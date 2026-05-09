/**
 * Tests for `src/serve/slack-stream-event-parser.ts`.
 *
 * Coverage:
 *
 *   1. parseStreamJsonLine — pure-line parsing
 *      - Empty / whitespace-only → []
 *      - Non-JSON noise → []
 *      - JSON arrays / primitives → []
 *      - Unrecognised SDK message types → []
 *      - `system` `init` invokes onSessionInit + emits []
 *      - `stream_event` content_block_delta/text_delta → text_delta
 *      - `stream_event` content_block_delta/thinking_delta → []
 *      - `assistant` with mixed text+thinking+tool_use blocks → text_delta + thinking + tool_use, in source order
 *      - `user` with tool_result blocks → tool_result events (with toolUseId)
 *      - `result` success → done with stop_reason
 *      - `result` is_error: true → error
 *      - `result` non-success subtype → error
 *      - onResult callback fires with parsed usage breakdown
 *      - listener throws are swallowed (parser stays alive)
 *
 *   2. StreamEventQueue — backpressure-safe async iteration
 *      - Pull-after-push order returns events in arrival order
 *      - Pull-before-push parks the consumer and resumes on the next push
 *      - Terminal `done` / `error` from a pushed line auto-closes the queue
 *      - end() synthesises `done` when no terminal was emitted yet
 *      - end() is idempotent and does not double-emit `done`
 *      - fail() synthesises `error` when no terminal was emitted yet
 *      - fail() called after `done` does not replace the terminal
 *      - push() after end() / fail() is silently dropped
 *      - iterator.return() (early break) drops the buffer and exits
 *      - Many pushes before a single pull — buffer absorbs the burst
 *      - parser-side onSessionInit / onResult callbacks fire from the queue
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentStreamEvent } from 'agentchannels';

import {
  parseStreamJsonLine,
  StreamEventQueue,
  type ResultInfo,
  type SystemInitInfo,
} from './slack-stream-event-parser.js';

// ── Shared helpers ──────────────────────────────────────────────────

/** Build a stream_event line carrying a single text_delta. */
function textDeltaLine(text: string): string {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  });
}

/** Build a system init line. */
function systemInitLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'sess_123',
    cwd: '/tmp/project',
    tools: ['Read', 'Bash'],
    model: 'sonnet',
    ...overrides,
  });
}

/** Build a result line. */
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

/**
 * Drain an async iterable into an array. Caps at maxEvents to keep
 * the test from hanging if the queue fails to terminate.
 */
async function drain(
  iter: AsyncIterable<AgentStreamEvent>,
  maxEvents = 100,
): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const evt of iter) {
    out.push(evt);
    if (out.length >= maxEvents) break;
  }
  return out;
}

// ── parseStreamJsonLine ─────────────────────────────────────────────

