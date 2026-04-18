/**
 * Centralized schema validator using Ajv.
 * Validates all agent artifacts against fixed schemas.
 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  goalSchema,
  goalsArraySchema,
  monthlyObjectiveSchema,
  monthlyPlanSchema,
  weeklyTaskSchema,
  weeklyPlanSchema,
  budgetSchema,
  inboxMessageSchema,
  inboxQueueSchema,
  agentConfigSchema,
} from './agent.schema.js';
import {
  activityLogEntrySchema,
  activityLogSchema,
} from './activity-log.schema.js';
import {
  usageRecordSchema,
  usageLogSchema,
} from './usage.schema.js';
import {
  artifactRecordSchema,
  artifactManifestSchema,
} from './artifact.schema.js';
import {
  executionRecordSchema,
  executionLogSchema,
} from './execution.schema.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

// Register all schemas (order matters: referenced schemas first)
ajv.addSchema(goalSchema);
ajv.addSchema(goalsArraySchema);
ajv.addSchema(monthlyObjectiveSchema);
ajv.addSchema(monthlyPlanSchema);
ajv.addSchema(weeklyTaskSchema);
ajv.addSchema(weeklyPlanSchema);
ajv.addSchema(budgetSchema);
ajv.addSchema(inboxMessageSchema);
ajv.addSchema(inboxQueueSchema);
ajv.addSchema(activityLogEntrySchema);
ajv.addSchema(activityLogSchema);
ajv.addSchema(usageRecordSchema);
ajv.addSchema(usageLogSchema);
ajv.addSchema(artifactRecordSchema);
ajv.addSchema(artifactManifestSchema);
ajv.addSchema(executionRecordSchema);
ajv.addSchema(executionLogSchema);
ajv.addSchema(agentConfigSchema);

/**
 * Validate data against a named schema.
 * @param {string} schemaId - The $id of the schema to validate against
 * @param {any} data - Data to validate
 * @returns {{ valid: boolean, errors: import('ajv').ErrorObject[] | null }}
 */
export function validate(schemaId, data) {
  const valid = ajv.validate(schemaId, data);
  return {
    valid: /** @type {boolean} */ (valid),
    errors: valid ? null : structuredClone(ajv.errors),
  };
}

/**
 * Validate and throw if invalid.
 * @param {string} schemaId
 * @param {any} data
 * @throws {Error} With validation details
 */
export function assertValid(schemaId, data) {
  const result = validate(schemaId, data);
  if (!result.valid) {
    const messages = result.errors.map(
      (e) => `${e.instancePath || '/'}: ${e.message}`
    );
    throw new Error(`Schema validation failed (${schemaId}):\n  ${messages.join('\n  ')}`);
  }
}

/** Convenience validators */
export const validateAgentConfig = (data) => validate('aweek://schemas/agent-config', data);
export const validateGoal = (data) => validate('aweek://schemas/goal', data);
export const validateMonthlyPlan = (data) => validate('aweek://schemas/monthly-plan', data);
export const validateMonthlyObjective = (data) => validate('aweek://schemas/monthly-objective', data);
export const validateWeeklyPlan = (data) => validate('aweek://schemas/weekly-plan', data);
export const validateBudget = (data) => validate('aweek://schemas/budget', data);
export const validateInboxMessage = (data) => validate('aweek://schemas/inbox-message', data);
export const validateInboxQueue = (data) => validate('aweek://schemas/inbox-queue', data);
export const validateActivityLogEntry = (data) => validate('aweek://schemas/activity-log-entry', data);
export const validateActivityLog = (data) => validate('aweek://schemas/activity-log', data);
export const validateUsageRecord = (data) => validate('aweek://schemas/usage-record', data);
export const validateUsageLog = (data) => validate('aweek://schemas/usage-log', data);
export const validateArtifactRecord = (data) => validate('aweek://schemas/artifact-record', data);
export const validateArtifactManifest = (data) => validate('aweek://schemas/artifact-manifest', data);
export const validateExecutionRecord = (data) => validate('aweek://schemas/execution-record', data);
export const validateExecutionLog = (data) => validate('aweek://schemas/execution-log', data);
