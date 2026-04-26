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

/**
 * Outcome statuses recognised by `executionRecordSchema` — kept in sync with
 * `EXECUTION_STATUSES` in `src/schemas/execution.schema.js`.
 */
export type ExecutionStatus = 'started' | 'completed' | 'failed' | 'skipped';

/**
 * Canonical shape of a single execution record — mirrors
 * `executionRecordSchema` in `src/schemas/execution.schema.js`. Required vs.
 * optional matches the schema's `required` array exactly.
 */
export interface ExecutionRecord {
  /** Unique execution identifier (`exec-<hex>`). */
  id: string;
  /** Hash key (or random key for tick records) — `idem-<hex>`. */
  idempotencyKey: string;
  /** Agent that was executed. */
  agentId: string;
  /** ISO-8601 datetime when execution started. */
  timestamp: string;
  /** ISO-8601 datetime of the time-window start. */
  windowStart: string;
  /** ISO-8601 datetime of the time-window end. */
  windowEnd: string;
  /** Outcome of the execution. */
  status: ExecutionStatus;
  /** Weekly-plan task ID that was executed (if applicable). */
  taskId?: string;
  /** Wall-clock milliseconds the execution took. */
  duration?: number;
  /** Free-form metadata bag (token counts, error info, etc.). */
  metadata?: Record<string, unknown>;
}

/** Inputs accepted by `createExecutionRecord`. */
export interface CreateExecutionRecordOptions {
  /** Agent that was executed. */
  agentId: string;
  /** Execution timestamp (defaults to now). */
  date?: Date;
  /** Time-window size in ms (defaults to 1 hour). */
  windowMs?: number;
  /** Outcome of the execution. */
  status: ExecutionStatus;
  /** Weekly-plan task ID (if applicable). */
  taskId?: string;
  /** Wall-clock milliseconds the execution took. */
  duration?: number;
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
}

/** Inputs accepted by `createTickExecutionRecord`. */
export interface CreateTickExecutionRecordOptions {
  /** Agent that was executed. */
  agentId: string;
  /** Execution timestamp (defaults to now). */
  date?: Date;
  /** Outcome of the execution. */
  status: ExecutionStatus;
  /** Weekly-plan task ID (if applicable). */
  taskId?: string;
  /** Wall-clock milliseconds the execution took. */
  duration?: number;
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
}

/** Filters accepted by `ExecutionStore.listRecent()`. */
export interface ExecutionListRecentFilters {
  /** Specific week (defaults to current Monday). */
  weekMonday?: string;
  /** Filter by status. */
  status?: ExecutionStatus;
  /** Max records to return (most recent first). */
  limit?: number;
}

/** Aggregated weekly summary returned by `ExecutionStore.summary()`. */
export interface ExecutionSummary {
  /** Monday date string for the summary week. */
  weekMonday: string;
  /** Number of records contributing to the totals. */
  recordCount: number;
  /** Counts of records grouped by status. */
  byStatus: Partial<Record<ExecutionStatus, number>>;
  /** Sum of `duration` across the records that have one. */
  totalDuration: number;
}

/** Result of `ExecutionStore.record()`. */
export interface ExecutionRecordResult {
  /** The record as written (or the duplicate that was already present). */
  record: ExecutionRecord;
  /** True when the idempotency key was already present and nothing was written. */
  duplicate: boolean;
}

/** Generate a short random hex ID. */
const shortId = (): string => randomBytes(4).toString('hex');

/**
 * Get the Monday ISO date string for a given date.
 * When `tz` is supplied, the Monday belongs to that date's *local* ISO
 * week in the supplied zone.
 *
 * @param date Date to bucket (defaults to now).
 * @param tz Optional IANA zone name; UTC is used when omitted/empty.
 * @returns e.g. "2026-04-13"
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
 * Compute the time-window boundaries for a given timestamp.
 * Default window is 1 hour (3600000ms).
 * The window start is floored to the nearest window boundary.
 */
