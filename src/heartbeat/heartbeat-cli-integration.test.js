/**
 * Integration tests — heartbeat triggering + CLI session launch with agent context.
 *
 * These tests verify the full pipeline:
 *   1. Heartbeat fires (scheduler acquires lock)
 *   2. Task selector picks next pending task from approved weekly plan
 *   3. Agent identity + task context are assembled into CLI session config
 *   4. CLI session is launched (via mock spawn) with correct arguments
 *   5. Session result (stdout, exit code, token usage) is captured
 *   6. Lock is released after completion
 *
 * All CLI spawns use an injectable mock — no real Claude CLI needed.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';

import { createScheduler } from './scheduler.js';
import { tickAgent, runHeartbeatTick } from './heartbeat-task-runner.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import {
  buildSessionConfig,
  buildCliArgs,
  buildSystemPrompt,
  buildTaskPrompt,
  launchSession,
  parseTokenUsage,
} from '../execution/cli-session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uid = () => randomBytes(4).toString('hex');

function makeTask(overrides = {}) {
  return {
    id: overrides.id || `task-${uid()}`,
    description: overrides.description || 'Implement feature X',
    objectiveId: overrides.objectiveId || `obj-${uid()}`,
    priority: overrides.priority || 'medium',
    status: overrides.status || 'pending',
    ...overrides,
  };
}

function makePlan(overrides = {}) {
  return {
    week: overrides.week || '2026-W16',
    month: overrides.month || '2026-04',
    tasks: overrides.tasks || [],
    approved: overrides.approved !== undefined ? overrides.approved : true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(overrides.approvedAt ? { approvedAt: overrides.approvedAt } : {}),
  };
}

function makeAgentConfig(overrides = {}) {
  return {
    id: overrides.id || `agent-${uid()}`,
    identity: overrides.identity || {
      name: 'ResearchBot',
      role: 'Research Assistant',
      systemPrompt: 'You are a research assistant focused on data analysis.',
    },
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

async function makeTempDir(prefix = 'aweek-hb-cli-') {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Create a mock spawn that returns a fake child process with configurable output.
 */
