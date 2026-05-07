/**
 * Task-warnings system-event emitter.
 *
 * Fires a `task-warnings` notification with severity `warning` whenever
 * the post-execution verifier (`task-verifier.ts`) flagged concerns on
 * a task that the heartbeat marked `completed`. Idempotent via the
 * notification store's `dedupKey` path so the same warning won't be
 * re-raised on subsequent ticks of the same task attempt.
 *
 * ## Why a separate notification (not a re-purposed task-failure event)
 *
 * Repeated-task-failure fires when a task is HARD-failing (status flips
 * to `failed`); this emitter fires when status stays `completed` but
 * the agent's transcript doesn't show evidence the stated outcome
 * happened. Two different operator messages, two different remediation
 * paths — separate event types let the dashboard render them with
 * distinct severity badges and copy.
 *
 * ## Idempotency
 *
 * The dedupKey shape `task-warnings:<agentId>:<week>:<taskId>` is unique
 * per task attempt. The notification store collapses duplicates against
 * the most recent UNREAD notification, so:
 *   - If the heartbeat re-runs against the same completed task before
 *     the user opens the bell, the duplicate is silently dropped.
 *   - If the user reads the warning and the heartbeat retries the task
 *     (status flips to `pending` → `in-progress` → `completed` again),
 *     the next warning gets a fresh row because the prior one is read.
 *
 * Best-effort: every failure mode is caught and logged. The heartbeat
 * tick must continue normally even if notification persistence breaks.
 */

import type {
  NotificationStore,
  Notification,
} from '../storage/notification-store.js';
import type { WeeklyTask } from '../storage/weekly-plan-store.js';

/** Maximum number of concerns embedded in the notification body. */
const MAX_CONCERNS_IN_BODY = 5;

/** Cap on the title's task-label segment so the chip stays single-line. */
const MAX_TITLE_LABEL_CHARS = 60;

/** Inputs for {@link maybeEmitTaskWarningsNotification}. */
export interface MaybeEmitTaskWarningsOptions {
  /**
   * Notification store. When omitted (or `undefined`), the function is a
   * cheap no-op — keeps the call site in the heartbeat happy during
   * unit tests that don't exercise the notification surface.
   */
  notificationStore?: NotificationStore;
  /** Owning agent slug (also the notification's `senderSlug`). */
  agentId: string;
  /** Week key the task lives in (`YYYY-Www`). */
  week: string;
  /** Snapshot of the task identity we surface in the notification copy. */
  task: Pick<WeeklyTask, 'id' | 'title'> & Partial<Pick<WeeklyTask, 'objectiveId'>>;
  /**
   * Concerns from the verifier. Must be non-empty for the emitter to
   * fire — empty arrays return `{ fired: false, reason: 'no_concerns' }`.
   */
  concerns: ReadonlyArray<string>;
}

/**
 * Outcome of a single emission probe.
 */
export type TaskWarningsEmitOutcome =
  | { fired: false; reason: 'no_notification_store' }
  | { fired: false; reason: 'no_concerns' }
  | {
      fired: true;
      notificationId: string;
      dedupKey: string;
    }
  | { fired: false; reason: 'send_failed'; error: Error };

/**
 * Emit a `task-warnings` notification iff the verifier returned
 * non-empty concerns and a notification store was provided.
 *
 * Call this AFTER {@link verifyTaskOutcome} resolves to a `verdict`
 * with `achieved === false`.
 */
export async function maybeEmitTaskWarningsNotification(
  opts: MaybeEmitTaskWarningsOptions,
): Promise<TaskWarningsEmitOutcome> {
  const { notificationStore, agentId, week, task, concerns } = opts;

  if (!notificationStore) {
    return { fired: false, reason: 'no_notification_store' };
  }
  if (!Array.isArray(concerns) || concerns.length === 0) {
    return { fired: false, reason: 'no_concerns' };
  }

  const dedupKey = buildDedupKey(agentId, week, task.id);
  const titleLabel = truncateForTitle(task.title || task.id);
  const concernsBody = formatConcernsForBody(concerns);

  try {
    const notification: Notification = await notificationStore.send(agentId, {
      source: 'system',
      systemEvent: 'task-warnings',
      severity: 'warning',
      title: `Task completed with concerns — "${titleLabel}"`,
      body:
        `Task "${task.title || task.id}" (id: ${task.id}) for agent ` +
        `"${agentId}" finished with status \`completed\` but the post-` +
        `execution verifier did not see evidence the stated outcome ` +
        `was achieved.\n\n` +
        `Concerns:\n${concernsBody}\n\n` +
        `Open the agent's Activity tab to inspect the captured ` +
        `transcript, then either retry the task, adjust the prompt, ` +
        `or accept the result by marking this notification as read.`,
      sourceTaskId: task.id,
      dedupKey,
      metadata: {
        week,
        objectiveId: task.objectiveId,
        concerns: concerns.slice(),
      },
    });

    return {
      fired: true,
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
 * Build the canonical dedupKey shape. Exported for tests so they can
 * pin the shape without re-typing the literal.
 */
export function buildDedupKey(
  agentId: string,
  week: string,
  taskId: string,
): string {
  return `task-warnings:${agentId}:${week}:${taskId}`;
}

function truncateForTitle(label: string): string {
  if (typeof label !== 'string') return '';
  if (label.length <= MAX_TITLE_LABEL_CHARS) return label;
  return `${label.slice(0, MAX_TITLE_LABEL_CHARS - 1)}…`;
}

function formatConcernsForBody(concerns: ReadonlyArray<string>): string {
  const top = concerns.slice(0, MAX_CONCERNS_IN_BODY);
  return top.map((c) => `- ${c}`).join('\n');
}
