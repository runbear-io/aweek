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
import { Writable } from 'node:stream';
import {
  buildRuntimeContext,
  buildTaskPrompt,
  buildCliArgs,
  buildProjectClaudeCliArgs,
  launchSession,
  buildSessionConfig,
  parseTokenUsage,
  spawnProjectClaudeSession,
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

// ===========================================================================
// buildProjectClaudeCliArgs (Slack execution surface)
// ===========================================================================
describe('buildProjectClaudeCliArgs', () => {
  it('emits the fixed Slack-mode flags by default', () => {
    const args = buildProjectClaudeCliArgs();
    assert.ok(args.includes('--print'));
    const ofIdx = args.indexOf('--output-format');
    assert.ok(ofIdx >= 0);
    assert.equal(args[ofIdx + 1], 'stream-json');
    assert.ok(args.includes('--verbose'));
    assert.ok(args.includes('--dangerously-skip-permissions'));
  });

  it('NEVER includes --agent (project-level Claude in v1)', () => {
    const args = buildProjectClaudeCliArgs({
      resumeSessionId: 'sess-1',
      systemPromptAppend: 'You are in Slack mode.',
      model: 'opus',
    });
    assert.ok(!args.includes('--agent'));
  });

  it('appends --resume <id> when resumeSessionId is set', () => {
    const args = buildProjectClaudeCliArgs({ resumeSessionId: 'sess-abc' });
    const idx = args.indexOf('--resume');
    assert.ok(idx >= 0, 'expected --resume in argv');
    assert.equal(args[idx + 1], 'sess-abc');
  });

  it('omits --resume when resumeSessionId is undefined', () => {
    const args = buildProjectClaudeCliArgs();
    assert.ok(!args.includes('--resume'));
  });

  it('omits --resume when resumeSessionId is the empty string', () => {
    // Empty string must be treated identically to undefined — passing
    // `--resume ""` to the CLI is a hard error and an empty string is
    // a common "no session yet" sentinel.
    const args = buildProjectClaudeCliArgs({ resumeSessionId: '' });
    assert.ok(!args.includes('--resume'));
  });

  it('appends --append-system-prompt <banner> when set', () => {
    const banner = 'You are running in Slack-mode (conversational chat).';
    const args = buildProjectClaudeCliArgs({ systemPromptAppend: banner });
    const idx = args.indexOf('--append-system-prompt');
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], banner);
  });

  it('omits --append-system-prompt when systemPromptAppend is empty', () => {
    const args = buildProjectClaudeCliArgs({ systemPromptAppend: '' });
    assert.ok(!args.includes('--append-system-prompt'));
  });

  it('appends --model when set', () => {
    const args = buildProjectClaudeCliArgs({ model: 'opus' });
    const idx = args.indexOf('--model');
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], 'opus');
  });

  it('omits --model when not set', () => {
    const args = buildProjectClaudeCliArgs();
    assert.ok(!args.includes('--model'));
  });
});

