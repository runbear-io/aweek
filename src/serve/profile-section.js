/**
 * Profile section — data gathering + HTML rendering for the `aweek serve`
 * dashboard's "Profile" tab.
 *
 * The Profile tab surfaces three data sources for the selected agent:
 *
 *   1. Identity fields from `.claude/agents/<slug>.md`
 *      — display name, description, file path, missing-marker when absent.
 *
 *   2. Scheduling meta from `.aweek/agents/<slug>.json`
 *      — slug (id), createdAt, updatedAt, paused state, pausedReason,
 *        budget period start.
 *
 *   3. Full budget breakdown
 *      — weeklyTokenBudget limit, current-week tokens used, remaining
 *        tokens, over-budget flag, and utilisation percentage with a
 *        progress bar — reuses the same deriveBudget() calculation as
 *        budget-section.js so the two displays stay in sync.
 *
 * This module is intentionally pure HTML + data — no DOM, no browser JS.
 * The server injects the rendered fragment into the dashboard shell on
 * every request.
 */

import { join } from 'node:path';
import { listAllAgents } from '../storage/agent-helpers.js';
import { readSubagentIdentity } from '../subagents/subagent-file.js';
import { UsageStore, getMondayDate } from '../storage/usage-store.js';
import { loadConfig } from '../storage/config-store.js';

/**
 * Compute budget fields from an agent config + weekly usage totals.
 * Re-implements the same calculation as `deriveBudget` in budget-section.js
 * locally so this module stays self-contained and testable in isolation.
 *
 * @param {{ weeklyTokenBudget?: number, budget?: { weeklyTokenLimit?: number } }} config
 * @param {{ totalTokens?: number }} usage
 * @returns {{
 *   tokenLimit: number,
 *   tokensUsed: number,
 *   remaining: number,
 *   overBudget: boolean,
 *   utilizationPct: number | null,
 * }}
 */
export function deriveProfileBudget(config, usage) {
  const tokenLimit = config?.weeklyTokenBudget || config?.budget?.weeklyTokenLimit || 0;
  const tokensUsed = usage?.totalTokens || 0;
  const overBudget = tokenLimit > 0 && tokensUsed >= tokenLimit;
  const remaining = tokenLimit > 0 ? Math.max(0, tokenLimit - tokensUsed) : 0;
  const utilizationPct =
    tokenLimit > 0 ? Math.round((tokensUsed / tokenLimit) * 100) : null;
  return { tokenLimit, tokensUsed, remaining, overBudget, utilizationPct };
}

/**
 * Gather the data the Profile tab needs.
 *
 * Resolves the selected agent, reads identity from the subagent .md,
 * loads the full agent config JSON, and fetches current-week usage.
 * Falls back to the first agent alphabetically when `selectedSlug` does
 * not match any known agent — consistent with gatherPlans / gatherCalendarView.
 *
 * Errors are absorbed per-agent / per-source so a missing .md or broken
 * usage log for one agent never knocks the whole profile tab offline.
 *
 * @param {object} opts
 * @param {string} opts.projectDir - Project root (contains `.aweek/`).
 * @param {string} [opts.selectedSlug] - Slug from the `?agent=` query param.
 * @returns {Promise<{
 *   agents: Array<{ slug: string, name: string }>,
 *   selected: {
 *     slug: string,
 *     name: string,
 *     description: string,
 *     missing: boolean,
 *     identityPath: string,
 *     createdAt: string | null,
 *     updatedAt: string | null,
 *     paused: boolean,
 *     pausedReason: string | null,
 *     periodStart: string | null,
 *     tokenLimit: number,
 *     tokensUsed: number,
 *     remaining: number,
 *     overBudget: boolean,
 *     utilizationPct: number | null,
 *     weekMonday: string,
 *   } | null,
 * }>}
 */
