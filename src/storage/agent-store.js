/**
 * Storage layer for agent configs.
 * Persists each agent as a JSON file under a designated directory.
 * Files are the source of truth — human-readable and skill-readable.
 */
import { readFile, writeFile, readdir, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValid } from '../schemas/validator.js';

const SCHEMA_ID = 'aweek://schemas/agent-config';

export class AgentStore {
  /**
   * @param {string} baseDir - Root directory for agent data (e.g., ./data/agents)
   */
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  /** Ensure the base directory exists */
  async init() {
    await mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Path to an agent's config file.
   * @param {string} agentId
   */
  _filePath(agentId) {
    return join(this.baseDir, `${agentId}.json`);
  }

  /**
   * Save an agent config. Validates before writing.
   * Idempotent: writing the same config twice produces the same file.
   * @param {object} config - Full agent config object
   */
  async save(config) {
    assertValid(SCHEMA_ID, config);
    await this.init();
    const filePath = this._filePath(config.id);
    const data = JSON.stringify(config, null, 2) + '\n';
    await writeFile(filePath, data, 'utf-8');
    return config;
  }

  /**
   * Load an agent config by ID.
   * @param {string} agentId
   * @returns {Promise<object>} The parsed agent config
   * @throws {Error} If agent not found or invalid
   */
  async load(agentId) {
    const filePath = this._filePath(agentId);
    const raw = await readFile(filePath, 'utf-8');
    const config = JSON.parse(raw);
    assertValid(SCHEMA_ID, config);
    return config;
  }

  /**
   * Check if an agent exists.
   * @param {string} agentId
   * @returns {Promise<boolean>}
   */
  async exists(agentId) {
    try {
      await access(this._filePath(agentId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all agent IDs.
   * @returns {Promise<string[]>}
   */
  async list() {
    await this.init();
    const entries = await readdir(this.baseDir);
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  /**
   * Load all agent configs.
   * @returns {Promise<object[]>}
   */
  async loadAll() {
    const ids = await this.list();
    return Promise.all(ids.map((id) => this.load(id)));
  }

  /**
   * Delete an agent config.
   * @param {string} agentId
   */
  async delete(agentId) {
    const filePath = this._filePath(agentId);
    await rm(filePath, { force: true });
  }

  /**
   * Update an agent config (merge-style). Loads, patches, validates, saves.
   * @param {string} agentId
   * @param {function(object): object} updater - Receives current config, returns updated config
   * @returns {Promise<object>} Updated config
   */
  async update(agentId, updater) {
    const current = await this.load(agentId);
    const updated = updater(current);
    updated.updatedAt = new Date().toISOString();
    return this.save(updated);
  }
}
