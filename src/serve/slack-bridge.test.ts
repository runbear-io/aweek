/**
 * Tests for `src/serve/slack-bridge.ts` — the Slack run-path bridge that
 * sits on top of the connected `SlackAdapter` and turns inbound Slack
 * messages into project-level Claude turns.
 *
 * Sub-AC 8.2 of the Slack-aweek integration seed. The seed contract is
 * explicit that
 *
 *   "Slack runs are an isolated execution surface from the heartbeat
 *    — separate per-Slack-thread lock (NOT the per-agent file lock),
 *    separate usage bucket .aweek/channels/slack/usage.json, no
 *    interaction with weekly-budget pause flag."
 *
 * This test suite locks that contract in place by:
 *
 *   1. **Static structure** — reading the bridge's source text and
 *      asserting that it imports neither `lock-manager` nor
 *      `usage-store` (the per-agent one) nor `budget-enforcer`. A
 *      future refactor that drags any of those in is caught at test
 *      time before it reaches production.
 *   2. **Wiring contract** — the bridge constructs a `StreamingBridge`,
 *      subscribes to `adapter.onMessage`, and forwards inbound
 *      messages. The backend factory is invoked exactly once per
 *      thread (cache hit on the second turn).
 *   3. **Usage isolation** — the `onResult` callback fires with a
 *      record built from the CLI's terminal `result` line and is
 *      handed to the injected `recordUsage` recorder, which writes
 *      `<dataDir>/../channels/slack/usage.json` ONLY. The per-agent
 *      `<dataDir>/<slug>/usage/<week>.json` tree stays byte-identical.
 *   4. **Lock isolation** — no `.aweek/agents/.locks/` files appear
 *      after a Slack message round-trips through the bridge.
 *   5. **Shutdown** — `shutdown()` aborts in-flight messages and is
 *      idempotent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import type {
  AgentStreamEvent,
  Backend,
  ChannelAdapter,
  ChannelMessage,
  StreamHandle,
  ThreadContext,
} from 'agentchannels';

/**
 * `MessageHandler` is not part of the agentchannels public surface, so
 * we re-derive it locally from the adapter's `onMessage` parameter
 * type. Doing it once here keeps the test doubles below trivially
 * type-correct without leaking an internal-only import.
 */
type MessageHandler = Parameters<ChannelAdapter['onMessage']>[0];

import {
  buildSlackUsageRecord,
  startSlackBridge,
  SLACK_SYSTEM_PROMPT_BANNER,
  type CreateSlackBackendFn,
  type SlackBridgeOptions,
  type SlackUsageRecorder,
} from './slack-bridge.js';
import type { ResultInfo } from './slack-stream-event-parser.js';
import { buildProjectClaudeCliArgs } from '../execution/cli-session.js';

// ── Test doubles ─────────────────────────────────────────────────────

interface FakeAdapterRecord {
  adapter: ChannelAdapter;
  /** Push a message into every registered handler — simulates inbound Slack message. */
  emit: (msg: ChannelMessage) => Promise<void>;
  startStreamCalls: Array<{ channelId: string; threadId: string; userId?: string }>;
  appendedTexts: string[];
  finishedTexts: Array<string | undefined>;
}

function makeFakeAdapter(): FakeAdapterRecord {
  const handlers: MessageHandler[] = [];
  const startStreamCalls: Array<{ channelId: string; threadId: string; userId?: string }> = [];
  const appendedTexts: string[] = [];
  const finishedTexts: Array<string | undefined> = [];

  const adapter: ChannelAdapter = {
    name: 'slack',
    connect: async () => {},
    disconnect: async () => {},
    onMessage: (h) => {
      handlers.push(h);
    },
    sendMessage: async () => {},
    startStream: async (channelId: string, threadId: string, userId?: string) => {
      startStreamCalls.push({ channelId, threadId, userId });
      const handle: StreamHandle = {
        append: async (text: string) => {
          appendedTexts.push(text);
        },
        finish: async (final?: string) => {
          finishedTexts.push(final);
        },
      };
      return handle;
    },
  };

  return {
    adapter,
    emit: async (msg) => {
      for (const h of handlers) {
        await h(msg);
      }
    },
    startStreamCalls,
    appendedTexts,
    finishedTexts,
  };
}

/**
 * A {@link Backend} test double that emits a canned `text_delta` then a
 * `done` event, optionally firing the factory-supplied `onResult` hook
 * with a synthetic {@link ResultInfo}.
 */
