/**
 * Shared agent selection and storage helpers.
 *
 * Extracted from the old per-skill modules (create-agent, resume-agent,
 * adjust-goal, approve-plan, summary, status, weekly-calendar-grid) so the
 * new consolidated `/aweek:*` skills — `/aweek:init`, `/aweek:hire`,
 * `/aweek:plan`, `/aweek:calendar`, `/aweek:summary`, `/aweek:manage` — all
 * reach for the same storage and selection primitives. Keeping them here
 * (next to `agent-store.ts`) instead of in `src/skills/` means the service
 * layer (`src/services/plan-*.ts`) can use them too without creating an
 * awkward skills → services → skills import cycle.
 *
 * Exports
 * -------
 *   - `getDefaultDataDir()`        — resolves `.aweek/agents` relative to
 *                                     `process.cwd()` on each call so test
 *                                     harnesses that change cwd don't end up
 *                                     with stale paths.
 *   - `DEFAULT_DATA_DIR`           — convenience constant frozen to the
 *                                     process cwd at module load. Prefer
 *                                     `getDefaultDataDir()` when writing
 *                                     testable code.
 *   - `resolveDataDir(dataDir?)`   — returns `dataDir` if provided, else
 *                                     `getDefaultDataDir()`. The one-liner
 *                                     used by every service / skill that
 *                                     accepts an optional data-dir override.
 *   - `createAgentStore(dataDir?)` — factory for an `AgentStore` pointed at
 *                                     the resolved data directory.
 *   - `listAllAgents(opts)`        — load every agent config, returning an
 *                                     empty array when the directory is
 *                                     missing or unreadable (matches the
 *                                     forgiving behavior the summary / status
 *                                     skills rely on).
 *   - `loadAgent(opts)`            — load a single agent config by id with
 *                                     a descriptive "not found" error.
 *   - `getAgentChoices(opts)`      — lightweight `{id, name, role, paused}`
 *                                     list for agent-selection prompts. This
 *                                     is what the `/aweek:plan`, `/aweek:manage`,
 *                                     and `/aweek:calendar` skills hand to
 *                                     `AskUserQuestion`.
 *   - `findAgentByQuery(query, configs)` — flexible id-or-name lookup used by
 *                                          non-interactive CLI entry points.
 *   - `formatAgentChoice(agent)`   — one-line "Name (role) [paused]" label.
 */
import { join } from 'node:path';
import { AgentStore } from './agent-store.js';
import { WeeklyPlanStore } from './weekly-plan-store.js';
import type { Agent } from '../schemas/agent.js';

// ---------------------------------------------------------------------------
// Internal helper types.
//
// Once the sibling stores migrate to TypeScript and publish their own
// canonical types, these can be replaced with imports from those modules.
// For now the helpers describe the loosest practical shape the helpers
// need so downstream callers still get type checking on the lightweight
// fields.
// ---------------------------------------------------------------------------

/**
 * Loose identity shape carried by some legacy / partially-shaped agent
 * configs. Real agent identity lives in the `.claude/agents/<slug>.md`
 * Markdown file — this typed surface only exists so the formatter can
 * still pull `name` / `role` from the (occasional) embedded `identity`
 * blob without falling back to `any`.
 */
export interface AgentIdentityFragment {
  name?: string;
  role?: string;
}

/**
 * Lightweight weekly-plan shape used by `getAgentChoices`. The full
 * weekly-plan schema lives in `src/schemas/weekly-plan.schema.js`; this
 * interface only captures the fields the helper consults.
 */
interface WeeklyPlanLite {
  week?: string;
  tasks?: unknown[];
  approved?: boolean;
}

/**
 * Catch-all extension for agent configs that surface optional / legacy
 * fields the helpers cherry-pick (e.g. `identity`, top-level `name`,
 * top-level `role`, top-level `paused`). The canonical `Agent` shape
 * has migrated those to the subagent `.md` file but a few code paths
 * still flow through here with the older flattened structure.
 */
export type AgentConfig = Agent & {
  identity?: AgentIdentityFragment;
  /** Legacy top-level alias for `identity.name`. */
  name?: string;
  /** Legacy top-level alias for `identity.role`. */
  role?: string;
  /** Legacy top-level alias for `budget.paused`. */
  paused?: boolean;
};

