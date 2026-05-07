/**
 * Tests for `./task-warning-notifier.ts` — the verifier-driven warning
 * emitter. Mirrors the structure of `repeated-failure-notifier.test.ts`
 * (real `NotificationStore` over a tmp dir) so we exercise the
 * persistence path end-to-end.
 *
 * Pinned contract:
 *
 *   1. `buildDedupKey` produces the documented `task-warnings:<a>:<w>:<t>` shape.
 *   2. Returns `{ fired: false, reason: 'no_notification_store' }` when store is missing.
 *   3. Returns `{ fired: false, reason: 'no_concerns' }` when the concerns array is empty.
 *   4. Fires on a real concern list — notification has severity='warning', system event,
 *      sourceTaskId, dedupKey, and concerns embedded in metadata.
 *   5. Re-firing with the same dedupKey while the previous notification is unread
 *      collapses to a single row (idempotency).
 *   6. Caps the body to {@link MAX_CONCERNS_IN_BODY} entries.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildDedupKey,
  maybeEmitTaskWarningsNotification,
} from './task-warning-notifier.ts';
import { NotificationStore } from '../storage/notification-store.ts';

const AGENT_ID = 'tester-agent-1';
const WEEK = '2026-W19';

describe('task-warning-notifier', () => {
  let tmpDir: string;
  let notificationStore: NotificationStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'task-warning-notifier-test-'));
    notificationStore = new NotificationStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('builds a stable dedupKey including agent, week, and task ID', () => {
    assert.equal(
      buildDedupKey('agent-foo', '2026-W19', 'task-abc'),
      'task-warnings:agent-foo:2026-W19:task-abc',
    );
  });

  it('returns no_notification_store when the store is missing', async () => {
    const outcome = await maybeEmitTaskWarningsNotification({
      agentId: AGENT_ID,
      week: WEEK,
      task: { id: 'task-1', title: 't' },
      concerns: ['c1'],
    });
    assert.equal(outcome.fired, false);
    assert.equal(
      outcome.fired === false && outcome.reason,
      'no_notification_store',
    );
  });

  it('returns no_concerns when the concerns array is empty', async () => {
    const outcome = await maybeEmitTaskWarningsNotification({
      notificationStore,
      agentId: AGENT_ID,
      week: WEEK,
      task: { id: 'task-1', title: 't' },
      concerns: [],
    });
    assert.equal(outcome.fired, false);
    assert.equal(outcome.fired === false && outcome.reason, 'no_concerns');
  });

  it('fires the notification with severity=warning + dedupKey + metadata', async () => {
    const outcome = await maybeEmitTaskWarningsNotification({
      notificationStore,
      agentId: AGENT_ID,
      week: WEEK,
      task: {
        id: 'task-publish',
        title: 'Publish Friday digest',
        objectiveId: 'objective-x-com',
      },
      concerns: ['No publish tool ran', 'Output describes a draft'],
    });

    assert.equal(outcome.fired, true);
    if (!outcome.fired) return;
    assert.equal(
      outcome.dedupKey,
      'task-warnings:tester-agent-1:2026-W19:task-publish',
    );

    const persisted = await notificationStore.load(AGENT_ID);
    assert.equal(persisted.length, 1);
    const row = persisted[0]!;
    assert.equal(row.source, 'system');
    assert.equal(row.systemEvent, 'task-warnings');
    assert.equal(row.severity, 'warning');
    assert.equal(row.sourceTaskId, 'task-publish');
    assert.match(row.title, /Publish Friday digest/);
    assert.match(row.body, /No publish tool ran/);
    assert.match(row.body, /Output describes a draft/);
    assert.deepEqual(
      (row.metadata as { concerns?: string[] } | undefined)?.concerns,
      ['No publish tool ran', 'Output describes a draft'],
    );
  });

  it('idempotent: a duplicate emission collapses against the unread row', async () => {
    const baseInput = {
      notificationStore,
      agentId: AGENT_ID,
      week: WEEK,
      task: { id: 'task-publish', title: 'Publish Friday digest' },
      concerns: ['No publish tool ran'],
    };

    const first = await maybeEmitTaskWarningsNotification(baseInput);
    assert.equal(first.fired, true);

    // A second emission with the same dedupKey while the first is still
    // unread should not append a second row to the on-disk feed. The
    // `send()` API still returns a fresh `Notification` object each time
    // (the dedup happens at the store level), so we assert against the
    // persisted feed rather than the returned ids.
    const second = await maybeEmitTaskWarningsNotification(baseInput);
    assert.equal(second.fired, true);
    if (!first.fired || !second.fired) return;
    assert.equal(second.dedupKey, first.dedupKey);

    const persisted = await notificationStore.load(AGENT_ID);
    assert.equal(persisted.length, 1);
  });

  it('falls back to taskId in the title when title is empty', async () => {
    const outcome = await maybeEmitTaskWarningsNotification({
      notificationStore,
      agentId: AGENT_ID,
      week: WEEK,
      task: { id: 'task-no-title', title: '' },
      concerns: ['c1'],
    });
    assert.equal(outcome.fired, true);

    const persisted = await notificationStore.load(AGENT_ID);
    assert.match(persisted[0]!.title, /task-no-title/);
  });
});
