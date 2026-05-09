/**
 * Stream-JSON Line Parser — Claude CLI `--output-format stream-json`
 * NDJSON events translated into agentchannels {@link AgentStreamEvent}
 * shapes for the Slack channel adapter.
 *
 * Sub-AC 4.3 of the Slack-aweek integration seed: the
 * {@link spawnProjectClaudeSession} helper in
 * `src/execution/cli-session.ts` emits one Claude Code SDK message per
 * stdout line via the `onStdoutLine` callback. Those lines arrive in
 * the SDK message format (a discriminated union over `system`,
 * `stream_event`, `assistant`, `user`, `result`, …) and need to be
 * adapted to agentchannels' five terminal-or-streaming events
 * — `text_delta`, `tool_use`, `tool_result`, `done`, `error` — before
 * the `StreamingBridge` can render them as Slack message updates.
 *
 * Design:
 *
 *   - **Pure parser, side-effect-free.** {@link parseStreamJsonLine}
 *     takes a single raw NDJSON line and returns zero-or-more
 *     {@link AgentStreamEvent}s. It NEVER throws on malformed input
 *     (CLI noise, partial buffers, log breadcrumbs leaked onto stdout)
 *     — invalid lines map to an empty array so the upstream readline
 *     pipeline can never be poisoned by a one-off parse failure.
 *
 *   - **Backpressure-safe queue.** {@link StreamEventQueue} is a
 *     push/pull bridge between the synchronous `onStdoutLine` callback
 *     (which cannot wait for an async consumer) and an
 *     `AsyncIterable<AgentStreamEvent>` consumer (the agentchannels
 *     `Backend.sendMessage` async generator). Pushed events buffer
 *     internally; pulled-but-not-yet-pushed `next()` calls park on a
 *     waiter Promise; the producer never blocks and the consumer
 *     never spins. A terminal `done` / `error` event auto-closes the
 *     queue so the consumer's `for await` loop exits cleanly.
 *
 *   - **Out-of-band metadata via callbacks.** The CLI's `system`
 *     `init` event carries the `session_id` we need to persist for
 *     `--resume` continuity and the `result` event carries token usage
 *     we need to record against the Slack usage bucket. Neither belongs
 *     in the {@link AgentStreamEvent} union — they are surfaced through
 *     the optional {@link ParseStreamJsonLineOptions.onSessionInit} /
 *     {@link ParseStreamJsonLineOptions.onResult} callbacks so callers
 *     can route them to the thread store / usage store without a
 *     downstream filter pass.
 *
 * Boundary notes:
 *
 *   - This module ONLY depends on the agentchannels public type
 *     export `AgentStreamEvent`. It does not import the spawn helper
 *     or any aweek persistence — the parser is reusable for any
 *     consumer that has a stream-json line stream to drive (e.g. a
 *     future per-subagent backend).
 *   - Unknown SDK message types are silently ignored. The Claude
 *     Code SDK ships dozens of internal message subtypes (status,
 *     hook progress, plugin install, …) that the agentchannels
 *     contract does not surface.
 *
 * @module serve/slack-stream-event-parser
 */

import type { AgentStreamEvent } from 'agentchannels';

// ── Out-of-band metadata shapes ──────────────────────────────────────

/**
 * Information lifted from the CLI's first `system` `init` line.
 *
 * The `sessionId` is the Claude Code CLI session id we persist on the
 * Slack thread record so subsequent turns can pass `--resume <id>`.
 * Tools and cwd are surfaced for diagnostic logging — they are not
 * required by the Slack execution surface.
 */
export interface SystemInitInfo {
  /** Claude Code CLI session id assigned to this run. */
  sessionId: string;
  /** Tools the CLI advertised on this run (informational). */
  tools: string[];
  /** Working directory the CLI is running in (informational). */
  cwd: string;
  /** Model in use, when reported. */
  model?: string;
}

