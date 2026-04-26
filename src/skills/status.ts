/**
 * Status skill — aggregates agent status summaries from all stores.
 *
 * Collects per-agent data from:
 *   - AgentStore (identity, budget config)
 *   - WeeklyPlanStore (current week task breakdown)
 *   - ActivityLogStore (activity summary)
 *   - UsageStore (token usage totals)
 *   - InboxStore (inbox message counts)
 *   - LockManager (lock/running state)
 *
 * All reads are from file-based stores — files are the source of truth.
 */
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { ActivityLogStore } from '../storage/activity-log-store.js';
import { UsageStore } from '../storage/usage-store.js';
import { InboxStore } from '../storage/inbox-store.js';
import { listAllAgents } from '../storage/agent-helpers.js';
import { queryLock } from '../lock/lock-manager.js';
import { currentWeekKey, localParts, mondayOfWeek } from '../time/zone.js';

/**
 * Get the ISO week string (YYYY-Www) for a given date.
 * When `tz` is supplied, the ISO week is computed in that zone; otherwise
 * we use the historical UTC implementation.
 */
export function getCurrentWeekString(date: Date = new Date(), tz?: string): string {
  if (typeof tz === 'string' && tz.length > 0 && tz !== 'UTC') {
    return currentWeekKey(tz, date);
  }
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  // ISO week: Thursday of the week determines the year
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const weekNum = Math.ceil((((d as any) - (yearStart as any)) / 86400000 + yearStart.getUTCDay() + 6) / 7);
  // Pad to 2 digits
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Get the Monday ISO date string for a given date. When `tz` is supplied,
 * the returned date is the Monday of that date's *local* ISO week.
 */
export function getMondayDate(date: Date = new Date(), tz?: string): string {
  if (typeof tz === 'string' && tz.length > 0 && tz !== 'UTC') {
    const weekKey = currentWeekKey(tz, date);
    const monUtc = mondayOfWeek(weekKey, tz);
    const parts = localParts(monUtc, tz);
    return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Compute task status counts from a weekly plan.
 */
export function computeTaskCounts(
  plan: any,
): { total: number; byStatus: Record<string, number>; approved: boolean } {
  if (!plan || !plan.tasks) {
    return { total: 0, byStatus: {}, approved: false };
  }
  const byStatus: Record<string, number> = {};
  for (const task of plan.tasks) {
    byStatus[task.status] = (byStatus[task.status] || 0) + 1;
  }
  return {
    total: plan.tasks.length,
    byStatus,
    approved: !!plan.approved,
  };
}

export interface BuildAgentStatusOpts {
  agentConfig: any;
  week: string;
  weekMonday: string;
  stores: any;
  lockOpts?: any;
  displayName?: string;
  displayRole?: string;
}

/**
 * Build the status summary for a single agent.
 * Gracefully handles missing data — returns partial info when stores are empty.
 */
export async function buildAgentStatus({
  agentConfig,
  week,
  weekMonday,
  stores,
  lockOpts,
  displayName,
  displayRole,
}: BuildAgentStatusOpts): Promise<any> {
  const agentId = agentConfig.id;

  // Gather data in parallel — each read is independent
  const [planResult, activityResult, usageResult, inboxResult, lockResult] = await Promise.allSettled([
    stores.weeklyPlanStore.load(agentId, week).catch(() => null),
    stores.activityLogStore.summary(agentId, weekMonday),
    stores.usageStore.weeklyTotal(agentId, weekMonday),
    stores.inboxStore.summary(agentId),
    lockOpts ? queryLock(agentId, lockOpts) : Promise.resolve({ locked: false, status: 'absent' }),
  ]);

  const plan: any = planResult.status === 'fulfilled' ? planResult.value : null;
  const activitySummary: any = activityResult.status === 'fulfilled' ? activityResult.value : { entryCount: 0, byStatus: {}, totalDuration: 0 };
  const usageSummary: any = usageResult.status === 'fulfilled' ? usageResult.value : { totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, recordCount: 0 };
  const inboxSummary: any = inboxResult.status === 'fulfilled' ? inboxResult.value : { total: 0, byStatus: {}, byType: {} };
  const lockInfo: any = lockResult.status === 'fulfilled' ? lockResult.value : { locked: false, status: 'unknown' };

  const taskCounts = computeTaskCounts(plan);

  // Determine overall agent state
  let state = 'idle';
  if (lockInfo.locked) {
    state = 'running';
  } else if (agentConfig.budget?.paused) {
    state = 'paused';
  } else if (taskCounts.total > 0 && taskCounts.approved) {
    const pending = (taskCounts.byStatus['pending'] || 0) + (taskCounts.byStatus['in-progress'] || 0);
    state = pending > 0 ? 'active' : 'idle';
  }

  // Identity lives in `.claude/agents/SLUG.md`, not in the aweek JSON. The
  // caller passes live name/role from there via displayName/displayRole.
  // We still tolerate legacy configs that happen to have an `identity` block
  // so tests (and any in-flight refactor steps) don't crash mid-migration.
  const resolvedName = displayName
    || agentConfig.identity?.name
    || agentId;
  const resolvedRole = displayRole != null
    ? displayRole
    : (agentConfig.identity?.role || '');

  return {
    id: agentId,
    name: resolvedName,
    role: resolvedRole,
    state,
    plan: {
      week,
      approved: taskCounts.approved,
      tasks: taskCounts,
    },
    activity: {
      weekMonday,
      entries: activitySummary.entryCount,
      byStatus: activitySummary.byStatus,
      totalDurationMs: activitySummary.totalDuration,
    },
    usage: {
      weekMonday: usageSummary.weekMonday || weekMonday,
      totalTokens: usageSummary.totalTokens,
      inputTokens: usageSummary.inputTokens,
      outputTokens: usageSummary.outputTokens,
      costUsd: usageSummary.costUsd,
      sessions: usageSummary.recordCount,
    },
    inbox: {
      total: inboxSummary.total,
      pending: inboxSummary.byStatus?.pending || 0,
      accepted: inboxSummary.byStatus?.accepted || 0,
    },
    budget: {
      weeklyTokenLimit: agentConfig.budget.weeklyTokenLimit,
      currentUsage: agentConfig.budget.currentUsage,
      paused: !!agentConfig.budget.paused,
      utilizationPct: agentConfig.budget.weeklyTokenLimit > 0
        ? Math.round((usageSummary.totalTokens / agentConfig.budget.weeklyTokenLimit) * 100)
        : 0,
    },
    lock: {
      status: lockInfo.status,
      locked: lockInfo.locked,
    },
  };
}

export interface GatherAllAgentStatusesOpts {
  dataDir: string;
  date?: Date;
  lockOpts?: any;
}

/**
 * Gather status for all agents.
 */
export async function gatherAllAgentStatuses({
  dataDir,
  date,
  lockOpts,
}: GatherAllAgentStatusesOpts): Promise<{ agents: any[]; timestamp: string; week: string; weekMonday: string }> {
  const now = date || new Date();
  const week = getCurrentWeekString(now);
  const weekMonday = getMondayDate(now);

  const stores = {
    weeklyPlanStore: new WeeklyPlanStore(dataDir),
    activityLogStore: new ActivityLogStore(dataDir),
    usageStore: new UsageStore(dataDir),
    inboxStore: new InboxStore(dataDir),
  };

  const agents = await listAllAgents({ dataDir });

  if (agents.length === 0) {
    return {
      agents: [],
      timestamp: now.toISOString(),
      week,
      weekMonday,
    };
  }

  const statuses = await Promise.all(
    agents.map((agentConfig: any) =>
      buildAgentStatus({ agentConfig, week, weekMonday, stores, lockOpts })
    )
  );

  return {
    agents: statuses,
    timestamp: now.toISOString(),
    week,
    weekMonday,
  };
}

// ---------------------------------------------------------------------------
// Formatting — human-readable text output for the skill
// ---------------------------------------------------------------------------

/**
 * Format a number with commas for readability.
 */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * State emoji/icon for display.
 */
function stateIcon(state: string): string {
  switch (state) {
    case 'running': return '[RUNNING]';
    case 'active':  return '[ACTIVE]';
    case 'paused':  return '[PAUSED]';
    case 'idle':    return '[IDLE]';
    default:        return `[${state.toUpperCase()}]`;
  }
}

/**
 * Format a single agent's status as a text block.
 */
export function formatAgentStatus(agentStatus: any): string {
  const s = agentStatus;
  const lines: string[] = [];

  lines.push(`${stateIcon(s.state)} ${s.name} (${s.role})`);
  lines.push(`  ID: ${s.id}`);

  // Plan / Tasks
  if (s.plan.tasks.total > 0) {
    const t = s.plan.tasks;
    const parts: string[] = [];
    if (t.byStatus['completed']) parts.push(`${t.byStatus['completed']} completed`);
    if (t.byStatus['in-progress']) parts.push(`${t.byStatus['in-progress']} in-progress`);
    if (t.byStatus['pending']) parts.push(`${t.byStatus['pending']} pending`);
    if (t.byStatus['failed']) parts.push(`${t.byStatus['failed']} failed`);
    if (t.byStatus['delegated']) parts.push(`${t.byStatus['delegated']} delegated`);
    if (t.byStatus['skipped']) parts.push(`${t.byStatus['skipped']} skipped`);
    lines.push(`  Plan: ${s.plan.week} ${s.plan.approved ? '(approved)' : '(pending approval)'} — ${t.total} tasks: ${parts.join(', ')}`);
  } else {
    lines.push(`  Plan: No weekly plan for ${s.plan.week}`);
  }

  // Token budget
  const budgetBar = s.budget.weeklyTokenLimit > 0
    ? `${formatNumber(s.usage.totalTokens)} / ${formatNumber(s.budget.weeklyTokenLimit)} tokens (${s.budget.utilizationPct}%)`
    : 'no limit set';
  lines.push(`  Budget: ${budgetBar}${s.budget.paused ? ' — PAUSED' : ''}`);

  // Activity
  if (s.activity.entries > 0) {
    lines.push(`  Activity: ${s.activity.entries} log entries this week`);
  }

  // Inbox
  if (s.inbox.total > 0) {
    const inboxParts: string[] = [];
    if (s.inbox.pending) inboxParts.push(`${s.inbox.pending} pending`);
    if (s.inbox.accepted) inboxParts.push(`${s.inbox.accepted} accepted`);
    lines.push(`  Inbox: ${s.inbox.total} messages (${inboxParts.join(', ')})`);
  }

  // Lock
  if (s.lock.locked) {
    lines.push(`  Lock: Active session running`);
  }

  return lines.join('\n');
}

/**
 * Format the full status report for all agents.
 */
export function formatStatusReport(statusReport: any): string {
  const lines: string[] = [];

  lines.push('=== aweek Agent Status ===');
  lines.push(`Week: ${statusReport.week} (Monday: ${statusReport.weekMonday})`);
  lines.push(`Agents: ${statusReport.agents.length}`);
  lines.push('');

  if (statusReport.agents.length === 0) {
    lines.push('No agents found. Use /aweek:create-agent to create one.');
    return lines.join('\n');
  }

  // Summary counts
  const stateCounts: Record<string, number> = {};
  for (const a of statusReport.agents) {
    stateCounts[a.state] = (stateCounts[a.state] || 0) + 1;
  }
  const summaryParts: string[] = [];
  if (stateCounts['running']) summaryParts.push(`${stateCounts['running']} running`);
  if (stateCounts['active']) summaryParts.push(`${stateCounts['active']} active`);
  if (stateCounts['paused']) summaryParts.push(`${stateCounts['paused']} paused`);
  if (stateCounts['idle']) summaryParts.push(`${stateCounts['idle']} idle`);
  if (summaryParts.length > 0) {
    lines.push(`Overview: ${summaryParts.join(', ')}`);
  }

  // Total tokens across all agents
  const totalTokens = statusReport.agents.reduce((sum: number, a: any) => sum + a.usage.totalTokens, 0);
  if (totalTokens > 0) {
    lines.push(`Total tokens this week: ${formatNumber(totalTokens)}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // Per-agent details
  for (let i = 0; i < statusReport.agents.length; i++) {
    if (i > 0) lines.push('');
    lines.push(formatAgentStatus(statusReport.agents[i]));
  }

  return lines.join('\n');
}