export async function gatherProfile({ projectDir, selectedSlug } = {}) {
  if (!projectDir) throw new Error('gatherProfile: projectDir is required');
  const agentsDir = join(projectDir, '.aweek', 'agents');

  const configs = await listAllAgents({ dataDir: agentsDir });
  if (configs.length === 0) {
    return { agents: [], selected: null };
  }

  // Build the lightweight agent list for the sidebar (not used here, but
  // returned so the caller has a consistent view shape).
  const agents = await Promise.all(
    configs.map(async (config) => {
      const identity = await readSubagentIdentity(config.id, projectDir).catch(
        () => ({ missing: true, name: '' }),
      );
      const name = identity?.missing ? config.id : identity?.name || config.id;
      return { slug: config.id, name };
    }),
  );
  agents.sort((a, b) => a.name.localeCompare(b.name));

  const selection =
    (selectedSlug && agents.find((a) => a.slug === selectedSlug)) || agents[0];

  // Find the full config for the selected agent.
  const selectedConfig = configs.find((c) => c.id === selection.slug);

  // Honor the project's configured timezone so the Monday anchor matches
  // what the heartbeat and budget-section use. Fall back to UTC on any
  // config load error.
  let timeZone;
  try {
    ({ timeZone } = await loadConfig(agentsDir));
  } catch {
    timeZone = undefined;
  }
  const weekMondayDate = getMondayDate(new Date(), timeZone);
  const usageStore = new UsageStore(agentsDir);

  const [identity, usage] = await Promise.all([
    readSubagentIdentity(selection.slug, projectDir).catch(() => ({
      missing: true,
      name: '',
      description: '',
      path: '',
    })),
    usageStore
      .weeklyTotal(selection.slug, weekMondayDate)
      .catch(() => ({
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        recordCount: 0,
      })),
  ]);

  const budget = deriveProfileBudget(selectedConfig, usage);

  return {
    agents,
    selected: {
      slug: selection.slug,
      name: identity.missing
        ? selection.slug
        : identity.name || selection.slug,
      description: identity.missing ? '' : identity.description || '',
      missing: !!identity.missing,
      identityPath: identity.path || '',
      createdAt: selectedConfig?.createdAt || null,
      updatedAt: selectedConfig?.updatedAt || null,
      paused: !!(selectedConfig?.budget?.paused),
      pausedReason: selectedConfig?.budget?.pausedReason || null,
      periodStart: selectedConfig?.budget?.periodStart || null,
      ...budget,
      weekMonday: weekMondayDate,
    },
  };
}

/**
 * Render the Profile tab body as an HTML string.
 *
 * Three sections:
 *   1. Identity card — name, description, .md path
 *   2. Scheduling meta — created/updated, paused state, period start
 *   3. Budget breakdown — tokens used / limit, progress bar, over-budget flag
 *
 * All dynamic strings are HTML-escaped before interpolation.
 *
 * @param {ReturnType<typeof gatherProfile> extends Promise<infer R> ? R : never} view
 * @returns {string}
 */
export function renderProfileSection(view) {
  const agents = view?.agents || [];
  const selected = view?.selected || null;

  if (agents.length === 0) {
    return [
      `<div class="profile-empty" data-profile-state="no-agents">`,
      `<p>No agents yet.</p>`,
      `<p>Run <code>/aweek:hire</code> to create one.</p>`,
      `</div>`,
    ].join('');
  }

  if (!selected) {
    return `<div class="profile-empty" data-profile-state="no-selection">Select an agent from the sidebar to view their profile.</div>`;
  }

  return [
    `<div class="profile-root" data-agent-slug="${escapeAttr(selected.slug)}">`,
    renderIdentityCard(selected),
    renderSchedulingCard(selected),
    renderBudgetCard(selected),
    `</div>`,
  ].join('');
}

// ---------------------------------------------------------------------------
// Private render helpers
// ---------------------------------------------------------------------------

/**
 * Render the identity card (name, description, .md path).
 *
 * @param {object} selected
 * @returns {string}
 */
function renderIdentityCard(selected) {
  const missingBanner = selected.missing
    ? [
        `<div class="profile-missing-banner">`,
        `<strong>Subagent file missing</strong> — `,
        `<code>.claude/agents/${escapeHtml(selected.slug)}.md</code> was not found.`,
        ` Restore it or re-run <code>/aweek:hire</code>.`,
        `</div>`,
      ].join('')
    : '';

  const descHtml = selected.description
    ? `<p class="profile-desc">${escapeHtml(selected.description)}</p>`
    : '';

  const pathHtml = selected.identityPath
    ? `<div class="profile-field">
        <span class="profile-field-label">File</span>
        <span class="profile-field-value"><code>${escapeHtml(selected.identityPath)}</code></span>
      </div>`
    : '';

  return [
    `<section class="profile-card" aria-labelledby="profile-identity-head">`,
    `<div class="profile-card-head" id="profile-identity-head">Identity</div>`,
    `<div class="profile-card-body">`,
    missingBanner,
    `<h3 class="profile-name">${escapeHtml(selected.name)}</h3>`,
    `<div class="profile-field">`,
    `<span class="profile-field-label">Slug</span>`,
    `<span class="profile-field-value"><code>${escapeHtml(selected.slug)}</code></span>`,
    `</div>`,
    descHtml,
    pathHtml,
    `</div>`,
    `</section>`,
  ].join('');
}

