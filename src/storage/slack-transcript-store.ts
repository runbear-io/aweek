/**
 * Per-Slack-thread conversation transcript — the memory layer for the
 * Gemini / Hermes Slack backends.
 *
 * Claude keeps Slack-thread continuity by resuming its CLI session id
 * (`--resume <id>`, persisted by `slack-thread-store.ts`). Gemini and
 * Hermes have no equivalent "resume a headless run by id" flag, so the
 * runner backend gives them memory the portable way: it persists the
 * thread's user/assistant turns here and replays them into each new
 * prompt. Same directory neighbourhood, same encoder, same atomic-write +
 * lazy-GC contract as `slack-thread-store.ts`, but a different shape and
 * its own subdirectory so the two never collide.
 *
 * On-disk: `.aweek/channels/slack/transcripts/<encodedThreadKey>.json`
 *   `{ threadKey, messages: [{ role, content }], lastUsedAt }`
 *
 * The message list is capped at {@link MAX_TRANSCRIPT_MESSAGES} (oldest
 * dropped first) so a long-running thread can't grow the replayed prompt
 * without bound. 24h idle TTL with lazy GC on read — matches the DM TTL
 * in `slack-thread-store.ts`, so a thread that goes quiet for a day starts
 * fresh, exactly like the Claude path's session GC.
 *
 * @module storage/slack-transcript-store
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import {
  encodeThreadKey,
  SLACK_THREAD_TTL_MS,
  type NowFn,
} from './slack-thread-store.js';

/** Max turns kept per thread before the oldest are dropped on write. */
export const MAX_TRANSCRIPT_MESSAGES = 40;

/** One turn in a Slack conversation transcript. */
export interface SlackTranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The persisted per-thread transcript document. */
export interface SlackTranscriptRecord {
  threadKey: string;
  messages: SlackTranscriptMessage[];
  /** Epoch ms of the most recent write; drives the 24h idle TTL. */
  lastUsedAt: number;
}

/** Resolve the transcript directory under a `.aweek/agents` data dir. */
function transcriptDir(dataDir: string): string {
  // `dataDir` is `<root>/.aweek/agents`; transcripts live beside the other
  // Slack channel state at `<root>/.aweek/channels/slack/transcripts/`.
  return join(dirname(dataDir), 'channels', 'slack', 'transcripts');
}

/** Absolute path of a thread's transcript file. */
export function slackTranscriptPath(dataDir: string, threadKey: string): string {
  return join(transcriptDir(dataDir), `${encodeThreadKey(threadKey)}.json`);
}

function isTranscriptRecord(value: unknown): value is SlackTranscriptRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (typeof r.threadKey !== 'string') return false;
  if (typeof r.lastUsedAt !== 'number' || !Number.isFinite(r.lastUsedAt)) return false;
  if (!Array.isArray(r.messages)) return false;
  return r.messages.every(
    (m) =>
      m &&
      typeof m === 'object' &&
      ((m as { role?: unknown }).role === 'user' ||
        (m as { role?: unknown }).role === 'assistant') &&
      typeof (m as { content?: unknown }).content === 'string',
  );
}

/**
 * Load a thread's transcript. Returns `null` when absent, malformed, or
 * expired (older than the 24h idle TTL) — expired records are deleted on
 * read so a stale thread starts fresh. A `null` return is the caller's
 * signal that this is the FIRST turn of a (new or GC'd) thread.
 */
export async function loadSlackTranscript(
  dataDir: string,
  threadKey: string,
  now: NowFn = Date.now,
): Promise<SlackTranscriptRecord | null> {
  const path = slackTranscriptPath(dataDir, threadKey);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null; // ENOENT (and any other read failure) → cold start
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await unlink(path).catch(() => undefined);
    return null;
  }
  if (!isTranscriptRecord(parsed)) {
    await unlink(path).catch(() => undefined);
    return null;
  }
  if (now() - parsed.lastUsedAt >= SLACK_THREAD_TTL_MS) {
    await unlink(path).catch(() => undefined);
    return null;
  }
  return parsed;
}

/**
 * Append one turn to a thread's transcript (creating the file on first
 * write), capped at {@link MAX_TRANSCRIPT_MESSAGES}. Atomic via
 * `writeFile(tmp)` + `rename`. Returns the persisted record.
 */
export async function appendSlackTranscript(
  dataDir: string,
  opts: {
    threadKey: string;
    role: 'user' | 'assistant';
    content: string;
    now?: NowFn;
  },
): Promise<SlackTranscriptRecord> {
  if (!opts || !opts.threadKey) {
    throw new TypeError('appendSlackTranscript: threadKey is required');
  }
  const now = opts.now ?? Date.now;
  const existing = await loadSlackTranscript(dataDir, opts.threadKey, now);
  const messages = existing ? [...existing.messages] : [];
  messages.push({ role: opts.role, content: opts.content });
  // Drop oldest turns beyond the cap so the replayed prompt stays bounded.
  const capped =
    messages.length > MAX_TRANSCRIPT_MESSAGES
      ? messages.slice(messages.length - MAX_TRANSCRIPT_MESSAGES)
      : messages;

  const record: SlackTranscriptRecord = {
    threadKey: opts.threadKey,
    messages: capped,
    lastUsedAt: now(),
  };

  const path = slackTranscriptPath(dataDir, opts.threadKey);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${now().toString(36)}`;
  await writeFile(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
  return record;
}
