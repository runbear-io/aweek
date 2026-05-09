/**
 * Slack-channel token-usage store for the Slack-aweek integration.
 *
 * Records one usage entry per Slack-thread turn driven through the
 * embedded `agentchannels` Slack adapter inside `aweek serve`.
 * Persisted to a single file at
 *
 *   <projectRoot>/.aweek/channels/slack/usage.json
 *
 * which is intentionally separate from the per-agent
 * `.aweek/agents/<slug>/usage/<week>.json` stream owned by
 * {@link UsageStore}. From the seed contract:
 *
 *   "Slack runs are an isolated execution surface from the heartbeat
 *    — separate per-Slack-thread lock (NOT the per-agent file lock),
 *    separate usage bucket .aweek/channels/slack/usage.json, no
 *    interaction with weekly-budget pause flag."
 *
 * On-disk shape: a JSON array of {@link SlackUsageRecord} objects.
 * One file means readers can render the dashboard's Slack timeline
 * without scanning a directory tree, and writers don't have to roll
 * out a new file each Monday because Slack usage is not budgeted.
 *
 * Concurrency model:
 *
 *   - Append is read-modify-write atop a tmp-then-rename swap. Two
 *     concurrent appenders race on the rename; the loser overwrites
 *     the winner. That's safe enough for v1 because the embedded
 *     Slack listener is single-process and the per-Slack-thread lock
 *     serialises turns within the same thread. Cross-thread
 *     near-simultaneous writes are rare; if drift becomes a problem
 *     we can layer a file lock here without changing the public API.
 *
 *   - Append is idempotent on `id`: re-appending a record that's
 *     already on disk is a no-op. The factory layer that owns the
 *     `ProjectClaudeBackend.onResult` callback can therefore retry on
 *     I/O failure without inflating totals.
 *
 *   - Reads tolerate ENOENT (returns `[]`) and a malformed file
 *     (logs to stderr, returns `[]`). A corrupt usage log must never
 *     brick the Slack listener — losing one turn's accounting is
 *     strictly better than dropping every subsequent message.
 *
 * The {@link createSlackUsageRecord} factory mirrors
 * {@link createUsageRecord} from `usage-store.ts`: callers supply
 * raw inputs, the factory stamps a unique id and timestamp, computes
 * `totalTokens`, and omits zero-cost / undefined fields so the
 * on-disk JSON stays compact.
 *
 * @module storage/slack-usage-store
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { SLACK_CHANNEL_DIRNAME } from './slack-config-store.js';

/** Filename of the Slack-channel usage log inside the Slack channel dir. */
export const SLACK_USAGE_FILENAME = 'usage.json';

/**
 * Resolve the absolute path to the Slack-channel usage log given a
 * `dataDir`. The rest of the codebase passes `dataDir` as
 * `<projectRoot>/.aweek/agents`; the usage file lives one level up
 * under `channels/slack/`, matching {@link slackConfigPath}.
 */
export function slackUsagePath(dataDir: string): string {
  return join(dirname(dataDir), 'channels', SLACK_CHANNEL_DIRNAME, SLACK_USAGE_FILENAME);
}

/**
 * Single Slack-channel usage record. One record per Slack-thread
 * turn — i.e. one user message round-trip through the
 * `ProjectClaudeBackend` for the corresponding thread.
 *
 * `id` is `slack-usage-<hex>` so it's distinguishable from
 * per-agent `usage-<hex>` records on the wire / in logs.
 */
