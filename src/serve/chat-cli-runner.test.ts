/**
 * Tests for the chat CLI runner — src/serve/data/chat-cli-runner.ts.
 *
 * Drives a fake spawned child (no real `gemini` / `hermes` binary) and
 * asserts the ChatStreamEvent sequence the SSE handler consumes:
 *   - gemini → NDJSON stream-json lines map to agent-init / text-delta /
 *     tool-use / tool-result / turn-complete (usage from `stats`),
 *   - hermes → one-shot final text becomes a single text-delta +
 *     turn-complete (zero usage),
 * plus argv / YOLO-flag / binary assertions and the streamAgentTurn
 * dispatch that routes non-Claude runners here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { streamCliRunnerTurn } from './chat-cli-runner.js';
import { streamAgentTurn, type ChatStreamEvent } from './data/chat.js';
import type { SpawnFn } from '../execution/cli-session.js';

interface MockChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: (signal?: string) => boolean;
}

interface SpawnCall {
  cmd: string;
  args: ReadonlyArray<string>;
  opts: { cwd?: string; env?: NodeJS.ProcessEnv };
}

/**
 * Fake spawn that pushes the given stdout lines then closes with
 * `exitCode`. Captures the last spawn call for argv/env assertions.
 */
function makeMockSpawn({
  stdoutLines = [],
  stderr = '',
  exitCode = 0,
}: {
  stdoutLines?: string[];
  stderr?: string;
  exitCode?: number;
} = {}): SpawnFn & { lastCall: () => SpawnCall | null } {
  let lastCall: SpawnCall | null = null;
  const fn = ((cmd: string, args: ReadonlyArray<string>, opts: SpawnCall['opts']) => {
    lastCall = { cmd, args, opts };
    const child = new EventEmitter() as MockChild;
    const stdout = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });
    child.stdout = stdout;
    child.stderr = stderrStream;
    child.kill = () => {
      setImmediate(() => child.emit('close', null));
      return true;
    };
    setImmediate(() => {
      for (const line of stdoutLines) stdout.push(line + '\n');
      stdout.push(null);
      if (stderr) stderrStream.push(stderr);
      stderrStream.push(null);
      setImmediate(() => child.emit('close', exitCode));
    });
    return child;
  }) as unknown as SpawnFn & { lastCall: () => SpawnCall | null };
  fn.lastCall = () => lastCall;
  return fn;
}

async function collect(
  gen: AsyncGenerator<ChatStreamEvent, void, void>,
): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('streamCliRunnerTurn — gemini', () => {
  const geminiLines = [
    JSON.stringify({ type: 'init', session_id: 'g-sess', model: 'gemini-2.5-pro', cwd: '/proj' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello ', delta: true }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'world', delta: true }),
    JSON.stringify({ type: 'tool_use', tool_name: 'Read', tool_id: 't1', parameters: { path: 'x' } }),
    JSON.stringify({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'file body' }),
    JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 40, output_tokens: 12, total_tokens: 52 } }),
  ];

  it('spawns the gemini binary with stream-json + YOLO flags', async () => {
    const spawnFn = makeMockSpawn({ stdoutLines: geminiLines });
    await collect(
      streamCliRunnerTurn({ runner: 'gemini', prompt: 'hi', slug: 'no-such-agent', spawnFn }),
    );
    const call = spawnFn.lastCall()!;
    assert.equal(call.cmd, 'gemini');
    assert.ok(call.args.includes('--output-format'));
    assert.ok(call.args.includes('stream-json'));
    assert.ok(call.args.includes('--yolo'));
    assert.ok(call.args.includes('--skip-trust'));
    const pIdx = call.args.indexOf('--prompt');
    assert.equal(call.args[pIdx + 1], 'hi');
  });

  it('translates the NDJSON stream into ChatStreamEvents', async () => {
    const spawnFn = makeMockSpawn({ stdoutLines: geminiLines });
    const events = await collect(
      streamCliRunnerTurn({ runner: 'gemini', prompt: 'hi', slug: 'no-such-agent', spawnFn }),
    );
    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      'agent-init',
      'text-delta',
      'text-delta',
      'tool-use',
      'tool-result',
      'turn-complete',
    ]);
    const deltas = events.filter((e) => e.type === 'text-delta') as Extract<ChatStreamEvent, { type: 'text-delta' }>[];
    assert.equal(deltas.map((d) => d.delta).join(''), 'Hello world');
    // Both deltas share one messageUuid so the handler accumulates them.
    assert.equal(deltas[0]!.messageUuid, deltas[1]!.messageUuid);
    const complete = events.find((e) => e.type === 'turn-complete') as Extract<ChatStreamEvent, { type: 'turn-complete' }>;
    assert.equal(complete.usage.inputTokens, 40);
    assert.equal(complete.usage.outputTokens, 12);
  });

  it('emits turn-error when gemini exits non-zero without a result event', async () => {
    const spawnFn = makeMockSpawn({ stdoutLines: [], stderr: 'GEMINI_API_KEY missing', exitCode: 41 });
    const events = await collect(
      streamCliRunnerTurn({ runner: 'gemini', prompt: 'hi', slug: 'x', spawnFn }),
    );
    const err = events.find((e) => e.type === 'turn-error') as Extract<ChatStreamEvent, { type: 'turn-error' }>;
    assert.ok(err);
    assert.match(err.error, /GEMINI_API_KEY missing/);
  });
});

