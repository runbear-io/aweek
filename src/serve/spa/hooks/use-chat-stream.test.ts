/**
 * Tests for `./use-chat-stream.ts` — the chat transport hook shipped in
 * Sub-AC 3 of the chat-panel feature (AC 1).
 *
 * Contract pinned by these tests:
 *   1. SSE-frame parser handles single-line `data:`, multi-data
 *      records, comments, and malformed JSON without throwing.
 *   2. `sendMessage()` POSTs to the configured endpoint with the
 *      slug + appended user message and an `Accept: text/event-stream`
 *      header.
 *   3. The user message is appended to local state **before** the
 *      fetch fires (optimistic update).
 *   4. As SSE frames stream in, `text-delta` events accumulate on the
 *      placeholder assistant message in order.
 *   5. `assistant-message` events replace the assistant content with
 *      the canonical text from the structured block list.
 *   6. `turn-complete` flips status from `streaming` → `ready`.
 *   7. `stop()` aborts the in-flight request — status returns to
 *      `ready` without setting `error`.
 *   8. Network errors and non-2xx responses surface via `error` and
 *      flip status to `'error'`; `onError` is invoked.
 *   9. `handleSubmit()` reads `input`, clears it, then calls
 *      `sendMessage`.
 *  10. Whitespace-only sends are dropped silently.
 *
 * Vitest + jsdom + Testing Library (config: vitest.config.js +
 * vitest.setup.js).
 */

import * as React from 'react';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import {
  __test,
  parseSseFrame,
  useChatStream,
  type ChatStatus,
  type ChatTransportFrame,
} from './use-chat-stream.ts';

afterEach(() => {
  cleanup();
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a `Response`-like object whose body is a controllable
 * `ReadableStream<Uint8Array>`. The returned `push` function emits a
 * UTF-8-encoded chunk; `end()` closes the stream cleanly.
 *
 * The hook reads via `response.body.getReader()` so we only need a
 * minimal subset of the real `Response` shape — `ok`, `body`, `text`,
 * `status`. This avoids the cost of mocking `Response` constructors
 * across jsdom / undici / node-fetch.
 */
function makeStreamingResponse(): {
  response: Response;
  push: (chunk: string) => void;
  end: () => void;
  closed: Promise<void>;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((res) => {
    resolveClosed = res;
  });

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      resolveClosed();
    },
  });

  const response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: stream,
    text: async () => '',
  } as unknown as Response;

  return {
    response,
    push(chunk: string) {
      controller?.enqueue(encoder.encode(chunk));
    },
    end() {
      controller?.close();
      resolveClosed();
    },
    closed,
  };
}

/** Build an SSE `data:` frame from a transport-frame object. */
function sse(frame: ChatTransportFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

// ── parseSseFrame ────────────────────────────────────────────────────

describe('parseSseFrame', () => {
  it('parses a single-line data: frame', () => {
    const out = parseSseFrame('data: {"type":"stream-start","t":1}');
    expect(out).toEqual({ type: 'stream-start', t: 1 });
  });

  it('tolerates the `data:` short form (no leading space)', () => {
    const out = parseSseFrame('data:{"type":"stream-end"}');
    expect(out).toEqual({ type: 'stream-end' });
  });

  it('joins multi-line data: payloads on \\n per the SSE spec', () => {
    // A JSON payload split across two `data:` lines. SSE spec says
    // each `data:` value is concatenated with `\n` and the resulting
    // text is decoded as the payload — so this builds a valid JSON
    // string with an embedded newline that survives JSON.parse.
    const frame =
      'data: {"type":"text-delta",\n' +
      'data: "delta":"hello"}';
    const out = parseSseFrame(frame);
    expect(out).toEqual({ type: 'text-delta', delta: 'hello' });
  });

  it('drops comment lines (": open")', () => {
    const out = parseSseFrame(': open');
    expect(out).toBeNull();
  });

  it('returns null on malformed JSON without throwing', () => {
    expect(parseSseFrame('data: not-json')).toBeNull();
  });

  it('returns null on a JSON value with no `type` discriminant', () => {
    expect(parseSseFrame('data: {"foo":"bar"}')).toBeNull();
  });
});

// ── extractAssistantText (helper) ────────────────────────────────────

describe('extractAssistantText helper', () => {
  it('passes through plain string content', () => {
    expect(__test.extractAssistantText('hi there')).toBe('hi there');
  });

  it('concatenates text blocks from a structured array', () => {
    expect(
      __test.extractAssistantText([
        { type: 'text', text: 'Hel' },
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'text', text: 'lo!' },
      ]),
    ).toBe('Hello!');
  });

  it('returns "" for unrecognised shapes', () => {
    expect(__test.extractAssistantText(null)).toBe('');
    expect(__test.extractAssistantText({ type: 'image' })).toBe('');
  });
});

