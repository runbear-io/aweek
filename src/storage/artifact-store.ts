/**
 * Storage layer for artifact records.
 * Tracks deliverable files/documents produced by agent tasks.
 * Persists artifact manifests as structured JSON under .aweek/agents/<agentId>/artifacts/.
 *
 * Each agent has a single manifest file (manifest.json) containing all artifact records.
 * Actual artifact files live in the project folder at their registered filePath.
 *
 * Design:
 * - File source of truth: manifest.json is human-readable and skill-readable
 * - Idempotent: registering an artifact with the same ID is a no-op
 * - Artifact files persist in project folder; manifest only tracks metadata
 * - Validation: all records validated against artifact-record schema
 */
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertValid } from '../schemas/validator.js';

const RECORD_SCHEMA_ID = 'aweek://schemas/artifact-record';
const MANIFEST_SCHEMA_ID = 'aweek://schemas/artifact-manifest';

/**
 * Valid artifact types. Mirrors `ARTIFACT_TYPES` in
 * `src/schemas/artifact.schema.js` and the schema's `enum`.
 */
export type ArtifactType = 'document' | 'code' | 'data' | 'config' | 'report' | 'other';

/**
 * Canonical shape of a single artifact record — mirrors `artifactRecordSchema`
 * in `src/schemas/artifact.schema.js`. Required vs. optional matches the
 * schema's `required` array exactly.
 */
export interface ArtifactRecord {
  /** Unique artifact identifier (`artifact-<hex>`). */
  id: string;
  /** Agent that produced the artifact. */
  agentId: string;
  /** Weekly-plan task that produced the artifact. */
  taskId: string;
  /** Relative path to the file in the project folder. */
  filePath: string;
  /** Human-readable display name for the artifact. */
  fileName: string;
  /** Category of artifact. */
  type: ArtifactType;
  /** Human-readable summary of what this artifact is. */
  description: string;
  /** ISO-8601 datetime when the artifact was registered. */
  createdAt: string;
  /** Plan week (`YYYY-Www`) for traceability. */
  week?: string;
  /** File size in bytes. */
  sizeBytes?: number;
  /** Optional extra key-value data. */
  metadata?: Record<string, unknown>;
}

/** Inputs accepted by `createArtifactRecord`. */
export interface CreateArtifactRecordOptions {
  /** Agent that produced the artifact. */
  agentId: string;
  /** Task that produced the artifact. */
  taskId: string;
  /** Relative path to the file in the project folder. */
  filePath: string;
  /** Human-readable file name. */
  fileName: string;
  /** Artifact type. */
  type: ArtifactType;
  /** What this artifact is. */
  description: string;
  /** Plan week (`YYYY-Www`) for traceability. */
  week?: string;
  /** File size in bytes. */
  sizeBytes?: number;
  /** Optional extra data. */
  metadata?: Record<string, unknown>;
}

/** Optional filters for `ArtifactStore.query()`. */
export interface ArtifactQueryFilters {
  /** Filter by task ID. */
  taskId?: string;
  /** Filter by artifact type. */
  type?: ArtifactType;
  /** Filter by plan week. */
  week?: string;
}

/** Options accepted by `register` / `registerBatch`. */
export interface RegisterOptions {
  /** Auto-populate sizeBytes from file if not set (default true). */
  autoSize?: boolean;
}

/** Result of `ArtifactStore.verify()`. */
export interface ArtifactVerifyResult {
  existing: ArtifactRecord[];
  missing: ArtifactRecord[];
}

/** Aggregate summary returned by `ArtifactStore.summary()`. */
export interface ArtifactSummary {
  agentId: string;
  totalArtifacts: number;
  byType: Record<string, number>;
  totalSizeBytes: number;
}

/** Generate a short random hex ID. */
const shortId = (): string => randomBytes(4).toString('hex');

/**
 * Create a new artifact record.
 */
export function createArtifactRecord({
  agentId,
  taskId,
  filePath,
  fileName,
  type,
  description,
  week,
  sizeBytes,
  metadata,
}: CreateArtifactRecordOptions): ArtifactRecord {
  const record: ArtifactRecord = {
    id: `artifact-${shortId()}`,
    agentId,
    taskId,
    filePath,
    fileName,
    type,
    description,
    createdAt: new Date().toISOString(),
  };
  if (week !== undefined) record.week = week;
  if (sizeBytes !== undefined) record.sizeBytes = sizeBytes;
  if (metadata !== undefined) record.metadata = metadata;
  return record;
}

/**
 * Try to get the file size for an artifact.
 * Returns undefined if the file doesn't exist or can't be read.
 */
export async function getFileSize(
  projectRoot: string,
  filePath: string,
): Promise<number | undefined> {
  try {
    const fullPath = join(projectRoot, filePath);
    const stats = await stat(fullPath);
    return stats.size;
  } catch {
    return undefined;
  }
}

/**
 * Check whether an artifact file exists on disk.
 */
export async function artifactFileExists(
  projectRoot: string,
  filePath: string,
): Promise<boolean> {
  try {
    const fullPath = join(projectRoot, filePath);
    await stat(fullPath);
    return true;
  } catch {
    return false;
  }
}

export class ArtifactStore {
  /** Root data directory (e.g., ./.aweek/agents). */
  readonly baseDir: string;
  /** Project root for resolving artifact files. */
  readonly projectRoot: string;

  constructor(baseDir: string, projectRoot?: string) {
    this.baseDir = baseDir;
    this.projectRoot = projectRoot || process.cwd();
  }

  /** Directory for an agent's artifact metadata. */
  _artifactsDir(agentId: string): string {
    return join(this.baseDir, agentId, 'artifacts');
  }

