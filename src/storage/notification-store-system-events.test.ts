/**
 * Convergence test for AC 7: every notification source — agent-initiated
 * (via the `notify` skill / `aweek exec notify send`) AND each of the three
 * v1 system events (budget-exhausted, repeated-task-failure, plan-ready) —
 * MUST persist into the same {@link NotificationStore} so that the
 * dashboard inbox, the global feed, and any future delivery channel see
 * them through one canonical surface.
 *
 * The other notification tests in this directory pin behaviour for one
 * source at a time (e.g. `repeated-failure-notifier.test.ts`,
 * `plan-ready-notifier.test.ts`, `budget-enforcer.test.ts`). This file is
 * the *integration* harness: it drives all four sources against ONE
 * `NotificationStore` instance, ONE temp data dir, ONE subscribed delivery
 * channel — and asserts:
 *
 *   1. All four notifications land in the same per-agent
 *      `.aweek/agents/<slug>/notifications.json` file.
 *   2. `loadAll()` returns every emission, regardless of source, in one
 *      time-ordered global feed.
 *   3. A single subscribed delivery channel observes every fresh emission
 *      from every source — so future Slack/email/push integrations get
 *      one subscription point that covers agent + system events.
 *   4. Source / systemEvent discriminators are preserved verbatim through
 *      every code path.
 *   5. Sender attribution (the `agentId` / `senderSlug`) is preserved
 *      through every code path.
 *
 * If any future refactor splits system events onto a sibling store, or if
 * an emitter starts writing JSON directly to disk, this test fails fast.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  NotificationStore,
  type Notification,
  type NotificationDeliveryChannel,
} from './notification-store.js';
import { AgentStore } from './agent-store.js';
import { UsageStore, createUsageRecord } from './usage-store.js';
import { WeeklyPlanStore, type WeeklyPlan, type WeeklyTask } from './weekly-plan-store.js';
import { createAgentConfig, createTask, createWeeklyPlan } from '../models/agent.js';
import { sendNotification } from '../skills/notify.js';
import { enforceBudget } from '../services/budget-enforcer.js';
import { maybeEmitRepeatedFailureNotification } from '../services/repeated-failure-notifier.js';
import { emitPlanReadyNotification } from '../services/plan-ready-notifier.js';

const AGENT_ID = 'integration-tester';
const WEEK = '2026-W16';
const MONTH = '2026-04';
const WEEK_MONDAY = '2026-04-13';

describe('AC 7 — all four notification sources converge on one NotificationStore', () => {
  let tmpDir: string;
  let agentStore: AgentStore;
  let usageStore: UsageStore;
  let weeklyPlanStore: WeeklyPlanStore;
  let notificationStore: NotificationStore;

  // The single subscribed delivery channel that AC 17 (subscribe API) opens
  // up. AC 7 asserts the channel sees every freshly persisted notification
  // from every source — proving future external push channels (Slack,
  // email, OS push) inherit fan-out from one subscription point.
  const channelObserved: Notification[] = [];
  const channel: NotificationDeliveryChannel = {
    name: 'integration-channel',
    deliver(notification) {
      channelObserved.push(notification);
    },
  };

  // Captured emissions in the order they happened so we can spot-check
  // each source's persisted entry by id.
  let agentNotificationId: string;
  let budgetNotificationId: string | null;
  let repeatedFailureNotificationId: string | undefined;
  let planReadyNotificationId: string | null;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'notification-system-events-test-'));
    agentStore = new AgentStore(tmpDir);
    usageStore = new UsageStore(tmpDir);
    weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    notificationStore = new NotificationStore(tmpDir, { channels: [channel] });

    // Seed the agent registry so the notify skill's sender-existence check
    // passes against the same baseDir the store will read.
    const config = createAgentConfig({
      subagentRef: AGENT_ID,
      weeklyTokenLimit: 1_000,
    });
    await agentStore.save(config);

    // ---------------------------------------------------------------------
    // Source 1 — agent-initiated via the notify skill.
    //   Mirrors `aweek exec notify send` in production; we hand the skill
    //   the same NotificationStore so AC 7's "same store" claim is concrete.
    // ---------------------------------------------------------------------
    const agentNotification = await sendNotification(
      {
        senderSlug: AGENT_ID,
        title: 'Hand-off ready',
        body: 'Drafted the launch checklist; please review.',
        options: { source: 'agent' },
      },
      { agentStore, notificationStore },
    );
    agentNotificationId = agentNotification.id;

    // ---------------------------------------------------------------------
    // Source 2 — budget-exhausted system event.
    //   Push usage well past the 1000-token weekly cap and drive enforceBudget
    //   with the same NotificationStore. The enforcer's send() call is the
    //   convergence point we're asserting.
    // ---------------------------------------------------------------------
    await usageStore.append(
      AGENT_ID,
      createUsageRecord({
        agentId: AGENT_ID,
        taskId: 'task-overuse',
        inputTokens: 600,
        outputTokens: 600,
        week: WEEK_MONDAY,
      }),
    );
    const budgetResult = await enforceBudget(
      AGENT_ID,
      { agentStore, usageStore, baseDir: tmpDir, notificationStore },
      WEEK_MONDAY,
    );
    assert.equal(budgetResult.notificationEmitted, true, 'budget enforcer must emit a notification on first pause');
    budgetNotificationId = budgetResult.notificationId;

    // ---------------------------------------------------------------------
    // Source 3 — repeated-task-failure system event.
    //   Save a weekly plan, transition the same task to failed twice so the
    //   counter crosses REPEATED_FAILURE_THRESHOLD (=2), then drive the
    //   emitter against the same NotificationStore.
    // ---------------------------------------------------------------------
    const wedgedTask = createTask(
      { title: 'Wedged task', prompt: 'Wedged prompt' },
      'objective-A',
    ) as WeeklyTask;
    const plan = createWeeklyPlan(WEEK, MONTH, [wedgedTask]) as WeeklyPlan;
    plan.approved = true;
    await weeklyPlanStore.save(AGENT_ID, plan);
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, wedgedTask.id, 'failed');
    await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK, wedgedTask.id, 'failed');

    const repeatedOutcome = await maybeEmitRepeatedFailureNotification({
      weeklyPlanStore,
      notificationStore,
      agentId: AGENT_ID,
      week: WEEK,
      task: { id: wedgedTask.id, title: wedgedTask.title, objectiveId: 'objective-A' },
    });
    assert.equal(repeatedOutcome.fired, true, 'repeated-failure emitter must fire on the second consecutive failure');
    if (repeatedOutcome.fired) {
      repeatedFailureNotificationId = repeatedOutcome.notificationId;
    }

    // ---------------------------------------------------------------------
    // Source 4 — plan-ready system event.
    //   Build a pending (approved=false) plan and emit through the same
    //   NotificationStore. This is the convergence point the
    //   weekly-plan-generator wires up in production via
    //   generateAndSaveWeeklyPlan.
    // ---------------------------------------------------------------------
    const planReadyOutcome = await emitPlanReadyNotification(
      notificationStore,
      AGENT_ID,
      {
        week: '2026-W17',
        month: MONTH,
        approved: false,
        tasks: [{ id: 'task-x' }, { id: 'task-y' }],
      },
    );
    assert.equal(planReadyOutcome.emitted, true, 'plan-ready emitter must emit on the first pending plan');
    planReadyNotificationId = planReadyOutcome.notificationId;
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('persists all four notifications into the same per-agent feed file', async () => {
    // Read the on-disk file directly. AC 7 fails if any emitter sneaks
    // around the store and writes to a sibling file.
    const filePath = join(tmpDir, AGENT_ID, 'notifications.json');
    const raw = await readFile(filePath, 'utf-8');
    const onDisk = JSON.parse(raw) as Notification[];

    const ids = onDisk.map((n) => n.id);
    assert.ok(ids.includes(agentNotificationId), 'agent-initiated notification missing from on-disk feed');
    assert.ok(budgetNotificationId, 'budget enforcer should have returned a notification id');
    assert.ok(ids.includes(budgetNotificationId), 'budget-exhausted notification missing from on-disk feed');
    assert.ok(repeatedFailureNotificationId, 'repeated-failure emitter should have returned a notification id');
    assert.ok(
      ids.includes(repeatedFailureNotificationId),
      'repeated-task-failure notification missing from on-disk feed',
    );
    assert.ok(planReadyNotificationId, 'plan-ready emitter should have returned a notification id');
    assert.ok(ids.includes(planReadyNotificationId), 'plan-ready notification missing from on-disk feed');

    // Total count: exactly four entries in this scenario. Catches the
    // (otherwise silent) regression where a system event accidentally
    // splits onto a sibling file.
    assert.equal(onDisk.length, 4, `expected exactly four notifications on disk, got ${onDisk.length}`);
  });

  it('preserves source and systemEvent discriminators verbatim across all four code paths', async () => {
    const feed = await notificationStore.load(AGENT_ID);
    const byId = new Map(feed.map((n) => [n.id, n]));

    const agentN = byId.get(agentNotificationId);
    const budgetN = budgetNotificationId ? byId.get(budgetNotificationId) : undefined;
    const repeatedN = repeatedFailureNotificationId
      ? byId.get(repeatedFailureNotificationId)
      : undefined;
    const planReadyN = planReadyNotificationId
      ? byId.get(planReadyNotificationId)
      : undefined;

    assert.ok(agentN, 'agent-initiated notification not loaded back');
    assert.equal(agentN.source, 'agent');
    assert.equal(agentN.systemEvent, undefined, 'agent notifications must not carry systemEvent');

    assert.ok(budgetN, 'budget notification not loaded back');
    assert.equal(budgetN.source, 'system');
    assert.equal(budgetN.systemEvent, 'budget-exhausted');

    assert.ok(repeatedN, 'repeated-failure notification not loaded back');
    assert.equal(repeatedN.source, 'system');
    assert.equal(repeatedN.systemEvent, 'repeated-task-failure');

    assert.ok(planReadyN, 'plan-ready notification not loaded back');
    assert.equal(planReadyN.source, 'system');
    assert.equal(planReadyN.systemEvent, 'plan-ready');
  });

  it('attributes every notification to the same sender (agentId) regardless of source', async () => {
    const feed = await notificationStore.load(AGENT_ID);
    for (const n of feed) {
      assert.equal(
        n.agentId,
        AGENT_ID,
        `notification ${n.id} (source=${n.source}, systemEvent=${n.systemEvent}) ` +
          `is attributed to "${n.agentId}", expected "${AGENT_ID}"`,
      );
    }
  });

  it('exposes all four notifications through the global feed (loadAll)', async () => {
    const all = await notificationStore.loadAll();
    const ids = all.map((n) => n.id);
    assert.ok(ids.includes(agentNotificationId));
    assert.ok(budgetNotificationId && ids.includes(budgetNotificationId));
    assert.ok(repeatedFailureNotificationId && ids.includes(repeatedFailureNotificationId));
    assert.ok(planReadyNotificationId && ids.includes(planReadyNotificationId));

    // Each entry on the global feed must carry the owning `agent` slug so
    // the dashboard's inbox can render sender attribution.
    for (const entry of all) {
      assert.equal(entry.agent, AGENT_ID);
    }
  });

  it('counts every emission as unread until the user marks it read', async () => {
    const summary = await notificationStore.summary(AGENT_ID);
    assert.equal(summary.total, 4);
    assert.equal(summary.unread, 4);
    assert.equal(summary.bySource.agent, 1);
    assert.equal(summary.bySource.system, 3);
    assert.equal(summary.bySystemEvent['budget-exhausted'], 1);
    assert.equal(summary.bySystemEvent['repeated-task-failure'], 1);
    assert.equal(summary.bySystemEvent['plan-ready'], 1);

    const totalUnread = await notificationStore.totalUnreadCount();
    assert.equal(totalUnread, 4);
  });

  it('fans out every freshly persisted emission to subscribed delivery channels', () => {
    // The single channel registered in `before` must have observed every
    // fresh emission — agent + all three system events. AC 17's subscribe
    // API is the seam future Slack/email/push integrations will hook into,
    // so this assertion is the load-bearing check that they will receive
    // system-event notifications without re-architecting.
    const observedIds = channelObserved.map((n) => n.id);
    assert.ok(observedIds.includes(agentNotificationId), 'channel did not observe the agent emission');
    assert.ok(
      budgetNotificationId && observedIds.includes(budgetNotificationId),
      'channel did not observe the budget-exhausted emission',
    );
    assert.ok(
      repeatedFailureNotificationId && observedIds.includes(repeatedFailureNotificationId),
      'channel did not observe the repeated-task-failure emission',
    );
    assert.ok(
      planReadyNotificationId && observedIds.includes(planReadyNotificationId),
      'channel did not observe the plan-ready emission',
    );
    assert.equal(channelObserved.length, 4, 'channel must see exactly four fresh emissions');
  });

  it('routes every source through one canonical baseDir (no sibling notification files)', async () => {
    // listAgents walks baseDir for `.../<slug>/notifications.json` files.
    // After all four emissions exactly ONE agent slug should be enumerated,
    // proving no emitter quietly created a sibling file under a different
    // path. If we ever introduce per-source storage subdirectories, this
    // is the canary.
    const slugs = await notificationStore.listAgents();
    assert.deepEqual(slugs, [AGENT_ID]);
  });
});
