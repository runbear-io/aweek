/**
 * Replay-driven integration test for the Slack-aweek run path.
 *
 * Sub-ACs 11.2 + 11.3 of the Slack-aweek integration seed:
 *
 *   11.2 — "Drive a fake inbound Slack message through the harness and
 *           assert the streamed reply text matches the scripted CLI
 *           output."
 *   11.3 — "Assert the on-disk thread file under .aweek/ is created/
 *           mutated with the expected message records after the cycle
 *           completes." Specifically:
 *           `<projectRoot>/.aweek/channels/slack/threads/<encoded>.json`
 *           must contain `{ threadKey, claudeSessionId, lastUsedAt }`
 *           where `claudeSessionId` is the id emitted on the scripted
 *           CLI's leading `system init` line and `threadKey` is the
 *           original (non-encoded) agentchannels thread key.
 *
 * This test wires the FULL vertical slice — fake Slack adapter →
 * `startSlackBridge` → real `createPersistedSlackBackend` → real
 * `ProjectClaudeBackend` → real stream-json parser → fake CLI sink — so
 * the only test doubles are at the network boundary (no live Slack
 * WebSocket) and the process boundary (no live `claude` binary). Every
 * line of code between those two seams is the actual production module.
 *
 * The harness pieces come from {@link ../../serve/slack-replay-harness.js}
 * (Sub-AC 11.1):
 *
 *   - {@link makeFakeSlackAdapterSource} — captures `startStream` /
 *     `append` / `finish` / `setStatus` calls so we can assert on the
 *     exact text the bridge would have rendered into Slack.
 *   - {@link makeFakeCliSink} — pretends to be the `claude` binary;
 *     emits a canned NDJSON sequence through a real `Readable` so the
 *     production readline pipeline + the production stream-json parser
 *     are both exercised end-to-end.
 *   - {@link cliInitLine} / {@link cliTextDeltaLine} /
 *     {@link cliResultLine} — canonical NDJSON line builders so the
 *     scripted CLI output is composed without ad-hoc `JSON.stringify`.
 *
 * Boundary contract this file enforces:
 *
 *   - The integration test belongs under `src/channels/slack/` (per the
 *     CLAUDE.md "Testing" section: "The replay-driven integration test
 *     under `src/channels/slack/` uses agentchannels' `replay-agent-client`
 *     harness to drive a fake Slack message through the bridge
 *     end-to-end and asserts both the streamed reply text and the
 *     on-disk `.aweek/channels/slack/threads/<threadKey>.json` mutation
 *     in a single cycle.").
 *   - It runs against an isolated `mkdtemp` project root so the on-disk
 *     thread file lands under `<tmp>/.aweek/channels/slack/threads/` and
 *     is cleaned up in a `finally`. No global `.aweek/` state is
 *     touched.
 *   - It uses `pnpm test`'s default node-test glob (`src/**`/`*.test.ts`),
 *     so no test runner config edits are required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Backend,
  ChannelMessage,
  ThreadContext,
} from 'agentchannels';

import {
  cliInitLine,
  cliResultLine,
  cliTextDeltaLine,
  makeFakeCliSink,
  makeFakeSlackAdapterSource,
} from '../../serve/slack-replay-harness.js';
import {
  startSlackBridge,
  type CreateSlackBackendFn,
} from '../../serve/slack-bridge.js';
import {
  slackThreadPath,
  type SlackThreadRecord,
} from '../../storage/slack-thread-store.js';
import {
  createPersistedSlackBackend,
  type CreatePersistedSlackBackendOptions,
} from './backend-factory.js';

/**
 * Stable thread context the test drives the bridge with. Pulled out as
 * a const so the streamed-reply assertion and any future on-disk
 * persistence assertion (Sub-AC 11.3) reach the same `threadKey`.
 */
const THREAD: ThreadContext = Object.freeze({
  adapterName: 'slack',
  channelId: 'C_REPLAY_INT',
  threadId: 'T_REPLAY_INT',
  userId: 'U_REPLAY_INT',
  threadKey: 'slack:C_REPLAY_INT:T_REPLAY_INT',
});

/** `ChannelMessage` matching {@link THREAD}. */
const INBOUND_MSG: ChannelMessage = Object.freeze({
  id: '1.0',
  channelId: THREAD.channelId,
  threadId: THREAD.threadId,
  userId: THREAD.userId,
  text: 'hello, replay-driven integration!',
  isMention: true,
  isDirectMessage: false,
});

