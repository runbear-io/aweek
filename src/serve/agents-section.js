/**
 * Agents section — data gathering + HTML rendering for the `aweek serve`
 * dashboard's "Agents" card.
 *
 * Reads live data from `.aweek/` on every call (the server hands us a fresh
 * `projectDir` per request) and derives a simple tri-state status for each
 * agent:
 *
 *   - `active`            — hired, not paused, under budget
 *   - `paused`            — `budget.paused === true` but still under budget
 *                           (user hit `/aweek:manage pause` or similar)
 *   - `budget-exhausted`  — `budget.paused === true` AND weekly usage has
 *                           met/exceeded the weekly limit
 *
 * The `budget-exhausted` vs `paused` split mirrors the heuristic used by
 * `src/services/budget-enforcer.js`: the enforcer flips `paused` whenever
 * `usage >= weeklyTokenLimit`, so seeing both conditions true at render
 * time is the strongest signal we have that the pause came from the
 * budget rather than from a manual toggle.
 *
 * Identity (display name + description) comes from the subagent .md via
 * {@link readSubagentIdentity} — the aweek JSON never holds identity data
 * post-refactor. A missing .md renders the slug with a `[subagent missing]`
 * marker so the row is still useful for operators who need to go patch
 * up `.claude/agents/<slug>.md`.
 *
 * This module is intentionally pure HTML + data — no DOM, no browser JS.
 * The server injects the result into the shell so the agents card is
 * server-rendered and live on every request without any client hydration.
 */

import { join } from 'node:path';
import { listAllAgents } from '../storage/agent-helpers.js';
import { readSubagentIdentity } from '../subagents/subagent-file.js';
import { UsageStore, getMondayDate } from '../storage/usage-store.js';
import { loadConfig } from '../storage/config-store.js';

/**
 * Canonical status order used for sorting rows in the dashboard — we
 * float "active" to the top (busy view), then "paused", then "budget-
 * exhausted" at the bottom so noisy exhausted agents don't drown out
 * agents that still need attention.
 */
const STATUS_ORDER = {
  active: 0,
  paused: 1,
  'budget-exhausted': 2,
};

/**
 * Derive the tri-state status from an agent config + its current-week
 * usage total. Exported so the HTTP layer can unit-test the derivation
 * without exercising the filesystem.
 *
 * @param {{ budget?: { paused?: boolean, weeklyTokenLimit?: number }, weeklyTokenBudget?: number }} config
 * @param {{ totalTokens: number }} usage
 * @returns {'active' | 'paused' | 'budget-exhausted'}
 */
export function deriveAgentStatus(config, usage) {
  const paused = !!config?.budget?.paused;
  const limit = config?.weeklyTokenBudget || config?.budget?.weeklyTokenLimit || 0;
  const used = usage?.totalTokens || 0;
  const overBudget = limit > 0 && used >= limit;

  if (paused && overBudget) return 'budget-exhausted';
  if (paused) return 'paused';
  return 'active';
}

/**
 * Read every agent's live status for the dashboard.
 *
 * Returns a sorted array of lightweight rows — just enough data for
 * `renderAgentsSection` to draw the card. Each row is fully computed
 * server-side so the HTML is the source of truth for what the user
 * sees (no client hydration).
 *
 * Errors are absorbed individually: a broken subagent .md or a malformed
 * usage file for one agent will not prevent the other agents' rows from
 * rendering. The dashboard is read-only and we'd rather show a partial
 * list than bail out with a 500.
 *
 * @param {object} opts
 * @param {string} opts.projectDir - Project root (contains `.aweek/`).
 * @returns {Promise<Array<{
 *   slug: string,
 *   name: string,
 *   description: string,
 *   missing: boolean,
 *   status: 'active' | 'paused' | 'budget-exhausted',
 *   tokensUsed: number,
 *   tokenLimit: number,
 *   utilizationPct: number | null,
 * }>>}
 */