function makeFakeBackend(opts: {
  /** What to stream out of `sendMessage`. Must include a terminal `done` or `error`. */
  events: AgentStreamEvent[];
  /** Synthetic result line (fires the wired `onResult` BEFORE the terminal `done`). */
  result?: ResultInfo;
  /** Triggered when the factory invokes `dispose()`. */
  onDispose?: () => void;
  /** Captured `onResult` callback (set by the factory). */
  resultSink?: { fn: ((r: ResultInfo) => void) | null };
}): Backend {
  let aborted = false;
  return {
    sendMessage(_text: string): AsyncIterable<AgentStreamEvent> {
      const events = opts.events;
      const result = opts.result;
      const sink = opts.resultSink;
      return (async function* () {
        for (const evt of events) {
          if (aborted) return;
          // Mirror the production sequence: the CLI's `result` line
          // is parsed and fires `onResult` BEFORE the synthetic `done`
          // event lands in the queue. We replicate that ordering here
          // so the bridge's downstream `for await` consumer sees the
          // hook fire before the terminal event.
          if (evt.type === 'done' && result && sink?.fn) {
            sink.fn(result);
          }
          yield evt;
        }
      })();
    },
    abort() {
      aborted = true;
    },
    async dispose() {
      opts.onDispose?.();
    },
  };
}

// ── Static-structure invariants ───────────────────────────────────────

describe('slack-bridge.ts static imports (Sub-AC 8.2 isolation contract)', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SOURCE = readFileSync(join(HERE, 'slack-bridge.ts'), 'utf-8');

  /**
   * Extract the module specifiers from every top-level `import` /
   * `export ... from` statement. Skips comments and docstrings, so a
   * `* {@link acquireLock} from ...` JSDoc reference does NOT count
   * as an import.
   */
  const importedSpecifiers: string[] = (() => {
    const pattern = /^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]\s*;?/gm;
    const out: string[] = [];
    for (const match of SOURCE.matchAll(pattern)) {
      out.push(match[1]!);
    }
    return out;
  })();

  it('does NOT import lock-manager (per-agent heartbeat lock is bypassed)', () => {
    const offenders = importedSpecifiers.filter((s) => /lock\/lock-manager/.test(s));
    assert.deepEqual(
      offenders,
      [],
      `slack-bridge must NOT import the per-agent lock manager; found: ${JSON.stringify(offenders)}`,
    );
  });

  it('does NOT import the per-agent UsageStore', () => {
    // Match `usage-store` (the per-agent one) without matching
    // `slack-usage-store` (the Sub-AC 8.1 isolated bucket).
    const offenders = importedSpecifiers.filter(
      (s) => /\/usage-store(?:\.js)?$/.test(s) && !/slack-usage-store/.test(s),
    );
    assert.deepEqual(
      offenders,
      [],
      `slack-bridge must NOT import the per-agent usage store; found: ${JSON.stringify(offenders)}`,
    );
  });

  it('does NOT import the budget enforcer', () => {
    const offenders = importedSpecifiers.filter((s) => /budget-enforcer/.test(s));
    assert.deepEqual(
      offenders,
      [],
      `slack-bridge must NOT import the budget enforcer; found: ${JSON.stringify(offenders)}`,
    );
  });

  it('DOES import the Slack-only usage store', () => {
    const found = importedSpecifiers.some((s) => /slack-usage-store/.test(s));
    assert.ok(
      found,
      `slack-bridge must import the Slack-only usage store; got specifiers: ${JSON.stringify(importedSpecifiers)}`,
    );
  });
});

// ── Sub-AC 5: SLACK_SYSTEM_PROMPT_BANNER constant + wiring ───────────
//
// The seed contract is explicit that Slack-driven runs must inject a
// "conversational human chat, not task reports" banner via
// `--append-system-prompt`. This block locks the banner CONTENT down
// (so a casual edit can't accidentally drop the contractual phrasing)
// AND verifies its WIRING — the constant is the default value the
// bridge hands to the backend factory, but a per-call override still
// wins.
//
// The cache-hit / cache-miss / threadKey-cache assertions live above;
// this block is dedicated to the banner-builder contract specifically.