// ===========================================================================
// spawnProjectClaudeSession (Slack execution surface)
// ===========================================================================
describe('spawnProjectClaudeSession', () => {
  // ---- Mock helper: child with stdin ----------------------------------
  interface ProjectClaudeMockChild extends EventEmitter {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable & { writes: string[]; ended: boolean };
    kill: (signal?: string) => boolean;
    killed: boolean;
    _signals: string[];
  }

  interface ProjectClaudeSpawnCall {
    cmd: string;
    args: ReadonlyArray<string>;
    opts: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      stdio?: unknown;
    };
  }

  interface ProjectClaudeMockSpawn extends SpawnFn {
    lastCall: () => ProjectClaudeSpawnCall | null;
    lastChild: () => ProjectClaudeMockChild | null;
  }

  interface ProjectClaudeMockOpts {
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error | null;
    /** When true, the child does not auto-close — the test drives the lifecycle. */
    manual?: boolean;
    /**
     * When true, the child auto-closes on first SIGTERM. Use to verify
     * abort-driven graceful kill.
     */
    closeOnSigterm?: boolean;
  }

  function createProjectClaudeMockSpawn(
    cfg: ProjectClaudeMockOpts = {},
  ): ProjectClaudeMockSpawn {
    let lastCall: ProjectClaudeSpawnCall | null = null;
    let lastChild: ProjectClaudeMockChild | null = null;

    const mockSpawn = ((cmd: string, args: ReadonlyArray<string>, opts: ProjectClaudeSpawnCall['opts']) => {
      lastCall = { cmd, args, opts };

      const child = new EventEmitter() as ProjectClaudeMockChild;
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      const stdinWrites: string[] = [];
      const stdinStream = new Writable({
        write(chunk, _encoding, cb) {
          stdinWrites.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
          cb();
        },
      }) as ProjectClaudeMockChild['stdin'];
      stdinStream.writes = stdinWrites;
      stdinStream.ended = false;
      const origEnd = stdinStream.end.bind(stdinStream);
      stdinStream.end = (...args: Parameters<typeof origEnd>) => {
        stdinStream.ended = true;
        return origEnd(...args);
      };

      child.stdout = stdoutStream;
      child.stderr = stderrStream;
      child.stdin = stdinStream;
      child.killed = false;
      child._signals = [];

      child.kill = (signal?: string) => {
        child.killed = true;
        child._signals.push(signal || 'SIGTERM');
        if (cfg.closeOnSigterm && (signal === 'SIGTERM' || signal === undefined)) {
          setImmediate(() => {
            stdoutStream.push(null);
            stderrStream.push(null);
            child.emit('close', null);
          });
        }
        return true;
      };

      lastChild = child;

      setImmediate(() => {
        if (cfg.error) {
          child.emit('error', cfg.error);
          return;
        }
        if (cfg.manual || cfg.closeOnSigterm) {
          // Push any pre-arranged stdout / stderr but leave the streams
          // open so the test can drive the lifecycle.
          if (cfg.stdout) stdoutStream.push(cfg.stdout);
          if (cfg.stderr) stderrStream.push(cfg.stderr);
          return;
        }
        if (cfg.stdout) stdoutStream.push(cfg.stdout);
        stdoutStream.push(null);
        if (cfg.stderr) stderrStream.push(cfg.stderr);
        stderrStream.push(null);
        setImmediate(() => child.emit('close', cfg.exitCode ?? 0));
      });

      return child;
    }) as unknown as ProjectClaudeMockSpawn;

    mockSpawn.lastCall = () => lastCall;
    mockSpawn.lastChild = () => lastChild;
    return mockSpawn;
  }

  // ---- argv / cwd / cli wiring ---------------------------------------
  it('passes the project-Claude argv and cwd through to spawn', async () => {
    const mockSpawn = createProjectClaudeMockSpawn({ exitCode: 0 });
    const result = await spawnProjectClaudeSession({
      cwd: '/work/project',
      prompt: 'hello',
      spawnFn: mockSpawn,
    });

    const call = mockSpawn.lastCall();
    assert.ok(call);
    assert.equal(call.cmd, 'claude');
    assert.equal(call.opts.cwd, '/work/project');
    assert.deepEqual(call.opts.stdio, ['pipe', 'pipe', 'pipe']);
    assert.ok(call.args.includes('--print'));
    assert.ok(call.args.includes('--output-format'));
    assert.ok(call.args.includes('stream-json'));
    assert.ok(call.args.includes('--verbose'));
    assert.ok(call.args.includes('--dangerously-skip-permissions'));
    assert.ok(!call.args.includes('--agent'));
    assert.deepEqual(result.cliArgs, call.args);
    assert.equal(result.exitCode, 0);
    assert.equal(result.killed, false);
  });

  it('honours the cli override', async () => {
    const mockSpawn = createProjectClaudeMockSpawn();
    await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'p',
      cli: '/usr/local/bin/claude',
      spawnFn: mockSpawn,
    });
    const call = mockSpawn.lastCall();
    assert.ok(call);
    assert.equal(call.cmd, '/usr/local/bin/claude');
  });

  it('appends --resume <id> when resumeSessionId is set', async () => {
    const mockSpawn = createProjectClaudeMockSpawn();
    await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'p',
      resumeSessionId: 'sess-42',
      spawnFn: mockSpawn,
    });
    const call = mockSpawn.lastCall();
    assert.ok(call);
    const idx = call.args.indexOf('--resume');
    assert.ok(idx >= 0);
    assert.equal(call.args[idx + 1], 'sess-42');
  });

  it('appends --append-system-prompt <banner> when set', async () => {
    const mockSpawn = createProjectClaudeMockSpawn();
    const banner = 'Slack-mode banner';
    await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'p',
      systemPromptAppend: banner,
      spawnFn: mockSpawn,
    });
    const call = mockSpawn.lastCall();
    assert.ok(call);
    const idx = call.args.indexOf('--append-system-prompt');
    assert.ok(idx >= 0);
    assert.equal(call.args[idx + 1], banner);
  });

  it('passes additional env variables', async () => {
    const mockSpawn = createProjectClaudeMockSpawn();
    await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'p',
      env: { SLACK_THREAD_KEY: 'slack:C1:T2' },
      spawnFn: mockSpawn,
    });
    const call = mockSpawn.lastCall();
    assert.ok(call);
    assert.equal(call.opts.env?.SLACK_THREAD_KEY, 'slack:C1:T2');
  });

  // ---- stdin prompt piping -------------------------------------------
  it('pipes the prompt to stdin and ends stdin', async () => {
    const mockSpawn = createProjectClaudeMockSpawn({ exitCode: 0 });
    await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'Hello, project Claude — multi-line\nprompt with "quotes".',
      spawnFn: mockSpawn,
    });
    const child = mockSpawn.lastChild();
    assert.ok(child);
    assert.equal(child.stdin.writes.join(''), 'Hello, project Claude — multi-line\nprompt with "quotes".');
    assert.equal(child.stdin.ended, true);
  });

  it('accepts an empty-string prompt (still ends stdin)', async () => {
    const mockSpawn = createProjectClaudeMockSpawn({ exitCode: 0 });
    await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: '',
      spawnFn: mockSpawn,
    });
    const child = mockSpawn.lastChild();
    assert.ok(child);
    assert.equal(child.stdin.writes.join(''), '');
    assert.equal(child.stdin.ended, true);
  });

  // ---- stdout line streaming -----------------------------------------
  it('delivers stdout lines to onStdoutLine in arrival order', async () => {
    const ndjson = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","content":"hi"}',
      '{"type":"result","usage":{"input_tokens":10,"output_tokens":2}}',
    ].join('\n');
    const mockSpawn = createProjectClaudeMockSpawn({
      exitCode: 0,
      stdout: ndjson,
    });
    const lines: string[] = [];
    await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'p',
      spawnFn: mockSpawn,
      onStdoutLine: (line) => lines.push(line),
    });
    assert.deepEqual(lines, [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","content":"hi"}',
      '{"type":"result","usage":{"input_tokens":10,"output_tokens":2}}',
    ]);
  });

  it('swallows onStdoutLine listener errors so the spawn still resolves', async () => {
    const mockSpawn = createProjectClaudeMockSpawn({
      exitCode: 0,
      stdout: 'line-a\nline-b\n',
    });
    const result = await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'p',
      spawnFn: mockSpawn,
      onStdoutLine: () => { throw new Error('listener bug'); },
    });
    assert.equal(result.exitCode, 0);
  });

  // ---- stderr capture -------------------------------------------------
  it('captures stderr both as a buffered string and via onStderrChunk', async () => {
    const mockSpawn = createProjectClaudeMockSpawn({
      exitCode: 1,
      stderr: 'boom: bad arg\n',
    });
    const chunks: string[] = [];
    const result = await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'p',
      spawnFn: mockSpawn,
      onStderrChunk: (c) => chunks.push(c),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, 'boom: bad arg\n');
    assert.equal(chunks.join(''), 'boom: bad arg\n');
  });

  // ---- exit code handling --------------------------------------------
  it('returns non-zero exit codes without rejecting', async () => {
    const mockSpawn = createProjectClaudeMockSpawn({ exitCode: 7, stderr: 'x' });
    const result = await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'p',
      spawnFn: mockSpawn,
    });
    assert.equal(result.exitCode, 7);
    assert.equal(result.killed, false);
    assert.equal(result.stderr, 'x');
  });

  // ---- abort lifecycle -----------------------------------------------
  it('returns immediately with killed=true when the signal is already aborted', async () => {
    const mockSpawn = createProjectClaudeMockSpawn();
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'p',
      signal: ctrl.signal,
      spawnFn: mockSpawn,
    });
    assert.equal(result.killed, true);
    assert.equal(result.exitCode, null);
    // No spawn should have happened.
    assert.equal(mockSpawn.lastCall(), null);
  });

  it('kills the child via SIGTERM when the signal aborts mid-run', async () => {
    const mockSpawn = createProjectClaudeMockSpawn({ closeOnSigterm: true });
    const ctrl = new AbortController();
    const p = spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'p',
      signal: ctrl.signal,
      spawnFn: mockSpawn,
    });
    // Give the spawn a tick to settle, then abort.
    await new Promise((r) => setImmediate(r));
    ctrl.abort();
    const result = await p;
    assert.equal(result.killed, true);
    assert.equal(result.exitCode, null);
    const child = mockSpawn.lastChild();
    assert.ok(child);
    assert.ok(child._signals.includes('SIGTERM'));
  });

  it('does not crash if abort fires after the child already exited', async () => {
    const mockSpawn = createProjectClaudeMockSpawn({ exitCode: 0 });
    const ctrl = new AbortController();
    const result = await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'p',
      signal: ctrl.signal,
      spawnFn: mockSpawn,
    });
    // Late abort — must be a no-op.
    ctrl.abort();
    assert.equal(result.exitCode, 0);
    assert.equal(result.killed, false);
  });

  // ---- spawn failures -------------------------------------------------
  it('rejects when spawnFn throws synchronously', async () => {
    const badSpawn = (() => { throw new Error('ENOENT'); }) as unknown as SpawnFn;
    await assert.rejects(
      () => spawnProjectClaudeSession({
        cwd: '/x',
        prompt: 'p',
        spawnFn: badSpawn,
      }),
      /Failed to spawn CLI process: ENOENT/,
    );
  });

  it('rejects on async child error event', async () => {
    const mockSpawn = createProjectClaudeMockSpawn({ error: new Error('crashed') });
    await assert.rejects(
      () => spawnProjectClaudeSession({
        cwd: '/x',
        prompt: 'p',
        spawnFn: mockSpawn,
      }),
      /CLI process error: crashed/,
    );
  });

  // ---- input validation ----------------------------------------------
  it('throws when cwd is missing', async () => {
    await assert.rejects(
      () => spawnProjectClaudeSession({
        cwd: '' as string,
        prompt: 'p',
      }),
      /cwd is required/,
    );
  });

  it('throws when prompt is not a string', async () => {
    await assert.rejects(
      () => spawnProjectClaudeSession({
        cwd: '/x',
        prompt: 123 as unknown as string,
      }),
      /prompt must be a string/,
    );
  });
});

