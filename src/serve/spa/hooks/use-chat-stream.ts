/**
 * `useChatStream` — Vercel AI SDK-style chat transport hook for the
 * floating chat panel in the aweek SPA.
 *
 * Sub-AC 3 of AC 1: implement the **client transport** that POSTs a user
 * message to `/api/chat` and begins reading the SSE stream as soon as
 * the response body is available. Earlier sub-ACs shipped:
 *   - Sub-AC 1: the SSE transport on the server (`server.ts` →
 *     `handleChatStream`) that flushes a `stream-start` frame
 *     immediately, then echoes the body, then closes.
 *   - Sub-AC 2: the `streamAgentTurn` translator in `serve/data/chat.ts`
 *     that yields non-buffered `ChatStreamEvent`s from the Anthropic
 *     Agent SDK. The chat handler in `server.ts` will swap echo →
 *     `streamAgentTurn` in a future sub-AC.
 *
 * This hook is the **client** half of that pipeline. It mirrors the
 * surface area of Vercel AI SDK's `useChat` (`messages`, `input`,
 * `setInput`, `handleSubmit`, `status`, `error`, `stop`) so a future
 * migration to the real `ai` package is a mechanical swap. We ship a
 * custom implementation for two reasons:
 *
 *   1. Vercel AI SDK isn't yet a project dependency — keeping the hook
 *      in-repo lets Sub-AC 3 land without bringing in a new transitive
 *      tree before the broader package decision is made.
 *   2. The server's SSE format is bespoke (`{type: 'stream-start'|...}`
 *      JSON frames) rather than Vercel AI SDK's data-stream protocol.
 *      Our parser knows how to consume both the transport-level frames
 *      (`stream-start`, `stream-end`, `stream-error`) and the chat
 *      events the Sub-AC 2 translator emits (`text-delta`,
 *      `assistant-message`, `tool-use`, `tool-result`, `turn-complete`,
 *      `turn-error`, `agent-init`). Forward-compatibility is therefore
 *      free: when the handler swaps echo → real chat events, no client
 *      change is required.
 *
 * Streaming guarantees:
 *   - The user message is appended to local `messages` **before** the
 *     fetch fires, so the composer feels instant even on a slow start.
 *   - As soon as the first SSE frame parses, an empty assistant message
 *     is appended and `status` flips to `'streaming'`. Subsequent
 *     `text-delta` frames mutate that one message's `content` in place
 *     (within the immutable React state pattern) so the UI re-renders
 *     once per delta.
 *   - The hook never buffers — each frame is parsed and dispatched in
 *     the same microtask the reader yielded the bytes on. This
 *     preserves the rubric's "first SSE chunk within 2 seconds" budget
 *     end-to-end.
 *
 * Abort + error handling:
 *   - `stop()` aborts the in-flight request via an `AbortController`.
 *     The reader exits cleanly, the assistant message keeps its
 *     accumulated content, and `status` returns to `'ready'`.
 *   - Network errors and non-2xx responses surface via `error` (an
 *     `Error` object) and flip `status` to `'error'`. The optional
 *     `onError` callback lets embedders log to telemetry.
 *   - Unmounting cancels the in-flight request automatically — there's
 *     no React state update on a torn-down component.
 *
 * @module serve/spa/hooks/use-chat-stream
 */

import * as React from 'react';

// ── Public types ─────────────────────────────────────────────────────

/**
 * Lifecycle states the hook reports through `status`. The vocabulary
 * mirrors Vercel AI SDK's so a future migration is a name-only swap.
 *
 *   - `ready`      — nothing in flight; safe to send.
 *   - `submitted`  — `sendMessage` invoked, waiting on response headers.
 *   - `streaming`  — response body is open, frames are arriving.
 *   - `error`      — fetch / parse failed. Clear via the next send.
 */
export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';

/**
 * Lifecycle state of a single tool invocation part within an assistant
 * message. Mirrors the {@link ToolInvocationState} surface in
 * `components/chat/tool-invocation-block.tsx`:
 *
 *   - `pending` — `tool-use` arrived, no matching `tool-result` yet.
 *   - `success` — `tool-result` arrived with `isError: false`.
 *   - `error`   — `tool-result` arrived with `isError: true`.
 *
 * Sub-AC 3 of AC 3: this is the bridge between streamed SSE
 * tool-call/tool-result frames and the renderer's collapsible block —
 * the renderer reads `state` directly to decide between the
 * spinner / success / destructive variants.
 */
export type ChatUIToolInvocationState = 'pending' | 'success' | 'error';

/**
 * Discriminated union of message parts the renderer interleaves inside
 * a single assistant message. Sub-AC 3 of AC 3 introduced the structure
 * so streamed `tool-use` / `tool-result` frames can render inline next
 * to the assistant's natural-language prose, matching the Claude Code
 * CLI's tool-use transparency.
 *
 *   - `text`            — a contiguous run of natural-language tokens.
 *                         Multiple text parts can exist when the model
 *                         interleaves prose with tool calls (e.g.
 *                         "let me read… [Read] …I see that…").
 *   - `tool-invocation` — one tool call. Identified by `toolUseId` so
 *                         the matching `tool-result` frame can update
 *                         the part in place when it arrives.
 */