describe('streamCliRunnerTurn — hermes', () => {
  it('spawns hermes --oneshot with YOLO flags and emits final text + turn-complete', async () => {
    const spawnFn = makeMockSpawn({ stdoutLines: ['The answer', 'is 42.'], exitCode: 0 });
    const events = await collect(
      streamCliRunnerTurn({ runner: 'hermes', prompt: 'q', slug: 'no-such-agent', spawnFn }),
    );
    const call = spawnFn.lastCall()!;
    assert.equal(call.cmd, 'hermes');
    assert.ok(call.args.includes('--oneshot'));
    assert.ok(call.args.includes('--yolo'));
    assert.ok(call.args.includes('--accept-hooks'));

    const types = events.map((e) => e.type);
    assert.deepEqual(types, ['agent-init', 'text-delta', 'turn-complete']);
    const delta = events.find((e) => e.type === 'text-delta') as Extract<ChatStreamEvent, { type: 'text-delta' }>;
    assert.equal(delta.delta, 'The answer\nis 42.');
    const complete = events.find((e) => e.type === 'turn-complete') as Extract<ChatStreamEvent, { type: 'turn-complete' }>;
    assert.equal(complete.usage.inputTokens, 0);
    assert.equal(complete.usage.outputTokens, 0);
  });

  it('emits turn-error when hermes exits non-zero with no output', async () => {
    const spawnFn = makeMockSpawn({ stdoutLines: [], stderr: 'no provider configured', exitCode: 1 });
    const events = await collect(
      streamCliRunnerTurn({ runner: 'hermes', prompt: 'q', slug: 'x', spawnFn }),
    );
    const err = events.find((e) => e.type === 'turn-error') as Extract<ChatStreamEvent, { type: 'turn-error' }>;
    assert.ok(err);
    assert.match(err.error, /no provider configured/);
  });
});

describe('streamAgentTurn dispatch', () => {
  it('routes runner="gemini" to the CLI runner (not the Agent SDK)', async () => {
    const spawnFn = makeMockSpawn({
      stdoutLines: [
        JSON.stringify({ type: 'message', role: 'assistant', content: 'hi from gemini', delta: true }),
        JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 1, output_tokens: 2 } }),
      ],
    });
    // runQuery would throw if the Agent SDK path were taken — proving dispatch.
    const runQuery = () => {
      throw new Error('Agent SDK path must not run for gemini');
    };
    const events = await collect(
      streamAgentTurn({
        slug: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        runner: 'gemini',
        spawnCli: spawnFn,
        runQuery,
      }),
    );
    assert.equal(spawnFn.lastCall()!.cmd, 'gemini');
    assert.ok(events.some((e) => e.type === 'text-delta'));
  });

  it('routes runner="hermes" to the CLI runner', async () => {
    const spawnFn = makeMockSpawn({ stdoutLines: ['hermes reply'], exitCode: 0 });
    const events = await collect(
      streamAgentTurn({
        slug: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        runner: 'hermes',
        spawnCli: spawnFn,
      }),
    );
    assert.equal(spawnFn.lastCall()!.cmd, 'hermes');
    const delta = events.find((e) => e.type === 'text-delta') as Extract<ChatStreamEvent, { type: 'text-delta' }>;
    assert.equal(delta.delta, 'hermes reply');
  });

  it('uses the Agent SDK runner for runner="claude" (default path)', async () => {
    let sdkCalled = false;
    async function* fakeSdk() {
      sdkCalled = true;
      yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5, stop_reason: 'end_turn' } as never;
    }
    const events = await collect(
      streamAgentTurn({
        slug: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        runner: 'claude',
        runQuery: () => fakeSdk(),
      }),
    );
    assert.equal(sdkCalled, true);
    assert.ok(events.some((e) => e.type === 'turn-complete'));
  });
});
