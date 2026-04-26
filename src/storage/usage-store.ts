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

/**
 * Canonical shape of a single usage record — mirrors `usageRecordSchema`
 * in `src/schemas/usage.schema.js`. Required vs. optional matches the
 * schema's `required` array exactly.
 */
export interface UsageRecord {
  /** Unique usage record identifier (`usage-<hex>`). */
  id: string;
  /** ISO-8601 datetime when the session completed. */
  timestamp: string;
  /** Agent ID that consumed the tokens. */
  agentId: string;
  /** Weekly-plan task ID that was executed. */
  taskId: string;
  /** Opaque session identifier for deduplication. */
  sessionId?: string;
  /** Number of input (prompt) tokens consumed (integer >= 0). */
  inputTokens: number;
  /** Number of output (completion) tokens consumed (integer >= 0). */
  outputTokens: number;
  /** Sum of input + output tokens (integer >= 0). */
  totalTokens: number;
  /** Estimated cost in USD (>= 0). Omitted when zero. */
  costUsd?: number;
  /** Wall-clock session duration in ms (integer >= 0). */
  durationMs?: number;
  /** Model used for the session (if known). */
  model?: string;
  /** Budget week key (ISO Monday date, e.g. "2026-04-13"). */
  week: string;
}

/** Inputs accepted by `createUsageRecord`. */
export interface CreateUsageRecordOptions {
  /** Agent that ran the session. */
  agentId: string;
  /** Task that was executed. */
  taskId: string;
  /** Opaque session identifier. */
  sessionId?: string;
  /** Input tokens consumed. */
  inputTokens: number;
  /** Output tokens consumed. */
  outputTokens: number;
  /** Estimated cost in USD (default 0). Omitted from the record when 0. */
  costUsd?: number;
  /** Wall-clock duration in ms. */
  durationMs?: number;
  /** Model used. */
  model?: string;
  /** Explicit week key (defaults to current Monday). */
  week?: string;
  /** Explicit timestamp (defaults to now). */
  timestamp?: string;
}

/** Optional filters for `UsageStore.query()`. */
export interface UsageQueryFilters {
  /** Specific week (defaults to current Monday). */
  weekMonday?: string;
  /** Filter by task ID. */
  taskId?: string;
  /** Filter by model. */
  model?: string;
}

/** Aggregated weekly totals returned by `UsageStore.weeklyTotal()`. */
export interface UsageWeeklyTotal {
  /** Monday date string for the budget week. */
  weekMonday: string;
  /** Number of records contributing to the totals. */
  recordCount: number;
  /** Sum of `inputTokens` across the week. */
  inputTokens: number;
  /** Sum of `outputTokens` across the week. */
  outputTokens: number;
  /** Sum of `totalTokens` across the week. */
  totalTokens: number;
  /** Sum of `costUsd` across the week, rounded to 6 decimals. */
  costUsd: number;
}

/** Generate a short random hex ID. */
const shortId = (): string => randomBytes(4).toString('hex');

/**
 * Get the Monday ISO date string for a given date (budget period key).
 * When `tz` is supplied, the Monday is the Monday of that date's *local*
 * ISO week in the given zone.
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
 * Create a new usage record from session results and parsed token data.
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
}: CreateUsageRecordOptions): UsageRecord {
  const ts = timestamp || new Date().toISOString();
  const weekKey = week || getMondayDate(new Date(ts));
  const record: UsageRecord = {
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
  /** Root data directory (e.g., ./.aweek/agents). */
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Directory for an agent's usage data. */
  _usageDir(agentId: string): string {
    return join(this.baseDir, agentId, 'usage');
  }

  /** Path to a specific week's usage file. */
  _filePath(agentId: string, weekMonday: string): string {
    return join(this._usageDir(agentId), `${weekMonday}.json`);
  }

  /** Ensure the usage directory for an agent exists. */
  async init(agentId: string): Promise<void> {
    await mkdir(this._usageDir(agentId), { recursive: true });
  }

  /**
   * Load usage records for a given week.
   * Returns empty array if no usage file exists yet.
   */
  async load(agentId: string, weekMonday?: string): Promise<UsageRecord[]> {
    const monday = weekMonday || getMondayDate();
    const filePath = this._filePath(agentId, monday);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const records = JSON.parse(raw) as UsageRecord[];
      assertValid(LOG_SCHEMA_ID, records);
      return records;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Append a usage record for the appropriate week.
   * Idempotent: if a record with the same ID already exists, it is not duplicated.
   * Validates the record before writing.
   */
  async append(agentId: string, record: UsageRecord): Promise<UsageRecord> {
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
   * @returns Sorted array of Monday date strings
   */
  async listWeeks(agentId: string): Promise<string[]> {
    await this.init(agentId);
    const entries = await readdir(this._usageDir(agentId));
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  }

  /** Get total token usage for a given week (budget period). */
  async weeklyTotal(
    agentId: string,
    weekMonday?: string,
  ): Promise<UsageWeeklyTotal> {
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

  /** Query usage records with optional filters. */
  async query(
    agentId: string,
    filters: UsageQueryFilters = {},
  ): Promise<UsageRecord[]> {
    const records = await this.load(agentId, filters.weekMonday);
    return records.filter((r) => {
      if (filters.taskId && r.taskId !== filters.taskId) return false;
      if (filters.model && r.model !== filters.model) return false;
      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Narrow `unknown` to a Node `ErrnoException` so we can read the `code` field. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
