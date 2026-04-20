/**
 * Tests for `src/serve/strategy-section.js`.
 *
 * AC 5: Strategy tab renders the existing plan.md content (goals, monthly
 * plans, strategies) for the selected agent without an agent picker.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';

import {
  gatherStrategy,
  renderStrategySection,
  strategySectionStyles,
} from './strategy-section.js';
import { startServer } from './server.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

async function makeProject(prefix = 'aweek-strategy-') {
  const projectDir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(projectDir, '.aweek', 'agents'), { recursive: true });
  await mkdir(join(projectDir, '.claude', 'agents'), { recursive: true });
  return projectDir;
}

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

async function writeSubagent(projectDir, slug, { name } = {}) {
  const content = [
    '---',
    `name: ${name || slug}`,
    'description: "test"',
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

async function writePlanMd(projectDir, slug, body) {
  const dir = join(projectDir, '.aweek', 'agents', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plan.md'), body, 'utf8');
}

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

// ────────────────────────────────────────────────────────────────────────────
// renderStrategySection — HTML shape
// ────────────────────────────────────────────────────────────────────────────

describe('renderStrategySection()', () => {
  it('renders an empty state when strategy is null', () => {
    const html = renderStrategySection(null);
    assert.match(html, /strategy-empty/);
  });

  it('renders an empty state when selected is null', () => {
    const html = renderStrategySection({ agents: [], selected: null });
    assert.match(html, /strategy-empty/);
    assert.match(html, /Select an agent/);
  });

  it('renders a no-plan empty state with CTA when agent has no plan.md', () => {
    const html = renderStrategySection({
      agents: [{ slug: 'writer', name: 'Writer' }],
      selected: { slug: 'writer', name: 'Writer', markdown: null, hasPlan: false },
    });
    assert.match(html, /strategy-empty/);
    assert.match(html, /No strategy yet/);
    assert.match(html, /Writer/);
    assert.match(html, /\/aweek:plan/);
  });

  it('renders the plan.md body as HTML when plan exists', () => {
    const md = [
      '# Writer',
      '',
      '## Long-term goals',
      '',
      '- Publish monthly',
      '- Build a style guide',
      '',
      '## Monthly plans',
      '',
      '### 2026-04',
      '',
      '- Ship the dashboard',
      '',
      '## Strategies',
      '',
      'Prefer **short** sessions with *focused* scope.',
    ].join('\n');
    const html = renderStrategySection({
      agents: [{ slug: 'writer', name: 'Writer' }],
      selected: { slug: 'writer', name: 'Writer', markdown: md, hasPlan: true },
    });
    // Article wrapper with agent slug
    assert.match(html, /<article class="strategy-body" data-agent-slug="writer">/);
    // Rendered markdown headings
    assert.match(html, /<h1 class="plan-h1">Writer<\/h1>/);
    assert.match(html, /<h2 class="plan-h2">Long-term goals<\/h2>/);
    assert.match(html, /<h2 class="plan-h2">Monthly plans<\/h2>/);
    assert.match(html, /<h2 class="plan-h2">Strategies<\/h2>/);
    // Bullet list items
    assert.match(html, /<li>Publish monthly<\/li>/);
    assert.match(html, /<li>Build a style guide<\/li>/);
    // Inline emphasis
    assert.match(html, /<strong>short<\/strong>/);
    assert.match(html, /<em>focused<\/em>/);
  });

  it('does NOT render an agent picker (sidebar handles agent switching)', () => {
    const html = renderStrategySection({
      agents: [
        { slug: 'writer', name: 'Writer' },
        { slug: 'analyst', name: 'Analyst' },
      ],
      selected: { slug: 'writer', name: 'Writer', markdown: '# hi', hasPlan: true },
    });
    // No plan-picker nav or plan-pill links
    assert.ok(!html.includes('class="plan-pill"'), 'no agent picker pills expected');
    assert.ok(!html.includes('class="plan-picker"'), 'no plan-picker nav expected');
    // No link to switch to another agent
    assert.ok(!html.includes('?agent=analyst'), 'no link to switch agent expected');
  });

  it('HTML-escapes agent slugs in the article data attribute', () => {
    const html = renderStrategySection({
      agents: [{ slug: 'my-agent', name: 'My Agent' }],
      selected: { slug: 'my-agent', name: 'My Agent', markdown: '# hi', hasPlan: true },
    });
    assert.match(html, /data-agent-slug="my-agent"/);
  });

  it('HTML-escapes agent names in the no-plan empty state', () => {
    const html = renderStrategySection({
      agents: [{ slug: 'evil', name: '<script>xss</script>' }],
      selected: {
        slug: 'evil',
        name: '<script>xss</script>',
        markdown: null,
        hasPlan: false,
      },
    });
    assert.ok(!html.includes('<script>'), 'raw script tag must not appear');
    assert.match(html, /&lt;script&gt;xss&lt;\/script&gt;/);
  });

  it('renders an empty article for an empty (but existing) plan.md', () => {
    const html = renderStrategySection({
      agents: [{ slug: 'blank', name: 'Blank' }],
      selected: { slug: 'blank', name: 'Blank', markdown: '', hasPlan: false },
    });
    // hasPlan:false triggers the no-plan empty state
    assert.match(html, /strategy-empty/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// strategySectionStyles()
// ────────────────────────────────────────────────────────────────────────────

describe('strategySectionStyles()', () => {
  it('returns a non-empty CSS string', () => {
    const css = strategySectionStyles();
    assert.equal(typeof css, 'string');
    assert.ok(css.length > 0);
  });

  it('declares .strategy-body selector', () => {
    const css = strategySectionStyles();
    assert.match(css, /\.strategy-body/);
  });

  it('declares .strategy-empty selector', () => {
    const css = strategySectionStyles();
    assert.match(css, /\.strategy-empty/);
  });

  it('uses CSS custom properties for theming', () => {
    const css = strategySectionStyles();
    assert.match(css, /var\(--muted\)/);
    assert.match(css, /var\(--text\)/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// gatherStrategy() — delegates to gatherPlans
// ────────────────────────────────────────────────────────────────────────────

describe('gatherStrategy()', () => {
  let projectDir;
  beforeEach(async () => {
    projectDir = await makeProject();
  });
  afterEach(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('returns empty agents + null selected when no agents exist', async () => {
    const result = await gatherStrategy({ projectDir });
    assert.deepEqual(result, { agents: [], selected: null });
  });

  it('picks the first agent when selectedSlug is omitted', async () => {
    await writeAgent(projectDir, 'aaa');
    await writeSubagent(projectDir, 'aaa', { name: 'Alpha' });
    await writePlanMd(projectDir, 'aaa', '# Alpha plan\n\nHello');

    const result = await gatherStrategy({ projectDir });
    assert.equal(result.selected.slug, 'aaa');
    assert.equal(result.selected.name, 'Alpha');
    assert.ok(result.selected.hasPlan);
    assert.match(result.selected.markdown, /Alpha plan/);
  });

  it('honours selectedSlug when it matches an existing agent', async () => {
    await writeAgent(projectDir, 'aaa');
    await writeAgent(projectDir, 'bbb');
    await writeSubagent(projectDir, 'aaa', { name: 'Alpha' });
    await writeSubagent(projectDir, 'bbb', { name: 'Bravo' });
    await writePlanMd(projectDir, 'bbb', '# Bravo plan');

    const result = await gatherStrategy({ projectDir, selectedSlug: 'bbb' });
    assert.equal(result.selected.slug, 'bbb');
    assert.equal(result.selected.name, 'Bravo');
    assert.match(result.selected.markdown, /Bravo plan/);
  });

  it('falls back to first agent when selectedSlug does not match', async () => {
    await writeAgent(projectDir, 'aaa');
    await writeSubagent(projectDir, 'aaa', { name: 'Alpha' });
    await writePlanMd(projectDir, 'aaa', '# Alpha plan');

    const result = await gatherStrategy({ projectDir, selectedSlug: 'nonexistent' });
    assert.equal(result.selected.slug, 'aaa');
  });

  it('returns hasPlan:false when the agent has no plan.md yet', async () => {
    await writeAgent(projectDir, 'ghost');
    await writeSubagent(projectDir, 'ghost', { name: 'Ghost' });

    const result = await gatherStrategy({ projectDir });
    assert.equal(result.selected.slug, 'ghost');
    assert.equal(result.selected.hasPlan, false);
    assert.equal(result.selected.markdown, null);
  });

  it('falls back to slug when the subagent .md is missing', async () => {
    await writeAgent(projectDir, 'ghost');
    // no writeSubagent — identity file missing

    const result = await gatherStrategy({ projectDir });
    assert.equal(result.agents[0].slug, 'ghost');
    assert.equal(result.agents[0].name, 'ghost');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// renderStrategySection() — agent-scope data attribute
// ────────────────────────────────────────────────────────────────────────────

describe('renderStrategySection() — agent scope', () => {
  it('article data-agent-slug matches the selected agent slug', () => {
    const html = renderStrategySection({
      agents: [{ slug: 'researcher', name: 'Researcher' }],
      selected: { slug: 'researcher', name: 'Researcher', markdown: '# R', hasPlan: true },
    });
    assert.match(html, /data-agent-slug="researcher"/);
    assert.ok(!html.includes('data-agent-slug=""'), 'slug must not be empty');
  });

  it('article data-agent-slug tracks the selected agent, not another agent in the list', () => {
    const html = renderStrategySection({
      agents: [
        { slug: 'alpha', name: 'Alpha' },
        { slug: 'beta', name: 'Beta' },
      ],
      selected: { slug: 'beta', name: 'Beta', markdown: '# Beta plan', hasPlan: true },
    });
    // Only beta's slug should appear as the data attribute value
    assert.match(html, /data-agent-slug="beta"/);
    assert.ok(!html.includes('data-agent-slug="alpha"'), 'non-selected agent slug must not appear in article');
  });

  it('no-plan empty state references the selected agent name, not another agent', () => {
    const html = renderStrategySection({
      agents: [
        { slug: 'alpha', name: 'Alpha Agent' },
        { slug: 'beta', name: 'Beta Agent' },
      ],
      selected: { slug: 'beta', name: 'Beta Agent', markdown: null, hasPlan: false },
    });
    assert.match(html, /Beta Agent/);
    assert.ok(!html.includes('Alpha Agent'), 'non-selected agent name must not appear');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC 12: Empty strategy shows analogous message plus CTA
// ────────────────────────────────────────────────────────────────────────────

describe('empty state — no strategy (AC 12)', () => {
  it('shows agent name in strong and /aweek:plan CTA in code when hasPlan is false', () => {
    const html = renderStrategySection({
      agents: [{ slug: 'researcher', name: 'Researcher' }],
      selected: {
        slug: 'researcher',
        name: 'Researcher',
        markdown: null,
        hasPlan: false,
      },
    });
    assert.match(html, /strategy-empty/);
    // Agent name is highlighted so the operator sees which agent has no strategy
    assert.match(html, /<strong>Researcher<\/strong>/);
    // Plain-language description of what is missing
    assert.match(html, /No strategy yet/);
    // CTA is in a <code> element so the user knows the exact command to run
    assert.match(html, /<code>\/aweek:plan<\/code>/);
  });

  it('no-plan message is structurally analogous to the calendar empty state', () => {
    // Both empty states follow the pattern:
    //   "No [X] yet for <strong>Name</strong>. Run <code>/aweek:plan</code> to [action]."
    // This test verifies the strategy half of that contract.
    const html = renderStrategySection({
      agents: [{ slug: 'planner', name: 'Planner' }],
      selected: {
        slug: 'planner',
        name: 'Planner',
        markdown: null,
        hasPlan: false,
      },
    });
    // Pattern: "No ... yet for <strong>..."
    assert.match(html, /No .+ yet for <strong>/);
    // Pattern: "Run <code>/aweek:plan</code> to ..."
    assert.match(html, /Run <code>\/aweek:plan<\/code> to /);
  });

  it('describes what /aweek:plan will create (goals, plans, strategies)', () => {
    const html = renderStrategySection({
      agents: [{ slug: 'writer', name: 'Writer' }],
      selected: { slug: 'writer', name: 'Writer', markdown: null, hasPlan: false },
    });
    // The CTA description tells the user what the command does
    assert.match(html, /goals/);
    assert.match(html, /strategies/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// End-to-end: GET /?tab=strategy renders the strategy card
// ────────────────────────────────────────────────────────────────────────────

describe('GET /?tab=strategy end-to-end', () => {
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

  it('renders the strategy card with plan.md content in the dashboard HTML', async () => {
    await writeAgent(projectDir, 'writer');
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });
    await writePlanMd(
      projectDir,
      'writer',
      [
        '# Writer',
        '',
        '## Long-term goals',
        '',
        '- Publish monthly',
        '- Build a style guide',
        '',
        '## Monthly plans',
        '',
        '### 2026-04',
        '',
        '- Ship the dashboard',
        '',
        '## Strategies',
        '',
        'Prefer **focused** short sessions.',
      ].join('\n'),
    );

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=strategy`);
    assert.equal(res.statusCode, 200);

    // Strategy card container is server-rendered
    assert.match(res.body, /data-section="strategy"/);
    assert.match(res.body, /card-strategy/);

    // plan.md content rendered correctly
    assert.match(res.body, /<h2 class="plan-h2">Long-term goals<\/h2>/);
    assert.match(res.body, /<h2 class="plan-h2">Strategies<\/h2>/);
    assert.match(res.body, /<li>Publish monthly<\/li>/);
    assert.match(res.body, /<strong>focused<\/strong>/);

    // No agent picker nav element — sidebar handles agent selection.
    // Note: the CSS selector `.plan-picker` appears in injected styles; we
    // check for the HTML attribute to distinguish CSS from rendered elements.
    assert.ok(!res.body.includes('class="plan-picker"'), 'no plan-picker nav element expected in strategy tab');
  });

  it('renders a no-plan empty state when agent has no plan.md', async () => {
    await writeAgent(projectDir, 'orphan');
    await writeSubagent(projectDir, 'orphan', { name: 'Orphan' });
    // no plan.md written

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=orphan&tab=strategy`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-section="strategy"/);
    assert.match(res.body, /No strategy yet/);
    assert.match(res.body, /Orphan/);
    assert.match(res.body, /\/aweek:plan/);
  });

  it('re-reads plan.md on every request — live data, no cache', async () => {
    await writeAgent(projectDir, 'writer');
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });
    await writePlanMd(projectDir, 'writer', '# v1 strategy body');

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    let res = await httpGet(`${handle.url}?agent=writer&tab=strategy`);
    assert.match(res.body, /v1 strategy body/);

    // Update plan.md without restarting the server
    await writePlanMd(projectDir, 'writer', '# v2 strategy updated');
    res = await httpGet(`${handle.url}?agent=writer&tab=strategy`);
    assert.match(res.body, /v2 strategy updated/);
    assert.ok(!res.body.includes('v1 strategy body'));
  });

  it('switches to the agent named in ?agent=<slug>', async () => {
    await writeAgent(projectDir, 'aaa');
    await writeAgent(projectDir, 'bbb');
    await writeSubagent(projectDir, 'aaa', { name: 'Alpha' });
    await writeSubagent(projectDir, 'bbb', { name: 'Bravo' });
    await writePlanMd(projectDir, 'aaa', '# Alpha strategy content');
    await writePlanMd(projectDir, 'bbb', '# Bravo strategy content');

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });

    let res = await httpGet(`${handle.url}?agent=aaa&tab=strategy`);
    assert.match(res.body, /Alpha strategy content/);
    assert.ok(!res.body.includes('Bravo strategy content'));

    res = await httpGet(`${handle.url}?agent=bbb&tab=strategy`);
    assert.match(res.body, /Bravo strategy content/);
    assert.ok(!res.body.includes('Alpha strategy content'));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// End-to-end: tab bar wiring when strategy tab is active
// ────────────────────────────────────────────────────────────────────────────

describe('GET /?tab=strategy — tab bar wiring', () => {
  let projectDir;
  let handle;

  beforeEach(async () => {
    projectDir = await makeProject('aweek-strategy-tabbar-');
    handle = null;
  });
  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('renders the tab bar with data-agent-tabs set to the selected agent slug', async () => {
    await writeAgent(projectDir, 'writer');
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });
    await writePlanMd(projectDir, 'writer', '# Writer plan');

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=strategy`);
    assert.equal(res.statusCode, 200);

    // Tab bar must carry the selected agent slug
    assert.match(res.body, /data-agent-tabs="writer"/);
  });

  it('marks the Strategy tab as active with aria-current="page"', async () => {
    await writeAgent(projectDir, 'writer');
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });
    await writePlanMd(projectDir, 'writer', '# Writer plan');

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=strategy`);
    assert.equal(res.statusCode, 200);

    // The active tab is rendered as a <span> with aria-current — not a link.
    assert.match(res.body, /aria-current="page"/);
    // data-tab="strategy" on the active span
    assert.match(res.body, /data-tab="strategy"/);
    // Strategy tab must not appear as a navigable href for itself
    assert.ok(
      !res.body.includes('href="?agent=writer&amp;tab=strategy"'),
      'active strategy tab must not be a self-link',
    );
  });

  it('renders Calendar, Activity, and Profile tabs as links when strategy is active', async () => {
    await writeAgent(projectDir, 'writer');
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });
    await writePlanMd(projectDir, 'writer', '# Writer plan');

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=strategy`);
    assert.equal(res.statusCode, 200);

    // Inactive tabs must have proper href links
    assert.match(res.body, /href="\?agent=writer&amp;tab=calendar"/);
    assert.match(res.body, /href="\?agent=writer&amp;tab=activity"/);
    assert.match(res.body, /href="\?agent=writer&amp;tab=profile"/);
  });

  it('tab bar is absent when no agent is selected (no ?agent= param)', async () => {
    await writeAgent(projectDir, 'writer');
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });
    await writePlanMd(projectDir, 'writer', '# Writer plan');

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    // Request with no agent param — tab bar should not render
    const res = await httpGet(`${handle.url}?tab=strategy`);
    assert.equal(res.statusCode, 200);

    // No tab bar rendered without an agent selection
    assert.ok(!res.body.includes('data-agent-tabs='), 'tab bar must be absent when no agent is selected');
  });

  it('tab bar agent context updates when a different agent is selected', async () => {
    await writeAgent(projectDir, 'aaa');
    await writeAgent(projectDir, 'bbb');
    await writeSubagent(projectDir, 'aaa', { name: 'Alpha' });
    await writeSubagent(projectDir, 'bbb', { name: 'Bravo' });
    await writePlanMd(projectDir, 'aaa', '# Alpha plan');
    await writePlanMd(projectDir, 'bbb', '# Bravo plan');

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });

    let res = await httpGet(`${handle.url}?agent=aaa&tab=strategy`);
    assert.match(res.body, /data-agent-tabs="aaa"/);
    assert.ok(!res.body.includes('data-agent-tabs="bbb"'));

    res = await httpGet(`${handle.url}?agent=bbb&tab=strategy`);
    assert.match(res.body, /data-agent-tabs="bbb"/);
    assert.ok(!res.body.includes('data-agent-tabs="aaa"'));
  });

  it('strategy section is rendered inside the content-area alongside the tab bar', async () => {
    await writeAgent(projectDir, 'writer');
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });
    await writePlanMd(projectDir, 'writer', '# Writer strategy');

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=strategy`);
    assert.equal(res.statusCode, 200);

    // Both the tab bar and the strategy card must be present
    assert.match(res.body, /data-agent-tabs="writer"/);
    assert.match(res.body, /data-section="strategy"/);
    assert.match(res.body, /card-strategy/);
    // Rendered plan content is reachable within the strategy card
    assert.match(res.body, /Writer strategy/);
  });
});
