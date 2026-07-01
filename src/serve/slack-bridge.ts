/**
 * Slack run-path bridge — wires a connected `SlackAdapter` to the
 * project-Claude `Backend` factory inside `aweek serve`.
 *
 * Sub-AC 8.2 of the Slack-aweek integration seed: this is the module
 * that takes the WebSocket the {@link startSlackListener} bootstrap
 * already opened and turns inbound Slack messages into project-level
 * Claude turns.
 *
 * **Isolation contract.** The seed contract is explicit that
 *
 *   "Slack runs are an isolated execution surface from the heartbeat
 *    — separate per-Slack-thread lock (NOT the per-agent file lock),
 *    separate usage bucket .aweek/channels/slack/usage.json, no
 *    interaction with weekly-budget pause flag."
 *
 * To enforce that on-disk:
 *
 *   - This module **MUST NOT** import {@link acquireLock} /
 *     {@link releaseLock} from `src/lock/lock-manager.ts`. The
 *     per-Slack-thread serialisation is owned by agentchannels'
 *     {@link StreamingBridge.activeThreads} guard, which already
 *     rejects concurrent messages for the same thread before the
 *     backend is even resolved.
 *   - This module **MUST NOT** import {@link UsageStore} or the
 *     budget enforcer. Per-turn token accounting goes to the Slack
 *     usage bucket via {@link appendSlackUsageRecord}, which writes
 *     `<projectRoot>/.aweek/channels/slack/usage.json` and never
 *     touches `<projectRoot>/.aweek/agents/<slug>/usage/<week>.json`.
 *   - The slack-bridge test suite asserts on both invariants by (a)
 *     statically importing this module's source text and grepping
 *     for the forbidden symbols, and (b) running a vertical-slice
 *     integration that walks a fake message through the bridge and
 *     verifies the per-agent tree (`.aweek/agents/`) is byte-identical
 *     before and after.
 *
 * Architecture:
 *
 * ```
 *   SlackAdapter (connected)
 *     └─ onMessage(ChannelMessage)
 *          └─ StreamingBridge.handleMessage(msg)
 *               ├─ resolveBackend(ctx)  ← cached per-threadKey
 *               │     └─ createPersistedSlackBackend({
 *               │           projectRoot, thread, systemPromptAppend,
 *               │           onResult: (info) => appendSlackUsageRecord(...)
 *               │         })
 *               └─ stream AgentStreamEvent[] back to adapter
 * ```
 *
 * Thread caching: the bridge calls `resolveBackend` on every message,
 * so we cache the backend instance per `threadKey` in a `Map`. This
 * keeps the in-memory `claudeSessionId` warm across turns within a
 * single `aweek serve` lifetime — disk persistence is the recovery
 * path on restart, not the per-message path.
 *
 * @module serve/slack-bridge
 */

import {
  StreamingBridge,
  type Backend,
  type ChannelAdapter,
  type ChannelMessage,
  type ResolveBackendHook,
  type ThreadContext,
} from 'agentchannels';

import {
  createPersistedSlackBackend,
  type CreatePersistedSlackBackendOptions,
} from '../channels/slack/backend-factory.js';
import {
  createRunnerSlackBackend,
  type CreateRunnerSlackBackendOptions,
  type RunnerBackendKind,
} from '../channels/slack/project-runner-backend.js';
import { loadConfig } from '../storage/config-store.js';
import { DEFAULT_RUNNER, resolveRunner, type RunnerKind } from '../execution/runner.js';
import {
  appendSlackUsageRecord,
  createSlackUsageRecord,
  type SlackUsageRecord,
} from '../storage/slack-usage-store.js';
import {
  loadReportThread,
  type SlackReportThreadRecord,
} from '../storage/slack-report-thread-store.js';
import type { ResultInfo, SystemInitInfo } from './slack-stream-event-parser.js';

// ── Constants ────────────────────────────────────────────────────────

/**
 * Default `--append-system-prompt` banner injected on every Slack-driven
 * Claude turn. The seed contract requires a "conversational human chat,
 * not task reports" banner so Slack replies don't read like heartbeat
 * task summaries.
 *
 * Test seams (`SlackBridgeOptions.systemPromptAppend`) can override this,
 * but production callers should leave it alone.
 */
