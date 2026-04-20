/**
 * Tests for `src/serve/tabs-section.js`.
 *
 * Covers the tab-bar rendering functions used in the refactored per-agent
 * horizontal tab navigation introduced in AC 2:
 *   - TABS / DEFAULT_TAB exports
 *   - resolveActiveTab(): falls back to DEFAULT_TAB for unknown values
 *   - renderTabBar(): HTML fragment for the horizontal tab bar
 *   - tabBarStyles(): CSS bundle injected into the shell
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TABS,
  DEFAULT_TAB,
  resolveActiveTab,
  renderTabBar,
  tabBarStyles,
} from './tabs-section.js';

// ───────────────────────────────────────────────────────────────────────
// TABS constant and DEFAULT_TAB
// ───────────────────────────────────────────────────────────────────────

describe('TABS', () => {
  it('exports exactly four tabs in display order', () => {
    assert.equal(TABS.length, 4);
    assert.deepEqual(
      TABS.map((t) => t.id),
      ['calendar', 'activity', 'strategy', 'profile'],
    );
  });

  it('every tab has a non-empty label', () => {
    for (const tab of TABS) {
      assert.ok(typeof tab.label === 'string' && tab.label.length > 0, `tab ${tab.id} has no label`);
    }
  });
});

describe('DEFAULT_TAB', () => {
  it('defaults to "calendar"', () => {
    assert.equal(DEFAULT_TAB, 'calendar');
  });

  it('matches the first tab id in TABS', () => {
    assert.equal(DEFAULT_TAB, TABS[0].id);
  });
});

// ───────────────────────────────────────────────────────────────────────
// resolveActiveTab()
// ───────────────────────────────────────────────────────────────────────

describe('resolveActiveTab()', () => {
  it('returns the tab id when it is a valid tab', () => {
    assert.equal(resolveActiveTab('calendar'), 'calendar');
    assert.equal(resolveActiveTab('activity'), 'activity');
    assert.equal(resolveActiveTab('strategy'), 'strategy');
    assert.equal(resolveActiveTab('profile'), 'profile');
  });

  it('falls back to DEFAULT_TAB for undefined', () => {
    assert.equal(resolveActiveTab(undefined), DEFAULT_TAB);
  });

  it('falls back to DEFAULT_TAB for an empty string', () => {
    assert.equal(resolveActiveTab(''), DEFAULT_TAB);
  });

  it('falls back to DEFAULT_TAB for an unrecognised tab id', () => {
    assert.equal(resolveActiveTab('budget'), DEFAULT_TAB);
    assert.equal(resolveActiveTab('unknown-tab'), DEFAULT_TAB);
  });
});

// ───────────────────────────────────────────────────────────────────────
// tabBarStyles()
// ───────────────────────────────────────────────────────────────────────

describe('tabBarStyles()', () => {
  it('returns a non-empty CSS string', () => {
    const css = tabBarStyles();
    assert.equal(typeof css, 'string');
    assert.ok(css.length > 0);
  });

  it('includes the .tab-bar selector', () => {
    const css = tabBarStyles();
    assert.match(css, /\.tab-bar/);
  });

  it('includes the .tab-list selector', () => {
    const css = tabBarStyles();
    assert.match(css, /\.tab-list/);
  });

  it('includes the active tab selector with accent underline', () => {
    const css = tabBarStyles();
    assert.match(css, /\.tab-link-active/);
    assert.match(css, /var\(--accent\)/);
  });

  it('includes the .tab-link base styles', () => {
    const css = tabBarStyles();
    assert.match(css, /\.tab-link/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderTabBar() — no agent selected
// ───────────────────────────────────────────────────────────────────────

describe('renderTabBar() — no agent selected', () => {
  it('returns an empty string when selectedSlug is undefined', () => {
    const html = renderTabBar(undefined, 'calendar');
    assert.equal(html, '');
  });

  it('returns an empty string when selectedSlug is null', () => {
    const html = renderTabBar(null, 'calendar');
    assert.equal(html, '');
  });

  it('returns an empty string when selectedSlug is an empty string', () => {
    // empty string is falsy — same as no selection
    const html = renderTabBar('', 'calendar');
    assert.equal(html, '');
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderTabBar() — with a selected agent
// ───────────────────────────────────────────────────────────────────────

describe('renderTabBar() — with selected agent', () => {
  it('renders a nav element with data-agent-tabs set to the selected slug', () => {
    const html = renderTabBar('writer', 'calendar');
    assert.match(html, /data-agent-tabs="writer"/);
    assert.match(html, /<nav\b/);
  });

  it('renders exactly four tab items', () => {
    const html = renderTabBar('writer', 'calendar');
    const count = (html.match(/<li\b/g) || []).length;
    assert.equal(count, 4);
  });

  it('renders one tab item per TABS entry', () => {
    const html = renderTabBar('writer', 'calendar');
    for (const tab of TABS) {
      assert.match(html, new RegExp(`data-tab="${tab.id}"`), `missing data-tab="${tab.id}"`);
    }
  });

  it('renders all tab labels', () => {
    const html = renderTabBar('writer', 'calendar');
    for (const tab of TABS) {
      assert.match(html, new RegExp(tab.label), `missing label "${tab.label}"`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderTabBar() — active tab
// ───────────────────────────────────────────────────────────────────────

describe('renderTabBar() — active tab markup', () => {
  it('marks the active tab with tab-item-active class and aria-current="page"', () => {
    const html = renderTabBar('writer', 'activity');
    assert.match(html, /tab-item-active/);
    assert.match(html, /aria-current="page"/);
  });

  it('renders the active tab as a span, not an anchor', () => {
    const html = renderTabBar('writer', 'strategy');
    // The active tab must not generate a navigable link to itself.
    assert.ok(
      !html.includes('href="?agent=writer&amp;tab=strategy"'),
      'active tab must not have a href link to itself',
    );
    // The strategy element must be a <span> carrying aria-current="page".
    assert.match(html, /<span[^>]*data-tab="strategy"/);
    assert.match(html, /aria-current="page"/);
  });

  it('wraps inactive tabs in anchor elements linking to the correct URL', () => {
    const html = renderTabBar('writer', 'calendar');
    // activity, strategy, profile should be links
    assert.match(html, /href="\?agent=writer&amp;tab=activity"/);
    assert.match(html, /href="\?agent=writer&amp;tab=strategy"/);
    assert.match(html, /href="\?agent=writer&amp;tab=profile"/);
  });

  it('the active tab does not generate a link for itself', () => {
    const html = renderTabBar('writer', 'calendar');
    // calendar is active — no link for calendar tab
    assert.ok(
      !html.includes('href="?agent=writer&amp;tab=calendar"'),
      'active tab must not have a link',
    );
  });

  it('defaults to calendar tab when activeTab is undefined', () => {
    const html = renderTabBar('writer', undefined);
    // calendar should be active (no link, has aria-current)
    assert.match(html, /tab-item-active[\s\S]*aria-current="page"/);
    // Other tabs should be links
    assert.match(html, /href="\?agent=writer&amp;tab=activity"/);
  });

  it('defaults to calendar tab for an unknown activeTab value', () => {
    const html = renderTabBar('writer', 'nonexistent-tab');
    assert.match(html, /tab-item-active/);
    // calendar link should be absent (it's the active tab)
    assert.ok(!html.includes('href="?agent=writer&amp;tab=calendar"'));
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderTabBar() — URL encoding
// ───────────────────────────────────────────────────────────────────────

describe('renderTabBar() — URL encoding for agent slugs', () => {
  it('encodes plugin-namespaced slugs in tab links', () => {
    const html = renderTabBar('oh-my-claudecode-writer', 'calendar');
    // Inactive tabs should include the encoded slug
    assert.match(html, /href="\?agent=oh-my-claudecode-writer&amp;tab=activity"/);
    assert.match(html, /data-agent-tabs="oh-my-claudecode-writer"/);
  });

  it('HTML-escapes the slug in data-agent-tabs', () => {
    // Fabricate a slug with an HTML-special character to verify escaping
    const html = renderTabBar('writer&analyst', 'calendar');
    assert.ok(!html.includes('data-agent-tabs="writer&analyst"'));
    assert.match(html, /data-agent-tabs="writer&amp;analyst"/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderTabBar() — accessibility attributes
// ───────────────────────────────────────────────────────────────────────

describe('renderTabBar() — accessibility', () => {
  it('includes aria-label on the nav element', () => {
    const html = renderTabBar('writer', 'calendar');
    assert.match(html, /aria-label="Agent sections"/);
  });

  it('includes role="tablist" on the list', () => {
    const html = renderTabBar('writer', 'calendar');
    assert.match(html, /role="tablist"/);
  });

  it('includes role="presentation" on each list item', () => {
    const html = renderTabBar('writer', 'calendar');
    const count = (html.match(/role="presentation"/g) || []).length;
    assert.equal(count, TABS.length);
  });
});
