/**
 * Tests for the `run-once` skill.
 *
 * The real executor is never invoked — tests always inject an `executeFn`
 * stub so nothing spawns a Claude Code CLI session. Filesystem state is
 * scoped to a tmpdir so activity-log writes don't leak between cases.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentStore } from '../storage/agent-store.js';
import { ActivityLogStore } from '../storage/activity-log-store.js';
import { UsageStore } from '../storage/usage-store.js';
import { createAgentConfig } from '../models/agent.js';
import { execute, buildAdHocTask } from './run-once.js';

// Pass-through lock stub — exercises the callback path without any real
// filesystem lock. Matches the `{ status, result }` contract of
// `runWithHeartbeatLock`.
async function passThroughLock(agentId: string, callback: any): Promise<any> {
  const result = await callback(agentId);
  return { status: 'completed', agentId, result };
}

// Helper that builds a minimal stub executor whose return value matches the
// real `ExecutionResult` shape well enough for activity-log rendering.
function stubExecutor({ executionLogPath = null, tokenUsage = null }: { executionLogPath?: any; tokenUsage?: any } = {}): any {
  return async (_agentId: any, _subagentRef: any, _task: any, _opts: any) => ({
    sessionResult: {
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    },
    tokenUsage,
    usageRecord: null,
    usageTracked: false,
    executionLogPath,
  });
}

// Fresh tmpdir per test so activity-log files never leak between cases.
let baseDir: string;
let agentStore: AgentStore;
let activityLogStore: ActivityLogStore;
let usageStore: UsageStore;
const AGENT_ID = 'runonce-test';

async function setup() {
  baseDir = await mkdtemp(join(tmpdir(), 'run-once-test-'));
  agentStore = new AgentStore(baseDir);
  activityLogStore = new ActivityLogStore(baseDir);
  usageStore = new UsageStore(baseDir);

  const config = createAgentConfig({
    id: AGENT_ID,
    subagentRef: AGENT_ID,
    weeklyTokenLimit: 100000,
  });
  await agentStore.save(config);

  // Per-agent env file so the env-load branch has something to read.
  await mkdir(join(baseDir, AGENT_ID), { recursive: true });
  await writeFile(
    join(baseDir, AGENT_ID, '.env'),
    'RUNONCE_TEST_KEY=hello\n',
    'utf8',
  );
}

async function teardown() {
  await rm(baseDir, { recursive: true, force: true });
}

describe('buildAdHocTask', () => {
  it('returns an adhoc-prefixed id and defaults the title', () => {
    const task = buildAdHocTask({ prompt: 'ping' });
    assert.match(task.id, /^adhoc-[0-9a-f]{8}$/);
    assert.equal(task.title, 'Ad-hoc debug run');
    assert.equal(task.prompt, 'ping');
    assert.equal(task.status, 'in-progress');
  });

  it('honors a custom title', () => {
    const task = buildAdHocTask({ prompt: 'p', title: 'My debug probe' });
    assert.equal(task.title, 'My debug probe');
  });
});

describe('execute — confirmation gate', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('rejects when confirmed is missing', async () => {
    await assert.rejects(
      () =>
        execute({
          agentId: AGENT_ID,
          prompt: 'test',
          dataDir: baseDir,
          agentStore,
          activityLogStore,
          usageStore,
          executeFn: stubExecutor(),
          lockFn: passThroughLock,
        }),
      (err: any) => err.code === 'ERUN_NOT_CONFIRMED',
    );
  });

  it('rejects when confirmed is explicitly false', async () => {
    await assert.rejects(
      () =>
        execute({
          agentId: AGENT_ID,
          prompt: 'test',
          confirmed: false,
          dataDir: baseDir,
          agentStore,
          activityLogStore,
          usageStore,
          executeFn: stubExecutor(),
          lockFn: passThroughLock,
        }),
      (err: any) => err.code === 'ERUN_NOT_CONFIRMED',
    );
  });
});

describe('execute — unknown agent', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('rejects with ERUN_UNKNOWN_AGENT for a missing agent', async () => {
    await assert.rejects(
      () =>
        execute({
          agentId: 'agent-does-not-exist',
          prompt: 'x',
          confirmed: true,
          dataDir: baseDir,
          agentStore,
          activityLogStore,
          usageStore,
          executeFn: stubExecutor(),
          lockFn: passThroughLock,
        }),
      (err: any) => err.code === 'ERUN_UNKNOWN_AGENT',
    );
  });
});

describe('execute — force-through pause', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('runs the session even when the agent is budget-paused', async () => {
    const config: any = await agentStore.load(AGENT_ID);
    config.budget = { ...(config.budget || {}), paused: true };
    await agentStore.save(config);

    let executorCalled = false;
    const result = await execute({
      agentId: AGENT_ID,
      prompt: 'force me through',
      confirmed: true,
      dataDir: baseDir,
      agentStore,
      activityLogStore,
      usageStore,
      executeFn: async (...args: any[]) => {
        executorCalled = true;
        return (stubExecutor() as any)(...args);
      },
      lockFn: passThroughLock,
    });

    assert.equal(executorCalled, true);
    assert.equal(result.finalStatus, 'completed');
  });
});

describe('execute — env loading', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('forwards the parsed .env as opts.env', async () => {
    let receivedEnv: any = null;
    await execute({
      agentId: AGENT_ID,
      prompt: 'inspect env',
      confirmed: true,
      dataDir: baseDir,
      agentStore,
      activityLogStore,
      usageStore,
      executeFn: async (_aid: any, _sref: any, _task: any, opts: any) => {
        receivedEnv = opts.env;
        return (stubExecutor() as any)(_aid, _sref, _task, opts);
      },
      lockFn: passThroughLock,
    });

    assert.ok(receivedEnv, 'env should have been forwarded');
    assert.equal(receivedEnv.RUNONCE_TEST_KEY, 'hello');
  });
});

describe('execute — dangerous-permissions forwarding', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('passes dangerouslySkipPermissions: true to the executor', async () => {
    let receivedOpts: any = null;
    await execute({
      agentId: AGENT_ID,
      prompt: 'p',
      confirmed: true,
      dataDir: baseDir,
      agentStore,
      activityLogStore,
      usageStore,
      executeFn: async (_aid: any, _sref: any, _task: any, opts: any) => {
        receivedOpts = opts;
        return (stubExecutor() as any)(_aid, _sref, _task, opts);
      },
      lockFn: passThroughLock,
    });

    assert.equal(receivedOpts.dangerouslySkipPermissions, true);
    // Sanity-check the other heartbeat-parity options too.
    assert.equal(receivedOpts.agentsDir, baseDir);
    assert.equal(receivedOpts.usageStore, usageStore);
  });
});

describe('execute — activity log', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('appends an activity entry with the task title and execution log path', async () => {
    const fakePath = join(
      baseDir,
      AGENT_ID,
      'executions',
      'adhoc-12345678_session-42.jsonl',
    );

    const result = await execute({
      agentId: AGENT_ID,
      prompt: 'log me',
      title: 'My Probe',
      confirmed: true,
      dataDir: baseDir,
      agentStore,
      activityLogStore,
      usageStore,
      executeFn: stubExecutor({ executionLogPath: fakePath }),
      lockFn: passThroughLock,
    });

    assert.equal(result.finalStatus, 'completed');
    assert.equal(result.task.title, 'My Probe');
    assert.equal(result.executionLogBasename, 'adhoc-12345678_session-42');

    assert.ok(result.activityEntry, 'activity entry should be written');
    assert.equal(result.activityEntry.title, 'My Probe');
    assert.equal(result.activityEntry.status, 'completed');
    assert.equal(
      result.activityEntry.metadata.execution.executionLogPath,
      fakePath,
    );
    assert.equal(result.activityEntry.metadata.task.adhoc, true);

    // Verify it was actually persisted to disk.
    const logs = await activityLogStore.load(AGENT_ID);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].id, result.activityEntry.id);
  });
});

describe('execute — failure path', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns finalStatus:failed with the error message AND writes activity entry', async () => {
    const boom = new Error('executor exploded');

    const result = await execute({
      agentId: AGENT_ID,
      prompt: 'p',
      confirmed: true,
      dataDir: baseDir,
      agentStore,
      activityLogStore,
      usageStore,
      executeFn: async () => {
        throw boom;
      },
      lockFn: passThroughLock,
    });

    assert.equal(result.finalStatus, 'failed');
    assert.equal(result.error, 'executor exploded');
    assert.ok(result.activityEntry, 'activity entry should still be written');
    assert.equal(result.activityEntry.status, 'failed');
    assert.equal(
      result.activityEntry.metadata.error.message,
      'executor exploded',
    );

    const logs = await activityLogStore.load(AGENT_ID);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'failed');
  });
});
