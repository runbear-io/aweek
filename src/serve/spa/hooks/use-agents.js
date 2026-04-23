/**
 * `useAgents` — React hook wrapping `fetchAgentsList`.
 *
 * Backs the Overview page table. Returns the full agent list with
 * loading / error / refresh state.
 *
 * Usage:
 *   const { data: agents, error, loading, refresh } = useAgents();
 *
 *   if (loading && !agents) return <Spinner />;
 *   if (error) return <ErrorBanner error={error} onRetry={refresh} />;
 *   return <AgentsTable rows={agents ?? []} onRefresh={refresh} />;
 *
 * @module serve/spa/hooks/use-agents
 */

import { useCallback } from 'react';

import { fetchAgentsList } from '../lib/api-client.js';

import { useApiResource } from './use-api-resource.js';

/**
 * @typedef {import('../lib/api-client.js').AgentListRow} AgentListRow
 */

/**
 * @param {{
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} [options]
 *   - `baseUrl` overrides the default same-origin base for tests or
 *     cross-origin dev setups.
 *   - `fetch` injects a custom fetch implementation (Storybook / tests).
 * @returns {import('./use-api-resource.js').UseApiResourceResult<AgentListRow[]>}
 */
export function useAgents(options = {}) {
  const { baseUrl, fetch: fetchImpl } = options;

  // Bind baseUrl/fetch once per dep change; the hook re-runs only when
  // these values actually differ between renders.
  const loader = useCallback(
    (opts) => fetchAgentsList({ ...opts, baseUrl, fetch: fetchImpl }),
    [baseUrl, fetchImpl],
  );

  return useApiResource(loader, [baseUrl, fetchImpl]);
}