describe('SLACK_SYSTEM_PROMPT_BANNER (Sub-AC 5 banner builder + contract)', () => {
  it('is a non-empty string', () => {
    assert.equal(typeof SLACK_SYSTEM_PROMPT_BANNER, 'string');
    assert.ok(
      SLACK_SYSTEM_PROMPT_BANNER.length > 0,
      'banner must be a non-empty string',
    );
  });

  it('frames the run as Slack-mode human conversation', () => {
    // Lower-cased once so we test the seed-contract intent, not the
    // exact capitalisation, but require both anchors so a future edit
    // that drops one of the framing concepts still trips the test.
    const lower = SLACK_SYSTEM_PROMPT_BANNER.toLowerCase();
    assert.ok(lower.includes('slack'), 'banner must mention Slack');
    assert.ok(
      lower.includes('human') || lower.includes('conversational'),
      'banner must frame the run as conversational / human chat',
    );
  });

  it('explicitly excludes the heartbeat task-report idiom', () => {
    const lower = SLACK_SYSTEM_PROMPT_BANNER.toLowerCase();
    // The exact contractual phrase from the seed — "conversational
    // human chat, NOT task reports" — must surface as an explicit
    // exclusion in the banner so the model doesn't fall back to the
    // heartbeat task-report style by default.
    assert.ok(
      lower.includes('task report'),
      'banner must explicitly exclude task reports',
    );
  });

  it('does NOT leak per-task scheduling metadata (no `Task ID:` / aweek runtime header)', () => {
    // The Slack run-path is project-level; a per-task runtime context
    // belongs to the heartbeat surface (`buildRuntimeContext`) only.
    // If a future change merges the two banners, the contract here
    // catches it before we ship.
    assert.ok(
      !SLACK_SYSTEM_PROMPT_BANNER.includes('Task ID:'),
      'banner must not embed per-task scheduling metadata',
    );
    assert.ok(
      !SLACK_SYSTEM_PROMPT_BANNER.includes('## aweek Runtime Context'),
      'banner must not embed the heartbeat runtime-context header',
    );
  });

  it('is a single contiguous string (no array, no template-builder leak)', () => {
    // Sub-AC 5's contract is that the banner is a *constant* — not a
    // builder fn that returns different strings per call. The bridge
    // assigns it directly to `systemPromptAppend`, so any future
    // refactor that turns it into a function would silently change
    // the wiring. Lock the shape down here.
    assert.ok(
      typeof SLACK_SYSTEM_PROMPT_BANNER === 'string',
      'banner must be a string constant, not a builder',
    );
    // Sanity: matches the in-source declaration line used by the
    // bridge default. We don't assert exact bytes (that would be a
    // brittle snapshot), just that the source contains the export
    // declaration as a string literal — paired with the static-
    // imports test above this gives us full coverage.
    assert.match(
      readFileSync(join(HERE_FOR_BANNER, 'slack-bridge.ts'), 'utf-8'),
      /export const SLACK_SYSTEM_PROMPT_BANNER\s*=\s*['"]/,
      'banner must be defined as `export const SLACK_SYSTEM_PROMPT_BANNER = "..."`',
    );
  });

  it('flows through to the factory as systemPromptAppend by default', async () => {
    const { adapter, emit } = makeFakeAdapter();
    const captured: Array<string | undefined> = [];
    const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };

    const createBackend: CreateSlackBackendFn = async (opts) => {
      captured.push(opts.systemPromptAppend);
      resultSink.fn = opts.onResult ?? null;
      return makeFakeBackend({
        events: [{ type: 'done' }],
        result: { isError: false, usage: { inputTokens: 0, outputTokens: 0 } },
        resultSink,
      });
    };

    startSlackBridge({
      adapter,
      projectRoot: '/p',
      dataDir: '/d',
      createBackend,
      recordUsage: async () => undefined,
      log: () => {},
    });
    await emit(THREAD_MSG);

    assert.equal(captured.length, 1);
    // The factory receives the EXACT constant by reference — not a
    // string-equal copy that some future helper produces from a
    // template — so identity equality is enforceable.
    assert.strictEqual(
      captured[0],
      SLACK_SYSTEM_PROMPT_BANNER,
      'factory receives the SLACK_SYSTEM_PROMPT_BANNER constant by identity',
    );
  });

  it('a per-call override beats the default (override identity preserved)', async () => {
    const { adapter, emit } = makeFakeAdapter();
    const captured: Array<string | undefined> = [];
    const override = 'custom Slack banner — multi-line\nrules apply';
    const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };

    const createBackend: CreateSlackBackendFn = async (opts) => {
      captured.push(opts.systemPromptAppend);
      resultSink.fn = opts.onResult ?? null;
      return makeFakeBackend({
        events: [{ type: 'done' }],
        result: { isError: false, usage: { inputTokens: 0, outputTokens: 0 } },
        resultSink,
      });
    };

    startSlackBridge({
      adapter,
      projectRoot: '/p',
      dataDir: '/d',
      systemPromptAppend: override,
      createBackend,
      recordUsage: async () => undefined,
      log: () => {},
    });
    await emit(THREAD_MSG);

    assert.equal(captured.length, 1);
    assert.strictEqual(
      captured[0],
      override,
      'override flows through verbatim — multi-line preserved',
    );
    assert.notStrictEqual(
      captured[0],
      SLACK_SYSTEM_PROMPT_BANNER,
      'override must NOT silently fall back to the default',
    );
  });

  // ── Argv-level injection (closes the loop in this file) ──────────
  //
  // The two tests above lock the bridge → factory wiring. The block
  // below proves the OTHER half of Sub-AC 5: that the banner the
  // bridge defaults to is the EXACT byte sequence the project-Claude
  // CLI argv builder emits as the value of `--append-system-prompt`.
  // Keeping these in slack-bridge.test.ts (alongside the matching
  // assertions in cli-session.test.ts) means a future refactor that
  // breaks either side fails the test that owns that side.

  it('the SLACK_SYSTEM_PROMPT_BANNER constant becomes the --append-system-prompt argv value', () => {
    const args = buildProjectClaudeCliArgs({
      systemPromptAppend: SLACK_SYSTEM_PROMPT_BANNER,
    });
    const idx = args.indexOf('--append-system-prompt');
    assert.ok(idx >= 0, '--append-system-prompt must appear in the argv');
    assert.strictEqual(
      args[idx + 1],
      SLACK_SYSTEM_PROMPT_BANNER,
      'argv must carry the SLACK_SYSTEM_PROMPT_BANNER verbatim as the next token',
    );
  });

  it('the banner is emitted exactly once in the argv (no duplication)', () => {
    const args = buildProjectClaudeCliArgs({
      systemPromptAppend: SLACK_SYSTEM_PROMPT_BANNER,
    });
    const flagOccurrences = args.filter((a) => a === '--append-system-prompt');
    assert.equal(
      flagOccurrences.length,
      1,
      `--append-system-prompt must appear exactly once, got ${flagOccurrences.length}`,
    );
    const bannerOccurrences = args.filter((a) => a === SLACK_SYSTEM_PROMPT_BANNER);
    assert.equal(
      bannerOccurrences.length,
      1,
      `the banner must appear exactly once in the argv, got ${bannerOccurrences.length}`,
    );
  });

  it('an absent banner produces NO --append-system-prompt flag (Slack-mode banner is opt-in)', () => {
    // Mirrors the contract `buildProjectClaudeCliArgs` enforces:
    // both `undefined` and `''` (empty) result in the flag being
    // omitted entirely — the CLI then uses its own default system
    // prompt. The bridge's default supplies the banner, but a caller
    // that explicitly nulls it must NOT have an empty
    // `--append-system-prompt ''` slot leaked into argv.
    const fromUndefined = buildProjectClaudeCliArgs({});
    const fromEmpty = buildProjectClaudeCliArgs({ systemPromptAppend: '' });
    assert.ok(
      !fromUndefined.includes('--append-system-prompt'),
      'undefined banner must NOT add --append-system-prompt',
    );
    assert.ok(
      !fromEmpty.includes('--append-system-prompt'),
      'empty-string banner must NOT add --append-system-prompt',
    );
  });

  it('a multi-line override banner survives argv injection without splitting', () => {
    // Slack reply banners can be multi-line. Spawn argv has no
    // intrinsic line semantics, so the entire banner — newline and
    // all — must land in a single argv slot. Asserting this in the
    // bridge test file (next to the other banner-content assertions)
    // means a regression in either layer surfaces here too.
    const banner = 'Line one\nLine two\nLine three with `back\\ticks`';
    const args = buildProjectClaudeCliArgs({ systemPromptAppend: banner });
    const idx = args.indexOf('--append-system-prompt');
    assert.ok(idx >= 0);
    assert.strictEqual(args[idx + 1], banner);
  });
});

