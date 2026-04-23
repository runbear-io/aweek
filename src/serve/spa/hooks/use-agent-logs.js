/**
 * `useAgentLogs` — React hook wrapping `fetchAgentLogs`.
 *
 * Backs the Activity tab: merges activity-log entries and execution-log
 * audit rows, filtered by a `dateRange` preset.
 *
 * The hook re-fetches automatically when `slug` OR `dateRange` change,
 * so a `<Select>` wired to `setDateRange` triggers a fresh server roll-up
 * without the component having to manually call `refresh()`.
 *
 * Empty / null slugs short-circuit to idle state.
 *
 * @module serve/spa/hooks/use-agent-logs
 */

import { useCallback } from 'react';

import { fetchAgentLogs } from '../lib/api-client.js';

import { useApiResource } from './use-api-resource.js';

/**
 * @typedef {import('../lib/api-client.js').AgentLogs} AgentLogs
 * @typedef {import('../lib/api-client.js').DateRangePreset} DateRangePreset
 */

/**
 * @param {string | null | undefined} slug
 * @param {{
 *   dateRange?: DateRangePreset,
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} [options]
 * @returns {import('./use-api-resource.js').UseApiResourceResult<AgentLogs>}
 */
export function useAgentLogs(slug, options = {}) {
  const { dateRange, baseUrl, fetch: fetchImpl } = options;
  const enabled = typeof slug === 'string' && slug.length > 0;

  const loader = useCallback(
    (opts) => {
      if (!enabled) return Promise.resolve(null);
      return fetchAgentLogs(slug, {
        ...opts,
        dateRange,
        baseUrl,
        fetch: fetchImpl,
      });
    },
    [slug, enabled, dateRange, baseUrl, fetchImpl],
  );

  return useApiResource(loader, [slug, enabled, dateRange, baseUrl, fetchImpl]);
}