/** Options accepted by every storage helper that touches the agent store. */
export interface AgentStoreOptions {
  dataDir?: string;
  agentStore?: AgentStore;
}

/** Options for {@link loadAgent}. */
export interface LoadAgentOptions extends AgentStoreOptions {
  agentId?: string;
}

/** Result of {@link listAllAgentsPartial}. */
export interface ListAllAgentsPartialResult {
  agents: AgentConfig[];
  errors: Array<{ id: string; message: string }>;
}

/** A single entry returned by {@link getAgentChoices}. */
export interface AgentChoice {
  id: string;
  name: string;
  role: string;
  paused: boolean;
  latestWeek: string | null;
  taskCount: number;
  approved: boolean;
  label: string;
}

/**
 * Subset of the {@link AgentChoice} shape that {@link formatAgentChoice}
 * needs. Accepting either the lightweight choice entry or a full
 * {@link AgentConfig} keeps the formatter callable from any layer.
 */
export type FormattableAgent =
  | (Pick<AgentChoice, 'id'> & Partial<Pick<AgentChoice, 'name' | 'role' | 'paused'>>)
  | AgentConfig
  | null
  | undefined;

/**
 * Resolve the default data directory for aweek agents.
 *
 * Computed on every call (rather than frozen at module load) so tests can
 * `process.chdir(tmpDir)` without caching a stale path. For production code
 * this is effectively the same value every time.
 *
 * @returns Absolute path to `.aweek/agents` under the current cwd.
 */
export function getDefaultDataDir(): string {
  return join(process.cwd(), '.aweek', 'agents');
}

/**
 * Default data directory frozen at module load.
 *
 * Kept for backwards-compat with callers that previously defined their own
 * private `DEFAULT_DATA_DIR` constant. New code should prefer
 * {@link getDefaultDataDir} or {@link resolveDataDir} which tolerate cwd
 * changes.
 */
export const DEFAULT_DATA_DIR: string = getDefaultDataDir();

/**
 * Resolve an optional data-dir override to an absolute path.
 *
 * @param dataDir Explicit data directory override. When falsy, falls back
 *   to {@link getDefaultDataDir}.
 */
export function resolveDataDir(dataDir?: string | null): string {
  return dataDir || getDefaultDataDir();
}

/**
 * Create an `AgentStore` pointed at the resolved data directory.
 */
export function createAgentStore(dataDir?: string | null): AgentStore {
  return new AgentStore(resolveDataDir(dataDir));
}

/**
 * Load every agent config from the given data directory.
 *
 * Forgiving on purpose: if the directory does not exist yet (fresh install)
 * or cannot be read, returns an empty array instead of throwing. This matches
 * the behavior the status / summary / resume skills already rely on.
 */
export async function listAllAgents(
  { dataDir, agentStore }: AgentStoreOptions = {},
): Promise<AgentConfig[]> {
  const store = agentStore || createAgentStore(dataDir);
  try {
    return (await store.loadAll()) as AgentConfig[];
  } catch {
    return [];
  }
}

/**
 * Like {@link listAllAgents} but tolerates per-agent load failures and
 * returns the collected errors alongside the successful configs. Used
 * by the dashboard so drifted / invalid agent JSON surfaces as a
 * visible issues banner instead of an empty list.
 */
export async function listAllAgentsPartial(
  { dataDir, agentStore }: AgentStoreOptions = {},
): Promise<ListAllAgentsPartialResult> {
  const store = agentStore || createAgentStore(dataDir);
  try {
    return (await store.loadAllPartial()) as ListAllAgentsPartialResult;
  } catch (err) {
    const message =
      err instanceof Error && err.message
        ? err.message
        : 'Failed to list agents';
    return {
      agents: [],
      errors: [{ id: '', message }],
    };
  }
}

/**
 * Load a single agent config by id.
 *
 * Unlike {@link listAllAgents} this surfaces "not found" as a descriptive
 * error because callers (the skill markdown) want to render a helpful
 * message rather than silently treat it as missing.
 *
 * @throws {Error} When the agent id does not exist.
 */