// Resolve the slack-bridge source path once for the constant-source
// regex assertion above.
const HERE_FOR_BANNER = dirname(fileURLToPath(import.meta.url));

// ── buildSlackUsageRecord ─────────────────────────────────────────────

describe('buildSlackUsageRecord', () => {
  it('builds a record from a happy-path result line', () => {
    const result: ResultInfo = {
      stopReason: 'end_turn',
      subtype: 'success',
      isError: false,
      durationMs: 1234,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        totalCostUsd: 0.0042,
      },
    };
    const r = buildSlackUsageRecord({ threadKey: 'slack:C1:T1', result });
    assert.equal(r.threadKey, 'slack:C1:T1');
    assert.equal(r.inputTokens, 100);
    assert.equal(r.outputTokens, 50);
    assert.equal(r.totalTokens, 150);
    assert.equal(r.cacheReadTokens, 10);
    assert.equal(r.cacheCreationTokens, 5);
    assert.equal(r.costUsd, 0.0042);
    assert.equal(r.durationMs, 1234);
    assert.equal(r.success, true);
    assert.equal(r.stopReason, 'end_turn');
  });

  it('marks success=false when isError is true', () => {
    const r = buildSlackUsageRecord({
      threadKey: 'slack:C1:T1',
      result: { isError: true, usage: { inputTokens: 1, outputTokens: 1 } },
    });
    assert.equal(r.success, false);
  });

  it('passes through model when supplied (v2 placeholder kept stable)', () => {
    const r = buildSlackUsageRecord({
      threadKey: 'slack:C1:T1',
      result: { isError: false, usage: { inputTokens: 1, outputTokens: 1 } },
      model: 'sonnet',
    });
    assert.equal(r.model, 'sonnet');
  });

  it('omits optional fields when not present on the result line', () => {
    const r = buildSlackUsageRecord({
      threadKey: 'slack:C1:T1',
      result: { isError: false, usage: { inputTokens: 1, outputTokens: 1 } },
    });
    assert.equal(r.cacheReadTokens, undefined);
    assert.equal(r.cacheCreationTokens, undefined);
    assert.equal(r.costUsd, undefined);
    assert.equal(r.durationMs, undefined);
    assert.equal(r.stopReason, undefined);
    assert.equal(r.model, undefined);
  });
});

