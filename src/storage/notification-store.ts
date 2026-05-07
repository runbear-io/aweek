/**
 * Storage layer for agent → user notifications.
 *
 * v1 notifications are a one-way (agent-to-user) feed surfaced in the
 * dashboard inbox. Each agent has a single per-agent notifications file at
 * `.aweek/agents/<agentId>/notifications.json`, mirroring the per-agent
 * layout used by `inbox-store`, `usage-store`, and `activity-log-store`.
 *
 * ## Storage ↔ delivery decoupling (AC 17)
 *
 * This module is the single source of truth for notification persistence.
 * It is intentionally ignorant of:
 *
 *   - the CLI dispatcher and the `aweek exec notify send` skill
 *   - the dashboard SPA, its HTTP endpoints, and any rendering logic
 *   - any external push channel (Slack, email, OS push, webhooks)
 *
 * The only imports below are `node:*` built-ins and the AJV validator.
 * `git grep` for `from '../serve` / `from '../skills` / `from '../cli'` in
 * this file should always come back empty — that invariant is asserted by
 * the colocated test suite.
 *
 * The decoupling is made *concrete* (rather than promised by convention)
 * via the {@link NotificationDeliveryChannel} subscription API. After
 * `append()` successfully persists a new notification, the store fires
 * `deliver()` on every subscribed channel in fire-and-forget mode with
 * per-channel error isolation. The dashboard read API
 * (`src/serve/data/notifications.ts` + the `/api/notifications/...`
 * handlers) is the v1 channel — but it consumes notifications by polling
 * the on-disk feed, not by subscribing, so it does not need to register
 * here. Future push channels (Slack, email, OS push) become a 5-line
 * `store.subscribe({ name, deliver })` call from the bootstrap layer
 * and require zero changes to this file.
 *
 * Idempotent no-ops in `append()` (duplicate id, or an unread match on
 * `dedupKey`) MUST NOT fire delivery — channels only see freshly
 * persisted notifications. This guarantees that, e.g., re-emitting a
 * `repeated-task-failure` notification while the prior one is still
 * unread does not re-page Slack.
 *
 * v1 is append-only — there is no pruning, TTL, or max-count cap — but
 * the schema's `metadata` bag and the optional `dedupKey` field leave
 * room for future retention policies and channel integrations.
 *
 * Idempotent: appending a notification with an existing `id` (or, for
 * system events, an existing `dedupKey` whose underlying state has not
 * yet cleared) is a no-op.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertValid } from '../schemas/validator.js';
import type {
  NotificationLink,
  NotificationSeverity,
} from '../schemas/notification.js';

// Re-export the typed link union so downstream consumers (CLI, dashboard,
// system-event emitters) can import everything notification-related from
// the storage entry point that AC 17 already designates as canonical.
export type {
  NotificationLink,
  NotificationLinkObject,
  NotificationSeverity,
} from '../schemas/notification.js';

const NOTIFICATION_SCHEMA_ID = 'aweek://schemas/notification';
const FEED_SCHEMA_ID = 'aweek://schemas/notification-feed';

/**
 * Source discriminator — agent-authored vs. system-emitted.
 * Mirrors `NOTIFICATION_SOURCES` in `src/schemas/notification.schema.js`.
 */
export type NotificationSource = 'agent' | 'system';

/**
 * Identifier for the three v1 system events. Mirrors
 * `NOTIFICATION_SYSTEM_EVENTS` in the schema definition.
 */
export type NotificationSystemEvent =
  | 'task-warnings'
  | 'budget-exhausted'
  | 'repeated-task-failure'
  | 'plan-ready';

/**
 * Canonical shape of a single notification — mirrors `notificationSchema`
 * in `src/schemas/notification.schema.js`. Required vs. optional matches
 * the schema's `required` array exactly.
 */
