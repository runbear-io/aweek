/**
 * Slack report-thread store — persists outbound CEO-report metadata so
 * the inbound Slack listener can inject the original report context the
 * first time the user replies to a `chat.postMessage` produced by the
 * `aweek report` skill.
 *
 * ## Why a separate store from `slack-thread-store`
 *
 * The existing {@link slack-thread-store} keys on
 * `${adapterName}:${channelId}:${threadId}` and persists ONLY
 * `{ claudeSessionId, lastUsedAt }` — the bridge looks it up when a
 * Slack message arrives in a thread that a previous turn already minted
 * a session for. But:
 *
 *   1. A report posted by the OUTBOUND `aweek exec report send` process
 *      never spawns a Claude session — it's a one-shot Slack Web-API
 *      POST. So `slack-thread-store` has no entry for the threadKey
 *      that future replies will carry.
 *   2. We want to surface the ORIGINAL report's content (title + body +
 *      sender slug + kind + source task) as system-prompt context the
 *      FIRST time someone replies, so the project-level Claude can
 *      respond in the report's frame instead of from a cold-start prompt.
 *
 * This module covers (2) by storing the report payload itself, keyed by
 * the same `threadKey` shape the inbound bridge uses. The inbound bridge
 * checks BOTH stores: `slack-thread-store` for an existing session
 * (resume path), `slack-report-thread-store` for first-reply context
 * (inject-and-mint path). After the first reply, the bridge writes a
 * `slack-thread-store` record as usual; subsequent replies in the same
 * thread `--resume` and don't need the report-thread record at all —
 * but we keep it around (30-day TTL) so a reply that comes in AFTER the
 * 24h DM TTL would have cleared the chat-thread session can still seed
 * a fresh session with the original context.
 *
 * ## Persistence shape
 *
 *   `<projectRoot>/.aweek/channels/slack/report-threads/<encoded>.json`
 *
 *     {
 *       "threadKey": "slack:C0123ABC:1762560000.000123",
 *       "senderSlug": "marketer-sam",
 *       "kind": "report",
 *       "title": "W21 launch ready",
 *       "body": "All channels primed, awaiting approval.",
 *       "sourceTaskId": "task-abc123",
 *       "postedAt": 1762560000000
 *     }
 *
 * `<encoded>` is the same filename-safe slug
 * {@link encodeThreadKey} produces for `slack-thread-store`, so the two
 * stores would never clash on disk even if the directories were merged
 * (they aren't — `report-threads/` is a sibling of `threads/`).
 *
 * ## Lifecycle invariants
 *
 *   - **30-day idle TTL** with **lazy GC on read**. {@link loadReportThread}
 *     deletes records older than {@link SLACK_REPORT_THREAD_TTL_MS} and
 *     returns `null`. The TTL is longer than the chat-thread store's 24h
 *     so a CEO who replies to a report days later still gets the context
 *     injected.
 *   - **Idempotent overwrite.** {@link saveReportThread} writes the record
 *     in-place (`writeFile` to a `.tmp` + `rename`). The outbound report
 *     path only ever writes ONCE per report — there is no "update" flow
 *     — but the idempotent-write contract lets a re-run after a Slack
 *     retry land safely.
 *   - **Isolated from `.aweek/agents/`.** No imports from the agent
 *     storage tree, no cross-references. Mirrors the same isolation
 *     contract the rest of the Slack channel surface enforces.
 *
 * ## Failure handling
 *
 *   - Missing file → `null` (cold-start path; not every Slack reply
 *     traces back to an aweek report).
 *   - Malformed JSON → warn-and-treat-as-missing, delete the file so
 *     the next read doesn't keep hitting the same parse error.
 *   - Schema mismatch (missing required fields, wrong types) → same as
 *     malformed.
 *
 * @module storage/slack-report-thread-store
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { encodeThreadKey } from './slack-thread-store.js';

/** Subdirectory under `<projectRoot>/.aweek/channels/slack/`. */
export const SLACK_REPORT_THREADS_DIRNAME = 'report-threads';

/**
 * 30-day TTL in ms. Chosen so a CEO who replies to a report days after
 * it was posted (well past the chat-thread store's 24h DM TTL) still
 * gets the original context injected into a fresh Claude session.
 */
export const SLACK_REPORT_THREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Report kinds accepted on disk — mirrors {@link REPORT_KINDS} in `src/skills/report.ts`. */
export type ReportThreadKind = 'report' | 'question';

const VALID_KINDS: readonly ReportThreadKind[] = ['report', 'question'];

/** Persisted shape of one report-thread record. */
export interface SlackReportThreadRecord {
  /**
   * Original agentchannels thread key
   * (`${adapterName}:${channelId}:${ts}`) — stored verbatim alongside
   * the filename-safe slug so an operator can reconstruct the routing
   * key from the file alone.
   */
  threadKey: string;
  /** Agent slug that emitted the report. */
  senderSlug: string;
  /** Report kind discriminator — `'report' | 'question'`. */
  kind: ReportThreadKind;
  /** Free-form title (mirrors the notification field). */
  title: string;
  /** Free-form body (mirrors the notification field). */
  body: string;
  /** Optional traceability — weekly-task id that produced the report. */
  sourceTaskId?: string;
  /** Epoch-ms wall-clock when the report was posted to Slack. */
  postedAt: number;
}

/** Clock injection point — defaults to {@link Date.now}. */
export type NowFn = () => number;

/**
 * Build the absolute path to a report-thread record JSON file. `dataDir`
 * is `.aweek/agents` (the rest of the storage layer's calling convention);
 * the file lives one level up under `channels/slack/report-threads/`.
 */
