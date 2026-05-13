/**
 * JSON Schema definitions for recurring tasks.
 *
 * A `RecurringTask` is the canonical source for a Google-Calendar-style
 * recurrence: one persisted document per rule, owning a template (the task
 * fields that occurrences inherit), a recurrence rule (an RFC-5545 subset),
 * and an exceptions list (per-occurrence skips or overrides).
 *
 * Occurrences themselves are NEVER persisted in the recurring-task store —
 * they are derived from `rule` by the expander (`src/services/recurrence-expander.ts`)
 * and either rendered lazily by the SPA calendar OR materialized eagerly
 * into the existing `WeeklyPlanStore` by the heartbeat's recurring-materializer.
 *
 * Storage path: `.aweek/agents/<slug>/recurring-tasks.json` — one file per
 * agent, an array of RecurringTask documents. Mirrors the layout of
 * `notifications.json` (append-style per-agent file) rather than the
 * one-file-per-record style of `goals/` / `weekly-plans/` because the
 * expected cardinality per agent is small (a handful of rules) and the
 * file is read in its entirety on every heartbeat tick.
 */

/** Valid frequencies for a recurrence rule. v1 ships day/week/month only. */
export const RECURRENCE_FREQS = ['daily', 'weekly', 'monthly'];

/**
 * Valid two-letter weekday codes (RFC 5545 BYDAY).
 * Monday-first to match ISO 8601 / aweek's calendar convention.
 */
export const RECURRENCE_BYDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** Valid kinds for a per-occurrence exception. */
export const RECURRENCE_EXCEPTION_KINDS = ['skip', 'override'];

/**
 * Pattern for a RecurringTask id — `rec-<slug>` where the slug body is
 * any non-empty lowercase-alphanum-and-hyphens string. Mirrors the
 * existing weekly-task / inbox-message id conventions.
 */
export const RECURRING_TASK_ID_PATTERN = '^rec-[a-z0-9-]+$';

/**
 * Sub-schema for the task template — the fields each occurrence inherits
 * before per-exception overrides are applied. Mirrors the runtime-relevant
 * subset of `weeklyTaskSchema` (title, prompt, priority, estimatedMinutes,
 * objectiveId, track) so the materializer can blit the template straight
 * into a freshly-minted WeeklyTask without a translation step.
 *
 * The template intentionally does NOT include `id`, `status`, `runAt`, or
 * the failure/verifier latches — those are populated at materialization
 * time (`id` via the occurrence-id-format, `status: 'pending'`, `runAt`
 * via the expander).
 */
export const recurringTaskTemplateSchema = {
  $id: 'aweek://schemas/recurring-task-template',
  type: 'object',
  required: ['title', 'prompt'],
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 80,
      description:
        'Short single-line label inherited by every occurrence. Mirrors ' +
        'the weeklyTaskSchema title constraint (1–80 chars).',
    },
    prompt: {
      type: 'string',
      minLength: 1,
      description:
        'Long-form instruction text inherited by every occurrence and ' +
        'sent to Claude when the heartbeat executes the task.',
    },
    objectiveId: {
      type: 'string',
      minLength: 1,
      description:
        'Free-form tag linking the recurring task back to a section in ' +
        'plan.md. Inherited by every occurrence verbatim.',
    },
    priority: {
      type: 'string',
      enum: ['critical', 'high', 'medium', 'low'],
      description: 'Priority inherited by every occurrence (defaults to medium).',
    },
    estimatedMinutes: {
      type: 'integer',
      minimum: 1,
      maximum: 480,
      description: 'Estimated time in minutes (1–480), inherited by every occurrence.',
    },
    track: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description:
        'Independent pacing lane (e.g. "x-com"). Inherited by every ' +
        'occurrence verbatim; defaults to objectiveId at selector time ' +
        'when omitted, matching weeklyTaskSchema semantics.',
    },
  },
  additionalProperties: false,
};

