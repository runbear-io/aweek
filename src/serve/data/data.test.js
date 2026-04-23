/**
 * Data-layer test suite for the SPA dashboard (`src/serve/data/*`).
 *
 * This file has two jobs:
 *
 *   1. **Read-only invariants (AC 9).** The data layer must source from
 *      existing `src/storage/*` stores (plus `src/subagents/subagent-file.js`
 *      and pure helpers in `src/time/zone.js`) and introduce NO new
 *      persistence. The static-check tests below scan every module source
 *      for disallowed imports and fs-write APIs.
 *
 *   2. **JSON API contract consumed by the SPA (AC 90202 sub-AC 2).**
 *      Every gatherer in this directory feeds a specific endpoint in
 *      `src/serve/server.js` that the SPA's `src/serve/spa/lib/api-client.js`
 *      fetches with a JSDoc-typed shape. The dynamic tests below exercise
 *      each gatherer against a fixture `.aweek/` and assert the returned
 *      payload matches those types field-for-field — so a regression in
 *      the data layer breaks these tests before it ever reaches the UI.
 *
 *      There are no SSR / HTML assertions in this file: the data layer
 *      has always returned plain JSON. The test assertions intentionally
 *      mirror the JSDoc typedefs in `api-client.js` (`AgentListRow`,
 *      `AgentProfile`, `AgentPlan`, `AgentUsage`, `AgentLogs`) so the
 *      two files move together.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import * as dataIndex from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = __dirname;

/**
 * Writable-FS APIs the data layer must never call.
 *
 * Each entry is a regex that matches the API in *call position*, not as
 * a substring of an unrelated identifier. Anchoring on `\b…\(` (optional
 * leading `.`) keeps "transform" from falsely matching "rm" and prevents
 * other innocent comment substrings from flunking the assertion.
 */
