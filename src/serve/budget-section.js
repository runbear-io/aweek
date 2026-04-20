/**
 * Budget section — data gathering + HTML rendering for the `aweek serve`
 * dashboard's "Budget & usage" card.
 *
 * Reads live data from `.aweek/` on every call and surfaces, per agent,
 * the weekly token budget compared against the current week's usage total.
 * Agents whose usage has met or exceeded their weekly limit get a
 * dedicated "over-budget" row treatment so the operator can spot budget
 * pressure at a glance — the same signal `src/services/budget-enforcer.js`
 * uses to decide whether to pause the agent on the next heartbeat.
 *
 * Data sources
 * ------------
 *   - Agent config    — `listAllAgents` from `storage/agent-helpers.js`
 *                       provides the weekly token limit. The limit is read
 *                       from `config.weeklyTokenBudget` first (the canonical
 *                       field) and falls back to `config.budget.weeklyTokenLimit`
 *                       for legacy configs. This matches the precedence used
 *                       elsewhere (budget-enforcer, agents-section).
 *   - Weekly usage    — `UsageStore.weeklyTotal` aggregates every usage
 *                       record for the current week's Monday key. The
 *                       Monday anchor honors the project's configured
 *                       timezone via `config-store.loadConfig`, falling back
 *                       to UTC on any config load error so a malformed
 *                       `.aweek/config.json` never knocks the dashboard
 *                       offline.
 *   - Subagent .md    — `readSubagentIdentity` provides the display name
 *                       for the row; missing .md files degrade gracefully
 *                       to the slug so the row is still useful.
 *
 * This module is intentionally pure HTML + data — no DOM, no browser JS.
 * The server injects the rendered fragment into the dashboard shell so the
 * card is server-rendered and live on every request.
 */

import { join } from 'node:path';
import { listAllAgents } from '../storage/agent-helpers.js';
import { readSubagentIdentity } from '../subagents/subagent-file.js';
import { UsageStore, getMondayDate } from '../storage/usage-store.js';
import { loadConfig } from '../storage/config-store.js';

/**
 * Derive the budget totals for a single agent given its config and the
 * current week's usage totals. Exported so the HTTP layer (and tests) can
 * exercise the math without touching the filesystem.
 *
 * Fields:
 *   - `tokenLimit`     — weekly budget in tokens (0 when no budget set).
 *   - `tokensUsed`     — tokens consumed in the current week.
 *   - `remaining`      — max(0, limit - used). Always 0 when there is no
 *                        limit (can't be "remaining" without a ceiling).
 *   - `overBudget`     — true when a positive limit has been met/exceeded.
 *   - `utilizationPct` — used / limit × 100, rounded to nearest integer;
 *                        null when no limit is set so the UI can suppress
 *                        the percentage rather than print "NaN%".
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
export function deriveBudget(config, usage) {
  const tokenLimit = config?.weeklyTokenBudget || config?.budget?.weeklyTokenLimit || 0;
  const tokensUsed = usage?.totalTokens || 0;
  const overBudget = tokenLimit > 0 && tokensUsed >= tokenLimit;
  const remaining = tokenLimit > 0 ? Math.max(0, tokenLimit - tokensUsed) : 0;
  const utilizationPct =
    tokenLimit > 0 ? Math.round((tokensUsed / tokenLimit) * 100) : null;
  return { tokenLimit, tokensUsed, remaining, overBudget, utilizationPct };
}

/**
 * Read every agent's live budget/usage state for the dashboard.
 *
 * Returns a sorted array of rows — over-budget agents float to the top so
 * the operator sees the urgent cases first, then the rest fall back to a
 * descending utilization sort (most-consumed first) so "almost out" is
 * above "barely touched". When two rows share the same utilization the
 * slug breaks the tie deterministically.
 *
 * Errors are absorbed individually: a malformed usage file or missing
 * subagent .md for one agent does not knock the rest of the table offline.
 *
 * @param {object} opts
 * @param {string} opts.projectDir - Project root (contains `.aweek/`).
 * @returns {Promise<Array<{
 *   slug: string,
 *   name: string,
 *   missing: boolean,
 *   tokenLimit: number,
 *   tokensUsed: number,
 *   remaining: number,
 *   overBudget: boolean,
 *   utilizationPct: number | null,
 *   weekMonday: string,
 * }>>}
 */
