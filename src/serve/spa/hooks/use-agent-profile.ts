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
 *   if (error && (error as { status?: number }).status === 404) return <AgentNotFound />;
 *
 * TypeScript migration note (AC 305 sub-AC 4.5):
 *   This module is part of the final wave of SPA hooks converted from
 *   `.js` → `.ts`. The dependencies (`../lib/api-client.js`,
 *   `./use-api-resource.js`) expose first-class TypeScript types via
 *   JSDoc `@typedef` declarations / native TS exports respectively. With
 *   `allowJs: true` + Bundler resolution, `import { type AgentProfile }
 *   from '../lib/api-client.js'` reads those typedefs as if they were
 *   native TS exports — no `.d.ts` shim required.
 *
 * @module serve/spa/hooks/use-agent-profile
 */

import { useCallback } from 'react';

import { fetchAgentProfile, type AgentProfile } from '../lib/api-client.js';

import {
  useApiResource,
  type UseApiResourceResult,
} from './use-api-resource.js';

/**
 * Options accepted by `useAgentProfile`.
 *
 * - `baseUrl` overrides the default same-origin base for tests or
 *   cross-origin dev setups.
 * - `fetch` injects a custom fetch implementation (Storybook / tests).
 */
export interface UseAgentProfileOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * React hook backing the Profile tab + header on the per-agent detail page.
 *
 * Returns the standard `useApiResource` envelope (`{ data, error,
 * loading, refresh }`) where `data` is the typed `AgentProfile` payload,
 * or `null` while idle (no slug yet) / before the first successful load.
 *
 * Pass a falsy `slug` (null / undefined / empty string) to keep the hook
 * idle — this is the canonical pattern for mounting the hook before the
 * router has resolved a slug.
 */
export function useAgentProfile(
  slug: string | null | undefined,
  options: UseAgentProfileOptions = {},
): UseApiResourceResult<AgentProfile | null> {
  const { baseUrl, fetch: fetchImpl } = options;
  const enabled = typeof slug === 'string' && slug.length > 0;

  const loader = useCallback(
    (opts: { signal: AbortSignal }): Promise<AgentProfile | null> => {
      // Guard-rail: if the slug becomes falsy between renders, short-circuit
      // with `null` so we don't bombard the server with bad requests.
      // Callers should render based on `data == null`.
      if (!enabled || !slug) return Promise.resolve(null);
      return fetchAgentProfile(slug, { ...opts, baseUrl, fetch: fetchImpl });
    },
    [slug, enabled, baseUrl, fetchImpl],
  );

  return useApiResource<AgentProfile | null>(loader, [
    slug,
    enabled,
    baseUrl,
    fetchImpl,
  ]);
}
