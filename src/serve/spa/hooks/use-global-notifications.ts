/**
 * `useGlobalNotifications` — React hook wrapping `fetchAllNotifications`.
 *
 * Backs the dashboard's global inbox view (the "all agents" notification
 * feed plus the unread badge in the sidebar). Returns the standard
 * `useApiResource` envelope (`{ data, error, loading, refresh }`) where
 * `data` is the global feed payload — newest-first list across every
 * agent plus a global `unreadCount` derived from the unfiltered feed.
 *
 * Usage:
 *
 *   const { data, error, loading, refresh } = useGlobalNotifications();
 *   if (loading && !data) return <Spinner />;
 *   if (error) return <ErrorBanner error={error} onRetry={refresh} />;
 *   return (
 *     <Inbox
 *       rows={data?.notifications ?? []}
 *       unread={data?.unreadCount ?? 0}
 *       onRefresh={refresh}
 *     />
 *   );
 *
 * Filters (`source`, `systemEvent`, `read`, `limit`) are forwarded on
 * every request so callers can wire query-string controls or sidebar
 * toggles without composing the URL by hand. Changing any filter (or
 * `baseUrl` / `fetch`) re-runs the loader — the values participate in
 * the dependency array fed to `useApiResource`.
 *
 * Architectural decoupling note (AC 17):
 *   This hook is a *read-only* client of the global notification
 *   endpoint. Storage and delivery stay decoupled — the hook never
 *   touches `NotificationStore` directly, only the API surface. Future
 *   external push channels (Slack, email, OS push) plug in below the
 *   storage layer; this hook does not need to know they exist.
 *
 * @module serve/spa/hooks/use-global-notifications
 */

import { useCallback } from 'react';

import {
  fetchAllNotifications,
  type AllNotificationsResponse,
  type FetchAllNotificationsOptions,
  type NotificationWithAgentRow,
} from '../lib/api-client.js';

import { useApiResource, type UseApiResourceResult } from './use-api-resource.js';

// Re-export the row alias so consumers can pull both the hook and its
// row type from the same module without reaching into `../lib/api-client.js`.
// `GlobalNotificationRow` is the consumer-facing alias name.
export type GlobalNotificationRow = NotificationWithAgentRow;
export type { NotificationWithAgentRow, AllNotificationsResponse };

/**
 * Options accepted by `useGlobalNotifications`.
 *
 * - `baseUrl` overrides the default same-origin base for tests or
 *   cross-origin dev setups.
 * - `fetch` injects a custom fetch implementation (Storybook / tests).
 * - `source`, `systemEvent`, `read`, `limit` are forwarded to the global
 *   notifications endpoint as filter query params.
 */
export interface UseGlobalNotificationsOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  source?: FetchAllNotificationsOptions['source'];
  systemEvent?: FetchAllNotificationsOptions['systemEvent'];
  read?: boolean;
  limit?: number;
}

/**
 * Re-export of the wire payload returned by the global notifications
 * endpoint. Hook consumers typically read `data.notifications` and
 * `data.unreadCount`; the row type is re-exported below as
 * `GlobalNotificationRow` for components that want to type a single row.
 */
export type GlobalNotificationsData = AllNotificationsResponse;

/**
 * React hook backing the global inbox view.
 *
 * Returns the standard `useApiResource` envelope (`{ data, error,
 * loading, refresh }`) where `data` is the typed
 * `GlobalNotificationsData` payload.
 *
 * Re-fetch policy: any change to `baseUrl`, `fetch`, or any filter
 * (`source`, `systemEvent`, `read`, `limit`) triggers a fresh load. The
 * stale-with-banner pattern from `useApiResource` is preserved — `data`
 * is held through error transitions so the UI can keep rendering the
 * last-known feed alongside an inline error banner.
 */
export function useGlobalNotifications(
  options: UseGlobalNotificationsOptions = {},
): UseApiResourceResult<GlobalNotificationsData> {
  const { baseUrl, fetch: fetchImpl, source, systemEvent, read, limit } = options;

  // Bind the loader once per dep change. The hook re-runs only when the
  // values that actually shape the request URL/body differ between
  // renders — the underlying `useApiResource` reads `loader` through a
  // ref, so re-creating the closure on each render is cheap.
  const loader = useCallback(
    (opts: { signal: AbortSignal }) =>
      fetchAllNotifications({
        ...opts,
        baseUrl,
        fetch: fetchImpl,
        source,
        systemEvent,
        read,
        limit,
      }),
    [baseUrl, fetchImpl, source, systemEvent, read, limit],
  );

  return useApiResource<GlobalNotificationsData>(loader, [
    baseUrl,
    fetchImpl,
    source,
    systemEvent,
    read,
    limit,
  ]);
}

