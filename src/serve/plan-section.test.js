/**
 * Tests for `src/serve/plan-section.js`.
 *
 * Scope (AC 4): gather plan.md for the selected agent, render the
 * markdown body as HTML inside the dashboard's "Plan" card, and expose
 * an agent picker so users can switch between agents via `?agent=<slug>`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';

import {
  gatherPlans,
  planSectionStyles,
  renderMarkdown,
  renderPlanSection,
} from './plan-section.js';
import { startServer } from './server.js';

// ───────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────

async function makeProject(prefix = 'aweek-plan-') {
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

// ───────────────────────────────────────────────────────────────────────
// renderMarkdown — subset coverage
// ───────────────────────────────────────────────────────────────────────

describe('renderMarkdown()', () => {
  it('renders ATX headings H1-H4 with .plan-h<level> class', () => {
    const html = renderMarkdown('# One\n\n## Two\n\n### Three\n\n#### Four');
    assert.match(html, /<h1 class="plan-h1">One<\/h1>/);
    assert.match(html, /<h2 class="plan-h2">Two<\/h2>/);
    assert.match(html, /<h3 class="plan-h3">Three<\/h3>/);
    assert.match(html, /<h4 class="plan-h4">Four<\/h4>/);
  });

  it('clamps deeper headings (#####) to H4 so styling stays bounded', () => {
    const html = renderMarkdown('##### Deep');
    assert.match(html, /<h4 class="plan-h4">Deep<\/h4>/);
  });

  it('renders unordered and ordered lists', () => {
    const md = '- alpha\n- beta\n\n1. first\n2. second';
    const html = renderMarkdown(md);
    assert.match(html, /<ul class="plan-list"><li>alpha<\/li><li>beta<\/li><\/ul>/);
    assert.match(html, /<ol class="plan-list"><li>first<\/li><li>second<\/li><\/ol>/);
  });

  it('wraps consecutive non-block lines into a paragraph', () => {
    const html = renderMarkdown('line one\nline two');
    assert.match(html, /<p class="plan-p">line one line two<\/p>/);
  });

  it('renders fenced code blocks with language class', () => {
    const md = '```js\nconst x = 1;\n```';
    const html = renderMarkdown(md);
    assert.match(html, /<pre class="plan-code"><code class="language-js">const x = 1;\n<\/code><\/pre>/);
  });

  it('renders inline code without touching markdown inside it', () => {
    const html = renderMarkdown('try `**not bold**` here');
    assert.match(html, /<code class="plan-code-inline">\*\*not bold\*\*<\/code>/);
    // The literal "**not bold**" must survive inside <code> — not be converted to <strong>
    assert.ok(!/<strong>/.test(html));
  });

  it('renders bold and italic inline', () => {
    const html = renderMarkdown('this is **bold** and *italic*');
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<em>italic<\/em>/);
  });

  it('renders links with plan-link class', () => {
    const html = renderMarkdown('see [docs](https://example.com)');
    assert.match(html, /<a class="plan-link" href="https:\/\/example\.com">docs<\/a>/);
  });

  it('renders blockquotes', () => {
    const html = renderMarkdown('> quoted line\n> second line');
    assert.match(html, /<blockquote class="plan-quote">/);
    assert.match(html, /quoted line second line/);
  });

  it('strips HTML comments so placeholder hints never leak', () => {
    const html = renderMarkdown('## Notes\n\n<!-- hidden -->\n\nreal text');
    assert.ok(!html.includes('hidden'));
    assert.match(html, /real text/);
  });

  it('HTML-escapes raw markup so <script> cannot leak', () => {
    const html = renderMarkdown('A <script>alert(1)</script> line');
    assert.ok(!html.includes('<script>'));
    assert.match(html, /&lt;script&gt;/);
  });

  it('returns empty string for empty / non-string input', () => {
    assert.equal(renderMarkdown(''), '');
    assert.equal(renderMarkdown(null), '');
    assert.equal(renderMarkdown(undefined), '');
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderPlanSection — HTML shape
// ───────────────────────────────────────────────────────────────────────

describe('renderPlanSection()', () => {
  it('renders an empty state when no agents exist', () => {
    const html = renderPlanSection({ agents: [], selected: null });
    assert.match(html, /plan-empty/);
    assert.match(html, /\/aweek:hire/);
  });

  it('renders a pill link per agent and highlights the selected one', () => {
    const html = renderPlanSection({
      agents: [
        { slug: 'writer', name: 'Writer' },
        { slug: 'analyst', name: 'Analyst' },
      ],
      selected: {
        slug: 'writer',
        name: 'Writer',
        markdown: '# Writer plan',
        hasPlan: true,
      },
    });
    // Picker contains both pills
    assert.match(html, /data-agent-slug="writer"/);
    assert.match(html, /data-agent-slug="analyst"/);
    // Selected renders as span with aria-current
    assert.match(html, /<span class="plan-pill selected"[^>]*aria-current="page"[^>]*>Writer<\/span>/);
    // Non-selected renders as anchor with ?agent= href
    assert.match(html, /<a class="plan-pill" href="\?agent=analyst"[^>]*>Analyst<\/a>/);
    // Plan body contains rendered markdown (H1)
    assert.match(html, /<article class="plan-body" data-agent-slug="writer">/);
    assert.match(html, /<h1 class="plan-h1">Writer plan<\/h1>/);
  });

  it('shows a friendly empty state when the selected agent has no plan.md yet', () => {
    const html = renderPlanSection({
      agents: [{ slug: 'ghost', name: 'Ghost' }],
      selected: { slug: 'ghost', name: 'Ghost', markdown: null, hasPlan: false },
    });
    assert.match(html, /No <code>plan\.md<\/code> yet/);
    assert.match(html, /Ghost/);
    assert.match(html, /\/aweek:plan/);
  });

  it('escapes agent names in the picker + plan body wrapper', () => {
    const html = renderPlanSection({
      agents: [{ slug: 'evil', name: '<b>Evil</b>' }],
      selected: { slug: 'evil', name: '<b>Evil</b>', markdown: '# hi', hasPlan: true },
    });
    assert.ok(!html.includes('<b>Evil</b>'));
    assert.match(html, /&lt;b&gt;Evil&lt;\/b&gt;/);
  });
});

describe('planSectionStyles()', () => {
  it('declares the classes the renderer emits', () => {
    const css = planSectionStyles();
    for (const sel of [
      '.plan-picker',
      '.plan-pill',
      '.plan-pill.selected',
      '.plan-body',
      '.plan-h1',
      '.plan-h2',
      '.plan-list',
      '.plan-code',
      '.plan-code-inline',
      '.plan-empty',
      '.plan-link',
      '.plan-quote',
    ]) {
      assert.ok(css.includes(sel), `expected CSS to contain ${sel}`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// gatherPlans — end-to-end from the filesystem
// ───────────────────────────────────────────────────────────────────────

describe('gatherPlans()', () => {
  let projectDir;
  beforeEach(async () => {
    projectDir = await makeProject();
  });
  afterEach(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('returns empty agents + null selected when no agents exist', async () => {
    const plans = await gatherPlans({ projectDir });
    assert.deepEqual(plans, { agents: [], selected: null });
  });

  it('picks the first agent when selectedSlug is omitted', async () => {
    await writeAgent(projectDir, 'aaa');
    await writeAgent(projectDir, 'bbb');
    await writeSubagent(projectDir, 'aaa', { name: 'Alpha' });
    await writeSubagent(projectDir, 'bbb', { name: 'Bravo' });
    await writePlanMd(projectDir, 'aaa', '# Alpha plan\n\nHello');
    await writePlanMd(projectDir, 'bbb', '# Bravo plan');

    const plans = await gatherPlans({ projectDir });
    assert.equal(plans.agents.length, 2);
    // Sorted by display name → Alpha first
    assert.deepEqual(plans.agents.map((a) => a.slug), ['aaa', 'bbb']);
    assert.equal(plans.selected.slug, 'aaa');
    assert.equal(plans.selected.name, 'Alpha');
    assert.ok(plans.selected.hasPlan);
    assert.match(plans.selected.markdown, /Alpha plan/);
  });

  it('honours selectedSlug when it matches an existing agent', async () => {
    await writeAgent(projectDir, 'aaa');
    await writeAgent(projectDir, 'bbb');
    await writeSubagent(projectDir, 'aaa', { name: 'Alpha' });
    await writeSubagent(projectDir, 'bbb', { name: 'Bravo' });
    await writePlanMd(projectDir, 'bbb', '# Bravo plan');

    const plans = await gatherPlans({ projectDir, selectedSlug: 'bbb' });
    assert.equal(plans.selected.slug, 'bbb');
    assert.equal(plans.selected.name, 'Bravo');
    assert.match(plans.selected.markdown, /Bravo plan/);
  });

  it('falls back to first agent when selectedSlug does not match', async () => {
    await writeAgent(projectDir, 'aaa');
    await writeSubagent(projectDir, 'aaa', { name: 'Alpha' });
    await writePlanMd(projectDir, 'aaa', '# Alpha plan');

    const plans = await gatherPlans({ projectDir, selectedSlug: 'nonexistent' });
    assert.equal(plans.selected.slug, 'aaa');
  });

  it('returns hasPlan:false when the agent has no plan.md yet', async () => {
    await writeAgent(projectDir, 'orphan');
    await writeSubagent(projectDir, 'orphan', { name: 'Orphan' });
    // Deliberately no writePlanMd

    const plans = await gatherPlans({ projectDir });
    assert.equal(plans.selected.slug, 'orphan');
    assert.equal(plans.selected.hasPlan, false);
    assert.equal(plans.selected.markdown, null);
  });

  it('falls back to slug when the subagent .md is missing', async () => {
    await writeAgent(projectDir, 'ghost');
    // no writeSubagent — identity missing
    const plans = await gatherPlans({ projectDir });
    assert.equal(plans.agents[0].slug, 'ghost');
    assert.equal(plans.agents[0].name, 'ghost');
  });
});

// ───────────────────────────────────────────────────────────────────────
// End-to-end: GET / renders the plan card
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

describe('GET / plan card end-to-end', () => {
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

  it('renders the default agent plan as formatted markdown', async () => {
    await writeAgent(projectDir, 'writer');
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });
    await writePlanMd(
      projectDir,
      'writer',
      [
        '# Writer',
        '',
        'A careful essayist.',
        '',
        '## Long-term goals',
        '',
        '- Publish monthly',
        '- Build a style guide',
        '',
        '## Strategies',
        '',
        'Prefer **short** sessions with *focused* scope.',
      ].join('\n'),
    );

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(handle.url);
    assert.equal(res.statusCode, 200);
    const body = res.body;

    // Plan card is server-rendered inside the shell
    assert.match(body, /data-section="plan"/);
    // Agent picker is present
    assert.match(body, /plan-picker/);
    // H1 from the plan.md becomes an h1 in the card
    assert.match(body, /<h1 class="plan-h1">Writer<\/h1>/);
    // Canonical H2s render
    assert.match(body, /<h2 class="plan-h2">Long-term goals<\/h2>/);
    assert.match(body, /<h2 class="plan-h2">Strategies<\/h2>/);
    // Bullet list renders
    assert.match(body, /<li>Publish monthly<\/li>/);
    // Inline emphasis renders
    assert.match(body, /<strong>short<\/strong>/);
    assert.match(body, /<em>focused<\/em>/);
  });

  it('switches to the agent named in ?agent=<slug>', async () => {
    await writeAgent(projectDir, 'aaa');
    await writeAgent(projectDir, 'bbb');
    await writeSubagent(projectDir, 'aaa', { name: 'Alpha' });
    await writeSubagent(projectDir, 'bbb', { name: 'Bravo' });
    await writePlanMd(projectDir, 'aaa', '# Alpha plan\n\nalpha body');
    await writePlanMd(projectDir, 'bbb', '# Bravo plan\n\nbravo body');

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });

    // Default → Alpha
    let res = await httpGet(handle.url);
    assert.match(res.body, /alpha body/);
    assert.ok(!res.body.includes('bravo body'));

    // ?agent=bbb → Bravo
    res = await httpGet(`${handle.url}?agent=bbb`);
    assert.match(res.body, /bravo body/);
    assert.ok(!res.body.includes('alpha body'));
  });

  it('re-reads plan.md on every request (live data)', async () => {
    await writeAgent(projectDir, 'writer');
    await writeSubagent(projectDir, 'writer', { name: 'Writer' });
    await writePlanMd(projectDir, 'writer', '# v1 body');

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });

    let res = await httpGet(handle.url);
    assert.match(res.body, /v1 body/);

    // Update plan.md without restarting the server
    await writePlanMd(projectDir, 'writer', '# v2 body');

    res = await httpGet(handle.url);
    assert.match(res.body, /v2 body/);
    assert.ok(!res.body.includes('v1 body'));
  });

  it('renders an empty state when the selected agent has no plan.md', async () => {
    await writeAgent(projectDir, 'orphan');
    await writeSubagent(projectDir, 'orphan', { name: 'Orphan' });
    // no plan.md

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(handle.url);
    assert.match(res.body, /No <code>plan\.md<\/code> yet/);
    assert.match(res.body, /Orphan/);
  });
});
