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

export interface DelegationParams {
  fromAgentId?: string;
  toAgentId?: string;
  taskDescription?: string;
  options?: {
    priority?: string;
    context?: string;
    sourceTaskId?: string;
  };
}

/**
 * Validate delegation parameters before constructing the message.
 * Throws descriptive errors for missing or invalid inputs.
 */
export function validateDelegationParams(
  { fromAgentId, toAgentId, taskDescription }: DelegationParams = {},
): { fromAgentId: string; toAgentId: string; taskDescription: string } {
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

export interface DelegateTaskDeps {
  agentStore?: any;
  inboxStore?: any;
}

/**
 * Delegate a task from one agent to another.
 *
 * 1. Validates parameters
 * 2. Verifies both sender and recipient agents exist
 * 3. Constructs a schema-valid inbox message
 * 4. Enqueues the message into the recipient's inbox (idempotent)
 */
export async function delegateTask(
  params: DelegationParams,
  deps: DelegateTaskDeps = {},
): Promise<any> {
  const { fromAgentId, toAgentId, taskDescription } = validateDelegationParams(params);
  const options = params.options || {};

  const agentStore = deps.agentStore || new AgentStore('.aweek/agents');
  const inboxStore = deps.inboxStore || new InboxStore('.aweek/agents');

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
    priority: options.priority as any,
    context: options.context,
    sourceTaskId: options.sourceTaskId,
  });

  // Enqueue into recipient's inbox (idempotent — duplicate IDs are no-ops)
  const enqueued = await inboxStore.enqueue(toAgentId, message);

  return enqueued;
}

/**
 * Format a human-friendly summary of a delegation result.
 */
export function formatDelegationResult(message: any): string {
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
