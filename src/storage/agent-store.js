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
   * The per-week `WeeklyPlanStore` is the single source of truth for
   * weekly plans. If `config.weeklyPlans` is present (legacy in-memory
   * input from tests or pre-migration callers), reconcile the file
   * store with it — every plan in the array is written to its per-week
   * file and any existing per-week file for a week NOT in the array is
   * deleted. The `weeklyPlans` field is then stripped from `config`
   * before serialising so the persisted agent JSON never contains it
   * (the schema's `additionalProperties: false` would reject it
   * anyway).
   *
   * @param {object} config - Full agent config object
   */
  async save(config) {
    await this.init();

    // Reconcile the per-week file store with any in-memory input.
    // Callers that have already migrated to WeeklyPlanStore simply
    // pass a config WITHOUT `weeklyPlans`; the reconcile loop is a
    // no-op for them.
    if (Array.isArray(config.weeklyPlans)) {
      const weeklyPlanStore = new WeeklyPlanStore(this.baseDir);
      const plansToWrite = config.weeklyPlans.filter((p) => p && p.week);
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
      // Strip the field before schema validation / serialisation — the
      // agent schema (additionalProperties: false) no longer permits it.
      delete config.weeklyPlans;
    }

    assertValid(SCHEMA_ID, config);
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
   * on first load, then DELETES the field from the in-memory object
   * before schema validation. The returned config never carries
   * `weeklyPlans` — consumers must read weekly plans via
   * `WeeklyPlanStore` directly.
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
    // store, then drop the field. We do this BEFORE schema validation
    // because the agent schema (post-refactor) no longer permits
    // `weeklyPlans` at all.
    if (Array.isArray(config.weeklyPlans) && config.weeklyPlans.length > 0) {
      const weeklyPlanStore = new WeeklyPlanStore(this.baseDir);
      for (const plan of config.weeklyPlans) {
        if (!plan?.week) continue;
        if (await weeklyPlanStore.exists(agentId, plan.week)) continue;
        await weeklyPlanStore.save(agentId, plan);
      }
    }
    // Always strip — even an empty array must not reach the validator.
    delete config.weeklyPlans;

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
   * Like `loadAll` but tolerates per-file failures instead of failing
   * the whole list on the first bad agent. Callers (dashboards) surface
   * the collected errors in the UI so drifted data stays discoverable
   * instead of silently disappearing.
   *
   * @returns {Promise<{ agents: object[], errors: Array<{ id: string, message: string }> }>}
   */
  async loadAllPartial() {
    const ids = await this.list();
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          return { ok: true, id, agent: await this.load(id) };
        } catch (err) {
          return {
            ok: false,
            id,
            message: (err && err.message) || 'unknown error',
          };
        }
      }),
    );
    const agents = [];
    const errors = [];
    for (const r of results) {
      if (r.ok) agents.push(r.agent);
      else errors.push({ id: r.id, message: r.message });
    }
    return { agents, errors };
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
 * plans directory hasn't been created yet. Used by `save` to reconcile
 * the per-week file store against an in-memory `weeklyPlans` array —
 * we need the existing week list to know which per-week files to
 * delete when a caller drops a week from the array.
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
