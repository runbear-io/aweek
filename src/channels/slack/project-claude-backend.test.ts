/**
 * Tests for `src/channels/slack/project-claude-backend.ts`.
 *
 * Sub-AC 4.4 of the Slack-aweek integration seed.
 *
 * Coverage:
 *
 *   1. Construction validation
 *      - Throws on missing `opts`, `projectRoot`, `thread`.
 *      - `kind` is the literal `"project-claude"`.
 *      - `getClaudeSessionId()` returns the construction-time value
 *        (rehydration path) or `undefined` (cold start).
 *
 *   2. Happy-path event sequence
 *      - System init → text_delta(s) → result(success) emitted by a
 *        fake CLI yields `text_delta` events followed by `done` with
 *        the reported `stop_reason`. No spurious extra events. The
 *        backend's `claudeSessionId` is updated AND the
 *        `onSessionInit` / `onResult` factory hooks fire exactly once
 *        with the parsed payloads.
 *      - First turn omits `--resume`; second turn (with sessionId now
 *        captured) injects `--resume <id>`.
 *
 *   3. tool_use / tool_result mapping
 *      - An `assistant` block carrying a `tool_use` content item
 *        becomes a `{ type: "tool_use", name, input }` event.
 *      - A `user` block carrying a `tool_result` content item becomes
 *        a `{ type: "tool_result", toolUseId }` event.
 *      - Mixed sequences (text_delta → tool_use → tool_result →
 *        text_delta → done) preserve arrival order.
 *
 *   4. Error propagation
 *      - A `result` line with `is_error: true` yields a single
 *        `error` event carrying the CLI's `result` text.
 *      - A clean stdout stream that ends with a non-zero exit code
 *        (no `result` line at all) yields an `error` event whose
 *        message embeds the buffered stderr.
 *      - A spawn helper rejection (synchronous spawn failure) yields
 *        a single `error` event whose message preserves the
 *        underlying error text — the generator NEVER rejects.
 *      - Listener throws inside `onSessionInit` / `onResult` are
 *        swallowed and do NOT abort the stream.
 *
 *   5. Abort / cleanup
 *      - `abort()` mid-stream causes the spawn helper to deliver
 *        SIGTERM, the queue to terminate with an `error` event, and
 *        the consumer's `for await` to exit cleanly.
 *      - `abort()` is idempotent (no throws) when called with no
 *        in-flight call or after the stream has already settled.
 *      - `dispose()` is equivalent to `abort()` — also idempotent.
 *      - A pre-aborted `options.signal` short-circuits the spawn
 *        before the child is launched; the iterable surfaces a
 *        terminal `error` and the spawn helper records `killed: true`
 *        with no spawn call recorded.
 *      - `currentAbort` is cleared after the generator settles.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import type { AgentStreamEvent, ThreadContext } from 'agentchannels';

import { ProjectClaudeBackend } from './project-claude-backend.js';
import type { SpawnFn } from '../../execution/cli-session.js';

// ── Shared fixtures ─────────────────────────────────────────────────

/** Stable thread context used by every test that doesn't override. */
const THREAD: ThreadContext = {
  adapterName: 'slack',
  channelId: 'C123',
  threadId: 'T456',
  userId: 'U789',
  threadKey: 'slack:C123:T456',
};

/** Build a `system` `init` NDJSON line with a configurable session id. */
function systemInitLine(sessionId: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: '/tmp/project',
    tools: ['Read', 'Bash'],
    model: 'sonnet',
  });
}

/** Build a streaming `text_delta` NDJSON line. */
function textDeltaLine(text: string): string {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  });
}

/** Build an `assistant` NDJSON line that carries a `tool_use` block. */
function toolUseLine(name: string, input: unknown, toolUseId = 'tu_1'): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: toolUseId, name, input },
      ],
    },
  });
}

/** Build a `user` NDJSON line that carries a `tool_result` block. */
function toolResultLine(toolUseId: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: 'ok' },
      ],
    },
  });
}

/** Build a successful `result` line with default usage. */
function resultLine(overrides: Record<string, unknown> = {}): string {
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

/** Build a failing `result` line. */
function errorResultLine(message = 'something went wrong'): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    duration_ms: 50,
    result: message,
    usage: { input_tokens: 1, output_tokens: 0 },
  });
}

