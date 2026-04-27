/**
 * Agent → user notification skill.
 *
 * Validates a free-form notification payload (title + body + optional link /
 * sourceTaskId / metadata) submitted by an agent and persists it through
 * {@link NotificationStore.send}. Mirrors the {@link delegateTask} pattern:
 *
 *   - parameter validation in a pure function (`validateSendParams`) that
 *     callers can re-use without instantiating a store;
 *   - the main entry point (`sendNotification`) verifies the sender agent
 *     exists, then hands off to the storage layer's `send()` which auto-
 *     populates `id`, `agentId`, `createdAt`, and `read=false` per AC 2;
 *   - returns the persisted notification so the CLI dispatcher can echo
 *     the assigned id back to the calling agent for traceability;
 *   - a small `formatNotificationResult` formatter for human-friendly CLI
 *     output (used by the dashboard / debug surfaces).
 *
 * Deliverable hand-offs (AC 15):
 *
 * Agent-produced deliverables (artifacts, reports, generated documents,
 * external URLs) are surfaced to the user through this **same** skill —
 * there is no separate "hand-off" CLI, no `aweek exec deliver` module, and
 * no dedicated dispatcher entry. The canonical pattern is:
 *
 *   1. The agent registers the deliverable via `ArtifactStore.register()`
 *      (or simply has a URL in hand for an external deliverable).
 *   2. The agent shells out to `aweek exec notify send` with:
 *        - `link`        — the artifact's `filePath`, an in-app dashboard
 *                          route, or a bare external URL.
 *        - `sourceTaskId`— the weekly-task id that produced the deliverable
 *                          (so the dashboard can backlink to it).
 *        - `metadata`    — free-form bag for `artifactId`, `type`, etc.
 *
 * The `link`, `sourceTaskId`, and `metadata` fields below are deliberately
 * permissive so any deliverable shape can be carried without schema churn.
 * Future external push channels (Slack/email/OS-push) registered via
 * `NotificationStore.subscribe()` see the same payload — the hand-off
 * surface fans out for free.
 *
 * v1 contract:
 *
 *   - `senderSlug` is required and must be a non-empty string. The CLI
 *     dispatcher passes the calling agent's slug from runtime context so
 *     agents never have to fabricate it themselves.
 *   - `title` is required, ≤ 200 chars (matches schema).
 *   - `body` is required, ≤ 5000 chars (matches schema).
 *   - `source` defaults to `'agent'`. Callers MAY pass `'system'` plus a
 *     `systemEvent` discriminator — the storage schema rejects mismatched
 *     combos at the boundary, but this skill validates them up-front so
 *     the CLI surfaces a friendlier error than an AJV blob.
 *   - All other fields (`link`, `sourceTaskId`, `dedupKey`, `metadata`) are
 *     optional and forwarded as-is.
 *
 * The skill is intentionally read-only with respect to delivery channels:
 * `NotificationStore.subscribe()` already exists for future Slack / email /
 * push integrations, so this skill never knows what channels (if any) are
 * registered. v1 ships dashboard-only.
 */
import { AgentStore } from '../storage/agent-store.js';
import { NotificationStore } from '../storage/notification-store.js';
import {
  NOTIFICATION_SOURCES,
  NOTIFICATION_SYSTEM_EVENTS,
} from '../schemas/notification.schema.js';
import type {
  Notification,
  NotificationSource,
  NotificationSystemEvent,
  NotificationLink,
} from '../storage/notification-store.js';

/** Free-form parameters accepted by {@link sendNotification}. */
export interface SendNotificationParams {
  /**
   * Slug of the agent emitting the notification. The CLI dispatcher
   * passes this from runtime context — agents never fabricate it.
   */
  senderSlug?: string;
  /** Free-form short title shown in inbox list rows. */
  title?: string;
  /** Free-form longer body shown in the notification detail view. */
  body?: string;
  /**
   * Optional content/extension fields. Mirrors
   * {@link import('../storage/notification-store.js').SendNotificationOptions}
   * minus the four auto-populated metadata fields (`id`, `agentId`,
   * `createdAt`, `read`).
   */
  options?: {
    source?: NotificationSource;
    systemEvent?: NotificationSystemEvent;
    link?: NotificationLink;
    sourceTaskId?: string;
    dedupKey?: string;
    metadata?: Record<string, unknown>;
    /**
     * Test/replay-only override. Production callers leave this unset
     * so the storage layer stamps the actual write time.
     */
    createdAt?: string;
  };
}

