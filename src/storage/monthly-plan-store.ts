/**
 * Storage layer for agent monthly plans.
 * Persists monthly plans as JSON files under .aweek/agents/<agentId>/monthly-plans/.
 * Each monthly plan is keyed by its month (YYYY-MM) for easy lookup.
 * Files are the source of truth — human-readable and skill-readable.
 *
 * Plan traceability: goals -> monthly objectives -> weekly tasks.
 */
import { readFile, writeFile, readdir, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValid } from '../schemas/validator.js';

const SCHEMA_ID = 'aweek://schemas/monthly-plan';

/** Lifecycle status of a single monthly plan objective. */
export type MonthlyObjectiveStatus = 'planned' | 'in-progress' | 'completed' | 'dropped';

/** Lifecycle status of a monthly plan. */
export type MonthlyPlanStatus = 'draft' | 'active' | 'completed' | 'archived';

/**
 * Canonical shape of a monthly plan objective — mirrors
 * `monthlyObjectiveSchema` in `src/schemas/monthly-plan.schema.js`.
 * Required vs. optional matches the schema's `required` array exactly.
 */
export interface MonthlyObjective {
  /** Unique objective identifier (`obj-<lowercase-alphanum-and-hyphens>`). */
  id: string;
  /** What this objective aims to accomplish. Non-empty. */
  description: string;
  /** Parent goal this objective traces back to (`goal-...`). */
  goalId: string;
  status: MonthlyObjectiveStatus;
  /** ISO-8601 date-time when status became `completed`. */
  completedAt?: string;
}

/**
 * Canonical shape of a monthly plan — mirrors `monthlyPlanSchema` in
 * `src/schemas/monthly-plan.schema.js`. Required vs. optional matches
 * the schema's `required` array exactly.
 */
export interface MonthlyPlan {
  /** Plan month in `YYYY-MM` format. */
  month: string;
  /** At least one objective tracing back to a goal. */
  objectives: MonthlyObjective[];
  status: MonthlyPlanStatus;
  /** Optional high-level summary of this month's focus. */
  summary?: string;
  /** ISO-8601 date-time. */
  createdAt?: string;
  /** ISO-8601 date-time. */
  updatedAt?: string;
}

/** Updater function signature accepted by `MonthlyPlanStore.update()`. */
export type MonthlyPlanUpdater = (current: MonthlyPlan) => MonthlyPlan;

export class MonthlyPlanStore {
  /** Root data directory (e.g., ./.aweek/agents) */
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Directory for an agent's monthly plans. */
  _plansDir(agentId: string): string {
    return join(this.baseDir, agentId, 'monthly-plans');
  }

  /** Path to a specific monthly plan file. Uses month as filename. */
  _filePath(agentId: string, month: string): string {
    return join(this._plansDir(agentId), `${month}.json`);
  }

  /** Ensure the monthly-plans directory for an agent exists. */
  async init(agentId: string): Promise<void> {
    await mkdir(this._plansDir(agentId), { recursive: true });
  }

  /**
   * Save a monthly plan. Validates before writing.
   * Idempotent: writing the same plan twice produces the same file.
   */
  async save(agentId: string, plan: MonthlyPlan): Promise<MonthlyPlan> {
    assertValid(SCHEMA_ID, plan);
    await this.init(agentId);
    const filePath = this._filePath(agentId, plan.month);
    const data = JSON.stringify(plan, null, 2) + '\n';
    await writeFile(filePath, data, 'utf-8');
    return plan;
  }

  /**
   * Load a monthly plan by month.
   * @throws If plan not found or invalid
   */
  async load(agentId: string, month: string): Promise<MonthlyPlan> {
    const filePath = this._filePath(agentId, month);
    const raw = await readFile(filePath, 'utf-8');
    const plan = JSON.parse(raw) as MonthlyPlan;
    assertValid(SCHEMA_ID, plan);
    return plan;
  }

  /** Check if a monthly plan exists for a given month. */
  async exists(agentId: string, month: string): Promise<boolean> {
    try {
      await access(this._filePath(agentId, month));
      return true;
    } catch {
      return false;
    }
  }

  /** List all month keys for an agent's monthly plans. */
  async list(agentId: string): Promise<string[]> {
    await this.init(agentId);
    const entries = await readdir(this._plansDir(agentId));
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  }

  /** Load all monthly plans for an agent. */
  async loadAll(agentId: string): Promise<MonthlyPlan[]> {
    const months = await this.list(agentId);
    return Promise.all(months.map((m) => this.load(agentId, m)));
  }

  /** Load the currently active monthly plan (status === 'active'). */
  async loadActive(agentId: string): Promise<MonthlyPlan | null> {
    const all = await this.loadAll(agentId);
    return all.find((p) => p.status === 'active') || null;
  }

  /** Delete a monthly plan. */
  async delete(agentId: string, month: string): Promise<void> {
    const filePath = this._filePath(agentId, month);
    await rm(filePath, { force: true });
  }

  /**
   * Update a monthly plan via an updater function. Loads, patches,
   * validates, saves.
   */
  async update(
    agentId: string,
    month: string,
    updater: MonthlyPlanUpdater,
  ): Promise<MonthlyPlan> {
    const current = await this.load(agentId, month);
    const updated = updater(current);
    updated.updatedAt = new Date().toISOString();
    return this.save(agentId, updated);
  }

  /** Update a monthly plan's status. Convenience method. */
  async updateStatus(
    agentId: string,
    month: string,
    status: MonthlyPlanStatus,
  ): Promise<MonthlyPlan> {
    return this.update(agentId, month, (plan) => {
      plan.status = status;
      return plan;
    });
  }

  /**
   * Update an objective's status within a monthly plan.
   * Sets completedAt when status becomes 'completed'.
   * @returns The updated objective, or null if not found
   */
  async updateObjectiveStatus(
    agentId: string,
    month: string,
    objectiveId: string,
    status: MonthlyObjectiveStatus,
  ): Promise<MonthlyObjective | null> {
    const plan = await this.load(agentId, month);
    const obj = plan.objectives.find((o) => o.id === objectiveId);
    if (!obj) return null;

    obj.status = status;
    if (status === 'completed') {
      obj.completedAt = new Date().toISOString();
    }
    plan.updatedAt = new Date().toISOString();
    await this.save(agentId, plan);
    return obj;
  }

  /** Add an objective to an existing monthly plan. */
  async addObjective(
    agentId: string,
    month: string,
    objective: MonthlyObjective,
  ): Promise<MonthlyObjective> {
    return this.update(agentId, month, (plan) => {
      plan.objectives.push(objective);
      return plan;
    }).then(() => objective);
  }

  /**
   * Get all objectives that trace back to a specific goal.
   * Searches across all monthly plans for plan traceability.
   */
  async getObjectivesForGoal(
    agentId: string,
    goalId: string,
  ): Promise<MonthlyObjective[]> {
    const all = await this.loadAll(agentId);
    const results: MonthlyObjective[] = [];
    for (const plan of all) {
      for (const obj of plan.objectives) {
        if (obj.goalId === goalId) {
          results.push(obj);
        }
      }
    }
    return results;
  }
}
