/**
 * Storage layer for activity logs.
 * Persists activity log entries as structured JSON under .aweek/agents/<agentId>/logs/.
 * Each week gets its own log file (keyed by Monday date) for clean rotation.
 * Files are the source of truth — human-readable and skill-readable.
 *
 * Log entries are structured JSON with:
 *   timestamp, agentId, taskId, status, description, duration
 *
 * Idempotent: appending a log entry with the same ID is a no-op.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertValid } from '../schemas/validator.js';
import { currentWeekKey, localParts, mondayOfWeek } from '../time/zone.js';

const ENTRY_SCHEMA_ID = 'aweek://schemas/activity-log-entry';
const LOG_SCHEMA_ID = 'aweek://schemas/activity-log';

/** Generate a short random hex ID */
const shortId = () => randomBytes(4).toString('hex');

/**
 * Get the Monday ISO date string for a given date.
 * When `tz` is supplied, the Monday is resolved inside the user's zone so
 * log rotation aligns to the local week.
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
 * Create a new activity log entry.
 * @param {object} opts
 * @param {string} opts.agentId - Agent that performed the activity
 * @param {string} [opts.taskId] - Weekly-plan task ID (if applicable)
 * @param {string} opts.status - One of: started, completed, failed, skipped, delegated
 * @param {string} opts.description - Human-readable summary
 * @param {number} [opts.duration] - Wall-clock milliseconds
 * @param {object} [opts.metadata] - Optional extra data
 * @returns {object} A valid activity log entry
 */
export function createLogEntry({ agentId, taskId, status, description, duration, metadata }) {
  const entry = {
    id: `log-${shortId()}`,
    timestamp: new Date().toISOString(),
    agentId,
    status,
    description,
  };
  if (taskId !== undefined) entry.taskId = taskId;
  if (duration !== undefined) entry.duration = duration;
  if (metadata !== undefined) entry.metadata = metadata;
  return entry;
}

export class ActivityLogStore {
  /**
   * @param {string} baseDir - Root data directory (e.g., ./.aweek/agents)
   */
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  /**
   * Directory for an agent's logs.
   * @param {string} agentId
   */
  _logsDir(agentId) {
    return join(this.baseDir, agentId, 'logs');
  }

  /**
   * Path to a specific week's log file.
   * @param {string} agentId
   * @param {string} weekMonday - ISO date string for Monday (e.g. "2026-04-13")
   */
  _filePath(agentId, weekMonday) {
    return join(this._logsDir(agentId), `${weekMonday}.json`);
  }

  /**
   * Ensure the logs directory for an agent exists.
   * @param {string} agentId
   */
  async init(agentId) {
    await mkdir(this._logsDir(agentId), { recursive: true });
  }

  /**
   * Load log entries for a given week.
   * Returns empty array if no log file exists yet.
   * @param {string} agentId
   * @param {string} [weekMonday] - Defaults to current week
   * @returns {Promise<object[]>} Array of log entries
   */
  async load(agentId, weekMonday) {
    const monday = weekMonday || getMondayDate();
    const filePath = this._filePath(agentId, monday);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const entries = JSON.parse(raw);
      assertValid(LOG_SCHEMA_ID, entries);
      return entries;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Append a log entry for the current week.
   * Idempotent: if an entry with the same ID already exists, it is not duplicated.
   * Validates the entry before writing.
   * @param {string} agentId
   * @param {object} entry - Activity log entry
   * @returns {Promise<object>} The appended entry
   */
  async append(agentId, entry) {
    assertValid(ENTRY_SCHEMA_ID, entry);
    const monday = getMondayDate(new Date(entry.timestamp));
    await this.init(agentId);

    const entries = await this.load(agentId, monday);

    // Idempotent: skip if entry ID already present
    if (entries.some((e) => e.id === entry.id)) {
      return entry;
    }

    entries.push(entry);
    const filePath = this._filePath(agentId, monday);
    await writeFile(filePath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
    return entry;
  }

  /**
   * List all available week keys (Monday dates) for an agent.
   * @param {string} agentId
   * @returns {Promise<string[]>} Sorted array of Monday date strings
   */
  async listWeeks(agentId) {
    await this.init(agentId);
    const entries = await readdir(this._logsDir(agentId));
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  }

  /**
   * Query log entries with optional filters.
   * @param {string} agentId
   * @param {object} [filters]
   * @param {string} [filters.weekMonday] - Specific week (defaults to current)
   * @param {string} [filters.status] - Filter by status
   * @param {string} [filters.taskId] - Filter by task ID
   * @returns {Promise<object[]>} Matching entries
   */
  async query(agentId, filters = {}) {
    const entries = await this.load(agentId, filters.weekMonday);
    return entries.filter((e) => {
      if (filters.status && e.status !== filters.status) return false;
      if (filters.taskId && e.taskId !== filters.taskId) return false;
      return true;
    });
  }

  /**
   * Get a summary of activity for a given week.
   * @param {string} agentId
   * @param {string} [weekMonday]
   * @returns {Promise<object>} Summary with counts by status, total duration, entry count
   */
  async summary(agentId, weekMonday) {
    const entries = await this.load(agentId, weekMonday);
    const byStatus = {};
    let totalDuration = 0;

    for (const entry of entries) {
      byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
      if (entry.duration) totalDuration += entry.duration;
    }

    return {
      weekMonday: weekMonday || getMondayDate(),
      entryCount: entries.length,
      byStatus,
      totalDuration,
    };
  }
}
