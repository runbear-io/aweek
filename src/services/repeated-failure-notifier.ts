/**
 * Repeated-task-failure system-event emitter.
 *
 * v1 system event #2 of 3: when the same weekly-task ID transitions to
 * `failed` two consecutive times without an intervening success / replan
 * / hand-off, the heartbeat fires a `repeated-task-failure` notification
 * so the operator notices a wedged task before it silently consumes the
 * full week's budget.
 *
 * ## Detection contract
 *
 * The failure counter (`consecutiveFailures`) is maintained by
 * `WeeklyPlanStore.updateTaskStatus` — every transition TO `failed`
 * increments it, and every transition AWAY from `failed` (success,
 * `pending`, `in-progress`, `delegated`, `skipped`) deletes both the
 * counter and the latch. This module does NOT increment the counter; it
 * only consumes the post-update value via `getFailureTracker(...)`.
 *
 * The latch (`failureNotificationEmitted`) is also stored on the task in
 * `weekly-plans/<week>.json`. Once we successfully emit a notification
 * for a failing streak, the latch is set so subsequent failures of the
 * same task (in the same streak) do not re-fire. The latch is cleared
 * automatically on the next non-failed status transition by the same
 * `updateTaskStatus` reset path, so a later re-failure of the same
 * task ID will fire a fresh notification once the threshold is crossed
 * again.
 *
 * ## Emission threshold
 *
 * Hard-coded to `2` per the AC: the notification fires the moment a
 * task hits its second consecutive failure, not on every failure
 * thereafter, and not at all on the first failure. The constant is
 * exported so tests and any future ACs can refer to it without
 * fabricating a magic number.
 *
 * ## Storage decoupling (AC 17)
 *
 * This module is the only place in the heartbeat / session-executor
 * pipeline that talks to the notification store. It treats the store as
 * an opaque sender: build the payload, call `send(senderSlug, opts)`,
 * fan-out / dedup / append-only persistence are the store's
 * responsibility. Future delivery channels (Slack, email, OS push,
 * webhooks) inherit fan-out automatically via the
 * `NotificationDeliveryChannel` subscription API — this module needs
 * zero changes when those land.
 *
 * ## Idempotency / dedup
 *
 * Two layers of defense, in order:
 *
 *   1. The latch — checked here before we even build the payload. If
 *      `failureNotificationEmitted` is already `true`, this function is a
 *      cheap no-op.
 *   2. The store's `dedupKey` path — we pass
 *      `repeated-task-failure:<agentId>:<week>:<taskId>` so even if a
 *      future code path calls `send()` twice in the same tick (or the
 *      latch write below fails after the notification write), the store
 *      collapses the duplicate.
 *
 * Best-effort: every failure mode is caught and logged. The heartbeat
 * tick must continue to enforce budgets, write the activity log, etc.
 * even if notification persistence is broken.
 */

import type { NotificationStore } from '../storage/notification-store.js';
import type { WeeklyPlanStore, WeeklyTask } from '../storage/weekly-plan-store.js';

/**
 * Hard-coded threshold for emitting the notification — see file header.
 * The AC specifies "2 consecutive failures"; tests and future ACs that
 * need to reason about this value should import the constant rather
 * than re-typing the literal.
 */
export const REPEATED_FAILURE_THRESHOLD = 2;

/** Inputs for {@link maybeEmitRepeatedFailureNotification}. */
export interface MaybeEmitRepeatedFailureOptions {
  /** Plan store — must already reflect the post-failure counter. */
  weeklyPlanStore: WeeklyPlanStore;
  /**
   * Notification store. When omitted (or `undefined`), the function is a
   * cheap no-op — keeps the call site in `executeOneSelection` happy
   * during unit tests that don't exercise the notification surface.
   */
  notificationStore?: NotificationStore;
  /** Owning agent slug (also the notification's `senderSlug`). */
  agentId: string;
  /** Week key the task lives in (`YYYY-Www`). */
  week: string;
  /** Snapshot of the task object captured before / after the failure. */
  task: Pick<WeeklyTask, 'id' | 'title'> & Partial<Pick<WeeklyTask, 'objectiveId'>>;
}

/**
 * Outcome of a single emission probe. Returned as a structured value so
 * tests can assert the precise branch the call took without resorting to
 * spy-style mock inspection.
 */
