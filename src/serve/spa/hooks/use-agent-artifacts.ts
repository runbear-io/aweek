/**
 * `useAgentArtifacts` — React hook wrapping `fetchAgentArtifacts`.
 *
 * Backs the Artifacts tab: fetches the merged artifact list for an
 * agent across all task executions and groups records by their ISO
 * week key (`YYYY-Www`) so the tab can render a per-week section
 * layout without the component having to re-derive the bucketing.
 *
 * Grouping rules:
 *   1. If a record carries a `week` field (server-supplied from the
 *      registration site), use that as its bucket.
 *   2. Else, derive the ISO week from `createdAt` client-side via
 *      `mondayToIsoWeek` so older records that pre-date the `week`
 *      field still slot into the right section.
 *   3. Records that are missing both `week` and a parseable
 *      `createdAt` are bucketed under the `'unknown'` sentinel so the
 *      tab can still surface them rather than silently dropping them.
 *
 * The hook returns the loose `AgentArtifacts` payload alongside a
 * derived `groups: ArtifactWeekGroup[]` collection. The groups are
 * sorted newest-first by week key (`'unknown'` always sorts last) so
 * the most-recent deliverables show up at the top of the tab.
 *
 * Empty / null slugs short-circuit to idle state — same pattern as
 * `useAgentLogs`, `useAgentReviews`, etc.
 *
 * @module serve/spa/hooks/use-agent-artifacts
 */

import { useCallback, useMemo } from 'react';

import {
  fetchAgentArtifacts,
  type AgentArtifacts,
  type ArtifactRecord,
  type ArtifactSummary,
} from '../lib/api-client.js';
import { mondayToIsoWeek } from '../lib/iso-week.js';

import { useApiResource, type UseApiResourceResult } from './use-api-resource.js';

export type { AgentArtifacts, ArtifactRecord, ArtifactSummary };

/** Sentinel bucket key for records with no usable week. */
export const ARTIFACT_UNKNOWN_WEEK = 'unknown';

/**
 * A single week-bucket of artifacts. `week` is either a canonical ISO
 * week key (`YYYY-Www`) or the literal string `'unknown'` for records
 * that have neither a `week` nor a parseable `createdAt`.
 */
export interface ArtifactWeekGroup {
  /** ISO week key (`YYYY-Www`) or the `'unknown'` sentinel. */
  week: string;
  /** Records assigned to this bucket, preserving server order (newest-first). */
  artifacts: ArtifactRecord[];
}

/**
 * Hook return shape. Spreads the standard `useApiResource` envelope and
 * appends the derived `groups` array so the tab component can render
 * the bucketed view without re-deriving the bucketing on every render.
 *
 * `groups` is always an array — empty when the agent has no artifacts
 * yet, or while the hook is still loading the first payload.
 */
export interface UseAgentArtifactsResult
  extends UseApiResourceResult<AgentArtifacts | null> {
  groups: ArtifactWeekGroup[];
}

/**
 * Options accepted by `useAgentArtifacts`.
 *
 * - `baseUrl` overrides the default same-origin base for tests or
 *   cross-origin dev setups.
 * - `fetch` injects a custom fetch implementation (Storybook / tests).
 */
export interface UseAgentArtifactsOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Resolve the bucket key (`YYYY-Www` or the `'unknown'` sentinel) for
 * a single artifact record. Exported for tests and for sibling
 * components that need to reproduce the same bucket assignment.
 */
export function resolveArtifactWeekKey(record: ArtifactRecord): string {
  if (typeof record.week === 'string' && record.week.length > 0) {
    return record.week;
  }
  if (typeof record.createdAt === 'string' && record.createdAt.length > 0) {
    const ts = Date.parse(record.createdAt);
    if (Number.isFinite(ts)) {
      try {
        return mondayToIsoWeek(new Date(ts));
      } catch {
        return ARTIFACT_UNKNOWN_WEEK;
      }
    }
  }
  return ARTIFACT_UNKNOWN_WEEK;
}

/**
 * Group an artifact list by week key, preserving the server's
 * newest-first ordering inside each bucket and sorting the buckets
 * themselves newest-first.
 *
 * Exported so the tab can opt into deriving groups from a custom
 * artifact list (e.g. after an optimistic delete) without re-running
 * the full hook.
 */
export function groupArtifactsByWeek(
  artifacts: ReadonlyArray<ArtifactRecord>,
): ArtifactWeekGroup[] {
  const buckets = new Map<string, ArtifactRecord[]>();
  for (const record of artifacts) {
    const week = resolveArtifactWeekKey(record);
    let list = buckets.get(week);
    if (!list) {
      list = [];
      buckets.set(week, list);
    }
    list.push(record);
  }
  const groups: ArtifactWeekGroup[] = [];
  for (const [week, list] of buckets) {
    groups.push({ week, artifacts: list });
  }
  // Newest-first — the `'unknown'` sentinel always sinks to the end so
  // dated buckets surface above un-bucketable records.
  groups.sort((a, b) => {
    if (a.week === ARTIFACT_UNKNOWN_WEEK && b.week === ARTIFACT_UNKNOWN_WEEK) {
      return 0;
    }
    if (a.week === ARTIFACT_UNKNOWN_WEEK) return 1;
    if (b.week === ARTIFACT_UNKNOWN_WEEK) return -1;
    // ISO week keys (`YYYY-Www`) sort lexicographically in chronological
    // order, so a descending lex compare gives newest-first.
    if (a.week < b.week) return 1;
    if (a.week > b.week) return -1;
    return 0;
  });
  return groups;
}

/**
 * React hook backing the Artifacts tab on the per-agent detail page.
 *
 * Returns the standard `useApiResource` envelope (`{ data, error,
 * loading, refresh }`) where `data` is the typed `AgentArtifacts`
 * payload (sorted artifact list + summary block), or `null` while
 * idle / before first load. The `groups` field is the artifact list
 * grouped by ISO week key — newest-first, with the `'unknown'`
 * sentinel last.
 *
 * Pass a falsy `slug` (null / undefined / empty string) to keep the
 * hook idle. This is the canonical pattern for mounting the hook
 * before the router has resolved a slug.
 */
export function useAgentArtifacts(
  slug: string | null | undefined,
  options: UseAgentArtifactsOptions = {},
): UseAgentArtifactsResult {
  const { baseUrl, fetch: fetchImpl } = options;
  const enabled = typeof slug === 'string' && slug.length > 0;

  const loader = useCallback(
    (opts: { signal: AbortSignal }): Promise<AgentArtifacts | null> => {
      if (!enabled || !slug) return Promise.resolve(null);
      return fetchAgentArtifacts(slug, { ...opts, baseUrl, fetch: fetchImpl });
    },
    [slug, enabled, baseUrl, fetchImpl],
  );

  const resource = useApiResource<AgentArtifacts | null>(loader, [
    slug,
    enabled,
    baseUrl,
    fetchImpl,
  ]);

  const groups = useMemo(
    () => (resource.data ? groupArtifactsByWeek(resource.data.artifacts) : []),
    [resource.data],
  );

  return { ...resource, groups };
}
