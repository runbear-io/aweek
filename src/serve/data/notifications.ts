/**
 * Global notification feed for the SPA dashboard inbox.
 *
 * Read-only JSON gatherer for the dashboard's global inbox view. Walks
 * every per-agent `.aweek/agents/<slug>/notifications.json` file via
 * `NotificationStore.loadAll()` and returns a single time-ordered
 * (newest-first) feed. Per-agent attribution is preserved on every entry
 * via the `agent` slug field on each row.
 *
 * Sources from `src/storage/notification-store.js` only — no new
 * persistence, no writes. The companion test in `data.test.ts` enforces
 * the read-only invariant by static-scanning this module for forbidden
 * fs-write APIs and disallowed imports.
 *
 * The companion mutation endpoints (`POST /api/notifications/:slug/:id/read`
 * and `POST /api/notifications/read-all`) intentionally relax the
 * read-only invariant for notifications — but those writes flow through
 * `NotificationStore.markRead` / `markAllRead` and are wired separately;
 * this gatherer remains a pure read.
 *
 * Endpoint mapping:
 *   /api/notifications  → gatherAllNotifications  (global feed)
 */

import { join } from 'node:path';
import { NotificationStore } from '../../storage/notification-store.js';
import type {
  NotificationSource,
  NotificationSystemEvent,
  NotificationWithAgent,
} from '../../storage/notification-store.js';

/**
 * Default cap on the global feed so the SPA never has to render thousands
 * of rows. v1 storage is append-only with no pruning, so an aggressive
 * cap here keeps the inbox responsive even after years of notifications.
 * The value is intentionally higher than the per-agent inbox typically
 * surfaces — this is the global feed across every agent.
 */
const DEFAULT_LIMIT = 200;

/** Optional filters accepted by {@link gatherAllNotifications}. */
export interface GatherAllNotificationsOptions {
  projectDir?: string;
  /** Filter by source ('agent' | 'system'). */
  source?: NotificationSource;
  /** Filter by system event id. */
  systemEvent?: NotificationSystemEvent;
  /** Filter by read flag. */
  read?: boolean;
  /**
   * Cap the response (applied after the reverse-chronological sort).
   * Defaults to {@link DEFAULT_LIMIT}.
   */
  limit?: number;
}

/** Payload returned to the SPA's global inbox view. */
export interface AllNotificationsPayload {
  /**
   * Reverse-chronological (newest-first) global notification feed across
   * every agent. Each entry carries an `agent` slug so the dashboard can
   * render sender attribution without a second round-trip.
   */
  notifications: NotificationWithAgent[];
  /**
   * Total unread count across every agent's feed.
   *
   * Derived from the unfiltered feed (independent of the filters above)
   * so the dashboard's inbox badge stays accurate when the user narrows
   * the visible rows by source / read flag / system event.
   */
  unreadCount: number;
}

/**
 * Gather the global notification feed across every agent.
 *
 * Walks every per-agent notifications file under `<projectDir>/.aweek/agents/`
 * via {@link NotificationStore.loadAll}, then returns the merged feed
 * sorted newest-first plus the global unread count.
 *
 * Returns an empty feed (with `unreadCount: 0`) when the agents directory
 * is missing or no agent has emitted a notification yet — never throws
 * for an empty project.
 */
export async function gatherAllNotifications(
  {
    projectDir,
    source,
    systemEvent,
    read,
    limit = DEFAULT_LIMIT,
  }: GatherAllNotificationsOptions = {},
): Promise<AllNotificationsPayload> {
  if (!projectDir) {
    throw new Error('gatherAllNotifications: projectDir is required');
  }
  const agentsDir = join(projectDir, '.aweek', 'agents');
  const store = new NotificationStore(agentsDir);

  // The store's loadAll() already walks every agent, applies per-agent
  // filters, merges into a single list, and sorts globally. We pass
  // `newestFirst: true` explicitly to be defensive against a future
  // default flip — Sub-AC 1's contract is reverse-chronological order.
  const notifications = await store.loadAll({
    source,
    systemEvent,
    read,
    limit,
    newestFirst: true,
  });

  // Unread total is intentionally derived from the unfiltered feed so the
  // SPA's inbox badge stays correct when the user narrows the visible
  // rows by source / read flag / system event.
  const unreadCount = await store.totalUnreadCount();

  return { notifications, unreadCount };
}
