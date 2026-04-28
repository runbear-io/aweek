/**
 * Tests for CLI Session Launcher — src/execution/cli-session.ts
 *
 * The launcher is a thin 1-to-1 wrapper around a Claude Code subagent:
 *   claude --print --agent <slug> --append-system-prompt <runtime> <task>
 *
 * These tests exercise the post-refactor API where identity is owned by
 * the `.claude/agents/<slug>.md` file and never appears in argv. The old
 * `buildSystemPrompt(identity)` helper was intentionally removed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  buildRuntimeContext,
  buildTaskPrompt,
  buildCliArgs,
  launchSession,
  buildSessionConfig,
  parseTokenUsage,
} from './cli-session.js';
import type {
  BuildSessionAgentConfig,
  BuildSessionSelectedTask,
  SpawnFn,
  TaskContext,
} from './cli-session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A syntactically valid subagent slug used for most tests. */
const SUBAGENT_REF = 'research-bot';

/** Minimal valid task context */
function makeTask(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: 'task-abc12345',
    title: 'Gather quarterly revenue data',
    prompt: 'Gather quarterly revenue data from public filings',
    ...overrides,
  };
}

interface MakeAgentConfigOverrides {
  id?: string;
  subagentRef?: string;
  goals?: unknown[];
  monthlyPlans?: unknown[];
  budget?: { weeklyTokenLimit: number; currentUsage: number };
  inbox?: unknown[];
  createdAt?: string;
  updatedAt?: string;
}

/** Minimal valid agent config (as stored by AgentStore in the new schema) */
function makeAgentConfig(overrides: MakeAgentConfigOverrides = {}): BuildSessionAgentConfig & MakeAgentConfigOverrides {
  return {
    id: 'research-bot',
    subagentRef: 'research-bot',
    goals: [],
    monthlyPlans: [],
    budget: { weeklyTokenLimit: 500000, currentUsage: 0 },
    inbox: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface MakeSelectedTaskOverrides extends Partial<BuildSessionSelectedTask> {
  priority?: string;
  status?: string;
}

/** Minimal selected task (as returned by task-selector) */
function makeSelectedTask(
  overrides: MakeSelectedTaskOverrides = {},
): BuildSessionSelectedTask & MakeSelectedTaskOverrides {
  return {
    id: 'task-abc12345',
    title: 'Gather quarterly revenue data',
    prompt: 'Gather quarterly revenue data',
    objectiveId: 'obj-xyz98765',
    priority: 'high',
    status: 'pending',
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
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: unknown;
  };
}

interface MockSpawn extends SpawnFn {
  lastCall: () => SpawnCall | null;
}

interface CreateMockSpawnOpts {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: Error | null;
  delay?: number;
}

/**
 * Create a mock spawn function that returns a fake child process.
 * The returned child emits close with the given exit code after stdout/stderr.
 */
function createMockSpawn(
  { exitCode = 0, stdout = '', stderr = '', error = null, delay = 0 }: CreateMockSpawnOpts = {},
): MockSpawn {
  let lastCall: SpawnCall | null = null;

  const mockSpawn = ((cmd: string, args: ReadonlyArray<string>, opts: SpawnCall['opts']) => {
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

      const doClose = () => child.emit('close', exitCode);
      if (delay > 0) {
        setTimeout(doClose, delay);
      } else {
        setImmediate(doClose);
      }
    });

    return child;
  }) as unknown as MockSpawn;

  mockSpawn.lastCall = () => lastCall;
  return mockSpawn;
}