export type ChatUIMessagePart =
  | {
      type: 'text';
      /** Concatenated text content for this run. */
      text: string;
    }
  | {
      type: 'tool-invocation';
      /**
       * `tool_use_id` from the wire frame — the same id is echoed back
       * by the server's matching `tool-result` so the renderer can
       * update the existing part rather than appending a new one.
       */
      toolUseId: string;
      /** Display name (e.g. `Read`, `mcp__github__create_issue`). */
      toolName: string;
      /** Tool argument payload. Pretty-printed by the renderer. */
      args: Record<string, unknown>;
      /** Lifecycle state — see {@link ChatUIToolInvocationState}. */
      state: ChatUIToolInvocationState;
      /**
       * Tool output payload. Populated when the matching
       * `tool-result` frame arrives.
       */
      result?: unknown;
      /**
       * Optional explicit error string surfaced by the renderer when
       * `state === 'error'`. Falls back to `result` when absent.
       */
      errorMessage?: string;
    };

/**
 * Minimal chat-message shape the hook keeps in state. The wire format
 * the server expects (`{ role, content }`) is a strict subset, so the
 * hook can serialise its own `messages` array directly when sending.
 *
 * Sub-AC 3 of AC 3 added `parts` — a structured stream of text +
 * tool-invocation parts in arrival order. The renderer prefers `parts`
 * when populated so streamed tool calls render inline within the
 * assistant's prose; `content` is kept up to date alongside as the
 * legacy fallback for environments / consumers that don't traverse
 * parts (notably `initialMessages` seeded from a thread replay).
 */
export interface ChatUIMessage {
  /** Stable client-generated id (uuid-ish). */
  id: string;
  /** `'user'` for composer-authored turns, `'assistant'` for replies. */
  role: 'user' | 'assistant';
  /** Concatenated natural-language text. Mutated as text-deltas arrive. */
  content: string;
  /**
   * Structured stream of {@link ChatUIMessagePart parts} in arrival
   * order. Optional — user messages and replayed initial messages
   * typically omit this; the renderer falls back to `content`.
   *
   * For assistant turns the hook always populates `parts`: each
   * `text-delta` appends to (or starts) the trailing text part; each
   * `tool-use` appends a `tool-invocation` part keyed by `toolUseId`;
   * each `tool-result` mutates the matching part's `state` / `result`.
   */
  parts?: ChatUIMessagePart[];
}

/**
 * Options accepted by {@link useChatStream}. Every field is optional
 * except `slug` so embedders can scope a thread to a specific agent
 * without re-deriving the URL on every render.
 */
export interface UseChatStreamOptions {
  /** Agent slug — round-tripped to the server in the POST body. */
  slug: string;
  /**
   * Active conversation/thread id — round-tripped to the server in the
   * POST body so the chat handler can persist user + assistant turns to
   * `.aweek/agents/<slug>/chat/<threadId>.json`. Without it the server's
   * persistence gate skips and thread history is lost on reload.
   */
  threadId?: string;
  /** Endpoint to POST to. Defaults to `'/api/chat'`. */
  api?: string;
  /**
   * Optional base URL prefixed onto `api`. The SPA defaults to a
   * same-origin relative path so production deployments work without
   * configuration; tests pin a base URL to assert the full URL.
   */
  baseUrl?: string;
  /** Test seam — defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Optional starting messages, e.g. for thread replay. */
  initialMessages?: ChatUIMessage[];
  /** Notified once per failed turn. Invoked **after** state updates. */
  onError?: (error: Error) => void;
  /**
   * Override the id generator. The default uses `crypto.randomUUID()`
   * when available, falling back to a counter-based id for jsdom test
   * environments where `crypto` may be absent.
   */
  generateId?: () => string;
  /**
   * Latency instrumentation hook (Sub-AC 4 of AC 1).
   *
   * Called exactly once per `sendMessage` turn, the moment the first
   * SSE frame parses successfully out of the response body. The
   * callback receives the **submit→first-chunk latency** in
   * milliseconds — i.e. the wall-clock interval between the moment the
   * hook entered `sendMessage` and the moment the first usable SSE
   * frame surfaced from the network reader. Callers can pipe this into
   * telemetry (PostHog, console.timing, etc.) to track the rubric's
   * "first SSE chunk within 2 seconds" budget end-to-end without
   * polling React state on every render.
   *
   * Timing is captured with `performance.now()` when available and
   * falls back to `Date.now()` so the instrumentation works inside
   * jsdom test runners.
   */
  onFirstChunk?: (latencyMs: number) => void;
  /**
   * Test seam — overrides the high-resolution clock used by the
   * latency-instrumentation path. Returns a monotonic millisecond
   * timestamp. Defaults to `performance.now()` when present, else
   * `Date.now()`. Tests inject a deterministic clock so the latency
   * assertion isn't flaky on slow CI runners.
   */
  now?: () => number;
}

