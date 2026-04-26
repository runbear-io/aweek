/**
 * Pure state-machine controller backing the React data hooks.
 *
 * This module intentionally has no dependency on React so the core
 * loading / error / abort / dedupe logic can be unit-tested under plain
 * `node --test` — the React hook in `./use-api-resource.js` is a thin
 * glue layer that forwards state changes into `useState`.
 *
 * Lifecycle:
 *   - A controller is created once per "resource slot" (agent slug,
 *     dateRange, etc.) with a `loader({ signal }) => Promise<T>` fn.
 *   - `refresh()` aborts any in-flight request, flips state to loading,
 *     runs the loader, then emits either `{ data }` or `{ error }` — but
 *     only if it is still the *current* request (guards against races
 *     where a slow first fetch resolves after a fast second fetch).
 *   - `destroy()` aborts and clears listeners so the hook's cleanup
 *     effect can't leak timers / fetches after unmount.
 *
 * Subscribe/unsubscribe is synchronous: listeners receive the new state
 * object by reference. Consumers must not mutate it.
 *
 * @module serve/spa/hooks/resource-controller
 */

/**
 * @template T
 * @typedef {object} ResourceState
 * @property {T | null} data     Last successful payload, or `null` until first success.
 * @property {Error | null} error Last error from a non-aborted, current-generation load.
 * @property {boolean} loading   `true` while a load is in flight.
 */

/**
 * @template T
 * @typedef {object} ResourceController
 * @property {() => ResourceState<T>} getState
 * @property {(listener: (state: ResourceState<T>) => void) => () => void} subscribe
 * @property {() => Promise<void>} refresh
 * @property {() => void} destroy
 */

const INITIAL_STATE = Object.freeze({ data: null, error: null, loading: false });

/**
 * Detect the two flavors of abort errors emitted by `fetch` / `AbortController`
 * across Node and browsers so the controller can safely ignore them.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortError(err) {
  if (!err || typeof err !== 'object') return false;
  // DOMException-ish (browser + Node 20+ fetch)
  if (/** @type {any} */ (err).name === 'AbortError') return true;
  // Node < 20 style
  if (/** @type {any} */ (err).code === 'ABORT_ERR') return true;
  return false;
}

/**
 * Create a resource controller around a loader function.
 *
 * @template T
 * @param {(opts: { signal: AbortSignal }) => Promise<T>} loader
 * @returns {ResourceController<T>}
 */
export function createResourceController(loader) {
  if (typeof loader !== 'function') {
    throw new TypeError('createResourceController: loader must be a function');
  }

  /** @type {ResourceState<T>} */
  let state = { ...INITIAL_STATE };
  /** @type {Set<(state: ResourceState<T>) => void>} */
  const listeners = new Set();
  /** Monotonic generation counter — lets us discard stale responses. */
  let generation = 0;
  /** @type {AbortController | null} */
  let currentAbort = null;
  let destroyed = false;

  /**
   * Replace state and notify listeners. We *always* allocate a new object
   * so React's `useState` reference-equality check schedules a re-render.
   *
   * @param {Partial<ResourceState<T>>} patch
   */
  function setState(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      // Swallow listener errors — a faulty subscriber must not poison
      // other subscribers or leave the controller in a wedged state.
      try {
        listener(state);
      } catch {
        /* intentionally ignored */
      }
    }
  }

  /**
   * Subscribe to state changes. Returns an unsubscribe thunk.
   *
   * Newly-attached listeners do *not* receive a synchronous snapshot;
   * callers should seed their own local state via `getState()` first.
   * This mirrors `useSyncExternalStore` semantics.
   *
   * @param {(state: ResourceState<T>) => void} listener
   * @returns {() => void}
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('subscribe: listener must be a function');
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getState() {
    return state;
  }

  /**
   * Start (or restart) a load. Idempotent w.r.t. in-flight requests:
   * any older fetch is aborted and its response discarded.
   *
   * @returns {Promise<void>}
   */
  async function refresh() {
    if (destroyed) return;

    // Abort any in-flight fetch before kicking off a new one.
    if (currentAbort) currentAbort.abort();

    const myGeneration = ++generation;
    const controller = new AbortController();
    currentAbort = controller;

    setState({ loading: true, error: null });

    try {
      const data = await loader({ signal: controller.signal });
      // Stale-response guard: a newer refresh() has superseded us, or
      // the controller has been destroyed. Drop the result.
      if (destroyed || myGeneration !== generation) return;
      setState({ data, error: null, loading: false });
    } catch (err) {
      if (isAbortError(err)) return;
      if (destroyed || myGeneration !== generation) return;
      // Preserve prior `data` on error so transient failures don't
      // blank the UI — components can choose to render stale data
      // alongside an error banner ("Refresh failed").
      setState({
        error: err instanceof Error ? err : new Error(String(err)),
        loading: false,
      });
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (currentAbort) {
      try {
        currentAbort.abort();
      } catch {
        /* ignore — abort() should not throw, but be defensive */
      }
      currentAbort = null;
    }
    listeners.clear();
  }

  return { getState, subscribe, refresh, destroy };
}
