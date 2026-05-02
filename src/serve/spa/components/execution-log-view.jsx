/**
 * `ExecutionLogView` — progressive-disclosure presentation of a parsed
 * execution-log summary. Used by both the full detail page
 * (`pages/agent-execution-log-page.jsx`) and the activity-row drawer so
 * the two surfaces stay visually identical.
 *
 * Pure presentation — the caller is responsible for fetching the NDJSON
 * lines and parsing them via `lib/execution-log-summary.js`.
 *
 * @module serve/spa/components/execution-log-view
 */

import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Badge } from './ui/badge.jsx';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { cn } from '../lib/cn.js';
import {
  formatDuration,
  formatInt,
  statusLabel,
  summarizeToolInput,
  safeStringify,
} from '../lib/execution-log-summary.js';

/**
 * @param {{
 *   summary: ReturnType<typeof import('../lib/execution-log-summary.js').buildExecutionLogSummary> | null,
 *   variant?: 'page' | 'drawer',
 * }} props
 */
export function ExecutionLogView({ summary, variant = 'page' }) {
  if (!summary) return null;
  const dense = variant === 'drawer';
  return (
    <div className={cn('flex flex-col', dense ? 'gap-3' : 'gap-4')}>
      <Headline headline={summary.headline} />
      <MetaExtra headline={summary.headline} />
      {summary.finalResult ? (
        <FinalOutput text={summary.finalResult} dense={dense} />
      ) : null}
      {summary.permissionDenials.length > 0 ? (
        <PermissionDenials denials={summary.permissionDenials} />
      ) : null}
      <Timeline items={summary.timeline} dense={dense} />
      <RawSection
        rawEvents={summary.rawEvents}
        filteredCount={summary.filteredCount}
        dense={dense}
      />
    </div>
  );
}

export default ExecutionLogView;

// ── Sections ──────────────────────────────────────────────────────────

function Headline({ headline }) {
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <Badge variant={tone} className="text-[10px] uppercase tracking-widest">
        {statusLabel(h.status, h.subtype)}
      </Badge>
      {metrics.map((m) => (
        <span key={m} className="tabular-nums">
          {m}
        </span>
      ))}
    </div>
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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {parts.map(([label, value]) => (
        <span key={label} className="min-w-0 truncate">
          {label}:{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
            {value}
          </code>
        </span>
      ))}
    </div>
  );
}

function FinalOutput({ text, dense }) {
  return (
    <Card>
      <CardHeader className={cn(dense && 'py-3')}>
        <CardTitle className="text-sm">Final output</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div
          className={cn(
            'overflow-auto rounded-b-lg bg-muted/40 p-4',
            dense ? 'max-h-[280px]' : 'max-h-[400px]',
          )}
        >
          <Markdown source={text} />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Render a markdown string with the small set of shadcn-token classes
 * that match the rest of the SPA. Uses GitHub-flavored extensions so
 * agents' tables, task-lists, and autolinks render the way they do in
 * the upstream markdown that generated them.
 *
 * @param {{ source: string }} props
 */
export function Markdown({ source }) {
  return (
    <div className="prose-sm max-w-none space-y-3 text-sm leading-relaxed text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => (
            <h3 className="text-base font-semibold text-foreground" {...props} />
          ),
          h2: (props) => (
            <h4 className="text-sm font-semibold text-foreground" {...props} />
          ),
          h3: (props) => (
            <h5 className="text-sm font-semibold text-foreground" {...props} />
          ),
          p: (props) => <p className="text-sm leading-relaxed" {...props} />,
          ul: (props) => (
            <ul className="list-disc space-y-1 pl-5 text-sm" {...props} />
          ),
          ol: (props) => (
            <ol className="list-decimal space-y-1 pl-5 text-sm" {...props} />
          ),
          li: (props) => <li className="text-sm" {...props} />,
          blockquote: (props) => (
            <blockquote
              className="border-l-2 border-border pl-3 text-muted-foreground"
              {...props}
            />
          ),
          // react-markdown v10 drops the `inline` prop — branch on
          // whether the parent is a <pre> (block) by letting the `pre`
          // component below own block rendering and keeping `code` as
          // the inline-only styling.
          code: ({ className, children, ...props }) => (
            <code
              className={cn(
                'rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground',
                className,
              )}
              {...props}
            >
              {children}
            </code>
          ),
          // Fenced code blocks render inside an explicit `overflow-x-auto`
          // wrapper so long lines (stack traces, JSON blobs) scroll
          // horizontally inside the block instead of forcing the page to
          // scroll at 375px. `max-w-full` keeps the wrapper from outgrowing
          // its parent even when a flex/grid ancestor lacks `min-w-0`.
          pre: ({ children, ...props }) => (
            <div className="max-w-full overflow-x-auto rounded-md border bg-background">
              <pre
                className="p-3 font-mono text-[12px] leading-relaxed text-foreground"
                {...props}
              >
                {children}
              </pre>
            </div>
          ),
          a: (props) => (
            <a
              className="text-primary underline underline-offset-2 hover:no-underline"
              target="_blank"
              rel="noreferrer"
              {...props}
            />
          ),
          table: (props) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs" {...props} />
            </div>
          ),
          thead: (props) => (
            <thead className="border-b bg-muted/60 text-left" {...props} />
          ),
          th: (props) => (
            <th className="px-2 py-1.5 font-semibold text-foreground" {...props} />
          ),
          td: (props) => (
            <td className="border-t px-2 py-1.5 align-top" {...props} />
          ),
          hr: () => <hr className="my-3 border-border" />,
        }}
      >
        {typeof source === 'string' ? source : String(source ?? '')}
      </ReactMarkdown>
    </div>
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
                <code className="text-[11px] text-muted-foreground">{input}</code>
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

const KIND_BORDER = {
  thinking: 'border-l-muted-foreground/40',
  text: 'border-l-primary',
  tool_use: 'border-l-amber-500',
  tool_result: 'border-l-emerald-500',
  user_text: 'border-l-muted-foreground/40',
  rate_limit: 'border-l-muted-foreground/40',
  other: 'border-l-muted-foreground/40',
};

function Timeline({ items, dense }) {
  return (
    <Card>
      <CardHeader className={cn(dense && 'py-3')}>
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
              <TimelineRow
                key={idx}
                number={idx + 1}
                item={item}
                dense={dense}
              />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function TimelineRow({ number, item, dense }) {
  const border = KIND_BORDER[item.kind] || KIND_BORDER.other;
  return (
    <li
      className={cn('border-l-2 px-4', dense ? 'py-1.5' : 'py-2', border)}
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
          <pre
            className={cn(
              'mt-2 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground',
              dense ? 'max-h-[320px]' : 'max-h-[500px]',
            )}
          >
            {item.detail}
          </pre>
        ) : null}
      </details>
    </li>
  );
}

function RawSection({ rawEvents, filteredCount, dense }) {
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
          <pre
            className={cn(
              'overflow-auto whitespace-pre-wrap break-words border-t bg-muted/40 p-4 font-mono text-[11px] leading-relaxed text-muted-foreground',
              dense ? 'max-h-[360px]' : 'max-h-[600px]',
            )}
          >
            {pretty}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}
