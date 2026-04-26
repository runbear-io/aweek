/**
 * Storage layer for agent configs.
 * Persists each agent as a JSON file under a designated directory.
 * Files are the source of truth — human-readable and skill-readable.
 */
import { readFile, writeFile, readdir, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValid } from '../schemas/validator.js';
import { WeeklyPlanStore } from './weekly-plan-store.js';
import type { Agent } from '../schemas/agent.js';

const SCHEMA_ID = 'aweek://schemas/agent-config';

/**
 * Minimal shape of a legacy embedded weekly plan that may still appear on
 * pre-Phase-3 agent JSON documents. The canonical weekly-plan schema lives
 * in `src/schemas/weekly-plan.schema.js`; this seed only needs the `week`
 * key for the migration logic, so the rest of the plan is left as
 * `Record<string, unknown>` to avoid a cross-seed type dependency.
 */
interface LegacyWeeklyPlan extends Record<string, unknown> {
  week: string;
}

/**
 * Input shape accepted by `AgentStore.save()`.
 *
 * Pre-migration callers (and a handful of tests) may still hand in a config
 * that carries an embedded `weeklyPlans: [...]` array. Such arrays are
 * reconciled against the per-week `WeeklyPlanStore` and stripped before the
 * agent JSON is written to disk, so the persisted shape is always a plain
 * `Agent`. Modern callers simply pass `Agent` directly — the optional
 * `weeklyPlans` key is treated as a no-op.
 */
export type AgentSaveInput = Agent & { weeklyPlans?: LegacyWeeklyPlan[] };

/**
 * Outcome of `loadAllPartial()` — same as `loadAll()` but tolerates
 * per-file failures so dashboards can surface drifted data instead of
 * disappearing the whole roster on the first bad agent.
 */
export interface LoadAllPartialResult {
  agents: Agent[];
  errors: Array<{ id: string; message: string }>;
}

/** Updater function signature accepted by `AgentStore.update()`. */
export type AgentUpdater = (current: Agent) => Agent;

/** Single per-id outcome used internally by `loadAllPartial()`. */
type LoadAttempt =
  | { ok: true; id: string; agent: Agent }
  | { ok: false; id: string; message: string };