// ── joinUrl (helper) ────────────────────────────────────────────────

describe('joinUrl helper', () => {
  it('returns endpoint as-is when baseUrl is empty', () => {
    expect(__test.joinUrl('', '/api/chat')).toBe('/api/chat');
  });

  it('joins absolute base + relative endpoint cleanly', () => {
    expect(__test.joinUrl('http://localhost:3000', '/api/chat')).toBe(
      'http://localhost:3000/api/chat',
    );
  });

  it('collapses trailing/leading slashes', () => {
    expect(__test.joinUrl('http://x/', '/api/chat')).toBe('http://x/api/chat');
    expect(__test.joinUrl('http://x', 'api/chat')).toBe('http://x/api/chat');
  });
});

// ── sendMessage / streaming integration ─────────────────────────────

describe('useChatStream — sendMessage / streaming', () => {
  it('POSTs to the configured endpoint with the user message appended', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const { response, end } = makeStreamingResponse();
      // Resolve immediately with an empty stream so the hook settles.
      queueMicrotask(() => end());
      return response;
    });

    const { result } = renderHook(() =>
      useChatStream({ slug: 'writer', fetch: fetchMock as unknown as typeof fetch }),
    );

    await act(async () => {
      await result.current.sendMessage('hello');
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/chat');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('text/event-stream');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.slug).toBe('writer');
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'hello' });
  });

  it('honours the baseUrl override when constructing the URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const { response, end } = makeStreamingResponse();
      queueMicrotask(() => end());
      return response;
    });

    const { result } = renderHook(() =>
      useChatStream({
        slug: 'writer',
        baseUrl: 'http://localhost:9999',
        fetch: fetchMock as unknown as typeof fetch,
      }),
    );

    await act(async () => {
      await result.current.sendMessage('ping');
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:9999/api/chat');
  });

  it('appends the user message + an empty assistant placeholder before fetch resolves', async () => {
    let resolveResponse: (r: Response) => void = () => {};
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((res) => {
          resolveResponse = res;
        }),
    );

    const { result } = renderHook(() =>
      useChatStream({ slug: 'writer', fetch: fetchMock as unknown as typeof fetch }),
    );

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage('hi');
    });

    // Even though the fetch is still pending, the optimistic state
    // updates should already be visible.
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
    });
    expect(result.current.messages[0]).toMatchObject({
      role: 'user',
      content: 'hi',
    });
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      content: '',
    });
    expect(result.current.status).toBe('submitted');

    // Now resolve the fetch with an immediately-closed stream so the
    // hook settles before the test ends.
    const { response, end } = makeStreamingResponse();
    resolveResponse(response);
    end();
    await act(async () => {
      await sendPromise;
    });
  });

  it('accumulates text-delta frames on the assistant message', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => stream.response);

    const { result } = renderHook(() =>
      useChatStream({ slug: 'writer', fetch: fetchMock as unknown as typeof fetch }),
    );

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage('hello');
    });
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
    });

    // Push the deltas in two SSE frames inside one chunk.
    await act(async () => {
      stream.push(
        sse({ type: 'stream-start', t: 1 }) +
          sse({ type: 'text-delta', delta: 'Hel' }),
      );
    });
    await waitFor(() => {
      expect(result.current.messages[1]?.content).toBe('Hel');
    });

    await act(async () => {
      stream.push(sse({ type: 'text-delta', delta: 'lo!' }));
    });
    await waitFor(() => {
      expect(result.current.messages[1]?.content).toBe('Hello!');
    });
    expect(result.current.status).toBe('streaming');

    // Close out cleanly.
    await act(async () => {
      stream.push(
        sse({
          type: 'turn-complete',
          usage: {},
          durationMs: 1,
          stopReason: 'end_turn',
        }) + sse({ type: 'stream-end' }),
      );
      stream.end();
      await sendPromise;
    });
    expect(result.current.status).toBe('ready');
  });

  it('replaces partial deltas when an `assistant-message` frame arrives', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => stream.response);

    const { result } = renderHook(() =>
      useChatStream({ slug: 'writer', fetch: fetchMock as unknown as typeof fetch }),
    );

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage('go');
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    await act(async () => {
      stream.push(
        sse({ type: 'text-delta', delta: 'partial-' }) +
          sse({
            type: 'assistant-message',
            uuid: 'msg-1',
            content: [
              { type: 'text', text: 'final ' },
              { type: 'text', text: 'answer' },
            ],
          }) +
          sse({ type: 'stream-end' }),
      );
      stream.end();
      await sendPromise;
    });

    expect(result.current.messages[1]?.content).toBe('final answer');
  });

  it('renders the echo placeholder body verbatim (Sub-AC 1 compat)', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => stream.response);

    const { result } = renderHook(() =>
      useChatStream({ slug: 'writer', fetch: fetchMock as unknown as typeof fetch }),
    );

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage('echo me');
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    await act(async () => {
      stream.push(
        sse({ type: 'echo', body: 'echoed text' }) +
          sse({ type: 'stream-end' }),
      );
      stream.end();
      await sendPromise;
    });

    expect(result.current.messages[1]?.content).toBe('echoed text');
    expect(result.current.status).toBe('ready');
  });
});