/** Validated/normalized payload returned by {@link validateSendParams}. */
export interface ValidatedSendParams {
  senderSlug: string;
  title: string;
  body: string;
  source: NotificationSource;
  systemEvent?: NotificationSystemEvent;
  link?: NotificationLink;
  sourceTaskId?: string;
  dedupKey?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

/**
 * Cap on `senderSlug` length matching the schema's `agentId` pattern
 * (the AJV regex itself doesn't pin a length, but every other agent surface
 * stays well under 200 chars; we surface a friendlier error than the AJV
 * blob would).
 */
const MAX_SLUG_LENGTH = 200;

/** Schema mirror — see notification.schema.js. */
const MAX_TITLE_LENGTH = 200;
/** Schema mirror — see notification.schema.js. */
const MAX_BODY_LENGTH = 5000;
/** Schema mirror — see notification.schema.js. */
const MAX_DEDUP_KEY_LENGTH = 200;

/**
 * Validate the user-supplied send params before constructing a notification.
 * Pure function — never touches disk, no async work — so it can be used by
 * both the in-process skill caller and the CLI's pre-flight error surface.
 *
 * Throws descriptive `Error` instances for every failure mode so the CLI
 * dispatcher can surface a user-readable message.
 */
export function validateSendParams(
  params: SendNotificationParams = {},
): ValidatedSendParams {
  const { senderSlug, title, body } = params;
  const options = params.options || {};

  if (!senderSlug || typeof senderSlug !== 'string') {
    throw new Error('senderSlug is required and must be a non-empty string');
  }
  if (senderSlug.length > MAX_SLUG_LENGTH) {
    throw new Error(`senderSlug must not exceed ${MAX_SLUG_LENGTH} characters`);
  }

  if (!title || typeof title !== 'string') {
    throw new Error('title is required and must be a non-empty string');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error(`title must not exceed ${MAX_TITLE_LENGTH} characters`);
  }

  if (!body || typeof body !== 'string') {
    throw new Error('body is required and must be a non-empty string');
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new Error(`body must not exceed ${MAX_BODY_LENGTH} characters`);
  }

  const source: NotificationSource = options.source || 'agent';
  if (!NOTIFICATION_SOURCES.includes(source)) {
    throw new Error(
      `source must be one of ${NOTIFICATION_SOURCES.join(', ')}; got "${String(
        source,
      )}"`,
    );
  }

  // System-source notifications must declare which event triggered them so
  // dedup/aggregation downstream works. Agent-source notifications must NOT
  // carry a systemEvent — that field is reserved for the auto-emitters.
  if (source === 'system') {
    if (
      !options.systemEvent ||
      !NOTIFICATION_SYSTEM_EVENTS.includes(options.systemEvent)
    ) {
      throw new Error(
        `systemEvent is required for source="system" and must be one of ${NOTIFICATION_SYSTEM_EVENTS.join(
          ', ',
        )}`,
      );
    }
  } else if (options.systemEvent !== undefined) {
    throw new Error(
      'systemEvent is reserved for source="system" notifications; ' +
        'omit it when sending an agent-authored notification',
    );
  }

  if (
    options.dedupKey !== undefined &&
    (typeof options.dedupKey !== 'string' ||
      options.dedupKey.length > MAX_DEDUP_KEY_LENGTH)
  ) {
    throw new Error(
      `dedupKey must be a string ≤ ${MAX_DEDUP_KEY_LENGTH} characters`,
    );
  }

  if (
    options.sourceTaskId !== undefined &&
    typeof options.sourceTaskId !== 'string'
  ) {
    throw new Error('sourceTaskId must be a string');
  }

  if (options.metadata !== undefined) {
    if (
      typeof options.metadata !== 'object' ||
      options.metadata === null ||
      Array.isArray(options.metadata)
    ) {
      throw new Error('metadata must be a plain object');
    }
  }

  // `link` is intentionally not deep-validated here — the storage layer's
  // AJV pass enforces the polymorphic `string-or-{href, label?, external?}`
  // union. We only catch the gross mistakes (wrong primitive type) so the
  // CLI surfaces a useful error before the AJV blob.
  if (options.link !== undefined) {
    if (typeof options.link !== 'string' && typeof options.link !== 'object') {
      throw new Error('link must be a string URL or an object with `href`');
    }
    if (options.link === null) {
      throw new Error('link must not be null');
    }
  }

  const validated: ValidatedSendParams = {
    senderSlug,
    title,
    body,
    source,
  };
  if (options.systemEvent !== undefined) validated.systemEvent = options.systemEvent;
  if (options.link !== undefined) validated.link = options.link;
  if (options.sourceTaskId !== undefined) validated.sourceTaskId = options.sourceTaskId;
  if (options.dedupKey !== undefined) validated.dedupKey = options.dedupKey;
  if (options.metadata !== undefined) validated.metadata = options.metadata;
  if (options.createdAt !== undefined) validated.createdAt = options.createdAt;
  return validated;
}

/** Optional dependency injection for tests. */
export interface SendNotificationDeps {
  /** Override the default `AgentStore` (used to verify the sender exists). */
  agentStore?: any;
  /**
   * Override the default `NotificationStore`. Tests typically pass a
   * store instance scoped to a temp dir so they can assert on the
   * resulting on-disk feed.
   */
  notificationStore?: any;
  /**
   * Skip the sender-existence check. Defaults to `false` (i.e. we DO
   * verify the sender exists). Useful for tests that want to drive
   * the storage layer without seeding an `AgentStore`.
   */
  skipSenderCheck?: boolean;
}

/**
 * Send a notification on behalf of an agent.
 *
 *   1. Validate the input payload via {@link validateSendParams}.
 *   2. Verify the sender agent exists in the agent registry (so a typo
 *      in the slug surfaces immediately rather than persisting an orphan
 *      notification under a non-existent agent's directory).
 *   3. Hand off to {@link NotificationStore.send}, which auto-populates
 *      `id`, `agentId`, `createdAt`, and `read=false` and runs the full
 *      idempotency / dedup / fan-out pipeline.
 *
 * Returns the persisted {@link Notification} so callers can echo the
 * assigned id back to the user. Idempotent re-sends (duplicate id /
 * unread dedupKey collision) return the same notification shape per the
 * storage layer's contract.
 */
export async function sendNotification(
  params: SendNotificationParams,
  deps: SendNotificationDeps = {},
): Promise<Notification> {
  const validated = validateSendParams(params);

  const agentStore = deps.agentStore || new AgentStore('.aweek/agents');
  const notificationStore =
    deps.notificationStore || new NotificationStore('.aweek/agents');

  if (!deps.skipSenderCheck) {
    const senderExists = await agentStore.exists(validated.senderSlug);
    if (!senderExists) {
      throw new Error(`Sender agent not found: ${validated.senderSlug}`);
    }
  }

  // Hand off to the canonical storage entry point. `send()` does the
  // auto-population of id, agentId, createdAt, read AND runs the full
  // idempotency/dedup/fan-out pipeline. We never re-implement any of that.
  const notification = await notificationStore.send(validated.senderSlug, {
    source: validated.source,
    title: validated.title,
    body: validated.body,
    ...(validated.systemEvent !== undefined ? { systemEvent: validated.systemEvent } : {}),
    ...(validated.link !== undefined ? { link: validated.link } : {}),
    ...(validated.sourceTaskId !== undefined ? { sourceTaskId: validated.sourceTaskId } : {}),
    ...(validated.dedupKey !== undefined ? { dedupKey: validated.dedupKey } : {}),
    ...(validated.metadata !== undefined ? { metadata: validated.metadata } : {}),
    ...(validated.createdAt !== undefined ? { createdAt: validated.createdAt } : {}),
  });

  return notification;
}

/**
 * Format a human-friendly summary of a sent notification. Mirrors the
 * `formatDelegationResult` shape so the CLI dispatcher's output for the
 * `aweek exec notify send` surface looks consistent with the existing
 * `delegate-task` surface.
 */
export function formatNotificationResult(notification: Notification): string {
  const lines = [
    `Notification sent successfully`,
    `  Notification ID: ${notification.id}`,
    `  Agent: ${notification.agentId}`,
    `  Source: ${notification.source}`,
  ];
  if (notification.systemEvent) {
    lines.push(`  System Event: ${notification.systemEvent}`);
  }
  lines.push(`  Title: ${notification.title}`);
  lines.push(`  Body: ${notification.body}`);
  if (notification.link !== undefined) {
    const linkText =
      typeof notification.link === 'string'
        ? notification.link
        : notification.link.href;
    lines.push(`  Link: ${linkText}`);
  }
  if (notification.sourceTaskId) {
    lines.push(`  Source Task: ${notification.sourceTaskId}`);
  }
  if (notification.dedupKey) {
    lines.push(`  Dedup Key: ${notification.dedupKey}`);
  }
  lines.push(`  Read: ${notification.read}`);
  lines.push(`  Created: ${notification.createdAt}`);
  return lines.join('\n');
}