// ===========================================================================
// buildRuntimeContext
// ===========================================================================
describe('buildRuntimeContext', () => {
  it('emits an aweek runtime header and the task id', () => {
    const result = buildRuntimeContext(makeTask());
    assert.ok(result.includes('## aweek Runtime Context'));
    assert.ok(result.includes('Task ID: task-abc12345'));
  });

  it('includes objectiveId when provided', () => {
    const result = buildRuntimeContext(makeTask({ objectiveId: 'obj-xyz' }));
    assert.ok(result.includes('Objective ID: obj-xyz'));
  });

  it('includes week when provided', () => {
    const result = buildRuntimeContext(makeTask({ week: '2026-W16' }));
    assert.ok(result.includes('Week: 2026-W16'));
  });

  it('includes additional context when provided', () => {
    const result = buildRuntimeContext(makeTask({ additionalContext: 'Focus on Q1 2026 data only.' }));
    assert.ok(result.includes('### Additional Context'));
    assert.ok(result.includes('Focus on Q1 2026 data only.'));
  });

  it('includes the artifact directory path when provided', () => {
    const dir = '/tmp/aweek/agents/research-bot/artifacts/task-abc12345_session-001';
    const result = buildRuntimeContext(makeTask({ artifactDir: dir }));
    assert.ok(result.includes('### Artifact Directory'));
    assert.ok(
      result.includes(`Artifact Directory: ${dir}`),
      'runtime context should announce the absolute artifact directory path',
    );
    // Should also reference the env var name so the agent has both channels.
    assert.ok(result.includes('AWEEK_ARTIFACT_DIR'));
  });

  it('omits optional fields when not provided', () => {
    const result = buildRuntimeContext(makeTask());
    assert.ok(!result.includes('Objective ID:'));
    assert.ok(!result.includes('Week:'));
    assert.ok(!result.includes('### Additional Context'));
    assert.ok(!result.includes('### Artifact Directory'));
    assert.ok(!result.includes('AWEEK_ARTIFACT_DIR'));
  });

  it('does NOT embed identity fields (name, role, system prompt)', () => {
    // The subagent .md file owns identity. Runtime context must never leak it.
    const result = buildRuntimeContext(makeTask());
    assert.ok(!/You are [A-Z]/.test(result));
    assert.ok(!result.toLowerCase().includes('role:'));
    assert.ok(!result.toLowerCase().includes('system prompt'));
  });

  it('throws if task is missing', () => {
    assert.throws(() => buildRuntimeContext(null), /task is required/);
  });

  it('throws if taskId is missing', () => {
    assert.throws(
      () => buildRuntimeContext({ title: 'd', prompt: 'd' } as unknown as TaskContext),
      /task\.taskId is required/
    );
  });
});

// ===========================================================================
// buildTaskPrompt
// ===========================================================================
describe('buildTaskPrompt', () => {
  it('builds a structured prompt from task context', () => {
    const task = makeTask();
    const result = buildTaskPrompt(task);

    assert.ok(result.includes('## Task: Gather quarterly revenue data from public filings'));
    assert.ok(result.includes('Task ID: task-abc12345'));
    assert.ok(result.includes('## Instructions'));
  });

  it('throws if task is missing', () => {
    assert.throws(() => buildTaskPrompt(null), /task is required/);
  });

  it('throws if taskId is missing', () => {
    assert.throws(
      () => buildTaskPrompt({ title: 'd', prompt: 'd' } as unknown as TaskContext),
      /task\.taskId is required/
    );
  });

  it('throws if prompt is missing', () => {
    assert.throws(
      () => buildTaskPrompt({ taskId: 't' } as unknown as TaskContext),
      /task\.prompt is required/
    );
  });
});

// ===========================================================================
// buildCliArgs
// ===========================================================================
describe('buildCliArgs', () => {
  it('builds base CLI args with --print, --output-format stream-json --verbose, --agent REF, --append-system-prompt', () => {
    const args = buildCliArgs(SUBAGENT_REF, makeTask());

    assert.ok(args.includes('--print'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('stream-json'));
    assert.ok(args.includes('--verbose'));
    assert.ok(args.includes('--agent'));
    assert.ok(args.includes('--append-system-prompt'));
  });

  it('NEVER includes --system-prompt (identity lives in the subagent .md)', () => {
    const args = buildCliArgs(SUBAGENT_REF, makeTask());
    assert.ok(!args.includes('--system-prompt'));
  });

  it('passes the subagent slug as the --agent value', () => {
    const args = buildCliArgs('marketer', makeTask());
    const idx = args.indexOf('--agent');
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], 'marketer');
  });

  it('passes the runtime-context as the --append-system-prompt value', () => {
    const args = buildCliArgs(SUBAGENT_REF, makeTask({ objectiveId: 'obj-1', week: '2026-W16' }));
    const idx = args.indexOf('--append-system-prompt');
    assert.ok(idx >= 0);
    const runtime = args[idx + 1];
    assert.ok(runtime.includes('## aweek Runtime Context'));
    assert.ok(runtime.includes('Objective ID: obj-1'));
    assert.ok(runtime.includes('Week: 2026-W16'));
  });

  it('user prompt is the last argument', () => {
    const task = makeTask();
    const args = buildCliArgs(SUBAGENT_REF, task);

    const lastArg = args[args.length - 1];
    assert.ok(lastArg.includes('## Task:'));
    assert.ok(lastArg.includes(task.prompt));
  });

  it('--agent comes before --append-system-prompt which comes before the positional task', () => {
    const args = buildCliArgs(SUBAGENT_REF, makeTask());
    const agentIdx = args.indexOf('--agent');
    const appendIdx = args.indexOf('--append-system-prompt');
    assert.ok(agentIdx >= 0 && appendIdx >= 0);
    assert.ok(agentIdx < appendIdx);
    // The final positional (task) is strictly after both flags+values.
    assert.ok(appendIdx + 1 < args.length - 1);
  });

  it('includes --model when specified', () => {
    const args = buildCliArgs(SUBAGENT_REF, makeTask(), { model: 'opus' });
    const idx = args.indexOf('--model');
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], 'opus');
  });

  it('always includes --verbose (required by stream-json under --print)', () => {
    const args = buildCliArgs(SUBAGENT_REF, makeTask());
    assert.ok(args.includes('--verbose'));
  });

  it('includes --dangerously-skip-permissions when specified', () => {
    const args = buildCliArgs(SUBAGENT_REF, makeTask(), { dangerouslySkipPermissions: true });
    assert.ok(args.includes('--dangerously-skip-permissions'));
  });

  it('omits optional flags by default', () => {
    const args = buildCliArgs(SUBAGENT_REF, makeTask());
    assert.ok(!args.includes('--model'));
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  });

  it('throws when subagentRef is missing', () => {
    assert.throws(
      () => buildCliArgs(null as unknown as string, makeTask()),
      /subagentRef is required/
    );
  });

  it('throws when subagentRef is empty', () => {
    assert.throws(
      () => buildCliArgs('', makeTask()),
      /subagentRef is required/
    );
  });
});

