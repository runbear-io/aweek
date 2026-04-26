/**
 * Storage layer for agent goals.
 * Persists goals as JSON files under .aweek/agents/<agentId>/goals/.
 * Each goal is its own file for granular access and idempotent writes.
 * Files are the source of truth — human-readable and skill-readable.
 *
 * Plan traceability: goals -> monthly objectives -> weekly tasks.
 *
 * Note: long-term goals have largely migrated to free-form
 * `.aweek/agents/<slug>/plan.md` (see `plan-markdown-store.ts`). This
 * legacy JSON store stays around for backward compatibility with agents
 * that still carry per-goal files; new flows write to plan.md instead.
 */
import { readFile, writeFile, readdir, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValid } from '../schemas/validator.js';

const SCHEMA_ID = 'aweek://schemas/goal';

/** Time horizon for a goal — short / medium / long term. */
export type GoalHorizon = '1mo' | '3mo' | '1yr';

/** Lifecycle status of a single goal. */
export type GoalStatus = 'active' | 'completed' | 'paused' | 'dropped';

/**
 * Canonical shape of a single goal — mirrors `goalSchema` in
 * `src/schemas/goals.schema.js` (the schema literal is still authored as
 * a plain JS object, so the TypeScript shape is hand-mirrored here
 * rather than derived via `JSONSchemaType<Goal>`). The required vs.
 * optional split matches the schema's `required` array exactly.
 */
export interface Goal {
  /** Unique goal identifier (`goal-<lowercase-alphanum-and-hyphens>`). */
  id: string;
  /** What this goal aims to achieve. Must be a non-empty string. */
  description: string;
  /** Time horizon: 1mo (short-term), 3mo (medium-term), 1yr (long-term). */
  horizon: GoalHorizon;
  /** Lifecycle status. */
  status: GoalStatus;
  /** Target completion date (YYYY-MM-DD). */
  targetDate?: string;
  /** ISO-8601 date-time when the goal was created. */
  createdAt?: string;
  /** ISO-8601 date-time when the goal transitioned to `completed`. */
  completedAt?: string;
}

/** Updater function signature accepted by `GoalStore.update()`. */
export type GoalUpdater = (current: Goal) => Goal;

export class GoalStore {
  /** Root data directory (e.g., ./.aweek/agents) */
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Directory for an agent's goals. */
  _goalsDir(agentId: string): string {
    return join(this.baseDir, agentId, 'goals');
  }

  /** Path to a specific goal file. */
  _filePath(agentId: string, goalId: string): string {
    return join(this._goalsDir(agentId), `${goalId}.json`);
  }

  /** Ensure the goals directory for an agent exists. */
  async init(agentId: string): Promise<void> {
    await mkdir(this._goalsDir(agentId), { recursive: true });
  }

  /**
   * Save a goal. Validates before writing.
   * Idempotent: writing the same goal twice produces the same file.
   */
  async save(agentId: string, goal: Goal): Promise<Goal> {
    assertValid(SCHEMA_ID, goal);
    await this.init(agentId);
    const filePath = this._filePath(agentId, goal.id);
    const data = JSON.stringify(goal, null, 2) + '\n';
    await writeFile(filePath, data, 'utf-8');
    return goal;
  }

  /**
   * Load a goal by ID.
   * @throws If goal not found or invalid
   */
  async load(agentId: string, goalId: string): Promise<Goal> {
    const filePath = this._filePath(agentId, goalId);
    const raw = await readFile(filePath, 'utf-8');
    const goal = JSON.parse(raw) as Goal;
    assertValid(SCHEMA_ID, goal);
    return goal;
  }

  /** Check if a goal exists. */
  async exists(agentId: string, goalId: string): Promise<boolean> {
    try {
      await access(this._filePath(agentId, goalId));
      return true;
    } catch {
      return false;
    }
  }

  /** List all goal IDs for an agent. */
  async list(agentId: string): Promise<string[]> {
    await this.init(agentId);
    const entries = await readdir(this._goalsDir(agentId));
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  /** Load all goals for an agent. */
  async loadAll(agentId: string): Promise<Goal[]> {
    const ids = await this.list(agentId);
    return Promise.all(ids.map((id) => this.load(agentId, id)));
  }

  /** Load goals filtered by time horizon. */
  async loadByHorizon(agentId: string, horizon: GoalHorizon): Promise<Goal[]> {
    const all = await this.loadAll(agentId);
    return all.filter((g) => g.horizon === horizon);
  }

  /** Load only active goals for an agent. */
  async loadActive(agentId: string): Promise<Goal[]> {
    const all = await this.loadAll(agentId);
    return all.filter((g) => g.status === 'active');
  }

  /** Delete a goal. */
  async delete(agentId: string, goalId: string): Promise<void> {
    const filePath = this._filePath(agentId, goalId);
    await rm(filePath, { force: true });
  }

  /**
   * Update a goal via an updater function. Loads, patches, validates, saves.
   * The updater receives the current goal and must return the updated goal —
   * typically the same object after mutation, mirroring the legacy `.js`
   * callers' in-place style.
   */
  async update(
    agentId: string,
    goalId: string,
    updater: GoalUpdater,
  ): Promise<Goal> {
    const current = await this.load(agentId, goalId);
    const updated = updater(current);
    return this.save(agentId, updated);
  }

  /**
   * Update a goal's status. Convenience method.
   * Sets `completedAt` when status becomes 'completed'.
   */
  async updateStatus(
    agentId: string,
    goalId: string,
    status: GoalStatus,
  ): Promise<Goal> {
    return this.update(agentId, goalId, (goal) => {
      goal.status = status;
      if (status === 'completed') {
        goal.completedAt = new Date().toISOString();
      }
      return goal;
    });
  }
}
