/**
 * Hire-all handler (Sub-AC 1 of AC 50301).
 *
 * Iterates over a list of Claude Code subagent slugs (typically the
 * `route.slugs` payload produced by `routeInitHireMenuChoice` on the
 * `hire-all` or `select-some` branches of the `/aweek:init` post-setup menu)
 * and creates a minimal aweek scheduling JSON "shell" for each one.
 *
 * Identity stays in `.claude/agents/<slug>.md` (the single source of truth
 * per the refactor) — this handler only materialises the aweek-side
 * wrapper. A fresh shell contains:
 *
 *   - `id` + `subagentRef` equal to the slug (1-to-1 filesystem mapping),
 *   - empty `goals`, `monthlyPlans`, and `inbox` (weekly plans live in
 *     the `WeeklyPlanStore` file store, not on the agent JSON),
 *   - a default-weekly-budget `budget` block anchored at Monday 00:00 UTC
 *     with `paused: false` and `pausedReason: null` (explicit "never
 *     paused" marker — distinguishable from a missing field),
 *   - matching `createdAt` / `updatedAt` timestamps.
 *
 * Each shell is validated against `aweek://schemas/agent-config` by the
 * storage layer before it is written, so callers get the same guarantees
 * they would from the full `hireAgent` pipeline — just without the
 * interactive goal / objective / task capture.
 *
 * ### Per-slug safety rails
 *
 * The handler short-circuits each slug that is not safe to wrap instead of
 * aborting the batch, so the caller gets a structured result describing
 * every outcome. The rules, in order:
 *
 *   1. **Plugin-namespaced slug** (e.g. `oh-my-claudecode-executor`,
 *      `geo-audit`) → recorded under `skipped` with a "plugin-namespaced"
 *      reason. Plugin subagents are excluded from hireable lists in v1 per
 *      the refactor constraint. This matches the behaviour of
 *      `listUnhiredSubagents`, but we re-check here because callers
 *      sometimes pass a slug list assembled from another source.
 *   2. **Already-hired slug** (a matching `.aweek/agents/<slug>.json`
 *      already exists) → recorded under `skipped` with an "already hired"
 *      reason. This makes the handler idempotent: re-running hire-all on
 *      the same project is a no-op for already-wrapped subagents rather
 *      than an overwrite or an error.
 *   3. **Missing subagent `.md`** (no `.claude/agents/<slug>.md` on disk)
 *      → recorded under `failed`. We refuse to create an aweek wrapper for
 *      a slug that has no matching subagent file because the heartbeat
 *      would immediately auto-pause such an agent as `subagent_missing`.
 *      Better to surface the problem at hire time.
 *   4. **Invalid slug / schema failure** (e.g. a slug that does not match
 *      `SUBAGENT_SLUG_PATTERN`, or a schema error surfaced by
 *      `AgentStore.save`) → recorded under `failed`.
 *
 * Only a successful `AgentStore.save` adds the slug to `created`.
 *
 * The handler never writes to the user-level `~/.claude/agents/`
 * directory — consistent with the project constraint.
 *
 * @module skills/hire-all
 */
import { createAgentConfig } from '../models/agent.js';
import { createAgentStore } from '../storage/agent-helpers.js';
import type { AgentStore } from '../storage/agent-store.js';
import {
  buildInitialPlan,
  exists as planExists,
  writePlan,
} from '../storage/plan-markdown-store.js';
import {
  readSubagentIdentity,
  subagentFileExists,
  validateSubagentSlug,
} from '../subagents/subagent-file.js';
import { isPluginSubagent } from './hire-route.js';

/**
 * Default weekly token budget applied to every shell created in a batch when
 * the caller does not override it. Matches the default used by
 * `createAgentConfig` and the three-field create-new wizard so ad-hoc hires
 * and bulk hires have the same starting budget.
 */
export const DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT = 500_000;

/** Options accepted by {@link hireAllSubagents}. */
export interface HireAllSubagentsOptions {
  /**
   * Subagent slugs to wrap. Typically the `route.slugs` payload from
   * `routeInitHireMenuChoice`. Any non-array input lands as a structured
   * failure rather than a throw.
   */
  slugs?: unknown;
  /**
   * Weekly token budget applied to every new shell. Defaults to
   * {@link DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT}.
   */
  weeklyTokenLimit?: number;
  /**
   * Project root for the `.md` lookup. Defaults to `process.cwd()` via
   * `subagentFileExists`.
   */
  projectDir?: string;
  /**
   * aweek data directory override. Defaults to the project-local
   * `.aweek/agents/` via `createAgentStore`.
   */
  dataDir?: string;
  /**
   * Pre-constructed store (test hook). When supplied, `dataDir` is ignored
   * and the provided store is used directly.
   */
  agentStore?: AgentStore;
}

