/**
 * ProjectClaudeBackend — per-Slack-thread Backend implementation that
 * proxies project-level Claude through the Claude Code CLI.
 *
 * Wires three pieces together:
 *
 *   1. {@link spawnProjectClaudeSession} (sub-AC 4.2) — spawns
 *      `claude --print --output-format stream-json --verbose
 *      --dangerously-skip-permissions [--resume <id>]
 *      [--append-system-prompt <banner>]` in the project root, pipes
 *      the user's Slack message to stdin, and emits one NDJSON line per
 *      stream-json event via `onStdoutLine`.
 *
 *   2. {@link StreamEventQueue} (sub-AC 4.3) — adapts the synchronous
 *      stdout-line callback into a backpressure-safe
 *      `AsyncIterable<AgentStreamEvent>`. The queue's `onSessionInit`
 *      hook captures the CLI session id assigned on the first turn so
 *      subsequent turns reuse it via `--resume`. The `onResult` hook
 *      surfaces the terminal token-usage breakdown for the Slack usage
 *      bucket (`.aweek/channels/slack/usage.json`); persistence itself
 *      lives in the factory layer that owns this backend instance.
 *
 *   3. The agentchannels {@link Backend} contract — `sendMessage`
 *      returns an `AsyncIterable<AgentStreamEvent>` that MUST terminate
 *      with `done` or `error`; `abort()` cancels in-flight work; the
 *      optional `dispose()` releases per-instance resources.
 *
 * Design notes:
 *
 *   - One Backend instance per Slack thread, reused across messages.
 *     The instance owns the `claudeSessionId` so `--resume` works.
 *   - This is the v1 "project-level proxy" backend. Subagent identities
 *     (researcher, marketer-sam, …) are NOT directly addressable from
 *     Slack; project Claude reaches them transitively via Task() under
 *     `bypassPermissions`. A v2+ per-subagent backend kind is reserved
 *     but not implemented here.
 *   - `backend_kind` is the literal `"project-claude"` — single backend
 *     kind in v1; reserved for future per-subagent backends.
 *   - The Slack execution surface is intentionally isolated from the
 *     heartbeat: a separate per-Slack-thread lock, a separate
 *     `.aweek/channels/slack/usage.json` bucket, and no interaction with
 *     the weekly-budget pause flag. This module never touches the
 *     per-agent `.aweek/agents/<slug>/` data.
 *
 * @module channels/slack/project-claude-backend
 */

import type {
  AgentStreamEvent,
  Backend,
  BackendSendOptions,
  ThreadContext,
} from 'agentchannels';

import {
  spawnProjectClaudeSession,
  type SpawnFn,
  type SpawnProjectClaudeSessionResult,
} from '../../execution/cli-session.js';
import {
  StreamEventQueue,
  type ResultInfo,
  type SystemInitInfo,
} from '../../serve/slack-stream-event-parser.js';

/**
 * Backend kind discriminator. v1 only emits `"project-claude"`. Reserved
 * as a string literal so a future per-subagent backend can extend the
 * union without breaking on-disk records.
 */
export type BackendKind = 'project-claude';

/**
 * Callback fired once per turn when the CLI emits its `system` `init`
 * line and assigns / confirms a session id. The factory layer mirrors
 * the assigned id to `.aweek/channels/slack/threads/<threadKey>.json`
 * so subsequent turns can reuse it via `--resume`.
 */
export type OnSessionInitCallback = (info: SystemInitInfo) => void;

/**
 * Callback fired once per turn when the CLI emits its terminal
 * `result` line. Carries the token-usage breakdown that the Slack
 * usage bucket (`.aweek/channels/slack/usage.json`) records. Wired by
 * the factory layer; the backend itself does not write usage records.
 */
export type OnResultCallback = (info: ResultInfo) => void;

/**
 * Constructor options for `ProjectClaudeBackend`.
 *
 * `projectRoot` is the absolute path of the aweek project directory
 * (the same path passed to `aweek serve --project-dir`). The backend
 * uses it as the CLI working directory and as the parent of
 * `.aweek/channels/slack/` for thread persistence and usage accounting.
 */
