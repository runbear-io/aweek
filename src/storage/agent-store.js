/**
 * Storage layer for agent configs.
 * Persists each agent as a JSON file under a designated directory.
 * Files are the source of truth — human-readable and skill-readable.
 */
import { readFile, writeFile, readdir, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValid } from '../schemas/validator.js';
import { WeeklyPlanStore } from './weekly-plan-store.js';

const SCHEMA_ID = 'aweek://schemas/agent-config';

export class AgentStore {
  /**
   * @param {string} baseDir - Root directory for agent data (e.g., ./.aweek/agents)
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
   *
   * Dual-writes the per-week plan files through `WeeklyPlanStore` so
   * the heartbeat (which reads the file store directly) sees the same
   * data the `/aweek:plan` skill produced. The embedded array is
   * stripped from the persisted agent JSON so the file store becomes
   * the single source of truth for weekly plans.
   *
   * @param {object} config - Full agent config object
   */
  async save(config) {
    assertValid(SCHEMA_ID, config);
    await this.init();

    // Dual-write: reconcile the per-week file store with the in-memory
    // array so the heartbeat (which reads files) matches what the
    // `/aweek:plan` writer just produced. This means:
    //   - Every plan in the array is written to its per-week file.
    //   - Any per-week file for a week NOT in the array is deleted
    //     (so reject / remove operations propagate correctly).
    const weeklyPlanStore = new WeeklyPlanStore(this.baseDir);
    const plansToWrite = Array.isArray(config.weeklyPlans)
      ? config.weeklyPlans.filter((p) => p && p.week)
      : [];
    const keepWeeks = new Set(plansToWrite.map((p) => p.week));
    const existingWeeks = await _safeListWeeks(weeklyPlanStore, config.id);
    for (const week of existingWeeks) {
      if (!keepWeeks.has(week)) {
        await weeklyPlanStore.delete(config.id, week);
      }
    }
    for (const plan of plansToWrite) {
      await weeklyPlanStore.save(config.id, plan);
    }

    // Phase 1 transitional: keep the embedded `weeklyPlans` array in
    // the agent JSON so legacy readers (summary, approval, manage,
    // calendar, …) still find it. Phase 3 will strip it and remove the
    // schema field once every consumer has been migrated to read from
    // WeeklyPlanStore directly.
    const filePath = this._filePath(config.id);
    const data = JSON.stringify(config, null, 2) + '\n';
    await writeFile(filePath, data, 'utf-8');
    return config;
  }

  /**
   * Load an agent config by ID.
   *
   * Transparently migrates legacy embedded `weeklyPlans: [...]` arrays
   * onto the per-week file store (`<agentId>/weekly-plans/<week>.json`)
   * on first load, then reattaches the array from the file store so
   * callers still see `config.weeklyPlans` while the refactor is in
   * flight. Phase 3 of the single-source-of-truth refactor drops the
   * reattachment entirely.
   *
   * @param {string} agentId
   * @returns {Promise<object>} The parsed agent config
   * @throws {Error} If agent not found or invalid
   */
  async load(agentId) {
    const filePath = this._filePath(agentId);
    const raw = await readFile(filePath, 'utf-8');
    const config = JSON.parse(raw);

    // Migration: move legacy embedded weeklyPlans to the per-week file
    // store. We do this BEFORE schema validation so legacy configs don't
    // trip validators in the transitional state.
    const weeklyPlanStore = new WeeklyPlanStore(this.baseDir);
    if (Array.isArray(config.weeklyPlans) && config.weeklyPlans.length > 0) {
      for (const plan of config.weeklyPlans) {
        if (!plan?.week) continue;
        if (await weeklyPlanStore.exists(agentId, plan.week)) continue;
        await weeklyPlanStore.save(agentId, plan);
      }
    }

    // Reattach weeklyPlans from the file store so every consumer reads
    // the same up-to-date slice regardless of which write path produced
    // it. The array is a derived view during Phase 2; AgentStore.save
    // strips it before persisting so the embedded copy never drifts.
    const persistedWeeks = await _safeListWeeks(weeklyPlanStore, agentId);
    const loaded = [];
    for (const week of persistedWeeks) {
      try {
        loaded.push(await weeklyPlanStore.load(agentId, week));
      } catch {
        // Skip unreadable weekly plan files; heartbeat selectors will
        // surface the error on their own read path.
      }
    }
    config.weeklyPlans = loaded;

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

/**
 * List weekly-plan weeks for an agent without blowing up if the
 * plans directory hasn't been created yet. Used by `load` to reattach
 * plans for backward-compat consumers that still read
 * `config.weeklyPlans`.
 *
 * @param {WeeklyPlanStore} store
 * @param {string} agentId
 * @returns {Promise<string[]>}
 */
async function _safeListWeeks(store, agentId) {
  try {
    return await store.list(agentId);
  } catch {
    return [];
  }
}
