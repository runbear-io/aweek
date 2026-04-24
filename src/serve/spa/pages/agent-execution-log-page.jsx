/**
 * `AgentExecutionLogPage` — full-page view for
 * `/agents/:slug/activity/:basename`.
 *
 * Fetches the execution log via `useExecutionLog` and renders the
 * shared `ExecutionLogView` in page variant. The same view is reused in
 * the activity-row drawer on the activity page, so both surfaces stay
 * visually identical.
 *
 * @module serve/spa/pages/agent-execution-log-page
 */

import React from 'react';
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
import { ExecutionLogView } from '../components/execution-log-view.jsx';
import { useExecutionLog } from '../hooks/use-execution-log.js';

/**
 * @param {{
 *   slug: string,
 *   basename: string,
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} props
 */
export function AgentExecutionLogPage({ slug, basename, baseUrl, fetch: fetchImpl }) {
  const { loading, error, summary } = useExecutionLog({
    slug,
    basename,
    baseUrl,
    fetch: fetchImpl,
  });
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
      </Card>

      {error ? (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            {error.message || 'Failed to load execution log.'}
          </CardContent>
        </Card>
      ) : loading ? (
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
        <ExecutionLogView summary={summary} variant="page" />
      )}
    </section>
  );
}

export default AgentExecutionLogPage;

function splitBasename(basename) {
  if (typeof basename !== 'string') return ['', ''];
  const cutIdx = basename.indexOf('_');
  if (cutIdx <= 0 || cutIdx === basename.length - 1) return [basename, ''];
  return [basename.slice(0, cutIdx), basename.slice(cutIdx + 1)];
}