export class AgentStore {
  /** Root directory for agent data (e.g., ./.aweek/agents) */
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Ensure the base directory exists */
  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  /** Path to an agent's config file. */
  _filePath(agentId: string): string {
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
   */
  async save(config: AgentSaveInput): Promise<Agent> {
    await this.init();

    // Reconcile the per-week file store with any in-memory input.
    // Callers that have already migrated to WeeklyPlanStore simply
    // pass a config WITHOUT `weeklyPlans`; the reconcile loop is a
    // no-op for them.
    if (Array.isArray(config.weeklyPlans)) {
      const weeklyPlanStore = new WeeklyPlanStore(this.baseDir);
      const plansToWrite = config.weeklyPlans.filter(
        (p): p is LegacyWeeklyPlan => Boolean(p && typeof p.week === 'string'),
      );
      const keepWeeks = new Set(plansToWrite.map((p) => p.week));
      const existingWeeks = await _safeListWeeks(weeklyPlanStore, config.id);
      for (const week of existingWeeks) {
        if (!keepWeeks.has(week)) {
          await weeklyPlanStore.delete(config.id, week);
        }
      }
      for (const plan of plansToWrite) {
        // Legacy embedded plans are typed as `LegacyWeeklyPlan` (only the
        // `week` key is required at the agent-config layer); the per-week
        // `WeeklyPlanStore.save` enforces the full canonical shape via
        // its AJV-backed `assertValid` call. Cast through `unknown` so
        // the type-checker accepts the legacy shape — schema validation
        // remains the source of truth at runtime.
        await weeklyPlanStore.save(
          config.id,
          plan as unknown as Parameters<typeof weeklyPlanStore.save>[1],
        );
      }
      // Strip the field before schema validation / serialisation — the
      // agent schema (additionalProperties: false) no longer permits it.
      delete config.weeklyPlans;
    }

    assertValid(SCHEMA_ID, config);
    const filePath = this._filePath(config.id);
    const data = JSON.stringify(config, null, 2) + '\n';
    await writeFile(filePath, data, 'utf-8');
    // After the optional `weeklyPlans` strip + schema assertion above,
    // `config` matches `Agent` exactly — return it as the canonical type.
    return config as Agent;
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
   * @throws If agent not found or invalid
   */
  async load(agentId: string): Promise<Agent> {
    const filePath = this._filePath(agentId);
    const raw = await readFile(filePath, 'utf-8');
    const config = JSON.parse(raw) as AgentSaveInput;

    // Migration: move legacy embedded weeklyPlans to the per-week file
    // store, then drop the field. We do this BEFORE schema validation
    // because the agent schema (post-refactor) no longer permits
    // `weeklyPlans` at all.
    if (Array.isArray(config.weeklyPlans) && config.weeklyPlans.length > 0) {
      const weeklyPlanStore = new WeeklyPlanStore(this.baseDir);
      for (const plan of config.weeklyPlans) {
        if (!plan?.week) continue;
        if (await weeklyPlanStore.exists(agentId, plan.week)) continue;
        // See comment on the corresponding cast in `save()` above —
        // `LegacyWeeklyPlan` is intentionally permissive; the canonical
        // shape is enforced by AJV inside `WeeklyPlanStore.save`.
        await weeklyPlanStore.save(
          agentId,
          plan as unknown as Parameters<typeof weeklyPlanStore.save>[1],
        );
      }
    }
    // Always strip — even an empty array must not reach the validator.
    delete config.weeklyPlans;

    assertValid(SCHEMA_ID, config);
    return config as Agent;
  }

  /** Check if an agent exists. */
  async exists(agentId: string): Promise<boolean> {
    try {
      await access(this._filePath(agentId));
      return true;
    } catch {
      return false;
    }
  }

  /** List all agent IDs. */
  async list(): Promise<string[]> {
    await this.init();
    const entries = await readdir(this.baseDir);
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  /** Load all agent configs. */
  async loadAll(): Promise<Agent[]> {
    const ids = await this.list();
    return Promise.all(ids.map((id) => this.load(id)));
  }

  /**
   * Like `loadAll` but tolerates per-file failures instead of failing
   * the whole list on the first bad agent. Callers (dashboards) surface
   * the collected errors in the UI so drifted data stays discoverable
   * instead of silently disappearing.
   */
  async loadAllPartial(): Promise<LoadAllPartialResult> {
    const ids = await this.list();
    const results: LoadAttempt[] = await Promise.all(
      ids.map(async (id): Promise<LoadAttempt> => {
        try {
          return { ok: true, id, agent: await this.load(id) };
        } catch (err) {
          const message =
            err instanceof Error && err.message ? err.message : 'unknown error';
          return { ok: false, id, message };
        }
      }),
    );
    const agents: Agent[] = [];
    const errors: Array<{ id: string; message: string }> = [];
    for (const r of results) {
      if (r.ok) agents.push(r.agent);
      else errors.push({ id: r.id, message: r.message });
    }
    return { agents, errors };
  }

  /** Delete an agent config. */
  async delete(agentId: string): Promise<void> {
    const filePath = this._filePath(agentId);
    await rm(filePath, { force: true });
  }

  /**
   * Update an agent config (merge-style). Loads, patches, validates, saves.
   * The `updater` receives the current config and must return the updated
   * config — typically the same object after mutation, in line with the
   * legacy `.js` callers.
   */
  async update(agentId: string, updater: AgentUpdater): Promise<Agent> {
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
 */
async function _safeListWeeks(
  store: WeeklyPlanStore,
  agentId: string,
): Promise<string[]> {
  try {
    return await store.list(agentId);
  } catch {
    return [];
  }
}