export async function gatherAgents({ projectDir }) {
  if (!projectDir) throw new Error('gatherAgents: projectDir is required');
  const dataDir = join(projectDir, '.aweek', 'agents');

  const configs = await listAllAgents({ dataDir });
  if (configs.length === 0) return [];

  // Timezone controls which Monday anchors the current week. Fall back to
  // UTC on any load error — we never want a malformed config.json to
  // knock the dashboard offline.
  let timeZone;
  try {
    ({ timeZone } = await loadConfig(dataDir));
  } catch {
    timeZone = undefined;
  }
  const weekMonday = getMondayDate(new Date(), timeZone);
  const usageStore = new UsageStore(dataDir);

  const rows = await Promise.all(
    configs.map(async (config) => {
      const [identity, usage] = await Promise.all([
        readSubagentIdentity(config.id, projectDir).catch(() => ({
          missing: true,
          name: '',
          description: '',
        })),
        usageStore.weeklyTotal(config.id, weekMonday).catch(() => ({
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          recordCount: 0,
        })),
      ]);

      const status = deriveAgentStatus(config, usage);
      const tokenLimit = config.weeklyTokenBudget || config.budget?.weeklyTokenLimit || 0;
      const tokensUsed = usage.totalTokens || 0;
      const utilizationPct =
        tokenLimit > 0 ? Math.round((tokensUsed / tokenLimit) * 100) : null;

      return {
        slug: config.id,
        name: identity.missing ? config.id : identity.name || config.id,
        description: identity.missing ? '' : identity.description || '',
        missing: !!identity.missing,
        status,
        tokensUsed,
        tokenLimit,
        utilizationPct,
      };
    }),
  );

  return rows.sort((a, b) => {
    const oa = STATUS_ORDER[a.status] ?? 99;
    const ob = STATUS_ORDER[b.status] ?? 99;
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Render the agents section body as HTML.
 *
 * The returned string is injected into the "Agents" card in
 * `renderDashboardShell`. When the list is empty we render a friendly
 * empty state that points the operator at `/aweek:hire` — the aweek
 * command that creates an agent in the first place.
 *
 * Status badges use the CSS tokens declared in the shell (`.agent-status`
 * + `.status-*`), so this function is a pure string builder with no
 * styling knowledge of its own beyond class names.
 *
 * @param {Array<ReturnType<typeof gatherAgents> extends Promise<infer R> ? R[number] : never>} agents
 * @returns {string}
 */
export function renderAgentsSection(agents) {
  if (!agents || agents.length === 0) {
    return `<div class="empty-state">No agents yet. Run <code>/aweek:hire</code> to create one.</div>`;
  }

  const items = agents.map((agent) => renderAgentRow(agent)).join('');
  return `<ul class="agents-list" role="list">${items}</ul>`;
}

/**
 * Human-facing label for a status badge. The `budget-exhausted` token
 * is rendered as "BUDGET EXHAUSTED" so it stands out — the dashboard
 * surfaces budget pressure prominently per the look-and-feel reference.
 *
 * @param {string} status
 * @returns {string}
 */
export function agentStatusLabel(status) {
  switch (status) {
    case 'active':
      return 'ACTIVE';
    case 'paused':
      return 'PAUSED';
    case 'budget-exhausted':
      return 'BUDGET EXHAUSTED';
    default:
      return String(status || 'UNKNOWN').toUpperCase();
  }
}

/**
 * Render a single agent row (list item) with its status badge, slug,
 * description, and usage line. Escapes every dynamic string so a
 * malicious subagent name/description cannot inject HTML.
 *
 * @param {object} agent
 * @returns {string}
 */
function renderAgentRow(agent) {
  const statusClass = `status-${agent.status}`;
  const statusLabel = agentStatusLabel(agent.status);
  const missingMarker = agent.missing
    ? ` <span class="agent-missing" title="No .claude/agents/${escapeAttr(agent.slug)}.md found">[subagent missing]</span>`
    : '';
  const description = agent.description
    ? `<div class="agent-desc">${escapeHtml(agent.description)}</div>`
    : '';

  const usage = renderAgentUsage(agent);

  return [
    `<li class="agent-row" data-agent-slug="${escapeAttr(agent.slug)}" data-agent-status="${escapeAttr(agent.status)}">`,
    `<div class="agent-head">`,
    `<span class="agent-name">${escapeHtml(agent.name)}</span>${missingMarker}`,
    `<span class="agent-status ${statusClass}">${escapeHtml(statusLabel)}</span>`,
    `</div>`,
    `<div class="agent-meta"><code>${escapeHtml(agent.slug)}</code></div>`,
    description,
    usage,
    `</li>`,
  ].join('');
}

/**
 * Render the usage/budget line under an agent row. Over-budget rows get
 * the `.over-budget` class so the red accent from the shell's CSS kicks
 * in — one of the core "vibe" requirements for the dashboard.
 *
 * @param {object} agent
 * @returns {string}
 */
function renderAgentUsage(agent) {
  if (!agent.tokenLimit || agent.tokenLimit <= 0) {
    return `<div class="agent-usage muted">no weekly budget</div>`;
  }
  const over = agent.tokensUsed >= agent.tokenLimit;
  const cls = over ? 'agent-usage over-budget' : 'agent-usage';
  const pct = agent.utilizationPct != null ? `${agent.utilizationPct}%` : '—';
  return `<div class="${cls}">${formatTokens(agent.tokensUsed)} / ${formatTokens(agent.tokenLimit)} tokens · ${pct}</div>`;
}

/**
 * Compact token formatter (e.g. 12_345 → "12.3k"). Keeps the card dense
 * per the reference dashboard's typography.
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
 * CSS fragment for the agents section. Lives here (not in the shell
 * template) so the agents module owns its own styling and the shell
 * stays agnostic about section internals. The server concatenates this
 * onto the shell stylesheet at render time.
 *
 * @returns {string}
 */
export function agentsSectionStyles() {
  return `
  .agents-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .agent-row {
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .agent-row:last-child { border-bottom: none; }
  .agent-row:first-child { padding-top: 0; }
  .agent-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .agent-name {
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .agent-missing {
    color: var(--critical);
    font-size: 11.5px;
    font-weight: 500;
    margin-left: 6px;
  }
  .agent-meta {
    color: var(--muted);
    font-size: 12px;
  }
  .agent-meta code {
    font-size: 11.5px;
  }
  .agent-desc {
    color: var(--muted);
    font-size: 12.5px;
    line-height: 1.4;
  }
  .agent-usage {
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .agent-usage.over-budget {
    color: var(--over-budget);
    font-weight: 600;
  }
  .agent-usage.muted {
    font-style: italic;
  }
  .agent-status {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid currentColor;
    white-space: nowrap;
  }
  .agent-status.status-active {
    color: var(--status-completed);
  }
  .agent-status.status-paused {
    color: var(--status-pending);
  }
  .agent-status.status-budget-exhausted {
    color: var(--over-budget);
    background: rgba(255, 107, 107, 0.08);
  }
  .empty-state {
    color: var(--muted);
    font-style: italic;
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
