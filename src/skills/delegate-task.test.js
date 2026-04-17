/**
 * Tests for delegate-task skill — inter-agent task delegation.
 * Covers: parameter validation, agent existence checks, message construction,
 * inbox enqueue (idempotent), optional fields, self-delegation rejection,
 * and human-friendly formatting.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentStore } from '../storage/agent-store.js';
import { InboxStore } from '../storage/inbox-store.js';
import { createAgentConfig } from '../models/agent.js';
import {
  validateDelegationParams,
  delegateTask,
  formatDelegationResult,
} from './delegate-task.js';

/** Minimal valid agent config for test setup — uses createAgentConfig factory */
function makeAgent(name) {
  return createAgentConfig({
    name,
    role: 'test-role',
    systemPrompt: 'You are a test agent.',
    weeklyTokenLimit: 100000,
  });
}

let tmpDir, agentStore, inboxStore, AGENT_A_ID, AGENT_B_ID;

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), 'delegate-task-test-'));
  agentStore = new AgentStore(tmpDir);
  inboxStore = new InboxStore(tmpDir);
  // Seed two agents — IDs are generated dynamically
  const agentA = makeAgent('Alice');
  const agentB = makeAgent('Bob');
  await agentStore.save(agentA);
  await agentStore.save(agentB);
  AGENT_A_ID = agentA.id;
  AGENT_B_ID = agentB.id;
}

async function teardown() {
  await rm(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// validateDelegationParams
// ---------------------------------------------------------------------------

// Static IDs for pure validation tests (no store needed)
const STATIC_A = 'agent-alice-00000001';
const STATIC_B = 'agent-bob-00000002';

describe('validateDelegationParams', () => {
  it('returns validated params for valid input', () => {
    const result = validateDelegationParams({
      fromAgentId: STATIC_A,
      toAgentId: STATIC_B,
      taskDescription: 'Write a report',
    });
    assert.equal(result.fromAgentId, STATIC_A);
    assert.equal(result.toAgentId, STATIC_B);
    assert.equal(result.taskDescription, 'Write a report');
  });

  it('throws on missing fromAgentId', () => {
    assert.throws(
      () => validateDelegationParams({ toAgentId: STATIC_B, taskDescription: 'x' }),
      /fromAgentId is required/
    );
  });

  it('throws on missing toAgentId', () => {
    assert.throws(
      () => validateDelegationParams({ fromAgentId: STATIC_A, taskDescription: 'x' }),
      /toAgentId is required/
    );
  });

  it('throws on missing taskDescription', () => {
    assert.throws(
      () => validateDelegationParams({ fromAgentId: STATIC_A, toAgentId: STATIC_B }),
      /taskDescription is required/
    );
  });

  it('throws on empty taskDescription string', () => {
    assert.throws(
      () =>
        validateDelegationParams({
          fromAgentId: STATIC_A,
          toAgentId: STATIC_B,
          taskDescription: '',
        }),
      /taskDescription is required/
    );
  });

  it('throws when taskDescription exceeds 2000 characters', () => {
    assert.throws(
      () =>
        validateDelegationParams({
          fromAgentId: STATIC_A,
          toAgentId: STATIC_B,
          taskDescription: 'x'.repeat(2001),
        }),
      /must not exceed 2000/
    );
  });

  it('throws when delegating to self', () => {
    assert.throws(
      () =>
        validateDelegationParams({
          fromAgentId: STATIC_A,
          toAgentId: STATIC_A,
          taskDescription: 'Do thing',
        }),
      /cannot delegate.*itself/i
    );
  });

  it('throws on undefined params', () => {
    assert.throws(() => validateDelegationParams(), /fromAgentId is required/);
  });
});

// ---------------------------------------------------------------------------
// delegateTask — happy path
// ---------------------------------------------------------------------------

describe('delegateTask — happy path', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('creates and enqueues a task-delegation message', async () => {
    const result = await delegateTask(
      {
        fromAgentId: AGENT_A_ID,
        toAgentId: AGENT_B_ID,
        taskDescription: 'Summarize the weekly metrics',
      },
      { agentStore, inboxStore }
    );

    assert.ok(result.id.startsWith('msg-'));
    assert.equal(result.from, AGENT_A_ID);
    assert.equal(result.to, AGENT_B_ID);
    assert.equal(result.type, 'task-delegation');
    assert.equal(result.taskDescription, 'Summarize the weekly metrics');
    assert.equal(result.priority, 'medium');
    assert.equal(result.status, 'pending');
    assert.ok(result.createdAt);
  });

  it('message appears in recipient inbox', async () => {
    const msg = await delegateTask(
      {
        fromAgentId: AGENT_A_ID,
        toAgentId: AGENT_B_ID,
        taskDescription: 'Check logs',
      },
      { agentStore, inboxStore }
    );

    const inbox = await inboxStore.load(AGENT_B_ID);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].id, msg.id);
    assert.equal(inbox[0].status, 'pending');
  });

  it('supports custom priority', async () => {
    const result = await delegateTask(
      {
        fromAgentId: AGENT_A_ID,
        toAgentId: AGENT_B_ID,
        taskDescription: 'Urgent fix',
        options: { priority: 'critical' },
      },
      { agentStore, inboxStore }
    );
    assert.equal(result.priority, 'critical');
  });

  it('supports context field', async () => {
    const result = await delegateTask(
      {
        fromAgentId: AGENT_A_ID,
        toAgentId: AGENT_B_ID,
        taskDescription: 'Review PR',
        options: { context: 'PR #42 has failing tests in CI' },
      },
      { agentStore, inboxStore }
    );
    assert.equal(result.context, 'PR #42 has failing tests in CI');
  });

  it('supports sourceTaskId for traceability', async () => {
    const result = await delegateTask(
      {
        fromAgentId: AGENT_A_ID,
        toAgentId: AGENT_B_ID,
        taskDescription: 'Deploy service',
        options: { sourceTaskId: 'task-abc12345' },
      },
      { agentStore, inboxStore }
    );
    assert.equal(result.sourceTaskId, 'task-abc12345');
  });
});

