/**
 * Tests for ChatConversationStore — file-based per-thread persistence
 * for the floating chat panel.
 *
 * Covers: factory output, read (missing / valid / corrupt-via-direct-edit),
 * write (validation + atomic rename), list (sorting + limit + tmp-file
 * skipping), listSummaries, appendMessage (idempotent + bumps updatedAt),
 * setTitle, delete (idempotent), agent-mismatch guard, and the
 * forward-compatible metadata bag.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ChatConversationStore,
  createChatConversation,
  createChatMessage,
  type ChatConversationListOptions,
} from './chat-conversation-store.js';
import type { ChatConversation, ChatMessage } from '../schemas/chat-conversation.js';

const AGENT_A = 'agent-alice';
const AGENT_B = 'agent-bob';

let tmpDir: string;
let store: ChatConversationStore;

async function setup(): Promise<void> {
  tmpDir = await mkdtemp(join(tmpdir(), 'chat-conv-store-test-'));
  store = new ChatConversationStore(tmpDir);
}

async function teardown(): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

describe('createChatConversation', () => {
  it('produces a schema-valid conversation with empty messages', () => {
    const conv = createChatConversation({ agentId: AGENT_A });
    assert.match(conv.id, /^chat-[a-f0-9]+$/);
    assert.equal(conv.agentId, AGENT_A);
    assert.deepEqual(conv.messages, []);
    assert.equal(typeof conv.createdAt, 'string');
    assert.equal(conv.createdAt, conv.updatedAt);
    assert.equal(conv.title, undefined);
  });

  it('honors the optional title and timestamp overrides', () => {
    const ts = '2026-04-13T00:00:00.000Z';
    const conv = createChatConversation({
      agentId: AGENT_A,
      title: 'Brainstorm',
      createdAt: ts,
      metadata: { pinned: true },
    });
    assert.equal(conv.title, 'Brainstorm');
    assert.equal(conv.createdAt, ts);
    assert.equal(conv.updatedAt, ts);
    assert.deepEqual(conv.metadata, { pinned: true });
  });
});

describe('createChatMessage', () => {
  it('produces a schema-valid message with auto id and timestamp', () => {
    const msg = createChatMessage({ role: 'user', content: 'hi' });
    assert.match(msg.id, /^msg-[a-f0-9]+$/);
    assert.equal(msg.role, 'user');
    assert.equal(msg.content, 'hi');
    assert.equal(typeof msg.createdAt, 'string');
  });

  it('honors id, createdAt, tools, metadata overrides', () => {
    const msg = createChatMessage({
      id: 'msg-custom',
      role: 'assistant',
      content: 'ran a tool',
      createdAt: '2026-04-13T00:00:00.000Z',
      tools: [
        {
          type: 'tool_use',
          toolUseId: 'tu_1',
          name: 'Read',
          input: { path: '/etc/hosts' },
        },
      ],
      metadata: { model: 'sonnet-4.5' },
    });
    assert.equal(msg.id, 'msg-custom');
    assert.equal(msg.tools?.length, 1);
    assert.deepEqual(msg.metadata, { model: 'sonnet-4.5' });
  });
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe('ChatConversationStore — read', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns null when the file does not exist', async () => {
    assert.equal(await store.read(AGENT_A, 'chat-missing'), null);
  });

  it('returns null when the agent directory does not exist', async () => {
    assert.equal(await store.read('agent-nope', 'chat-anything'), null);
  });

  it('round-trips a written conversation with full fidelity', async () => {
    const conv = createChatConversation({ agentId: AGENT_A, title: 'Demo' });
    conv.messages.push(createChatMessage({ role: 'user', content: 'hi' }));
    await store.write(AGENT_A, conv);

    const loaded = await store.read(AGENT_A, conv.id);
    assert.deepEqual(loaded, conv);
  });

  it('rejects a corrupt thread file (validates on load)', async () => {
    const conv = createChatConversation({ agentId: AGENT_A });
    await store.write(AGENT_A, conv);
    // Hand-edit the file to break required field
    await writeFile(
      store._filePath(AGENT_A, conv.id),
      JSON.stringify({ id: conv.id, agentId: AGENT_A }) + '\n',
      'utf-8',
    );
    await assert.rejects(
      () => store.read(AGENT_A, conv.id),
      /Schema validation failed/,
    );
  });
});

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

describe('ChatConversationStore — write', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('persists a conversation to .aweek/agents/<slug>/chat/<id>.json', async () => {
    const conv = createChatConversation({ agentId: AGENT_A });
    await store.write(AGENT_A, conv);
    const expected = join(tmpDir, AGENT_A, 'chat', `${conv.id}.json`);
    const raw = await readFile(expected, 'utf-8');
    assert.equal(JSON.parse(raw).id, conv.id);
  });

  it('rejects a payload that fails schema validation', async () => {
    const bad = {
      id: 'chat-bad',
      agentId: AGENT_A,
      // messages, createdAt, updatedAt missing on purpose
    } as unknown as ChatConversation;
    await assert.rejects(
      () => store.write(AGENT_A, bad),
      /Schema validation failed/,
    );
  });

  it('rejects an id that does not match the schema pattern', async () => {
    const bad = createChatConversation({ agentId: AGENT_A });
    bad.id = 'NotAValidId';
    await assert.rejects(
      () => store.write(AGENT_A, bad),
      /Schema validation failed/,
    );
  });

  it('rejects an agent mismatch between the directory and the payload', async () => {
    const conv = createChatConversation({ agentId: AGENT_B });
    await assert.rejects(
      () => store.write(AGENT_A, conv),
      /agent mismatch/,
    );
  });

  it('does not leave a partial file when validation fails', async () => {
    // Ensure the chat directory exists from a prior valid write so any
    // stray tmp file would actually be visible.
    const ok = createChatConversation({ agentId: AGENT_A });
    await store.write(AGENT_A, ok);

    const bad = createChatConversation({ agentId: AGENT_A });
    (bad as unknown as { messages: unknown }).messages = 'not-an-array';
    await assert.rejects(() => store.write(AGENT_A, bad), /Schema validation failed/);

    const files = await readdir(join(tmpDir, AGENT_A, 'chat'));
    // Only the one valid file (ok.id) should remain — no .tmp-* trash.
    assert.deepEqual(
      files.sort(),
      [`${ok.id}.json`],
    );
  });

  it('overwrites with last-writer-wins on the same id', async () => {
    const conv = createChatConversation({ agentId: AGENT_A, title: 'First' });
    await store.write(AGENT_A, conv);
    const updated: ChatConversation = { ...conv, title: 'Second', updatedAt: new Date().toISOString() };
    await store.write(AGENT_A, updated);
    const loaded = await store.read(AGENT_A, conv.id);
    assert.equal(loaded?.title, 'Second');
  });
});

// ---------------------------------------------------------------------------
// List & summaries
// ---------------------------------------------------------------------------

describe('ChatConversationStore — list', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns [] when no chat directory exists', async () => {
    assert.deepEqual(await store.list('agent-nope'), []);
  });

  it('returns [] for an agent with an empty chat dir', async () => {
    await store.init(AGENT_A);
    assert.deepEqual(await store.list(AGENT_A), []);
  });

  it('sorts updatedAt-desc by default', async () => {
    const a = createChatConversation({
      agentId: AGENT_A,
      createdAt: '2026-04-10T00:00:00.000Z',
    });
    a.updatedAt = '2026-04-11T00:00:00.000Z';
    const b = createChatConversation({
      agentId: AGENT_A,
      createdAt: '2026-04-12T00:00:00.000Z',
    });
    b.updatedAt = '2026-04-12T05:00:00.000Z';
    const c = createChatConversation({
      agentId: AGENT_A,
      createdAt: '2026-04-09T00:00:00.000Z',
    });
    c.updatedAt = '2026-04-13T00:00:00.000Z';

    await store.write(AGENT_A, a);
    await store.write(AGENT_A, b);
    await store.write(AGENT_A, c);

    const list = await store.list(AGENT_A);
    assert.deepEqual(
      list.map((x) => x.id),
      [c.id, b.id, a.id],
    );
  });

  it('honors createdAt-asc sort and limit', async () => {
    const a = createChatConversation({
      agentId: AGENT_A,
      createdAt: '2026-04-10T00:00:00.000Z',
    });
    const b = createChatConversation({
      agentId: AGENT_A,
      createdAt: '2026-04-12T00:00:00.000Z',
    });
    const c = createChatConversation({
      agentId: AGENT_A,
      createdAt: '2026-04-09T00:00:00.000Z',
    });
    await store.write(AGENT_A, a);
    await store.write(AGENT_A, b);
    await store.write(AGENT_A, c);

    const opts: ChatConversationListOptions = { sort: 'createdAt-asc', limit: 2 };
    const list = await store.list(AGENT_A, opts);
    assert.deepEqual(
      list.map((x) => x.id),
      [c.id, a.id],
    );
  });

  it('skips files that do not match the conversation id pattern', async () => {
    const conv = createChatConversation({ agentId: AGENT_A });
    await store.write(AGENT_A, conv);
    // Plant a stray file that ends in .json but does not match the id pattern
    const dir = join(tmpDir, AGENT_A, 'chat');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'README.json'), '{}', 'utf-8');
    await writeFile(join(dir, 'chat-x.json.tmp-1234-abcd'), '{}', 'utf-8');

    const list = await store.list(AGENT_A);
    assert.deepEqual(list.map((x) => x.id), [conv.id]);
  });

  it('isolates threads per agent', async () => {
    const a = createChatConversation({ agentId: AGENT_A });
    const b = createChatConversation({ agentId: AGENT_B });
    await store.write(AGENT_A, a);
    await store.write(AGENT_B, b);

    const aList = await store.list(AGENT_A);
    const bList = await store.list(AGENT_B);
    assert.deepEqual(aList.map((x) => x.id), [a.id]);
    assert.deepEqual(bList.map((x) => x.id), [b.id]);
  });
});

describe('ChatConversationStore — listSummaries', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('exposes title, message count, and last-message preview', async () => {
    const conv = createChatConversation({ agentId: AGENT_A, title: 'Demo' });
    conv.messages.push(createChatMessage({ role: 'user', content: 'hi' }));
    conv.messages.push(createChatMessage({ role: 'assistant', content: 'hello!' }));
    await store.write(AGENT_A, conv);

    const [summary] = await store.listSummaries(AGENT_A);
    assert.ok(summary);
    assert.equal(summary.id, conv.id);
    assert.equal(summary.title, 'Demo');
    assert.equal(summary.messageCount, 2);
    assert.equal(summary.lastMessageRole, 'assistant');
    assert.equal(summary.lastMessagePreview, 'hello!');
  });

  it('truncates long previews', async () => {
    const conv = createChatConversation({ agentId: AGENT_A });
    const longText = 'x'.repeat(500);
    conv.messages.push(createChatMessage({ role: 'user', content: longText }));
    await store.write(AGENT_A, conv);

    const [summary] = await store.listSummaries(AGENT_A);
    assert.ok(summary);
    assert.ok(summary.lastMessagePreview);
    assert.ok(summary.lastMessagePreview!.length <= 200);
    assert.ok(summary.lastMessagePreview!.endsWith('…'));
  });
});

// ---------------------------------------------------------------------------
// appendMessage
// ---------------------------------------------------------------------------

describe('ChatConversationStore — appendMessage', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('appends a message and bumps updatedAt', async () => {
    const conv = createChatConversation({
      agentId: AGENT_A,
      createdAt: '2026-04-10T00:00:00.000Z',
    });
    await store.write(AGENT_A, conv);

    const msg = createChatMessage({ role: 'user', content: 'hi' });
    const after = await store.appendMessage(AGENT_A, conv.id, msg);
    assert.equal(after.messages.length, 1);
    assert.equal(after.messages[0]?.id, msg.id);
    assert.notEqual(after.updatedAt, conv.updatedAt);
  });

  it('is idempotent on message id', async () => {
    const conv = createChatConversation({ agentId: AGENT_A });
    await store.write(AGENT_A, conv);

    const msg = createChatMessage({ role: 'user', content: 'hi' });
    await store.appendMessage(AGENT_A, conv.id, msg);
    const second = await store.appendMessage(AGENT_A, conv.id, msg);
    assert.equal(second.messages.length, 1);
  });

  it('throws when the conversation does not exist', async () => {
    const msg = createChatMessage({ role: 'user', content: 'hi' });
    await assert.rejects(
      () => store.appendMessage(AGENT_A, 'chat-missing', msg),
      /not found/,
    );
  });

  it('rejects an invalid message via schema validation', async () => {
    const conv = createChatConversation({ agentId: AGENT_A });
    await store.write(AGENT_A, conv);
    const bad = { id: 'msg-bad', role: 'system', content: 'oops' } as unknown as ChatMessage;
    await assert.rejects(
      () => store.appendMessage(AGENT_A, conv.id, bad),
      /Schema validation failed/,
    );
  });

  it('preserves message ordering when appending sequentially', async () => {
    const conv = createChatConversation({ agentId: AGENT_A });
    await store.write(AGENT_A, conv);

    const m1 = createChatMessage({ role: 'user', content: 'first' });
    const m2 = createChatMessage({ role: 'assistant', content: 'second' });
    const m3 = createChatMessage({ role: 'user', content: 'third' });
    await store.appendMessage(AGENT_A, conv.id, m1);
    await store.appendMessage(AGENT_A, conv.id, m2);
    const after = await store.appendMessage(AGENT_A, conv.id, m3);

    assert.deepEqual(
      after.messages.map((m) => m.id),
      [m1.id, m2.id, m3.id],
    );
  });
});

// ---------------------------------------------------------------------------
// setTitle
// ---------------------------------------------------------------------------

describe('ChatConversationStore — setTitle', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('updates the title and bumps updatedAt', async () => {
    const conv = createChatConversation({
      agentId: AGENT_A,
      createdAt: '2026-04-10T00:00:00.000Z',
    });
    await store.write(AGENT_A, conv);

    const after = await store.setTitle(AGENT_A, conv.id, 'Renamed');
    assert.equal(after.title, 'Renamed');
    assert.notEqual(after.updatedAt, conv.updatedAt);
  });

  it('clears the title when called with an empty string', async () => {
    const conv = createChatConversation({ agentId: AGENT_A, title: 'Original' });
    await store.write(AGENT_A, conv);

    const after = await store.setTitle(AGENT_A, conv.id, '');
    assert.equal(after.title, undefined);
  });

  it('throws when the conversation does not exist', async () => {
    await assert.rejects(
      () => store.setTitle(AGENT_A, 'chat-missing', 'nope'),
      /not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe('ChatConversationStore — delete', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('removes the on-disk file and returns true', async () => {
    const conv = createChatConversation({ agentId: AGENT_A });
    await store.write(AGENT_A, conv);

    const removed = await store.delete(AGENT_A, conv.id);
    assert.equal(removed, true);
    assert.equal(await store.read(AGENT_A, conv.id), null);
  });

  it('is idempotent on a missing id', async () => {
    const removed = await store.delete(AGENT_A, 'chat-missing');
    assert.equal(removed, false);
  });

  it('only deletes the targeted thread', async () => {
    const a = createChatConversation({ agentId: AGENT_A });
    const b = createChatConversation({ agentId: AGENT_A });
    await store.write(AGENT_A, a);
    await store.write(AGENT_A, b);

    await store.delete(AGENT_A, a.id);
    const list = await store.list(AGENT_A);
    assert.deepEqual(list.map((x) => x.id), [b.id]);
  });
});
