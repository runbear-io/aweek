/**
 * Tests for the summary skill — compact dashboard renderer.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { UsageStore, createUsageRecord } from '../storage/usage-store.js';
import {
  createAgentConfig,
  createWeeklyPlan,
  createTask,
  createGoal,
} from '../models/agent.js';

import {
  countGoals,
  stateLabel,
  formatGoalsCell,
  formatTasksCell,
  formatBudgetCell,
  buildSummaryRow,
  renderTable,
  formatSummaryReport,
  buildSummary,
  getAgentDrillDownChoices,
  buildAgentDrillDown,
} from './summary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), 'summary-test-'));
}

async function teardown() {
  await rm(tmpDir, { recursive: true, force: true });
}

function makeAgent(name, overrides = {}) {
  const config = createAgentConfig({
    name,
    role: `${name} role`,
    systemPrompt: `You are ${name}.`,
    weeklyTokenLimit: 100000,
  });
  return { ...config, ...overrides };
}

// ---------------------------------------------------------------------------
// countGoals
// ---------------------------------------------------------------------------

describe('countGoals', () => {
  it('returns zero when there are no goals', () => {
    assert.deepEqual(countGoals({ goals: [] }), { active: 0, total: 0 });
  });

  it('returns zero when goals is missing', () => {
    assert.deepEqual(countGoals({}), { active: 0, total: 0 });
  });

  it('counts active vs total goals', () => {
    const cfg = {
      goals: [
        { status: 'active' },
        { status: 'active' },
        { status: 'completed' },
        { status: 'dropped' },
      ],
    };
    assert.deepEqual(countGoals(cfg), { active: 2, total: 4 });
  });

  it('treats goals without status as active', () => {
    const cfg = { goals: [{}, {}, { status: 'completed' }] };
    assert.deepEqual(countGoals(cfg), { active: 2, total: 3 });
  });
});

// ---------------------------------------------------------------------------
// Cell formatters
// ---------------------------------------------------------------------------

describe('stateLabel', () => {
  it('uppercases known states', () => {
    assert.equal(stateLabel('running'), 'RUNNING');
    assert.equal(stateLabel('active'), 'ACTIVE');
    assert.equal(stateLabel('paused'), 'PAUSED');
    assert.equal(stateLabel('idle'), 'IDLE');
  });

  it('handles unknown states gracefully', () => {
    assert.equal(stateLabel('weird'), 'WEIRD');
    assert.equal(stateLabel(undefined), 'UNKNOWN');
  });
});

describe('formatGoalsCell', () => {
  it('renders "0" when there are no goals', () => {
    assert.equal(formatGoalsCell({ active: 0, total: 0 }), '0');
  });

  it('renders just the total when all are active', () => {
    assert.equal(formatGoalsCell({ active: 3, total: 3 }), '3');
  });

  it('renders active/total when some are inactive', () => {
    assert.equal(formatGoalsCell({ active: 2, total: 5 }), '2/5');
  });
});

describe('formatTasksCell', () => {
  it('renders em dash when no tasks exist', () => {
    assert.equal(formatTasksCell({ total: 0, byStatus: {} }), '—');
  });

  it('renders completed/total', () => {
    assert.equal(
      formatTasksCell({ total: 5, byStatus: { completed: 2, pending: 3 } }),
      '2/5'
    );
  });
});

describe('formatBudgetCell', () => {
  it('renders "no limit" when limit is zero', () => {
    assert.equal(formatBudgetCell({ weeklyTokenLimit: 0 }, { totalTokens: 0 }), 'no limit');
  });

  it('renders tokens and percentage', () => {
    const cell = formatBudgetCell(
      { weeklyTokenLimit: 100000, utilizationPct: 25 },
      { totalTokens: 25000 }
    );
    assert.ok(cell.includes('25,000'));
    assert.ok(cell.includes('100,000'));
    assert.ok(cell.includes('25%'));
  });
});

// ---------------------------------------------------------------------------
// buildSummaryRow
// ---------------------------------------------------------------------------

describe('buildSummaryRow', () => {
  it('shapes a dashboard row from status + config', () => {
    const status = {
      id: 'agent-a-123',
      name: 'Alice',
      role: 'dev',
      state: 'active',
      plan: { tasks: { total: 5, byStatus: { completed: 2, pending: 3 } } },
      budget: { weeklyTokenLimit: 100000, utilizationPct: 25 },
      usage: { totalTokens: 25000 },
    };
    const config = {
      id: 'agent-a-123',
      goals: [{ status: 'active' }, { status: 'active' }, { status: 'completed' }],
    };

    const row = buildSummaryRow(status, config);

    assert.equal(row.agent, 'Alice');
    assert.equal(row.goals, '2/3');
    assert.equal(row.tasks, '2/5');
    assert.ok(row.budget.includes('25%'));
    assert.equal(row.status, 'ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// renderTable
// ---------------------------------------------------------------------------

describe('renderTable', () => {
  it('includes all five required headers', () => {
    const table = renderTable([]);
    for (const header of ['Agent', 'Goals', 'Tasks', 'Budget', 'Status']) {
      assert.ok(table.includes(header), `Expected header "${header}" in table`);
    }
  });

  it('renders one row per agent and pads columns', () => {
    const rows = [
      { agent: 'Alice', goals: '3', tasks: '2/5', budget: '25% used', status: 'ACTIVE' },
      { agent: 'Bob',   goals: '1', tasks: '—',   budget: 'no limit', status: 'IDLE' },
    ];
    const table = renderTable(rows);
    const lines = table.split('\n');

    // Header + separator + 2 rows
    assert.equal(lines.length, 4);
    assert.ok(lines[0].includes('Agent'));
    assert.ok(lines[2].includes('Alice'));
    assert.ok(lines[3].includes('Bob'));

    // All data lines share the same rendered width (padding honoured)
    const widths = lines.map((l) => l.length);
    assert.ok(widths.every((w) => w === widths[0]));
  });
});

// ---------------------------------------------------------------------------
// formatSummaryReport
// ---------------------------------------------------------------------------

describe('formatSummaryReport', () => {
  it('tells the user to hire when there are no agents', () => {
    const text = formatSummaryReport({
      rows: [],
      week: '2026-W16',
      weekMonday: '2026-04-13',
      agentCount: 0,
    });
    assert.ok(text.includes('No agents found'));
    assert.ok(text.includes('/aweek:hire'));
  });

  it('includes the week header and a populated table', () => {
    const rows = [
      { agent: 'Alice', goals: '1', tasks: '0/3', budget: 'no limit', status: 'ACTIVE' },
    ];
    const text = formatSummaryReport({
      rows,
      week: '2026-W16',
      weekMonday: '2026-04-13',
      agentCount: 1,
    });
    assert.ok(text.includes('Week: 2026-W16'));
    assert.ok(text.includes('Monday: 2026-04-13'));
    assert.ok(text.includes('Agents: 1'));
    assert.ok(text.includes('Alice'));
    assert.ok(text.includes('Agent'));
    assert.ok(text.includes('Status'));
  });
});

// ---------------------------------------------------------------------------
// buildSummary (end-to-end)
// ---------------------------------------------------------------------------

describe('buildSummary end-to-end', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns empty report when the agents directory is empty', async () => {
    const result = await buildSummary({
      dataDir: tmpDir,
      date: new Date('2026-04-17'),
    });

    assert.equal(result.agentCount, 0);
    assert.equal(result.rows.length, 0);
    assert.ok(result.report.includes('No agents found'));
    assert.equal(result.week, '2026-W16');
    assert.equal(result.weekMonday, '2026-04-13');
  });

  it('aggregates goals, tasks, budget and status for each agent', async () => {
    const agentStore = new AgentStore(tmpDir);
    const weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    const usageStore = new UsageStore(tmpDir);

    // Alice — active, has plan + goals + usage
    const alice = makeAgent('Alice');
    alice.goals = [createGoal('Ship MVP', '3mo'), createGoal('Hire eng', '1yr')];
    alice.goals[1].status = 'completed';
    await agentStore.save(alice);

    const plan = createWeeklyPlan('2026-W16', '2026-04', [
      { ...createTask('t1', 'obj-1'), status: 'completed' },
      { ...createTask('t2', 'obj-1'), status: 'pending' },
      { ...createTask('t3', 'obj-1'), status: 'pending' },
    ]);
    plan.approved = true;
    plan.approvedAt = new Date().toISOString();
    await weeklyPlanStore.save(alice.id, plan);

    await usageStore.append(
      alice.id,
      createUsageRecord({
        agentId: alice.id,
        taskId: 't1',
        inputTokens: 15000,
        outputTokens: 10000,
        week: '2026-04-13',
        timestamp: '2026-04-15T10:00:00Z',
      })
    );

    // Bob — idle, no plan, one goal
    const bob = makeAgent('Bob');
    bob.goals = [createGoal('Write docs', '1mo')];
    await agentStore.save(bob);

    const result = await buildSummary({
      dataDir: tmpDir,
      date: new Date('2026-04-17'),
    });

    assert.equal(result.agentCount, 2);
    assert.equal(result.rows.length, 2);

    const byName = Object.fromEntries(result.rows.map((r) => [r.agent, r]));
    // Alice: 1 active of 2 goals, 1 completed of 3 tasks, 25% usage, ACTIVE
    assert.equal(byName.Alice.goals, '1/2');
    assert.equal(byName.Alice.tasks, '1/3');
    assert.ok(byName.Alice.budget.includes('25%'));
    assert.equal(byName.Alice.status, 'ACTIVE');

    // Bob: 1 active goal (shown as "1"), no tasks, no usage, IDLE
    assert.equal(byName.Bob.goals, '1');
    assert.equal(byName.Bob.tasks, '—');
    assert.equal(byName.Bob.status, 'IDLE');

    // Report must contain a rendered table with the required columns
    for (const header of ['Agent', 'Goals', 'Tasks', 'Budget', 'Status']) {
      assert.ok(result.report.includes(header), `Missing header: ${header}`);
    }
    assert.ok(result.report.includes('Alice'));
    assert.ok(result.report.includes('Bob'));
  });

  it('throws when dataDir is missing', async () => {
    await assert.rejects(() => buildSummary({}), /dataDir is required/);
  });
});

// ---------------------------------------------------------------------------
// Drill-down (AC 7) — interactive deep dive
// ---------------------------------------------------------------------------

describe('getAgentDrillDownChoices', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns only the sentinel "No thanks" entry when no agents exist', async () => {
    const choices = await getAgentDrillDownChoices({ dataDir: tmpDir });

    assert.equal(choices.length, 1);
    const [cancel] = choices;
    assert.equal(cancel.id, null);
    assert.ok(cancel.label.toLowerCase().includes('no thanks'));
  });

  it('lists every agent plus a trailing "No thanks" entry', async () => {
    const agentStore = new AgentStore(tmpDir);

    const alice = makeAgent('Alice');
    const bob = makeAgent('Bob');
    bob.budget.paused = true;

    await agentStore.save(alice);
    await agentStore.save(bob);

    const choices = await getAgentDrillDownChoices({ dataDir: tmpDir });

    // Two real agents + one sentinel
    assert.equal(choices.length, 3);

    const realChoices = choices.filter((c) => c.id !== null);
    assert.equal(realChoices.length, 2);

    // Paused agents surface the [paused] marker in their label
    const bobChoice = realChoices.find((c) => c.name === 'Bob');
    assert.ok(bobChoice, 'expected Bob in choices');
    assert.equal(bobChoice.paused, true);
    assert.ok(bobChoice.label.includes('[paused]'));

    // Alice is not paused
    const aliceChoice = realChoices.find((c) => c.name === 'Alice');
    assert.ok(aliceChoice, 'expected Alice in choices');
    assert.equal(aliceChoice.paused, false);
    assert.ok(!aliceChoice.label.includes('[paused]'));

    // Sentinel must be the last entry so the skill UX stays predictable
    assert.equal(choices[choices.length - 1].id, null);
  });

  it('labels include the role when present', async () => {
    const agentStore = new AgentStore(tmpDir);
    const alice = makeAgent('Alice');
    await agentStore.save(alice);

    const choices = await getAgentDrillDownChoices({ dataDir: tmpDir });
    const aliceChoice = choices.find((c) => c.name === 'Alice');
    assert.ok(aliceChoice.label.includes('Alice'));
    assert.ok(aliceChoice.label.includes('Alice role'));
  });
});

describe('buildAgentDrillDown', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('requires both dataDir and agentId', async () => {
    await assert.rejects(
      () => buildAgentDrillDown({ agentId: 'x' }),
      /dataDir is required/
    );
    await assert.rejects(
      () => buildAgentDrillDown({ dataDir: tmpDir }),
      /agentId is required/
    );
  });

  it('throws a predictable error for unknown agent ids', async () => {
    await assert.rejects(
      () => buildAgentDrillDown({ dataDir: tmpDir, agentId: 'missing-id' }),
      /Agent not found: missing-id/
    );
  });

  it('returns the long-form status block for the selected agent', async () => {
    const agentStore = new AgentStore(tmpDir);
    const weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    const usageStore = new UsageStore(tmpDir);

    const alice = makeAgent('Alice');
    alice.goals = [createGoal('Ship MVP', '3mo')];
    await agentStore.save(alice);

    const plan = createWeeklyPlan('2026-W16', '2026-04', [
      { ...createTask('t1', 'obj-1'), status: 'completed' },
      { ...createTask('t2', 'obj-1'), status: 'pending' },
    ]);
    plan.approved = true;
    plan.approvedAt = new Date().toISOString();
    await weeklyPlanStore.save(alice.id, plan);

    await usageStore.append(
      alice.id,
      createUsageRecord({
        agentId: alice.id,
        taskId: 't1',
        inputTokens: 10000,
        outputTokens: 5000,
        week: '2026-04-13',
        timestamp: '2026-04-15T10:00:00Z',
      })
    );

    const result = await buildAgentDrillDown({
      dataDir: tmpDir,
      agentId: alice.id,
      date: new Date('2026-04-17'),
    });

    assert.equal(result.agentId, alice.id);
    assert.equal(result.name, 'Alice');
    assert.equal(result.week, '2026-W16');
    assert.equal(result.weekMonday, '2026-04-13');

    // The report reuses formatAgentStatus so the long-form status cues
    // must be present — agent name, role, plan week, budget line.
    assert.ok(result.report.includes('Alice'));
    assert.ok(result.report.includes('Alice role'));
    assert.ok(result.report.includes('2026-W16'));
    assert.ok(result.report.includes('Budget'));

    // Task summary from the plan
    assert.ok(result.report.includes('1 completed'));
    assert.ok(result.report.includes('1 pending'));

    // The raw status object is also returned for callers that want the
    // structured shape (e.g. automated tests in larger workflows).
    assert.equal(result.status.id, alice.id);
    assert.equal(result.status.state, 'active');
  });

  it('uses the provided date for week resolution', async () => {
    const agentStore = new AgentStore(tmpDir);
    const alice = makeAgent('Alice');
    await agentStore.save(alice);

    const result = await buildAgentDrillDown({
      dataDir: tmpDir,
      agentId: alice.id,
      date: new Date('2026-01-05'), // 2026-W02
    });

    assert.equal(result.week, '2026-W02');
    assert.equal(result.weekMonday, '2026-01-05');
  });
});
