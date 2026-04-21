/**
 * Per-agent persistent state for the `/aweek:plan` adaptive interview.
 *
 * The Ouroboros-style interview loop (in `skills/plan/SKILL.md`) asks a
 * question, calls the LLM to score the accumulated transcript, updates a
 * sustained-clarity streak, and either offers closure or drills into the
 * weakest dimension. The interview can span a single Claude Code
 * session, so the state — transcript + latest breakdown + streak — is
 * persisted here rather than carried in conversation memory.
 *
 * File: `<agentsDir>/<agentId>/plan-interview.json`
 *
 * This store is intentionally thin: save / load / delete plus a small
 * helper to append a turn. All scoring math lives in
 * `src/skills/plan-ambiguity.js`; this module only persists what the
 * skill markdown hands it.
 */

import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const PLAN_INTERVIEW_FILENAME = 'plan-interview.json';

/**
 * @typedef {object} PlanInterviewTurn
 * @property {string} question
 * @property {string} answer
 * @property {Record<string, { score: number, justification: string }>} [breakdownAfter]
 * @property {number} [ambiguityAfter]
 * @property {number} [streakAfter]
 * @property {string} askedAt - ISO timestamp when the question was emitted.
 * @property {string} [answeredAt] - ISO timestamp when the answer landed.
 */

/**
 * @typedef {object} PlanInterviewState
 * @property {string} agentId
 * @property {string} initialContext
 * @property {PlanInterviewTurn[]} turns
 * @property {number} streak
 * @property {Record<string, { score: number, justification: string }> | null} lastBreakdown
 * @property {string} startedAt
 * @property {string} updatedAt
 */

/**
 * Absolute path of an agent's plan-interview state file.
 *
 * @param {string} agentsDir
 * @param {string} agentId
 * @returns {string}
 */
export function planInterviewPath(agentsDir, agentId) {
  if (!agentsDir) throw new TypeError('agentsDir is required');
  if (!agentId) throw new TypeError('agentId is required');
  return join(agentsDir, agentId, PLAN_INTERVIEW_FILENAME);
}

/**
 * Return a fresh interview state primed with the user's initial context.
 *
 * @param {object} args
 * @param {string} args.agentId
 * @param {string} args.initialContext
 * @param {Date} [args.now]
 * @returns {PlanInterviewState}
 */
export function createInterviewState({ agentId, initialContext, now = new Date() } = {}) {
  if (!agentId) throw new TypeError('agentId is required');
  const iso = now.toISOString();
  return {
    agentId,
    initialContext: typeof initialContext === 'string' ? initialContext : '',
    turns: [],
    streak: 0,
    lastBreakdown: null,
    startedAt: iso,
    updatedAt: iso,
  };
}

/**
 * Return true if the interview state exists on disk. Useful for
 * resume-vs-start decisions at the top of B2a.
 *
 * @param {string} agentsDir
 * @param {string} agentId
 * @returns {Promise<boolean>}
 */
export async function interviewExists(agentsDir, agentId) {
  try {
    const s = await stat(planInterviewPath(agentsDir, agentId));
    return s.isFile();
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Load an agent's interview state. Returns `null` when the file is
 * absent so callers can branch without try/catch noise.
 *
 * @param {string} agentsDir
 * @param {string} agentId
 * @returns {Promise<PlanInterviewState | null>}
 */
export async function loadInterviewState(agentsDir, agentId) {
  let text;
  try {
    text = await readFile(planInterviewPath(agentsDir, agentId), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(text);
}

/**
 * Persist an interview state. Creates the parent agent directory as
 * needed. Updates `updatedAt` to the caller-supplied `now` (or the
 * current wall clock).
 *
 * @param {string} agentsDir
 * @param {string} agentId
 * @param {PlanInterviewState} state
 * @param {Date} [now]
 * @returns {Promise<PlanInterviewState>}
 */
export async function saveInterviewState(agentsDir, agentId, state, now = new Date()) {
  const path = planInterviewPath(agentsDir, agentId);
  await mkdir(dirname(path), { recursive: true });
  const stamped = { ...state, agentId, updatedAt: now.toISOString() };
  await writeFile(path, JSON.stringify(stamped, null, 2) + '\n', 'utf8');
  return stamped;
}

/**
 * Delete an agent's interview state file. Idempotent — missing files
 * return `{ deleted: false }` rather than throwing.
 *
 * @param {string} agentsDir
 * @param {string} agentId
 * @returns {Promise<{ deleted: boolean, path: string }>}
 */
export async function clearInterviewState(agentsDir, agentId) {
  const path = planInterviewPath(agentsDir, agentId);
  try {
    await unlink(path);
    return { deleted: true, path };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { deleted: false, path };
    throw err;
  }
}

/**
 * Append a completed Q/A turn to the state. Does NOT save to disk —
 * callers follow this with `saveInterviewState` so a single write
 * captures the fully-updated state. Keeping append pure lets tests
 * validate the mutation shape without touching the filesystem.
 *
 * @param {PlanInterviewState} state
 * @param {object} turn
 * @param {string} turn.question
 * @param {string} turn.answer
 * @param {Record<string, { score: number, justification: string }>} [turn.breakdownAfter]
 * @param {number} [turn.ambiguityAfter]
 * @param {number} [turn.streakAfter]
 * @param {string} [turn.askedAt]
 * @param {string} [turn.answeredAt]
 * @returns {PlanInterviewState} A new state object (the input is not mutated).
 */
export function appendTurn(state, turn) {
  if (!state || typeof state !== 'object') throw new TypeError('state is required');
  if (!turn || typeof turn !== 'object') throw new TypeError('turn is required');
  if (typeof turn.question !== 'string' || typeof turn.answer !== 'string') {
    throw new TypeError('turn.question and turn.answer must be strings');
  }

  const normalized = {
    question: turn.question,
    answer: turn.answer,
    askedAt: turn.askedAt || new Date().toISOString(),
    answeredAt: turn.answeredAt || new Date().toISOString(),
  };
  if (turn.breakdownAfter) normalized.breakdownAfter = turn.breakdownAfter;
  if (typeof turn.ambiguityAfter === 'number') normalized.ambiguityAfter = turn.ambiguityAfter;
  if (typeof turn.streakAfter === 'number') normalized.streakAfter = turn.streakAfter;

  return {
    ...state,
    turns: [...state.turns, normalized],
    lastBreakdown: turn.breakdownAfter || state.lastBreakdown,
    streak: typeof turn.streakAfter === 'number' ? turn.streakAfter : state.streak,
  };
}
