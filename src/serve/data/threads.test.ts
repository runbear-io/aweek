/**
 * Tests for the thread (chat-conversation) data handler module
 * (AC 40101 sub-AC 1).
 *
 * Exercises {@link listThreads}, {@link createThread}, {@link renameThread},
 * and {@link deleteThread} against a tmp `.aweek/` so the storage
 * plumbing wires up end-to-end. Mirrors the testing style of
 * `agent-notifications.test.ts` (a sibling per-agent gatherer): each
 * test seeds a minimal fixture project, exercises the handler, then
 * cleans up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createThread,
  deleteThread,
  getThread,
  listThreads,
  renameThread,
} from './threads.js';
import { AgentStore } from '../../storage/agent-store.js';
import { ChatConversationStore } from '../../storage/chat-conversation-store.js';
import { createAgentConfig } from '../../models/agent.js';

const SLUG = 'thread-test-agent';
const OTHER_SLUG = 'other-agent';

async function setupProject(): Promise<{
  projectDir: string;
  cleanup: () => Promise<void>;
}> {
  const projectDir = await mkdtemp(join(tmpdir(), 'aweek-threads-data-'));
  const agentsDir = join(projectDir, '.aweek', 'agents');
  await mkdir(agentsDir, { recursive: true });
  return {
    projectDir,
    cleanup: () => rm(projectDir, { recursive: true, force: true }),
  };
}

async function seedAgent(projectDir: string, slug: string): Promise<void> {
  // Use the canonical AgentStore + createAgentConfig so the on-disk JSON
  // satisfies schema validation in `listAllAgentsPartial`. A hand-rolled
  // stub will end up in the partial-load `errors` bucket and the gatherer
  // will treat the slug as missing (returning null).
  const dir = join(projectDir, '.aweek', 'agents');
  await mkdir(dir, { recursive: true });
  const store = new AgentStore(dir);
  const config = createAgentConfig({ subagentRef: slug });
  await store.save(config);
}

// ---------------------------------------------------------------------------
// listThreads
// ---------------------------------------------------------------------------

test('listThreads: returns null when slug missing on disk', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    const result = await listThreads({
      projectDir,
      agentId: 'no-such-agent',
    });
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

test('listThreads: returns empty list when agent exists but has no threads', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    const result = await listThreads({ projectDir, agentId: SLUG });
    assert.ok(result, 'expected non-null payload');
    assert.equal(result.agentId, SLUG);
    assert.deepEqual(result.threads, []);
  } finally {
    await cleanup();
  }
});

test('listThreads: surfaces summaries newest-first by default', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    // Seed two threads via createThread to exercise the round-trip.
    const first = await createThread({
      projectDir,
      agentId: SLUG,
      title: 'first',
    });
    assert.ok(first, 'expected create to succeed');
    // Force a small delay so updatedAt timestamps differ.
    await new Promise((r) => setTimeout(r, 5));
    const second = await createThread({
      projectDir,
      agentId: SLUG,
      title: 'second',
    });
    assert.ok(second, 'expected create to succeed');

    const result = await listThreads({ projectDir, agentId: SLUG });
    assert.ok(result);
    assert.equal(result.threads.length, 2);
    // Default sort is updatedAt-desc — newer thread surfaces first.
    assert.equal(result.threads[0]?.title, 'second');
    assert.equal(result.threads[1]?.title, 'first');
  } finally {
    await cleanup();
  }
});

test('listThreads: honors limit option', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    await createThread({ projectDir, agentId: SLUG, title: 'a' });
    await createThread({ projectDir, agentId: SLUG, title: 'b' });
    await createThread({ projectDir, agentId: SLUG, title: 'c' });

    const result = await listThreads({
      projectDir,
      agentId: SLUG,
      limit: 2,
    });
    assert.ok(result);
    assert.equal(result.threads.length, 2);
  } finally {
    await cleanup();
  }
});

test('listThreads: requires projectDir and agentId', async () => {
  await assert.rejects(
    () => listThreads({ agentId: SLUG }),
    /projectDir is required/,
  );
  await assert.rejects(
    () => listThreads({ projectDir: '/tmp' }),
    /agentId is required/,
  );
});

// ---------------------------------------------------------------------------
// createThread
// ---------------------------------------------------------------------------

test('createThread: returns null when slug missing on disk', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    const result = await createThread({
      projectDir,
      agentId: 'no-such-agent',
      title: 'will not persist',
    });
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

test('createThread: persists a new thread with auto id and timestamps', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    const result = await createThread({
      projectDir,
      agentId: SLUG,
      title: 'Brainstorm',
    });
    assert.ok(result, 'expected non-null payload');
    assert.match(result.thread.id, /^chat-[a-f0-9]+$/);
    assert.equal(result.thread.agentId, SLUG);
    assert.equal(result.thread.title, 'Brainstorm');
    assert.deepEqual(result.thread.messages, []);
    assert.equal(typeof result.thread.createdAt, 'string');
    assert.equal(result.thread.createdAt, result.thread.updatedAt);

    // Round-trip through the store to confirm it landed on disk.
    const agentsDir = join(projectDir, '.aweek', 'agents');
    const store = new ChatConversationStore(agentsDir);
    const onDisk = await store.read(SLUG, result.thread.id);
    assert.ok(onDisk);
    assert.equal(onDisk.title, 'Brainstorm');
  } finally {
    await cleanup();
  }
});

test('createThread: persists a thread with no title when title omitted', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    const result = await createThread({ projectDir, agentId: SLUG });
    assert.ok(result);
    assert.equal(result.thread.title, undefined);
  } finally {
    await cleanup();
  }
});

test('createThread: requires projectDir and agentId', async () => {
  await assert.rejects(
    () => createThread({ agentId: SLUG }),
    /projectDir is required/,
  );
  await assert.rejects(
    () => createThread({ projectDir: '/tmp' }),
    /agentId is required/,
  );
});

// ---------------------------------------------------------------------------
// getThread (Sub-AC 4 of AC 5)
// ---------------------------------------------------------------------------

test('getThread: returns null when slug missing on disk', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    const result = await getThread({
      projectDir,
      agentId: 'no-such-agent',
      threadId: 'chat-x',
    });
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

test('getThread: returns null when slug exists but threadId is unknown', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    const result = await getThread({
      projectDir,
      agentId: SLUG,
      threadId: 'chat-missing',
    });
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

test('getThread: returns the full thread document for replay', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    const created = await createThread({
      projectDir,
      agentId: SLUG,
      title: 'Replay me',
    });
    assert.ok(created);
    const result = await getThread({
      projectDir,
      agentId: SLUG,
      threadId: created.thread.id,
    });
    assert.ok(result);
    assert.equal(result.thread.id, created.thread.id);
    assert.equal(result.thread.agentId, SLUG);
    assert.equal(result.thread.title, 'Replay me');
    assert.deepEqual(result.thread.messages, []);
  } finally {
    await cleanup();
  }
});

test('getThread: returns persisted messages when the thread has any', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    const created = await createThread({ projectDir, agentId: SLUG });
    assert.ok(created);

    // Append a couple of messages directly via the store so we test
    // round-tripping. The data layer is the read path; the store is
    // the canonical write path.
    const store = new ChatConversationStore(
      join(projectDir, '.aweek', 'agents'),
    );
    await store.appendMessage(SLUG, created.thread.id, {
      id: 'msg-u1',
      role: 'user',
      content: 'hello',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    await store.appendMessage(SLUG, created.thread.id, {
      id: 'msg-a1',
      role: 'assistant',
      content: 'hi back',
      createdAt: '2026-04-30T00:00:01.000Z',
    });

    const result = await getThread({
      projectDir,
      agentId: SLUG,
      threadId: created.thread.id,
    });
    assert.ok(result);
    assert.equal(result.thread.messages.length, 2);
    assert.equal(result.thread.messages[0]?.id, 'msg-u1');
    assert.equal(result.thread.messages[0]?.role, 'user');
    assert.equal(result.thread.messages[1]?.id, 'msg-a1');
    assert.equal(result.thread.messages[1]?.role, 'assistant');
  } finally {
    await cleanup();
  }
});

test('getThread: requires projectDir, agentId, and threadId', async () => {
  await assert.rejects(
    () => getThread({ agentId: SLUG, threadId: 'chat-x' }),
    /projectDir is required/,
  );
  await assert.rejects(
    () => getThread({ projectDir: '/tmp', threadId: 'chat-x' }),
    /agentId is required/,
  );
  await assert.rejects(
    () => getThread({ projectDir: '/tmp', agentId: SLUG }),
    /threadId is required/,
  );
});

// ---------------------------------------------------------------------------
// renameThread
// ---------------------------------------------------------------------------

test('renameThread: updates the title on an existing thread', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    const created = await createThread({
      projectDir,
      agentId: SLUG,
      title: 'Old name',
    });
    assert.ok(created);
    // Bump time so updatedAt actually differs.
    await new Promise((r) => setTimeout(r, 5));
    const renamed = await renameThread({
      projectDir,
      agentId: SLUG,
      threadId: created.thread.id,
      title: 'New name',
    });
    assert.ok(renamed, 'expected non-null payload');
    assert.equal(renamed.thread.title, 'New name');
    assert.notEqual(renamed.thread.updatedAt, created.thread.updatedAt);
  } finally {
    await cleanup();
  }
});

test('renameThread: clears the title when called with empty string', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    const created = await createThread({
      projectDir,
      agentId: SLUG,
      title: 'Will be cleared',
    });
    assert.ok(created);
    const renamed = await renameThread({
      projectDir,
      agentId: SLUG,
      threadId: created.thread.id,
      title: '',
    });
    assert.ok(renamed);
    assert.equal(renamed.thread.title, undefined);
  } finally {
    await cleanup();
  }
});

test('renameThread: returns null when agent slug is unknown', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    const result = await renameThread({
      projectDir,
      agentId: 'no-such-agent',
      threadId: 'chat-deadbeef',
      title: 'noop',
    });
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

test('renameThread: returns null when thread id is unknown', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    const result = await renameThread({
      projectDir,
      agentId: SLUG,
      threadId: 'chat-missing',
      title: 'noop',
    });
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

test('renameThread: requires projectDir, agentId, threadId, and title', async () => {
  await assert.rejects(
    () => renameThread({ agentId: SLUG, threadId: 'chat-x', title: 'n' }),
    /projectDir is required/,
  );
  await assert.rejects(
    () => renameThread({ projectDir: '/tmp', threadId: 'chat-x', title: 'n' }),
    /agentId is required/,
  );
  await assert.rejects(
    () => renameThread({ projectDir: '/tmp', agentId: SLUG, title: 'n' }),
    /threadId is required/,
  );
  await assert.rejects(
    () =>
      renameThread({
        projectDir: '/tmp',
        agentId: SLUG,
        threadId: 'chat-x',
      }),
    /title is required/,
  );
});

// ---------------------------------------------------------------------------
// deleteThread
// ---------------------------------------------------------------------------

test('deleteThread: removes an existing thread and reports removed: true', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    const created = await createThread({
      projectDir,
      agentId: SLUG,
      title: 'Doomed',
    });
    assert.ok(created);
    const result = await deleteThread({
      projectDir,
      agentId: SLUG,
      threadId: created.thread.id,
    });
    assert.deepEqual(result, { removed: true });

    // Verify the file was actually deleted from the chat dir.
    const agentsDir = join(projectDir, '.aweek', 'agents');
    const store = new ChatConversationStore(agentsDir);
    const onDisk = await store.read(SLUG, created.thread.id);
    assert.equal(onDisk, null);
  } finally {
    await cleanup();
  }
});

test('deleteThread: idempotent — missing thread returns removed: false', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    const result = await deleteThread({
      projectDir,
      agentId: SLUG,
      threadId: 'chat-missing',
    });
    assert.deepEqual(result, { removed: false });
  } finally {
    await cleanup();
  }
});

test('deleteThread: returns null when agent slug is unknown', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    const result = await deleteThread({
      projectDir,
      agentId: 'no-such-agent',
      threadId: 'chat-deadbeef',
    });
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

test('deleteThread: only deletes the targeted thread', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    const a = await createThread({ projectDir, agentId: SLUG, title: 'A' });
    const b = await createThread({ projectDir, agentId: SLUG, title: 'B' });
    assert.ok(a && b);

    const result = await deleteThread({
      projectDir,
      agentId: SLUG,
      threadId: a.thread.id,
    });
    assert.deepEqual(result, { removed: true });

    // B should still be present.
    const list = await listThreads({ projectDir, agentId: SLUG });
    assert.ok(list);
    assert.equal(list.threads.length, 1);
    assert.equal(list.threads[0]?.id, b.thread.id);
  } finally {
    await cleanup();
  }
});

test('deleteThread: requires projectDir, agentId, and threadId', async () => {
  await assert.rejects(
    () => deleteThread({ agentId: SLUG, threadId: 'chat-x' }),
    /projectDir is required/,
  );
  await assert.rejects(
    () => deleteThread({ projectDir: '/tmp', threadId: 'chat-x' }),
    /agentId is required/,
  );
  await assert.rejects(
    () => deleteThread({ projectDir: '/tmp', agentId: SLUG }),
    /threadId is required/,
  );
});

// ---------------------------------------------------------------------------
// Per-agent isolation
// ---------------------------------------------------------------------------

test('threads are isolated per agent', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await seedAgent(projectDir, SLUG);
    await seedAgent(projectDir, OTHER_SLUG);

    await createThread({ projectDir, agentId: SLUG, title: 'mine' });
    await createThread({ projectDir, agentId: OTHER_SLUG, title: 'theirs' });

    const mine = await listThreads({ projectDir, agentId: SLUG });
    const theirs = await listThreads({ projectDir, agentId: OTHER_SLUG });

    assert.ok(mine && theirs);
    assert.equal(mine.threads.length, 1);
    assert.equal(theirs.threads.length, 1);
    assert.equal(mine.threads[0]?.title, 'mine');
    assert.equal(theirs.threads[0]?.title, 'theirs');
  } finally {
    await cleanup();
  }
});