export type RepeatedFailureEmitOutcome =
  /** Notification store was missing — nothing to do. */
  | { fired: false; reason: 'no_notification_store' }
  /** Plan / task could not be loaded — graceful degradation. */
  | { fired: false; reason: 'tracker_unavailable' }
  /** Task hasn't crossed the threshold yet. */
  | { fired: false; reason: 'below_threshold'; consecutiveFailures: number }
  /** Latch already set — this streak already fired once. */
  | { fired: false; reason: 'already_emitted'; consecutiveFailures: number }
  /** Notification was sent and the latch was set successfully. */
  | {
      fired: true;
      consecutiveFailures: number;
      notificationId: string;
      dedupKey: string;
    }
  /** Send threw — best-effort skip; heartbeat continues. */
  | { fired: false; reason: 'send_failed'; error: Error };

/**
 * Emit a `repeated-task-failure` notification iff the post-update
 * failure tracker reports `consecutiveFailures >= 2` and the latch is
 * still clear. Idempotent and best-effort — see file header.
 *
 * Call this AFTER `weeklyPlanStore.updateTaskStatus(..., 'failed')` so
 * the counter we read reflects the just-recorded failure.
 */
export async function maybeEmitRepeatedFailureNotification(
  opts: MaybeEmitRepeatedFailureOptions,
): Promise<RepeatedFailureEmitOutcome> {
  const { weeklyPlanStore, notificationStore, agentId, week, task } = opts;

  if (!notificationStore) {
    return { fired: false, reason: 'no_notification_store' };
  }

  // Read the post-update tracker. `getFailureTracker` already swallows
  // ENOENT / parse errors and returns `null`, so any null result here is
  // the "tracker unavailable" branch — degrade gracefully.
  let tracker;
  try {
    tracker = await weeklyPlanStore.getFailureTracker(agentId, week, task.id);
  } catch {
    tracker = null;
  }
  if (!tracker) {
    return { fired: false, reason: 'tracker_unavailable' };
  }

  const { consecutiveFailures, notificationEmitted } = tracker;

  if (consecutiveFailures < REPEATED_FAILURE_THRESHOLD) {
    return { fired: false, reason: 'below_threshold', consecutiveFailures };
  }
  if (notificationEmitted) {
    return { fired: false, reason: 'already_emitted', consecutiveFailures };
  }

  const dedupKey = buildDedupKey(agentId, week, task.id);
  const titleLabel = task.title || task.id;

  try {
    const notification = await notificationStore.send(agentId, {
      source: 'system',
      systemEvent: 'repeated-task-failure',
      title: `Task failing repeatedly — "${truncateForTitle(titleLabel)}"`,
      body:
        `Task "${titleLabel}" (id: ${task.id}) for agent "${agentId}" ` +
        `has now failed ${consecutiveFailures} times in a row in week ${week}. ` +
        `Review the activity log and either retry, replan, or skip the task ` +
        `before it consumes additional budget. This notification will not ` +
        `re-fire until the task transitions out of the failing state ` +
        `(success, replan, hand-off, skip, or replacement by next week's plan).`,
      sourceTaskId: task.id,
      dedupKey,
      metadata: {
        week,
        consecutiveFailures,
        objectiveId: task.objectiveId,
      },
    });

    // Latch the task so subsequent failures within this streak don't
    // re-fire. We do this AFTER the send succeeds so a transient
    // notification-store failure leaves us in a state where the next
    // tick can retry rather than silently swallowing the alert.
    try {
      await weeklyPlanStore.markFailureNotificationEmitted(agentId, week, task.id);
    } catch {
      // Latch write failed — the store's dedupKey path is the
      // fallback. Next tick re-emits, which the store collapses on the
      // unread match. No need to surface this.
    }

    return {
      fired: true,
      consecutiveFailures,
      notificationId: notification.id,
      dedupKey,
    };
  } catch (err) {
    return {
      fired: false,
      reason: 'send_failed',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Compose the dedupKey passed to `NotificationStore.send()`. Exposed so
 * tests can assert the exact value without re-deriving it; the format is
 * an internal contract between this emitter and the store's unread-match
 * path, so it should stay stable across refactors.
 */
export function buildDedupKey(agentId: string, week: string, taskId: string): string {
  return `repeated-task-failure:${agentId}:${week}:${taskId}`;
}

/** Trim a long task title to fit comfortably inside the 200-char title budget. */
function truncateForTitle(value: string, max = 80): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
