/**
 * Summary skill — compact dashboard view of all agents.
 *
 * Reuses `gatherAllAgentStatuses` from ./status.js and renders a
 * one-row-per-agent table with columns:
 *   Agent | Goals | Tasks (this week) | Budget | Status
 *
 * Unlike the older verbose status report, this view is optimised for
 * quick at-a-glance scanning of many agents. The skill markdown calls
 * `buildSummary` first, then — when agents exist — offers an optional
 * drill-down (AC 7) that delegates back into this module via
 * `buildAgentDrillDown` / `getAgentDrillDownChoices` so the interactive
 * layer never has to reach into `status.js` or `agent-helpers.js` itself.
 */
import {
  gatherAllAgentStatuses,
  buildAgentStatus,
  formatAgentStatus,
  getCurrentWeekString,
  getMondayDate,
  formatNumber,
} from './status.js';
import { listAllAgents, loadAgent, formatAgentChoice } from '../storage/agent-helpers.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { ActivityLogStore } from '../storage/activity-log-store.js';
import { UsageStore } from '../storage/usage-store.js';
import { InboxStore } from '../storage/inbox-store.js';

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

/**
 * Count active goals in an agent config.
 * Falls back to the total goals length when no status information is present.
 * @param {object} agentConfig
 * @returns {{ active: number, total: number }}
 */
export function countGoals(agentConfig) {
  const goals = agentConfig?.goals || [];
  const total = goals.length;
  const active = goals.filter((g) => !g.status || g.status === 'active').length;
  return { active, total };
}

/**
 * Short human label for agent state (used in the Status column).
 * @param {string} state
 * @returns {string}
 */
export function stateLabel(state) {
  switch (state) {
    case 'running': return 'RUNNING';
    case 'active':  return 'ACTIVE';
    case 'paused':  return 'PAUSED';
    case 'idle':    return 'IDLE';
    default:        return String(state || 'UNKNOWN').toUpperCase();
  }
}

/**
 * Render the goals cell value (e.g. "3 active / 5").
 * @param {{ active: number, total: number }} counts
 * @returns {string}
 */
export function formatGoalsCell({ active, total }) {
  if (total === 0) return '0';
  if (active === total) return String(total);
  return `${active}/${total}`;
}

/**
 * Render the tasks-this-week cell (e.g. "2/5" — completed / total).
 * @param {{ total: number, byStatus: Record<string, number> }} tasks
 * @returns {string}
 */
export function formatTasksCell(tasks) {
  if (!tasks || tasks.total === 0) return '—';
  const completed = tasks.byStatus?.['completed'] || 0;
  return `${completed}/${tasks.total}`;
}

/**
 * Render the budget cell (e.g. "25k/100k (25%)" or "— (no limit)").
 * @param {object} budget - Budget summary slice from status
 * @param {object} usage - Usage summary slice from status
 * @returns {string}
 */
export function formatBudgetCell(budget, usage) {
  if (!budget || !budget.weeklyTokenLimit) {
    return 'no limit';
  }
  const used = usage?.totalTokens || 0;
  return `${formatNumber(used)} / ${formatNumber(budget.weeklyTokenLimit)} (${budget.utilizationPct}%)`;
}

/**
 * Build a single dashboard row from a per-agent status summary and its config.
 * @param {object} agentStatus - Entry from gatherAllAgentStatuses().agents
 * @param {object} agentConfig - Full agent config (used to count goals)
 * @returns {{ agent: string, goals: string, tasks: string, budget: string, status: string }}
 */
export function buildSummaryRow(agentStatus, agentConfig) {
  return {
    agent: agentStatus.name,
    goals: formatGoalsCell(countGoals(agentConfig)),
    tasks: formatTasksCell(agentStatus.plan?.tasks),
    budget: formatBudgetCell(agentStatus.budget, agentStatus.usage),
    status: stateLabel(agentStatus.state),
  };
}

// ---------------------------------------------------------------------------
// Table rendering (ASCII, no external deps)
// ---------------------------------------------------------------------------

const COLUMNS = [
  { key: 'agent',  header: 'Agent'  },
  { key: 'goals',  header: 'Goals'  },
  { key: 'tasks',  header: 'Tasks'  },
  { key: 'budget', header: 'Budget' },
  { key: 'status', header: 'Status' },
];

/**
 * Render a list of row objects as an ASCII table.
 * Widths expand to fit the widest cell per column.
 *
 * @param {Array<Record<string, string>>} rows
 * @returns {string}
 */
