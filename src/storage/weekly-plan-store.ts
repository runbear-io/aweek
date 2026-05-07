/**
 * Storage layer for agent weekly plans.
 * Persists weekly plans as JSON files under .aweek/agents/<agentId>/weekly-plans/.
 * Each weekly plan is keyed by its week (YYYY-Www) for easy lookup.
 * Files are the source of truth — human-readable and skill-readable.
 *
 * Plan traceability: goals -> monthly objectives -> weekly tasks.
 */
import { readFile, writeFile, readdir, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValid } from '../schemas/validator.js';

const SCHEMA_ID = 'aweek://schemas/weekly-plan';

/** Lifecycle status of a single weekly task. */
export type WeeklyTaskStatus =
  | 'pending'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'delegated'
  | 'skipped';

/** Priority levels for a weekly task. */
export type WeeklyTaskPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Canonical shape of a single weekly task — mirrors `weeklyTaskSchema`
 * in `src/schemas/weekly-plan.schema.js`. Required vs. optional matches
 * the schema's `required` array exactly. The schema is still authored
 * as a plain JS object, so the TypeScript shape is hand-mirrored here.
 */
export interface WeeklyTask {
  /** Unique task identifier (`task-<lowercase-alphanum-and-hyphens>`). */
  id: string;
  /** Short single-line label for the calendar / activity rows. */
  title: string;
  /** Long-form prompt sent to Claude when the heartbeat executes. */
  prompt: string;
  /**
   * Free-form tag linking the task back to a monthly section in plan.md.
   * Two values are reserved for advisor-mode review slots:
   * `daily-review` and `weekly-review`.
   */
  objectiveId?: string;
  priority?: WeeklyTaskPriority;
  /** Estimated time in minutes (1–480). */
  estimatedMinutes?: number;
  status: WeeklyTaskStatus;
  /** Agent ID if task was delegated. */
  delegatedTo?: string;
  /**
   * Independent pacing lane (e.g. `x-com`, `email-replies`). Defaults to
   * `objectiveId` when omitted; the task-selector picks ONE task per
   * distinct track per heartbeat tick.
   */
  track?: string;
  /** ISO-8601 date-time — earliest moment this task is eligible to run. */
  runAt?: string;
  /** ISO-8601 date-time when status became `completed`. */
  completedAt?: string;
  /**
   * Number of consecutive times this task has transitioned to `failed`
   * without an intervening success / replacement. Used by the
   * repeated-task-failure system-event emitter to fire a notification
   * once the threshold (currently 2) is reached. Reset to 0 / omitted on
   * any transition to a non-failed status, or when the task is replaced
   * by a new weekly plan. Absent value is equivalent to 0.
   */
  consecutiveFailures?: number;
  /**
   * Latch flag — set to `true` after the repeated-task-failure
   * notification has been emitted for the current failing streak.
   * Prevents the heartbeat from re-emitting another notification while
   * the task is still in the failing state. Cleared on transition to a
   * non-failed status so a future re-failure of the same task ID can
   * fire a fresh notification.
   */
  failureNotificationEmitted?: boolean;
  /**
   * Soft-failure concerns surfaced by the post-execution verifier when
   * the task transitioned to `completed` but the agent did not achieve
   * the stated outcome. Rendered as an amber badge on the calendar
   * chip. Cleared on the next attempt of the same task.
   */
  warnings?: string[];
  /**
   * Verifier verdict — `true` when the post-execution verifier confirmed
   * the agent met the stated outcome, `false` when concerns were
   * detected (in which case `warnings` is non-empty). Absent when the
   * verifier was skipped (failed task, config-disabled, no verifier
   * callable wired in).
   */
  outcomeAchieved?: boolean;
}

/**
 * Canonical shape of a weekly plan — mirrors `weeklyPlanSchema` in
 * `src/schemas/weekly-plan.schema.js`. Required vs. optional matches the
 * schema's `required` array exactly.
 */
