/**
 * Hire skill logic — thin adapter over the shared agent-creation pipeline.
 *
 * The `/aweek:hire` skill (see `skills/aweek-hire.md`) is the consolidated
 * replacement for the old `/aweek:create-agent` skill. It reuses every
 * validator and the `assembleAndSaveAgent` pipeline from
 * `./create-agent.js` so there is a single source of truth for how an
 * agent is validated and persisted.
 *
 * This adapter exposes:
 *   - `hireAgent`         — canonical entry point that "hires" an agent
 *                           (alias for `assembleAndSaveAgent`).
 *   - `formatHireSummary` — user-facing summary after a successful hire
 *                           (alias for `formatAgentSummary`).
 *   - Re-exports of every input validator / helper so the skill markdown
 *     can import them from one module.
 *
 * Keeping the adapter deliberately small means the `/aweek:hire` skill can
 * evolve its UX layer (prompt copy, summary framing, confirmation flow)
 * without touching the persistence logic.
 */
import {
  assembleAndSaveAgent,
  formatAgentSummary,
  validateIdentityInput,
  validateGoalsInput,
  validateObjectivesInput,
  validateTasksInput,
  validateTokenLimit,
  getCurrentMonth,
  getCurrentWeek,
} from './create-agent.js';

/**
 * Hire (create and persist) a new aweek agent.
 *
 * Accepts the same parameters as {@link assembleAndSaveAgent}. Returns the
 * same `{ success, config?, errors? }` shape. This is the function the
 * `/aweek:hire` skill calls once all interactive prompts have been
 * collected.
 *
 * @param {Parameters<typeof assembleAndSaveAgent>[0]} params
 * @returns {ReturnType<typeof assembleAndSaveAgent>}
 */
export function hireAgent(params) {
  return assembleAndSaveAgent(params);
}

/**
 * Format a post-hire summary for display in the `/aweek:hire` skill.
 *
 * Mirrors {@link formatAgentSummary} exactly — kept as a named export so
 * consumer code in the new skill surface reads naturally (`formatHireSummary`
 * alongside `hireAgent`).
 *
 * @param {object} config - The saved agent config returned by `hireAgent`.
 * @returns {string}
 */
export function formatHireSummary(config) {
  return formatAgentSummary(config);
}

// Re-export validators and helpers so the /aweek:hire skill markdown has a
// single import surface. The underlying implementations still live in
// create-agent.js — this module is intentionally a thin shim.
export {
  validateIdentityInput,
  validateGoalsInput,
  validateObjectivesInput,
  validateTasksInput,
  validateTokenLimit,
  getCurrentMonth,
  getCurrentWeek,
  // Keep the original names accessible too, so callers that already know
  // the shared pipeline can opt into them directly.
  assembleAndSaveAgent,
  formatAgentSummary,
};
