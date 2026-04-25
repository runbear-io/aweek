/**
 * `useAgentUsage` — React hook wrapping `fetchAgentUsage`.
 *
 * Backs the Usage / Budget tab: current-week token totals, utilization
 * percentage, budget-exhaustion state, and historical weekly roll-up.
 *
 * Empty / null slugs short-circuit to idle state.
 *
 * TypeScript migration note (AC 305 sub-AC 4.5):
 *   This module is part of the final wave of SPA hooks converted from
 *   `.js` → `.ts`. The dependencies (`../lib/api-client.js`,
 *   `./use-api-resource.js`) expose first-class TypeScript types via
 *   JSDoc `@typedef` declarations / native TS exports respectively. With
 *   `allowJs: true` + Bundler resolution, `import { type AgentUsage }
 *   from '../lib/api-client.js'` reads those typedefs as if they were
 *   native TS exports — no `.d.ts` shim required.
 *
 * @module serve/spa/hooks/use-agent-usage
 */

import { useCallback } from 'react';

import { fetchAgentUsage, type AgentUsage } from '../lib/api-client.js';

import {
  useApiResource,
  type UseApiResourceResult,
} from './use-api-resource.js';

/**
 * Options accepted by `useAgentUsage`.
 *
 * - `baseUrl` overrides the default same-origin base for tests or
 *   cross-origin dev setups.
 * - `fetch` injects a custom fetch implementation (Storybook / tests).
 */
export interface UseAgentUsageOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * React hook backing the Usage / Budget tab on the per-agent detail page.
 *
 * Returns the standard `useApiResource` envelope (`{ data, error,
 * loading, refresh }`) where `data` is the typed `AgentUsage` payload
 * (current-week + historical weekly token roll-up), or `null` while idle
 * (no slug yet) / before the first successful load.
 *
 * Pass a falsy `slug` (null / undefined / empty string) to keep the hook
 * idle — this is the canonical pattern for mounting the hook before the
 * router has resolved a slug.
 */
export function useAgentUsage(
  slug: string | null | undefined,
  options: UseAgentUsageOptions = {},
): UseApiResourceResult<AgentUsage | null> {
  const { baseUrl, fetch: fetchImpl } = options;
  const enabled = typeof slug === 'string' && slug.length > 0;

  const loader = useCallback(
    (opts: { signal: AbortSignal }): Promise<AgentUsage | null> => {
      if (!enabled || !slug) return Promise.resolve(null);
      return fetchAgentUsage(slug, { ...opts, baseUrl, fetch: fetchImpl });
    },
    [slug, enabled, baseUrl, fetchImpl],
  );

  return useApiResource<AgentUsage | null>(loader, [
    slug,
    enabled,
    baseUrl,
    fetchImpl,
  ]);
}
