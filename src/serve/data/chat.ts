/**
 * Chat data layer — bridges the SSE transport in `src/serve/server.ts`
 * (Vercel AI SDK `useChat` on the client) to the Anthropic Agent SDK's
 * `query()` async generator (`@anthropic-ai/claude-agent-sdk`).
 *
 * Sub-AC 2 of AC 1 scope: this module wires the Anthropic Agent SDK so
 * that the SPA's floating chat panel can stream a single agent turn end
 * to end. The defining guarantee is **non-buffered streaming** — every
 * `SDKMessage` produced by the Agent SDK's `Query` is yielded onward as
 * a `ChatStreamEvent` immediately, with no accumulator or wait-for-end
 * pattern between the SDK and the SSE writer in `server.ts`. That
 * preserves the rubric's "first SSE chunk within 2 seconds" guarantee
 * once a later sub-AC wires this generator into the chat handler.
 *
 * Subsequent sub-ACs layer on:
 *   - thread persistence (`chat-conversation` store under
 *     `.aweek/agents/<slug>/chat/`)
 *   - shared weekly budget enforcement via `BudgetEnforcer`, including
 *     a graceful in-flight cutoff
 *   - system preamble injection (plan.md summary + recent activity log
 *     entries + ISO-week key + budget remaining)
 *   - subagent identity loading from `.claude/agents/<slug>.md` plus
 *     MCP server passthrough so chat has full tool parity with the
 *     heartbeat CLI session path
 *
 * Design notes:
 *   - The Agent SDK is **lazy-imported** so `aweek serve` cold-start
 *     does not pay the cost (~150ms) on dashboards that never open the
 *     chat panel.
 *   - The Agent SDK runner is **dependency-injectable** via the
 *     `runQuery` parameter so unit tests can drive deterministic
 *     message sequences without invoking the real `claude` CLI. The
 *     non-buffering invariant is exercised through this seam.
 *   - This module is **read/translate only** — it never persists chat
 *     state, never reads `.aweek/`, and never touches `.claude/agents`.
 *     Persistence, identity loading, budget enforcement, and preamble
 *     composition land in subsequent sub-ACs and remain orthogonal.
 *
 * @module serve/data/chat
 */

import type {
  Options as AgentSdkOptions,
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

// ── Public types ─────────────────────────────────────────────────────

/**
 * Token-usage numbers reported when a turn completes. Mirrors the shape
 * `parseTokenUsage` in `src/execution/cli-session.ts` produces, so a
 * later sub-AC can route chat-side usage through the same
 * `usage-store.recordTokens` path the heartbeat already uses (one
 * shared weekly budget pool per agent).
 */
export interface ChatTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalCostUsd?: number;
}

/**
 * Structural enum of the events the chat data layer emits toward the
 * SSE transport. Kept narrow on purpose so the SPA `useChat` hook +
 * floating panel can render each event with a dedicated component
 * without an open-ended discriminated union sprawl.
 *
 * The wire format is `data: <JSON>\n\n` per SSE convention; encoding
 * lives in `writeSseEvent` in `server.ts`.
 */
export type ChatStreamEvent =
  | {
      type: 'agent-init';
      sessionId: string;
      tools: string[];
      cwd: string;
    }
  | {
      type: 'text-delta';
      delta: string;
      messageUuid: string;
    }
  | {
      type: 'tool-use';
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      messageUuid: string;
    }
  | {
      type: 'tool-result';
      toolUseId: string;
      content: unknown;
      isError: boolean;
    }
  | {
      type: 'assistant-message';
      uuid: string;
      content: SDKAssistantMessage['message']['content'];
    }
  | {
      type: 'turn-complete';
      usage: ChatTokenUsage;
      durationMs: number;
      stopReason: string | null;
    }
  | {
      type: 'turn-error';
      error: string;
    };

