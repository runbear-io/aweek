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
import { readSubagentIdentity } from '../subagents/subagent-file.js';

// Rendered when a subagent .md file cannot be found on disk. The summary
// dashboard must never pull name/description from aweek JSON — those fields
// live only in the .md — so we show this marker alongside the slug instead.
export const MISSING_SUBAGENT_MARKER = '[subagent missing]';

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

/**
 * Count active goals in an agent config.
 * Falls back to the total goals length when no status information is present.
 */
export function countGoals(agentConfig: any): { active: number; total: number } {
  const goals = agentConfig?.goals || [];
  const total = goals.length;
  const active = goals.filter((g: any) => !g.status || g.status === 'active').length;
  return { active, total };
}

/**
 * Short human label for agent state (used in the Status column).
 */
export function stateLabel(state: string | null | undefined): string {
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
 */
export function formatGoalsCell({ active, total }: { active: number; total: number }): string {
  if (total === 0) return '0';
  if (active === total) return String(total);
  return `${active}/${total}`;
}

/**
 * Render the tasks-this-week cell (e.g. "2/5" — completed / total).
 */
export function formatTasksCell(
  tasks:
    | {
        total: number;
        byStatus?: Record<string, number>;
      }
    | null
    | undefined,
): string {
  if (!tasks || tasks.total === 0) return '—';
  const completed = tasks.byStatus?.['completed'] || 0;
  return `${completed}/${tasks.total}`;
}

/**
 * Render the budget cell (e.g. "25k/100k (25%)" or "— (no limit)").
 */
export function formatBudgetCell(
  budget:
    | {
        weeklyTokenLimit?: number;
        utilizationPct?: number;
      }
    | null
    | undefined,
  usage:
    | {
        totalTokens?: number;
      }
    | null
    | undefined,
): string {
  if (!budget || !budget.weeklyTokenLimit) {
    return 'no limit';
  }
  const used = usage?.totalTokens || 0;
  return `${formatNumber(used)} / ${formatNumber(budget.weeklyTokenLimit)} (${budget.utilizationPct}%)`;
}

/**
 * Render the agent cell — the display name sourced live from the subagent
 * .md frontmatter. When the .md is missing we fall back to `slug
 * [subagent missing]` so the row still identifies which aweek agent is
 * orphaned without pretending we know a friendly name we never stored.
 */
export function formatAgentCell(slug: string, subagent: { missing?: boolean; name?: string } | null): string {
  if (!subagent || subagent.missing) {
    return `${slug} ${MISSING_SUBAGENT_MARKER}`;
  }
  return subagent.name || slug;
}

/**
 * Build a single dashboard row from a per-agent status summary and its config.
 */
export function buildSummaryRow(
  agentStatus: any,
  agentConfig: any,
  subagent: any,
): { agent: string; goals: string; tasks: string; budget: string; status: string } {
  return {
    agent: formatAgentCell(agentStatus.id, subagent),
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
] as const;

/**
 * Render a list of row objects as an ASCII table.
 * Widths expand to fit the widest cell per column.
 */
export function renderTable(rows: Array<Record<string, string>>): string {
  const widths = COLUMNS.map((col) => {
    const cellWidth = rows.reduce((max: number, r: Record<string, string>) => Math.max(max, String(r[col.key] ?? '').length), 0);
    return Math.max(col.header.length, cellWidth);
  });

  const line = (cells: any[]) =>
    '| ' + cells.map((c, i) => String(c).padEnd(widths[i] ?? 0)).join(' | ') + ' |';

  const separator = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';

  const out: string[] = [];
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

export interface BuildSummaryOpts {
  dataDir?: string;
  date?: Date;
  lockOpts?: any;
  projectDir?: string;
}

/**
 * Gather data and format a compact dashboard for all agents.
 */
export async function buildSummary({ dataDir, date, lockOpts, projectDir }: BuildSummaryOpts = {}): Promise<{ report: string; rows: any[]; week: string; weekMonday: string; agentCount: number }> {
  if (!dataDir) {
    throw new Error('buildSummary: dataDir is required');
  }

  const configs = await listAllAgents({ dataDir });
  const configMap = new Map(configs.map((c: any) => [c.id, c]));

  const result = await gatherAllAgentStatuses({ dataDir, date, lockOpts });

  // Pull name + description live from every agent's subagent .md. Reads run
  // in parallel because each one is an independent filesystem round-trip.
  // Missing files surface as `{ missing: true }` and render the missing
  // marker downstream instead of throwing.
  const subagentEntries = await Promise.all(
    result.agents.map(async (s: any) => [s.id, await readSubagentIdentity(s.id, projectDir)] as [string, any]),
  );
  const subagentMap = new Map<string, any>(subagentEntries);

  const rows = result.agents.map((s: any) =>
    buildSummaryRow(s, configMap.get(s.id) || { goals: [] }, subagentMap.get(s.id))
  );
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
 */
export function formatSummaryReport({ rows, week, weekMonday, agentCount }: { rows: any[]; week: string; weekMonday: string; agentCount: number }): string {
  const lines: string[] = [];
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

export interface GetAgentDrillDownChoicesOpts {
  dataDir?: string;
  projectDir?: string;
}

/**
 * Build a lightweight agent-selection list tailored for the summary
 * drill-down prompt.
 */
export async function getAgentDrillDownChoices({ dataDir, projectDir }: GetAgentDrillDownChoicesOpts = {}): Promise<any[]> {
  const configs = await listAllAgents({ dataDir });

  // Read each agent's live subagent .md so the choice label reflects the
  // current name / description from disk — not stale data stored inside the
  // aweek JSON. A missing file renders the agent with the missing marker so
  // the user can still pick it to investigate.
  const subagents = await Promise.all(
    configs.map((c: any) => readSubagentIdentity(c.id, projectDir))
  );

  const choices: any[] = configs.map((config: any, i: number) => {
    const subagent: any = subagents[i];
    const displayName = subagent.missing
      ? `${config.id} ${MISSING_SUBAGENT_MARKER}`
      : (subagent.name || config.id);
    const entry: any = {
      id: config.id,
      name: displayName,
      role: subagent.missing ? '' : (subagent.description || ''),
      paused: !!config.budget?.paused,
      missing: !!subagent.missing,
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
    missing: false,
    label: 'No thanks — skip the detailed view',
  });

  return choices;
}

export interface BuildAgentDrillDownOpts {
  dataDir?: string;
  agentId?: string;
  date?: Date;
  lockOpts?: any;
  projectDir?: string;
}

/**
 * Load and format the long-form status block for a single agent.
 */
export async function buildAgentDrillDown({ dataDir, agentId, date, lockOpts, projectDir }: BuildAgentDrillDownOpts = {}): Promise<any> {
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

  // The subagent .md is the single source of truth for name + description.
  // Read it live so the drill-down view matches whatever the user has in
  // .claude/agents/SLUG.md right now, not stale data from aweek JSON.
  const subagent: any = await readSubagentIdentity(agentId, projectDir);

  const status = await buildAgentStatus({
    agentConfig,
    week,
    weekMonday,
    stores,
    lockOpts,
    // Feed live identity through so buildAgentStatus doesn't have to reach
    // into aweek JSON for fields that now live exclusively on disk.
    displayName: subagent.missing ? agentId : (subagent.name || agentId),
    displayRole: subagent.missing ? '' : (subagent.description || ''),
  });

  const baseReport = formatAgentStatus(status);
  const report = subagent.missing
    ? `${MISSING_SUBAGENT_MARKER} ${subagent.path}\n${baseReport}`
    : baseReport;

  return {
    agentId,
    name: subagent.missing ? agentId : (subagent.name || agentId),
    subagent,
    report,
    status,
    week,
    weekMonday,
  };
}

// Re-export helpers so callers can use them without pulling status directly.
export { getCurrentWeekString, getMondayDate, formatAgentStatus };
