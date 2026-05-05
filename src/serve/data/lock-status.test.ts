/**
 * Tests for the chat-panel lock-status data source
 * (`src/serve/data/lock-status.ts`).
 *
 * The gatherer is read-only: given a `projectDir` + `slug` it queries
 * the same `.aweek/.locks/<slug>.lock` file the heartbeat writes and
 * projects the result into a banner-friendly payload. Coverage:
 *
 *   - happy-path active lock → `locked: true`, `status: 'active'`,
 *     `since` populated, `sessionInfo` carries the heartbeat metadata.
 *   - missing lock file → `locked: false`, `status: 'absent'`,
 *     `since: null`, `sessionInfo: null`.
 *   - stale lock (createdAt older than `maxLockAgeMs`) → `locked: false`,
 *     `status: 'stale'` (banner does NOT trigger).
 *   - orphaned lock (PID dead) → `locked: false`, `status: 'orphaned'`.
 *   - missing required args throw.
 *   - unknown sessionInfo keys are stripped — only `taskId` + `type`
 *     pass through to the SPA payload.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  gatherAgentLockStatus,
} from './lock-status.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function mkdtempSafe(prefix: string): Promise<string> {
  const base = join(
    tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(base, { recursive: true });
  return base;
}

async function writeLockFile(
  projectDir: string,
  slug: string,
  body: Record<string, unknown>,
): Promise<void> {
  const lockDir = join(projectDir, '.aweek', '.locks');
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, `${slug}.lock`),
    JSON.stringify(body, null, 2) + '\n',
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// Required-arg guards
// ---------------------------------------------------------------------------

test('throws when projectDir is missing', async () => {
  await assert.rejects(
    () => gatherAgentLockStatus({ slug: 'writer' }),
    /projectDir is required/,
  );
});

test('throws when slug is missing', async () => {
  await assert.rejects(
    () => gatherAgentLockStatus({ projectDir: '/tmp' }),
    /slug is required/,
  );
});

// ---------------------------------------------------------------------------
// Absent / missing lock file
// ---------------------------------------------------------------------------

test('returns absent when the lock file does not exist', async () => {
  const projectDir = await mkdtempSafe('aweek-lock-status-absent-');
  try {
    const result = await gatherAgentLockStatus({
      projectDir,
      slug: 'writer',
    });
    assert.deepEqual(result, {
      slug: 'writer',
      locked: false,
      status: 'absent',
      since: null,
      sessionInfo: null,
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Active lock
// ---------------------------------------------------------------------------

test('returns active when a fresh lock exists with the current pid', async () => {
  const projectDir = await mkdtempSafe('aweek-lock-status-active-');
  try {
    const createdAt = new Date().toISOString();
    await writeLockFile(projectDir, 'writer', {
      agentId: 'writer',
      pid: process.pid,
      createdAt,
      staleAfter: new Date(Date.now() + 60_000).toISOString(),
      sessionInfo: { taskId: 'task-42', type: 'heartbeat' },
    });
    const result = await gatherAgentLockStatus({
      projectDir,
      slug: 'writer',
    });
    assert.equal(result.slug, 'writer');
    assert.equal(result.locked, true);
    assert.equal(result.status, 'active');
    assert.equal(result.since, createdAt);
    assert.deepEqual(result.sessionInfo, {
      taskId: 'task-42',
      type: 'heartbeat',
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Stale / orphaned locks (banner must NOT trigger)
// ---------------------------------------------------------------------------

test('returns stale when the lock has aged past the configured max', async () => {
  const projectDir = await mkdtempSafe('aweek-lock-status-stale-');
  try {
    // Use a very old createdAt + an explicit lockDir so we can pass a
    // tiny `maxLockAgeMs`. Default max age is 2h so we have to coax
    // the lock manager via a fresh queryLock call — which means we
    // need to plumb the test through a custom call. We sidestep by
    // writing a createdAt of "yesterday" against the default max age.
    const yesterday = new Date(Date.now() - 86_400_000 * 2).toISOString();
    await writeLockFile(projectDir, 'writer', {
      agentId: 'writer',
      pid: process.pid,
      createdAt: yesterday,
      staleAfter: new Date(Date.now() - 1).toISOString(),
    });
    const result = await gatherAgentLockStatus({
      projectDir,
      slug: 'writer',
    });
    // Default maxLockAgeMs = 2h; 48h-old lock is stale. PID is alive
    // (current process) so it's NOT orphaned — explicitly stale.
    assert.equal(result.locked, false);
    assert.equal(result.status, 'stale');
    assert.equal(result.since, yesterday);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('returns orphaned when the lock pid is no longer alive', async () => {
  const projectDir = await mkdtempSafe('aweek-lock-status-orphan-');
  try {
    const createdAt = new Date().toISOString();
    await writeLockFile(projectDir, 'writer', {
      agentId: 'writer',
      // PID 0 is never a valid running pid — the lock manager treats
      // it as orphaned per `isPidAlive`'s integer-check.
      pid: 0,
      createdAt,
      staleAfter: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await gatherAgentLockStatus({
      projectDir,
      slug: 'writer',
    });
    assert.equal(result.locked, false);
    assert.equal(result.status, 'orphaned');
    assert.equal(result.since, createdAt);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SessionInfo projection
// ---------------------------------------------------------------------------

test('projects only taskId + type from sessionInfo, dropping unknown keys', async () => {
  const projectDir = await mkdtempSafe('aweek-lock-status-sessioninfo-');
  try {
    await writeLockFile(projectDir, 'writer', {
      agentId: 'writer',
      pid: process.pid,
      createdAt: new Date().toISOString(),
      staleAfter: new Date(Date.now() + 60_000).toISOString(),
      sessionInfo: {
        taskId: 'task-7',
        type: 'inbox',
        secret: 'should-not-leak',
        nested: { irrelevant: true },
      },
    });
    const result = await gatherAgentLockStatus({
      projectDir,
      slug: 'writer',
    });
    assert.deepEqual(result.sessionInfo, {
      taskId: 'task-7',
      type: 'inbox',
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('returns sessionInfo: null when the lock has no sessionInfo', async () => {
  const projectDir = await mkdtempSafe('aweek-lock-status-no-sessioninfo-');
  try {
    await writeLockFile(projectDir, 'writer', {
      agentId: 'writer',
      pid: process.pid,
      createdAt: new Date().toISOString(),
      staleAfter: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await gatherAgentLockStatus({
      projectDir,
      slug: 'writer',
    });
    assert.equal(result.sessionInfo, null);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('honors the lockDir override (test seam)', async () => {
  const projectDir = await mkdtempSafe('aweek-lock-status-override-');
  try {
    const customLockDir = join(projectDir, 'custom-locks');
    await mkdir(customLockDir, { recursive: true });
    await writeFile(
      join(customLockDir, 'writer.lock'),
      JSON.stringify(
        {
          agentId: 'writer',
          pid: process.pid,
          createdAt: new Date().toISOString(),
          staleAfter: new Date(Date.now() + 60_000).toISOString(),
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    const result = await gatherAgentLockStatus({
      projectDir,
      slug: 'writer',
      lockDir: customLockDir,
    });
    assert.equal(result.locked, true);
    assert.equal(result.status, 'active');
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
