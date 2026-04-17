/**
 * Tests for Session Executor — src/execution/session-executor.js
 *
 * Verifies that the session executor properly integrates CLI session launching
 * with automatic token usage parsing and storage.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  executeSessionWithTracking,
  weekFromPlanWeek,
  createTrackedExecutor,
} from './session-executor.js';
import { UsageStore } from '../storage/usage-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdentity(overrides = {}) {
  return {
    name: 'TestBot',
    role: 'Test Agent',
    systemPrompt: 'You are a test agent.',
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    taskId: 'task-test001',
    description: 'Run a test task',
    ...overrides,
  };
}

/**
 * Create a mock spawn that emits the given stdout/stderr and exit code.
 */
function createMockSpawn({ exitCode = 0, stdout = '', stderr = '', error = null } = {}) {
  let lastCall = null;

  function mockSpawn(cmd, args, opts) {
    lastCall = { cmd, args, opts };

    const child = new EventEmitter();
    const stdoutStream = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });
    child.stdout = stdoutStream;
    child.stderr = stderrStream;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null));
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
  }

  mockSpawn.lastCall = () => lastCall;
  return mockSpawn;
}

/** Build CLI output JSON with token usage */
function makeCliOutput({ inputTokens = 1000, outputTokens = 500, costUsd = 0.05 } = {}) {
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
    // 2026-W16 starts Monday 2026-04-13
    const result = weekFromPlanWeek('2026-W16');
    assert.equal(result, '2026-04-13');
  });

  it('converts week 1 of a year', () => {
    // 2026-W01 starts Monday 2025-12-29
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
    // 2026-W26 starts Monday 2026-06-22
    const result = weekFromPlanWeek('2026-W26');
    assert.equal(result, '2026-06-22');
  });
});

// ===========================================================================
// executeSessionWithTracking
// ===========================================================================
describe('executeSessionWithTracking', () => {
  let tmpDir;
  let usageStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-session-exec-'));
    usageStore = new UsageStore(tmpDir);
  });

  it('returns session result with parsed token usage', async () => {
    const stdout = makeCliOutput({ inputTokens: 1200, outputTokens: 600, costUsd: 0.08 });
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      makeIdentity(),
      makeTask(),
      { spawnFn: mockSpawn, usageStore }
    );

    assert.ok(result.sessionResult);
    assert.equal(result.sessionResult.agentId, 'agent-test');
    assert.equal(result.sessionResult.taskId, 'task-test001');
    assert.equal(result.sessionResult.exitCode, 0);

    assert.ok(result.tokenUsage);
    assert.equal(result.tokenUsage.inputTokens, 1200);
    assert.equal(result.tokenUsage.outputTokens, 600);
    assert.equal(result.tokenUsage.totalTokens, 1800);
    assert.equal(result.tokenUsage.costUsd, 0.08);
  });

  it('persists usage record when usageStore is provided', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      makeIdentity(),
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

    // Verify it's persisted in the store
    const records = await usageStore.load('agent-test');
    assert.equal(records.length, 1);
    assert.equal(records[0].id, result.usageRecord.id);
  });

  it('returns usageTracked=false when no usageStore provided', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      makeIdentity(),
      makeTask(),
      { spawnFn: mockSpawn }
    );

    assert.equal(result.usageTracked, false);
    assert.equal(result.usageRecord, null);
    // tokenUsage is still parsed even without store
    assert.ok(result.tokenUsage);
    assert.equal(result.tokenUsage.inputTokens, 1000);
  });

  it('returns tokenUsage=null when CLI output has no usage data', async () => {
    const stdout = JSON.stringify({ result: 'done, no usage info' });
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      makeIdentity(),
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
      makeIdentity(),
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
      makeIdentity(),
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
      makeIdentity(),
      makeTask(),
      { spawnFn: mockSpawn, usageStore, model: 'opus' }
    );

    assert.equal(result.usageRecord.model, 'opus');
  });

  it('includes durationMs from session in usage record', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      makeIdentity(),
      makeTask(),
      { spawnFn: mockSpawn, usageStore }
    );

    assert.ok(typeof result.usageRecord.durationMs === 'number');
    assert.equal(result.usageRecord.durationMs, result.sessionResult.durationMs);
  });

  it('converts plan week to usage week key', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      makeIdentity(),
      makeTask({ week: '2026-W16' }),
      { spawnFn: mockSpawn, usageStore }
    );

    assert.equal(result.usageRecord.week, '2026-04-13');
  });

  it('handles multiple sessions accumulating usage records', async () => {
    const stdout = makeCliOutput({ inputTokens: 100, outputTokens: 50 });
    const mockSpawn = createMockSpawn({ stdout });

    await executeSessionWithTracking(
      'agent-test', makeIdentity(), makeTask({ taskId: 'task-1' }),
      { spawnFn: mockSpawn, usageStore }
    );
    await executeSessionWithTracking(
      'agent-test', makeIdentity(), makeTask({ taskId: 'task-2' }),
      { spawnFn: mockSpawn, usageStore }
    );
    await executeSessionWithTracking(
      'agent-test', makeIdentity(), makeTask({ taskId: 'task-3' }),
      { spawnFn: mockSpawn, usageStore }
    );

    const records = await usageStore.load('agent-test');
    assert.equal(records.length, 3);

    const totals = await usageStore.weeklyTotal('agent-test');
    assert.equal(totals.totalTokens, 450); // 3 * 150
    assert.equal(totals.recordCount, 3);
  });

  it('gracefully degrades if usageStore.append fails', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    // Create a broken store
    const brokenStore = {
      append: async () => { throw new Error('disk full'); },
      init: async () => {},
    };

    const result = await executeSessionWithTracking(
      'agent-test',
      makeIdentity(),
      makeTask(),
      { spawnFn: mockSpawn, usageStore: brokenStore }
    );

    // Session result is still returned
    assert.ok(result.sessionResult);
    assert.equal(result.sessionResult.exitCode, 0);
    // Usage was parsed but tracking failed
    assert.ok(result.tokenUsage);
    assert.equal(result.usageTracked, false);
  });

  it('uses custom sessionId when provided', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const result = await executeSessionWithTracking(
      'agent-test',
      makeIdentity(),
      makeTask(),
      { spawnFn: mockSpawn, usageStore, sessionId: 'my-custom-session' }
    );

    assert.equal(result.usageRecord.sessionId, 'my-custom-session');
  });

  it('throws if agentId is missing', async () => {
    await assert.rejects(
      () => executeSessionWithTracking(null, makeIdentity(), makeTask()),
      /agentId is required/
    );
  });

  it('throws if identity is missing', async () => {
    await assert.rejects(
      () => executeSessionWithTracking('agent-test', null, makeTask()),
      /identity is required/
    );
  });

  it('throws if task is missing', async () => {
    await assert.rejects(
      () => executeSessionWithTracking('agent-test', makeIdentity(), null),
      /task is required/
    );
  });

  it('propagates CLI spawn errors (does not swallow)', async () => {
    const mockSpawn = createMockSpawn({ error: new Error('ENOENT') });

    await assert.rejects(
      () => executeSessionWithTracking('agent-test', makeIdentity(), makeTask(), {
        spawnFn: mockSpawn,
        usageStore,
      }),
      /CLI process error: ENOENT/
    );
  });
});