export const SLACK_SYSTEM_PROMPT_BANNER =
  'You are chatting with a human in Slack. Reply conversationally — keep replies short, direct, friendly, and human. Do NOT format replies as task reports, weekly-plan summaries, or status updates. This is human chat, not heartbeat output.';

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Backend factory signature compatible with
 * {@link createPersistedSlackBackend}. Carried as a named type so the
 * test seam in {@link SlackBridgeOptions} is self-documenting.
 */
export type CreateSlackBackendFn = (
  opts: CreatePersistedSlackBackendOptions,
) => Promise<Backend>;

/**
 * Backend factory signature for the non-Claude runners, compatible with
 * {@link createRunnerSlackBackend}. Selected by the bridge when
 * `.aweek/config.json` `runner` resolves to `'gemini'` / `'hermes'`.
 */
export type CreateRunnerSlackBackendFn = (
  opts: CreateRunnerSlackBackendOptions,
) => Promise<Backend>;

/**
 * Usage-bucket recorder signature. Defaults to
 * {@link appendSlackUsageRecord}; tests pin a sink that records calls
 * without touching the disk so the assertion that the per-agent tree
 * is unchanged stays self-contained.
 */
export type SlackUsageRecorder = (
  dataDir: string,
  record: SlackUsageRecord,
) => Promise<unknown>;

/**
 * Loader signature compatible with {@link loadReportThread}. Tests pin
 * a stub that returns a canned record without touching the disk so the
 * banner-composition vertical-slice can be asserted in-memory.
 */
export type SlackReportThreadLoader = (
  dataDir: string,
  threadKey: string,
) => Promise<SlackReportThreadRecord | null>;

/**
 * Compose the first-turn system-prompt-append banner that surfaces an
 * earlier `aweek report` to the project Claude when the CEO replies in
 * that thread. The text is shaped so Claude (a) knows the message is
 * a reply to a specific report rather than a cold-start chat, (b)
 * has the original title / body / source-task ID in context, and (c)
 * understands the agent slug for the case where the user asks to push
 * changes back to that agent — but is explicitly told to speak AS
 * project Claude, not impersonating the agent.
 *
 * Exported so the colocated tests can pin the rendered shape and the
 * report-skill side can stay aligned with the bridge-side renderer
 * without duplicating the format.
 */
export function buildReportContextBanner(
  record: SlackReportThreadRecord,
): string {
  const lines = [
    'This Slack thread started with an `aweek report` posted by one of the project\'s agents — the user is replying to that report, NOT starting a cold conversation. Original report context:',
    '',
    `Agent: ${record.senderSlug}`,
    `Kind: ${record.kind}`,
    `Title: ${record.title}`,
    'Body:',
    record.body,
  ];
  if (record.sourceTaskId) {
    lines.push('', `Source task: ${record.sourceTaskId}`);
  }
  lines.push(
    '',
    'You are project Claude responding to the user. DO NOT impersonate the agent. If the user asks for changes to the agent\'s plan, dispatch back via `Task()` or `aweek exec` rather than speaking in the agent\'s voice.',
  );
  return lines.join('\n');
}

