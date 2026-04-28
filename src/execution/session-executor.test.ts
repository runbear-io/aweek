/**
 * Tests for Session Executor — src/execution/session-executor.ts
 *
 * The executor is a thin integrator around cli-session's subagent-first
 * `launchSession(agentId, subagentRef, task, opts)` API. Identity (name,
 * role, system prompt, model, tools, skills) is owned by the subagent
 * `.claude/agents/<slug>.md` file, so these tests pass a subagent slug
 * string rather than an identity object.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  executeSessionWithTracking,
  weekFromPlanWeek,
  createTrackedExecutor,
} from './session-executor.js';
import type { UsageStoreLike, UsageRecord } from './session-executor.js';
import type { SpawnFn, TaskContext } from './cli-session.js';
import { UsageStore } from '../storage/usage-store.js';
import { ArtifactStore, resolveArtifactDir } from '../storage/artifact-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUBAGENT_REF = 'test-bot';

function makeTask(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: 'task-test001',
    title: 'Run a test task',
    prompt: 'Run a test task',
    ...overrides,
  };
}

interface MockChildProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: (signal?: string) => boolean;
  killed: boolean;
}

interface SpawnCall {
  cmd: string;
  args: ReadonlyArray<string>;
  opts: unknown;
}

interface MockSpawn extends SpawnFn {
  lastCall: () => SpawnCall | null;
}

interface MockSpawnOpts {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: Error | null;
}

/**
 * Create a mock spawn that emits the given stdout/stderr and exit code.
 */
function createMockSpawn(
  { exitCode = 0, stdout = '', stderr = '', error = null }: MockSpawnOpts = {},
): MockSpawn {
  let lastCall: SpawnCall | null = null;

  const mockSpawn = ((cmd: string, args: ReadonlyArray<string>, opts: unknown) => {
    lastCall = { cmd, args, opts };

    const child = new EventEmitter() as MockChildProcess;
    const stdoutStream = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });
    child.stdout = stdoutStream;
    child.stderr = stderrStream;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null));
      return true;
    };
    child.killed = false;

    setImmediate(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      if (stdout) stdoutStream.push(stdout);
      stdoutStream.push(null);
      if (stderr) stderrStream.push(stderr);
      stderrStream.push(null);
      setImmediate(() => child.emit('close', exitCode));
    });

    return child;
  }) as unknown as MockSpawn;

  mockSpawn.lastCall = () => lastCall;
  return mockSpawn;
}

interface MakeCliOutputOpts {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** Build CLI output JSON with token usage */
function makeCliOutput(
  { inputTokens = 1000, outputTokens = 500, costUsd = 0.05 }: MakeCliOutputOpts = {},
): string {
  return JSON.stringify({
    result: 'Task completed successfully.',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    cost_usd: costUsd,
  });
}

// ===========================================================================
// weekFromPlanWeek
// ===========================================================================
describe('weekFromPlanWeek', () => {
  it('converts ISO week to Monday date string', () => {
    const result = weekFromPlanWeek('2026-W16');
    assert.equal(result, '2026-04-13');
  });

  it('converts week 1 of a year', () => {
    const result = weekFromPlanWeek('2026-W01');
    assert.equal(result, '2025-12-29');
  });

  it('returns undefined for null input', () => {
    assert.equal(weekFromPlanWeek(null), undefined);
  });

  it('returns undefined for empty string', () => {
    assert.equal(weekFromPlanWeek(''), undefined);
  });

  it('returns undefined for non-string input', () => {
    assert.equal(weekFromPlanWeek(42), undefined);
  });

  it('returns undefined for invalid format', () => {
    assert.equal(weekFromPlanWeek('2026-16'), undefined);
    assert.equal(weekFromPlanWeek('not-a-week'), undefined);
    assert.equal(weekFromPlanWeek('W16-2026'), undefined);
  });

  it('handles mid-year weeks', () => {
    const result = weekFromPlanWeek('2026-W26');
    assert.equal(result, '2026-06-22');
  });
});

// ===========================================================================
// executeSessionWithTracking
// ===========================================================================
describe('executeSessionWithTracking', () => {
  let tmpDir: string;
  let usageStore: UsageStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-session-exec-'));
    usageStore = new UsageStore(tmpDir);
  });

  it('returns session result with parsed token usage', async () => {
    const stdout = makeCliOutput({ inputTokens: 1200, outputTokens: 600, costUsd: 0.08 });
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn, usageStore }
    );

    assert.ok(result.sessionResult);
    assert.equal(result.sessionResult.agentId, 'agent-test');
    assert.equal(result.sessionResult.subagentRef, SUBAGENT_REF);
    assert.equal(result.sessionResult.taskId, 'task-test001');
    assert.equal(result.sessionResult.exitCode, 0);