export interface WeeklyPlan {
  /** ISO week format `YYYY-Www`. */
  week: string;
  /** Parent month this plan belongs to (`YYYY-MM`). */
  month: string;
  tasks: WeeklyTask[];
  /** Human-in-the-loop approval gate. */
  approved: boolean;
  /** ISO-8601 date-time when the plan was approved. */
  approvedAt?: string;
  /** ISO-8601 date-time. */
  createdAt?: string;
  /** ISO-8601 date-time. */
  updatedAt?: string;
}

/** Updater function signature accepted by `WeeklyPlanStore.update()`. */
export type WeeklyPlanUpdater = (current: WeeklyPlan) => WeeklyPlan;

export class WeeklyPlanStore {
  /** Root data directory (e.g., ./.aweek/agents) */
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Directory for an agent's weekly plans. */
  _plansDir(agentId: string): string {
    return join(this.baseDir, agentId, 'weekly-plans');
  }

  /** Path to a specific weekly plan file. Uses week as filename. */
  _filePath(agentId: string, week: string): string {
    return join(this._plansDir(agentId), `${week}.json`);
  }

  /** Ensure the weekly-plans directory for an agent exists. */
  async init(agentId: string): Promise<void> {
    await mkdir(this._plansDir(agentId), { recursive: true });
  }

  /**
   * Save a weekly plan. Validates before writing.
   * Idempotent: writing the same plan twice produces the same file.
   */
  async save(agentId: string, plan: WeeklyPlan): Promise<WeeklyPlan> {
    assertValid(SCHEMA_ID, plan);
    await this.init(agentId);
    const filePath = this._filePath(agentId, plan.week);
    const data = JSON.stringify(plan, null, 2) + '\n';
    await writeFile(filePath, data, 'utf-8');
    return plan;
  }

  /**
   * Load a weekly plan by week.
   * @throws If plan not found or invalid
   */
  async load(agentId: string, week: string): Promise<WeeklyPlan> {
    const filePath = this._filePath(agentId, week);
    const raw = await readFile(filePath, 'utf-8');
    const plan = JSON.parse(raw) as WeeklyPlan;
    assertValid(SCHEMA_ID, plan);
    return plan;
  }

  /** Check if a weekly plan exists for a given week. */
  async exists(agentId: string, week: string): Promise<boolean> {
    try {
      await access(this._filePath(agentId, week));
      return true;
    } catch {
      return false;
    }
  }

  /** List all week keys for an agent's weekly plans. */
  async list(agentId: string): Promise<string[]> {
    await this.init(agentId);
    const entries = await readdir(this._plansDir(agentId));
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  }

  /** Load all weekly plans for an agent. */
  async loadAll(agentId: string): Promise<WeeklyPlan[]> {
    const weeks = await this.list(agentId);
    return Promise.all(weeks.map((w) => this.load(agentId, w)));
  }

  /** Load weekly plans for a specific month (`YYYY-MM`). */
  async loadByMonth(agentId: string, month: string): Promise<WeeklyPlan[]> {
    const all = await this.loadAll(agentId);
    return all.filter((p) => p.month === month);
  }

  /** Load the most recently approved weekly plan. */
  async loadLatestApproved(agentId: string): Promise<WeeklyPlan | null> {
    const all = await this.loadAll(agentId);
    const approved = all.filter((p) => p.approved);
    if (approved.length === 0) return null;
    // Sorted by week key; last is latest
    return approved[approved.length - 1] ?? null;
  }

  /** Delete a weekly plan. */
  async delete(agentId: string, week: string): Promise<void> {
    const filePath = this._filePath(agentId, week);
    await rm(filePath, { force: true });
  }

