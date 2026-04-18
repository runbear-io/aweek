/**
 * Tests for inbox queue schema — inter-agent task delegation messages.
 * Covers: schema validation, message lifecycle, queue validation,
 * required fields, optional fields, enum constraints, and edge cases.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGE_STATUSES,
  MESSAGE_PRIORITIES,
  MESSAGE_TYPES,
  inboxMessageSchema,
  inboxQueueSchema,
} from './inbox.schema.js';
import {
  validateInboxMessage,
  validateInboxQueue,
  validate,
} from './validator.js';
import { createInboxMessage } from '../models/agent.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('inbox schema — constants', () => {
  it('MESSAGE_STATUSES contains expected values', () => {
    assert.deepStrictEqual(MESSAGE_STATUSES, ['pending', 'accepted', 'completed', 'rejected']);
  });

  it('MESSAGE_PRIORITIES contains expected values', () => {
    assert.deepStrictEqual(MESSAGE_PRIORITIES, ['critical', 'high', 'medium', 'low']);
  });

  it('MESSAGE_TYPES contains expected values', () => {
    assert.deepStrictEqual(MESSAGE_TYPES, ['task-delegation', 'status-update', 'info']);
  });
});

// ---------------------------------------------------------------------------
// Schema $id
// ---------------------------------------------------------------------------

describe('inbox schema — $id', () => {
  it('inboxMessageSchema has correct $id', () => {
    assert.equal(inboxMessageSchema.$id, 'aweek://schemas/inbox-message');
  });

  it('inboxQueueSchema has correct $id', () => {
    assert.equal(inboxQueueSchema.$id, 'aweek://schemas/inbox-queue');
  });
});

// ---------------------------------------------------------------------------
// Helper: build a valid message
// ---------------------------------------------------------------------------

function validMessage(overrides = {}) {
  return {
    id: 'msg-abc12345',
    from: 'agent-sender-abc123',
    to: 'agent-receiver-xyz789',
    type: 'task-delegation',
    taskDescription: 'Review the latest changes',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    status: 'pending',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Required fields
// ---------------------------------------------------------------------------

describe('inbox message — required fields', () => {
  const requiredFields = ['id', 'from', 'to', 'type', 'taskDescription', 'priority', 'createdAt', 'status'];

  for (const field of requiredFields) {
    it(`rejects message missing ${field}`, () => {
      const msg = validMessage();
      delete msg[field];
      const result = validateInboxMessage(msg);
      assert.equal(result.valid, false);
    });
  }

  it('accepts a message with all required fields', () => {
    const result = validateInboxMessage(validMessage());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// Field constraints
// ---------------------------------------------------------------------------

describe('inbox message — field constraints', () => {
  it('rejects invalid id pattern', () => {
    const result = validateInboxMessage(validMessage({ id: 'bad-id' }));
    assert.equal(result.valid, false);
  });

  it('accepts valid id pattern', () => {
    const result = validateInboxMessage(validMessage({ id: 'msg-abc-123-def' }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects invalid from pattern', () => {
    const result = validateInboxMessage(validMessage({ from: 'Not-A-Slug' }));
    assert.equal(result.valid, false);
  });

  it('rejects invalid to pattern', () => {
    const result = validateInboxMessage(validMessage({ to: 'Not-A-Slug' }));
    assert.equal(result.valid, false);
  });

  it('rejects empty taskDescription', () => {
    const result = validateInboxMessage(validMessage({ taskDescription: '' }));
    assert.equal(result.valid, false);
  });

  it('rejects taskDescription exceeding maxLength', () => {
    const result = validateInboxMessage(validMessage({ taskDescription: 'x'.repeat(2001) }));
    assert.equal(result.valid, false);
  });

  it('accepts taskDescription at maxLength boundary', () => {
    const result = validateInboxMessage(validMessage({ taskDescription: 'x'.repeat(2000) }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects invalid status enum', () => {
    const result = validateInboxMessage(validMessage({ status: 'unknown' }));
    assert.equal(result.valid, false);
  });

  it('rejects invalid type enum', () => {
    const result = validateInboxMessage(validMessage({ type: 'unknown' }));
    assert.equal(result.valid, false);
  });

  it('rejects invalid priority enum', () => {
    const result = validateInboxMessage(validMessage({ priority: 'urgent' }));
    assert.equal(result.valid, false);
  });

  it('rejects invalid createdAt format', () => {
    const result = validateInboxMessage(validMessage({ createdAt: 'not-a-date' }));
    assert.equal(result.valid, false);
  });

  it('rejects additional properties', () => {
    const result = validateInboxMessage(validMessage({ extraField: 'nope' }));
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Enum coverage
// ---------------------------------------------------------------------------

describe('inbox message — enum coverage', () => {
  for (const status of MESSAGE_STATUSES) {
    it(`accepts status: ${status}`, () => {
      const result = validateInboxMessage(validMessage({ status }));
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });
  }

  for (const priority of MESSAGE_PRIORITIES) {
    it(`accepts priority: ${priority}`, () => {
      const result = validateInboxMessage(validMessage({ priority }));
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });
  }

  for (const type of MESSAGE_TYPES) {
    it(`accepts type: ${type}`, () => {
      const result = validateInboxMessage(validMessage({ type }));
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });
  }
});

// ---------------------------------------------------------------------------
// Optional fields
// ---------------------------------------------------------------------------

describe('inbox message — optional fields', () => {
  it('accepts context string', () => {
    const result = validateInboxMessage(validMessage({ context: 'Some background info' }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects context exceeding maxLength', () => {
    const result = validateInboxMessage(validMessage({ context: 'x'.repeat(5001) }));
    assert.equal(result.valid, false);
  });

  it('accepts sourceTaskId with valid pattern', () => {
    const result = validateInboxMessage(validMessage({ sourceTaskId: 'task-abc-123' }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects sourceTaskId with invalid pattern', () => {
    const result = validateInboxMessage(validMessage({ sourceTaskId: 'invalid-id' }));
    assert.equal(result.valid, false);
  });

  it('accepts processedAt datetime', () => {
    const result = validateInboxMessage(validMessage({ processedAt: new Date().toISOString() }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('accepts completedAt datetime', () => {
    const result = validateInboxMessage(validMessage({ completedAt: new Date().toISOString() }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('accepts result string', () => {
    const result = validateInboxMessage(validMessage({ result: 'Task completed successfully' }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects result exceeding maxLength', () => {
    const result = validateInboxMessage(validMessage({ result: 'x'.repeat(5001) }));
    assert.equal(result.valid, false);
  });

  it('accepts rejectionReason string', () => {
    const result = validateInboxMessage(validMessage({ rejectionReason: 'Not relevant to my goals' }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects rejectionReason exceeding maxLength', () => {
    const result = validateInboxMessage(validMessage({ rejectionReason: 'x'.repeat(1001) }));
    assert.equal(result.valid, false);
  });

  it('accepts a fully populated message with all optional fields', () => {
    const msg = validMessage({
      context: 'Background info',
      sourceTaskId: 'task-origin-123',
      processedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: 'Done',
      rejectionReason: 'N/A',
    });
    const result = validateInboxMessage(msg);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// Inbox queue schema
// ---------------------------------------------------------------------------

describe('inbox queue — validation', () => {
  it('accepts an empty queue', () => {
    const result = validateInboxQueue([]);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('accepts a queue with one valid message', () => {
    const result = validateInboxQueue([validMessage()]);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('accepts a queue with multiple valid messages', () => {
    const queue = [
      validMessage({ id: 'msg-aaa11111' }),
      validMessage({ id: 'msg-bbb22222', status: 'accepted', priority: 'high' }),
      validMessage({ id: 'msg-ccc33333', status: 'completed', type: 'status-update' }),
    ];
    const result = validateInboxQueue(queue);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects a queue with an invalid message', () => {
    const queue = [
      validMessage(),
      { id: 'bad', status: 'pending' }, // missing required fields
    ];
    const result = validateInboxQueue(queue);
    assert.equal(result.valid, false);
  });

  it('rejects a non-array value', () => {
    const result = validateInboxQueue('not-an-array');
    assert.equal(result.valid, false);
  });

  it('rejects a queue containing non-objects', () => {
    const result = validateInboxQueue([42]);
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// createInboxMessage integration — factory produces valid messages
// ---------------------------------------------------------------------------

describe('inbox schema — createInboxMessage integration', () => {
  it('factory creates a schema-valid message with defaults', () => {
    const msg = createInboxMessage('agent-sender-abc123', 'agent-receiver-xyz789', 'Do something');
    const result = validateInboxMessage(msg);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('factory creates a schema-valid message with all opts', () => {
    const msg = createInboxMessage('agent-sender-abc123', 'agent-receiver-xyz789', 'Do something', {
      type: 'status-update',
      priority: 'critical',
      context: 'Urgent work needed',
      sourceTaskId: 'task-origin-abc123',
    });
    const result = validateInboxMessage(msg);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(msg.type, 'status-update');
    assert.equal(msg.priority, 'critical');
    assert.equal(msg.context, 'Urgent work needed');
    assert.equal(msg.sourceTaskId, 'task-origin-abc123');
  });

  it('factory queue of messages validates as inbox queue', () => {
    const queue = [
      createInboxMessage('agent-a-12345678', 'agent-b-12345678', 'Task 1'),
      createInboxMessage('agent-c-12345678', 'agent-b-12345678', 'Task 2', { priority: 'high' }),
    ];
    const result = validateInboxQueue(queue);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});