/**
 * Sub-schema for the recurrence rule — an RFC-5545 subset sufficient for
 * Google-Calendar-style weekly/biweekly/monthly recurrence patterns. v1
 * deliberately omits FREQ=YEARLY, multiple RRULEs per task, RDATE/EXDATE,
 * and iCalendar I/O (see the seed's "v1 out of scope" constraint).
 *
 * Required fields:
 *   - `freq`      — daily | weekly | monthly
 *   - `interval`  — integer ≥ 1 (e.g. 2 for "every other week")
 *   - `dtStart`   — anchor instant as a UTC ISO-8601 date-time
 *   - `timeZone`  — IANA zone name for wall-clock projection
 *
 * Optional fields:
 *   - `byDay`       — array of weekday codes (RFC 5545 BYDAY subset)
 *   - `byMonthDay`  — integer 1..31 (BYMONTHDAY single-value subset)
 *   - `bySetPos`    — integer in {-5..-1, 1..5} excluding 0 (BYSETPOS single value)
 *   - `count`       — integer ≥ 1, terminates after N occurrences (XOR with `until`)
 *   - `until`       — UTC ISO date-time, inclusive end bound (XOR with `count`)
 *
 * The `count` XOR `until` constraint is enforced via `oneOf` so AJV
 * rejects a rule that declares both terminators (per RFC 5545).
 */
export const recurrenceRuleSchema = {
  $id: 'aweek://schemas/recurrence-rule',
  type: 'object',
  required: ['freq', 'interval', 'dtStart', 'timeZone'],
  properties: {
    freq: {
      type: 'string',
      enum: ['daily', 'weekly', 'monthly'],
      description:
        'Recurrence frequency. v1 ships daily/weekly/monthly only — ' +
        'FREQ=YEARLY is explicitly out of scope.',
    },
    interval: {
      type: 'integer',
      minimum: 1,
      description:
        'Recurrence interval — e.g. 1 for "every week", 2 for "every other ' +
        'week" / "biweekly", 3 for "every third week".',
    },
    byDay: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'],
      },
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
      description:
        'BYDAY weekday filter — restricts occurrences to the listed weekdays. ' +
        'For FREQ=WEEKLY: which day(s) of the week the event fires (e.g. ' +
        '["MO","WE","FR"] for Mon/Wed/Fri). For FREQ=MONTHLY combined with ' +
        'bySetPos: which weekday the nth-of-the-month rule selects (e.g. ' +
        '{byDay:["TU"], bySetPos:2} = the second Tuesday of each month).',
    },
    byMonthDay: {
      type: 'integer',
      minimum: 1,
      maximum: 31,
      description:
        'BYMONTHDAY single-value subset — the calendar day of the month ' +
        '(1..31) when FREQ=MONTHLY. Months with fewer days than `byMonthDay` ' +
        'silently skip (no occurrence) per RFC 5545 semantics.',
    },
    bySetPos: {
      type: 'integer',
      minimum: -5,
      maximum: 5,
      not: { const: 0 },
      description:
        'BYSETPOS single value — selects the nth match within a recurrence ' +
        'set. Positive values count from the start (1 = first, 2 = second, …), ' +
        'negative values count from the end (-1 = last, -2 = second-to-last). ' +
        'Combined with byDay for "nth weekday of the month" patterns.',
    },
    dtStart: {
      type: 'string',
      format: 'date-time',
      description:
        'Anchor instant for the recurrence (UTC ISO-8601). Defines both the ' +
        'wall-clock hour/minute of every occurrence (via timeZone projection) ' +
        'and the lower bound — no occurrence fires before dtStart.',
    },
    timeZone: {
      type: 'string',
      minLength: 1,
      description:
        'IANA zone name (e.g. "America/Los_Angeles") used to project dtStart ' +
        'into a local wall-clock when computing each occurrence\'s firing ' +
        'time. DST seams are handled via localWallClockToUtc().',
    },
    count: {
      type: 'integer',
      minimum: 1,
      description:
        'COUNT terminator — total number of occurrences before the rule ' +
        'stops. Mutually exclusive with `until` per RFC 5545.',
    },
    until: {
      type: 'string',
      format: 'date-time',
      description:
        'UNTIL terminator (inclusive) — UTC ISO-8601 date-time after which ' +
        'no further occurrences fire. Mutually exclusive with `count`.',
    },
  },
  additionalProperties: false,
  // RFC 5545 forbids declaring BOTH count and until on the same rule.
  // `oneOf` with empty-property shapes lets AJV enforce the XOR while still
  // accepting rules that declare neither (open-ended recurrence).
  oneOf: [
    {
      // Neither terminator
      not: { anyOf: [{ required: ['count'] }, { required: ['until'] }] },
    },
    {
      // count only
      required: ['count'],
      not: { required: ['until'] },
    },
    {
      // until only
      required: ['until'],
      not: { required: ['count'] },
    },
  ],
};

