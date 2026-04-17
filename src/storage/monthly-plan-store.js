/**
 * Storage layer for agent monthly plans.
 * Persists monthly plans as JSON files under data/agents/<agentId>/monthly-plans/.
 * Each monthly plan is keyed by its month (YYYY-MM) for easy lookup.
 * Files are the source of truth — human-readable and skill-readable.
 *
 * Plan traceability: goals -> monthly objectives -> weekly tasks.
 */
import { readFile, writeFile, readdir, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValid } from '../schemas/validator.js';

const SCHEMA_ID = 'aweek://schemas/monthly-plan';

export class MonthlyPlanStore {
  /**
   * @param {string} baseDir - Root data directory (e.g., ./data/agents)
   */
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  /**
   * Directory for an agent's monthly plans.
   * @param {string} agentId
   */
  _plansDir(agentId) {
    return join(this.baseDir, agentId, 'monthly-plans');
  }

  /**
   * Path to a specific monthly plan file. Uses month as filename.
   * @param {string} agentId
   * @param {string} month - YYYY-MM
   */
  _filePath(agentId, month) {
    return join(this._plansDir(agentId), `${month}.json`);
  }

  /**
   * Ensure the monthly-plans directory for an agent exists.
   * @param {string} agentId
   */
  async init(agentId) {
    await mkdir(this._plansDir(agentId), { recursive: true });
  }

  /**
   * Save a monthly plan. Validates before writing.
   * Idempotent: writing the same plan twice produces the same file.
   * @param {string} agentId
   * @param {object} plan - Monthly plan object conforming to monthly-plan schema
   * @returns {Promise<object>} The saved plan
   */
  async save(agentId, plan) {
    assertValid(SCHEMA_ID, plan);
    await this.init(agentId);
    const filePath = this._filePath(agentId, plan.month);
    const data = JSON.stringify(plan, null, 2) + '\n';
    await writeFile(filePath, data, 'utf-8');
    return plan;
  }

  /**
   * Load a monthly plan by month.
   * @param {string} agentId
   * @param {string} month - YYYY-MM
   * @returns {Promise<object>} The parsed monthly plan
   * @throws {Error} If plan not found or invalid
   */
  async load(agentId, month) {
    const filePath = this._filePath(agentId, month);
    const raw = await readFile(filePath, 'utf-8');
    const plan = JSON.parse(raw);
    assertValid(SCHEMA_ID, plan);
    return plan;
  }

  /**
   * Check if a monthly plan exists for a given month.
   * @param {string} agentId
   * @param {string} month - YYYY-MM
   * @returns {Promise<boolean>}
   */
  async exists(agentId, month) {
    try {
      await access(this._filePath(agentId, month));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all month keys for an agent's monthly plans.
   * @param {string} agentId
   * @returns {Promise<string[]>} Array of YYYY-MM strings
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
   * Load all monthly plans for an agent.
   * @param {string} agentId
   * @returns {Promise<object[]>}
   */
  async loadAll(agentId) {
    const months = await this.list(agentId);
    return Promise.all(months.map((m) => this.load(agentId, m)));
  }

  /**
   * Load the currently active monthly plan (status === 'active').
   * @param {string} agentId
   * @returns {Promise<object | null>} The active plan, or null if none
   */
  async loadActive(agentId) {
    const all = await this.loadAll(agentId);
    return all.find((p) => p.status === 'active') || null;
  }

  /**
   * Delete a monthly plan.
   * @param {string} agentId
   * @param {string} month - YYYY-MM
   */
  async delete(agentId, month) {
    const filePath = this._filePath(agentId, month);
    await rm(filePath, { force: true });
  }

  /**
   * Update a monthly plan via an updater function. Loads, patches, validates, saves.
   * @param {string} agentId
   * @param {string} month - YYYY-MM
   * @param {function(object): object} updater - Receives current plan, returns updated plan
   * @returns {Promise<object>} Updated plan
   */
  async update(agentId, month, updater) {
    const current = await this.load(agentId, month);
    const updated = updater(current);
    updated.updatedAt = new Date().toISOString();
    return this.save(agentId, updated);
  }

  /**
   * Update a monthly plan's status. Convenience method.
   * @param {string} agentId
   * @param {string} month - YYYY-MM
   * @param {'draft' | 'active' | 'completed' | 'archived'} status
   * @returns {Promise<object>} Updated plan
   */
  async updateStatus(agentId, month, status) {
    return this.update(agentId, month, (plan) => {
      plan.status = status;
      return plan;
    });
  }

  /**
   * Update an objective's status within a monthly plan.
   * Sets completedAt when status becomes 'completed'.
   * @param {string} agentId
   * @param {string} month - YYYY-MM
   * @param {string} objectiveId
   * @param {'planned' | 'in-progress' | 'completed' | 'dropped'} status
   * @returns {Promise<object | null>} The updated objective, or null if not found
   */
  async updateObjectiveStatus(agentId, month, objectiveId, status) {
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

  /**
   * Add an objective to an existing monthly plan.
   * @param {string} agentId
   * @param {string} month - YYYY-MM
   * @param {object} objective - Objective conforming to monthly-objective schema
   * @returns {Promise<object>} The added objective
   */
  async addObjective(agentId, month, objective) {
    return this.update(agentId, month, (plan) => {
      plan.objectives.push(objective);
      return plan;
    }).then(() => objective);
  }

  /**
   * Get all objectives that trace back to a specific goal.
   * Searches across all monthly plans for plan traceability.
   * @param {string} agentId
   * @param {string} goalId
   * @returns {Promise<object[]>} Objectives referencing this goal
   */
  async getObjectivesForGoal(agentId, goalId) {
    const all = await this.loadAll(agentId);
    const results = [];
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
