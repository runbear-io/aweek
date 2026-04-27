import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  REPEATED_FAILURE_THRESHOLD,
  buildDedupKey,
  maybeEmitRepeatedFailureNotification,
} from './repeated-failure-notifier.js';
import { WeeklyPlanStore, type WeeklyPlan, type WeeklyTask } from '../storage/weekly-plan-store.js';
import { NotificationStore } from '../storage/notification-store.js';
import { createTask, createWeeklyPlan } from '../models/agent.js';

const AGENT_ID = 'tester-agent-1';
const WEEK = '2026-W16';
const MONTH = '2026-04';

function makePlanWithTask(): { plan: WeeklyPlan; task: WeeklyTask } {
  const task = createTask(
    { title: 'Wedged task', prompt: 'Wedged prompt' },
    'objective-A',
  ) as WeeklyTask;
  const plan = createWeeklyPlan(WEEK, MONTH, [task]) as WeeklyPlan;
  plan.approved = true;
  return { plan, task };
}

describe('repeated-failure-notifier', () => {
  let tmpDir: string;
  let weeklyPlanStore: WeeklyPlanStore;
  let notificationStore: NotificationStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'repeated-failure-notifier-test-'));
    weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    notificationStore = new NotificationStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('exports the documented threshold constant of 2', () => {
    assert.equal(REPEATED_FAILURE_THRESHOLD, 2);
  });

  it('builds a stable dedupKey including agent, week, and task ID', () => {
    assert.equal(
      buildDedupKey('agent-foo', '2026-W16', 'task-abc'),
      'repeated-task-failure:agent-foo:2026-W16:task-abc',
    );
  });

  it('returns no_notification_store when notificationStore is missing', async () => {
    const { plan, task } = makePlanWithTask();
    await weeklyPlanStore.save(AGENT_ID, plan);

    const outcome = await maybeEmitRepeatedFailureNotification({
      weeklyPlanStore,
      // notificationStore deliberately omitted
      agentId: AGENT_ID,
      week: WEEK,
      task,
    });

    assert.equal(outcome.fired, false);
    assert.equal(
      outcome.fired === false && outcome.reason,
      'no_notification_store',
    );
  });

  it('returns tracker_unavailable when the plan does not exist', async () => {
    const { task } = makePlanWithTask();
    // Note: no plan saved.
    const outcome = await maybeEmitRepeatedFailureNotification({
      weeklyPlanStore,
      notificationStore,
      agentId: AGENT_ID,
      week: WEEK,
      task,
    });
    assert.equal(outcome.fired, false);
    assert.equal(
      outcome.fired === false && outcome.reason,
      'tracker_unavailable',
    );
  });

  it('does NOT fire on the first consecutive failure (below threshold)', async () => {
    const { plan, task } = makePlanWithTask();
    await weeklyPlanStore.save(AGENT_ID, plan);

    // Simulate one failure — counter goes 0 → 1.
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');

    const outcome = await maybeEmitRepeatedFailureNotification({
      weeklyPlanStore,
      notificationStore,
      agentId: AGENT_ID,
      week: WEEK,
      task,
    });

    assert.equal(outcome.fired, false);
    if (outcome.fired === false && outcome.reason === 'below_threshold') {
      assert.equal(outcome.consecutiveFailures, 1);
    } else {
      assert.fail(`unexpected outcome: ${JSON.stringify(outcome)}`);
    }

    // Storage layer should also be empty.
    const feed = await notificationStore.load(AGENT_ID);
    assert.equal(feed.length, 0);
  });

  it('fires exactly once when consecutiveFailures hits 2', async () => {
    const { plan, task } = makePlanWithTask();
    await weeklyPlanStore.save(AGENT_ID, plan);

    // Two failures back-to-back.
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');

    const outcome = await maybeEmitRepeatedFailureNotification({
      weeklyPlanStore,
      notificationStore,
      agentId: AGENT_ID,
      week: WEEK,
      task,
    });

    assert.equal(outcome.fired, true);
    if (outcome.fired === true) {
      assert.equal(outcome.consecutiveFailures, 2);
      assert.equal(outcome.dedupKey, buildDedupKey(AGENT_ID, WEEK, task.id));
      assert.match(outcome.notificationId, /^notif-[a-f0-9]+$/);
    }

    // Verify the persisted notification has the correct shape.
    const feed = await notificationStore.load(AGENT_ID);
    assert.equal(feed.length, 1);
    const n = feed[0]!;
    assert.equal(n.source, 'system');
    assert.equal(n.systemEvent, 'repeated-task-failure');
    assert.equal(n.agentId, AGENT_ID);
    assert.equal(n.read, false);
    assert.equal(n.sourceTaskId, task.id);
    assert.equal(n.dedupKey, buildDedupKey(AGENT_ID, WEEK, task.id));
    // Metadata pinned for downstream consumers.
    const meta = n.metadata as Record<string, unknown> | undefined;
    assert.ok(meta);
    assert.equal(meta.week, WEEK);
    assert.equal(meta.consecutiveFailures, 2);
    assert.equal(meta.objectiveId, 'objective-A');
  });

  it('latches the task so a third consecutive failure does NOT re-emit', async () => {
    const { plan, task } = makePlanWithTask();
    await weeklyPlanStore.save(AGENT_ID, plan);

    // Two failures → emit.
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');
    const first = await maybeEmitRepeatedFailureNotification({
      weeklyPlanStore,
      notificationStore,
      agentId: AGENT_ID,
      week: WEEK,
      task,
    });
    assert.equal(first.fired, true);

    // Third failure — counter goes to 3, but the latch should prevent
    // a second emission.
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');
    const second = await maybeEmitRepeatedFailureNotification({
      weeklyPlanStore,
      notificationStore,
      agentId: AGENT_ID,
      week: WEEK,
      task,
    });
    assert.equal(second.fired, false);
    if (second.fired === false && second.reason === 'already_emitted') {
      assert.equal(second.consecutiveFailures, 3);
    } else {
      assert.fail(`unexpected outcome: ${JSON.stringify(second)}`);
    }

    // Feed still has exactly one notification.
    const feed = await notificationStore.load(AGENT_ID);
    assert.equal(feed.length, 1);
  });

  it('re-fires after the failing streak is broken (status flips to non-failed)', async () => {
    const { plan, task } = makePlanWithTask();
    await weeklyPlanStore.save(AGENT_ID, plan);

    // Initial 2 failures + emission.
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');
    const first = await maybeEmitRepeatedFailureNotification({
      weeklyPlanStore,
      notificationStore,
      agentId: AGENT_ID,
      week: WEEK,
      task,
    });
    assert.equal(first.fired, true);

    // Mark the prior notification as read so the store-level dedupKey
    // path doesn't suppress the next legitimate emission.
    if (first.fired === true) {
      await notificationStore.markRead(AGENT_ID, first.notificationId);
    }

    // Streak breaks — status transitions out of `failed`.
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'pending');

    // Tracker should now be reset (counter cleared, latch cleared).
    const tracker = await weeklyPlanStore.getFailureTracker(
      AGENT_ID,
      WEEK,
      task.id,
    );
    assert.deepEqual(tracker, {
      consecutiveFailures: 0,
      notificationEmitted: false,
    });

    // Two new failures — fresh streak.
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');
    const second = await maybeEmitRepeatedFailureNotification({
      weeklyPlanStore,
      notificationStore,
      agentId: AGENT_ID,
      week: WEEK,
      task,
    });
    assert.equal(second.fired, true);

    // Two notifications now in the feed: one read (the original), one
    // unread (the new streak's).
    const feed = await notificationStore.load(AGENT_ID);
    assert.equal(feed.length, 2);
    assert.equal(feed[0]?.read, true);
    assert.equal(feed[1]?.read, false);
  });

  it('reports send_failed when the notification store throws and does NOT latch', async () => {
    const { plan, task } = makePlanWithTask();
    await weeklyPlanStore.save(AGENT_ID, plan);

    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');

    // Stub the store's `send()` to reject.
    const failingStore = {
      send: async () => {
        throw new Error('boom');
      },
    } as unknown as NotificationStore;

    const outcome = await maybeEmitRepeatedFailureNotification({
      weeklyPlanStore,
      notificationStore: failingStore,
      agentId: AGENT_ID,
      week: WEEK,
      task,
    });

    assert.equal(outcome.fired, false);
    if (outcome.fired === false && outcome.reason === 'send_failed') {
      assert.match(outcome.error.message, /boom/);
    } else {
      assert.fail(`unexpected outcome: ${JSON.stringify(outcome)}`);
    }

    // Latch must remain clear so the next tick can retry.
    const tracker = await weeklyPlanStore.getFailureTracker(
      AGENT_ID,
      WEEK,
      task.id,
    );
    assert.equal(tracker?.notificationEmitted, false);

    // Real notification store remains empty.
    const feed = await notificationStore.load(AGENT_ID);
    assert.equal(feed.length, 0);
  });

  it('keeps the notification title within the schema 200-char cap for max-length task titles', async () => {
    // Weekly-task schema caps `title` at 80 chars; build the longest-allowed
    // title and verify the formatted notification title still fits inside
    // the notification schema's 200-char budget.
    const longTitle = 'x'.repeat(80);
    const task = createTask(
      { title: longTitle, prompt: 'p' },
      'objective-long',
    ) as WeeklyTask;
    const plan = createWeeklyPlan(WEEK, MONTH, [task]) as WeeklyPlan;
    plan.approved = true;
    await weeklyPlanStore.save(AGENT_ID, plan);

    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, task.id, 'failed');

    const outcome = await maybeEmitRepeatedFailureNotification({
      weeklyPlanStore,
      notificationStore,
      agentId: AGENT_ID,
      week: WEEK,
      task,
    });
    assert.equal(outcome.fired, true);

    const feed = await notificationStore.load(AGENT_ID);
    assert.equal(feed.length, 1);
    // Notification schema caps `title` at 200 chars.
    assert.ok(feed[0]!.title.length <= 200);
  });
});
