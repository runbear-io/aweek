/**
 * Artifacts data source for the SPA dashboard — `/api/agents/:slug/artifacts`.
 *
 * Read-only JSON gatherer that returns the merged artifact list for a
 * single agent across every task execution. Sources exclusively from
 * `ArtifactStore` (`src/storage/artifact-store.ts`) — no new persistence,
 * no writes.
 *
 * The endpoint is the source of truth for the SPA Artifacts tab: it
 * returns every record the agent has produced in chronological (newest
 * first) order, plus a small summary by type so the tab can render its
 * group-by-type chip row without an extra round-trip.
 *
 * Returns `null` when the slug is unknown on disk so the HTTP layer can
 * map it to a 404. Empty manifests / missing artifacts dirs degrade to
 * an empty list rather than throwing — same forgiving policy used by
 * `gatherAgentLogs`.
 */

import { join, resolve, sep } from 'node:path';
import { listAllAgentsPartial } from '../../storage/agent-helpers.js';
import { ArtifactStore, statArtifactFile } from '../../storage/artifact-store.js';
import type {
  ArtifactRecord,
  ArtifactSummary,
} from '../../storage/artifact-store.js';

/** Options accepted by {@link gatherAgentArtifacts}. */
export interface GatherAgentArtifactsOptions {
  projectDir?: string;
  slug?: string;
}

/** Aggregate counts by artifact type, returned alongside the full list. */
export interface ArtifactSummaryPayload {
  totalArtifacts: number;
  byType: Record<string, number>;
  totalSizeBytes: number;
}

/** Artifacts payload returned to the SPA. */
export interface AgentArtifactsPayload {
  slug: string;
  artifacts: ArtifactRecord[];
  summary: ArtifactSummaryPayload;
}

/**
 * Gather every artifact record produced by `slug` across all task
 * executions. Records are sorted newest-first by `createdAt` so the SPA
 * Artifacts tab can render the most-recent deliverables at the top. The
 * summary block mirrors `ArtifactStore.summary()` so the tab's chip row
 * (counts by type, total size) lights up without an extra round-trip.
 */
export async function gatherAgentArtifacts({
  projectDir,
  slug,
}: GatherAgentArtifactsOptions = {}): Promise<AgentArtifactsPayload | null> {
  if (!projectDir) throw new Error('gatherAgentArtifacts: projectDir is required');
  if (!slug) throw new Error('gatherAgentArtifacts: slug is required');
  const agentsDir = join(projectDir, '.aweek', 'agents');

  // 404 surface: only existing agents get a payload. Use the partial
  // loader so a single drifted agent JSON does not knock this endpoint
  // offline for healthy agents.
  const { agents: configs } = await listAllAgentsPartial({ dataDir: agentsDir });
  const exists = configs.some((c) => c.id === slug);
  if (!exists) return null;

  const store = new ArtifactStore(agentsDir, projectDir);

  // ArtifactStore.load returns [] for a missing manifest (ENOENT) but
  // re-throws on schema-validation failure. Absorb that here so a
  // single corrupt manifest degrades to "no artifacts" instead of
  // 500ing the whole tab — this matches the read-only-but-forgiving
  // policy the rest of the data layer follows (gatherAgentLogs et al).
  let artifacts: ArtifactRecord[];
  try {
    artifacts = await store.load(slug);
  } catch {
    artifacts = [];
  }

  artifacts.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });

  // Source the aggregate counts (totalArtifacts, byType, totalSizeBytes)
  // exclusively from ArtifactStore.summary() — keeping the storage layer
  // as the single source of truth for the per-agent rollup and the
  // formula the SPA Artifacts tab surfaces. The same try/catch fallback
  // applies: a corrupt manifest degrades to a zero-summary instead of
  // 500ing the whole tab.
  let storeSummary: ArtifactSummary;
  try {
    storeSummary = await store.summary(slug);
  } catch {
    storeSummary = {
      agentId: slug,
      totalArtifacts: 0,
      byType: {},
      totalSizeBytes: 0,
    };
  }

  return {
    slug,
    artifacts,
    summary: {
      totalArtifacts: storeSummary.totalArtifacts,
      byType: storeSummary.byType,
      totalSizeBytes: storeSummary.totalSizeBytes,
    },
  };
}

/**
 * Content-Type lookup for the file extensions that artifact deliverables
 * commonly use. The set is intentionally broader than the SPA's
 * `MIME_TYPES` map (which is scoped to the Vite bundle) — agents can
 * produce arbitrary deliverable types (markdown, PDF, CSV, source code,
 * binary blobs), and the dashboard needs to surface each with the right
 * Content-Type so the browser either renders inline (markdown via the
 * SPA's Markdown component, images, PDFs) or falls back to a download.
 *
 * Anything missing from this table is served as
 * `application/octet-stream` — the browser-safe default that triggers a
 * download instead of attempting to render an unknown body, which both
 * matches user expectations for "unknown file type" and prevents
 * accidental script execution from a mislabelled extension.
 */
const ARTIFACT_MIME_TYPES: Record<string, string> = {
  // Text / source code
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.toml': 'application/toml; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.ndjson': 'application/x-ndjson; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/x-typescript; charset=utf-8',
  '.tsx': 'text/x-typescript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.rb': 'text/x-ruby; charset=utf-8',
  '.go': 'text/x-go; charset=utf-8',
  '.rs': 'text/x-rust; charset=utf-8',
  '.java': 'text/x-java; charset=utf-8',
  '.c': 'text/x-c; charset=utf-8',
  '.h': 'text/x-c; charset=utf-8',
  '.cpp': 'text/x-c++; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.sql': 'application/sql; charset=utf-8',
  // Documents
  '.pdf': 'application/pdf',
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  // Audio / video — typed correctly so the browser can stream.
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  // Archives — always download.
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
};

