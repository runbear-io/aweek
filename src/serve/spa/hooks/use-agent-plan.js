/**
 * `useAgentPlan` — React hook wrapping `fetchAgentPlan`.
 *
 * Backs the Plan tab: renders plan.md markdown plus the structured
 * weekly-plan list (ISO week keys, tasks, approval state).
 *
 * Empty / null slugs short-circuit to idle state (see `useAgentProfile`
 * for the same pattern).
 *
 * @module serve/spa/hooks/use-agent-plan
 */

import { useCallback } from 'react';

import { fetchAgentPlan } from '../lib/api-client.js';

import { useApiResource } from './use-api-resource.js';

/**
 * @typedef {import('../lib/api-client.js').AgentPlan} AgentPlan
 */

/**
 * @param {string | null | undefined} slug
 * @param {{
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} [options]
 * @returns {import('./use-api-resource.js').UseApiResourceResult<AgentPlan>}
 */
export function useAgentPlan(slug, options = {}) {
  const { baseUrl, fetch: fetchImpl } = options;
  const enabled = typeof slug === 'string' && slug.length > 0;

  const loader = useCallback(
    (opts) => {
      if (!enabled) return Promise.resolve(null);
      return fetchAgentPlan(slug, { ...opts, baseUrl, fetch: fetchImpl });
    },
    [slug, enabled, baseUrl, fetchImpl],
  );

  return useApiResource(loader, [slug, enabled, baseUrl, fetchImpl]);
}