    assert.ok(result.tokenUsage);
    assert.equal(result.tokenUsage.inputTokens, 1200);
    assert.equal(result.tokenUsage.outputTokens, 600);
    assert.equal(result.tokenUsage.totalTokens, 1800);
    assert.equal(result.tokenUsage.costUsd, 0.08);
  });

  it('invokes claude CLI with --agent <slug> (no --system-prompt)', async () => {
    const mockSpawn = createMockSpawn({ stdout: makeCliOutput() });

    await executeSessionWithTracking(
      'agent-test',
      'marketer',
      makeTask(),
      { spawnFn: mockSpawn, usageStore }
    );

    const call = mockSpawn.lastCall();
    assert.ok(call);
    const args = call.args;
    const agentIdx = args.indexOf('--agent');
    assert.ok(agentIdx >= 0);
    assert.equal(args[agentIdx + 1], 'marketer');
    assert.ok(args.includes('--append-system-prompt'));
    assert.ok(!args.includes('--system-prompt'));
  });

  it('persists usage record when usageStore is provided', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn, usageStore }
    );

    assert.equal(result.usageTracked, true);
    assert.ok(result.usageRecord);
    assert.equal(result.usageRecord.agentId, 'agent-test');
    assert.equal(result.usageRecord.taskId, 'task-test001');
    assert.equal(result.usageRecord.inputTokens, 1000);
    assert.equal(result.usageRecord.outputTokens, 500);
    assert.equal(result.usageRecord.totalTokens, 1500);

    const records = await usageStore.load('agent-test') as UsageRecord[];
    assert.equal(records.length, 1);
    assert.equal(records[0].id, result.usageRecord.id);
  });

  it('returns usageTracked=false when no usageStore provided', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn }
    );

    assert.equal(result.usageTracked, false);
    assert.equal(result.usageRecord, null);
    assert.ok(result.tokenUsage);
    assert.equal(result.tokenUsage.inputTokens, 1000);
  });

  it('returns tokenUsage=null when CLI output has no usage data', async () => {
    const stdout = JSON.stringify({ result: 'done, no usage info' });
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn, usageStore }
    );

    assert.equal(result.tokenUsage, null);
    assert.equal(result.usageRecord, null);
    assert.equal(result.usageTracked, false);
  });

  it('returns tokenUsage=null when CLI output is not JSON', async () => {
    const mockSpawn = createMockSpawn({ stdout: 'plain text output' });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn, usageStore }
    );

    assert.equal(result.tokenUsage, null);
    assert.equal(result.usageTracked, false);
  });

  it('still returns session result on non-zero exit code', async () => {
    const mockSpawn = createMockSpawn({ exitCode: 1, stderr: 'error' });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn, usageStore }
    );

    assert.equal(result.sessionResult.exitCode, 1);
    assert.equal(result.tokenUsage, null);
    assert.equal(result.usageTracked, false);
  });

  it('includes model in usage record when specified', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn, usageStore, model: 'opus' }
    );

    assert.ok(result.usageRecord);
    assert.equal(result.usageRecord.model, 'opus');
  });

  it('includes durationMs from session in usage record', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn, usageStore }
    );

    assert.ok(result.usageRecord);
    assert.ok(typeof result.usageRecord.durationMs === 'number');
    assert.equal(result.usageRecord.durationMs, result.sessionResult.durationMs);
  });

  it('converts plan week to usage week key', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask({ week: '2026-W16' }),
      { spawnFn: mockSpawn, usageStore }
    );

    assert.ok(result.usageRecord);
    assert.equal(result.usageRecord.week, '2026-04-13');
  });

  it('handles multiple sessions accumulating usage records', async () => {
    const stdout = makeCliOutput({ inputTokens: 100, outputTokens: 50 });
    const mockSpawn = createMockSpawn({ stdout });

    await executeSessionWithTracking(
      'agent-test', SUBAGENT_REF, makeTask({ taskId: 'task-1' }),
      { spawnFn: mockSpawn, usageStore }
    );
    await executeSessionWithTracking(
      'agent-test', SUBAGENT_REF, makeTask({ taskId: 'task-2' }),
      { spawnFn: mockSpawn, usageStore }
    );
    await executeSessionWithTracking(
      'agent-test', SUBAGENT_REF, makeTask({ taskId: 'task-3' }),
      { spawnFn: mockSpawn, usageStore }
    );

    const records = await usageStore.load('agent-test') as UsageRecord[];
    assert.equal(records.length, 3);

    const totals = await usageStore.weeklyTotal('agent-test') as {
      totalTokens: number;
      recordCount: number;
    };
    assert.equal(totals.totalTokens, 450);
    assert.equal(totals.recordCount, 3);
  });

  it('gracefully degrades if usageStore.append fails', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const brokenStore: UsageStoreLike = {
      append: async () => { throw new Error('disk full'); },
      init: async () => {},
    };

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn, usageStore: brokenStore }
    );

    assert.ok(result.sessionResult);
    assert.equal(result.sessionResult.exitCode, 0);
    assert.ok(result.tokenUsage);
    assert.equal(result.usageTracked, false);
  });

  it('uses custom sessionId when provided', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn, usageStore, sessionId: 'my-custom-session' }
    );

    assert.ok(result.usageRecord);
    assert.equal(result.usageRecord.sessionId, 'my-custom-session');
  });

  it('throws if agentId is missing', async () => {
    await assert.rejects(
      () => executeSessionWithTracking(null as unknown as string, SUBAGENT_REF, makeTask()),
      /agentId is required/
    );
  });

  it('throws if subagentRef is missing', async () => {
    await assert.rejects(
      () => executeSessionWithTracking('agent-test', null as unknown as string, makeTask()),
      /subagentRef is required/
    );
  });

  it('throws if subagentRef is empty', async () => {
    await assert.rejects(
      () => executeSessionWithTracking('agent-test', '', makeTask()),
      /subagentRef is required/
    );
  });

  it('throws if task is missing', async () => {
    await assert.rejects(
      () => executeSessionWithTracking('agent-test', SUBAGENT_REF, null as unknown as TaskContext),
      /task is required/
    );
  });

  it('propagates CLI spawn errors (does not swallow)', async () => {
    const mockSpawn = createMockSpawn({ error: new Error('ENOENT') });

    await assert.rejects(
      () => executeSessionWithTracking('agent-test', SUBAGENT_REF, makeTask(), {
        spawnFn: mockSpawn,
        usageStore,
      }),
      /CLI process error: ENOENT/
    );
  });

  // -------------------------------------------------------------------------
  // Per-execution artifact directory provisioning
  // (Sub-AC 1.2: resolve + mkdir -p before the CLI session launches)
  // -------------------------------------------------------------------------

  it('creates the per-execution artifact directory before launching the CLI', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask({ taskId: 'task-art-001' }),
      {
        spawnFn: mockSpawn,
        usageStore,
        agentsDir: tmpDir,
        sessionId: 'session-fixed-001',
      }
    );

    const expected = resolveArtifactDir(
      tmpDir,
      'agent-test',
      'task-art-001',
      'session-fixed-001',
    );

    assert.equal(result.artifactDir, expected);
    const stats = await stat(expected);
    assert.ok(stats.isDirectory(), 'artifact directory should exist on disk');
    assert.ok(
      expected.endsWith(join('agent-test', 'artifacts', 'task-art-001_session-fixed-001')),
      `artifact dir should match the compound-key layout, got ${expected}`,
    );
  });

  it('returns artifactDir=null when agentsDir is not provided', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn, usageStore }
    );

    assert.equal(result.artifactDir, null);
    assert.equal(result.sessionResult.exitCode, 0);
  });

  // -------------------------------------------------------------------------
  // Artifact directory exposure (Sub-AC 1.3)
  // The provisioned per-execution artifact directory must reach the
  // subagent through BOTH:
  //   (a) the `--append-system-prompt` runtime context block, and
  //   (b) the `AWEEK_ARTIFACT_DIR` environment variable on the spawned CLI.
  // -------------------------------------------------------------------------

  it('injects the artifact directory into the runtime-context system prompt', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask({ taskId: 'task-art-prompt' }),
      {
        spawnFn: mockSpawn,
        usageStore,
        agentsDir: tmpDir,
        sessionId: 'session-prompt-001',
      }
    );

    const expected = resolveArtifactDir(
      tmpDir,
      'agent-test',
      'task-art-prompt',
      'session-prompt-001',
    );
    assert.equal(result.artifactDir, expected);

    const call = mockSpawn.lastCall();
    assert.ok(call);
    const args = call.args;
    const appendIdx = args.indexOf('--append-system-prompt');
    assert.ok(appendIdx >= 0);
    const runtimeContext = args[appendIdx + 1];
    assert.ok(
      runtimeContext.includes('### Artifact Directory'),
      'runtime context should include the Artifact Directory section',
    );
    assert.ok(
      runtimeContext.includes(`Artifact Directory: ${expected}`),
      `runtime context should announce the absolute artifact path; got: ${runtimeContext}`,
    );
  });

  it('exports the artifact directory as AWEEK_ARTIFACT_DIR on the spawned CLI', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask({ taskId: 'task-art-env' }),
      {
        spawnFn: mockSpawn,
        usageStore,
        agentsDir: tmpDir,
        sessionId: 'session-env-001',
      }
    );

    const expected = resolveArtifactDir(
      tmpDir,
      'agent-test',
      'task-art-env',
      'session-env-001',
    );
    assert.equal(result.artifactDir, expected);

    const call = mockSpawn.lastCall();
    assert.ok(call);
    const env = (call.opts as { env?: NodeJS.ProcessEnv }).env;
    assert.ok(env);
    assert.equal(
      env.AWEEK_ARTIFACT_DIR,
      expected,
      'AWEEK_ARTIFACT_DIR must equal the resolved artifact directory',
    );
  });

  it('preserves caller-provided env vars when injecting AWEEK_ARTIFACT_DIR', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask({ taskId: 'task-art-env-merge' }),
      {
        spawnFn: mockSpawn,
        usageStore,
        agentsDir: tmpDir,
        sessionId: 'session-env-merge-001',
        env: { CUSTOM_FLAG: 'preserved' },
      }
    );

    const call = mockSpawn.lastCall();
    assert.ok(call);
    const env = (call.opts as { env?: NodeJS.ProcessEnv }).env;
    assert.ok(env);
    assert.equal(env.CUSTOM_FLAG, 'preserved');
    assert.ok(env.AWEEK_ARTIFACT_DIR && env.AWEEK_ARTIFACT_DIR.length > 0);
  });

  it('does NOT set AWEEK_ARTIFACT_DIR when no artifact directory was provisioned', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn, usageStore }
    );

    const call = mockSpawn.lastCall();
    assert.ok(call);
    const env = (call.opts as { env?: NodeJS.ProcessEnv }).env;
    // env may exist (process.env always merged in by launchSession) but
    // AWEEK_ARTIFACT_DIR must not be present when we never provisioned a dir.
    assert.equal(env?.AWEEK_ARTIFACT_DIR, undefined);
  });

  it('omits the Artifact Directory section from the prompt when no dir was provisioned', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    await executeSessionWithTracking(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn, usageStore }
    );

    const call = mockSpawn.lastCall();
    assert.ok(call);
    const args = call.args;
    const appendIdx = args.indexOf('--append-system-prompt');
    assert.ok(appendIdx >= 0);
    const runtimeContext = args[appendIdx + 1];
    assert.ok(
      !runtimeContext.includes('### Artifact Directory'),
      'runtime context must not advertise an artifact directory when none exists',
    );
    assert.ok(!runtimeContext.includes('AWEEK_ARTIFACT_DIR'));
  });

  // -------------------------------------------------------------------------
  // Post-session auto-scan + ArtifactStore.register wiring (Sub-AC 3)
  //
  // After the CLI session completes, every file the subagent dropped into the
  // per-execution artifact directory must be registered via the existing
  // ArtifactStore (no parallel persistence). The scan is best-effort — a
  // failure must NOT abort the tick or break usage tracking.
  // -------------------------------------------------------------------------

  it('auto-registers files dropped into the artifact directory after the session', async () => {
    const stdout = makeCliOutput();
    // Mock spawn that writes files into the artifact dir before exiting,
    // simulating a subagent that dropped deliverables during the session.
    let lastCall: { cmd: string; args: ReadonlyArray<string>; opts: unknown } | null = null;
    const mockSpawn = ((cmd: string, args: ReadonlyArray<string>, opts: unknown) => {
      lastCall = { cmd, args, opts };
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable; stderr: Readable; kill: () => boolean; killed: boolean;
      };
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      child.stdout = stdoutStream;
      child.stderr = stderrStream;
      child.kill = () => { child.killed = true; return true; };
      child.killed = false;

      // Find the AWEEK_ARTIFACT_DIR env var the executor exported and drop
      // a couple of deliverables there before the process "exits".
      const env = (opts as { env?: NodeJS.ProcessEnv }).env || {};
      const artifactDir = env.AWEEK_ARTIFACT_DIR;
      setImmediate(async () => {
        if (artifactDir) {
          try {
            await mkdir(join(artifactDir, 'reports'), { recursive: true });
            await writeFile(join(artifactDir, 'plan.md'), '# Launch Plan\n', 'utf-8');
            await writeFile(join(artifactDir, 'data.json'), '[1,2,3]', 'utf-8');
            await writeFile(
              join(artifactDir, 'reports', 'weekly-report.md'),
              '# Weekly Report\n',
              'utf-8',
            );
          } catch { /* best-effort */ }
        }
        stdoutStream.push(stdout);
        stdoutStream.push(null);
        stderrStream.push(null);
        setImmediate(() => child.emit('close', 0));
      });

      return child;
    }) as unknown as SpawnFn;

    const result = await executeSessionWithTracking(
      'agent-art',
      SUBAGENT_REF,
      makeTask({
        taskId: 'task-art-scan',
        title: 'Draft launch plan',
        prompt: 'Draft launch plan',
        objectiveId: 'obj-launch',
        week: '2026-W17',
      }),
      {
        spawnFn: mockSpawn,
        usageStore,
        agentsDir: tmpDir,
        cwd: tmpDir,
        sessionId: 'session-scan-001',
      }
    );

    // Verify spawn was called (so the mock ran).
    assert.ok(lastCall);

    // The executor should report the registered records on the result.
    assert.ok(Array.isArray(result.artifactsRegistered));
    assert.equal(result.artifactsRegistered.length, 3,
      'all three files dropped into the artifact dir should be registered');

    // The scan must call ArtifactStore.register* under the hood — verify by
    // loading the manifest the store wrote to disk.
    const store = new ArtifactStore(tmpDir, tmpDir);
    const loaded = await store.load('agent-art');
    assert.equal(loaded.length, 3);

    // Every record must carry the compound (taskId, executionId) coordinates,
    // the inferred type, and a description that mentions the task.
    for (const record of loaded) {
      assert.equal(record.agentId, 'agent-art');
      assert.equal(record.taskId, 'task-art-scan');
      assert.equal(record.week, '2026-W17');
      assert.equal((record.metadata as { executionId: string }).executionId, 'session-scan-001');
      assert.match(record.description, /Draft launch plan/);
      assert.match(record.id, /^artifact-[a-f0-9]+$/);
    }

    const byName = new Map(loaded.map((r) => [r.fileName, r]));
    assert.equal(byName.get('plan.md')?.type, 'document');
    assert.equal(byName.get('data.json')?.type, 'data');
    // Filename keyword promotes this to type=report.
    assert.equal(byName.get('reports/weekly-report.md')?.type, 'report');
  });

  it('returns an empty artifactsRegistered list when the artifact dir is empty', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-art-empty',
      SUBAGENT_REF,
      makeTask({ taskId: 'task-art-empty' }),
      {
        spawnFn: mockSpawn,
        usageStore,
        agentsDir: tmpDir,
        cwd: tmpDir,
        sessionId: 'session-empty-001',
      }
    );

    assert.deepEqual(result.artifactsRegistered, []);
    assert.equal(result.sessionResult.exitCode, 0);

    // No manifest should be written when nothing got registered.
    const store = new ArtifactStore(tmpDir, tmpDir);
    const loaded = await store.load('agent-art-empty');
    assert.deepEqual(loaded, []);
  });

  it('returns artifactsRegistered=[] when no artifact dir was provisioned', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-art-none',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn, usageStore }
    );

    assert.equal(result.artifactDir, null);
    assert.deepEqual(result.artifactsRegistered, []);
  });

  it('still runs the session and returns artifactDir=null if mkdir fails', async () => {
    // Simulate a failed mkdir by pointing agentsDir at an existing FILE
    // (not a directory). `mkdir -p` cannot create child directories under a
    // path that is itself a regular file, so the resolver-then-mkdir step
    // throws — but the session must still launch.
    const collidingFile = join(tmpDir, 'not-a-directory');
    await writeFile(collidingFile, 'oops', 'utf-8');

    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    // Capture warnings without polluting test output.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: unknown) => {
      warnings.push(typeof msg === 'string' ? msg : String(msg));
    };

    let result;
    try {
      result = await executeSessionWithTracking(
        'agent-test',
        SUBAGENT_REF,
        makeTask({ taskId: 'task-art-fail' }),
        {
          spawnFn: mockSpawn,
          usageStore,
          agentsDir: collidingFile,
          sessionId: 'session-fail-001',
        }
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(result.artifactDir, null);
    assert.equal(result.sessionResult.exitCode, 0,
      'session must still complete even when artifact dir provisioning fails');
    assert.ok(
      warnings.some((w) => w.includes('failed to create artifact directory')),
      `expected a console.warn about artifact directory failure; got: ${warnings.join(' | ')}`,
    );
  });

  // -------------------------------------------------------------------------
  // Sub-AC 4: Strengthened coverage for the post-session auto-scan path.
  //
  // The earlier integration test ("auto-registers files dropped into the
  // artifact directory after the session") covers the happy path. The
  // following tests explicitly exercise the seams that connect:
  //   - directory creation (executor) → scanner (type inference) →
  //     description builder → ArtifactStore.register* (persistence).
  // Each test pins down one seam so a regression in any single layer
  // surfaces here rather than silently degrading the dashboard view.
  // -------------------------------------------------------------------------

  it('propagates inferred mimeType into artifact metadata for downstream rendering', async () => {
    // Spawn that drops one of every supported MIME class (markdown, JSON,
    // PDF-ish binary, image) so we can assert the dashboard-facing
    // metadata.mimeType field comes from inferMimeType, not a hardcoded
    // default. This is the seam the SPA artifacts tab reads to decide
    // whether to render inline or fall back to download.
    const stdout = makeCliOutput();
    const mockSpawn = ((_cmd: string, _args: ReadonlyArray<string>, opts: unknown) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable; stderr: Readable; kill: () => boolean; killed: boolean;
      };
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      child.stdout = stdoutStream;
      child.stderr = stderrStream;
      child.kill = () => { child.killed = true; return true; };
      child.killed = false;

      const env = (opts as { env?: NodeJS.ProcessEnv }).env || {};
      const artifactDir = env.AWEEK_ARTIFACT_DIR;
      setImmediate(async () => {
        if (artifactDir) {
          try {
            await writeFile(join(artifactDir, 'plan.md'), '# plan\n', 'utf-8');
            await writeFile(join(artifactDir, 'data.json'), '{}', 'utf-8');
            // Use an unknown extension to validate the octet-stream fallback
            // also flows through the metadata field.
            await writeFile(join(artifactDir, 'mystery.xyz'), 'binary-ish', 'utf-8');
          } catch { /* best-effort */ }
        }
        stdoutStream.push(stdout);
        stdoutStream.push(null);
        stderrStream.push(null);
        setImmediate(() => child.emit('close', 0));
      });
      return child;
    }) as unknown as SpawnFn;

    const result = await executeSessionWithTracking(
      'agent-mime',
      SUBAGENT_REF,
      makeTask({ taskId: 'task-mime-001' }),
      {
        spawnFn: mockSpawn,
        usageStore,
        agentsDir: tmpDir,
        cwd: tmpDir,
        sessionId: 'session-mime-001',
      },
    );

    assert.equal(result.artifactsRegistered.length, 3);
    const byName = new Map(
      result.artifactsRegistered.map((r) => [r.fileName, r]),
    );

    const md = byName.get('plan.md')!;
    assert.equal((md.metadata as { mimeType: string }).mimeType, 'text/markdown');

    const json = byName.get('data.json')!;
    assert.equal((json.metadata as { mimeType: string }).mimeType, 'application/json');

    const unknown = byName.get('mystery.xyz')!;
    assert.equal(
      (unknown.metadata as { mimeType: string }).mimeType,
      'application/octet-stream',
      'unknown extensions should fall back to application/octet-stream',
    );
  });

  it('flows the task descriptor through to descriptions and objectiveId metadata', async () => {
    // Validates the description-generation seam: the executor must hand
    // title/prompt/objectiveId off to scanAndRegister so each persisted
    // record carries a human-readable description AND a metadata.objectiveId
    // marker. Without this wiring, dashboard rows would render as
    // `<filename> — <type>` with no traceability back to the plan.
    const stdout = makeCliOutput();
    const mockSpawn = ((_cmd: string, _args: ReadonlyArray<string>, opts: unknown) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable; stderr: Readable; kill: () => boolean; killed: boolean;
      };
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      child.stdout = stdoutStream;
      child.stderr = stderrStream;
      child.kill = () => { child.killed = true; return true; };
      child.killed = false;

      const env = (opts as { env?: NodeJS.ProcessEnv }).env || {};
      const artifactDir = env.AWEEK_ARTIFACT_DIR;
      setImmediate(async () => {
        if (artifactDir) {
          try {
            await writeFile(join(artifactDir, 'launch-plan.md'), '# plan\n', 'utf-8');
          } catch { /* best-effort */ }
        }
        stdoutStream.push(stdout);
        stdoutStream.push(null);
        stderrStream.push(null);
        setImmediate(() => child.emit('close', 0));
      });
      return child;
    }) as unknown as SpawnFn;

    const result = await executeSessionWithTracking(
      'agent-desc',
      SUBAGENT_REF,
      makeTask({
        taskId: 'task-desc-001',
        title: 'Refresh the launch plan',
        prompt: 'Refresh the launch plan',
        objectiveId: '2026-04',
        week: '2026-W17',
      }),
      {
        spawnFn: mockSpawn,
        usageStore,
        agentsDir: tmpDir,
        cwd: tmpDir,
        sessionId: 'session-desc-001',
      },
    );

    assert.equal(result.artifactsRegistered.length, 1);
    const [record] = result.artifactsRegistered;
    assert.match(
      record.description,
      /Refresh the launch plan/,
      'description should reference the task title supplied to the executor',
    );
    assert.match(
      record.description,
      /\(objective 2026-04\)/,
      'description should append an objective marker when objectiveId is present',
    );
    assert.equal(
      (record.metadata as { objectiveId: string }).objectiveId,
      '2026-04',
      'metadata.objectiveId is the SPA-facing traceability handle to plan.md',
    );
    assert.equal(record.week, '2026-W17');
  });

  it('writes auto-scanned records to the ArtifactStore-backed manifest path', async () => {
    // Pins down the ArtifactStore.register* invocation contract: after the
    // session ends, the manifest file at
    // `<agentsDir>/<agentId>/artifacts/manifest.json` must exist on disk
    // with the records the scanner produced. This guards against future
    // refactors that bypass ArtifactStore in favor of an ad-hoc writer.
    const stdout = makeCliOutput();
    const mockSpawn = ((_cmd: string, _args: ReadonlyArray<string>, opts: unknown) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable; stderr: Readable; kill: () => boolean; killed: boolean;
      };
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      child.stdout = stdoutStream;
      child.stderr = stderrStream;
      child.kill = () => { child.killed = true; return true; };
      child.killed = false;

      const env = (opts as { env?: NodeJS.ProcessEnv }).env || {};
      const artifactDir = env.AWEEK_ARTIFACT_DIR;
      setImmediate(async () => {
        if (artifactDir) {
          try {
            await writeFile(join(artifactDir, 'notes.md'), '# notes', 'utf-8');
          } catch { /* best-effort */ }
        }
        stdoutStream.push(stdout);
        stdoutStream.push(null);
        stderrStream.push(null);
        setImmediate(() => child.emit('close', 0));
      });
      return child;
    }) as unknown as SpawnFn;

    await executeSessionWithTracking(
      'agent-manifest',
      SUBAGENT_REF,
      makeTask({ taskId: 'task-manifest-001' }),
      {
        spawnFn: mockSpawn,
        usageStore,
        agentsDir: tmpDir,
        cwd: tmpDir,
        sessionId: 'session-manifest-001',
      },
    );

    // The canonical manifest path is owned by ArtifactStore — re-derive it
    // here so the test fails loudly if either the executor or the store
    // changes the on-disk layout.
    const manifestPath = join(tmpDir, 'agent-manifest', 'artifacts', 'manifest.json');
    const stats = await stat(manifestPath);
    assert.ok(stats.isFile(), 'manifest.json must exist at the ArtifactStore-owned path');

    const store = new ArtifactStore(tmpDir, tmpDir);
    const loaded = await store.load('agent-manifest');
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].fileName, 'notes.md');
    // The record carries the auto-populated sizeBytes from registerBatch's
    // autoSize=false path — the scanner pre-fills it via `stat`, so the
    // manifest reflects the file size at scan time.
    assert.ok(loaded[0].sizeBytes && loaded[0].sizeBytes > 0,
      'sizeBytes should be populated when files exist on disk');
  });

  it('gracefully degrades when ArtifactStore.registerBatch throws', async () => {
    // Best-effort contract: a failure inside the scan/register pipeline
    // (schema rejection, disk full, etc.) must NOT abort the tick. The
    // session result and usage tracking must still succeed; only
    // artifactsRegistered should be empty and a single console.warn must
    // surface so heartbeat logs flag the regression.
    const stdout = makeCliOutput();

    // Force a registerBatch failure by *replacing* the per-execution dir
    // with a file AFTER mkdir succeeded. The scanner walks the file list
    // before the registerBatch call, so we instead make the manifest path
    // unwritable: pre-create a directory at the manifest filename so
    // writeFile rejects with EISDIR.
    const mockSpawn = ((_cmd: string, _args: ReadonlyArray<string>, opts: unknown) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable; stderr: Readable; kill: () => boolean; killed: boolean;
      };
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      child.stdout = stdoutStream;
      child.stderr = stderrStream;
      child.kill = () => { child.killed = true; return true; };
      child.killed = false;

      const env = (opts as { env?: NodeJS.ProcessEnv }).env || {};
      const artifactDir = env.AWEEK_ARTIFACT_DIR;
      setImmediate(async () => {
        if (artifactDir) {
          try {
            await writeFile(join(artifactDir, 'plan.md'), '# plan', 'utf-8');
            // Sabotage: replace the manifest *file* slot with a directory
            // so `_save` (writeFile) rejects with EISDIR and the
            // scan/register step throws.
            const manifestPath = join(tmpDir, 'agent-degraded', 'artifacts', 'manifest.json');
            await mkdir(manifestPath, { recursive: true });
          } catch { /* best-effort */ }
        }
        stdoutStream.push(stdout);
        stdoutStream.push(null);
        stderrStream.push(null);
        setImmediate(() => child.emit('close', 0));
      });
      return child;
    }) as unknown as SpawnFn;

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: unknown) => {
      warnings.push(typeof msg === 'string' ? msg : String(msg));
    };

    let result;
    try {
      result = await executeSessionWithTracking(
        'agent-degraded',
        SUBAGENT_REF,
        makeTask({ taskId: 'task-degraded-001' }),
        {
          spawnFn: mockSpawn,
          usageStore,
          agentsDir: tmpDir,
          cwd: tmpDir,
          sessionId: 'session-degraded-001',
        },
      );
    } finally {
      console.warn = originalWarn;
    }

    // Session itself must still complete cleanly.
    assert.equal(result.sessionResult.exitCode, 0);
    assert.equal(result.usageTracked, true);
    // Auto-scan failure surfaces as an empty registered list + a warning.
    assert.deepEqual(result.artifactsRegistered, []);
    assert.ok(
      warnings.some((w) => w.includes('post-session artifact scan failed')),
      `expected a console.warn about scan failure; got: ${warnings.join(' | ')}`,
    );
  });
});