/**
 * Return value of {@link useChatStream}. Surface mirrors Vercel AI
 * SDK's `useChat` so embedders can wire `<form onSubmit={handleSubmit}>`
 * + a controlled `<textarea value={input} onChange={handleInputChange}>`
 * with no glue code.
 */
export interface UseChatStreamResult {
  /** Live list of messages in the thread. */
  messages: ChatUIMessage[];
  /** Current composer text. */
  input: string;
  /** Direct setter for `input`. */
  setInput: (next: string) => void;
  /** Convenience handler for `<input>` / `<textarea>` `onChange`. */
  handleInputChange: (
    event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
  /** Current lifecycle state — see {@link ChatStatus}. */
  status: ChatStatus;
  /** Last error, or `null` when the previous turn ended cleanly. */
  error: Error | null;
  /**
   * Send a user message and begin streaming the response. Idempotent
   * while a turn is in flight (calls during `submitted` / `streaming`
   * are ignored — `stop()` first if you need to interrupt).
   *
   * Returns a promise that resolves when the stream closes (cleanly
   * or via abort / error) so embedders can `await` if they need to.
   */
  sendMessage: (text: string) => Promise<void>;
  /**
   * Form-style submit handler. Reads the current `input`, clears it,
   * then calls `sendMessage`. Whitespace-only input is dropped.
   */
  handleSubmit: (event?: { preventDefault?: () => void }) => void;
  /** Abort the in-flight request, if any. Safe to call when idle. */
  stop: () => void;
  /**
   * Submit→first-chunk latency for the most recent turn, in
   * milliseconds. `null` until a turn has emitted a first SSE frame.
   *
   * Sub-AC 4 instrumentation: this state mirrors the value passed to
   * the optional `onFirstChunk` callback so observability surfaces
   * (e.g. a footer chip on the chat panel) can render the latency
   * without re-implementing the timer. Reset to `null` at the start
   * of each new `sendMessage` invocation.
   */
  firstChunkLatencyMs: number | null;
  /**
   * Sub-AC 4 of AC 7: server-side budget verdict for the most recent
   * turn. `null` while the agent has remaining budget (the normal
   * case); a populated payload when the chat handler emitted a
   * `budget-exhausted` SSE frame in lieu of streaming the model
   * response.
   *
   * Consumers (e.g. {@link ChatThread}) gate the composer + surface
   * the canonical "Weekly budget exhausted — resume via aweek manage"
   * banner when this value is non-null. Cleared at the start of each
   * subsequent `sendMessage` so a top-up between turns frees the
   * composer the moment the next turn is allowed through.
   */
  budgetExhausted: BudgetExhaustedInfo | null;
}

// ── Wire-format types (mirrored from `serve/data/chat.ts`) ──────────

/**
 * Discriminated union of every SSE frame the parser knows how to
 * consume. Includes:
 *   - Transport-level frames emitted by `server.ts` (`stream-start`,
 *     `stream-end`, `stream-error`, `echo`).
 *   - Chat events emitted by `streamAgentTurn` (`agent-init`,
 *     `text-delta`, `tool-use`, `tool-result`, `assistant-message`,
 *     `turn-complete`, `turn-error`).
 *
 * Unknown frames are tolerated silently — the protocol is forward-
 * compatible by design so a server-side schema addition doesn't
 * crash existing clients.
 */
export type ChatTransportFrame =
  | { type: 'stream-start'; t?: number; serverLatencyMs?: number }
  | { type: 'stream-end' }
  | { type: 'stream-error'; message?: string }
  | { type: 'echo'; body: unknown }
  | { type: 'agent-init'; sessionId: string; tools: string[]; cwd: string }
  | { type: 'text-delta'; delta: string; messageUuid?: string }
  | {
      type: 'tool-use';
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      messageUuid?: string;
    }
  | {
      type: 'tool-result';
      toolUseId: string;
      content: unknown;
      isError: boolean;
    }
  | { type: 'assistant-message'; uuid: string; content: unknown }
  | {
      type: 'turn-complete';
      usage: Record<string, unknown>;
      durationMs: number;
      stopReason: string | null;
    }
  | { type: 'turn-error'; error: string }
  | {
      // Sub-AC 4 of AC 7: server-side budget gate verdict. Emitted
      // by `server.ts:handleChatStream` (via `buildBudgetExhaustedFrame`
      // in `serve/data/chat-budget.ts`) when the agent's weekly token
      // budget is exhausted or the agent is paused. The chat panel
      // disables its composer and surfaces a banner pointing at
      // `aweek manage` so the user can resume / top-up.
      type: 'budget-exhausted';
      reason: 'budget_exhausted';
      agentId: string;
      weekMonday: string;
      used: number;
      budget: number;
      remaining: number;
      paused: boolean;
      message: string;
    };

/**
 * Budget verdict surfaced through {@link UseChatStreamResult.budgetExhausted}.
 *
 * Sub-AC 4 of AC 7: the chat panel's composer disables itself and
 * renders the "Weekly budget exhausted — resume via aweek manage"
 * banner whenever this value is non-null. The hook flips it when the
 * server emits a `budget-exhausted` SSE frame; consumers can also seed
 * it from agent status (e.g. an agent already in `'budget-exhausted'`
 * status before any send attempt).
 *
 * Mirrors the on-wire `budget-exhausted` frame shape minus the
 * transport-level `type` discriminant.
 */
export interface BudgetExhaustedInfo {
  reason: 'budget_exhausted';
  agentId: string;
  weekMonday: string;
  used: number;
  budget: number;
  remaining: number;
  paused: boolean;
  message: string;
}

// ── Implementation helpers ───────────────────────────────────────────

/**
 * Default id generator. Prefers `crypto.randomUUID()` when available
 * (browsers, modern Node) and falls back to a monotonic counter for
 * environments where it's missing (older jsdom, deterministic tests).
 */
function makeDefaultIdGenerator(): () => string {
  let counter = 0;
  return () => {
    if (
      typeof globalThis !== 'undefined' &&
      globalThis.crypto &&
      typeof globalThis.crypto.randomUUID === 'function'
    ) {
      return globalThis.crypto.randomUUID();
    }
    counter += 1;
    return `chat-${Date.now().toString(36)}-${counter}`;
  };
}

/**
 * Default monotonic clock used by the submit→first-chunk latency
 * instrumentation (Sub-AC 4). Prefers `performance.now()` because it is
 * monotonic and immune to wall-clock adjustments mid-turn; falls back
 * to `Date.now()` so the hook still produces a sensible reading inside
 * environments that lack `performance` (older jsdom, sandboxed
 * runtimes). Returned values are millisecond offsets, not absolute
 * timestamps — the caller subtracts two readings to obtain a duration.
 */
function defaultNow(): number {
  if (
    typeof globalThis !== 'undefined' &&
    globalThis.performance &&
    typeof globalThis.performance.now === 'function'
  ) {
    return globalThis.performance.now();
  }
  return Date.now();
}

/**
 * `AbortController` errors surface as `AbortError` (DOMException) on
 * the browser/undici and `'ABORT_ERR'` codes on older Node. We accept
 * either so the caller-initiated `stop()` path is recognised
 * everywhere.
 */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

/**
 * Extract the natural-language text from an Anthropic SDK structured
 * `content` block array (the `assistant-message` event surfaces the
 * raw `SDKAssistantMessage['message']['content']`). Concatenates every
 * `text` block — `tool_use` blocks are surfaced via dedicated frames
 * and don't belong in the message body.
 */
function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      out += (block as { text: string }).text;
    }
  }
  return out;
}