export interface Notification {
  /** Unique notification identifier (`notif-<lowercase-hex>`). */
  id: string;
  /**
   * Agent slug this notification is associated with — sender for
   * agent-authored notifications, subject for system events.
   */
  agentId: string;
  /** Who emitted the notification. */
  source: NotificationSource;
  /** When source=system, identifies which automated event triggered it. */
  systemEvent?: NotificationSystemEvent;
  /** Free-form short title shown in inbox list rows. */
  title: string;
  /** Free-form longer body shown in the detail view. */
  body: string;
  /**
   * Optional polymorphic link target — bare URL string OR structured
   * `{href, label?, external?}` object. Validated at the storage boundary
   * by AJV's `oneOf` union (see `notificationLinkSchema`); consumers must
   * narrow before reading nested fields.
   */
  link?: NotificationLink;
  /** ISO-8601 timestamp when the notification was emitted. */
  createdAt: string;
  /** Read flag — false until the user opens or marks-all-read. */
  read: boolean;
  /** ISO-8601 timestamp the user marked it read (set when read flips true). */
  readAt?: string;
  /** Optional traceability link (e.g. weekly-task id for failure events). */
  sourceTaskId?: string;
  /** Optional dedupe handle for system events. */
  dedupKey?: string;
  /** Optional visual severity hint — defaults to `info` when absent. */
  severity?: NotificationSeverity;
  /** Forward-compatible extensibility bag. */
  metadata?: Record<string, unknown>;
}

/** Inputs accepted by {@link createNotification}. */
export interface CreateNotificationOptions {
  /** Agent slug the notification belongs to. */
  agentId: string;
  /** Source — defaults to `'agent'`. */
  source?: NotificationSource;
  /** Required when source is `'system'`. */
  systemEvent?: NotificationSystemEvent;
  /** Free-form title (≤ 200 chars). */
  title: string;
  /** Free-form body (≤ 5000 chars). */
  body: string;
  /** Optional polymorphic link target — bare URL string OR `{href, label?, external?}` object. */
  link?: NotificationLink;
  /** Optional traceability — typically the weekly-task id. */
  sourceTaskId?: string;
  /** Optional dedupe key (system events). */
  dedupKey?: string;
  /** Optional visual severity hint — defaults to `info` when absent. */
  severity?: NotificationSeverity;
  /** Optional metadata bag (priority, category, action buttons, …). */
  metadata?: Record<string, unknown>;
  /** Override timestamp (defaults to now). Useful for tests. */
  createdAt?: string;
}

/**
 * Inputs accepted by {@link NotificationStore.send} — the high-level
 * convenience entry point used by `aweek exec notify send` and the
 * system-event emitters.
 *
 * Per AC 2, the caller only supplies content (title + body) and any
 * optional fields; the storage layer auto-populates the four pieces of
 * metadata that callers should never have to fabricate by hand:
 *
 *   - sender slug (`agentId`) — taken from the `senderSlug` argument so the
 *     CLI dispatcher can pass the calling agent's identity through once
 *     and the agent itself never has to remember its own slug
 *   - unique `id` — generated as `notif-<lowercase-hex>` via crypto-random
 *     bytes, guaranteeing uniqueness across processes
 *   - `createdAt` timestamp — stamped at write time (UTC ISO-8601)
 *   - `read` flag — defaults to `false` so the dashboard surfaces the
 *     notification as unread until explicitly marked
 *
 * `createdAt` is exposed on this interface as an escape hatch for tests
 * and replay-style tooling, but real-world callers (CLI + system events)
 * should leave it unset and let the store stamp the actual write time.
 */
export interface SendNotificationOptions {
  /** Source — defaults to `'agent'`. */
  source?: NotificationSource;
  /** Required when source is `'system'`. */
  systemEvent?: NotificationSystemEvent;
  /** Free-form title (≤ 200 chars). */
  title: string;
  /** Free-form body (≤ 5000 chars). */
  body: string;
  /** Optional polymorphic link target — bare URL string OR `{href, label?, external?}` object. */
  link?: NotificationLink;
  /** Optional traceability — typically the weekly-task id. */
  sourceTaskId?: string;
  /** Optional dedupe key (system events). */
  dedupKey?: string;
  /** Optional visual severity hint — defaults to `info` when absent. */
  severity?: NotificationSeverity;
  /** Optional metadata bag (priority, category, action buttons, …). */
  metadata?: Record<string, unknown>;
  /**
   * Override timestamp (defaults to now). Provided as an escape hatch for
   * tests and replay tooling; leave unset in production callers so the
   * storage layer stamps the real write time.
   */
  createdAt?: string;
}