/** Minimal chat-thread message shape used for full-thread replay. */
export interface ChatTurnMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Test-injectable Agent SDK runner. The default runner proxies to the
 * real `query()` from `@anthropic-ai/claude-agent-sdk`; tests pass a
 * fake that returns a deterministic `AsyncIterable<SDKMessage>`.
 *
 * The return value is intentionally an `AsyncIterable<SDKMessage>` (a
 * superset of the SDK's `Query` async generator) so test fakes can
 * return a plain `async function*` without satisfying the full `Query`
 * interface (`interrupt`, `setPermissionMode`, `streamInput`, …).
 */
export type AgentSdkRunner = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: AgentSdkOptions;
}) => AsyncIterable<SDKMessage>;

/**
 * Parameters for {@link streamAgentTurn}. Kept deliberately narrow in
 * this sub-AC — only the fields needed to run a single non-buffered
 * turn against the Agent SDK. Persistence, identity loading, MCP
 * servers, budget context, and system preamble all land in later
 * sub-ACs and will extend this interface in a backward-compatible way.
 */
export interface StreamAgentTurnParams {
  /** Slug of the `.claude/agents/<slug>.md` subagent. Recorded for
   *  observability — the SDK options block in this sub-AC is empty;
   *  later sub-ACs will translate this into `--agent` + MCP loading. */
  slug: string;
  /** Full thread replay (the latest user turn must be the last entry). */
  messages: ChatTurnMessage[];
  /** Optional working directory for the spawned `claude` CLI. */
  cwd?: string;
  /** Abort signal — when fired the underlying Query is closed. */
  signal?: AbortSignal;
  /** Test seam — defaults to the lazy-loaded real Agent SDK runner. */
  runQuery?: AgentSdkRunner;
  /**
   * Auto-injected system preamble (Sub-AC 3 of AC 6).
   *
   * Composed by {@link buildPreamble} + {@link formatPreamble} in
   * `chat-preamble.ts` — a markdown block summarising the agent's
   * weekly plan, recent activity, weekly budget remaining, and ISO-week
   * key. The chat handler passes this **only on the first system turn
   * of each thread** (i.e. when the thread has no prior assistant
   * messages); on subsequent turns the field is omitted so the
   * preamble is not re-sent on every prompt.
   *
   * When non-empty, the runner is invoked with
   * `options.systemPrompt = { type: 'preset', preset: 'claude_code', append: <preamble> }`,
   * which preserves the Claude Code default system prompt + the
   * `agents` registry's per-subagent identity and merely **appends**
   * the situational context. This keeps full tool parity intact (the
   * preset still wires Read / Bash / MCP) while giving the model the
   * same week-1 context the heartbeat already builds when it generates
   * weekly tasks for this agent.
   *
   * Empty string and `undefined` are treated identically — neither
   * sets `systemPrompt`, so the SDK falls back to its default.
   */
  systemPromptAppend?: string;
}

// ── Implementation ───────────────────────────────────────────────────

/**
 * Cached lazy-loaded default runner. The Agent SDK pulls in zod and the
 * MCP SDK at import time, so we defer the cost until the first chat
 * turn fires. Once loaded the runner is cached for the process
 * lifetime — there is no need to re-import on every turn.
 */
let cachedDefaultRunner: AgentSdkRunner | null = null;

/**
 * Resolve the default Agent SDK runner. Tests should NOT rely on this —
 * inject a `runQuery` instead. Production callers use this when they
 * omit `runQuery`.
 */
export async function getDefaultAgentSdkRunner(): Promise<AgentSdkRunner> {
  if (cachedDefaultRunner) return cachedDefaultRunner;
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  cachedDefaultRunner = (params) => sdk.query(params);
  return cachedDefaultRunner;
}

/**
 * Stream a single agent turn end-to-end as `ChatStreamEvent`s.
 *
 * Non-buffering invariant: every `SDKMessage` arriving from the Agent
 * SDK is translated and yielded **immediately**, in the same JS micro-
 * task tick the SDK delivered it on. The implementation is a direct
 * `for await` over the SDK's async iterator, with each branch yielding
 * zero or more `ChatStreamEvent`s synchronously. There is no
 * accumulator, no `Promise.all`, and no "collect then yield" pattern.
 *
 * Termination paths:
 *   - clean: SDK emits a `result` message → we yield `turn-complete`
 *     and the generator returns.
 *   - abort: caller-provided `AbortSignal` fires → we break out of the
 *     iteration and the generator returns silently. The SSE transport
 *     in `server.ts` is responsible for emitting the terminal
 *     `stream-end` frame.
 *   - error: thrown error from the SDK iterator → we yield a
 *     `turn-error` event with the message and return. We never re-throw
 *     past the SSE boundary; once headers are flushed the client
 *     expects a stream, not an HTTP error.
 */
