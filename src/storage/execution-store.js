/**
 * Storage layer for execution records (idempotency tracking).
 * Persists execution entries as structured JSON under .aweek/agents/<agentId>/executions/.
 * Each week gets its own file (keyed by Monday date) for clean rotation.
 * Files are the source of truth — human-readable and skill-readable.
 *
 * Execution records track heartbeat runs with idempotency keys to prevent
 * duplicate work when heartbeats fire multiple times in the same time window.
 *
 * Idempotent: recording an execution with the same idempotency key is a no-op.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { assertValid } from '../schemas/validator.js';
import { currentWeekKey, localParts, mondayOfWeek } from '../time/zone.js';

const RECORD_SCHEMA_ID = 'aweek://schemas/execution-record';
const LOG_SCHEMA_ID = 'aweek://schemas/execution-log';

/** Generate a short random hex ID */
const shortId = () => randomBytes(4).toString('hex');

/**
 * Get the Monday ISO date string for a given date.
 * When `tz` is supplied, the Monday belongs to that date's *local* ISO
 * week in the supplied zone.
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
 * Compute the time-window boundaries for a given timestamp.
 * Default window is 1 hour (3600000ms).
 * The window start is floored to the nearest window boundary.
 * @param {Date} date
 * @param {number} [windowMs=3600000] - Window size in milliseconds
 * @returns {{ windowStart: string, windowEnd: string }}
 */
export function computeTimeWindow(date, windowMs = 3600000) {
  const ts = date.getTime();
  const windowStartMs = Math.floor(ts / windowMs) * windowMs;
  const windowEndMs = windowStartMs + windowMs;
  return {
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
  };
}

/**
 * Generate an idempotency key from agent ID and time-window start.
 * The key is a deterministic hash so repeated heartbeats in the same window
 * always produce the same key.
 * @param {string} agentId
 * @param {string} windowStart - ISO-8601 datetime of the window start
 * @returns {string} e.g. "idem-a1b2c3d4e5f6"
 */
export function generateIdempotencyKey(agentId, windowStart) {
  const hash = createHash('sha256')
    .update(`${agentId}:${windowStart}`)
    .digest('hex')
    .slice(0, 12);
  return `idem-${hash}`;
}

/**
 * Create a new execution record.
 * @param {object} opts
 * @param {string} opts.agentId - Agent that was executed
 * @param {Date}   [opts.date]  - Execution timestamp (defaults to now)
 * @param {number} [opts.windowMs=3600000] - Time window size in ms
 * @param {string} opts.status - One of: started, completed, failed, skipped
 * @param {string} [opts.taskId] - Weekly-plan task ID (if applicable)
 * @param {number} [opts.duration] - Wall-clock milliseconds
 * @param {object} [opts.metadata] - Optional extra data
 * @returns {object} A valid execution record
 */
export function createExecutionRecord({ agentId, date, windowMs, status, taskId, duration, metadata }) {
  const now = date || new Date();
  const { windowStart, windowEnd } = computeTimeWindow(now, windowMs);
  const idempotencyKey = generateIdempotencyKey(agentId, windowStart);

  const record = {
    id: `exec-${shortId()}`,
    idempotencyKey,
    agentId,
    timestamp: now.toISOString(),
    windowStart,
    windowEnd,
    status,
  };
  if (taskId !== undefined) record.taskId = taskId;
  if (duration !== undefined) record.duration = duration;
  if (metadata !== undefined) record.metadata = metadata;
  return record;
}

export class ExecutionStore {
  /**
   * @param {string} baseDir - Root data directory (e.g., ./.aweek/agents)
   */
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  /**
   * Directory for an agent's execution records.
   * @param {string} agentId
   */
  _execDir(agentId) {
    return join(this.baseDir, agentId, 'executions');
  }

  /**
   * Path to a specific week's execution file.
   * @param {string} agentId
   * @param {string} weekMonday - ISO date string for Monday (e.g. "2026-04-13")
   */
  _filePath(agentId, weekMonday) {
    return join(this._execDir(agentId), `${weekMonday}.json`);
  }

  /**
   * Ensure the executions directory for an agent exists.
   * @param {string} agentId
   */
  async init(agentId) {
    await mkdir(this._execDir(agentId), { recursive: true });
  }

  /**
   * Load execution records for a given week.
   * Returns empty array if no file exists yet.
   * @param {string} agentId
   * @param {string} [weekMonday] - Defaults to current week
   * @returns {Promise<object[]>} Array of execution records
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
   * Check if an idempotency key already exists for a given week.
   * @param {string} agentId
   * @param {string} idempotencyKey
   * @param {string} [weekMonday] - Defaults to current week
   * @returns {Promise<boolean>}
   */
  async exists(agentId, idempotencyKey, weekMonday) {
    const records = await this.load(agentId, weekMonday);
    return records.some((r) => r.idempotencyKey === idempotencyKey);
  }

  /**
   * Record an execution entry for the appropriate week.
   * Idempotent: if an entry with the same idempotency key already exists, it is not duplicated.
   * Validates the record before writing.
   * @param {string} agentId
   * @param {object} record - Execution record
   * @returns {Promise<{ record: object, duplicate: boolean }>}
   */
  async record(agentId, record) {
    assertValid(RECORD_SCHEMA_ID, record);
    const monday = getMondayDate(new Date(record.timestamp));
    await this.init(agentId);

    const records = await this.load(agentId, monday);

    // Idempotent: skip if idempotency key already present
    if (records.some((r) => r.idempotencyKey === record.idempotencyKey)) {
      return { record, duplicate: true };
    }

    records.push(record);
    const filePath = this._filePath(agentId, monday);
    await writeFile(filePath, JSON.stringify(records, null, 2) + '\n', 'utf-8');
    return { record, duplicate: false };
  }

  /**
   * List all available week keys (Monday dates) for an agent.
   * @param {string} agentId
   * @returns {Promise<string[]>} Sorted array of Monday date strings
   */
  async listWeeks(agentId) {
    await this.init(agentId);
    const entries = await readdir(this._execDir(agentId));
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  }

  /**
   * List recent execution records with optional filters.
   * @param {string} agentId
   * @param {object} [filters]
   * @param {string} [filters.weekMonday] - Specific week (defaults to current)
   * @param {string} [filters.status] - Filter by status
   * @param {number} [filters.limit] - Max records to return (most recent first)
   * @returns {Promise<object[]>} Matching records
   */
  async listRecent(agentId, filters = {}) {
    const records = await this.load(agentId, filters.weekMonday);
    let filtered = records.filter((r) => {
      if (filters.status && r.status !== filters.status) return false;
      return true;
    });
    // Sort by timestamp descending (most recent first)
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    if (filters.limit && filters.limit > 0) {
      filtered = filtered.slice(0, filters.limit);
    }
    return filtered;
  }

  /**
   * Get a summary of executions for a given week.
   * @param {string} agentId
   * @param {string} [weekMonday]
   * @returns {Promise<object>} Summary with counts by status, total duration, record count
   */
  async summary(agentId, weekMonday) {
    const records = await this.load(agentId, weekMonday);
    const byStatus = {};
    let totalDuration = 0;

    for (const record of records) {
      byStatus[record.status] = (byStatus[record.status] || 0) + 1;
      if (record.duration) totalDuration += record.duration;
    }

    return {
      weekMonday: weekMonday || getMondayDate(),
      recordCount: records.length,
      byStatus,
      totalDuration,
    };
  }
}