/**
 * Join a base URL + endpoint into a full request URL. Matches the
 * `joinUrl` helper in `lib/api-client.ts` byte-for-byte so the chat
 * transport composes cleanly with the rest of the SPA's URL plumbing.
 */
function joinUrl(baseUrl: string, endpoint: string): string {
  if (!baseUrl) return endpoint;
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedEnd = endpoint.replace(/^\/+/, '/');
  return `${trimmedBase}${trimmedEnd.startsWith('/') ? '' : '/'}${trimmedEnd}`;
}

// ── SSE parser ───────────────────────────────────────────────────────

/**
 * Minimal SSE-frame parser. The hook reads the response body byte-for-
 * byte and feeds the decoded UTF-8 string into this function, which
 * yields one parsed frame per `\n\n`-delimited record. Comment lines
 * (`: open`) and frames with no `data:` payload are silently dropped.
 *
 * Exported (under `__test`) so unit tests can pin the parsing contract
 * without driving a full hook lifecycle.
 */
export function parseSseFrame(frame: string): ChatTransportFrame | null {
  // SSE record format: each line is either a comment (`: ...`) or a
  // `field: value` pair. We only care about `data: <json>` lines —
  // every transport frame is JSON, so we collect every data line and
  // join them on `\n` (per the SSE spec).
  let dataPayload = '';
  const lines = frame.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      dataPayload += (dataPayload ? '\n' : '') + line.slice('data: '.length);
    } else if (line.startsWith('data:')) {
      dataPayload += (dataPayload ? '\n' : '') + line.slice('data:'.length);
    }
  }
  if (!dataPayload) return null;
  try {
    const parsed = JSON.parse(dataPayload);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { type?: unknown }).type === 'string'
    ) {
      return parsed as ChatTransportFrame;
    }
  } catch {
    // Malformed JSON — drop the frame. The server is the trusted side
    // of the protocol and shouldn't ship malformed JSON; if it ever
    // does, treating the frame as a no-op keeps the rest of the stream
    // legible rather than aborting the whole turn.
  }
  return null;
}

// ── Hook ─────────────────────────────────────────────────────────────

/**
 * React hook that POSTs a user message to the chat endpoint and
 * streams the SSE response body into local message state.
 *
 * See the module header for the full contract; this function-level
 * comment focuses on the implementation invariants.
 *
 * Implementation invariants:
 *   - All async work runs through a `useRef`-stored `AbortController`
 *     so the cleanup effect can cancel in-flight work on unmount.
 *   - The user-message append happens **before** `fetch()` so the
 *     composer renders instantly even on a slow connection.
 *   - The empty assistant placeholder is created at the same time so
 *     subsequent `text-delta` frames have a target to mutate.
 *   - State updates use the functional updater form so concurrent
 *     events (e.g. multiple text-deltas in one chunk) compose
 *     correctly without races.
 *   - The hook is robust to the server closing without a terminal
 *     `turn-complete` — it falls back to `'ready'` on `stream-end`
 *     too, so transport-only frames keep the UI legible.
 */
