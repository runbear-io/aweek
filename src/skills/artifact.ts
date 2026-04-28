/**
 * Artifact skill module — explicit registration of deliverable files.
 *
 * The companion `artifact-scanner.ts` handles the post-session auto-scan
 * pipeline (best-effort sweep of `<agentsDir>/<slug>/artifacts/<taskId>_<executionId>/`
 * and bulk register). This module exposes the *explicit* registration entry
 * point — one record at a time, callable from skill markdown via
 * `aweek exec artifact register`.
 *
 * Both paths converge on the same persistence layer
 * (`ArtifactStore.register` from `src/storage/artifact-store.ts`) so a
 * record produced via auto-scan or via explicit register is byte-identical
 * on disk.
 *
 * Design constraints (from the wiring spec):
 *   - Every artifact must belong to a specific (taskId, executionId) pair.
 *     The (taskId, executionId) pair partitions per-execution deliverables
 *     under `<agentsDir>/<slug>/artifacts/<taskId>_<executionId>/`; we
 *     verify that directory exists on disk so we can't register an
 *     artifact for an execution that never happened.
 *   - The taskId must reference a real weekly-plan task for the agent so
 *     the dashboard can drill from artifact → task → objective without
 *     dangling references. Validation is skipped only when the caller
 *     explicitly opts out (used by run-once ad-hoc tasks that don't live
 *     in any weekly plan).
 *   - The on-disk filePath stored in the manifest must point inside the
 *     project root — we reject any path that escapes via `..` or absolute
 *     traversal so the dashboard's file-serving endpoint can trust the
 *     manifest as a security boundary.
 *   - The file must already exist on disk: we stat it once for size and
 *     read it once for the SHA-256 checksum, stamping both into the
 *     record so the dashboard can detect post-registration tampering.
 *   - Reuses ArtifactStore's API surface; no parallel storage is introduced.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  ArtifactStore,
  createArtifactRecord,
  resolveArtifactDir,
  type ArtifactRecord,
  type ArtifactType,
} from '../storage/artifact-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { inferMimeType } from './artifact-scanner.js';

/** Algorithm name stamped alongside the digest so future migrations can swap implementations. */
const CHECKSUM_ALGORITHM = 'sha256' as const;

/**
 * Inputs accepted by `register`.
 *
 * Mirrors the JSON-object surface of every other dispatcher entry: each
 * field arrives top-level on a single input object so the CLI can pass the
 * payload through `--input-json -` without schema gymnastics.
 */
export interface RegisterArtifactOpts {
  /** Project root — used both as the security boundary for filePath and as the ArtifactStore.projectRoot. */
  projectRoot: string;
  /** `.aweek/agents` directory — owned by the heartbeat / CLI. */
  agentsDir: string;
  /** Agent slug producing the artifact (matches `.claude/agents/<slug>.md`). */
  agentId: string;
  /** Weekly-plan task id this artifact belongs to. */
  taskId: string;
  /** Compound execution id (from `cli-session.ts`) — the (taskId, executionId) pair partitions artifacts on disk. */
  executionId: string;
  /** Path to the artifact file. Accepts paths relative to projectRoot or absolute paths inside it. */
  filePath: string;
  /** Human-readable display name. Defaults to the basename of filePath. */
  fileName?: string;
  /** Artifact category (document/code/data/config/report/other). */
  type: ArtifactType;
  /** Human-readable description of the artifact's purpose. */
  description: string;
  /** Plan week (`YYYY-Www`) for traceability. */
  week?: string;
  /** File size in bytes — auto-populated from disk when omitted. */
  sizeBytes?: number;
  /** Optional extra metadata. `executionId`, `mimeType`, `checksum`, `checksumAlgorithm` are always merged in. */
  metadata?: Record<string, unknown>;
  /** Pre-built ArtifactStore. When omitted, one is constructed against `agentsDir` + `projectRoot`. */
  store?: ArtifactStore;
  /**
   * Pre-built WeeklyPlanStore — used to verify `taskId` exists in some
   * weekly plan for `agentId`. When omitted, one is constructed against
   * `agentsDir`. Set `skipTaskExistenceCheck: true` to bypass entirely.
   */
  weeklyPlanStore?: WeeklyPlanStore;
  /**
   * Skip the weekly-plan task-existence check. Default `false`.
   * Useful for ad-hoc / debug taskIds (e.g. `adhoc-<uuid>` from the
   * run-once skill) that are intentionally NOT in any weekly plan.
   */
  skipTaskExistenceCheck?: boolean;
}