export interface ProjectClaudeBackendOptions {
  /** Absolute path of the aweek project root. */
  projectRoot: string;
  /** Stable agentchannels thread context for this backend instance. */
  thread: ThreadContext;
  /**
   * Optional resume token — the Claude Code CLI session id assigned on
   * the first turn. When set on construction, the backend is
   * rehydrating a prior thread and will pass `--resume <sessionId>` on
   * the next `sendMessage` call.
   */
  claudeSessionId?: string;
  /**
   * Optional Slack-mode banner appended to the project Claude system
   * prompt via `--append-system-prompt`. The seed contract requires a
   * "conversational human chat, not task reports" banner so Slack
   * replies don't read like heartbeat task summaries. Construction
   * leaves this optional so unit tests can omit it without affecting
   * argv shape.
   */
  systemPromptAppend?: string;
  /**
   * Optional callback invoked when the CLI assigns / confirms a
   * session id. The factory layer wires this to the thread store so
   * the assigned id is persisted to
   * `.aweek/channels/slack/threads/<threadKey>.json`.
   */
  onSessionInit?: OnSessionInitCallback;
  /**
   * Optional callback invoked when the CLI emits its terminal
   * `result` line. The factory layer wires this to the Slack usage
   * bucket (`.aweek/channels/slack/usage.json`).
   */
  onResult?: OnResultCallback;
  /**
   * Test seam — inject a fake `node:child_process` `spawn` function.
   * Production callers leave this `undefined` so the spawn helper
   * uses the real `nodeSpawn`.
   */
  spawnFn?: SpawnFn;
  /** Test seam — override the CLI binary name (default `'claude'`). */
  cli?: string;
}

/**
 * Per-Slack-thread Backend that proxies a project-level Claude Code
 * session.
 *
 * Implements the agentchannels `Backend` contract:
 *   - `sendMessage(text)` returns an `AsyncIterable<AgentStreamEvent>`
 *     and MUST terminate with either a `done` or `error` event.
 *   - `abort()` cancels any in-flight `sendMessage`. Idempotent.
 *   - Optional `dispose()` releases per-instance resources.
 */
export class ProjectClaudeBackend implements Backend {
  /** Backend kind discriminator (v1: always `"project-claude"`). */
  readonly kind: BackendKind = 'project-claude';

  /** Absolute path of the aweek project root. */
  readonly projectRoot: string;

  /** Stable thread identity supplied by agentchannels. */
  readonly thread: ThreadContext;

  /**
   * Claude Code CLI session id, assigned on the first turn and reused
   * via `--resume` on subsequent turns. `undefined` until the first
   * `system` `init` line lands. Persisted to
   * `.aweek/channels/slack/threads/<threadKey>.json` by the backend
   * factory; this field is the in-memory mirror.
   */
  protected claudeSessionId: string | undefined;

  /**
   * AbortController shared across the in-flight `sendMessage` call so
   * `abort()` can cancel both the outer iterable and the underlying
   * `spawnProjectClaudeSession` child process.
   */
  protected currentAbort: AbortController | undefined;

  /** Slack-mode banner appended via `--append-system-prompt`. */
  protected readonly systemPromptAppend: string | undefined;

  /** Wired thread-store hook (sees system init lines). */
  protected readonly onSessionInit: OnSessionInitCallback | undefined;

  /** Wired usage-bucket hook (sees terminal result lines). */
  protected readonly onResult: OnResultCallback | undefined;

  /** Injectable spawn function (test seam). */
  protected readonly spawnFn: SpawnFn | undefined;

  /** Optional CLI binary override (test seam). */
  protected readonly cli: string | undefined;

  constructor(opts: ProjectClaudeBackendOptions) {
    if (!opts) throw new Error('ProjectClaudeBackend: opts is required');
    if (!opts.projectRoot) {
      throw new Error('ProjectClaudeBackend: projectRoot is required');
    }
    if (!opts.thread) {
      throw new Error('ProjectClaudeBackend: thread is required');
    }
    this.projectRoot = opts.projectRoot;
    this.thread = opts.thread;
    this.claudeSessionId = opts.claudeSessionId;
    this.systemPromptAppend = opts.systemPromptAppend;
    this.onSessionInit = opts.onSessionInit;
    this.onResult = opts.onResult;
    this.spawnFn = opts.spawnFn;
    this.cli = opts.cli;
  }

