/**
 * Initial routing for the `/aweek:hire` wizard.
 *
 * Before the wizard asks the user for anything it needs to decide between two
 * branches:
 *
 *   1. **Pick existing** — the project already has one or more Claude Code
 *      subagent files under `.claude/agents/<slug>.md` that are not yet
 *      wrapped by an aweek scheduling JSON. The wizard should surface those
 *      to the user so they can adopt one without re-typing identity data.
 *
 *   2. **Create new** — there are no unhired subagents available, OR the user
 *      explicitly opts into creating from scratch. The wizard falls through
 *      to the three-field capture flow (see `hire-create-new.ts`).
 *
 * When at least one unhired subagent is available the wizard offers both
 * options via `AskUserQuestion` ("Pick existing" / "Create new"). When none
 * are available the wizard skips the branching prompt entirely and routes
 * straight to the create-new path — prompting the user to choose between two
 * options where one branch is impossible would just be noise.
 *
 * This module supplies the pure data primitives; the skill markdown file
 * (`skills/aweek-hire.md`) drives the actual UX with `AskUserQuestion`.
 *
 * Exports:
 *   - `PLUGIN_SUBAGENT_PREFIXES` — slug prefixes we deliberately hide from
 *     hireable listings (plugin-supplied subagents are excluded from v1).
 *   - `isPluginSubagent(slug)` — predicate used by the listing helpers.
 *   - `listProjectSubagentSlugs({projectDir})` — every `.claude/agents/*.md`
 *     with a well-formed slug, regardless of hire status.
 *   - `listUnhiredSubagents({projectDir, dataDir, agentStore})` — project
 *     subagents minus plugin namespaces minus already-hired slugs.
 *   - `determineHireRoute(opts)` — decision object consumed by the skill
 *     markdown: `{ route, unhired, forcedCreateNew }`.
 */
import { readdir } from 'node:fs/promises';
import { resolveSubagentsDir, validateSubagentSlug } from '../subagents/subagent-file.js';
import { listAllAgents } from '../storage/agent-helpers.js';
import type { AgentStore } from '../storage/agent-store.js';
/**
 * Slug prefixes that belong to plugin-supplied subagents.
 *
 * Per the refactor constraint ("Plugin subagents (oh-my-claudecode, geo) are
 * excluded from hireable lists in v1") these never appear in the wizard's
 * pick-existing list even if a project happens to have a file with a
 * matching prefix under `.claude/agents/`. Users who really want to wrap a
 * plugin subagent can rename it by hand and re-run the wizard.
 *
 * A prefix matches when the slug equals the prefix exactly, or the slug
 * starts with `<prefix>-`. Keeping it a prefix match (not substring) avoids
 * false positives on unrelated slugs like `my-geo-notes`.
 */
export const PLUGIN_SUBAGENT_PREFIXES: readonly string[] = Object.freeze([
  'oh-my-claudecode',
  'geo',
]);

/**
 * Check whether a subagent slug belongs to a plugin namespace.
 */
export function isPluginSubagent(slug: unknown): boolean {
  if (typeof slug !== 'string' || slug.length === 0) return false;
  for (const prefix of PLUGIN_SUBAGENT_PREFIXES) {
    if (slug === prefix) return true;
    if (slug.startsWith(`${prefix}-`)) return true;
  }
  return false;
}

/** Options for {@link listProjectSubagentSlugs}. */
export interface ListProjectSubagentSlugsOptions {
  /**
   * Explicit project root override; falls back to `process.cwd()` via
   * `resolveSubagentsDir`.
   */
  projectDir?: string;
}

/**
 * List every well-formed subagent slug currently on disk under the
 * project-level `.claude/agents/` directory.
 *
 * - Only `.md` files are considered; directories and other extensions are
 *   ignored.
 * - Files whose basename does not satisfy `validateSubagentSlug` (e.g.
 *   `Draft Copy.md`, `_notes.md`) are dropped so they don't poison the
 *   wizard's selection prompt. They'll still be editable by hand — the
 *   wizard just won't try to wrap them.
 * - A missing directory is treated as "no subagents yet" and returns an
 *   empty array. Fresh projects should never throw here.
 *
 * Returned slugs are sorted alphabetically so downstream prompts render in a
 * stable order across runs.
 */
export async function listProjectSubagentSlugs(
  { projectDir }: ListProjectSubagentSlugsOptions = {},
): Promise<string[]> {
  const dir = resolveSubagentsDir(projectDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const slug = entry.slice(0, -'.md'.length);
    if (!validateSubagentSlug(slug).valid) continue;
    slugs.push(slug);
  }
  slugs.sort();
  return slugs;
}

/** Options for {@link listUnhiredSubagents}. */
export interface ListUnhiredSubagentsOptions {
  /** Project root override (for the `.md` scan). */
  projectDir?: string;
  /** aweek data directory override (for the `.json` scan). */
  dataDir?: string;
  /** Pre-constructed store (test hook). */
  agentStore?: AgentStore;
}

/**
 * List subagents that exist on disk but have not yet been wrapped by an
 * aweek scheduling JSON (i.e. are "unhired").
 *
 * Unhired = present under `.claude/agents/<slug>.md` AND not present under
 * `.aweek/agents/<slug>.json`. Plugin-namespaced slugs are filtered out per
 * the v1 constraint.
 *
 * The order matches {@link listProjectSubagentSlugs} — alphabetical by slug
 * — so wizard prompts render deterministically.
 */
export async function listUnhiredSubagents({
  projectDir,
  dataDir,
  agentStore,
}: ListUnhiredSubagentsOptions = {}): Promise<string[]> {
  const [subagents, hired] = await Promise.all([
    listProjectSubagentSlugs({ projectDir }),
    listAllAgents({ dataDir, agentStore }),
  ]);
  const hiredIds = new Set(hired.map((c) => c.id));
  return subagents.filter(
    (slug) => !isPluginSubagent(slug) && !hiredIds.has(slug),
  );
}

/** Options for {@link determineHireRoute}. */
export interface DetermineHireRouteOptions extends ListUnhiredSubagentsOptions {}

/** Result of {@link determineHireRoute}. */
export interface HireRouteDecision {
  route: 'create-new' | 'choose';
  unhired: string[];
  forcedCreateNew: boolean;
}

/**
 * Decide which branch of the `/aweek:hire` wizard to run.
 *
 * The skill markdown calls this once, before prompting the user for
 * anything, and uses the returned object to shape the first `AskUserQuestion`:
 *
 *   - `route === 'choose'` → ask the user "Pick existing" vs "Create new"
 *     using the `unhired` slug list to render options.
 *   - `route === 'create-new'` → skip the branching prompt and jump straight
 *     to the three-field create-new capture. The `forcedCreateNew` flag is
 *     surfaced so the markdown can explain *why* the pick-existing option is
 *     not being offered ("No unhired subagents found in .claude/agents/").
 *
 * This keeps the UX obvious: users never see a two-option prompt where one
 * option is impossible to fulfil.
 */
export async function determineHireRoute({
  projectDir,
  dataDir,
  agentStore,
}: DetermineHireRouteOptions = {}): Promise<HireRouteDecision> {
  const unhired = await listUnhiredSubagents({
    projectDir,
    dataDir,
    agentStore,
  });
  if (unhired.length === 0) {
    return {
      route: 'create-new',
      unhired: [],
      forcedCreateNew: true,
    };
  }
  return {
    route: 'choose',
    unhired,
    forcedCreateNew: false,
  };
}
