/**
 * Tests for the notify skill module.
 *
 * Coverage:
 *   - validateSendParams happy path + every documented failure mode
 *   - sendNotification creates a notification through the storage layer's
 *     send() entry point and returns the auto-populated record
 *   - sender existence enforcement
 *   - free-form fields (link, sourceTaskId, dedupKey, metadata) round-trip
 *   - source=system path with required systemEvent
 *   - source=agent rejects accidental systemEvent
 *   - idempotency on duplicate dedupKey (forwarded from storage)
 *   - formatNotificationResult covers the common output shape
 *   - the skill never persists the notification under the wrong agent dir
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentStore } from '../storage/agent-store.js';
import { NotificationStore } from '../storage/notification-store.js';
import { createAgentConfig } from '../models/agent.js';
import {
  validateSendParams,
  sendNotification,
  formatNotificationResult,
} from './notify.js';

/** Minimal valid agent config for test setup — uses createAgentConfig factory. */
function makeAgent(slug: string): any {
  return createAgentConfig({
    subagentRef: slug,
    weeklyTokenLimit: 100000,
  });
}

let tmpDir: string;
let agentStore: AgentStore;
let notificationStore: NotificationStore;
let SENDER_ID: string;

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), 'notify-skill-test-'));
  agentStore = new AgentStore(tmpDir);
  notificationStore = new NotificationStore(tmpDir);
  const sender = makeAgent('alice');
  await agentStore.save(sender);
  SENDER_ID = sender.id;
}

