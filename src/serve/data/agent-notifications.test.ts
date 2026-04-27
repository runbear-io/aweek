/**
 * Tests for the per-agent notifications gatherer (AC 9).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gatherAgentNotifications } from './agent-notifications.js';
import { NotificationStore, createNotification } from '../../storage/notification-store.js';
import { AgentStore } from '../../storage/agent-store.js';
import { createAgentConfig } from '../../models/agent.js';

async function setupProject(): Promise<{ projectDir: string; cleanup: () => Promise<void> }> {
  const projectDir = await mkdtemp(join(tmpdir(), 'aweek-notif-data-'));
  const agentsDir = join(projectDir, '.aweek', 'agents');
  await mkdir(agentsDir, { recursive: true });
  return {
    projectDir,
    cleanup: () => rm(projectDir, { recursive: true, force: true }),
  };
}

async function writeAgentConfig(projectDir: string, slug: string): Promise<void> {
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

test('gatherAgentNotifications: returns null when slug missing on disk', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    const result = await gatherAgentNotifications({
      projectDir,
      slug: 'no-such-agent',
    });
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

test('gatherAgentNotifications: returns empty feed when agent has no notifications', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await writeAgentConfig(projectDir, 'writer');
    const result = await gatherAgentNotifications({ projectDir, slug: 'writer' });
    assert.ok(result);
    assert.equal(result.slug, 'writer');
    assert.deepEqual(result.notifications, []);
    assert.equal(result.unreadCount, 0);
    assert.equal(result.summary.total, 0);
    assert.equal(result.loadError, null);
  } finally {
    await cleanup();
  }
});

test('gatherAgentNotifications: returns notifications newest-first with summary', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await writeAgentConfig(projectDir, 'writer');
    const agentsDir = join(projectDir, '.aweek', 'agents');
    const store = new NotificationStore(agentsDir);
    const first = createNotification({
      agentId: 'writer',
      title: 'first',
      body: 'first body',
      createdAt: '2026-04-20T10:00:00.000Z',
    });
    const second = createNotification({
      agentId: 'writer',
      title: 'second',
      body: 'second body',
      createdAt: '2026-04-21T10:00:00.000Z',
    });
    await store.append('writer', first);
    await store.append('writer', second);

    const result = await gatherAgentNotifications({ projectDir, slug: 'writer' });
    assert.ok(result);
    assert.equal(result.slug, 'writer');
    assert.equal(result.notifications.length, 2);
    // newest-first
    assert.equal(result.notifications[0]?.title, 'second');
    assert.equal(result.notifications[1]?.title, 'first');
    assert.equal(result.unreadCount, 2);
    assert.equal(result.summary.total, 2);
    assert.equal(result.summary.unread, 2);
    assert.equal(result.loadError, null);
  } finally {
    await cleanup();
  }
});

test('gatherAgentNotifications: requires projectDir and slug', async () => {
  await assert.rejects(
    () => gatherAgentNotifications({ slug: 'writer' }),
    /projectDir is required/,
  );
  await assert.rejects(
    () => gatherAgentNotifications({ projectDir: '/tmp' }),
    /slug is required/,
  );
});

test('gatherAgentNotifications: surfaces load errors via loadError', async () => {
  const { projectDir, cleanup } = await setupProject();
  try {
    await writeAgentConfig(projectDir, 'writer');
    const agentDir = join(projectDir, '.aweek', 'agents', 'writer');
    await mkdir(agentDir, { recursive: true });
    // Write a file that fails schema validation (must be array, this is object)
    await writeFile(
      join(agentDir, 'notifications.json'),
      '{"this":"is not a feed"}',
    );

    const result = await gatherAgentNotifications({ projectDir, slug: 'writer' });
    assert.ok(result);
    assert.equal(result.notifications.length, 0);
    assert.notEqual(result.loadError, null);
  } finally {
    await cleanup();
  }
});