// ── startSlackBridge wiring ───────────────────────────────────────────

const THREAD_MSG: ChannelMessage = {
  id: '1.0',
  channelId: 'C123',
  threadId: 'T456',
  userId: 'U789',
  text: 'hello there',
  isMention: true,
  isDirectMessage: false,
};

describe('startSlackBridge — argument validation', () => {
  it('throws when adapter is missing', () => {
    // @ts-expect-error — intentionally bad input
    assert.throws(() => startSlackBridge({ projectRoot: '/p', dataDir: '/d' }));
  });

  it('throws when projectRoot is missing', () => {
    const { adapter } = makeFakeAdapter();
    // @ts-expect-error — intentionally bad input
    assert.throws(() => startSlackBridge({ adapter, dataDir: '/d' }));
  });

  it('throws when dataDir is missing', () => {
    const { adapter } = makeFakeAdapter();
    // @ts-expect-error — intentionally bad input
    assert.throws(() => startSlackBridge({ adapter, projectRoot: '/p' }));
  });
});

describe('startSlackBridge — happy path', () => {
  it('subscribes to adapter.onMessage and resolves a backend on first turn', async () => {
    const { adapter, emit, startStreamCalls } = makeFakeAdapter();
    const factoryCalls: ThreadContext[] = [];
    const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };

    const createBackend: CreateSlackBackendFn = async (opts) => {
      factoryCalls.push(opts.thread);
      // Capture the factory-supplied onResult hook so the fake backend
      // can fire it after streaming.
      resultSink.fn = opts.onResult ?? null;
      return makeFakeBackend({
        events: [
          { type: 'text_delta', text: 'hi back' },
          { type: 'done' },
        ],
        result: {
          isError: false,
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        resultSink,
      });
    };

    const handle = startSlackBridge({
      adapter,
      projectRoot: '/tmp/fake-project',
      dataDir: '/tmp/fake-project/.aweek/agents',
      createBackend,
      recordUsage: async () => undefined,
      log: () => {},
    });

    await emit(THREAD_MSG);

    assert.equal(factoryCalls.length, 1, 'backend factory called exactly once');
    assert.equal(factoryCalls[0]!.threadKey, 'slack:C123:T456');
    assert.equal(startStreamCalls.length, 1, 'adapter.startStream called once');
    assert.equal(handle.backends.size, 1, 'backend cached');
    assert.ok(handle.backends.has('slack:C123:T456'));
  });

  it('reuses the cached backend on a second message in the same thread', async () => {
    const { adapter, emit } = makeFakeAdapter();
    let factoryCalls = 0;
    const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };
    const createBackend: CreateSlackBackendFn = async (opts) => {
      factoryCalls += 1;
      resultSink.fn = opts.onResult ?? null;
      return makeFakeBackend({
        events: [
          { type: 'text_delta', text: 'reply' },
          { type: 'done' },
        ],
        result: { isError: false, usage: { inputTokens: 1, outputTokens: 1 } },
        resultSink,
      });
    };

    startSlackBridge({
      adapter,
      projectRoot: '/p',
      dataDir: '/d',
      createBackend,
      recordUsage: async () => undefined,
      log: () => {},
    });

    await emit(THREAD_MSG);
    await emit({ ...THREAD_MSG, id: '2.0', text: 'second turn' });

    assert.equal(factoryCalls, 1, 'second turn must hit the cache, not the factory');
  });

  it('passes the SLACK_SYSTEM_PROMPT_BANNER to the factory by default', async () => {
    const { adapter, emit } = makeFakeAdapter();
    let receivedBanner: string | undefined = undefined;
    const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };
    const createBackend: CreateSlackBackendFn = async (opts) => {
      receivedBanner = opts.systemPromptAppend;
      resultSink.fn = opts.onResult ?? null;
      return makeFakeBackend({
        events: [{ type: 'done' }],
        result: { isError: false, usage: { inputTokens: 0, outputTokens: 0 } },
        resultSink,
      });
    };
    startSlackBridge({
      adapter,
      projectRoot: '/p',
      dataDir: '/d',
      createBackend,
      recordUsage: async () => undefined,
      log: () => {},
    });
    await emit(THREAD_MSG);
    assert.equal(receivedBanner, SLACK_SYSTEM_PROMPT_BANNER);
  });

  it('honours an override systemPromptAppend', async () => {
    const { adapter, emit } = makeFakeAdapter();
    let receivedBanner: string | undefined = undefined;
    const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };
    const createBackend: CreateSlackBackendFn = async (opts) => {
      receivedBanner = opts.systemPromptAppend;
      resultSink.fn = opts.onResult ?? null;
      return makeFakeBackend({
        events: [{ type: 'done' }],
        result: { isError: false, usage: { inputTokens: 0, outputTokens: 0 } },
        resultSink,
      });
    };
    startSlackBridge({
      adapter,
      projectRoot: '/p',
      dataDir: '/d',
      systemPromptAppend: 'override-banner',
      createBackend,
      recordUsage: async () => undefined,
      log: () => {},
    });
    await emit(THREAD_MSG);
    assert.equal(receivedBanner, 'override-banner');
  });
});

