/**
 * Tests for the chat preamble builder (`src/serve/data/chat-preamble.ts`).
 *
 * The preamble is the auto-injected context block prepended to every
 * chat turn. It must read four signals out of the existing
 * `src/storage/*` stores **without writing anything new**:
 *
 *   - weekly plan summary (canonical H2 sections from `plan.md`)
 *   - last 5 activity-log entries (newest first)
 *   - weekly budget remaining (limit − usage for the current ISO week)
 *   - ISO-week key derived in the configured time zone
 *
 * Coverage:
 *   - happy-path build assembles all four signals correctly
 *   - missing plan.md / missing logs / missing weekly plan / no usage —
 *     all degrade to empty / zero values without throwing
 *   - unknown agent slug → throws (programmer error)
 *   - `formatPreamble` deterministic markdown rendering
 *   - activity tail reversal: when more than 5 entries exist, only the
 *     5 newest are surfaced (newest first)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildPreamble,
  formatPreamble,
  PREAMBLE_RECENT_ACTIVITY_LIMIT,
  type ChatPreamble,
} from './chat-preamble.js';
import { DEFAULT_TZ, currentWeekKey } from '../../time/zone.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function mkdtempSafe(prefix: string): Promise<string> {
  const base = join(
    tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(base, { recursive: true });
  return base;
}

/** Compute the Monday ISO date for a given UTC date (matches store math). */
function utcMonday(date: Date): string {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a fixture `.aweek/` directory pinned to UTC so the preamble's
 * Monday-of-week math matches the test's hand-written fixtures
 * regardless of where (or when) CI runs.
 */
async function makeFixtureProject(opts: {
  /** Plan markdown body (omit to leave plan.md absent). */
  planBody?: string | null;
  /** Activity-log entries to seed (defaults to none). */
  activity?: Array<{
    id: string;
    timestamp: string;
    status:
      | 'started'
      | 'completed'
      | 'failed'
      | 'skipped'
      | 'delegated';
    title: string;
    taskId?: string;
    duration?: number;
  }>;
  /** Usage records to seed (defaults to none). */
  usage?: Array<{
    id: string;
    timestamp: string;
    taskId: string;
    inputTokens: number;
    outputTokens: number;
    week: string;
  }>;
  /** Weekly plan tasks to seed for `weekKey` (defaults to none). */
  weeklyTasks?: Array<{
    id: string;
    title: string;
    prompt: string;
    status:
      | 'pending'
      | 'in-progress'
      | 'completed'
      | 'failed'
      | 'delegated'
      | 'skipped';
    objectiveId?: string;
    track?: string;
  }>;
  /** ISO week key for the seeded weekly plan (e.g. `2026-W18`). */
  weekKey?: string;
  /** Month for the seeded weekly plan (e.g. `2026-04`). */
  month?: string;
  /** Token budget on the agent JSON. */
  weeklyTokenBudget?: number;
  /**
   * Anchor "now" for the fixture so the seeded `<weekMonday>.json`
   * activity / usage files line up with the `now` the test passes
   * into `buildPreamble`. Defaults to the wall clock at fixture build
   * time (which is fine for tests that don't pin `now`).
   */
  now?: Date;
  /**
   * IANA time zone written into `.aweek/config.json`. Defaults to
   * `'UTC'` so the existing fixtures stay deterministic. Tests that
   * need to verify timezone-sensitive behavior (Sub-AC 4 of AC 6 — the
   * weekKey must match the configured zone) override this.
   *
   * Pass `null` to suppress the config file entirely so the
   * preamble's "no config → fall back to UTC" branch can be exercised.
   */
  configTimeZone?: string | null;
  /**
   * Override the `weekMonday` used when laying out the activity-log
   * and usage files on disk. Without this, the fixture writes them
   * under the *UTC*-Monday (since `utcMonday` is a UTC computation),
   * which is wrong for tests that pin a non-UTC config and expect the
   * preamble to bucket by the local Monday. Tests that want
   * activity/usage to line up with a specific local-Monday pass it
   * explicitly here.
   */
  fileWeekMonday?: string;
}): Promise<{ root: string; agentId: string; weekMonday: string }> {
  const root = await mkdtempSafe('aweek-chat-preamble-');
  const agentsDir = join(root, '.aweek', 'agents');
  await mkdir(agentsDir, { recursive: true });

  // Pin to UTC by default so Monday math is stable. Tests that need
  // a different zone (e.g. ISO-week boundary checks for Sub-AC 4 of
  // AC 6) override via `configTimeZone`. Pass `null` to omit the file
  // entirely.
  if (opts.configTimeZone !== null) {
    await writeFile(
      join(root, '.aweek', 'config.json'),
      JSON.stringify({ timeZone: opts.configTimeZone ?? 'UTC' }, null, 2) +
        '\n',
      'utf-8',
    );
  }

  const agentId = 'fixture-agent';
  const now = opts.now ?? new Date();
  const weekMonday = opts.fileWeekMonday ?? utcMonday(now);
  const isoNow = now.toISOString();

  const tokenBudget = opts.weeklyTokenBudget ?? 10_000;
  const config = {
    id: agentId,
    subagentRef: agentId,
    createdAt: isoNow,
    updatedAt: isoNow,
    weeklyTokenBudget: tokenBudget,
    budget: {
      weeklyTokenLimit: tokenBudget,
      currentUsage: 0,
      periodStart: `${weekMonday}T00:00:00.000Z`,
      paused: false,
    },
  };
  await writeFile(
    join(agentsDir, `${agentId}.json`),
    JSON.stringify(config, null, 2) + '\n',
    'utf-8',
  );

  await mkdir(join(agentsDir, agentId), { recursive: true });

  // plan.md
  if (typeof opts.planBody === 'string') {
    await writeFile(
      join(agentsDir, agentId, 'plan.md'),
      opts.planBody,
      'utf-8',
    );
  }

  // activity-log
  if (opts.activity && opts.activity.length > 0) {
    const logsDir = join(agentsDir, agentId, 'logs');
    await mkdir(logsDir, { recursive: true });
    const entries = opts.activity.map((a) => ({
      id: a.id,
      timestamp: a.timestamp,
      agentId,
      status: a.status,
      title: a.title,
      ...(a.taskId !== undefined ? { taskId: a.taskId } : {}),
      ...(a.duration !== undefined ? { duration: a.duration } : {}),
    }));
    await writeFile(
      join(logsDir, `${weekMonday}.json`),
      JSON.stringify(entries, null, 2) + '\n',
      'utf-8',
    );
  }

  // usage
  if (opts.usage && opts.usage.length > 0) {
    const usageDir = join(agentsDir, agentId, 'usage');
    await mkdir(usageDir, { recursive: true });
    const records = opts.usage.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      agentId,
      taskId: r.taskId,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      totalTokens: r.inputTokens + r.outputTokens,
      week: r.week,
    }));
    await writeFile(
      join(usageDir, `${weekMonday}.json`),
      JSON.stringify(records, null, 2) + '\n',
      'utf-8',
    );
  }

  // weekly plan
  if (opts.weeklyTasks && opts.weeklyTasks.length > 0) {
    const planDir = join(agentsDir, agentId, 'weekly-plans');
    await mkdir(planDir, { recursive: true });
    const weekKey = opts.weekKey ?? '2026-W18';
    const month = opts.month ?? '2026-04';
    const plan = {
      week: weekKey,
      month,
      tasks: opts.weeklyTasks.map((t) => ({
        id: t.id,
        title: t.title,
        prompt: t.prompt,
        status: t.status,
        ...(t.objectiveId !== undefined ? { objectiveId: t.objectiveId } : {}),
        ...(t.track !== undefined ? { track: t.track } : {}),
      })),
      approved: true,
      approvedAt: isoNow,
      createdAt: isoNow,
      updatedAt: isoNow,
    };
    await writeFile(
      join(planDir, `${weekKey}.json`),
      JSON.stringify(plan, null, 2) + '\n',
      'utf-8',
    );
  }

  return { root, agentId, weekMonday };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('buildPreamble: gathers plan summary, recent activity, budget, and ISO-week key', async () => {
  // Pin "now" to a known UTC instant so the test is deterministic.
  // 2026-04-29 (Wednesday) → Monday 2026-04-27, ISO week 2026-W18.
  const now = new Date('2026-04-29T12:00:00.000Z');
  const weekKey = '2026-W18';
  const planBody = [
    '# Fixture',
    '',
    'Some preamble copy.',
    '',
    '## Long-term goals',
    '',
    'Ship a tiny weekly tracker.',
    '',
    '## Monthly plans',
    '',
    '### 2026-04',
    '',
    '- Outline the v1 schema',
    '',
    '## Strategies',
    '',
    'Default to small atomic PRs.',
    '',
    '## Notes',
    '',
    'Move slowly, integrate often.',
    '',
  ].join('\n');

  const activity = [
    {
      id: 'log-aaaa1111',
      timestamp: '2026-04-27T09:00:00.000Z',
      status: 'completed' as const,
      title: 'morning task',
      taskId: 'task-1',
      duration: 1500,
    },
    {
      id: 'log-aaaa2222',
      timestamp: '2026-04-28T10:00:00.000Z',
      status: 'failed' as const,
      title: 'midday task',
      taskId: 'task-2',
    },
    {
      id: 'log-aaaa3333',
      timestamp: '2026-04-29T11:00:00.000Z',
      status: 'completed' as const,
      title: 'recent task',
      taskId: 'task-3',
      duration: 800,
    },
  ];

  const usage = [
    {
      id: 'usage-aa11',
      timestamp: '2026-04-27T09:00:00.000Z',
      taskId: 'task-1',
      inputTokens: 1000,
      outputTokens: 500,
      week: '2026-04-27',
    },
  ];

  const { root, agentId } = await makeFixtureProject({
    planBody,
    activity,
    usage,
    weeklyTasks: [
      {
        id: 'task-aaaa1',
        title: 'Plan the v1 release',
        prompt: 'Write up the v1 release plan.',
        status: 'pending',
        objectiveId: '2026-04',
        track: 'planning',
      },
    ],
    weekKey,
    month: '2026-04',
    now,
  });

  try {
    const preamble = await buildPreamble({
      projectDir: root,
      slug: agentId,
      now,
    });

    // Time / week
    assert.equal(preamble.slug, agentId);
    assert.equal(preamble.weekKey, weekKey);
    assert.equal(preamble.timeZone, 'UTC');
    assert.equal(preamble.budget.weekMonday, '2026-04-27');

    // Plan sections (canonical only)
    assert.equal(preamble.hasPlan, true);
    assert.match(
      preamble.planSections['Long-term goals'] ?? '',
      /Ship a tiny weekly tracker/,
    );
    assert.match(
      preamble.planSections['Monthly plans'] ?? '',
      /2026-04/,
    );
    assert.match(
      preamble.planSections['Strategies'] ?? '',
      /atomic PRs/,
    );
    assert.match(preamble.planSections['Notes'] ?? '', /integrate often/);

    // Recent activity (newest first, capped at 5)
    assert.equal(preamble.recentActivity.length, 3);
    assert.equal(preamble.recentActivity[0]!.title, 'recent task');
    assert.equal(preamble.recentActivity[1]!.title, 'midday task');
    assert.equal(preamble.recentActivity[2]!.title, 'morning task');
    assert.equal(preamble.recentActivity[0]!.taskId, 'task-3');

    // Weekly tasks
    assert.equal(preamble.weeklyTasks.length, 1);
    assert.equal(preamble.weeklyTasks[0]!.title, 'Plan the v1 release');
    assert.equal(preamble.weeklyTasks[0]!.status, 'pending');
    assert.equal(preamble.weeklyTasks[0]!.track, 'planning');

    // Budget — 10_000 limit, 1500 used
    assert.equal(preamble.budget.tokenLimit, 10_000);
    assert.equal(preamble.budget.tokensUsed, 1500);
    assert.equal(preamble.budget.remaining, 8500);
    assert.equal(preamble.budget.overBudget, false);
    assert.equal(preamble.budget.utilizationPct, 15);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPreamble: caps recent activity at PREAMBLE_RECENT_ACTIVITY_LIMIT and surfaces newest first', async () => {
  const now = new Date('2026-04-29T12:00:00.000Z');
  // Seven activity entries — only the last 5 (newest first) should
  // appear in the preamble.
  const activity = Array.from({ length: 7 }, (_, i) => ({
    // ID pattern: ^log-[a-f0-9]+$ — keep to lowercase hex chars.
    id: `log-aaaa${String(i).padStart(4, '0')}`,
    // Increasing timestamp; index 6 is the newest.
    timestamp: `2026-04-29T0${i}:00:00.000Z`,
    status: 'completed' as const,
    title: `entry-${i}`,
  }));

  const { root, agentId } = await makeFixtureProject({ activity, now });
  try {
    const preamble = await buildPreamble({
      projectDir: root,
      slug: agentId,
      now,
    });
    assert.equal(
      preamble.recentActivity.length,
      PREAMBLE_RECENT_ACTIVITY_LIMIT,
    );
    // Newest first — entry-6 should head the list.
    assert.equal(preamble.recentActivity[0]!.title, 'entry-6');
    assert.equal(preamble.recentActivity[1]!.title, 'entry-5');
    assert.equal(preamble.recentActivity[2]!.title, 'entry-4');
    assert.equal(preamble.recentActivity[3]!.title, 'entry-3');
    assert.equal(preamble.recentActivity[4]!.title, 'entry-2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPreamble: degrades gracefully when plan.md, logs, weekly plan, and usage are absent', async () => {
  const now = new Date('2026-04-29T12:00:00.000Z');
  const { root, agentId } = await makeFixtureProject({
    // No planBody, no activity, no usage, no weeklyTasks.
    now,
  });
  try {
    const preamble = await buildPreamble({
      projectDir: root,
      slug: agentId,
      now,
    });
    assert.equal(preamble.hasPlan, false);
    assert.deepEqual(preamble.planSections, {});
    assert.deepEqual(preamble.weeklyTasks, []);
    assert.deepEqual(preamble.recentActivity, []);
    assert.equal(preamble.budget.tokenLimit, 10_000);
    assert.equal(preamble.budget.tokensUsed, 0);
    assert.equal(preamble.budget.remaining, 10_000);
    assert.equal(preamble.budget.overBudget, false);
    assert.equal(preamble.weekKey, '2026-W18');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPreamble: marks budget overBudget when usage >= limit', async () => {
  const now = new Date('2026-04-29T12:00:00.000Z');
  const { root, agentId } = await makeFixtureProject({
    weeklyTokenBudget: 1000,
    usage: [
      {
        id: 'usage-bb11',
        timestamp: '2026-04-27T09:00:00.000Z',
        taskId: 'task-1',
        inputTokens: 800,
        outputTokens: 300, // total 1100 > 1000
        week: '2026-04-27',
      },
    ],
    now,
  });
  try {
    const preamble = await buildPreamble({
      projectDir: root,
      slug: agentId,
      now,
    });
    assert.equal(preamble.budget.tokenLimit, 1000);
    assert.equal(preamble.budget.tokensUsed, 1100);
    assert.equal(preamble.budget.remaining, 0);
    assert.equal(preamble.budget.overBudget, true);
    assert.equal(preamble.budget.utilizationPct, 110);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPreamble: throws when the agent slug is not present on disk', async () => {
  const { root } = await makeFixtureProject({});
  try {
    await assert.rejects(
      buildPreamble({
        projectDir: root,
        slug: 'does-not-exist',
        now: new Date('2026-04-29T12:00:00.000Z'),
      }),
      /not found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPreamble: throws when projectDir or slug is missing', async () => {
  await assert.rejects(
    // @ts-expect-error - intentionally invalid for runtime guard test
    buildPreamble({ slug: 'foo' }),
    /projectDir/,
  );
  await assert.rejects(
    // @ts-expect-error - intentionally invalid for runtime guard test
    buildPreamble({ projectDir: '/tmp' }),
    /slug/,
  );
});

test('formatPreamble: renders deterministic markdown including all populated sections', () => {
  const preamble: ChatPreamble = {
    slug: 'fixture-agent',
    weekKey: '2026-W18',
    timeZone: 'UTC',
    planSections: {
      'Long-term goals': 'Ship something small every week.',
      Strategies: 'Default to atomic PRs.',
    },
    hasPlan: true,
    weeklyTasks: [
      {
        id: 'task-A',
        title: 'Outline v1',
        status: 'pending',
        objectiveId: '2026-04',
        track: 'planning',
      },
    ],
    recentActivity: [
      {
        timestamp: '2026-04-29T11:00:00.000Z',
        status: 'completed',
        title: 'recent task',
        taskId: 'task-3',
        duration: 800,
      },
    ],
    budget: {
      weekMonday: '2026-04-27',
      tokenLimit: 10_000,
      tokensUsed: 1500,
      remaining: 8500,
      overBudget: false,
      utilizationPct: 15,
    },
  };

  const md = formatPreamble(preamble);

  assert.match(md, /Context for agent "fixture-agent"/);
  assert.match(md, /Current week: \*\*2026-W18\*\*/);
  assert.match(md, /Limit: 10000 tokens/);
  assert.match(md, /Used: 1500 tokens \(15%\)/);
  assert.match(md, /Remaining: 8500 tokens/);
  assert.match(md, /## Plan summary/);
  assert.match(md, /### Long-term goals/);
  assert.match(md, /Ship something small every week\./);
  assert.match(md, /### Strategies/);
  assert.match(md, /Default to atomic PRs\./);
  assert.match(md, /This week's tasks \(2026-W18\)/);
  assert.match(md, /\*\*Outline v1\*\*/);
  assert.match(md, /Recent activity/);
  assert.match(md, /\*\*completed\*\* — recent task/);
  // Sections that are absent should not be emitted.
  assert.equal(md.includes('### Monthly plans'), false);
  assert.equal(md.includes('### Notes'), false);
});

test('formatPreamble: omits absent sections and flags overBudget when relevant', () => {
  const preamble: ChatPreamble = {
    slug: 'lean-agent',
    weekKey: '2026-W18',
    timeZone: 'UTC',
    planSections: {},
    hasPlan: false,
    weeklyTasks: [],
    recentActivity: [],
    budget: {
      weekMonday: '2026-04-27',
      tokenLimit: 100,
      tokensUsed: 200,
      remaining: 0,
      overBudget: true,
      utilizationPct: 200,
    },
  };
  const md = formatPreamble(preamble);
  assert.match(md, /OVER BUDGET/);
  // Plan / tasks / activity sections should be skipped entirely.
  assert.equal(md.includes('## Plan summary'), false);
  assert.equal(md.includes("This week's tasks"), false);
  assert.equal(md.includes('Recent activity'), false);
});

test('formatPreamble: handles "no budget configured" cleanly', () => {
  const preamble: ChatPreamble = {
    slug: 'no-budget-agent',
    weekKey: '2026-W18',
    timeZone: 'UTC',
    planSections: {},
    hasPlan: false,
    weeklyTasks: [],
    recentActivity: [],
    budget: {
      weekMonday: '2026-04-27',
      tokenLimit: 0,
      tokensUsed: 0,
      remaining: 0,
      overBudget: false,
      utilizationPct: null,
    },
  };
  const md = formatPreamble(preamble);
  assert.match(md, /No weekly token budget configured\./);
});

// ---------------------------------------------------------------------------
// Sub-AC 4 of AC 6 — preamble content correctness + first-turn-only injection
//
// The rubric (`system_preamble_accuracy`) requires that the auto-injected
// context is current, accurate, and sourced from the existing stores. The
// tests below pin two specific contracts:
//
//   1. "all 4 fields present" — every preamble carries the four canonical
//      signals (plan summary, recent activity, budget snapshot, ISO-week
//      key). Even sparse / fresh agents must produce all four keys (with
//      empty / zeroed values for missing data) so downstream consumers
//      can rely on the shape unconditionally.
//   2. "ISO-week key matches configured timezone" — the weekKey honors
//      `.aweek/config.json` `timeZone` (i.e. the same zone the dashboard,
//      heartbeat, and `aweek summary` use). When that zone disagrees
//      with UTC across a week boundary, the preamble must report the
//      *local* week, not the UTC week.
//   3. "first-turn-only injection behavior" — `formatPreamble` is
//      deterministic for a given preamble shape, so this file pins the
//      formatter side. The HTTP handler that *decides* when to inject
//      (only on the first system turn of each thread) is covered by
//      the integration tests in `src/serve/server.test.ts` under the
//      `Sub-AC 3 of AC 6` block. To round-trip the contract here, we
//      assert (a) `buildPreamble` is itself deterministic — calling it
//      twice with the same inputs returns equal payloads — so the chat
//      handler can safely re-build the preamble on its first-turn
//      branch and trust the result, and (b) the formatted markdown
//      contains the full canonical block so the SDK only needs to
//      receive it once and the model retains it for the rest of the
//      thread via the SDK's session cache.
// ---------------------------------------------------------------------------

test('Sub-AC 4 / content correctness: every preamble carries all four canonical fields', async () => {
  // A fully-loaded fixture so each of the four fields has substantive
  // content to assert on. The existing happy-path test covers
  // value-correctness in detail; this test pins the *shape* contract:
  // every key on `ChatPreamble` is present with the expected type,
  // because downstream consumers (the floating chat panel + the
  // server preamble formatter) treat the four fields as load-bearing
  // and assume they are always defined.
  const now = new Date('2026-04-29T12:00:00.000Z');
  const planBody = [
    '## Long-term goals',
    '',
    'Stay healthy and ship.',
    '',
    '## Monthly plans',
    '',
    '### 2026-04',
    '',
    '- One clean PR a day.',
    '',
    '## Strategies',
    '',
    'Lead with tests.',
    '',
    '## Notes',
    '',
    'Be kind.',
    '',
  ].join('\n');
  const { root, agentId } = await makeFixtureProject({
    planBody,
    activity: [
      {
        id: 'log-cccc1111',
        timestamp: '2026-04-29T11:00:00.000Z',
        status: 'completed' as const,
        title: 'recent task',
        taskId: 'task-r',
      },
    ],
    usage: [
      {
        id: 'usage-cc11',
        timestamp: '2026-04-27T08:00:00.000Z',
        taskId: 'task-r',
        inputTokens: 200,
        outputTokens: 100,
        week: '2026-04-27',
      },
    ],
    weeklyTasks: [
      {
        id: 'task-cccc1',
        title: 'Outline release',
        prompt: 'Outline the release.',
        status: 'pending',
      },
    ],
    weekKey: '2026-W18',
    month: '2026-04',
    now,
  });
  try {
    const preamble = await buildPreamble({
      projectDir: root,
      slug: agentId,
      now,
    });

    // Field 1: weekly plan summary — at least one canonical section
    // surfaced; the keys are stable strings sourced from
    // `CANONICAL_SECTIONS` in `plan-markdown-store`.
    assert.equal(typeof preamble.planSections, 'object');
    assert.ok(preamble.planSections);
    assert.ok(
      Object.keys(preamble.planSections).length >= 1,
      'expected at least one canonical plan section',
    );
    assert.equal(typeof preamble.hasPlan, 'boolean');
    assert.equal(preamble.hasPlan, true);

    // Field 2: recent activity — populated array of the compact entry
    // shape (timestamp, status, title required).
    assert.ok(Array.isArray(preamble.recentActivity));
    assert.ok(preamble.recentActivity.length >= 1);
    const a = preamble.recentActivity[0]!;
    assert.equal(typeof a.timestamp, 'string');
    assert.equal(typeof a.status, 'string');
    assert.equal(typeof a.title, 'string');

    // Field 3: weekly budget snapshot — every numeric field present
    // (no `undefined` allowed, so the formatter can render without
    // null-checks).
    assert.equal(typeof preamble.budget, 'object');
    assert.equal(typeof preamble.budget.weekMonday, 'string');
    assert.equal(typeof preamble.budget.tokenLimit, 'number');
    assert.equal(typeof preamble.budget.tokensUsed, 'number');
    assert.equal(typeof preamble.budget.remaining, 'number');
    assert.equal(typeof preamble.budget.overBudget, 'boolean');
    // utilizationPct is `number | null` by design — `null` only when
    // tokenLimit is 0. Here the fixture sets a real budget.
    assert.equal(typeof preamble.budget.utilizationPct, 'number');

    // Field 4: ISO-week key — well-formed `YYYY-Www` string, matches
    // the timeZone used by the rest of the preamble.
    assert.equal(typeof preamble.weekKey, 'string');
    assert.match(preamble.weekKey, /^\d{4}-W\d{2}$/);
    assert.equal(typeof preamble.timeZone, 'string');
    assert.ok(preamble.timeZone.length > 0);

    // Bonus: every key on the public `ChatPreamble` shape is present —
    // a missing key here means a regression in the builder.
    const keys = Object.keys(preamble).sort();
    assert.deepEqual(keys, [
      'budget',
      'hasPlan',
      'planSections',
      'recentActivity',
      'slug',
      'timeZone',
      'weekKey',
      'weeklyTasks',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Sub-AC 4 / content correctness: sparse agent still emits every required field (zero / empty values)', async () => {
  // Fresh agent — no plan.md, no activity-log, no weekly plan, no
  // usage records. The preamble's "graceful degradation" contract
  // says all four canonical fields must still be present (with
  // empty / zero values) so downstream consumers can render
  // unconditionally.
  const now = new Date('2026-04-29T12:00:00.000Z');
  const { root, agentId } = await makeFixtureProject({ now });
  try {
    const preamble = await buildPreamble({
      projectDir: root,
      slug: agentId,
      now,
    });

    // 1. plan: empty object, hasPlan=false — but the *key* exists.
    assert.deepEqual(preamble.planSections, {});
    assert.equal(preamble.hasPlan, false);

    // 2. activity: empty array — but the *key* exists.
    assert.deepEqual(preamble.recentActivity, []);

    // 3. budget: zeroed but every numeric key present.
    assert.equal(preamble.budget.tokensUsed, 0);
    assert.equal(preamble.budget.remaining, 10_000);
    assert.equal(preamble.budget.overBudget, false);
    assert.equal(preamble.budget.utilizationPct, 0);

    // 4. weekKey: still derived from the configured zone (UTC fixture).
    assert.equal(preamble.weekKey, '2026-W18');
    assert.equal(preamble.timeZone, 'UTC');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Sub-AC 4 / TZ correctness: weekKey reflects the configured non-UTC time zone across a week boundary', async () => {
  // Choose an instant that straddles the ISO-week boundary in
  // America/Los_Angeles (UTC-7 during PDT) but sits cleanly inside
  // the next week in UTC:
  //
  //   UTC instant:  2026-04-27T05:00:00Z (Monday, week 2026-W18)
  //   In LA (PDT):  2026-04-26T22:00:00  (Sunday, end of 2026-W17)
  //
  // The preamble must report W17 — the local week — so the agent's
  // sense of "this week" matches the dashboard / heartbeat / aweek
  // summary, all of which honor the configured zone.
  const now = new Date('2026-04-27T05:00:00.000Z');
  const { root, agentId } = await makeFixtureProject({
    now,
    configTimeZone: 'America/Los_Angeles',
    // The activity-log file is bucketed by the *local* Monday for the
    // active zone — in LA the Monday containing 2026-04-26 (Sun) is
    // 2026-04-20. Tell the fixture to lay the file there so the
    // preamble can find it (this is also the bucket the heartbeat
    // would write to).
    fileWeekMonday: '2026-04-20',
    activity: [
      {
        // ID must match `^log-[a-f0-9]+$` per the activity-log schema.
        id: 'log-aabbccdd0001',
        timestamp: '2026-04-26T20:00:00.000Z', // Sunday afternoon in LA
        status: 'completed' as const,
        title: 'sunday wrap-up',
      },
    ],
  });
  try {
    const preamble = await buildPreamble({
      projectDir: root,
      slug: agentId,
      now,
    });
    assert.equal(preamble.timeZone, 'America/Los_Angeles');
    // The crux: the weekKey is the *local* week (W17), NOT the UTC
    // week (W18). A regression that re-introduces a UTC-default in
    // the builder would surface here as `'2026-W18'`.
    assert.equal(preamble.weekKey, '2026-W17');
    // Activity successfully read from the local-Monday bucket.
    assert.equal(preamble.recentActivity.length, 1);
    assert.equal(preamble.recentActivity[0]!.title, 'sunday wrap-up');
    // The budget weekMonday is the local Monday too (so chat and
    // dashboard never disagree about which week's spend they show).
    assert.equal(preamble.budget.weekMonday, '2026-04-20');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Sub-AC 4 / TZ correctness: weekKey honors a non-UTC zone east of UTC (Asia/Seoul)', async () => {
  // Mirror of the LA test, the other way: an instant just before
  // local midnight on a Monday in Seoul (UTC+9):
  //
  //   UTC instant:  2026-04-19T14:00:00Z (Sunday end of W16 in UTC)
  //   In Seoul:     2026-04-19T23:00:00  (still Sunday, end of W16)
  //
  //   UTC instant:  2026-04-19T15:00:00Z (Sunday end of W16 in UTC)
  //   In Seoul:     2026-04-20T00:00:00  (Monday, start of W17)
  //
  // Pick the second instant — UTC says W16, Seoul says W17. The
  // preamble must report W17.
  const now = new Date('2026-04-19T15:00:00.000Z');
  const { root, agentId } = await makeFixtureProject({
    now,
    configTimeZone: 'Asia/Seoul',
    fileWeekMonday: '2026-04-20', // local Monday in Seoul
  });
  try {
    const preamble = await buildPreamble({
      projectDir: root,
      slug: agentId,
      now,
    });
    assert.equal(preamble.timeZone, 'Asia/Seoul');
    assert.equal(preamble.weekKey, '2026-W17');
    assert.equal(preamble.budget.weekMonday, '2026-04-20');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Sub-AC 4 / TZ correctness: explicit timeZone option overrides the configured zone', async () => {
  // The builder accepts an opt-in `timeZone` override (used by tests
  // and by advanced callers that want to force a particular zone
  // without rewriting `.aweek/config.json`). The override must take
  // precedence over the on-disk config.
  const now = new Date('2026-04-27T05:00:00.000Z');
  const { root, agentId } = await makeFixtureProject({
    now,
    configTimeZone: 'UTC', // on disk: UTC
    fileWeekMonday: '2026-04-20',
  });
  try {
    const withDefault = await buildPreamble({
      projectDir: root,
      slug: agentId,
      now,
    });
    // Configured zone (UTC) wins → W18.
    assert.equal(withDefault.timeZone, 'UTC');
    assert.equal(withDefault.weekKey, '2026-W18');

    const withOverride = await buildPreamble({
      projectDir: root,
      slug: agentId,
      now,
      timeZone: 'America/Los_Angeles',
    });
    // Explicit override wins over the on-disk config → W17.
    assert.equal(withOverride.timeZone, 'America/Los_Angeles');
    assert.equal(withOverride.weekKey, '2026-W17');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Sub-AC 4 / TZ correctness: falls back to system DEFAULT_TZ when .aweek/config.json is absent', async () => {
  // Suppress the config file entirely. `loadConfig` in
  // `src/storage/config-store.ts` treats ENOENT as the canonical
  // "fresh project" case and silently returns its defaults, where
  // `timeZone` is `DEFAULT_TZ` (the system local zone, the same one
  // `aweek init` would seed into a brand-new config). The preamble
  // honors that — it never silently re-pegs to UTC behind the user's
  // back, because doing so would make chat's "this week" disagree
  // with everything else the dashboard / heartbeat / `aweek summary`
  // shows for the same agent.
  //
  // Hard-pegging to a literal zone string would be brittle in CI
  // (different machines have different system zones), so the test
  // pins the *contract*: when no config file exists and no override
  // is passed, the resolved zone equals `DEFAULT_TZ`, and the
  // weekKey is what `currentWeekKey(DEFAULT_TZ, now)` would compute.
  const now = new Date('2026-04-29T12:00:00.000Z');
  const { root, agentId } = await makeFixtureProject({
    now,
    configTimeZone: null, // skip writing .aweek/config.json
  });
  try {
    const preamble = await buildPreamble({
      projectDir: root,
      slug: agentId,
      now,
    });
    assert.equal(preamble.timeZone, DEFAULT_TZ);
    assert.equal(preamble.weekKey, currentWeekKey(DEFAULT_TZ, now));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Sub-AC 4 / TZ correctness: explicit UTC override produces UTC weekKey regardless of system zone', async () => {
  // Pinning the explicit-override behavior independently of
  // DEFAULT_TZ — the override is the canonical escape hatch for
  // tests and advanced callers that want a fully deterministic
  // weekKey.
  const now = new Date('2026-04-29T12:00:00.000Z');
  const { root, agentId } = await makeFixtureProject({
    now,
    configTimeZone: null, // no config — override must still work
  });
  try {
    const preamble = await buildPreamble({
      projectDir: root,
      slug: agentId,
      now,
      timeZone: 'UTC',
    });
    assert.equal(preamble.timeZone, 'UTC');
    assert.equal(preamble.weekKey, '2026-W18');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Sub-AC 4 / first-turn-only: buildPreamble is deterministic across re-invocations on the same inputs', async () => {
  // The chat handler in `src/serve/server.ts:handleChatStream` decides
  // whether to inject the preamble based on the thread's message
  // history (no prior assistant turn → first turn → inject). That
  // decision is exercised end-to-end in `src/serve/server.test.ts`
  // under the `Sub-AC 3 of AC 6` block.
  //
  // The contract this unit test pins is the *prerequisite* for
  // first-turn-only injection: `buildPreamble` must be deterministic
  // for a given (projectDir, slug, now) tuple, so the handler can
  // safely re-build the preamble on every "first turn" branch and
  // trust that two independent first-turn requests on identical
  // state produce identical context. Without this property the chat
  // panel could see the model's behavior diverge between threads on
  // the same day for no observable reason.
  const now = new Date('2026-04-29T12:00:00.000Z');
  const { root, agentId } = await makeFixtureProject({
    now,
    planBody: [
      '## Long-term goals',
      '',
      'Stay deterministic.',
      '',
      '## Strategies',
      '',
      'Avoid hidden state.',
      '',
    ].join('\n'),
    weeklyTasks: [
      {
        id: 'task-dddd1',
        title: 'Make idempotency observable',
        prompt: 'Make idempotency observable.',
        status: 'pending',
      },
    ],
    weekKey: '2026-W18',
    month: '2026-04',
  });
  try {
    const a = await buildPreamble({ projectDir: root, slug: agentId, now });
    const b = await buildPreamble({ projectDir: root, slug: agentId, now });
    assert.deepEqual(a, b);
    // Round-trip through the formatter — same input must yield the
    // same markdown so the SDK's session cache key stays stable.
    assert.equal(formatPreamble(a), formatPreamble(b));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Sub-AC 4 / first-turn-only: formatted preamble carries the full canonical block (single-shot suffices)', async () => {
  // The chat handler injects the preamble only on the first turn of
  // a thread — subsequent turns omit it (so token spend stays low and
  // the SDK's cache prefix survives). For that single-shot delivery
  // to be sufficient, the formatted markdown must carry every signal
  // the agent needs to orient: the context-block header, the budget
  // snapshot, the plan summary, the weekly tasks, and the recent
  // activity. If any of these were elided the model would lose
  // situational awareness from turn 2 onward and the preamble's whole
  // purpose would be defeated.
  const now = new Date('2026-04-29T12:00:00.000Z');
  const { root, agentId } = await makeFixtureProject({
    now,
    planBody: [
      '## Long-term goals',
      '',
      'Sustain weekly pace.',
      '',
      '## Strategies',
      '',
      'Atomic commits.',
      '',
    ].join('\n'),
    activity: [
      {
        id: 'log-eeee1111',
        timestamp: '2026-04-29T08:00:00.000Z',
        status: 'completed' as const,
        title: 'wrote preamble tests',
      },
    ],
    weeklyTasks: [
      {
        id: 'task-eeee1',
        title: 'Cover preamble in tests',
        prompt: 'Cover preamble in tests.',
        status: 'in-progress',
      },
    ],
    weekKey: '2026-W18',
    month: '2026-04',
  });
  try {
    const preamble = await buildPreamble({
      projectDir: root,
      slug: agentId,
      now,
    });
    const md = formatPreamble(preamble);

    // Every canonical signal surfaces in the single-shot markdown.
    assert.match(
      md,
      new RegExp(`Context for agent "${agentId}"`),
      'header must identify the agent',
    );
    assert.match(
      md,
      /Current week: \*\*2026-W18\*\*/,
      'weekKey must appear in the rendered markdown',
    );
    assert.match(md, /## Weekly budget/, 'budget block must be present');
    assert.match(md, /## Plan summary/, 'plan summary must be present');
    assert.match(
      md,
      /### Long-term goals/,
      'long-term goals section must be present',
    );
    assert.match(
      md,
      /This week's tasks \(2026-W18\)/,
      'weekly tasks section must be present',
    );
    assert.match(md, /Recent activity/, 'recent-activity block must be present');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
