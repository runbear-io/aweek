/**
 * Slack thread store — per-Slack-thread Claude session persistence.
 *
 * Sub-AC 5 of the Slack-aweek integration seed: when the embedded Slack
 * listener inside `aweek serve` receives the FIRST message in a Slack
 * thread, it spawns a project-level Claude with NO `--resume` flag.
 * The Claude Code CLI then mints a fresh `session_id` on its leading
 * `system` `init` line; that id is captured by the
 * {@link ProjectClaudeBackend}'s `onSessionInit` hook and MUST be
 * mirrored to disk before the next turn arrives so a subsequent
 * message in the same thread can pass `--resume <sessionId>`.
 *
 * Persistence shape — one file per Slack thread:
 *
 *   `<projectRoot>/.aweek/channels/slack/threads/<safeThreadKey>.json`
 *
 *     {
 *       "threadKey": "slack:C123:T456",
 *       "claudeSessionId": "8f1a…",
 *       "lastUsedAt": 1762560000000
 *     }
 *
 * `<safeThreadKey>` is the agentchannels `threadKey`
 * (`${adapterName}:${channelId}:${threadId}`) sanitised to a filename
 * via {@link encodeThreadKey} — colons (`:`) are unsafe on Windows /
 * many CI sandboxes, so we map them to a single underscore. The decoder
 * is intentionally not exposed: callers always have the original key
 * from the agentchannels `ThreadContext` and never need to round-trip
 * filenames back into keys.
 *
 * Lifecycle invariants (carried by the seed contract):
 *
 *   - Survives `aweek serve` restarts. The store reads-then-writes a
 *     single JSON file via the same atomic `write-tmp + rename` pattern
 *     other aweek stores use (`notification-store.ts`,
 *     `chat-conversation-store.ts`).
 *   - 24h idle TTL with **lazy GC on read**. {@link loadSlackThread}
 *     deletes a stale record (and returns `null`) when the on-disk
 *     `lastUsedAt` is older than {@link SLACK_THREAD_TTL_MS}; nothing
 *     proactively scans the directory. This keeps the store
 *     deterministic across restarts and clock skew — the file's
 *     mtime is irrelevant; only the persisted `lastUsedAt` matters.
 *   - **Idempotent overwrite.** {@link saveSlackThread} updates the
 *     same record in-place (no append, no history). The Slack
 *     execution surface is intentionally append-free: the on-disk
 *     contract is "the latest known sessionId for this thread, plus
 *     the wall-clock time we last touched it."
 *   - **Isolated from the heartbeat.** This store touches NOTHING
 *     under `.aweek/agents/<slug>/`; the per-thread lock and per-bucket
 *     usage accounting live elsewhere.
 *
 * Failure handling:
 *
 *   - Missing file → `null` (cold-start path; `aweek serve` boots
 *     against a project that hasn't seen any Slack traffic yet).
 *   - Malformed JSON → warn-and-treat-as-missing. We never throw out
 *     of {@link loadSlackThread}; a corrupt thread file should not
 *     pin a Slack channel.
 *   - Schema mismatch (missing required fields, wrong types) → same
 *     as malformed: warn and treat as missing.
 *
 * Concurrency model:
 *
 *   - Last-writer-wins per thread. Two writes against the same record
 *     race for the atomic `rename()`; whichever lands second is the
 *     committed state. Slack runs are serialised per thread by the
 *     per-Slack-thread lock (sibling AC) so this race is bounded to
 *     the rare case of two processes (e.g. an `aweek serve` restart
 *     overlap) writing simultaneously.
 *
 * @module storage/slack-thread-store
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Subdirectory under `<projectRoot>/.aweek/channels/slack/` that holds
 * per-thread session-id mirrors. Mirrors the existing
 * `<projectRoot>/.aweek/channels/slack/config.json` location so the
 * gitignore rule on `.aweek/` keeps these out of source control.
 */
export const SLACK_THREADS_DIRNAME = 'threads';

/**
 * 24h idle TTL in ms. Mirrors the seed contract's "24h idle TTL with
 * lazy GC on read" requirement — the threshold is fixed (not user
 * configurable) so the on-disk contract stays predictable across
 * `aweek serve` versions.
 */
export const SLACK_THREAD_TTL_MS = 24 * 60 * 60 * 1000;

