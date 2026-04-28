/**
 * Post-session artifact scanner.
 *
 * After a Claude Code CLI session completes, the heartbeat needs to register
 * any deliverable files the subagent dropped into its per-execution artifact
 * directory (`<agentsDir>/<agent>/artifacts/<taskId>_<executionId>/`). This
 * module walks that directory, classifies each file's `ArtifactType` from
 * its extension/MIME, and produces ready-to-persist `ArtifactRecord` objects
 * that can be handed straight to `ArtifactStore.registerBatch`.
 *
 * Design:
 * - Pure helpers (`inferMimeType`, `inferArtifactType`, `buildDefaultDescription`)
 *   are exported alongside the orchestrator so unit tests, the CLI dispatcher,
 *   and the future explicit `register` command can all share the same logic.
 * - The scanner is best-effort: a missing/unreadable directory yields an empty
 *   array rather than throwing — a session shouldn't fail just because no
 *   artifacts were produced.
 * - Recursive: subagents may organize deliverables into nested folders, so we
 *   walk the tree and preserve relative paths inside the artifact directory.
 * - Reuses the existing `ArtifactStore` API surface (`createArtifactRecord`,
 *   `registerBatch`) — no new persistence is introduced here.
 */
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

import {
  ArtifactStore,
  createArtifactRecord,
  type ArtifactRecord,
  type ArtifactType,
} from '../storage/artifact-store.js';

// ---------------------------------------------------------------------------
// Extension / MIME / type tables
// ---------------------------------------------------------------------------

/**
 * Minimal extension → MIME map. Covers the file types subagents most
 * commonly produce as deliverables — text, structured data, code, and the
 * handful of binary document formats we want to render or download from
 * the dashboard. Unknown extensions resolve to `application/octet-stream`.
 *
 * Kept inline (no `mime` dependency) so the scanner stays tree-shakeable
 * and dependency-free; downstream consumers can extend the table by passing
 * a custom `extensionToMime` override to `scanArtifactDirectory`.
 */
const DEFAULT_EXT_TO_MIME: Readonly<Record<string, string>> = Object.freeze({
  // Markdown / plain text
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.rst': 'text/x-rst',
  // Rich documents
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.odt': 'application/vnd.oasis.opendocument.text',
  // Structured data
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.ndjson': 'application/x-ndjson',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.toml': 'application/toml',
  '.parquet': 'application/vnd.apache.parquet',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // Code
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.hpp': 'text/x-c++',
  '.cc': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.swift': 'text/x-swift',
  '.kt': 'text/x-kotlin',
  '.scala': 'text/x-scala',
  '.sh': 'application/x-sh',
  '.bash': 'application/x-sh',
  '.zsh': 'application/x-sh',
  '.fish': 'application/x-sh',
  '.ps1': 'application/x-powershell',
  '.sql': 'application/sql',
  '.css': 'text/css',
  '.scss': 'text/x-scss',
  '.less': 'text/x-less',
  '.vue': 'text/x-vue',
  '.svelte': 'text/x-svelte',
  // Config-ish
  '.env': 'text/plain',
  '.ini': 'text/plain',
  '.conf': 'text/plain',
  '.config': 'text/plain',
  '.lock': 'text/plain',
  // Images (carried through MIME so the dashboard can decide whether to
  // render inline; categorized as `other` because the artifact taxonomy is
  // intentionally narrow.)
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
});

const FALLBACK_MIME = 'application/octet-stream';

/**
 * Extension → ArtifactType. The taxonomy is documented in
 * `src/schemas/artifact.schema.js#ARTIFACT_TYPES`.
 */
