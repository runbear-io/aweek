/**
 * Artifact write operations for the SPA dashboard's HTTP layer.
 *
 * The read-only data layer at `src/serve/data/*` is contractually forbidden
 * from invoking any filesystem write API (see `src/serve/data/data.test.ts`
 * — the static-check tests scan every module in that directory for `unlink`,
 * `rm`, `writeFile`, etc.). The dashboard nevertheless needs a small set of
 * mutations: deleting an artifact removes both the manifest entry kept by
 * `ArtifactStore` and the underlying deliverable file on disk.
 *
 * This module is the carve-out. It lives next to `server.ts` rather than
 * under `data/` so the read-only invariant tests stay green while still
 * letting the HTTP layer perform manual deletes from the SPA's Artifacts
 * tab.
 *
 * Security:
 *   - The artifact's `filePath` is validated to live inside the project
 *     root before any unlink is attempted. This prevents a hostile or
 *     drifted manifest entry from coaxing the server into deleting
 *     arbitrary files outside the project tree (path traversal).
 *   - Path resolution uses `node:path.resolve` + a `startsWith` boundary
 *     check that guards against the `dist-sibling`/`dist` prefix-match
 *     pitfall by appending the platform separator before comparing.
 *
 * Behaviour:
 *   - The unlink is best-effort: a missing file (`ENOENT`) is treated as
 *     "already gone" so the manifest entry is still removed and the API
 *     stays idempotent. Any other filesystem error propagates so the
 *     operator notices.
 *   - Manifest removal is performed via the existing
 *     `ArtifactStore.remove()` method — no parallel persistence is
 *     introduced, satisfying the existing-code-reuse principle.
 */

import { unlink } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

import {
  ArtifactStore,
  type ArtifactRecord,
} from '../storage/artifact-store.js';

/** Inputs for {@link removeAgentArtifact}. */
export interface RemoveAgentArtifactOpts {
  /** Project root containing `.aweek/`. */
  projectDir: string;
  /** Agent slug — same as the `.claude/agents/<slug>.md` filename. */
  slug: string;
  /** Artifact identifier from the manifest (`artifact-<hex>`). */
  artifactId: string;
}

/** Possible outcomes of {@link removeAgentArtifact}. */
export type RemoveAgentArtifactResult =
  | {
      ok: true;
      /** The record that was removed. Preserved so the HTTP layer can echo
       *  the artifact's identity back to the caller. */
      artifact: ArtifactRecord;
      /** True when an actual file was unlinked. False when the file was
       *  already gone (manifest entry pointed at a missing file). */
      fileUnlinked: boolean;
    }
  | { ok: false; reason: 'not-found' | 'invalid-path' };

/**
 * Validate that `absPath` lives strictly inside `projectRoot`.
 *
 * Both inputs are normalized via `resolve()` first so symbolic `..` segments
 * collapse before the comparison runs. The boundary check appends the
 * platform separator after `projectRoot` so a sibling like
 * `<root>-evil` cannot pass by sharing a string prefix with `<root>`.
 */
export function isPathInsideRoot(absPath: string, projectRoot: string): boolean {
  if (!absPath || !projectRoot) return false;
  const normalizedRoot = resolve(projectRoot);
  const normalizedPath = resolve(absPath);
  // The artifact path must point to *something inside* the project — the
  // root itself is never a deliverable.
  if (normalizedPath === normalizedRoot) return false;
  return normalizedPath.startsWith(normalizedRoot + sep);
}

/**
 * Remove an artifact from disk + manifest.
 *
 * Steps:
 *   1. Load the manifest for `slug`. If no record matches `artifactId`,
 *      return `{ ok: false, reason: 'not-found' }` so the HTTP layer can
 *      respond 404 without bothering the filesystem.
 *   2. Resolve `record.filePath` against `projectDir` and verify the
 *      resulting absolute path stays inside the project root. If the
 *      record points outside (path traversal, drifted manifest), return
 *      `{ ok: false, reason: 'invalid-path' }`.
 *   3. Unlink the file. `ENOENT` is absorbed (treated as `fileUnlinked:
 *      false`) so deletes stay idempotent across retries / partial
 *      cleanups. Any other error propagates.
 *   4. Remove the manifest entry via `ArtifactStore.remove()`.
 */
export async function removeAgentArtifact(
  { projectDir, slug, artifactId }: RemoveAgentArtifactOpts,
): Promise<RemoveAgentArtifactResult> {
  if (!projectDir) throw new TypeError('projectDir is required');
  if (!slug) throw new TypeError('slug is required');
  if (!artifactId) throw new TypeError('artifactId is required');

  const dataDir = resolve(projectDir, '.aweek', 'agents');
  const store = new ArtifactStore(dataDir, projectDir);

  const records = await store.load(slug);
  const target = records.find((r) => r.id === artifactId);
  if (!target) return { ok: false, reason: 'not-found' };

  // Reject absolute filePath entries — manifests are supposed to keep
  // paths relative to projectRoot. An absolute entry is either drift or
  // an attempt to point at /etc/passwd; either way, refuse to act.
  if (isAbsolute(target.filePath)) {
    return { ok: false, reason: 'invalid-path' };
  }

  const absoluteFile = resolve(projectDir, target.filePath);
  if (!isPathInsideRoot(absoluteFile, projectDir)) {
    return { ok: false, reason: 'invalid-path' };
  }

  // Unlink the artifact file from disk.
  let fileUnlinked = false;
  try {
    await unlink(absoluteFile);
    fileUnlinked = true;
  } catch (err) {
    if (!(isErrnoException(err) && err.code === 'ENOENT')) throw err;
    // ENOENT → file already gone; manifest cleanup still proceeds.
  }

  // Remove the manifest entry. The store's `remove` is idempotent — a
  // false return value here would mean the entry vanished between our
  // load() and remove(), which is harmless for our caller.
  await store.remove(slug, artifactId);

  return { ok: true, artifact: target, fileUnlinked };
}

/** Narrow `unknown` to a Node `ErrnoException` so we can read `code`. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