export function useChatStream(
  options: UseChatStreamOptions,
): UseChatStreamResult {
  const {
    slug,
    threadId,
    api = '/api/chat',
    baseUrl = '',
    fetch: fetchImpl,
    initialMessages = [],
    onError,
    onFirstChunk,
    generateId,
    now,
  } = options;

  const [messages, setMessages] = React.useState<ChatUIMessage[]>(
    () => initialMessages.slice(),
  );
  const [input, setInputState] = React.useState<string>('');
  const [status, setStatus] = React.useState<ChatStatus>('ready');
  const [error, setError] = React.useState<Error | null>(null);
  // Sub-AC 4 (latency instrumentation) state — mirrors the value passed
  // to `onFirstChunk` so consumers can render it inline without wiring
  // up an extra ref. Reset to `null` at the start of every new turn.
  const [firstChunkLatencyMs, setFirstChunkLatencyMs] = React.useState<
    number | null
  >(null);
  // Sub-AC 4 of AC 7: server-side budget verdict. `null` while the
  // agent has budget; populated when the chat handler emits a
  // `budget-exhausted` SSE frame in lieu of streaming a model
  // response. Reset to `null` at the start of every new turn so a
  // post-top-up retry sees a clean slate.
  const [budgetExhausted, setBudgetExhausted] =
    React.useState<BudgetExhaustedInfo | null>(null);

  // Mutable refs so the long-lived `sendMessage` closure can access
  // the latest values without forcing a re-render dependency dance.
  const messagesRef = React.useRef<ChatUIMessage[]>(messages);
  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const abortRef = React.useRef<AbortController | null>(null);
  const idGeneratorRef = React.useRef<() => string>(
    generateId ?? makeDefaultIdGenerator(),
  );
  React.useEffect(() => {
    if (generateId) idGeneratorRef.current = generateId;
  }, [generateId]);

  // Cancel any in-flight stream when the consumer unmounts. We don't
  // null `abortRef.current` here — the `finally` block in `sendMessage`
  // owns that lifecycle.
  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ── setInput / handleInputChange ──────────────────────────────────

  const setInput = React.useCallback((next: string): void => {
    setInputState(next);
  }, []);

  const handleInputChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      setInputState(event.target.value);
    },
    [],
  );

  // ── stop ──────────────────────────────────────────────────────────

  const stop = React.useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  // ── sendMessage ───────────────────────────────────────────────────

  const sendMessage = React.useCallback(
    async (text: string): Promise<void> => {
      // Drop empty / whitespace-only sends so the form-submit handler
      // doesn't have to remember to guard each call site.
      const trimmed = text.trim();
      if (!trimmed) return;

      // Refuse re-entry while a turn is already in flight. Vercel AI
      // SDK's `useChat` semantics: the consumer must `stop()` first.
      if (abortRef.current !== null) return;

      const fetchFn =
        fetchImpl ??
        (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
          ? globalThis.fetch.bind(globalThis)
          : null);
      if (!fetchFn) {
        const noFetchErr = new Error(
          'useChatStream: global fetch is unavailable. Pass `fetch` explicitly.',
        );
        setError(noFetchErr);
        setStatus('error');
        onError?.(noFetchErr);
        return;
      }

      const userMessage: ChatUIMessage = {
        id: idGeneratorRef.current(),
        role: 'user',
        content: trimmed,
      };
      const assistantMessage: ChatUIMessage = {
        id: idGeneratorRef.current(),
        role: 'assistant',
        content: '',
      };

      // Snapshot the message list *before* mutation so we can build
      // the wire payload from the same view the user just saw. The
      // setState below appends the user msg + the placeholder; the
      // wire payload below sends the user msg only (the placeholder
      // is a UI artefact, not part of the conversation history).
      const baseMessages = messagesRef.current.slice();
      const wireMessages = [
        ...baseMessages.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: trimmed },
      ];

      // Optimistic append: user msg + empty assistant placeholder.
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setError(null);
      setStatus('submitted');
      // Sub-AC 4: clear any prior turn's latency reading at the moment
      // of submit so consumers can distinguish "in-flight, no chunk
      // yet" from "previous turn finished, next not started".
      setFirstChunkLatencyMs(null);
      // Sub-AC 4 of AC 7: clear any prior budget-exhausted verdict at
      // submit time so a post-top-up retry sees a clean slate. If the
      // server still rejects the turn the verdict will be re-set when
      // the `budget-exhausted` frame arrives below.
      setBudgetExhausted(null);

      // Latency instrumentation — capture the submit timestamp using
      // the high-resolution clock when available so we can compute the
      // submit→first-chunk interval down to the millisecond once the
      // first SSE frame parses.
      const clock = now ?? defaultNow;
      const submitAt = clock();
      let firstChunkSeen = false;

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const url = joinUrl(baseUrl, api);

      try {
        const response = await fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(
            threadId !== undefined
              ? { slug, threadId, messages: wireMessages }
              : { slug, messages: wireMessages },
          ),
          signal: ctrl.signal,
        });

        if (!response.ok) {
          // Try to surface the server's error envelope when present.
          let bodyText = '';
          try {
            bodyText = await response.text();
          } catch {
            /* ignore */
          }
          let serverMsg = `HTTP ${response.status}`;
          try {
            const parsed = JSON.parse(bodyText) as { error?: unknown };
            if (parsed && typeof parsed.error === 'string') {
              serverMsg = parsed.error;
            }
          } catch {
            if (bodyText) serverMsg = bodyText.slice(0, 200);
          }
          throw new Error(serverMsg);
        }

        if (!response.body) {
          throw new Error('Response has no body — cannot stream chat.');
        }

        // First byte is in flight (or already arrived). Flip status so
        // the composer renders a "streaming…" indicator without waiting
        // for the first parsed frame.
        setStatus('streaming');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // Pump the stream, splitting on the SSE record terminator
        // (`\n\n`). Anything left over between reads stays in `buffer`
        // until the next chunk completes the frame.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let separatorIdx = buffer.indexOf('\n\n');
          while (separatorIdx !== -1) {
            const rawFrame = buffer.slice(0, separatorIdx);
            buffer = buffer.slice(separatorIdx + 2);
            const frame = parseSseFrame(rawFrame);
            if (frame) {
              // Sub-AC 4: capture submit→first-chunk latency on the
              // very first parseable frame of the turn. We measure at
              // *parse* (not at the raw-byte read) so the reading
              // reflects an actually-usable event — a `: open` SSE
              // comment or a partial frame the buffer hasn't completed
              // yet shouldn't tick the clock. Once recorded, the flag
              // suppresses re-firing on subsequent frames in the same
              // turn.
              if (!firstChunkSeen) {
                firstChunkSeen = true;
                const latency = clock() - submitAt;
                setFirstChunkLatencyMs(latency);
                onFirstChunk?.(latency);
              }
              // Sub-AC 4 of AC 7: capture the server-side budget
              // verdict. The chat handler emits this frame in lieu of
              // streaming the model when the agent's weekly budget is
              // spent or the agent is paused; consumers gate their
              // composer on this value being non-null and surface the
              // canonical banner. We snapshot before `applyFrame` so
              // the dispatched setMessages and setBudgetExhausted land
              // in the same React batch where possible.
              if (frame.type === 'budget-exhausted') {
                setBudgetExhausted(extractBudgetInfo(frame));
              }
              applyFrame(frame, assistantMessage.id, setMessages);
            }
            separatorIdx = buffer.indexOf('\n\n');
          }
        }
        // Flush any residual buffered frame (servers usually emit a
        // trailing `\n\n` but we tolerate the alternative).
        if (buffer.length > 0) {
          const frame = parseSseFrame(buffer);
          if (frame) {
            if (!firstChunkSeen) {
              firstChunkSeen = true;
              const latency = clock() - submitAt;
              setFirstChunkLatencyMs(latency);
              onFirstChunk?.(latency);
            }
            if (frame.type === 'budget-exhausted') {
              setBudgetExhausted(extractBudgetInfo(frame));
            }
            applyFrame(frame, assistantMessage.id, setMessages);
          }
        }

        setStatus('ready');
      } catch (err) {
        if (isAbortError(err)) {
          // Caller invoked `stop()` — keep the partial assistant content
          // and return to ready. Don't surface as an error.
          setStatus('ready');
          return;
        }
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setStatus('error');
        onError?.(e);
      } finally {
        abortRef.current = null;
      }
    },
    [api, baseUrl, fetchImpl, now, onError, onFirstChunk, slug],
  );

  // ── handleSubmit ──────────────────────────────────────────────────

  const handleSubmit = React.useCallback(
    (event?: { preventDefault?: () => void }): void => {
      event?.preventDefault?.();
      const current = input;
      if (!current.trim()) return;
      setInputState('');
      void sendMessage(current);
    },
    [input, sendMessage],
  );

  return {
    messages,
    input,
    setInput,
    handleInputChange,
    status,
    error,
    sendMessage,
    handleSubmit,
    firstChunkLatencyMs,
    budgetExhausted,
    stop,
  };
}