/**
 * Information lifted from the terminal `result` line.
 *
 * Carries the token-usage breakdown that the Slack usage bucket
 * (`.aweek/channels/slack/usage.json`) records per turn, plus the
 * `stop_reason` / `is_error` flags the queue uses to decide between
 * yielding `done` or `error`.
 */
export interface ResultInfo {
  /** `stop_reason` from the result line, e.g. `"end_turn"`. */
  stopReason?: string;
  /** Result `subtype`, e.g. `"success"` or `"error_max_turns"`. */
  subtype?: string;
  /** Whether the CLI reported the run as an error. */
  isError: boolean;
  /** Wall-clock duration of the turn, when reported. */
  durationMs?: number;
  /** Token-usage breakdown for the turn. */
  usage: ResultUsage;
}

/** Token-usage breakdown extracted from a CLI `result` line. */
export interface ResultUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalCostUsd?: number;
}

/** Optional callbacks invoked alongside event emission. */
export interface ParseStreamJsonLineOptions {
  /**
   * Fired exactly once when the CLI emits its leading
   * `{ type: "system", subtype: "init" }` line. Throws are swallowed
   * so a buggy listener cannot orphan the parser.
   */
  onSessionInit?: (info: SystemInitInfo) => void;
  /**
   * Fired once when the CLI emits its terminal `result` line, before
   * the matching `done` or `error` AgentStreamEvent is yielded. Throws
   * are swallowed for the same reason.
   */
  onResult?: (info: ResultInfo) => void;
}

// ── Pure line parser ─────────────────────────────────────────────────

/**
 * Translate a single stream-json NDJSON line into zero-or-more
 * {@link AgentStreamEvent}s.
 *
 * The contract is intentionally permissive:
 *
 *   - Blank lines / whitespace-only lines → `[]`.
 *   - Non-JSON lines → `[]` (CLI may interleave plain-text breadcrumbs
 *     under specific failure modes).
 *   - JSON values that are not plain objects (arrays, primitives) → `[]`.
 *   - Recognised SDK message types → the equivalent AgentStreamEvent
 *     sequence.
 *   - Unrecognised `type` values (status updates, hook progress,
 *     plugin install, …) → `[]`.
 *
 * The function itself is synchronous and pure. Any side effects (the
 * `onSessionInit` / `onResult` callbacks) come from the explicit
 * options bag and are isolated by try/catch so a listener throw does
 * not poison the calling readline pipeline.
 */
export function parseStreamJsonLine(
  line: string,
  options: ParseStreamJsonLineOptions = {},
): AgentStreamEvent[] {
  if (typeof line !== 'string') return [];
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const msg = parsed as Record<string, unknown>;
  const type = typeof msg.type === 'string' ? msg.type : null;
  if (!type) return [];

  switch (type) {
    case 'system':
      return parseSystem(msg, options);
    case 'stream_event':
      return parseStreamEvent(msg);
    case 'assistant':
      return parseAssistant(msg);
    case 'user':
      return parseUser(msg);
    case 'result':
      return parseResult(msg, options);
    default:
      // status, hook_*, task_*, plugin_install, files_persisted, … —
      // the agentchannels contract does not surface these.
      return [];
  }
}

function parseSystem(
  msg: Record<string, unknown>,
  options: ParseStreamJsonLineOptions,
): AgentStreamEvent[] {
  if (msg.subtype !== 'init') return [];
  if (!options.onSessionInit) return [];

  const sessionId = typeof msg.session_id === 'string' ? msg.session_id : '';
  const cwd = typeof msg.cwd === 'string' ? msg.cwd : '';
  const tools = Array.isArray(msg.tools)
    ? (msg.tools.filter((t) => typeof t === 'string') as string[])
    : [];

  const info: SystemInitInfo = { sessionId, tools, cwd };
  if (typeof msg.model === 'string') info.model = msg.model;

  try {
    options.onSessionInit(info);
  } catch {
    // Listener errors must not poison the parser. The session-id
    // missing path is handled by the caller (turn proceeds without
    // --resume next time).
  }
  return [];
}