/** Optional filters for {@link NotificationStore.query}. */
export interface NotificationQueryFilters {
  /** Filter by source. */
  source?: NotificationSource;
  /** Filter by system event id. */
  systemEvent?: NotificationSystemEvent;
  /** Filter by read flag. */
  read?: boolean;
  /** Limit the number of returned entries (newest first if `newestFirst`). */
  limit?: number;
  /** Reverse the order so the newest notifications come first. */
  newestFirst?: boolean;
}

/** Aggregated counts returned by {@link NotificationStore.summary}. */
export interface NotificationSummary {
  total: number;
  unread: number;
  bySource: Partial<Record<NotificationSource, number>>;
  bySystemEvent: Partial<Record<NotificationSystemEvent, number>>;
}

/**
 * Aggregated entry returned by {@link NotificationStore.loadAll}. Lets the
 * dashboard render a global feed by walking every per-agent file.
 */
export interface NotificationWithAgent extends Notification {
  /** Agent slug whose file the notification was loaded from. */
  agent: string;
}

/**
 * Subscriber contract for external delivery channels (Slack, email, OS
 * push, webhooks, …).
 *
 * The store invokes `deliver()` once per freshly persisted notification,
 * AFTER the on-disk write succeeds. Implementations should return as
 * quickly as possible (or async, fire-and-forget) — the store does not
 * await the returned promise as part of `append()` so a slow or failing
 * channel never blocks storage. Throwing or rejecting is allowed and
 * isolated per-channel; surface errors via the optional `onChannelError`
 * sink configured on the host {@link NotificationStore}.
 */
export interface NotificationDeliveryChannel {
  /** Stable identifier used in error reporting and telemetry. */
  readonly name: string;
  /**
   * Deliver a freshly persisted notification.
   *
   * `agentId` is provided as a separate argument so channels can route
   * by recipient without parsing the payload.
   */
  deliver(notification: Notification, agentId: string): void | Promise<void>;
}

/**
 * Optional error sink invoked when a delivery channel throws or rejects.
 * The store never surfaces channel errors through `append()` itself — that
 * would couple storage success to delivery success. Hosts that need
 * visibility (logs, dashboards) wire a sink at construction time.
 */
export type NotificationChannelErrorHandler = (
  err: unknown,
  context: { channel: string; agentId: string; notificationId: string },
) => void;

/** Constructor options for {@link NotificationStore}. */
export interface NotificationStoreOptions {
  /**
   * Pre-registered delivery channels. Equivalent to calling
   * `store.subscribe(channel)` for each entry after construction.
   */
  channels?: NotificationDeliveryChannel[];
  /**
   * Sink for delivery-channel errors. Defaults to a no-op so a missing
   * sink never crashes the heartbeat or CLI.
   */
  onChannelError?: NotificationChannelErrorHandler;
}

/** Generate a short random hex id. */
const shortId = (): string => randomBytes(4).toString('hex');

/**
 * Build a fully-validated notification from the provided input.
 *
 * Defaults `source` to `'agent'` and `read` to `false`. System events
 * supply their own `source: 'system'` + `systemEvent` discriminator and
 * (typically) a `dedupKey` so the heartbeat does not re-emit until the
 * underlying state clears.
 */
export function createNotification(opts: CreateNotificationOptions): Notification {
  const {
    agentId,
    source = 'agent',
    systemEvent,
    title,
    body,
    link,
    sourceTaskId,
    dedupKey,
    severity,
    metadata,
    createdAt,
  } = opts;
  const notification: Notification = {
    id: `notif-${shortId()}`,
    agentId,
    source,
    title,
    body,
    createdAt: createdAt || new Date().toISOString(),
    read: false,
  };
  if (systemEvent !== undefined) notification.systemEvent = systemEvent;
  if (link !== undefined) notification.link = link;
  if (sourceTaskId !== undefined) notification.sourceTaskId = sourceTaskId;
  if (dedupKey !== undefined) notification.dedupKey = dedupKey;
  if (severity !== undefined) notification.severity = severity;
  if (metadata !== undefined) notification.metadata = metadata;
  return notification;
}

export class NotificationStore {
  /** Root data directory (e.g., ./.aweek/agents). */
  readonly baseDir: string;

  /**
   * Registered delivery channels. Held as a plain array (rather than a
   * Set) so a channel can be registered multiple times intentionally
   * (e.g. in tests). Mutated only through {@link subscribe} and the
   * unsubscribe handle it returns.
   */
  private readonly _channels: NotificationDeliveryChannel[] = [];