describe('parseStreamJsonLine()', () => {
  it('returns [] for empty / whitespace-only lines', () => {
    assert.deepEqual(parseStreamJsonLine(''), []);
    assert.deepEqual(parseStreamJsonLine('   '), []);
    assert.deepEqual(parseStreamJsonLine('\n'), []);
  });

  it('returns [] for non-string input', () => {
    // @ts-expect-error — intentional bad input, parser must not throw.
    assert.deepEqual(parseStreamJsonLine(null), []);
    // @ts-expect-error — intentional bad input.
    assert.deepEqual(parseStreamJsonLine(undefined), []);
    // @ts-expect-error — intentional bad input.
    assert.deepEqual(parseStreamJsonLine(42), []);
  });

  it('returns [] for non-JSON noise without throwing', () => {
    assert.deepEqual(parseStreamJsonLine('hello world'), []);
    assert.deepEqual(parseStreamJsonLine('{ broken json'), []);
  });

  it('returns [] for JSON arrays / primitives (only objects are handled)', () => {
    assert.deepEqual(parseStreamJsonLine('[]'), []);
    assert.deepEqual(parseStreamJsonLine('"a string"'), []);
    assert.deepEqual(parseStreamJsonLine('42'), []);
    assert.deepEqual(parseStreamJsonLine('null'), []);
  });

  it('returns [] for objects without a `type` field', () => {
    assert.deepEqual(parseStreamJsonLine('{}'), []);
    assert.deepEqual(parseStreamJsonLine('{"foo":"bar"}'), []);
  });

  it('returns [] for unrecognised SDK message types', () => {
    assert.deepEqual(
      parseStreamJsonLine(JSON.stringify({ type: 'status_running' })),
      [],
    );
    assert.deepEqual(
      parseStreamJsonLine(JSON.stringify({ type: 'plugin_install' })),
      [],
    );
  });

  it('invokes onSessionInit on `system` `init` and emits no events', () => {
    let captured: SystemInitInfo | null = null;
    const out = parseStreamJsonLine(systemInitLine(), {
      onSessionInit: (info) => {
        captured = info;
      },
    });
    assert.deepEqual(out, []);
    assert.ok(captured, 'onSessionInit must be called');
    const info = captured as unknown as SystemInitInfo;
    assert.equal(info.sessionId, 'sess_123');
    assert.equal(info.cwd, '/tmp/project');
    assert.deepEqual(info.tools, ['Read', 'Bash']);
    assert.equal(info.model, 'sonnet');
  });

  it('does not invoke onSessionInit when the system subtype is not init', () => {
    let calls = 0;
    parseStreamJsonLine(
      JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
      { onSessionInit: () => calls++ },
    );
    assert.equal(calls, 0);
  });

  it('swallows onSessionInit listener throws', () => {
    assert.doesNotThrow(() =>
      parseStreamJsonLine(systemInitLine(), {
        onSessionInit: () => {
          throw new Error('boom');
        },
      }),
    );
  });

  it('translates stream_event content_block_delta/text_delta into text_delta', () => {
    const out = parseStreamJsonLine(textDeltaLine('Hello, '));
    assert.deepEqual(out, [{ type: 'text_delta', text: 'Hello, ' }]);
  });

  it('drops thinking_delta and other delta subtypes (v1 contract)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'pondering' },
      },
    });
    assert.deepEqual(parseStreamJsonLine(line), []);
  });

  it('drops stream_event types other than content_block_delta', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_start' },
    });
    assert.deepEqual(parseStreamJsonLine(line), []);
  });

  it('translates assistant content blocks (text + tool_use, source order preserved)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I will search.' },
          {
            type: 'tool_use',
            id: 'tool_abc',
            name: 'Bash',
            input: { command: 'ls' },
          },
          {
            type: 'tool_use',
            id: 'tool_def',
            name: 'Read',
            input: { path: '/tmp/x' },
          },
        ],
      },
    });
    const out = parseStreamJsonLine(line);
    assert.deepEqual(out, [
      { type: 'text_delta', text: 'I will search.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', name: 'Read', input: { path: '/tmp/x' } },
    ]);
  });

  it('translates assistant thinking blocks into thinking events with text', () => {
    // Anthropic ships extended-thinking content blocks as
    // `{ type: 'thinking', thinking: '<text>', signature?: '...' }` inside
    // `assistant.message.content[]`. The parser must surface them so
    // agentchannels' StreamingBridge can render the plan-task indicator
    // (`case 'thinking'` in streaming-bridge.js's appendTasks pipeline).
    // The output shape is `{ type: 'thinking', text?: string }` — the
    // OUTPUT field is `text`, not `thinking`, even though the input is
    // `thinking`. Multiple thinking blocks coexist with text + tool_use
    // in source order.
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Let me think about this.' },
          { type: 'text', text: 'Here is what I found.' },
          {
            type: 'tool_use',
            id: 'tool_abc',
            name: 'Bash',
            input: { command: 'ls' },
          },
          { type: 'thinking', thinking: 'And one more thought.' },
        ],
      },
    });
    const out = parseStreamJsonLine(line);
    assert.deepEqual(out, [
      { type: 'thinking', text: 'Let me think about this.' },
      { type: 'text_delta', text: 'Here is what I found.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'thinking', text: 'And one more thought.' },
    ]);
  });

  it('drops assistant thinking blocks whose `thinking` field is missing or non-string', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking' },
          { type: 'thinking', thinking: 42 },
          { type: 'thinking', thinking: null },
          { type: 'text', text: 'done' },
        ],
      },
    });
    const out = parseStreamJsonLine(line);
    assert.deepEqual(out, [{ type: 'text_delta', text: 'done' }]);
  });

  it('falls back to "unknown" when an assistant tool_use has no name', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', input: { x: 1 } }],
      },
    });
    const out = parseStreamJsonLine(line);
    assert.deepEqual(out, [{ type: 'tool_use', name: 'unknown', input: { x: 1 } }]);
  });

  it('translates user tool_result blocks with toolUseId', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_abc',
            content: 'output',
            is_error: false,
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool_def',
            content: 'output 2',
          },
        ],
      },
    });
    const out = parseStreamJsonLine(line);
    assert.equal(out.length, 2);
    assert.equal(out[0]?.type, 'tool_result');
    assert.equal((out[0] as { toolUseId?: string }).toolUseId, 'tool_abc');
    assert.equal(out[1]?.type, 'tool_result');
    assert.equal((out[1] as { toolUseId?: string }).toolUseId, 'tool_def');
  });

  it('emits a tool_result without toolUseId when the block lacks the id', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result' }] },
    });
    const out = parseStreamJsonLine(line);
    assert.deepEqual(out, [{ type: 'tool_result' }]);
  });

  it('skips non-tool_result user content blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'plain' }] },
    });
    assert.deepEqual(parseStreamJsonLine(line), []);
  });

  it('translates result success into done with stopReason', () => {
    const out = parseStreamJsonLine(resultLine());
    assert.deepEqual(out, [{ type: 'done', stopReason: 'end_turn' }]);
  });

  it('translates result is_error: true into error', () => {
    const out = parseStreamJsonLine(
      resultLine({ is_error: true, result: 'rate limited' }),
    );
    assert.deepEqual(out, [{ type: 'error', error: 'rate limited' }]);
  });

  it('translates a non-success subtype (e.g. error_max_turns) into error', () => {
    const out = parseStreamJsonLine(
      resultLine({ subtype: 'error_max_turns', is_error: false, result: '' }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.type, 'error');
    assert.match(
      (out[0] as { error: string }).error,
      /error_max_turns|CLI/i,
    );
  });

  it('falls back to a generic error message when result/error fields are missing', () => {
    const out = parseStreamJsonLine(
      JSON.stringify({ type: 'result', is_error: true }),
    );
    assert.equal(out[0]?.type, 'error');
    assert.ok((out[0] as { error: string }).error.length > 0);
  });

  it('invokes onResult with the parsed usage breakdown', () => {
    let captured: ResultInfo | null = null;
    parseStreamJsonLine(resultLine(), {
      onResult: (info) => {
        captured = info;
      },
    });
    assert.ok(captured, 'onResult must be called');
    const info = captured as unknown as ResultInfo;
    assert.equal(info.isError, false);
    assert.equal(info.stopReason, 'end_turn');
    assert.equal(info.subtype, 'success');
    assert.equal(info.durationMs, 1234);
    assert.equal(info.usage.inputTokens, 100);
    assert.equal(info.usage.outputTokens, 50);
    assert.equal(info.usage.cacheReadTokens, 10);
    assert.equal(info.usage.cacheCreationTokens, 5);
    assert.equal(info.usage.totalCostUsd, 0.0042);
  });

  it('swallows onResult listener throws', () => {
    assert.doesNotThrow(() =>
      parseStreamJsonLine(resultLine(), {
        onResult: () => {
          throw new Error('boom');
        },
      }),
    );
  });

  it('defaults usage tokens to 0 when usage block is missing', () => {
    let captured: ResultInfo | null = null;
    parseStreamJsonLine(
      JSON.stringify({ type: 'result', subtype: 'success' }),
      {
        onResult: (info) => {
          captured = info;
        },
      },
    );
    const info = captured as unknown as ResultInfo;
    assert.equal(info.usage.inputTokens, 0);
    assert.equal(info.usage.outputTokens, 0);
  });
});

