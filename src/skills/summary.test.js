/**
 * Tests for the summary skill — compact dashboard renderer.
 *
 * The summary skill treats the subagent .md file at
 * `.claude/agents/SLUG.md` as the single source of truth for every agent's
 * display name and description. These tests set up a temporary project
 * directory that holds both the aweek data dir and the subagent .md files so
 * the live-read and missing-marker behaviours can be exercised without
 * mocking filesystem calls.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, unlink } from 'node:fs/promises';
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
  buildSubagentMarkdown,
  subagentFilePath,
} from '../subagents/subagent-file.js';

import {
  countGoals,
  stateLabel,
  formatGoalsCell,
  formatTasksCell,
  formatBudgetCell,
  formatAgentCell,
  buildSummaryRow,
  renderTable,
  formatSummaryReport,
  buildSummary,
  getAgentDrillDownChoices,
  buildAgentDrillDown,
  MISSING_SUBAGENT_MARKER,
} from './summary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let projectDir;
let dataDir;

async function setup() {
  // projectDir doubles as both the aweek data root and the .claude/agents
  // host so readSubagentIdentity resolves against the same filesystem tree
  // the AgentStore is writing into.
  tmpDir = await mkdtemp(join(tmpdir(), 'summary-test-'));
  projectDir = tmpDir;
  dataDir = join(projectDir, '.aweek', 'agents');
  await mkdir(join(projectDir, '.claude', 'agents'), { recursive: true });
}

async function teardown() {
  await rm(tmpDir, { recursive: true, force: true });
}

/**
 * Write a subagent .md file at `.claude/agents/<slug>.md` with the given
 * display name and description — this is the single source of truth for
 * identity after the refactor.
 */
async function writeSubagentMd(slug, { name, description }) {
  const content = buildSubagentMarkdown({
    name: name || slug,
    description: description || `${slug} description`,
    systemPrompt: `You are ${slug}.`,
  });
  await writeFile(subagentFilePath(slug, projectDir), content, 'utf8');
}

/**
 * Create a valid aweek agent config + matching subagent .md file. The slug
 * is derived from the human-readable `name` so tests can still speak in
 * friendly terms like "Alice" while the wrapper refactor enforces slug ids.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {boolean} [opts.writeSubagentFile=true] - When false, skips writing
 *   the .md file so tests can exercise the missing-marker path.
 * @param {string} [opts.description] - Override for the .md `description`.
 * @param {string} [opts.slug] - Override for the slug (defaults to lowercased name).
 * @returns {Promise<object>} Persisted agent config.
 */
async function makeAgent(name, { writeSubagentFile: shouldWriteMd = true, description, slug } = {}) {
  const effectiveSlug = slug || name.toLowerCase();
  if (shouldWriteMd) {
    await writeSubagentMd(effectiveSlug, {
      name,
      description: description || `${name} role`,
    });
  }
  const config = createAgentConfig({
    subagentRef: effectiveSlug,
    weeklyTokenLimit: 100000,
  });
  return config;
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
  it('shapes a dashboard row from status + config + live subagent info', () => {
    const status = {
      id: 'alice',
      name: 'stale-ignored',
      role: 'dev',
      state: 'active',
      plan: { tasks: { total: 5, byStatus: { completed: 2, pending: 3 } } },
      budget: { weeklyTokenLimit: 100000, utilizationPct: 25 },
      usage: { totalTokens: 25000 },
    };
    const config = {
      id: 'alice',
      goals: [{ status: 'active' }, { status: 'active' }, { status: 'completed' }],
    };
    const subagent = { missing: false, name: 'Alice', description: 'dev' };

    const row = buildSummaryRow(status, config, subagent);

    // The agent cell uses the live .md name — NOT whatever the legacy
    // status object happens to carry.
    assert.equal(row.agent, 'Alice');
    assert.equal(row.goals, '2/3');
    assert.equal(row.tasks, '2/5');
    assert.ok(row.budget.includes('25%'));
    assert.equal(row.status, 'ACTIVE');
  });

  it('renders the missing marker when the subagent .md is gone', () => {
    const status = {
      id: 'alice',
      name: 'stale-ignored',
      role: '',
      state: 'idle',
      plan: { tasks: { total: 0, byStatus: {} } },
      budget: { weeklyTokenLimit: 0 },
      usage: { totalTokens: 0 },
    };
    const row = buildSummaryRow(status, { id: 'alice', goals: [] }, { missing: true });
    assert.ok(row.agent.includes('alice'));
    assert.ok(row.agent.includes(MISSING_SUBAGENT_MARKER));
  });
});