const DEFAULT_EXT_TO_TYPE: Readonly<Record<string, ArtifactType>> = Object.freeze({
  // documents
  '.md': 'document',
  '.markdown': 'document',
  '.txt': 'document',
  '.rst': 'document',
  '.rtf': 'document',
  '.doc': 'document',
  '.docx': 'document',
  '.odt': 'document',
  '.pdf': 'document',
  '.html': 'document',
  '.htm': 'document',
  // code
  '.js': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.ts': 'code',
  '.tsx': 'code',
  '.jsx': 'code',
  '.py': 'code',
  '.rb': 'code',
  '.go': 'code',
  '.rs': 'code',
  '.java': 'code',
  '.c': 'code',
  '.h': 'code',
  '.cpp': 'code',
  '.hpp': 'code',
  '.cc': 'code',
  '.cs': 'code',
  '.swift': 'code',
  '.kt': 'code',
  '.scala': 'code',
  '.sh': 'code',
  '.bash': 'code',
  '.zsh': 'code',
  '.fish': 'code',
  '.ps1': 'code',
  '.sql': 'code',
  '.css': 'code',
  '.scss': 'code',
  '.less': 'code',
  '.vue': 'code',
  '.svelte': 'code',
  // data
  '.json': 'data',
  '.jsonl': 'data',
  '.ndjson': 'data',
  '.csv': 'data',
  '.tsv': 'data',
  '.xml': 'data',
  '.parquet': 'data',
  '.xls': 'data',
  '.xlsx': 'data',
  // config
  '.env': 'config',
  '.ini': 'config',
  '.conf': 'config',
  '.config': 'config',
  '.toml': 'config',
  '.yaml': 'config',
  '.yml': 'config',
  '.lock': 'config',
});

/**
 * Filename hints that bias classification toward `report`. Reports are
 * usually markdown / pdf documents — the keyword-based override lets us
 * surface them as a distinct type in the dashboard regardless of the
 * underlying extension.
 */
const REPORT_KEYWORDS = ['report', 'review', 'retrospective', 'summary', 'recap'] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Optional task context that flavors the auto-generated description. */
export interface TaskDescriptor {
  /** Short calendar label (preferred for descriptions). */
  title?: string;
  /** Long-form prompt. Falls back to title when title is missing. */
  prompt?: string;
  /** Parent objective ID for traceability in the description. */
  objectiveId?: string;
}

/** Inputs for the orchestrator. */
export interface ScanArtifactDirectoryOpts {
  /** `.aweek/agents` root — owned by the heartbeat / CLI. */
  agentsDir: string;
  /** Agent slug (matches `.claude/agents/<slug>.md`). */
  agentId: string;
  /** Weekly-plan task id that ran in this execution. */
  taskId: string;
  /** Compound execution id from `cli-session.ts`. */
  executionId: string;
  /** Project root for resolving the relative `filePath` written into the manifest. */
  projectRoot: string;
  /** Optional plan week (`YYYY-Www`). Stored on every produced record. */
  week?: string;
  /** Optional task context — used to flavor each artifact's description. */
  task?: TaskDescriptor;
  /** Override extension → MIME map (merged on top of the default). */
  extensionToMime?: Readonly<Record<string, string>>;
  /** Override extension → ArtifactType map (merged on top of the default). */
  extensionToType?: Readonly<Record<string, ArtifactType>>;
}

/** Inputs for the scan + register convenience. */
export interface ScanAndRegisterOpts extends ScanArtifactDirectoryOpts {
  /** Pre-built ArtifactStore. When omitted, one is constructed against `agentsDir`. */
  store?: ArtifactStore;
}

