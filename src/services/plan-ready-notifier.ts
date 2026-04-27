/**
 * Plan-ready system-event emitter.
 *
 * Fires a `plan-ready` notification when a weekly plan transitions into the
 * "awaiting approval" state — i.e., a fresh plan has been generated and
 * saved with `approved: false`. This is the third v1 system event, alongside
 * `budget-exhausted` (paused agent) and `repeated-task-failure` (failing
 * weekly task ID).
 *
 * ## Sender attribution (AC 6)
 *
 * The system event's *subject* is the agent whose plan needs approval, so
 * the storage layer's `senderSlug` is set to that same agent's slug. This
 * mirrors the convention established by the budget-exhausted emitter:
 * for system notifications the agent slug doubles as both "subject of the
 * event" (read by the dashboard inbox to attribute the notification to the
 * correct agent's feed) and "sender" (the audit-trail concept the storage
 * layer enforces at the boundary).
 *
 * ## Dedup contract
 *
 * The notification carries `dedupKey: 'plan-ready:<agentId>:<week>'`. The
 * storage layer's append() path treats an UNREAD match on the same dedupKey
 * as an idempotent no-op, so:
 *
 *   - calling `emitPlanReadyNotification` twice for the same pending plan
 *     while the user has not yet read the inbox notification is a no-op;
 *   - once the user reads or marks-all-read, the dedup latch clears so a
 *     fresh re-generation of the SAME week's plan (e.g. after a reject →
 *     regenerate) can fire a new notification.
 *
 * The week key is part of the dedupKey so each weekly plan gets its own
 * notification — approving week N's plan and generating week N+1 always
 * fires a fresh notification regardless of read state on the prior week.
 *
 * ## Decoupling from generation
 *
 * Generation of a plan and emission of the notification are intentionally
 * separate concerns: the generator (`generateAndSaveWeeklyPlan`) calls into
 * this module behind an OPTIONAL `notificationStore` parameter, so all
 * existing tests and callers that don't care about notifications keep
 * working unchanged. The heartbeat / next-week planner chain auto-approves
 * its plans and therefore never triggers this emitter (auto-approved plans
 * have `approved: true`).
 *
 * Also — like the budget-enforcer — emission is best-effort. The plan has
 * already persisted; surfacing a notification-store failure through the
 * generator would punish plan generation for an unrelated subsystem
 * failure. Errors are logged and swallowed.
 */
import type { NotificationStore, Notification } from '../storage/notification-store.js';

/**
 * Loose plan shape consumed by the emitter. Matches the structural surface
 * of `WeeklyPlan` in `weekly-plan-store.ts` but kept locally so this module
 * does not pull a hard dependency on the storage type — callers already
 * pass either a freshly generated plan or one loaded from disk.
 */
export interface PlanReadyPlanShape {
  /** ISO week format `YYYY-Www`. */
  week: string;
  /** Parent month `YYYY-MM`. */
  month?: string;
  /** Approval gate flag. The emitter no-ops when this is true. */
  approved?: boolean;
  /** Tasks array (only the count is read for the notification body). */
  tasks?: { id?: string }[];
}

/** Inputs accepted by {@link emitPlanReadyNotification}. */
export interface EmitPlanReadyOptions {
  /** Override timestamp (defaults to now). Useful for tests. */
  timestamp?: string;
}

/** Outcome reported by {@link emitPlanReadyNotification}. */
export interface EmitPlanReadyResult {
  /**
   * Whether a fresh notification was persisted on this call. False when:
   *   - the plan was approved (no event applicable);
   *   - dedup suppressed the write (an unread plan-ready notification for
   *     the same agent + week already exists);
   *   - a non-fatal storage error was caught (logged separately).
   */
  emitted: boolean;
  /** ID of the emitted (or candidate) notification. */
  notificationId: string | null;
  /** Dedup key used for the notification. */
  dedupKey: string;
}

/**
 * Build the dedup key for a plan-ready notification.
 *
 * Exposed as a named helper so the dashboard / tests can construct the same
 * key without re-implementing the format string. The colon-separated
 * `<event>:<agent>:<scope>` shape mirrors the budget-exhausted emitter's
 * `budget-exhausted:<agentId>:<weekMonday>` for consistency.
 */