// ===========================================================================
// Sub-AC 5: --append-system-prompt flag wiring (banner end-to-end)
// ===========================================================================
//
// The seed contract requires Slack-driven runs to inject a Slack-mode
// banner via `--append-system-prompt`. This block locks down the wiring
// from the slack-bridge constant through {@link buildProjectClaudeCliArgs}
// and out of {@link spawnProjectClaudeSession} as a single argv pair —
// so a future refactor that splits, repeats, or drops the flag is caught
// at test time.
//
// The simpler "is the flag in argv when set?" / "is it omitted when
// unset?" assertions live in the buildProjectClaudeCliArgs and
// spawnProjectClaudeSession describes above; this block is the
// integration-style end-to-end wiring contract.
describe('Sub-AC 5: --append-system-prompt flag wiring (banner end-to-end)', () => {
  // Re-import locally so the dynamic import lives next to the
  // assertions that depend on it; keeps the contract self-contained
  // to this block rather than threading a top-of-file import that
  // would suggest broader coupling.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const slackBridgeModule = '../serve/slack-bridge.js';

  it('the SLACK_SYSTEM_PROMPT_BANNER from slack-bridge flows through buildProjectClaudeCliArgs verbatim', async () => {
    const { SLACK_SYSTEM_PROMPT_BANNER } = await import(slackBridgeModule);
    const args = buildProjectClaudeCliArgs({
      systemPromptAppend: SLACK_SYSTEM_PROMPT_BANNER,
    });
    const idx = args.indexOf('--append-system-prompt');
    assert.ok(idx >= 0, '--append-system-prompt must appear in argv');
    assert.strictEqual(
      args[idx + 1],
      SLACK_SYSTEM_PROMPT_BANNER,
      'the constant flows through verbatim, no re-quoting / re-wrapping',
    );
  });

  it('emits exactly ONE --append-system-prompt pair (no duplication)', () => {
    const banner = 'banner-x';
    const args = buildProjectClaudeCliArgs({ systemPromptAppend: banner });
    const occurrences = args.filter((a) => a === '--append-system-prompt');
    assert.equal(
      occurrences.length,
      1,
      `--append-system-prompt must appear exactly once, got ${occurrences.length}`,
    );
  });

  it('preserves multi-line banners verbatim (no line splitting)', () => {
    const banner = 'line one\nline two\nline three with "quotes" and a tab\there';
    const args = buildProjectClaudeCliArgs({ systemPromptAppend: banner });
    const idx = args.indexOf('--append-system-prompt');
    assert.ok(idx >= 0);
    assert.strictEqual(
      args[idx + 1],
      banner,
      'multi-line banner must reach argv as a single string with all whitespace intact',
    );
  });

  it('preserves shell-metachar banners verbatim (no escaping)', () => {
    // The CLI is spawned via execve, not /bin/sh, so the banner
    // must NOT be shell-escaped. Round-trip a banner full of
    // metachars to lock that down.
    const banner = `$VAR \`backtick\` && echo "x" | cat ; rm -rf / # comment`;
    const args = buildProjectClaudeCliArgs({ systemPromptAppend: banner });
    const idx = args.indexOf('--append-system-prompt');
    assert.ok(idx >= 0);
    assert.strictEqual(args[idx + 1], banner);
  });

  it('treats undefined and empty-string banners identically — flag omitted', () => {
    const fromUndefined = buildProjectClaudeCliArgs({});
    const fromEmpty = buildProjectClaudeCliArgs({ systemPromptAppend: '' });
    assert.ok(!fromUndefined.includes('--append-system-prompt'));
    assert.ok(!fromEmpty.includes('--append-system-prompt'));
  });

  it('--append-system-prompt comes after the fixed Slack-mode flags', () => {
    // Ordering matters for human readability of the argv when it
    // shows up in `aweek serve` logs / debug traces. Lock it down
    // so a future refactor that re-orders the args (e.g. to put
    // --model first) doesn't accidentally interleave the banner
    // between --print and --output-format.
    const args = buildProjectClaudeCliArgs({
      systemPromptAppend: 'banner',
      resumeSessionId: 'sess-1',
    });
    const printIdx = args.indexOf('--print');
    const ofIdx = args.indexOf('--output-format');
    const verboseIdx = args.indexOf('--verbose');
    const dskipIdx = args.indexOf('--dangerously-skip-permissions');
    const appendIdx = args.indexOf('--append-system-prompt');
    assert.ok(printIdx >= 0 && ofIdx >= 0 && verboseIdx >= 0 && dskipIdx >= 0 && appendIdx >= 0);
    assert.ok(appendIdx > printIdx, '--append-system-prompt after --print');
    assert.ok(appendIdx > ofIdx, '--append-system-prompt after --output-format');
    assert.ok(appendIdx > verboseIdx, '--append-system-prompt after --verbose');
    assert.ok(
      appendIdx > dskipIdx,
      '--append-system-prompt after --dangerously-skip-permissions',
    );
  });

  // ----- spawnProjectClaudeSession argv passthrough -------------------

  /**
   * Local mock factory for this block — a minimal spawn that records
   * the argv it was invoked with and auto-closes cleanly. The
   * `spawnProjectClaudeSession` describe above already has a richer
   * helper but it lives in scope of that describe; mirroring a tiny
   * version here keeps the Sub-AC 5 contract self-contained.
   */
  function makeArgvSpyMockSpawn(): { spawnFn: SpawnFn; lastArgs: () => ReadonlyArray<string> | null } {
    let lastArgs: ReadonlyArray<string> | null = null;
    const spawnFn = ((_cmd: string, args: ReadonlyArray<string>) => {
      lastArgs = args;
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        stdin: Writable;
        kill: () => boolean;
        killed: boolean;
      };
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
      child.killed = false;
      child.kill = () => { child.killed = true; return true; };
      setImmediate(() => {
        (child.stdout as Readable).push(null);
        (child.stderr as Readable).push(null);
        setImmediate(() => child.emit('close', 0));
      });
      return child;
    }) as unknown as SpawnFn;
    return { spawnFn, lastArgs: () => lastArgs };
  }

  it('spawnProjectClaudeSession with the SLACK_SYSTEM_PROMPT_BANNER passes one --append-system-prompt pair to spawn', async () => {
    const { SLACK_SYSTEM_PROMPT_BANNER } = await import(slackBridgeModule);
    const { spawnFn, lastArgs } = makeArgvSpyMockSpawn();
    const result = await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'hi',
      systemPromptAppend: SLACK_SYSTEM_PROMPT_BANNER,
      spawnFn,
    });
    const args = lastArgs();
    assert.ok(args, 'spawn was called');
    const idx = args!.indexOf('--append-system-prompt');
    assert.ok(idx >= 0, '--append-system-prompt must appear in argv');
    assert.strictEqual(
      args![idx + 1],
      SLACK_SYSTEM_PROMPT_BANNER,
      'the SLACK_SYSTEM_PROMPT_BANNER reaches spawn argv verbatim',
    );
    const occurrences = args!.filter((a) => a === '--append-system-prompt');
    assert.equal(occurrences.length, 1, 'no duplication of the banner flag');
    // Result.cliArgs should be the same argv that hit spawn.
    assert.deepEqual(result.cliArgs, args);
  });

  it('spawnProjectClaudeSession with NO banner does NOT include --append-system-prompt', async () => {
    const { spawnFn, lastArgs } = makeArgvSpyMockSpawn();
    await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'hi',
      spawnFn,
    });
    const args = lastArgs();
    assert.ok(args);
    assert.ok(
      !args!.includes('--append-system-prompt'),
      'absent banner means absent flag — no empty-string fallthrough',
    );
  });

  it('spawnProjectClaudeSession with an empty-string banner ALSO omits --append-system-prompt', async () => {
    const { spawnFn, lastArgs } = makeArgvSpyMockSpawn();
    await spawnProjectClaudeSession({
      cwd: '/x',
      prompt: 'hi',
      systemPromptAppend: '',
      spawnFn,
    });
    const args = lastArgs();
    assert.ok(args);
    assert.ok(
      !args!.includes('--append-system-prompt'),
      'empty-string banner is treated identically to undefined',
    );
  });
});