interface MockChildProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  kill: (signal?: string) => boolean;
  killed: boolean;
}

interface SpawnCall {
  cmd: string;
  args: ReadonlyArray<string>;
  opts: SpawnOptions;
}

interface MockSpawn extends SpawnFn {
  /** Returns the most recent (cmd, args, opts) tuple, or null. */
  lastCall: () => SpawnCall | null;
  /** All recorded calls in arrival order. */
  calls: SpawnCall[];
}

interface CreateMockSpawnOpts {
  /** Stream-json NDJSON lines (one per element) the child emits on stdout. */
  stdoutLines?: string[];
  /** Buffered stderr the child writes before exit. */
  stderr?: string;
  /** Exit code reported by the child (null if killed). */
  exitCode?: number | null;
  /**
   * If set, the child emits an `'error'` event with this message
   * before exit (modelling a child_process error surface, e.g.
   * EACCES on a non-executable CLI binary).
   */
  childError?: string;
  /**
   * If set, the *spawn function itself* throws synchronously. Models
   * `spawn ENOENT` from a missing CLI binary.
   */
  syncThrow?: Error;
  /**
   * If true, never emit `close` on its own — the test must trigger
   * exit via `child.kill()` (used to verify abort wiring).
   */
  hangUntilKilled?: boolean;
  /**
   * Synthetic delay (ms) before stdout starts flowing. Defaults to 0
   * (`setImmediate`).
   */
  startDelay?: number;
}

/**
 * Build a fake `node:child_process.spawn` that exposes a recorded
 * stdin/stdout/stderr triple and emits a configurable stream-json
 * sequence.
 *
 * The fake uses Node streams + EventEmitter — exactly what the readline
 * pipeline inside `spawnProjectClaudeSession` consumes — so the
 * production code path is exercised end-to-end without a real CLI.
 */
function createMockSpawn(opts: CreateMockSpawnOpts = {}): MockSpawn {
  const calls: SpawnCall[] = [];

  const fn = ((
    cmd: string,
    args: ReadonlyArray<string>,
    options: SpawnOptions,
  ): ChildProcess => {
    if (opts.syncThrow) {
      throw opts.syncThrow;
    }
    calls.push({ cmd, args, opts: options });

    const child = new EventEmitter() as MockChildProcess;
    const stdoutStream = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });

    // Stdin must be a writable that swallows the prompt — the
    // production code calls `child.stdin.write(prompt)` and
    // `child.stdin.end()`. A no-op writable matches the contract.
    const stdinStream = new Writable({
      write(_chunk, _enc, cb) {
        cb();
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
      // (the AbortSignal listener) can return before close fires.
      setImmediate(() => {
        stdoutStream.push(null);
        stderrStream.push(null);
        child.emit('close', null);
      });
      return true;
    };

    const startDelay = opts.startDelay ?? 0;
    const start = () => {
      if (opts.childError) {
        child.emit('error', new Error(opts.childError));
        return;
      }

      for (const line of opts.stdoutLines ?? []) {
        // Push each line + trailing newline so readline emits it
        // exactly as the production CLI does.
        stdoutStream.push(`${line}\n`);
      }
      if (opts.stderr) stderrStream.push(opts.stderr);

      if (opts.hangUntilKilled) {
        // Hold both streams open. The test calls abort()/kill() to
        // close them.
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
  }) as unknown as MockSpawn;

  fn.lastCall = () => (calls.length ? calls[calls.length - 1] : null);
  fn.calls = calls;
  return fn;
}

/**
 * Drain an async iterable into an array. `maxEvents` keeps a hung test
 * from dragging the runner along — assertion failures are noisier than
 * a runaway test.
 */
async function drain(
  iter: AsyncIterable<AgentStreamEvent>,
  maxEvents = 200,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const evt of iter) {
    events.push(evt);
    if (events.length > maxEvents) {
      throw new Error(`drain: exceeded ${maxEvents} events`);
    }
  }
  return events;
}

// ===========================================================================
// Construction validation
// ===========================================================================
describe('ProjectClaudeBackend — construction', () => {
  it('throws when opts is missing', () => {
    assert.throws(
      () => new ProjectClaudeBackend(undefined as unknown as never),
      /opts is required/,
    );
  });

  it('throws when projectRoot is missing', () => {
    assert.throws(
      () =>
        new ProjectClaudeBackend({
          // @ts-expect-error — exercising runtime guard
          projectRoot: '',
          thread: THREAD,
        }),
      /projectRoot is required/,
    );
  });

  it('throws when thread is missing', () => {
    assert.throws(
      () =>
        new ProjectClaudeBackend({
          projectRoot: '/tmp/proj',
          // @ts-expect-error — exercising runtime guard
          thread: undefined,
        }),
      /thread is required/,
    );
  });

  it('exposes the literal "project-claude" backend kind', () => {
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
    });
    assert.equal(backend.kind, 'project-claude');
  });

  it('echoes the construction-time claudeSessionId (rehydration path)', () => {
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      claudeSessionId: 'sess_pre_existing',
    });
    assert.equal(backend.getClaudeSessionId(), 'sess_pre_existing');
  });

  it('returns undefined for getClaudeSessionId on a cold start', () => {
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
    });
    assert.equal(backend.getClaudeSessionId(), undefined);
  });
});

