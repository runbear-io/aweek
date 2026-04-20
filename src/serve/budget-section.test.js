/**
 * Tests for `src/serve/budget-section.js`.
 *
 * Scope (AC 5): the budget card surfaces per-agent weekly token budget vs
 * usage with over-budget highlighting so the operator can spot pressure at
 * a glance. Tests cover:
 *
 *   - `deriveBudget`        — pure math (limit precedence, over-budget
 *                             detection, utilization, remaining).
 *   - `renderBudgetSection` — HTML fragment shape: empty state,
 *                             over-budget class + tag, progress bar
 *                             clamping, HTML escaping.
 *   - `gatherBudget`        — end-to-end filesystem read with sort order
 *                             (over-budget first, then high-util desc).
 *   - GET /                  — the dashboard shell actually embeds the
 *                             rendered budget fragment and the CSS.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';

import {
  budgetSectionStyles,
  deriveBudget,
  formatTokens,
  gatherBudget,
  renderBudgetSection,
} from './budget-section.js';
import { startServer } from './server.js';

/**
 * Seed a project directory with the `.aweek/agents/` and `.claude/agents/`
 * folders so the gathers + identity reads work out of the box.
 */
async function makeProject(prefix = 'aweek-budget-') {
  const projectDir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(projectDir, '.aweek', 'agents'), { recursive: true });
  await mkdir(join(projectDir, '.claude', 'agents'), { recursive: true });
  return projectDir;
}

/** Minimal valid agent JSON matching `aweek://schemas/agent-config`. */
async function writeAgent(
  projectDir,
  slug,
  { paused = false, weeklyTokenLimit = 100_000, currentUsage = 0 } = {},
) {
  const now = '2026-04-13T00:00:00.000Z';
  const config = {
    id: slug,
    subagentRef: slug,
    goals: [],
    monthlyPlans: [],
    weeklyTokenBudget: weeklyTokenLimit,
    budget: {
      weeklyTokenLimit,
      currentUsage,
      periodStart: now,
      paused,
      sessions: [],
    },
    inbox: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(
    join(projectDir, '.aweek', 'agents', `${slug}.json`),
    JSON.stringify(config, null, 2) + '\n',
    'utf8',
  );
}

/** Minimal subagent .md with name / description frontmatter. */
async function writeSubagent(projectDir, slug, { name, description } = {}) {
  const content = [
    '---',
    `name: ${name || slug}`,
    `description: "${(description || '').replace(/"/g, '\\"')}"`,
    '---',
    '',
    'Body',
    '',
  ].join('\n');
  await writeFile(
    join(projectDir, '.claude', 'agents', `${slug}.md`),
    content,
    'utf8',
  );
}

/**
 * Write a usage log for the given week with a total token count so
 * `UsageStore.weeklyTotal` returns known aggregates.
 */
async function writeUsage(projectDir, slug, { weekMonday, totalTokens }) {
  const dir = join(projectDir, '.aweek', 'agents', slug, 'usage');
  await mkdir(dir, { recursive: true });
  const hex = Buffer.from(slug).toString('hex').slice(0, 8).padEnd(8, '0');
  const record = {
    id: `usage-${hex}`,
    timestamp: `${weekMonday}T12:00:00.000Z`,
    agentId: slug,
    taskId: `task-${hex}`,
    inputTokens: Math.floor(totalTokens / 2),
    outputTokens: Math.ceil(totalTokens / 2),
    totalTokens,
    week: weekMonday,
  };
  await writeFile(dir + `/${weekMonday}.json`, JSON.stringify([record], null, 2) + '\n');
}

/** Monday of the current week (UTC) — matches `getMondayDate` default. */
function utcMondayOfThisWeek() {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// ───────────────────────────────────────────────────────────────────────
// deriveBudget — pure math
// ───────────────────────────────────────────────────────────────────────

describe('deriveBudget()', () => {
  it('computes tokens used, remaining, and utilization under budget', () => {
    const out = deriveBudget(
      { weeklyTokenBudget: 1000 },
      { totalTokens: 250 },
    );
    assert.equal(out.tokenLimit, 1000);
    assert.equal(out.tokensUsed, 250);
    assert.equal(out.remaining, 750);
    assert.equal(out.overBudget, false);
    assert.equal(out.utilizationPct, 25);
  });

  it('flags over-budget when usage meets the limit exactly', () => {
    const out = deriveBudget(
      { weeklyTokenBudget: 1000 },
      { totalTokens: 1000 },
    );
    assert.equal(out.overBudget, true);
    assert.equal(out.remaining, 0);
    assert.equal(out.utilizationPct, 100);
  });

  it('flags over-budget when usage exceeds the limit and clamps remaining', () => {
    const out = deriveBudget(
      { weeklyTokenBudget: 1000 },
      { totalTokens: 1500 },
    );
    assert.equal(out.overBudget, true);
    assert.equal(out.remaining, 0); // never negative
    assert.equal(out.utilizationPct, 150);
  });

  it('prefers weeklyTokenBudget over budget.weeklyTokenLimit', () => {
    const out = deriveBudget(
      { weeklyTokenBudget: 2000, budget: { weeklyTokenLimit: 500 } },
      { totalTokens: 750 },
    );
    assert.equal(out.tokenLimit, 2000);
    assert.equal(out.overBudget, false);
    assert.equal(out.utilizationPct, 38); // rounded to nearest int
  });

  it('falls back to budget.weeklyTokenLimit when weeklyTokenBudget missing', () => {
    const out = deriveBudget(
      { budget: { weeklyTokenLimit: 500 } },
      { totalTokens: 100 },
    );
    assert.equal(out.tokenLimit, 500);
    assert.equal(out.utilizationPct, 20);
  });

  it('reports null utilization and zero remaining when no budget is set', () => {
    const out = deriveBudget({}, { totalTokens: 1234 });
    assert.equal(out.tokenLimit, 0);
    assert.equal(out.tokensUsed, 1234);
    assert.equal(out.remaining, 0);
    assert.equal(out.overBudget, false);
    assert.equal(out.utilizationPct, null);
  });

  it('tolerates missing config or usage objects', () => {
    assert.deepEqual(deriveBudget(undefined, undefined), {
      tokenLimit: 0,
      tokensUsed: 0,
      remaining: 0,
      overBudget: false,
      utilizationPct: null,
    });
  });
});

// ───────────────────────────────────────────────────────────────────────
// formatTokens / budgetSectionStyles
// ───────────────────────────────────────────────────────────────────────

describe('formatTokens()', () => {
  it('renders compact tokens for common magnitudes', () => {
    assert.equal(formatTokens(0), '0');
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1_000), '1.0k');
    assert.equal(formatTokens(12_345), '12k');
    assert.equal(formatTokens(1_500_000), '1.5M');
  });
});