/** Per-slug "skipped" outcome. */
export interface HireAllSkipped {
  slug: string;
  reason: string;
}

/** Per-slug "failed" outcome. */
export interface HireAllFailed {
  slug: string;
  errors: string[];
}

/** Result of {@link hireAllSubagents}. */
export interface HireAllResult {
  success: boolean;
  /** slugs that now have a fresh aweek JSON wrapper on disk. */
  created: string[];
  /**
   * slugs that were intentionally left alone (plugin-namespaced or
   * already-hired). Each entry carries a human-readable `reason`.
   */
  skipped: HireAllSkipped[];
  /**
   * slugs that could not be wrapped (missing `.md`, invalid slug, schema
   * error). Each entry carries the underlying `errors`.
   */
  failed: HireAllFailed[];
}

/**
 * Wrap a batch of pre-existing Claude Code subagents with minimal aweek
 * scheduling JSON shells.
 *
 * Every slug is processed independently — a failure on one slug does NOT
 * short-circuit the batch. The returned object lists every outcome so the
 * caller can render a full post-hire summary.
 *
 * `success` is `true` iff `failed` is empty. `skipped` does not affect the
 * success flag — skips are a valid outcome.
 */
export async function hireAllSubagents({
  slugs,
  weeklyTokenLimit = DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT,
  projectDir,
  dataDir,
  agentStore,
}: HireAllSubagentsOptions = {}): Promise<HireAllResult> {
  // Defensive shape check — the handler is often called from skill markdown
  // that hands us whatever `route.slugs` happens to be, so we don't want a
  // stray `null`/`undefined` to throw an opaque error.
  if (!Array.isArray(slugs)) {
    return {
      success: false,
      created: [],
      skipped: [],
      failed: [
        {
          slug: '(input)',
          errors: ['hireAllSubagents: `slugs` must be an array of subagent slugs'],
        },
      ],
    };
  }

  // Empty input is a legal no-op — the menu can route here with an empty
  // list if every available subagent was filtered out upstream (e.g. the
  // user picked "Select some" and then un-selected everything).
  if (slugs.length === 0) {
    return { success: true, created: [], skipped: [], failed: [] };
  }

  const store = agentStore || createAgentStore(dataDir);

  const created: string[] = [];
  const skipped: HireAllSkipped[] = [];
  const failed: HireAllFailed[] = [];
  // Track slugs we've already processed in THIS batch so a caller that
  // accidentally duplicates a slug in its input list still gets one create
  // + one "already hired" skip rather than a schema collision on the second
  // save.
  const seen = new Set<string>();

  for (const slug of slugs as unknown[]) {
    // Validate the slug shape up front. If the caller passed a bad slug
    // (non-string, wrong casing, underscores, etc.) we want a clear error
    // in `failed` rather than a misleading "file not found" path.
    const slugCheck = validateSubagentSlug(slug);
    if (!slugCheck.valid) {
      failed.push({
        slug: typeof slug === 'string' ? slug : String(slug),
        errors: slugCheck.errors,
      });
      continue;
    }

    // After validateSubagentSlug succeeds we know `slug` is a string.
    const slugStr = slug as string;

    if (seen.has(slugStr)) {
      skipped.push({
        slug: slugStr,
        reason: 'duplicate slug in input — already processed in this batch',
      });
      continue;
    }
    seen.add(slugStr);

    // Plugin-namespaced slugs are filtered out of hireable lists per the v1
    // constraint. Re-check here because not every caller assembles its slug
    // list from `listUnhiredSubagents`.
    if (isPluginSubagent(slugStr)) {
      skipped.push({
        slug: slugStr,
        reason:
          'plugin-namespaced subagent — excluded from hireable lists in v1 (see PLUGIN_SUBAGENT_PREFIXES)',
      });
      continue;
    }

    // Idempotency: if an aweek JSON wrapper already exists, leave it
    // untouched. This lets users re-run the hire-all flow after adding a
    // new subagent without clobbering already-scheduled agents.
    if (await store.exists(slugStr)) {
      skipped.push({
        slug: slugStr,
        reason:
          'aweek JSON wrapper already exists — re-running hire-all on an already-hired slug is a no-op',
      });
      continue;
    }

    // Require the subagent .md to exist before creating the wrapper.
    // Creating an aweek config that points at a missing .md would just
    // trigger an immediate `subagent_missing` auto-pause on the next
    // heartbeat — better to surface the problem at hire time.
    const exists = await subagentFileExists(slugStr, projectDir);
    if (!exists) {
      failed.push({
        slug: slugStr,
        errors: [
          `Subagent file .claude/agents/${slugStr}.md not found in project. Create the subagent first or run /aweek:hire create-new.`,
        ],
      });
      continue;
    }

    // Build the minimal shell. `createAgentConfig` asserts the slug shape
    // via the schema-shared regex and throws on a bad slug — we already
    // validated above, but the extra safety net stays useful if the regex
    // ever drifts.
    let config;
    try {
      config = createAgentConfig({ subagentRef: slugStr, weeklyTokenLimit });
    } catch (err) {
      failed.push({
        slug: slugStr,
        errors: [err instanceof Error ? err.message : String(err)],
      });
      continue;
    }

    // Normalise the shell to the explicit "fresh hire" shape:
    //
    //   - empty `goals`, `monthlyPlans`, and `inbox` arrays
    //     (defensive — `createAgentConfig` already produces them, but we
    //     re-set so a future drift in the model can't silently leak
    //     populated defaults into a batch hire),
    //   - `budget.paused` = false and `budget.pausedReason` = null.
    //
    // Weekly plans are intentionally NOT re-set here — they live in the
    // per-week `WeeklyPlanStore` file store (`<agentId>/weekly-plans/`),
    // not on the agent JSON, so there is nothing to seed on a fresh
    // hire.
    //
    // Writing `pausedReason: null` explicitly (rather than omitting the
    // field) gives downstream readers — the heartbeat, the summary table,
    // resume flows — an unambiguous "never paused, no reason" marker that
    // is distinguishable from "schema predates the column / field
    // forgotten on serialisation". The schema permits string|null on this
    // field for exactly this reason.
    config.goals = [];
    config.monthlyPlans = [];
    config.inbox = [];
    config.budget.paused = false;
    config.budget.pausedReason = null;

    // AgentStore.save runs `assertValid` against the agent-config schema
    // before writing, so any downstream schema drift surfaces here. Capture
    // validation / filesystem errors as a per-slug failure rather than
    // aborting the batch.
    try {
      await store.save(config);
      // Seed the free-form plan.md when missing. Non-fatal: a hire that
      // succeeds but fails to seed plan.md still counts as `created` — the
      // user can write the file by hand on first `/aweek:plan`.
      try {
        if (!(await planExists(store.baseDir, slugStr))) {
          let name: string = slugStr;
          let description: string | undefined;
          try {
            const identity = await readSubagentIdentity(slugStr, projectDir);
            if (identity?.name) name = identity.name;
            if (identity?.description) description = identity.description;
          } catch {
            // Fall back to the slug alone.
          }
          await writePlan(
            store.baseDir,
            slugStr,
            buildInitialPlan({ name, description }),
          );
        }
      } catch {
        // Ignore — plan.md is secondary to the JSON wrapper.
      }
      created.push(slugStr);
    } catch (err) {
      failed.push({
        slug: slugStr,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  return {
    success: failed.length === 0,
    created,
    skipped,
    failed,
  };
}

/**
 * Format a {@link hireAllSubagents} result as a human-readable block the
 * `/aweek:init` skill markdown can echo after dispatch.
 *
 * Empty sections are omitted to keep the summary concise. When every list
 * is empty (e.g. the caller passed an empty `slugs` array), a single-line
 * "nothing to hire" message is returned instead.
 */
export function formatHireAllSummary(
  result: HireAllResult | null | undefined,
): string {
  if (!result) return '';

  const { created = [], skipped = [], failed = [] } = result;
  if (created.length === 0 && skipped.length === 0 && failed.length === 0) {
    return 'hire-all: no slugs to process.';
  }

  const lines: string[] = [];

  if (created.length > 0) {
    lines.push(
      `Created ${created.length} aweek JSON wrapper${created.length === 1 ? '' : 's'}:`,
    );
    for (const slug of created) lines.push(`  + ${slug}`);
  }

  if (skipped.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Skipped ${skipped.length}:`);
    for (const entry of skipped) lines.push(`  - ${entry.slug} — ${entry.reason}`);
  }

  if (failed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Failed ${failed.length}:`);
    for (const entry of failed) {
      for (const err of entry.errors) {
        lines.push(`  ! ${entry.slug}: ${err}`);
      }
    }
  }

  return lines.join('\n');
}
