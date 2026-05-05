/**
 * Chat-side bridge to the shared weekly usage store.
 *
 * Sub-AC 1 of AC 7: chat-driven token spend has to land in the **same**
 * weekly usage record the heartbeat reads, so the budget enforcer
 * (`src/services/budget-enforcer.ts`) sees one combined pool per agent.
 *
 * The chat handler (`handleChatStream` in `src/serve/server.ts`) walks
 * a `ChatStreamEvent` async iterator from `streamAgentTurn`. Two events
 * carry the data we need to record:
 *
 *   1. `agent-init`    → `sessionId` (Anthropic Agent SDK session id).
 *   2. `turn-complete` → `usage` (input/output token counts, cost,
 *                        cache stats) + `durationMs`.
 *
 * After the iterator finishes, the handler hands the captured pair to
 * {@link recordChatUsage}, which builds a {@link UsageRecord} and
 * appends it via {@link UsageStoreLike.append}. The record uses a
 * synthetic `taskId` of `chat:<threadId-or-sessionId>` so chat usage is
 * grouped under one weekly file alongside heartbeat task usage but
 * stays distinguishable in queries.
 *
 * Why a separate module from `data/chat.ts`:
 *   - `data/chat.ts` is documented as **read/translate only** — it must
 *     never touch `.aweek/`. Persistence lives here.
 *   - The chat-conversation store handles thread persistence; usage
 *     tracking is a parallel concern with its own schema and weekly
 *     rotation, so it earns its own seam.
 *   - This module is dependency-injectable so unit tests can verify the
 *     wire-up without spinning up the whole server / SSE harness.
 *
 * @module serve/data/chat-usage
 */

import {
  createUsageRecord,
  getMondayDate,
  type UsageRecord,
  type UsageStore,
} from '../../storage/usage-store.js';
import type { ChatTokenUsage } from './chat.js';

/**
 * Minimal duck-typed UsageStore so test doubles can stand in for the
 * real class without re-implementing every storage helper. Mirrors the
 * `UsageStoreLike` shape `session-executor.ts` uses for the same reason.
 */
export interface ChatUsageStoreLike {
  append: (agentId: string, record: UsageRecord) => Promise<unknown>;
  init?: (agentId: string) => Promise<unknown>;
}

/** Inputs for {@link recordChatUsage}. */
export interface RecordChatUsageOptions {
  /** Agent slug whose budget should be charged. */
  agentId: string;
  /**
   * Chat-conversation id (the floating panel's thread id). When supplied
   * it forms the recorded `taskId` (`chat:<threadId>`) so usage records
   * group cleanly per thread for analytics queries. When absent the
   * record falls back to `chat:<sessionId>` and finally to `chat`.
   */
  threadId?: string;
  /**
   * Anthropic Agent SDK session id captured from the `agent-init` event.
   * Stored on the record's `sessionId` field for deduplication.
   */
  sessionId?: string;
  /** Token-usage payload from the `turn-complete` SDK event. */
  usage: ChatTokenUsage;
  /** Wall-clock duration of the turn in ms (from `turn-complete`). */
  durationMs?: number;
  /** Model that produced the response (if known). */
  model?: string;
  /**
   * Override the budget-week key. Defaults to the current Monday in
   * UTC (matching {@link getMondayDate}'s default). Production callers
   * leave unset; tests pin a deterministic week.
   */
  week?: string;
  /** Override the record timestamp. Defaults to now. */
  timestamp?: string;
}

/** Result of {@link recordChatUsage}. */
export interface RecordChatUsageResult {
  /** The persisted usage record (post-validation). */
  record: UsageRecord;
}

/**
 * Compute the synthetic `taskId` for a chat usage record.
 *
 * Format priority:
 *   1. `chat:<threadId>` — preferred, groups records by conversation.
 *   2. `chat:<sessionId>` — fallback when no threadId is available.
 *   3. `chat` — last-resort fallback (still satisfies the schema's
 *      `minLength: 1` constraint).
 *
 * Exposed for tests so they can assert the exact value the handler
 * computes without round-tripping through the file system.
 */