function createMockSpawn({ exitCode = 0, stdout = '', stderr = '', error = null } = {}) {
  const calls = [];

  function mockSpawn(cmd, args, opts) {
    calls.push({ cmd, args, opts });

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

  mockSpawn.calls = calls;
  return mockSpawn;
}

// ---------------------------------------------------------------------------
// Heartbeat trigger → task selection → session config building
// ---------------------------------------------------------------------------

describe('heartbeat trigger → CLI session config', () => {
  let dataDir;
  let lockDir;
  let store;
  let scheduler;

  beforeEach(async () => {
    dataDir = await makeTempDir('hb-cli-data-');
    lockDir = await makeTempDir('hb-cli-lock-');
    store = new WeeklyPlanStore(dataDir);
    scheduler = createScheduler({ lockDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  });

  it('selected task from heartbeat tick maps correctly to session config', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({
      priority: 'high',
      description: 'Analyze quarterly earnings',
      objectiveId: 'obj-earnings-2026',
    });

    await store.save(agentId, makePlan({
      week: '2026-W16',
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    // Step 1: heartbeat tick selects the task
    const tickResult = await tickAgent(agentId, { weeklyPlanStore: store });
    assert.equal(tickResult.outcome, 'task_selected');

    // Step 2: build session config from agent config + selected task
    const agentConfig = makeAgentConfig({ id: agentId });
    const sessionConfig = buildSessionConfig(agentConfig, tickResult.task, {
      week: tickResult.week,
    });

    // Verify agent identity flows through
    assert.equal(sessionConfig.agentId, agentId);
    assert.equal(sessionConfig.identity.name, 'ResearchBot');
    assert.equal(sessionConfig.identity.role, 'Research Assistant');
    assert.ok(sessionConfig.identity.systemPrompt.includes('research assistant'));

    // Verify task context flows through
    assert.equal(sessionConfig.task.taskId, task.id);
    assert.equal(sessionConfig.task.description, 'Analyze quarterly earnings');
    assert.equal(sessionConfig.task.objectiveId, 'obj-earnings-2026');
    assert.equal(sessionConfig.task.week, '2026-W16');
  });

  it('CLI args contain agent system prompt and task description', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ description: 'Write unit tests for parser module' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const tickResult = await tickAgent(agentId, { weeklyPlanStore: store });
    assert.equal(tickResult.outcome, 'task_selected');

    const agentConfig = makeAgentConfig({
      id: agentId,
      identity: {
        name: 'TestEngineer',
        role: 'QA Engineer',
        systemPrompt: 'You write thorough tests with edge cases.',
      },
    });

    const sessionConfig = buildSessionConfig(agentConfig, tickResult.task, {
      week: tickResult.week,
    });

    const cliArgs = buildCliArgs(sessionConfig.identity, sessionConfig.task);

    // Should include --print for non-interactive mode
    assert.ok(cliArgs.includes('--print'));
    // Should include --output-format json for token parsing
    assert.ok(cliArgs.includes('--output-format'));
    assert.ok(cliArgs.includes('json'));
    // Should include --system-prompt
    assert.ok(cliArgs.includes('--system-prompt'));

    // System prompt should contain agent identity
    const sysIdx = cliArgs.indexOf('--system-prompt');
    const systemPrompt = cliArgs[sysIdx + 1];
    assert.ok(systemPrompt.includes('TestEngineer'));
    assert.ok(systemPrompt.includes('QA Engineer'));
    assert.ok(systemPrompt.includes('thorough tests'));

    // Last arg should be the user prompt with task description
    const userPrompt = cliArgs[cliArgs.length - 1];
    assert.ok(userPrompt.includes('Write unit tests for parser module'));
    assert.ok(userPrompt.includes(task.id));
  });

  it('additional context is forwarded to CLI prompt', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ description: 'Deploy service' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const tickResult = await tickAgent(agentId, { weeklyPlanStore: store });
    const agentConfig = makeAgentConfig({ id: agentId });

    const sessionConfig = buildSessionConfig(agentConfig, tickResult.task, {
      week: tickResult.week,
      additionalContext: 'Use staging environment. Notify #ops-channel on completion.',
    });

    const userPrompt = buildTaskPrompt(sessionConfig.task);
    assert.ok(userPrompt.includes('Use staging environment'));
    assert.ok(userPrompt.includes('#ops-channel'));
    assert.ok(userPrompt.includes('## Additional Context'));
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: heartbeat → task selection → CLI launch (mock spawn)
// ---------------------------------------------------------------------------

describe('full pipeline: heartbeat → CLI session launch', () => {
  let dataDir;
  let lockDir;
  let store;
  let scheduler;

  beforeEach(async () => {
    dataDir = await makeTempDir('hb-full-data-');
    lockDir = await makeTempDir('hb-full-lock-');
    store = new WeeklyPlanStore(dataDir);
    scheduler = createScheduler({ lockDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  });

  it('heartbeat tick + CLI launch produces structured session result', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ description: 'Generate weekly report' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    // Step 1: heartbeat tick
    const tickResult = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(tickResult.status, 'completed');
    assert.equal(tickResult.result.outcome, 'task_selected');

    // Step 2: build config and launch session
    const agentConfig = makeAgentConfig({ id: agentId });
    const sessionConfig = buildSessionConfig(agentConfig, tickResult.result.task, {
      week: tickResult.result.week,
    });

    const cliOutput = JSON.stringify({
      result: 'Report generated successfully',
      usage: { input_tokens: 1200, output_tokens: 800 },
      cost_usd: 0.04,
    });

    const mockSpawn = createMockSpawn({ exitCode: 0, stdout: cliOutput });

    const sessionResult = await launchSession(
      sessionConfig.agentId,
      sessionConfig.identity,
      sessionConfig.task,
      { spawnFn: mockSpawn }
    );

    // Verify session result structure
    assert.equal(sessionResult.agentId, agentId);
    assert.equal(sessionResult.taskId, task.id);
    assert.equal(sessionResult.exitCode, 0);
    assert.equal(sessionResult.timedOut, false);
    assert.ok(sessionResult.startedAt);
    assert.ok(sessionResult.completedAt);
    assert.ok(sessionResult.durationMs >= 0);
    assert.ok(Array.isArray(sessionResult.cliArgs));

    // Verify token usage can be parsed from output
    const usage = parseTokenUsage(sessionResult.stdout);
    assert.equal(usage.inputTokens, 1200);
    assert.equal(usage.outputTokens, 800);
    assert.equal(usage.totalTokens, 2000);
    assert.equal(usage.costUsd, 0.04);

    // Verify the CLI was called with correct binary
    assert.equal(mockSpawn.calls.length, 1);
    assert.equal(mockSpawn.calls[0].cmd, 'claude');
  });

  it('agent identity is embedded in CLI system prompt during session', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ description: 'Code review PR #42' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const tickResult = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    const agentConfig = makeAgentConfig({
      id: agentId,
      identity: {
        name: 'CodeReviewer',
        role: 'Senior Code Reviewer',
        systemPrompt: 'You review code for security vulnerabilities and best practices.',
      },
    });

    const sessionConfig = buildSessionConfig(agentConfig, tickResult.result.task, {
      week: tickResult.result.week,
    });

    const mockSpawn = createMockSpawn({ stdout: '{"result":"reviewed"}' });

    await launchSession(
      sessionConfig.agentId,
      sessionConfig.identity,
      sessionConfig.task,
      { spawnFn: mockSpawn }
    );

    // Check the system prompt passed to CLI
    const call = mockSpawn.calls[0];
    const sysIdx = call.args.indexOf('--system-prompt');
    const systemPrompt = call.args[sysIdx + 1];

    assert.ok(systemPrompt.includes('You are CodeReviewer, a Senior Code Reviewer.'));
    assert.ok(systemPrompt.includes('security vulnerabilities'));
  });

  it('task context includes objective ID and week for traceability', async () => {
    const agentId = `agent-${uid()}`;
    const objectiveId = `obj-${uid()}`;
    const task = makeTask({
      description: 'Implement caching layer',
      objectiveId,
    });

    await store.save(agentId, makePlan({
      week: '2026-W17',
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const tickResult = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    const agentConfig = makeAgentConfig({ id: agentId });
    const sessionConfig = buildSessionConfig(agentConfig, tickResult.result.task, {
      week: tickResult.result.week,
    });

    const mockSpawn = createMockSpawn({ stdout: '{"result":"done"}' });
    await launchSession(
      sessionConfig.agentId,
      sessionConfig.identity,
      sessionConfig.task,
      { spawnFn: mockSpawn }
    );

    // Verify traceability info in the user prompt
    const userPrompt = mockSpawn.calls[0].args[mockSpawn.calls[0].args.length - 1];
    assert.ok(userPrompt.includes(`Task ID: ${task.id}`));
    assert.ok(userPrompt.includes(`Objective ID: ${objectiveId}`));
    assert.ok(userPrompt.includes('Week: 2026-W17'));
  });

  it('CLI session handles non-zero exit code without breaking heartbeat', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ description: 'Risky migration' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const tickResult = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    const agentConfig = makeAgentConfig({ id: agentId });
    const sessionConfig = buildSessionConfig(agentConfig, tickResult.result.task, {
      week: tickResult.result.week,
    });

    const mockSpawn = createMockSpawn({
      exitCode: 1,
      stderr: 'Error: migration failed',
    });

    const sessionResult = await launchSession(
      sessionConfig.agentId,
      sessionConfig.identity,
      sessionConfig.task,
      { spawnFn: mockSpawn }
    );

    // Session completes with error info — doesn't throw
    assert.equal(sessionResult.exitCode, 1);
    assert.equal(sessionResult.stderr, 'Error: migration failed');
    assert.equal(sessionResult.timedOut, false);

    // Lock should be released after the tick
    const lockState = await scheduler.isLocked(agentId);
    assert.equal(lockState.locked, false);
  });

  it('token usage is null when CLI output has no usage data', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ description: 'Simple task' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const tickResult = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    const agentConfig = makeAgentConfig({ id: agentId });
    const sessionConfig = buildSessionConfig(agentConfig, tickResult.result.task, {
      week: tickResult.result.week,
    });

    const mockSpawn = createMockSpawn({
      stdout: 'plain text output with no JSON',
    });

    const sessionResult = await launchSession(
      sessionConfig.agentId,
      sessionConfig.identity,
      sessionConfig.task,
      { spawnFn: mockSpawn }
    );

    const usage = parseTokenUsage(sessionResult.stdout);
    assert.equal(usage, null);
  });
});

// ---------------------------------------------------------------------------
// Idempotent execution: repeated heartbeats don't duplicate work
// ---------------------------------------------------------------------------

describe('idempotent heartbeat → CLI execution', () => {
  let dataDir;
  let lockDir;
  let store;
  let scheduler;

  beforeEach(async () => {
    dataDir = await makeTempDir('hb-idem-data-');
    lockDir = await makeTempDir('hb-idem-lock-');
    store = new WeeklyPlanStore(dataDir);
    scheduler = createScheduler({ lockDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  });

  it('sequential heartbeats advance through tasks — never re-select in-progress', async () => {
    const agentId = `agent-${uid()}`;
    const task1 = makeTask({ priority: 'critical', description: 'Task A' });
    const task2 = makeTask({ priority: 'high', description: 'Task B' });
    const task3 = makeTask({ priority: 'medium', description: 'Task C' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task1, task2, task3],
    }));

    const agentConfig = makeAgentConfig({ id: agentId });
    const sessionsLaunched = [];

    // Simulate 4 heartbeat ticks (3 tasks + 1 "no more" tick)
    for (let i = 0; i < 4; i++) {
      const tick = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
      assert.equal(tick.status, 'completed');

      if (tick.result.outcome === 'task_selected') {
        const config = buildSessionConfig(agentConfig, tick.result.task, {
          week: tick.result.week,
        });

        const mockSpawn = createMockSpawn({
          stdout: JSON.stringify({ result: 'done', usage: { input_tokens: 100, output_tokens: 50 } }),
        });

        const session = await launchSession(
          config.agentId,
          config.identity,
          config.task,
          { spawnFn: mockSpawn }
        );

        sessionsLaunched.push(session.taskId);
      }
    }

    // Exactly 3 unique sessions launched, one per task
    assert.equal(sessionsLaunched.length, 3);
    assert.equal(new Set(sessionsLaunched).size, 3);
    assert.ok(sessionsLaunched.includes(task1.id));
    assert.ok(sessionsLaunched.includes(task2.id));
    assert.ok(sessionsLaunched.includes(task3.id));
  });

  it('task marked in-progress by first heartbeat is not re-selected by second', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ priority: 'high', description: 'One-shot task' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    // First tick selects and marks in-progress
    const tick1 = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(tick1.result.outcome, 'task_selected');
    assert.equal(tick1.result.task.id, task.id);

    // Second tick finds no pending tasks
    const tick2 = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(tick2.result.outcome, 'no_pending_tasks');

    // Verify the task is in-progress in the store
    const plan = await store.load(agentId, '2026-W16');
    assert.equal(plan.tasks[0].status, 'in-progress');
  });

  it('concurrent heartbeats for same agent — second is skipped via lock', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ description: 'Concurrent test task' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    // Acquire lock to simulate an in-progress heartbeat
    await scheduler.acquireLock(agentId);

    // Second heartbeat should be skipped
    const result = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'already_locked');

    await scheduler.releaseLock(agentId);
  });
});

// ---------------------------------------------------------------------------
// Multi-agent parallel heartbeat → independent CLI sessions
// ---------------------------------------------------------------------------

describe('multi-agent parallel heartbeat → CLI sessions', () => {
  let dataDir;
  let lockDir;
  let store;
  let scheduler;

  beforeEach(async () => {
    dataDir = await makeTempDir('hb-multi-data-');
    lockDir = await makeTempDir('hb-multi-lock-');
    store = new WeeklyPlanStore(dataDir);
    scheduler = createScheduler({ lockDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  });

  it('parallel agents each get their own task selected and session config built', async () => {
    const agents = [
      {
        id: `agent-${uid()}`,
        config: makeAgentConfig({
          identity: { name: 'Writer', role: 'Content Writer', systemPrompt: 'Write engaging content.' },
        }),
        task: makeTask({ description: 'Write blog post' }),
      },
      {
        id: `agent-${uid()}`,
        config: makeAgentConfig({
          identity: { name: 'Coder', role: 'Software Engineer', systemPrompt: 'Write clean code.' },
        }),
        task: makeTask({ description: 'Refactor auth module' }),
      },
    ];

    // Set up plans for each agent
    for (const agent of agents) {
      agent.config.id = agent.id;
      await store.save(agent.id, makePlan({
        approved: true,
        approvedAt: new Date().toISOString(),
        tasks: [agent.task],
      }));
    }

    // Run heartbeat ticks in parallel
    const tickResults = await Promise.all(
      agents.map((a) => runHeartbeatTick(a.id, { scheduler, weeklyPlanStore: store }))
    );

    // All should succeed
    assert.ok(tickResults.every((r) => r.status === 'completed'));
    assert.ok(tickResults.every((r) => r.result.outcome === 'task_selected'));

    // Build session configs and verify each agent gets its own context
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const tick = tickResults[i];
      const config = buildSessionConfig(agent.config, tick.result.task, {
        week: tick.result.week,
      });

      assert.equal(config.agentId, agent.id);
      assert.equal(config.identity.name, agent.config.identity.name);
      assert.equal(config.task.description, agent.task.description);

      // Verify system prompt distinguishes agents
      const systemPrompt = buildSystemPrompt(config.identity);
      assert.ok(systemPrompt.includes(agent.config.identity.name));
    }

    // Verify all locks are released
    for (const agent of agents) {
      const lockState = await scheduler.isLocked(agent.id);
      assert.equal(lockState.locked, false);
    }
  });

  it('one agent failure does not prevent other agents from launching sessions', async () => {
    const goodAgentId = `agent-${uid()}`;
    const badAgentId = `agent-${uid()}`;

    // Good agent has a plan
    await store.save(goodAgentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'Good task' })],
    }));

    // Bad agent has no plans at all
    await store.init(badAgentId);

    const [goodResult, badResult] = await Promise.all([
      runHeartbeatTick(goodAgentId, { scheduler, weeklyPlanStore: store }),
      runHeartbeatTick(badAgentId, { scheduler, weeklyPlanStore: store }),
    ]);

    // Good agent succeeds
    assert.equal(goodResult.status, 'completed');
    assert.equal(goodResult.result.outcome, 'task_selected');

    // Bad agent gets no_approved_plan but doesn't throw
    assert.equal(badResult.status, 'completed');
    assert.equal(badResult.result.outcome, 'no_approved_plan');

    // Good agent can still have its CLI session launched
    const agentConfig = makeAgentConfig({ id: goodAgentId });
    const sessionConfig = buildSessionConfig(agentConfig, goodResult.result.task, {
      week: goodResult.result.week,
    });

    const mockSpawn = createMockSpawn({ stdout: '{"result":"ok"}' });
    const session = await launchSession(
      sessionConfig.agentId,
      sessionConfig.identity,
      sessionConfig.task,
      { spawnFn: mockSpawn }
    );

    assert.equal(session.exitCode, 0);
    assert.equal(session.agentId, goodAgentId);
  });
});

// ---------------------------------------------------------------------------
// CLI session with model override and permission flags
// ---------------------------------------------------------------------------

describe('CLI session launch options from heartbeat context', () => {
  it('model override flows through to CLI args', () => {
    const identity = {
      name: 'Architect',
      role: 'System Architect',
      systemPrompt: 'You design scalable systems.',
    };
    const task = {
      taskId: 'task-arch-001',
      description: 'Design database schema',
    };

    const args = buildCliArgs(identity, task, { model: 'opus' });
    const modelIdx = args.indexOf('--model');
    assert.ok(modelIdx >= 0);
    assert.equal(args[modelIdx + 1], 'opus');
  });

  it('dangerouslySkipPermissions flows through for automated agents', () => {
    const identity = {
      name: 'AutoBot',
      role: 'Automated Task Runner',
      systemPrompt: 'You execute automated tasks.',
    };
    const task = {
      taskId: 'task-auto-001',
      description: 'Run scheduled cleanup',
    };

    const args = buildCliArgs(identity, task, { dangerouslySkipPermissions: true });
    assert.ok(args.includes('--dangerously-skip-permissions'));
  });

  it('custom working directory passed to spawn options', async () => {
    const mockSpawn = createMockSpawn({ stdout: '{"result":"ok"}' });

    await launchSession(
      'agent-cwd-test',
      {
        name: 'DirBot',
        role: 'Directory Worker',
        systemPrompt: 'You work in specific directories.',
      },
      { taskId: 'task-cwd-001', description: 'Process files' },
      { spawnFn: mockSpawn, cwd: '/workspace/my-project' }
    );

    assert.equal(mockSpawn.calls[0].opts.cwd, '/workspace/my-project');
  });
});

// ---------------------------------------------------------------------------
// Token usage extraction from CLI session output
// ---------------------------------------------------------------------------

describe('token usage parsing from heartbeat-triggered sessions', () => {
  it('parses token usage from standard claude CLI JSON output', async () => {
    const cliOutput = JSON.stringify({
      result: 'Task completed successfully.',
      usage: { input_tokens: 5000, output_tokens: 2000 },
      cost_usd: 0.15,
    });

    const mockSpawn = createMockSpawn({ stdout: cliOutput });

    const session = await launchSession(
      'agent-tokens-1',
      { name: 'Bot', role: 'Worker', systemPrompt: 'Work.' },
      { taskId: 'task-tok-1', description: 'Do work' },
      { spawnFn: mockSpawn }
    );

    const usage = parseTokenUsage(session.stdout);
    assert.equal(usage.inputTokens, 5000);
    assert.equal(usage.outputTokens, 2000);
    assert.equal(usage.totalTokens, 7000);
    assert.equal(usage.costUsd, 0.15);
  });

  it('handles streaming JSON output with usage on last line', async () => {
    const lines = [
      JSON.stringify({ type: 'progress', step: 1, message: 'Starting...' }),
      JSON.stringify({ type: 'progress', step: 2, message: 'Analyzing...' }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 3000, output_tokens: 1500 }, cost_usd: 0.10 }),
    ];

    const mockSpawn = createMockSpawn({ stdout: lines.join('\n') });

    const session = await launchSession(
      'agent-stream-1',
      { name: 'Bot', role: 'Worker', systemPrompt: 'Work.' },
      { taskId: 'task-stream-1', description: 'Stream task' },
      { spawnFn: mockSpawn }
    );

    const usage = parseTokenUsage(session.stdout);
    assert.equal(usage.inputTokens, 3000);
    assert.equal(usage.outputTokens, 1500);
    assert.equal(usage.totalTokens, 4500);
    assert.equal(usage.costUsd, 0.10);
  });

  it('returns null when session output is not JSON', async () => {
    const mockSpawn = createMockSpawn({ stdout: 'ERROR: something went wrong\nStack trace...' });

    const session = await launchSession(
      'agent-err-1',
      { name: 'Bot', role: 'Worker', systemPrompt: 'Work.' },
      { taskId: 'task-err-1', description: 'Fail task' },
      { spawnFn: mockSpawn }
    );

    const usage = parseTokenUsage(session.stdout);
    assert.equal(usage, null);
  });

  it('accumulates token usage across multiple sequential heartbeat ticks', async () => {
    const dataDir2 = await makeTempDir('hb-accum-data-');
    const lockDir2 = await makeTempDir('hb-accum-lock-');
    const store2 = new WeeklyPlanStore(dataDir2);
    const scheduler2 = createScheduler({ lockDir: lockDir2 });

    try {
      const agentId = `agent-${uid()}`;
      const tasks = [
        makeTask({ priority: 'critical', description: 'Task 1' }),
        makeTask({ priority: 'high', description: 'Task 2' }),
      ];

      await store2.save(agentId, makePlan({
        approved: true,
        approvedAt: new Date().toISOString(),
        tasks,
      }));

      const agentConfig = makeAgentConfig({ id: agentId });
      let totalTokens = 0;

      // Tick 1
      const tick1 = await runHeartbeatTick(agentId, { scheduler: scheduler2, weeklyPlanStore: store2 });
      assert.equal(tick1.result.outcome, 'task_selected');

      const config1 = buildSessionConfig(agentConfig, tick1.result.task, { week: tick1.result.week });
      const spawn1 = createMockSpawn({
        stdout: JSON.stringify({ usage: { input_tokens: 2000, output_tokens: 1000 } }),
      });
      const session1 = await launchSession(config1.agentId, config1.identity, config1.task, { spawnFn: spawn1 });
      const usage1 = parseTokenUsage(session1.stdout);
      totalTokens += usage1.totalTokens;

      // Tick 2
      const tick2 = await runHeartbeatTick(agentId, { scheduler: scheduler2, weeklyPlanStore: store2 });
      assert.equal(tick2.result.outcome, 'task_selected');

      const config2 = buildSessionConfig(agentConfig, tick2.result.task, { week: tick2.result.week });
      const spawn2 = createMockSpawn({
        stdout: JSON.stringify({ usage: { input_tokens: 1500, output_tokens: 800 } }),
      });
      const session2 = await launchSession(config2.agentId, config2.identity, config2.task, { spawnFn: spawn2 });
      const usage2 = parseTokenUsage(session2.stdout);
      totalTokens += usage2.totalTokens;

      // Verify accumulated usage
      assert.equal(totalTokens, 5300); // (2000+1000) + (1500+800)
      assert.equal(usage1.totalTokens, 3000);
      assert.equal(usage2.totalTokens, 2300);
    } finally {
      await rm(dataDir2, { recursive: true, force: true });
      await rm(lockDir2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases: no plan, unapproved plan, empty tasks
// ---------------------------------------------------------------------------

describe('heartbeat → CLI edge cases', () => {
  let dataDir;
  let lockDir;
  let store;
  let scheduler;

  beforeEach(async () => {
    dataDir = await makeTempDir('hb-edge-data-');
    lockDir = await makeTempDir('hb-edge-lock-');
    store = new WeeklyPlanStore(dataDir);
    scheduler = createScheduler({ lockDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  });

  it('heartbeat tick with no approved plan produces no CLI session', async () => {
    const agentId = `agent-${uid()}`;
    await store.init(agentId);

    const tick = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(tick.status, 'completed');
    assert.equal(tick.result.outcome, 'no_approved_plan');
    // No task selected — no session to launch
    assert.equal(tick.result.task, undefined);
  });

  it('heartbeat tick with unapproved plan produces no CLI session', async () => {
    const agentId = `agent-${uid()}`;
    await store.save(agentId, makePlan({
      approved: false,
      tasks: [makeTask()],
    }));

    const tick = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(tick.status, 'completed');
    assert.equal(tick.result.outcome, 'no_approved_plan');
  });

  it('heartbeat tick with empty task list produces no CLI session', async () => {
    const agentId = `agent-${uid()}`;
    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [],
    }));

    const tick = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(tick.status, 'completed');
    assert.equal(tick.result.outcome, 'all_tasks_finished');
  });

  it('heartbeat tick after all tasks completed returns all_tasks_finished', async () => {
    const agentId = `agent-${uid()}`;
    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [
        makeTask({ status: 'completed' }),
        makeTask({ status: 'completed' }),
      ],
    }));

    const tick = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(tick.status, 'completed');
    assert.equal(tick.result.outcome, 'all_tasks_finished');
    assert.equal(tick.result.summary.completed, 2);
    assert.equal(tick.result.summary.pending, 0);
  });

  it('lock is always released even when no task is selected', async () => {
    const agentId = `agent-${uid()}`;
    await store.init(agentId);

    await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });

    const lockState = await scheduler.isLocked(agentId);
    assert.equal(lockState.locked, false);
  });

  it('CLI session timeout produces timedOut result without crashing pipeline', async () => {
    const child = new EventEmitter();
    const stdoutStream = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });
    child.stdout = stdoutStream;
    child.stderr = stderrStream;
    child.killed = false;
    child.kill = (signal) => {
      child.killed = true;
      setImmediate(() => {
        stdoutStream.push(null);
        stderrStream.push(null);
        child.emit('close', null);
      });
    };
    const timeoutSpawn = () => child;

    const session = await launchSession(
      'agent-timeout',
      { name: 'SlowBot', role: 'Slow Worker', systemPrompt: 'You are slow.' },
      { taskId: 'task-slow-1', description: 'Long running task' },
      { spawnFn: timeoutSpawn, timeoutMs: 10 }
    );

    assert.equal(session.timedOut, true);
    assert.equal(session.exitCode, null);
    assert.equal(session.agentId, 'agent-timeout');

    // Token usage should be null for timed out sessions
    const usage = parseTokenUsage(session.stdout);
    assert.equal(usage, null);
  });
});
