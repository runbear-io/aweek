/**
 * Tests for the chat data layer (`src/serve/data/chat.ts`).
 *
 * Sub-AC 2 of AC 1: the chat module wires the Anthropic Agent SDK so
 * that streaming response generation begins **without buffering before
 * first token**. These tests exercise the dependency-injection seam
 * (`runQuery`) so the non-buffering invariant is verified without
 * invoking the real `claude` CLI.
 *
 * Coverage:
 *   - First `ChatStreamEvent` is yielded as soon as the SDK emits its
 *     first message (no "wait for end" pattern in `streamAgentTurn`).
 *   - `system` `init`            → `agent-init`
 *   - `stream_event` text-delta  → `text-delta`
 *   - `assistant` w/ tool_use    → `assistant-message` + `tool-use`
 *   - `user` w/ tool_result      → `tool-result`
 *   - `result`                   → `turn-complete`
 *   - SDK iterator throw         → `turn-error` (no rethrow)
 *   - `AbortSignal` already aborted → no events yielded
 *   - `AbortSignal` fires mid-stream → iteration breaks cleanly
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { streamAgentTurn, type AgentSdkRunner, type ChatStreamEvent } from './chat.js';
import type { Options as AgentSdkOptions } from '@anthropic-ai/claude-agent-sdk';

/** Drain a chat-event async generator into an array. */
async function drain(
  gen: AsyncGenerator<ChatStreamEvent, void, void>,
): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/**
 * Build a fake Agent SDK runner from a fixture array. The runner
 * yields each fixture message in its own JS microtask tick so a
 * non-buffering consumer sees events arrive over time rather than all
 * at once.
 */
function makeRunner(messages: unknown[]): AgentSdkRunner {
  return () => {
    const iter = (async function* () {
      for (const m of messages) {
        // Yield each message on a new microtask so a buffering
        // consumer would visibly stall on the first one.
        await Promise.resolve();
        yield m as never;
      }
    })();
    return iter;
  };
}

describe('streamAgentTurn — non-buffering streaming', () => {
  it('yields the first event before the SDK iterator finishes', async () => {
    // Hold the second SDK message indefinitely until we explicitly
    // resolve it — if `streamAgentTurn` is buffering, the first chat
    // event will never arrive at the consumer.
    let releaseSecond: () => void = () => {};
    const second = new Promise<void>((res) => {
      releaseSecond = res;
    });

    const runner: AgentSdkRunner = () =>
      (async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
          tools: ['Read'],
          cwd: '/tmp/proj',
        } as never;
        await second;
        yield {
          type: 'result',
          subtype: 'success',
          duration_ms: 42,
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        } as never;
      })();

    const gen = streamAgentTurn({
      slug: 'writer',
      messages: [{ role: 'user', content: 'hello' }],
      runQuery: runner,
    });

    // Ask for one event — should resolve to the agent-init translation
    // even though the SDK iterator is parked on the second message.
    const first = await gen.next();
    assert.equal(first.done, false);
    if (first.done) return;
    assert.equal(first.value.type, 'agent-init');
    if (first.value.type === 'agent-init') {
      assert.equal(first.value.sessionId, 'sess-1');
      assert.deepEqual(first.value.tools, ['Read']);
    }

    // Now release the second SDK message and drain.
    releaseSecond();
    const rest = await drain(gen);
    assert.equal(rest.at(-1)?.type, 'turn-complete');
  });

  it('translates a complete turn fixture into the expected event sequence', async () => {
    const fixtures: unknown[] = [
      {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-2',
        tools: ['Read', 'Bash'],
        cwd: '/tmp/proj',
      },
      {
        type: 'stream_event',
        uuid: 'msg-1',
        session_id: 'sess-2',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hel' },
        },
      },
      {
        type: 'stream_event',
        uuid: 'msg-1',
        session_id: 'sess-2',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'lo!' },
        },
      },
      {
        type: 'assistant',
        uuid: 'msg-1',
        session_id: 'sess-2',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'text', text: 'Hello!' },
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'Read',
              input: { path: '/tmp/x.txt' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'msg-2',
        session_id: 'sess-2',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file body', is_error: false },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        stop_reason: 'end_turn',
        total_cost_usd: 0.0123,
        usage: {
          input_tokens: 50,
          output_tokens: 20,
          cache_read_input_tokens: 5,
        },
      },
    ];

    const events = await drain(
      streamAgentTurn({
        slug: 'writer',
        messages: [{ role: 'user', content: 'hi' }],
        runQuery: makeRunner(fixtures),
      }),
    );

    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      'agent-init',
      'text-delta',
      'text-delta',
      'assistant-message',
      'tool-use',
      'tool-result',
      'turn-complete',
    ]);

    const deltas = events.filter((e) => e.type === 'text-delta');
    assert.equal(deltas.length, 2);
    if (deltas[0].type === 'text-delta') assert.equal(deltas[0].delta, 'Hel');
    if (deltas[1].type === 'text-delta') assert.equal(deltas[1].delta, 'lo!');

    const toolUse = events.find((e) => e.type === 'tool-use');
    assert.ok(toolUse);
    if (toolUse && toolUse.type === 'tool-use') {
      assert.equal(toolUse.toolUseId, 'tu-1');
      assert.equal(toolUse.name, 'Read');
      assert.deepEqual(toolUse.input, { path: '/tmp/x.txt' });
    }

    const toolResult = events.find((e) => e.type === 'tool-result');
    assert.ok(toolResult);
    if (toolResult && toolResult.type === 'tool-result') {
      assert.equal(toolResult.toolUseId, 'tu-1');
      assert.equal(toolResult.content, 'file body');
      assert.equal(toolResult.isError, false);
    }

    const complete = events.find((e) => e.type === 'turn-complete');
    assert.ok(complete);
    if (complete && complete.type === 'turn-complete') {
      assert.equal(complete.usage.inputTokens, 50);
      assert.equal(complete.usage.outputTokens, 20);
      assert.equal(complete.usage.cacheReadTokens, 5);
      assert.equal(complete.usage.totalCostUsd, 0.0123);
      assert.equal(complete.durationMs, 100);
      assert.equal(complete.stopReason, 'end_turn');
    }
  });

  it('emits turn-error when the SDK iterator throws', async () => {
    const runner: AgentSdkRunner = () =>
      (async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-err',
          tools: [],
          cwd: '/tmp',
        } as never;
        throw new Error('rate_limit');
      })();

    const events = await drain(
      streamAgentTurn({
        slug: 'writer',
        messages: [{ role: 'user', content: 'go' }],
        runQuery: runner,
      }),
    );

    assert.equal(events.at(-1)?.type, 'turn-error');
    const err = events.at(-1);
    if (err && err.type === 'turn-error') {
      assert.equal(err.error, 'rate_limit');
    }
  });

  it('exits silently when the abort signal is already fired', async () => {
    const ac = new AbortController();
    ac.abort();
    const runner: AgentSdkRunner = () =>
      (async function* () {
        // Should never run — pre-aborted streamAgentTurn returns early.
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 's',
          tools: [],
          cwd: '/',
        } as never;
      })();

    const events = await drain(
      streamAgentTurn({
        slug: 'writer',
        messages: [{ role: 'user', content: 'x' }],
        runQuery: runner,
        signal: ac.signal,
      }),
    );

    assert.deepEqual(events, []);
  });

  it('breaks cleanly when the abort signal fires mid-stream', async () => {
    const ac = new AbortController();
    const runner: AgentSdkRunner = () =>
      (async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 's',
          tools: [],
          cwd: '/',
        } as never;
        // Abort mid-stream so the next iteration boundary breaks.
        ac.abort();
        yield {
          type: 'result',
          subtype: 'success',
          duration_ms: 1,
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        } as never;
      })();

    const events = await drain(
      streamAgentTurn({
        slug: 'writer',
        messages: [{ role: 'user', content: 'x' }],
        runQuery: runner,
        signal: ac.signal,
      }),
    );

    // Only the agent-init survives — the post-abort `result` is
    // skipped by the loop's `if (aborted) break` guard.
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'agent-init');
  });
});