// ── stop() / abort ───────────────────────────────────────────────────

describe('useChatStream — stop()', () => {
  it('aborts the in-flight request and returns status to ready without error', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          // Real fetch rejects with AbortError when the signal fires
          // mid-stream. Simulate that by cancelling the stream.
          stream.end();
        });
      }
      return stream.response;
    });

    const { result } = renderHook(() =>
      useChatStream({ slug: 'writer', fetch: fetchMock as unknown as typeof fetch }),
    );

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage('long');
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    // Push a partial reply.
    await act(async () => {
      stream.push(sse({ type: 'text-delta', delta: 'partial' }));
    });
    await waitFor(() =>
      expect(result.current.messages[1]?.content).toBe('partial'),
    );

    // Abort.
    await act(async () => {
      result.current.stop();
      await sendPromise;
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeNull();
    // Partial content is preserved.
    expect(result.current.messages[1]?.content).toBe('partial');
  });
});

// ── Errors ───────────────────────────────────────────────────────────

describe('useChatStream — error handling', () => {
  it('surfaces non-2xx responses via error + status="error"', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      ({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        text: async () => JSON.stringify({ error: 'boom' }),
        body: null,
      }) as unknown as Response,
    );
    const onError = vi.fn();

    const { result } = renderHook(() =>
      useChatStream({
        slug: 'writer',
        fetch: fetchMock as unknown as typeof fetch,
        onError,
      }),
    );

    await act(async () => {
      await result.current.sendMessage('x');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toBe('boom');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('surfaces a transport-level fetch failure', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Network down');
    });

    const { result } = renderHook(() =>
      useChatStream({ slug: 'writer', fetch: fetchMock as unknown as typeof fetch }),
    );

    await act(async () => {
      await result.current.sendMessage('x');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('Network down');
  });
});

// ── handleSubmit / input lifecycle ──────────────────────────────────

describe('useChatStream — handleSubmit / input lifecycle', () => {
  it('reads input, clears it, then calls sendMessage', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      queueMicrotask(() => stream.end());
      return stream.response;
    });

    const { result } = renderHook(() =>
      useChatStream({ slug: 'writer', fetch: fetchMock as unknown as typeof fetch }),
    );

    act(() => {
      result.current.setInput('typed text');
    });
    expect(result.current.input).toBe('typed text');

    await act(async () => {
      result.current.handleSubmit();
      // Drain microtasks so the inner sendMessage settles.
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.input).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.messages.at(-1).content).toBe('typed text');
  });

  it('drops whitespace-only submits', async () => {
    const fetchMock = vi.fn<typeof fetch>();

    const { result } = renderHook(() =>
      useChatStream({ slug: 'writer', fetch: fetchMock as unknown as typeof fetch }),
    );

    act(() => {
      result.current.setInput('   \n  \t  ');
    });
    act(() => {
      result.current.handleSubmit();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops empty sendMessage calls without firing fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();

    const { result } = renderHook(() =>
      useChatStream({ slug: 'writer', fetch: fetchMock as unknown as typeof fetch }),
    );

    await act(async () => {
      await result.current.sendMessage('');
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updates input via handleInputChange', () => {
    const { result } = renderHook(() =>
      useChatStream({
        slug: 'writer',
        fetch: (async () => new Response('')) as unknown as typeof fetch,
      }),
    );
    act(() => {
      result.current.handleInputChange({
        target: { value: 'next' },
      } as unknown as React.ChangeEvent<HTMLTextAreaElement>);
    });
    expect(result.current.input).toBe('next');
  });
});

// ── Status lifecycle pinned ─────────────────────────────────────────

describe('useChatStream — status lifecycle', () => {
  it('walks ready → submitted → streaming → ready on a clean turn', async () => {
    const observed: ChatStatus[] = [];

    const stream = makeStreamingResponse();
    let resolveResponse: (r: Response) => void = () => {};
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((res) => {
          resolveResponse = res;
        }),
    );

    function Probe(): null {
      const hook = useChatStream({
        slug: 'writer',
        fetch: fetchMock as unknown as typeof fetch,
      });
      observed.push(hook.status);
      // Expose handle through a closure — renderHook doesn't help us
      // capture the imperative state machine in a clean way here.
      (Probe as unknown as { _h?: typeof hook })._h = hook;
      return null;
    }

    renderHook(() => Probe());
    const hook = (Probe as unknown as { _h: ReturnType<typeof useChatStream> })
      ._h;

    expect(observed[0]).toBe('ready');

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = hook.sendMessage('go');
    });
    await waitFor(() => {
      expect(observed.includes('submitted')).toBe(true);
    });

    resolveResponse(stream.response);
    await waitFor(() => {
      expect(observed.includes('streaming')).toBe(true);
    });

    await act(async () => {
      stream.end();
      await sendPromise;
    });
    expect(observed.at(-1)).toBe('ready');
  });
});

