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

export class WeeklyPlanStore {
  /**
   * @param {string} baseDir - Root data directory (e.g., ./.aweek/agents)
   */
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  /**
   * Directory for an agent's weekly plans.
   * @param {string} agentId
   */
  _plansDir(agentId) {
    return join(this.baseDir, agentId, 'weekly-plans');
  }

  /**
   * Path to a specific weekly plan file. Uses week as filename.
   * @param {string} agentId
   * @param {string} week - YYYY-Www
   */
  _filePath(agentId, week) {
    return join(this._plansDir(agentId), `${week}.json`);
  }

  /**
   * Ensure the weekly-plans directory for an agent exists.
   * @param {string} agentId
   */
  async init(agentId) {
    await mkdir(this._plansDir(agentId), { recursive: true });
  }

  /**
   * Save a weekly plan. Validates before writing.
   * Idempotent: writing the same plan twice produces the same file.
   * @param {string} agentId
   * @param {object} plan - Weekly plan object conforming to weekly-plan schema
   * @returns {Promise<object>} The saved plan
   */
  async save(agentId, plan) {
    assertValid(SCHEMA_ID, plan);
    await this.init(agentId);
    const filePath = this._filePath(agentId, plan.week);
    const data = JSON.stringify(plan, null, 2) + '\n';
    await writeFile(filePath, data, 'utf-8');
    return plan;
  }

  /**
   * Load a weekly plan by week.
   * @param {string} agentId
   * @param {string} week - YYYY-Www
   * @returns {Promise<object>} The parsed weekly plan
   * @throws {Error} If plan not found or invalid
   */
  async load(agentId, week) {
    const filePath = this._filePath(agentId, week);
    const raw = await readFile(filePath, 'utf-8');
    const plan = JSON.parse(raw);
    assertValid(SCHEMA_ID, plan);
    return plan;
  }

  /**
   * Check if a weekly plan exists for a given week.
   * @param {string} agentId
   * @param {string} week - YYYY-Www
   * @returns {Promise<boolean>}
   */
  async exists(agentId, week) {
    try {
      await access(this._filePath(agentId, week));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all week keys for an agent's weekly plans.
   * @param {string} agentId
   * @returns {Promise<string[]>} Array of YYYY-Www strings
   */
  async list(agentId) {
    await this.init(agentId);
    const entries = await readdir(this._plansDir(agentId));
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  }

  /**
   * Load all weekly plans for an agent.
   * @param {string} agentId
   * @returns {Promise<object[]>}
   */
  async loadAll(agentId) {
    const weeks = await this.list(agentId);
    return Promise.all(weeks.map((w) => this.load(agentId, w)));
  }

  /**
   * Load weekly plans for a specific month.
   * @param {string} agentId
   * @param {string} month - YYYY-MM
   * @returns {Promise<object[]>}
   */
  async loadByMonth(agentId, month) {
    const all = await this.loadAll(agentId);
    return all.filter((p) => p.month === month);
  }

  /**
   * Load the most recently approved weekly plan.
   * @param {string} agentId
   * @returns {Promise<object | null>} The approved plan, or null if none
   */
  async loadLatestApproved(agentId) {
    const all = await this.loadAll(agentId);
    const approved = all.filter((p) => p.approved);
    if (approved.length === 0) return null;
    // Sorted by week key; last is latest
    return approved[approved.length - 1];
  }

  /**
   * Delete a weekly plan.
   * @param {string} agentId
   * @param {string} week - YYYY-Www
   */
  async delete(agentId, week) {
    const filePath = this._filePath(agentId, week);
    await rm(filePath, { force: true });
  }

  /**
   * Update a weekly plan via an updater function. Loads, patches, validates, saves.
   * @param {string} agentId
   * @param {string} week - YYYY-Www
   * @param {function(object): object} updater - Receives current plan, returns updated plan
   * @returns {Promise<object>} Updated plan
   */
  async update(agentId, week, updater) {
    const current = await this.load(agentId, week);
    const updated = updater(current);
    updated.updatedAt = new Date().toISOString();
    return this.save(agentId, updated);
  }

  /**
   * Approve a weekly plan. Sets approved=true and records approvedAt.
   * This is the human-in-the-loop gate — first approval triggers heartbeat activation.
   * @param {string} agentId
   * @param {string} week - YYYY-Www
   * @returns {Promise<object>} The approved plan
   */
  async approve(agentId, week) {
    return this.update(agentId, week, (plan) => {
      plan.approved = true;
      plan.approvedAt = new Date().toISOString();
      return plan;
    });
  }

  /**
   * Update a task's status within a weekly plan.
   * Sets completedAt when status becomes 'completed'.
   * @param {string} agentId
   * @param {string} week - YYYY-Www
   * @param {string} taskId
   * @param {'pending' | 'in-progress' | 'completed' | 'failed' | 'delegated' | 'skipped'} status
   * @returns {Promise<object | null>} The updated task, or null if not found
   */
  async updateTaskStatus(agentId, week, taskId, status) {
    const plan = await this.load(agentId, week);
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return null;

    task.status = status;
    if (status === 'completed') {
      task.completedAt = new Date().toISOString();
    }
    plan.updatedAt = new Date().toISOString();
    await this.save(agentId, plan);
    return task;
  }

  /**
   * Add a task to an existing weekly plan.
   * @param {string} agentId
   * @param {string} week - YYYY-Www
   * @param {object} task - Task conforming to weekly-task schema
   * @returns {Promise<object>} The added task
   */
  async addTask(agentId, week, task) {
    return this.update(agentId, week, (plan) => {
      plan.tasks.push(task);
      return plan;
    }).then(() => task);
  }

  /**
   * Get all tasks that trace back to a specific objective.
   * Searches across all weekly plans for plan traceability.
   * @param {string} agentId
   * @param {string} objectiveId
   * @returns {Promise<object[]>} Tasks referencing this objective
   */
  async getTasksForObjective(agentId, objectiveId) {
    const all = await this.loadAll(agentId);
    const results = [];
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