  /** Path to an agent's artifact manifest file. */
  _manifestPath(agentId: string): string {
    return join(this._artifactsDir(agentId), 'manifest.json');
  }

  /** Ensure the artifacts directory for an agent exists. */
  async init(agentId: string): Promise<void> {
    await mkdir(this._artifactsDir(agentId), { recursive: true });
  }

  /**
   * Load all artifact records for an agent.
   * Returns empty array if no manifest exists yet.
   */
  async load(agentId: string): Promise<ArtifactRecord[]> {
    const filePath = this._manifestPath(agentId);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const records = JSON.parse(raw) as ArtifactRecord[];
      assertValid(MANIFEST_SCHEMA_ID, records);
      return records;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Save the full manifest for an agent (overwrite). */
  async _save(agentId: string, records: ArtifactRecord[]): Promise<void> {
    assertValid(MANIFEST_SCHEMA_ID, records);
    await this.init(agentId);
    const filePath = this._manifestPath(agentId);
    await writeFile(filePath, JSON.stringify(records, null, 2) + '\n', 'utf-8');
  }

  /**
   * Register a new artifact record.
   * Idempotent: if a record with the same ID already exists, it is not duplicated.
   * Optionally auto-populates sizeBytes from the file on disk.
   */
  async register(
    agentId: string,
    record: ArtifactRecord,
    opts: RegisterOptions = {},
  ): Promise<ArtifactRecord> {
    const autoSize = opts.autoSize !== false;

    // Auto-populate sizeBytes if not already set
    let resolved: ArtifactRecord = record;
    if (autoSize && resolved.sizeBytes === undefined && resolved.filePath) {
      const size = await getFileSize(this.projectRoot, resolved.filePath);
      if (size !== undefined) {
        resolved = { ...resolved, sizeBytes: size };
      }
    }

    assertValid(RECORD_SCHEMA_ID, resolved);
    await this.init(agentId);

    const records = await this.load(agentId);

    // Idempotent: skip if record ID already present
    if (records.some((r) => r.id === resolved.id)) {
      return resolved;
    }

    records.push(resolved);
    await this._save(agentId, records);
    return resolved;
  }

  /**
   * Register multiple artifact records at once (batch).
   * Each record is individually validated; duplicates are skipped.
   */
  async registerBatch(
    agentId: string,
    newRecords: ArtifactRecord[],
    opts: RegisterOptions = {},
  ): Promise<ArtifactRecord[]> {
    const autoSize = opts.autoSize !== false;
    await this.init(agentId);
    const existing = await this.load(agentId);
    const existingIds = new Set(existing.map((r) => r.id));
    const added: ArtifactRecord[] = [];

    for (const original of newRecords) {
      let record: ArtifactRecord = original;
      if (autoSize && record.sizeBytes === undefined && record.filePath) {
        const size = await getFileSize(this.projectRoot, record.filePath);
        if (size !== undefined) {
          record = { ...record, sizeBytes: size };
        }
      }
      assertValid(RECORD_SCHEMA_ID, record);
      if (!existingIds.has(record.id)) {
        existing.push(record);
        existingIds.add(record.id);
        added.push(record);
      }
    }

    if (added.length > 0) {
      await this._save(agentId, existing);
    }
    return added;
  }

  /**
   * Remove an artifact record by ID.
   * Does NOT delete the actual file — only removes from manifest.
   * Idempotent: removing a nonexistent record is a no-op.
   * @returns true if a record was removed
   */
  async remove(agentId: string, artifactId: string): Promise<boolean> {
    const records = await this.load(agentId);
    const filtered = records.filter((r) => r.id !== artifactId);
    if (filtered.length === records.length) return false;
    await this._save(agentId, filtered);
    return true;
  }

  /** Query artifact records with optional filters. */
  async query(
    agentId: string,
    filters: ArtifactQueryFilters = {},
  ): Promise<ArtifactRecord[]> {
    const records = await this.load(agentId);
    return records.filter((r) => {
      if (filters.taskId && r.taskId !== filters.taskId) return false;
      if (filters.type && r.type !== filters.type) return false;
      if (filters.week && r.week !== filters.week) return false;
      return true;
    });
  }

  /**
   * Verify which artifacts still exist on disk.
   * Returns records partitioned into existing and missing.
   */
  async verify(agentId: string): Promise<ArtifactVerifyResult> {
    const records = await this.load(agentId);
    const existing: ArtifactRecord[] = [];
    const missing: ArtifactRecord[] = [];

    for (const record of records) {
      const exists = await artifactFileExists(this.projectRoot, record.filePath);
      if (exists) {
        existing.push(record);
      } else {
        missing.push(record);
      }
    }

    return { existing, missing };
  }

  /** Get a summary of artifacts for an agent. */
  async summary(agentId: string): Promise<ArtifactSummary> {
    const records = await this.load(agentId);
    const byType: Record<string, number> = {};
    let totalSizeBytes = 0;

    for (const record of records) {
      byType[record.type] = (byType[record.type] || 0) + 1;
      if (record.sizeBytes) totalSizeBytes += record.sizeBytes;
    }

    return {
      agentId,
      totalArtifacts: records.length,
      byType,
      totalSizeBytes,
    };
  }

  /** List artifacts across all agents. */
  async listAll(): Promise<ArtifactRecord[]> {
    let agentDirs: string[];
    try {
      agentDirs = await readdir(this.baseDir);
    } catch {
      return [];
    }

    const all: ArtifactRecord[] = [];
    for (const dir of agentDirs) {
      try {
        const records = await this.load(dir);
        all.push(...records);
      } catch {
        // Skip agents with invalid manifests
        continue;
      }
    }
    return all;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Narrow `unknown` to a Node `ErrnoException` so we can read the `code` field. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
