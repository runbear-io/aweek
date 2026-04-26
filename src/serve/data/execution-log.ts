/**
 * Execution log data source for the SPA dashboard.
 *
 * Read-only streaming gatherer for per-execution NDJSON logs. Wraps the
 * existing `readExecutionLogLines` async iterator from
 * `src/storage/execution-log-store.js` — no writes, no new persistence.
 *
 * The SPA hits this endpoint when the user drills into an activity-log
 * entry's "view execution log" link; the server is expected to surface
 * the raw NDJSON (or a plain-text rendering thereof) back to the
 * browser. This module is responsible only for path-splitting and
 * delegating to the store; it does not buffer or transform the stream.
 */

import { join } from 'node:path';
import { readExecutionLogLines } from '../../storage/execution-log-store.js';

/**
 * Validate that a path segment is safe to use as part of the on-disk
 * lookup (no separators, no traversal). Exported so the HTTP layer can
 * reuse the same gate before calling into the iterator.
 */
export function isSafePathSegment(segment: unknown): segment is string {
  return (
    typeof segment === 'string' &&
    segment.length > 0 &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('..')
  );
}

/** Output of {@link parseExecutionBasename}. */
export interface ParsedExecutionBasename {
  taskId: string;
  executionId: string;
}

/**
 * Split a `<taskId>_<executionId>` basename. The heartbeat writes
 * execution logs to `<taskId>_<executionId>.jsonl`; taskId's schema
 * bans underscores, so the first `_` is an unambiguous split point.
 */
export function parseExecutionBasename(
  basename: unknown,
): ParsedExecutionBasename | null {
  if (!isSafePathSegment(basename)) return null;
  const cutIdx = basename.indexOf('_');
  if (cutIdx <= 0 || cutIdx === basename.length - 1) return null;
  return {
    taskId: basename.slice(0, cutIdx),
    executionId: basename.slice(cutIdx + 1),
  };
}

/** Options accepted by {@link streamExecutionLogLines}. */
export interface StreamExecutionLogLinesOptions {
  projectDir?: string;
  slug?: string;
  /** `<taskId>_<executionId>` (no `.jsonl`). */
  basename?: string;
}

/**
 * Async iterator over the raw NDJSON lines of a single execution's
 * log file. Yields nothing when the file is missing (the underlying
 * `readExecutionLogLines` treats ENOENT as an empty stream), which the
 * HTTP layer can map to 404.
 */
export async function* streamExecutionLogLines(
  { projectDir, slug, basename }: StreamExecutionLogLinesOptions = {},
): AsyncGenerator<string> {
  if (!projectDir) throw new Error('streamExecutionLogLines: projectDir is required');
  if (!isSafePathSegment(slug)) return;
  const parsed = parseExecutionBasename(basename);
  if (!parsed) return;
  const agentsDir = join(projectDir, '.aweek', 'agents');
  for await (const line of readExecutionLogLines(
    agentsDir,
    slug,
    parsed.taskId,
    parsed.executionId,
  )) {
    yield line;
  }
}