/**
 * Render the scheduling meta card (status, paused reason, timestamps).
 *
 * @param {object} selected
 * @returns {string}
 */
function renderSchedulingCard(selected) {
  const statusLabel = selected.paused
    ? (selected.pausedReason ? `paused (${formatPausedReason(selected.pausedReason)})` : 'paused')
    : 'active';
  const statusCls = selected.paused ? 'profile-status-paused' : 'profile-status-active';

  const periodLine = selected.periodStart
    ? fieldRow('Period start', formatDate(selected.periodStart))
    : '';

  const createdLine = selected.createdAt
    ? fieldRow('Created', formatDate(selected.createdAt))
    : '';

  const updatedLine = selected.updatedAt
    ? fieldRow('Updated', formatDate(selected.updatedAt))
    : '';

  return [
    `<section class="profile-card" aria-labelledby="profile-schedule-head">`,
    `<div class="profile-card-head" id="profile-schedule-head">Scheduling</div>`,
    `<div class="profile-card-body">`,
    `<div class="profile-field">`,
    `<span class="profile-field-label">Status</span>`,
    `<span class="profile-field-value"><span class="profile-status ${statusCls}">${escapeHtml(statusLabel)}</span></span>`,
    `</div>`,
    periodLine,
    createdLine,
    updatedLine,
    `</div>`,
    `</section>`,
  ].join('');
}

/**
 * Render the full budget breakdown card.
 *
 * @param {object} selected
 * @returns {string}
 */
function renderBudgetCard(selected) {
  const { tokenLimit, tokensUsed, remaining, overBudget, utilizationPct, weekMonday } = selected;

  const noBudget = !tokenLimit || tokenLimit <= 0;
  const overCls = overBudget ? ' profile-budget-over' : '';

  const weekLine = weekMonday
    ? `<div class="profile-budget-week">Week of <time datetime="${escapeAttr(weekMonday)}">${escapeHtml(weekMonday)}</time></div>`
    : '';

  if (noBudget) {
    return [
      `<section class="profile-card" aria-labelledby="profile-budget-head">`,
      `<div class="profile-card-head" id="profile-budget-head">Budget</div>`,
      `<div class="profile-card-body">`,
      weekLine,
      `<div class="profile-field">`,
      `<span class="profile-field-label">Weekly limit</span>`,
      `<span class="profile-field-value profile-muted">no budget set</span>`,
      `</div>`,
      `<div class="profile-field">`,
      `<span class="profile-field-label">Tokens used</span>`,
      `<span class="profile-field-value">${escapeHtml(formatTokens(tokensUsed))}</span>`,
      `</div>`,
      `</div>`,
      `</section>`,
    ].join('');
  }

  const pctLabel = utilizationPct != null ? `${utilizationPct}%` : '—';
  const barFill = Math.max(0, Math.min(100, utilizationPct ?? 0));
  const overTag = overBudget
    ? `<span class="profile-over-tag">OVER BUDGET</span>`
    : '';

  return [
    `<section class="profile-card${overCls}" aria-labelledby="profile-budget-head">`,
    `<div class="profile-card-head" id="profile-budget-head">Budget</div>`,
    `<div class="profile-card-body">`,
    weekLine,
    `<div class="profile-field">`,
    `<span class="profile-field-label">Tokens used</span>`,
    `<span class="profile-field-value${overBudget ? ' profile-over-budget-text' : ''}">`,
    `${escapeHtml(formatTokens(tokensUsed))} / ${escapeHtml(formatTokens(tokenLimit))} ${overTag}`,
    `</span>`,
    `</div>`,
    `<div class="profile-field">`,
    `<span class="profile-field-label">Utilisation</span>`,
    `<span class="profile-field-value${overBudget ? ' profile-over-budget-text' : ''}">${escapeHtml(pctLabel)}</span>`,
    `</div>`,
    `<div class="profile-progress-track" role="progressbar"`,
    ` aria-valuenow="${utilizationPct ?? 0}"`,
    ` aria-valuemin="0"`,
    ` aria-valuemax="100">`,
    `<span class="profile-progress-fill${overBudget ? ' over' : ''}" style="width:${barFill}%"></span>`,
    `</div>`,
    `<div class="profile-field">`,
    `<span class="profile-field-label">${overBudget ? 'Exceeded by' : 'Remaining'}</span>`,
    `<span class="profile-field-value profile-muted">`,
    overBudget
      ? `${escapeHtml(formatTokens(tokensUsed - tokenLimit))} tokens`
      : `${escapeHtml(formatTokens(remaining))} tokens`,
    `</span>`,
    `</div>`,
    `</div>`,
    `</section>`,
  ].join('');
}