  /** See {@link NotificationStoreOptions.onChannelError}. */
  private readonly _onChannelError: NotificationChannelErrorHandler;

  constructor(baseDir: string, options: NotificationStoreOptions = {}) {
    this.baseDir = baseDir;
    this._onChannelError = options.onChannelError || (() => undefined);
    if (options.channels) {
      for (const channel of options.channels) this.subscribe(channel);
    }
  }

  /**
   * Register a delivery channel. The channel's `deliver()` callback fires
   * once per freshly persisted notification — never for an idempotent
   * no-op (duplicate id / dedupKey collision).
   *
   * Returns an unsubscribe function. Re-calling unsubscribe after the
   * channel has already been removed is a safe no-op.
   *
   * The store deliberately exposes no `unsubscribe(channel)` overload —
   * the closure is the only handle, which prevents ambiguity when the
   * same channel object is registered twice.
   */
  subscribe(channel: NotificationDeliveryChannel): () => void {
    this._channels.push(channel);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const idx = this._channels.indexOf(channel);
      if (idx !== -1) this._channels.splice(idx, 1);
    };
  }

  /** Number of currently subscribed delivery channels (test helper). */
  get channelCount(): number {
    return this._channels.length;
  }

  /** Directory for an agent's data. */
  _agentDir(agentId: string): string {
    return join(this.baseDir, agentId);
  }

  /** Path to an agent's notifications file. */
  _filePath(agentId: string): string {
    return join(this._agentDir(agentId), 'notifications.json');
  }

  /** Ensure the agent directory exists. */
  async init(agentId: string): Promise<void> {
    await mkdir(this._agentDir(agentId), { recursive: true });
  }

  /**
   * Load the full notification feed for an agent.
   * Returns an empty array when the file does not exist yet.
   * Validates the feed against the notification-feed schema on load.
   */
  async load(agentId: string): Promise<Notification[]> {
    const filePath = this._filePath(agentId);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const feed = JSON.parse(raw) as Notification[];
      assertValid(FEED_SCHEMA_ID, feed);
      return feed;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Persist the full notification feed for an agent.
   * Validates the entire feed before writing. Uses an atomic
   * write-then-rename so concurrent dashboard reads never see a partial
   * file (the rename is atomic on POSIX filesystems).
   */
  async _save(agentId: string, feed: Notification[]): Promise<void> {
    assertValid(FEED_SCHEMA_ID, feed);
    await this.init(agentId);
    const filePath = this._filePath(agentId);
    const tmpPath = `${filePath}.tmp-${process.pid}-${shortId()}`;
    const payload = JSON.stringify(feed, null, 2) + '\n';
    await writeFile(tmpPath, payload, 'utf-8');
    const { rename, unlink } = await import('node:fs/promises');
    try {
      await rename(tmpPath, filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Append a notification to an agent's feed.
   *
   * Idempotent in two ways:
   *
   *   1. If a notification with the same `id` is already present, no-op.
   *   2. If the new notification carries a `dedupKey` and an UNREAD
   *      notification with the same `dedupKey` already exists, no-op.
   *      This is the system-event dedupe path — e.g. the repeated
   *      task-failure emitter passes `dedupKey: 'task-failure:<taskId>'`
   *      so the heartbeat does not re-emit until the failing task
   *      transitions out of the failing state (which marks the prior
   *      notification read or otherwise clears it).
   *
   * Validates the notification before writing.
   */
  async append(agentId: string, notification: Notification): Promise<Notification> {
    assertValid(NOTIFICATION_SCHEMA_ID, notification);
    const feed = await this.load(agentId);

    if (feed.some((n) => n.id === notification.id)) {
      return notification;
    }
    if (
      typeof notification.dedupKey === 'string' &&
      notification.dedupKey.length > 0 &&
      feed.some(
        (n) =>
          n.dedupKey === notification.dedupKey && n.read === false,
      )
    ) {
      // Caller asked to dedupe and an unread match is already in the feed.
      return notification;
    }

    feed.push(notification);
    await this._save(agentId, feed);
    // Fan out to subscribed delivery channels AFTER the on-disk write
    // succeeds. Errors are isolated per-channel and surfaced through the
    // optional sink so a misbehaving Slack/email/webhook integration never
    // takes down storage or the heartbeat.
    this._fanout(agentId, notification);
    return notification;
  }

  /**
   * Invoke `deliver()` on every subscribed channel. Synchronous channels
   * run inline (their throws are caught); async channels are kicked off
   * with their promise's `.catch()` wired to the error sink so the
   * caller of `append()` does not await delivery.
   *
   * Channels are invoked in registration order. The store snapshots
   * `_channels` before iterating so a channel that unsubscribes during
   * its own callback does not skip a sibling.
   */
  private _fanout(agentId: string, notification: Notification): void {
    if (this._channels.length === 0) return;
    const snapshot = this._channels.slice();
    for (const channel of snapshot) {
      const ctx = {
        channel: channel.name,
        agentId,
        notificationId: notification.id,
      };
      try {
        const result = channel.deliver(notification, agentId);
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch((err: unknown) => {
            this._reportChannelError(err, ctx);
          });
        }
      } catch (err) {
        this._reportChannelError(err, ctx);
      }
    }
  }

  /** Forward a delivery error to the configured sink, swallowing sink errors. */
  private _reportChannelError(
    err: unknown,
    ctx: { channel: string; agentId: string; notificationId: string },
  ): void {
    try {
      this._onChannelError(err, ctx);
    } catch {
      // The sink itself threw — there's nothing useful we can do; we
      // refuse to surface this through `append()` because storage already
      // succeeded.
    }
  }

  /**
   * Convenience entry point: build a notification on behalf of `senderSlug`
   * and persist it.
   *
   * This is the method the CLI dispatcher (`aweek exec notify send`) and
   * the system-event emitters call. It captures AC 2 in a single API:
   * the caller supplies only content + intent, and the storage layer
   * stamps the four pieces of metadata that should never be the agent's
   * responsibility:
   *
   *   - `agentId`   — set to `senderSlug` (the calling agent's slug, which
   *                   the dispatcher knows from runtime context)
   *   - `id`        — generated `notif-<hex>`
   *   - `createdAt` — stamped at write time
   *   - `read`      — defaulted to `false`
   *
   * The full notification idempotency / dedupe / fan-out semantics of
   * {@link append} apply unchanged.
   *
   * @param senderSlug Agent slug to attribute the notification to. For
   *                   `source: 'agent'` this is the sender; for
   *                   `source: 'system'` this is the subject (the agent
   *                   the event is about).
   * @param opts       Free-form content + optional metadata. Required
   *                   shape mirrors {@link SendNotificationOptions}.
   */
  async send(
    senderSlug: string,
    opts: SendNotificationOptions,
  ): Promise<Notification> {
    if (typeof senderSlug !== 'string' || senderSlug.length === 0) {
      throw new Error('senderSlug is required and must be a non-empty string');
    }
    const notification = createNotification({
      agentId: senderSlug,
      source: opts.source,
      systemEvent: opts.systemEvent,
      title: opts.title,
      body: opts.body,
      link: opts.link,
      sourceTaskId: opts.sourceTaskId,
      dedupKey: opts.dedupKey,
      severity: opts.severity,
      metadata: opts.metadata,
      createdAt: opts.createdAt,
    });
    return this.append(senderSlug, notification);
  }

  /** Get a single notification by id. */
  async get(agentId: string, notificationId: string): Promise<Notification | null> {
    const feed = await this.load(agentId);
    return feed.find((n) => n.id === notificationId) || null;
  }

  /**
   * Mark a notification as read.
   *
   * Idempotent: a no-op if the notification is already read. Returns the
   * updated notification, or `null` if no notification with that id exists
   * in the agent's feed.
   */
  async markRead(agentId: string, notificationId: string): Promise<Notification | null> {
    const feed = await this.load(agentId);
    const idx = feed.findIndex((n) => n.id === notificationId);
    if (idx === -1) return null;
    const current = feed[idx] as Notification;
    if (current.read) return current;
    const updated: Notification = {
      ...current,
      read: true,
      readAt: new Date().toISOString(),
    };
    feed[idx] = updated;
    await this._save(agentId, feed);
    return updated;
  }

  /**
   * Mark every unread notification in an agent's feed as read.
   * Returns the number of notifications that were flipped.
   */
  async markAllRead(agentId: string): Promise<number> {
    const feed = await this.load(agentId);
    let flipped = 0;
    const now = new Date().toISOString();
    for (let i = 0; i < feed.length; i++) {
      const current = feed[i] as Notification;
      if (!current.read) {
        feed[i] = { ...current, read: true, readAt: now };
        flipped++;
      }
    }
    if (flipped > 0) {
      await this._save(agentId, feed);
    }
    return flipped;
  }

  /** Count unread notifications for a single agent. */
  async unreadCount(agentId: string): Promise<number> {
    const feed = await this.load(agentId);
    return feed.filter((n) => !n.read).length;
  }

  /**
   * Query notifications with optional filters. Defaults to oldest-first
   * (insertion order) which mirrors the on-disk shape; pass
   * `newestFirst: true` to flip for dashboard list rendering.
   */
  async query(
    agentId: string,
    filters: NotificationQueryFilters = {},
  ): Promise<Notification[]> {
    const feed = await this.load(agentId);
    let results = feed.filter((n) => {
      if (filters.source && n.source !== filters.source) return false;
      if (filters.systemEvent && n.systemEvent !== filters.systemEvent) return false;
      if (typeof filters.read === 'boolean' && n.read !== filters.read) return false;
      return true;
    });
    if (filters.newestFirst) {
      results = [...results].reverse();
    }
    if (typeof filters.limit === 'number' && filters.limit >= 0) {
      results = results.slice(0, filters.limit);
    }
    return results;
  }

  /** Aggregated counts for a single agent's feed. */
  async summary(agentId: string): Promise<NotificationSummary> {
    const feed = await this.load(agentId);
    const bySource: Partial<Record<NotificationSource, number>> = {};
    const bySystemEvent: Partial<Record<NotificationSystemEvent, number>> = {};
    let unread = 0;
    for (const n of feed) {
      bySource[n.source] = (bySource[n.source] || 0) + 1;
      if (n.systemEvent) {
        bySystemEvent[n.systemEvent] = (bySystemEvent[n.systemEvent] || 0) + 1;
      }
      if (!n.read) unread++;
    }
    return {
      total: feed.length,
      unread,
      bySource,
      bySystemEvent,
    };
  }

  /**
   * List every agent slug that has a notifications file under `baseDir`.
   *
   * The dashboard's global inbox calls this to walk every agent rather
   * than relying on the agent registry — keeps the notification surface
   * working even if a stale notifications file sticks around after an
   * agent is deleted.
   */
  async listAgents(): Promise<string[]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(this.baseDir, { withFileTypes: true });
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return [];
      throw err;
    }
    const slugs: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(this._filePath(entry.name), 'utf-8');
        slugs.push(entry.name);
      } catch (err) {
        if (isErrnoException(err) && err.code === 'ENOENT') continue;
        // Permission errors / etc. — skip but don't fail the global view.
      }
    }
    return slugs.sort();
  }

  /**
   * Aggregate every agent's feed into a single time-ordered list.
   *
   * Each entry carries the owning `agent` slug so the dashboard can show
   * sender attribution. Pass `newestFirst: true` (default) to render the
   * inbox top-down. The aggregate respects `limit` after ordering.
   */
  async loadAll(
    filters: NotificationQueryFilters = {},
  ): Promise<NotificationWithAgent[]> {
    const agents = await this.listAgents();
    const newestFirst = filters.newestFirst !== false; // default true for global feed
    const collected: NotificationWithAgent[] = [];
    for (const agent of agents) {
      const perAgent = await this.query(agent, {
        source: filters.source,
        systemEvent: filters.systemEvent,
        read: filters.read,
      });
      for (const n of perAgent) {
        collected.push({ ...n, agent });
      }
    }
    collected.sort((a, b) => {
      if (a.createdAt === b.createdAt) return 0;
      return newestFirst
        ? a.createdAt < b.createdAt
          ? 1
          : -1
        : a.createdAt < b.createdAt
          ? -1
          : 1;
    });
    if (typeof filters.limit === 'number' && filters.limit >= 0) {
      return collected.slice(0, filters.limit);
    }
    return collected;
  }

  /** Total unread count across every agent's feed. */
  async totalUnreadCount(): Promise<number> {
    const agents = await this.listAgents();
    let total = 0;
    for (const agent of agents) {
      total += await this.unreadCount(agent);
    }
    return total;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Narrow `unknown` to a Node `ErrnoException` so we can read the `code` field. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
