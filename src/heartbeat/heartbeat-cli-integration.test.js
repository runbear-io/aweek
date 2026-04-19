/**
 * Integration tests — heartbeat task runner + CLI session launch with SUBAGENT_REF.
 *
 * Post-refactor, every aweek agent is a 1-to-1 wrapper around a Claude Code
 * subagent. The heartbeat task runner picks a task, and the CLI layer spawns:
 *
 *   claude --print --output-format json --agent SUBAGENT_REF \
 *          --append-system-prompt RUNTIME_CONTEXT TASK
 *
 * Identity (name, role, system prompt, model, tools, skills, MCP servers)
 * lives EXCLUSIVELY in `.claude/agents/<slug>.md` and is resolved by Claude
 * Code via `--agent`. The aweek JSON carries only the `subagentRef` slug —
 * never an identity block.
 *
 * These tests verify:
 *   1. Heartbeat fires (scheduler acquires lock)
 *   2. Task selector picks next pending task from approved weekly plan
 *   3. Session config is built from the agent's `subagentRef` (no identity)
 *   4. CLI session is launched (via mock spawn) with `--print --agent <slug>`
 *      and NEVER with the legacy `--system-prompt` flag
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
  buildRuntimeContext,
  buildTaskPrompt,
  launchSession,
  parseTokenUsage,
} from '../execution/cli-session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uid = () => randomBytes(4).toString('hex');

/** Build a slug that matches the SUBAGENT_SLUG_PATTERN used by the schema. */
function makeSubagentRef(prefix = 'agent') {
  return `${prefix}-${uid()}`;
}

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

/**
 * Build a minimal agent config in the post-refactor shape.
 *
 * Identity is NOT present — it lives in `.claude/agents/<subagentRef>.md`.
 * The aweek JSON carries only the slug (subagentRef) plus scheduling fields.
 *
 * By convention we set `id === subagentRef` to honour the
 * filesystem_1to1_mapping evaluation principle.
 */
