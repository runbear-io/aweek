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
 * TypeScript migration note (AC 302 sub-AC 4.2):
 *   This module is part of the second wave of SPA hooks converted from
 *   `.js` → `.ts`. The dependencies (`../lib/api-client.js`,
 *   `./use-api-resource.js`) remain `.js` in this phase but expose
 *   first-class TypeScript types via JSDoc `@typedef` declarations. With
 *   `allowJs: true` + Bundler resolution, `import { type AgentCalendar }
 *   from '../lib/api-client.js'` reads those typedefs as if they were
 *   native TS exports — no `.d.ts` shim required. The `.js` extension on
 *   import specifiers also resolves to `.ts` files transparently under
 *   `moduleResolution: "Bundler"`, so existing callers continue to work
 *   without churn.
 *
 * @module serve/spa/hooks/use-agent-calendar
 */

import { useCallback } from 'react';

import { fetchAgentCalendar, type AgentCalendar } from '../lib/api-client.js';

import { useApiResource, type UseApiResourceResult } from './use-api-resource.js';

/**
 * Options accepted by `useAgentCalendar`.
 *
 * - `week` is an ISO week key (e.g. `"2026-W17"`); when omitted the
 *   server defaults to the current week per the agent's configured time
 *   zone.
 * - `baseUrl` overrides the default same-origin base for tests or
 *   cross-origin dev setups.
 * - `fetch` injects a custom fetch implementation (Storybook / tests).
 */
export interface UseAgentCalendarOptions {
  week?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * React hook backing the Calendar tab on the per-agent detail page.
 *
 * Returns the standard `useApiResource` envelope (`{ data, error,
 * loading, refresh }`) where `data` is the typed `AgentCalendar`
 * payload, or `null` while idle (no slug yet) / before the first
 * successful load.
 *
 * Pass a falsy `slug` (null / undefined / empty string) to keep the hook
 * idle — this is the canonical pattern for mounting the hook before the
 * router has resolved a slug.
 */
export function useAgentCalendar(
  slug: string | null | undefined,
  options: UseAgentCalendarOptions = {},
): UseApiResourceResult<AgentCalendar | null> {
  const { week, baseUrl, fetch: fetchImpl } = options;
  const enabled = typeof slug === 'string' && slug.length > 0;

  const loader = useCallback(
    (opts: { signal: AbortSignal }): Promise<AgentCalendar | null> => {
      if (!enabled || !slug) return Promise.resolve(null);
      return fetchAgentCalendar(slug, {
        ...opts,
        week,
        baseUrl,
        fetch: fetchImpl,
      });
    },
    [slug, enabled, week, baseUrl, fetchImpl],
  );

  return useApiResource<AgentCalendar | null>(loader, [
    slug,
    enabled,
    week,
    baseUrl,
    fetchImpl,
  ]);
}
