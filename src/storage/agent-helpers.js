/**
 * Shared agent selection and storage helpers.
 *
 * Extracted from the old per-skill modules (create-agent, resume-agent,
 * adjust-goal, approve-plan, summary, status, weekly-calendar-grid) so the
 * new consolidated `/aweek:*` skills — `/aweek:init`, `/aweek:hire`,
 * `/aweek:plan`, `/aweek:calendar`, `/aweek:summary`, `/aweek:manage` — all
 * reach for the same storage and selection primitives. Keeping them here
 * (next to `agent-store.js`) instead of in `src/skills/` means the service
 * layer (`src/services/plan-*.js`) can use them too without creating an
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

/**
 * Resolve the default data directory for aweek agents.
 *
 * Computed on every call (rather than frozen at module load) so tests can
 * `process.chdir(tmpDir)` without caching a stale path. For production code
 * this is effectively the same value every time.
 *
 * @returns {string} Absolute path to `.aweek/agents` under the current cwd.
 */
export function getDefaultDataDir() {
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
export const DEFAULT_DATA_DIR = getDefaultDataDir();

/**
 * Resolve an optional data-dir override to an absolute path.
 *
 * @param {string} [dataDir] - Explicit data directory override. When falsy,
 *   falls back to {@link getDefaultDataDir}.
 * @returns {string}
 */
export function resolveDataDir(dataDir) {
  return dataDir || getDefaultDataDir();
}

/**
 * Create an `AgentStore` pointed at the resolved data directory.
 *
 * @param {string} [dataDir]
 * @returns {AgentStore}
 */
export function createAgentStore(dataDir) {
  return new AgentStore(resolveDataDir(dataDir));
}

/**
 * Load every agent config from the given data directory.
 *
 * Forgiving on purpose: if the directory does not exist yet (fresh install)
 * or cannot be read, returns an empty array instead of throwing. This matches
 * the behavior the status / summary / resume skills already rely on.
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @param {AgentStore} [opts.agentStore] - Pre-constructed store (for tests).
 * @returns {Promise<object[]>}
 */
export async function listAllAgents({ dataDir, agentStore } = {}) {
  const store = agentStore || createAgentStore(dataDir);
  try {
    return await store.loadAll();
  } catch {
    return [];
  }
}

/**
 * Like {@link listAllAgents} but tolerates per-agent load failures and
 * returns the collected errors alongside the successful configs. Used
 * by the dashboard so drifted / invalid agent JSON surfaces as a
 * visible issues banner instead of an empty list.
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @param {AgentStore} [opts.agentStore]
 * @returns {Promise<{ agents: object[], errors: Array<{ id: string, message: string }> }>}
 */
export async function listAllAgentsPartial({ dataDir, agentStore } = {}) {
  const store = agentStore || createAgentStore(dataDir);
  try {
    return await store.loadAllPartial();
  } catch (err) {
    return {
      agents: [],
      errors: [
        { id: '', message: (err && err.message) || 'Failed to list agents' },
      ],
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
 * @param {object} opts
 * @param {string} opts.agentId - Agent id to load.
 * @param {string} [opts.dataDir]
 * @param {AgentStore} [opts.agentStore]
 * @returns {Promise<object>} Parsed agent config.
 * @throws {Error} When the agent id does not exist.
 */
export async function loadAgent({ agentId, dataDir, agentStore } = {}) {
  if (!agentId) throw new Error('loadAgent: agentId is required');
  const store = agentStore || createAgentStore(dataDir);
  try {
    return await store.load(agentId);
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
 * @param {object} agent - An agent config or the lightweight shape returned
 *   by {@link getAgentChoices}.
 * @returns {string}
 */
export function formatAgentChoice(agent) {
  if (!agent) return '';
  const name = agent.name || agent.identity?.name || agent.id || '(unknown)';
  const role = agent.role || agent.identity?.role || '';
  const paused = agent.paused || agent.budget?.paused;
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
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @param {AgentStore} [opts.agentStore]
 * @returns {Promise<Array<{
 *   id: string,
 *   name: string,
 *   role: string,
 *   paused: boolean,
 *   latestWeek: string | null,
 *   taskCount: number,
 *   approved: boolean,
 *   label: string,
 * }>>}
 */
export async function getAgentChoices(opts = {}) {
  const configs = await listAllAgents(opts);
  const weeklyPlanStore = new WeeklyPlanStore(resolveDataDir(opts.dataDir));
  return Promise.all(
    configs.map(async (config) => {
      const plans = await weeklyPlanStore.loadAll(config.id).catch(() => []);
      // WeeklyPlanStore.list sorts weeks ascending, so the last plan is
      // the most recent one by week key.
      const latest = plans[plans.length - 1] || null;
      const entry = {
        id: config.id,
        name: config.identity?.name || config.id,
        role: config.identity?.role || '',
        paused: !!config.budget?.paused,
        latestWeek: latest?.week || null,
        taskCount: latest?.tasks?.length || 0,
        approved: !!latest?.approved,
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
 * @param {string} query - User-supplied id / name / prefix.
 * @param {object[]} configs - Agent configs (e.g., from {@link listAllAgents}).
 * @returns {object | null}
 */
export function findAgentByQuery(query, configs) {
  if (!query || typeof query !== 'string' || !Array.isArray(configs)) {
    return null;
  }
  const q = query.trim();
  if (q.length === 0) return null;

  const exactId = configs.find((c) => c.id === q);
  if (exactId) return exactId;

  const lower = q.toLowerCase();
  const exactName = configs.find(
    (c) => (c.identity?.name || '').toLowerCase() === lower
  );
  if (exactName) return exactName;

  const prefix = configs.filter((c) => {
    const id = (c.id || '').toLowerCase();
    const name = (c.identity?.name || '').toLowerCase();
    return id.startsWith(lower) || name.startsWith(lower);
  });
  if (prefix.length === 1) return prefix[0];

  return null;
}