// ===========================================================================
// launchSession
// ===========================================================================
describe('launchSession', () => {
  it('spawns CLI and returns structured result on success', async () => {
    const mockSpawn = createMockSpawn({ exitCode: 0, stdout: '{"result":"ok"}' });

    const result = await launchSession(
      'agent-test',
      SUBAGENT_REF,
      makeTask(),
      { spawnFn: mockSpawn }
    );

    assert.equal(result.agentId, 'agent-test');
    assert.equal(result.subagentRef, SUBAGENT_REF);
    assert.equal(result.taskId, 'task-abc12345');
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    // Stream-json emits one event per line; readline re-appends a newline
    // as it accumulates, so stdout always ends with `\n`.
    assert.equal(result.stdout, '{"result":"ok"}\n');
    assert.equal(result.stderr, '');
    assert.ok(result.startedAt);
    assert.ok(result.completedAt);
    assert.ok(typeof result.durationMs === 'number');
    assert.ok(Array.isArray(result.cliArgs));
  });

  it('passes correct CLI binary and args to spawn', async () => {
    const mockSpawn = createMockSpawn();

    await launchSession('agent-test', SUBAGENT_REF, makeTask(), {
      spawnFn: mockSpawn,
      cli: '/usr/local/bin/claude',
    });

    const call = mockSpawn.lastCall();
    assert.ok(call);
    assert.equal(call.cmd, '/usr/local/bin/claude');
    assert.ok(call.args.includes('--print'));
    assert.ok(call.args.includes('--agent'));
    assert.ok(call.args.includes('--append-system-prompt'));
    // Legacy flag must not appear.
    assert.ok(!call.args.includes('--system-prompt'));
  });

  it('defaults CLI to "claude"', async () => {
    const mockSpawn = createMockSpawn();
    await launchSession('agent-test', SUBAGENT_REF, makeTask(), { spawnFn: mockSpawn });
    const call = mockSpawn.lastCall();
    assert.ok(call);
    assert.equal(call.cmd, 'claude');
  });

  it('passes cwd to spawn when specified', async () => {
    const mockSpawn = createMockSpawn();
    await launchSession('agent-test', SUBAGENT_REF, makeTask(), {
      spawnFn: mockSpawn,
      cwd: '/workspace/project',
    });

    const call = mockSpawn.lastCall();
    assert.ok(call);
    assert.equal(call.opts.cwd, '/workspace/project');
  });

  it('captures stderr output', async () => {
    const mockSpawn = createMockSpawn({ stderr: 'warning: something' });
    const result = await launchSession('agent-test', SUBAGENT_REF, makeTask(), { spawnFn: mockSpawn });
    assert.equal(result.stderr, 'warning: something');
  });

  it('returns non-zero exit code without rejecting', async () => {
    const mockSpawn = createMockSpawn({ exitCode: 1, stderr: 'error occurred' });
    const result = await launchSession('agent-test', SUBAGENT_REF, makeTask(), { spawnFn: mockSpawn });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, 'error occurred');
    assert.equal(result.timedOut, false);
  });

  it('rejects on spawn error', async () => {
    const mockSpawn = createMockSpawn({ error: new Error('ENOENT') });

    await assert.rejects(
      () => launchSession('agent-test', SUBAGENT_REF, makeTask(), { spawnFn: mockSpawn }),
      /CLI process error: ENOENT/
    );
  });

  it('kills process on timeout and sets timedOut flag', async () => {
    interface TimeoutTestChild extends MockChildProcess {
      _lastSignal?: string;
    }
    const child = new EventEmitter() as TimeoutTestChild;
    const stdoutStream = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });
    child.stdout = stdoutStream;
    child.stderr = stderrStream;
    child.killed = false;
    child.kill = (signal?: string) => {
      child.killed = true;
      child._lastSignal = signal;
      setImmediate(() => {
        stdoutStream.push(null);
        stderrStream.push(null);
        child.emit('close', null);
      });
      return true;
    };

    const mockSpawn = (() => child) as unknown as SpawnFn;

    const result = await launchSession('agent-test', SUBAGENT_REF, makeTask(), {
      spawnFn: mockSpawn,
      timeoutMs: 10,
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
  });

  it('passes additional env variables', async () => {
    const mockSpawn = createMockSpawn();
    await launchSession('agent-test', SUBAGENT_REF, makeTask(), {
      spawnFn: mockSpawn,
      env: { CUSTOM_VAR: 'test' },
    });

    const call = mockSpawn.lastCall();
    assert.ok(call);
    assert.equal(call.opts.env?.CUSTOM_VAR, 'test');
  });

  it('sets stdin to ignore', async () => {
    const mockSpawn = createMockSpawn();
    await launchSession('agent-test', SUBAGENT_REF, makeTask(), { spawnFn: mockSpawn });

    const call = mockSpawn.lastCall();
    assert.ok(call);
    assert.deepEqual(call.opts.stdio, ['ignore', 'pipe', 'pipe']);
  });

  it('throws if agentId is missing', async () => {
    await assert.rejects(
      () => launchSession(null as unknown as string, SUBAGENT_REF, makeTask()),
      /agentId is required/
    );
  });

  it('throws if subagentRef is missing', async () => {
    await assert.rejects(
      () => launchSession('agent-test', null as unknown as string, makeTask()),
      /subagentRef is required/
    );
  });

  it('throws if subagentRef is empty', async () => {
    await assert.rejects(
      () => launchSession('agent-test', '', makeTask()),
      /subagentRef is required/
    );
  });

  it('throws if task is missing', async () => {
    await assert.rejects(
      () => launchSession('agent-test', SUBAGENT_REF, null as unknown as TaskContext),
      /task is required/
    );
  });

  it('passes model option through to CLI args', async () => {
    const mockSpawn = createMockSpawn();
    await launchSession('agent-test', SUBAGENT_REF, makeTask(), {
      spawnFn: mockSpawn,
      model: 'opus',
    });

    const call = mockSpawn.lastCall();
    assert.ok(call);
    const modelIdx = call.args.indexOf('--model');
    assert.ok(modelIdx >= 0);
    assert.equal(call.args[modelIdx + 1], 'opus');
  });

  it('cliArgs in result match what was passed to spawn', async () => {
    const mockSpawn = createMockSpawn();
    const result = await launchSession('agent-test', SUBAGENT_REF, makeTask(), {
      spawnFn: mockSpawn,
      model: 'sonnet',
    });

    const call = mockSpawn.lastCall();
    assert.ok(call);
    assert.deepEqual(result.cliArgs, call.args);
  });

  it('rejects when spawnFn throws synchronously', async () => {
    const badSpawn = (() => { throw new Error('spawn failed'); }) as unknown as SpawnFn;
    await assert.rejects(
      () => launchSession('agent-test', SUBAGENT_REF, makeTask(), { spawnFn: badSpawn }),
      /Failed to spawn CLI process: spawn failed/
    );
  });
});

