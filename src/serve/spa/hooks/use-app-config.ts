/**
 * `useAppConfig` — React hook wrapping `fetchAppConfig`.
 *
 * Backs the Settings page. Returns the full app-config payload
 * (config.json fields + compiled-in constants grouped by category)
 * with loading / error / refresh state.
 *
 * Usage:
 *   const { data, error, loading, refresh } = useAppConfig();
 *
 *   if (loading && !data) return <Skeleton />;
 *   if (error && !data) return <ErrorBanner error={error} onRetry={refresh} />;
 *   // data.status === 'missing' → show inline warning
 *   // data.categories → render category cards
 *
 * @module serve/spa/hooks/use-app-config
 */

import { useCallback } from 'react';

import { fetchAppConfig, type AppConfigPayload } from '../lib/api-client.js';
import { useApiResource, type UseApiResourceResult } from './use-api-resource.js';

/**
 * Options accepted by `useAppConfig`.
 *
 * - `baseUrl` overrides the default same-origin base for tests or
 *   cross-origin dev setups.
 * - `fetch` injects a custom fetch implementation (Storybook / tests).
 */
export interface UseAppConfigOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * React hook backing the Settings page.
 *
 * Returns the standard `useApiResource` envelope (`{ data, error,
 * loading, refresh }`) where `data` is the typed `AppConfigPayload`.
 */
export function useAppConfig(
  options: UseAppConfigOptions = {},
): UseApiResourceResult<AppConfigPayload> {
  const { baseUrl, fetch: fetchImpl } = options;

  const loader = useCallback(
    (opts: { signal: AbortSignal }) =>
      fetchAppConfig({ ...opts, baseUrl, fetch: fetchImpl }),
    [baseUrl, fetchImpl],
  );

  return useApiResource<AppConfigPayload>(loader, [baseUrl, fetchImpl]);
}
