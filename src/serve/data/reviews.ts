/**
 * Reviews data source for the SPA dashboard — `/api/agents/:slug/reviews`.
 *
 * Read-only JSON gatherer that surfaces the weekly-review pipeline's
 * on-disk output. The weekly-review orchestrator writes two sidecar
 * files per review period under `.aweek/agents/<slug>/reviews/`:
 *
 *   <week>.md   — freeform markdown body written by the LLM reviewer.
 *   <week>.json — structured metadata sidecar (agentId, generatedAt,
 *                 summary, tasks, …).
 *
 * This module scans that directory, pairs the two sidecars, and returns a
 * sorted (newest-first) list capped at MAX_REVIEWS so the Reviews tab
 * remains a lightweight browsing surface rather than a bulk data dump.
 *
 * Read-only contract (AC 9):
 *   - No writes.
 *   - No new persistence — reads go through `src/storage/review-file-reader.js`
 *     which owns the `node:fs` boundary (matching the pattern where storage
 *     modules own all fs access).
 *   - Per-file errors are absorbed so a single corrupt or missing sidecar
 *     never blanks the whole list.
 */

import { join } from 'node:path';
import { listAllAgentsPartial } from '../../storage/agent-helpers.js';
import { listReviewStems, readReviewFiles } from '../../storage/review-file-reader.js';

/** Maximum number of reviews returned. ~6 months of weekly reviews. */
const MAX_REVIEWS = 26;

/** Options accepted by {@link gatherAgentReviews}. */
export interface GatherAgentReviewsOptions {
  projectDir?: string;
  slug?: string;
}

/** A single review entry returned in the payload. */
export interface AgentReviewEntry {
  /** Week or date key — the basename without extension, e.g. `"2026-W17"` or `"daily-2026-04-23"`. */
  week: string;
  /** Raw markdown body. Empty string when the `.md` file could not be read. */
  markdown: string;
  /** Parsed JSON metadata sidecar, or `null` when missing/unreadable. */
  metadata: Record<string, unknown> | null;
  /** `generatedAt` pulled from metadata for convenience, or `null`. */
  generatedAt: string | null;
}

/** Reviews payload returned to the SPA. */
export interface AgentReviewsPayload {
  slug: string;
  reviews: AgentReviewEntry[];
}

/**
 * Gather weekly-review entries for a single agent.
 *
 * Returns `null` when the slug is not present on disk (→ 404). When the
 * agent exists but has no reviews directory (or no `.md` files), returns
 * an empty `reviews` array. Per-file read errors are absorbed so a single
 * corrupt file never blanks the list.
 */
export async function gatherAgentReviews(
  { projectDir, slug }: GatherAgentReviewsOptions = {},
): Promise<AgentReviewsPayload | null> {
  if (!projectDir) throw new Error('gatherAgentReviews: projectDir is required');
  if (!slug) throw new Error('gatherAgentReviews: slug is required');

  const agentsDir = join(projectDir, '.aweek', 'agents');
  const { agents: configs } = await listAllAgentsPartial({ dataDir: agentsDir });
  const exists = configs.some((c) => c.id === slug);
  if (!exists) return null;

  const reviewsDir = join(agentsDir, slug, 'reviews');

  // listReviewStems owns the fs.readdir call; returns [] when dir is missing.
  const stems = await listReviewStems(reviewsDir);

  // Sort newest-first — stems are `YYYY-Www`, `daily-YYYY-MM-DD`, or
  // `weekly-YYYY-Www`; lexicographic descending works for all three because
  // the date component is left-padded.
  stems.sort((a, b) => b.localeCompare(a));

  // Cap before loading so we never read more than we need.
  const capped = stems.slice(0, MAX_REVIEWS);

  const reviews = await Promise.all(
    capped.map(async (stem): Promise<AgentReviewEntry> => {
      const { markdown, metadata } = await readReviewFiles(reviewsDir, stem);
      const generatedAt =
        metadata !== null &&
        typeof (metadata as { generatedAt?: unknown }).generatedAt === 'string'
          ? (metadata as { generatedAt: string }).generatedAt
          : null;
      return { week: stem, markdown, metadata, generatedAt };
    }),
  );

  return { slug, reviews };
}