async function teardown() {
  await rm(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// validateSendParams
// ---------------------------------------------------------------------------

const STATIC_SENDER = 'agent-alice-00000001';

describe('validateSendParams', () => {
  it('returns validated params for a minimal valid input', () => {
    const result = validateSendParams({
      senderSlug: STATIC_SENDER,
      title: 'Hello',
      body: 'World',
    });
    assert.equal(result.senderSlug, STATIC_SENDER);
    assert.equal(result.title, 'Hello');
    assert.equal(result.body, 'World');
    assert.equal(result.source, 'agent');
    assert.equal(result.systemEvent, undefined);
    assert.equal(result.link, undefined);
    assert.equal(result.sourceTaskId, undefined);
    assert.equal(result.dedupKey, undefined);
    assert.equal(result.metadata, undefined);
    assert.equal(result.createdAt, undefined);
  });

  it('throws on missing senderSlug', () => {
    assert.throws(
      () => validateSendParams({ title: 'x', body: 'y' }),
      /senderSlug is required/,
    );
  });

  it('throws on empty senderSlug', () => {
    assert.throws(
      () => validateSendParams({ senderSlug: '', title: 'x', body: 'y' }),
      /senderSlug is required/,
    );
  });

  it('throws on non-string senderSlug', () => {
    assert.throws(
      () =>
        validateSendParams({
          senderSlug: 42 as unknown as string,
          title: 'x',
          body: 'y',
        }),
      /senderSlug is required/,
    );
  });

  it('throws on overly long senderSlug', () => {
    assert.throws(
      () =>
        validateSendParams({
          senderSlug: 'a'.repeat(201),
          title: 'x',
          body: 'y',
        }),
      /senderSlug must not exceed/,
    );
  });

  it('throws on missing title', () => {
    assert.throws(
      () => validateSendParams({ senderSlug: STATIC_SENDER, body: 'y' }),
      /title is required/,
    );
  });

  it('throws on empty title', () => {
    assert.throws(
      () => validateSendParams({ senderSlug: STATIC_SENDER, title: '', body: 'y' }),
      /title is required/,
    );
  });

  it('throws on title over 200 chars', () => {
    assert.throws(
      () =>
        validateSendParams({
          senderSlug: STATIC_SENDER,
          title: 'x'.repeat(201),
          body: 'y',
        }),
      /title must not exceed 200/,
    );
  });

  it('throws on missing body', () => {
    assert.throws(
      () => validateSendParams({ senderSlug: STATIC_SENDER, title: 'x' }),
      /body is required/,
    );
  });

  it('throws on body over 5000 chars', () => {
    assert.throws(
      () =>
        validateSendParams({
          senderSlug: STATIC_SENDER,
          title: 'x',
          body: 'y'.repeat(5001),
        }),
      /body must not exceed 5000/,
    );
  });

  it('throws on unknown source value', () => {
    assert.throws(
      () =>
        validateSendParams({
          senderSlug: STATIC_SENDER,
          title: 'x',
          body: 'y',
          options: { source: 'broadcast' as any },
        }),
      /source must be one of/,
    );
  });

  it('throws when source=system but systemEvent is missing', () => {
    assert.throws(
      () =>
        validateSendParams({
          senderSlug: STATIC_SENDER,
          title: 'x',
          body: 'y',
          options: { source: 'system' },
        }),
      /systemEvent is required/,
    );
  });

  it('throws when source=system but systemEvent is unknown', () => {
    assert.throws(
      () =>
        validateSendParams({
          senderSlug: STATIC_SENDER,
          title: 'x',
          body: 'y',
          options: { source: 'system', systemEvent: 'mystery-event' as any },
        }),
      /systemEvent is required/,
    );
  });

  it('throws when source=agent and systemEvent is supplied', () => {
    assert.throws(
      () =>
        validateSendParams({
          senderSlug: STATIC_SENDER,
          title: 'x',
          body: 'y',
          options: { systemEvent: 'plan-ready' },
        }),
      /reserved for source="system"/,
    );
  });

  it('accepts source=system with systemEvent', () => {
    const result = validateSendParams({
      senderSlug: STATIC_SENDER,
      title: 'x',
      body: 'y',
      options: { source: 'system', systemEvent: 'budget-exhausted' },
    });
    assert.equal(result.source, 'system');
    assert.equal(result.systemEvent, 'budget-exhausted');
  });

  it('throws on dedupKey over 200 chars', () => {
    assert.throws(
      () =>
        validateSendParams({
          senderSlug: STATIC_SENDER,
          title: 'x',
          body: 'y',
          options: { dedupKey: 'k'.repeat(201) },
        }),
      /dedupKey must be a string/,
    );
  });

  it('throws on non-string sourceTaskId', () => {
    assert.throws(
      () =>
        validateSendParams({
          senderSlug: STATIC_SENDER,
          title: 'x',
          body: 'y',
          options: { sourceTaskId: 12345 as unknown as string },
        }),
      /sourceTaskId must be a string/,
    );
  });

  it('throws when metadata is not a plain object', () => {
    assert.throws(
      () =>
        validateSendParams({
          senderSlug: STATIC_SENDER,
          title: 'x',
          body: 'y',
          options: { metadata: ['array', 'not', 'object'] as any },
        }),
      /metadata must be a plain object/,
    );
  });

  it('throws when link is null', () => {
    assert.throws(
      () =>
        validateSendParams({
          senderSlug: STATIC_SENDER,
          title: 'x',
          body: 'y',
          options: { link: null as unknown as string },
        }),
      /link must not be null/,
    );
  });

  it('throws when link is a number', () => {
    assert.throws(
      () =>
        validateSendParams({
          senderSlug: STATIC_SENDER,
          title: 'x',
          body: 'y',
          options: { link: 42 as unknown as string },
        }),
      /link must be a string URL or an object/,
    );
  });

  it('forwards all optional fields when present', () => {
    const result = validateSendParams({
      senderSlug: STATIC_SENDER,
      title: 'x',
      body: 'y',
      options: {
        link: 'https://example.com',
        sourceTaskId: 'task-1',
        dedupKey: 'dedup-1',
        metadata: { priority: 'high' },
        createdAt: '2026-04-17T10:00:00.000Z',
      },
    });
    assert.equal(result.link, 'https://example.com');
    assert.equal(result.sourceTaskId, 'task-1');
    assert.equal(result.dedupKey, 'dedup-1');
    assert.deepEqual(result.metadata, { priority: 'high' });
    assert.equal(result.createdAt, '2026-04-17T10:00:00.000Z');
  });

  it('throws on undefined params', () => {
    assert.throws(() => validateSendParams(), /senderSlug is required/);
  });
});

// ---------------------------------------------------------------------------
// sendNotification — happy path
// ---------------------------------------------------------------------------

describe('sendNotification — happy path', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('persists a minimal agent notification through the store', async () => {
    const result = await sendNotification(
      {
        senderSlug: SENDER_ID,
        title: 'Weekly status',
        body: 'All tasks on track for this week.',
      },
      { agentStore, notificationStore },
    );

    assert.ok(result.id.startsWith('notif-'), `expected notif- prefix, got ${result.id}`);
    assert.equal(result.agentId, SENDER_ID);
    assert.equal(result.source, 'agent');
    assert.equal(result.title, 'Weekly status');
    assert.equal(result.body, 'All tasks on track for this week.');
    assert.equal(result.read, false);
    assert.equal(result.systemEvent, undefined);
    assert.ok(result.createdAt);
    // ISO-8601 sanity check — Date.parse returns NaN when the string is invalid
    assert.ok(Number.isFinite(Date.parse(result.createdAt)));
  });

  it('appears in the recipient agent feed (= the sender feed in v1)', async () => {
    const sent = await sendNotification(
      {
        senderSlug: SENDER_ID,
        title: 'Heads up',
        body: 'Something to report.',
      },
      { agentStore, notificationStore },
    );

    const feed = await notificationStore.load(SENDER_ID);
    assert.equal(feed.length, 1);
    assert.equal(feed[0]?.id, sent.id);
    assert.equal(feed[0]?.read, false);
  });

  it('forwards the optional link / sourceTaskId / dedupKey / metadata', async () => {
    const sent = await sendNotification(
      {
        senderSlug: SENDER_ID,
        title: 'Detailed update',
        body: 'See linked artifact.',
        options: {
          link: { href: 'https://example.com', label: 'Open report', external: true },
          sourceTaskId: 'task-deadbeef',
          dedupKey: 'manual:report:1',
          metadata: { priority: 'high', category: 'review' },
        },
      },
      { agentStore, notificationStore },
    );

    assert.deepEqual(sent.link, {
      href: 'https://example.com',
      label: 'Open report',
      external: true,
    });
    assert.equal(sent.sourceTaskId, 'task-deadbeef');
    assert.equal(sent.dedupKey, 'manual:report:1');
    assert.deepEqual(sent.metadata, { priority: 'high', category: 'review' });
  });

  it('writes the notification under the sender slug directory', async () => {
    const sent = await sendNotification(
      {
        senderSlug: SENDER_ID,
        title: 'On disk',
        body: 'Should land in the sender file.',
      },
      { agentStore, notificationStore },
    );

    const onDisk = await readFile(
      join(tmpDir, SENDER_ID, 'notifications.json'),
      'utf-8',
    );
    const parsed = JSON.parse(onDisk);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, sent.id);
    assert.equal(parsed[0].agentId, SENDER_ID);
  });

  it('honours an explicit createdAt override (used by tests/replay)', async () => {
    const sent = await sendNotification(
      {
        senderSlug: SENDER_ID,
        title: 'Deterministic',
        body: 'Stamped at a known time.',
        options: { createdAt: '2026-04-17T10:00:00.000Z' },
      },
      { agentStore, notificationStore },
    );
    assert.equal(sent.createdAt, '2026-04-17T10:00:00.000Z');
  });

  it('supports source=system with systemEvent', async () => {
    const sent = await sendNotification(
      {
        senderSlug: SENDER_ID,
        title: 'Plan ready',
        body: 'Approve the next-week plan.',
        options: {
          source: 'system',
          systemEvent: 'plan-ready',
          dedupKey: `plan-ready:${SENDER_ID}:2026-W17`,
        },
      },
      { agentStore, notificationStore },
    );
    assert.equal(sent.source, 'system');
    assert.equal(sent.systemEvent, 'plan-ready');
  });
});

