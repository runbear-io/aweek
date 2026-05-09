/**
 * Integration tests for `src/channels/slack/backend-factory.ts`.
 *
 * Sub-AC 5 of the Slack-aweek integration seed. The factory wires
 * {@link ProjectClaudeBackend} to the disk-backed slack-thread-store so:
 *
 *   - First message in a Slack thread spawns Claude with NO `--resume`.
 *   - The CLI's `system init` `session_id` is captured.
 *   - The captured id is persisted under
 *     `<projectRoot>/.aweek/channels/slack/threads/<encoded>.json`
 *     alongside a `lastUsedAt` epoch-ms.
 *   - Second message in the SAME thread is constructed with that id
 *     pre-loaded (rehydration path) and the spawn helper emits
 *     `--resume <sessionId>` in its argv.
 *   - A persisted record older than 24h is evicted by the store's
 *     lazy-GC sweep, so a returning user effectively starts fresh.
 *
 * The test exercises the full vertical slice using a fake spawn that
 * pushes stream-json NDJSON lines through the same readline pipeline
 * production uses; only the `claude` binary is replaced.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentStreamEvent, ThreadContext } from 'agentchannels';

import { createPersistedSlackBackend } from './backend-factory.js';
import {
  loadSlackThread,
  slackThreadPath,
  SLACK_THREAD_TTL_MS,
} from '../../storage/slack-thread-store.js';
import type { SpawnFn } from '../../execution/cli-session.js';

const THREAD: ThreadContext = {
  adapterName: 'slack',
  channelId: 'C123',
  threadId: 'T456',
  userId: 'U789',
  threadKey: 'slack:C123:T456',
};

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

function textDeltaLine(text: string): string {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  });
}

function resultLine(): string {
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
    },
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
  calls: SpawnCall[];
  lastCall: () => SpawnCall | null;
}

interface CreateMockSpawnOpts {
  stdoutLines?: string[];
  exitCode?: number | null;
}

function createMockSpawn(opts: CreateMockSpawnOpts = {}): MockSpawn {
  const calls: SpawnCall[] = [];
  const fn = ((cmd: string, args: ReadonlyArray<string>, options: SpawnOptions) => {
    calls.push({ cmd, args, opts: options });
    const child = new EventEmitter() as MockChildProcess;
    const stdoutStream = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });
    const stdinStream = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    child.stdout = stdoutStream;
    child.stderr = stderrStream;
    child.stdin = stdinStream;
    child.killed = false;
    child.kill = () => true;
    setImmediate(() => {
      for (const line of opts.stdoutLines ?? []) {
        stdoutStream.push(`${line}\n`);
      }
      stdoutStream.push(null);
      stderrStream.push(null);
      setImmediate(() => child.emit('close', opts.exitCode ?? 0));
    });
    return child as unknown as ChildProcess;
  }) as unknown as MockSpawn;
  fn.calls = calls;
  fn.lastCall = () => (calls.length ? calls[calls.length - 1] : null);
  return fn;
}

async function drain(
  iter: AsyncIterable<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const evt of iter) events.push(evt);
  return events;
}

async function tempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'aweek-slack-bf-'));
}

/**
 * Build a deferred whose `promise` resolves the first time `notify`
 * is invoked. Used as a synchronisation point with the
 * fire-and-forget `onPersisted` callback so tests can `await` the
 * actual on-disk write before asserting against the file.
 */
function deferred<T>(): {
  promise: Promise<T>;
  notify: (v: T) => void;
} {
  let notify!: (v: T) => void;
  const promise = new Promise<T>((resolve) => {
    notify = resolve;
  });
  return { promise, notify };
}

