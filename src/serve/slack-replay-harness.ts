/**
 * Replay-driven integration test harness for the Slack-aweek run path.
 *
 * Sub-AC 11.1 of the Slack-aweek integration seed: this module is the
 * shared scaffold that every replay-driven Slack integration test
 * imports. It wires three deterministic test doubles together so a
 * sibling test can exercise the entire Slack run path WITHOUT a live
 * Slack workspace, a real Claude Code CLI, or an Anthropic API key:
 *
 *   1. **{@link ReplayBackend}** — an agentchannels `Backend` stub
 *      that emits a pre-recorded `AgentStreamEvent[]` deterministically.
 *      Mirrors the `replay-agent-client.ts` helper used inside
 *      agentchannels' own e2e suite. Reproduced locally because the
 *      published agentchannels public surface (`dist/index.js`) only
 *      ships runtime code — the e2e helper modules are not part of the
 *      published API.
 *
 *      ReplayBackend is the right choice when the test wants to bypass
 *      the entire CLI / persistence stack and assert against the
 *      agentchannels `StreamingBridge` contract in isolation.
 *
 *   2. **{@link makeFakeSlackAdapterSource}** — a `ChannelAdapter` test
 *      double that lets a test push synthetic inbound Slack messages
 *      and capture every `startStream` / `append` / `finish` /
 *      `setStatus` call the bridge makes downstream. The shape mirrors
 *      `makeFakeAdapter` inside `slack-bridge.test.ts` but is extracted
 *      so the existing per-module unit tests AND the new replay-driven
 *      integration tests can share one source of truth for "what does a
 *      fake Slack adapter look like".
 *
 *   3. **{@link makeFakeCliSink}** — an injectable `SpawnFn` that
 *      pretends to be the `claude` binary. It accepts a canned
 *      stream-json NDJSON sequence on construction and feeds it through
 *      a real `Readable` so the production readline pipeline inside
 *      `spawnProjectClaudeSession` is exercised end-to-end.
 *
 *      The fake CLI sink is the right choice when the test wants to
 *      drive the real `ProjectClaudeBackend` (and therefore the real
 *      `createPersistedSlackBackend` factory + `slack-thread-store`
 *      side effects) without spawning a real `claude` process. It is
 *      what the seed contract's "replay-driven integration test
 *      demonstrates streamed reply + on-disk thread persistence in one
 *      cycle" exit-condition test will use to assert on the
 *      `.aweek/channels/slack/threads/<threadKey>.json` mutation.
 *
 * Design boundaries:
 *
 *   - This module is shipped under `src/serve/` (not under a separate
 *     `tests/` tree) because aweek's `pnpm test` glob already picks up
 *     every `src/**` `*.test.ts` file. Keeping the harness colocated
 *     with the modules it tests means we never have to touch the
 *     test-runner glob, and the harness is import-discoverable from
 *     any future Slack-channel test.
 *
 *   - The harness depends only on the agentchannels public surface
 *     (`Backend`, `ChannelAdapter`, `ChannelMessage`, etc.) and on
 *     Node's built-in `node:child_process` / `node:stream` shapes. No
 *     deep imports, no fixture files. Subsequent sub-ACs that record
 *     cassettes can layer fixture I/O on top without touching this
 *     module.
 *
 *   - Nothing in this module touches the disk, the per-agent heartbeat
 *     lock, or the per-agent usage tree. The Sub-AC 8 isolation
 *     contract is preserved by construction: ReplayBackend never spawns
 *     a process, makeFakeCliSink only emits the lines the test seeded,
 *     and the fake adapter has no real Slack `WebClient`.
 *
 * @module serve/slack-replay-harness
 */

import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import type {
  AgentStreamEvent,
  Backend,
  BackendSendOptions,
  ChannelAdapter,
  ChannelMessage,
  StreamHandle,
  ThreadContext,
} from 'agentchannels';

import type { SpawnFn } from '../execution/cli-session.js';