export interface SlackUsageRecord {
  /** Unique record identifier (`slack-usage-<hex>`). */
  id: string;
  /** ISO-8601 datetime when the turn completed. */
  timestamp: string;
  /**
   * agentchannels-supplied thread key
   * (`${adapterName}:${channelId}:${threadId}`). Stable across turns.
   */
  threadKey: string;
  /** Input (prompt) tokens consumed (integer >= 0). */
  inputTokens: number;
  /** Output (completion) tokens consumed (integer >= 0). */
  outputTokens: number;
  /** Sum of input + output tokens (integer >= 0). */
  totalTokens: number;
  /** Cache-read tokens reported by the CLI, when present. */
  cacheReadTokens?: number;
  /** Cache-creation tokens reported by the CLI, when present. */
  cacheCreationTokens?: number;
  /** Estimated cost in USD (>= 0). Omitted when zero. */
  costUsd?: number;
  /** Wall-clock turn duration in ms (integer >= 0). */
  durationMs?: number;
  /** Model used for the turn (when reported). */
  model?: string;
  /**
   * Whether the CLI reported the turn as a success (the inverse of
   * `ResultInfo.isError`). Persisted explicitly so the dashboard can
   * distinguish "turn ran but failed" from "turn succeeded".
   */
  success: boolean;
  /** `stop_reason` from the result line, e.g. `"end_turn"`. */
  stopReason?: string;
}

/** Inputs accepted by {@link createSlackUsageRecord}. */
export interface CreateSlackUsageRecordOptions {
  /** Stable agentchannels thread key. Required. */
  threadKey: string;
  /** Input tokens consumed (default 0). */
  inputTokens?: number;
  /** Output tokens consumed (default 0). */
  outputTokens?: number;
  /** Cache-read tokens (optional). */
  cacheReadTokens?: number;
  /** Cache-creation tokens (optional). */
  cacheCreationTokens?: number;
  /** Estimated cost in USD (default 0; omitted from the record when 0). */
  costUsd?: number;
  /** Wall-clock duration in ms (optional). */
  durationMs?: number;
  /** Model used (optional). */
  model?: string;
  /**
   * Whether the turn succeeded. Required because callers always
   * know — `ResultInfo.isError` is the canonical source — and
   * defaulting would silently swallow real failures.
   */
  success: boolean;
  /** Stop reason from the CLI's `result` line. */
  stopReason?: string;
  /** Explicit timestamp (defaults to now). */
  timestamp?: string;
  /** Explicit id (defaults to a server-generated one). */
  id?: string;
}

/** Generate a short random hex id (matches the format used elsewhere). */
const shortId = (): string => randomBytes(4).toString('hex');

/**
 * Build a fresh Slack usage record from raw inputs. The returned
 * object is structurally valid (passes {@link isSlackUsageRecord})
 * and ready for {@link appendSlackUsageRecord}.
 */
export function createSlackUsageRecord(
  opts: CreateSlackUsageRecordOptions,
): SlackUsageRecord {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('createSlackUsageRecord: opts is required');
  }
  if (typeof opts.threadKey !== 'string' || opts.threadKey.trim().length === 0) {
    throw new TypeError('createSlackUsageRecord: threadKey is required');
  }
  if (typeof opts.success !== 'boolean') {
    throw new TypeError('createSlackUsageRecord: success must be a boolean');
  }

  const inputTokens = normalizeCount(opts.inputTokens, 'inputTokens');
  const outputTokens = normalizeCount(opts.outputTokens, 'outputTokens');

  const record: SlackUsageRecord = {
    id: opts.id ?? `slack-usage-${shortId()}`,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    threadKey: opts.threadKey,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    success: opts.success,
  };

  if (opts.cacheReadTokens !== undefined) {
    record.cacheReadTokens = normalizeCount(opts.cacheReadTokens, 'cacheReadTokens');
  }
  if (opts.cacheCreationTokens !== undefined) {
    record.cacheCreationTokens = normalizeCount(
      opts.cacheCreationTokens,
      'cacheCreationTokens',
    );
  }
  if (opts.costUsd !== undefined) {
    if (typeof opts.costUsd !== 'number' || !Number.isFinite(opts.costUsd) || opts.costUsd < 0) {
      throw new TypeError('createSlackUsageRecord: costUsd must be a non-negative finite number');
    }
    if (opts.costUsd > 0) record.costUsd = opts.costUsd;
  }
  if (opts.durationMs !== undefined) {
    record.durationMs = normalizeCount(opts.durationMs, 'durationMs');
  }
  if (opts.model !== undefined) record.model = opts.model;
  if (opts.stopReason !== undefined) record.stopReason = opts.stopReason;

  return record;
}