export async function gatherBudget({ projectDir }) {
  if (!projectDir) throw new Error('gatherBudget: projectDir is required');
  const dataDir = join(projectDir, '.aweek', 'agents');

  const configs = await listAllAgents({ dataDir });
  if (configs.length === 0) return [];

  // Honor the project's configured timezone so the Monday anchor matches
  // what the heartbeat and the /aweek:summary skill use. Fall back to UTC
  // on any load error — a broken config.json must never 500 the dashboard.
  let timeZone;
  try {
    ({ timeZone } = await loadConfig(dataDir));
  } catch {
    timeZone = undefined;
  }
  const weekMondayDate = getMondayDate(new Date(), timeZone);
  const usageStore = new UsageStore(dataDir);

  const rows = await Promise.all(
    configs.map(async (config) => {
      const [identity, usage] = await Promise.all([
        readSubagentIdentity(config.id, projectDir).catch(() => ({
          missing: true,
          name: '',
          description: '',
        })),
        usageStore.weeklyTotal(config.id, weekMondayDate).catch(() => ({
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          recordCount: 0,
        })),
      ]);

      const budget = deriveBudget(config, usage);
      return {
        slug: config.id,
        name: identity.missing ? config.id : identity.name || config.id,
        missing: !!identity.missing,
        ...budget,
        weekMonday: weekMondayDate,
      };
    }),
  );

  return rows.sort((a, b) => {
    // Over-budget rows float to the top so urgent cases are never buried.
    if (a.overBudget && !b.overBudget) return -1;
    if (!a.overBudget && b.overBudget) return 1;
    // Then by utilization desc (null limit = effectively 0%).
    const pctA = a.utilizationPct ?? -1;
    const pctB = b.utilizationPct ?? -1;
    if (pctA !== pctB) return pctB - pctA;
    // Stable tiebreaker by slug.
    return a.slug.localeCompare(b.slug);
  });
}

/**
 * Render the budget section body as HTML.
 *
 * Empty states point the operator at `/aweek:hire` so the card doubles as
 * a nudge for fresh installs. Over-budget rows receive the `.over-budget`
 * class used by the shell stylesheet (red accent + bold) so the visual
 * requirement from AC 5 — "over-budget highlighting" — is satisfied by
 * CSS alone, no JS hydration required.
 *
 * @param {Array<ReturnType<typeof gatherBudget> extends Promise<infer R> ? R[number] : never>} rows
 * @returns {string}
 */
export function renderBudgetSection(rows) {
  if (!rows || rows.length === 0) {
    return `<div class="empty-state">No agents yet. Run <code>/aweek:hire</code> to create one.</div>`;
  }

  const items = rows.map(renderBudgetRow).join('');
  const weekMonday = rows[0]?.weekMonday || '';
  const caption = weekMonday
    ? `<div class="budget-week">Week of <time datetime="${escapeAttr(weekMonday)}">${escapeHtml(weekMonday)}</time></div>`
    : '';

  return `${caption}<ul class="budget-list" role="list">${items}</ul>`;
}

/**
 * Render a single budget row. Each row shows the agent name, slug, a
 * used/limit token line, utilization percentage, and a progress bar. The
 * bar caps its visible fill at 100% so the row does not break out of its
 * column for severely over-budget agents — the numeric "used / limit · N%"
 * text still reports the true overage.
 *
 * @param {object} row
 * @returns {string}
 */
