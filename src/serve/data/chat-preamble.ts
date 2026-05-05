/**
 * Chat preamble builder.
 *
 * Sub-AC of AC 6 (system_preamble_accuracy). Composes the auto-injected
 * context block that prepends every chat turn so the agent answers with
 * the same situational awareness the heartbeat session has:
 *
 *   1. **Weekly plan summary** — the canonical "Long-term goals" /
 *      "Monthly plans" / "Strategies" / "Notes" sections from
 *      `.aweek/agents/<slug>/plan.md` plus the active week's tasks
 *      (titles + statuses) from the weekly-plan store.
 *   2. **Last 5 activity-log entries** — pulled from
 *      `.aweek/agents/<slug>/logs/<weekMonday>.json`. The chat view of
 *      "what just happened" mirrors the dashboard activity timeline.
 *   3. **Weekly budget remaining** — `weeklyTokenBudget − totalTokens`
 *      via `UsageStore.weeklyTotal` for the current week. Same
 *      derivation the budget endpoint (`gatherBudgetList`) uses, so
 *      chat and dashboard never disagree about how much budget the
 *      agent has.
 *   4. **ISO-week key** — `currentWeekKey(timeZone)` from `src/time/zone.ts`,
 *      exactly the way the heartbeat does it. The configured time zone
 *      from `.aweek/config.json` is honored.
 *
 * Design notes:
 *   - **Read-only.** This module never writes — it composes a snapshot
 *     of existing storage state. All four sources are read in parallel
 *     and individually catch ENOENT / load errors so a missing
 *     plan.md, an absent logs week file, or a fresh agent with no
 *     usage records still produces a valid (just sparser) preamble.
 *   - **Single source of truth.** Every input (plan.md, activity-log,
 *     usage-store, time-zone helpers) is the same store the rest of
 *     the dashboard / heartbeat / `aweek summary` already consumes.
 *     No duplicated derivation, no second budget formula.
 *   - **Markdown-friendly output.** `formatPreamble()` renders the
 *     gathered fields into a deterministic markdown block ready to
 *     paste into the Agent SDK's `systemPrompt` option (or to drop
 *     into the head of the user prompt). The structured
 *     `ChatPreamble` shape is also exported so callers that want to
 *     render their own format (e.g. tests) can skip the formatter.
 *
 * @module serve/data/chat-preamble
 */

import { join } from 'node:path';
import { listAllAgentsPartial } from '../../storage/agent-helpers.js';
import {
  readPlan,
  parsePlanMarkdownSections,
  CANONICAL_SECTIONS,
} from '../../storage/plan-markdown-store.js';
import { ActivityLogStore, getMondayDate } from '../../storage/activity-log-store.js';
import type { ActivityLogEntry } from '../../storage/activity-log-store.js';
import { UsageStore } from '../../storage/usage-store.js';
import { WeeklyPlanStore } from '../../storage/weekly-plan-store.js';
import type { WeeklyTask, WeeklyTaskStatus } from '../../storage/weekly-plan-store.js';
import { loadConfig } from '../../storage/config-store.js';
import { currentWeekKey } from '../../time/zone.js';
import { deriveBudget } from './budget.js';

/**
 * Number of most-recent activity-log entries surfaced in the preamble.
 * Aligned with the rubric (`system_preamble_accuracy`) and the dashboard
 * "Recent activity" widget. Exported so tests can compare against a
 * single source of truth.
 */
export const PREAMBLE_RECENT_ACTIVITY_LIMIT = 5;

/**
 * Compact view of a weekly task included in the preamble. We deliberately
 * do not surface long-form prompts here — the agent does not need its
 * own task prompts re-injected, only the title/status/track grid that
 * tells it what is on its plate this week.
 */
export interface PreambleWeeklyTask {
  id: string;
  title: string;
  status: WeeklyTaskStatus;
  /** Free-form objective tag. Mirrors `WeeklyTask.objectiveId`. */
  objectiveId?: string;
  /** Pacing lane (e.g. `email-replies`). Mirrors `WeeklyTask.track`. */
  track?: string;
}

