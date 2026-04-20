/**
 * Tabs section — horizontal tab navigation bar for per-agent content areas.
 *
 * When the user selects an agent via the sidebar (i.e. `?agent=<slug>` is set
 * in the URL), this module renders a horizontal tab bar directly above the
 * content area with four named sections:
 *
 *   Calendar   — weekly task grid for the selected agent
 *   Activity   — activity-log events backed by the activity-log store
 *   Strategy   — rendered plan.md (long-term goals, monthly plans, strategies)
 *   Profile    — agent identity, budget configuration, and status
 *
 * Navigation is URL-only: each tab renders as an `<a href="?agent=<slug>&tab=<id>">`.
 * The active tab uses a `<span>` with `aria-current="page"` instead of a link
 * so screen readers announce it as the current location and keyboard users do
 * not activate a no-op navigation.
 *
 * When no agent is selected the tab bar returns an empty string so the caller
 * can safely interpolate it without an extra guard.
 *
 * This module is intentionally pure HTML + data — no DOM, no browser JS.
 */

/**
 * The four tabs, in display order. `id` is the wire-format value used in
 * `?tab=<id>` query params and in `data-tab` attributes; `label` is the
 * human-readable button text.
 *
 * @type {ReadonlyArray<{ id: string, label: string }>}
 */
export const TABS = [
  { id: 'calendar', label: 'Calendar' },
  { id: 'activity', label: 'Activity' },
  { id: 'strategy', label: 'Strategy' },
  { id: 'profile', label: 'Profile' },
];

/**
 * The tab shown when `?tab=` is absent or contains an unrecognised value.
 * Matches the id of the first entry in `TABS`.
 */
export const DEFAULT_TAB = 'calendar';

/**
 * Resolve the canonical active-tab id.  Falls back to `DEFAULT_TAB` for
 * unrecognised values so callers never need to guard the return value.
 *
 * @param {string | undefined} rawTab
 * @returns {string}
 */
export function resolveActiveTab(rawTab) {
  if (rawTab && TABS.some((t) => t.id === rawTab)) return rawTab;
  return DEFAULT_TAB;
}

/**
 * Render the horizontal tab bar as an HTML string.
 *
 * Returns an empty string when no agent is selected — the caller can
 * interpolate the return value unconditionally.
 *
 * Each tab generates a navigation entry:
 *   - Active tab → `<span aria-current="page">` (no anchor, clear "current" affordance)
 *   - Inactive tab → `<a href="?agent=<slug>&tab=<id>">` (single-click to switch)
 *
 * The container carries `data-agent-tabs="<slug>"` so tests and integration
 * code can assert on the rendered tab bar without parsing CSS class names.
 *
 * @param {string | undefined} selectedSlug  — slug of the currently active agent
 * @param {string | undefined} activeTab     — id of the selected tab (raw from query param)
 * @returns {string}
 */
export function renderTabBar(selectedSlug, activeTab) {
  if (!selectedSlug) return '';

  const resolvedTab = resolveActiveTab(activeTab);

  const items = TABS.map((tab) => {
    const isActive = tab.id === resolvedTab;
    const dataAttr = `data-tab="${escapeAttr(tab.id)}"`;

    if (isActive) {
      return [
        `<li class="tab-item tab-item-active" role="presentation">`,
        `<span class="tab-link tab-link-active" aria-current="page" ${dataAttr}>${escapeHtml(tab.label)}</span>`,
        `</li>`,
      ].join('');
    }

    const href = `?agent=${encodeURIComponent(selectedSlug)}&tab=${encodeURIComponent(tab.id)}`;
    return [
      `<li class="tab-item" role="presentation">`,
      `<a class="tab-link" href="${escapeAttr(href)}" ${dataAttr}>${escapeHtml(tab.label)}</a>`,
      `</li>`,
    ].join('');
  }).join('');

  return [
    `<nav class="tab-bar" aria-label="Agent sections" data-agent-tabs="${escapeAttr(selectedSlug)}">`,
    `<ul class="tab-list" role="tablist">${items}</ul>`,
    `</nav>`,
  ].join('');
}

/**
 * CSS fragment for the tab bar layout and item styles. Injected into the
 * dashboard shell's `<style>` block via `extraStyles` so this module owns
 * its own styling and the shell stays agnostic about section internals.
 *
 * @returns {string}
 */
export function tabBarStyles() {
  return `
  /* ── Tab bar ─────────────────────────────────────────────────────── */
  .tab-bar {
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    padding: 0 16px;
    flex-shrink: 0;
  }
  .tab-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    gap: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab-list::-webkit-scrollbar { display: none; }

  .tab-item {
    display: flex;
    align-items: stretch;
    flex-shrink: 0;
  }

  /* Base link/span styles shared between active and inactive tabs */
  .tab-link {
    display: flex;
    align-items: center;
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.01em;
    color: var(--muted);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    transition: color 100ms ease, border-color 100ms ease;
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
  }
  .tab-link:hover {
    color: var(--text);
  }
  .tab-link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: 2px;
  }

  /* Active tab: accent underline + full text colour */
  .tab-link-active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 600;
    cursor: default;
  }
  `;
}

// ---------------------------------------------------------------------------
// HTML escaping — local copy so this module can be tested in isolation
// without pulling server.js in.
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
