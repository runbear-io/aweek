/**
 * `useExecutionLog` — fetches `/api/agents/:slug/executions/:basename`
 * and memoises the parsed + summarised result for consumers (the full
 * detail page and the activity-row drawer).
 *
 * @module serve/spa/hooks/use-execution-log
 */

import { useEffect, useMemo, useState } from 'react';

import {
  buildExecutionLogSummary,
  parseExecutionLog,
} from '../lib/execution-log-summary.js';

/**
 * @param {{
 *   slug: string,
 *   basename: string,
 *   enabled?: boolean,
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} opts
 */
export function useExecutionLog({ slug, basename, enabled = true, baseUrl, fetch: fetchImpl } = {}) {
  const [state, setState] = useState({
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
    const url = `${baseUrl || ''}/api/agents/${encodeURIComponent(slug)}/executions/${encodeURIComponent(basename)}`;
    setState({ loading: true, data: null, error: null });
    f(url, { signal: ctrl.signal })
      .then((r) =>
        r.ok
          ? r.json()
          : r.json().then((body) => Promise.reject(new Error(body?.error || `HTTP ${r.status}`))),
      )
      .then((body) => setState({ loading: false, data: body?.log ?? null, error: null }))
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setState({ loading: false, data: null, error: err });
      });
    return () => ctrl.abort();
  }, [enabled, slug, basename, baseUrl, fetchImpl]);

  const summary = useMemo(() => {
    const lines = state.data?.lines;
    if (!Array.isArray(lines) || lines.length === 0) return null;
    return buildExecutionLogSummary(parseExecutionLog(lines));
  }, [state.data]);

  return { ...state, summary };
}