describe('budgetSectionStyles()', () => {
  it('includes the over-budget highlight selectors used by the renderer', () => {
    const css = budgetSectionStyles();
    assert.match(css, /\.budget-row\.over-budget/);
    assert.match(css, /\.budget-usage\.over-budget/);
    assert.match(css, /\.budget-bar\.over-budget/);
    assert.match(css, /\.budget-tag/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderBudgetSection — HTML fragment shape
// ───────────────────────────────────────────────────────────────────────

describe('renderBudgetSection()', () => {
  it('renders an empty state when no rows exist', () => {
    const html = renderBudgetSection([]);
    assert.match(html, /empty-state/);
    assert.match(html, /\/aweek:hire/);
  });

  it('renders one li per row with usage numbers and progress bar', () => {
    const html = renderBudgetSection([
      {
        slug: 'writer',
        name: 'Writer',
        missing: false,
        tokenLimit: 100_000,
        tokensUsed: 25_000,
        remaining: 75_000,
        overBudget: false,
        utilizationPct: 25,
        weekMonday: '2026-04-20',
      },
      {
        slug: 'analyst',
        name: 'Analyst',
        missing: false,
        tokenLimit: 50_000,
        tokensUsed: 45_000,
        remaining: 5_000,
        overBudget: false,
        utilizationPct: 90,
        weekMonday: '2026-04-20',
      },
    ]);
    const items = (html.match(/<li /g) || []).length;
    assert.equal(items, 2);
    // Week label appears exactly once
    assert.match(html, /Week of <time/);
    assert.match(html, /2026-04-20/);
    // Progress bars
    assert.match(html, /role="progressbar"/);
    // Tokens are present in compact form
    assert.match(html, /25k/); // 25_000 tokens used
    assert.match(html, /100k/); // 100_000 tokens limit
    // No over-budget tag
    assert.ok(!html.includes('OVER BUDGET'));
    // No over-budget row class
    assert.ok(!/class="budget-row over-budget"/.test(html));
  });

  it('highlights over-budget rows with class + tag + exceeded-by line', () => {
    const html = renderBudgetSection([
      {
        slug: 'scribe',
        name: 'Scribe',
        missing: false,
        tokenLimit: 1_000,
        tokensUsed: 1_500,
        remaining: 0,
        overBudget: true,
        utilizationPct: 150,
        weekMonday: '2026-04-20',
      },
    ]);
    assert.match(html, /class="budget-row over-budget"/);
    assert.match(html, /class="budget-usage over-budget"/);
    assert.match(html, /OVER BUDGET/);
    assert.match(html, /exceeded by/);
    assert.match(html, /class="budget-bar over-budget"/);
    // aria-valuenow keeps the raw (>100) number even though the fill is clamped
    assert.match(html, /aria-valuenow="150"/);
    // The inline width style must be clamped to 100% so the bar does not overflow
    assert.match(html, /width:100%/);
  });

  it('renders the "no weekly budget" fallback when tokenLimit is zero', () => {
    const html = renderBudgetSection([
      {
        slug: 'free',
        name: 'Free',
        missing: false,
        tokenLimit: 0,
        tokensUsed: 1_234,
        remaining: 0,
        overBudget: false,
        utilizationPct: null,
        weekMonday: '2026-04-20',
      },
    ]);
    assert.match(html, /no weekly budget/);
    // No progressbar is rendered when there is no limit
    assert.ok(!html.includes('role="progressbar"'));
    // Used tokens still surfaced so the card is informative
    assert.match(html, /1\.2k tokens used/);
  });

  it('marks missing subagents with a [subagent missing] marker', () => {
    const html = renderBudgetSection([
      {
        slug: 'ghost',
        name: 'ghost',
        missing: true,
        tokenLimit: 100,
        tokensUsed: 50,
        remaining: 50,
        overBudget: false,
        utilizationPct: 50,
        weekMonday: '2026-04-20',
      },
    ]);
    assert.match(html, /\[subagent missing\]/);
  });

  it('HTML-escapes name and slug', () => {
    const html = renderBudgetSection([
      {
        slug: 'evil',
        name: '<script>alert(1)</script>',
        missing: false,
        tokenLimit: 100,
        tokensUsed: 10,
        remaining: 90,
        overBudget: false,
        utilizationPct: 10,
        weekMonday: '2026-04-20',
      },
    ]);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// gatherBudget — end-to-end from the filesystem
// ───────────────────────────────────────────────────────────────────────

describe('gatherBudget()', () => {
  let projectDir;
  beforeEach(async () => {
    projectDir = await makeProject();
  });
  afterEach(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('returns [] when no agents exist', async () => {
    const rows = await gatherBudget({ projectDir });
    assert.deepEqual(rows, []);
  });

  it('throws when projectDir is missing', async () => {
    await assert.rejects(() => gatherBudget({}), /projectDir is required/);
  });

  it('aggregates each agent and sorts over-budget first, then util desc', async () => {
    // aaa: exhausted (50% of limit, but actually over — 1500 / 1000)
    await writeAgent(projectDir, 'aaa-exhausted', { weeklyTokenLimit: 1_000 });
    // bbb: 90% used
    await writeAgent(projectDir, 'bbb-high', { weeklyTokenLimit: 10_000 });
    // ccc: 10% used
    await writeAgent(projectDir, 'ccc-low', { weeklyTokenLimit: 10_000 });

    await writeSubagent(projectDir, 'aaa-exhausted', { name: 'AAA' });
    await writeSubagent(projectDir, 'bbb-high', { name: 'BBB' });
    await writeSubagent(projectDir, 'ccc-low', { name: 'CCC' });

    const monday = utcMondayOfThisWeek();
    await writeUsage(projectDir, 'aaa-exhausted', {
      weekMonday: monday,
      totalTokens: 1_500,
    });
    await writeUsage(projectDir, 'bbb-high', {
      weekMonday: monday,
      totalTokens: 9_000,
    });
    await writeUsage(projectDir, 'ccc-low', {
      weekMonday: monday,
      totalTokens: 1_000,
    });

    const rows = await gatherBudget({ projectDir });
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => [r.slug, r.overBudget, r.utilizationPct]),
      [
        ['aaa-exhausted', true, 150],
        ['bbb-high', false, 90],
        ['ccc-low', false, 10],
      ],
    );
    // Name is read from the subagent .md when present
    assert.equal(rows[0].name, 'AAA');
    assert.equal(rows[0].tokensUsed, 1_500);
    assert.equal(rows[0].tokenLimit, 1_000);
    // weekMonday passes through
    assert.equal(rows[0].weekMonday, monday);
  });

  it('degrades gracefully when a subagent .md is missing', async () => {
    await writeAgent(projectDir, 'orphan', { weeklyTokenLimit: 100 });
    // no writeSubagent
    const rows = await gatherBudget({ projectDir });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].missing, true);
    assert.equal(rows[0].name, 'orphan');
  });

  it('returns 0 usage when an agent has no usage log yet', async () => {
    await writeAgent(projectDir, 'fresh', { weeklyTokenLimit: 1_000 });
    await writeSubagent(projectDir, 'fresh', { name: 'Fresh' });
    const rows = await gatherBudget({ projectDir });
    assert.equal(rows[0].tokensUsed, 0);
    assert.equal(rows[0].remaining, 1_000);
    assert.equal(rows[0].overBudget, false);
    assert.equal(rows[0].utilizationPct, 0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// End-to-end: GET / renders budget rows
// ───────────────────────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url);
    const req = httpRequest(
      {
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolvePromise({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

describe('GET / with budget data', () => {
  let projectDir;
  let handle;

  beforeEach(async () => {
    projectDir = await makeProject();
    handle = null;
  });
  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('renders an empty budget state when no agents are hired', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(handle.url);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-section="budget"/);
    // Empty state should appear in the budget card (agents card also has one,
    // so just verify both are reachable and the CSS made it in).
    assert.match(res.body, /\.budget-bar/);
  });

  it('renders budget rows with over-budget highlighting end-to-end', async () => {
    await writeAgent(projectDir, 'writer', { weeklyTokenLimit: 100_000 });
    await writeAgent(projectDir, 'scribe', { weeklyTokenLimit: 1_000 });
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });
    await writeSubagent(projectDir, 'scribe', { name: 'Scribe' });

    const monday = utcMondayOfThisWeek();
    await writeUsage(projectDir, 'writer', {
      weekMonday: monday,
      totalTokens: 10_000,
    });
    await writeUsage(projectDir, 'scribe', {
      weekMonday: monday,
      totalTokens: 2_500,
    });

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(handle.url);
    assert.equal(res.statusCode, 200);
    const body = res.body;

    // Budget section is populated (not the fallback placeholder)
    assert.match(body, /data-section="budget"/);
    assert.ok(!/data-section="budget">[\s\S]*will appear here/.test(body));

    // Both agents surfaced by slug
    assert.match(body, /budget-slug">writer<\/code>/);
    assert.match(body, /budget-slug">scribe<\/code>/);

    // Over-budget highlight kicks in for scribe (2500 / 1000)
    assert.match(body, /data-agent-slug="scribe"[^>]*data-over-budget="1"/);
    assert.match(body, /OVER BUDGET/);
    // Writer is under budget — no over-budget row class on its row
    assert.match(body, /data-agent-slug="writer"[^>]*data-over-budget="0"/);

    // The budget CSS is embedded in the shell
    assert.match(body, /\.budget-bar\.over-budget/);
  });

  it('re-reads .aweek/ on every request (live data)', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });

    // First request — no agents yet
    let res = await httpGet(handle.url);
    assert.match(res.body, /data-section="budget"/);

    // Add an agent with usage; no restart
    await writeAgent(projectDir, 'late', { weeklyTokenLimit: 100 });
    await writeSubagent(projectDir, 'late', { name: 'Late' });
    await writeUsage(projectDir, 'late', {
      weekMonday: utcMondayOfThisWeek(),
      totalTokens: 500, // over budget
    });

    // Second request — data appears
    res = await httpGet(handle.url);
    assert.match(res.body, /budget-slug">late<\/code>/);
    assert.match(res.body, /OVER BUDGET/);
  });
});
