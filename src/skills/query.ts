/**
 * Query skill — filter aweek agents by role, status, persona keyword, or budget.
 *
 * Rationale: other skills (`/aweek:plan`, `/aweek:manage`) take one agent at a
 * time, and `/aweek:summary` lists the whole roster unconditionally. Requests
 * like "update the weekly plans of active marketers" have no primitive today —
 * callers fall back to hand-rolled `cat`/`grep` over `.claude/agents/*.md`.
 * This skill gives every consumer (human-facing markdown and downstream bulk
 * operations) a single selection surface that reads identity live from the
 * subagent `.md` and lifecycle state from the aweek JSON + stores.
 *
 * Matching rules:
 *   - `role`     → case-insensitive substring against the subagent description.
 *   - `keyword`  → substring against name + description + system-prompt body.
 *   - `status`   → exact match against the lifecycle state from `status.js`
 *                  (`running` / `active` / `paused` / `idle`), or the synthetic
 *                  `missing-subagent` when the `.md` file is absent.
 *   - `budget`   → `no-limit` (limit == 0), `under` (utilization < 100%), or
 *                  `over` (utilization ≥ 100%). Paused agents fail `under`
 *                  because they only got paused after running out of budget.
 *
 * Every filter is optional; omitting them returns the full roster.
 */
import {
  gatherAllAgentStatuses,
  getCurrentWeekString,
  getMondayDate,
} from './status.js';
import { listAllAgents } from '../storage/agent-helpers.js';
import { readSubagentIdentity } from '../subagents/subagent-file.js';
import { stateLabel, MISSING_SUBAGENT_MARKER } from './summary.js';

// ---------------------------------------------------------------------------
// Filter helpers (pure — exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Normalize the `status` input into a lowercase string array, or null when
 * no filter was provided. Callers pass either a single string (`'active'`),
 * a comma-separated list (`'active,paused'`), or a pre-split array.
 */
export function normalizeStatusFilter(status: any): string[] | null {
  if (status === undefined || status === null || status === '') return null;
  const parts = Array.isArray(status)
    ? status
    : String(status).split(',');
  const cleaned = parts
    .map((s: any) => String(s).trim().toLowerCase())
    .filter((s: string) => s.length > 0);
  return cleaned.length > 0 ? cleaned : null;
}

export function matchesRole(description: any, role: any): { matched: boolean; on: string[] } {
  if (!role) return { matched: true, on: [] };
  const needle = String(role).toLowerCase();
  const haystack = String(description ?? '').toLowerCase();
  return haystack.includes(needle)
    ? { matched: true, on: ['description'] }
    : { matched: false, on: [] };
}

export function matchesKeyword(subagent: any, keyword: any): { matched: boolean; on: string[] } {
  if (!keyword) return { matched: true, on: [] };
  const needle = String(keyword).toLowerCase();
  const on: string[] = [];
  const name = String(subagent?.name ?? '').toLowerCase();
  const desc = String(subagent?.description ?? '').toLowerCase();
  const body = String(subagent?.body ?? '').toLowerCase();
  if (name.includes(needle)) on.push('name');
  if (desc.includes(needle)) on.push('description');
  if (body.includes(needle)) on.push('systemPrompt');
  return { matched: on.length > 0, on };
}

export function matchesStatus(state: any, wanted: string[] | null): boolean {
  if (!wanted) return true;
  return wanted.includes(String(state ?? '').toLowerCase());
}

