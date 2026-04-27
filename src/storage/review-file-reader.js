/**
 * Thin file-system reader for per-agent review files.
 *
 * The weekly-review orchestrator (`src/services/weekly-review-orchestrator.ts`)
 * writes two files per review period under `.aweek/agents/<slug>/reviews/`:
 *
 *   <stem>.md   — freeform markdown body.
 *   <stem>.json — structured metadata sidecar (agentId, generatedAt, …).
 *
 * This module owns the `node:fs` boundary for those files so the data-layer
 * gatherer (`src/serve/data/reviews.ts`) can source from `src/storage/*`
 * without importing `node:fs` directly — matching the storage-owns-fs
 * convention used throughout this codebase.
 *
 * All reads are fire-and-absorb: errors are swallowed and surfaced as empty
 * strings / null values rather than thrown so a single corrupt file never
 * blanks the caller's result set.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';

/**
 * List the unique stem names (basenames without extension) for all `.md`
 * review files under `reviewsDir`. Returns an empty array when the
 * directory does not exist or cannot be read.
 *
 * @param {string} reviewsDir  Absolute path to `.aweek/agents/<slug>/reviews/`.
 * @returns {Promise<string[]>}
 */
export async function listReviewStems(reviewsDir) {
  let entries;
  try {
    entries = await readdir(reviewsDir);
  } catch {
    return [];
  }
  const stems = Array.from(
    new Set(
      entries
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3)),
    ),
  );
  return stems;
}

/**
 * Read the watchlist and per-strategy documents for an agent.
 *
 * - Watchlist: `.aweek/agents/<slug>/watchlist.md` (optional).
 * - Strategies: `.aweek/agents/<slug>/strategies/*.md` (optional dir).
 *
 * Missing files / directories are treated as empty (absorbed, not thrown).
 *
 * @param {string} agentDir  Absolute path to `.aweek/agents/<slug>/`.
 * @returns {Promise<{
 *   watchlist: { hasWatchlist: boolean, markdown: string },
 *   strategies: Array<{ name: string, markdown: string }>
 * }>}
 */
export async function readWatchlistAndStrategies(agentDir) {
  const [watchlistResult, strategiesResult] = await Promise.all([
    readFile(join(agentDir, 'watchlist.md'), 'utf-8')
      .then((md) => ({ hasWatchlist: true, markdown: md }))
      .catch(() => ({ hasWatchlist: false, markdown: '' })),
    (async () => {
      const strategiesDir = join(agentDir, 'strategies');
      let entries;
      try {
        entries = await readdir(strategiesDir);
      } catch {
        return [];
      }
      const mdFiles = entries.filter((f) => f.endsWith('.md'));
      const loaded = await Promise.all(
        mdFiles.map(async (f) => {
          const name = basename(f, extname(f));
          const markdown = await readFile(join(strategiesDir, f), 'utf-8').catch(() => '');
          return { name, markdown };
        }),
      );
      return loaded;
    })(),
  ]);
  return { watchlist: watchlistResult, strategies: strategiesResult };
}

/**
 * Read the `.md` and `.json` sidecar for a single review stem.
 *
 * Per-file errors are absorbed: a missing markdown file returns `''`;
 * a missing or unparseable JSON sidecar returns `null`.
 *
 * @param {string} reviewsDir  Absolute path to `.aweek/agents/<slug>/reviews/`.
 * @param {string} stem        Basename without extension (e.g. `"2026-W17"`).
 * @returns {Promise<{ markdown: string, metadata: Record<string,unknown>|null }>}
 */
export async function readReviewFiles(reviewsDir, stem) {
  const [markdown, metadata] = await Promise.all([
    readFile(join(reviewsDir, `${stem}.md`), 'utf-8').catch(() => ''),
    readFile(join(reviewsDir, `${stem}.json`), 'utf-8')
      .then((raw) => {
        try {
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
        } catch {
          return null;
        }
      })
      .catch(() => null),
  ]);
  return { markdown, metadata };
}