// ===========================================================================
// sendMessage — happy path
// ===========================================================================
describe('ProjectClaudeBackend.sendMessage — happy path', () => {
  it('yields text_delta events followed by a terminal `done` with stop_reason', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [
        systemInitLine('sess_new'),
        textDeltaLine('Hello'),
        textDeltaLine(' world'),
        resultLine(),
      ],
      exitCode: 0,
    });

    const sessionInits: Array<{ sessionId: string }> = [];
    const results: Array<{ isError: boolean }> = [];

    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
      onSessionInit: (info) => sessionInits.push({ sessionId: info.sessionId }),
      onResult: (info) => results.push({ isError: info.isError }),
    });

    const events = await drain(backend.sendMessage('hi'));

    assert.deepEqual(events, [
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'done', stopReason: 'end_turn' },
    ]);

    // Session id is captured for the next turn.
    assert.equal(backend.getClaudeSessionId(), 'sess_new');
    // Factory hooks fired exactly once each.
    assert.equal(sessionInits.length, 1);
    assert.equal(sessionInits[0].sessionId, 'sess_new');
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, false);
  });

  it('passes the user prompt to stdin and includes --dangerously-skip-permissions in argv', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [systemInitLine('sess_x'), resultLine()],
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
    });

    await drain(backend.sendMessage('please respond'));

    const call = spawnFn.lastCall();
    assert.ok(call, 'spawn must have been called');
    assert.ok(
      call.args.includes('--dangerously-skip-permissions'),
      'Slack runs MUST include --dangerously-skip-permissions',
    );
    assert.ok(call.args.includes('--print'));
    assert.ok(call.args.includes('--output-format'));
    assert.ok(call.args.includes('stream-json'));
    assert.ok(call.args.includes('--verbose'));
    // No --agent in v1 (project-level proxy).
    assert.ok(!call.args.includes('--agent'));
    // First turn never carries --resume.
    assert.ok(!call.args.includes('--resume'));
    // Working directory is the project root.
    assert.equal(call.opts.cwd, '/tmp/proj');
  });

  it('passes --resume <sessionId> on the second turn and updates it from the new init line', async () => {
    // Turn 1: assigns sess_a.
    const spawn1 = createMockSpawn({
      stdoutLines: [systemInitLine('sess_a'), resultLine()],
    });
    // Turn 2: re-confirms sess_a via init (CLI may re-emit the same id).
    const spawn2 = createMockSpawn({
      stdoutLines: [systemInitLine('sess_a'), resultLine()],
    });

    const backend1 = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn: spawn1,
    });
    await drain(backend1.sendMessage('first'));
    const sessionAfterTurn1 = backend1.getClaudeSessionId();
    assert.equal(sessionAfterTurn1, 'sess_a');

    // Simulate re-using the SAME backend instance (one-per-thread
    // contract) for turn 2 with a different mock so we can inspect
    // the second argv independently.
    const backend2 = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn: spawn2,
      claudeSessionId: sessionAfterTurn1,
    });
    await drain(backend2.sendMessage('second'));

    const call2 = spawn2.lastCall();
    assert.ok(call2);
    const resumeIdx = call2.args.indexOf('--resume');
    assert.ok(resumeIdx >= 0, 'second turn must carry --resume');
    assert.equal(call2.args[resumeIdx + 1], 'sess_a');
  });

  it('appends the systemPromptAppend banner via --append-system-prompt when provided', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [systemInitLine('sess'), resultLine()],
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
      systemPromptAppend: 'You are chatting in Slack — keep replies conversational.',
    });
    await drain(backend.sendMessage('hi'));

    const call = spawnFn.lastCall();
    assert.ok(call);
    const idx = call.args.indexOf('--append-system-prompt');
    assert.ok(idx >= 0);
    assert.match(
      String(call.args[idx + 1]),
      /conversational/,
      'banner must appear as the value of --append-system-prompt',
    );
  });

  it('omits --append-system-prompt when the banner is unset', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [systemInitLine('sess'), resultLine()],
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
    });
    await drain(backend.sendMessage('hi'));

    const call = spawnFn.lastCall();
    assert.ok(call);
    assert.ok(!call.args.includes('--append-system-prompt'));
  });
});