function makeAgentConfig(overrides = {}) {
  const id = overrides.id || makeSubagentRef();
  return {
    id,
    subagentRef: overrides.subagentRef || id,
    goals: [],
    monthlyPlans: [],
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

/** Assert the CLI args use the post-refactor invocation shape. */
function assertSubagentFirstArgs(args, { subagentRef, taskDescription } = {}) {
  // Required subagent-first flags.
  assert.ok(args.includes('--print'), 'missing --print');
  assert.ok(args.includes('--output-format'), 'missing --output-format');
  const fmtIdx = args.indexOf('--output-format');
  assert.equal(args[fmtIdx + 1], 'json', '--output-format should be json');
  assert.ok(args.includes('--agent'), 'missing --agent');
  assert.ok(
    args.includes('--append-system-prompt'),
    'missing --append-system-prompt',
  );

  // Legacy identity flag must be gone.
  assert.ok(
    !args.includes('--system-prompt'),
    'legacy --system-prompt must not appear',
  );

  if (subagentRef) {
    const agentIdx = args.indexOf('--agent');
    assert.equal(
      args[agentIdx + 1],
      subagentRef,
      `--agent value should be ${subagentRef}`,
    );
  }

  if (taskDescription) {
    const lastArg = args[args.length - 1];
    assert.ok(
      lastArg.includes(taskDescription),
      `last arg (user prompt) should include task description: ${taskDescription}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Heartbeat trigger → task selection → session config building
// ---------------------------------------------------------------------------

describe('heartbeat trigger → CLI session config (subagent-first)', () => {
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

  it('selected task from heartbeat tick maps to session config with subagentRef', async () => {
    const agentId = makeSubagentRef();
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

    // Verify agent slug (not identity) flows through
    assert.equal(sessionConfig.agentId, agentId);
    assert.equal(sessionConfig.subagentRef, agentId);
    // Identity must NOT be present — it lives in the subagent .md file.
    assert.equal(sessionConfig.identity, undefined);

    // Verify task context flows through
    assert.equal(sessionConfig.task.taskId, task.id);
    assert.equal(sessionConfig.task.description, 'Analyze quarterly earnings');
    assert.equal(sessionConfig.task.objectiveId, 'obj-earnings-2026');
    assert.equal(sessionConfig.task.week, '2026-W16');
  });

  it('CLI args contain --print --agent SUBAGENT_REF and task description', async () => {
    const agentId = makeSubagentRef('qa');
    const task = makeTask({ description: 'Write unit tests for parser module' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const tickResult = await tickAgent(agentId, { weeklyPlanStore: store });
    assert.equal(tickResult.outcome, 'task_selected');

    const agentConfig = makeAgentConfig({ id: agentId });
    const sessionConfig = buildSessionConfig(agentConfig, tickResult.task, {
      week: tickResult.week,
    });

    const cliArgs = buildCliArgs(sessionConfig.subagentRef, sessionConfig.task);

    assertSubagentFirstArgs(cliArgs, {
      subagentRef: agentId,
      taskDescription: 'Write unit tests for parser module',
    });

    // --append-system-prompt carries aweek runtime context only (no identity).
    const appendIdx = cliArgs.indexOf('--append-system-prompt');
    const runtime = cliArgs[appendIdx + 1];
    assert.ok(runtime.includes('## aweek Runtime Context'));
    assert.ok(runtime.includes(`Task ID: ${task.id}`));
    // Runtime context must NOT impersonate the agent (identity stays in .md).
    assert.ok(!/You are [A-Z]/.test(runtime));

    // Last positional arg is the user prompt.
    const userPrompt = cliArgs[cliArgs.length - 1];
    assert.ok(userPrompt.includes('Write unit tests for parser module'));
    assert.ok(userPrompt.includes(task.id));
  });

  it('additional context is forwarded to the runtime-context append block', async () => {
    const agentId = makeSubagentRef();
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

    // In the new shape, additionalContext flows through the runtime context,
    // not the task prompt. buildRuntimeContext is the single source of truth
    // for the `--append-system-prompt` value.
    const runtime = buildRuntimeContext(sessionConfig.task);
    assert.ok(runtime.includes('Use staging environment'));
    assert.ok(runtime.includes('#ops-channel'));
    assert.ok(runtime.includes('### Additional Context'));

    // buildTaskPrompt remains narrow — task description + instructions.
    const userPrompt = buildTaskPrompt(sessionConfig.task);
    assert.ok(userPrompt.includes('Deploy service'));
    assert.ok(userPrompt.includes('## Instructions'));
  });

  it('buildSessionConfig throws when agent config is missing subagentRef', async () => {
    const configWithoutRef = { id: 'x', goals: [] };
    assert.throws(
      () => buildSessionConfig(configWithoutRef, makeTask()),
      /subagentRef is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: heartbeat → task selection → CLI launch (mock spawn)
// ---------------------------------------------------------------------------

describe('full pipeline: heartbeat → CLI session launch (subagent-first)', () => {
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
    const agentId = makeSubagentRef('reporter');
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
      sessionConfig.subagentRef,
      sessionConfig.task,
      { spawnFn: mockSpawn }
    );

    // Verify session result structure
    assert.equal(sessionResult.agentId, agentId);
    assert.equal(sessionResult.subagentRef, agentId);
    assert.equal(sessionResult.taskId, task.id);
    assert.equal(sessionResult.exitCode, 0);
    assert.equal(sessionResult.timedOut, false);
    assert.ok(sessionResult.startedAt);
    assert.ok(sessionResult.completedAt);
    assert.ok(sessionResult.durationMs >= 0);
    assert.ok(Array.isArray(sessionResult.cliArgs));

    // Verify the CLI was invoked in the subagent-first shape.
    assert.equal(mockSpawn.calls.length, 1);
    assert.equal(mockSpawn.calls[0].cmd, 'claude');
    assertSubagentFirstArgs(mockSpawn.calls[0].args, {
      subagentRef: agentId,
      taskDescription: 'Generate weekly report',
    });

    // Verify token usage can be parsed from output
    const usage = parseTokenUsage(sessionResult.stdout);
    assert.equal(usage.inputTokens, 1200);
    assert.equal(usage.outputTokens, 800);
    assert.equal(usage.totalTokens, 2000);
    assert.equal(usage.costUsd, 0.04);
  });

  it('subagent slug (not identity) is embedded in CLI args during session', async () => {
    const agentId = makeSubagentRef('code-reviewer');
    const task = makeTask({ description: 'Code review PR #42' });

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

    const mockSpawn = createMockSpawn({ stdout: '{"result":"reviewed"}' });

    await launchSession(
      sessionConfig.agentId,
      sessionConfig.subagentRef,
      sessionConfig.task,
      { spawnFn: mockSpawn }
    );

    // Check the CLI args — identity is resolved by Claude Code from the
    // subagent .md file, NOT passed via argv.
    const call = mockSpawn.calls[0];
    const agentIdx = call.args.indexOf('--agent');
    assert.equal(call.args[agentIdx + 1], agentId);

    // The --append-system-prompt block carries only runtime scheduling
    // context — never agent identity strings. We reject impersonation
    // phrases like "You are NAME, a ROLE." while permitting the frame
    // sentence "You are running as a scheduled aweek heartbeat task."
    const appendIdx = call.args.indexOf('--append-system-prompt');
    const runtime = call.args[appendIdx + 1];
    assert.ok(runtime.includes('## aweek Runtime Context'));
    assert.ok(runtime.includes(`Task ID: ${task.id}`));
    assert.ok(
      !/You are [A-Z][A-Za-z]+,\s+a\s+/m.test(runtime),
      'runtime context must not impersonate the agent (identity belongs in the .md)',
    );
    assert.ok(
      !/^Role:/mi.test(runtime),
      'runtime context must not carry an identity "Role:" label',
    );
    assert.ok(
      !/System Prompt:/i.test(runtime),
      'runtime context must not embed a "System Prompt:" block',
    );
  });

  it('task context includes objective ID and week for traceability', async () => {
    const agentId = makeSubagentRef();
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
      sessionConfig.subagentRef,
      sessionConfig.task,
      { spawnFn: mockSpawn }
    );

    // Verify traceability: runtime context carries objective + week, user
    // prompt carries task id + description.
    const appendIdx = mockSpawn.calls[0].args.indexOf('--append-system-prompt');
    const runtime = mockSpawn.calls[0].args[appendIdx + 1];
    assert.ok(runtime.includes(`Task ID: ${task.id}`));
    assert.ok(runtime.includes(`Objective ID: ${objectiveId}`));
    assert.ok(runtime.includes('Week: 2026-W17'));

    const userPrompt = mockSpawn.calls[0].args[mockSpawn.calls[0].args.length - 1];
    assert.ok(userPrompt.includes(task.id));
    assert.ok(userPrompt.includes('Implement caching layer'));
  });

  it('CLI session handles non-zero exit code without breaking heartbeat', async () => {
    const agentId = makeSubagentRef();
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
      sessionConfig.subagentRef,
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
    const agentId = makeSubagentRef();
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
      sessionConfig.subagentRef,
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

describe('idempotent heartbeat → CLI execution (subagent-first)', () => {
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
    const agentId = makeSubagentRef();
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
          config.subagentRef,
          config.task,
          { spawnFn: mockSpawn }
        );

        // Every launched session routes through --agent SUBAGENT_REF.
        assertSubagentFirstArgs(mockSpawn.calls[0].args, { subagentRef: agentId });

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
    const agentId = makeSubagentRef();
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
    const agentId = makeSubagentRef();
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

describe('multi-agent parallel heartbeat → CLI sessions (subagent-first)', () => {
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

  it('parallel agents each invoke claude CLI with their own --agent SUBAGENT_REF', async () => {
    const agents = [
      {
        id: makeSubagentRef('writer'),
        task: makeTask({ description: 'Write blog post' }),
      },
      {
        id: makeSubagentRef('coder'),
        task: makeTask({ description: 'Refactor auth module' }),
      },
    ];

    // Set up plans for each agent
    for (const agent of agents) {
      agent.config = makeAgentConfig({ id: agent.id });
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

    // Build session configs and launch sessions via mock spawn. Each agent
    // must route to its own subagent slug — never share state.
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const tick = tickResults[i];
      const config = buildSessionConfig(agent.config, tick.result.task, {
        week: tick.result.week,
      });

      assert.equal(config.agentId, agent.id);
      assert.equal(config.subagentRef, agent.id);
      assert.equal(config.identity, undefined);
      assert.equal(config.task.description, agent.task.description);

      // Launch the CLI session (mock) and verify per-agent routing.
      const mockSpawn = createMockSpawn({ stdout: '{"result":"ok"}' });
      await launchSession(
        config.agentId,
        config.subagentRef,
        config.task,
        { spawnFn: mockSpawn },
      );

      assertSubagentFirstArgs(mockSpawn.calls[0].args, {
        subagentRef: agent.id,
        taskDescription: agent.task.description,
      });
    }

    // Verify all locks are released
    for (const agent of agents) {
      const lockState = await scheduler.isLocked(agent.id);
      assert.equal(lockState.locked, false);
    }
  });

  it('one agent failure does not prevent other agents from launching sessions', async () => {
    const goodAgentId = makeSubagentRef('good');
    const badAgentId = makeSubagentRef('bad');

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

    // Bad agent (no weekly plan files on disk) gets no_weekly_plans but doesn't throw
    assert.equal(badResult.status, 'completed');
    assert.equal(badResult.result.outcome, 'no_weekly_plans');

    // Good agent can still have its CLI session launched
    const agentConfig = makeAgentConfig({ id: goodAgentId });
    const sessionConfig = buildSessionConfig(agentConfig, goodResult.result.task, {
      week: goodResult.result.week,
    });

    const mockSpawn = createMockSpawn({ stdout: '{"result":"ok"}' });
    const session = await launchSession(
      sessionConfig.agentId,
      sessionConfig.subagentRef,
      sessionConfig.task,
      { spawnFn: mockSpawn }
    );

    assert.equal(session.exitCode, 0);
    assert.equal(session.agentId, goodAgentId);
    assertSubagentFirstArgs(mockSpawn.calls[0].args, { subagentRef: goodAgentId });
  });
});

// ---------------------------------------------------------------------------
// CLI session with model override and permission flags
// ---------------------------------------------------------------------------

describe('CLI session launch options from heartbeat context (subagent-first)', () => {
  it('model override flows through to CLI args', () => {
    const subagentRef = 'architect';
    const task = {
      taskId: 'task-arch-001',
      description: 'Design database schema',
    };

    const args = buildCliArgs(subagentRef, task, { model: 'opus' });
    assertSubagentFirstArgs(args, { subagentRef, taskDescription: 'Design database schema' });

    const modelIdx = args.indexOf('--model');
    assert.ok(modelIdx >= 0);
    assert.equal(args[modelIdx + 1], 'opus');
  });

  it('dangerouslySkipPermissions flows through for automated agents', () => {
    const subagentRef = 'auto-bot';
    const task = {
      taskId: 'task-auto-001',
      description: 'Run scheduled cleanup',
    };

    const args = buildCliArgs(subagentRef, task, { dangerouslySkipPermissions: true });
    assertSubagentFirstArgs(args, { subagentRef });
    assert.ok(args.includes('--dangerously-skip-permissions'));
  });

  it('custom working directory passed to spawn options', async () => {
    const mockSpawn = createMockSpawn({ stdout: '{"result":"ok"}' });

    await launchSession(
      'agent-cwd-test',
      'dir-bot',
      { taskId: 'task-cwd-001', description: 'Process files' },
      { spawnFn: mockSpawn, cwd: '/workspace/my-project' }
    );

    assert.equal(mockSpawn.calls[0].opts.cwd, '/workspace/my-project');
    assertSubagentFirstArgs(mockSpawn.calls[0].args, { subagentRef: 'dir-bot' });
  });
});

// ---------------------------------------------------------------------------
// Token usage extraction from CLI session output
// ---------------------------------------------------------------------------

describe('token usage parsing from heartbeat-triggered sessions (subagent-first)', () => {
  it('parses token usage from standard claude CLI JSON output', async () => {
    const cliOutput = JSON.stringify({
      result: 'Task completed successfully.',
      usage: { input_tokens: 5000, output_tokens: 2000 },
      cost_usd: 0.15,
    });

    const mockSpawn = createMockSpawn({ stdout: cliOutput });

    const session = await launchSession(
      'agent-tokens-1',
      'worker-bot',
      { taskId: 'task-tok-1', description: 'Do work' },
      { spawnFn: mockSpawn }
    );

    assertSubagentFirstArgs(session.cliArgs, { subagentRef: 'worker-bot' });

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
      'stream-bot',
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
      'fail-bot',
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
      const agentId = makeSubagentRef('accumulator');
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
      const session1 = await launchSession(config1.agentId, config1.subagentRef, config1.task, { spawnFn: spawn1 });
      assertSubagentFirstArgs(spawn1.calls[0].args, { subagentRef: agentId });
      const usage1 = parseTokenUsage(session1.stdout);
      totalTokens += usage1.totalTokens;

      // Tick 2
      const tick2 = await runHeartbeatTick(agentId, { scheduler: scheduler2, weeklyPlanStore: store2 });
      assert.equal(tick2.result.outcome, 'task_selected');

      const config2 = buildSessionConfig(agentConfig, tick2.result.task, { week: tick2.result.week });
      const spawn2 = createMockSpawn({
        stdout: JSON.stringify({ usage: { input_tokens: 1500, output_tokens: 800 } }),
      });
      const session2 = await launchSession(config2.agentId, config2.subagentRef, config2.task, { spawnFn: spawn2 });
      assertSubagentFirstArgs(spawn2.calls[0].args, { subagentRef: agentId });
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

describe('heartbeat → CLI edge cases (subagent-first)', () => {
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

  it('heartbeat tick on a shell agent (no weekly plans) produces no CLI session', async () => {
    // A shell agent — the result of hireAllSubagents before any plan is
    // authored — surfaces as no_weekly_plans and does not launch a CLI
    // session. This is the most common "empty" case in practice.
    const agentId = makeSubagentRef();
    await store.init(agentId);

    const tick = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(tick.status, 'completed');
    assert.equal(tick.result.outcome, 'no_weekly_plans');
    // No task selected — no session to launch
    assert.equal(tick.result.task, undefined);
  });

  it('heartbeat tick with unapproved plan produces no CLI session', async () => {
    const agentId = makeSubagentRef();
    await store.save(agentId, makePlan({
      approved: false,
      tasks: [makeTask()],
    }));

    const tick = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(tick.status, 'completed');
    assert.equal(tick.result.outcome, 'no_approved_plan');
  });

  it('heartbeat tick with empty task list produces no CLI session', async () => {
    const agentId = makeSubagentRef();
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
    const agentId = makeSubagentRef();
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
    const agentId = makeSubagentRef();
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
      'slow-bot',
      { taskId: 'task-slow-1', description: 'Long running task' },
      { spawnFn: timeoutSpawn, timeoutMs: 10 }
    );

    assert.equal(session.timedOut, true);
    assert.equal(session.exitCode, null);
    assert.equal(session.agentId, 'agent-timeout');
    assert.equal(session.subagentRef, 'slow-bot');

    // Token usage should be null for timed out sessions
    const usage = parseTokenUsage(session.stdout);
    assert.equal(usage, null);
  });
});

// ---------------------------------------------------------------------------
// Guardrails: the heartbeat pipeline must NEVER use the legacy
// identity-based CLI invocation. Adding a test at this layer protects against
// regressions where someone wires back `--system-prompt` or an identity arg.
// ---------------------------------------------------------------------------

describe('heartbeat → CLI subagent-first guardrails', () => {
  let dataDir;
  let lockDir;
  let store;
  let scheduler;

  beforeEach(async () => {
    dataDir = await makeTempDir('hb-guard-data-');
    lockDir = await makeTempDir('hb-guard-lock-');
    store = new WeeklyPlanStore(dataDir);
    scheduler = createScheduler({ lockDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  });

  it('end-to-end: tick → buildSessionConfig → launchSession uses --print --agent <slug> and no --system-prompt', async () => {
    const agentId = makeSubagentRef('guardrail');
    const task = makeTask({ description: 'Verify invocation shape' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const tick = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(tick.result.outcome, 'task_selected');

    const config = buildSessionConfig(makeAgentConfig({ id: agentId }), tick.result.task, {
      week: tick.result.week,
    });

    const mockSpawn = createMockSpawn({ stdout: '{"result":"ok"}' });
    const session = await launchSession(
      config.agentId,
      config.subagentRef,
      config.task,
      { spawnFn: mockSpawn },
    );

    const args = mockSpawn.calls[0].args;

    // Required post-refactor flags.
    assert.ok(args.includes('--print'));
    const agentIdx = args.indexOf('--agent');
    assert.ok(agentIdx >= 0);
    assert.equal(args[agentIdx + 1], agentId);

    // Forbidden legacy flags.
    assert.ok(!args.includes('--system-prompt'), 'legacy --system-prompt leaked');

    // Subagent slug is surfaced on the session result for downstream logging.
    assert.equal(session.subagentRef, agentId);
    assert.equal(session.agentId, agentId);
  });

  it('buildSessionConfig throws when the agent JSON is missing subagentRef (post-refactor invariant)', () => {
    // Post-refactor, the slug is the sole link between aweek JSON and the
    // Claude Code subagent .md. A missing slug MUST surface as a hard error
    // at session-build time rather than degrade into a silent identity-less
    // CLI invocation.
    const legacyShape = {
      id: 'x',
      // No subagentRef — what a pre-refactor config would look like.
      identity: { name: 'Legacy', role: 'Old', systemPrompt: 'old' },
      goals: [],
    };
    assert.throws(
      () => buildSessionConfig(legacyShape, makeTask()),
      /subagentRef is required/,
    );
  });

  it('buildCliArgs refuses empty subagentRef (would otherwise invoke claude with no --agent target)', () => {
    assert.throws(
      () => buildCliArgs('', { taskId: 't', description: 'd' }),
      /subagentRef is required/,
    );
    assert.throws(
      () => buildCliArgs(null, { taskId: 't', description: 'd' }),
      /subagentRef is required/,
    );
  });

  it('launchSession refuses empty subagentRef', async () => {
    await assert.rejects(
      () => launchSession('agent-x', '', { taskId: 't', description: 'd' }, {}),
      /subagentRef is required/,
    );
    await assert.rejects(
      () => launchSession('agent-x', null, { taskId: 't', description: 'd' }, {}),
      /subagentRef is required/,
    );
  });
});