/** Persisted shape of one thread record. */
export interface SlackThreadRecord {
  /**
   * Original agentchannels `threadKey`
   * (`${adapterName}:${channelId}:${threadId}`). Stored alongside the
   * filename-safe variant so a future operator can reconstruct the
   * routing key from the file alone (the encoder is lossy on edge
   * cases; the round-trip via `threadKey` field is canonical).
   */
  threadKey: string;
  /** Claude Code CLI session id assigned on the first turn. */
  claudeSessionId: string;
  /** Epoch-ms timestamp of the most recent turn against this thread. */
  lastUsedAt: number;
}

/**
 * Process-clock injection point for tests — defaults to {@link Date.now}.
 * Exposed so the lazy-GC tests can pin "now" forward of the persisted
 * `lastUsedAt` without touching real time.
 */
export type NowFn = () => number;

/**
 * Build the absolute path to a thread record JSON file given the
 * project's `.aweek` root and the agentchannels thread key.
 *
 * `dataDir` is the same `.aweek/agents` directory the rest of the
 * storage layer accepts. The file resolves to
 * `<projectRoot>/.aweek/channels/slack/threads/<encoded>.json` — one
 * level up from `agents`, into `channels/slack/threads/`.
 */
export function slackThreadPath(dataDir: string, threadKey: string): string {
  if (!dataDir) throw new TypeError('slackThreadPath: dataDir is required');
  if (!threadKey) throw new TypeError('slackThreadPath: threadKey is required');
  // Walk up from `.aweek/agents` to `.aweek/`, then descend into
  // `channels/slack/threads/`. Same convention as `slackConfigPath`.
  const aweekRoot = dirname(dataDir);
  return join(
    aweekRoot,
    'channels',
    'slack',
    SLACK_THREADS_DIRNAME,
    `${encodeThreadKey(threadKey)}.json`,
  );
}

/**
 * Sanitise a `threadKey` into a filename-safe slug.
 *
 * Slack-supplied threadKeys look like `slack:C0123ABC:1762560000.000123`,
 * which is fine on macOS/Linux but trips Windows ADS parsing. We map
 * everything that isn't `[A-Za-z0-9._-]` to a single underscore so the
 * filename round-trips cleanly across the same filesystems aweek
 * already supports.
 *
 * The encoder is lossy by design (two distinct keys could collide if
 * they only differ in non-alphanumeric punctuation). The persisted
 * `threadKey` field carries the original; the filename is purely a
 * lookup key.
 */
export function encodeThreadKey(threadKey: string): string {
  if (!threadKey) throw new TypeError('encodeThreadKey: threadKey is required');
  // Replace any sequence of unsafe chars with a single underscore.
  // Allow letters, digits, dot, hyphen, underscore — that's the
  // intersection of safe filename chars across macOS / Linux / Windows.
  const cleaned = threadKey.replace(/[^A-Za-z0-9._-]+/g, '_');
  // Defensive: collapse leading dots so we don't accidentally hide the
  // file (`.foo.json`) on POSIX. A `_foo.json` is fine.
  return cleaned.replace(/^\.+/, '_');
}

/** Generate a short random hex id (used for atomic-write tmp suffix). */
const shortId = (): string => randomBytes(4).toString('hex');

/**
 * Read the persisted record for a Slack thread, applying lazy GC.
 *
 * Behaviour matrix:
 *
 *   - File missing (`ENOENT`)            → returns `null`.
 *   - File malformed / wrong shape       → warns to stderr, returns `null`.
 *   - Record older than 24h              → deletes the file, returns `null`.
 *   - Record fresh                       → returns it as-is.
 *
 * @param dataDir   `<projectRoot>/.aweek/agents` — the same calling
 *                  convention the rest of the storage layer uses.
 * @param threadKey agentchannels thread key.
 * @param now       Optional clock for test isolation. Defaults to
 *                  {@link Date.now}.
 */