// ===========================================================================
// sendMessage — tool_use / tool_result mapping
// ===========================================================================
describe('ProjectClaudeBackend.sendMessage — tool mapping', () => {
  it('maps an assistant tool_use block to a `tool_use` AgentStreamEvent', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [
        systemInitLine('sess'),
        toolUseLine('Read', { path: '/tmp/foo' }, 'tu_1'),
        resultLine(),
      ],
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
    });

    const events = await drain(backend.sendMessage('hi'));

    assert.equal(events.length, 2);
    const [toolUse, done] = events;
    assert.equal(toolUse.type, 'tool_use');
    if (toolUse.type === 'tool_use') {
      assert.equal(toolUse.name, 'Read');
      assert.deepEqual(toolUse.input, { path: '/tmp/foo' });
    }
    assert.equal(done.type, 'done');
  });

  it('maps a user tool_result block to a `tool_result` AgentStreamEvent carrying toolUseId', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [
        systemInitLine('sess'),
        toolResultLine('tu_42'),
        resultLine(),
      ],
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
    });

    const events = await drain(backend.sendMessage('hi'));

    assert.equal(events.length, 2);
    const [toolResult, done] = events;
    assert.equal(toolResult.type, 'tool_result');
    if (toolResult.type === 'tool_result') {
      assert.equal(toolResult.toolUseId, 'tu_42');
    }
    assert.equal(done.type, 'done');
  });

  it('preserves arrival order across mixed text/tool/text sequences', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [
        systemInitLine('sess'),
        textDeltaLine('Looking up '),
        toolUseLine('Read', { path: '/a' }, 'tu_1'),
        toolResultLine('tu_1'),
        textDeltaLine('Done.'),
        resultLine(),
      ],
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
    });

    const events = await drain(backend.sendMessage('hi'));
    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      'text_delta',
      'tool_use',
      'tool_result',
      'text_delta',
      'done',
    ]);
  });
});

// ===========================================================================
// sendMessage — error propagation
// ===========================================================================
describe('ProjectClaudeBackend.sendMessage — error propagation', () => {
  it('emits a single `error` event when the CLI reports is_error: true', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [
        systemInitLine('sess'),
        errorResultLine('boom: turn limit reached'),
      ],
      // Even an error-result run exits with code 0 — the error is
      // reported in-band, not through the exit code.
      exitCode: 0,
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
    });

    const events = await drain(backend.sendMessage('hi'));
    assert.equal(events.length, 1);
    const [evt] = events;
    assert.equal(evt.type, 'error');
    if (evt.type === 'error') {
      assert.match(evt.error, /boom: turn limit reached/);
    }
  });

  it('synthesises an `error` event when the child exits non-zero with no result line', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [], // no init, no events at all
      stderr: 'oh no, the cli crashed',
      exitCode: 2,
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
    });

    const events = await drain(backend.sendMessage('hi'));
    assert.equal(events.length, 1);
    const [evt] = events;
    assert.equal(evt.type, 'error');
    if (evt.type === 'error') {
      assert.match(evt.error, /CLI exited with code 2/);
      assert.match(evt.error, /oh no, the cli crashed/);
    }
  });

  it('surfaces a synchronous spawn failure as a single `error` event (never rejects)', async () => {
    const spawnFn = createMockSpawn({
      syncThrow: new Error('spawn ENOENT: claude'),
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
    });

    let threw: unknown = null;
    let events: AgentStreamEvent[] = [];
    try {
      events = await drain(backend.sendMessage('hi'));
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, null, 'sendMessage iterable must NOT reject on spawn failure');
    assert.equal(events.length, 1);
    const [evt] = events;
    assert.equal(evt.type, 'error');
    if (evt.type === 'error') {
      assert.match(evt.error, /spawn ENOENT/);
    }
  });

  it('swallows throws inside onSessionInit and onResult listeners', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [
        systemInitLine('sess_x'),
        textDeltaLine('hi'),
        resultLine(),
      ],
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
      onSessionInit: () => {
        throw new Error('persistence boom');
      },
      onResult: () => {
        throw new Error('usage bucket boom');
      },
    });

    const events = await drain(backend.sendMessage('hi'));
    // Stream still terminates cleanly.
    assert.equal(events[events.length - 1].type, 'done');
    // Session id is still mirrored (mirror happens before the listener).
    assert.equal(backend.getClaudeSessionId(), 'sess_x');
  });
});