// ── StreamEventQueue ────────────────────────────────────────────────

describe('StreamEventQueue', () => {
  it('yields events pushed before iteration starts (buffered burst)', async () => {
    const q = new StreamEventQueue();
    q.push(textDeltaLine('a'));
    q.push(textDeltaLine('b'));
    q.push(textDeltaLine('c'));
    q.end();
    const out = await drain(q);
    assert.deepEqual(out, [
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
      { type: 'text_delta', text: 'c' },
      { type: 'done' },
    ]);
  });

  it('parks a consumer that pulls before any push and resumes on the next push', async () => {
    const q = new StreamEventQueue();
    const iter = q[Symbol.asyncIterator]();

    // Start the pull first — it must NOT resolve until a push lands.
    const pending = iter.next();
    let resolved = false;
    pending.then(() => {
      resolved = true;
    });
    // Yield to the microtask queue so any synchronous resolution would
    // have fired by now.
    await new Promise((r) => setImmediate(r));
    assert.equal(resolved, false, 'next() must park on an empty queue');

    q.push(textDeltaLine('hello'));
    const result = await pending;
    assert.deepEqual(result, {
      value: { type: 'text_delta', text: 'hello' },
      done: false,
    });

    q.end();
    // The synthesised `done` event arrives as a value first…
    const terminal = await iter.next();
    assert.deepEqual(terminal, { value: { type: 'done' }, done: false } as never);
    // …and only the subsequent next() resolves with done: true.
    const after = await iter.next();
    assert.equal(after.done, true);
  });

  it('auto-closes after a terminal done emitted from a pushed result line', async () => {
    const q = new StreamEventQueue();
    q.push(textDeltaLine('partial'));
    q.push(resultLine());
    // No end() — the result line must close the queue on its own.
    const out = await drain(q);
    assert.deepEqual(out, [
      { type: 'text_delta', text: 'partial' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('auto-closes after a terminal error emitted from a pushed result line', async () => {
    const q = new StreamEventQueue();
    q.push(resultLine({ is_error: true, result: 'rate limited' }));
    const out = await drain(q);
    assert.deepEqual(out, [{ type: 'error', error: 'rate limited' }]);
  });

  it('end() synthesises done when no terminal was emitted yet', async () => {
    const q = new StreamEventQueue();
    q.push(textDeltaLine('x'));
    q.end();
    const out = await drain(q);
    assert.deepEqual(out, [{ type: 'text_delta', text: 'x' }, { type: 'done' }]);
  });

  it('end() is idempotent and does not double-emit done', async () => {
    const q = new StreamEventQueue();
    q.end();
    q.end();
    q.end();
    const out = await drain(q);
    assert.deepEqual(out, [{ type: 'done' }]);
  });

  it('fail() synthesises error when no terminal was emitted yet', async () => {
    const q = new StreamEventQueue();
    q.push(textDeltaLine('partial'));
    q.fail(new Error('CLI crashed'));
    const out = await drain(q);
    assert.deepEqual(out, [
      { type: 'text_delta', text: 'partial' },
      { type: 'error', error: 'CLI crashed' },
    ]);
  });

  it('fail() with a non-Error value stringifies it', async () => {
    const q = new StreamEventQueue();
    q.fail('oh no');
    const out = await drain(q);
    assert.deepEqual(out, [{ type: 'error', error: 'oh no' }]);
  });

  it('fail() called after a clean done does not replace the terminal', async () => {
    const q = new StreamEventQueue();
    q.push(resultLine()); // emits done
    q.fail(new Error('too late'));
    const out = await drain(q);
    assert.deepEqual(out, [{ type: 'done', stopReason: 'end_turn' }]);
  });

  it('push() after end() is silently dropped', async () => {
    const q = new StreamEventQueue();
    q.end();
    q.push(textDeltaLine('ignored'));
    const out = await drain(q);
    assert.deepEqual(out, [{ type: 'done' }]);
  });

  it('push() after fail() is silently dropped', async () => {
    const q = new StreamEventQueue();
    q.fail('crash');
    q.push(textDeltaLine('ignored'));
    const out = await drain(q);
    assert.deepEqual(out, [{ type: 'error', error: 'crash' }]);
  });

  it('iterator.return() (early break) drops the buffer and exits', async () => {
    const q = new StreamEventQueue();
    q.push(textDeltaLine('a'));
    q.push(textDeltaLine('b'));
    q.push(textDeltaLine('c'));

    const collected: AgentStreamEvent[] = [];
    for await (const evt of q) {
      collected.push(evt);
      break; // triggers iterator.return()
    }
    assert.equal(collected.length, 1);
    assert.deepEqual(collected[0], { type: 'text_delta', text: 'a' });
    assert.equal(q.bufferedCount, 0, 'return() drops the buffer');

    // Subsequent pushes are inert.
    q.push(textDeltaLine('d'));
    assert.equal(q.bufferedCount, 0);
  });

  it('absorbs many synchronous pushes before a single pull (backpressure)', async () => {
    const q = new StreamEventQueue();
    const N = 500;
    for (let i = 0; i < N; i++) {
      q.push(textDeltaLine(String(i)));
    }
    q.end();
    assert.equal(q.bufferedCount, N + 1, 'buffer holds every parsed event');

    const out = await drain(q, N + 5);
    assert.equal(out.length, N + 1);
    assert.deepEqual(out[0], { type: 'text_delta', text: '0' });
    assert.deepEqual(out[N - 1], { type: 'text_delta', text: String(N - 1) });
    assert.deepEqual(out[N], { type: 'done' });
  });

  it('forwards onSessionInit from pushed system init lines', async () => {
    let captured: SystemInitInfo | null = null;
    const q = new StreamEventQueue({
      onSessionInit: (info) => {
        captured = info;
      },
    });
    q.push(systemInitLine());
    q.push(resultLine());
    await drain(q);
    assert.ok(captured);
    const info = captured as unknown as SystemInitInfo;
    assert.equal(info.sessionId, 'sess_123');
  });

  it('forwards onResult from pushed result lines before yielding the terminal', async () => {
    const events: ResultInfo[] = [];
    const q = new StreamEventQueue({
      onResult: (info) => events.push(info),
    });
    q.push(resultLine());
    const out = await drain(q);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.usage.inputTokens, 100);
    assert.deepEqual(out, [{ type: 'done', stopReason: 'end_turn' }]);
  });

  it('isDone reflects post-terminal drained state', async () => {
    const q = new StreamEventQueue();
    assert.equal(q.isDone, false);
    q.push(resultLine());
    assert.equal(q.isDone, false, 'terminal queued but not yet consumed');
    await drain(q);
    assert.equal(q.isDone, true, 'terminal consumed → isDone true');
  });

  it('interleaves pulls and pushes without losing events', async () => {
    const q = new StreamEventQueue();
    const iter = q[Symbol.asyncIterator]();

    q.push(textDeltaLine('a'));
    const e1 = await iter.next();
    assert.deepEqual(e1.value, { type: 'text_delta', text: 'a' });

    const pending = iter.next(); // park
    q.push(textDeltaLine('b'));
    const e2 = await pending;
    assert.deepEqual(e2.value, { type: 'text_delta', text: 'b' });

    q.push(textDeltaLine('c'));
    q.push(resultLine());
    const e3 = await iter.next();
    assert.deepEqual(e3.value, { type: 'text_delta', text: 'c' });

    const e4 = await iter.next();
    assert.deepEqual(e4.value, { type: 'done', stopReason: 'end_turn' });

    const e5 = await iter.next();
    assert.equal(e5.done, true);
  });
});
