/**
 * Sidebar section — agent-picker sidebar for the aweek serve dashboard.
 *
 * Renders the left-hand agent list used in the refactored layout:
 * sidebar (agent picker) + main content area (per-agent horizontal tabs).
 *
 * Each sidebar item shows:
 *   - Agent display name (from .claude/agents/<slug>.md)
 *   - Agent slug in a <code> element
 *   - Status chip  (active / paused / budget-exhausted)
 *   - Usage-percent chip  (when a weekly budget is configured)
 *
 * The currently-selected agent (resolved from the `?agent=` query param)
 * is highlighted with an accent border and rendered as a non-link so
 * pointer users get a clear "current" affordance and screen readers do not
 * announce a no-op link. All other agents link to `?agent=<slug>` so
 * switching agents is a single click that updates the URL without a JS
 * router.
 *
 * The container is tagged with `data-section="agents"` so server-level
 * snapshot tests and HTTP integration tests can locate the agent list in
 * the rendered page without depending on the surrounding layout structure.
 *
 * This module is intentionally pure HTML + data — no DOM, no browser JS.
 * The server injects the result directly into the dashboard shell, which is
 * server-rendered on every request.
 */

/**
 * Render the sidebar body as an HTML string.
 *
 * Returns an empty-state hint when no agents are hired, otherwise a
 * `<ul>` of agent items — one per agent, sorted as supplied (the caller
 * is responsible for ordering; `gatherAgents` returns active → paused →
 * budget-exhausted → alphabetical).
 *
 * @param {Array<{
 *   slug: string,
 *   name: string,
 *   missing: boolean,
 *   status: 'active' | 'paused' | 'budget-exhausted',
 *   tokensUsed: number,
 *   tokenLimit: number,
 *   utilizationPct: number | null,
 * }>} agents
 * @param {string | undefined} selectedSlug  — slug of the currently active agent
 * @returns {string}
 */
export function renderSidebar(agents, selectedSlug) {
  if (!agents || agents.length === 0) {
    return [
      `<div class="sidebar-empty">`,
      `<p>No agents yet.</p>`,
      `<p>Run <code>/aweek:hire</code> to create one.</p>`,
      `</div>`,
    ].join('');
  }

  const items = agents.map((agent) => renderSidebarItem(agent, selectedSlug)).join('');
  return `<ul class="sidebar-list" role="list">${items}</ul>`;
}

/**
 * Render one sidebar list item with name, slug, status chip, and usage chip.
 *
 * Selected items are rendered as `<li>` with plain text content; non-selected
 * items wrap their content in an `<a>` so the browser handles hover / focus
 * styling naturally and the link is keyboard-accessible.
 *
 * @param {{
 *   slug: string,
 *   name: string,
 *   missing: boolean,
 *   status: string,
 *   tokensUsed: number,
 *   tokenLimit: number,
 *   utilizationPct: number | null,
 * }} agent
 * @param {string | undefined} selectedSlug
 * @returns {string}
 */
function renderSidebarItem(agent, selectedSlug) {
  const isSelected = agent.slug === selectedSlug;

  // Status chip — class name mirrors the status value so CSS can colour each
  // state independently without JS.
  const statusLabel = agentStatusLabel(agent.status);
  const statusChip = `<span class="sidebar-chip sidebar-chip-status sidebar-chip-${escapeAttr(agent.status)}" title="${escapeAttr(statusLabel)}">${escapeHtml(statusLabel)}</span>`;

  // Usage chip — only rendered when a weekly budget is set so agents without
  // a budget don't show a meaningless "—%" chip.
  let usageChip = '';
  if (agent.utilizationPct != null) {
    const over = agent.tokenLimit > 0 && agent.tokensUsed >= agent.tokenLimit;
    const chipCls = over
      ? 'sidebar-chip sidebar-chip-usage sidebar-chip-usage-over'
      : 'sidebar-chip sidebar-chip-usage';
    usageChip = `<span class="${chipCls}">${agent.utilizationPct}%</span>`;
  }

  // Missing-subagent marker — shown inline next to the name when the
  // .claude/agents/<slug>.md file is absent.
  const missingMarker = agent.missing
    ? ` <span class="sidebar-missing" title="No .claude/agents/${escapeAttr(agent.slug)}.md found">[missing]</span>`
    : '';

  const inner = [
    `<span class="sidebar-agent-name">${escapeHtml(agent.name)}${missingMarker}</span>`,
    `<span class="sidebar-agent-slug"><code>${escapeHtml(agent.slug)}</code></span>`,
    `<span class="sidebar-agent-chips">${statusChip}${usageChip}</span>`,
  ].join('');

  const liAttrs = [
    `data-agent-slug="${escapeAttr(agent.slug)}"`,
    `data-agent-status="${escapeAttr(agent.status)}"`,
  ].join(' ');

  if (isSelected) {
    return [
      `<li class="sidebar-item sidebar-item-selected" ${liAttrs} aria-current="page">`,
      inner,
      `</li>`,
    ].join('');
  }

  const href = `?agent=${encodeURIComponent(agent.slug)}`;
  return [
    `<li class="sidebar-item" ${liAttrs}>`,
    `<a class="sidebar-item-link" href="${escapeAttr(href)}">`,
    inner,
    `</a>`,
    `</li>`,
  ].join('');
}

