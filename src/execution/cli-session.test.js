/**
 * Tests for CLI Session Launcher — src/execution/cli-session.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  buildSystemPrompt,
  buildTaskPrompt,
  buildCliArgs,
  launchSession,
  buildSessionConfig,
  parseTokenUsage,
} from './cli-session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid agent identity */
function makeIdentity(overrides = {}) {
  return {
    name: 'ResearchBot',
    role: 'Research Assistant',
    systemPrompt: 'You are a research assistant focused on gathering data.',
    ...overrides,
  };
}

/** Minimal valid task context */
function makeTask(overrides = {}) {
  return {
    taskId: 'task-abc12345',
    description: 'Gather quarterly revenue data from public filings',
    ...overrides,
  };
}

/** Minimal valid agent config (as stored by AgentStore) */
function makeAgentConfig(overrides = {}) {
  return {
    id: 'agent-research-bot-1a2b3c4d',
    identity: makeIdentity(),
    goals: [],
    monthlyPlans: [],
    weeklyPlans: [],
    budget: { weeklyTokenLimit: 500000, currentUsage: 0 },
    inbox: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Minimal selected task (as returned by task-selector) */
function makeSelectedTask(overrides = {}) {
  return {
    id: 'task-abc12345',
    description: 'Gather quarterly revenue data',
    objectiveId: 'obj-xyz98765',
    priority: 'high',
    status: 'pending',
    ...overrides,
  };
}

/**
 * Create a mock spawn function that returns a fake child process.
 * The returned child emits close with the given exit code after stdout/stderr.
 */
function createMockSpawn({ exitCode = 0, stdout = '', stderr = '', error = null, delay = 0 } = {}) {
  let lastCall = null;

  function mockSpawn(cmd, args, opts) {
    lastCall = { cmd, args, opts };

    const child = new EventEmitter();

    // Create readable streams for stdout/stderr
    const stdoutStream = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });
    child.stdout = stdoutStream;
    child.stderr = stderrStream;
    child.kill = () => {
      child.killed = true;
      // Simulate process termination on kill
      setImmediate(() => child.emit('close', null));
    };
    child.killed = false;

    // Push data and close asynchronously
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
  }

  mockSpawn.lastCall = () => lastCall;
  return mockSpawn;
}