/**
 * Render a `<div class="profile-field">` label/value pair.
 *
 * @param {string} label
 * @param {string} value - Already-escaped or safe HTML.
 * @returns {string}
 */
function fieldRow(label, value) {
  return [
    `<div class="profile-field">`,
    `<span class="profile-field-label">${escapeHtml(label)}</span>`,
    `<span class="profile-field-value">${value}</span>`,
    `</div>`,
  ].join('');
}

/**
 * Map a `pausedReason` enum value to a short human-readable label.
 *
 * @param {string | null} reason
 * @returns {string}
 */
function formatPausedReason(reason) {
  switch (reason) {
    case 'budget_exhausted':
      return 'budget exhausted';
    case 'subagent_missing':
      return 'subagent missing';
    case 'manual':
      return 'manual';
    default:
      return reason ? String(reason) : '';
  }
}

/**
 * Format an ISO date-time string to a compact local-style label.
 *
 * @param {string} iso
 * @returns {string}
 */
function formatDate(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return escapeHtml(iso);
  const d = new Date(ms);
  return escapeHtml(
    d.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
  );
}

/**
 * Compact token formatter (e.g. 12_345 → "12.3k").
 *
 * @param {number} n
 * @returns {string}
 */
export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(v);
}

/**
 * CSS fragment for the profile section. Injected into the dashboard shell's
 * `<style>` block via `extraStyles` so this module owns its own styling and
 * the shell stays agnostic about section internals.
 *
 * @returns {string}
 */
export function profileSectionStyles() {
  return `
  /* ── Profile tab ─────────────────────────────────────────────────── */
  .profile-root {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .profile-card {
    border-bottom: 1px solid var(--border);
    padding: 0;
  }
  .profile-card:last-child { border-bottom: none; }

  .profile-card.profile-budget-over {
    background: rgba(255, 107, 107, 0.04);
    border-left: 2px solid var(--over-budget);
  }

  .profile-card-head {
    padding: 10px 16px 8px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    background: var(--panel-2);
  }

  .profile-card-body {
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Identity card: name + description */
  .profile-name {
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text);
  }

  .profile-desc {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
    line-height: 1.5;
  }

  /* Missing-subagent banner */
  .profile-missing-banner {
    padding: 8px 10px;
    background: rgba(255, 107, 107, 0.1);
    border: 1px solid rgba(255, 107, 107, 0.3);
    border-radius: 6px;
    font-size: 12.5px;
    color: var(--critical);
    line-height: 1.5;
    margin-bottom: 4px;
  }
  .profile-missing-banner strong { font-weight: 700; }

  /* Field row: label + value */
  .profile-field {
    display: grid;
    grid-template-columns: 110px 1fr;
    align-items: baseline;
    gap: 8px;
    font-size: 12.5px;
  }

  .profile-field-label {
    color: var(--muted);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }

  .profile-field-value {
    color: var(--text);
    word-break: break-all;
  }
  .profile-field-value code {
    font-size: 11.5px;
    word-break: break-all;
  }

  .profile-muted {
    color: var(--muted);
    font-style: italic;
  }

  /* Status chip */
  .profile-status {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    border: 1px solid currentColor;
  }
  .profile-status-active {
    color: var(--status-completed);
  }
  .profile-status-paused {
    color: var(--status-pending);
  }

  /* Budget card */
  .profile-budget-week {
    font-size: 11.5px;
    color: var(--muted);
    letter-spacing: 0.02em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .profile-over-budget-text {
    color: var(--over-budget);
    font-weight: 600;
  }

  .profile-over-tag {
    display: inline-block;
    margin-left: 8px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--over-budget);
    color: var(--over-budget);
    background: rgba(255, 107, 107, 0.08);
    vertical-align: 1px;
  }

  .profile-progress-track {
    position: relative;
    width: 100%;
    height: 6px;
    background: var(--panel-2);
    border-radius: 3px;
    overflow: hidden;
    margin: 2px 0;
  }
  .profile-progress-fill {
    display: block;
    height: 100%;
    background: var(--status-completed);
    transition: width 0.2s ease;
    border-radius: 3px;
  }
  .profile-progress-fill.over {
    background: var(--over-budget);
  }

  /* Empty state */
  .profile-empty {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
    padding: 4px 0;
  }
  .profile-empty p { margin: 0 0 8px; }
  .profile-empty p:last-child { margin-bottom: 0; }
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