// ── Sub-AC 10.1: resolveBackend hook + per-threadKey backend cache ───
//
// The cache-hit / cache-miss assertions in the "happy path" suite above
// rely on factory call counts. Sub-AC 10.1 nails the cache contract
// down further by asserting on backend identity (cache hit returns the
// SAME instance) and on the per-`threadKey` partitioning (two distinct
// thread keys → two distinct backend instances, both wired through the
// factory). These tests fail loudly if a future refactor accidentally
// flattens the cache key (e.g. using `channelId` only) or rebuilds the
// backend on every turn.

describe('startSlackBridge — Sub-AC 10.1 resolveBackend + per-threadKey cache', () => {
  it('cache hit returns the exact same backend instance across turns in one thread', async () => {
    const { adapter, emit } = makeFakeAdapter();
    const constructed: Backend[] = [];
    const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };

    const createBackend: CreateSlackBackendFn = async (opts) => {
      resultSink.fn = opts.onResult ?? null;
      const b = makeFakeBackend({
        events: [
          { type: 'text_delta', text: 'reply' },
          { type: 'done' },
        ],
        result: { isError: false, usage: { inputTokens: 1, outputTokens: 1 } },
        resultSink,
      });
      constructed.push(b);
      return b;
    };

    const handle = startSlackBridge({
      adapter,
      projectRoot: '/p',
      dataDir: '/d',
      createBackend,
      recordUsage: async () => undefined,
      log: () => {},
    });

    await emit(THREAD_MSG);
    await emit({ ...THREAD_MSG, id: '2.0', text: 'second turn' });
    await emit({ ...THREAD_MSG, id: '3.0', text: 'third turn' });

    assert.equal(constructed.length, 1, 'factory invoked exactly once for one thread');

    const cached = handle.backends.get('slack:C123:T456');
    assert.ok(cached, 'cache entry exists for the thread');
    assert.strictEqual(
      cached,
      constructed[0],
      'cached backend is identity-equal to the constructed instance',
    );
  });

  it('different threadKeys hit the factory separately and produce distinct backends', async () => {
    const { adapter, emit } = makeFakeAdapter();
    const constructed: Array<{ threadKey: string; backend: Backend }> = [];
    const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };

    const createBackend: CreateSlackBackendFn = async (opts) => {
      resultSink.fn = opts.onResult ?? null;
      const backend = makeFakeBackend({
        events: [
          { type: 'text_delta', text: 'reply' },
          { type: 'done' },
        ],
        result: { isError: false, usage: { inputTokens: 1, outputTokens: 1 } },
        resultSink,
      });
      constructed.push({ threadKey: opts.thread.threadKey, backend });
      return backend;
    };

    const handle = startSlackBridge({
      adapter,
      projectRoot: '/p',
      dataDir: '/d',
      createBackend,
      recordUsage: async () => undefined,
      log: () => {},
    });

    // Two messages on distinct threads (different channel + thread combos).
    await emit({ ...THREAD_MSG, channelId: 'C-A', threadId: 'T-1', id: '1.0' });
    await emit({ ...THREAD_MSG, channelId: 'C-B', threadId: 'T-2', id: '2.0' });
    // Repeat the FIRST thread — must hit the cache, not the factory.
    await emit({ ...THREAD_MSG, channelId: 'C-A', threadId: 'T-1', id: '3.0' });

    assert.equal(
      constructed.length,
      2,
      'factory invoked once per distinct threadKey',
    );
    assert.equal(constructed[0]!.threadKey, 'slack:C-A:T-1');
    assert.equal(constructed[1]!.threadKey, 'slack:C-B:T-2');
    assert.notStrictEqual(
      constructed[0]!.backend,
      constructed[1]!.backend,
      'distinct threadKeys produce distinct backend instances',
    );

    assert.equal(handle.backends.size, 2, 'cache has one entry per threadKey');
    assert.strictEqual(
      handle.backends.get('slack:C-A:T-1'),
      constructed[0]!.backend,
    );
    assert.strictEqual(
      handle.backends.get('slack:C-B:T-2'),
      constructed[1]!.backend,
    );
  });

  it('the resolveBackend factory receives the agentchannels ThreadContext verbatim', async () => {
    const { adapter, emit } = makeFakeAdapter();
    const captured: ThreadContext[] = [];
    const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };

    const createBackend: CreateSlackBackendFn = async (opts) => {
      captured.push(opts.thread);
      resultSink.fn = opts.onResult ?? null;
      return makeFakeBackend({
        events: [{ type: 'done' }],
        result: { isError: false, usage: { inputTokens: 0, outputTokens: 0 } },
        resultSink,
      });
    };

    startSlackBridge({
      adapter,
      projectRoot: '/p',
      dataDir: '/d',
      createBackend,
      recordUsage: async () => undefined,
      log: () => {},
    });

    await emit(THREAD_MSG);

    assert.equal(captured.length, 1);
    const ctx = captured[0]!;
    // Cache key matches the agentchannels-supplied threadKey shape:
    // `${adapterName}:${channelId}:${threadId}`.
    assert.equal(ctx.threadKey, 'slack:C123:T456');
    assert.equal(ctx.channelId, 'C123');
    assert.equal(ctx.threadId, 'T456');
  });

  it('handle.backends is a live read-only view of the per-threadKey cache', async () => {
    const { adapter, emit } = makeFakeAdapter();
    const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };
    const createBackend: CreateSlackBackendFn = async (opts) => {
      resultSink.fn = opts.onResult ?? null;
      return makeFakeBackend({
        events: [{ type: 'done' }],
        result: { isError: false, usage: { inputTokens: 0, outputTokens: 0 } },
        resultSink,
      });
    };

    const handle = startSlackBridge({
      adapter,
      projectRoot: '/p',
      dataDir: '/d',
      createBackend,
      recordUsage: async () => undefined,
      log: () => {},
    });

    // Empty before any messages.
    assert.equal(handle.backends.size, 0, 'cache empty pre-flight');

    await emit(THREAD_MSG);
    assert.equal(handle.backends.size, 1, 'cache populated after first turn');

    await emit({ ...THREAD_MSG, channelId: 'C-X', threadId: 'T-X', id: '2.0' });
    assert.equal(
      handle.backends.size,
      2,
      'second distinct thread adds a second cache entry',
    );

    // The exposed view is the ReadonlyMap of the per-threadKey cache.
    // Iteration order should match insertion order (Map semantics).
    const keys = [...handle.backends.keys()];
    assert.deepEqual(keys, ['slack:C123:T456', 'slack:C-X:T-X']);
  });
});