// ===========================================================================
// buildSessionConfig
// ===========================================================================
describe('buildSessionConfig', () => {
  it('extracts subagentRef and task from agent config and selected task', () => {
    const config = makeAgentConfig();
    const task = makeSelectedTask();

    const result = buildSessionConfig(config, task, { week: '2026-W16' });

    assert.equal(result.agentId, 'research-bot');
    assert.equal(result.subagentRef, 'research-bot');
    assert.equal(result.task.taskId, 'task-abc12345');
    assert.equal(result.task.title, 'Gather quarterly revenue data');
    assert.equal(result.task.objectiveId, 'obj-xyz98765');
    assert.equal(result.task.week, '2026-W16');
  });

  it('does NOT return an identity field (identity lives in the subagent .md)', () => {
    const config = makeAgentConfig();
    const task = makeSelectedTask();
    const result = buildSessionConfig(config, task) as { identity?: unknown };
    assert.equal(result.identity, undefined);
  });

  it('includes additional context when provided', () => {
    const config = makeAgentConfig();
    const task = makeSelectedTask();
    const result = buildSessionConfig(config, task, { additionalContext: 'Extra info' });
    assert.equal(result.task.additionalContext, 'Extra info');
  });

  it('works without optional opts', () => {
    const config = makeAgentConfig();
    const task = makeSelectedTask();
    const result = buildSessionConfig(config, task);

    assert.equal(result.task.week, undefined);
    assert.equal(result.task.additionalContext, undefined);
  });

  it('throws if agentConfig is missing', () => {
    assert.throws(
      () => buildSessionConfig(null, makeSelectedTask()),
      /agentConfig is required/
    );
  });

  it('throws if agentConfig.id is missing', () => {
    assert.throws(
      () => buildSessionConfig(
        { subagentRef: 'x' } as unknown as BuildSessionAgentConfig,
        makeSelectedTask(),
      ),
      /agentConfig\.id is required/
    );
  });

  it('throws if agentConfig.subagentRef is missing', () => {
    assert.throws(
      () => buildSessionConfig(
        { id: 'x' } as unknown as BuildSessionAgentConfig,
        makeSelectedTask(),
      ),
      /agentConfig\.subagentRef is required/
    );
  });

  it('throws if selectedTask is missing', () => {
    assert.throws(
      () => buildSessionConfig(makeAgentConfig(), null),
      /selectedTask is required/
    );
  });

  it('throws if selectedTask.id is missing', () => {
    assert.throws(
      () => buildSessionConfig(
        makeAgentConfig(),
        { title: 'd', prompt: 'd' } as unknown as BuildSessionSelectedTask,
      ),
      /selectedTask\.id is required/
    );
  });

  it('throws if selectedTask.prompt is missing', () => {
    assert.throws(
      () => buildSessionConfig(
        makeAgentConfig(),
        { id: 't' } as unknown as BuildSessionSelectedTask,
      ),
      /selectedTask\.prompt is required/
    );
  });
});