export async function loadSlackThread(
  dataDir: string,
  threadKey: string,
  now: NowFn = Date.now,
): Promise<SlackThreadRecord | null> {
  if (!dataDir) throw new TypeError('loadSlackThread: dataDir is required');
  if (!threadKey) {
    throw new TypeError('loadSlackThread: threadKey is required');
  }

  const path = slackThreadPath(dataDir, threadKey);

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
      `aweek: ignoring malformed Slack thread file ${path} and treating thread as cold\n`,
    );
    // Best-effort: delete the file so the next turn doesn't keep
    // hitting the same parse error.
    await unlink(path).catch(() => undefined);
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  const persistedKey =
    typeof candidate.threadKey === 'string' ? candidate.threadKey : undefined;
  const claudeSessionId =
    typeof candidate.claudeSessionId === 'string'
      ? candidate.claudeSessionId
      : undefined;
  const lastUsedAt =
    typeof candidate.lastUsedAt === 'number' ? candidate.lastUsedAt : undefined;

  if (!persistedKey || !claudeSessionId || lastUsedAt === undefined) {
    process.stderr.write(
      `aweek: Slack thread file ${path} missing required fields, treating thread as cold\n`,
    );
    await unlink(path).catch(() => undefined);
    return null;
  }

  // Lazy GC: any record older than 24h is treated as expired and the
  // file is deleted on read so the disk eventually self-cleans without
  // a separate scanner. Use `now() - lastUsedAt >= TTL` (NOT `>`) so
  // the boundary case is deterministic.
  if (now() - lastUsedAt >= SLACK_THREAD_TTL_MS) {
    await unlink(path).catch(() => undefined);
    return null;
  }

  return {
    threadKey: persistedKey,
    claudeSessionId,
    lastUsedAt,
  };
}

/**
 * Inputs accepted by {@link saveSlackThread}.
 */
export interface SaveSlackThreadOptions {
  /** Original agentchannels thread key (stored verbatim in the JSON). */
  threadKey: string;
  /** CLI session id — captured from the `system` `init` stream-json line. */
  claudeSessionId: string;
  /**
   * Optional override of `Date.now()`. Production callers leave this
   * unset; tests pin a fixed clock so the persisted `lastUsedAt` is
   * deterministic.
   */
  now?: NowFn;
}

/**
 * Persist a thread record. Creates the parent directory if missing,
 * writes a tmp file alongside, then `rename`s into place so a
 * concurrent reader either sees the previous bytes or the new bytes —
 * never a half-flushed file.
 *
 * Returns the record that was committed to disk so the caller can use
 * the same `lastUsedAt` value the file now carries (useful for
 * in-memory mirrors and observability).
 */
export async function saveSlackThread(
  dataDir: string,
  options: SaveSlackThreadOptions,
): Promise<SlackThreadRecord> {
  if (!dataDir) throw new TypeError('saveSlackThread: dataDir is required');
  if (!options) throw new TypeError('saveSlackThread: options is required');
  if (!options.threadKey) {
    throw new TypeError('saveSlackThread: options.threadKey is required');
  }
  if (!options.claudeSessionId) {
    throw new TypeError('saveSlackThread: options.claudeSessionId is required');
  }

  const now = options.now ?? Date.now;
  const path = slackThreadPath(dataDir, options.threadKey);

  const record: SlackThreadRecord = {
    threadKey: options.threadKey,
    claudeSessionId: options.claudeSessionId,
    lastUsedAt: now(),
  };

  await mkdir(dirname(path), { recursive: true });

  // Atomic write — same pattern notification-store / chat-conversation-
  // store use. Without the rename indirection a Ctrl-C between
  // `writeFile()` flushing the header and the body would leave a
  // half-formed JSON file, which the loader would then warn-and-delete
  // — costing us an unnecessary `--resume` regression on the next turn.
  const tmpPath = `${path}.${shortId()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  try {
    await rename(tmpPath, path);
  } catch (err) {
    // Cleanup the tmp file before propagating; otherwise repeated
    // failures would litter the threads dir.
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  return record;
}

/**
 * Delete the persisted record for a thread. Idempotent — a missing
 * file is a silent success. Used by:
 *
 *   - The lazy-GC path inside {@link loadSlackThread} (handled
 *     internally; do not call this from there).
 *   - Manual test cleanup.
 *   - A future `/aweek:slack reset-thread` slash command.
 */
export async function deleteSlackThread(
  dataDir: string,
  threadKey: string,
): Promise<void> {
  if (!dataDir) throw new TypeError('deleteSlackThread: dataDir is required');
  if (!threadKey) {
    throw new TypeError('deleteSlackThread: threadKey is required');
  }
  const path = slackThreadPath(dataDir, threadKey);
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw err;
  }
}