/**
 * Extract the persistent payload from a `budget-exhausted` SSE frame.
 *
 * Strips the transport-level `type` discriminator so the value can be
 * stored directly in {@link UseChatStreamResult.budgetExhausted} —
 * consumers don't need to distinguish "frame on the wire" from
 * "verdict at rest". Exported via `__test` for unit tests that need
 * to round-trip through the same projection the hook uses.
 */
function extractBudgetInfo(
  frame: ChatTransportFrame & { type: 'budget-exhausted' },
): BudgetExhaustedInfo {
  return {
    reason: frame.reason,
    agentId: frame.agentId,
    weekMonday: frame.weekMonday,
    used: frame.used,
    budget: frame.budget,
    remaining: frame.remaining,
    paused: frame.paused,
    message: frame.message,
  };
}

// ── Parts plumbing ───────────────────────────────────────────────────
// Helpers for projecting streamed SSE frames onto the structured
// `ChatUIMessage.parts` array introduced in Sub-AC 3 of AC 3. Each
// helper is pure / immutable — `applyFrame` dispatches via the
// functional setState form, so these may run multiple times within a
// single React batch without trampling each other.

/**
 * Append a `text-delta` to the trailing text part of `parts`.
 *
 * Behaviour:
 *   - If the last existing part is `text`, the delta is concatenated
 *     onto it (so a long stream of text-deltas collapses into one
 *     part rather than fragmenting per-token).
 *   - Otherwise (no parts, or the last part is a tool-invocation), a
 *     new text part is appended after the existing parts so the
 *     interleaving order matches arrival order on the wire.
 *
 * Returns a brand-new array — the caller never mutates the previous
 * `parts` reference, so React's structural-equality bail-out still
 * works as expected.
 */
