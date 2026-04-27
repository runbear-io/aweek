/**
 * Per-agent notifications gatherer for the SPA dashboard — backs
 * `GET /api/agents/:slug/notifications` (AC 9).
 *
 * Read-only over the existing {@link NotificationStore} surface. The
 * notifications tab on the per-agent detail page renders newest-first,
 * filtered by the slug embedded in the URL. The dashboard global feed
 * (sibling AC) walks the same store; this gatherer is the focused
 * single-agent view.
 *
 * Read-only contract (AC 9 + AC 17):
 *   - No writes from this module — it only `load()`s through
 *     {@link NotificationStore}.
 *   - Per-file errors do not blank the list; the gatherer returns a
 *     load-error string so the SPA can render a banner without
 *     dropping any rows already in memory.
 */
import { join } from 'node:path';

import {
  NotificationStore,
  type Notification,
  type NotificationSummary,
} from '../../storage/notification-store.js';
import { listAllAgentsPartial } from '../../storage/agent-helpers.js';

/** Cap returned to the SPA — keeps the per-agent payload bounded. */
export const MAX_NOTIFICATIONS = 200;

/** Options accepted by {@link gatherAgentNotifications}. */
export interface GatherAgentNotificationsOptions {
  projectDir?: string;
  slug?: string;
}

/** Single notification row returned to the SPA. */
export type AgentNotificationEntry = Notification;

/** Per-agent payload returned to the SPA. */
export interface AgentNotificationsPayload {
  slug: string;
  /** Newest-first, capped at {@link MAX_NOTIFICATIONS}. */
  notifications: AgentNotificationEntry[];
  /** Aggregated counts for the agent's full feed (pre-cap). */
  summary: NotificationSummary;
  /** Convenience mirror of `summary.unread`. */
  unreadCount: number;
  /** Schema/parse failure surfaced to the SPA so it can render a banner. */
  loadError: string | null;
}

/**
 * Gather notifications for a single agent.
 *
 * Returns `null` when the slug is not present on disk (→ 404). When the
 * agent exists but has no notifications file (or an empty feed), returns
 * a payload with `notifications: []` so the SPA can render a deterministic
 * empty state.
 *
 * Per the AC 17 storage/delivery decoupling, this gatherer is the only
 * place SPA data flow touches `NotificationStore`. Callers must not
 * import the storage module directly.
 */
export async function gatherAgentNotifications(
  { projectDir, slug }: GatherAgentNotificationsOptions = {},
): Promise<AgentNotificationsPayload | null> {
  if (!projectDir) {
    throw new Error('gatherAgentNotifications: projectDir is required');
  }
  if (!slug) {
    throw new Error('gatherAgentNotifications: slug is required');
  }

  const agentsDir = join(projectDir, '.aweek', 'agents');
  const { agents: configs } = await listAllAgentsPartial({ dataDir: agentsDir });
  const exists = configs.some((c) => c.id === slug);
  if (!exists) return null;

  const store = new NotificationStore(agentsDir);

  // Surface any load-time error (corrupt JSON, schema validation failure)
  // through `loadError` rather than throwing — the dashboard banner
  // pattern matches `gatherAgentCalendar`'s `loadError` field.
  let feed: Notification[] = [];
  let loadError: string | null = null;
  try {
    feed = await store.load(slug);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    feed = [];
  }

  // Compute summary on the full feed (pre-cap), so the unread badge stays
  // accurate even when the SPA only renders the most recent slice.
  let summary: NotificationSummary;
  try {
    summary = await store.summary(slug);
  } catch {
    summary = {
      total: feed.length,
      unread: feed.filter((n) => !n.read).length,
      bySource: {},
      bySystemEvent: {},
    };
  }

  // Newest-first, capped. The on-disk feed is insertion-order; reverse
  // a copy so the original array remains intact for any concurrent reader.
  const newestFirst = [...feed].reverse().slice(0, MAX_NOTIFICATIONS);

  return {
    slug,
    notifications: newestFirst,
    summary,
    unreadCount: summary.unread,
    loadError,
  };
}
