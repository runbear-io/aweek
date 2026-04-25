/**
 * `useAgentLogs` — React hook wrapping `fetchAgentLogs`.
 *
 * Backs the Activity tab: merges activity-log entries and execution-log
 * audit rows, filtered by a `dateRange` preset.
 *
 * The hook re-fetches automatically when `slug` OR `dateRange` change,
 * so a `<Select>` wired to `setDateRange` triggers a fresh server roll-up
 * without the component having to manually call `refresh()`.
 *
 * Empty / null slugs short-circuit to idle state.
 *
 * TypeScript migration note (AC 304 sub-AC 4.4):
 *   This module is part of the SPA hooks converted from `.js` → `.ts`.
 *   The dependencies (`../lib/api-client.js`, `./use-api-resource.js`)
 *   remain `.js` in this phase but expose first-class TypeScript types
 *   via JSDoc `@typedef` declarations. With `allowJs: true` + Bundler
 *   resolution, `import { type AgentLogs } from '../lib/api-client.js'`
 *   reads those typedefs as if they were native TS exports — no `.d.ts`
 *   shim required. The `.js` extension on import specifiers also
 *   resolves to `.ts` files transparently under
 *   `moduleResolution: "Bundler"`, so existing callers continue to work
 *   without churn.
 *
 *   The api-client's `AgentLogs` typedef declares `entries` / `executions`
 *   as `Array<object>` (loose, by design — the server payload absorbs
 *   forward-compatible fields without locking the schema). This hook
 *   layers on top a typed `AgentLogs` envelope (`AgentLogsTyped`) plus
 *   permissive `ActivityLogEntry` / `ExecutionRecord` shapes describing
 *   the fields the dashboard actually reads. The shapes mirror
 *   `createLogEntry` in `src/storage/activity-log-store.js` and
 *   `createExecutionRecord` in `src/storage/execution-store.js` so
 *   consumers (the Activity tab, the timeline component, future
 *   filters) can index into entries without per-callsite casts.
 *
 * @module serve/spa/hooks/use-agent-logs
 */

import { useCallback } from 'react';

import {
  fetchAgentLogs,
  type AgentLogs,
  type DateRangePreset,
} from '../lib/api-client.js';

import { useApiResource, type UseApiResourceResult } from './use-api-resource.js';

// ── Log entry types ──────────────────────────────────────────────────

/**
 * Permissive activity-log entry shape (matches `createLogEntry` in
 * `src/storage/activity-log-store.js` and the rows surfaced by
 * `src/serve/data/logs.js`).
 *
 * Only fields the dashboard reads are typed — the index signature lets
 * extra server-emitted fields flow through to consumers (e.g.
 * `executionLogPath`, future audit tags) without per-call casts. The
 * sibling `<ActivityTimeline>` component declares a near-identical shape
 * for its own rendering surface; both stay loose intentionally because
 * the backend stores remain raw `.js` in this migration phase.
 */
export interface ActivityLogEntry {
  id?: string;
  timestamp?: string | null;
  at?: string | null;
  createdAt?: string | null;
  agentId?: string;
  status?: string;
  kind?: string;
  type?: string;
  title?: string;
  message?: string;
  summary?: string;
  text?: string;
  taskId?: string | null;
  duration?: number;
  metadata?: {
    execution?: {
      executionLogPath?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Permissive execution-record shape (matches `createExecutionRecord` in
 * `src/storage/execution-store.js`). As with `ActivityLogEntry`, only
 * fields the dashboard reads are typed — the rest pass through.
 */
export interface ExecutionRecord {
  id?: string;
  idempotencyKey?: string;
  agentId?: string;
  timestamp?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  endedAt?: string | null;
  at?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  status?: string;
  exitCode?: number;
  taskId?: string | null;
  duration?: number;
  totalTokens?: number;
  tokensUsed?: number;
  costUsd?: number;
  error?: string;
  metadata?: {
    totalTokens?: number;
    tokensUsed?: number;
    costUsd?: number;
    error?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Strongly-typed `AgentLogs` envelope. The api-client's typedef declares
 * `entries` / `executions` as `Array<object>`; this interface narrows
 * those to the permissive `ActivityLogEntry` / `ExecutionRecord` shapes
 * defined above, while preserving the `slug` / `dateRange` fields the
 * server echoes back so consumers can confirm which preset the payload
 * corresponds to.
 *
 * Re-exported (`export type { AgentLogs }`) from `api-client.js` for
 * callers that prefer the loose envelope or need to construct fixtures
 * matching the wire shape verbatim.
 */
export interface AgentLogsTyped {
  slug: string;
  dateRange: DateRangePreset;
  entries: ActivityLogEntry[];
  executions: ExecutionRecord[];
}

export type { AgentLogs, DateRangePreset };

// ── Hook ─────────────────────────────────────────────────────────────

/**
 * Options accepted by `useAgentLogs`.
 *
 * - `dateRange` selects the server-side roll-up window (`'all'`,
 *   `'this-week'`, `'last-7-days'`). Omit to let the server default.
 * - `baseUrl` overrides the default same-origin base for tests or
 *   cross-origin dev setups.
 * - `fetch` injects a custom fetch implementation (Storybook / tests).
 */
export interface UseAgentLogsOptions {
  dateRange?: DateRangePreset;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * React hook backing the Activity tab on the per-agent detail page.
 *
 * Returns the standard `useApiResource` envelope (`{ data, error,
 * loading, refresh }`) where `data` is the typed `AgentLogsTyped`
 * payload (activity entries + execution records, already sorted
 * newest-first server-side), or `null` while idle (no slug yet) or
 * before the first successful load.
 *
 * Pass a falsy `slug` (null / undefined / empty string) to keep the hook
 * idle — this is the canonical pattern for mounting the hook before the
 * router has resolved a slug.
 */
export function useAgentLogs(
  slug: string | null | undefined,
  options: UseAgentLogsOptions = {},
): UseApiResourceResult<AgentLogsTyped | null> {
  const { dateRange, baseUrl, fetch: fetchImpl } = options;
  const enabled = typeof slug === 'string' && slug.length > 0;

  const loader = useCallback(
    (opts: { signal: AbortSignal }): Promise<AgentLogsTyped | null> => {
      if (!enabled || !slug) return Promise.resolve(null);
      // The api-client's `AgentLogs` typedef intentionally declares
      // `entries` / `executions` as `Array<object>` so the loose JSON
      // contract isn't locked at the network boundary. We narrow the
      // shape here to the typed envelope consumers expect — the cast is
      // safe because the server-side schema (validated in
      // `src/serve/data/logs.js`) populates exactly these fields.
      return fetchAgentLogs(slug, {
        ...opts,
        dateRange,
        baseUrl,
        fetch: fetchImpl,
      }).then((logs) => logs as unknown as AgentLogsTyped);
    },
    [slug, enabled, dateRange, baseUrl, fetchImpl],
  );

  return useApiResource<AgentLogsTyped | null>(loader, [
    slug,
    enabled,
    dateRange,
    baseUrl,
    fetchImpl,
  ]);
}