/**
 * Compact activity-log view used in the preamble. Drops `metadata`
 * (which can be large or sensitive) and keeps the user-facing fields.
 */
export interface PreambleActivityEntry {
  /** ISO-8601 timestamp the activity occurred. */
  timestamp: string;
  status: ActivityLogEntry['status'];
  /** Single-line label, mirrors the originating task's calendar title. */
  title: string;
  taskId?: string;
  /** Wall-clock milliseconds the activity took, when known. */
  duration?: number;
}

/**
 * Budget snapshot in the preamble. Mirrors {@link BudgetDerivation} so
 * the dashboard / `gatherBudgetList` and the chat preamble share the
 * same fields and derivation.
 */
export interface PreambleBudget {
  weekMonday: string;
  tokenLimit: number;
  tokensUsed: number;
  remaining: number;
  overBudget: boolean;
  /** Integer percentage 0..100, or `null` when no budget is configured. */
  utilizationPct: number | null;
}

/**
 * Structured preamble payload. Used both by callers that want to render
 * the canonical markdown via {@link formatPreamble} and by tests that
 * want to assert against the underlying values directly.
 */
export interface ChatPreamble {
  /** Slug of the agent the preamble was composed for. */
  slug: string;
  /** ISO week key (e.g. `"2026-W17"`) for the current week in the agent's TZ. */
  weekKey: string;
  /**
   * Time zone used to derive `weekKey` and the activity-log Monday
   * bucket. Falls back to `"UTC"` when `.aweek/config.json` is absent
   * or unreadable.
   */
  timeZone: string;
  /**
   * Plan summary by canonical section title. Keys are stable
   * (`"Long-term goals"` / `"Monthly plans"` / `"Strategies"` /
   * `"Notes"`); missing sections are omitted from the map. The body is
   * the verbatim markdown between the H2 and the next H2 / EOF, with
   * leading and trailing blank lines stripped (same shape
   * `parsePlanMarkdownSections` returns).
   */
  planSections: Partial<Record<string, string>>;
  /** True when `plan.md` exists for this agent. */
  hasPlan: boolean;
  /**
   * Compact view of the active week's tasks. Empty when the weekly
   * plan for `weekKey` is missing or unreadable.
   */
  weeklyTasks: PreambleWeeklyTask[];
  /**
   * Most recent activity-log entries (up to {@link PREAMBLE_RECENT_ACTIVITY_LIMIT}),
   * newest first. Empty when the agent has no log entries this week.
   */
  recentActivity: PreambleActivityEntry[];
  /** Budget snapshot for the current week. */
  budget: PreambleBudget;
}

/** Options for {@link buildPreamble}. */
export interface BuildPreambleOptions {
  /** Project root that contains `.aweek/`. Required. */
  projectDir: string;
  /** Agent slug. Required. */
  slug: string;
  /**
   * Optional clock override for deterministic tests. Defaults to
   * `Date.now()` at call time. The same clock is used to derive the
   * ISO-week key and the activity-log Monday bucket so a fixed clock
   * makes the whole preamble reproducible.
   */
  now?: Date;
  /**
   * Optional time-zone override for tests / advanced callers. When
   * absent the configured zone from `.aweek/config.json` is used, with
   * `"UTC"` as the final fallback.
   */
  timeZone?: string;
}

/**
 * Build a structured preamble for a given agent slug.
 *
 * Errors from individual sources (missing plan.md, absent logs file,
 * fresh agent with no usage history) are absorbed so a sparse but
 * valid preamble still ships. The only hard error path is "agent does
 * not exist" — when the slug is not present on disk we throw, since
 * that indicates a programmer error in the chat handler.
 */
