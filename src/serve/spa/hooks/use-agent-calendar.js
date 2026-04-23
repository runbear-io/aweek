/**
 * `useAgentCalendar` — React hook wrapping `fetchAgentCalendar`.
 *
 * Backs the Calendar tab on the per-agent detail page: surfaces the
 * agent's weekly plan grid, with tasks placed on their `slot` (day/hour)
 * and counts summarised per status.
 *
 * The hook re-fetches automatically when `slug` or `week` changes, so a
 * week-picker wired to `setWeek` triggers a fresh server payload without
 * the component needing to call `refresh()` manually. Omit `week` to
 * default to the current week (matching `/aweek:calendar` behaviour).
 *
 * Empty / null slugs short-circuit to idle state — same pattern as the
 * other `use-agent-*` hooks so the caller can mount the hook before the
 * router has resolved a slug.
 *
 * @module serve/spa/hooks/use-agent-calendar
 */

import { useCallback } from 'react';

import { fetchAgentCalendar } from '../lib/api-client.js';

import { useApiResource } from './use-api-resource.js';

/**
 * @typedef {import('../lib/api-client.js').AgentCalendar} AgentCalendar
 */

/**
 * @param {string | null | undefined} slug
 * @param {{
 *   week?: string,
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} [options]
 * @returns {import('./use-api-resource.js').UseApiResourceResult<AgentCalendar>}
 */
export function useAgentCalendar(slug, options = {}) {
  const { week, baseUrl, fetch: fetchImpl } = options;
  const enabled = typeof slug === 'string' && slug.length > 0;

  const loader = useCallback(
    (opts) => {
      if (!enabled) return Promise.resolve(null);
      return fetchAgentCalendar(slug, {
        ...opts,
        week,
        baseUrl,
        fetch: fetchImpl,
      });
    },
    [slug, enabled, week, baseUrl, fetchImpl],
  );

  return useApiResource(loader, [slug, enabled, week, baseUrl, fetchImpl]);
}
