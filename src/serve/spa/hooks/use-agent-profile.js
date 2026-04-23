/**
 * `useAgentProfile` — React hook wrapping `fetchAgentProfile`.
 *
 * Backs the Profile tab and header details on the per-agent page.
 *
 * A `null` / empty slug is treated as "not ready" — the hook returns
 * `{ data: null, error: null, loading: false }` and skips the fetch.
 * This lets parents mount the hook before the slug from the router is
 * resolved without triggering a request for `/api/agents/`.
 *
 * 404 responses surface as `ApiError` with `status: 404` on `error` so
 * the Profile page can render a "not found" state:
 *
 *   if (error && error.status === 404) return <AgentNotFound />;
 *
 * @module serve/spa/hooks/use-agent-profile
 */

import { useCallback } from 'react';

import { fetchAgentProfile } from '../lib/api-client.js';

import { useApiResource } from './use-api-resource.js';

/**
 * @typedef {import('../lib/api-client.js').AgentProfile} AgentProfile
 */

/**
 * @param {string | null | undefined} slug
 * @param {{
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} [options]
 * @returns {import('./use-api-resource.js').UseApiResourceResult<AgentProfile>}
 */
export function useAgentProfile(slug, options = {}) {
  const { baseUrl, fetch: fetchImpl } = options;
  const enabled = typeof slug === 'string' && slug.length > 0;

  const loader = useCallback(
    (opts) => {
      // Guard-rail: if the slug becomes falsy between renders, short-circuit
      // with `null` so we don't bombard the server with bad requests.
      // Callers should render based on `data == null`.
      if (!enabled) return Promise.resolve(null);
      return fetchAgentProfile(slug, { ...opts, baseUrl, fetch: fetchImpl });
    },
    [slug, enabled, baseUrl, fetchImpl],
  );

  return useApiResource(loader, [slug, enabled, baseUrl, fetchImpl]);
}