/**
 * Read the Slack usage log for a project. Returns `[]` when the file
 * does not exist (project hasn't run a Slack turn yet) and when the
 * file is corrupt (a stderr warning is emitted; the rest of the log
 * is treated as missing). Never throws on user-data corruption.
 */
export async function readSlackUsage(dataDir: string): Promise<SlackUsageRecord[]> {
  if (!dataDir) throw new TypeError('dataDir is required');
  const filePath = slackUsagePath(dataDir);

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      `aweek: ignoring malformed ${SLACK_CHANNEL_DIRNAME}/${SLACK_USAGE_FILENAME} (corrupt JSON)\n`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    process.stderr.write(
      `aweek: ignoring ${SLACK_CHANNEL_DIRNAME}/${SLACK_USAGE_FILENAME} (expected JSON array)\n`,
    );
    return [];
  }
  // Drop entries that don't structurally look like a usage record.
  // A single bad row should not poison the rest of the log.
  return parsed.filter(isSlackUsageRecord);
}

/**
 * Overwrite the Slack usage log with the given records. Used by the
 * {@link appendSlackUsageRecord} flow and by future GC paths that
 * trim old entries. Writes are atomic via tmp-then-rename so a
 * concurrent reader never observes a half-written file.
 */
export async function writeSlackUsage(
  dataDir: string,
  records: ReadonlyArray<SlackUsageRecord>,
): Promise<void> {
  if (!dataDir) throw new TypeError('dataDir is required');
  if (!Array.isArray(records)) {
    throw new TypeError('writeSlackUsage: records must be an array');
  }
  for (const record of records) {
    if (!isSlackUsageRecord(record)) {
      throw new TypeError('writeSlackUsage: every record must be a valid SlackUsageRecord');
    }
  }

  const filePath = slackUsagePath(dataDir);
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${shortId()}`;
  const payload = JSON.stringify(records, null, 2) + '\n';
  await writeFile(tmpPath, payload, 'utf-8');
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

/**
 * Append a single record to the Slack usage log. Idempotent on `id`
 * — re-appending a record already on disk is a no-op. Returns the
 * record that's now on disk (the input on a fresh append; the
 * pre-existing one when `id` collided).
 */
export async function appendSlackUsageRecord(
  dataDir: string,
  record: SlackUsageRecord,
): Promise<SlackUsageRecord> {
  if (!dataDir) throw new TypeError('dataDir is required');
  if (!isSlackUsageRecord(record)) {
    throw new TypeError('appendSlackUsageRecord: invalid record shape');
  }

  const records = await readSlackUsage(dataDir);
  const existing = records.find((r) => r.id === record.id);
  if (existing) return existing;

  records.push(record);
  await writeSlackUsage(dataDir, records);
  return record;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce an optional non-negative integer-like input. Undefined
 * becomes 0; negative / non-finite / non-numeric inputs throw.
 * Floats are truncated (`Math.trunc`) so the on-disk shape stays
 * integer-typed without surprising callers that pass `0.0` from a
 * JSON-parsed float.
 */
function normalizeCount(value: number | undefined, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `createSlackUsageRecord: ${label} must be a non-negative finite number`,
    );
  }
  return Math.trunc(value);
}

/**
 * Structural type-guard for a Slack usage record. Used both by the
 * write path (defensive validation) and the read path (filter out
 * corrupt rows). Mirrors the required subset of
 * {@link SlackUsageRecord} — optional fields are not checked.
 */
function isSlackUsageRecord(value: unknown): value is SlackUsageRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' && r.id.length > 0 &&
    typeof r.timestamp === 'string' && r.timestamp.length > 0 &&
    typeof r.threadKey === 'string' && r.threadKey.length > 0 &&
    typeof r.inputTokens === 'number' && Number.isFinite(r.inputTokens) && r.inputTokens >= 0 &&
    typeof r.outputTokens === 'number' && Number.isFinite(r.outputTokens) && r.outputTokens >= 0 &&
    typeof r.totalTokens === 'number' && Number.isFinite(r.totalTokens) && r.totalTokens >= 0 &&
    typeof r.success === 'boolean'
  );
}

/** Narrow `unknown` to a Node `ErrnoException` so we can read the `code` field. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
