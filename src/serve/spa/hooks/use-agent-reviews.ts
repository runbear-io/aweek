/**
 * `useAgentReviews` — React hook wrapping `fetchAgentReviews`.
 *
 * Backs the Reviews tab: fetches the per-week review list for an agent,
 * sorted newest-first, capped at 26 entries (~6 months).
 *
 * Empty / null slugs short-circuit to idle state (same pattern as
 * `useAgentLogs`, `useAgentPlan`, etc.).
 *
 * @module serve/spa/hooks/use-agent-reviews
 */

import { useCallback } from 'react';
import { useApiResource, type UseApiResourceResult } from './use-api-resource.js';
import { fetchAgentReviews, type AgentReviews } from '../lib/api-client.js';

export type { AgentReviews };

/**
 * Options accepted by `useAgentReviews`.
 *
 * - `baseUrl` overrides the default same-origin base for tests or
 *   cross-origin dev setups.
 * - `fetch` injects a custom fetch implementation (Storybook / tests).
 */
export interface UseAgentReviewsOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * React hook backing the Reviews tab on the per-agent detail page.
 *
 * Returns the standard `useApiResource` envelope (`{ data, error,
 * loading, refresh }`) where `data` is an `AgentReviews` payload
 * (sorted review list), or `null` while idle / before first load.
 *
 * Pass a falsy `slug` to keep the hook idle.
 */
export function useAgentReviews(
  slug: string | null | undefined,
  options: UseAgentReviewsOptions = {},
): UseApiResourceResult<AgentReviews | null> {
  const { baseUrl, fetch: fetchImpl } = options;
  const enabled = typeof slug === 'string' && slug.length > 0;

  const loader = useCallback(
    (opts: { signal: AbortSignal }): Promise<AgentReviews | null> => {
      if (!enabled || !slug) return Promise.resolve(null);
      return fetchAgentReviews(slug, { ...opts, baseUrl, fetch: fetchImpl });
    },
    [slug, enabled, baseUrl, fetchImpl],
  );

  return useApiResource<AgentReviews | null>(loader, [
    slug,
    enabled,
    baseUrl,
    fetchImpl,
  ]);
}