/**
 * Look up the Content-Type for an artifact filename based on its
 * extension. Falls back to `application/octet-stream` for unknown
 * extensions so the browser triggers a download (the safe default for
 * unidentified bodies).
 */
export function resolveArtifactContentType(fileName: string): string {
  if (typeof fileName !== 'string' || fileName.length === 0) {
    return 'application/octet-stream';
  }
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return 'application/octet-stream';
  const ext = fileName.slice(dot).toLowerCase();
  return ARTIFACT_MIME_TYPES[ext] || 'application/octet-stream';
}

/** Options accepted by {@link resolveArtifactFile}. */
export interface ResolveArtifactFileOptions {
  projectDir?: string;
  slug?: string;
  artifactId?: string;
}

/** Result of a successful {@link resolveArtifactFile} lookup. */
export interface ResolvedArtifactFile {
  /** The matching artifact record from the manifest. */
  record: ArtifactRecord;
  /** Absolute path to the file on disk (validated to be inside `projectDir`). */
  absolutePath: string;
  /** Content-Type derived from the artifact's `fileName` extension. */
  contentType: string;
  /** File size on disk, in bytes (read at lookup time, not from the manifest). */
  sizeBytes: number;
}

/** Failure shape returned by {@link resolveArtifactFile} when the lookup fails. */
export interface ResolveArtifactFileError {
  /**
   * Why the lookup failed:
   *   - 'agent-not-found'    — slug isn't on disk
   *   - 'artifact-not-found' — manifest has no record with this id
   *   - 'path-traversal'     — record.filePath escapes projectDir
   *   - 'file-missing'       — record exists but file is gone from disk
   */
  reason:
    | 'agent-not-found'
    | 'artifact-not-found'
    | 'path-traversal'
    | 'file-missing';
}

/**
 * Type guard distinguishing the success and error variants returned by
 * {@link resolveArtifactFile}. The HTTP layer uses this to branch on
 * the result shape without leaking implementation details.
 */
export function isResolveArtifactFileError(
  result: ResolvedArtifactFile | ResolveArtifactFileError,
): result is ResolveArtifactFileError {
  return (result as ResolveArtifactFileError).reason !== undefined;
}

/**
 * Resolve an artifact's record + absolute file path, validating that the
 * resolved path lives inside the project root.
 *
 * Security: the manifest's `filePath` is treated as untrusted user input
 * — even though agents register it themselves, a malicious or malformed
 * record could contain `../../../etc/passwd` and escape the project.
 * We `path.resolve(projectDir, filePath)` and then assert the result
 * starts with `projectDir + sep` (the `+ sep` keeps `project-sibling/`
 * from matching `project/` as a prefix). Any failure returns a typed
 * error code so the HTTP layer can map to the right status.
 *
 * Returns either:
 *   - `{ record, absolutePath, contentType, sizeBytes }` on success
 *   - `{ reason: '...' }` on failure (for HTTP layer to translate)
 */
export async function resolveArtifactFile({
  projectDir,
  slug,
  artifactId,
}: ResolveArtifactFileOptions = {}): Promise<
  ResolvedArtifactFile | ResolveArtifactFileError
> {
  if (!projectDir) throw new Error('resolveArtifactFile: projectDir is required');
  if (!slug) throw new Error('resolveArtifactFile: slug is required');
  if (!artifactId) throw new Error('resolveArtifactFile: artifactId is required');

  const agentsDir = join(projectDir, '.aweek', 'agents');

  // Confirm the agent exists on disk before touching the manifest. We
  // could rely on `ArtifactStore.load` returning [] for a missing
  // manifest, but distinguishing "no such agent" from "agent has no
  // artifacts" yields cleaner 404 messages.
  const { agents: configs } = await listAllAgentsPartial({ dataDir: agentsDir });
  if (!configs.some((c) => c.id === slug)) {
    return { reason: 'agent-not-found' };
  }

  const store = new ArtifactStore(agentsDir, projectDir);

  let records: ArtifactRecord[];
  try {
    records = await store.load(slug);
  } catch {
    // Corrupt manifest → treat as "no artifacts" so a single bad
    // record doesn't 500 the file endpoint.
    records = [];
  }
  const record = records.find((r) => r.id === artifactId);
  if (!record) return { reason: 'artifact-not-found' };

  // Path-traversal guard: resolve the manifest's `filePath` relative to
  // the project root and then assert the result is contained. The check
  // also rejects bare projectRoot — a deliverable cannot be the project
  // tree itself.
  const projectRoot = resolve(projectDir);
  const candidate = resolve(projectRoot, record.filePath);
  if (candidate === projectRoot || !candidate.startsWith(projectRoot + sep)) {
    return { reason: 'path-traversal' };
  }

  // Delegate the `stat()` call to the storage layer so this module
  // doesn't import `node:fs/promises` directly — the data-layer test
  // suite enforces that all fs access flows through `src/storage/*`.
  // We pass the validated relative path so `statArtifactFile` joins it
  // back to projectRoot consistently with other store callers.
  const stat = await statArtifactFile(projectRoot, record.filePath);
  if (!stat || !stat.isFile) return { reason: 'file-missing' };

  return {
    record,
    absolutePath: stat.absolutePath,
    contentType: resolveArtifactContentType(record.fileName),
    sizeBytes: stat.size,
  };
}
