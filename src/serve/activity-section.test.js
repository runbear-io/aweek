/**
 * Tests for `src/serve/activity-section.js`.
 *
 * Covers:
 *   - gatherActivity(): filesystem-backed data gathering for the Activity tab
 *   - renderActivitySection(): pure HTML rendering from a view object
 *   - activitySectionStyles(): CSS bundle injected into the dashboard shell
 *
 * Filesystem tests use a real tmpdir so the activity-log store's file
 * layout is exercised end-to-end, matching the pattern used by
 * plan-section.test.js and calendar-section.test.js.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  gatherActivity,
  renderActivitySection,
  activitySectionStyles,
  resolveDateRange,
  computeDateRangeBounds,
  DATE_RANGE_PRESETS,
  DEFAULT_DATE_RANGE,
} from './activity-section.js';

// ───────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────

/**
 * Create a minimal project directory with a `.aweek/agents/` tree.
 */
async function makeProject(prefix = 'aweek-activity-') {
  const projectDir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(projectDir, '.aweek', 'agents'), { recursive: true });
  return projectDir;
}

/**
 * Write a minimal agent config JSON so `listAllAgents` finds the slug.
 */
async function writeAgent(projectDir, slug) {
  const now = '2026-04-13T00:00:00.000Z';
  const config = {
    id: slug,
    subagentRef: slug,
    goals: [],
    monthlyPlans: [],
    weeklyTokenBudget: 100_000,
    budget: {
      weeklyTokenLimit: 100_000,
      currentUsage: 0,
      periodStart: now,
      paused: false,
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
 * Write one or more activity-log entries for a given agent and week.
 * The store format is a plain JSON array in `.aweek/agents/<slug>/logs/<monday>.json`.
 */
async function writeActivityLog(projectDir, slug, weekMonday, entries) {
  const logsDir = join(projectDir, '.aweek', 'agents', slug, 'logs');
  await mkdir(logsDir, { recursive: true });
  await writeFile(
    join(logsDir, `${weekMonday}.json`),
    JSON.stringify(entries, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Build a minimal valid activity-log entry for testing.
 */
function makeEntry(overrides = {}) {
  return {
    id: overrides.id ?? `log-${Math.random().toString(16).slice(2, 10)}`,
    timestamp: overrides.timestamp ?? '2026-04-14T10:00:00.000Z',
    agentId: overrides.agentId ?? 'writer',
    status: overrides.status ?? 'completed',
    description: overrides.description ?? 'Write a blog post about AI agents',
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────
// activitySectionStyles()
// ───────────────────────────────────────────────────────────────────────

describe('activitySectionStyles()', () => {
  it('returns a non-empty CSS string', () => {
    const css = activitySectionStyles();
    assert.equal(typeof css, 'string');
    assert.ok(css.length > 0);
  });

  it('includes the .activity-list selector', () => {
    assert.match(activitySectionStyles(), /\.activity-list/);
  });

  it('includes the .activity-row selector', () => {
    assert.match(activitySectionStyles(), /\.activity-row/);
  });

  it('includes status chip selectors for all log statuses', () => {
    const css = activitySectionStyles();
    for (const status of ['started', 'completed', 'failed', 'skipped', 'delegated']) {
      assert.match(css, new RegExp(`\\.activity-chip-${status}`), `missing chip CSS for ${status}`);
    }
  });

  it('includes the .activity-empty selector', () => {
    assert.match(activitySectionStyles(), /\.activity-empty/);
  });

  it('uses CSS variable tokens from the dashboard shell', () => {
    const css = activitySectionStyles();
    assert.match(css, /var\(--status-completed\)/);
    assert.match(css, /var\(--status-failed\)/);
    assert.match(css, /var\(--accent\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderActivitySection() — empty states
// ───────────────────────────────────────────────────────────────────────

describe('renderActivitySection() — empty states', () => {
  it('renders a no-agents empty state when agents list is empty', () => {
    const html = renderActivitySection({ agents: [], selected: null });
    assert.match(html, /data-activity-state="no-agents"/);
    assert.match(html, /\/aweek:hire/);
  });

  it('no-agents state mentions hiring an agent', () => {
    const html = renderActivitySection({ agents: [], selected: null });
    assert.match(html, /No agents yet/);
  });

  it('renders a no-selection empty state when selected is null but agents exist', () => {
    const agents = [{ slug: 'writer', name: 'Writer' }];
    const html = renderActivitySection({ agents, selected: null });
    assert.match(html, /data-activity-state="no-selection"/);
    assert.match(html, /Select an agent/);
  });

  it('renders a no-entries empty state when entries is empty', () => {
    const agents = [{ slug: 'writer', name: 'Writer' }];
    const selected = { slug: 'writer', name: 'Writer', entries: [] };
    const html = renderActivitySection({ agents, selected });
    assert.match(html, /data-activity-state="no-entries"/);
    assert.match(html, /No activity logged yet/);
  });

  it('no-entries state shows the agent name', () => {
    const agents = [{ slug: 'writer', name: 'Content Writer' }];
    const selected = { slug: 'writer', name: 'Content Writer', entries: [] };
    const html = renderActivitySection({ agents, selected });
    assert.match(html, /Content Writer/);
  });

  it('no-entries state provides actionable CTAs', () => {
    const agents = [{ slug: 'writer', name: 'Writer' }];
    const selected = { slug: 'writer', name: 'Writer', entries: [] };
    const html = renderActivitySection({ agents, selected });
    assert.match(html, /\/aweek:init/);
    assert.match(html, /\/aweek:plan/);
  });

  it('no-entries state references first heartbeat tick', () => {
    const agents = [{ slug: 'writer', name: 'Writer' }];
    const selected = { slug: 'writer', name: 'Writer', entries: [] };
    const html = renderActivitySection({ agents, selected });
    assert.match(html, /first heartbeat tick/);
  });

  it('handles undefined view gracefully', () => {
    const html = renderActivitySection(undefined);
    assert.match(html, /data-activity-state="no-agents"/);
  });

  it('handles null view gracefully', () => {
    const html = renderActivitySection(null);
    assert.match(html, /data-activity-state="no-agents"/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderActivitySection() — entry rendering
// ───────────────────────────────────────────────────────────────────────

describe('renderActivitySection() — entry rendering', () => {
  const agents = [{ slug: 'writer', name: 'Writer' }];

  function viewWithEntries(entries) {
    return { agents, selected: { slug: 'writer', name: 'Writer', entries } };
  }

  it('renders a .activity-list container with data-section="activity"', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /class="activity-list"/);
    assert.match(html, /data-section="activity"/);
  });

  it('sets data-agent-slug on the container', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry({ agentId: 'writer' })]));
    assert.match(html, /data-agent-slug="writer"/);
  });

  it('renders one .activity-row per entry', () => {
    const entries = [makeEntry(), makeEntry(), makeEntry()];
    const html = renderActivitySection(viewWithEntries(entries));
    const count = (html.match(/class="activity-row"/g) || []).length;
    assert.equal(count, 3);
  });

  it('renders the agent slug in each row', () => {
    const entry = makeEntry({ agentId: 'content-writer' });
    const html = renderActivitySection(viewWithEntries([entry]));
    assert.match(html, /content-writer/);
  });

  it('renders the task description in each row', () => {
    const entry = makeEntry({ description: 'Write newsletter about AI trends' });
    const html = renderActivitySection(viewWithEntries([entry]));
    assert.match(html, /Write newsletter about AI trends/);
  });

  it('renders a status chip with the correct status class', () => {
    for (const status of ['started', 'completed', 'failed', 'skipped', 'delegated']) {
      const entry = makeEntry({ status });
      const html = renderActivitySection(viewWithEntries([entry]));
      assert.match(
        html,
        new RegExp(`activity-chip-${status}`),
        `missing status chip class for status="${status}"`,
      );
    }
  });

  it('renders a timestamp column', () => {
    const entry = makeEntry({ timestamp: '2026-04-20T14:30:00.000Z' });
    const html = renderActivitySection(viewWithEntries([entry]));
    // The formatted timestamp should appear somewhere in the row
    assert.match(html, /class="activity-ts"/);
  });

  it('sets data-entry-id on each row', () => {
    const entry = makeEntry({ id: 'log-abc123' });
    const html = renderActivitySection(viewWithEntries([entry]));
    assert.match(html, /data-entry-id="log-abc123"/);
  });

  it('sets data-entry-status on each row', () => {
    const entry = makeEntry({ status: 'failed' });
    const html = renderActivitySection(viewWithEntries([entry]));
    assert.match(html, /data-entry-status="failed"/);
  });

  it('HTML-escapes the description to prevent injection', () => {
    const entry = makeEntry({ description: '<script>alert("xss")</script>' });
    const html = renderActivitySection(viewWithEntries([entry]));
    // The XSS payload must not appear unescaped inside the activity row.
    // Note: a <script> tag IS legitimately present in the output (the filter
    // bar's client-side script), so we check the specific injected payload
    // rather than the absence of all <script> strings.
    assert.ok(!html.includes('<script>alert('), 'raw XSS payload must not appear unescaped');
    assert.match(html, /&lt;script&gt;/);
  });

  it('HTML-escapes the agent slug', () => {
    const entry = makeEntry({ agentId: 'writer&analyst' });
    const html = renderActivitySection(viewWithEntries([entry]));
    assert.ok(!html.includes('writer&analyst"'), 'unescaped ampersand must not appear in attribute');
    assert.match(html, /writer&amp;analyst/);
  });

  it('HTML-escapes the agent slug in data-agent-slug attribute', () => {
    const selected = { slug: 'writer&co', name: 'Writer', entries: [makeEntry()] };
    const html = renderActivitySection({ agents, selected });
    assert.ok(!html.includes('data-agent-slug="writer&co"'));
    assert.match(html, /data-agent-slug="writer&amp;co"/);
  });

  it('renders rows in the supplied order (caller is responsible for sorting)', () => {
    const entries = [
      makeEntry({ id: 'log-first', description: 'First task' }),
      makeEntry({ id: 'log-second', description: 'Second task' }),
    ];
    const html = renderActivitySection(viewWithEntries(entries));
    const firstIdx = html.indexOf('First task');
    const secondIdx = html.indexOf('Second task');
    assert.ok(firstIdx < secondIdx, 'rows should appear in supplied order');
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderActivitySection() — status filter bar
// ───────────────────────────────────────────────────────────────────────

describe('renderActivitySection() — status filter bar', () => {
  const agents = [{ slug: 'writer', name: 'Writer' }];

  function viewWithEntries(entries) {
    return { agents, selected: { slug: 'writer', name: 'Writer', entries } };
  }

  it('renders a filter bar when entries exist', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /class="activity-filter-bar"/);
  });

  it('renders the filter bar with data-activity-filter attribute', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /data-activity-filter/);
  });

  it('renders an "All" filter button', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /data-filter="all"/);
    assert.match(html, />All<\/button>/);
  });

  it('renders filter buttons for every log status', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    for (const status of ['started', 'completed', 'failed', 'skipped', 'delegated']) {
      assert.match(
        html,
        new RegExp(`data-filter="${status}"`),
        `missing data-filter="${status}" button`,
      );
    }
  });

  it('marks the "All" button active by default (activity-filter-btn-active)', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /activity-filter-btn-active[^>]*data-filter="all"|data-filter="all"[^>]*activity-filter-btn-active/);
  });

  it('sets aria-pressed="true" on the "All" button', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /data-filter="all"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-filter="all"/);
  });

  it('sets aria-pressed="false" on non-"All" buttons', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    // All status buttons other than "all" should be unpressed
    assert.match(html, /data-filter="failed"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-filter="failed"/);
  });

  it('wraps entries in data-activity-wrap container', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /data-activity-wrap/);
  });

  it('does NOT render a filter bar in the no-entries empty state', () => {
    const html = renderActivitySection(viewWithEntries([]));
    assert.ok(!html.includes('data-activity-filter'), 'filter bar must not appear in no-entries empty state');
  });

  it('does NOT render a filter bar in the no-agents empty state', () => {
    const html = renderActivitySection({ agents: [], selected: null });
    assert.ok(!html.includes('data-activity-filter'), 'filter bar must not appear in no-agents empty state');
  });

  it('does NOT render a filter bar in the no-selection empty state', () => {
    const html = renderActivitySection({ agents, selected: null });
    assert.ok(!html.includes('data-activity-filter'), 'filter bar must not appear in no-selection empty state');
  });

  it('includes an inline <script> tag for client-side filtering when entries exist', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /<script>/);
    assert.match(html, /data-activity-filter/);
    assert.match(html, /data-entry-status/);
  });

  it('does NOT include the filter script in empty states', () => {
    const htmlNoAgents = renderActivitySection({ agents: [], selected: null });
    assert.ok(!htmlNoAgents.includes('<script>'), 'no script in no-agents state');

    const htmlNoEntries = renderActivitySection(viewWithEntries([]));
    assert.ok(!htmlNoEntries.includes('<script>'), 'no script in no-entries state');
  });
});

// ───────────────────────────────────────────────────────────────────────
// activitySectionStyles() — filter button CSS
// ───────────────────────────────────────────────────────────────────────

describe('activitySectionStyles() — filter button CSS', () => {
  it('includes the .activity-filter-bar selector', () => {
    assert.match(activitySectionStyles(), /\.activity-filter-bar/);
  });

  it('includes the .activity-filter-btn selector', () => {
    assert.match(activitySectionStyles(), /\.activity-filter-btn/);
  });

  it('includes the .activity-filter-btn-active selector', () => {
    assert.match(activitySectionStyles(), /\.activity-filter-btn-active/);
  });

  it('includes the .activity-filter-no-results selector', () => {
    assert.match(activitySectionStyles(), /\.activity-filter-no-results/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// gatherActivity() — argument validation
// ───────────────────────────────────────────────────────────────────────

describe('gatherActivity() — argument validation', () => {
  it('throws when projectDir is missing', async () => {
    await assert.rejects(
      () => gatherActivity({}),
      (err) => err.message.includes('projectDir is required'),
    );
  });

  it('throws when called with no arguments', async () => {
    await assert.rejects(
      () => gatherActivity(),
      (err) => err.message.includes('projectDir is required'),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
// gatherActivity() — filesystem-backed tests
// ───────────────────────────────────────────────────────────────────────

describe('gatherActivity() — no agents', () => {
  let projectDir;
  beforeEach(async () => { projectDir = await makeProject(); });
  afterEach(async () => { await rm(projectDir, { recursive: true, force: true }); });

  it('returns empty agents and null selected when no agents are hired', async () => {
    const view = await gatherActivity({ projectDir });
    assert.deepEqual(view.agents, []);
    assert.equal(view.selected, null);
  });
});

describe('gatherActivity() — agent with no log files', () => {
  let projectDir;
  beforeEach(async () => {
    projectDir = await makeProject();
    await writeAgent(projectDir, 'writer');
  });
  afterEach(async () => { await rm(projectDir, { recursive: true, force: true }); });

  it('returns agents list with the agent', async () => {
    const view = await gatherActivity({ projectDir });
    assert.equal(view.agents.length, 1);
    assert.equal(view.agents[0].slug, 'writer');
  });

  it('returns empty entries when agent has no log files', async () => {
    const view = await gatherActivity({ projectDir });
    assert.ok(view.selected !== null);
    assert.deepEqual(view.selected.entries, []);
  });

  it('sets selected slug correctly', async () => {
    const view = await gatherActivity({ projectDir });
    assert.equal(view.selected.slug, 'writer');
  });
});

describe('gatherActivity() — agent with log entries', () => {
  let projectDir;
  beforeEach(async () => {
    projectDir = await makeProject();
    await writeAgent(projectDir, 'writer');
  });
  afterEach(async () => { await rm(projectDir, { recursive: true, force: true }); });

  it('loads entries from a single week file', async () => {
    const entries = [
      makeEntry({ agentId: 'writer', timestamp: '2026-04-14T10:00:00.000Z', description: 'Task A' }),
      makeEntry({ agentId: 'writer', timestamp: '2026-04-15T11:00:00.000Z', description: 'Task B' }),
    ];
    await writeActivityLog(projectDir, 'writer', '2026-04-13', entries);

    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    assert.equal(view.selected.entries.length, 2);
  });

  it('merges entries from multiple week files', async () => {
    const week1 = [makeEntry({ agentId: 'writer', timestamp: '2026-04-07T09:00:00.000Z' })];
    const week2 = [
      makeEntry({ agentId: 'writer', timestamp: '2026-04-14T09:00:00.000Z' }),
      makeEntry({ agentId: 'writer', timestamp: '2026-04-15T10:00:00.000Z' }),
    ];
    await writeActivityLog(projectDir, 'writer', '2026-04-06', week1);
    await writeActivityLog(projectDir, 'writer', '2026-04-13', week2);

    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    assert.equal(view.selected.entries.length, 3);
  });

  it('returns entries sorted reverse-chronologically (newest first)', async () => {
    const entries = [
      makeEntry({ agentId: 'writer', timestamp: '2026-04-13T08:00:00.000Z', description: 'Oldest' }),
      makeEntry({ agentId: 'writer', timestamp: '2026-04-15T12:00:00.000Z', description: 'Newest' }),
      makeEntry({ agentId: 'writer', timestamp: '2026-04-14T10:00:00.000Z', description: 'Middle' }),
    ];
    await writeActivityLog(projectDir, 'writer', '2026-04-13', entries);

    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    const descs = view.selected.entries.map((e) => e.description);
    assert.deepEqual(descs, ['Newest', 'Middle', 'Oldest']);
  });

  it('selects the specified agent when selectedSlug matches', async () => {
    await writeAgent(projectDir, 'coder');
    const writerEntries = [makeEntry({ agentId: 'writer', description: 'Writer task' })];
    await writeActivityLog(projectDir, 'writer', '2026-04-13', writerEntries);

    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    assert.equal(view.selected.slug, 'writer');
    assert.equal(view.selected.entries[0].description, 'Writer task');
  });

  it('falls back to first (alphabetical) agent when selectedSlug is unknown', async () => {
    await writeAgent(projectDir, 'analyst');
    const entries = [makeEntry({ agentId: 'analyst' })];
    await writeActivityLog(projectDir, 'analyst', '2026-04-13', entries);

    const view = await gatherActivity({ projectDir, selectedSlug: 'nonexistent' });
    // alphabetically 'analyst' < 'writer'
    assert.equal(view.selected.slug, 'analyst');
  });

  it('includes all agents in the agents list', async () => {
    await writeAgent(projectDir, 'coder');

    const view = await gatherActivity({ projectDir });
    const slugs = view.agents.map((a) => a.slug).sort();
    assert.deepEqual(slugs, ['coder', 'writer']);
  });

  it('agents list is sorted alphabetically by name', async () => {
    await writeAgent(projectDir, 'alpha');
    await writeAgent(projectDir, 'zeta');

    const view = await gatherActivity({ projectDir });
    // 'alpha' < 'writer' < 'zeta'
    assert.equal(view.agents[0].slug, 'alpha');
    assert.equal(view.agents[view.agents.length - 1].slug, 'zeta');
  });

  it('returns entries with expected fields (id, timestamp, agentId, status, description)', async () => {
    const entry = makeEntry({
      id: 'log-ab01cd02',  // must match ^log-[a-f0-9]+$ from schema
      agentId: 'writer',
      timestamp: '2026-04-14T09:00:00.000Z',
      status: 'completed',
      description: 'Draft article',
    });
    await writeActivityLog(projectDir, 'writer', '2026-04-13', [entry]);

    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    const e = view.selected.entries[0];
    assert.equal(e.id, 'log-ab01cd02');
    assert.equal(e.agentId, 'writer');
    assert.equal(e.status, 'completed');
    assert.equal(e.description, 'Draft article');
    assert.equal(typeof e.timestamp, 'string');
  });
});

// ───────────────────────────────────────────────────────────────────────
// gatherActivity() — integration: gatherActivity → renderActivitySection
// ───────────────────────────────────────────────────────────────────────

describe('gatherActivity() + renderActivitySection() integration', () => {
  let projectDir;
  beforeEach(async () => {
    projectDir = await makeProject();
    await writeAgent(projectDir, 'writer');
  });
  afterEach(async () => { await rm(projectDir, { recursive: true, force: true }); });

  it('renders a no-entries empty state for an agent with no logs', async () => {
    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    const html = renderActivitySection(view);
    assert.match(html, /data-activity-state="no-entries"/);
  });

  it('renders activity rows for logged entries', async () => {
    const entries = [
      makeEntry({ agentId: 'writer', status: 'completed', description: 'Publish post' }),
      makeEntry({ agentId: 'writer', status: 'failed', description: 'Send newsletter' }),
    ];
    await writeActivityLog(projectDir, 'writer', '2026-04-13', entries);

    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    const html = renderActivitySection(view);

    assert.match(html, /Publish post/);
    assert.match(html, /Send newsletter/);
    assert.match(html, /activity-chip-completed/);
    assert.match(html, /activity-chip-failed/);
  });

  it('renders newest entries first in the HTML output', async () => {
    const entries = [
      makeEntry({ agentId: 'writer', timestamp: '2026-04-13T08:00:00.000Z', description: 'Older' }),
      makeEntry({ agentId: 'writer', timestamp: '2026-04-15T12:00:00.000Z', description: 'Newer' }),
    ];
    await writeActivityLog(projectDir, 'writer', '2026-04-13', entries);

    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    const html = renderActivitySection(view);

    const newerIdx = html.indexOf('Newer');
    const olderIdx = html.indexOf('Older');
    assert.ok(newerIdx < olderIdx, 'newer entry should appear before older entry in the HTML');
  });
});

// ───────────────────────────────────────────────────────────────────────
// resolveDateRange()
// ───────────────────────────────────────────────────────────────────────

describe('resolveDateRange()', () => {
  it('returns "all" when called with no argument', () => {
    assert.equal(resolveDateRange(), DEFAULT_DATE_RANGE);
  });

  it('returns "all" for undefined', () => {
    assert.equal(resolveDateRange(undefined), 'all');
  });

  it('returns "all" for an unknown value', () => {
    assert.equal(resolveDateRange('month'), 'all');
    assert.equal(resolveDateRange(''), 'all');
    assert.equal(resolveDateRange(null), 'all');
    assert.equal(resolveDateRange(42), 'all');
  });

  it('returns the preset unchanged when it is a known value', () => {
    for (const preset of DATE_RANGE_PRESETS) {
      assert.equal(resolveDateRange(preset), preset);
    }
  });

  it('DATE_RANGE_PRESETS includes all, this-week, last-7-days', () => {
    assert.ok(DATE_RANGE_PRESETS.includes('all'));
    assert.ok(DATE_RANGE_PRESETS.includes('this-week'));
    assert.ok(DATE_RANGE_PRESETS.includes('last-7-days'));
  });
});

// ───────────────────────────────────────────────────────────────────────
// computeDateRangeBounds()
// ───────────────────────────────────────────────────────────────────────

describe('computeDateRangeBounds()', () => {
  it('returns { cutoff: null } for "all"', () => {
    const { cutoff } = computeDateRangeBounds('all');
    assert.equal(cutoff, null);
  });

  it('returns a ms cutoff for "last-7-days" equal to now − 7 days', () => {
    const now = new Date('2026-04-20T12:00:00.000Z');
    const { cutoff } = computeDateRangeBounds('last-7-days', now);
    const expected = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    assert.equal(cutoff, expected);
  });

  it('"last-7-days" cutoff is strictly less than now', () => {
    const now = new Date();
    const { cutoff } = computeDateRangeBounds('last-7-days', now);
    assert.ok(cutoff < now.getTime());
  });

  it('returns Monday midnight UTC cutoff for "this-week" (Wednesday input)', () => {
    // 2026-04-20 is a Monday; 2026-04-22 is a Wednesday
    const wednesday = new Date('2026-04-22T15:30:00.000Z');
    const { cutoff } = computeDateRangeBounds('this-week', wednesday);
    const mondayMidnight = new Date('2026-04-20T00:00:00.000Z').getTime();
    assert.equal(cutoff, mondayMidnight);
  });

  it('"this-week" cutoff on a Monday is that same Monday midnight UTC', () => {
    const monday = new Date('2026-04-20T08:00:00.000Z');
    const { cutoff } = computeDateRangeBounds('this-week', monday);
    const mondayMidnight = new Date('2026-04-20T00:00:00.000Z').getTime();
    assert.equal(cutoff, mondayMidnight);
  });

  it('"this-week" cutoff on a Sunday resolves to the preceding Monday', () => {
    // 2026-04-19 is a Sunday
    const sunday = new Date('2026-04-19T10:00:00.000Z');
    const { cutoff } = computeDateRangeBounds('this-week', sunday);
    const prevMonday = new Date('2026-04-13T00:00:00.000Z').getTime();
    assert.equal(cutoff, prevMonday);
  });

  it('returns { cutoff: null } for unknown preset (falls through to "all" behaviour)', () => {
    const { cutoff } = computeDateRangeBounds('unknown-preset');
    assert.equal(cutoff, null);
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderActivitySection() — date-range selector
// ───────────────────────────────────────────────────────────────────────

describe('renderActivitySection() — date-range selector', () => {
  const agents = [{ slug: 'writer', name: 'Writer' }];

  function viewWithEntries(entries, dateRange) {
    return { agents, selected: { slug: 'writer', name: 'Writer', entries }, dateRange };
  }

  it('renders the date-range group when entries exist', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /data-filter-group="date-range"/);
  });

  it('renders an "All time" button with data-date-range="all"', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /data-date-range="all"/);
    assert.match(html, /All time/);
  });

  it('renders a "This week" button with data-date-range="this-week"', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /data-date-range="this-week"/);
    assert.match(html, /This week/);
  });

  it('renders a "Last 7 days" button with data-date-range="last-7-days"', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /data-date-range="last-7-days"/);
    assert.match(html, /Last 7 days/);
  });

  it('marks the "all" date-range button active when dateRange is "all" or missing', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()], 'all'));
    // "all" button should have the active class and aria-pressed="true"
    assert.match(html, /data-date-range="all"[^>]*activity-filter-btn-active|activity-filter-btn-active[^>]*data-date-range="all"/);
    assert.match(html, /data-date-range="all"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-date-range="all"/);
  });

  it('marks the "this-week" date-range button active when view.dateRange="this-week"', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()], 'this-week'));
    assert.match(html, /data-date-range="this-week"[^>]*activity-filter-btn-active|activity-filter-btn-active[^>]*data-date-range="this-week"/);
    assert.match(html, /data-date-range="this-week"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-date-range="this-week"/);
  });

  it('marks the "last-7-days" date-range button active when view.dateRange="last-7-days"', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()], 'last-7-days'));
    assert.match(html, /data-date-range="last-7-days"[^>]*activity-filter-btn-active|activity-filter-btn-active[^>]*data-date-range="last-7-days"/);
  });

  it('sets aria-pressed="false" on non-active date-range buttons', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()], 'this-week'));
    assert.match(html, /data-date-range="all"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-date-range="all"/);
    assert.match(html, /data-date-range="last-7-days"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-date-range="last-7-days"/);
  });

  it('falls back to "all" preset when dateRange is missing from view', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()])); // no dateRange
    assert.match(html, /data-date-range="all"[^>]*activity-filter-btn-active|activity-filter-btn-active[^>]*data-date-range="all"/);
  });

  it('renders a separator between date-range and status groups', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /activity-filter-sep/);
  });

  it('renders the status group alongside the date-range group', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /data-filter-group="status"/);
    assert.match(html, /data-filter="all"/);
    assert.match(html, /data-filter="completed"/);
  });

  it('does NOT render the date-range selector in the no-entries empty state', () => {
    const html = renderActivitySection(viewWithEntries([]));
    assert.ok(!html.includes('data-date-range'), 'date-range selector must not appear in no-entries state');
  });

  it('does NOT render the date-range selector in the no-agents empty state', () => {
    const html = renderActivitySection({ agents: [], selected: null });
    assert.ok(!html.includes('data-date-range'), 'date-range selector must not appear in no-agents state');
  });

  it('includes data-date-range in the client-side script for the active button detection', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /<script>/);
    assert.match(html, /data-date-range/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderActivitySection() — data-entry-ts on rows
// ───────────────────────────────────────────────────────────────────────

describe('renderActivitySection() — data-entry-ts attribute', () => {
  const agents = [{ slug: 'writer', name: 'Writer' }];

  function viewWithEntries(entries) {
    return { agents, selected: { slug: 'writer', name: 'Writer', entries } };
  }

  it('sets data-entry-ts on each activity row', () => {
    const entry = makeEntry({ timestamp: '2026-04-20T10:00:00.000Z' });
    const html = renderActivitySection(viewWithEntries([entry]));
    assert.match(html, /data-entry-ts="2026-04-20T10:00:00.000Z"/);
  });

  it('sets data-entry-ts to empty string when timestamp is missing', () => {
    const entry = makeEntry({ timestamp: undefined });
    delete entry.timestamp;
    const html = renderActivitySection(viewWithEntries([entry]));
    assert.match(html, /data-entry-ts=""/);
  });

  it('HTML-escapes the timestamp value in data-entry-ts', () => {
    const entry = makeEntry({ timestamp: '2026-04-20T10:00:00.000Z' });
    const html = renderActivitySection(viewWithEntries([entry]));
    // Should render without unescaped characters (ISO timestamps are safe,
    // but verify the attribute is properly quoted)
    assert.match(html, /data-entry-ts="[^"]*"/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// activitySectionStyles() — filter group CSS
// ───────────────────────────────────────────────────────────────────────

describe('activitySectionStyles() — filter group CSS', () => {
  it('includes the .activity-filter-group selector', () => {
    assert.match(activitySectionStyles(), /\.activity-filter-group/);
  });

  it('includes the .activity-filter-sep selector', () => {
    assert.match(activitySectionStyles(), /\.activity-filter-sep/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// gatherActivity() — dateRange parameter
// ───────────────────────────────────────────────────────────────────────

describe('gatherActivity() — dateRange param', () => {
  let projectDir;
  beforeEach(async () => {
    projectDir = await makeProject();
    await writeAgent(projectDir, 'writer');
  });
  afterEach(async () => { await rm(projectDir, { recursive: true, force: true }); });

  it('includes dateRange="all" in the returned view by default', async () => {
    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    assert.equal(view.dateRange, 'all');
  });

  it('includes the resolved dateRange in the returned view', async () => {
    const view = await gatherActivity({ projectDir, selectedSlug: 'writer', dateRange: 'this-week' });
    assert.equal(view.dateRange, 'this-week');
  });

  it('normalises unknown dateRange to "all"', async () => {
    const view = await gatherActivity({ projectDir, selectedSlug: 'writer', dateRange: 'bad-value' });
    assert.equal(view.dateRange, 'all');
  });

  it('"all" returns all entries regardless of timestamp', async () => {
    const entries = [
      makeEntry({ agentId: 'writer', timestamp: '2020-01-06T10:00:00.000Z', description: 'Old task' }),
      makeEntry({ agentId: 'writer', timestamp: '2026-04-14T10:00:00.000Z', description: 'Recent task' }),
    ];
    await writeActivityLog(projectDir, 'writer', '2020-01-06', [entries[0]]);
    await writeActivityLog(projectDir, 'writer', '2026-04-13', [entries[1]]);

    const view = await gatherActivity({ projectDir, selectedSlug: 'writer', dateRange: 'all' });
    assert.equal(view.selected.entries.length, 2);
  });

  it('"last-7-days" excludes entries older than 7 days', async () => {
    const now = new Date();
    const recentTs = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const oldTs = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();   // 10 days ago
    const recentMonday = getMondayIso(new Date(recentTs));
    const oldMonday = getMondayIso(new Date(oldTs));

    const recent = makeEntry({ agentId: 'writer', timestamp: recentTs, description: 'Recent' });
    const old = makeEntry({ agentId: 'writer', timestamp: oldTs, description: 'Old' });

    await writeActivityLog(projectDir, 'writer', recentMonday, [recent]);
    if (oldMonday !== recentMonday) {
      await writeActivityLog(projectDir, 'writer', oldMonday, [old]);
    } else {
      // Same week file — append both to the same file
      await writeActivityLog(projectDir, 'writer', recentMonday, [recent, old]);
    }

    const view = await gatherActivity({ projectDir, selectedSlug: 'writer', dateRange: 'last-7-days' });
    const descs = view.selected.entries.map((e) => e.description);
    assert.ok(descs.includes('Recent'), 'recent entry should be included');
    assert.ok(!descs.includes('Old'), 'old entry should be excluded');
  });

  it('"this-week" excludes entries before Monday of the current UTC week', async () => {
    // Use a fixed "now" to make the test deterministic.
    // We can't inject `now` into gatherActivity directly, but we can use
    // timestamps that are unambiguously in-week vs out-of-week relative to
    // the real current week. Use computeDateRangeBounds to get the cutoff.
    const { cutoff } = computeDateRangeBounds('this-week');
    const inWeekTs = new Date(cutoff + 60 * 60 * 1000).toISOString();    // 1h after Monday midnight
    const outWeekTs = new Date(cutoff - 60 * 60 * 1000).toISOString();   // 1h before Monday midnight

    const inMonday = getMondayIso(new Date(inWeekTs));
    const outMonday = getMondayIso(new Date(outWeekTs));

    const inEntry = makeEntry({ agentId: 'writer', timestamp: inWeekTs, description: 'This week' });
    const outEntry = makeEntry({ agentId: 'writer', timestamp: outWeekTs, description: 'Last week' });

    if (inMonday === outMonday) {
      await writeActivityLog(projectDir, 'writer', inMonday, [inEntry, outEntry]);
    } else {
      await writeActivityLog(projectDir, 'writer', inMonday, [inEntry]);
      await writeActivityLog(projectDir, 'writer', outMonday, [outEntry]);
    }

    const view = await gatherActivity({ projectDir, selectedSlug: 'writer', dateRange: 'this-week' });
    const descs = view.selected.entries.map((e) => e.description);
    assert.ok(descs.includes('This week'), 'in-week entry should be included');
    assert.ok(!descs.includes('Last week'), 'out-of-week entry should be excluded');
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderActivitySection() — per-agent tab embedding (v1.1 layout)
// ───────────────────────────────────────────────────────────────────────

describe('renderActivitySection() — per-agent tab embedding', () => {
  // In the sidebar+tab layout the server wraps renderActivitySection output
  // inside a <section class="card card-activity"> card. The section itself
  // must NOT add its own card wrapper or card heading — those belong to
  // server.js. These tests verify the section renders pure tab-body content.

  const agents = [{ slug: 'writer', name: 'Writer' }];
  function viewWithEntries(entries) {
    return { agents, selected: { slug: 'writer', name: 'Writer', entries } };
  }

  it('does not render its own card wrapper (server.js owns the card shell)', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    // The card classes (card, card-activity) are added by server.js, not here
    assert.ok(!html.includes('class="card '), 'activity section must not self-wrap in a card element');
    assert.ok(!html.includes('card-activity'), 'card-activity class must be emitted by server.js, not the section');
  });

  it('does not render its own card heading (server.js renders card-head)', () => {
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    // The <h2 id="activity-head">Activity</h2> lives in server.js renderDashboardShell
    assert.ok(!html.includes('<h2'), 'section body must not contain its own heading element');
  });

  it('renders data-section="activity" to identify the active tab content pane', () => {
    // The server uses data-section to locate tab pane content; this attribute
    // must be present for the tab routing to work correctly.
    const html = renderActivitySection(viewWithEntries([makeEntry()]));
    assert.match(html, /data-section="activity"/);
  });

  it('scopes content to the selected agent via data-agent-slug attribute', () => {
    // data-agent-slug anchors the activity list to the agent selected in the
    // sidebar so client-side scripts can match content to the active agent tab.
    const selected = { slug: 'analyst', name: 'Analyst', entries: [makeEntry({ agentId: 'analyst' })] };
    const html = renderActivitySection({ agents: [{ slug: 'analyst', name: 'Analyst' }], selected });
    assert.match(html, /data-agent-slug="analyst"/);
  });

  it('data-agent-slug updates to the currently selected agent slug', () => {
    // Switching agents in the sidebar changes ?agent= in the URL; the server
    // calls gatherActivity with the new slug and re-renders the section.
    // Verify the slug is correctly propagated into the rendered HTML.
    const selected = { slug: 'coder', name: 'Coder', entries: [makeEntry({ agentId: 'coder' })] };
    const html = renderActivitySection({ agents: [{ slug: 'coder', name: 'Coder' }], selected });
    assert.match(html, /data-agent-slug="coder"/);
    assert.ok(!html.includes('data-agent-slug="writer"'), 'slug from previous agent must not leak');
  });

  it('renders a no-selection prompt when agents exist but no agent is selected in the sidebar', () => {
    // This state occurs when the URL has no ?agent= param but agents are hired.
    // The message should guide the user to click an agent in the sidebar.
    const html = renderActivitySection({ agents, selected: null });
    assert.match(html, /data-activity-state="no-selection"/);
    assert.match(html, /Select an agent/);
  });

  it('no-selection state does not render tab-specific UI (filter bar, entry rows)', () => {
    // Without a selected agent there is nothing to filter or display.
    const html = renderActivitySection({ agents, selected: null });
    assert.ok(!html.includes('data-activity-filter'), 'filter bar must be absent when no agent is selected');
    assert.ok(!html.includes('activity-row'), 'entry rows must be absent when no agent is selected');
    assert.ok(!html.includes('<script>'), 'client-side filter script must be absent when no agent is selected');
  });

  it('renders a no-agents CTA guiding user to /aweek:hire when no agents exist', () => {
    // Zero-agents empty state: the sidebar is also empty; both the sidebar
    // and the activity section show the hire CTA independently.
    const html = renderActivitySection({ agents: [], selected: null });
    assert.match(html, /data-activity-state="no-agents"/);
    assert.match(html, /\/aweek:hire/);
  });

  it('no-entries state shows agent name and heartbeat-related CTAs', () => {
    // Agent is selected (sidebar click worked) but has no logs yet.
    // The message should name the agent and tell the user how to start logging.
    const selected = { slug: 'writer', name: 'Content Writer', entries: [] };
    const html = renderActivitySection({ agents, selected });
    assert.match(html, /data-activity-state="no-entries"/);
    assert.match(html, /Content Writer/);
    assert.match(html, /\/aweek:init/);
    assert.match(html, /\/aweek:plan/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// gatherActivity() — agent context from URL routing (sidebar → tab)
// ───────────────────────────────────────────────────────────────────────

describe('gatherActivity() — agent context from URL routing', () => {
  // In the sidebar+tab layout the server extracts ?agent=<slug> from the
  // request URL and passes it to gatherActivity as `selectedSlug`. These
  // tests verify that agent context is correctly resolved and that activity
  // logs are scoped to the selected agent — not merged across all agents.

  let projectDir;
  beforeEach(async () => {
    projectDir = await makeProject();
    await writeAgent(projectDir, 'writer');
    await writeAgent(projectDir, 'coder');
  });
  afterEach(async () => { await rm(projectDir, { recursive: true, force: true }); });

  it('scopes the activity log to the agent selected in the sidebar (?agent= param)', async () => {
    const writerEntries = [makeEntry({ agentId: 'writer', description: 'Write post' })];
    const coderEntries = [makeEntry({ agentId: 'coder', description: 'Fix bug' })];
    await writeActivityLog(projectDir, 'writer', '2026-04-13', writerEntries);
    await writeActivityLog(projectDir, 'coder', '2026-04-13', coderEntries);

    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    const descriptions = view.selected.entries.map((e) => e.description);
    assert.ok(descriptions.includes('Write post'), 'writer log entry should be included');
    assert.ok(!descriptions.includes('Fix bug'), 'coder log must NOT bleed into writer view');
  });

  it('does not merge activity logs across multiple agents', async () => {
    // Each agent's log is stored in its own directory; only the selected
    // agent's log should be loaded — not a cross-agent aggregate.
    const writerEntries = [
      makeEntry({ agentId: 'writer', description: 'Write A' }),
      makeEntry({ agentId: 'writer', description: 'Write B' }),
    ];
    const coderEntries = [makeEntry({ agentId: 'coder', description: 'Code task' })];
    await writeActivityLog(projectDir, 'writer', '2026-04-13', writerEntries);
    await writeActivityLog(projectDir, 'coder', '2026-04-13', coderEntries);

    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    assert.equal(view.selected.entries.length, 2, 'should return only writer entries');
    assert.equal(view.selected.slug, 'writer');
  });

  it('view.selected.slug matches the ?agent= URL param exactly', async () => {
    // The rendered HTML uses view.selected.slug for data-agent-slug; it must
    // equal the slug that the sidebar navigation placed in the URL.
    const view = await gatherActivity({ projectDir, selectedSlug: 'coder' });
    assert.equal(view.selected.slug, 'coder');
  });

  it('returns all agents in view.agents so the sidebar can remain fully populated', async () => {
    // The sidebar needs the full agent list regardless of which agent is active.
    // gatherActivity populates view.agents for this purpose (and for backward compat).
    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    const slugs = view.agents.map((a) => a.slug).sort();
    assert.deepEqual(slugs, ['coder', 'writer'], 'all hired agents must appear in view.agents');
  });

  it('falls back to first alphabetical agent when ?agent= param is absent (no sidebar selection)', async () => {
    // When the URL has no ?agent= the server passes undefined; the section
    // auto-selects to avoid showing a blank page.
    const view = await gatherActivity({ projectDir, selectedSlug: undefined });
    // alphabetically 'coder' < 'writer'
    assert.equal(view.selected.slug, 'coder');
  });

  it('falls back to first alphabetical agent when ?agent= param references a deleted slug', async () => {
    // Stale deep-link or bookmark to a now-deleted agent; should degrade
    // gracefully to the default selection instead of throwing or returning null.
    const view = await gatherActivity({ projectDir, selectedSlug: 'deleted-agent' });
    assert.ok(view.selected !== null, 'selected must not be null for an unknown slug when agents exist');
    assert.equal(view.selected.slug, 'coder'); // alphabetically first of the two agents
  });

  it('switching agents (different selectedSlug) loads the correct agent log', async () => {
    // Simulates the user clicking a different agent in the sidebar:
    // the server re-renders with the new slug.
    const writerEntries = [makeEntry({ agentId: 'writer', description: 'Writer log' })];
    const coderEntries = [makeEntry({ agentId: 'coder', description: 'Coder log' })];
    await writeActivityLog(projectDir, 'writer', '2026-04-13', writerEntries);
    await writeActivityLog(projectDir, 'coder', '2026-04-13', coderEntries);

    const writerView = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    const coderView = await gatherActivity({ projectDir, selectedSlug: 'coder' });

    assert.equal(writerView.selected.slug, 'writer');
    assert.equal(coderView.selected.slug, 'coder');
    assert.ok(
      writerView.selected.entries.every((e) => e.agentId === 'writer'),
      'writer view must only contain writer entries',
    );
    assert.ok(
      coderView.selected.entries.every((e) => e.agentId === 'coder'),
      'coder view must only contain coder entries',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
// gatherActivity() — tab-level lazy-load contract (activity tab only)
// ───────────────────────────────────────────────────────────────────────

describe('gatherActivity() — tab-level data contract', () => {
  // The server only calls gatherActivity when resolvedActiveTab === 'activity'.
  // These tests verify that the returned view object carries the fields the
  // server and renderActivitySection expect for correct tab rendering.

  let projectDir;
  beforeEach(async () => {
    projectDir = await makeProject();
    await writeAgent(projectDir, 'writer');
  });
  afterEach(async () => { await rm(projectDir, { recursive: true, force: true }); });

  it('returns view.agents, view.selected, and view.dateRange as top-level fields', async () => {
    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    assert.ok(Array.isArray(view.agents), 'view.agents must be an array');
    assert.ok(view.selected !== null && typeof view.selected === 'object', 'view.selected must be an object');
    assert.ok(typeof view.dateRange === 'string', 'view.dateRange must be a string');
  });

  it('view.selected carries slug, name, and entries for the activity tab renderer', async () => {
    const entries = [makeEntry({ agentId: 'writer' })];
    await writeActivityLog(projectDir, 'writer', '2026-04-13', entries);
    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    assert.ok('slug' in view.selected, 'view.selected.slug required for data-agent-slug attribute');
    assert.ok('name' in view.selected, 'view.selected.name required for display in empty states');
    assert.ok(Array.isArray(view.selected.entries), 'view.selected.entries required for row rendering');
  });

  it('view.dateRange is always a valid preset string (never undefined or null)', async () => {
    // renderActivitySection reads view.dateRange to determine which filter button
    // is initially active; it must always be a known preset or 'all'.
    const viewDefault = await gatherActivity({ projectDir });
    assert.ok(['all', 'this-week', 'last-7-days'].includes(viewDefault.dateRange));

    const viewExplicit = await gatherActivity({ projectDir, dateRange: 'this-week' });
    assert.ok(['all', 'this-week', 'last-7-days'].includes(viewExplicit.dateRange));
  });

  it('round-trips through renderActivitySection without throwing', async () => {
    // Smoke-test the full gather → render pipeline as the server executes it.
    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    assert.doesNotThrow(() => renderActivitySection(view));
  });

  it('round-trip produces valid HTML with at least one known activity attribute', async () => {
    const entries = [makeEntry({ agentId: 'writer', description: 'Pipeline test' })];
    await writeActivityLog(projectDir, 'writer', '2026-04-13', entries);

    const view = await gatherActivity({ projectDir, selectedSlug: 'writer' });
    const html = renderActivitySection(view);
    assert.match(html, /data-section="activity"/);
    assert.match(html, /data-agent-slug="writer"/);
    assert.match(html, /Pipeline test/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Helper: getMondayIso(date) — replicates getMondayDate for test fixtures
// ───────────────────────────────────────────────────────────────────────
function getMondayIso(date) {
  const d = new Date(date.getTime());
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}