// ---------------------------------------------------------------------------
// delegateTask — idempotent
// ---------------------------------------------------------------------------

describe('delegateTask — idempotent enqueue', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('multiple delegations produce multiple unique messages', async () => {
    await delegateTask(
      { fromAgentId: AGENT_A_ID, toAgentId: AGENT_B_ID, taskDescription: 'Task one' },
      { agentStore, inboxStore }
    );
    await delegateTask(
      { fromAgentId: AGENT_A_ID, toAgentId: AGENT_B_ID, taskDescription: 'Task two' },
      { agentStore, inboxStore }
    );

    const inbox = await inboxStore.load(AGENT_B_ID);
    assert.equal(inbox.length, 2);
    assert.notEqual(inbox[0].id, inbox[1].id);
  });

  it('enqueuing the same message object twice is a no-op', async () => {
    const msg = await delegateTask(
      { fromAgentId: AGENT_A_ID, toAgentId: AGENT_B_ID, taskDescription: 'Once only' },
      { agentStore, inboxStore }
    );

    // Re-enqueue the exact message directly
    await inboxStore.enqueue(AGENT_B_ID, msg);
    const inbox = await inboxStore.load(AGENT_B_ID);
    assert.equal(inbox.length, 1);
  });
});

// ---------------------------------------------------------------------------
// delegateTask — agent existence validation
// ---------------------------------------------------------------------------

describe('delegateTask — agent existence checks', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('throws when sender agent does not exist', async () => {
    await assert.rejects(
      () =>
        delegateTask(
          {
            fromAgentId: 'agent-nonexistent-99',
            toAgentId: AGENT_B_ID,
            taskDescription: 'Hello',
          },
          { agentStore, inboxStore }
        ),
      /Sender agent not found/
    );
  });

  it('throws when target agent does not exist', async () => {
    await assert.rejects(
      () =>
        delegateTask(
          {
            fromAgentId: AGENT_A_ID,
            toAgentId: 'agent-ghost-99999999',
            taskDescription: 'Hello',
          },
          { agentStore, inboxStore }
        ),
      /Target agent not found/
    );
  });

  it('does not write to inbox when target does not exist', async () => {
    try {
      await delegateTask(
        {
          fromAgentId: AGENT_A_ID,
          toAgentId: 'agent-ghost-99999999',
          taskDescription: 'Hello',
        },
        { agentStore, inboxStore }
      );
    } catch {
      // expected
    }
    // Inbox should remain empty for a nonexistent agent directory
    const inbox = await inboxStore.load('agent-ghost-99999999');
    assert.equal(inbox.length, 0);
  });
});

// ---------------------------------------------------------------------------
// formatDelegationResult
// ---------------------------------------------------------------------------

describe('formatDelegationResult', () => {
  it('formats a basic delegation summary', () => {
    const msg = {
      id: 'msg-abc123',
      from: AGENT_A_ID,
      to: AGENT_B_ID,
      type: 'task-delegation',
      taskDescription: 'Run the tests',
      priority: 'high',
      status: 'pending',
      createdAt: '2026-04-17T10:00:00.000Z',
    };
    const output = formatDelegationResult(msg);
    assert.ok(output.includes('Task delegated successfully'));
    assert.ok(output.includes('msg-abc123'));
    assert.ok(output.includes(AGENT_A_ID));
    assert.ok(output.includes(AGENT_B_ID));
    assert.ok(output.includes('high'));
    assert.ok(output.includes('Run the tests'));
    assert.ok(output.includes('pending'));
  });

  it('includes context when present', () => {
    const msg = {
      id: 'msg-xyz789',
      from: AGENT_A_ID,
      to: AGENT_B_ID,
      type: 'task-delegation',
      taskDescription: 'Fix it',
      priority: 'medium',
      context: 'The build is broken',
      status: 'pending',
      createdAt: '2026-04-17T10:00:00.000Z',
    };
    const output = formatDelegationResult(msg);
    assert.ok(output.includes('The build is broken'));
  });

  it('includes sourceTaskId when present', () => {
    const msg = {
      id: 'msg-src001',
      from: AGENT_A_ID,
      to: AGENT_B_ID,
      type: 'task-delegation',
      taskDescription: 'Deploy',
      priority: 'low',
      sourceTaskId: 'task-origintask1',
      status: 'pending',
      createdAt: '2026-04-17T10:00:00.000Z',
    };
    const output = formatDelegationResult(msg);
    assert.ok(output.includes('task-origintask1'));
  });
});
