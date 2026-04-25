/**
 * `useApiResource` — the base React hook for read-only dashboard data.
 *
 * All resource-specific hooks (`useAgents`, `useAgentProfile`, …) are
 * thin wrappers around this one. The heavy lifting — request dedupe,
 * abort handling, stale-response guards — lives in the React-free
 * `./resource-controller.js` state machine so it can be unit-tested
 * without a renderer.
 *
 * Return shape is intentionally minimal:
 *
 *   { data, error, loading, refresh }
 *
 *   - `data`    : last successful payload, `null` until first success.
 *   - `error`   : last non-abort error (an `Error` instance). `null`
 *                 after a successful refresh. Data is NOT cleared on
 *                 error so components can render "stale + banner" UX.
 *   - `loading` : `true` while a load is in flight.
 *   - `refresh` : stable `() => Promise<void>` thunk; callers can wire
 *                 it to a "Refresh" button. Safe to call during a load —
 *                 the in-flight request is aborted first.
 *
 * Re-fetch policy:
 *   The hook re-runs the loader whenever any value in `deps` changes
 *   (shallow equality, same semantics as `useEffect`). Resource-specific
 *   wrappers thread slug / dateRange / etc. into `deps` so navigation
 *   triggers a fresh load without the caller touching `refresh()`.
 *
 * Cleanup:
 *   On unmount (or when `deps` change) the controller is destroyed,
 *   which aborts the in-flight fetch and clears its subscribers —
 *   guaranteeing no state updates leak onto an unmounted component.
 *
 * TypeScript migration note (AC 305 sub-AC 4.5):
 *   This module was promoted from `.js` → `.ts` alongside the remaining
 *   user-facing `use-agent-*` hooks. The underlying state machine in
 *   `./resource-controller.js` deliberately stays raw `.js` because
 *   `resource-controller.test.js` is a `node:test` suite that imports the
 *   module by its on-disk filename (Node's ESM resolver can't follow
 *   `.js → .ts` transparently). The JSDoc types on `resource-controller.js`
 *   are picked up here via `allowJs: true` so this conversion needs no
 *   `.d.ts` shim.
 *
 * @module serve/spa/hooks/use-api-resource
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { createResourceController } from './resource-controller.js';

/**
 * Public envelope returned by `useApiResource` and by every
 * resource-specific wrapper (`useAgents`, `useAgentProfile`, …).
 */
export interface UseApiResourceResult<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Internal state shape held in `useState`. Distinct from the public
 * `UseApiResourceResult<T>` because the hook layers its own stable
 * `refresh` callback on top.
 */
interface InternalState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

/**
 * Loader function passed by callers. Must honor the abort `signal` so
 * the hook can cancel in-flight work.
 */
export type ApiResourceLoader<T> = (opts: {
  signal: AbortSignal;
}) => Promise<T>;

/**
 * Minimal slice of the controller surface this hook actually consumes.
 * Mirrors the `ResourceController<T>` typedef on
 * `./resource-controller.js` without re-importing it (the JSDoc-only
 * typedef there is fine for type-checking but doesn't carry over as a
 * named export under Bundler resolution).
 */
interface InternalController<T> {
  refresh: () => Promise<void>;
  destroy: () => void;
  subscribe: (listener: (state: InternalState<T>) => void) => () => void;
}

/**
 * Wrap a loader fn in a React hook exposing `{ data, error, loading, refresh }`.
 *
 * The hook kicks off an initial load on mount and re-loads whenever any
 * value in `deps` changes. In-flight requests are aborted when
 * superseded or on unmount.
 *
 * `loader` is read through a ref so re-renders that merely change the
 * closure (e.g. a fresh `fetch`/`baseUrl` option object on every render)
 * do NOT trigger a reload — pass those values through `deps` if you want
 * re-fetching behavior.
 */
export function useApiResource<T>(
  loader: ApiResourceLoader<T>,
  deps: ReadonlyArray<unknown> = [],
): UseApiResourceResult<T> {
  if (typeof loader !== 'function') {
    throw new TypeError('useApiResource: loader must be a function');
  }

  // Hold the latest loader in a ref so the effect below can use the
  // freshest closure without adding it to `deps` (which would force a
  // new controller on every render).
  const loaderRef = useRef<ApiResourceLoader<T>>(loader);
  loaderRef.current = loader;

  const [state, setState] = useState<InternalState<T>>({
    data: null,
    error: null,
    loading: true,
  });

  // Controller ref is what `refresh()` dispatches to. It is re-created
  // every time `deps` change; callers holding an old `refresh` still
  // see the correct behavior because we always read from the ref.
  const controllerRef = useRef<InternalController<T> | null>(null);

  useEffect(() => {
    // Forward-declare a stable loader wrapper so the controller always
    // calls through the latest `loaderRef.current`. The wrapper itself
    // doesn't change across renders.
    const controller = createResourceController((opts: { signal: AbortSignal }) =>
      loaderRef.current(opts),
    ) as InternalController<T>;
    controllerRef.current = controller;

    // Seed local state from whatever the controller reports first. We
    // explicitly mark loading=true upfront so the UI doesn't flash
    // "empty" between mount and the first state emission.
    setState({ data: null, error: null, loading: true });

    const unsubscribe = controller.subscribe((next) => {
      // Avoid gratuitous state churn by copying into a fresh object —
      // React's bailout on referential equality needs a *new* reference.
      setState({
        data: next.data,
        error: next.error,
        loading: next.loading,
      });
    });

    // Kick off the initial load. Intentionally unawaited — React effects
    // can't be async and we forward errors via state.
    controller.refresh();

    return () => {
      unsubscribe();
      controller.destroy();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
    // We intentionally omit `loader` from the dependency list: the ref
    // pattern keeps the controller calling through to the freshest
    // closure, and including it would thrash the effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const refresh = useCallback(async (): Promise<void> => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    await ctrl.refresh();
  }, []);

  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    refresh,
  };
}