// ===========================================================================
// buildSystemPrompt
// ===========================================================================
describe('buildSystemPrompt', () => {
  it('composes identity into a system prompt string', () => {
    const identity = makeIdentity();
    const result = buildSystemPrompt(identity);

    assert.ok(result.includes('You are ResearchBot'));
    assert.ok(result.includes('Research Assistant'));
    assert.ok(result.includes('research assistant focused on gathering data'));
  });

  it('throws if identity is missing', () => {
    assert.throws(() => buildSystemPrompt(null), /identity is required/);
  });

  it('throws if name is missing', () => {
    assert.throws(
      () => buildSystemPrompt({ role: 'r', systemPrompt: 's' }),
      /identity\.name is required/
    );
  });

  it('throws if role is missing', () => {
    assert.throws(
      () => buildSystemPrompt({ name: 'n', systemPrompt: 's' }),
      /identity\.role is required/
    );
  });

  it('throws if systemPrompt is missing', () => {
    assert.throws(
      () => buildSystemPrompt({ name: 'n', role: 'r' }),
      /identity\.systemPrompt is required/
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

    assert.ok(result.includes('## Task: Gather quarterly revenue data'));
    assert.ok(result.includes('Task ID: task-abc12345'));
    assert.ok(result.includes('## Instructions'));
  });

  it('includes objectiveId when provided', () => {
    const task = makeTask({ objectiveId: 'obj-xyz' });
    const result = buildTaskPrompt(task);
    assert.ok(result.includes('Objective ID: obj-xyz'));
  });

  it('includes week when provided', () => {
    const task = makeTask({ week: '2026-W16' });
    const result = buildTaskPrompt(task);
    assert.ok(result.includes('Week: 2026-W16'));
  });

  it('includes additional context when provided', () => {
    const task = makeTask({ additionalContext: 'Focus on Q1 2026 data only.' });
    const result = buildTaskPrompt(task);
    assert.ok(result.includes('## Additional Context'));
    assert.ok(result.includes('Focus on Q1 2026 data only.'));
  });

  it('omits optional fields when not provided', () => {
    const task = makeTask();
    const result = buildTaskPrompt(task);
    assert.ok(!result.includes('Objective ID:'));
    assert.ok(!result.includes('Week:'));
    assert.ok(!result.includes('## Additional Context'));
  });

  it('throws if task is missing', () => {
    assert.throws(() => buildTaskPrompt(null), /task is required/);
  });

  it('throws if taskId is missing', () => {
    assert.throws(
      () => buildTaskPrompt({ description: 'd' }),
      /task\.taskId is required/
    );
  });

  it('throws if description is missing', () => {
    assert.throws(
      () => buildTaskPrompt({ taskId: 't' }),
      /task\.description is required/
    );
  });
});

// ===========================================================================
// buildCliArgs
// ===========================================================================
describe('buildCliArgs', () => {
  it('builds base CLI args with --print and --output-format json', () => {
    const identity = makeIdentity();
    const task = makeTask();
    const args = buildCliArgs(identity, task);

    assert.ok(args.includes('--print'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('json'));
    assert.ok(args.includes('--system-prompt'));
  });

  it('includes system prompt as argument value', () => {
    const identity = makeIdentity();
    const task = makeTask();
    const args = buildCliArgs(identity, task);

    const sysIdx = args.indexOf('--system-prompt');
    assert.ok(sysIdx >= 0);
    const systemPrompt = args[sysIdx + 1];
    assert.ok(systemPrompt.includes('ResearchBot'));
  });

  it('user prompt is the last argument', () => {
    const identity = makeIdentity();
    const task = makeTask();
    const args = buildCliArgs(identity, task);

    const lastArg = args[args.length - 1];
    assert.ok(lastArg.includes('## Task:'));
    assert.ok(lastArg.includes(task.description));
  });

  it('includes --model when specified', () => {
    const args = buildCliArgs(makeIdentity(), makeTask(), { model: 'opus' });
    const idx = args.indexOf('--model');
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], 'opus');
  });

  it('includes --verbose when specified', () => {
    const args = buildCliArgs(makeIdentity(), makeTask(), { verbose: true });
    assert.ok(args.includes('--verbose'));
  });

  it('includes --dangerously-skip-permissions when specified', () => {
    const args = buildCliArgs(makeIdentity(), makeTask(), { dangerouslySkipPermissions: true });
    assert.ok(args.includes('--dangerously-skip-permissions'));
  });

  it('omits optional flags by default', () => {
    const args = buildCliArgs(makeIdentity(), makeTask());
    assert.ok(!args.includes('--model'));
    assert.ok(!args.includes('--verbose'));
    assert.ok(!args.includes('--dangerously-skip-permissions'));
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
      makeIdentity(),
      makeTask(),
      { spawnFn: mockSpawn }
    );

    assert.equal(result.agentId, 'agent-test');
    assert.equal(result.taskId, 'task-abc12345');
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, '{"result":"ok"}');
    assert.equal(result.stderr, '');
    assert.ok(result.startedAt);
    assert.ok(result.completedAt);
    assert.ok(typeof result.durationMs === 'number');
    assert.ok(Array.isArray(result.cliArgs));
  });

  it('passes correct CLI binary and args to spawn', async () => {
    const mockSpawn = createMockSpawn();

    await launchSession('agent-test', makeIdentity(), makeTask(), {
      spawnFn: mockSpawn,
      cli: '/usr/local/bin/claude',
    });

    const call = mockSpawn.lastCall();
    assert.equal(call.cmd, '/usr/local/bin/claude');
    assert.ok(call.args.includes('--print'));
    assert.ok(call.args.includes('--system-prompt'));
  });

  it('defaults CLI to "claude"', async () => {
    const mockSpawn = createMockSpawn();
    await launchSession('agent-test', makeIdentity(), makeTask(), { spawnFn: mockSpawn });
    assert.equal(mockSpawn.lastCall().cmd, 'claude');
  });

  it('passes cwd to spawn when specified', async () => {
    const mockSpawn = createMockSpawn();
    await launchSession('agent-test', makeIdentity(), makeTask(), {
      spawnFn: mockSpawn,
      cwd: '/workspace/project',
    });

    assert.equal(mockSpawn.lastCall().opts.cwd, '/workspace/project');
  });

  it('captures stderr output', async () => {
    const mockSpawn = createMockSpawn({ stderr: 'warning: something' });
    const result = await launchSession('agent-test', makeIdentity(), makeTask(), { spawnFn: mockSpawn });
    assert.equal(result.stderr, 'warning: something');
  });

  it('returns non-zero exit code without rejecting', async () => {
    const mockSpawn = createMockSpawn({ exitCode: 1, stderr: 'error occurred' });
    const result = await launchSession('agent-test', makeIdentity(), makeTask(), { spawnFn: mockSpawn });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, 'error occurred');
    assert.equal(result.timedOut, false);
  });

  it('rejects on spawn error', async () => {
    const mockSpawn = createMockSpawn({ error: new Error('ENOENT') });

    await assert.rejects(
      () => launchSession('agent-test', makeIdentity(), makeTask(), { spawnFn: mockSpawn }),
      /CLI process error: ENOENT/
    );
  });

  it('kills process on timeout and sets timedOut flag', async () => {
    // Create a mock that never closes on its own
    const child = new EventEmitter();
    const stdoutStream = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });
    child.stdout = stdoutStream;
    child.stderr = stderrStream;
    child.killed = false;
    child.kill = (signal) => {
      child.killed = true;
      child._lastSignal = signal;
      // Simulate close after kill
      setImmediate(() => {
        stdoutStream.push(null);
        stderrStream.push(null);
        child.emit('close', null);
      });
    };

    const mockSpawn = () => child;

    const result = await launchSession('agent-test', makeIdentity(), makeTask(), {
      spawnFn: mockSpawn,
      timeoutMs: 10, // very short timeout
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
  });

  it('passes additional env variables', async () => {
    const mockSpawn = createMockSpawn();
    await launchSession('agent-test', makeIdentity(), makeTask(), {
      spawnFn: mockSpawn,
      env: { CUSTOM_VAR: 'test' },
    });

    const call = mockSpawn.lastCall();
    assert.equal(call.opts.env.CUSTOM_VAR, 'test');
  });

  it('sets stdin to ignore', async () => {
    const mockSpawn = createMockSpawn();
    await launchSession('agent-test', makeIdentity(), makeTask(), { spawnFn: mockSpawn });

    const call = mockSpawn.lastCall();
    assert.deepEqual(call.opts.stdio, ['ignore', 'pipe', 'pipe']);
  });

  it('throws if agentId is missing', async () => {
    await assert.rejects(
      () => launchSession(null, makeIdentity(), makeTask()),
      /agentId is required/
    );
  });

  it('throws if identity is missing', async () => {
    await assert.rejects(
      () => launchSession('agent-test', null, makeTask()),
      /identity is required/
    );
  });

  it('throws if task is missing', async () => {
    await assert.rejects(
      () => launchSession('agent-test', makeIdentity(), null),
      /task is required/
    );
  });

  it('passes model option through to CLI args', async () => {
    const mockSpawn = createMockSpawn();
    await launchSession('agent-test', makeIdentity(), makeTask(), {
      spawnFn: mockSpawn,
      model: 'opus',
    });

    const call = mockSpawn.lastCall();
    const modelIdx = call.args.indexOf('--model');
    assert.ok(modelIdx >= 0);
    assert.equal(call.args[modelIdx + 1], 'opus');
  });

  it('cliArgs in result match what was passed to spawn', async () => {
    const mockSpawn = createMockSpawn();
    const result = await launchSession('agent-test', makeIdentity(), makeTask(), {
      spawnFn: mockSpawn,
      model: 'sonnet',
    });

    assert.deepEqual(result.cliArgs, mockSpawn.lastCall().args);
  });

  it('rejects when spawnFn throws synchronously', async () => {
    const badSpawn = () => { throw new Error('spawn failed'); };
    await assert.rejects(
      () => launchSession('agent-test', makeIdentity(), makeTask(), { spawnFn: badSpawn }),
      /Failed to spawn CLI process: spawn failed/
    );
  });
});