/** Options accepted by {@link startSlackBridge}. */
export interface SlackBridgeOptions {
  /**
   * Connected `ChannelAdapter` returned by {@link startSlackListener}.
   * The bridge calls `adapter.onMessage(...)` immediately, so the
   * adapter MUST already be connected when this function is invoked.
   */
  adapter: ChannelAdapter;
  /** Absolute path to the project root (parent of `.aweek`). */
  projectRoot: string;
  /**
   * Absolute path to `<projectRoot>/.aweek/agents` — the calling
   * convention every other store in the codebase accepts. The bridge
   * passes this through to {@link appendSlackUsageRecord}, which
   * writes one level up at `.aweek/channels/slack/usage.json`.
   */
  dataDir: string;
  /**
   * Optional override of the {@link SLACK_SYSTEM_PROMPT_BANNER}
   * appended via `--append-system-prompt`. Production callers should
   * leave this unset.
   */
  systemPromptAppend?: string;
  /**
   * Test seam — override the Claude backend factory. When set, it is used
   * for EVERY thread regardless of `config.runner` (so existing
   * Claude-path tests stay runner-agnostic).
   */
  createBackend?: CreateSlackBackendFn;
  /**
   * Test seam — override the Gemini / Hermes backend factory. Used only
   * when `config.runner` resolves to a non-Claude runner AND `createBackend`
   * is not set. Production callers leave this unset.
   */
  createRunnerBackend?: CreateRunnerSlackBackendFn;
  /**
   * Test seam — force the resolved runner instead of reading
   * `.aweek/config.json`. Production callers leave this unset; the bridge
   * then resolves the project-wide `runner` via `loadConfig`.
   */
  resolveRunnerKind?: () => Promise<RunnerKind> | RunnerKind;
  /** Test seam — override the usage recorder. */
  recordUsage?: SlackUsageRecorder;
  /**
   * Test seam — override the report-thread loader. Defaults to
   * {@link loadReportThread}. Production callers leave this unset.
   */
  loadReportThreadFn?: SlackReportThreadLoader;
  /**
   * Logger sink for the bridge's status / warning lines. Defaults to
   * stderr so the messages appear alongside the existing `aweek serve`
   * console output. Tests pin a `string[]` sink and assert on its
   * contents.
   */
  log?: (message: string) => void;
}

/** Handle returned by {@link startSlackBridge}. */
export interface SlackBridgeHandle {
  /** The constructed `StreamingBridge`. Exposed for diagnostics / tests. */
  bridge: StreamingBridge;
  /**
   * Per-`threadKey` backend cache. Read-only view exposed for
   * diagnostics / tests; the bridge owns the mutation surface.
   */
  backends: ReadonlyMap<string, Backend>;
  /**
   * Tear down: aborts every in-flight bridge message and disposes
   * cached backends. Idempotent and never throws — it's safe to call
   * from the `aweek serve` shutdown path even if the bridge already
   * fell over.
   */
  shutdown: () => Promise<void>;
}

// ── Implementation ────────────────────────────────────────────────────

/** Default logger: write a `\n`-terminated line to stderr. */
function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Stringify an unknown thrown value for the single-line log messages.
 * Prefers `Error.message` so the user sees the actionable detail
 * without a stack trace.
 */
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'Error';
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Build a {@link SlackUsageRecord} from the CLI's terminal `result`
 * line plus the model captured from the leading `system init` line.
 * The model is opportunistic — if the CLI never emits an init line
 * (extremely rare; only happens on a dead-on-arrival spawn) the record
 * simply omits the `model` field.
 */
export function buildSlackUsageRecord(opts: {
  threadKey: string;
  result: ResultInfo;
  /** Model captured from `onSessionInit`; passed through verbatim. */
  model?: string;
}): SlackUsageRecord {
  const { threadKey, result, model } = opts;
  const usage = result.usage;

  const recordOpts: Parameters<typeof createSlackUsageRecord>[0] = {
    threadKey,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    success: !result.isError,
  };
  if (usage.cacheReadTokens !== undefined) {
    recordOpts.cacheReadTokens = usage.cacheReadTokens;
  }
  if (usage.cacheCreationTokens !== undefined) {
    recordOpts.cacheCreationTokens = usage.cacheCreationTokens;
  }
  if (usage.totalCostUsd !== undefined) {
    recordOpts.costUsd = usage.totalCostUsd;
  }
  if (result.durationMs !== undefined) {
    recordOpts.durationMs = result.durationMs;
  }
  if (result.stopReason !== undefined) {
    recordOpts.stopReason = result.stopReason;
  }
  if (model !== undefined && model.length > 0) {
    recordOpts.model = model;
  }
  return createSlackUsageRecord(recordOpts);
}