function appendTextDelta(
  parts: ChatUIMessagePart[] | undefined,
  delta: string,
): ChatUIMessagePart[] {
  const base = parts ?? [];
  const last = base[base.length - 1];
  if (last && last.type === 'text') {
    return [
      ...base.slice(0, -1),
      { type: 'text', text: last.text + delta },
    ];
  }
  return [...base, { type: 'text', text: delta }];
}

/**
 * Replace the trailing text part of `parts` with the canonical text
 * surfaced by an `assistant-message` frame. Used to synchronise the
 * structured parts with the SDK's authoritative text after a turn
 * completes (the SDK occasionally rewrites partial output, and this
 * keeps the renderer aligned with `content`).
 *
 *   - When the message ends with a text part, that part's `text` is
 *     replaced with `text` so already-streamed tool-invocation parts
 *     stay intact.
 *   - When the message ends with a tool-invocation (or has no parts
 *     yet), a fresh text part is appended so the canonical text is
 *     still surfaced.
 */
function replaceTrailingText(
  parts: ChatUIMessagePart[] | undefined,
  text: string,
): ChatUIMessagePart[] {
  const base = parts ?? [];
  const last = base[base.length - 1];
  if (last && last.type === 'text') {
    return [...base.slice(0, -1), { type: 'text', text }];
  }
  return [...base, { type: 'text', text }];
}

/**
 * Append a fresh `tool-invocation` part for an incoming `tool-use`
 * frame. Idempotent on `toolUseId` — if a part with the same id
 * already exists (e.g. a re-emitted frame after a transient retry),
 * the existing part is left in place.
 */
function appendToolUse(
  parts: ChatUIMessagePart[] | undefined,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown> | undefined,
): ChatUIMessagePart[] {
  const base = parts ?? [];
  const exists = base.some(
    (p) => p.type === 'tool-invocation' && p.toolUseId === toolUseId,
  );
  if (exists) return base;
  return [
    ...base,
    {
      type: 'tool-invocation',
      toolUseId,
      toolName,
      args: input ?? {},
      state: 'pending',
    },
  ];
}

/**
 * Apply a `tool-result` frame to the matching `tool-invocation` part
 * identified by `toolUseId`.
 *
 *   - Sets `state` to `'success'` or `'error'` based on the wire
 *     `isError` flag.
 *   - Stores the raw `content` payload in `result` so the renderer can
 *     pretty-print it (string passthrough; everything else is
 *     JSON-stringified by the renderer).
 *   - On error, when the result is a string, also pins `errorMessage`
 *     so the destructive-tinted block surfaces a clean message.
 *
 * Out-of-order or unmatched `tool-result` frames are dropped — the
 * server only emits results for tool-uses we already saw, but the
 * helper stays defensive so a sparse stream doesn't crash the hook.
 */
function applyToolResult(
  parts: ChatUIMessagePart[] | undefined,
  toolUseId: string,
  content: unknown,
  isError: boolean,
): ChatUIMessagePart[] {
  const base = parts ?? [];
  let matched = false;
  const next = base.map((p) => {
    if (p.type !== 'tool-invocation' || p.toolUseId !== toolUseId) return p;
    matched = true;
    const updated: ChatUIMessagePart = {
      type: 'tool-invocation',
      toolUseId: p.toolUseId,
      toolName: p.toolName,
      args: p.args,
      state: isError ? 'error' : 'success',
      result: content,
    };
    if (isError && typeof content === 'string') {
      updated.errorMessage = content;
    }
    return updated;
  });
  // Defensive: tolerate a `tool-result` that arrived without a
  // preceding `tool-use` (shouldn't happen in practice — server
  // guarantees ordering — but keeps the hook from silently dropping
  // the result on a buggy stream).
  if (!matched) return base;
  return next;
}

// ── State-update plumbing ───────────────────────────────────────────

/**
 * Mutate the messages array in response to a single parsed SSE frame.
 * Extracted from the hook body so the streaming loop stays linear and
 * each frame's effect on state is documented in one place.
 *
 * The function returns nothing — it dispatches a functional setState
 * so concurrent frames in the same chunk compose correctly.
 */
