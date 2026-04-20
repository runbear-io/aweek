/**
 * Tests for `src/serve/agents-section.js`.
 *
 * Scope: this module is the **data layer** for the agents sidebar.  The
 * refactored dashboard uses an agent-picker sidebar (rendered by
 * `sidebar-section.js`) with per-agent horizontal tab navigation
 * (Calendar / Activity / Strategy / Profile).  `agents-section.js` provides
 * the shared infrastructure that both old and new surfaces depend on:
 *
 *   - `deriveAgentStatus()`     — pure tri-state derivation from live config
 *   - `agentStatusLabel()`      — human-readable badge text
 *   - `formatTokens()`          — compact token formatter
 *   - `agentsSectionStyles()`   — CSS fragment (status-* classes used globally)
 *   - `gatherAgents()`          — data gatherer consumed by the sidebar renderer
 *   - `renderAgentsSection()`   — LEGACY card-based renderer (no longer mounted
 *                                 in the dashboard shell; replaced by
 *                                 `renderSidebar` from sidebar-section.js).
 *                                 Tests are kept for API-stability documentation.
 *
 * HTTP integration tests cover the full request → render pipeline and assert on
 * the new sidebar + tab bar structure rather than the old 2×2 card grid.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';

import {
  agentStatusLabel,
  agentsSectionStyles,
  deriveAgentStatus,
  formatTokens,
  gatherAgents,
  renderAgentsSection,
} from './agents-section.js';
import { startServer } from './server.js';

/**
 * Seed a project directory with `.aweek/agents/` structure and return the
 * project root. The returned dir is a fresh tmpdir — callers clean it up.
 */
async function makeProject(prefix = 'aweek-agents-') {
  const projectDir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(projectDir, '.aweek', 'agents'), { recursive: true });
  await mkdir(join(projectDir, '.claude', 'agents'), { recursive: true });
  return projectDir;
}

/**
 * Write a minimal valid agent JSON to `.aweek/agents/<slug>.json`. The
 * config matches `aweek://schemas/agent-config` — if the schema changes
 * this helper must be updated alongside it.
 */
