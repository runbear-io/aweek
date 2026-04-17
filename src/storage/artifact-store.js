/**
 * Storage layer for artifact records.
 * Tracks deliverable files/documents produced by agent tasks.
 * Persists artifact manifests as structured JSON under data/agents/<agentId>/artifacts/.
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
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertValid } from '../schemas/validator.js';

const RECORD_SCHEMA_ID = 'aweek://schemas/artifact-record';
const MANIFEST_SCHEMA_ID = 'aweek://schemas/artifact-manifest';

/** Generate a short random hex ID */
const shortId = () => randomBytes(4).toString('hex');

/**
 * Create a new artifact record.
 * @param {object} opts
 * @param {string} opts.agentId - Agent that produced the artifact
 * @param {string} opts.taskId - Task that produced the artifact
 * @param {string} opts.filePath - Relative path to the file in the project folder
 * @param {string} opts.fileName - Human-readable file name
 * @param {string} opts.type - Artifact type: document, code, data, config, report, other
 * @param {string} opts.description - What this artifact is
 * @param {string} [opts.week] - Plan week (YYYY-Www) for traceability
 * @param {number} [opts.sizeBytes] - File size in bytes
 * @param {object} [opts.metadata] - Optional extra data
 * @returns {object} A valid artifact record
 */
export function createArtifactRecord({ agentId, taskId, filePath, fileName, type, description, week, sizeBytes, metadata }) {
  const record = {
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
 * @param {string} projectRoot - Project root directory
 * @param {string} filePath - Relative path to the artifact
 * @returns {Promise<number|undefined>}
 */
export async function getFileSize(projectRoot, filePath) {
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
 * @param {string} projectRoot - Project root directory
 * @param {string} filePath - Relative path to the artifact
 * @returns {Promise<boolean>}
 */
export async function artifactFileExists(projectRoot, filePath) {
  try {
    const fullPath = join(projectRoot, filePath);
    await stat(fullPath);
    return true;
  } catch {
    return false;
  }
}

export class ArtifactStore {
  /**
   * @param {string} baseDir - Root data directory (e.g., ./data/agents)
   * @param {string} [projectRoot] - Project root for resolving artifact files
   */
  constructor(baseDir, projectRoot) {
    this.baseDir = baseDir;
    this.projectRoot = projectRoot || process.cwd();
  }

  /**
   * Directory for an agent's artifact metadata.
   * @param {string} agentId
   */
  _artifactsDir(agentId) {
    return join(this.baseDir, agentId, 'artifacts');
  }

  /**
   * Path to an agent's artifact manifest file.
   * @param {string} agentId
   */
  _manifestPath(agentId) {
    return join(this._artifactsDir(agentId), 'manifest.json');
  }

  /**
   * Ensure the artifacts directory for an agent exists.
   * @param {string} agentId
   */
  async init(agentId) {
    await mkdir(this._artifactsDir(agentId), { recursive: true });
  }

  /**
   * Load all artifact records for an agent.
   * Returns empty array if no manifest exists yet.
   * @param {string} agentId
   * @returns {Promise<object[]>} Array of artifact records
   */
  async load(agentId) {
    const filePath = this._manifestPath(agentId);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const records = JSON.parse(raw);
      assertValid(MANIFEST_SCHEMA_ID, records);
      return records;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Save the full manifest for an agent (overwrite).
   * @param {string} agentId
   * @param {object[]} records
   */
  async _save(agentId, records) {
    assertValid(MANIFEST_SCHEMA_ID, records);
    await this.init(agentId);
    const filePath = this._manifestPath(agentId);
    await writeFile(filePath, JSON.stringify(records, null, 2) + '\n', 'utf-8');
  }

  /**
   * Register a new artifact record.
   * Idempotent: if a record with the same ID already exists, it is not duplicated.
   * Optionally auto-populates sizeBytes from the file on disk.
   * @param {string} agentId
   * @param {object} record - Artifact record (from createArtifactRecord)
   * @param {object} [opts]
   * @param {boolean} [opts.autoSize=true] - Auto-populate sizeBytes from file if not set
   * @returns {Promise<object>} The registered record
   */
  async register(agentId, record, opts = {}) {
    const autoSize = opts.autoSize !== false;

    // Auto-populate sizeBytes if not already set
    if (autoSize && record.sizeBytes === undefined && record.filePath) {
      const size = await getFileSize(this.projectRoot, record.filePath);
      if (size !== undefined) {
        record = { ...record, sizeBytes: size };
      }
    }

    assertValid(RECORD_SCHEMA_ID, record);
    await this.init(agentId);

    const records = await this.load(agentId);

    // Idempotent: skip if record ID already present
    if (records.some((r) => r.id === record.id)) {
      return record;
    }

    records.push(record);
    await this._save(agentId, records);
    return record;
  }

  /**
   * Register multiple artifact records at once (batch).
   * Each record is individually validated; duplicates are skipped.
   * @param {string} agentId
   * @param {object[]} newRecords - Array of artifact records
   * @param {object} [opts]
   * @param {boolean} [opts.autoSize=true] - Auto-populate sizeBytes from files
   * @returns {Promise<object[]>} The registered records
   */
  async registerBatch(agentId, newRecords, opts = {}) {
    const autoSize = opts.autoSize !== false;
    await this.init(agentId);
    const existing = await this.load(agentId);
    const existingIds = new Set(existing.map((r) => r.id));
    const added = [];

    for (let record of newRecords) {
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
   * @param {string} agentId
   * @param {string} artifactId
   * @returns {Promise<boolean>} true if a record was removed
   */
  async remove(agentId, artifactId) {
    const records = await this.load(agentId);
    const filtered = records.filter((r) => r.id !== artifactId);
    if (filtered.length === records.length) return false;
    await this._save(agentId, filtered);
    return true;
  }

  /**
   * Query artifact records with optional filters.
   * @param {string} agentId
   * @param {object} [filters]
   * @param {string} [filters.taskId] - Filter by task ID
   * @param {string} [filters.type] - Filter by artifact type
   * @param {string} [filters.week] - Filter by plan week
   * @returns {Promise<object[]>} Matching records
   */
  async query(agentId, filters = {}) {
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
   * @param {string} agentId
   * @returns {Promise<{ existing: object[], missing: object[] }>}
   */
  async verify(agentId) {
    const records = await this.load(agentId);
    const existing = [];
    const missing = [];

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

  /**
   * Get a summary of artifacts for an agent.
   * @param {string} agentId
   * @returns {Promise<object>} Summary with counts by type, total size, file count
   */
  async summary(agentId) {
    const records = await this.load(agentId);
    const byType = {};
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

  /**
   * List artifacts across all agents.
   * @returns {Promise<object[]>} All artifact records from all agents
   */
  async listAll() {
    const { readdir } = await import('node:fs/promises');
    let agentDirs;
    try {
      agentDirs = await readdir(this.baseDir);
    } catch {
      return [];
    }

    const all = [];
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
