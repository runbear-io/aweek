/**
 * Tests for the Gemini/Hermes Slack backend — spawns the runner CLI,
 * translates its output into agentchannels AgentStreamEvents, and keeps
 * per-thread memory via the transcript store.
 *
 * src/channels/slack/project-runner-backend.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentStreamEvent, ThreadContext } from 'agentchannels';

import {
  ProjectRunnerBackend,
  createRunnerSlackBackend,
  formatTranscriptPrompt,
} from './project-runner-backend.js';
import { loadSlackTranscript } from '../../storage/slack-transcript-store.js';
import type { SpawnFn } from '../../execution/cli-session.js';

interface SpawnCall {
  cmd: string;
  args: ReadonlyArray<string>;
}

function makeMockSpawn(stdoutLines: string[], exitCode = 0): SpawnFn & {
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const fn = ((cmd: string, args: ReadonlyArray<string>) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: () => boolean;
    };
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {
      setImmediate(() => child.emit('close', null));
      return true;
    };
    setImmediate(() => {
      for (const l of stdoutLines) stdout.push(l + '\n');
      stdout.push(null);
      stderr.push(null);
      setImmediate(() => child.emit('close', exitCode));
    });
    return child;
  }) as unknown as SpawnFn & { calls: SpawnCall[] };
  fn.calls = calls;
  return fn;
}

const THREAD: ThreadContext = {
  adapterName: 'slack',
  channelId: 'C1',
  threadId: 'T1',
  userId: 'U1',
  threadKey: 'slack:C1:T1',
};

async function collect(it: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

async function tempProject(): Promise<{ base: string; root: string; dataDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'aweek-runner-backend-'));
  const dataDir = join(base, '.aweek', 'agents');
  await mkdir(dataDir, { recursive: true });
  return { base, root: base, dataDir };
}

describe('formatTranscriptPrompt', () => {
  it('sends a lone opening turn verbatim', () => {
    assert.equal(formatTranscriptPrompt([], 'hello'), 'hello');
  });
  it('renders a User/Assistant transcript ending on an Assistant cue', () => {
    const p = formatTranscriptPrompt(
      [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
      ],
      'q2',
    );
    assert.equal(p, 'User: q1\n\nAssistant: a1\n\nUser: q2\n\nAssistant:');
  });
});

describe('ProjectRunnerBackend — gemini', () => {
  it('translates gemini stream-json into AgentStreamEvents and persists memory', async () => {
    const { base, root, dataDir } = await tempProject();
    try {
      const spawnFn = makeMockSpawn([
        JSON.stringify({ type: 'init', session_id: 'g1', cwd: root }),
        JSON.stringify({ type: 'message', role: 'assistant', content: 'Hi ', delta: true }),
        JSON.stringify({ type: 'message', role: 'assistant', content: 'there', delta: true }),
        JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 7, output_tokens: 3 } }),
      ]);
      let resultUsage: { inputTokens: number; outputTokens: number } | null = null;
      const backend = new ProjectRunnerBackend({
        projectRoot: root,
        dataDir,
        thread: THREAD,
        runner: 'gemini',
        spawnFn,
        onResult: (info) => {
          resultUsage = { inputTokens: info.usage.inputTokens, outputTokens: info.usage.outputTokens };
        },
      });

      const events = await collect(backend.sendMessage('hello'));
      const types = events.map((e) => e.type);
      assert.deepEqual(types, ['text_delta', 'text_delta', 'done']);
      assert.equal(
        events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join(''),
        'Hi there',
      );
      // Spawned gemini (not claude).
      assert.equal(spawnFn.calls[0]!.cmd, 'gemini');
      // Usage surfaced for the Slack usage bucket.
      assert.deepEqual(resultUsage, { inputTokens: 7, outputTokens: 3 });

      // Memory persisted: user + assistant turns.
      const rec = await loadSlackTranscript(dataDir, THREAD.threadKey);
      assert.ok(rec);
      assert.deepEqual(rec!.messages, [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Hi there' },
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('replays prior transcript into the next turn prompt (memory)', async () => {
    const { base, root, dataDir } = await tempProject();
    try {
      const first = makeMockSpawn([
        JSON.stringify({ type: 'message', role: 'assistant', content: 'blue', delta: true }),
        JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 1, output_tokens: 1 } }),
      ]);
      const backend = new ProjectRunnerBackend({ projectRoot: root, dataDir, thread: THREAD, runner: 'gemini', spawnFn: first });
      await collect(backend.sendMessage('what colour is the sky?'));

      // Second turn: a fresh spawn; assert the prompt carries the prior turns.
      const second = makeMockSpawn([
        JSON.stringify({ type: 'message', role: 'assistant', content: 'still blue', delta: true }),
        JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 1, output_tokens: 1 } }),
      ]);
      const backend2 = new ProjectRunnerBackend({ projectRoot: root, dataDir, thread: THREAD, runner: 'gemini', spawnFn: second });
      await collect(backend2.sendMessage('are you sure?'));

      const args = second.calls[0]!.args;
      const prompt = args[args.indexOf('--prompt') + 1]!;
      assert.match(prompt, /User: what colour is the sky\?/);
      assert.match(prompt, /Assistant: blue/);
      assert.match(prompt, /User: are you sure\?/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('emits an error event and does not commit memory on a failed turn', async () => {
    const { base, root, dataDir } = await tempProject();
    try {
      const spawnFn = makeMockSpawn([], 41); // gemini auth failure — no result
      const backend = new ProjectRunnerBackend({ projectRoot: root, dataDir, thread: THREAD, runner: 'gemini', spawnFn });
      const events = await collect(backend.sendMessage('hi'));
      assert.equal(events.at(-1)!.type, 'error');
      // Nothing persisted — a retry starts clean.
      assert.equal(await loadSlackTranscript(dataDir, THREAD.threadKey), null);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('ProjectRunnerBackend — hermes', () => {
  it('runs hermes --oneshot and emits the final text + done', async () => {
    const { base, root, dataDir } = await tempProject();
    try {
      const spawnFn = makeMockSpawn(['the answer is 42']);
      const backend = new ProjectRunnerBackend({ projectRoot: root, dataDir, thread: THREAD, runner: 'hermes', spawnFn });
      const events = await collect(backend.sendMessage('q'));
      assert.equal(spawnFn.calls[0]!.cmd, 'hermes');
      assert.ok(spawnFn.calls[0]!.args.includes('--oneshot'));
      const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('');
      assert.equal(text, 'the answer is 42');
      assert.equal(events.at(-1)!.type, 'done');
      const rec = await loadSlackTranscript(dataDir, THREAD.threadKey);
      assert.equal(rec!.messages.at(-1)!.content, 'the answer is 42');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('createRunnerSlackBackend', () => {
  it('injects first-turn context only on a cold thread', async () => {
    const { base, root, dataDir } = await tempProject();
    try {
      let firstTurnCalls = 0;
      const spawnFn = makeMockSpawn([
        JSON.stringify({ type: 'message', role: 'assistant', content: 'ok', delta: true }),
        JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 1, output_tokens: 1 } }),
      ]);
      const mk = () =>
        createRunnerSlackBackend({
          projectRoot: root,
          thread: THREAD,
          runner: 'gemini',
          systemPromptAppend: 'BANNER',
          spawnFn,
          loadFirstTurnSystemPromptAppend: async () => {
            firstTurnCalls++;
            return 'REPORT_CONTEXT';
          },
        });

      // Cold thread → callback fires, backend built.
      const b1 = await mk();
      await collect(b1.sendMessage('hi'));
      assert.equal(firstTurnCalls, 1);

      // Warm thread (transcript now exists) → callback skipped.
      const b2 = await mk();
      assert.equal(firstTurnCalls, 1);
      assert.ok(b2 instanceof ProjectRunnerBackend);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
