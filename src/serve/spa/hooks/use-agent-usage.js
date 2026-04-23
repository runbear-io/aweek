/**
 * `useAgentUsage` — React hook wrapping `fetchAgentUsage`.
 *
 * Backs the Usage / Budget tab: current-week token totals, utilization
 * percentage, budget-exhaustion state, and historical weekly roll-up.
 *
 * Empty / null slugs short-circuit to idle state.
 *
 * @module serve/spa/hooks/use-agent-usage
 */

import { useCallback } from 'react';

import { fetchAgentUsage } from '../lib/api-client.js';

import { useApiResource } from './use-api-resource.js';

/**
 * @typedef {import('../lib/api-client.js').AgentUsage} AgentUsage
 */

/**
 * @param {string | null | undefined} slug
 * @param {{
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} [options]
 * @returns {import('./use-api-resource.js').UseApiResourceResult<AgentUsage>}
 */
export function useAgentUsage(slug, options = {}) {
  const { baseUrl, fetch: fetchImpl } = options;
  const enabled = typeof slug === 'string' && slug.length > 0;

  const loader = useCallback(
    (opts) => {
      if (!enabled) return Promise.resolve(null);
      return fetchAgentUsage(slug, { ...opts, baseUrl, fetch: fetchImpl });
    },
    [slug, enabled, baseUrl, fetchImpl],
  );

  return useApiResource(loader, [slug, enabled, baseUrl, fetchImpl]);
}