  /**
   * Update a weekly plan via an updater function. Loads, patches,
   * validates, saves.
   */
  async update(
    agentId: string,
    week: string,
    updater: WeeklyPlanUpdater,
  ): Promise<WeeklyPlan> {
    const current = await this.load(agentId, week);
    const updated = updater(current);
    updated.updatedAt = new Date().toISOString();
    return this.save(agentId, updated);
  }

  /**
   * Approve a weekly plan. Sets approved=true and records approvedAt.
   * This is the human-in-the-loop gate — first approval triggers
   * heartbeat activation.
   */
  async approve(agentId: string, week: string): Promise<WeeklyPlan> {
    return this.update(agentId, week, (plan) => {
      plan.approved = true;
      plan.approvedAt = new Date().toISOString();
      return plan;
    });
  }

  /**
   * Update a task's status within a weekly plan.
   *
   * Side effects on top of the basic status assignment:
   *   - When `status === 'completed'`, stamps `completedAt`.
   *   - When `status === 'failed'`, increments `consecutiveFailures`
   *     (treats absent / non-numeric as 0). The `failureNotificationEmitted`
   *     latch is left as-is so the system-event emitter can decide whether
   *     to fire — once it does, it should call
   *     {@link markFailureNotificationEmitted} to set the flag.
   *   - On transition to ANY non-failed status (`pending`, `in-progress`,
   *     `completed`, `delegated`, `skipped`), the consecutive-failure
   *     tracker is reset by deleting both `consecutiveFailures` and
   *     `failureNotificationEmitted`. This is the "success or task change"
   *     reset path called out by the repeated-task-failure dedup contract:
   *     the next time the task fails, the streak starts fresh and a new
   *     notification can fire once the threshold is crossed again.
   *
   * Per-task-ID failure tracking is naturally bounded by the weekly plan's
   * lifetime — when next week's plan supersedes the current one (a "task
   * change" via plan replacement), the tracker simply doesn't carry over,
   * which satisfies the second half of the reset contract.
   *
   * @returns The updated task, or null if not found
   */
  async updateTaskStatus(
    agentId: string,
    week: string,
    taskId: string,
    status: WeeklyTaskStatus,
  ): Promise<WeeklyTask | null> {
    const plan = await this.load(agentId, week);
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return null;

    task.status = status;
    if (status === 'completed') {
      task.completedAt = new Date().toISOString();
    }
    if (status === 'failed') {
      const prev =
        typeof task.consecutiveFailures === 'number' &&
        Number.isFinite(task.consecutiveFailures) &&
        task.consecutiveFailures >= 0
          ? task.consecutiveFailures
          : 0;
      task.consecutiveFailures = prev + 1;
      // Leave failureNotificationEmitted as-is — the system-event emitter
      // is responsible for setting it via markFailureNotificationEmitted()
      // once the notification has actually been written. That separation
      // keeps the storage layer ignorant of notification semantics.
    } else {
      // Reset on any transition out of the failing state — success
      // (`completed`), replanning (`pending`), retry (`in-progress`),
      // hand-off (`delegated`), or explicit `skipped`.
      delete task.consecutiveFailures;
      delete task.failureNotificationEmitted;
    }
    // Verifier outcome from any prior attempt of this task is stale the
    // moment status changes — drop it so the post-execution verifier
    // (or its absence) writes the fresh verdict via `setTaskOutcome`.
    delete task.warnings;
    delete task.outcomeAchieved;
    plan.updatedAt = new Date().toISOString();
    await this.save(agentId, plan);
    return task;
  }