function parseStreamEvent(msg: Record<string, unknown>): AgentStreamEvent[] {
  const event = msg.event as Record<string, unknown> | undefined;
  if (!event || typeof event !== 'object') return [];
  if (event.type !== 'content_block_delta') return [];

  const delta = event.delta as Record<string, unknown> | undefined;
  if (!delta || typeof delta !== 'object') return [];
  if (delta.type === 'text_delta' && typeof delta.text === 'string') {
    return [{ type: 'text_delta', text: delta.text }];
  }
  // thinking_delta, input_json_delta, … — agentchannels does not
  // surface these in the v1 contract. Drop them silently.
  return [];
}

function parseAssistant(msg: Record<string, unknown>): AgentStreamEvent[] {
  const message = msg.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];

  const events: AgentStreamEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    // The Claude Code CLI emits `assistant` messages with text + tool_use
    // content blocks. Without the text branch the StreamingBridge sees
    // 0 chars and ships the `emptyResponseText` fallback (the
    // `parseStreamEvent` SSE-delta path is only hit when the CLI runs in
    // delta-streaming mode, which `claude --print --output-format
    // stream-json` does NOT do — it emits whole content blocks).
    if (b.type === 'text' && typeof b.text === 'string') {
      events.push({ type: 'text_delta', text: b.text });
      continue;
    }
    if (b.type === 'thinking' && typeof b.thinking === 'string') {
      // Anthropic's extended-thinking content blocks ship as
      // `{ type: 'thinking', thinking: '<text>', signature?: '...' }` inside
      // the `assistant.message.content[]` array. Same drop-on-floor problem
      // the text branch above just fixed: without this case the
      // StreamingBridge never sees a thinking event and skips the plan-task
      // indicator (`appendTasks` arm in agentchannels' streaming-bridge.js
      // case 'thinking'). Mapped to agentchannels' `ThinkingEvent` shape
      // (`{ type: 'thinking', text?: string }`), which is `text` not
      // `thinking` on the output side.
      events.push({ type: 'thinking', text: b.thinking });
      continue;
    }
    if (b.type === 'tool_use') {
      const name = typeof b.name === 'string' ? b.name : 'unknown';
      events.push({ type: 'tool_use', name, input: b.input });
    }
  }
  return events;
}

function parseUser(msg: Record<string, unknown>): AgentStreamEvent[] {
  const message = msg.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];

  const events: AgentStreamEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_result') continue;
    const evt: AgentStreamEvent = { type: 'tool_result' };
    if (typeof b.tool_use_id === 'string') {
      (evt as { type: 'tool_result'; toolUseId?: string }).toolUseId =
        b.tool_use_id;
    }
    events.push(evt);
  }
  return events;
}

function parseResult(
  msg: Record<string, unknown>,
  options: ParseStreamJsonLineOptions,
): AgentStreamEvent[] {
  const subtype = typeof msg.subtype === 'string' ? msg.subtype : undefined;
  const stopReason =
    typeof msg.stop_reason === 'string' ? msg.stop_reason : undefined;
  const isError =
    msg.is_error === true ||
    (typeof subtype === 'string' && subtype.length > 0 && subtype !== 'success');

  const usageRaw = msg.usage as Record<string, unknown> | undefined;
  const usage: ResultUsage = {
    inputTokens:
      typeof usageRaw?.input_tokens === 'number' ? usageRaw.input_tokens : 0,
    outputTokens:
      typeof usageRaw?.output_tokens === 'number' ? usageRaw.output_tokens : 0,
  };
  if (typeof usageRaw?.cache_read_input_tokens === 'number') {
    usage.cacheReadTokens = usageRaw.cache_read_input_tokens;
  }
  if (typeof usageRaw?.cache_creation_input_tokens === 'number') {
    usage.cacheCreationTokens = usageRaw.cache_creation_input_tokens;
  }
  if (typeof msg.total_cost_usd === 'number') {
    usage.totalCostUsd = msg.total_cost_usd;
  }

  if (options.onResult) {
    const info: ResultInfo = { isError, usage };
    if (stopReason) info.stopReason = stopReason;
    if (subtype) info.subtype = subtype;
    if (typeof msg.duration_ms === 'number') info.durationMs = msg.duration_ms;
    try {
      options.onResult(info);
    } catch {
      // Same reasoning as onSessionInit — never let a listener throw
      // poison the parser.
    }
  }

  if (isError) {
    const errMessage =
      typeof msg.result === 'string' && msg.result.length > 0
        ? msg.result
        : typeof msg.error === 'string' && msg.error.length > 0
          ? msg.error
          : subtype && subtype !== 'success'
            ? `CLI reported ${subtype}`
            : 'CLI reported error';
    return [{ type: 'error', error: errMessage }];
  }

  const doneEvent: AgentStreamEvent = stopReason
    ? { type: 'done', stopReason }
    : { type: 'done' };
  return [doneEvent];
}