// ===========================================================================
// buildSessionConfig
// ===========================================================================
describe('buildSessionConfig', () => {
  it('extracts identity and task from agent config and selected task', () => {
    const config = makeAgentConfig();
    const task = makeSelectedTask();

    const result = buildSessionConfig(config, task, { week: '2026-W16' });

    assert.equal(result.agentId, 'agent-research-bot-1a2b3c4d');
    assert.equal(result.identity.name, 'ResearchBot');
    assert.equal(result.identity.role, 'Research Assistant');
    assert.ok(result.identity.systemPrompt);
    assert.equal(result.task.taskId, 'task-abc12345');
    assert.equal(result.task.description, 'Gather quarterly revenue data');
    assert.equal(result.task.objectiveId, 'obj-xyz98765');
    assert.equal(result.task.week, '2026-W16');
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
      () => buildSessionConfig({ identity: makeIdentity() }, makeSelectedTask()),
      /agentConfig\.id is required/
    );
  });

  it('throws if agentConfig.identity is missing', () => {
    assert.throws(
      () => buildSessionConfig({ id: 'x' }, makeSelectedTask()),
      /agentConfig\.identity is required/
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
      () => buildSessionConfig(makeAgentConfig(), { description: 'd' }),
      /selectedTask\.id is required/
    );
  });

  it('throws if selectedTask.description is missing', () => {
    assert.throws(
      () => buildSessionConfig(makeAgentConfig(), { id: 't' }),
      /selectedTask\.description is required/
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
    assert.equal(usage.inputTokens, 200);
    assert.equal(usage.outputTokens, 100);
    assert.equal(usage.totalTokens, 300);
  });

  it('handles camelCase token fields', () => {
    const output = JSON.stringify({
      usage: { inputTokens: 300, outputTokens: 150 },
    });

    const usage = parseTokenUsage(output);
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
    assert.equal(usage.inputTokens, 0);
    assert.equal(usage.outputTokens, 0);
    assert.equal(usage.totalTokens, 0);
    assert.equal(usage.costUsd, 0);
  });
});