describe('Slack replay-driven integration (Sub-AC 11.2 + 11.3)', () => {
  it('drives a fake inbound Slack message through the bridge: streamed reply matches the scripted CLI output AND the on-disk thread record is created with the captured session id', async () => {
    // ── Arrange ──────────────────────────────────────────────────────
    //
    // Scripted CLI output: a leading `system init` line (CLI mints the
    // session id), three `text_delta` chunks the test asserts against,
    // and a terminal `result` line so the parser's terminal `done` event
    // fires and the consumer's `for await` loop exits cleanly.
    const SCRIPTED_DELTAS = ['Hello ', 'from the ', 'replay harness!'];
    const EXPECTED_REPLY = SCRIPTED_DELTAS.join('');

    const sink = makeFakeCliSink({
      stdoutLines: [
        cliInitLine('sess_replay_e2e_001'),
        ...SCRIPTED_DELTAS.map((text) => cliTextDeltaLine(text)),
        cliResultLine(),
      ],
      exitCode: 0,
    });

    const adapterSrc = makeFakeSlackAdapterSource();

    // Run against an isolated project root so the factory's disk
    // persistence (`.aweek/channels/slack/threads/<key>.json`) doesn't
    // collide with the dev workspace.
    const projectRoot = await mkdtemp(
      join(tmpdir(), 'aweek-slack-replay-int-'),
    );
    const dataDir = join(projectRoot, '.aweek', 'agents');

    // Wrap the real factory with the fake spawn injection. This is the
    // ONLY test double in the run path — the bridge, the backend, the
    // stream-json parser, and the on-disk thread store are all real.
    const createBackend: CreateSlackBackendFn = (
      opts: CreatePersistedSlackBackendOptions,
    ): Promise<Backend> =>
      createPersistedSlackBackend({
        ...opts,
        spawnFn: sink,
      });

    const handle = startSlackBridge({
      adapter: adapterSrc.adapter,
      projectRoot,
      dataDir,
      createBackend,
      // Silence the bridge's status-line log so the test output stays
      // clean; the assertions don't depend on log content.
      log: () => {},
    });

    try {
      // ── Act ────────────────────────────────────────────────────────
      // Push a synthetic inbound Slack message into the adapter; the
      // bridge's onMessage subscriber forwards it to handleMessage,
      // which resolves the backend, which spawns the fake CLI, which
      // emits the scripted lines, which the parser converts into
      // AgentStreamEvents, which the bridge feeds to the adapter's
      // StreamHandle. `emit()` awaits each handler so by the time it
      // resolves the bridge has finished processing the turn.
      await adapterSrc.emit(INBOUND_MSG);

      // ── Assert ─────────────────────────────────────────────────────

      // The CLI sink was invoked exactly once with the user's prompt
      // piped through stdin.
      assert.equal(
        sink.calls.length,
        1,
        'expected exactly one CLI spawn for the single inbound Slack message',
      );
      assert.equal(
        sink.lastCall()?.stdinReceived,
        INBOUND_MSG.text,
        "the user's Slack message was piped through stdin verbatim",
      );

      // The bridge opened exactly one Slack stream for this thread.
      assert.equal(
        adapterSrc.capture.startStreamCalls.length,
        1,
        'bridge opened one Slack stream for the inbound message',
      );
      assert.deepEqual(adapterSrc.capture.startStreamCalls[0], {
        channelId: THREAD.channelId,
        threadId: THREAD.threadId,
        userId: THREAD.userId,
      });

      // Heart of Sub-AC 11.2: the streamed reply text the bridge wrote
      // into Slack matches the scripted CLI text-delta sequence,
      // chunk-by-chunk AND in concatenated form.
      assert.deepEqual(
        adapterSrc.capture.appendedTexts,
        SCRIPTED_DELTAS,
        'each text_delta chunk was forwarded to StreamHandle.append in order',
      );
      assert.equal(
        adapterSrc.readStreamedText(),
        EXPECTED_REPLY,
        'concatenated streamed reply matches the scripted CLI output',
      );

      // Stream finished exactly once — the parser saw the terminal
      // `result` line and synthesised the `done` event the bridge
      // settles on.
      assert.equal(
        adapterSrc.capture.finishedTexts.length,
        1,
        'the bridge called finish() exactly once on stream completion',
      );

      // The bridge cached one backend keyed by the inbound thread.
      assert.equal(handle.backends.size, 1, 'one backend cached');
      assert.ok(
        handle.backends.has(THREAD.threadKey),
        `backend cached under ${THREAD.threadKey}`,
      );

      // ── Sub-AC 11.3: on-disk thread file mutation ───────────────────
      //
      // The factory's `onSessionInit` hook fires
      // `saveSlackThread(...)` as a fire-and-forget background write
      // when the parser surfaces the leading `system init` line. The
      // write chain is `mkdir(recursive) → writeFile(tmp) → rename`,
      // each step a separate microtask + libuv tick — `await
      // emit(...)` returns once the bridge has finished consuming
      // events, but the persistence IIFE may still be in flight.
      //
      // Poll for the on-disk artifact with a bounded budget rather
      // than guessing a fixed drain count: that way the assertion is
      // robust under loaded CI without padding the happy path on a
      // fast dev machine.
      const tWindowStart = Date.now();
      const expectedPath = slackThreadPath(dataDir, THREAD.threadKey);
      const POLL_DEADLINE_MS = 2000;
      const pollStart = Date.now();
      let fileStat: Awaited<ReturnType<typeof stat>> | null = null;
      while (Date.now() - pollStart < POLL_DEADLINE_MS) {
        fileStat = await stat(expectedPath).catch(() => null);
        if (fileStat?.isFile()) break;
        await new Promise<void>((r) => setImmediate(r));
        await Promise.resolve();
      }
      assert.ok(
        fileStat?.isFile(),
        `expected thread file to exist at ${expectedPath} within ${POLL_DEADLINE_MS}ms`,
      );

      const persistedRaw = await readFile(expectedPath, 'utf8');
      const persisted = JSON.parse(persistedRaw) as SlackThreadRecord;

      // The persisted record carries the AGENTCHANNELS thread key
      // verbatim (not the filesystem-encoded slug) so a future
      // operator can reconstruct the routing key from the file alone.
      assert.equal(
        persisted.threadKey,
        THREAD.threadKey,
        'persisted threadKey is the original agentchannels threadKey',
      );

      // The Claude session id mirrored to disk MUST be the one the
      // scripted `system init` line emitted — that's the contract
      // sub-AC 5 enforces (first turn → save; second turn → resume
      // with the saved id). Any other value means `onSessionInit`
      // either fired with the wrong id or never fired at all.
      assert.equal(
        persisted.claudeSessionId,
        'sess_replay_e2e_001',
        'persisted claudeSessionId matches the system_init session_id from the scripted CLI output',
      );

      // The persisted `lastUsedAt` is a Date.now() the factory took
      // inside the test window. Bound it loosely (between the start
      // of the assertion phase and now) so a misbehaving clock
      // injection (e.g. `now: () => 0`) trips the assertion.
      assert.equal(
        typeof persisted.lastUsedAt,
        'number',
        'persisted lastUsedAt is a number (epoch-ms)',
      );
      assert.ok(
        persisted.lastUsedAt >= tWindowStart - 1000 &&
          persisted.lastUsedAt <= Date.now() + 1000,
        `persisted lastUsedAt (${persisted.lastUsedAt}) is within the assertion window [${
          tWindowStart - 1000
        }, ${Date.now() + 1000}]`,
      );

      // The persisted record has exactly the three documented fields
      // (`threadKey`, `claudeSessionId`, `lastUsedAt`) — guard
      // against accidental field bloat that would silently expand
      // the on-disk contract.
      assert.deepEqual(
        Object.keys(persisted).sort(),
        ['claudeSessionId', 'lastUsedAt', 'threadKey'],
        'persisted record exposes only the documented fields',
      );
    } finally {
      // Drain microtask + setImmediate queues a few times so any
      // residual fire-and-forget `saveSlackThread(...)` write settles
      // BEFORE we tear the temp project root out from under it.
      // (Sub-AC 11.3 already drained + asserted above; this drain is
      // a belt-and-braces guard against the bridge replaying init
      // events on shutdown.)
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((r) => setImmediate(r));
        await Promise.resolve();
      }
      await handle.shutdown();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