  /**
   * Send a user message and stream the project-level Claude response.
   *
   * Lifecycle:
   *   1. Build a per-call AbortController, wire any caller-supplied
   *      `options.signal` into it, and store it on `currentAbort` so
   *      `abort()` / `dispose()` can fire it.
   *   2. Build a {@link StreamEventQueue} with `onSessionInit` /
   *      `onResult` hooks. The session-id hook updates this instance's
   *      `claudeSessionId` (so the next turn can `--resume`) AND
   *      forwards to the factory-supplied callback if any.
   *   3. Kick off {@link spawnProjectClaudeSession} in the background
   *      with `onStdoutLine: queue.push`. The spawn promise drives
   *      queue termination — clean exit calls `queue.end()` (which
   *      synthesises a `done` if the CLI failed to emit a terminal
   *      `result`); abort calls `queue.fail(...)`; non-zero exit calls
   *      `queue.fail(...)` with the buffered stderr.
   *   4. Return an async generator that drains the queue. The queue
   *      auto-terminates on the first `done` / `error` event a pushed
   *      line emits, so the consumer's `for await` exits cleanly even
   *      if the spawn promise is still in flight.
   */
  sendMessage(
    text: string,
    options?: BackendSendOptions,
  ): AsyncIterable<AgentStreamEvent> {
    if (typeof text !== 'string') {
      throw new Error(
        'ProjectClaudeBackend.sendMessage: text must be a string',
      );
    }

    // Per-call abort controller — `abort()` flips it, the spawn helper
    // listens on its `.signal`, and the generator's `finally` clears
    // `currentAbort` so a stale controller can never linger past the
    // call that created it.
    const controller = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener('abort', () => controller.abort(), {
          once: true,
        });
      }
    }
    this.currentAbort = controller;

    const self = this;
    const queue = new StreamEventQueue({
      onSessionInit: (info) => {
        // Capture the assigned session id so the next turn can
        // `--resume`. The factory hook is invoked AFTER the in-memory
        // mirror is updated so persistence sees the same value the
        // backend will pass next turn.
        if (info.sessionId && info.sessionId.length > 0) {
          self.claudeSessionId = info.sessionId;
        }
        if (self.onSessionInit) {
          try {
            self.onSessionInit(info);
          } catch {
            // Persistence failures are best-effort — never let a
            // factory hook poison the in-flight stream.
          }
        }
      },
      onResult: (info) => {
        if (self.onResult) {
          try {
            self.onResult(info);
          } catch {
            // Same reasoning — usage-bucket failures are best-effort.
          }
        }
      },
    });

    // Spawn the CLI in the background and route exit / abort / failure
    // into the queue's terminal events. The spawn helper resolves
    // `killed: true` on abort (does NOT reject), so the outer
    // generator can rely on a single settle path.
    const spawnPromise: Promise<SpawnProjectClaudeSessionResult> =
      spawnProjectClaudeSession({
        cwd: this.projectRoot,
        prompt: text,
        cli: this.cli,
        spawnFn: this.spawnFn,
        signal: controller.signal,
        resumeSessionId: this.claudeSessionId,
        systemPromptAppend: this.systemPromptAppend,
        onStdoutLine: (line) => queue.push(line),
      });

    spawnPromise.then(
      (result) => {
        if (result.killed) {
          // Aborted mid-flight — synthesise an error so the consumer
          // sees a terminal event rather than a silently-truncated
          // stream. If the queue already terminated cleanly (rare:
          // the result line landed before the SIGTERM took effect),
          // `fail()` is a no-op.
          queue.fail(new Error('aborted'));
          return;
        }
        if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
          const stderr = result.stderr ? result.stderr.trim() : '';
          const message = stderr
            ? `CLI exited with code ${result.exitCode}: ${stderr}`
            : `CLI exited with code ${result.exitCode}`;
          queue.fail(new Error(message));
          return;
        }
        // Clean exit. If the CLI emitted a terminal `result` line, the
        // queue already terminated; `end()` is idempotent. If it did
        // NOT (rare — process exited without a result), `end()`
        // synthesises a `done` so the consumer exits cleanly.
        queue.end();
      },
      (err) => {
        queue.fail(err);
      },
    );

    async function* outer(): AsyncGenerator<AgentStreamEvent> {
      try {
        for await (const evt of queue) {
          yield evt;
        }
        // Wait for the spawn promise to settle so any stray rejection
        // surfaces (and is swallowed by the queue's `fail()` path).
        // We never let the spawn promise reject the generator —
        // terminal failures already became `error` events.
        await spawnPromise.catch(() => undefined);
      } finally {
        if (self.currentAbort === controller) {
          self.currentAbort = undefined;
        }
      }
    }

    return outer();
  }

  /**
   * Cancel the currently in-flight `sendMessage`. Idempotent — calling
   * `abort()` with no in-flight call (or after the call has already
   * settled) is a no-op.
   */
  abort(): void {
    const controller = this.currentAbort;
    if (!controller) return;
    try {
      controller.abort();
    } finally {
      // Leave `currentAbort` in place so the generator's `finally`
      // block can clear it; `abort()` only flips the signal.
    }
  }

  /**
   * Release per-instance resources. v1 has nothing to clean up beyond
   * the AbortController — the spawn helper owns no persistent state
   * once `spawnPromise` settles, and persistence is owned by the
   * factory. Calling `dispose()` after `abort()` is safe and
   * idempotent.
   */
  async dispose(): Promise<void> {
    this.abort();
  }

  /**
   * Read-only accessor for the current Claude Code session id. Returns
   * `undefined` until the first turn assigns one. Exposed primarily for
   * tests and for the persistence layer that mirrors this value to
   * `.aweek/channels/slack/threads/<threadKey>.json`.
   */
  getClaudeSessionId(): string | undefined {
    return this.claudeSessionId;
  }
}