// ── ReplayBackend ────────────────────────────────────────────────────

/**
 * A deterministic `Backend` that emits a canned
 * `AgentStreamEvent[]` sequence and ignores the user's prompt.
 *
 * Mirrors the `ReplayBackend` exposed by agentchannels' own e2e harness
 * (`tests/e2e/helpers/replay-agent-client.ts`). The contract is
 * intentionally narrow:
 *
 *   - `sendMessage` ALWAYS yields the same canned events, in order.
 *   - The terminal event in the canned array MUST be `{ type: 'done' }`
 *     or `{ type: 'error', error: '...' }`; the agentchannels
 *     `StreamingBridge` requires a terminal event to settle the run.
 *     The `ReplayBackend` does not synthesise one — feed a complete
 *     sequence in.
 *   - `abort()` flips a flag that causes the next yield to emit a
 *     synthetic `error` event and terminate the iterable.
 *   - `dispose()` is a no-op: there is no real resource to release.
 *
 * Construction options:
 *
 *   - `events` — the canned stream. Pass an empty array for a
 *     no-events drill (the bridge will fall back to its empty-response
 *     handling).
 *   - `sessionId` — exposed as a public field on the instance so
 *     replay-driven tests can assert against the same id the cassette
 *     was recorded with (no functional effect).
 *
 * Usage:
 *
 * ```ts
 * const backend = new ReplayBackend({
 *   sessionId: 'sess_replay_001',
 *   events: [
 *     { type: 'text_delta', text: 'Hi from replay!' },
 *     { type: 'done' },
 *   ],
 * });
 * await bridge.handleMessage(msg, { resolveBackend: async () => backend });
 * ```
 */
export class ReplayBackend implements Backend {
  /**
   * The "session ID" associated with the canned event stream. Carried
   * verbatim from the cassette so replay-driven tests can assert that
   * downstream observers (e.g. the slack-thread-store) see the same id
   * as the cassette recording phase.
   *
   * Read-only; does not affect event emission.
   */
  readonly sessionId: string;

  private readonly events: readonly AgentStreamEvent[];
  private aborted = false;

  constructor(opts: ReplayBackendOptions) {
    if (!opts) throw new TypeError('ReplayBackend: opts is required');
    if (!Array.isArray(opts.events)) {
      throw new TypeError('ReplayBackend: opts.events must be an array');
    }
    this.sessionId = opts.sessionId ?? 'sess_replay';
    this.events = [...opts.events];
  }

