/**
 * Subagent discovery across the two Claude Code scopes.
 *
 * Claude Code loads subagents from two directories:
 *
 *   1. **Project-level** — `<projectDir>/.claude/agents/<slug>.md`. Checked in
 *      to the repo, shared by everyone who clones it.
 *   2. **User-level** — `~/.claude/agents/<slug>.md`. Personal to the logged-in
 *      developer; lives in their home directory and is never checked in.
 *
 * The `/aweek:hire` wizard needs to see BOTH scopes when it asks the user
 * "which existing subagent do you want to wrap?" — a developer who already
 * maintains a personal `~/.claude/agents/researcher.md` should be able to hire
 * that researcher into aweek without re-typing the identity.
 *
 * This module is the single place that knows how to do that scan and how to
 * merge the two scopes into one deduplicated list. Design rules:
 *
 *   - **Project wins on collision.** If both `<project>/.claude/agents/foo.md`
 *     and `~/.claude/agents/foo.md` exist, the project-level file is returned
 *     (Claude Code itself resolves subagent names in project-over-user order,
 *     so we surface whichever one the heartbeat will actually invoke).
 *   - **Write-scope is project-only.** Discovery reads user-level files but
 *     never writes or deletes them — per the refactor constraint, aweek only
 *     mutates `<projectDir>/.claude/agents/`. Hiring a user-level subagent
 *     creates an aweek JSON under `.aweek/agents/<slug>.json` and leaves the
 *     user-level .md untouched.
 *   - **Plugin subagents stay hidden.** The v1 constraint excludes
 *     oh-my-claudecode / geo from hireable lists; the filter is shared with
 *     the existing project-only scanner via `isPluginSubagent`.
 *   - **Hired filter is stateful.** "Already hired" means there is an
 *     `.aweek/agents/<slug>.json` with a matching id — the aweek JSON is the
 *     authority on hire status, not the .md.
 *
 * Entry-point exports:
 *   - {@link resolveUserSubagentsDir} — absolute path to `~/.claude/agents`.
 *   - {@link userSubagentFilePath} — absolute path to `~/.claude/agents/<slug>.md`.
 *   - {@link listUserSubagentSlugs} — sorted, validated slugs under the user
 *     scope (empty array if the dir does not exist).
 *   - {@link discoverSubagents} — the merged view consumed by the hire
 *     wizard's pick-existing branch.
 */
import { homedir } from 'node:os';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  SUBAGENTS_DIR_RELATIVE,
  validateSubagentSlug,
  resolveSubagentsDir,
} from './subagent-file.js';
import { listAllAgents } from '../storage/agent-helpers.js';
import type { AgentStore } from '../storage/agent-store.js';
import { isPluginSubagent } from '../skills/hire-route.js';

/**
 * Scope tags surfaced on every discovered entry.
 *
 * Callers (the hire wizard, the summary dashboard) render these verbatim — a
 * user picking between a project-level and user-level subagent with the same
 * base name deserves to see which one they're adopting.
 */
export const USER_SUBAGENT_SCOPE = 'user' as const;
export const PROJECT_SUBAGENT_SCOPE = 'project' as const;

/**
 * The two scopes Claude Code loads subagents from.
 */
export type SubagentScope =
  | typeof USER_SUBAGENT_SCOPE
  | typeof PROJECT_SUBAGENT_SCOPE;

/** Optional `userHome` override accepted by the user-scope helpers. */
export interface UserHomeOptions {
  /**
   * Override for the home directory. Defaults to `os.homedir()`. The override
   * exists so tests can point discovery at a temp directory without mutating
   * `$HOME` process-wide.
   */
  userHome?: string;
}

/**
 * Options accepted by {@link discoverSubagents}. See the function JSDoc for
 * field semantics.
 */
export interface DiscoverSubagentsOptions extends UserHomeOptions {
  /** Project root override (for `.claude/agents/`). */
  projectDir?: string;
  /** aweek data directory override (for `.aweek/agents/*.json`). */
  dataDir?: string;
  /** Pre-constructed store (test hook). */
  agentStore?: AgentStore;
  /**
   * When true, keep entries whose slug already has a matching aweek JSON.
   * Defaults to `false` — the hire wizard wants only fresh subagents.
   */
  includeHired?: boolean;
  /**
   * When true, keep plugin-namespaced slugs (oh-my-claudecode, geo, ...).
   * Defaults to `false` per the v1 constraint.
   */
  includePlugins?: boolean;
}

/**
 * One entry in the merged discovery output.
 */
export interface DiscoveredSubagent {
  /** Validated subagent slug (the .md basename without the extension). */
  slug: string;
  /** Whether the surfaced .md lives in the project or the user home. */
  scope: SubagentScope;
  /** Absolute filesystem path to the surfaced .md file. */
  path: string;
  /** True iff an `.aweek/agents/<slug>.json` already exists for this slug. */
  hired: boolean;
}