export function matchesBudget(budget: any, wanted: any): boolean {
  if (!wanted) return true;
  const w = String(wanted).toLowerCase();
  const limit = Number(budget?.weeklyTokenLimit ?? 0);
  const util = Number(budget?.utilizationPct ?? 0);
  if (w === 'no-limit' || w === 'unlimited') return limit === 0;
  if (w === 'over') return limit > 0 && util >= 100;
  if (w === 'under') return limit > 0 && util < 100;
  // Unknown token — do not filter rather than silently drop everything.
  return true;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface QueryAgentsOpts {
  dataDir?: string;
  projectDir?: string;
  date?: Date;
  lockOpts?: any;
  role?: string;
  keyword?: string;
  status?: string | string[];
  budget?: string;
}

/**
 * Filter the full agent roster down to those matching the supplied filters.
 */
export async function queryAgents({
  dataDir,
  projectDir,
  date,
  lockOpts,
  role,
  keyword,
  status,
  budget,
}: QueryAgentsOpts = {}): Promise<any> {
  if (!dataDir) throw new Error('queryAgents: dataDir is required');

  const configs = await listAllAgents({ dataDir });
  const configMap = new Map(configs.map((c: any) => [c.id, c]));

  const gathered = await gatherAllAgentStatuses({ dataDir, date, lockOpts });
  const statuses = gathered.agents;
  const total = statuses.length;

  const subagentEntries = await Promise.all(
    statuses.map(async (s: any) => [s.id, await readSubagentIdentity(s.id, projectDir)] as [string, any]),
  );
  const subagentMap = new Map<string, any>(subagentEntries);

  const statusFilter = normalizeStatusFilter(status);

  const filtered: any[] = [];
  for (const s of statuses) {
    const subagent: any = subagentMap.get(s.id) || { missing: true, name: '', description: '', body: '' };
    const effectiveState = subagent.missing ? 'missing-subagent' : s.state;

    // Role / keyword live in the subagent .md — when the file is missing we
    // have no text to match against, so those filters drop the row. A
    // missing-subagent row is still reachable via `status=missing-subagent`.
    const roleMatch = matchesRole(subagent.description, role);
    if (!roleMatch.matched) continue;

    const keywordMatch = matchesKeyword(subagent, keyword);
    if (!keywordMatch.matched) continue;

    if (!matchesStatus(effectiveState, statusFilter)) continue;
    if (!matchesBudget(s.budget, budget)) continue;

    const matchedOn = Array.from(new Set([...roleMatch.on, ...keywordMatch.on]));

    filtered.push({
      id: s.id,
      name: subagent.missing ? s.id : (subagent.name || s.id),
      description: subagent.missing ? '' : (subagent.description || ''),
      state: effectiveState,
      paused: !!(configMap.get(s.id) as any)?.budget?.paused,
      missing: !!subagent.missing,
      matchedOn,
      weeklyPlan: {
        week: s.plan?.week || null,
        approved: !!s.plan?.approved,
        tasks: s.plan?.tasks || { total: 0, byStatus: {} },
      },
      budget: {
        weeklyTokenLimit: s.budget?.weeklyTokenLimit || 0,
        utilizationPct: s.budget?.utilizationPct || 0,
      },
    });
  }

  return {
    total,
    matched: filtered.length,
    filters: {
      role: role || null,
      keyword: keyword || null,
      status: statusFilter,
      budget: budget || null,
    },
    week: gathered.week,
    weekMonday: gathered.weekMonday,
    agents: filtered,
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const COLUMNS = [
  { key: 'agent',      header: 'Agent' },
  { key: 'role',       header: 'Role' },
  { key: 'status',     header: 'Status' },
  { key: 'tasks',      header: 'Tasks' },
  { key: 'matchedOn',  header: 'Matched on' },
] as const;

function truncate(value: any, max: number): string {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

function formatTasksCell(plan: any): string {
  const total = plan?.tasks?.total || 0;
  if (total === 0) return '—';
  const completed = plan?.tasks?.byStatus?.['completed'] || 0;
  return `${completed}/${total}`;
}

export function buildQueryRow(agent: any): Record<string, string> {
  const agentCell = agent.missing
    ? `${agent.id} ${MISSING_SUBAGENT_MARKER}`
    : (agent.name || agent.id);
  const status = agent.missing ? 'MISSING' : stateLabel(agent.state);
  return {
    agent: truncate(agentCell, 32),
    role: truncate(agent.description || '—', 40),
    status,
    tasks: formatTasksCell(agent.weeklyPlan),
    matchedOn: agent.matchedOn.length > 0 ? agent.matchedOn.join(', ') : '—',
  };
}

function renderTable(rows: Record<string, string>[]): string {
  const widths = COLUMNS.map((col) => {
    const cellWidth = rows.reduce(
      (max: number, r: Record<string, string>) => Math.max(max, String(r[col.key] ?? '').length),
      0,
    );
    return Math.max(col.header.length, cellWidth);
  });
  const line = (cells: any[]) =>
    '| ' + cells.map((c, i) => String(c).padEnd(widths[i] ?? 0)).join(' | ') + ' |';
  const separator = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';
  const out: string[] = [];
  out.push(line(COLUMNS.map((c) => c.header)));
  out.push(separator);
  for (const r of rows) out.push(line(COLUMNS.map((c) => r[c.key] ?? '')));
  return out.join('\n');
}

function formatFilters(filters: any): string {
  const parts: string[] = [];
  if (filters.role) parts.push(`role~"${filters.role}"`);
  if (filters.keyword) parts.push(`keyword~"${filters.keyword}"`);
  if (filters.status) parts.push(`status=${filters.status.join('|')}`);
  if (filters.budget) parts.push(`budget=${filters.budget}`);
  return parts.length > 0 ? parts.join('  ') : '(none — all agents)';
}

/**
 * Render a human-readable report for the skill's final output.
 */
export function formatQueryResult(result: any): string {
  const lines: string[] = [];
  lines.push('=== aweek Query ===');
  lines.push(`Week: ${result.week} (Monday: ${result.weekMonday})`);
  lines.push(`Filters: ${formatFilters(result.filters)}`);
  lines.push(`Matched: ${result.matched} / ${result.total} agent(s)`);
  lines.push('');
  if (result.matched === 0) {
    lines.push('No agents matched. Loosen a filter or run /aweek:summary to see the full roster.');
    return lines.join('\n');
  }
  const rows = result.agents.map(buildQueryRow);
  lines.push(renderTable(rows));
  lines.push('');
  lines.push('Slugs:');
  for (const a of result.agents) lines.push(`  - ${a.id}`);
  return lines.join('\n');
}

/**
 * Build an AskUserQuestion choice list from a query result. The sentinel
 * `id: null` "No thanks" entry is appended so the skill markdown can wire the
 * same homogeneous list that `/aweek:summary` uses.
 */
export function buildQueryChoices(result: any): any[] {
  if (!result || !Array.isArray(result.agents)) return [];
  const choices = result.agents.map((a: any) => {
    const displayName = a.missing
      ? `${a.id} ${MISSING_SUBAGENT_MARKER}`
      : (a.name || a.id);
    const role = a.description ? ` (${truncate(a.description, 48)})` : '';
    const statusSuffix = a.missing ? ' [missing]' : ` [${stateLabel(a.state)}]`;
    return {
      id: a.id,
      name: displayName,
      label: `${displayName}${role}${statusSuffix}`,
    };
  });
  choices.push({ id: null, name: 'No thanks', label: 'No thanks — done' });
  return choices;
}

export { MISSING_SUBAGENT_MARKER };

// Re-exports for status helpers that the query skill markdown depends on.
export { getCurrentWeekString, getMondayDate };