export function slackReportThreadPath(dataDir: string, threadKey: string): string {
  if (!dataDir) throw new TypeError('slackReportThreadPath: dataDir is required');
  if (!threadKey) {
    throw new TypeError('slackReportThreadPath: threadKey is required');
  }
  const aweekRoot = dirname(dataDir);
  return join(
    aweekRoot,
    'channels',
    'slack',
    SLACK_REPORT_THREADS_DIRNAME,
    `${encodeThreadKey(threadKey)}.json`,
  );
}

/** Generate a short random hex id (used for the atomic-write tmp suffix). */
const shortId = (): string => randomBytes(4).toString('hex');

/**
 * Read the persisted record for a Slack thread, applying lazy GC.
 *
 * Behaviour matrix:
 *
 *   - File missing (`ENOENT`)              → returns `null`.
 *   - File malformed / wrong shape         → warn, delete, return `null`.
 *   - Record older than 30 days            → delete the file, return `null`.
 *   - Record fresh                         → return it as-is.
 */
export async function loadReportThread(
  dataDir: string,
  threadKey: string,
  now: NowFn = Date.now,
): Promise<SlackReportThreadRecord | null> {
  if (!dataDir) throw new TypeError('loadReportThread: dataDir is required');
  if (!threadKey) throw new TypeError('loadReportThread: threadKey is required');

  const path = slackReportThreadPath(dataDir, threadKey);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      `aweek: ignoring malformed Slack report-thread file ${path} and treating reply as cold\n`,
    );
    await unlink(path).catch(() => undefined);
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const candidate = parsed as Record<string, unknown>;
  const persistedKey =
    typeof candidate.threadKey === 'string' ? candidate.threadKey : undefined;
  const senderSlug =
    typeof candidate.senderSlug === 'string' ? candidate.senderSlug : undefined;
  const kindRaw =
    typeof candidate.kind === 'string' ? candidate.kind : undefined;
  const kind =
    kindRaw && (VALID_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as ReportThreadKind)
      : undefined;
  const title = typeof candidate.title === 'string' ? candidate.title : undefined;
  const body = typeof candidate.body === 'string' ? candidate.body : undefined;
  const sourceTaskId =
    typeof candidate.sourceTaskId === 'string' ? candidate.sourceTaskId : undefined;
  const postedAt =
    typeof candidate.postedAt === 'number' ? candidate.postedAt : undefined;

  if (
    !persistedKey ||
    !senderSlug ||
    !kind ||
    !title ||
    !body ||
    postedAt === undefined
  ) {
    process.stderr.write(
      `aweek: Slack report-thread file ${path} missing required fields, treating reply as cold\n`,
    );
    await unlink(path).catch(() => undefined);
    return null;
  }

  if (now() - postedAt >= SLACK_REPORT_THREAD_TTL_MS) {
    await unlink(path).catch(() => undefined);
    return null;
  }

  const record: SlackReportThreadRecord = {
    threadKey: persistedKey,
    senderSlug,
    kind,
    title,
    body,
    postedAt,
  };
  if (sourceTaskId !== undefined) record.sourceTaskId = sourceTaskId;
  return record;
}

/** Inputs accepted by {@link saveReportThread}. */
export interface SaveReportThreadOptions {
  /** Original agentchannels thread key (stored verbatim). */
  threadKey: string;
  /** Agent slug that emitted the report. */
  senderSlug: string;
  /** Report kind — `'report' | 'question'`. */
  kind: ReportThreadKind;
  /** Free-form title (mirrors the notification). */
  title: string;
  /** Free-form body (mirrors the notification). */
  body: string;
  /** Optional traceability — weekly-task id. */
  sourceTaskId?: string;
  /** Optional clock injection — defaults to {@link Date.now}. */
  now?: NowFn;
}

/**
 * Persist a report-thread record. Creates the parent directory if
 * missing, writes a tmp file alongside, then `rename`s into place so a
 * concurrent reader either sees the previous bytes or the new bytes —
 * never a half-flushed file.
 */
export async function saveReportThread(
  dataDir: string,
  options: SaveReportThreadOptions,
): Promise<SlackReportThreadRecord> {
  if (!dataDir) throw new TypeError('saveReportThread: dataDir is required');
  if (!options) throw new TypeError('saveReportThread: options is required');
  if (!options.threadKey) {
    throw new TypeError('saveReportThread: options.threadKey is required');
  }
  if (!options.senderSlug) {
    throw new TypeError('saveReportThread: options.senderSlug is required');
  }
  if (!options.kind || !(VALID_KINDS as readonly string[]).includes(options.kind)) {
    throw new TypeError(
      `saveReportThread: options.kind must be one of ${VALID_KINDS.join(', ')}`,
    );
  }
  if (!options.title) {
    throw new TypeError('saveReportThread: options.title is required');
  }
  if (!options.body) {
    throw new TypeError('saveReportThread: options.body is required');
  }

  const now = options.now ?? Date.now;
  const postedAt = now();

  const record: SlackReportThreadRecord = {
    threadKey: options.threadKey,
    senderSlug: options.senderSlug,
    kind: options.kind,
    title: options.title,
    body: options.body,
    postedAt,
  };
  if (options.sourceTaskId !== undefined) record.sourceTaskId = options.sourceTaskId;

  const path = slackReportThreadPath(dataDir, options.threadKey);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${shortId()}`;
  const payload = JSON.stringify(record, null, 2) + '\n';
  await writeFile(tmpPath, payload, 'utf8');
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  return record;
}