export function renderTable(rows) {
  const widths = COLUMNS.map((col) => {
    const cellWidth = rows.reduce((max, r) => Math.max(max, String(r[col.key] ?? '').length), 0);
    return Math.max(col.header.length, cellWidth);
  });

  const line = (cells) =>
    '| ' + cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';

  const separator = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';

  const out = [];
  out.push(line(COLUMNS.map((c) => c.header)));
  out.push(separator);
  for (const r of rows) {
    out.push(line(COLUMNS.map((c) => r[c.key] ?? '')));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Top-level entry — the actual skill handler
// ---------------------------------------------------------------------------

/**
 * Gather data and format a compact dashboard for all agents.
 *
 * @param {object} opts
 * @param {string} opts.dataDir - Base data directory (e.g., ./.aweek/agents)
 * @param {Date} [opts.date] - Reference date (defaults to now)
 * @param {object} [opts.lockOpts] - Lock manager options { lockDir, maxLockAgeMs }
 * @returns {Promise<{ report: string, rows: object[], week: string, weekMonday: string, agentCount: number }>}
 */
export async function buildSummary({ dataDir, date, lockOpts } = {}) {
  if (!dataDir) {
    throw new Error('buildSummary: dataDir is required');
  }

  const configs = await listAllAgents({ dataDir });
  const configMap = new Map(configs.map((c) => [c.id, c]));

  const result = await gatherAllAgentStatuses({ dataDir, date, lockOpts });

  const rows = result.agents.map((s) => buildSummaryRow(s, configMap.get(s.id) || { goals: [] }));
  const report = formatSummaryReport({
    rows,
    week: result.week,
    weekMonday: result.weekMonday,
    agentCount: result.agents.length,
  });

  return {
    report,
    rows,
    week: result.week,
    weekMonday: result.weekMonday,
    agentCount: result.agents.length,
  };
}

/**
 * Format the full dashboard (header + table) for the skill output.
 * @param {object} opts
 * @param {Array<object>} opts.rows
 * @param {string} opts.week
 * @param {string} opts.weekMonday
 * @param {number} opts.agentCount
 * @returns {string}
 */
export function formatSummaryReport({ rows, week, weekMonday, agentCount }) {
  const lines = [];
  lines.push('=== aweek Summary ===');
  lines.push(`Week: ${week} (Monday: ${weekMonday})`);
  lines.push(`Agents: ${agentCount}`);
  lines.push('');

  if (agentCount === 0 || rows.length === 0) {
    lines.push('No agents found. Use /aweek:hire to create one.');
    return lines.join('\n');
  }

  lines.push(renderTable(rows));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Drill-down (AC 7) — interactive deep dive into a single agent
// ---------------------------------------------------------------------------

/**
 * Build a lightweight agent-selection list tailored for the summary
 * drill-down prompt.
 *
 * Returned entries are deliberately minimal — just enough to render the
 * `AskUserQuestion` prompt and disambiguate by id afterwards. A synthetic
 * "no thanks" entry (id: null) is appended so the skill markdown can wire
 * the cancel option into the same choice list without hand-crafting a
 * special-case branch.
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @returns {Promise<Array<{
 *   id: string | null,
 *   name: string,
 *   role: string,
 *   paused: boolean,
 *   label: string,
 * }>>}
 */
export async function getAgentDrillDownChoices({ dataDir } = {}) {
  const configs = await listAllAgents({ dataDir });
  const choices = configs.map((config) => {
    const entry = {
      id: config.id,
      name: config.identity?.name || config.id,
      role: config.identity?.role || '',
      paused: !!config.budget?.paused,
    };
    entry.label = formatAgentChoice(entry);
    return entry;
  });

  // Sentinel for the "No thanks" option — keeps the AskUserQuestion prompt
  // wired to a single homogeneous list in the skill markdown.
  choices.push({
    id: null,
    name: 'No thanks',
    role: '',
    paused: false,
    label: 'No thanks — skip the detailed view',
  });

  return choices;
}

/**
 * Load and format the long-form status block for a single agent.
 *
 * Reuses `buildAgentStatus` + `formatAgentStatus` from status.js so the
 * drill-down view stays byte-identical to the old /aweek:status report for
 * a single agent — the summary skill is purely a presentation wrapper.
 *
 * @param {object} opts
 * @param {string} opts.dataDir - Base data directory (e.g., `.aweek/agents`)
 * @param {string} opts.agentId - Agent id from the drill-down choices
 * @param {Date}   [opts.date]  - Reference date (defaults to now)
 * @param {object} [opts.lockOpts] - `{ lockDir, maxLockAgeMs }`
 * @returns {Promise<{ agentId: string, name: string, report: string, status: object, week: string, weekMonday: string }>}
 */
export async function buildAgentDrillDown({ dataDir, agentId, date, lockOpts } = {}) {
  if (!dataDir) throw new Error('buildAgentDrillDown: dataDir is required');
  if (!agentId) throw new Error('buildAgentDrillDown: agentId is required');

  const agentConfig = await loadAgent({ agentId, dataDir });

  const now = date || new Date();
  const week = getCurrentWeekString(now);
  const weekMonday = getMondayDate(now);

  const stores = {
    weeklyPlanStore: new WeeklyPlanStore(dataDir),
    activityLogStore: new ActivityLogStore(dataDir),
    usageStore: new UsageStore(dataDir),
    inboxStore: new InboxStore(dataDir),
  };

  const status = await buildAgentStatus({
    agentConfig,
    week,
    weekMonday,
    stores,
    lockOpts,
  });

  const report = formatAgentStatus(status);

  return {
    agentId,
    name: status.name,
    report,
    status,
    week,
    weekMonday,
  };
}

// Re-export helpers so callers can use them without pulling status directly.
export { getCurrentWeekString, getMondayDate, formatAgentStatus };