describe('createPersistedSlackBackend — first message persists session_id', () => {
  it('spawns Claude with NO --resume and writes the captured session_id to disk', async () => {
    const projectRoot = await tempProjectRoot();
    try {
      const fixedNow = 1_700_000_000_000;
      const spawnFn = createMockSpawn({
        stdoutLines: [
          systemInitLine('sess_first_turn'),
          textDeltaLine('Hello from Slack'),
          resultLine(),
        ],
      });

      const persisted = deferred<{ claudeSessionId: string; lastUsedAt: number }>();
      const backend = await createPersistedSlackBackend({
        projectRoot,
        thread: THREAD,
        spawnFn,
        now: () => fixedNow,
        onPersisted: (rec) => persisted.notify(rec),
      });

      // No persisted record yet → backend has undefined session id.
      assert.equal(backend.getClaudeSessionId(), undefined);

      const events = await drain(backend.sendMessage('hi'));

      // Stream completed cleanly.
      assert.equal(events[events.length - 1].type, 'done');

      // Argv check — the first turn MUST omit --resume.
      const call = spawnFn.lastCall();
      assert.ok(call, 'spawn must have been called');
      assert.ok(
        !call.args.includes('--resume'),
        'first turn MUST NOT include --resume',
      );
      assert.equal(call.opts.cwd, projectRoot);

      // Backend's in-memory mirror reflects the captured id.
      assert.equal(backend.getClaudeSessionId(), 'sess_first_turn');

      // Wait for the async persistence inside onSessionInit. Using the
      // onPersisted observer as the synchronisation point so the test
      // is robust against I/O latency (mkdir + writeFile + rename).
      await persisted.promise;

      // On-disk file MUST exist and carry the captured session_id +
      // the configured `lastUsedAt`.
      const dataDir = join(projectRoot, '.aweek', 'agents');
      const path = slackThreadPath(dataDir, THREAD.threadKey);
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as {
        threadKey: string;
        claudeSessionId: string;
        lastUsedAt: number;
      };
      assert.equal(parsed.threadKey, THREAD.threadKey);
      assert.equal(parsed.claudeSessionId, 'sess_first_turn');
      assert.equal(parsed.lastUsedAt, fixedNow);

      // Roundtrip via the loader to confirm the on-disk shape is
      // canonical (the loader applies the schema check).
      const loaded = await loadSlackThread(
        dataDir,
        THREAD.threadKey,
        () => fixedNow + 1,
      );
      assert.deepEqual(loaded, {
        threadKey: THREAD.threadKey,
        claudeSessionId: 'sess_first_turn',
        lastUsedAt: fixedNow,
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rehydrates a fresh persisted record and emits --resume on the second turn', async () => {
    const projectRoot = await tempProjectRoot();
    try {
      const t0 = 1_700_000_000_000;

      // First turn: cold start.
      const spawn1 = createMockSpawn({
        stdoutLines: [systemInitLine('sess_resume_me'), resultLine()],
      });
      const persisted1 = deferred<unknown>();
      const backend1 = await createPersistedSlackBackend({
        projectRoot,
        thread: THREAD,
        spawnFn: spawn1,
        now: () => t0,
        onPersisted: (rec) => persisted1.notify(rec),
      });
      await drain(backend1.sendMessage('first'));
      const call1 = spawn1.lastCall();
      assert.ok(call1);
      assert.ok(!call1.args.includes('--resume'), 'first turn omits --resume');

      // Wait for the first-turn persistence to settle on disk.
      await persisted1.promise;

      // Second turn: factory must rehydrate from disk.
      const spawn2 = createMockSpawn({
        stdoutLines: [systemInitLine('sess_resume_me'), resultLine()],
      });
      const persisted2 = deferred<unknown>();
      const backend2 = await createPersistedSlackBackend({
        projectRoot,
        thread: THREAD,
        spawnFn: spawn2,
        now: () => t0 + 5_000,
        onPersisted: (rec) => persisted2.notify(rec),
      });

      // Backend MUST be pre-populated with the persisted id BEFORE we
      // even send the second message.
      assert.equal(backend2.getClaudeSessionId(), 'sess_resume_me');

      await drain(backend2.sendMessage('second'));

      const call2 = spawn2.lastCall();
      assert.ok(call2);
      const resumeIdx = call2.args.indexOf('--resume');
      assert.ok(resumeIdx >= 0, 'second turn MUST include --resume');
      assert.equal(call2.args[resumeIdx + 1], 'sess_resume_me');

      // The second turn ALSO bumped `lastUsedAt` on disk so the 24h
      // TTL is measured from the most recent activity, not the first
      // touch.
      await persisted2.promise;
      const dataDir = join(projectRoot, '.aweek', 'agents');
      const loaded = await loadSlackThread(
        dataDir,
        THREAD.threadKey,
        () => t0 + 6_000,
      );
      assert.equal(loaded?.lastUsedAt, t0 + 5_000);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reuses the same backend across turns: turn 2 carries --resume and bumps lastUsedAt', async () => {
    // AC 6: agentchannels' BackendRegistry caches the Backend per Slack
    // thread, so subsequent Slack messages call `sendMessage()` again on
    // the SAME instance. The in-memory `claudeSessionId` mirror (set by
    // the first turn's `system init` line) is what makes `--resume` flow
    // on turn 2 — no factory rehydration needed within a single
    // `aweek serve` lifetime. Each turn must also bump the on-disk
    // `lastUsedAt` so the 24h TTL is measured from the most recent
    // activity, not the first touch.
    const projectRoot = await tempProjectRoot();
    try {
      // Moving wall clock — every read returns 1ms after the previous
      // read so we can assert that turn N's persisted `lastUsedAt`
      // advances strictly past turn N-1's. Using a sequence is more
      // robust than two pinned values because the persistence path
      // internally calls `now()` once per `saveSlackThread` invocation.
      let tick = 1_700_000_000_000;
      const now = () => {
        const v = tick;
        tick += 1_000;
        return v;
      };

      const persistedRecords: Array<{
        claudeSessionId: string;
        lastUsedAt: number;
      }> = [];
      let nextPersisted = deferred<unknown>();

      // ONE backend instance, used for both turns (the registry-cached
      // hot path). Turn 1 spawn emits sess_continuous; turn 2 spawn
      // re-emits the same id because resumed turns carry it forward.
      const spawn1 = createMockSpawn({
        stdoutLines: [systemInitLine('sess_continuous'), resultLine()],
      });
      const backend = await createPersistedSlackBackend({
        projectRoot,
        thread: THREAD,
        spawnFn: spawn1,
        now,
        onPersisted: (rec) => {
          persistedRecords.push(rec);
          nextPersisted.notify(rec);
        },
      });

      // Turn 1 — cold start.
      await drain(backend.sendMessage('first'));
      await nextPersisted.promise;
      nextPersisted = deferred<unknown>();

      const call1 = spawn1.lastCall();
      assert.ok(call1, 'turn 1 must spawn the CLI');
      assert.ok(
        !call1.args.includes('--resume'),
        'turn 1 (cold start) MUST NOT include --resume',
      );
      assert.equal(
        backend.getClaudeSessionId(),
        'sess_continuous',
        'turn 1 must capture session id into the in-memory mirror',
      );
      const turn1LastUsedAt = persistedRecords[0].lastUsedAt;

      // Turn 2 — SAME backend instance, fresh spawn so we can inspect
      // the second turn's argv independently. The factory layer's
      // `onSessionInit` hook fires again on turn 2's `system init` line,
      // bumping the on-disk `lastUsedAt` via `saveSlackThread`.
      //
      // We cannot swap `spawnFn` on the existing backend (it's a
      // constructor field), so we mutate the backend's `spawnFn` via
      // its protected slot the same way agentchannels would in
      // production: by routing through the construction options. To
      // keep this test honest we instead reach into the backend via
      // its only mutation path — replacing the `spawnFn` reference on
      // the same backend by overwriting the protected field through
      // a typed cast. This mirrors how a real `aweek serve` keeps a
      // single backend per thread; only the underlying spawn is
      // re-invoked per turn.
      const spawn2 = createMockSpawn({
        stdoutLines: [systemInitLine('sess_continuous'), resultLine()],
      });
      // The protected `spawnFn` field is what the next `sendMessage`
      // call will pass to `spawnProjectClaudeSession`. Overwriting it
      // simulates the production path where `spawn` itself is the
      // process boundary (a fresh child process is spawned on every
      // turn, but the Backend instance and its `spawnFn` reference
      // stay constant across turns).
      (backend as unknown as { spawnFn: SpawnFn }).spawnFn = spawn2;

      await drain(backend.sendMessage('second'));
      await nextPersisted.promise;

      const call2 = spawn2.lastCall();
      assert.ok(call2, 'turn 2 must spawn the CLI');
      const resumeIdx = call2.args.indexOf('--resume');
      assert.ok(
        resumeIdx >= 0,
        'turn 2 (subsequent message) MUST include --resume',
      );
      assert.equal(
        call2.args[resumeIdx + 1],
        'sess_continuous',
        'turn 2 must carry the persisted session id verbatim',
      );

      // The on-disk `lastUsedAt` advanced from turn 1 to turn 2 — the
      // seed contract's "lastUsedAt is bumped" requirement.
      assert.equal(persistedRecords.length, 2);
      const turn2LastUsedAt = persistedRecords[1].lastUsedAt;
      assert.ok(
        turn2LastUsedAt > turn1LastUsedAt,
        `turn 2 lastUsedAt (${turn2LastUsedAt}) must be greater than turn 1 (${turn1LastUsedAt})`,
      );

      // Round-trip via the loader to confirm disk has the bumped value
      // (and not a stale snapshot).
      const dataDir = join(projectRoot, '.aweek', 'agents');
      const loaded = await loadSlackThread(dataDir, THREAD.threadKey, () => tick);
      assert.equal(loaded?.claudeSessionId, 'sess_continuous');
      assert.equal(
        loaded?.lastUsedAt,
        turn2LastUsedAt,
        'loaded lastUsedAt must equal turn 2 persistence value',
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('treats a 24h-stale record as a cold start (lazy GC), no --resume', async () => {
    const projectRoot = await tempProjectRoot();
    try {
      const t0 = 1_000_000;

      // Plant an old record via the first turn.
      const spawn1 = createMockSpawn({
        stdoutLines: [systemInitLine('sess_old'), resultLine()],
      });
      const persisted1 = deferred<unknown>();
      const backend1 = await createPersistedSlackBackend({
        projectRoot,
        thread: THREAD,
        spawnFn: spawn1,
        now: () => t0,
        onPersisted: (rec) => persisted1.notify(rec),
      });
      await drain(backend1.sendMessage('first'));
      await persisted1.promise;

      // Now jump past the 24h TTL. The factory must NOT rehydrate.
      const spawn2 = createMockSpawn({
        stdoutLines: [systemInitLine('sess_brand_new'), resultLine()],
      });
      const persisted2 = deferred<unknown>();
      const backend2 = await createPersistedSlackBackend({
        projectRoot,
        thread: THREAD,
        spawnFn: spawn2,
        now: () => t0 + SLACK_THREAD_TTL_MS + 1,
        onPersisted: (rec) => persisted2.notify(rec),
      });
      assert.equal(
        backend2.getClaudeSessionId(),
        undefined,
        'expired record must NOT rehydrate',
      );
      await drain(backend2.sendMessage('post-TTL'));

      const call2 = spawn2.lastCall();
      assert.ok(call2);
      assert.ok(
        !call2.args.includes('--resume'),
        'post-TTL turn MUST omit --resume',
      );

      // The new turn writes a fresh record with the new session id.
      await persisted2.promise;
      const dataDir = join(projectRoot, '.aweek', 'agents');
      const loaded = await loadSlackThread(
        dataDir,
        THREAD.threadKey,
        () => t0 + SLACK_THREAD_TTL_MS + 2,
      );
      assert.equal(loaded?.claudeSessionId, 'sess_brand_new');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('forwards --append-system-prompt banner verbatim', async () => {
    const projectRoot = await tempProjectRoot();
    try {
      const spawnFn = createMockSpawn({
        stdoutLines: [systemInitLine('sess'), resultLine()],
      });
      const backend = await createPersistedSlackBackend({
        projectRoot,
        thread: THREAD,
        spawnFn,
        systemPromptAppend: 'Slack mode — keep replies conversational.',
      });
      await drain(backend.sendMessage('hi'));

      const call = spawnFn.lastCall();
      assert.ok(call);
      const idx = call.args.indexOf('--append-system-prompt');
      assert.ok(idx >= 0);
      assert.match(String(call.args[idx + 1]), /conversational/);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('throws on missing required options', async () => {
    await assert.rejects(
      () => createPersistedSlackBackend(undefined as unknown as never),
      /opts is required/,
    );
    await assert.rejects(
      () =>
        createPersistedSlackBackend({
          // @ts-expect-error — exercising runtime guard
          projectRoot: '',
          thread: THREAD,
        }),
      /projectRoot is required/,
    );
    await assert.rejects(
      () =>
        createPersistedSlackBackend({
          projectRoot: '/tmp/x',
          // @ts-expect-error — exercising runtime guard
          thread: undefined,
        }),
      /thread is required/,
    );
    await assert.rejects(
      () =>
        createPersistedSlackBackend({
          projectRoot: '/tmp/x',
          // @ts-expect-error — exercising runtime guard
          thread: { ...THREAD, threadKey: '' },
        }),
      /threadKey is required/,
    );
  });

  it('fires onPersisted observer with the committed record', async () => {
    const projectRoot = await tempProjectRoot();
    try {
      const observed: Array<{
        threadKey: string;
        claudeSessionId: string;
        lastUsedAt: number;
      }> = [];
      const persisted = deferred<unknown>();
      const spawnFn = createMockSpawn({
        stdoutLines: [systemInitLine('sess_observed'), resultLine()],
      });
      const backend = await createPersistedSlackBackend({
        projectRoot,
        thread: THREAD,
        spawnFn,
        now: () => 9_999,
        onPersisted: (record) => {
          observed.push(record);
          persisted.notify(record);
        },
      });
      await drain(backend.sendMessage('hi'));
      await persisted.promise;

      assert.equal(observed.length, 1);
      assert.equal(observed[0].claudeSessionId, 'sess_observed');
      assert.equal(observed[0].lastUsedAt, 9_999);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
