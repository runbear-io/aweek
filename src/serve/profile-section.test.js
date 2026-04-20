/**
 * Tests for the profile-section module.
 *
 * The Profile section is the fourth tab ("Profile") in the per-agent
 * horizontal tab navigation introduced in the sidebar-layout refactor.
 * It is rendered inside the `.content-area` only when an agent is
 * selected in the left sidebar and `?tab=profile` is active.
 *
 * Covers:
 *   - deriveProfileBudget() — budget math with and without a limit
 *   - renderProfileSection() — empty states, missing-subagent banner,
 *     identity card, scheduling card, full budget breakdown
 *   - renderProfileSection() — per-agent tab layout wiring:
 *       · sidebar-driven no-selection guidance
 *       · data-agent-slug ties content to the selected sidebar agent
 *       · layout is a vertical column, not a 2×2 grid panel
 *   - profileSectionStyles() — returns a non-empty CSS string without
 *     any 2×2 grid assumptions
 *   - formatTokens() — compact token formatter
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveProfileBudget,
  renderProfileSection,
  profileSectionStyles,
  formatTokens,
} from './profile-section.js';

// ---------------------------------------------------------------------------
// deriveProfileBudget
// ---------------------------------------------------------------------------

describe('deriveProfileBudget', () => {
  it('returns zero utilisation when no budget is set', () => {
    const result = deriveProfileBudget({}, { totalTokens: 500 });
    assert.strictEqual(result.tokenLimit, 0);
    assert.strictEqual(result.tokensUsed, 500);
    assert.strictEqual(result.remaining, 0);
    assert.strictEqual(result.overBudget, false);
    assert.strictEqual(result.utilizationPct, null);
  });

  it('reads weeklyTokenBudget from config', () => {
    const result = deriveProfileBudget(
      { weeklyTokenBudget: 10000 },
      { totalTokens: 2500 },
    );
    assert.strictEqual(result.tokenLimit, 10000);
    assert.strictEqual(result.tokensUsed, 2500);
    assert.strictEqual(result.remaining, 7500);
    assert.strictEqual(result.overBudget, false);
    assert.strictEqual(result.utilizationPct, 25);
  });

  it('falls back to budget.weeklyTokenLimit for legacy configs', () => {
    const result = deriveProfileBudget(
      { budget: { weeklyTokenLimit: 8000 } },
      { totalTokens: 8000 },
    );
    assert.strictEqual(result.tokenLimit, 8000);
    assert.strictEqual(result.overBudget, true);
    assert.strictEqual(result.remaining, 0);
    assert.strictEqual(result.utilizationPct, 100);
  });

  it('flags overBudget when tokensUsed >= tokenLimit', () => {
    const result = deriveProfileBudget(
      { weeklyTokenBudget: 1000 },
      { totalTokens: 1500 },
    );
    assert.strictEqual(result.overBudget, true);
    assert.strictEqual(result.remaining, 0);
    assert.strictEqual(result.utilizationPct, 150);
  });

  it('handles null/undefined config and usage gracefully', () => {
    const result = deriveProfileBudget(null, null);
    assert.strictEqual(result.tokenLimit, 0);
    assert.strictEqual(result.tokensUsed, 0);
    assert.strictEqual(result.overBudget, false);
    assert.strictEqual(result.utilizationPct, null);
  });
});

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe('formatTokens', () => {
  it('formats small numbers as plain integers', () => {
    assert.strictEqual(formatTokens(0), '0');
    assert.strictEqual(formatTokens(999), '999');
  });

  it('formats thousands with one decimal place for < 10k', () => {
    assert.strictEqual(formatTokens(1234), '1.2k');
    assert.strictEqual(formatTokens(9999), '10.0k');
  });

  it('formats tens of thousands without decimal', () => {
    assert.strictEqual(formatTokens(12345), '12k');
  });

  it('formats millions with one decimal', () => {
    assert.strictEqual(formatTokens(1_500_000), '1.5M');
  });
});

// ---------------------------------------------------------------------------
// renderProfileSection — empty states
// ---------------------------------------------------------------------------

describe('renderProfileSection — empty states', () => {
  it('renders no-agents empty state when agents array is empty', () => {
    const html = renderProfileSection({ agents: [], selected: null });
    assert.ok(
      html.includes('data-profile-state="no-agents"'),
      'should include no-agents state marker',
    );
    assert.ok(html.includes('/aweek:hire'), 'should include hire CTA');
  });

  it('renders no-selection empty state when selected is null but agents exist', () => {
    const html = renderProfileSection({
      agents: [{ slug: 'alpha', name: 'Alpha' }],
      selected: null,
    });
    assert.ok(
      html.includes('data-profile-state="no-selection"'),
      'should include no-selection state marker',
    );
  });

  it('returns no-agents state for null/undefined view', () => {
    const html = renderProfileSection(null);
    assert.ok(html.includes('data-profile-state="no-agents"'));
  });
});

// ---------------------------------------------------------------------------
// renderProfileSection — identity card
// ---------------------------------------------------------------------------

describe('renderProfileSection — identity card', () => {
  const baseView = {
    agents: [{ slug: 'alpha', name: 'Alpha' }],
    selected: {
      slug: 'alpha',
      name: 'Alpha Agent',
      description: 'Does alpha things',
      missing: false,
      identityPath: '/project/.claude/agents/alpha.md',
      createdAt: '2025-01-15T10:00:00Z',
      updatedAt: '2025-03-20T15:30:00Z',
      paused: false,
      pausedReason: null,
      periodStart: null,
      tokenLimit: 50000,
      tokensUsed: 12500,
      remaining: 37500,
      overBudget: false,
      utilizationPct: 25,
      weekMonday: '2025-03-17',
    },
  };

  it('includes agent slug in data-agent-slug attribute', () => {
    const html = renderProfileSection(baseView);
    assert.ok(
      html.includes('data-agent-slug="alpha"'),
      'should include data-agent-slug attribute',
    );
  });

  it('renders agent display name', () => {
    const html = renderProfileSection(baseView);
    assert.ok(html.includes('Alpha Agent'), 'should include display name');
  });

  it('renders agent description', () => {
    const html = renderProfileSection(baseView);
    assert.ok(html.includes('Does alpha things'), 'should include description');
  });

  it('renders identity file path as code', () => {
    const html = renderProfileSection(baseView);
    assert.ok(
      html.includes('/project/.claude/agents/alpha.md'),
      'should include identity path',
    );
  });

  it('renders the slug in a code element', () => {
    const html = renderProfileSection(baseView);
    assert.ok(html.includes('<code>alpha</code>'), 'should render slug in code tag');
  });

  it('shows missing-subagent banner when identity is missing', () => {
    const view = {
      ...baseView,
      selected: {
        ...baseView.selected,
        missing: true,
        name: 'alpha',
        description: '',
        identityPath: '/project/.claude/agents/alpha.md',
      },
    };
    const html = renderProfileSection(view);
    assert.ok(
      html.includes('profile-missing-banner'),
      'should include missing banner',
    );
    assert.ok(html.includes('Subagent file missing'), 'should explain the issue');
    assert.ok(html.includes('/aweek:hire'), 'should include hire CTA');
  });

  it('does not show missing banner when subagent file exists', () => {
    const html = renderProfileSection(baseView);
    assert.ok(
      !html.includes('profile-missing-banner'),
      'should not include missing banner when file exists',
    );
  });
});

// ---------------------------------------------------------------------------
// renderProfileSection — scheduling card
// ---------------------------------------------------------------------------

describe('renderProfileSection — scheduling card', () => {
  const makeView = (overrides = {}) => ({
    agents: [{ slug: 'beta', name: 'Beta' }],
    selected: {
      slug: 'beta',
      name: 'Beta Agent',
      description: '',
      missing: false,
      identityPath: '/project/.claude/agents/beta.md',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: null,
      paused: false,
      pausedReason: null,
      periodStart: '2025-03-17T00:00:00Z',
      tokenLimit: 0,
      tokensUsed: 0,
      remaining: 0,
      overBudget: false,
      utilizationPct: null,
      weekMonday: '2025-03-17',
      ...overrides,
    },
  });

  it('shows "active" status chip when not paused', () => {
    const html = renderProfileSection(makeView({ paused: false }));
    assert.ok(
      html.includes('profile-status-active'),
      'should show active status class',
    );
    assert.ok(html.includes('active'), 'should show active label');
  });

  it('shows "paused" status when paused with no reason', () => {
    const html = renderProfileSection(makeView({ paused: true, pausedReason: null }));
    assert.ok(
      html.includes('profile-status-paused'),
      'should show paused status class',
    );
  });

  it('shows paused reason when available', () => {
    const html = renderProfileSection(
      makeView({ paused: true, pausedReason: 'budget_exhausted' }),
    );
    assert.ok(
      html.includes('budget exhausted'),
      'should include formatted paused reason',
    );
  });

  it('shows "manual" paused reason', () => {
    const html = renderProfileSection(
      makeView({ paused: true, pausedReason: 'manual' }),
    );
    assert.ok(html.includes('manual'), 'should include manual reason');
  });

  it('shows "subagent missing" paused reason', () => {
    const html = renderProfileSection(
      makeView({ paused: true, pausedReason: 'subagent_missing' }),
    );
    assert.ok(html.includes('subagent missing'), 'should include subagent missing reason');
  });

  it('renders createdAt date', () => {
    const html = renderProfileSection(makeView({ createdAt: '2025-01-01T00:00:00Z' }));
    // Just check "Created" label is present; exact locale formatting varies
    assert.ok(html.includes('Created'), 'should include Created label');
  });

  it('renders updatedAt when provided', () => {
    const html = renderProfileSection(
      makeView({ updatedAt: '2025-03-20T15:30:00Z' }),
    );
    assert.ok(html.includes('Updated'), 'should include Updated label');
  });
});

// ---------------------------------------------------------------------------
// renderProfileSection — budget card
// ---------------------------------------------------------------------------

describe('renderProfileSection — budget card (no budget)', () => {
  it('shows "no budget set" when tokenLimit is 0', () => {
    const view = {
      agents: [{ slug: 'gamma', name: 'Gamma' }],
      selected: {
        slug: 'gamma',
        name: 'Gamma',
        description: '',
        missing: false,
        identityPath: '',
        createdAt: null,
        updatedAt: null,
        paused: false,
        pausedReason: null,
        periodStart: null,
        tokenLimit: 0,
        tokensUsed: 300,
        remaining: 0,
        overBudget: false,
        utilizationPct: null,
        weekMonday: '2025-03-17',
      },
    };
    const html = renderProfileSection(view);
    assert.ok(html.includes('no budget set'), 'should indicate no budget');
  });

  it('still shows tokens used when no budget is configured', () => {
    const view = {
      agents: [{ slug: 'gamma', name: 'Gamma' }],
      selected: {
        slug: 'gamma',
        name: 'Gamma',
        description: '',
        missing: false,
        identityPath: '',
        createdAt: null,
        updatedAt: null,
        paused: false,
        pausedReason: null,
        periodStart: null,
        tokenLimit: 0,
        tokensUsed: 1500,
        remaining: 0,
        overBudget: false,
        utilizationPct: null,
        weekMonday: '2025-03-17',
      },
    };
    const html = renderProfileSection(view);
    assert.ok(html.includes('1.5k'), 'should format tokens used');
  });
});

describe('renderProfileSection — budget card (with budget)', () => {
  const makeView = (overrides = {}) => ({
    agents: [{ slug: 'delta', name: 'Delta' }],
    selected: {
      slug: 'delta',
      name: 'Delta Agent',
      description: '',
      missing: false,
      identityPath: '/project/.claude/agents/delta.md',
      createdAt: null,
      updatedAt: null,
      paused: false,
      pausedReason: null,
      periodStart: null,
      tokenLimit: 100000,
      tokensUsed: 25000,
      remaining: 75000,
      overBudget: false,
      utilizationPct: 25,
      weekMonday: '2025-03-17',
      ...overrides,
    },
  });

  it('renders tokens used and limit', () => {
    const html = renderProfileSection(makeView());
    assert.ok(html.includes('25k'), 'should include used tokens');
    assert.ok(html.includes('100k'), 'should include token limit');
  });

  it('renders utilisation percentage', () => {
    const html = renderProfileSection(makeView());
    assert.ok(html.includes('25%'), 'should include utilisation pct');
  });

  it('renders progress bar with correct fill percentage', () => {
    const html = renderProfileSection(makeView());
    assert.ok(
      html.includes('width:25%'),
      'should set progress bar fill to 25%',
    );
  });

  it('renders remaining tokens', () => {
    const html = renderProfileSection(makeView());
    assert.ok(html.includes('Remaining'), 'should include Remaining label');
    assert.ok(html.includes('75k'), 'should include remaining token count');
  });

  it('renders week-of date', () => {
    const html = renderProfileSection(makeView());
    assert.ok(html.includes('2025-03-17'), 'should include weekMonday date');
  });

  it('shows OVER BUDGET tag when overBudget is true', () => {
    const html = renderProfileSection(
      makeView({
        tokensUsed: 120000,
        remaining: 0,
        overBudget: true,
        utilizationPct: 120,
      }),
    );
    assert.ok(html.includes('OVER BUDGET'), 'should show OVER BUDGET tag');
  });

  it('shows over-budget card class when over budget', () => {
    const html = renderProfileSection(
      makeView({
        tokensUsed: 120000,
        remaining: 0,
        overBudget: true,
        utilizationPct: 120,
      }),
    );
    assert.ok(
      html.includes('profile-budget-over'),
      'should add profile-budget-over class to card',
    );
  });

  it('shows "Exceeded by" instead of "Remaining" when over budget', () => {
    const html = renderProfileSection(
      makeView({
        tokenLimit: 100000,
        tokensUsed: 120000,
        remaining: 0,
        overBudget: true,
        utilizationPct: 120,
      }),
    );
    assert.ok(html.includes('Exceeded by'), 'should show Exceeded by label');
    assert.ok(!html.includes('>Remaining<'), 'should not show Remaining label');
  });

  it('caps progress bar at 100% for over-budget agents', () => {
    const html = renderProfileSection(
      makeView({
        tokensUsed: 150000,
        remaining: 0,
        overBudget: true,
        utilizationPct: 150,
      }),
    );
    // Fill must not exceed width:100%
    assert.ok(html.includes('width:100%'), 'should cap progress bar at 100%');
  });

  it('adds over class to progress fill when over budget', () => {
    const html = renderProfileSection(
      makeView({
        tokensUsed: 110000,
        remaining: 0,
        overBudget: true,
        utilizationPct: 110,
      }),
    );
    assert.ok(
      html.includes('profile-progress-fill over'),
      'should add over class to progress fill',
    );
  });
});

// ---------------------------------------------------------------------------
// renderProfileSection — HTML escaping
// ---------------------------------------------------------------------------

describe('renderProfileSection — HTML escaping', () => {
  it('escapes XSS in agent name', () => {
    const view = {
      agents: [{ slug: 'xss', name: '<script>evil</script>' }],
      selected: {
        slug: 'xss',
        name: '<script>evil</script>',
        description: 'desc',
        missing: false,
        identityPath: '/path/xss.md',
        createdAt: null,
        updatedAt: null,
        paused: false,
        pausedReason: null,
        periodStart: null,
        tokenLimit: 0,
        tokensUsed: 0,
        remaining: 0,
        overBudget: false,
        utilizationPct: null,
        weekMonday: '2025-03-17',
      },
    };
    const html = renderProfileSection(view);
    assert.ok(!html.includes('<script>'), 'should escape script tags in name');
    assert.ok(html.includes('&lt;script&gt;'), 'should HTML-encode angle brackets');
  });

  it('escapes XSS in description', () => {
    const view = {
      agents: [{ slug: 'xss2', name: 'XSS2' }],
      selected: {
        slug: 'xss2',
        name: 'XSS2',
        description: '<img src=x onerror=alert(1)>',
        missing: false,
        identityPath: '',
        createdAt: null,
        updatedAt: null,
        paused: false,
        pausedReason: null,
        periodStart: null,
        tokenLimit: 0,
        tokensUsed: 0,
        remaining: 0,
        overBudget: false,
        utilizationPct: null,
        weekMonday: '2025-03-17',
      },
    };
    const html = renderProfileSection(view);
    assert.ok(!html.includes('<img'), 'should escape img tag in description');
  });
});

// ---------------------------------------------------------------------------
// renderProfileSection — per-agent tab layout wiring
// ---------------------------------------------------------------------------

describe('renderProfileSection — per-agent tab layout wiring', () => {
  const baseView = {
    agents: [{ slug: 'alpha', name: 'Alpha' }],
    selected: {
      slug: 'alpha',
      name: 'Alpha Agent',
      description: 'Does alpha things',
      missing: false,
      identityPath: '/project/.claude/agents/alpha.md',
      createdAt: '2025-01-15T10:00:00Z',
      updatedAt: null,
      paused: false,
      pausedReason: null,
      periodStart: null,
      tokenLimit: 50000,
      tokensUsed: 12500,
      remaining: 37500,
      overBudget: false,
      utilizationPct: 25,
      weekMonday: '2025-03-17',
    },
  };

  it('no-selection state guides the user to pick an agent from the sidebar', () => {
    // When an agent is selected in the sidebar, server passes selected !== null.
    // When nothing is selected yet, the content area shows a sidebar prompt,
    // not a 2×2 grid cell placeholder.
    const html = renderProfileSection({
      agents: [{ slug: 'alpha', name: 'Alpha' }],
      selected: null,
    });
    assert.ok(
      html.includes('sidebar'),
      'no-selection message should reference the sidebar (not a grid)',
    );
    assert.ok(
      html.includes('data-profile-state="no-selection"'),
      'should carry the no-selection state marker',
    );
  });

  it('renders profile-root directly in the content area — not wrapped in a grid cell', () => {
    // The profile-root element is the direct content container for the tab.
    // It must NOT be nested inside any 2×2 grid structure (e.g. .dashboard-grid,
    // .grid-cell, .section-card). We verify by checking the root wrapper class.
    const html = renderProfileSection(baseView);
    assert.ok(html.startsWith('<div class="profile-root"'), 'outermost element should be profile-root');
    assert.ok(!html.includes('dashboard-grid'), 'must not reference the old 2x2 grid class');
    assert.ok(!html.includes('grid-cell'), 'must not wrap content in a grid cell');
  });

  it('data-agent-slug attribute ties the section to the active sidebar selection', () => {
    // The sidebar renders each agent as ?agent=<slug>; the server passes that
    // slug down to gatherProfile / renderProfileSection as the selected agent.
    // The rendered fragment must carry data-agent-slug so the UI can correlate.
    const html = renderProfileSection(baseView);
    assert.match(html, /data-agent-slug="alpha"/, 'should carry data-agent-slug matching the selected sidebar item');
  });

  it('changes content when a different agent is selected via the sidebar', () => {
    // Each sidebar click swaps ?agent=<slug> in the URL; the server re-renders
    // with a fresh gatherProfile result. The fragment must reflect the new slug.
    const view2 = {
      agents: [
        { slug: 'alpha', name: 'Alpha' },
        { slug: 'beta', name: 'Beta' },
      ],
      selected: {
        slug: 'beta',
        name: 'Beta Agent',
        description: 'Second agent',
        missing: false,
        identityPath: '/project/.claude/agents/beta.md',
        createdAt: null,
        updatedAt: null,
        paused: false,
        pausedReason: null,
        periodStart: null,
        tokenLimit: 0,
        tokensUsed: 0,
        remaining: 0,
        overBudget: false,
        utilizationPct: null,
        weekMonday: '2025-03-17',
      },
    };
    const html = renderProfileSection(view2);
    assert.match(html, /data-agent-slug="beta"/, 'content must reflect beta, not alpha');
    assert.ok(!html.includes('data-agent-slug="alpha"'), 'old agent slug must not appear');
  });

  it('exactly one agent selected at a time — profile-root appears exactly once', () => {
    // The sidebar enforces single-selection; the rendered profile must not
    // duplicate the root container for multiple agents.
    const html = renderProfileSection(baseView);
    const count = (html.match(/class="profile-root"/g) || []).length;
    assert.equal(count, 1, 'profile-root must appear exactly once per render');
  });
});

// ---------------------------------------------------------------------------
// profileSectionStyles
// ---------------------------------------------------------------------------

describe('profileSectionStyles', () => {
  it('returns a non-empty CSS string', () => {
    const css = profileSectionStyles();
    assert.ok(typeof css === 'string', 'should return a string');
    assert.ok(css.length > 0, 'should not be empty');
  });

  it('includes .profile-root class', () => {
    assert.ok(profileSectionStyles().includes('.profile-root'));
  });

  it('includes .profile-card class', () => {
    assert.ok(profileSectionStyles().includes('.profile-card'));
  });

  it('includes progress bar styles', () => {
    assert.ok(profileSectionStyles().includes('.profile-progress-track'));
    assert.ok(profileSectionStyles().includes('.profile-progress-fill'));
  });

  it('includes over-budget styling', () => {
    assert.ok(profileSectionStyles().includes('.profile-budget-over'));
    assert.ok(profileSectionStyles().includes('.profile-over-tag'));
  });

  it('profile-root uses flex column layout, not a 2×2 grid', () => {
    // In the old 2×2 grid layout, section cards sat inside a CSS grid with
    // grid-template-columns. The new layout uses a vertical flex column inside
    // the content-area controlled by the sidebar. Verify the profile-root rule
    // uses flex, not grid-template-columns.
    const css = profileSectionStyles();
    // Extract the .profile-root rule block
    const rootMatch = css.match(/\.profile-root\s*\{([^}]+)\}/);
    assert.ok(rootMatch, '.profile-root rule must exist in profileSectionStyles()');
    const rootRule = rootMatch[1];
    assert.ok(
      rootRule.includes('flex-direction: column') || rootRule.includes('flex-direction:column'),
      '.profile-root should use flex column layout',
    );
    assert.ok(
      !rootRule.includes('grid-template-columns'),
      '.profile-root must not use grid-template-columns (2×2 grid artifact)',
    );
  });

  it('does not define any top-level 2×2 dashboard grid selectors', () => {
    // profileSectionStyles() owns only profile-tab CSS. It must not define
    // .dashboard-grid or .grid-cell selectors that belong to the old layout.
    const css = profileSectionStyles();
    assert.ok(!css.includes('.dashboard-grid'), 'must not include old .dashboard-grid selector');
    assert.ok(!css.includes('.grid-cell'), 'must not include old .grid-cell selector');
  });
});
