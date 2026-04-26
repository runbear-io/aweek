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
 * Per-dimension score + justification produced by the interview's
 * scoring pass. The dimension key is free-form (e.g. `goalClarity`,
 * `successCriteria`) so the scorer can evolve without breaking the
 * persisted shape.
 */
export interface PlanInterviewBreakdown {
  [dimension: string]: {
    score: number;
    justification: string;
  };
}

/** A single Q/A turn in the interview transcript. */
export interface PlanInterviewTurn {
  question: string;
  answer: string;
  /** Per-dimension breakdown captured after this turn was scored. */
  breakdownAfter?: PlanInterviewBreakdown;
  /** Aggregated ambiguity score after this turn was scored. */
  ambiguityAfter?: number;
  /** Sustained-clarity streak length after this turn was scored. */
  streakAfter?: number;
  /** ISO timestamp when the question was emitted. */
  askedAt: string;
  /** ISO timestamp when the answer landed. */
  answeredAt?: string;
}

/** Full per-agent interview state persisted to disk. */
export interface PlanInterviewState {
  agentId: string;
  initialContext: string;
  turns: PlanInterviewTurn[];
  streak: number;
  lastBreakdown: PlanInterviewBreakdown | null;
  startedAt: string;
  updatedAt: string;
}

/** Arguments for `createInterviewState`. */
export interface CreateInterviewStateArgs {
  agentId: string;
  initialContext?: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

/**
 * Absolute path of an agent's plan-interview state file.
 */
export function planInterviewPath(agentsDir: string, agentId: string): string {
  if (!agentsDir) throw new TypeError('agentsDir is required');
  if (!agentId) throw new TypeError('agentId is required');
  return join(agentsDir, agentId, PLAN_INTERVIEW_FILENAME);
}

/**
 * Return a fresh interview state primed with the user's initial context.
 */
export function createInterviewState({
  agentId,
  initialContext,
  now = new Date(),
}: CreateInterviewStateArgs = {} as CreateInterviewStateArgs): PlanInterviewState {
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
 */
export async function interviewExists(agentsDir: string, agentId: string): Promise<boolean> {
  try {
    const s = await stat(planInterviewPath(agentsDir, agentId));
    return s.isFile();
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Load an agent's interview state. Returns `null` when the file is
 * absent so callers can branch without try/catch noise.
 */
export async function loadInterviewState(
  agentsDir: string,
  agentId: string,
): Promise<PlanInterviewState | null> {
  let text: string;
  try {
    text = await readFile(planInterviewPath(agentsDir, agentId), 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(text) as PlanInterviewState;
}

/**
 * Persist an interview state. Creates the parent agent directory as
 * needed. Updates `updatedAt` to the caller-supplied `now` (or the
 * current wall clock).
 */
export async function saveInterviewState(
  agentsDir: string,
  agentId: string,
  state: PlanInterviewState,
  now: Date = new Date(),
): Promise<PlanInterviewState> {
  const path = planInterviewPath(agentsDir, agentId);
  await mkdir(dirname(path), { recursive: true });
  const stamped: PlanInterviewState = { ...state, agentId, updatedAt: now.toISOString() };
  await writeFile(path, JSON.stringify(stamped, null, 2) + '\n', 'utf8');
  return stamped;
}

/** Result of `clearInterviewState`. */
export interface ClearInterviewStateResult {
  deleted: boolean;
  path: string;
}

/**
 * Delete an agent's interview state file. Idempotent — missing files
 * return `{ deleted: false }` rather than throwing.
 */
export async function clearInterviewState(
  agentsDir: string,
  agentId: string,
): Promise<ClearInterviewStateResult> {
  const path = planInterviewPath(agentsDir, agentId);
  try {
    await unlink(path);
    return { deleted: true, path };
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return { deleted: false, path };
    throw err;
  }
}

/** Input shape accepted by `appendTurn`. */
export interface AppendTurnInput {
  question: string;
  answer: string;
  breakdownAfter?: PlanInterviewBreakdown;
  ambiguityAfter?: number;
  streakAfter?: number;
  askedAt?: string;
  answeredAt?: string;
}

/**
 * Append a completed Q/A turn to the state. Does NOT save to disk —
 * callers follow this with `saveInterviewState` so a single write
 * captures the fully-updated state. Keeping append pure lets tests
 * validate the mutation shape without touching the filesystem.
 *
 * @returns A new state object (the input is not mutated).
 */
export function appendTurn(state: PlanInterviewState, turn: AppendTurnInput): PlanInterviewState {
  if (!state || typeof state !== 'object') throw new TypeError('state is required');
  if (!turn || typeof turn !== 'object') throw new TypeError('turn is required');
  if (typeof turn.question !== 'string' || typeof turn.answer !== 'string') {
    throw new TypeError('turn.question and turn.answer must be strings');
  }

  const normalized: PlanInterviewTurn = {
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

/** Narrow `unknown` to a Node `ErrnoException` so we can read the `code` field. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