function renderBudgetRow(row) {
  const overCls = row.overBudget ? ' over-budget' : '';
  const missingMarker = row.missing
    ? ` <span class="budget-missing" title="No .claude/agents/${escapeAttr(row.slug)}.md found">[subagent missing]</span>`
    : '';
  const pctLabel = row.utilizationPct != null ? `${row.utilizationPct}%` : '—';
  const noBudget = !row.tokenLimit || row.tokenLimit <= 0;

  const usageLine = noBudget
    ? `<div class="budget-usage muted">no weekly budget · ${formatTokens(row.tokensUsed)} tokens used</div>`
    : `<div class="budget-usage${overCls}">${formatTokens(row.tokensUsed)} / ${formatTokens(row.tokenLimit)} tokens · <span class="budget-pct">${escapeHtml(pctLabel)}</span>${row.overBudget ? ' <span class="budget-tag">OVER BUDGET</span>' : ''}</div>`;

  const progress = noBudget
    ? ''
    : renderProgressBar(row.utilizationPct, row.overBudget);

  const remainingLine = noBudget
    ? ''
    : `<div class="budget-remaining">${row.overBudget ? `exceeded by ${formatTokens(row.tokensUsed - row.tokenLimit)}` : `${formatTokens(row.remaining)} remaining`}</div>`;

  return [
    `<li class="budget-row${overCls}" data-agent-slug="${escapeAttr(row.slug)}" data-over-budget="${row.overBudget ? '1' : '0'}">`,
    `<div class="budget-head">`,
    `<span class="budget-name">${escapeHtml(row.name)}</span>${missingMarker}`,
    `<code class="budget-slug">${escapeHtml(row.slug)}</code>`,
    `</div>`,
    usageLine,
    progress,
    remainingLine,
    `</li>`,
  ].join('');
}

/**
 * Render the progress bar for a budget row. Visible fill is clamped to
 * 100% so over-budget bars max out instead of overflowing the track; the
 * numeric label in `renderBudgetRow` still exposes the true percentage.
 *
 * @param {number | null} pct
 * @param {boolean} overBudget
 * @returns {string}
 */
function renderProgressBar(pct, overBudget) {
  const raw = typeof pct === 'number' ? pct : 0;
  const clamped = Math.max(0, Math.min(100, raw));
  const cls = overBudget ? 'budget-bar over-budget' : 'budget-bar';
  return `<div class="${cls}" role="progressbar" aria-valuenow="${raw}" aria-valuemin="0" aria-valuemax="100"><span style="width:${clamped}%"></span></div>`;
}

/**
 * Compact token formatter (e.g. 12_345 → "12.3k"). Mirrors the
 * agents-section formatter so the two cards stay visually in sync. Kept
 * local to this module so the budget section has no cross-section import.
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
 * CSS fragment for the budget section. Lives here (not in the shell
 * template) so the budget module owns its own styling and the shell stays
 * agnostic about section internals. The server concatenates this onto the
 * shell stylesheet at render time via `extraStyles`.
 *
 * @returns {string}
 */
export function budgetSectionStyles() {
  return `
  .budget-week {
    color: var(--muted);
    font-size: 11.5px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin-bottom: 10px;
  }
  .budget-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .budget-row {
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .budget-row:last-child { border-bottom: none; }
  .budget-row:first-child { padding-top: 0; }
  .budget-row.over-budget {
    background: rgba(255, 107, 107, 0.06);
    border-left: 2px solid var(--over-budget);
    padding-left: 10px;
    margin-left: -12px;
    padding-right: 10px;
    margin-right: -12px;
  }
  .budget-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .budget-name {
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .budget-slug {
    color: var(--muted);
    font-size: 11.5px;
  }
  .budget-missing {
    color: var(--critical);
    font-size: 11.5px;
    font-weight: 500;
    margin-left: 6px;
  }
  .budget-usage {
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .budget-usage.over-budget {
    color: var(--over-budget);
    font-weight: 600;
  }
  .budget-usage.muted {
    font-style: italic;
  }
  .budget-pct {
    font-weight: 600;
  }
  .budget-tag {
    display: inline-block;
    margin-left: 6px;
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
  .budget-bar {
    position: relative;
    width: 100%;
    height: 6px;
    background: var(--panel-2);
    border-radius: 3px;
    overflow: hidden;
  }
  .budget-bar > span {
    display: block;
    height: 100%;
    background: var(--status-completed);
    transition: width 0.2s ease;
  }
  .budget-bar.over-budget > span {
    background: var(--over-budget);
  }
  .budget-remaining {
    color: var(--muted);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  .budget-row.over-budget .budget-remaining {
    color: var(--over-budget);
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
