/**
 * JSON Schema for artifact records.
 * Each record tracks a deliverable file/document produced by an agent task.
 *
 * Required fields:
 *   - id:          Unique artifact identifier
 *   - agentId:     The agent that produced the artifact
 *   - taskId:      The weekly-plan task that produced it
 *   - filePath:    Relative path to the artifact within the project folder
 *   - fileName:    Human-readable display name for the artifact
 *   - type:        Category of artifact (document, code, data, config, report, other)
 *   - description: Human-readable summary of the artifact's purpose
 *   - createdAt:   ISO-8601 datetime when the artifact was registered
 *
 * Optional rich-metadata fields (promoted from `metadata.*` to top-level so
 * the dashboard can read them without unpacking the metadata bag):
 *   - executionId:       Compound execution id (from `cli-session.ts`) tying
 *                        this artifact to a specific session run
 *   - relpath:           Path relative to the per-execution artifact dir
 *                        (`<agentsDir>/<slug>/artifacts/<taskId>_<executionId>/`).
 *                        Distinct from `filePath`, which is relative to the
 *                        project root
 *   - mime:              IANA MIME type inferred from the filename extension
 *                        (e.g. `text/markdown`, `application/pdf`)
 *   - checksum:          Hex-encoded content digest captured at registration
 *                        time so the dashboard can detect post-registration
 *                        tampering
 *   - checksumAlgorithm: Algorithm name for `checksum` (e.g. `sha256`).
 *                        Stamped alongside `checksum` so future migrations
 *                        can swap implementations without ambiguity
 *   - week:              Plan week (YYYY-Www) for traceability
 *   - sizeBytes:         File size in bytes (auto-populated on registration)
 *   - metadata:          Free-form extra key-value bag for caller-supplied
 *                        attributes that don't deserve top-level promotion
 */

/** Valid artifact types */
export const ARTIFACT_TYPES = ['document', 'code', 'data', 'config', 'report', 'other'];

/**
 * Supported checksum algorithms. Only `sha256` is stamped today; the enum
 * leaves room for future migrations (e.g. `blake3`) without breaking existing
 * manifests.
 */
export const CHECKSUM_ALGORITHMS = ['sha256'];

export const artifactRecordSchema = {
  $id: 'aweek://schemas/artifact-record',
  type: 'object',
  required: ['id', 'agentId', 'taskId', 'filePath', 'fileName', 'type', 'description', 'createdAt'],
  properties: {
    id: {
      type: 'string',
      pattern: '^artifact-[a-f0-9]+$',
      description: 'Unique artifact identifier',
    },
    agentId: {
      type: 'string',
      description: 'The agent that produced the artifact',
    },
    taskId: {
      type: 'string',
      description: 'The weekly-plan task that produced the artifact',
    },
    filePath: {
      type: 'string',
      minLength: 1,
      description: 'Relative path to the artifact within the project folder',
    },
    fileName: {
      type: 'string',
      minLength: 1,
      description: 'Human-readable display name for the artifact',
    },
    type: {
      type: 'string',
      enum: ARTIFACT_TYPES,
      description: 'Category of artifact',
    },
    description: {
      type: 'string',
      minLength: 1,
      description: 'Human-readable summary of what this artifact is',
    },
    createdAt: {
      type: 'string',
      format: 'date-time',
      description: 'ISO-8601 datetime when the artifact was registered',
    },
    week: {
      type: 'string',
      pattern: '^\\d{4}-W\\d{2}$',
      description: 'Plan week for traceability (e.g. 2026-W16)',
    },
    sizeBytes: {
      type: 'integer',
      minimum: 0,
      description: 'File size in bytes',
    },
    executionId: {
      type: 'string',
      minLength: 1,
      description:
        'Compound execution id from cli-session.ts; ties the artifact to a specific session run',
    },
    relpath: {
      type: 'string',
      minLength: 1,
      description:
        'Path relative to the per-execution artifact directory (<agentsDir>/<slug>/artifacts/<taskId>_<executionId>/)',
    },
    mime: {
      type: 'string',
      minLength: 1,
      description: 'IANA MIME type inferred from the filename extension',
    },
    checksum: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Fa-f0-9]+$',
      description:
        'Hex-encoded content digest captured at registration time (algorithm in checksumAlgorithm)',
    },
    checksumAlgorithm: {
      type: 'string',
      enum: CHECKSUM_ALGORITHMS,
      description: 'Algorithm name for the checksum field (e.g. sha256)',
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description: 'Optional extra key-value data',
    },
  },
  additionalProperties: false,
};

export const artifactManifestSchema = {
  $id: 'aweek://schemas/artifact-manifest',
  type: 'array',
  items: { $ref: 'aweek://schemas/artifact-record' },
  description: 'Array of artifact records for an agent',
};
