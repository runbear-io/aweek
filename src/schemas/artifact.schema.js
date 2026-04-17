/**
 * JSON Schema for artifact records.
 * Each record tracks a deliverable file/document produced by an agent task.
 *
 * Fields:
 *   - id:          Unique artifact identifier
 *   - agentId:     The agent that produced the artifact
 *   - taskId:      The weekly-plan task that produced it
 *   - filePath:    Relative path to the artifact within the project folder
 *   - fileName:    Human-readable display name for the artifact
 *   - type:        Category of artifact (document, code, data, config, report, other)
 *   - description: Human-readable summary of the artifact's purpose
 *   - createdAt:   ISO-8601 datetime when the artifact was registered
 *   - week:        Plan week (YYYY-Www) for traceability
 *   - sizeBytes:   File size in bytes (optional, populated on registration)
 *   - metadata:    Optional extra key-value data
 */

/** Valid artifact types */
export const ARTIFACT_TYPES = ['document', 'code', 'data', 'config', 'report', 'other'];

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