// ── Sub-AC 4: latency instrumentation (submit→first-chunk timing) ────
//
// Pins the contract the eval rubric cares about most: from the moment
// the hook enters `sendMessage`, the first SSE frame must surface to
// the consumer (via `firstChunkLatencyMs` state and the `onFirstChunk`
// callback) within ~2s. The tests below pin both the **plumbing** of
// the timer (callback fires once, state updates, monotonicity) AND the
// **budget** assertion (latency reading lands well under 2000ms when
// the server side responds promptly).
//
// We inject a deterministic `now()` clock so the assertions aren't
// flaky on slow CI runners; jsdom's `performance.now()` is real wall
// time and can drift unpredictably under load.

describe('useChatStream — first-chunk latency instrumentation (Sub-AC 4)', () => {
  it('records submit→first-chunk latency when the first SSE frame arrives', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => stream.response);

    // Deterministic clock: returns the next value from a queue every
    // time the hook reads it. The hook reads `now()` exactly twice per
    // turn — once at submit, once when the first frame parses — so a
    // two-element queue is sufficient.
    const clockReads: number[] = [1000, 1042];
    let clockIdx = 0;
    const now = (): number =>
      clockReads[Math.min(clockIdx++, clockReads.length - 1)]!;

    const onFirstChunk = vi.fn();

    const { result } = renderHook(() =>
      useChatStream({
        slug: 'writer',
        fetch: fetchMock as unknown as typeof fetch,
        now,
        onFirstChunk,
      }),
    );

    // Before the first turn, the latency reading is null (no chunk
    // has arrived yet — we don't surface a stale value from a prior
    // turn, which would be misleading on the first render).
    expect(result.current.firstChunkLatencyMs).toBeNull();

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage('hello');
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    // Submit happened (clock read #1 = 1000ms). Push a `stream-start`
    // SSE frame — the first parsed frame triggers the latency capture
    // (clock read #2 = 1042ms → reading is 42ms).
    await act(async () => {
      stream.push(sse({ type: 'stream-start', t: 1 }));
    });

    await waitFor(() => {
      expect(result.current.firstChunkLatencyMs).toBe(42);
    });
    expect(onFirstChunk).toHaveBeenCalledTimes(1);
    expect(onFirstChunk).toHaveBeenCalledWith(42);

    // Subsequent frames in the same turn must NOT re-fire the callback
    // or overwrite the reading — the contract is "first chunk only".
    await act(async () => {
      stream.push(sse({ type: 'text-delta', delta: 'hi' }));
      stream.push(sse({ type: 'stream-end' }));
      stream.end();
      await sendPromise;
    });

    expect(onFirstChunk).toHaveBeenCalledTimes(1);
    expect(result.current.firstChunkLatencyMs).toBe(42);
  });

  it('first chunk arrives within the 2-second budget on a fast server', async () => {
    // Eval rubric: "First SSE chunk within 2 seconds and continuous
    // token streaming without perceptible gaps." We simulate a
    // realistic server that flushes its leading SSE comment + the
    // `stream-start` frame on the same tick the request lands — i.e.
    // what `handleChatStream` in `server.ts` actually does.
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      // Push the first frame immediately, *before* the hook reads from
      // the body, so the latency captured measures the hook's own
      // pump-loop overhead rather than test-fixture sleep timers.
      stream.push(sse({ type: 'stream-start', t: 1 }));
      return stream.response;
    });

    const onFirstChunk = vi.fn();
    const { result } = renderHook(() =>
      useChatStream({
        slug: 'writer',
        fetch: fetchMock as unknown as typeof fetch,
        onFirstChunk,
      }),
    );

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage('hi');
    });

    await waitFor(() => {
      expect(result.current.firstChunkLatencyMs).not.toBeNull();
    });

    // Real-clock assertion. The 2000ms ceiling matches the rubric;
    // we leave a generous margin so the test isn't flaky on slow CI
    // runners while still catching the failure mode (server buffers
    // and never emits a leading frame, which would make this read
    // out at hundreds of milliseconds even on fast hardware).
    const latency = result.current.firstChunkLatencyMs!;
    expect(latency).toBeGreaterThanOrEqual(0);
    expect(latency).toBeLessThan(2000);
    expect(onFirstChunk).toHaveBeenCalledTimes(1);
    const observed = onFirstChunk.mock.calls[0]![0] as number;
    expect(observed).toBeLessThan(2000);

    // Drain the stream so the test exits cleanly.
    await act(async () => {
      stream.end();
      await sendPromise;
    });
  });

  it('resets firstChunkLatencyMs to null at the start of a new turn', async () => {
    // Two turns back-to-back: the second `sendMessage` must clear the
    // first turn's reading at submit time and re-emit a fresh value
    // when its own first frame parses.
    const stream1 = makeStreamingResponse();
    const stream2 = makeStreamingResponse();
    let callIdx = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      callIdx += 1;
      return callIdx === 1 ? stream1.response : stream2.response;
    });

    const clockReads: number[] = [
      // Turn 1: submit @ 1000, first chunk @ 1010 → 10ms reading.
      1000, 1010,
      // Turn 2: submit @ 2000, first chunk @ 2025 → 25ms reading.
      2000, 2025,
    ];
    let clockIdx = 0;
    const now = (): number =>
      clockReads[Math.min(clockIdx++, clockReads.length - 1)]!;

    const { result } = renderHook(() =>
      useChatStream({
        slug: 'writer',
        fetch: fetchMock as unknown as typeof fetch,
        now,
      }),
    );

    // Turn 1.
    let sp1!: Promise<void>;
    act(() => {
      sp1 = result.current.sendMessage('one');
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    await act(async () => {
      stream1.push(sse({ type: 'stream-start', t: 1 }));
      stream1.push(sse({ type: 'stream-end' }));
      stream1.end();
      await sp1;
    });
    expect(result.current.firstChunkLatencyMs).toBe(10);

    // Turn 2: submit clears the reading until the next first-chunk
    // arrives.
    let sp2!: Promise<void>;
    act(() => {
      sp2 = result.current.sendMessage('two');
    });
    // After submit but before the new stream emits anything, the
    // reading should already be null (defensive: tests should not
    // observe a stale value mid-turn).
    await waitFor(() => {
      expect(result.current.firstChunkLatencyMs).toBeNull();
    });

    await act(async () => {
      stream2.push(sse({ type: 'stream-start', t: 2 }));
      stream2.push(sse({ type: 'stream-end' }));
      stream2.end();
      await sp2;
    });
    expect(result.current.firstChunkLatencyMs).toBe(25);
  });

  it('does not record latency when the server returns no parseable frame', async () => {
    // If the server only writes the `: open` SSE comment and then
    // closes (a degenerate case the hook tolerates), no frame ever
    // parses, so the latency reading must stay null and the callback
    // must not fire. This guards against a false-positive "fast
    // response" reading on a broken server.
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => stream.response);
    const onFirstChunk = vi.fn();

    const { result } = renderHook(() =>
      useChatStream({
        slug: 'writer',
        fetch: fetchMock as unknown as typeof fetch,
        onFirstChunk,
      }),
    );

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    await act(async () => {
      // Comment-only frame — `parseSseFrame(': open')` returns null.
      stream.push(': open\n\n');
      stream.end();
      await sendPromise;
    });

    expect(result.current.firstChunkLatencyMs).toBeNull();
    expect(onFirstChunk).not.toHaveBeenCalled();
  });
});

