/**
 * Strategy tab section — HTML rendering for the `aweek serve` dashboard's
 * "Strategy" tab.
 *
 * The Strategy tab shows the selected agent's plan.md content (long-term
 * goals, monthly plans, and strategies) without the legacy agent picker.
 * In the new sidebar-plus-tabs layout the agent is already selected via the
 * sidebar, so only the plan body is rendered here.
 *
 * Reuses `gatherPlans` and `renderMarkdown` from the plan-section module so
 * there is a single code path for reading and rendering plan.md — this module
 * is purely a presentation adapter for the tab context.
 */

import { gatherPlans, renderMarkdown } from './plan-section.js';

/**
 * Gather the data the strategy tab needs. Delegates to `gatherPlans` — same
 * shape, same error-absorption behaviour.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {string} [opts.selectedSlug]
 * @returns {Promise<{
 *   agents: Array<{ slug: string, name: string }>,
 *   selected: { slug: string, name: string, markdown: string | null, hasPlan: boolean } | null,
 * }>}
 */
export async function gatherStrategy({ projectDir, selectedSlug } = {}) {
  return gatherPlans({ projectDir, selectedSlug });
}

/**
 * Render the strategy tab body for the selected agent.
 *
 * Renders plan.md as formatted HTML when the file exists, otherwise shows a
 * helpful empty state with a CTA pointing to `/aweek:plan`. No agent picker
 * is shown — the sidebar handles agent switching in the new layout.
 *
 * @param {{
 *   selected: { slug: string, name: string, markdown: string | null, hasPlan: boolean } | null,
 * } | null} strategy
 * @returns {string}
 */
export function renderStrategySection(strategy) {
  const selected = strategy?.selected ?? null;

  if (!selected) {
    return `<div class="strategy-empty">Select an agent from the sidebar to view their strategy.</div>`;
  }

  if (!selected.hasPlan) {
    return [
      `<div class="strategy-empty">`,
      `No strategy yet for <strong>${escapeHtml(selected.name)}</strong>.`,
      ` Run <code>/aweek:plan</code> to draft long-term goals, monthly plans, and strategies.`,
      `</div>`,
    ].join('');
  }

  const rendered = renderMarkdown(selected.markdown);
  return `<article class="strategy-body" data-agent-slug="${escapeAttr(selected.slug)}">${rendered}</article>`;
}

/**
 * CSS fragment for the strategy tab content area. Reuses plan rendering
 * classes (.plan-h1, .plan-h2, etc.) from planSectionStyles, which are
 * already injected by the server. This block covers only the strategy-
 * specific container and empty-state styles.
 *
 * @returns {string}
 */
export function strategySectionStyles() {
  return `
  .strategy-body {
    font-size: 13.5px;
    line-height: 1.55;
  }
  .strategy-body > *:first-child { margin-top: 0; }
  .strategy-body > *:last-child { margin-bottom: 0; }
  .strategy-empty {
    color: var(--muted);
    font-style: italic;
  }
  .strategy-empty strong { color: var(--text); font-style: normal; }
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