export function planReadyDedupKey(agentId: string, week: string): string {
  return `plan-ready:${agentId}:${week}`;
}

/**
 * Build the user-facing title for a plan-ready notification.
 *
 * Exposed so the dashboard inbox tests can assert on the same string the
 * emitter writes (rather than hardcoding the copy in two places).
 */
export function planReadyTitle(): string {
  return 'Weekly plan ready for review';
}

/**
 * Build the user-facing body for a plan-ready notification.
 *
 * Pulls the agent slug, week, month, and task count into a single line so
 * the dashboard's compact notification card has enough context without the
 * user clicking through. Kept as a pure helper so the wording is testable.
 */
export function planReadyBody(agentId: string, plan: PlanReadyPlanShape): string {
  const taskCount = Array.isArray(plan.tasks) ? plan.tasks.length : 0;
  const taskWord = taskCount === 1 ? 'task' : 'tasks';
  const monthFragment = plan.month ? ` (month ${plan.month})` : '';
  return (
    `Agent "${agentId}" has generated a weekly plan for ${plan.week}${monthFragment} ` +
    `with ${taskCount} ${taskWord}. The plan is awaiting your approval — open ` +
    `the dashboard or run \`/aweek:plan\` to review and approve.`
  );
}

/**
 * Emit a `plan-ready` system notification for the given pending plan.
 *
 * No-ops in the following cases:
 *   - `notificationStore` is missing (test/legacy path);
 *   - the plan is already approved (`plan.approved === true`);
 *   - the plan does not carry a `week` field;
 *   - the storage layer's dedup path suppresses the write because an
 *     unread `plan-ready` notification for the same agent + week is
 *     already in the feed.
 *
 * Returns a structured outcome rather than throwing — callers that wire
 * this into `generateAndSaveWeeklyPlan` should consider notification
 * emission best-effort and never fail plan persistence on a downstream
 * notification error.
 */
export async function emitPlanReadyNotification(
  notificationStore: NotificationStore | null | undefined,
  agentId: string,
  plan: PlanReadyPlanShape,
  options: EmitPlanReadyOptions = {},
): Promise<EmitPlanReadyResult> {
  const week = plan?.week;
  const dedupKey = week ? planReadyDedupKey(agentId, week) : `plan-ready:${agentId}:`;

  if (!notificationStore) {
    return { emitted: false, notificationId: null, dedupKey };
  }
  if (!agentId || typeof agentId !== 'string') {
    return { emitted: false, notificationId: null, dedupKey };
  }
  if (!plan || !week || typeof week !== 'string') {
    return { emitted: false, notificationId: null, dedupKey };
  }
  if (plan.approved === true) {
    // Auto-approved or already-approved plans never need user review,
    // so no notification fires. The autonomous next-week planner chain
    // exercises this branch.
    return { emitted: false, notificationId: null, dedupKey };
  }

  // Snapshot the agent's current feed pre-write so we can tell whether the
  // store's dedup path suppressed the append (returns the candidate
  // notification unchanged when an unread match exists).
  let preExistingDedupHit = false;
  try {
    const existing = await notificationStore.query(agentId, {
      systemEvent: 'plan-ready',
      read: false,
    });
    preExistingDedupHit = existing.some((n) => n.dedupKey === dedupKey);
  } catch {
    // Best-effort dedup probe — a transient read failure should not block
    // the emission attempt. The store's own dedup path is still authoritative.
  }

  let notification: Notification;
  try {
    notification = await notificationStore.send(agentId, {
      source: 'system',
      systemEvent: 'plan-ready',
      title: planReadyTitle(),
      body: planReadyBody(agentId, plan),
      dedupKey,
      metadata: {
        week,
        ...(plan.month ? { month: plan.month } : {}),
        taskCount: Array.isArray(plan.tasks) ? plan.tasks.length : 0,
      },
      ...(options.timestamp ? { createdAt: options.timestamp } : {}),
    });
  } catch (err) {
    // Best-effort: log and swallow. Plan generation already persisted.
    // eslint-disable-next-line no-console
    console.warn(
      `[${agentId}] plan-ready notification emit failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { emitted: false, notificationId: null, dedupKey };
  }

  return {
    emitted: !preExistingDedupHit,
    notificationId: notification.id,
    dedupKey,
  };
}