// ── Backpressure-safe async-iterable queue ──────────────────────────

/** Construction options for {@link StreamEventQueue}. */
export interface StreamEventQueueOptions extends ParseStreamJsonLineOptions {}

/**
 * Push/pull bridge that adapts a synchronous CLI line stream into an
 * `AsyncIterable<AgentStreamEvent>` consumer.
 *
 * Lifecycle:
 *
 *   1. Construct the queue with the {@link StreamEventQueueOptions}
 *      (typically `onSessionInit` / `onResult` for thread-store and
 *      usage-bucket persistence).
 *   2. Wire the producer side: pass {@link push} into
 *      `spawnProjectClaudeSession`'s `onStdoutLine` callback. Each
 *      call parses the line synchronously and enqueues zero-or-more
 *      {@link AgentStreamEvent}s.
 *   3. Wire the consumer side: `for await (const evt of queue) { … }`
 *      inside the agentchannels `Backend.sendMessage` async generator.
 *      The loop receives events as they arrive (parked on a waiter
 *      Promise when the queue is empty) and exits cleanly when the
 *      queue terminates.
 *   4. Termination — pick exactly one:
 *      - The CLI emits a `result` line. The parser yields a `done`
 *        (or `error`) event, the queue marks itself ended, and the
 *        consumer's `for await` exits naturally.
 *      - The CLI process exits without a `result` line (rare —
 *        usually means a crash). The producer calls {@link end} or
 *        {@link fail}. {@link end} synthesises a `done` if no
 *        terminal event was emitted yet; {@link fail} synthesises
 *        an `error`. Either way the consumer's loop exits.
 *
 * Backpressure model:
 *
 *   - The producer side is non-blocking — `push()` returns
 *     synchronously regardless of whether a consumer is currently
 *     awaiting `next()`. Events buffer in an internal array when the
 *     consumer is slow.
 *   - The consumer side is async — `next()` resolves immediately if
 *     the buffer is non-empty, and otherwise parks on a single
 *     waiter slot until the next `push()` / `end()` / `fail()` call.
 *   - Idempotency — `end()` and `fail()` are no-ops once a terminal
 *     event has been emitted, so callers can defensively call them
 *     from process-exit handlers without worrying about double-emit.
 *
 * Cancellation:
 *
 *   - Calling `iterator.return()` (i.e. `break` in a `for await`)
 *     aborts the iteration, drops the buffer, and resolves any
 *     pending waiter. Subsequent `push()`es are silently dropped.
 *   - Aborting the upstream CLI (via the spawn helper's
 *     `AbortSignal`) means the producer eventually calls `end()`
 *     or `fail()`; the queue is the right place to translate that
 *     into a clean iterator exit.
 */
export class StreamEventQueue implements AsyncIterable<AgentStreamEvent> {
  private readonly options: StreamEventQueueOptions;
  private readonly buffer: AgentStreamEvent[] = [];
  private waiter:
    | ((result: IteratorResult<AgentStreamEvent>) => void)
    | null = null;
  /** True once `end()` / `fail()` ran or a terminal event was emitted. */
  private ended = false;
  /** True once `done` / `error` has been enqueued. Prevents double-terminal. */
  private terminalEmitted = false;
  /** True once iterator.return() has been called. */
  private returned = false;

