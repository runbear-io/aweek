/**
 * JSON Schema definitions for the agent → user notification model.
 *
 * Notifications are a one-way (agent-to-user) feed surfaced in the dashboard
 * inbox. v1 is read-only — there is no reply / approve / reject loop back to
 * the agents — so the schema mirrors the lightweight log-entry shape rather
 * than the inbox-message lifecycle:
 *
 *   id, agentId, source, title, body, createdAt, read, readAt
 *
 * Per the AC suite the schema must leave room for future fields (priority,
 * category, action buttons, retention metadata) without breaking changes,
 * so the optional `metadata` bag is kept open (`additionalProperties: true`)
 * and the top-level `additionalProperties: false` still allows new named
 * fields to be threaded in via additive minor revisions.
 *
 * Storage path: `.aweek/agents/<slug>/notifications.json` (per-agent file,
 * append-only in v1, mirrors inbox-store / usage-store layout).
 */

/** Valid sources for a notification. */
export const NOTIFICATION_SOURCES = ['agent', 'system'];

/**
 * Valid severity levels — surfaced visually by the dashboard
 * (`info` = default blue/neutral, `warning` = amber, `error` = red).
 * Optional per notification: when absent, consumers SHOULD treat the
 * row as `info`. Reserved as an enum (rather than a free-form string)
 * so the renderer's exhaustiveness check stays compile-safe.
 */
export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'error'];

/**
 * AJV sub-schema for the optional `link` field — a polymorphic
 * string-or-object union expressed via `oneOf` so the validator rejects
 * shapes that satisfy both branches (e.g., a primitive string would not
 * type-check as an object, and vice versa).
 *
 * Branch 1 — bare string. Convenience form for the common case where the
 * notification target is a single URL or in-app path. Stored verbatim and
 * surfaced by the dashboard inbox as a clickable link.
 *
 * Branch 2 — structured object. The forward-compatible form for richer
 * link metadata (e.g., a human label distinct from the href, an explicit
 * `external` flag for routing, or a `target` window hint). Only `href` is
 * required so callers can grow the shape additively without touching this
 * schema in lockstep — `additionalProperties: true` keeps the door open
 * for fields that future ACs introduce.
 *
 * Exported so the typed wrapper (`notification.schema.ts`) and any
 * consumers that need to validate a standalone link payload can reuse the
 * same definition that's embedded inside `notificationSchema`.
 */
export const notificationLinkSchema = {
  $id: 'aweek://schemas/notification-link',
  oneOf: [
    {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description:
        'Bare URL or in-app path. Convenience form when no extra metadata is required.',
    },
    {
      type: 'object',
      required: ['href'],
      properties: {
        href: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description: 'URL or in-app path the link points to.',
        },
        label: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'Human-friendly label rendered in place of the bare href. ' +
            'Defaults to the href when omitted.',
        },
        external: {
          type: 'boolean',
          description:
            'Hint for the dashboard router — true means the link points ' +
            'outside the SPA (open in new tab), false means an in-app ' +
            'route (handled by the SPA router).',
        },
      },
      additionalProperties: true,
      description:
        'Structured link with metadata — used when the notification needs a label ' +
        'distinct from the href or wants to flag external-vs-internal routing.',
    },
  ],
  description:
    'Optional link payload — bare URL string OR structured `{href, label?, external?}` object.',
};

/**
 * Valid system event identifiers — only meaningful when `source === 'system'`.
 *
 * Kept as a permissive enum so future system events can be added without a
 * schema migration. v1 emits exactly the three documented in the task spec:
 *
 *   - `budget-exhausted`     — budget enforcer paused the agent
 *   - `repeated-task-failure` — same weekly-task ID failed 2 consecutive times
 *   - `plan-ready`           — next-week weekly plan is awaiting approval
 */
export const NOTIFICATION_SYSTEM_EVENTS = [
  'budget-exhausted',
  'repeated-task-failure',
  'plan-ready',
  'task-warnings',
];

/**
 * Schema for an individual notification.
 *
 * Required fields are intentionally minimal so agent-emitted notifications
 * can stay free-form (just title + body). System-event emitters supply the
 * additional `systemEvent` + `dedupKey` fields when applicable.
 */
export const notificationSchema = {
  $id: 'aweek://schemas/notification',
  type: 'object',
  required: ['id', 'agentId', 'source', 'title', 'body', 'createdAt', 'read'],
  properties: {
    id: {
      type: 'string',
      pattern: '^notif-[a-f0-9]+$',
      description: 'Unique notification identifier',
    },
    agentId: {
      type: 'string',
      pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
      description:
        'Agent slug this notification is associated with — either the ' +
        'sender (source=agent) or the subject (source=system).',
    },
    source: {
      type: 'string',
      enum: NOTIFICATION_SOURCES,
      description:
        'Who emitted the notification — `agent` for agent-authored ' +
        'messages via `aweek exec notify send`, `system` for ' +
        'auto-emitted events from the heartbeat / budget enforcer.',
    },
    systemEvent: {
      type: 'string',
      enum: NOTIFICATION_SYSTEM_EVENTS,
      description:
        'When source=system, identifies which automated event triggered ' +
        'the notification. Omitted for agent-authored notifications.',
    },
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Free-form short title shown in inbox list rows.',
    },
    body: {
      type: 'string',
      minLength: 1,
      maxLength: 5000,
      description: 'Free-form longer body shown in the notification detail view.',
    },
    link: {
      // Optional polymorphic link target — a bare URL string OR a structured
      // `{href, label?, external?}` object. Validated via the standalone
      // `notification-link` sub-schema so the union shape stays in one place
      // and standalone link payloads can be validated without re-importing
      // the full notification schema. AJV resolves the `$ref` at registration
      // time, so the runtime cost is identical to inlining the `oneOf` body.
      $ref: 'aweek://schemas/notification-link',
    },
    createdAt: {
      type: 'string',
      format: 'date-time',
      description: 'When the notification was emitted (ISO-8601 UTC).',
    },
    read: {
      type: 'boolean',
      description:
        'Read flag — flips to true when the user opens the notification ' +
        'or invokes the mark-all-read action from the dashboard.',
    },
    readAt: {
      type: 'string',
      format: 'date-time',
      description: 'ISO-8601 timestamp when the user marked it read.',
    },
    sourceTaskId: {
      type: 'string',
      description:
        'Optional traceability link — e.g. the weekly-task id that ' +
        'triggered a repeated-failure notification.',
    },
    severity: {
      type: 'string',
      enum: NOTIFICATION_SEVERITIES,
      description:
        'Optional severity hint — drives icon/colour in the bell. ' +
        'When absent the renderer treats the row as `info`.',
    },
    dedupKey: {
      type: 'string',
      maxLength: 200,
      description:
        'Optional dedupe handle for system events — e.g. a ' +
        '`task-failure:<taskId>` key so the heartbeat does not re-emit ' +
        'until the underlying state changes. Agent-authored ' +
        'notifications can omit this.',
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description:
        'Forward-compatible extensibility bag — future fields like ' +
        'priority, category, action buttons, and retention metadata can ' +
        'land here without a breaking schema revision.',
    },
  },
  additionalProperties: false,
};

/**
 * Schema for the per-agent notifications file — an ordered array of
 * notifications, oldest first (append-only in v1).
 */
export const notificationFeedSchema = {
  $id: 'aweek://schemas/notification-feed',
  type: 'array',
  items: { $ref: 'aweek://schemas/notification' },
  description: 'Ordered append-only feed of notifications for an agent.',
};
