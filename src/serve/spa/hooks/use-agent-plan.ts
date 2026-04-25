/**
 * `useAgentPlan` — React hook wrapping `fetchAgentPlan`.
 *
 * Backs the Plan tab: renders plan.md markdown plus the structured
 * weekly-plan list (ISO week keys, tasks, approval state).
 *
 * Empty / null slugs short-circuit to idle state (see `useAgentProfile`
 * for the same pattern).
 *
 * TypeScript migration note (AC 303 sub-AC 4.3):
 *   This module is part of the SPA hooks converted from `.js` → `.ts`.
 *   The dependencies (`../lib/api-client.js`, `./use-api-resource.js`)
 *   remain `.js` in this phase but expose first-class TypeScript types
 *   via JSDoc `@typedef` declarations. With `allowJs: true` + Bundler
 *   resolution, `import { type AgentPlan } from '../lib/api-client.js'`
 *   reads those typedefs as if they were native TS exports — no `.d.ts`
 *   shim required. The `.js` extension on import specifiers also
 *   resolves to `.ts` files transparently under
 *   `moduleResolution: "Bundler"`, so existing callers continue to work
 *   without churn.
 *
 * @module serve/spa/hooks/use-agent-plan
 */

import { useCallback } from 'react';

import { fetchAgentPlan, type AgentPlan } from '../lib/api-client.js';

import { useApiResource, type UseApiResourceResult } from './use-api-resource.js';

/**
 * Options accepted by `useAgentPlan`.
 *
 * - `baseUrl` overrides the default same-origin base for tests or
 *   cross-origin dev setups.
 * - `fetch` injects a custom fetch implementation (Storybook / tests).
 */
export interface UseAgentPlanOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * React hook backing the Plan tab on the per-agent detail page.
 *
 * Returns the standard `useApiResource` envelope (`{ data, error,
 * loading, refresh }`) where `data` is the typed `AgentPlan` payload
 * (plan.md markdown + structured weekly plans), or `null` while idle
 * (no slug yet) / before the first successful load.
 *
 * Pass a falsy `slug` (null / undefined / empty string) to keep the hook
 * idle — this is the canonical pattern for mounting the hook before the
 * router has resolved a slug.
 */
export function useAgentPlan(
  slug: string | null | undefined,
  options: UseAgentPlanOptions = {},
): UseApiResourceResult<AgentPlan | null> {
  const { baseUrl, fetch: fetchImpl } = options;
  const enabled = typeof slug === 'string' && slug.length > 0;

  const loader = useCallback(
    (opts: { signal: AbortSignal }): Promise<AgentPlan | null> => {
      if (!enabled || !slug) return Promise.resolve(null);
      return fetchAgentPlan(slug, { ...opts, baseUrl, fetch: fetchImpl });
    },
    [slug, enabled, baseUrl, fetchImpl],
  );

  return useApiResource<AgentPlan | null>(loader, [
    slug,
    enabled,
    baseUrl,
    fetchImpl,
  ]);
}
