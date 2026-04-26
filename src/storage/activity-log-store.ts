/**
 * Storage layer for activity logs.
 * Persists activity log entries as structured JSON under .aweek/agents/<agentId>/logs/.
 * Each week gets its own log file (keyed by Monday date) for clean rotation.
 * Files are the source of truth — human-readable and skill-readable.
 *
 * Log entries are structured JSON with:
 *   timestamp, agentId, taskId, status, title, duration
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

/**
 * Lifecycle status of an activity log entry — mirrors `ACTIVITY_STATUSES`
 * in `src/schemas/activity-log.schema.js`.
 */
export type ActivityLogStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'delegated';

/**
 * Canonical shape of a single activity log entry — mirrors
 * `activityLogEntrySchema` in `src/schemas/activity-log.schema.js`. The
 * schema literal is still authored as a plain JS object, so the TypeScript
 * shape is hand-mirrored here. Required vs. optional matches the schema's
 * `required` array exactly.
 */
export interface ActivityLogEntry {
  /** Unique log entry identifier (`log-<lowercase-hex>`). */
  id: string;
  /** ISO-8601 datetime when the activity occurred. */
  timestamp: string;
  /** Agent that performed the activity. */
  agentId: string;
  /** Outcome of the activity. */
  status: ActivityLogStatus;
  /**
   * Short single-line label sourced from the originating weekly task's
   * title. The log is a user-facing surface — dashboards, activity rows,
   * drawer headers — so it tracks the calendar label rather than the long
   * Claude prompt.
   */
  title: string;
  /** Weekly-plan task ID (if applicable). */
  taskId?: string;
  /** Wall-clock milliseconds the activity took. */
  duration?: number;
  /** Optional extra key-value data (tokens used, error info, etc.). */
  metadata?: Record<string, unknown>;
}

/** Input bag accepted by `createLogEntry`. */
export interface CreateLogEntryInput {
  /** Agent that performed the activity. */
  agentId: string;
  /** Weekly-plan task ID (if applicable). */
  taskId?: string;
  /** One of: started, completed, failed, skipped, delegated. */
  status: ActivityLogStatus;
  /** Short single-line label (typically copied from task.title). */
  title: string;
  /** Wall-clock milliseconds. */
  duration?: number;
  /** Optional extra data. */
  metadata?: Record<string, unknown>;
}

/** Optional filters for `ActivityLogStore.query()`. */
export interface ActivityLogQueryFilters {
  /** Specific week (defaults to current). */
  weekMonday?: string;
  /** Filter by status. */
  status?: ActivityLogStatus;
  /** Filter by task ID. */
  taskId?: string;
}

/** Aggregated counts returned by `ActivityLogStore.summary()`. */
export interface ActivityLogSummary {
  weekMonday: string;
  entryCount: number;
  byStatus: Partial<Record<ActivityLogStatus, number>>;
  totalDuration: number;
}

/** Generate a short random hex ID. */
const shortId = (): string => randomBytes(4).toString('hex');

/**
 * Get the Monday ISO date string for a given date.
 * When `tz` is supplied, the Monday is resolved inside the user's zone so
 * log rotation aligns to the local week.
 *
 * @param date - The date to anchor on (defaults to "now")
 * @param tz   - Optional IANA zone (e.g. `"America/Los_Angeles"`)
 * @returns ISO date string, e.g. `"2026-04-13"`
 */
export function getMondayDate(date: Date = new Date(), tz?: string): string {
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
 *
 * The entry's `title` mirrors the originating weekly task's short
 * calendar label. The log is a user-facing surface — dashboards, activity
 * rows, drawer headers — so it tracks the compact title rather than the
 * long-form prompt fed to Claude.
 */
export function createLogEntry({
  agentId,
  taskId,
  status,
  title,
  duration,
  metadata,
}: CreateLogEntryInput): ActivityLogEntry {
  const entry: ActivityLogEntry = {
    id: `log-${shortId()}`,
    timestamp: new Date().toISOString(),
    agentId,
    status,
    title,
  };
  if (taskId !== undefined) entry.taskId = taskId;
  if (duration !== undefined) entry.duration = duration;
  if (metadata !== undefined) entry.metadata = metadata;
  return entry;
}

export class ActivityLogStore {
  /** Root data directory (e.g., ./.aweek/agents). */
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Directory for an agent's logs. */
  _logsDir(agentId: string): string {
    return join(this.baseDir, agentId, 'logs');
  }

  /**
   * Path to a specific week's log file.
   * @param weekMonday ISO date string for Monday (e.g. `"2026-04-13"`)
   */
  _filePath(agentId: string, weekMonday: string): string {
    return join(this._logsDir(agentId), `${weekMonday}.json`);
  }

  /** Ensure the logs directory for an agent exists. */
  async init(agentId: string): Promise<void> {
    await mkdir(this._logsDir(agentId), { recursive: true });
  }

  /**
   * Load log entries for a given week.
   * Returns empty array if no log file exists yet.
   *
   * @param weekMonday Defaults to current week
   */
  async load(agentId: string, weekMonday?: string): Promise<ActivityLogEntry[]> {
    const monday = weekMonday || getMondayDate();
    const filePath = this._filePath(agentId, monday);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const entries = JSON.parse(raw) as ActivityLogEntry[];
      assertValid(LOG_SCHEMA_ID, entries);
      return entries;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Append a log entry for the entry's week.
   * Idempotent: if an entry with the same ID already exists, it is not
   * duplicated. Validates the entry before writing.
   */
  async append(agentId: string, entry: ActivityLogEntry): Promise<ActivityLogEntry> {
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
   * @returns Sorted array of Monday date strings
   */
  async listWeeks(agentId: string): Promise<string[]> {
    await this.init(agentId);
    const entries = await readdir(this._logsDir(agentId));
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  }

  /** Query log entries with optional filters. */
  async query(
    agentId: string,
    filters: ActivityLogQueryFilters = {},
  ): Promise<ActivityLogEntry[]> {
    const entries = await this.load(agentId, filters.weekMonday);
    return entries.filter((e) => {
      if (filters.status && e.status !== filters.status) return false;
      if (filters.taskId && e.taskId !== filters.taskId) return false;
      return true;
    });
  }

  /** Get a summary of activity for a given week. */
  async summary(agentId: string, weekMonday?: string): Promise<ActivityLogSummary> {
    const entries = await this.load(agentId, weekMonday);
    const byStatus: Partial<Record<ActivityLogStatus, number>> = {};
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Narrow `unknown` to a Node `ErrnoException` so we can read the `code` field. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