/**
 * Sub-schema for a single exception entry. An exception either skips the
 * occurrence at `originalRunAt` outright (`kind: 'skip'`) or replaces the
 * template fields with an override (`kind: 'override'` + `override` body).
 *
 * `originalRunAt` is the UTC ISO instant the expander would have produced
 * before the exception applied — it's the join key the materializer uses
 * to match an exception against an expansion result.
 */
export const recurrenceExceptionSchema = {
  $id: 'aweek://schemas/recurrence-exception',
  type: 'object',
  required: ['originalRunAt', 'kind'],
  properties: {
    originalRunAt: {
      type: 'string',
      format: 'date-time',
      description:
        'UTC ISO instant of the occurrence this exception targets — equals ' +
        'the runAt the expander would have produced before the exception ' +
        'applied. Used as the join key.',
    },
    kind: {
      type: 'string',
      enum: ['skip', 'override'],
      description:
        'Exception kind. `skip` drops the occurrence outright; `override` ' +
        'replaces template fields per the `override` body.',
    },
    override: {
      // Partial<template> — any subset of the template fields. We re-use
      // the template schema's property shapes but make every field optional
      // by inlining (rather than $ref'ing the required template schema).
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 80 },
        prompt: { type: 'string', minLength: 1 },
        objectiveId: { type: 'string', minLength: 1 },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
        },
        estimatedMinutes: { type: 'integer', minimum: 1, maximum: 480 },
        track: { type: 'string', minLength: 1, maxLength: 64 },
        runAt: { type: 'string', format: 'date-time' },
      },
      additionalProperties: false,
      description:
        'Partial template overlay applied when kind=override. Any omitted ' +
        'field falls back to the template value. A `runAt` here moves the ' +
        'occurrence in time (Google-Calendar "move this occurrence" UX).',
    },
  },
  additionalProperties: false,
};

/**
 * Schema for a single RecurringTask document — the canonical persisted
 * record. The `recurring-tasks.json` file is an array of these.
 */
export const recurringTaskSchema = {
  $id: 'aweek://schemas/recurring-task',
  type: 'object',
  required: ['id', 'template', 'rule', 'createdAt'],
  properties: {
    id: {
      type: 'string',
      pattern: RECURRING_TASK_ID_PATTERN,
      description: 'Unique RecurringTask id (`rec-<slug>`).',
    },
    template: { $ref: 'aweek://schemas/recurring-task-template' },
    rule: { $ref: 'aweek://schemas/recurrence-rule' },
    exceptions: {
      type: 'array',
      items: { $ref: 'aweek://schemas/recurrence-exception' },
      description:
        'Per-occurrence skips or overrides. Empty / absent means every ' +
        'occurrence produced by the rule fires verbatim from the template.',
    },
    createdAt: {
      type: 'string',
      format: 'date-time',
      description: 'UTC ISO date-time when this RecurringTask was created.',
    },
    updatedAt: {
      type: 'string',
      format: 'date-time',
      description: 'UTC ISO date-time of the last mutation (rule or template edit).',
    },
  },
  additionalProperties: false,
};

/**
 * Schema for the per-agent recurring-tasks file — an array of
 * RecurringTask documents. One document per recurrence rule.
 */
export const recurringTaskListSchema = {
  $id: 'aweek://schemas/recurring-task-list',
  type: 'array',
  items: { $ref: 'aweek://schemas/recurring-task' },
  description:
    'Ordered list of RecurringTask documents for a single agent. ' +
    'Persisted at .aweek/agents/<slug>/recurring-tasks.json.',
};
