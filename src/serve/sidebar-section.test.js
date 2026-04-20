/**
 * Tests for `src/serve/sidebar-section.js`.
 *
 * Covers the sidebar rendering functions used in the refactored
 * agent-picker sidebar layout introduced in AC 1:
 *   - renderSidebar(): HTML fragment with all agents listed
 *   - sidebarStatusLabel(): human-readable chip labels
 *   - sidebarStyles(): CSS bundle injected into the shell
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSidebar,
  sidebarStatusLabel,
  sidebarStyles,
} from './sidebar-section.js';

// ───────────────────────────────────────────────────────────────────────
// sidebarStatusLabel()
// ───────────────────────────────────────────────────────────────────────

describe('sidebarStatusLabel()', () => {
  it('returns lowercase labels for canonical statuses', () => {
    assert.equal(sidebarStatusLabel('active'), 'active');
    assert.equal(sidebarStatusLabel('paused'), 'paused');
    assert.equal(sidebarStatusLabel('budget-exhausted'), 'exhausted');
  });

  it('returns the raw value for unknown statuses', () => {
    assert.equal(sidebarStatusLabel('running'), 'running');
  });

  it('returns "unknown" for empty / null status', () => {
    assert.equal(sidebarStatusLabel(''), 'unknown');
    assert.equal(sidebarStatusLabel(null), 'unknown');
    assert.equal(sidebarStatusLabel(undefined), 'unknown');
  });
});

// ───────────────────────────────────────────────────────────────────────
// sidebarStyles()
// ───────────────────────────────────────────────────────────────────────

describe('sidebarStyles()', () => {
  it('returns a non-empty CSS string', () => {
    const css = sidebarStyles();
    assert.equal(typeof css, 'string');
    assert.ok(css.length > 0);
  });

  it('includes the chip colour selectors for all three statuses', () => {
    const css = sidebarStyles();
    assert.match(css, /\.sidebar-chip-active/);
    assert.match(css, /\.sidebar-chip-paused/);
    assert.match(css, /\.sidebar-chip-budget-exhausted/);
  });

  it('includes the usage chip selectors', () => {
    const css = sidebarStyles();
    assert.match(css, /\.sidebar-chip-usage/);
    assert.match(css, /\.sidebar-chip-usage-over/);
  });

  it('includes the dashboard-layout and content-area flex rules', () => {
    const css = sidebarStyles();
    assert.match(css, /\.dashboard-layout/);
    assert.match(css, /\.content-area/);
    assert.match(css, /\.sidebar/);
  });

  it('includes the selected-item accent border rule', () => {
    const css = sidebarStyles();
    assert.match(css, /\.sidebar-item-selected/);
    assert.match(css, /var\(--accent\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderSidebar() — empty state
// ───────────────────────────────────────────────────────────────────────

describe('renderSidebar() — empty state', () => {
  it('renders an empty state when agents list is empty', () => {
    const html = renderSidebar([]);
    assert.match(html, /sidebar-empty/);
    assert.match(html, /\/aweek:hire/);
  });

  it('renders an empty state when agents is null', () => {
    const html = renderSidebar(null);
    assert.match(html, /sidebar-empty/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderSidebar() — with agents
// ───────────────────────────────────────────────────────────────────────

const SAMPLE_AGENTS = [
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
    description: 'Number cruncher',
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
    tokensUsed: 120_000,
    tokenLimit: 100_000,
    utilizationPct: 120,
  },
];

describe('renderSidebar() — renders all agents', () => {
  it('renders one li per agent', () => {
    const html = renderSidebar(SAMPLE_AGENTS);
    const count = (html.match(/<li /g) || []).length;
    assert.equal(count, 3);
  });

  it('renders agent name in each item', () => {
    const html = renderSidebar(SAMPLE_AGENTS);
    assert.match(html, /Writer/);
    assert.match(html, /Analyst/);
    assert.match(html, /Scribe/);
  });

  it('renders agent slug in a <code> element', () => {
    const html = renderSidebar(SAMPLE_AGENTS);
    assert.match(html, /<code>writer<\/code>/);
    assert.match(html, /<code>analyst<\/code>/);
    assert.match(html, /<code>scribe<\/code>/);
  });

  it('renders status chips for all three status values', () => {
    const html = renderSidebar(SAMPLE_AGENTS);
    assert.match(html, /sidebar-chip-active/);
    assert.match(html, /sidebar-chip-paused/);
    assert.match(html, /sidebar-chip-budget-exhausted/);
  });

  it('renders usage-percent chips when a budget is set', () => {
    const html = renderSidebar(SAMPLE_AGENTS);
    assert.match(html, /10%/);
    assert.match(html, /50%/);
    assert.match(html, /120%/);
  });

  it('does not render a usage chip when utilizationPct is null', () => {
    const agents = [
      {
        slug: 'no-budget',
        name: 'No Budget',
        description: '',
        missing: false,
        status: 'active',
        tokensUsed: 0,
        tokenLimit: 0,
        utilizationPct: null,
      },
    ];
    const html = renderSidebar(agents);
    assert.ok(!html.includes('sidebar-chip-usage'));
  });

  it('uses over-budget chip class when usage >= limit', () => {
    const html = renderSidebar(SAMPLE_AGENTS);
    // scribe: 120k used / 100k limit → over budget chip
    assert.match(html, /sidebar-chip-usage-over/);
  });

  it('does not use over-budget chip class for agents under limit', () => {
    const agents = [SAMPLE_AGENTS[0]]; // writer at 10%
    const html = renderSidebar(agents);
    assert.ok(!html.includes('sidebar-chip-usage-over'));
    assert.match(html, /sidebar-chip-usage/); // plain usage chip
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderSidebar() — selected agent highlighting
// ───────────────────────────────────────────────────────────────────────

describe('renderSidebar() — selected agent', () => {
  it('marks the selected agent with sidebar-item-selected and aria-current', () => {
    const html = renderSidebar(SAMPLE_AGENTS, 'analyst');
    assert.match(html, /sidebar-item-selected[\s\S]*aria-current="page"/);
  });

  it('does not wrap the selected item in an <a> tag', () => {
    const html = renderSidebar(SAMPLE_AGENTS, 'writer');
    // The writer li should NOT contain a sidebar-item-link anchor
    const writerBlock = html.slice(
      html.indexOf('data-agent-slug="writer"'),
      html.indexOf('data-agent-slug="analyst"'),
    );
    assert.ok(!writerBlock.includes('sidebar-item-link'), 'selected item must not be a link');
  });

  it('wraps non-selected items in <a href="?agent=<slug>"> links', () => {
    const html = renderSidebar(SAMPLE_AGENTS, 'writer');
    // analyst and scribe should be links
    assert.match(html, /href="\?agent=analyst"/);
    assert.match(html, /href="\?agent=scribe"/);
  });

  it('URL-encodes slugs with special characters in links', () => {
    const agents = [
      {
        slug: 'oh-my-claudecode-writer',
        name: 'OMC Writer',
        description: '',
        missing: false,
        status: 'active',
        tokensUsed: 0,
        tokenLimit: 0,
        utilizationPct: null,
      },
    ];
    // No selection → rendered as link
    const html = renderSidebar(agents, undefined);
    assert.match(html, /href="\?agent=oh-my-claudecode-writer"/);
  });

  it('renders all items as links when no slug is selected', () => {
    const html = renderSidebar(SAMPLE_AGENTS, undefined);
    const linkCount = (html.match(/sidebar-item-link/g) || []).length;
    assert.equal(linkCount, 3);
    // No selected item
    assert.ok(!html.includes('sidebar-item-selected'));
  });

  it('carries data-agent-slug and data-agent-status on every li', () => {
    const html = renderSidebar(SAMPLE_AGENTS, 'writer');
    assert.match(html, /data-agent-slug="writer"/);
    assert.match(html, /data-agent-slug="analyst"/);
    assert.match(html, /data-agent-slug="scribe"/);
    assert.match(html, /data-agent-status="active"/);
    assert.match(html, /data-agent-status="paused"/);
    assert.match(html, /data-agent-status="budget-exhausted"/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderSidebar() — missing subagent
// ───────────────────────────────────────────────────────────────────────

describe('renderSidebar() — missing subagent marker', () => {
  it('shows [missing] marker when the subagent .md is absent', () => {
    const agents = [
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
    ];
    const html = renderSidebar(agents);
    assert.match(html, /\[missing\]/);
    assert.match(html, /sidebar-missing/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderSidebar() — HTML escaping
// ───────────────────────────────────────────────────────────────────────

describe('renderSidebar() — HTML escaping', () => {
  it('escapes agent name and slug to prevent HTML injection', () => {
    const agents = [
      {
        slug: 'safe-slug',
        name: '<script>alert(1)</script>',
        description: '',
        missing: false,
        status: 'active',
        tokensUsed: 0,
        tokenLimit: 0,
        utilizationPct: null,
      },
    ];
    const html = renderSidebar(agents);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
  });
});