describe('formatAgentCell', () => {
  it('renders the live subagent name when present', () => {
    assert.equal(
      formatAgentCell('alice', { missing: false, name: 'Alice' }),
      'Alice'
    );
  });

  it('falls back to the slug when the name is empty but the file exists', () => {
    assert.equal(
      formatAgentCell('alice', { missing: false, name: '' }),
      'alice'
    );
  });

  it('shows the missing marker when the .md is absent', () => {
    const cell = formatAgentCell('alice', { missing: true, name: '' });
    assert.ok(cell.includes('alice'));
    assert.ok(cell.includes(MISSING_SUBAGENT_MARKER));
  });

  it('shows the missing marker when no subagent info is provided', () => {
    const cell = formatAgentCell('alice', null);
    assert.ok(cell.includes(MISSING_SUBAGENT_MARKER));
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
      dataDir,
      projectDir,
      date: new Date('2026-04-17'),
    });

    assert.equal(result.agentCount, 0);
    assert.equal(result.rows.length, 0);
    assert.ok(result.report.includes('No agents found'));
    assert.equal(result.week, '2026-W16');
    assert.equal(result.weekMonday, '2026-04-13');
  });

  it('aggregates goals, tasks, budget and status for each agent', async () => {
    const agentStore = new AgentStore(dataDir);
    const weeklyPlanStore = new WeeklyPlanStore(dataDir);
    const usageStore = new UsageStore(dataDir);

    // Alice — active, has plan + goals + usage. Her display name lives in
    // .claude/agents/alice.md and is pulled live by buildSummary.
    const alice = await makeAgent('Alice');
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
    const bob = await makeAgent('Bob');
    bob.goals = [createGoal('Write docs', '1mo')];
    await agentStore.save(bob);

    const result = await buildSummary({
      dataDir,
      projectDir,
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

  it('reads name and description live from the subagent .md', async () => {
    const agentStore = new AgentStore(dataDir);
    const alice = await makeAgent('Alice', { description: 'original role' });
    await agentStore.save(alice);

    // Update ONLY the .md — the aweek JSON is never touched. The summary
    // dashboard must reflect the new name the very next time it's rendered.
    await writeSubagentMd('alice', {
      name: 'Alice Renamed',
      description: 'lead dev',
    });

    const result = await buildSummary({
      dataDir,
      projectDir,
      date: new Date('2026-04-17'),
    });

    const row = result.rows[0];
    assert.equal(row.agent, 'Alice Renamed');
    assert.ok(!row.agent.includes(MISSING_SUBAGENT_MARKER));
  });

  it('shows the missing marker when the subagent .md has been deleted', async () => {
    const agentStore = new AgentStore(dataDir);
    const alice = await makeAgent('Alice');
    await agentStore.save(alice);

    // Delete the .md behind aweek's back — simulates a user removing the
    // subagent file without first running /aweek:manage delete.
    await unlink(subagentFilePath('alice', projectDir));

    const result = await buildSummary({
      dataDir,
      projectDir,
      date: new Date('2026-04-17'),
    });

    assert.equal(result.agentCount, 1);
    const row = result.rows[0];
    assert.ok(row.agent.includes('alice'));
    assert.ok(row.agent.includes(MISSING_SUBAGENT_MARKER));
    assert.ok(result.report.includes(MISSING_SUBAGENT_MARKER));
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
    const choices = await getAgentDrillDownChoices({ dataDir, projectDir });

    assert.equal(choices.length, 1);
    const [cancel] = choices;
    assert.equal(cancel.id, null);
    assert.ok(cancel.label.toLowerCase().includes('no thanks'));
  });

  it('lists every agent plus a trailing "No thanks" entry', async () => {
    const agentStore = new AgentStore(dataDir);

    const alice = await makeAgent('Alice');
    const bob = await makeAgent('Bob');
    bob.budget.paused = true;

    await agentStore.save(alice);
    await agentStore.save(bob);

    const choices = await getAgentDrillDownChoices({ dataDir, projectDir });

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

  it('labels include the live subagent description from the .md', async () => {
    const agentStore = new AgentStore(dataDir);
    const alice = await makeAgent('Alice', { description: 'Alice role' });
    await agentStore.save(alice);

    const choices = await getAgentDrillDownChoices({ dataDir, projectDir });
    const aliceChoice = choices.find((c) => c.name === 'Alice');
    assert.ok(aliceChoice, 'expected Alice in choices');
    assert.ok(aliceChoice.label.includes('Alice'));
    assert.ok(aliceChoice.label.includes('Alice role'));
  });

  it('renders the missing marker when an agent has no subagent .md', async () => {
    const agentStore = new AgentStore(dataDir);
    const alice = await makeAgent('Alice');
    await agentStore.save(alice);
    await unlink(subagentFilePath('alice', projectDir));

    const choices = await getAgentDrillDownChoices({ dataDir, projectDir });
    const real = choices.filter((c) => c.id !== null);
    assert.equal(real.length, 1);

    const [orphan] = real;
    assert.equal(orphan.id, 'alice');
    assert.equal(orphan.missing, true);
    assert.ok(orphan.name.includes('alice'));
    assert.ok(orphan.name.includes(MISSING_SUBAGENT_MARKER));
    assert.ok(orphan.label.includes(MISSING_SUBAGENT_MARKER));
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
      () => buildAgentDrillDown({ dataDir }),
      /agentId is required/
    );
  });

  it('throws a predictable error for unknown agent ids', async () => {
    await assert.rejects(
      () => buildAgentDrillDown({ dataDir, projectDir, agentId: 'missing-id' }),
      /Agent not found: missing-id/
    );
  });

  it('returns the long-form status block for the selected agent', async () => {
    const agentStore = new AgentStore(dataDir);
    const weeklyPlanStore = new WeeklyPlanStore(dataDir);
    const usageStore = new UsageStore(dataDir);

    const alice = await makeAgent('Alice', { description: 'Alice role' });
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
      dataDir,
      projectDir,
      agentId: alice.id,
      date: new Date('2026-04-17'),
    });

    assert.equal(result.agentId, alice.id);
    assert.equal(result.name, 'Alice');
    assert.equal(result.week, '2026-W16');
    assert.equal(result.weekMonday, '2026-04-13');

    // Live subagent payload must be returned alongside the status so
    // downstream renderers don't have to re-read the .md themselves.
    assert.equal(result.subagent.missing, false);
    assert.equal(result.subagent.name, 'Alice');
    assert.equal(result.subagent.description, 'Alice role');

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

  it('renders the missing marker when the subagent .md has been deleted', async () => {
    const agentStore = new AgentStore(dataDir);
    const alice = await makeAgent('Alice');
    await agentStore.save(alice);
    await unlink(subagentFilePath('alice', projectDir));

    const result = await buildAgentDrillDown({
      dataDir,
      projectDir,
      agentId: alice.id,
      date: new Date('2026-04-17'),
    });

    assert.equal(result.subagent.missing, true);
    // Name falls back to the slug when the .md is gone — we must never
    // pretend to know a display name that's no longer on disk.
    assert.equal(result.name, alice.id);
    assert.ok(result.report.includes(MISSING_SUBAGENT_MARKER));
  });

  it('uses the provided date for week resolution', async () => {
    const agentStore = new AgentStore(dataDir);
    const alice = await makeAgent('Alice');
    await agentStore.save(alice);

    const result = await buildAgentDrillDown({
      dataDir,
      projectDir,
      agentId: alice.id,
      date: new Date('2026-01-05'), // 2026-W02
    });

    assert.equal(result.week, '2026-W02');
    assert.equal(result.weekMonday, '2026-01-05');
  });
});