/**
 * Resolve the absolute path to the user-level subagent directory
 * (`~/.claude/agents`).
 *
 * @param opts - Optional `userHome` override (test hook).
 * @returns Absolute path to `<userHome>/.claude/agents`.
 */
export function resolveUserSubagentsDir(
  { userHome }: UserHomeOptions = {},
): string {
  const base = userHome || homedir();
  return resolve(base, SUBAGENTS_DIR_RELATIVE);
}

/**
 * Absolute path to a specific user-level subagent .md file.
 */
export function userSubagentFilePath(
  slug: string,
  { userHome }: UserHomeOptions = {},
): string {
  return join(resolveUserSubagentsDir({ userHome }), `${slug}.md`);
}

/**
 * Scan a single directory for well-formed subagent .md files and return the
 * slugs sorted alphabetically.
 *
 * Shared helper used by both the user-scope and project-scope scanners so
 * they apply identical filtering rules (.md suffix, slug validation, sort).
 * A missing directory is treated as "no subagents here" and returns `[]`
 * rather than throwing — fresh projects and users without a personal subagent
 * dir are both valid states.
 *
 * @param dir - Absolute directory path.
 */
async function scanSubagentSlugsIn(dir: string): Promise<string[]> {
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

/**
 * List every well-formed subagent slug under the user-level
 * `~/.claude/agents/` directory.
 *
 * Matches the project-level scanner's contract (`listProjectSubagentSlugs` in
 * `hire-route.js`) so the two can be composed without surprises: sorted
 * alphabetically, hand-named files with invalid slugs dropped, missing dir
 * returns `[]`.
 */
export async function listUserSubagentSlugs(
  { userHome }: UserHomeOptions = {},
): Promise<string[]> {
  return scanSubagentSlugsIn(resolveUserSubagentsDir({ userHome }));
}

/**
 * Discover every hireable subagent across the project and user scopes.
 *
 * Returns a deduplicated, alphabetically sorted list of entries. Each entry
 * carries the slug, its scope (`'project'` | `'user'`), the absolute .md path,
 * and its hire status (whether an aweek JSON with a matching id already
 * exists). Callers can then filter on scope or hire status as needed.
 *
 * Deduplication rule: if a slug exists in both scopes, the project-level
 * entry wins. Claude Code itself resolves `--agent SLUG` in project-over-user
 * order, so the heartbeat would invoke the project file anyway — surfacing
 * the user-level copy would be misleading.
 *
 * Filters:
 *   - `includeHired: false` (default) — drop already-hired slugs. This is the
 *     shape the hire wizard wants: only offer fresh subagents to wrap.
 *   - `includePlugins: false` (default) — drop plugin-namespaced slugs per
 *     the v1 constraint. Plugin subagents (oh-my-claudecode, geo) are not
 *     hireable in v1 even if a project copies the .md into its agents dir.
 */
export async function discoverSubagents({
  projectDir,
  userHome,
  dataDir,
  agentStore,
  includeHired = false,
  includePlugins = false,
}: DiscoverSubagentsOptions = {}): Promise<DiscoveredSubagent[]> {
  const projectDirAbs = resolveSubagentsDir(projectDir);
  const userDirAbs = resolveUserSubagentsDir({ userHome });

  const [projectSlugs, userSlugs, hired] = await Promise.all([
    scanSubagentSlugsIn(projectDirAbs),
    scanSubagentSlugsIn(userDirAbs),
    listAllAgents({ dataDir, agentStore }),
  ]);

  const hiredIds = new Set<string>(hired.map((c) => c.id));

  // Seed with user-scope entries first, then overwrite with project-scope on
  // collision — project wins because that is the scope Claude Code itself
  // resolves to when both are present.
  const bySlug = new Map<string, DiscoveredSubagent>();
  for (const slug of userSlugs) {
    bySlug.set(slug, {
      slug,
      scope: USER_SUBAGENT_SCOPE,
      path: join(userDirAbs, `${slug}.md`),
      hired: hiredIds.has(slug),
    });
  }
  for (const slug of projectSlugs) {
    bySlug.set(slug, {
      slug,
      scope: PROJECT_SUBAGENT_SCOPE,
      path: join(projectDirAbs, `${slug}.md`),
      hired: hiredIds.has(slug),
    });
  }

  const out: DiscoveredSubagent[] = [];
  for (const entry of bySlug.values()) {
    if (!includeHired && entry.hired) continue;
    if (!includePlugins && isPluginSubagent(entry.slug)) continue;
    out.push(entry);
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}