export async function loadAgent(
  { agentId, dataDir, agentStore }: LoadAgentOptions = {},
): Promise<AgentConfig> {
  if (!agentId) throw new Error('loadAgent: agentId is required');
  const store = agentStore || createAgentStore(dataDir);
  try {
    return (await store.load(agentId)) as AgentConfig;
  } catch (err) {
    // Preserve the underlying filesystem error message via `cause` so test
    // harnesses / debuggers can still inspect it, but give the user-facing
    // layer a predictable "not found" string.
    throw new Error(`Agent not found: ${agentId}`, { cause: err });
  }
}

/**
 * Format an agent config as a one-line choice label for selection prompts.
 *
 * @param agent An agent config or the lightweight shape returned by
 *   {@link getAgentChoices}.
 */
export function formatAgentChoice(agent: FormattableAgent): string {
  if (!agent) return '';
  const lite = agent as Partial<AgentChoice> & Partial<AgentConfig>;
  const name =
    lite.name || lite.identity?.name || lite.id || '(unknown)';
  const role = lite.role || lite.identity?.role || '';
  const paused = lite.paused || lite.budget?.paused;
  const suffix = paused ? ' [paused]' : '';
  const roleStr = role ? ` (${role})` : '';
  return `${name}${roleStr}${suffix}`;
}

/**
 * Build a lightweight selection list for agent-picker prompts.
 *
 * Every new `/aweek:*` skill that asks the user "which agent?" starts from
 * this list, then renders {@link formatAgentChoice} labels in the prompt.
 *
 * Each entry carries just enough data to:
 *   - display a meaningful label (`name`, `role`, `paused`),
 *   - disambiguate by id after the user picks,
 *   - filter the list (`paused`, `latestWeek`) without re-reading the files.
 */
export async function getAgentChoices(
  opts: AgentStoreOptions = {},
): Promise<AgentChoice[]> {
  const configs = await listAllAgents(opts);
  const weeklyPlanStore = new WeeklyPlanStore(resolveDataDir(opts.dataDir));
  return Promise.all(
    configs.map(async (config): Promise<AgentChoice> => {
      const plans = (await weeklyPlanStore
        .loadAll(config.id)
        .catch(() => [] as WeeklyPlanLite[])) as WeeklyPlanLite[];
      // WeeklyPlanStore.list sorts weeks ascending, so the last plan is
      // the most recent one by week key.
      const latest = plans[plans.length - 1] || null;
      const entry: AgentChoice = {
        id: config.id,
        name: config.identity?.name || config.id,
        role: config.identity?.role || '',
        paused: !!config.budget?.paused,
        latestWeek: latest?.week || null,
        taskCount: latest?.tasks?.length || 0,
        approved: !!latest?.approved,
        label: '',
      };
      entry.label = formatAgentChoice(entry);
      return entry;
    }),
  );
}

/**
 * Look up an agent by id or name from a pre-loaded config list.
 *
 * Matching order:
 *   1. Exact id match.
 *   2. Case-insensitive exact name match.
 *   3. Case-insensitive "startsWith" prefix match on id or name — only
 *      accepted when it resolves to a single unambiguous config.
 *
 * Returns `null` on no match or when a prefix match is ambiguous.
 *
 * @param query User-supplied id / name / prefix.
 * @param configs Agent configs (e.g., from {@link listAllAgents}).
 */
export function findAgentByQuery(
  query: string | null | undefined,
  configs: AgentConfig[] | null | undefined,
): AgentConfig | null {
  if (!query || typeof query !== 'string' || !Array.isArray(configs)) {
    return null;
  }
  const q = query.trim();
  if (q.length === 0) return null;

  const exactId = configs.find((c) => c.id === q);
  if (exactId) return exactId;

  const lower = q.toLowerCase();
  const exactName = configs.find(
    (c) => (c.identity?.name || '').toLowerCase() === lower,
  );
  if (exactName) return exactName;

  const prefix = configs.filter((c) => {
    const id = (c.id || '').toLowerCase();
    const name = (c.identity?.name || '').toLowerCase();
    return id.startsWith(lower) || name.startsWith(lower);
  });
  if (prefix.length === 1) return prefix[0]!;

  return null;
}