const FORBIDDEN_WRITE_APIS = [
  /\bwriteFile\s*\(/,
  /\bappendFile\s*\(/,
  /\bmkdir\s*\(/,
  /(?:\.)?\brm\s*\(/,
  /\brmdir\s*\(/,
  /\bunlink\s*\(/,
  /\brename\s*\(/,
  /\bcopyFile\s*\(/,
  /\bchmod\s*\(/,
  /\bchown\s*\(/,
  /\btruncate\s*\(/,
  /\bcreateWriteStream\s*\(/,
  /\bopenSync\s*\(/,
];

/**
 * Allowed import specifiers for modules under `src/serve/data/`.
 * The list is deliberately strict: anything that isn't one of these is
 * a regression on AC 9 (no new persistence, no side channels).
 */
const ALLOWED_IMPORT_PREFIXES = [
  'node:path',
  'node:fs/promises', // only imported by the test file; data modules don't need it
  'node:assert',
  'node:test',
  'node:os',
  'node:url',
  '../../storage/',
  '../../subagents/subagent-file.js',
  '../../time/zone.js',
  './agents.js',
  './budget.js',
  './plan.js',
  './calendar.js',
  './activity.js',
  './execution-log.js',
  './logs.js',
  './index.js',
];

async function listDataModules() {
  const entries = await readdir(DATA_DIR);
  return entries
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
}

test('data layer: every production module has allowlisted imports only', async () => {
  const files = await listDataModules();
  assert.ok(files.length > 0, 'expected at least one data-layer module');

  for (const file of files) {
    const src = await readFile(join(DATA_DIR, file), 'utf-8');
    const importRe = /import\s+(?:[\s\S]*?)from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(src)) !== null) {
      const spec = m[1];
      const allowed = ALLOWED_IMPORT_PREFIXES.some((prefix) =>
        spec.startsWith(prefix),
      );
      assert.ok(
        allowed,
        `${file}: disallowed import "${spec}" — data layer must import only from src/storage/, src/subagents/subagent-file.js, src/time/zone.js, or node:path`,
      );
    }
  }
});

test('data layer: no module uses a filesystem write API', async () => {
  const files = await listDataModules();
  for (const file of files) {
    const src = await readFile(join(DATA_DIR, file), 'utf-8');
    for (const api of FORBIDDEN_WRITE_APIS) {
      assert.equal(
        api.test(src),
        false,
        `${file}: uses forbidden write API matching /${api.source}/ — AC 9 forbids new persistence`,
      );
    }
  }
});

test('data layer: production modules do not import node:fs or node:fs/promises directly', async () => {
  // Storage modules (`src/storage/*`) own all fs access. Importing fs
  // directly from the data layer would bypass the storage contract.
  const files = await listDataModules();
  for (const file of files) {
    const src = await readFile(join(DATA_DIR, file), 'utf-8');
    assert.equal(
      /from\s+['"]node:fs(\/promises)?['"]/.test(src),
      false,
      `${file}: must not import node:fs directly — go through src/storage/*`,
    );
  }
});

test('data layer: barrel re-exports every expected gatherer', () => {
  const expected = [
    'gatherAgentsList',
    'gatherAgentProfile',
    'gatherBudgetList',
    'gatherAgentUsage',
    'gatherAgentPlan',
    'gatherAgentCalendar',
    'gatherTaskActivity',
    'gatherAgentActivity',
    'gatherAgentLogs',
    'streamExecutionLogLines',
  ];
  for (const name of expected) {
    assert.equal(
      typeof dataIndex[name],
      'function',
      `index.js must re-export ${name}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Dynamic fixtures — exercise the gatherers against a tmp `.aweek/` so we
// know the storage plumbing wires up end-to-end without touching the real
// project data dir.
// ---------------------------------------------------------------------------

async function makeFixtureProject() {
  const root = await mkdtempSafe('aweek-data-test-');
  const agentsDir = join(root, '.aweek', 'agents');
  await mkdir(agentsDir, { recursive: true });

  const agentId = 'fixture-agent';
  const now = new Date().toISOString();
  const weekMonday = mondayIso(new Date());
  // Minimal agent config — shape matches `src/schemas/agent.schema.js`.
  const config = {
    id: agentId,
    subagentRef: agentId,
    createdAt: now,
    updatedAt: now,
    weeklyTokenBudget: 10_000,
    budget: {
      weeklyTokenLimit: 10_000,
      currentUsage: 0,
      periodStart: weekMonday,
      paused: false,
    },
  };
  await writeFile(
    join(agentsDir, `${agentId}.json`),
    JSON.stringify(config, null, 2) + '\n',
    'utf-8',
  );

  // Plan.md body so gatherAgentPlan has something to read.
  await mkdir(join(agentsDir, agentId), { recursive: true });
  await writeFile(
    join(agentsDir, agentId, 'plan.md'),
    '# Fixture plan\n\nOne line of content.\n',
    'utf-8',
  );

  // Subagent identity file.
  const claudeAgents = join(root, '.claude', 'agents');
  await mkdir(claudeAgents, { recursive: true });
  await writeFile(
    join(claudeAgents, `${agentId}.md`),
    '---\nname: Fixture Agent\ndescription: A test fixture.\n---\n\nYou are a test.\n',
    'utf-8',
  );

  return { root, agentId };
}

async function mkdtempSafe(prefix) {
  const base = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(base, { recursive: true });
  return base;
}

function mondayIso(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

test('gatherAgentsList reads from fixture .aweek/ via src/storage/*', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const rows = await dataIndex.gatherAgentsList({ projectDir: root });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.slug, agentId);
    assert.equal(row.name, 'Fixture Agent');
    assert.equal(row.description, 'A test fixture.');
    assert.equal(row.missing, false);
    assert.equal(row.tokenLimit, 10_000);
    assert.equal(row.tokensUsed, 0);
    assert.equal(row.status, 'active');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentProfile returns identity + scheduling + budget', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const profile = await dataIndex.gatherAgentProfile({
      projectDir: root,
      slug: agentId,
    });
    assert.ok(profile, 'expected non-null profile');
    assert.equal(profile.slug, agentId);
    assert.equal(profile.name, 'Fixture Agent');
    assert.equal(profile.paused, false);
    assert.equal(profile.tokenLimit, 10_000);
    assert.equal(profile.overBudget, false);
    // systemPrompt is sourced from .claude/agents/<slug>.md body (Sub-AC 5).
    assert.equal(profile.systemPrompt, 'You are a test.');
    // Unknown slug → null so the HTTP layer can map to 404.
    const missing = await dataIndex.gatherAgentProfile({
      projectDir: root,
      slug: 'does-not-exist',
    });
    assert.equal(missing, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentPlan returns the raw plan.md body', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const plan = await dataIndex.gatherAgentPlan({
      projectDir: root,
      slug: agentId,
    });
    assert.ok(plan, 'expected non-null plan');
    assert.equal(plan.slug, agentId);
    assert.equal(plan.hasPlan, true);
    assert.match(plan.markdown, /^# Fixture plan/);
    // Fresh fixtures have no weekly plans yet — verify empty defaults.
    assert.ok(Array.isArray(plan.weeklyPlans), 'weeklyPlans must be an array');
    assert.equal(plan.weeklyPlans.length, 0);
    assert.equal(plan.latestApproved, null);

    const missing = await dataIndex.gatherAgentPlan({
      projectDir: root,
      slug: 'does-not-exist',
    });
    assert.equal(missing, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentPlan includes weekly plan data from weekly-plan-store', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    // Seed two weekly plans directly through the store so the fixture
    // exercises the same read path the gatherer uses in production.
    const { WeeklyPlanStore } = await import(
      '../../storage/weekly-plan-store.js'
    );
    const { createTask, createWeeklyPlan } = await import(
      '../../models/agent.js'
    );
    const agentsDir = join(root, '.aweek', 'agents');
    const store = new WeeklyPlanStore(agentsDir);

    const t1 = createTask({ title: 'First', prompt: 'Do first' }, 'obj-1');
    const approvedPlan = createWeeklyPlan('2026-W15', '2026-04', [t1]);
    approvedPlan.approved = true;
    approvedPlan.approvedAt = '2026-04-10T00:00:00.000Z';
    await store.save(agentId, approvedPlan);

    const t2 = createTask({ title: 'Second', prompt: 'Do second' }, 'obj-2');
    const pendingPlan = createWeeklyPlan('2026-W16', '2026-04', [t2]);
    await store.save(agentId, pendingPlan);

    const plan = await dataIndex.gatherAgentPlan({
      projectDir: root,
      slug: agentId,
    });
    assert.ok(plan, 'expected non-null plan payload');
    assert.equal(plan.weeklyPlans.length, 2);
    // loadAll sorts by week key ascending.
    assert.equal(plan.weeklyPlans[0].week, '2026-W15');
    assert.equal(plan.weeklyPlans[1].week, '2026-W16');
    assert.equal(plan.weeklyPlans[0].approved, true);
    assert.equal(plan.weeklyPlans[1].approved, false);
    assert.ok(plan.latestApproved, 'expected a latestApproved plan');
    assert.equal(plan.latestApproved.week, '2026-W15');
    assert.equal(plan.latestApproved.approved, true);
    // Plan markdown still comes through unchanged.
    assert.equal(plan.hasPlan, true);
    assert.match(plan.markdown, /^# Fixture plan/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherBudgetList returns one row per agent with zero usage', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const rows = await dataIndex.gatherBudgetList({ projectDir: root });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slug, agentId);
    assert.equal(rows[0].tokenLimit, 10_000);
    assert.equal(rows[0].tokensUsed, 0);
    assert.equal(rows[0].overBudget, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentUsage returns current-week + historical usage for a known slug', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    // Seed two past usage weeks through the store so we exercise the
    // same read path the gatherer uses in production.
    const { UsageStore, createUsageRecord } = await import(
      '../../storage/usage-store.js'
    );
    const agentsDir = join(root, '.aweek', 'agents');
    const store = new UsageStore(agentsDir);
    // Week 1 — 2 records (one with cost, one without).
    await store.append(
      agentId,
      createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.01,
        model: 'opus',
        week: '2026-04-06',
        timestamp: '2026-04-06T12:00:00.000Z',
      }),
    );
    await store.append(
      agentId,
      createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 200,
        outputTokens: 100,
        model: 'opus',
        week: '2026-04-06',
        timestamp: '2026-04-07T12:00:00.000Z',
      }),
    );
    // Week 2 — 1 record.
    await store.append(
      agentId,
      createUsageRecord({
        agentId,
        taskId: 'task-2',
        inputTokens: 400,
        outputTokens: 200,
        costUsd: 0.05,
        model: 'sonnet',
        week: '2026-04-13',
        timestamp: '2026-04-13T12:00:00.000Z',
      }),
    );

    const usage = await dataIndex.gatherAgentUsage({
      projectDir: root,
      slug: agentId,
    });
    assert.ok(usage, 'expected a non-null usage payload');
    assert.equal(usage.slug, agentId);
    assert.equal(usage.name, 'Fixture Agent');
    assert.equal(usage.missing, false);
    assert.equal(usage.paused, false);
    assert.equal(usage.tokenLimit, 10_000);
    // Current-week figures depend on "now" — a fresh fixture has no
    // records for the current week, so tokensUsed should be 0.
    assert.equal(typeof usage.weekMonday, 'string');
    assert.equal(usage.tokensUsed, 0);
    assert.equal(usage.recordCount, 0);
    assert.equal(usage.overBudget, false);
    assert.equal(usage.utilizationPct, 0);

    // Historical weeks — should include at least the two seeded weeks,
    // sorted ascending by weekMonday.
    assert.ok(Array.isArray(usage.weeks), 'weeks must be an array');
    const w1 = usage.weeks.find((w) => w.weekMonday === '2026-04-06');
    const w2 = usage.weeks.find((w) => w.weekMonday === '2026-04-13');
    assert.ok(w1, 'expected 2026-04-06 week row');
    assert.ok(w2, 'expected 2026-04-13 week row');
    assert.equal(w1.recordCount, 2);
    assert.equal(w1.inputTokens, 300);
    assert.equal(w1.outputTokens, 150);
    assert.equal(w1.totalTokens, 450);
    assert.equal(w1.costUsd, 0.01);
    assert.equal(w2.recordCount, 1);
    assert.equal(w2.totalTokens, 600);
    assert.equal(w2.costUsd, 0.05);

    // Sort order: ascending by weekMonday.
    const sorted = usage.weeks.map((w) => w.weekMonday);
    const copy = [...sorted].sort();
    assert.deepEqual(sorted, copy, 'weeks must be sorted ascending');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentUsage returns null for unknown slug', async () => {
  const { root } = await makeFixtureProject();
  try {
    const missing = await dataIndex.gatherAgentUsage({
      projectDir: root,
      slug: 'does-not-exist',
    });
    assert.equal(missing, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentUsage requires projectDir and slug', async () => {
  await assert.rejects(
    () => dataIndex.gatherAgentUsage({}),
    /projectDir is required/,
  );
  await assert.rejects(
    () => dataIndex.gatherAgentUsage({ projectDir: '/tmp/x' }),
    /slug is required/,
  );
});

test('gatherAgentCalendar degrades to noPlan when no plan exists', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const cal = await dataIndex.gatherAgentCalendar({
      projectDir: root,
      slug: agentId,
    });
    assert.equal(cal.agentId, agentId);
    assert.equal(cal.noPlan, true);
    assert.deepEqual(cal.tasks, []);
    assert.equal(cal.counts.total, 0);

    // Unknown slug → notFound
    const nf = await dataIndex.gatherAgentCalendar({
      projectDir: root,
      slug: 'does-not-exist',
    });
    assert.equal(nf.notFound, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentActivity returns empty entries when no log weeks exist', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const result = await dataIndex.gatherAgentActivity({
      projectDir: root,
      slug: agentId,
    });
    assert.ok(result, 'expected non-null activity result');
    assert.equal(result.slug, agentId);
    assert.equal(result.dateRange, 'all');
    assert.deepEqual(result.entries, []);

    const nf = await dataIndex.gatherAgentActivity({
      projectDir: root,
      slug: 'does-not-exist',
    });
    assert.equal(nf, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentLogs returns empty entries + executions when nothing has been logged', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const logs = await dataIndex.gatherAgentLogs({
      projectDir: root,
      slug: agentId,
    });
    assert.ok(logs, 'expected non-null logs payload');
    assert.equal(logs.slug, agentId);
    assert.equal(logs.dateRange, 'all');
    assert.deepEqual(logs.entries, []);
    assert.deepEqual(logs.executions, []);

    const nf = await dataIndex.gatherAgentLogs({
      projectDir: root,
      slug: 'does-not-exist',
    });
    assert.equal(nf, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentLogs merges activity-log entries and execution records', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    // Seed an activity-log entry through the real store.
    const { ActivityLogStore, createLogEntry } = await import(
      '../../storage/activity-log-store.js'
    );
    const { ExecutionStore, createExecutionRecord } = await import(
      '../../storage/execution-store.js'
    );
    const agentsDir = join(root, '.aweek', 'agents');

    const activityStore = new ActivityLogStore(agentsDir);
    const entry = createLogEntry({
      agentId,
      taskId: 'task-1',
      status: 'completed',
      title: 'Ship a feature',
      duration: 1200,
    });
    await activityStore.append(agentId, entry);

    const executionStore = new ExecutionStore(agentsDir);
    const execRecord = createExecutionRecord({
      agentId,
      status: 'completed',
      taskId: 'task-1',
      duration: 1200,
    });
    await executionStore.record(agentId, execRecord);

    const logs = await dataIndex.gatherAgentLogs({
      projectDir: root,
      slug: agentId,
    });
    assert.ok(logs);
    assert.equal(logs.entries.length, 1);
    assert.equal(logs.entries[0].title, 'Ship a feature');
    assert.equal(logs.entries[0].status, 'completed');

    assert.equal(logs.executions.length, 1);
    assert.equal(logs.executions[0].status, 'completed');
    assert.equal(logs.executions[0].agentId, agentId);
    assert.equal(typeof logs.executions[0].idempotencyKey, 'string');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentLogs requires projectDir and slug', async () => {
  await assert.rejects(
    () => dataIndex.gatherAgentLogs({}),
    /projectDir is required/,
  );
  await assert.rejects(
    () => dataIndex.gatherAgentLogs({ projectDir: '/tmp/x' }),
    /slug is required/,
  );
});

test('parseExecutionBasename splits on the first underscore only', () => {
  const ok = dataIndex.parseExecutionBasename('task-abc_exec-1-2-3');
  assert.deepEqual(ok, { taskId: 'task-abc', executionId: 'exec-1-2-3' });

  assert.equal(dataIndex.parseExecutionBasename('no-underscore'), null);
  assert.equal(dataIndex.parseExecutionBasename('_leading'), null);
  assert.equal(dataIndex.parseExecutionBasename('trailing_'), null);
  assert.equal(dataIndex.parseExecutionBasename('../traversal_x'), null);
});

test('resolveDateRange coerces unknown values to the default', () => {
  assert.equal(dataIndex.resolveDateRange('all'), 'all');
  assert.equal(dataIndex.resolveDateRange('this-week'), 'this-week');
  assert.equal(dataIndex.resolveDateRange('last-7-days'), 'last-7-days');
  assert.equal(dataIndex.resolveDateRange('bogus'), 'all');
  assert.equal(dataIndex.resolveDateRange(undefined), 'all');
});

// ---------------------------------------------------------------------------
// Derivation helpers — exported from the data layer and shared with the
// SPA for client-side derivations. Tested directly so regressions here
// surface without needing to spin up fixture filesystems.
// ---------------------------------------------------------------------------

test('deriveAgentStatus: not paused → active (even if usage ≥ limit)', () => {
  assert.equal(
    dataIndex.deriveAgentStatus(
      { weeklyTokenBudget: 1000, budget: { paused: false } },
      { totalTokens: 500 },
    ),
    'active',
  );
  // Budget exhaustion alone is not enough — the heartbeat sets `paused`
  // when it trips the limit; until that happens the UI must read "active".
  assert.equal(
    dataIndex.deriveAgentStatus(
      { weeklyTokenBudget: 1000, budget: { paused: false } },
      { totalTokens: 5000 },
    ),
    'active',
  );
});

test('deriveAgentStatus: paused without over-limit → paused', () => {
  assert.equal(
    dataIndex.deriveAgentStatus(
      { weeklyTokenBudget: 1000, budget: { paused: true } },
      { totalTokens: 100 },
    ),
    'paused',
  );
});

test('deriveAgentStatus: paused + at/over limit → budget-exhausted', () => {
  assert.equal(
    dataIndex.deriveAgentStatus(
      { weeklyTokenBudget: 1000, budget: { paused: true } },
      { totalTokens: 1000 },
    ),
    'budget-exhausted',
  );
  assert.equal(
    dataIndex.deriveAgentStatus(
      { weeklyTokenBudget: 1000, budget: { paused: true } },
      { totalTokens: 2500 },
    ),
    'budget-exhausted',
  );
});

test('deriveBudget: no limit → utilizationPct null, overBudget false', () => {
  const b = dataIndex.deriveBudget(
    { weeklyTokenBudget: 0 },
    { totalTokens: 500 },
  );
  assert.equal(b.tokenLimit, 0);
  assert.equal(b.tokensUsed, 500);
  assert.equal(b.overBudget, false);
  assert.equal(b.utilizationPct, null);
  assert.equal(b.remaining, 0);
});

test('deriveBudget: with limit → remaining / pct / overBudget derive correctly', () => {
  const under = dataIndex.deriveBudget(
    { weeklyTokenBudget: 1000 },
    { totalTokens: 250 },
  );
  assert.deepEqual(under, {
    tokenLimit: 1000,
    tokensUsed: 250,
    remaining: 750,
    overBudget: false,
    utilizationPct: 25,
  });
  const at = dataIndex.deriveBudget(
    { weeklyTokenBudget: 1000 },
    { totalTokens: 1000 },
  );
  assert.equal(at.overBudget, true);
  assert.equal(at.remaining, 0);
  assert.equal(at.utilizationPct, 100);
  const over = dataIndex.deriveBudget(
    { weeklyTokenBudget: 1000 },
    { totalTokens: 1500 },
  );
  assert.equal(over.overBudget, true);
  assert.equal(over.remaining, 0); // never negative
  assert.equal(over.utilizationPct, 150);
});

test('isSafePathSegment: rejects separators, traversal, and empties', () => {
  assert.equal(dataIndex.isSafePathSegment('task-1_exec-a'), true);
  assert.equal(dataIndex.isSafePathSegment(''), false);
  assert.equal(dataIndex.isSafePathSegment('foo/bar'), false);
  assert.equal(dataIndex.isSafePathSegment('foo\\bar'), false);
  assert.equal(dataIndex.isSafePathSegment('..'), false);
  assert.equal(dataIndex.isSafePathSegment('foo/../bar'), false);
  assert.equal(dataIndex.isSafePathSegment(42), false);
});

test('computeDateRangeBounds: all → null cutoff', () => {
  assert.deepEqual(dataIndex.computeDateRangeBounds('all'), { cutoff: null });
  assert.deepEqual(
    dataIndex.computeDateRangeBounds('unknown-preset'),
    { cutoff: null },
  );
});

test('computeDateRangeBounds: last-7-days subtracts exactly 7*24h', () => {
  const now = new Date('2026-04-23T15:30:00.000Z');
  const { cutoff } = dataIndex.computeDateRangeBounds('last-7-days', now);
  assert.equal(cutoff, now.getTime() - 7 * 24 * 60 * 60 * 1000);
});

test('computeDateRangeBounds: this-week pins to Monday 00:00 UTC', () => {
  // 2026-04-23 is a Thursday (UTC); the Monday of that ISO week is 2026-04-20.
  const now = new Date('2026-04-23T15:30:00.000Z');
  const { cutoff } = dataIndex.computeDateRangeBounds('this-week', now);
  const iso = new Date(cutoff).toISOString();
  assert.equal(iso, '2026-04-20T00:00:00.000Z');

  // Sunday edge case — "this week" still points back at the *previous*
  // Monday, matching ISO-week semantics.
  const sunday = new Date('2026-04-26T10:00:00.000Z');
  const { cutoff: c2 } = dataIndex.computeDateRangeBounds('this-week', sunday);
  assert.equal(new Date(c2).toISOString(), '2026-04-20T00:00:00.000Z');
});

test('computeTaskSlot: returns null for missing / invalid runAt', () => {
  const weekMonday = new Date('2026-04-20T00:00:00.000Z');
  assert.equal(dataIndex.computeTaskSlot({}, weekMonday, 'UTC'), null);
  assert.equal(
    dataIndex.computeTaskSlot({ runAt: '' }, weekMonday, 'UTC'),
    null,
  );
  assert.equal(
    dataIndex.computeTaskSlot({ runAt: 'not-a-date' }, weekMonday, 'UTC'),
    null,
  );
  // Out-of-week runAt → null (before Monday, after Sunday).
  assert.equal(
    dataIndex.computeTaskSlot(
      { runAt: '2026-04-13T10:00:00.000Z' },
      weekMonday,
      'UTC',
    ),
    null,
  );
  assert.equal(
    dataIndex.computeTaskSlot(
      { runAt: '2026-04-27T10:00:00.000Z' },
      weekMonday,
      'UTC',
    ),
    null,
  );
});

test('computeTaskSlot: maps a UTC runAt to dayKey/hour/minute/iso', () => {
  const weekMonday = new Date('2026-04-20T00:00:00.000Z');
  // 2026-04-22 is a Wednesday → dayOffset 2, dayKey 'wed'.
  const slot = dataIndex.computeTaskSlot(
    { runAt: '2026-04-22T14:30:00.000Z' },
    weekMonday,
    'UTC',
  );
  assert.ok(slot, 'expected slot object');
  assert.equal(slot.dayKey, 'wed');
  assert.equal(slot.dayOffset, 2);
  assert.equal(slot.hour, 14);
  assert.equal(slot.minute, 30);
  assert.equal(slot.iso, '2026-04-22T14:30:00.000Z');
});

// ---------------------------------------------------------------------------
// API contract shape assertions — each gatherer is the source-of-truth
// payload for an endpoint the SPA's `api-client.js` consumes. These tests
// assert that every field declared in the JSDoc typedefs (AgentListRow,
// AgentProfile, AgentPlan, AgentUsage, AgentLogs) is present with the
// expected primitive type. They intentionally do NOT re-check the values
// (covered by the behaviour tests above); they check the contract.
// ---------------------------------------------------------------------------

/**
 * Assert `obj` has exactly the keys `expected` declares (no more, no
 * less) and that each key is typeof the declared primitive. `primitive`
 * can be: 'string' | 'number' | 'boolean' | 'nullable-string' |
 * 'nullable-number' | 'array' | 'object'.
 */
function assertShape(obj, expected, label) {
  assert.ok(obj && typeof obj === 'object', `${label}: expected object`);
  const actualKeys = Object.keys(obj).sort();
  const expectedKeys = Object.keys(expected).sort();
  assert.deepEqual(
    actualKeys,
    expectedKeys,
    `${label}: keys mismatch.\n  actual:   ${JSON.stringify(actualKeys)}\n  expected: ${JSON.stringify(expectedKeys)}`,
  );
  for (const [key, kind] of Object.entries(expected)) {
    const value = obj[key];
    switch (kind) {
      case 'string':
        assert.equal(
          typeof value,
          'string',
          `${label}.${key}: expected string, got ${typeof value} (${JSON.stringify(value)})`,
        );
        break;
      case 'number':
        assert.equal(
          typeof value,
          'number',
          `${label}.${key}: expected number, got ${typeof value}`,
        );
        break;
      case 'boolean':
        assert.equal(
          typeof value,
          'boolean',
          `${label}.${key}: expected boolean, got ${typeof value}`,
        );
        break;
      case 'nullable-string':
        assert.ok(
          value === null || typeof value === 'string',
          `${label}.${key}: expected string|null, got ${typeof value}`,
        );
        break;
      case 'nullable-number':
        assert.ok(
          value === null || typeof value === 'number',
          `${label}.${key}: expected number|null, got ${typeof value}`,
        );
        break;
      case 'nullable-object':
        assert.ok(
          value === null || (typeof value === 'object' && !Array.isArray(value)),
          `${label}.${key}: expected object|null, got ${typeof value}`,
        );
        break;
      case 'array':
        assert.ok(
          Array.isArray(value),
          `${label}.${key}: expected array, got ${typeof value}`,
        );
        break;
      case 'object':
        assert.ok(
          value && typeof value === 'object' && !Array.isArray(value),
          `${label}.${key}: expected object, got ${typeof value}`,
        );
        break;
      default:
        throw new Error(`assertShape: unknown kind ${kind} for ${label}.${key}`);
    }
  }
}

test('SPA contract: gatherAgentsList row matches AgentListRow typedef', async () => {
  const { root } = await makeFixtureProject();
  try {
    const rows = await dataIndex.gatherAgentsList({ projectDir: root });
    assert.equal(rows.length, 1);
    // Shape is the superset of api-client.js `AgentListRow` + the extra
    // dashboard-only fields (`week`, `tasksTotal`, `tasksCompleted`) that
    // the SPA's Overview table surfaces. Any new field added to the
    // gatherer must be reflected here so the contract stays explicit.
    assertShape(
      rows[0],
      {
        slug: 'string',
        name: 'string',
        description: 'string',
        missing: 'boolean',
        status: 'string',
        tokensUsed: 'number',
        tokenLimit: 'number',
        utilizationPct: 'nullable-number',
        week: 'string',
        tasksTotal: 'number',
        tasksCompleted: 'number',
      },
      'AgentListRow',
    );
    // Status enum gate — api-client.js narrows to these three literals.
    assert.ok(
      ['active', 'paused', 'budget-exhausted'].includes(rows[0].status),
      `status must be one of the AgentStatus enum values: ${rows[0].status}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SPA contract: gatherAgentProfile matches AgentProfile typedef', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const profile = await dataIndex.gatherAgentProfile({
      projectDir: root,
      slug: agentId,
    });
    assertShape(
      profile,
      {
        slug: 'string',
        name: 'string',
        description: 'string',
        systemPrompt: 'string',
        missing: 'boolean',
        identityPath: 'string',
        createdAt: 'nullable-string',
        updatedAt: 'nullable-string',
        paused: 'boolean',
        pausedReason: 'nullable-string',
        periodStart: 'nullable-string',
        tokenLimit: 'number',
        tokensUsed: 'number',
        remaining: 'number',
        overBudget: 'boolean',
        utilizationPct: 'nullable-number',
        weekMonday: 'string',
      },
      'AgentProfile',
    );
    // The fixture's .md body is exactly "You are a test."; the Profile
    // tab renders it verbatim, so assert the end-to-end read path pulls
    // the system prompt through unchanged.
    assert.equal(profile.systemPrompt, 'You are a test.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SPA contract: gatherAgentPlan matches AgentPlan typedef', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const plan = await dataIndex.gatherAgentPlan({
      projectDir: root,
      slug: agentId,
    });
    assertShape(
      plan,
      {
        slug: 'string',
        name: 'string',
        hasPlan: 'boolean',
        markdown: 'string',
        weeklyPlans: 'array',
        latestApproved: 'nullable-object',
      },
      'AgentPlan',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SPA contract: gatherAgentUsage matches AgentUsage typedef', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const usage = await dataIndex.gatherAgentUsage({
      projectDir: root,
      slug: agentId,
    });
    assertShape(
      usage,
      {
        slug: 'string',
        name: 'string',
        missing: 'boolean',
        paused: 'boolean',
        pausedReason: 'nullable-string',
        weekMonday: 'string',
        tokenLimit: 'number',
        tokensUsed: 'number',
        inputTokens: 'number',
        outputTokens: 'number',
        costUsd: 'number',
        recordCount: 'number',
        remaining: 'number',
        overBudget: 'boolean',
        utilizationPct: 'nullable-number',
        weeks: 'array',
      },
      'AgentUsage',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SPA contract: gatherAgentLogs matches AgentLogs typedef', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const logs = await dataIndex.gatherAgentLogs({
      projectDir: root,
      slug: agentId,
    });
    assertShape(
      logs,
      {
        slug: 'string',
        dateRange: 'string',
        entries: 'array',
        executions: 'array',
      },
      'AgentLogs',
    );
    // Date-range must be one of the three typed presets — api-client.js
    // narrows to this union and the SPA's filter pill reads it back.
    assert.ok(
      ['all', 'this-week', 'last-7-days'].includes(logs.dateRange),
      `dateRange must be one of the DateRangePreset values: ${logs.dateRange}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Additional dynamic behaviour — gatherers that needed more than the
// empty/404 baselines covered above. These drive the SPA pages beyond
// their initial render (calendar with a plan, activity with entries,
// logs with a date-range filter, budget-list sort order, per-task
// activity grouping, NDJSON stream edge cases).
// ---------------------------------------------------------------------------

test('gatherAgentCalendar projects tasks + counts when a weekly plan exists', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const { WeeklyPlanStore } = await import(
      '../../storage/weekly-plan-store.js'
    );
    const { createTask, createWeeklyPlan } = await import(
      '../../models/agent.js'
    );
    const agentsDir = join(root, '.aweek', 'agents');
    const store = new WeeklyPlanStore(agentsDir);

    // Pin the timezone so slot assertions stay deterministic regardless
    // of the developer's system TZ. `loadConfig` defaults to the host
    // zone when `.aweek/config.json` is missing.
    await writeFile(
      join(root, '.aweek', 'config.json'),
      JSON.stringify({ timeZone: 'UTC' }, null, 2),
      'utf-8',
    );

    // 2026-W17 = week of Monday 2026-04-20 (UTC). `createTask` takes the
    // runAt via its third "options" argument, not the first payload.
    const t1 = createTask(
      { title: 'Wednesday midday task', prompt: 'Do wednesday work' },
      'obj-1',
      { runAt: '2026-04-22T14:00:00.000Z' },
    );
    const t2 = createTask(
      { title: 'Unscheduled task', prompt: 'No runAt' },
      'obj-2',
    );
    t2.status = 'completed';
    const plan = createWeeklyPlan('2026-W17', '2026-04', [t1, t2]);
    plan.approved = true;
    plan.approvedAt = '2026-04-20T00:00:00.000Z';
    await store.save(agentId, plan);

    const cal = await dataIndex.gatherAgentCalendar({
      projectDir: root,
      slug: agentId,
      week: '2026-W17',
    });
    assert.equal(cal.agentId, agentId);
    assert.equal(cal.noPlan, false);
    assert.equal(cal.approved, true);
    assert.equal(cal.week, '2026-W17');
    assert.equal(cal.tasks.length, 2);

    const scheduled = cal.tasks.find((t) => t.title === 'Wednesday midday task');
    const unscheduled = cal.tasks.find((t) => t.title === 'Unscheduled task');
    assert.ok(scheduled && unscheduled);
    assert.ok(scheduled.slot, 'scheduled task must have a slot');
    assert.equal(scheduled.slot.dayKey, 'wed');
    assert.equal(scheduled.slot.hour, 14);
    assert.equal(unscheduled.slot, null, 'unscheduled task must have slot=null');

    // Counts: one pending (default status), one completed; totals match.
    assert.equal(cal.counts.total, 2);
    assert.equal(cal.counts.completed, 1);
    assert.equal(cal.counts.pending, 1);

    // activityByTask is present on every response (possibly empty).
    assert.ok(
      cal.activityByTask && typeof cal.activityByTask === 'object',
      'activityByTask must be an object',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentActivity returns entries sorted newest-first', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const { ActivityLogStore, createLogEntry } = await import(
      '../../storage/activity-log-store.js'
    );
    const agentsDir = join(root, '.aweek', 'agents');
    const store = new ActivityLogStore(agentsDir);

    // Seed three entries across two weeks with out-of-order timestamps.
    const older = createLogEntry({
      agentId,
      taskId: 'task-1',
      status: 'completed',
      title: 'Older',
    });
    older.timestamp = '2026-04-15T10:00:00.000Z';
    const middle = createLogEntry({
      agentId,
      taskId: 'task-1',
      status: 'completed',
      title: 'Middle',
    });
    middle.timestamp = '2026-04-20T10:00:00.000Z';
    const newest = createLogEntry({
      agentId,
      taskId: 'task-2',
      status: 'failed',
      title: 'Newest',
    });
    newest.timestamp = '2026-04-22T10:00:00.000Z';
    await store.append(agentId, older);
    await store.append(agentId, middle);
    await store.append(agentId, newest);

    const result = await dataIndex.gatherAgentActivity({
      projectDir: root,
      slug: agentId,
    });
    assert.ok(result);
    assert.equal(result.dateRange, 'all');
    assert.equal(result.entries.length, 3);
    const titles = result.entries.map((e) => e.title);
    assert.deepEqual(titles, ['Newest', 'Middle', 'Older']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentActivity filters to last-7-days when requested', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const { ActivityLogStore, createLogEntry } = await import(
      '../../storage/activity-log-store.js'
    );
    const agentsDir = join(root, '.aweek', 'agents');
    const store = new ActivityLogStore(agentsDir);

    const now = new Date('2026-04-23T12:00:00.000Z');
    const keep = createLogEntry({
      agentId,
      taskId: 'task-keep',
      status: 'completed',
      title: 'Within window',
    });
    keep.timestamp = '2026-04-19T12:00:00.000Z'; // 4 days before now
    const drop = createLogEntry({
      agentId,
      taskId: 'task-drop',
      status: 'completed',
      title: 'Outside window',
    });
    drop.timestamp = '2026-04-10T12:00:00.000Z'; // 13 days before now
    await store.append(agentId, keep);
    await store.append(agentId, drop);

    const result = await dataIndex.gatherAgentActivity({
      projectDir: root,
      slug: agentId,
      dateRange: 'last-7-days',
      now,
    });
    assert.ok(result);
    assert.equal(result.dateRange, 'last-7-days');
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].title, 'Within window');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentLogs applies date-range to both entries and executions', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const { ActivityLogStore, createLogEntry } = await import(
      '../../storage/activity-log-store.js'
    );
    const { ExecutionStore, createExecutionRecord } = await import(
      '../../storage/execution-store.js'
    );
    const agentsDir = join(root, '.aweek', 'agents');

    const activityStore = new ActivityLogStore(agentsDir);
    const keepEntry = createLogEntry({
      agentId,
      taskId: 'task-1',
      status: 'completed',
      title: 'Recent entry',
    });
    keepEntry.timestamp = '2026-04-20T10:00:00.000Z';
    const dropEntry = createLogEntry({
      agentId,
      taskId: 'task-1',
      status: 'completed',
      title: 'Old entry',
    });
    dropEntry.timestamp = '2026-04-10T10:00:00.000Z';
    await activityStore.append(agentId, keepEntry);
    await activityStore.append(agentId, dropEntry);

    const execStore = new ExecutionStore(agentsDir);
    const keepExec = createExecutionRecord({
      agentId,
      status: 'completed',
      taskId: 'task-1',
    });
    keepExec.timestamp = '2026-04-20T11:00:00.000Z';
    const dropExec = createExecutionRecord({
      agentId,
      status: 'completed',
      taskId: 'task-1',
    });
    dropExec.timestamp = '2026-04-10T11:00:00.000Z';
    await execStore.record(agentId, keepExec);
    await execStore.record(agentId, dropExec);

    const now = new Date('2026-04-23T12:00:00.000Z');
    const logs = await dataIndex.gatherAgentLogs({
      projectDir: root,
      slug: agentId,
      dateRange: 'last-7-days',
      now,
    });
    assert.ok(logs);
    assert.equal(logs.dateRange, 'last-7-days');
    // Both arrays should contain only the in-window record.
    assert.equal(logs.entries.length, 1);
    assert.equal(logs.entries[0].title, 'Recent entry');
    assert.equal(logs.executions.length, 1);
    assert.equal(
      logs.executions[0].timestamp,
      '2026-04-20T11:00:00.000Z',
    );

    // And with `dateRange: 'all'` (or unknown), everything comes back.
    const allLogs = await dataIndex.gatherAgentLogs({
      projectDir: root,
      slug: agentId,
      dateRange: 'all',
      now,
    });
    assert.equal(allLogs.entries.length, 2);
    assert.equal(allLogs.executions.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherBudgetList sorts over-budget agents first', async () => {
  const { root } = await makeFixtureProject();
  try {
    // Seed a second fixture agent with a second config + identity so we
    // have two rows to sort. Then append enough usage to push it over
    // its weekly limit.
    const { UsageStore, createUsageRecord, getMondayDate } = await import(
      '../../storage/usage-store.js'
    );
    const agentsDir = join(root, '.aweek', 'agents');
    const secondId = 'second-agent';
    const now = new Date().toISOString();
    // Agent schema requires periodStart as a full ISO datetime; the
    // usage record's `week` field uses the short YYYY-MM-DD form.
    const periodStart = mondayIso(new Date());
    const weekShort = getMondayDate(new Date());
    const config = {
      id: secondId,
      subagentRef: secondId,
      createdAt: now,
      updatedAt: now,
      weeklyTokenBudget: 100,
      budget: {
        weeklyTokenLimit: 100,
        currentUsage: 0,
        periodStart,
        paused: false,
      },
    };
    await writeFile(
      join(agentsDir, `${secondId}.json`),
      JSON.stringify(config, null, 2) + '\n',
      'utf-8',
    );
    await mkdir(join(root, '.claude', 'agents'), { recursive: true });
    await writeFile(
      join(root, '.claude', 'agents', `${secondId}.md`),
      '---\nname: Second Agent\ndescription: Also a fixture.\n---\n\nYou are a test.\n',
      'utf-8',
    );
    const usageStore = new UsageStore(agentsDir);
    await usageStore.append(
      secondId,
      createUsageRecord({
        agentId: secondId,
        taskId: 'task-over',
        inputTokens: 300,
        outputTokens: 200, // 500 total vs. 100 limit → over budget
        model: 'opus',
        week: weekShort,
        timestamp: new Date().toISOString(),
      }),
    );

    const rows = await dataIndex.gatherBudgetList({ projectDir: root });
    assert.equal(rows.length, 2);
    // The over-budget row MUST be first regardless of slug ordering.
    assert.equal(rows[0].slug, secondId);
    assert.equal(rows[0].overBudget, true);
    assert.equal(rows[1].overBudget, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherTaskActivity groups entries by taskId with a default cap per task', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    const { ActivityLogStore, createLogEntry } = await import(
      '../../storage/activity-log-store.js'
    );
    const agentsDir = join(root, '.aweek', 'agents');
    const store = new ActivityLogStore(agentsDir);

    // Two tasks, two entries each, plus one orphan with no taskId (must
    // be skipped rather than crashing the grouper).
    for (const [taskId, offset] of [
      ['task-a', 0],
      ['task-a', 1],
      ['task-b', 2],
      ['task-b', 3],
    ]) {
      const e = createLogEntry({
        agentId,
        taskId,
        status: 'completed',
        title: `${taskId}-${offset}`,
      });
      e.timestamp = new Date(
        Date.parse('2026-04-20T00:00:00.000Z') + offset * 60_000,
      ).toISOString();
      await store.append(agentId, e);
    }
    const orphan = createLogEntry({
      agentId,
      taskId: 'task-c',
      status: 'completed',
      title: 'orphan-intrinsic',
    });
    delete orphan.taskId; // simulate legacy entry
    await store.append(agentId, orphan);

    const grouped = await dataIndex.gatherTaskActivity({
      projectDir: root,
      slug: agentId,
    });
    const keys = Object.keys(grouped).sort();
    assert.deepEqual(keys, ['task-a', 'task-b']);
    assert.equal(grouped['task-a'].length, 2);
    assert.equal(grouped['task-b'].length, 2);
    // Empty projectDir / slug → empty object, never throws.
    assert.deepEqual(await dataIndex.gatherTaskActivity({}), {});
    assert.deepEqual(
      await dataIndex.gatherTaskActivity({ projectDir: root }),
      {},
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('streamExecutionLogLines yields nothing for unsafe or missing inputs', async () => {
  const { root, agentId } = await makeFixtureProject();
  try {
    async function collect(gen) {
      const out = [];
      for await (const line of gen) out.push(line);
      return out;
    }

    // Missing projectDir → sync throw for programmer errors.
    await assert.rejects(
      () => collect(dataIndex.streamExecutionLogLines({})),
      /projectDir is required/,
    );

    // Unsafe slug → empty stream (silent).
    assert.deepEqual(
      await collect(
        dataIndex.streamExecutionLogLines({
          projectDir: root,
          slug: '../escape',
          basename: 'task_exec',
        }),
      ),
      [],
    );

    // Malformed basename → empty stream.
    assert.deepEqual(
      await collect(
        dataIndex.streamExecutionLogLines({
          projectDir: root,
          slug: agentId,
          basename: 'no-underscore-here',
        }),
      ),
      [],
    );

    // Safe basename, but no on-disk file → empty stream (ENOENT absorbed
    // by the underlying readExecutionLogLines iterator).
    assert.deepEqual(
      await collect(
        dataIndex.streamExecutionLogLines({
          projectDir: root,
          slug: agentId,
          basename: 'task-1_exec-1',
        }),
      ),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Silence the unused-import lint: dynamic fs APIs (readdir, writeFile,
// mkdir, rm) are used by the test helpers above. readFile is used by
// the static-check tests.
void [readFile, readdir, mkdir, writeFile, rm, resolve];
