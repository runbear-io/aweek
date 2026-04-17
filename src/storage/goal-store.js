/**
 * Storage layer for agent goals.
 * Persists goals as JSON files under .aweek/agents/<agentId>/goals/.
 * Each goal is its own file for granular access and idempotent writes.
 * Files are the source of truth — human-readable and skill-readable.
 *
 * Plan traceability: goals -> monthly objectives -> weekly tasks.
 */
import { readFile, writeFile, readdir, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValid } from '../schemas/validator.js';

const SCHEMA_ID = 'aweek://schemas/goal';

export class GoalStore {
  /**
   * @param {string} baseDir - Root data directory (e.g., ./.aweek/agents)
   */
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  /**
   * Directory for an agent's goals.
   * @param {string} agentId
   */
  _goalsDir(agentId) {
    return join(this.baseDir, agentId, 'goals');
  }

  /**
   * Path to a specific goal file.
   * @param {string} agentId
   * @param {string} goalId
   */
  _filePath(agentId, goalId) {
    return join(this._goalsDir(agentId), `${goalId}.json`);
  }

  /**
   * Ensure the goals directory for an agent exists.
   * @param {string} agentId
   */
  async init(agentId) {
    await mkdir(this._goalsDir(agentId), { recursive: true });
  }

  /**
   * Save a goal. Validates before writing.
   * Idempotent: writing the same goal twice produces the same file.
   * @param {string} agentId
   * @param {object} goal - Goal object conforming to goal schema
   * @returns {Promise<object>} The saved goal
   */
  async save(agentId, goal) {
    assertValid(SCHEMA_ID, goal);
    await this.init(agentId);
    const filePath = this._filePath(agentId, goal.id);
    const data = JSON.stringify(goal, null, 2) + '\n';
    await writeFile(filePath, data, 'utf-8');
    return goal;
  }

  /**
   * Load a goal by ID.
   * @param {string} agentId
   * @param {string} goalId
   * @returns {Promise<object>} The parsed goal
   * @throws {Error} If goal not found or invalid
   */
  async load(agentId, goalId) {
    const filePath = this._filePath(agentId, goalId);
    const raw = await readFile(filePath, 'utf-8');
    const goal = JSON.parse(raw);
    assertValid(SCHEMA_ID, goal);
    return goal;
  }

  /**
   * Check if a goal exists.
   * @param {string} agentId
   * @param {string} goalId
   * @returns {Promise<boolean>}
   */
  async exists(agentId, goalId) {
    try {
      await access(this._filePath(agentId, goalId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all goal IDs for an agent.
   * @param {string} agentId
   * @returns {Promise<string[]>}
   */
  async list(agentId) {
    await this.init(agentId);
    const entries = await readdir(this._goalsDir(agentId));
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  /**
   * Load all goals for an agent.
   * @param {string} agentId
   * @returns {Promise<object[]>}
   */
  async loadAll(agentId) {
    const ids = await this.list(agentId);
    return Promise.all(ids.map((id) => this.load(agentId, id)));
  }

  /**
   * Load goals filtered by time horizon.
   * @param {string} agentId
   * @param {'1mo' | '3mo' | '1yr'} horizon
   * @returns {Promise<object[]>}
   */
  async loadByHorizon(agentId, horizon) {
    const all = await this.loadAll(agentId);
    return all.filter((g) => g.horizon === horizon);
  }

  /**
   * Load only active goals for an agent.
   * @param {string} agentId
   * @returns {Promise<object[]>}
   */
  async loadActive(agentId) {
    const all = await this.loadAll(agentId);
    return all.filter((g) => g.status === 'active');
  }

  /**
   * Delete a goal.
   * @param {string} agentId
   * @param {string} goalId
   */
  async delete(agentId, goalId) {
    const filePath = this._filePath(agentId, goalId);
    await rm(filePath, { force: true });
  }

  /**
   * Update a goal via an updater function. Loads, patches, validates, saves.
   * @param {string} agentId
   * @param {string} goalId
   * @param {function(object): object} updater - Receives current goal, returns updated goal
   * @returns {Promise<object>} Updated goal
   */
  async update(agentId, goalId, updater) {
    const current = await this.load(agentId, goalId);
    const updated = updater(current);
    return this.save(agentId, updated);
  }

  /**
   * Update a goal's status. Convenience method.
   * Sets completedAt when status becomes 'completed'.
   * @param {string} agentId
   * @param {string} goalId
   * @param {'active' | 'completed' | 'paused' | 'dropped'} status
   * @returns {Promise<object>} Updated goal
   */
  async updateStatus(agentId, goalId, status) {
    return this.update(agentId, goalId, (goal) => {
      goal.status = status;
      if (status === 'completed') {
        goal.completedAt = new Date().toISOString();
      }
      return goal;
    });
  }
}