// ---------------------------------------------------------------------------
// Sub-AC 3 of AC 6 — systemPromptAppend wiring
//
// The chat handler decides per-turn whether to inject the auto-built
// preamble (only on the first system turn of each thread). The
// translator's job is just to pass the string through to the Agent SDK
// runner via `options.systemPrompt = { type: 'preset', preset: 'claude_code',
// append: <preamble> }`. These tests pin that contract.
// ---------------------------------------------------------------------------

describe('streamAgentTurn — systemPromptAppend wiring (Sub-AC 3 of AC 6)', () => {
  /**
   * Build a runner that captures the options it was invoked with so the
   * test can assert on the SDK options shape without mocking the SDK
   * itself.
   */
  function makeOptionsCapturingRunner(): {
    runner: AgentSdkRunner;
    captured: { options: AgentSdkOptions | undefined };
  } {
    const captured: { options: AgentSdkOptions | undefined } = {
      options: undefined,
    };
    const runner: AgentSdkRunner = (params) => {
      captured.options = params.options;
      const iter = (async function* () {
        await Promise.resolve();
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-prefix',
          tools: [],
          cwd: '/tmp',
        } as never;
        yield {
          type: 'result',
          subtype: 'success',
          duration_ms: 1,
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        } as never;
      })();
      return iter;
    };
    return { runner, captured };
  }

  it('passes systemPromptAppend through as preset+append on options.systemPrompt', async () => {
    const { runner, captured } = makeOptionsCapturingRunner();
    await drain(
      streamAgentTurn({
        slug: 'writer',
        messages: [{ role: 'user', content: 'hello' }],
        runQuery: runner,
        systemPromptAppend: '# Preamble\n\nAgent context goes here.',
      }),
    );
    assert.ok(captured.options, 'expected options to be captured');
    assert.deepEqual(captured.options?.systemPrompt, {
      type: 'preset',
      preset: 'claude_code',
      append: '# Preamble\n\nAgent context goes here.',
    });
  });

  it('does not set options.systemPrompt when systemPromptAppend is omitted', async () => {
    const { runner, captured } = makeOptionsCapturingRunner();
    await drain(
      streamAgentTurn({
        slug: 'writer',
        messages: [{ role: 'user', content: 'hello' }],
        runQuery: runner,
      }),
    );
    assert.ok(captured.options, 'expected options to be captured');
    assert.equal(captured.options?.systemPrompt, undefined);
  });

  it('does not set options.systemPrompt when systemPromptAppend is the empty string', async () => {
    const { runner, captured } = makeOptionsCapturingRunner();
    await drain(
      streamAgentTurn({
        slug: 'writer',
        messages: [{ role: 'user', content: 'hello' }],
        runQuery: runner,
        systemPromptAppend: '',
      }),
    );
    assert.ok(captured.options, 'expected options to be captured');
    assert.equal(captured.options?.systemPrompt, undefined);
  });
});
