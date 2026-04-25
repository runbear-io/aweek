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
 * TypeScript migration note (AC 301 sub-AC 4.1):
 *   This module is the first SPA hook converted from `.js` → `.ts`. Its
 *   dependencies (`../lib/api-client.js`, `./use-api-resource.js`) remain
 *   `.js` in this phase but expose first-class TypeScript types via JSDoc
 *   `@typedef` declarations. With `allowJs: true` + Bundler resolution,
 *   `import { type AgentListRow } from '../lib/api-client.js'` reads those
 *   typedefs as if they were native TS exports — no `.d.ts` shim required.
 *
 * @module serve/spa/hooks/use-agents
 */

import { useCallback } from 'react';

import { fetchAgentsList, type AgentListRow } from '../lib/api-client.js';

import { useApiResource, type UseApiResourceResult } from './use-api-resource.js';

/**
 * Per-agent load issue surfaced by `GET /api/agents` alongside the
 * successfully-loaded rows. The dashboard renders these inline as a
 * banner instead of silently dropping invalid records.
 */
export interface AgentsListIssue {
  id: string;
  message: string;
}

/**
 * Envelope returned by `fetchAgentsList` and exposed to consumers via
 * `useAgents().data`. `rows` are the agent overview rows; `issues`
 * collects per-agent load failures so the dashboard can surface them
 * inline instead of silently dropping invalid records.
 */
export interface AgentsListData {
  rows: AgentListRow[];
  issues: AgentsListIssue[];
}

/**
 * Options accepted by `useAgents`.
 *
 * - `baseUrl` overrides the default same-origin base for tests or
 *   cross-origin dev setups.
 * - `fetch` injects a custom fetch implementation (Storybook / tests).
 */
export interface UseAgentsOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * React hook backing the Overview page table.
 *
 * Returns the standard `useApiResource` envelope (`{ data, error,
 * loading, refresh }`) where `data` is the typed `AgentsListData`
 * payload.
 */
export function useAgents(
  options: UseAgentsOptions = {},
): UseApiResourceResult<AgentsListData> {
  const { baseUrl, fetch: fetchImpl } = options;

  // Bind baseUrl/fetch once per dep change; the hook re-runs only when
  // these values actually differ between renders.
  const loader = useCallback(
    (opts: { signal: AbortSignal }) =>
      fetchAgentsList({ ...opts, baseUrl, fetch: fetchImpl }),
    [baseUrl, fetchImpl],
  );

  return useApiResource<AgentsListData>(loader, [baseUrl, fetchImpl]);
}