// ===========================================================================
// createTrackedExecutor
// ===========================================================================
describe('createTrackedExecutor', () => {
  let tmpDir: string;
  let usageStore: UsageStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-tracked-exec-'));
    usageStore = new UsageStore(tmpDir);
  });

  it('creates an executor function that resolves subagentRef from agent config', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const agentConfigs = {
      'agent-bot': {
        id: 'agent-bot',
        subagentRef: 'agent-bot',
      },
    };

    const executor = createTrackedExecutor({
      agentConfigs,
      usageStore,
      sessionOpts: { spawnFn: mockSpawn },
    });

    assert.equal(typeof executor, 'function');

    const result = await executor('agent-bot', {
      taskId: 'task-exec-001',
      payload: {
        title: 'Execute something',
        prompt: 'Execute something',
        objectiveId: 'obj-1',
        week: '2026-W16',
      },
    });

    assert.ok(result.sessionResult);
    assert.equal(result.sessionResult.agentId, 'agent-bot');
    assert.equal(result.sessionResult.subagentRef, 'agent-bot');
    assert.equal(result.usageTracked, true);
    assert.ok(result.usageRecord);

    // Verify that the CLI was invoked with the subagent slug, not identity.
    const call = mockSpawn.lastCall();
    assert.ok(call);
    const args = call.args;
    const agentIdx = args.indexOf('--agent');
    assert.equal(args[agentIdx + 1], 'agent-bot');
    assert.ok(!args.includes('--system-prompt'));
  });

  it('throws if agent config not found for agentId', async () => {
    const executor = createTrackedExecutor({
      agentConfigs: {},
      usageStore,
    });

    await assert.rejects(
      () => executor('unknown-agent', { taskId: 'task-1' }),
      /No agent config found for unknown-agent/
    );
  });

  it('throws if agent config has no subagentRef', async () => {
    const executor = createTrackedExecutor({
      agentConfigs: { 'agent-bot': { id: 'agent-bot' } },
      usageStore,
    });

    await assert.rejects(
      () => executor('agent-bot', { taskId: 'task-1' }),
      /missing subagentRef/
    );
  });

  it('throws if agentConfigs is missing', () => {
    assert.throws(
      () => createTrackedExecutor({}),
      /agentConfigs is required/
    );
  });

  it('uses taskId as description fallback when payload.description missing', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const agentConfigs = {
      'agent-bot': {
        id: 'agent-bot',
        subagentRef: 'agent-bot',
      },
    };

    const executor = createTrackedExecutor({
      agentConfigs,
      usageStore,
      sessionOpts: { spawnFn: mockSpawn },
    });

    const result = await executor('agent-bot', { taskId: 'task-fallback' });

    assert.ok(result.sessionResult);
    assert.equal(result.sessionResult.taskId, 'task-fallback');
  });

  it('passes session results to usage store for multiple agents', async () => {
    const stdout = makeCliOutput({ inputTokens: 200, outputTokens: 100 });
    const mockSpawn = createMockSpawn({ stdout });

    const agentConfigs = {
      'agent-a': { id: 'agent-a', subagentRef: 'agent-a' },
      'agent-b': { id: 'agent-b', subagentRef: 'agent-b' },
    };

    const executor = createTrackedExecutor({
      agentConfigs,
      usageStore,
      sessionOpts: { spawnFn: mockSpawn },
    });

    await executor('agent-a', { taskId: 'task-a1', payload: { title: 'Task A1', prompt: 'Task A1' } });
    await executor('agent-b', { taskId: 'task-b1', payload: { title: 'Task B1', prompt: 'Task B1' } });

    const recordsA = await usageStore.load('agent-a') as UsageRecord[];
    const recordsB = await usageStore.load('agent-b') as UsageRecord[];
    assert.equal(recordsA.length, 1);
    assert.equal(recordsB.length, 1);
    assert.equal(recordsA[0].agentId, 'agent-a');
    assert.equal(recordsB[0].agentId, 'agent-b');
  });
});
