/**
 * `useAgentThreads` — React hook wrapping `fetchAgentThreads`.
 *
 * Sub-AC 3 of AC 5: backs the floating chat panel's thread-list
 * sidebar. Returns the per-agent thread summaries with loading /
 * error / refresh state, mirroring the surface area of every other
 * `useAgent*` hook in this directory.
 *
 * Usage:
 *
 *   const { data, error, loading, refresh } = useAgentThreads(slug);
 *   if (loading && !data) return <Spinner />;
 *   if (error)            return <ErrorBanner ... />;
 *   const threads = data?.threads ?? [];
 *
 * The hook re-fetches automatically whenever `slug` changes — switching
 * the chat panel to a different agent triggers a fresh load without the
 * caller touching `refresh()`. The `pollIntervalMs` option mirrors
 * `useAgents`: pass a positive integer to install a background refresh
 * timer, useful when a long-running send may have produced new threads
 * server-side that the in-memory list would otherwise miss.
 *
 * @module serve/spa/hooks/use-agent-threads
 */

import { useCallback, useEffect } from 'react';

import {
  fetchAgentThreads,
  type AgentThreadsResponse,
} from '../lib/api-client.js';

import { useApiResource, type UseApiResourceResult } from './use-api-resource.js';

/**
 * Options accepted by `useAgentThreads`.
 *
 * `slug` is required-but-nullable — when `null` (or empty) the hook
 * skips the fetch and reports `data: null, loading: false`. This
 * mirrors the floating chat panel's "no agent selected" path so the
 * thread list can render an empty state without the consumer
 * conditioning on the slug before calling the hook.
 */
export interface UseAgentThreadsOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /**
   * When set to a positive integer, the hook calls `refresh()` every N
   * milliseconds in the background. Useful when a chat turn may have
   * produced new threads server-side (e.g. another browser tab) that
   * the in-memory list would otherwise miss until manual reload.
   * `0`, `null`, `undefined` all disable polling.
   */
  pollIntervalMs?: number | null;
}

/**
 * Hook return shape. The `null`/`undefined`/empty-slug short-circuit
 * surfaces here as `data: null, loading: false, error: null` so
 * consumers can blindly read `data?.threads ?? []` without staging an
 * extra "is the slug ready" guard.
 */
export type UseAgentThreadsResult = UseApiResourceResult<AgentThreadsResponse>;

/**
 * Fetch the chat-thread summaries for a single agent.
 *
 * @param slug — Agent slug. Pass `null` (or an empty string) to disable
 *   the fetch — the hook returns `{ data: null, error: null,
 *   loading: false, refresh: noop }` so the consumer can render an
 *   empty state without conditioning on the slug.
 */
export function useAgentThreads(
  slug: string | null | undefined,
  options: UseAgentThreadsOptions = {},
): UseAgentThreadsResult {
  const { baseUrl, fetch: fetchImpl, pollIntervalMs } = options;

  // Bind `slug` + transport options into the loader. The `useApiResource`
  // base hook re-runs whenever any value in `deps` changes, so the
  // dependency tuple drives re-fetching on slug switch.
  const loader = useCallback(
    (opts: { signal: AbortSignal }) => {
      // Short-circuit for the "no agent selected" case. `useApiResource`
      // expects a Promise from the loader — resolving with an empty
      // payload keeps the UI's "no threads" empty state coherent and
      // avoids a 400 from `assertValidSlug`.
      if (!slug) {
        const empty: AgentThreadsResponse = { agentId: '', threads: [] };
        return Promise.resolve(empty);
      }
      return fetchAgentThreads(slug, { ...opts, baseUrl, fetch: fetchImpl });
    },
    [slug, baseUrl, fetchImpl],
  );

  const result = useApiResource<AgentThreadsResponse>(loader, [
    slug,
    baseUrl,
    fetchImpl,
  ]);

  // Optional background polling — same pattern as `useAgents`. The
  // hook installs a `setInterval` only when `pollIntervalMs > 0`,
  // and clears it on unmount or when the cadence drops.
  const { refresh } = result;
  useEffect(() => {
    if (
      pollIntervalMs === undefined ||
      pollIntervalMs === null ||
      !(pollIntervalMs > 0)
    ) {
      return undefined;
    }
    // Don't poll while there is no slug — there's nothing to refresh.
    if (!slug) return undefined;
    const id = setInterval(() => {
      void refresh();
    }, pollIntervalMs);
    return () => clearInterval(id);
  }, [pollIntervalMs, slug, refresh]);

  return result;
}