/**
 * Map a status value to a short human-readable chip label.
 *
 * Labels are kept lowercase and concise so they fit in the narrow sidebar
 * chip without truncation. The budget-exhausted case is shortened to
 * "exhausted" for the same reason.
 *
 * @param {string} status
 * @returns {string}
 */
export function sidebarStatusLabel(status) {
  switch (status) {
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    case 'budget-exhausted':
      return 'exhausted';
    default:
      return String(status || 'unknown');
  }
}

// Internal alias so renderSidebarItem stays readable.
const agentStatusLabel = sidebarStatusLabel;

/**
 * CSS fragment for the sidebar layout and item styles. Injected into the
 * dashboard shell's `<style>` block via `extraStyles` so this module owns
 * its own styling and the shell stays agnostic about section internals.
 *
 * @returns {string}
 */
export function sidebarStyles() {
  return `
  /* ── Dashboard top-level layout ─────────────────────────────────── */
  .dashboard-layout {
    display: flex;
    align-items: stretch;
    min-height: calc(100vh - 57px - 53px); /* header + footer */
  }

  /* ── Sidebar ─────────────────────────────────────────────────────── */
  .sidebar {
    width: 220px;
    min-width: 180px;
    max-width: 260px;
    flex-shrink: 0;
    background: var(--panel);
    border-right: 1px solid var(--border);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .sidebar-head {
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--muted);
    flex-shrink: 0;
  }
  .sidebar-list {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1;
  }
  .sidebar-item {
    border-bottom: 1px solid var(--border);
    position: relative;
  }
  .sidebar-item:last-child { border-bottom: none; }

  /* Non-selected items are wrapped in an <a>; use the link for interaction. */
  .sidebar-item-link {
    display: block;
    padding: 10px 14px;
    text-decoration: none;
    color: inherit;
    transition: background 100ms ease;
  }
  .sidebar-item-link:hover {
    background: var(--panel-2);
  }
  .sidebar-item-link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  /* Selected item: no <a> wrapper, accent left-border highlight. */
  .sidebar-item-selected {
    padding: 10px 14px 10px 12px;
    border-left: 2px solid var(--accent);
    background: rgba(138, 180, 255, 0.08);
  }

  /* Agent name, slug, and chips inside each item */
  .sidebar-agent-name {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.005em;
    margin-bottom: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sidebar-agent-slug {
    display: block;
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sidebar-agent-slug code {
    font-size: 10.5px;
    background: transparent;
    padding: 0;
    color: inherit;
  }
  .sidebar-agent-chips {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  /* Chips */
  .sidebar-chip {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  /* Status chip colour variants */
  .sidebar-chip-active {
    background: rgba(114, 226, 164, 0.15);
    color: var(--status-completed);
    border: 1px solid rgba(114, 226, 164, 0.3);
  }
  .sidebar-chip-paused {
    background: rgba(139, 147, 167, 0.15);
    color: var(--status-pending);
    border: 1px solid rgba(139, 147, 167, 0.25);
  }
  .sidebar-chip-budget-exhausted {
    background: rgba(255, 107, 107, 0.15);
    color: var(--over-budget);
    border: 1px solid rgba(255, 107, 107, 0.3);
  }
  /* Usage percent chip */
  .sidebar-chip-usage {
    background: rgba(138, 180, 255, 0.12);
    color: var(--accent);
    border: 1px solid rgba(138, 180, 255, 0.2);
  }
  .sidebar-chip-usage-over {
    background: rgba(255, 107, 107, 0.12);
    color: var(--over-budget);
    border: 1px solid rgba(255, 107, 107, 0.25);
  }

  /* Missing subagent marker */
  .sidebar-missing {
    display: inline-block;
    color: var(--critical);
    font-size: 10px;
    font-weight: 500;
    margin-left: 4px;
    vertical-align: 1px;
  }

  /* Empty state */
  .sidebar-empty {
    padding: 16px 14px;
    color: var(--muted);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .sidebar-empty p { margin: 0 0 6px; }
  .sidebar-empty p:last-child { margin-bottom: 0; }

  /* ── Content area (right of sidebar) ────────────────────────────── */
  .content-area {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* ── Zero-agents empty state ─────────────────────────────────────── */
  .zero-agents-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 32px;
    text-align: center;
    color: var(--muted);
  }
  .zero-agents-icon {
    font-size: 48px;
    margin-bottom: 20px;
    opacity: 0.6;
  }
  .zero-agents-title {
    margin: 0 0 12px;
    font-size: 18px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
  }
  .zero-agents-body {
    margin: 0 0 16px;
    font-size: 14px;
    line-height: 1.6;
    max-width: 380px;
  }
  .zero-agents-cta {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.5;
  }
  .zero-agents-cta code {
    font-size: 13px;
    background: rgba(138, 180, 255, 0.12);
    color: var(--accent);
    padding: 2px 7px;
    border-radius: 4px;
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