// ---------------------------------------------------------------------------
// sendNotification — sender existence enforcement
// ---------------------------------------------------------------------------

describe('sendNotification — sender existence', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('throws when sender agent does not exist', async () => {
    await assert.rejects(
      () =>
        sendNotification(
          {
            senderSlug: 'agent-ghost-99999999',
            title: 'Hello',
            body: 'World',
          },
          { agentStore, notificationStore },
        ),
      /Sender agent not found/,
    );
  });

  it('does not write to the notifications feed when sender does not exist', async () => {
    try {
      await sendNotification(
        {
          senderSlug: 'agent-ghost-99999999',
          title: 'Hello',
          body: 'World',
        },
        { agentStore, notificationStore },
      );
    } catch {
      // expected
    }
    const feed = await notificationStore.load('agent-ghost-99999999');
    assert.equal(feed.length, 0);
  });

  it('skipSenderCheck=true bypasses the registry probe (test/diagnostics path)', async () => {
    // No agent created; should still persist when skipSenderCheck is on.
    const sent = await sendNotification(
      {
        senderSlug: 'agent-skip-12345678',
        title: 'Diagnostic',
        body: 'Bypass enabled.',
      },
      { notificationStore, skipSenderCheck: true },
    );
    assert.ok(sent.id.startsWith('notif-'));
    assert.equal(sent.agentId, 'agent-skip-12345678');
  });
});