export function computeTimeWindow(
  date: Date,
  windowMs: number = 3_600_000,
): { windowStart: string; windowEnd: string } {
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
 *
 * @param agentId Agent identifier.
 * @param windowStart ISO-8601 datetime of the window start.
 * @returns e.g. "idem-a1b2c3d4e5f6"
 */
export function generateIdempotencyKey(agentId: string, windowStart: string): string {
  const hash = createHash('sha256')
    .update(`${agentId}:${windowStart}`)
    .digest('hex')
    .slice(0, 12);
  return `idem-${hash}`;
}

/**
 * Create a new execution record bucketed into a deterministic time window.
 */
export function createExecutionRecord({
  agentId,
  date,
  windowMs,
  status,
  taskId,
  duration,
  metadata,
}: CreateExecutionRecordOptions): ExecutionRecord {
  const now = date || new Date();
  const { windowStart, windowEnd } = computeTimeWindow(now, windowMs);
  const idempotencyKey = generateIdempotencyKey(agentId, windowStart);

  const record: ExecutionRecord = {
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

/**
 * Create a new execution record with a unique-per-tick idempotency key.
 *
 * Unlike {@link createExecutionRecord}, which hashes the agent id with a
 * time-window bucket (originally used to enforce hourly dedup), this helper
 * generates a random idempotency key so every tick appends a fresh audit row
 * regardless of how close together the ticks are. The store still dedups on
 * `idempotencyKey`, so uniqueness here guarantees every tick is persisted.
 *
 * Real duplicate-run prevention is now enforced by the heartbeat runner via
 * per-agent locks plus the atomic `pending → in-progress` task-state
 * transition — the window-based key has become an append-only audit trail.
 *
 * `windowStart`/`windowEnd` are required by the stored schema, so we set
 * them to the tick timestamp (zero-width window) to satisfy validation.
 */
export function createTickExecutionRecord({
  agentId,
  date,
  status,
  taskId,
  duration,
  metadata,
}: CreateTickExecutionRecordOptions): ExecutionRecord {
  const now = date || new Date();
  const timestamp = now.toISOString();
  const idempotencyKey = `idem-${randomBytes(6).toString('hex')}`;

  const record: ExecutionRecord = {
    id: `exec-${shortId()}`,
    idempotencyKey,
    agentId,
    timestamp,
    windowStart: timestamp,
    windowEnd: timestamp,
    status,
  };
  if (taskId !== undefined) record.taskId = taskId;
  if (duration !== undefined) record.duration = duration;
  if (metadata !== undefined) record.metadata = metadata;
  return record;
}

export class ExecutionStore {
  /** Root data directory (e.g., ./.aweek/agents). */
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Directory for an agent's execution records. */
  _execDir(agentId: string): string {
    return join(this.baseDir, agentId, 'executions');
  }

  /**
   * Path to a specific week's execution file.
   *
   * @param weekMonday ISO date string for Monday (e.g. "2026-04-13")
   */
  _filePath(agentId: string, weekMonday: string): string {
    return join(this._execDir(agentId), `${weekMonday}.json`);
  }

  /** Ensure the executions directory for an agent exists. */
  async init(agentId: string): Promise<void> {
    await mkdir(this._execDir(agentId), { recursive: true });
  }

  /**
   * Load execution records for a given week.
   * Returns empty array if no file exists yet.
   */
  async load(agentId: string, weekMonday?: string): Promise<ExecutionRecord[]> {
    const monday = weekMonday || getMondayDate();
    const filePath = this._filePath(agentId, monday);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const records = JSON.parse(raw) as ExecutionRecord[];
      assertValid(LOG_SCHEMA_ID, records);
      return records;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Check if an idempotency key already exists for a given week. */
  async exists(
    agentId: string,
    idempotencyKey: string,
    weekMonday?: string,
  ): Promise<boolean> {
    const records = await this.load(agentId, weekMonday);
    return records.some((r) => r.idempotencyKey === idempotencyKey);
  }

  /**
   * Record an execution entry for the appropriate week.
   * Idempotent: if an entry with the same idempotency key already exists, it
   * is not duplicated. Validates the record before writing.
   */
  async record(agentId: string, record: ExecutionRecord): Promise<ExecutionRecordResult> {
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
   *
   * @returns Sorted array of Monday date strings
   */
  async listWeeks(agentId: string): Promise<string[]> {
    await this.init(agentId);
    const entries = await readdir(this._execDir(agentId));
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  }

  /** List recent execution records with optional filters. */
  async listRecent(
    agentId: string,
    filters: ExecutionListRecentFilters = {},
  ): Promise<ExecutionRecord[]> {
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

  /** Get a summary of executions for a given week. */
  async summary(agentId: string, weekMonday?: string): Promise<ExecutionSummary> {
    const records = await this.load(agentId, weekMonday);
    const byStatus: Partial<Record<ExecutionStatus, number>> = {};
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Narrow `unknown` to a Node `ErrnoException` so we can read the `code` field. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
