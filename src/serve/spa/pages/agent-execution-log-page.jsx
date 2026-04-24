/**
 * `AgentExecutionLogPage` — progressive-disclosure view of a single
 * execution log. Routes on `/agents/:slug/activity/:basename`.
 *
 * Fetches `/api/agents/:slug/executions/:basename` (NDJSON lines) and
 * renders:
 *   - Headline: status Badge + metrics (duration, tokens, cost, model)
 *   - Meta: session, cwd, tools, terminal reason
 *   - Final output (when present)
 *   - Permission denials (when any)
 *   - Timeline: one row per meaningful turn, collapsed by default
 *   - Raw events: every event, collapsed by default
 *
 * Port of the pre-SPA `src/serve/execution-log-summary.js` HTML page,
 * rewritten in stock shadcn primitives + native `<details>` for
 * progressive disclosure.
 *
 * @module serve/spa/pages/agent-execution-log-page
 */

import React, { useEffect, useMemo, useState } from 'react';
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
import {
  buildExecutionLogSummary,
  formatDuration,
  formatInt,
  parseExecutionLog,
  statusLabel,
  summarizeToolInput,
  safeStringify,
} from '../lib/execution-log-summary.js';

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

  const summary = useMemo(() => {
    const lines = state.data?.lines;
    if (!Array.isArray(lines) || lines.length === 0) return null;
    return buildExecutionLogSummary(parseExecutionLog(lines));
  }, [state.data]);

  const [taskId, executionId] = splitBasename(basename);

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
        <a
          className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
          href={`${baseUrl || ''}/api/agents/${encodeURIComponent(slug)}/executions/${encodeURIComponent(basename)}`}
        >
          raw JSONL →
        </a>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span>Execution log</span>
            <code className="text-[11px] font-normal text-muted-foreground">
              {basename}
            </code>
          </CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-2">
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
          </CardDescription>
        </CardHeader>
        {summary ? <HeadlineStrip headline={summary.headline} /> : null}
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
      ) : !summary ? (
        <Card className="border-dashed">
          <CardContent className="py-6 text-sm italic text-muted-foreground">
            No log lines found for this execution. The{' '}
            <code className="not-italic text-foreground">.jsonl</code> file may
            have been pruned or never written.
          </CardContent>
        </Card>
      ) : (
        <>
          {summary.headline ? <MetaExtra headline={summary.headline} /> : null}
          {summary.finalResult ? (
            <FinalOutput text={summary.finalResult} />
          ) : null}
          {summary.permissionDenials.length > 0 ? (
            <PermissionDenials denials={summary.permissionDenials} />
          ) : null}
          <Timeline items={summary.timeline} />
          <RawSection
            rawEvents={summary.rawEvents}
            filteredCount={summary.filteredCount}
          />
        </>
      )}
    </section>
  );
}

export default AgentExecutionLogPage;

// ── Subcomponents ──────────────────────────────────────────────────────

function HeadlineStrip({ headline }) {
  const h = headline;
  const tone =
    h.status === 'completed'
      ? 'default'
      : h.status === 'error'
        ? 'destructive'
        : 'outline';
  const metrics = [
    h.durationMs != null ? formatDuration(h.durationMs) : null,
    h.inputTokens != null ? `${formatInt(h.inputTokens)} in` : null,
    h.outputTokens != null ? `${formatInt(h.outputTokens)} out` : null,
    h.cacheReadTokens != null && h.cacheReadTokens > 0
      ? `${formatInt(h.cacheReadTokens)} cache`
      : null,
    h.costUsd != null ? `$${h.costUsd.toFixed(4)}` : null,
    h.model || null,
  ].filter(Boolean);
  return (
    <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <Badge variant={tone} className="text-[10px] uppercase tracking-widest">
        {statusLabel(h.status, h.subtype)}
      </Badge>
      {metrics.map((m) => (
        <span key={m} className="tabular-nums">
          {m}
        </span>
      ))}
    </CardContent>
  );
}

function MetaExtra({ headline }) {
  const h = headline;
  const parts = [];
  if (h.sessionId) parts.push(['session', h.sessionId]);
  if (h.cwd) parts.push(['cwd', h.cwd]);
  if (h.toolsAvailable != null)
    parts.push(['tools', `${h.toolsAvailable} available`]);
  if (h.terminalReason) parts.push(['terminal', h.terminalReason]);
  if (parts.length === 0) return null;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1 py-4 text-xs text-muted-foreground">
        {parts.map(([label, value]) => (
          <span key={label}>
            {label}:{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
              {value}
            </code>
          </span>
        ))}
      </CardContent>
    </Card>
  );
}