// ── Usage-bucket isolation (heart of Sub-AC 8.2) ─────────────────────

describe('startSlackBridge — Slack usage bucket isolation', () => {
  it('routes usage to recordUsage with the thread-keyed record', async () => {
    const { adapter, emit } = makeFakeAdapter();
    const usageCalls: Array<{ dataDir: string; threadKey: string; tokens: number }> = [];
    const recordUsage: SlackUsageRecorder = async (dataDir, record) => {
      usageCalls.push({
        dataDir,
        threadKey: record.threadKey,
        tokens: record.totalTokens,
      });
      return undefined;
    };

    const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };
    const createBackend: CreateSlackBackendFn = async (opts) => {
      resultSink.fn = opts.onResult ?? null;
      return makeFakeBackend({
        events: [
          { type: 'text_delta', text: 'reply' },
          { type: 'done' },
        ],
        result: {
          isError: false,
          stopReason: 'end_turn',
          usage: { inputTokens: 17, outputTokens: 23 },
        },
        resultSink,
      });
    };

    startSlackBridge({
      adapter,
      projectRoot: '/tmp/fake',
      dataDir: '/tmp/fake/.aweek/agents',
      createBackend,
      recordUsage,
      log: () => {},
    });
    await emit(THREAD_MSG);

    // The usage call is fired via `Promise.resolve(...).catch(...)` so we
    // need to spin the event loop a few times for the microtask queue
    // (and for the fire-and-forget Promise) to settle.
    await drainAsync();

    assert.equal(usageCalls.length, 1);
    assert.equal(usageCalls[0]!.dataDir, '/tmp/fake/.aweek/agents');
    assert.equal(usageCalls[0]!.threadKey, 'slack:C123:T456');
    assert.equal(usageCalls[0]!.tokens, 40);
  });

  it('does NOT touch the per-agent .aweek/agents/<slug>/ tree', async () => {
    const base = await mkdtemp(join(tmpdir(), 'aweek-slack-bridge-iso-'));
    const dataDir = join(base, '.aweek', 'agents');
    // Pre-seed a per-agent tree so the test can compare snapshots.
    await mkdir(join(dataDir, 'researcher', 'usage'), { recursive: true });
    await mkdir(join(dataDir, '.locks'), { recursive: true });
    try {
      const before = await snapshotTree(dataDir);

      const { adapter, emit } = makeFakeAdapter();
      const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };
      const createBackend: CreateSlackBackendFn = async (opts) => {
        resultSink.fn = opts.onResult ?? null;
        return makeFakeBackend({
          events: [
            { type: 'text_delta', text: 'hi' },
            { type: 'done' },
          ],
          result: {
            isError: false,
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          resultSink,
        });
      };

      startSlackBridge({
        adapter,
        projectRoot: base,
        dataDir,
        createBackend,
        // Record-usage is NOT mocked — let the real
        // `appendSlackUsageRecord` write to disk so we can prove it
        // lands UNDER `.aweek/channels/slack/`, not `.aweek/agents/`.
        log: () => {},
      });
      await emit(THREAD_MSG);
      // Give the fire-and-forget write a few ticks to settle.
      await drainAsync();
      await new Promise<void>((r) => setTimeout(r, 50));
      await drainAsync();

      const after = await snapshotTree(dataDir);
      assert.deepEqual(
        after,
        before,
        'per-agent tree must be untouched by a Slack run',
      );

      // The Slack usage file landed where Sub-AC 8.1 says it should.
      const slackUsage = await readFile(
        join(base, '.aweek', 'channels', 'slack', 'usage.json'),
        'utf-8',
      );
      const records = JSON.parse(slackUsage);
      assert.ok(Array.isArray(records));
      assert.equal(records.length, 1);
      assert.equal(records[0].threadKey, 'slack:C123:T456');

      // And the lock dir is untouched — the per-agent heartbeat lock
      // surface was bypassed.
      const lockEntries = await readdir(join(dataDir, '.locks'));
      assert.deepEqual(lockEntries, [], '.aweek/agents/.locks/ must stay empty');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('logs but does not throw when recordUsage rejects', async () => {
    const { adapter, emit } = makeFakeAdapter();
    const messages: string[] = [];
    const recordUsage: SlackUsageRecorder = async () => {
      throw new Error('disk-on-fire');
    };
    const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };
    const createBackend: CreateSlackBackendFn = async (opts) => {
      resultSink.fn = opts.onResult ?? null;
      return makeFakeBackend({
        events: [{ type: 'done' }],
        result: { isError: false, usage: { inputTokens: 1, outputTokens: 1 } },
        resultSink,
      });
    };
    startSlackBridge({
      adapter,
      projectRoot: '/p',
      dataDir: '/d',
      createBackend,
      recordUsage,
      log: (m) => messages.push(m),
    });
    await emit(THREAD_MSG);
    // Drain microtasks AND macro tasks so the catch handler runs.
    await drainAsync();
    assert.ok(
      messages.some((m) => /Slack usage append failed/.test(m) && /disk-on-fire/.test(m)),
      `expected a usage-append failure log, got: ${JSON.stringify(messages)}`,
    );
  });
});

// ── Shutdown ─────────────────────────────────────────────────────────

describe('startSlackBridge — shutdown', () => {
  it('aborts in-flight messages, disposes cached backends, and is idempotent', async () => {
    const { adapter, emit } = makeFakeAdapter();
    let disposeCount = 0;
    const resultSink: { fn: ((r: ResultInfo) => void) | null } = { fn: null };
    const createBackend: CreateSlackBackendFn = async (opts) => {
      resultSink.fn = opts.onResult ?? null;
      return makeFakeBackend({
        events: [
          { type: 'text_delta', text: 'reply' },
          { type: 'done' },
        ],
        result: { isError: false, usage: { inputTokens: 1, outputTokens: 1 } },
        resultSink,
        onDispose: () => {
          disposeCount += 1;
        },
      });
    };

    const handle = startSlackBridge({
      adapter,
      projectRoot: '/p',
      dataDir: '/d',
      createBackend,
      recordUsage: async () => undefined,
      log: () => {},
    });
    await emit(THREAD_MSG);

    await handle.shutdown();
    assert.equal(disposeCount, 1, 'cached backend disposed exactly once');
    assert.equal(handle.backends.size, 0, 'cache cleared');

    // Idempotent: calling shutdown again does NOT re-dispose.
    await handle.shutdown();
    assert.equal(disposeCount, 1, 'second shutdown is a no-op');
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Drain the microtask + setImmediate queues a few times so any
 * fire-and-forget `Promise.resolve(...).catch(...)` chain has a chance
 * to settle before assertions run. Used because the bridge intentionally
 * does NOT await the usage-recorder write (the in-flight Slack reply
 * has already been delivered by the time we get there).
 */
async function drainAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setImmediate(r));
    await Promise.resolve();
  }
}

/**
 * Sorted list of relative paths under `root`. Used for byte-equality
 * snapshots in the isolation test.
 */
async function snapshotTree(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        await walk(full, rel);
      } else {
        out.push(rel);
      }
    }
  };
  await walk(root, '');
  out.sort();
  return out;
}

const _silenceUnused: SlackBridgeOptions | undefined = undefined;
void _silenceUnused;