async function writeAgent(
  projectDir,
  slug,
  {
    paused = false,
    weeklyTokenLimit = 100_000,
    currentUsage = 0,
  } = {},
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

/**
 * Write a minimal subagent .md file with frontmatter so
 * `readSubagentIdentity` finds a name + description.
 */
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
 * Write a usage-log file for an agent so `UsageStore.weeklyTotal` returns
 * a known token count for the current week's Monday key.
 */
async function writeUsage(projectDir, slug, { weekMonday, totalTokens }) {
  const dir = join(projectDir, '.aweek', 'agents', slug, 'usage');
  await mkdir(dir, { recursive: true });
  // Record id must match `^usage-[a-f0-9]+$` per the usage-record schema —
  // use a deterministic hex suffix derived from the slug so the fixture
  // is stable across test runs.
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

/**
 * Monday of the current week (UTC) — matches the default `getMondayDate`
 * behaviour when no timezone is configured.
 */
function utcMondayOfThisWeek() {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// ───────────────────────────────────────────────────────────────────────
// Pure helpers — status derivation, label, formatters
// ───────────────────────────────────────────────────────────────────────

describe('deriveAgentStatus()', () => {
  it('returns "active" when not paused', () => {
    const config = { budget: { paused: false, weeklyTokenLimit: 1000 } };
    assert.equal(deriveAgentStatus(config, { totalTokens: 500 }), 'active');
  });

  it('returns "paused" when paused but under budget', () => {
    const config = { budget: { paused: true, weeklyTokenLimit: 1000 } };
    assert.equal(deriveAgentStatus(config, { totalTokens: 500 }), 'paused');
  });

  it('returns "budget-exhausted" when paused and usage >= limit', () => {
    const config = { budget: { paused: true, weeklyTokenLimit: 1000 } };
    assert.equal(deriveAgentStatus(config, { totalTokens: 1000 }), 'budget-exhausted');
    assert.equal(deriveAgentStatus(config, { totalTokens: 1200 }), 'budget-exhausted');
  });

  it('prefers weeklyTokenBudget over budget.weeklyTokenLimit', () => {
    const config = {
      weeklyTokenBudget: 2000,
      budget: { paused: true, weeklyTokenLimit: 500 },
    };
    // With the higher (2000) limit and 1000 used, this is not exhausted
    assert.equal(deriveAgentStatus(config, { totalTokens: 1000 }), 'paused');
    // And with 2000 used, it is exhausted
    assert.equal(deriveAgentStatus(config, { totalTokens: 2000 }), 'budget-exhausted');
  });

  it('returns "active" when not paused even if over budget (enforcer not run yet)', () => {
    // The enforcer flips `paused` when over budget; if the flag is still
    // false we treat the agent as active even though usage is over — this
    // is the "drifting" state between heartbeats and is expected.
    const config = { budget: { paused: false, weeklyTokenLimit: 1000 } };
    assert.equal(deriveAgentStatus(config, { totalTokens: 1500 }), 'active');
  });

  it('tolerates missing fields (no config, no usage)', () => {
    assert.equal(deriveAgentStatus(undefined, undefined), 'active');
    assert.equal(deriveAgentStatus({}, {}), 'active');
    assert.equal(deriveAgentStatus({ budget: {} }, {}), 'active');
  });
});

describe('agentStatusLabel()', () => {
  it('maps canonical statuses to readable labels', () => {
    assert.equal(agentStatusLabel('active'), 'ACTIVE');
    assert.equal(agentStatusLabel('paused'), 'PAUSED');
    assert.equal(agentStatusLabel('budget-exhausted'), 'BUDGET EXHAUSTED');
  });

  it('uppercases unknown statuses as a fallback', () => {
    assert.equal(agentStatusLabel('running'), 'RUNNING');
    assert.equal(agentStatusLabel(''), 'UNKNOWN');
    assert.equal(agentStatusLabel(null), 'UNKNOWN');
  });
});

describe('formatTokens()', () => {
  it('renders compact tokens for common magnitudes', () => {
    assert.equal(formatTokens(0), '0');
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1_000), '1.0k');
    assert.equal(formatTokens(12_345), '12k');
    assert.equal(formatTokens(1_500_000), '1.5M');
  });
});

describe('agentsSectionStyles()', () => {
  it('includes the status-* class selectors used by the renderer', () => {
    const css = agentsSectionStyles();
    assert.match(css, /\.agent-status\.status-active/);
    assert.match(css, /\.agent-status\.status-paused/);
    assert.match(css, /\.agent-status\.status-budget-exhausted/);
    assert.match(css, /\.agent-usage\.over-budget/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderAgentsSection — HTML fragment shape (LEGACY card-based renderer)
//
// NOTE: `renderAgentsSection` is no longer mounted in the live dashboard
// shell.  The sidebar-section.js `renderSidebar` function replaced it in
// the agent-picker sidebar layout.  These tests are kept as regression
// coverage for the function's API contract — the function still ships in
// agents-section.js and callers (e.g. email reports, custom scripts) may
// consume it outside the dashboard.  The sidebar-section.test.js file
// covers the new rendering path.
// ───────────────────────────────────────────────────────────────────────

describe('renderAgentsSection() [legacy renderer]', () => {
  it('renders an empty state when no agents exist', () => {
    const html = renderAgentsSection([]);
    assert.match(html, /empty-state/);
    assert.match(html, /\/aweek:hire/);
  });

  it('renders one li per agent with status badge + slug', () => {
    const html = renderAgentsSection([
      {
        slug: 'writer',
        name: 'Writer',
        description: 'Long-form writing',
        missing: false,
        status: 'active',
        tokensUsed: 10_000,
        tokenLimit: 100_000,
        utilizationPct: 10,
      },
      {
        slug: 'analyst',
        name: 'Analyst',
        description: '',
        missing: false,
        status: 'paused',
        tokensUsed: 50_000,
        tokenLimit: 100_000,
        utilizationPct: 50,
      },
      {
        slug: 'scribe',
        name: 'Scribe',
        description: '',
        missing: false,
        status: 'budget-exhausted',
        tokensUsed: 200_000,
        tokenLimit: 100_000,
        utilizationPct: 200,
      },
    ]);
    // One li per agent
    const items = (html.match(/<li /g) || []).length;
    assert.equal(items, 3);
    // Status classes present
    assert.match(html, /status-active[\s\S]*ACTIVE/);
    assert.match(html, /status-paused[\s\S]*PAUSED/);
    assert.match(html, /status-budget-exhausted[\s\S]*BUDGET EXHAUSTED/);
    // Slugs surfaced as <code>
    assert.match(html, /<code>writer<\/code>/);
    assert.match(html, /<code>analyst<\/code>/);
    assert.match(html, /<code>scribe<\/code>/);
    // Over-budget row gets the highlight class
    assert.match(html, /class="agent-usage over-budget"/);
  });

  it('marks missing subagents with a [subagent missing] marker', () => {
    const html = renderAgentsSection([
      {
        slug: 'ghost',
        name: 'ghost',
        description: '',
        missing: true,
        status: 'active',
        tokensUsed: 0,
        tokenLimit: 0,
        utilizationPct: null,
      },
    ]);
    assert.match(html, /\[subagent missing\]/);
    assert.match(html, /no weekly budget/);
  });

  it('HTML-escapes name and description', () => {
    const html = renderAgentsSection([
      {
        slug: 'evil',
        name: '<script>alert(1)</script>',
        description: 'desc with <b>html</b>',
        missing: false,
        status: 'active',
        tokensUsed: 0,
        tokenLimit: 0,
        utilizationPct: null,
      },
    ]);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('<b>html</b>'));
    assert.match(html, /&lt;script&gt;/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// gatherAgents — end-to-end from the filesystem
// ───────────────────────────────────────────────────────────────────────

describe('gatherAgents()', () => {
  let projectDir;
  beforeEach(async () => {
    projectDir = await makeProject();
  });
  afterEach(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('returns [] when no agents exist', async () => {
    const rows = await gatherAgents({ projectDir });
    assert.deepEqual(rows, []);
  });

  it('returns one row per agent and sorts active → paused → budget-exhausted', async () => {
    await writeAgent(projectDir, 'aaa-paused', {
      paused: true,
      weeklyTokenLimit: 10_000,
    });
    await writeAgent(projectDir, 'bbb-exhausted', {
      paused: true,
      weeklyTokenLimit: 1_000,
    });
    await writeAgent(projectDir, 'ccc-active', {
      paused: false,
      weeklyTokenLimit: 100_000,
    });

    await writeSubagent(projectDir, 'aaa-paused', { name: 'Alpha' });
    await writeSubagent(projectDir, 'bbb-exhausted', { name: 'Bravo' });
    await writeSubagent(projectDir, 'ccc-active', { name: 'Charlie' });

    // Push 'bbb-exhausted' over its 1_000 limit for the current week
    await writeUsage(projectDir, 'bbb-exhausted', {
      weekMonday: utcMondayOfThisWeek(),
      totalTokens: 1_500,
    });

    const rows = await gatherAgents({ projectDir });
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => [r.slug, r.status]),
      [
        ['ccc-active', 'active'],
        ['aaa-paused', 'paused'],
        ['bbb-exhausted', 'budget-exhausted'],
      ],
    );
    // Live identity propagates
    assert.equal(rows[0].name, 'Charlie');
  });

  it('falls back to slug + missing marker when subagent .md is absent', async () => {
    await writeAgent(projectDir, 'orphan', {});
    // no writeSubagent — .md intentionally missing
    const rows = await gatherAgents({ projectDir });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slug, 'orphan');
    assert.equal(rows[0].name, 'orphan');
    assert.equal(rows[0].missing, true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// End-to-end: GET / renders agent rows
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

describe('GET / with agents data', () => {
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

  it('renders an empty-state when no agents are hired', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(handle.url);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-section="agents"/);
    assert.match(res.body, /No agents yet/);
  });

  it('renders every agent row with the right status badge', async () => {
    await writeAgent(projectDir, 'writer', { paused: false });
    await writeAgent(projectDir, 'analyst', { paused: true, weeklyTokenLimit: 100 });
    await writeAgent(projectDir, 'scribe', { paused: true, weeklyTokenLimit: 100 });
    await writeSubagent(projectDir, 'writer', {
      name: 'Writer',
      description: 'Writes essays',
    });
    await writeSubagent(projectDir, 'analyst', {
      name: 'Analyst',
      description: 'Runs numbers',
    });
    await writeSubagent(projectDir, 'scribe', { name: 'Scribe' });
    // Exhaust scribe
    await writeUsage(projectDir, 'scribe', {
      weekMonday: utcMondayOfThisWeek(),
      totalTokens: 500,
    });

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(handle.url);
    assert.equal(res.statusCode, 200);
    const body = res.body;

    // All three slugs visible
    assert.match(body, /<code>writer<\/code>/);
    assert.match(body, /<code>analyst<\/code>/);
    assert.match(body, /<code>scribe<\/code>/);
    // Display names propagate
    assert.match(body, /Writer/);
    assert.match(body, /Analyst/);
    assert.match(body, /Scribe/);
    // Status chips — sidebar uses sidebar-chip-* classes with lowercase labels
    assert.match(body, /sidebar-chip-active[\s\S]*active/i);
    assert.match(body, /sidebar-chip-paused[\s\S]*paused/i);
    assert.match(body, /sidebar-chip-budget-exhausted[\s\S]*exhausted/i);
    // The sidebar nav carries data-section="agents" for test-locatability
    assert.match(body, /data-section="agents"/);
  });

  it('re-reads .aweek/ on every request (live data)', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });

    // First request: empty
    let res = await httpGet(handle.url);
    assert.match(res.body, /No agents yet/);

    // Add an agent; no restart
    await writeAgent(projectDir, 'late-arrival', {});
    await writeSubagent(projectDir, 'late-arrival', { name: 'Late Arrival' });

    // Second request: agent appears in sidebar
    res = await httpGet(handle.url);
    assert.match(res.body, /<code>late-arrival<\/code>/);
    assert.match(res.body, /Late Arrival/);
  });

  // ─── Tab bar integration ───────────────────────────────────────────
  // These tests cover the per-agent horizontal tab bar introduced with
  // the agent-picker sidebar refactor.  The tab bar (Calendar / Activity /
  // Strategy / Profile) only renders when a specific agent is selected via
  // the `?agent=<slug>` query param; the root URL with no selection should
  // produce no tab bar at all.

  it('renders no tab bar when no agent is selected', async () => {
    await writeAgent(projectDir, 'writer', { paused: false });
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(handle.url); // no ?agent= param
    assert.equal(res.statusCode, 200);
    // The tab-bar element must not be present when no agent is selected
    assert.ok(!res.body.includes('data-agent-tabs'), 'tab bar must be absent when no agent selected');
    assert.ok(!res.body.includes('class="tab-bar"'), 'tab-bar class must be absent');
  });

  it('renders the tab bar with all four tabs when ?agent=<slug> is set', async () => {
    await writeAgent(projectDir, 'writer', { paused: false });
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer`);
    assert.equal(res.statusCode, 200);
    const body = res.body;

    // Tab bar container present with the selected agent slug
    assert.match(body, /data-agent-tabs="writer"/);
    // All four tab IDs present
    assert.match(body, /data-tab="calendar"/);
    assert.match(body, /data-tab="activity"/);
    assert.match(body, /data-tab="strategy"/);
    assert.match(body, /data-tab="profile"/);
    // All four tab labels present
    assert.match(body, /Calendar/);
    assert.match(body, /Activity/);
    assert.match(body, /Strategy/);
    assert.match(body, /Profile/);
  });

  it('defaults to calendar tab when ?tab= is absent', async () => {
    await writeAgent(projectDir, 'writer', { paused: false });
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer`);
    assert.equal(res.statusCode, 200);
    const body = res.body;

    // Calendar tab-link should be active (rendered as <span aria-current="page">)
    assert.match(body, /tab-link-active[\s\S]*?Calendar/);
    // Other tabs are links (not spans with aria-current).
    // Note: & in href attributes is HTML-escaped to &amp; by the renderer.
    assert.match(body, /href="[^"]*tab=activity"/);
    assert.match(body, /href="[^"]*tab=strategy"/);
    assert.match(body, /href="[^"]*tab=profile"/);
  });

  it('activates the tab matching ?tab= query param', async () => {
    await writeAgent(projectDir, 'writer', { paused: false });
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=strategy`);
    assert.equal(res.statusCode, 200);
    const body = res.body;

    // Strategy tab should be the active one
    assert.match(body, /tab-link-active[\s\S]*?Strategy/);
    // Calendar tab should be a link, not active
    assert.match(body, /href="[^"]*tab=calendar"/);
  });

  it('falls back to calendar tab for unrecognised ?tab= values', async () => {
    await writeAgent(projectDir, 'writer', { paused: false });
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=nonexistent`);
    assert.equal(res.statusCode, 200);
    // Calendar should still be the active tab
    assert.match(res.body, /tab-link-active[\s\S]*?Calendar/);
  });

  it('highlights the selected agent in the sidebar with sidebar-item-selected', async () => {
    await writeAgent(projectDir, 'writer', { paused: false });
    await writeAgent(projectDir, 'analyst', { paused: false });
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });
    await writeSubagent(projectDir, 'analyst', { name: 'Analyst' });

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer`);
    assert.equal(res.statusCode, 200);
    const body = res.body;

    // writer should be selected (sidebar-item-selected carries the agent slug)
    assert.match(body, /sidebar-item-selected/);
    assert.match(body, /data-agent-slug="writer"/);
    // analyst should be a link (not selected)
    assert.match(body, /href="\?agent=analyst"/);
  });

  it('tab bar links include the current agent slug', async () => {
    await writeAgent(projectDir, 'analyst', { paused: false });
    await writeSubagent(projectDir, 'analyst', { name: 'Analyst' });

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=analyst`);
    assert.equal(res.statusCode, 200);
    // Inactive tab links carry ?agent=analyst&tab=<id>.
    // The & is HTML-escaped to &amp; in the href attribute value.
    assert.match(res.body, /href="\?agent=analyst&amp;tab=activity"/);
    assert.match(res.body, /href="\?agent=analyst&amp;tab=strategy"/);
    assert.match(res.body, /href="\?agent=analyst&amp;tab=profile"/);
  });
});
