/**
 * Tests for the chat-side bridge into the shared usage store.
 *
 * Sub-AC 1 of AC 7: chat-driven token spend has to land in the same
 * weekly usage record the heartbeat reads. These tests verify:
 *
 *   - `chatUsageTaskId` priority: threadId → sessionId → bare "chat".
 *   - `buildChatUsageRecord` folds cache token counts into `inputTokens`,
 *     produces a schema-valid record, and honours week/timestamp overrides.
 *   - `recordChatUsage` initialises the store, calls `append` exactly
 *     once, and round-trips through the real `UsageStore` so the same
 *     weekly file the heartbeat reads picks up the chat usage.
 *   - Negative inputs (missing agentId, missing usage) throw.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildChatUsageRecord,
  chatUsageTaskId,
  recordChatUsage,
  type ChatUsageStoreLike,
} from './chat-usage.js';
import { UsageStore, type UsageRecord } from '../../storage/usage-store.js';
import { validateUsageRecord } from '../../schemas/validator.js';
import type { ChatTokenUsage } from './chat.js';

describe('chat-usage chatUsageTaskId', () => {
  it('prefers threadId over sessionId', () => {
    assert.equal(
      chatUsageTaskId({ threadId: 'thread-1', sessionId: 'sess-1' }),
      'chat:thread-1',
    );
  });

  it('falls back to sessionId when threadId is missing', () => {
    assert.equal(chatUsageTaskId({ sessionId: 'sess-2' }), 'chat:sess-2');
  });

  it('falls back to bare "chat" when both ids are missing', () => {
    assert.equal(chatUsageTaskId({}), 'chat');
  });

  it('treats empty strings as missing', () => {
    assert.equal(
      chatUsageTaskId({ threadId: '', sessionId: '' }),
      'chat',
    );
  });
});

describe('chat-usage buildChatUsageRecord', () => {
  const baseUsage: ChatTokenUsage = {
    inputTokens: 100,
    outputTokens: 50,
  };

  it('produces a schema-valid record', () => {
    const record = buildChatUsageRecord({
      agentId: 'writer',
      threadId: 'thread-1',
      sessionId: 'sess-1',
      usage: baseUsage,
      durationMs: 1234,
      model: 'claude-sonnet-4',
      week: '2026-04-13',
      timestamp: '2026-04-15T12:00:00.000Z',
    });
    const v = validateUsageRecord(record);
    assert.ok(v.valid, `Schema validation failed: ${JSON.stringify(v.errors)}`);
    assert.equal(record.agentId, 'writer');
    assert.equal(record.taskId, 'chat:thread-1');
    assert.equal(record.sessionId, 'sess-1');
    assert.equal(record.inputTokens, 100);
    assert.equal(record.outputTokens, 50);
    assert.equal(record.totalTokens, 150);
    assert.equal(record.durationMs, 1234);
    assert.equal(record.model, 'claude-sonnet-4');
    assert.equal(record.week, '2026-04-13');
    assert.equal(record.timestamp, '2026-04-15T12:00:00.000Z');
  });

  it('folds cache read + creation tokens into inputTokens', () => {
    const record = buildChatUsageRecord({
      agentId: 'writer',
      threadId: 'thread-1',
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 30,
        cacheCreationTokens: 5,
      },
      week: '2026-04-13',
    });
    // 100 input + 30 cache-read + 5 cache-creation = 135 input total.
    assert.equal(record.inputTokens, 135);
    assert.equal(record.outputTokens, 25);
    assert.equal(record.totalTokens, 160);
  });

  it('records costUsd when reported as a positive number', () => {
    const record = buildChatUsageRecord({
      agentId: 'writer',
      threadId: 'thread-1',
      usage: {
        ...baseUsage,
        totalCostUsd: 0.0123,
      },
      week: '2026-04-13',
    });
    assert.equal(record.costUsd, 0.0123);
  });

  it('omits costUsd when zero', () => {
    const record = buildChatUsageRecord({
      agentId: 'writer',
      threadId: 'thread-1',
      usage: {
        ...baseUsage,
        totalCostUsd: 0,
      },
      week: '2026-04-13',
    });
    assert.equal(record.costUsd, undefined);
  });

  it('clamps negative or non-integer token counts to zero', () => {
    const record = buildChatUsageRecord({
      agentId: 'writer',
      threadId: 'thread-1',
      usage: {
        inputTokens: -10,
        outputTokens: 12.7,
      },
      week: '2026-04-13',
    });
    assert.equal(record.inputTokens, 0);
    assert.equal(record.outputTokens, 12);
    assert.equal(record.totalTokens, 12);
  });

  it('uses sessionId as taskId fallback when threadId is missing', () => {
    const record = buildChatUsageRecord({
      agentId: 'writer',
      sessionId: 'sess-99',
      usage: baseUsage,
      week: '2026-04-13',
    });
    assert.equal(record.taskId, 'chat:sess-99');
  });

  it('emits a stable record id pattern for schema validation', () => {
    const record = buildChatUsageRecord({
      agentId: 'writer',
      threadId: 'thread-1',
      usage: baseUsage,
      week: '2026-04-13',
    });
    assert.match(record.id, /^usage-[a-f0-9]+$/);
  });
});

describe('chat-usage recordChatUsage with a fake store', () => {
  it('calls init then append exactly once', async () => {
    const calls: { method: string; agentId: string; record?: UsageRecord }[] = [];
    const store: ChatUsageStoreLike = {
      async init(agentId) {
        calls.push({ method: 'init', agentId });
      },
      async append(agentId, record) {
        calls.push({ method: 'append', agentId, record });
      },
    };
    const result = await recordChatUsage(store, {
      agentId: 'writer',
      threadId: 'thread-1',
      sessionId: 'sess-1',
      usage: { inputTokens: 7, outputTokens: 3 },
      week: '2026-04-13',
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'init');
    assert.equal(calls[1].method, 'append');
    assert.equal(calls[1].agentId, 'writer');
    assert.equal(calls[1].record?.taskId, 'chat:thread-1');
    assert.equal(calls[1].record?.totalTokens, 10);
    assert.equal(result.record.totalTokens, 10);
  });

  it('skips init when the store does not expose one', async () => {
    let appendCount = 0;
    const store: ChatUsageStoreLike = {
      async append(_agentId, _record) {
        appendCount += 1;
      },
    };
    await recordChatUsage(store, {
      agentId: 'writer',
      threadId: 'thread-1',
      usage: { inputTokens: 1, outputTokens: 1 },
      week: '2026-04-13',
    });
    assert.equal(appendCount, 1);
  });

  it('throws when agentId is missing', async () => {
    const store: ChatUsageStoreLike = {
      async append() {},
    };
    await assert.rejects(
      () =>
        recordChatUsage(store, {
          agentId: '',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      /agentId/,
    );
  });

  it('throws when usage is missing', async () => {
    const store: ChatUsageStoreLike = {
      async append() {},
    };
    await assert.rejects(
      () =>
        recordChatUsage(store, {
          agentId: 'writer',
          // @ts-expect-error — testing the runtime guard
          usage: undefined,
        }),
      /usage/,
    );
  });
});

describe('chat-usage recordChatUsage with the real UsageStore', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'aweek-chat-usage-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('writes into the same weekly file the heartbeat reads', async () => {
    const store = new UsageStore(baseDir);
    await recordChatUsage(store, {
      agentId: 'writer',
      threadId: 'thread-1',
      sessionId: 'sess-1',
      usage: { inputTokens: 200, outputTokens: 75, totalCostUsd: 0.005 },
      durationMs: 1500,
      model: 'claude-sonnet-4',
      week: '2026-04-13',
      timestamp: '2026-04-15T12:00:00.000Z',
    });

    // Same week-key the heartbeat would read for the same Monday.
    const records = await store.load('writer', '2026-04-13');
    assert.equal(records.length, 1);
    const r = records[0];
    assert.equal(r.agentId, 'writer');
    assert.equal(r.taskId, 'chat:thread-1');
    assert.equal(r.sessionId, 'sess-1');
    assert.equal(r.inputTokens, 200);
    assert.equal(r.outputTokens, 75);
    assert.equal(r.totalTokens, 275);
    assert.equal(r.costUsd, 0.005);
    assert.equal(r.durationMs, 1500);
    assert.equal(r.model, 'claude-sonnet-4');

    // The weekly aggregate the budget enforcer queries must include this
    // record's totals — that is the contract of "chat counts against the
    // shared budget pool".
    const totals = await store.weeklyTotal('writer', '2026-04-13');
    assert.equal(totals.totalTokens, 275);
    assert.equal(totals.recordCount, 1);
    assert.equal(totals.costUsd, 0.005);
  });

  it('chat + heartbeat usage accumulate in one weekly bucket', async () => {
    const store = new UsageStore(baseDir);

    // Heartbeat-style record (real path uses createUsageRecord directly).
    await store.append('writer', {
      id: 'usage-aaaaaaaa',
      timestamp: '2026-04-13T08:00:00.000Z',
      agentId: 'writer',
      taskId: 'task-001',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      week: '2026-04-13',
    });

    // Chat-side record routes through the same store + week key.
    await recordChatUsage(store, {
      agentId: 'writer',
      threadId: 'thread-1',
      sessionId: 'sess-1',
      usage: { inputTokens: 200, outputTokens: 75 },
      week: '2026-04-13',
      timestamp: '2026-04-15T12:00:00.000Z',
    });

    const totals = await store.weeklyTotal('writer', '2026-04-13');
    assert.equal(totals.recordCount, 2);
    assert.equal(totals.inputTokens, 1200);
    assert.equal(totals.outputTokens, 575);
    assert.equal(totals.totalTokens, 1775);
  });

  it('idempotency: re-appending the same record id is a no-op', async () => {
    const store = new UsageStore(baseDir);
    const before = await recordChatUsage(store, {
      agentId: 'writer',
      threadId: 'thread-1',
      usage: { inputTokens: 50, outputTokens: 25 },
      week: '2026-04-13',
    });
    // Manually re-append the same record — UsageStore.append dedups by id.
    await store.append('writer', before.record);
    const records = await store.load('writer', '2026-04-13');
    assert.equal(records.length, 1);
    assert.equal(records[0].id, before.record.id);
  });
});