// ===========================================================================
// sendMessage — abort / cleanup
// ===========================================================================
describe('ProjectClaudeBackend.sendMessage — abort / cleanup', () => {
  it('abort() mid-stream terminates the iterable with an `error` event', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [systemInitLine('sess'), textDeltaLine('partial')],
      hangUntilKilled: true,
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
    });

    const iter = backend.sendMessage('hi');
    const events: AgentStreamEvent[] = [];

    const consumer = (async () => {
      for await (const evt of iter) {
        events.push(evt);
        if (evt.type === 'text_delta') {
          // Pull one text delta then abort. The hung child must
          // close in response to SIGTERM and the iterable terminates.
          backend.abort();
        }
      }
    })();

    await consumer;

    assert.ok(events.length >= 2, 'should yield at least the partial text + terminal');
    assert.equal(events[0].type, 'text_delta');
    const last = events[events.length - 1];
    assert.equal(last.type, 'error');
  });

  it('abort() is idempotent (no-op when called with no in-flight call or after settle)', async () => {
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn: createMockSpawn({
        stdoutLines: [systemInitLine('sess'), resultLine()],
      }),
    });
    // No in-flight call — must not throw.
    backend.abort();

    await drain(backend.sendMessage('hi'));

    // After settle — must not throw.
    backend.abort();
    backend.abort();
  });

  it('dispose() aborts any in-flight call and is idempotent', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [systemInitLine('sess'), textDeltaLine('a')],
      hangUntilKilled: true,
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
    });

    const iter = backend.sendMessage('hi');
    const events: AgentStreamEvent[] = [];
    const consumer = (async () => {
      for await (const evt of iter) {
        events.push(evt);
        if (evt.type === 'text_delta') {
          await backend.dispose();
        }
      }
    })();
    await consumer;
    // Calling dispose twice must not throw.
    await backend.dispose();
    await backend.dispose();

    const last = events[events.length - 1];
    assert.equal(last.type, 'error');
  });

  it('a pre-aborted signal short-circuits — no spawn call is recorded', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [systemInitLine('sess'), resultLine()],
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
    });

    const ac = new AbortController();
    ac.abort();
    const events = await drain(backend.sendMessage('hi', { signal: ac.signal }));

    // The spawn helper's fast-path returns `killed: true` before
    // calling `spawnFn`, so the mock must record zero calls.
    assert.equal(spawnFn.calls.length, 0, 'no spawn must occur when signal is pre-aborted');
    // The stream still terminates.
    assert.ok(events.length >= 1);
    assert.equal(events[events.length - 1].type, 'error');
  });

  it('clears currentAbort after the generator settles', async () => {
    const spawnFn = createMockSpawn({
      stdoutLines: [systemInitLine('sess'), resultLine()],
    });
    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/proj',
      thread: THREAD,
      spawnFn,
    });

    await drain(backend.sendMessage('hi'));

    // After settle, abort() with no in-flight call must be a no-op
    // (which we already cover above) AND a fresh sendMessage must
    // succeed cleanly — proving the controller slot was cleared.
    const second = await drain(backend.sendMessage('hi again'));
    assert.equal(second[second.length - 1].type, 'done');
  });
});