export async function buildPreamble(
  options: BuildPreambleOptions,
): Promise<ChatPreamble> {
  const { projectDir, slug } = options;
  if (!projectDir) throw new Error('buildPreamble: projectDir is required');
  if (!slug) throw new Error('buildPreamble: slug is required');

  const dataDir = join(projectDir, '.aweek', 'agents');
  const now = options.now ?? new Date();

  // Load aweek config so we can pick up the configured time zone.
  // Tolerate any failure — callers shouldn't lose the preamble because
  // of a malformed config.json.
  let configuredTz: string | undefined;
  try {
    const cfg = await loadConfig(dataDir);
    configuredTz = cfg.timeZone;
  } catch {
    configuredTz = undefined;
  }
  const timeZone =
    options.timeZone || configuredTz || 'UTC';

  // Confirm the agent exists. Also pulls the budget limit from config.
  // Use the partial loader so a single drifted JSON does not 404 the
  // chat session for unrelated agents.
  const { agents: configs } = await listAllAgentsPartial({ dataDir });
  const agentConfig = configs.find((c) => c.id === slug);
  if (!agentConfig) {
    throw new Error(`buildPreamble: agent "${slug}" not found in ${dataDir}`);
  }

  const weekKey = currentWeekKey(timeZone, now);
  const weekMonday = getMondayDate(now, timeZone);

  // Stores share the agents data dir.
  const usageStore = new UsageStore(dataDir);
  const activityStore = new ActivityLogStore(dataDir);
  const weeklyPlanStore = new WeeklyPlanStore(dataDir);

  // Read all four data sources in parallel. Each call has its own
  // catch so a missing plan.md / logs file / weekly plan file does not
  // poison the rest of the preamble.
  const [planMarkdown, weeklyPlan, activity, usage] = await Promise.all([
    readPlan(dataDir, slug).catch(() => null),
    weeklyPlanStore.load(slug, weekKey).catch(() => null),
    activityStore.load(slug, weekMonday).catch(
      () => [] as ActivityLogEntry[],
    ),
    usageStore.weeklyTotal(slug, weekMonday).catch(() => ({
      weekMonday,
      recordCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    })),
  ]);

  // Plan summary — pull only the canonical H2 sections so the preamble
  // doesn't accidentally inject random user-renamed sections. The
  // parsing logic is the same one the dashboard Strategy tab uses.
  const parsed = parsePlanMarkdownSections(planMarkdown);
  const planSections: Partial<Record<string, string>> = {};
  for (const title of CANONICAL_SECTIONS) {
    const body = parsed.byTitle[title];
    if (typeof body === 'string' && body.trim().length > 0) {
      planSections[title] = body;
    }
  }

  // Compact weekly tasks — drop the long-form prompt; chat does not
  // need its own task prompts re-injected.
  const weeklyTasks: PreambleWeeklyTask[] = Array.isArray(weeklyPlan?.tasks)
    ? weeklyPlan!.tasks.map(toPreambleTask)
    : [];

  // Recent activity — newest first, capped at PREAMBLE_RECENT_ACTIVITY_LIMIT.
  // Activity-log entries are appended in time order, so a tail-then-
  // reverse is sufficient (cheaper than a full sort on the array).
  const recentActivity = activity
    .slice(-PREAMBLE_RECENT_ACTIVITY_LIMIT)
    .reverse()
    .map(toPreambleActivity);

  // Budget — same derivation as `gatherBudgetList`, sourced from the
  // shared `deriveBudget` so chat and dashboard never diverge.
  const derived = deriveBudget(agentConfig, usage);
  const budget: PreambleBudget = {
    weekMonday,
    tokenLimit: derived.tokenLimit,
    tokensUsed: derived.tokensUsed,
    remaining: derived.remaining,
    overBudget: derived.overBudget,
    utilizationPct: derived.utilizationPct,
  };

  return {
    slug,
    weekKey,
    timeZone,
    planSections,
    hasPlan: typeof planMarkdown === 'string' && planMarkdown.length > 0,
    weeklyTasks,
    recentActivity,
    budget,
  };
}

