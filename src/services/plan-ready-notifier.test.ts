/**
 * Colocated tests for the plan-ready system-event emitter (AC 6).
 *
 * Pinned invariants:
 *   - Emits a `source: 'system'`, `systemEvent: 'plan-ready'` notification
 *     when a pending (`approved: false`) weekly plan is provided.
 *   - The senderSlug is the agent whose plan needs approval (subject = sender
 *     for system events, mirroring the budget-exhausted emitter pattern).
 *   - Carries `dedupKey: 'plan-ready:<agentId>:<week>'` so re-emission for
 *     the same plan while the prior notification is still unread is a
 *     storage-layer no-op.
 *   - Skips emission for already-approved plans (auto-chain path).
 *   - Best-effort: a thrown notification-store error is caught, logged, and
 *     surfaced via the structured return value rather than escalating.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  emitPlanReadyNotification,
  planReadyDedupKey,
  planReadyTitle,
  planReadyBody,
} from './plan-ready-notifier.js';
import { NotificationStore } from '../storage/notification-store.js';

describe('plan-ready-notifier (AC 6)', () => {
  let baseDir: string;
  let store: NotificationStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'plan-ready-notifier-test-'));
    store = new NotificationStore(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  describe('helpers', () => {
    it('planReadyDedupKey composes the canonical key shape', () => {
      assert.equal(
        planReadyDedupKey('content-marketer', '2026-W18'),
        'plan-ready:content-marketer:2026-W18',
      );
    });

    it('planReadyTitle is a non-empty stable string', () => {
      const title = planReadyTitle();
      assert.equal(typeof title, 'string');
      assert.ok(title.length > 0);
    });

    it('planReadyBody references the agent slug, week, and task count', () => {
      const body = planReadyBody('content-marketer', {
        week: '2026-W18',
        month: '2026-04',
        approved: false,
        tasks: [{ id: 'task-1' }, { id: 'task-2' }, { id: 'task-3' }],
      });
      assert.match(body, /content-marketer/);
      assert.match(body, /2026-W18/);
      assert.match(body, /3 tasks/);
    });

    it('planReadyBody pluralises task count correctly', () => {
      assert.match(
        planReadyBody('a', { week: '2026-W18', tasks: [{ id: 't' }] }),
        /1 task[^s]/,
      );
      assert.match(
        planReadyBody('a', { week: '2026-W18', tasks: [] }),
        /0 tasks/,
      );
    });
  });

  describe('emitPlanReadyNotification — happy path', () => {
    it('emits a system notification with sender = agent slug', async () => {
      const result = await emitPlanReadyNotification(store, 'content-marketer', {
        week: '2026-W18',
        month: '2026-04',
        approved: false,
        tasks: [{ id: 'task-1' }],
      });

      assert.equal(result.emitted, true);
      assert.ok(result.notificationId, 'notification id should be set');
      assert.equal(result.dedupKey, 'plan-ready:content-marketer:2026-W18');

      // The notification persists under the agent's per-agent file (sender =
      // subject for system events, so the feed lives on the same agent).
      const feed = await store.load('content-marketer');
      assert.equal(feed.length, 1);
      const notif = feed[0]!;
      assert.equal(notif.agentId, 'content-marketer');
      assert.equal(notif.source, 'system');
      assert.equal(notif.systemEvent, 'plan-ready');
      assert.equal(notif.dedupKey, 'plan-ready:content-marketer:2026-W18');
      assert.equal(notif.read, false);
      assert.match(notif.title, /Weekly plan/);
      assert.match(notif.body, /content-marketer/);
      assert.match(notif.body, /2026-W18/);
    });

    it('attaches week / month / taskCount metadata', async () => {
      await emitPlanReadyNotification(store, 'content-marketer', {
        week: '2026-W18',
        month: '2026-04',
        approved: false,
        tasks: [{ id: 't1' }, { id: 't2' }],
      });

      const feed = await store.load('content-marketer');
      assert.deepEqual(feed[0]!.metadata, {
        week: '2026-W18',
        month: '2026-04',
        taskCount: 2,
      });
    });

    it('respects an explicit createdAt timestamp', async () => {
      const ts = '2026-04-27T12:34:56.000Z';
      await emitPlanReadyNotification(
        store,
        'content-marketer',
        { week: '2026-W18', approved: false, tasks: [] },
        { timestamp: ts },
      );
      const feed = await store.load('content-marketer');
      assert.equal(feed[0]!.createdAt, ts);
    });
  });

  describe('emitPlanReadyNotification — dedup', () => {
    it('storage-layer dedup suppresses re-emission while prior is unread', async () => {
      const first = await emitPlanReadyNotification(store, 'content-marketer', {
        week: '2026-W18',
        approved: false,
        tasks: [{ id: 't1' }],
      });
      assert.equal(first.emitted, true);

      const second = await emitPlanReadyNotification(store, 'content-marketer', {
        week: '2026-W18',
        approved: false,
        tasks: [{ id: 't1' }, { id: 't2' }],
      });
      // Pre-write probe should detect the existing unread match → reports
      // emitted=false even though the store no-ops idempotently.
      assert.equal(second.emitted, false);

      const feed = await store.load('content-marketer');
      assert.equal(feed.length, 1, 'feed must contain exactly one notification');
    });

    it('different week emits a new notification (week is part of dedupKey)', async () => {
      await emitPlanReadyNotification(store, 'content-marketer', {
        week: '2026-W18',
        approved: false,
        tasks: [],
      });
      const second = await emitPlanReadyNotification(store, 'content-marketer', {
        week: '2026-W19',
        approved: false,
        tasks: [],
      });

      assert.equal(second.emitted, true);
      const feed = await store.load('content-marketer');
      assert.equal(feed.length, 2);
      assert.deepEqual(
        feed.map((n) => n.dedupKey).sort(),
        [
          'plan-ready:content-marketer:2026-W18',
          'plan-ready:content-marketer:2026-W19',
        ],
      );
    });

    it('after the prior notification is read, a fresh emit creates a new entry', async () => {
      const first = await emitPlanReadyNotification(store, 'content-marketer', {
        week: '2026-W18',
        approved: false,
        tasks: [],
      });
      assert.ok(first.notificationId);
      await store.markRead('content-marketer', first.notificationId!);

      const second = await emitPlanReadyNotification(store, 'content-marketer', {
        week: '2026-W18',
        approved: false,
        tasks: [{ id: 't1' }],
      });

      // Storage-layer dedup only suppresses on UNREAD matches, so once the
      // user has read the prior plan-ready notification, a re-emit creates
      // a new entry. That matches the v1 contract: read clears the latch.
      assert.equal(second.emitted, true);
      const feed = await store.load('content-marketer');
      assert.equal(feed.length, 2);
    });
  });

  describe('emitPlanReadyNotification — skip paths', () => {
    it('no-ops when notificationStore is missing', async () => {
      const result = await emitPlanReadyNotification(null, 'content-marketer', {
        week: '2026-W18',
        approved: false,
        tasks: [],
      });
      assert.equal(result.emitted, false);
      assert.equal(result.notificationId, null);
    });

    it('no-ops when plan is already approved', async () => {
      const result = await emitPlanReadyNotification(store, 'content-marketer', {
        week: '2026-W18',
        approved: true,
        tasks: [],
      });
      assert.equal(result.emitted, false);
      const feed = await store.load('content-marketer');
      assert.equal(feed.length, 0, 'no notification must persist for approved plans');
    });

    it('no-ops when agentId is empty', async () => {
      const result = await emitPlanReadyNotification(store, '', {
        week: '2026-W18',
        approved: false,
        tasks: [],
      });
      assert.equal(result.emitted, false);
    });

    it('no-ops when plan.week is missing', async () => {
      const result = await emitPlanReadyNotification(store, 'content-marketer', {
        // week deliberately missing
        approved: false,
        tasks: [],
      } as unknown as Parameters<typeof emitPlanReadyNotification>[2]);
      assert.equal(result.emitted, false);
    });
  });

  describe('emitPlanReadyNotification — error isolation', () => {
    it('catches and reports notification-store errors without throwing', async () => {
      // A stub store whose send() always throws — the emitter must surface
      // the failure as `emitted: false` rather than letting the rejection
      // bubble out and break the calling generator.
      const brokenStore = {
        // The actual NotificationStore methods the emitter calls.
        query: async () => [],
        send: async () => {
          throw new Error('simulated disk full');
        },
      } as unknown as NotificationStore;

      const result = await emitPlanReadyNotification(brokenStore, 'content-marketer', {
        week: '2026-W18',
        approved: false,
        tasks: [],
      });

      assert.equal(result.emitted, false);
      assert.equal(result.notificationId, null);
      assert.equal(result.dedupKey, 'plan-ready:content-marketer:2026-W18');
    });

    it('treats a query-side failure as best-effort and still attempts send', async () => {
      // query() throws but send() works — emitter should still write the
      // notification and report emitted=true (storage layer is authoritative
      // about whether the write actually happened).
      let sendCalls = 0;
      const partialStore = {
        query: async () => {
          throw new Error('simulated read error');
        },
        send: async () => {
          sendCalls++;
          return {
            id: 'notif-fake01',
            agentId: 'content-marketer',
            source: 'system' as const,
            systemEvent: 'plan-ready' as const,
            title: 'x',
            body: 'y',
            createdAt: new Date().toISOString(),
            read: false,
            dedupKey: 'plan-ready:content-marketer:2026-W18',
          };
        },
      } as unknown as NotificationStore;

      const result = await emitPlanReadyNotification(partialStore, 'content-marketer', {
        week: '2026-W18',
        approved: false,
        tasks: [],
      });

      assert.equal(sendCalls, 1, 'send should have been attempted');
      assert.equal(result.emitted, true);
      assert.equal(result.notificationId, 'notif-fake01');
    });
  });
});