  constructor(options: StreamEventQueueOptions = {}) {
    this.options = options;
  }

  /**
   * Parse one CLI stream-json line and enqueue any resulting
   * {@link AgentStreamEvent}s. Calls after termination are silently
   * ignored — once the consumer's iterator has surfaced a `done` or
   * `error`, further events are unreachable.
   */
  push(line: string): void {
    if (this.returned || this.ended) return;
    let events: AgentStreamEvent[];
    try {
      events = parseStreamJsonLine(line, this.options);
    } catch {
      // The parser already swallows JSON / listener errors, but a
      // truly defensive fence here costs us nothing and guards against
      // future refactors that might let a throw escape.
      return;
    }

    for (const evt of events) {
      this.enqueue(evt);
      if (evt.type === 'done' || evt.type === 'error') {
        this.terminalEmitted = true;
        this.ended = true;
        // Stop processing further events on this line — the contract
        // is "first terminal wins".
        break;
      }
    }
  }

  /**
   * Mark the producer side complete. If no terminal event has been
   * emitted yet, synthesise a `done` so the consumer's `for await`
   * exits cleanly. Idempotent.
   */
  end(): void {
    if (this.ended) {
      this.flushWaiterIfDrained();
      return;
    }
    this.ended = true;
    if (!this.terminalEmitted) {
      this.terminalEmitted = true;
      this.enqueue({ type: 'done' });
    }
    this.flushWaiterIfDrained();
  }

  /**
   * Mark the producer side as having failed. If no terminal event has
   * been emitted yet, synthesise an `error` carrying the failure
   * message so the consumer can surface it. Idempotent — calling
   * `fail()` after a clean `done` does NOT replace the terminal.
   */
  fail(error: unknown): void {
    if (this.ended) {
      this.flushWaiterIfDrained();
      return;
    }
    this.ended = true;
    if (!this.terminalEmitted) {
      this.terminalEmitted = true;
      const message =
        error instanceof Error
          ? (error.message || error.name || 'Stream error')
          : String(error);
      this.enqueue({ type: 'error', error: message });
    }
    this.flushWaiterIfDrained();
  }

  /** Buffered (unconsumed) event count. Useful for diagnostics / tests. */
  get bufferedCount(): number {
    return this.buffer.length;
  }

  /** True when no further events can ever be yielded. */
  get isDone(): boolean {
    return this.ended && this.buffer.length === 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentStreamEvent> {
    return {
      next: (): Promise<IteratorResult<AgentStreamEvent>> => {
        if (this.returned) {
          return Promise.resolve({ value: undefined, done: true });
        }
        if (this.buffer.length > 0) {
          const value = this.buffer.shift() as AgentStreamEvent;
          return Promise.resolve({ value, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        // Park until push() / end() / fail() / return() resolves us.
        // Only one waiter at a time — the consumer pulls serially.
        return new Promise<IteratorResult<AgentStreamEvent>>((resolve) => {
          this.waiter = resolve;
        });
      },
      return: (): Promise<IteratorResult<AgentStreamEvent>> => {
        this.returned = true;
        this.ended = true;
        this.buffer.length = 0;
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          w({ value: undefined, done: true });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (
        err?: unknown,
      ): Promise<IteratorResult<AgentStreamEvent>> => {
        this.returned = true;
        this.ended = true;
        this.buffer.length = 0;
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          w({ value: undefined, done: true });
        }
        return Promise.reject(err);
      },
    };
  }

  private enqueue(evt: AgentStreamEvent): void {
    if (this.returned) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: evt, done: false });
      return;
    }
    this.buffer.push(evt);
  }

  private flushWaiterIfDrained(): void {
    if (this.buffer.length === 0 && this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }
}