/**
 * Normalize a caller-supplied filePath into a project-root-relative,
 * forward-slash form, *and* verify the resulting path stays inside the
 * project root. Throws on path traversal so callers can't slip an
 * absolute or `../` escape past the manifest.
 *
 * Returns the canonical relative path (forward-slash) suitable for
 * persisting to the manifest.
 */
export function normalizeArtifactFilePath(
  projectRoot: string,
  filePath: string,
): string {
  if (!projectRoot) throw new TypeError('projectRoot is required');
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('filePath is required');
  }

  const projectAbs = resolve(projectRoot);
  const candidateAbs = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(projectAbs, filePath);

  const rel = relative(projectAbs, candidateAbs);
  if (rel.startsWith('..') || (sep !== '/' && rel.startsWith(`..${sep}`)) || isAbsolute(rel)) {
    throw new Error(
      `filePath "${filePath}" escapes the project root — refusing to register a path outside ${projectAbs}`,
    );
  }
  // Reject the project root itself — an artifact must point at a file, not the root dir.
  if (rel === '') {
    throw new Error('filePath must point at a file inside the project root, not the root itself');
  }
  return sep === '/' ? rel : rel.split(sep).join('/');
}

/**
 * Look up a task by id across every weekly plan an agent owns. Returns
 * `null` if the agent has no plans yet (uninitialized) or if no plan
 * contains a task with the given id.
 *
 * Robust against `loadAll` errors: a corrupted plan file should NOT
 * mask the artifact-register call with a confusing JSON parse error;
 * we treat unreadable plans the same as a missing task and let the
 * caller raise a precise `EARTIFACT_UNKNOWN_TASK`.
 */
async function taskExistsInAnyWeeklyPlan(
  store: WeeklyPlanStore,
  agentId: string,
  taskId: string,
): Promise<boolean> {
  let plans;
  try {
    plans = await store.loadAll(agentId);
  } catch {
    return false;
  }
  for (const plan of plans) {
    if (plan.tasks.some((t) => t.id === taskId)) return true;
  }
  return false;
}

/** Compute SHA-256 hex digest of the file at `absolutePath`. */
async function computeFileChecksum(absolutePath: string): Promise<string> {
  // readFile is fine for the deliverable-sized files this skill is
  // designed for (markdown, reports, small images). Streaming would only
  // matter for >100MB artifacts which are out of scope for v1.
  const buf = await readFile(absolutePath);
  return createHash(CHECKSUM_ALGORITHM).update(buf).digest('hex');
}

/**
 * Explicitly register a single artifact under (agentId, taskId, executionId).
 *
 * Validation pipeline (all must pass before persistence):
 *   1. Required fields are present.
 *   2. `filePath` resolves inside the project root (no traversal).
 *   3. The on-disk file exists and is a regular file.
 *   4. The per-execution artifact directory `<agentsDir>/<agentId>/artifacts/<taskId>_<executionId>/`
 *      exists — proves the (taskId, executionId) pair is real.
 *   5. `taskId` is referenced by some weekly plan for `agentId` (skippable
 *      via `skipTaskExistenceCheck`).
 *
 * After validation, the file is hashed (SHA-256), the MIME type is
 * inferred from the filename, and the rich metadata payload — `executionId`,
 * `mimeType`, `checksum`, `checksumAlgorithm`, plus any caller-supplied
 * keys — is stamped onto the record. `sizeBytes` is also captured here
 * from the same `stat()` so `ArtifactStore.register` doesn't need to
 * re-stat the file.
 *
 * Returns the persisted record.
 */