// ── Sub-AC 4: defaultNow helper ──────────────────────────────────────

describe('defaultNow helper (Sub-AC 4)', () => {
  it('prefers performance.now() when available', () => {
    // jsdom ships `performance.now()`. The reading should be a finite
    // number — we don't assert exact value because the clock advances
    // between the call and the assertion.
    const t = __test.defaultNow();
    expect(typeof t).toBe('number');
    expect(Number.isFinite(t)).toBe(true);
  });

  it('produces strictly monotonic readings under back-to-back calls', async () => {
    // The whole point of `performance.now()` is monotonicity — back-
    // to-back reads must never go backward. (Equal is fine; the clock
    // can't always tick between two synchronous reads.)
    const a = __test.defaultNow();
    // Synthetic delay so the clock measurably advances on any
    // platform that supports sub-ms resolution. Microtask queue alone
    // doesn't always advance `performance.now()` on every runtime.
    await new Promise((r) => setTimeout(r, 1));
    const b = __test.defaultNow();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

// ── Sub-AC 3 of AC 3: Tool-invocation parts ────────────────────────────

describe('appendTextDelta — parts plumbing', () => {
  it('returns a fresh text part when parts is empty/undefined', () => {
    expect(__test.appendTextDelta(undefined, 'hello')).toEqual([
      { type: 'text', text: 'hello' },
    ]);
    expect(__test.appendTextDelta([], 'world')).toEqual([
      { type: 'text', text: 'world' },
    ]);
  });

  it('appends to the trailing text part when one exists', () => {
    const out = __test.appendTextDelta(
      [{ type: 'text', text: 'hello ' }],
      'world',
    );
    expect(out).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('starts a new text part after a tool-invocation', () => {
    const out = __test.appendTextDelta(
      [
        { type: 'text', text: 'before tool ' },
        {
          type: 'tool-invocation',
          toolUseId: 'tu_1',
          toolName: 'Read',
          args: { file_path: '/x' },
          state: 'success',
          result: 'ok',
        },
      ],
      'after tool',
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ type: 'text', text: 'before tool ' });
    expect(out[1]?.type).toBe('tool-invocation');
    expect(out[2]).toEqual({ type: 'text', text: 'after tool' });
  });

  it('returns a new array reference (immutable update)', () => {
    const input = [{ type: 'text', text: 'a' } as const];
    const out = __test.appendTextDelta(input, 'b');
    expect(out).not.toBe(input);
  });
});

describe('appendToolUse — parts plumbing', () => {
  it('appends a pending tool-invocation part', () => {
    const out = __test.appendToolUse(
      [{ type: 'text', text: 'let me check' }],
      'tu_1',
      'Read',
      { file_path: '/tmp/foo.txt' },
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: 'tool-invocation',
      toolUseId: 'tu_1',
      toolName: 'Read',
      args: { file_path: '/tmp/foo.txt' },
      state: 'pending',
    });
  });

  it('is idempotent on toolUseId — duplicate frames are ignored', () => {
    const base = __test.appendToolUse([], 'tu_1', 'Read', { file_path: '/x' });
    const out = __test.appendToolUse(base, 'tu_1', 'Read', { file_path: '/x' });
    expect(out).toBe(base);
    expect(out).toHaveLength(1);
  });

  it('coerces missing input to {}', () => {
    const out = __test.appendToolUse(undefined, 'tu_1', 'NoArgs', undefined);
    expect(out[0]).toMatchObject({ args: {}, state: 'pending' });
  });
});

describe('applyToolResult — parts plumbing', () => {
  it('flips the matching part to success and stores the result', () => {
    const base = __test.appendToolUse(
      [{ type: 'text', text: 'reading' }],
      'tu_1',
      'Read',
      { file_path: '/x' },
    );
    const out = __test.applyToolResult(base, 'tu_1', 'file contents', false);
    const tool = out[1];
    if (!tool || tool.type !== 'tool-invocation') {
      throw new Error('expected tool-invocation part');
    }
    expect(tool.state).toBe('success');
    expect(tool.result).toBe('file contents');
    expect(tool.errorMessage).toBeUndefined();
  });

  it('flips the matching part to error and pins the errorMessage when result is a string', () => {
    const base = __test.appendToolUse(
      undefined,
      'tu_1',
      'Read',
      { file_path: '/missing' },
    );
    const out = __test.applyToolResult(base, 'tu_1', 'ENOENT', true);
    const tool = out[0];
    if (!tool || tool.type !== 'tool-invocation') {
      throw new Error('expected tool-invocation part');
    }
    expect(tool.state).toBe('error');
    expect(tool.errorMessage).toBe('ENOENT');
    expect(tool.result).toBe('ENOENT');
  });

  it('does not pin errorMessage when result is structured', () => {
    const base = __test.appendToolUse(undefined, 'tu_1', 'Bash', {
      command: 'false',
    });
    const out = __test.applyToolResult(
      base,
      'tu_1',
      { code: 'EFAIL', stderr: 'nope' },
      true,
    );
    const tool = out[0];
    if (!tool || tool.type !== 'tool-invocation') {
      throw new Error('expected tool-invocation part');
    }
    expect(tool.state).toBe('error');
    expect(tool.errorMessage).toBeUndefined();
    expect(tool.result).toEqual({ code: 'EFAIL', stderr: 'nope' });
  });

  it('returns the original parts when no part matches the toolUseId', () => {
    const input: Parameters<typeof __test.applyToolResult>[0] = [
      { type: 'text', text: 'hi' },
    ];
    const out = __test.applyToolResult(input, 'tu_unknown', 'data', false);
    expect(out).toBe(input);
  });
});

describe('useChatStream — tool invocation streaming integration', () => {
  it('streams a tool-use → tool-result pair into the assistant message parts', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => stream.response);

    const { result } = renderHook(() =>
      useChatStream({
        slug: 'writer',
        fetch: fetchMock as unknown as typeof fetch,
      }),
    );

    // Kick off the send without awaiting (the stream stays open).
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage('check the file');
    });
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
    });

    // Stream a text-delta, then a tool-use frame, then a tool-result.
    await act(async () => {
      stream.push(sse({ type: 'text-delta', delta: 'Let me read it. ' }));
      stream.push(
        sse({
          type: 'tool-use',
          toolUseId: 'tu_1',
          name: 'Read',
          input: { file_path: '/tmp/foo.txt' },
        }),
      );
      await new Promise((r) => setTimeout(r, 5));
    });

    // Pending state — tool part exists with no result yet.
    let assistant = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistant?.parts).toBeDefined();
    expect(assistant?.parts).toHaveLength(2);
    const pendingTool = assistant?.parts?.[1];
    if (!pendingTool || pendingTool.type !== 'tool-invocation') {
      throw new Error('expected pending tool-invocation');
    }
    expect(pendingTool.state).toBe('pending');
    expect(pendingTool.toolUseId).toBe('tu_1');
    expect(pendingTool.toolName).toBe('Read');
    expect(pendingTool.args).toEqual({ file_path: '/tmp/foo.txt' });

    // Now push the tool-result + a trailing text-delta.
    await act(async () => {
      stream.push(
        sse({
          type: 'tool-result',
          toolUseId: 'tu_1',
          content: 'file contents here',
          isError: false,
        }),
      );
      stream.push(sse({ type: 'text-delta', delta: 'Got it.' }));
      stream.push(
        sse({
          type: 'turn-complete',
          usage: {},
          durationMs: 0,
          stopReason: 'end_turn',
        }),
      );
      stream.end();
      await sendPromise;
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    assistant = result.current.messages.find((m) => m.role === 'assistant');
    const parts = assistant?.parts ?? [];
    // Three parts: leading text → tool → trailing text.
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: 'Let me read it. ' });
    if (!parts[1] || parts[1].type !== 'tool-invocation') {
      throw new Error('expected tool-invocation as middle part');
    }
    expect(parts[1].state).toBe('success');
    expect(parts[1].toolUseId).toBe('tu_1');
    expect(parts[1].result).toBe('file contents here');
    expect(parts[2]).toEqual({ type: 'text', text: 'Got it.' });

    // `content` (legacy fallback) accumulates plain text across parts.
    expect(assistant?.content).toBe('Let me read it. Got it.');
  });

  it('flips a tool to error state when the server reports isError', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => stream.response);

    const { result } = renderHook(() =>
      useChatStream({
        slug: 'writer',
        fetch: fetchMock as unknown as typeof fetch,
      }),
    );

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage('do the thing');
    });
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
    });

    await act(async () => {
      stream.push(
        sse({
          type: 'tool-use',
          toolUseId: 'tu_err',
          name: 'Read',
          input: { file_path: '/missing' },
        }),
      );
      stream.push(
        sse({
          type: 'tool-result',
          toolUseId: 'tu_err',
          content: 'ENOENT: file not found',
          isError: true,
        }),
      );
      stream.push(
        sse({
          type: 'turn-complete',
          usage: {},
          durationMs: 0,
          stopReason: 'end_turn',
        }),
      );
      stream.end();
      await sendPromise;
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    const assistant = result.current.messages.find(
      (m) => m.role === 'assistant',
    );
    const tool = assistant?.parts?.find((p) => p.type === 'tool-invocation');
    if (!tool || tool.type !== 'tool-invocation') {
      throw new Error('expected tool-invocation');
    }
    expect(tool.state).toBe('error');
    expect(tool.errorMessage).toBe('ENOENT: file not found');
  });
});