  /**
   * Yield the canned event sequence. The user's prompt is intentionally
   * ignored — replay backends are deterministic by design.
   *
   * If `abort()` has been called (or `options.signal` is already
   * aborted on entry), the iterable yields a single synthetic
   * `{ type: 'error', error: 'aborted' }` event and terminates.
   */
  async *sendMessage(
    _text: string,
    options?: BackendSendOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    if (options?.signal) {
      if (options.signal.aborted) {
        this.aborted = true;
      } else {
        const onAbort = () => {
          this.aborted = true;
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    for (const event of this.events) {
      if (this.aborted) {
        yield { type: 'error', error: 'aborted' };
        return;
      }
      yield event;
    }
  }

  /** Abort the next yield. Idempotent. */
  abort(): void {
    this.aborted = true;
  }

  /** No-op: nothing to release. Idempotent. */
  async dispose(): Promise<void> {
    // intentionally empty
  }

  /** Replay backends never retry. */
  isTransient?(): boolean {
    return false;
  }
}

/** Options accepted by {@link ReplayBackend}'s constructor. */
export interface ReplayBackendOptions {
  /** Canned `AgentStreamEvent` sequence. MUST end with `done` or `error`. */
  events: readonly AgentStreamEvent[];
  /**
   * Synthetic session id surfaced via {@link ReplayBackend.sessionId}.
   * Defaults to `'sess_replay'`. No functional effect — only exposed
   * for parity with cassette-driven tests that assert on the id.
   */
  sessionId?: string;
}

// ── Fake Slack adapter ────────────────────────────────────────────────

/**
 * Inbound message handler shape — re-derived from the agentchannels
 * public `ChannelAdapter['onMessage']` parameter type because
 * `MessageHandler` itself is not on the public surface.
 */
type MessageHandler = Parameters<ChannelAdapter['onMessage']>[0];

/** Captured `startStream(...)` call. */
export interface CapturedStartStreamCall {
  channelId: string;
  threadId: string;
  /** Slack adapters mark this optional; the fake faithfully forwards it. */
  userId?: string;
}

/**
 * Captured outbound traffic — populated as the bridge pushes deltas
 * down the returned `StreamHandle`. Useful for asserting on the exact
 * text the bridge would have rendered into Slack.
 */
export interface FakeSlackAdapterCapture {
  /** Every `startStream(...)` call, in arrival order. */
  startStreamCalls: CapturedStartStreamCall[];
  /** Every `StreamHandle.append(text)` argument, in arrival order. */
  appendedTexts: string[];
  /** Every `StreamHandle.finish(final)` argument, in arrival order. */
  finishedTexts: Array<string | undefined>;
  /** Every `setStatus(...)` call, in arrival order. */
  setStatusCalls: Array<{ channelId: string; threadId: string; status: string }>;
  /** Every direct `sendMessage(...)` call (used for error fallbacks). */
  sentMessages: Array<{ channelId: string; threadId: string; text: string }>;
}

/** Handle returned by {@link makeFakeSlackAdapterSource}. */
export interface FakeSlackAdapterSource {
  /** The {@link ChannelAdapter} test double. */
  adapter: ChannelAdapter;
  /**
   * Push a synthetic inbound Slack message into every registered
   * `onMessage` handler. Awaits each handler so `await emit(...)`
   * blocks until the bridge has finished processing the message.
   */
  emit: (msg: ChannelMessage) => Promise<void>;
  /** Captured outbound traffic. */
  capture: FakeSlackAdapterCapture;
  /**
   * Concatenated `appendedTexts` joined into a single string. Mirrors
   * the cassette `finalText` shape so replay tests can do a single
   * `assert.match(harness.streamedText, /.../)` instead of indexing
   * into the array.
   */
  readStreamedText: () => string;
}

/**
 * Build a fully in-process Slack `ChannelAdapter` test double.
 *
 * Lifecycle:
 *
 *   - `connect()` / `disconnect()` are no-ops; the adapter is "always
 *     connected" in test space.
 *   - `onMessage(handler)` registers the handler in an internal list.
 *     A test calls `harness.emit(msg)` to fan a synthetic message out
 *     to every registered handler — that is the surface a Slack-bridge
 *     consumer normally hits when Bolt fires a `message` event.
 *   - `startStream(...)` records the call and returns a `StreamHandle`
 *     whose `append` / `finish` push into the `capture` object.
 *   - `sendMessage(...)` and `setStatus(...)` are recorded for
 *     diagnostic / error-path assertions.
 *
 * No real Slack `WebClient` is constructed; the adapter never touches
 * the network.
 */
export function makeFakeSlackAdapterSource(): FakeSlackAdapterSource {
  const handlers: MessageHandler[] = [];
  const capture: FakeSlackAdapterCapture = {
    startStreamCalls: [],
    appendedTexts: [],
    finishedTexts: [],
    setStatusCalls: [],
    sentMessages: [],
  };

  const adapter: ChannelAdapter = {
    name: 'slack',
    connect: async () => {},
    disconnect: async () => {},
    onMessage: (h) => {
      handlers.push(h);
    },
    sendMessage: async (channelId: string, threadId: string, text: string) => {
      capture.sentMessages.push({ channelId, threadId, text });
    },
    startStream: async (channelId: string, threadId: string, userId?: string) => {
      const call: CapturedStartStreamCall = userId
        ? { channelId, threadId, userId }
        : { channelId, threadId };
      capture.startStreamCalls.push(call);

      const handle: StreamHandle = {
        append: async (text: string) => {
          capture.appendedTexts.push(text);
        },
        finish: async (final?: string) => {
          capture.finishedTexts.push(final);
        },
      };
      return handle;
    },
  };

  return {
    adapter,
    emit: async (msg) => {
      // Await each handler in declaration order so a test that wires
      // multiple bridges onto the same adapter sees deterministic
      // ordering (matters for shutdown-during-flight assertions).
      for (const h of handlers) {
        await h(msg);
      }
    },
    capture,
    readStreamedText: () => capture.appendedTexts.join(''),
  };
}

// ── Fake CLI sink ─────────────────────────────────────────────────────

/** Options accepted by {@link makeFakeCliSink}. */
export interface FakeCliSinkOptions {
  /**
   * Stream-json NDJSON lines (one per element) the fake CLI emits on
   * stdout. Exactly the shape `claude --print --output-format
   * stream-json --verbose` prints, one event per line. Helpers like
   * {@link cliInitLine}, {@link cliTextDeltaLine}, {@link cliResultLine}
   * compose canonical lines without ad-hoc JSON.stringify in tests.
   */
  stdoutLines?: string[];
  /** Buffered stderr the fake child writes before exit. */
  stderr?: string;
  /** Exit code reported by the fake child. Default: 0. */
  exitCode?: number;
  /**
   * Synthetic delay (ms) before stdout starts flowing. Default: 0
   * (`setImmediate`). Useful for tests that want to assert on
   * abort-while-pending behavior.
   */
  startDelay?: number;
  /**
   * If `true`, the child holds streams open and never emits `close` on
   * its own — the test must trigger exit via `child.kill()`. Models
   * the abort-mid-flight scenario.
   */
  hangUntilKilled?: boolean;
}

/** Recorded `(cmd, args, opts)` triple from one `spawn()` call. */
export interface CapturedSpawnCall {
  cmd: string;
  args: ReadonlyArray<string>;
  opts: SpawnOptions;
  /** Concatenation of every chunk written to the child's stdin. */
  stdinReceived: string;
}

/**
 * `SpawnFn` extension surfaced by {@link makeFakeCliSink}: in addition
 * to behaving like `node:child_process.spawn`, the returned function
 * exposes a `calls` array and `lastCall()` helper for assertions.
 */
export interface FakeCliSink extends SpawnFn {
  /** Every recorded call, in arrival order. */
  calls: CapturedSpawnCall[];
  /** The most recent call, or `null` if `spawnFn` was never invoked. */
  lastCall: () => CapturedSpawnCall | null;
}

interface MockChildProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  kill: (signal?: string) => boolean;
  killed: boolean;
}

/**
 * Build an injectable `SpawnFn` that pretends to be the `claude`
 * binary. The fake uses real Node `Readable` / `Writable` streams +
 * `EventEmitter`, so the production readline pipeline inside
 * `spawnProjectClaudeSession` is exercised end-to-end without a real
 * CLI process.
 *
 * The returned function is callable exactly like `node:child_process`'s
 * `spawn`. It additionally exposes:
 *
 *   - `calls` — every recorded `(cmd, args, opts, stdinReceived)`
 *     tuple, in arrival order. Useful for argv-shape assertions
 *     (`--resume`, `--append-system-prompt`, etc.).
 *   - `lastCall()` — convenience accessor for the most recent call.
 *
 * Stdin handling:
 *
 *   The production code calls `child.stdin.write(prompt)` followed by
 *   `child.stdin.end()`. The fake captures every chunk into
 *   `stdinReceived` so a test can assert on the exact prompt the user
 *   supplied. The writable is otherwise a no-op.
 */
export function makeFakeCliSink(opts: FakeCliSinkOptions = {}): FakeCliSink {
  const calls: CapturedSpawnCall[] = [];

  const fn = ((
    cmd: string,
    args: ReadonlyArray<string>,
    options: SpawnOptions,
  ): ChildProcess => {
    const call: CapturedSpawnCall = {
      cmd,
      args,
      opts: options,
      stdinReceived: '',
    };
    calls.push(call);

    const child = new EventEmitter() as MockChildProcess;
    const stdoutStream = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });

    const stdinStream = new Writable({
      write(chunk, _enc, cb) {
        try {
          // The production code writes the prompt as a Buffer; tests
          // that JSON.stringify the prompt see the same string here.
          call.stdinReceived += Buffer.isBuffer(chunk)
            ? chunk.toString('utf-8')
            : String(chunk);
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
    });

    child.stdout = stdoutStream;
    child.stderr = stderrStream;
    child.stdin = stdinStream;
    child.killed = false;
    child.kill = (_signal?: string) => {
      if (child.killed) return true;
      child.killed = true;
      // Drain streams and close. Use setImmediate so the kill caller
      // (the AbortSignal listener inside spawnProjectClaudeSession) can
      // return before close fires.
      setImmediate(() => {
        stdoutStream.push(null);
        stderrStream.push(null);
        child.emit('close', null);
      });
      return true;
    };

    const startDelay = opts.startDelay ?? 0;
    const start = () => {
      for (const line of opts.stdoutLines ?? []) {
        // Trailing newline so readline emits one event per push, not
        // a buffered batch.
        stdoutStream.push(`${line}\n`);
      }
      if (opts.stderr) stderrStream.push(opts.stderr);

      if (opts.hangUntilKilled) {
        // Hold streams open. The test must call abort()/kill().
        return;
      }

      stdoutStream.push(null);
      stderrStream.push(null);
      setImmediate(() => child.emit('close', opts.exitCode ?? 0));
    };

    if (startDelay > 0) {
      setTimeout(start, startDelay);
    } else {
      setImmediate(start);
    }

    return child as unknown as ChildProcess;
  }) as unknown as FakeCliSink;

  fn.calls = calls;
  fn.lastCall = () => (calls.length ? calls[calls.length - 1] ?? null : null);
  return fn;
}

// ── Canned NDJSON line builders ───────────────────────────────────────
//
// Convenience helpers for composing the canned `stdoutLines` arrays
// that {@link makeFakeCliSink} replays. Each helper produces a single
// NDJSON line in the exact shape `claude --print --output-format
// stream-json --verbose` emits, so subsequent integration tests do not
// have to re-derive the JSON structure.

/**
 * Build a `system` `init` line — the leading event Claude CLI emits
 * on every run. Carries the assigned `session_id` that subsequent
 * turns will reuse via `--resume`.
 */
export function cliInitLine(
  sessionId: string,
  extras: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: '/tmp/project',
    tools: ['Read', 'Bash'],
    model: 'sonnet',
    ...extras,
  });
}

/** Build a streaming `text_delta` line. */
export function cliTextDeltaLine(text: string): string {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  });
}

/** Build the terminal `result` line that closes a successful run. */
export function cliResultLine(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1234,
    stop_reason: 'end_turn',
    result: 'final text',
    total_cost_usd: 0.0042,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
    ...overrides,
  });
}

// ── Convenience: build a default ThreadContext ───────────────────────

/**
 * Return a stable `ThreadContext` that the fake adapter would have
 * synthesised from a Slack `message` event for `THREAD_MSG`. Pulled
 * out as a helper so multiple replay tests reach the same default
 * without duplicating the threadKey shape.
 */
export const REPLAY_THREAD: ThreadContext = Object.freeze({
  adapterName: 'slack',
  channelId: 'C123',
  threadId: 'T456',
  userId: 'U789',
  threadKey: 'slack:C123:T456',
});

/** Default `ChannelMessage` matching {@link REPLAY_THREAD}. */
export const REPLAY_THREAD_MSG: ChannelMessage = Object.freeze({
  id: '1.0',
  channelId: 'C123',
  threadId: 'T456',
  userId: 'U789',
  text: 'hello, replay!',
  isMention: true,
  isDirectMessage: false,
});