function FinalOutput({ text }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Final output</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <pre
          className={cn(
            'max-h-[400px] overflow-auto whitespace-pre-wrap break-words',
            'rounded-b-lg bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground',
          )}
        >
          {text}
        </pre>
      </CardContent>
    </Card>
  );
}

function PermissionDenials({ denials }) {
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm text-destructive">
          ⚠ Permission denials
          <Badge variant="destructive">{denials.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {denials.map((d, idx) => {
          const tool = d?.tool_name || '?';
          const input = summarizeToolInput(tool, d?.tool_input || {});
          const full = safeStringify(d?.tool_input || {});
          return (
            <details
              key={idx}
              className="rounded-md border bg-muted/40 px-3 py-2 text-xs"
            >
              <summary className="cursor-pointer list-none">
                <strong className="text-foreground">{tool}</strong>{' '}
                <code className="text-[11px] text-muted-foreground">
                  {input}
                </code>
              </summary>
              <pre className="mt-2 max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[11px] text-foreground">
                {full}
              </pre>
            </details>
          );
        })}
      </CardContent>
    </Card>
  );
}

function Timeline({ items }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          Timeline
          <span className="text-xs font-normal text-muted-foreground">
            {items.length} event{items.length === 1 ? '' : 's'}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <p className="px-6 pb-6 text-sm italic text-muted-foreground">
            No events.
          </p>
        ) : (
          <ol role="list" className="flex flex-col divide-y">
            {items.map((item, idx) => (
              <TimelineRow key={idx} number={idx + 1} item={item} />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

const KIND_BORDER = {
  thinking: 'border-l-muted-foreground/40',
  text: 'border-l-primary',
  tool_use: 'border-l-amber-500',
  tool_result: 'border-l-emerald-500',
  user_text: 'border-l-muted-foreground/40',
  rate_limit: 'border-l-muted-foreground/40',
  other: 'border-l-muted-foreground/40',
};

function TimelineRow({ number, item }) {
  const border = KIND_BORDER[item.kind] || KIND_BORDER.other;
  return (
    <li
      className={cn('border-l-2 px-4 py-2', border)}
      data-timeline-kind={item.kind}
    >
      <details>
        <summary className="flex cursor-pointer list-none items-baseline gap-2">
          <span aria-hidden="true" className="inline-block w-5 font-mono text-sm">
            {item.icon || '•'}
          </span>
          <span className="min-w-[2rem] text-xs text-muted-foreground tabular-nums">
            {number}.
          </span>
          <span className="text-sm font-medium text-foreground">
            {item.label}
          </span>
          {item.meta ? (
            <span className="ml-1 min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
              {item.meta}
            </span>
          ) : null}
        </summary>
        {item.detail ? (
          <pre className="mt-2 max-h-[500px] overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
            {item.detail}
          </pre>
        ) : null}
      </details>
    </li>
  );
}

function RawSection({ rawEvents, filteredCount }) {
  const pretty = useMemo(
    () =>
      rawEvents
        .map((ev) => {
          try {
            return JSON.stringify(JSON.parse(ev.raw), null, 2);
          } catch {
            return ev.raw;
          }
        })
        .join('\n\n'),
    [rawEvents],
  );
  return (
    <Card>
      <CardContent className="p-0">
        <details>
          <summary className="cursor-pointer list-none px-6 py-4 text-sm">
            Full raw execution log{' '}
            <span className="text-xs text-muted-foreground">
              ({rawEvents.length} events, {filteredCount} filtered from timeline)
            </span>
          </summary>
          <pre className="max-h-[600px] overflow-auto whitespace-pre-wrap break-words border-t bg-muted/40 p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {pretty}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}

function splitBasename(basename) {
  if (typeof basename !== 'string') return ['', ''];
  const cutIdx = basename.indexOf('_');
  if (cutIdx <= 0 || cutIdx === basename.length - 1) return [basename, ''];
  return [basename.slice(0, cutIdx), basename.slice(cutIdx + 1)];
}