// ===========================================================================
// parseTokenUsage
// ===========================================================================
describe('parseTokenUsage', () => {
  it('parses token usage from valid JSON output', () => {
    const output = JSON.stringify({
      result: 'done',
      usage: { input_tokens: 1000, output_tokens: 500 },
      cost_usd: 0.05,
    });

    const usage = parseTokenUsage(output);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 1000);
    assert.equal(usage.outputTokens, 500);
    assert.equal(usage.totalTokens, 1500);
    assert.equal(usage.costUsd, 0.05);
  });

  it('parses nested usage from result.usage', () => {
    const output = JSON.stringify({
      result: { usage: { input_tokens: 200, output_tokens: 100 } },
    });

    const usage = parseTokenUsage(output);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 200);
    assert.equal(usage.outputTokens, 100);
    assert.equal(usage.totalTokens, 300);
  });

  it('handles camelCase token fields', () => {
    const output = JSON.stringify({
      usage: { inputTokens: 300, outputTokens: 150 },
    });

    const usage = parseTokenUsage(output);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 300);
    assert.equal(usage.outputTokens, 150);
    assert.equal(usage.totalTokens, 450);
  });

  it('returns null for null/undefined input', () => {
    assert.equal(parseTokenUsage(null), null);
    assert.equal(parseTokenUsage(undefined), null);
    assert.equal(parseTokenUsage(''), null);
  });

  it('returns null for non-string input', () => {
    assert.equal(parseTokenUsage(123), null);
  });

  it('returns null when JSON has no usage field', () => {
    const output = JSON.stringify({ result: 'ok' });
    assert.equal(parseTokenUsage(output), null);
  });

  it('parses multi-line JSON output (last line with usage)', () => {
    const lines = [
      JSON.stringify({ type: 'progress', message: 'working...' }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 500, output_tokens: 250 } }),
    ];
    const output = lines.join('\n');

    const usage = parseTokenUsage(output);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 500);
    assert.equal(usage.outputTokens, 250);
    assert.equal(usage.totalTokens, 750);
  });

  it('returns null for completely invalid output', () => {
    assert.equal(parseTokenUsage('not json at all'), null);
  });

  it('defaults missing token fields to 0', () => {
    const output = JSON.stringify({ usage: {} });
    const usage = parseTokenUsage(output);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 0);
    assert.equal(usage.outputTokens, 0);
    assert.equal(usage.totalTokens, 0);
    assert.equal(usage.costUsd, 0);
  });
});
