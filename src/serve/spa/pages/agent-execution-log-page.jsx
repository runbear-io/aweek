/**
 * `AgentExecutionLogPage` — renders the NDJSON body of a single
 * execution log for `/agents/:slug/activity/:basename`.
 *
 * Sources its data from `/api/agents/:slug/executions/:basename`, which
 * the server surfaces from `streamExecutionLogLines`. Lines are shown
 * verbatim as pretty-printed JSON inside a scrollable `<pre>`, matching
 * the terminal-tool expectation that this page is an audit surface, not
 * a formatted explorer.
 *
 * @module serve/spa/pages/agent-execution-log-page
 */

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { Badge } from '../components/ui/badge.jsx';
import { Button } from '../components/ui/button.jsx';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.jsx';
import { cn } from '../lib/cn.js';

/**
 * @param {{
 *   slug: string,
 *   basename: string,
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} props
 */
export function AgentExecutionLogPage({ slug, basename, baseUrl, fetch: fetchImpl }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
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
  }, [slug, basename, baseUrl, fetchImpl]);

  const [taskId, executionId] = splitBasename(basename);
  const lines = state.data?.lines || [];

  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-execution-log"
      data-agent-slug={slug}
      data-basename={basename}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button asChild variant="ghost" size="sm">
          <Link to={`/agents/${slug}/activity`}>
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
            Back to activity
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Execution log</CardTitle>
          <CardDescription>
            <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
              {basename}
            </code>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {taskId ? (
            <Badge variant="outline">
              task <code className="ml-1 text-[11px]">{taskId}</code>
            </Badge>
          ) : null}
          {executionId ? (
            <Badge variant="outline">
              exec <code className="ml-1 text-[11px]">{executionId}</code>
            </Badge>
          ) : null}
          <span>{lines.length} line{lines.length === 1 ? '' : 's'}</span>
        </CardContent>
      </Card>

      {state.error ? (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            {state.error.message || 'Failed to load execution log.'}
          </CardContent>
        </Card>
      ) : state.loading ? (
        <Card>
          <CardContent className="py-6 text-sm italic text-muted-foreground">
            Loading execution log…
          </CardContent>
        </Card>
      ) : lines.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-6 text-sm italic text-muted-foreground">
            No log lines yet for this execution.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <pre
              className={cn(
                'max-h-[70vh] overflow-auto whitespace-pre-wrap break-words p-4',
                'font-mono text-[11px] leading-relaxed text-foreground',
              )}
            >
              {lines.map((line, idx) => (
                <LogLine key={idx} index={idx} line={line} />
              ))}
            </pre>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

export default AgentExecutionLogPage;

function LogLine({ index, line }) {
  const pretty = safePretty(line);
  return (
    <div className="flex gap-3">
      <span
        aria-hidden="true"
        className="shrink-0 select-none text-right text-muted-foreground tabular-nums"
        style={{ width: '3ch' }}
      >
        {index + 1}
      </span>
      <code className="flex-1 text-foreground">{pretty}</code>
    </div>
  );
}

function safePretty(line) {
  if (typeof line !== 'string') return JSON.stringify(line, null, 2);
  try {
    return JSON.stringify(JSON.parse(line), null, 2);
  } catch {
    return line;
  }
}

function splitBasename(basename) {
  if (typeof basename !== 'string') return ['', ''];
  const cutIdx = basename.indexOf('_');
  if (cutIdx <= 0 || cutIdx === basename.length - 1) return [basename, ''];
  return [basename.slice(0, cutIdx), basename.slice(cutIdx + 1)];
}