export async function* streamAgentTurn(
  params: StreamAgentTurnParams,
): AsyncGenerator<ChatStreamEvent, void, void> {
  const runner: AgentSdkRunner =
    params.runQuery ?? (await getDefaultAgentSdkRunner());

  // Compose the Agent SDK prompt. In this sub-AC we collapse the thread
  // into the latest user turn; full multi-turn replay via
  // `streamInput`/`AsyncIterable<SDKUserMessage>` lands when the
  // chat-conversation store ships.
  const prompt = formatPromptFromMessages(params.messages);

  // Bail early if the caller already aborted before we started — saves
  // an SDK round-trip on a no-op turn.
  if (params.signal?.aborted) return;

  const options: AgentSdkOptions = {};
  if (params.cwd !== undefined) options.cwd = params.cwd;

  // Bypass tool permission prompts. The dashboard is a single-user
  // surface running against the user's own `.aweek/` directory, and the
  // sibling heartbeat already invokes the Claude Code CLI with
  // `--dangerously-skip-permissions` (see `src/execution/cli-session.ts`)
  // — so gating the chat panel separately would just block `aweek exec`,
  // file reads, and edits with no human in the loop on the SSE stream
  // to approve them. Match the heartbeat posture: trust the agent with
  // the same authority it already has at every 10-min tick.
  options.permissionMode = 'bypassPermissions';
  options.allowDangerouslySkipPermissions = true;

  // Sub-AC 3 of AC 6: auto-inject the system preamble on the first
  // turn of each thread. The chat handler decides when to pass this
  // (first turn only — subsequent turns omit it so the preamble is
  // not re-sent on every prompt). When set, we use the preset+append
  // form so the Claude Code default system prompt + the per-subagent
  // identity loaded via `agents` stay intact and the preamble is
  // simply appended.
  if (
    typeof params.systemPromptAppend === 'string' &&
    params.systemPromptAppend.length > 0
  ) {
    options.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: params.systemPromptAppend,
    };
  }
  // Future sub-ACs add: agents (subagent slug), mcpServers,
  // allowed_tools, can_use_tool, etc.

  const iter = runner({ prompt, options });

  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
  };
  params.signal?.addEventListener('abort', onAbort);

  try {
    for await (const message of iter) {
      if (aborted) break;
      // `yield*` over a synchronous generator preserves the non-buffering
      // contract: each translated event is emitted in the same tick the
      // SDK delivered the source message.
      yield* translateSdkMessage(message);
    }
  } catch (err) {
    yield {
      type: 'turn-error',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    params.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Translate one `SDKMessage` into zero or more `ChatStreamEvent`s.
 *
 * Synchronous on purpose — yielding through a `yield*` inside the
 * caller's `for await` loop preserves the non-buffering guarantee.
 * Unknown message types are silently dropped: the Agent SDK message
 * union covers many internal events (status, hook progress, plugin
 * install, …) that the chat panel does not surface.
 */
function* translateSdkMessage(
  message: SDKMessage,
): Generator<ChatStreamEvent, void, void> {
  switch (message.type) {
    case 'system': {
      // `init` arrives first and lists the agent's tool surface, MCP
      // servers, working dir, and model. Surfacing it lets the panel
      // render an "agent ready" indicator on the first SSE frame after
      // the leading `stream-start`.
      if (message.subtype === 'init') {
        yield {
          type: 'agent-init',
          sessionId: message.session_id,
          tools: message.tools,
          cwd: message.cwd,
        };
      }
      return;
    }

    case 'stream_event': {
      // Partial assistant message — the Agent SDK forwards the raw
      // `BetaRawMessageStreamEvent`. We surface text-deltas so the panel
      // renders tokens as they stream from the model.
      const evt = message.event;
      if (
        evt &&
        (evt as { type?: string }).type === 'content_block_delta' &&
        (evt as { delta?: { type?: string } }).delta?.type === 'text_delta'
      ) {
        const deltaText = (evt as { delta: { text: string } }).delta.text;
        yield {
          type: 'text-delta',
          delta: deltaText,
          messageUuid: message.uuid,
        };
      }
      return;
    }

    case 'assistant': {
      // Full assistant message — surface the canonical structured
      // content so the panel can replace any partial deltas with the
      // final block list. Tool-use blocks within are surfaced
      // separately so the UI can render an inline tool-invocation card
      // before the result arrives.
      const content = message.message.content;
      yield {
        type: 'assistant-message',
        uuid: message.uuid,
        content,
      };
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && (block as { type?: string }).type === 'tool_use') {
            const toolUse = block as {
              id: string;
              name: string;
              input: Record<string, unknown>;
            };
            yield {
              type: 'tool-use',
              toolUseId: toolUse.id,
              name: toolUse.name,
              input: toolUse.input,
              messageUuid: message.uuid,
            };
          }
        }
      }
      return;
    }

    case 'user': {
      // User messages back from the SDK carry tool results during a
      // tool-use cycle (the SDK echoes them so callers can transcribe
      // the full conversation). Forward them so the UI can mark the
      // tool-invocation card as complete.
      const messageContent = (
        message as { message?: { content?: unknown } }
      ).message?.content;
      if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
          if (block && (block as { type?: string }).type === 'tool_result') {
            const tr = block as {
              tool_use_id: string;
              content: unknown;
              is_error?: boolean;
            };
            yield {
              type: 'tool-result',
              toolUseId: tr.tool_use_id,
              content: tr.content,
              isError: !!tr.is_error,
            };
          }
        }
      }
      return;
    }

    case 'result': {
      // Terminal SDK message — carries the canonical token-usage
      // numbers we need to record against the agent's weekly budget. A
      // later sub-AC routes `usage` through `usage-store.recordTokens`
      // so chat and heartbeat draw from the same pool.
      const result = message as {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        duration_ms?: number;
        stop_reason?: string | null;
        total_cost_usd?: number;
      };
      const usage: ChatTokenUsage = {
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
      };
      if (result.usage?.cache_read_input_tokens !== undefined) {
        usage.cacheReadTokens = result.usage.cache_read_input_tokens;
      }
      if (result.usage?.cache_creation_input_tokens !== undefined) {
        usage.cacheCreationTokens = result.usage.cache_creation_input_tokens;
      }
      if (result.total_cost_usd !== undefined) {
        usage.totalCostUsd = result.total_cost_usd;
      }
      yield {
        type: 'turn-complete',
        usage,
        durationMs: result.duration_ms ?? 0,
        stopReason: result.stop_reason ?? null,
      };
      return;
    }

    default:
      // All other SDK message types (status, api_retry, hook_*,
      // task_*, plugin_install, files_persisted, …) are observability
      // events the chat panel does not surface in this sub-AC.
      return;
  }
}

/**
 * Collapse the chat thread into the prompt string for `query()`.
 *
 * Single-turn threads send the user message verbatim. Multi-turn threads
 * render a transcript with explicit role markers so the model has the
 * prior context — without this, every follow-up was a fresh single-shot
 * prompt and the assistant would respond as if it had no memory of the
 * conversation. The trailing "Assistant:" cue tells the model where its
 * reply belongs.
 */
function formatPromptFromMessages(messages: ChatTurnMessage[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const turns = messages.filter(
    (m) => m && typeof m.content === 'string' && m.content.length > 0,
  );
  if (turns.length === 0) return '';
  if (turns.length === 1) {
    const only = turns[0]!;
    if (only.role === 'user') return only.content;
  }

  const transcript = turns
    .map((m) => {
      const label = m.role === 'assistant' ? 'Assistant' : 'User';
      return `${label}: ${m.content}`;
    })
    .join('\n\n');
  return `${transcript}\n\nAssistant:`;
}
