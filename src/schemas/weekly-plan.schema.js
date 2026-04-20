/**
 * JSON Schema definitions for weekly plans.
 * Weekly plans contain tasks that trace back to monthly objectives via objectiveId.
 * Plan traceability: goal -> monthly objective -> weekly task.
 */

/** Valid statuses for weekly tasks */
export const TASK_STATUSES = ['pending', 'in-progress', 'completed', 'failed', 'delegated', 'skipped'];

/** Valid priority levels for weekly tasks */
export const TASK_PRIORITIES = ['critical', 'high', 'medium', 'low'];

/**
 * Reserved objectiveId for daily review tasks.
 * Tasks carrying this objectiveId are structured reflection/planning slots
 * injected by the weekly-plan generator — they are not user work items.
 * The task-selector skips them from the regular FIFO queue; instead they
 * are triggered at the start of each working day as a paced onboarding moment.
 */
export const DAILY_REVIEW_OBJECTIVE_ID = 'daily-review';

/**
 * Reserved objectiveId for the end-of-week review task.
 * The single weekly-review slot is placed on Friday (or the last working day
 * of the plan) and chains automatically into the next-week planner when the
 * agent runs autonomously. Its output is auto-approved so the next week's
 * plan is ready without manual intervention.
 */
export const WEEKLY_REVIEW_OBJECTIVE_ID = 'weekly-review';

/**
 * All reserved objectiveId values used by the advisor-mode planner.
 * Downstream code should use these constants rather than raw strings so that
 * refactors and additional review types can be tracked in one place.
 */
export const REVIEW_OBJECTIVE_IDS = [DAILY_REVIEW_OBJECTIVE_ID, WEEKLY_REVIEW_OBJECTIVE_ID];

/**
 * Returns true when the given objectiveId is a reserved review slot.
 * Use this instead of inline string comparisons to keep a single source
 * of truth for the reserved set.
 *
 * @param {string | undefined} objectiveId
 * @returns {boolean}
 */
export function isReviewObjectiveId(objectiveId) {
  return typeof objectiveId === 'string' && REVIEW_OBJECTIVE_IDS.includes(objectiveId);
}

/** Schema for a weekly task */
export const weeklyTaskSchema = {
  $id: 'aweek://schemas/weekly-task',
  type: 'object',
  required: ['id', 'description', 'status'],
  properties: {
    id: {
      type: 'string',
      pattern: '^task-[a-z0-9-]+$',
      description: 'Unique task identifier',
    },
    description: {
      type: 'string',
      minLength: 1,
      description: 'What this task accomplishes',
    },
    objectiveId: {
      type: 'string',
      minLength: 1,
      description:
        'Free-form tag linking the task back to a monthly section in ' +
        "plan.md (typically the H3 heading, e.g. \"2026-04\"). Legacy " +
        'agents may still carry structured `obj-xxxxx` IDs here — the ' +
        'field is now optional and any non-empty string is accepted. ' +
        'Two values are reserved for advisor-mode review slots: ' +
        '"daily-review" (DAILY_REVIEW_OBJECTIVE_ID) marks a structured ' +
        'end-of-day reflection task, and "weekly-review" ' +
        '(WEEKLY_REVIEW_OBJECTIVE_ID) marks the end-of-week review that ' +
        'chains into the next-week planner. Use isReviewObjectiveId() to ' +
        'test for either reserved value.',
    },
    priority: {
      type: 'string',
      enum: ['critical', 'high', 'medium', 'low'],
      description: 'Task priority level (defaults to medium)',
    },
    estimatedMinutes: {
      type: 'integer',
      minimum: 1,
      maximum: 480,
      description: 'Estimated time in minutes (1–480)',
    },
    status: {
      type: 'string',
      enum: ['pending', 'in-progress', 'completed', 'failed', 'delegated', 'skipped'],
    },
    delegatedTo: {
      type: 'string',
      description: 'Agent ID if task was delegated',
    },
    track: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description:
        'Independent pacing lane (e.g. "x-com", "reddit", "email-replies"). ' +
        'At each heartbeat tick the selector picks ONE task per distinct track, ' +
        'so tracks are parallel lanes that each fire at the cron cadence. ' +
        'Defaults to objectiveId when omitted, so tasks under the same ' +
        'objective naturally pace together unless the user wants otherwise.',
    },
    runAt: {
      type: 'string',
      format: 'date-time',
      description:
        'Earliest time this task becomes eligible for execution. Tasks ' +
        'with runAt > now are skipped by the selector until the slot ' +
        'arrives, and the calendar grid renders them at their declared ' +
        'day/hour. Tracks handle cadence; runAt handles absolute time ' +
        'pinning — the two compose.',
    },
    completedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
};

/** Schema for a weekly plan */
export const weeklyPlanSchema = {
  $id: 'aweek://schemas/weekly-plan',
  type: 'object',
  required: ['week', 'month', 'tasks', 'approved'],
  properties: {
    week: {
      type: 'string',
      pattern: '^\\d{4}-W\\d{2}$',
      description: 'ISO week format YYYY-Www',
    },
    month: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}$',
      description: 'Parent month this plan belongs to',
    },
    tasks: {
      type: 'array',
      items: { $ref: 'aweek://schemas/weekly-task' },
    },
    approved: {
      type: 'boolean',
      description: 'Human-in-the-loop approval gate',
    },
    approvedAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
};