/**
 * Wire the Slack run path on top of an already-connected
 * {@link ChannelAdapter}.
 *
 * Lifecycle:
 *
 *   1. Construct a per-thread backend cache keyed by `threadKey`.
 *   2. Build a {@link StreamingBridge} with a `resolveBackend` hook
 *      that reads from the cache and falls back to
 *      {@link createPersistedSlackBackend} on first use. The factory
 *      wires `onResult` to {@link appendSlackUsageRecord} so the
 *      Slack-only usage bucket is the SOLE accounting surface.
 *   3. Subscribe to inbound messages via `adapter.onMessage` and
 *      forward them to `bridge.handleMessage`. The bridge's internal
 *      `activeThreads` map serialises messages within the same Slack
 *      thread, which is the per-Slack-thread "lock" the seed contract
 *      mandates — separate from the per-agent heartbeat lock.
 *
 * Returns synchronously: the bridge is ready to receive messages
 * immediately. The returned `shutdown()` aborts in-flight processing
 * and disposes cached backends.
 */
export function startSlackBridge(opts: SlackBridgeOptions): SlackBridgeHandle {
  if (!opts) throw new TypeError('startSlackBridge: opts is required');
  if (!opts.adapter) throw new TypeError('startSlackBridge: opts.adapter is required');
  if (!opts.projectRoot) throw new TypeError('startSlackBridge: opts.projectRoot is required');
  if (!opts.dataDir) throw new TypeError('startSlackBridge: opts.dataDir is required');

  const log = opts.log ?? defaultLog;
  const createBackend: CreateSlackBackendFn =
    opts.createBackend ?? (createPersistedSlackBackend as CreateSlackBackendFn);
  const createRunnerBackend: CreateRunnerSlackBackendFn =
    opts.createRunnerBackend ?? (createRunnerSlackBackend as CreateRunnerSlackBackendFn);
  // Resolve the project-wide Slack runner. Slack is project-level (no
  // per-agent subagent), so only the `.aweek/config.json` `runner`
  // applies. Read per thread-creation (cached with the backend) so a
  // config edit is picked up by new threads without an `aweek serve`
  // restart. Best-effort — a missing/corrupt config falls back to Claude.
  const resolveRunnerKind =
    opts.resolveRunnerKind ??
    (async (): Promise<RunnerKind> => {
      try {
        return resolveRunner(undefined, (await loadConfig(opts.dataDir)).runner);
      } catch {
        return DEFAULT_RUNNER;
      }
    });
  const recordUsage: SlackUsageRecorder =
    opts.recordUsage ?? (appendSlackUsageRecord as SlackUsageRecorder);
  const loadReportThreadFn: SlackReportThreadLoader =
    opts.loadReportThreadFn ?? (loadReportThread as SlackReportThreadLoader);
  const systemPromptAppend = opts.systemPromptAppend ?? SLACK_SYSTEM_PROMPT_BANNER;

  // Per-thread cache. The bridge calls `resolveBackend` on every
  // message; we cache so the in-memory `claudeSessionId` is reused
  // across turns within the same thread without re-reading the disk
  // record on every turn. Disk is the rehydration path on restart.
  const backends = new Map<string, Backend>();

  const resolveBackend: ResolveBackendHook = async (ctx: ThreadContext) => {
    const cached = backends.get(ctx.threadKey);
    if (cached) return cached;

    const factoryOpts: CreatePersistedSlackBackendOptions = {
      projectRoot: opts.projectRoot,
      thread: ctx,
      systemPromptAppend,
      // First-turn report-context injection. The factory only invokes
      // this callback when there is no existing slack-thread-store
      // record for this threadKey (i.e., the FIRST Claude spawn for
      // this Slack thread in the current process — either a brand-new
      // thread or one whose chat-session TTL has expired). When no
      // matching `aweek report` exists, this returns `null` and the
      // factory falls back to the conversational-banner-only path.
      loadFirstTurnSystemPromptAppend: async (): Promise<string | null> => {
        try {
          const record = await loadReportThreadFn(opts.dataDir, ctx.threadKey);
          if (!record) return null;
          return buildReportContextBanner(record);
        } catch (err) {
          log(
            `aweek: Slack report-thread lookup failed for ${ctx.threadKey} (${formatError(err)})`,
          );
          return null;
        }
      },
      onResult: (info: ResultInfo) => {
        // Slack-only usage accounting. The factory wires this through
        // to the backend's `onResult` callback, which fires once per
        // turn when the CLI emits its terminal `result` line.
        //
        // Failures are best-effort: a usage-bucket I/O hiccup must
        // not poison the user-visible reply. The bridge has already
        // streamed the response by the time we get here.
        //
        // Note: the CLI's `result` line does NOT carry the model name
        // (the model is on the leading `system init` line that the
        // factory consumes for thread-store persistence). We omit the
        // `model` field on the Slack usage record for v1 — it's
        // optional on the on-disk shape and threading a second hook
        // through the factory is out of scope for the isolation AC.
        let record: SlackUsageRecord;
        try {
          record = buildSlackUsageRecord({
            threadKey: ctx.threadKey,
            result: info,
          });
        } catch (err) {
          log(
            `aweek: Slack usage record build failed for ${ctx.threadKey} (${formatError(err)})`,
          );
          return;
        }
        // Fire-and-forget. The recorder writes to
        // `.aweek/channels/slack/usage.json` (NOT the per-agent
        // `.aweek/agents/<slug>/usage/...` tree). Async errors are
        // logged once and dropped — they cannot poison the in-flight
        // Slack reply, which has already been delivered.
        Promise.resolve(recordUsage(opts.dataDir, record)).catch((err: unknown) => {
          log(
            `aweek: Slack usage append failed for ${ctx.threadKey} (${formatError(err)})`,
          );
        });
      },
    };

    // Runner dispatch. An explicit `createBackend` test override forces the
    // Claude path (runner-agnostic); otherwise the project-wide config
    // runner decides. `claude` → the Claude Code backend; `gemini` /
    // `hermes` → the runner backend (spawns that CLI, keeps memory via the
    // transcript store). The `factoryOpts` shape is shared by both
    // factories — the runner factory just also takes the `runner` kind.
    const runner: RunnerKind = opts.createBackend
      ? 'claude'
      : await resolveRunnerKind();

    let backend: Backend;
    if (runner === 'gemini' || runner === 'hermes') {
      backend = await createRunnerBackend({
        ...factoryOpts,
        runner: runner as RunnerBackendKind,
      });
    } else {
      backend = await createBackend(factoryOpts);
    }
    backends.set(ctx.threadKey, backend);
    return backend;
  };

  const bridge = new StreamingBridge({
    adapter: opts.adapter,
    resolveBackend,
  });

  // Wire inbound messages → bridge. The handler MUST be `async` and
  // the adapter contractually swallows handler errors (see
  // `MessageHandler` in agentchannels), but we still wrap in a
  // try/catch so a bug in the bridge surfaces in our log instead of
  // disappearing into the Bolt runtime.
  opts.adapter.onMessage(async (msg: ChannelMessage) => {
    try {
      await bridge.handleMessage(msg);
    } catch (err) {
      log(
        `aweek: Slack bridge handleMessage failed for ${msg.channelId}:${msg.threadId} (${formatError(err)})`,
      );
    }
  });

  log('aweek: Slack bridge wired (project-claude backend, isolated usage bucket)');

  return {
    bridge,
    backends,
    shutdown: async () => {
      // Step 1: abort every in-flight message. The bridge's internal
      // AbortControllers fire, the backend AbortControllers fire, the
      // child `claude` processes get SIGTERM. Idempotent.
      bridge.abortAll();
      // Step 2: dispose cached backends. Each backend's `dispose()` is
      // a no-op once the in-flight call has been aborted, but we call
      // it for symmetry and for the test that asserts shutdown is
      // observable.
      const entries = Array.from(backends.values());
      backends.clear();
      for (const backend of entries) {
        try {
          await backend.dispose?.();
        } catch (err) {
          log(`aweek: Slack bridge backend dispose warning (${formatError(err)})`);
        }
      }
    },
  };
}

// Re-exports for convenient consumer wiring (mostly used by tests so
// they can pass a fake `recordUsage` of the right shape without
// importing from `../storage/slack-usage-store.js` separately).
export type { SlackUsageRecord } from '../storage/slack-usage-store.js';
export { appendSlackUsageRecord, createSlackUsageRecord } from '../storage/slack-usage-store.js';

// Surface the parser metadata types so the `onResult` hook signature
// stays self-documenting from a single import.
export type { ResultInfo, SystemInitInfo };