export function chatUsageTaskId(opts: {
  threadId?: string;
  sessionId?: string;
}): string {
  if (typeof opts.threadId === 'string' && opts.threadId.length > 0) {
    return `chat:${opts.threadId}`;
  }
  if (typeof opts.sessionId === 'string' && opts.sessionId.length > 0) {
    return `chat:${opts.sessionId}`;
  }
  return 'chat';
}

/**
 * Build a {@link UsageRecord} from a chat turn's token usage payload.
 *
 * Pure function — no I/O, deterministic given inputs (modulo the random
 * `id` and default timestamp). Useful both for the persistence path
 * (delegated to {@link recordChatUsage}) and for direct schema-shape
 * tests.
 */
export function buildChatUsageRecord(
  opts: RecordChatUsageOptions,
): UsageRecord {
  const taskId = chatUsageTaskId({
    threadId: opts.threadId,
    sessionId: opts.sessionId,
  });
  const ts = opts.timestamp ?? new Date().toISOString();
  const week = opts.week ?? getMondayDate(new Date(ts));
  const inputTokens = Math.max(0, Math.floor(opts.usage.inputTokens || 0));
  const outputTokens = Math.max(0, Math.floor(opts.usage.outputTokens || 0));
  // Cache tokens are reported separately by the Agent SDK. They count
  // against the same weekly pool, so we fold cache reads + creations into
  // the input bucket. This mirrors the convention `cli-session.parseTokenUsage`
  // applies for heartbeat sessions and keeps the budget arithmetic
  // consistent across both code paths.
  const cacheReads = Math.max(0, Math.floor(opts.usage.cacheReadTokens || 0));
  const cacheCreates = Math.max(
    0,
    Math.floor(opts.usage.cacheCreationTokens || 0),
  );
  const recordedInput = inputTokens + cacheReads + cacheCreates;
  const opts2: Parameters<typeof createUsageRecord>[0] = {
    agentId: opts.agentId,
    taskId,
    inputTokens: recordedInput,
    outputTokens,
    week,
    timestamp: ts,
  };
  if (opts.sessionId !== undefined) opts2.sessionId = opts.sessionId;
  if (opts.usage.totalCostUsd !== undefined && opts.usage.totalCostUsd > 0) {
    opts2.costUsd = opts.usage.totalCostUsd;
  }
  if (opts.durationMs !== undefined) opts2.durationMs = opts.durationMs;
  if (opts.model !== undefined) opts2.model = opts.model;
  return createUsageRecord(opts2);
}

/**
 * Persist a chat-turn's token usage to the shared weekly usage store.
 *
 * Idempotent: appending a record whose id already exists is a no-op
 * (handled by `UsageStore.append`). The store's atomic
 * write-tmp-then-rename pattern means the heartbeat reading the same
 * weekly file concurrently never observes a partial write.
 *
 * Errors are surfaced to the caller so the handler can decide whether
 * to swallow them (the chat turn already succeeded) or propagate them
 * to telemetry.
 */
export async function recordChatUsage(
  store: ChatUsageStoreLike,
  opts: RecordChatUsageOptions,
): Promise<RecordChatUsageResult> {
  if (!store) throw new Error('UsageStore is required');
  if (!opts.agentId || typeof opts.agentId !== 'string') {
    throw new Error('agentId is required and must be a non-empty string');
  }
  if (!opts.usage || typeof opts.usage !== 'object') {
    throw new Error('usage is required');
  }
  const record = buildChatUsageRecord(opts);
  if (typeof store.init === 'function') {
    await store.init(opts.agentId);
  }
  await store.append(opts.agentId, record);
  return { record };
}

// Re-export for callers that want to import everything from one place.
export type { UsageRecord, UsageStore };