  /**
   * Persist the post-execution verifier verdict for a task. The
   * heartbeat calls this AFTER `updateTaskStatus` has already flipped
   * the status to `completed` and AFTER the verifier returned a
   * `verdict` result.
   *
   * - When `achieved === true`, both fields land on the task and the
   *   `warnings` array is empty (the calendar chip stays clean).
   * - When `achieved === false`, the concerns array drives the amber
   *   warning badge and the row tinting in the activity timeline.
   *
   * Idempotent: re-calling with an identical verdict does not rewrite
   * the plan file. Verdicts of the form `{ achieved: true, concerns: [] }`
   * vs an absent verdict produce indistinguishable rendering, so we
   * still write so the field acts as a "verifier ran" tombstone.
   *
   * @returns The updated task, or null if the plan / task is missing.
   */
  async setTaskOutcome(
    agentId: string,
    week: string,
    taskId: string,
    verdict: { achieved: boolean; concerns: ReadonlyArray<string> },
  ): Promise<WeeklyTask | null> {
    const plan = await this.load(agentId, week);
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    const concerns = verdict.achieved ? [] : verdict.concerns.slice();
    const sameAchieved = task.outcomeAchieved === verdict.achieved;
    const sameConcerns =
      Array.isArray(task.warnings) &&
      task.warnings.length === concerns.length &&
      task.warnings.every((c, i) => c === concerns[i]);
    if (sameAchieved && sameConcerns) return task;
    task.outcomeAchieved = verdict.achieved;
    if (concerns.length > 0) {
      task.warnings = concerns;
    } else {
      delete task.warnings;
    }
    plan.updatedAt = new Date().toISOString();
    await this.save(agentId, plan);
    return task;
  }

  /**
   * Set a task's `failureNotificationEmitted` latch to `true`.
   *
   * Called by the repeated-task-failure system-event emitter AFTER the
   * notification has been successfully written through the notification
   * store. Prevents the heartbeat from re-emitting another notification
   * for the same failing streak. The flag is cleared automatically on
   * the next non-failed status transition by {@link updateTaskStatus}.
   *
   * Idempotent: calling this on a task that already has the flag set is
   * a no-op (no rewrite of the plan file).
   *
   * @returns The updated task, or null if not found.
   */
  async markFailureNotificationEmitted(
    agentId: string,
    week: string,
    taskId: string,
  ): Promise<WeeklyTask | null> {
    const plan = await this.load(agentId, week);
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    if (task.failureNotificationEmitted === true) return task;
    task.failureNotificationEmitted = true;
    plan.updatedAt = new Date().toISOString();
    await this.save(agentId, plan);
    return task;
  }

  /**
   * Read-only view of a task's failure-tracking state. Returns the
   * absent-fields-as-zero defaults so callers don't need to repeat the
   * "treat undefined as 0/false" logic at every site.
   *
   * @returns
   *   - `null` if the plan or task does not exist.
   *   - `{ consecutiveFailures, notificationEmitted }` otherwise.
   */
  async getFailureTracker(
    agentId: string,
    week: string,
    taskId: string,
  ): Promise<{ consecutiveFailures: number; notificationEmitted: boolean } | null> {
    let plan: WeeklyPlan;
    try {
      plan = await this.load(agentId, week);
    } catch {
      return null;
    }
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    return {
      consecutiveFailures:
        typeof task.consecutiveFailures === 'number' && task.consecutiveFailures >= 0
          ? task.consecutiveFailures
          : 0,
      notificationEmitted: task.failureNotificationEmitted === true,
    };
  }

  /** Add a task to an existing weekly plan. */
  async addTask(
    agentId: string,
    week: string,
    task: WeeklyTask,
  ): Promise<WeeklyTask> {
    return this.update(agentId, week, (plan) => {
      plan.tasks.push(task);
      return plan;
    }).then(() => task);
  }

  /**
   * Get all tasks that trace back to a specific objective.
   * Searches across all weekly plans for plan traceability.
   */
  async getTasksForObjective(
    agentId: string,
    objectiveId: string,
  ): Promise<WeeklyTask[]> {
    const all = await this.loadAll(agentId);
    const results: WeeklyTask[] = [];
    for (const plan of all) {
      for (const task of plan.tasks) {
        if (task.objectiveId === objectiveId) {
          results.push(task);
        }
      }
    }
    return results;
  }
}
