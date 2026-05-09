/**
 * Tests for `src/serve/slack-replay-harness.ts` — the replay-driven
 * integration test scaffold (Sub-AC 11.1).
 *
 * These tests do double duty:
 *
 *   1. They verify the harness pieces themselves (`ReplayBackend`,
 *      `makeFakeSlackAdapterSource`, `makeFakeCliSink`) work in
 *      isolation, so a sibling integration test that imports them can
 *      trust the surface.
 *
 *   2. They demonstrate the *integration shape* the seed contract's
 *      `integration_proof` exit condition requires: a canned event
 *      stream + a fake Slack adapter source + a fake CLI sink wired
 *      together end-to-end. Subsequent sub-ACs add on-disk persistence
 *      assertions on top of this foundation.
 *
 * The harness is colocated under `src/serve/` so aweek's existing
 * `pnpm test` glob (`src/serve/*.test.ts`) picks it up without any
 * change to the test runner config.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  AgentStreamEvent,
  Backend,
  ChannelMessage,
  ResolveBackendHook,
  ThreadContext,
} from 'agentchannels';
import { StreamingBridge } from 'agentchannels';

import {
  ReplayBackend,
  REPLAY_THREAD_MSG,
  cliInitLine,
  cliResultLine,
  cliTextDeltaLine,
  makeFakeCliSink,
  makeFakeSlackAdapterSource,
} from './slack-replay-harness.js';
import { ProjectClaudeBackend } from '../channels/slack/project-claude-backend.js';

// ── ReplayBackend ────────────────────────────────────────────────────

describe('ReplayBackend (Sub-AC 11.1 scaffold)', () => {
  it('throws when constructed without options', () => {
    assert.throws(
      () => new ReplayBackend(undefined as unknown as never),
      /opts is required/,
    );
  });

  it('throws when opts.events is not an array', () => {
    assert.throws(
      // @ts-expect-error — exercising runtime guard
      () => new ReplayBackend({ events: 'not-an-array' }),
      /events must be an array/,
    );
  });

  it('exposes the constructor-supplied sessionId', () => {
    const backend = new ReplayBackend({
      sessionId: 'sess_replay_xyz',
      events: [{ type: 'done' }],
    });
    assert.equal(backend.sessionId, 'sess_replay_xyz');
  });

  it("falls back to 'sess_replay' when sessionId is omitted", () => {
    const backend = new ReplayBackend({ events: [{ type: 'done' }] });
    assert.equal(backend.sessionId, 'sess_replay');
  });

  it('yields the canned events in order, terminating with done', async () => {
    const events: AgentStreamEvent[] = [
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ', world' },
      { type: 'done' },
    ];
    const backend = new ReplayBackend({ events });

    const collected: AgentStreamEvent[] = [];
    for await (const evt of backend.sendMessage('user prompt is ignored')) {
      collected.push(evt);
    }
    assert.deepEqual(collected, events);
  });

  it('replaces remaining events with a synthetic error after abort()', async () => {
    const backend = new ReplayBackend({
      events: [
        { type: 'text_delta', text: 'first' },
        { type: 'text_delta', text: 'second' },
        { type: 'done' },
      ],
    });

    const collected: AgentStreamEvent[] = [];
    let pumped = 0;
    for await (const evt of backend.sendMessage('ignored')) {
      collected.push(evt);
      pumped += 1;
      if (pumped === 1) backend.abort();
    }
    assert.equal(collected.length, 2, 'abort terminates after one yield + synthetic error');
    assert.deepEqual(collected[0], { type: 'text_delta', text: 'first' });
    assert.deepEqual(collected[1], { type: 'error', error: 'aborted' });
  });

  it('emits an immediate error when options.signal is pre-aborted', async () => {
    const backend = new ReplayBackend({
      events: [
        { type: 'text_delta', text: 'never seen' },
        { type: 'done' },
      ],
    });
    const ac = new AbortController();
    ac.abort();

    const collected: AgentStreamEvent[] = [];
    for await (const evt of backend.sendMessage('ignored', { signal: ac.signal })) {
      collected.push(evt);
    }
    assert.equal(collected.length, 1);
    assert.deepEqual(collected[0], { type: 'error', error: 'aborted' });
  });

  it('dispose() is idempotent and never throws', async () => {
    const backend = new ReplayBackend({ events: [{ type: 'done' }] });
    await backend.dispose();
    await backend.dispose();
  });

  it('isTransient() returns false (replay backends never retry)', () => {
    const backend = new ReplayBackend({ events: [{ type: 'done' }] });
    assert.equal(backend.isTransient?.(), false);
  });
});

// ── makeFakeSlackAdapterSource ───────────────────────────────────────

describe('makeFakeSlackAdapterSource (Sub-AC 11.1 scaffold)', () => {
  it('starts with an empty capture object', () => {
    const src = makeFakeSlackAdapterSource();
    assert.equal(src.capture.startStreamCalls.length, 0);
    assert.equal(src.capture.appendedTexts.length, 0);
    assert.equal(src.capture.finishedTexts.length, 0);
    assert.equal(src.capture.setStatusCalls.length, 0);
    assert.equal(src.capture.sentMessages.length, 0);
    assert.equal(src.readStreamedText(), '');
  });

  it('exposes adapter.name === "slack"', () => {
    const src = makeFakeSlackAdapterSource();
    assert.equal(src.adapter.name, 'slack');
  });

  it('connect/disconnect are no-ops that resolve cleanly', async () => {
    const src = makeFakeSlackAdapterSource();
    await src.adapter.connect();
    await src.adapter.disconnect();
  });

  it('emit(msg) fans out to every registered onMessage handler in declaration order', async () => {
    const src = makeFakeSlackAdapterSource();
    const seen: Array<{ slot: number; id: string }> = [];
    src.adapter.onMessage(async (m: ChannelMessage) => {
      seen.push({ slot: 0, id: m.id });
    });
    src.adapter.onMessage(async (m: ChannelMessage) => {
      seen.push({ slot: 1, id: m.id });
    });
    await src.emit({ ...REPLAY_THREAD_MSG, id: 'msg-1' });
    await src.emit({ ...REPLAY_THREAD_MSG, id: 'msg-2' });

    assert.deepEqual(seen, [
      { slot: 0, id: 'msg-1' },
      { slot: 1, id: 'msg-1' },
      { slot: 0, id: 'msg-2' },
      { slot: 1, id: 'msg-2' },
    ]);
  });

  it('records startStream calls with optional userId', async () => {
    const src = makeFakeSlackAdapterSource();
    await src.adapter.startStream('C1', 'T1');
    await src.adapter.startStream('C2', 'T2', 'U2');
    assert.deepEqual(src.capture.startStreamCalls, [
      { channelId: 'C1', threadId: 'T1' },
      { channelId: 'C2', threadId: 'T2', userId: 'U2' },
    ]);
  });

  it('records append/finish calls into the capture object', async () => {
    const src = makeFakeSlackAdapterSource();
    const handle = await src.adapter.startStream('C1', 'T1');
    await handle.append('Hello');
    await handle.append(', world');
    await handle.finish('Hello, world');

    assert.deepEqual(src.capture.appendedTexts, ['Hello', ', world']);
    assert.deepEqual(src.capture.finishedTexts, ['Hello, world']);
    assert.equal(src.readStreamedText(), 'Hello, world');
  });

  it('records direct sendMessage calls (used for error fallbacks)', async () => {
    const src = makeFakeSlackAdapterSource();
    await src.adapter.sendMessage('C1', 'T1', 'plain text fallback');
    assert.deepEqual(src.capture.sentMessages, [
      { channelId: 'C1', threadId: 'T1', text: 'plain text fallback' },
    ]);
  });
});

// ── makeFakeCliSink ──────────────────────────────────────────────────

describe('makeFakeCliSink (Sub-AC 11.1 scaffold)', () => {
  it('starts with an empty calls list', () => {
    const sink = makeFakeCliSink();
    assert.equal(sink.calls.length, 0);
    assert.equal(sink.lastCall(), null);
  });

  it('records (cmd, args, opts) on each spawn call', () => {
    const sink = makeFakeCliSink();
    sink('claude', ['--print', '--resume', 'sess1'], { cwd: '/tmp/proj' });
    sink('claude', ['--print'], { cwd: '/tmp/proj2' });
    assert.equal(sink.calls.length, 2);
    assert.equal(sink.calls[0]!.cmd, 'claude');
    assert.deepEqual(sink.calls[0]!.args, ['--print', '--resume', 'sess1']);
    assert.equal(sink.calls[0]!.opts.cwd, '/tmp/proj');
    assert.equal(sink.lastCall()?.opts.cwd, '/tmp/proj2');
  });

  it('captures every chunk written to child.stdin', async () => {
    const sink = makeFakeCliSink({
      stdoutLines: [cliInitLine('sess_a'), cliResultLine()],
    });
    const child = sink('claude', ['--print'], {});
    child.stdin?.write('user prompt 1');
    child.stdin?.write('user prompt 2');
    child.stdin?.end();
    // Wait for the close event so streams have settled.
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    assert.equal(sink.lastCall()?.stdinReceived, 'user prompt 1user prompt 2');
  });

  it('emits each stdoutLine + newline through a real Readable', async () => {
    const sink = makeFakeCliSink({
      stdoutLines: ['line-1', 'line-2', 'line-3'],
    });
    const child = sink('claude', [], {});

    let buffered = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf-8');
    });
    await new Promise<void>((resolve) => child.once('close', () => resolve()));

    assert.equal(buffered, 'line-1\nline-2\nline-3\n');
  });

  it('emits the configured stderr through child.stderr', async () => {
    const sink = makeFakeCliSink({
      stdoutLines: [],
      stderr: 'err: synthetic warning\n',
    });
    const child = sink('claude', [], {});
    let bufferedErr = '';
    child.stderr?.on('data', (c: Buffer) => {
      bufferedErr += c.toString('utf-8');
    });
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    assert.equal(bufferedErr, 'err: synthetic warning\n');
  });

  it('emits the configured exitCode on close', async () => {
    const sink = makeFakeCliSink({ stdoutLines: [], exitCode: 42 });
    const child = sink('claude', [], {});
    const code = await new Promise<number | null>((resolve) => {
      child.once('close', (c: number | null) => resolve(c));
    });
    assert.equal(code, 42);
  });

  it('hangUntilKilled holds streams open until kill()', async () => {
    const sink = makeFakeCliSink({
      stdoutLines: [cliInitLine('sess_h')],
      hangUntilKilled: true,
    });
    const child = sink('claude', [], {});

    // Wait one tick to let the canned line flow.
    await new Promise<void>((r) => setImmediate(r));

    let closed = false;
    child.once('close', () => {
      closed = true;
    });
    // The child is hanging — close should not have fired yet.
    assert.equal(closed, false);
    child.kill();
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(closed, true);
  });
});

// ── Canned NDJSON line builders ──────────────────────────────────────

describe('cliInitLine / cliTextDeltaLine / cliResultLine helpers', () => {
  it('cliInitLine emits a system/init shape with the given sessionId', () => {
    const parsed = JSON.parse(cliInitLine('sess_xyz'));
    assert.equal(parsed.type, 'system');
    assert.equal(parsed.subtype, 'init');
    assert.equal(parsed.session_id, 'sess_xyz');
  });

  it('cliInitLine accepts extras that override defaults', () => {
    const parsed = JSON.parse(cliInitLine('sess_xyz', { model: 'opus' }));
    assert.equal(parsed.model, 'opus');
  });

  it('cliTextDeltaLine emits a stream_event/content_block_delta wrapping the text', () => {
    const parsed = JSON.parse(cliTextDeltaLine('Hello'));
    assert.equal(parsed.type, 'stream_event');
    assert.equal(parsed.event.type, 'content_block_delta');
    assert.equal(parsed.event.delta.type, 'text_delta');
    assert.equal(parsed.event.delta.text, 'Hello');
  });

  it('cliResultLine emits a successful result with default usage', () => {
    const parsed = JSON.parse(cliResultLine());
    assert.equal(parsed.type, 'result');
    assert.equal(parsed.subtype, 'success');
    assert.equal(parsed.is_error, false);
    assert.equal(parsed.usage.input_tokens, 100);
    assert.equal(parsed.usage.output_tokens, 50);
  });

  it('cliResultLine accepts overrides for error scenarios', () => {
    const parsed = JSON.parse(
      cliResultLine({
        is_error: true,
        subtype: 'error_max_turns',
        result: 'oops',
      }),
    );
    assert.equal(parsed.is_error, true);
    assert.equal(parsed.subtype, 'error_max_turns');
    assert.equal(parsed.result, 'oops');
  });
});

// ── End-to-end: ReplayBackend through StreamingBridge ────────────────

describe('replay-driven integration: ReplayBackend + StreamingBridge + fake adapter', () => {
  it('streams the canned text through the fake adapter capture', async () => {
    const src = makeFakeSlackAdapterSource();

    const replayBackend = new ReplayBackend({
      sessionId: 'sess_replay_e2e',
      events: [
        { type: 'text_delta', text: 'Hello from replay' },
        { type: 'text_delta', text: '!' },
        { type: 'done' },
      ],
    });

    const resolveBackend: ResolveBackendHook = async (_ctx: ThreadContext) =>
      replayBackend as Backend;

    const bridge = new StreamingBridge({
      adapter: src.adapter,
      resolveBackend,
    });

    src.adapter.onMessage(async (msg: ChannelMessage) => {
      await bridge.handleMessage(msg);
    });

    await src.emit(REPLAY_THREAD_MSG);

    // The bridge delivered the canned text via startStream → append.
    assert.equal(src.capture.startStreamCalls.length, 1);
    assert.match(src.readStreamedText(), /Hello from replay!/);
  });
});

// ── End-to-end: fake CLI sink + ProjectClaudeBackend ─────────────────

describe('replay-driven integration: fake CLI sink + ProjectClaudeBackend', () => {
  it('drives a complete stream-json sequence through the real backend', async () => {
    const sink = makeFakeCliSink({
      stdoutLines: [
        cliInitLine('sess_cli_e2e'),
        cliTextDeltaLine('streamed '),
        cliTextDeltaLine('reply'),
        cliResultLine(),
      ],
      exitCode: 0,
    });

    const sessionInits: string[] = [];
    const resultIsError: boolean[] = [];

    const backend = new ProjectClaudeBackend({
      projectRoot: '/tmp/replay-harness-test',
      thread: {
        adapterName: 'slack',
        channelId: 'C123',
        threadId: 'T456',
        userId: 'U789',
        threadKey: 'slack:C123:T456',
      },
      spawnFn: sink,
      onSessionInit: (info) => sessionInits.push(info.sessionId),
      onResult: (info) => resultIsError.push(info.isError),
    });

    const events: AgentStreamEvent[] = [];
    for await (const evt of backend.sendMessage('hello replay')) {
      events.push(evt);
    }

    // The harness drove through to the terminal `done` event.
    assert.ok(events.length > 0);
    assert.equal(events[events.length - 1]!.type, 'done');

    // Concatenated text matches the canned `text_delta` lines.
    const textDeltas = events
      .filter((e): e is AgentStreamEvent & { type: 'text_delta' } => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    assert.equal(textDeltas, 'streamed reply');

    // Out-of-band metadata fired through the parser hooks.
    assert.deepEqual(sessionInits, ['sess_cli_e2e']);
    assert.deepEqual(resultIsError, [false]);

    // Exactly one CLI invocation, with the prompt piped through stdin.
    assert.equal(sink.calls.length, 1);
    assert.equal(sink.lastCall()?.stdinReceived, 'hello replay');
  });
});