// ---------------------------------------------------------------------------
// sendNotification — idempotency forwarded from the storage layer
// ---------------------------------------------------------------------------

describe('sendNotification — idempotency through storage', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('multiple distinct sends produce multiple notifications', async () => {
    await sendNotification(
      {
        senderSlug: SENDER_ID,
        title: 'First',
        body: 'one',
      },
      { agentStore, notificationStore },
    );
    await sendNotification(
      {
        senderSlug: SENDER_ID,
        title: 'Second',
        body: 'two',
      },
      { agentStore, notificationStore },
    );

    const feed = await notificationStore.load(SENDER_ID);
    assert.equal(feed.length, 2);
    assert.notEqual(feed[0]?.id, feed[1]?.id);
  });

  it('an unread dedupKey collision is a no-op (single feed entry)', async () => {
    await sendNotification(
      {
        senderSlug: SENDER_ID,
        title: 'Plan ready',
        body: 'first emit',
        options: {
          source: 'system',
          systemEvent: 'plan-ready',
          dedupKey: `plan-ready:${SENDER_ID}:2026-W17`,
        },
      },
      { agentStore, notificationStore },
    );

    // Same dedupKey while the previous one is still unread → suppressed.
    await sendNotification(
      {
        senderSlug: SENDER_ID,
        title: 'Plan ready (re-emit)',
        body: 'second emit',
        options: {
          source: 'system',
          systemEvent: 'plan-ready',
          dedupKey: `plan-ready:${SENDER_ID}:2026-W17`,
        },
      },
      { agentStore, notificationStore },
    );

    const feed = await notificationStore.load(SENDER_ID);
    assert.equal(feed.length, 1);
    assert.equal(feed[0]?.body, 'first emit');
  });
});

// ---------------------------------------------------------------------------
// formatNotificationResult
// ---------------------------------------------------------------------------

describe('formatNotificationResult', () => {
  it('formats a basic agent notification summary', () => {
    const output = formatNotificationResult({
      id: 'notif-abc12345',
      agentId: 'alice-12345678',
      source: 'agent',
      title: 'Hello',
      body: 'World',
      createdAt: '2026-04-17T10:00:00.000Z',
      read: false,
    });
    assert.ok(output.includes('Notification sent successfully'));
    assert.ok(output.includes('notif-abc12345'));
    assert.ok(output.includes('alice-12345678'));
    assert.ok(output.includes('agent'));
    assert.ok(output.includes('Hello'));
    assert.ok(output.includes('World'));
    assert.ok(output.includes('false'));
    assert.ok(output.includes('2026-04-17T10:00:00.000Z'));
  });

  it('includes systemEvent + dedupKey when present', () => {
    const output = formatNotificationResult({
      id: 'notif-sys00001',
      agentId: 'bob-00000001',
      source: 'system',
      systemEvent: 'plan-ready',
      title: 'Plan ready',
      body: 'Approve.',
      createdAt: '2026-04-17T10:00:00.000Z',
      read: false,
      dedupKey: 'plan-ready:bob:2026-W17',
    });
    assert.ok(output.includes('System Event: plan-ready'));
    assert.ok(output.includes('Dedup Key: plan-ready:bob:2026-W17'));
  });

  it('includes a bare-string link', () => {
    const output = formatNotificationResult({
      id: 'notif-l000001',
      agentId: 'alice-12345678',
      source: 'agent',
      title: 'See here',
      body: 'Linkable.',
      createdAt: '2026-04-17T10:00:00.000Z',
      read: false,
      link: 'https://example.com/x',
    });
    assert.ok(output.includes('Link: https://example.com/x'));
  });

  it('includes an object-link href', () => {
    const output = formatNotificationResult({
      id: 'notif-l000002',
      agentId: 'alice-12345678',
      source: 'agent',
      title: 'Labelled link',
      body: 'Linkable.',
      createdAt: '2026-04-17T10:00:00.000Z',
      read: false,
      link: { href: 'https://example.com/y', label: 'Open report', external: true },
    });
    assert.ok(output.includes('Link: https://example.com/y'));
  });

  it('includes sourceTaskId when present', () => {
    const output = formatNotificationResult({
      id: 'notif-trace01',
      agentId: 'alice-12345678',
      source: 'agent',
      title: 'Trace',
      body: 'Ref task.',
      createdAt: '2026-04-17T10:00:00.000Z',
      read: false,
      sourceTaskId: 'task-origin-1',
    });
    assert.ok(output.includes('Source Task: task-origin-1'));
  });
});