/** Aggregate result from `scanAndRegister`. */
export interface ScanAndRegisterResult {
  /** Records that the scan walk produced (before registration). */
  scanned: ArtifactRecord[];
  /** Records actually written to the manifest (idempotency removes duplicates). */
  registered: ArtifactRecord[];
  /** Absolute path that was scanned. */
  artifactDir: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Lowercase the extension and strip leading `.`-collapsing surprises (we
 * want `.MD` and `.md` to map identically).
 */
function normalizeExtension(name: string): string {
  return extname(name).toLowerCase();
}

/**
 * Best-guess MIME type for a filename. Falls back to the generic
 * `application/octet-stream` so consumers always get a non-empty string.
 *
 * Override map entries take precedence; case-insensitive on the extension.
 */
export function inferMimeType(
  fileName: string,
  override: Readonly<Record<string, string>> = {},
): string {
  const ext = normalizeExtension(fileName);
  if (!ext) return FALLBACK_MIME;
  if (override[ext]) return override[ext];
  return DEFAULT_EXT_TO_MIME[ext] ?? FALLBACK_MIME;
}

/**
 * Best-guess `ArtifactType` for a filename. Heuristics, in priority order:
 *   1. Filename keyword match for `report` (e.g. `weekly-report.md`).
 *   2. Override map entry for the extension.
 *   3. Built-in extension → type map.
 *   4. Fallback to `'other'`.
 */
export function inferArtifactType(
  fileName: string,
  override: Readonly<Record<string, ArtifactType>> = {},
): ArtifactType {
  const lowerName = fileName.toLowerCase();
  for (const keyword of REPORT_KEYWORDS) {
    if (lowerName.includes(keyword)) {
      // Reports may be markdown, pdf, html — keep them grouped under 'report'
      // so the dashboard can surface them as a distinct row class.
      return 'report';
    }
  }
  const ext = normalizeExtension(fileName);
  if (!ext) return 'other';
  if (override[ext]) return override[ext];
  return DEFAULT_EXT_TO_TYPE[ext] ?? 'other';
}

/**
 * Generate a default human-readable description.
 *
 * Format: `<filename> — <type> generated during task "<title>"`. When the
 * task descriptor is missing, falls back to a minimal `filename — type`.
 */
export function buildDefaultDescription(
  fileName: string,
  type: ArtifactType,
  task?: TaskDescriptor | null,
): string {
  const base = `${fileName} — ${type}`;
  if (!task) return base;

  const taskLabel = task.title ?? task.prompt ?? '';
  const trimmed = taskLabel.trim();
  // Single-line, length-capped task label so descriptions stay readable in
  // the dashboard regardless of how verbose the original prompt was.
  const oneLine = trimmed.replace(/\s+/g, ' ');
  const capped = oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
  if (!capped) {
    if (task.objectiveId) {
      return `${base} (objective ${task.objectiveId})`;
    }
    return base;
  }
  if (task.objectiveId) {
    return `${base} generated during task "${capped}" (objective ${task.objectiveId})`;
  }
  return `${base} generated during task "${capped}"`;
}

// ---------------------------------------------------------------------------
// Directory walk
// ---------------------------------------------------------------------------

/**
 * Recursive file enumeration starting at `root`. Returns absolute paths.
 * Symlinks pointing at directories are followed once (no cycle detection
 * beyond Node's own readdir behaviour); broken / unreadable entries are
 * silently skipped — the scanner is best-effort.
 */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      // Skip the manifest we ourselves write into the per-agent
      // `<agentsDir>/<slug>/artifacts/manifest.json` location — though that
      // file lives one level above the per-execution directory, the guard
      // is cheap and protects callers that point the scanner at the wrong
      // root.
      if (entry.isFile()) {
        if (entry.name === 'manifest.json') continue;
        out.push(full);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(full);
      }
      // Other entry types (sockets, fifos, etc.) are ignored.
    }
  }

  await visit(root);
  return out.sort();
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

// ---------------------------------------------------------------------------
// Orchestrators
// ---------------------------------------------------------------------------

/**
 * Resolve the per-execution artifact directory and walk it, producing
 * ready-to-persist `ArtifactRecord` objects. Does NOT touch the manifest;
 * callers can choose to inspect/modify the records before handing them to
 * `ArtifactStore.registerBatch`.
 *
 * The artifact directory layout is owned by `resolveArtifactDir` in
 * `src/storage/artifact-store.ts`; we recompute the path here for caller
 * ergonomics rather than asking every caller to import it.
 *
 * The returned records carry:
 *   - `id`        — auto-assigned by `createArtifactRecord`
 *   - `agentId`   — from opts
 *   - `taskId`    — from opts
 *   - `filePath`  — relative to `projectRoot`, joined with `/`
 *   - `fileName`  — basename within the artifact dir (path-style, joined with `/`)
 *   - `type`      — inferred via `inferArtifactType`
 *   - `description` — auto-generated via `buildDefaultDescription`
 *   - `week`      — copied from opts when present
 *   - `metadata`  — carries `mimeType`, `executionId`, and the `objectiveId`
 *                   when supplied so the dashboard can render context without
 *                   re-resolving the execution log.
 */
