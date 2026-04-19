/**
 * Storage layer for token usage tracking.
 * Persists per-session token usage records as structured JSON under .aweek/agents/<agentId>/usage/.
 * Each week gets its own file (keyed by Monday date) for clean budget-period rotation.
 * Files are the source of truth — human-readable and skill-readable.
 *
 * Usage records are structured JSON with:
 *   id, timestamp, agentId, taskId, sessionId, inputTokens, outputTokens,
 *   totalTokens, costUsd, durationMs, model, week
 *
 * Idempotent: appending a record with the same ID is a no-op (safe for repeated heartbeats).
 * Budget period resets each Monday.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertValid } from '../schemas/validator.js';
import { currentWeekKey, localParts, mondayOfWeek } from '../time/zone.js';

const RECORD_SCHEMA_ID = 'aweek://schemas/usage-record';
const LOG_SCHEMA_ID = 'aweek://schemas/usage-log';

/** Generate a short random hex ID */
const shortId = () => randomBytes(4).toString('hex');

/**
 * Get the Monday ISO date string for a given date (budget period key).
 * When `tz` is supplied, the Monday is the Monday of that date's *local*
 * ISO week in the given zone.
 * @param {Date} [date]
 * @param {string} [tz]
 * @returns {string} e.g. "2026-04-13"
 */
export function getMondayDate(date = new Date(), tz) {
  if (typeof tz === 'string' && tz.length > 0 && tz !== 'UTC') {
    const weekKey = currentWeekKey(tz, date);
    const monUtc = mondayOfWeek(weekKey, tz);
    const parts = localParts(monUtc, tz);
    return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Create a new usage record from session results and parsed token data.
 * @param {object} opts
 * @param {string} opts.agentId - Agent that ran the session
 * @param {string} opts.taskId - Task that was executed
 * @param {string} [opts.sessionId] - Opaque session identifier
 * @param {number} opts.inputTokens - Input tokens consumed
 * @param {number} opts.outputTokens - Output tokens consumed
 * @param {number} [opts.costUsd=0] - Estimated cost in USD
 * @param {number} [opts.durationMs] - Wall-clock duration in ms
 * @param {string} [opts.model] - Model used
 * @param {string} [opts.week] - Explicit week key (defaults to current Monday)
 * @param {string} [opts.timestamp] - Explicit timestamp (defaults to now)
 * @returns {object} A valid usage record
 */
export function createUsageRecord({
  agentId,
  taskId,
  sessionId,
  inputTokens,
  outputTokens,
  costUsd = 0,
  durationMs,
  model,
  week,
  timestamp,
}) {
  const ts = timestamp || new Date().toISOString();
  const weekKey = week || getMondayDate(new Date(ts));
  const record = {
    id: `usage-${shortId()}`,
    timestamp: ts,
    agentId,
    taskId,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    week: weekKey,
  };
  if (sessionId !== undefined) record.sessionId = sessionId;
  if (costUsd !== undefined && costUsd > 0) record.costUsd = costUsd;
  if (durationMs !== undefined) record.durationMs = durationMs;
  if (model !== undefined) record.model = model;
  return record;
}

export class UsageStore {
  /**
   * @param {string} baseDir - Root data directory (e.g., ./.aweek/agents)
   */
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  /**
   * Directory for an agent's usage data.
   * @param {string} agentId
   */
  _usageDir(agentId) {
    return join(this.baseDir, agentId, 'usage');
  }

  /**
   * Path to a specific week's usage file.
   * @param {string} agentId
   * @param {string} weekMonday - ISO date string for Monday
   */
  _filePath(agentId, weekMonday) {
    return join(this._usageDir(agentId), `${weekMonday}.json`);
  }

  /**
   * Ensure the usage directory for an agent exists.
   * @param {string} agentId
   */
  async init(agentId) {
    await mkdir(this._usageDir(agentId), { recursive: true });
  }

  /**
   * Load usage records for a given week.
   * Returns empty array if no usage file exists yet.
   * @param {string} agentId
   * @param {string} [weekMonday] - Defaults to current week
   * @returns {Promise<object[]>} Array of usage records
   */
  async load(agentId, weekMonday) {
    const monday = weekMonday || getMondayDate();
    const filePath = this._filePath(agentId, monday);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const records = JSON.parse(raw);
      assertValid(LOG_SCHEMA_ID, records);
      return records;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Append a usage record for the appropriate week.
   * Idempotent: if a record with the same ID already exists, it is not duplicated.
   * Validates the record before writing.
   * @param {string} agentId
   * @param {object} record - Usage record
   * @returns {Promise<object>} The appended record
   */
  async append(agentId, record) {
    assertValid(RECORD_SCHEMA_ID, record);
    const weekMonday = record.week;
    await this.init(agentId);

    const records = await this.load(agentId, weekMonday);

    // Idempotent: skip if record ID already present
    if (records.some((r) => r.id === record.id)) {
      return record;
    }

    records.push(record);
    const filePath = this._filePath(agentId, weekMonday);
    await writeFile(filePath, JSON.stringify(records, null, 2) + '\n', 'utf-8');
    return record;
  }

  /**
   * List all available week keys (Monday dates) for an agent's usage.
   * @param {string} agentId
   * @returns {Promise<string[]>} Sorted array of Monday date strings
   */
  async listWeeks(agentId) {
    await this.init(agentId);
    const entries = await readdir(this._usageDir(agentId));
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  }

  /**
   * Get total token usage for a given week (budget period).
   * @param {string} agentId
   * @param {string} [weekMonday] - Defaults to current week
   * @returns {Promise<{ weekMonday: string, recordCount: number, inputTokens: number, outputTokens: number, totalTokens: number, costUsd: number }>}
   */
  async weeklyTotal(agentId, weekMonday) {
    const monday = weekMonday || getMondayDate();
    const records = await this.load(agentId, monday);
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let costUsd = 0;

    for (const r of records) {
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      totalTokens += r.totalTokens;
      if (r.costUsd) costUsd += r.costUsd;
    }

    return {
      weekMonday: monday,
      recordCount: records.length,
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd: Math.round(costUsd * 1e6) / 1e6, // avoid floating point drift
    };
  }

  /**
   * Query usage records with optional filters.
   * @param {string} agentId
   * @param {object} [filters]
   * @param {string} [filters.weekMonday] - Specific week (defaults to current)
   * @param {string} [filters.taskId] - Filter by task ID
   * @param {string} [filters.model] - Filter by model
   * @returns {Promise<object[]>} Matching records
   */
  async query(agentId, filters = {}) {
    const records = await this.load(agentId, filters.weekMonday);
    return records.filter((r) => {
      if (filters.taskId && r.taskId !== filters.taskId) return false;
      if (filters.model && r.model !== filters.model) return false;
      return true;
    });
  }
}
