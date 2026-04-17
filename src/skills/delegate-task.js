/**
 * Inter-agent task delegation skill.
 * Validates that the target agent exists, constructs a task message
 * conforming to the inbox-message schema, and enqueues it into
 * the target agent's inbox queue via InboxStore.
 *
 * Idempotent: re-delegating the same message (by ID) is a no-op
 * (enforced by InboxStore.enqueue).
 *
 * Returns the enqueued message for confirmation/traceability.
 */
import { AgentStore } from '../storage/agent-store.js';
import { InboxStore } from '../storage/inbox-store.js';
import { createInboxMessage } from '../models/agent.js';

/**
 * Validate delegation parameters before constructing the message.
 * Throws descriptive errors for missing or invalid inputs.
 *
 * @param {object} params
 * @param {string} params.fromAgentId - Sender agent ID
 * @param {string} params.toAgentId - Recipient agent ID
 * @param {string} params.taskDescription - Task description
 * @returns {{ fromAgentId: string, toAgentId: string, taskDescription: string }}
 */
export function validateDelegationParams({ fromAgentId, toAgentId, taskDescription } = {}) {
  if (!fromAgentId || typeof fromAgentId !== 'string') {
    throw new Error('fromAgentId is required and must be a non-empty string');
  }
  if (!toAgentId || typeof toAgentId !== 'string') {
    throw new Error('toAgentId is required and must be a non-empty string');
  }
  if (!taskDescription || typeof taskDescription !== 'string') {
    throw new Error('taskDescription is required and must be a non-empty string');
  }
  if (taskDescription.length > 2000) {
    throw new Error('taskDescription must not exceed 2000 characters');
  }
  if (fromAgentId === toAgentId) {
    throw new Error('An agent cannot delegate a task to itself');
  }
  return { fromAgentId, toAgentId, taskDescription };
}

/**
 * Delegate a task from one agent to another.
 *
 * 1. Validates parameters
 * 2. Verifies both sender and recipient agents exist
 * 3. Constructs a schema-valid inbox message
 * 4. Enqueues the message into the recipient's inbox (idempotent)
 *
 * @param {object} params
 * @param {string} params.fromAgentId - Sender agent ID
 * @param {string} params.toAgentId - Recipient agent ID
 * @param {string} params.taskDescription - What the target agent should do
 * @param {object} [params.options] - Optional message fields
 * @param {string} [params.options.priority] - 'critical' | 'high' | 'medium' | 'low' (default: 'medium')
 * @param {string} [params.options.context] - Additional context for the task
 * @param {string} [params.options.sourceTaskId] - Weekly task ID that triggered this delegation
 * @param {object} [deps] - Injectable dependencies (for testing)
 * @param {AgentStore} [deps.agentStore]
 * @param {InboxStore} [deps.inboxStore]
 * @returns {Promise<object>} The enqueued inbox message
 */
export async function delegateTask(params, deps = {}) {
  const { fromAgentId, toAgentId, taskDescription } = validateDelegationParams(params);
  const options = params.options || {};

  const agentStore = deps.agentStore || new AgentStore('data/agents');
  const inboxStore = deps.inboxStore || new InboxStore('data/agents');

  // Verify sender exists
  const senderExists = await agentStore.exists(fromAgentId);
  if (!senderExists) {
    throw new Error(`Sender agent not found: ${fromAgentId}`);
  }

  // Verify recipient exists
  const recipientExists = await agentStore.exists(toAgentId);
  if (!recipientExists) {
    throw new Error(`Target agent not found: ${toAgentId}`);
  }

  // Construct the inbox message via the model factory
  const message = createInboxMessage(fromAgentId, toAgentId, taskDescription, {
    priority: options.priority,
    context: options.context,
    sourceTaskId: options.sourceTaskId,
  });

  // Enqueue into recipient's inbox (idempotent — duplicate IDs are no-ops)
  const enqueued = await inboxStore.enqueue(toAgentId, message);

  return enqueued;
}

/**
 * Format a human-friendly summary of a delegation result.
 *
 * @param {object} message - The enqueued inbox message
 * @returns {string} Formatted summary
 */
export function formatDelegationResult(message) {
  const lines = [
    `Task delegated successfully`,
    `  Message ID: ${message.id}`,
    `  From: ${message.from}`,
    `  To: ${message.to}`,
    `  Priority: ${message.priority}`,
    `  Description: ${message.taskDescription}`,
  ];
  if (message.context) {
    lines.push(`  Context: ${message.context}`);
  }
  if (message.sourceTaskId) {
    lines.push(`  Source Task: ${message.sourceTaskId}`);
  }
  lines.push(`  Status: ${message.status}`);
  lines.push(`  Created: ${message.createdAt}`);
  return lines.join('\n');
}