// ===========================================================================
// createTrackedExecutor
// ===========================================================================
describe('createTrackedExecutor', () => {
  let tmpDir;
  let usageStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-tracked-exec-'));
    usageStore = new UsageStore(tmpDir);
  });

  it('creates an executor function from agent configs', async () => {
    const stdout = makeCliOutput();
    const mockSpawn = createMockSpawn({ stdout });

    const agentConfigs = {
      'agent-bot': {
        id: 'agent-bot',
        identity: makeIdentity(),
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
        description: 'Execute something',
        objectiveId: 'obj-1',
        week: '2026-W16',
      },
    });

    assert.ok(result.sessionResult);
    assert.equal(result.sessionResult.agentId, 'agent-bot');
    assert.equal(result.usageTracked, true);
    assert.ok(result.usageRecord);
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
        identity: makeIdentity(),
      },
    };

    const executor = createTrackedExecutor({
      agentConfigs,
      usageStore,
      sessionOpts: { spawnFn: mockSpawn },
    });

    // No payload.description — should use taskId as fallback
    const result = await executor('agent-bot', { taskId: 'task-fallback' });

    assert.ok(result.sessionResult);
    assert.equal(result.sessionResult.taskId, 'task-fallback');
  });

  it('passes session results to usage store for multiple agents', async () => {
    const stdout = makeCliOutput({ inputTokens: 200, outputTokens: 100 });
    const mockSpawn = createMockSpawn({ stdout });

    const agentConfigs = {
      'agent-a': { id: 'agent-a', identity: makeIdentity({ name: 'AgentA' }) },
      'agent-b': { id: 'agent-b', identity: makeIdentity({ name: 'AgentB' }) },
    };

    const executor = createTrackedExecutor({
      agentConfigs,
      usageStore,
      sessionOpts: { spawnFn: mockSpawn },
    });

    await executor('agent-a', { taskId: 'task-a1', payload: { description: 'Task A1' } });
    await executor('agent-b', { taskId: 'task-b1', payload: { description: 'Task B1' } });

    const recordsA = await usageStore.load('agent-a');
    const recordsB = await usageStore.load('agent-b');
    assert.equal(recordsA.length, 1);
    assert.equal(recordsB.length, 1);
    assert.equal(recordsA[0].agentId, 'agent-a');
    assert.equal(recordsB[0].agentId, 'agent-b');
  });
});