/**
 * Render a {@link ChatPreamble} as a deterministic markdown block
 * suitable for prepending to a chat turn. Sections that are empty
 * (no plan, no tasks, no activity, no budget) are omitted so the
 * preamble stays compact for fresh agents.
 *
 * The exact formatting is intentionally simple — chat callers are
 * free to render their own variation by reading the structured
 * payload directly.
 */
export function formatPreamble(preamble: ChatPreamble): string {
  const lines: string[] = [];
  lines.push(`# Context for agent "${preamble.slug}"`);
  lines.push('');
  lines.push(
    `Current week: **${preamble.weekKey}** (Monday ${preamble.budget.weekMonday}, time zone ${preamble.timeZone}).`,
  );
  lines.push('');

  // Budget — always emit (zero budget is itself signal).
  lines.push('## Weekly budget');
  lines.push('');
  if (preamble.budget.tokenLimit > 0) {
    const pct =
      preamble.budget.utilizationPct == null
        ? 'n/a'
        : `${preamble.budget.utilizationPct}%`;
    lines.push(
      `- Limit: ${preamble.budget.tokenLimit} tokens`,
      `- Used: ${preamble.budget.tokensUsed} tokens (${pct})`,
      `- Remaining: ${preamble.budget.remaining} tokens` +
        (preamble.budget.overBudget ? ' — **OVER BUDGET**' : ''),
    );
  } else {
    lines.push('- No weekly token budget configured.');
  }
  lines.push('');

  // Plan summary
  const planTitles = CANONICAL_SECTIONS.filter(
    (t) => typeof preamble.planSections[t] === 'string',
  );
  if (planTitles.length > 0 || preamble.hasPlan) {
    lines.push('## Plan summary');
    lines.push('');
    if (planTitles.length === 0) {
      lines.push('_plan.md exists but has no canonical sections filled in._');
      lines.push('');
    } else {
      for (const title of planTitles) {
        lines.push(`### ${title}`);
        lines.push('');
        lines.push(preamble.planSections[title]!);
        lines.push('');
      }
    }
  }

  // Weekly tasks
  if (preamble.weeklyTasks.length > 0) {
    lines.push(`## This week's tasks (${preamble.weekKey})`);
    lines.push('');
    for (const t of preamble.weeklyTasks) {
      const tags: string[] = [`status: ${t.status}`];
      if (t.objectiveId) tags.push(`objective: ${t.objectiveId}`);
      if (t.track) tags.push(`track: ${t.track}`);
      lines.push(`- **${t.title}** (${tags.join(', ')})`);
    }
    lines.push('');
  }

  // Recent activity
  if (preamble.recentActivity.length > 0) {
    lines.push(
      `## Recent activity (last ${preamble.recentActivity.length}, newest first)`,
    );
    lines.push('');
    for (const a of preamble.recentActivity) {
      const dur =
        typeof a.duration === 'number' ? ` (${a.duration} ms)` : '';
      const taskTag = a.taskId ? ` [${a.taskId}]` : '';
      lines.push(
        `- ${a.timestamp} — **${a.status}** — ${a.title}${taskTag}${dur}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toPreambleTask(task: WeeklyTask): PreambleWeeklyTask {
  const out: PreambleWeeklyTask = {
    id: task.id,
    title: task.title,
    status: task.status,
  };
  if (task.objectiveId !== undefined) out.objectiveId = task.objectiveId;
  if (task.track !== undefined) out.track = task.track;
  return out;
}

function toPreambleActivity(entry: ActivityLogEntry): PreambleActivityEntry {
  const out: PreambleActivityEntry = {
    timestamp: entry.timestamp,
    status: entry.status,
    title: entry.title,
  };
  if (entry.taskId !== undefined) out.taskId = entry.taskId;
  if (entry.duration !== undefined) out.duration = entry.duration;
  return out;
}