export async function register(opts: RegisterArtifactOpts): Promise<ArtifactRecord> {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('register requires an options object');
  }
  const {
    projectRoot,
    agentsDir,
    agentId,
    taskId,
    executionId,
    filePath,
    fileName,
    type,
    description,
    week,
    sizeBytes,
    metadata,
    store: providedStore,
    weeklyPlanStore: providedPlanStore,
    skipTaskExistenceCheck = false,
  } = opts;

  if (!projectRoot) throw new TypeError('projectRoot is required');
  if (!agentsDir) throw new TypeError('agentsDir is required');
  if (!agentId) throw new TypeError('agentId is required');
  if (!taskId) throw new TypeError('taskId is required');
  if (!executionId) throw new TypeError('executionId is required');
  if (!filePath) throw new TypeError('filePath is required');
  if (!type) throw new TypeError('type is required');
  if (!description) throw new TypeError('description is required');

  // ── Step 2: filePath traversal guard ───────────────────────────────
  const safeRelPath = normalizeArtifactFilePath(projectRoot, filePath);
  const absoluteFilePath = join(resolve(projectRoot), safeRelPath);

  // ── Step 3: file exists on disk and is a regular file ──────────────
  let fileStat;
  try {
    fileStat = await stat(absoluteFilePath);
  } catch (cause) {
    const err: NodeJS.ErrnoException = new Error(
      `Artifact file does not exist on disk: ${safeRelPath} (resolved to ${absoluteFilePath})`,
    );
    err.code = 'EARTIFACT_FILE_MISSING';
    err.cause = cause;
    throw err;
  }
  if (!fileStat.isFile()) {
    const err: NodeJS.ErrnoException = new Error(
      `Artifact path is not a regular file: ${safeRelPath}`,
    );
    err.code = 'EARTIFACT_FILE_NOT_REGULAR';
    throw err;
  }

  // ── Step 4: per-execution artifact directory exists ────────────────
  const execDir = resolveArtifactDir(agentsDir, agentId, taskId, executionId);
  let execStat;
  try {
    execStat = await stat(execDir);
  } catch (cause) {
    const err: NodeJS.ErrnoException = new Error(
      `Execution directory not found for (taskId=${taskId}, executionId=${executionId}): ${execDir}`,
    );
    err.code = 'EARTIFACT_UNKNOWN_EXECUTION';
    err.cause = cause;
    throw err;
  }
  if (!execStat.isDirectory()) {
    const err: NodeJS.ErrnoException = new Error(
      `Execution path is not a directory: ${execDir}`,
    );
    err.code = 'EARTIFACT_UNKNOWN_EXECUTION';
    throw err;
  }

  // ── Step 5: task exists in some weekly plan for this agent ─────────
  if (!skipTaskExistenceCheck) {
    const planStore = providedPlanStore ?? new WeeklyPlanStore(agentsDir);
    const found = await taskExistsInAnyWeeklyPlan(planStore, agentId, taskId);
    if (!found) {
      const err: NodeJS.ErrnoException = new Error(
        `Task "${taskId}" was not found in any weekly plan for agent "${agentId}". ` +
          `Pass skipTaskExistenceCheck: true for ad-hoc tasks that don't live in a weekly plan.`,
      );
      err.code = 'EARTIFACT_UNKNOWN_TASK';
      throw err;
    }
  }

  // ── Step 6: compute rich metadata ──────────────────────────────────
  const resolvedFileName =
    fileName && fileName.length > 0
      ? fileName
      : (() => {
          const segments = safeRelPath.split('/');
          return segments[segments.length - 1] || safeRelPath;
        })();

  const mimeType = inferMimeType(resolvedFileName);
  const checksum = await computeFileChecksum(absoluteFilePath);
  const resolvedSizeBytes = sizeBytes ?? fileStat.size;

  // Always stamp the executionId into metadata so the dashboard can drill
  // from the artifact back to the per-execution log without re-parsing
  // the (taskId, executionId) pair from a sibling field. Auto-stamped
  // mimeType + SHA-256 checksum let the dashboard render the right
  // viewer and detect post-registration tampering.
  const mergedMetadata: Record<string, unknown> = {
    ...(metadata ?? {}),
    executionId,
    mimeType,
    checksum,
    checksumAlgorithm: CHECKSUM_ALGORITHM,
  };

  // ── Step 7: build + persist the record ─────────────────────────────
  const record = createArtifactRecord({
    agentId,
    taskId,
    filePath: safeRelPath,
    fileName: resolvedFileName,
    type,
    description,
    ...(week !== undefined ? { week } : {}),
    sizeBytes: resolvedSizeBytes,
    metadata: mergedMetadata,
  });

  const store = providedStore ?? new ArtifactStore(agentsDir, projectRoot);
  // We already populated sizeBytes from our single stat above, so
  // ArtifactStore.register doesn't need to stat the file again.
  return store.register(agentId, record, { autoSize: false });
}

// Re-export commonly-needed types so callers can import from this module
// without also importing the storage module.
export type { ArtifactRecord, ArtifactType };