export async function scanArtifactDirectory(
  opts: ScanArtifactDirectoryOpts,
): Promise<ArtifactRecord[]> {
  const {
    agentsDir,
    agentId,
    taskId,
    executionId,
    projectRoot,
    week,
    task,
    extensionToMime = {},
    extensionToType = {},
  } = opts;

  if (!agentsDir) throw new TypeError('agentsDir is required');
  if (!agentId) throw new TypeError('agentId is required');
  if (!taskId) throw new TypeError('taskId is required');
  if (!executionId) throw new TypeError('executionId is required');
  if (!projectRoot) throw new TypeError('projectRoot is required');

  const artifactDir = join(agentsDir, agentId, 'artifacts', `${taskId}_${executionId}`);

  let absoluteFiles: string[];
  try {
    absoluteFiles = await walkFiles(artifactDir);
  } catch (err) {
    // ENOENT already handled inside walkFiles; anything else is a real
    // error and surfaces to the caller so the heartbeat can log it.
    throw err;
  }

  const records: ArtifactRecord[] = [];
  for (const absolute of absoluteFiles) {
    const relInDir = toForwardSlash(relative(artifactDir, absolute));
    const fileName = relInDir; // preserves any subdirectory structure
    const filePath = toForwardSlash(relative(projectRoot, absolute));

    const type = inferArtifactType(fileName, extensionToType);
    const mimeType = inferMimeType(fileName, extensionToMime);
    const description = buildDefaultDescription(fileName, type, task);

    let sizeBytes: number | undefined;
    try {
      const s = await stat(absolute);
      if (s.isFile()) sizeBytes = s.size;
    } catch {
      sizeBytes = undefined;
    }

    const metadata: Record<string, unknown> = {
      mimeType,
      executionId,
    };
    if (task?.objectiveId) metadata.objectiveId = task.objectiveId;

    const record = createArtifactRecord({
      agentId,
      taskId,
      filePath,
      fileName,
      type,
      description,
      ...(week !== undefined ? { week } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      metadata,
    });
    records.push(record);
  }
  return records;
}

/**
 * One-shot helper: scan the artifact directory and persist the resulting
 * records via `ArtifactStore.registerBatch`. The store's idempotency check
 * (record.id uniqueness) means re-running the scan on the same directory
 * is safe — only newly-walked records will be appended to the manifest.
 *
 * Callers that need to inspect or filter the scan output before persistence
 * should use `scanArtifactDirectory` directly and call `registerBatch`
 * themselves.
 */
export async function scanAndRegister(
  opts: ScanAndRegisterOpts,
): Promise<ScanAndRegisterResult> {
  const { store: providedStore, ...scanOpts } = opts;
  const store = providedStore ?? new ArtifactStore(scanOpts.agentsDir, scanOpts.projectRoot);

  const scanned = await scanArtifactDirectory(scanOpts);
  const registered = scanned.length > 0
    ? await store.registerBatch(scanOpts.agentId, scanned, { autoSize: false })
    : [];
  const artifactDir = join(
    scanOpts.agentsDir,
    scanOpts.agentId,
    'artifacts',
    `${scanOpts.taskId}_${scanOpts.executionId}`,
  );
  return { scanned, registered, artifactDir };
}

/**
 * Convert a platform-native path (Windows `\`) to a forward-slash form so the
 * manifest stays portable across the OSes a single project might be cloned to.
 */
function toForwardSlash(p: string): string {
  if (sep === '/') return p;
  return p.split(sep).join('/');
}

// Re-exports so callers that only import from this module can build records
// or query the schema-backed types without also importing the storage module.
export type { ArtifactRecord, ArtifactType };
