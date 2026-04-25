/**
 * `useExecutionLog` — fetches `/api/agents/:slug/executions/:basename`
 * and memoises the parsed + summarised result for consumers (the full
 * detail page and the activity-row drawer).
 *
 * Unlike the resource-specific `use-agent-*` hooks, this hook does NOT
 * delegate to `useApiResource` — it carries its own minimal state shape
 * (`{ loading, data, error }`) plus a memoised `summary` derived from
 * `data.lines` via `parseExecutionLog` + `buildExecutionLogSummary`.
 * The summary lives outside the data pipeline because the heavy work is
 * pure CPU on a multi-thousand-event JSONL stream and we only want to
 * pay the cost when `data` actually changes (cheap reference equality).
 *
 * TypeScript migration note (AC 305 sub-AC 4.5):
 *   This module is part of the final wave of SPA hooks converted from
 *   `.js` → `.ts`. The dependency `../lib/execution-log-summary.js`
 *   stays raw `.js` in this phase but its `@returns` JSDoc is picked up
 *   by `ReturnType<typeof buildExecutionLogSummary>` so consumers get a
 *   typed `summary` shape without a separate `.d.ts` shim.
 *
 * @module serve/spa/hooks/use-execution-log
 */

import { useEffect, useMemo, useState } from 'react';

import {
  buildExecutionLogSummary,
  parseExecutionLog,
} from '../lib/execution-log-summary.js';

/**
 * Wire shape of the execution-log payload returned by
 * `GET /api/agents/:slug/executions/:basename`. The server emits a
 * JSON envelope `{ log: { lines: string[] } }`; we normalize to
 * `data = body.log` here so consumers can read `data.lines` directly.
 *
 * Extra fields on `log` (`startedAt`, `endedAt`, etc., as the server
 * grows them) flow through via the index signature.
 */
export interface ExecutionLogPayload {
  lines?: string[];
  [key: string]: unknown;
}

/**
 * Internal `useState` shape. `loading` mirrors the boot-time guard
 * (`enabled && slug && basename`) so the consumer's first paint already
 * reflects whether a fetch is in flight.
 */
interface ExecutionLogState {
  loading: boolean;
  data: ExecutionLogPayload | null;
  error: Error | null;
}

/**
 * Options accepted by `useExecutionLog`.
 *
 * - `slug` / `basename` identify the execution log on disk (the basename
 *   is the `.jsonl` filename emitted by the heartbeat session executor).
 * - `enabled` defaults to `true`; consumers gate fetches by passing a
 *   computed boolean (e.g. `Boolean(entry && basename)`) to avoid
 *   firing requests for nothing.
 * - `baseUrl` overrides the default same-origin base for tests or
 *   cross-origin dev setups.
 * - `fetch` injects a custom fetch implementation (Storybook / tests).
 */
export interface UseExecutionLogOptions {
  slug?: string;
  basename?: string;
  enabled?: boolean;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Public envelope returned to the component. `summary` is the cached
 * result of running the raw JSONL `lines` through
 * `parseExecutionLog → buildExecutionLogSummary`; it is recomputed only
 * when `data` changes.
 */
export interface UseExecutionLogResult {
  loading: boolean;
  data: ExecutionLogPayload | null;
  error: Error | null;
  summary: ReturnType<typeof buildExecutionLogSummary> | null;
}

/**
 * Fetch one execution log, parse it, and memoise the summary.
 *
 * Returns `{ loading, data, error, summary }`. `summary` is `null`
 * while loading, on error, or when the log has no parseable lines.
 */
export function useExecutionLog(
  opts: UseExecutionLogOptions = {},
): UseExecutionLogResult {
  const { slug, basename, enabled = true, baseUrl, fetch: fetchImpl } = opts;

  const [state, setState] = useState<ExecutionLogState>({
    loading: Boolean(enabled && slug && basename),
    data: null,
    error: null,
  });

  useEffect(() => {
    if (!enabled || !slug || !basename) {
      setState({ loading: false, data: null, error: null });
      return undefined;
    }
    const ctrl = new AbortController();
    const f = fetchImpl || fetch;
    const url = `${baseUrl || ''}/api/agents/${encodeURIComponent(
      slug,
    )}/executions/${encodeURIComponent(basename)}`;
    setState({ loading: true, data: null, error: null });
    f(url, { signal: ctrl.signal })
      .then((r: Response) =>
        r.ok
          ? r.json()
          : r
              .json()
              .then((body: { error?: string } | null) =>
                Promise.reject(
                  new Error(body?.error || `HTTP ${r.status}`),
                ),
              ),
      )
      .then((body: { log?: ExecutionLogPayload | null } | null) =>
        setState({
          loading: false,
          data: body?.log ?? null,
          error: null,
        }),
      )
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const wrapped = err instanceof Error ? err : new Error(String(err));
        setState({ loading: false, data: null, error: wrapped });
      });
    return () => ctrl.abort();
  }, [enabled, slug, basename, baseUrl, fetchImpl]);

  const summary = useMemo<UseExecutionLogResult['summary']>(() => {
    const lines = state.data?.lines;
    if (!Array.isArray(lines) || lines.length === 0) return null;
    return buildExecutionLogSummary(parseExecutionLog(lines));
  }, [state.data]);

  return { ...state, summary };
}