function applyFrame(
  frame: ChatTransportFrame,
  assistantMessageId: string,
  setMessages: React.Dispatch<React.SetStateAction<ChatUIMessage[]>>,
): void {
  switch (frame.type) {
    case 'text-delta': {
      const delta = frame.delta;
      if (typeof delta !== 'string' || delta.length === 0) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMessageId) return m;
          // Sub-AC 3 of AC 3: keep `content` updated for the legacy
          // fallback render path, AND project the delta onto the
          // structured `parts` stream so the renderer can interleave
          // text with tool-invocation blocks.
          const parts = appendTextDelta(m.parts, delta);
          return { ...m, content: m.content + delta, parts };
        }),
      );
      return;
    }
    case 'assistant-message': {
      // Replace the in-progress content with the canonical text from
      // the structured assistant message. This lets the model "rewrite"
      // its own partial output (rare, but supported by the SDK) and
      // also strips any tool_use blocks that snuck into the deltas.
      const text = extractAssistantText(frame.content);
      if (!text) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMessageId) return m;
          // Replace the trailing text part (or append a fresh one when
          // the message ends with a tool-invocation) with the canonical
          // text from the structured block list. Keeps tool-invocation
          // parts intact so a mid-turn `assistant-message` rewrite
          // doesn't drop already-streamed tool calls.
          const parts = replaceTrailingText(m.parts, text);
          return { ...m, content: text, parts };
        }),
      );
      return;
    }
    case 'tool-use': {
      // Sub-AC 3 of AC 3: append a new tool-invocation part keyed by
      // `toolUseId`. The renderer mounts a `ToolInvocationBlock` in
      // `'pending'` state until the matching `tool-result` arrives.
      if (typeof frame.toolUseId !== 'string' || frame.toolUseId.length === 0) {
        return;
      }
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMessageId) return m;
          const parts = appendToolUse(
            m.parts,
            frame.toolUseId,
            frame.name,
            frame.input,
          );
          return { ...m, parts };
        }),
      );
      return;
    }
    case 'tool-result': {
      // Sub-AC 3 of AC 3: locate the in-flight tool-invocation part by
      // `toolUseId` and update its state + result. Out-of-order or
      // missing parts (e.g. a `tool-result` for a `tool-use` we never
      // saw) are silently dropped — the renderer is forward-compatible
      // with sparse streams and the wire protocol guarantees the
      // tool-use frame precedes its result for cleanly-streamed turns.
      if (typeof frame.toolUseId !== 'string' || frame.toolUseId.length === 0) {
        return;
      }
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMessageId) return m;
          const parts = applyToolResult(
            m.parts,
            frame.toolUseId,
            frame.content,
            frame.isError,
          );
          return { ...m, parts };
        }),
      );
      return;
    }
    case 'echo': {
      // Sub-AC 1 placeholder: surface the echo body as plain text so
      // the chat panel renders something legible even before the
      // server is wired to the real Agent SDK output. Once that swap
      // lands, `echo` frames stop arriving and this branch becomes
      // dead code (kept for forward-compat).
      const body = frame.body;
      const rendered =
        typeof body === 'string' ? body : JSON.stringify(body, null, 2);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId ? { ...m, content: rendered } : m,
        ),
      );
      return;
    }
    case 'turn-error':
    case 'stream-error': {
      // Server-reported error mid-stream — surface the message in the
      // assistant slot so the user sees *something* and the hook
      // settles to `'error'` once the stream closes (caller flips
      // status in the catch block; this branch only handles content).
      const msg =
        frame.type === 'turn-error'
          ? frame.error
          : frame.message ?? 'stream error';
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId
            ? { ...m, content: m.content || `⚠️ ${msg}` }
            : m,
        ),
      );
      return;
    }
    // Frames with no direct UI state effect in v1 (still surfaced via
    // future event subscriptions in later sub-ACs).
    case 'agent-init':
    case 'turn-complete':
    case 'stream-start':
    case 'stream-end':
      return;
    case 'budget-exhausted': {
      // Sub-AC 4 of AC 7: surface the verdict in the empty assistant
      // bubble so the user sees the reason inline even if the panel
      // banner is dismissed / scrolled away. The composer is gated by
      // `budgetExhausted` state in the hook return — this branch is
      // purely cosmetic and only runs when the placeholder is still
      // empty (no model tokens streamed in this turn, by definition).
      const msg = frame.message;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId
            ? { ...m, content: m.content || `⚠️ ${msg}` }
            : m,
        ),
      );
      return;
    }
    default: {
      // Exhaustiveness check — the discriminant above covers every
      // arm of `ChatTransportFrame`. New frame types added in later
      // sub-ACs hit this branch and pass through silently.
      return;
    }
  }
}

// ── Test-facing internals ────────────────────────────────────────────
// Exported for unit tests only — not part of the SPA's public API.

export const __test = {
  parseSseFrame,
  extractAssistantText,
  extractBudgetInfo,
  joinUrl,
  isAbortError,
  applyFrame,
  appendTextDelta,
  replaceTrailingText,
  appendToolUse,
  applyToolResult,
  defaultNow,
} as const;
