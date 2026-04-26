import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isPidAlive,
  lockPathFor,
  readLockFile,
  isLockStale,
  isLockOrphaned,
  lockStatus,
  acquireLock,
  releaseLock,
  queryLock,
  breakLock,
  createLockManager,
} from './lock-manager.js';

/** Create a temporary lock directory for test isolation */
async function makeTempLockDir() {
  return mkdtemp(join(tmpdir(), 'aweek-lock-test-'));
}

// ── isPidAlive ─────────────────────────────────────────────────────────────

describe('isPidAlive()', () => {
  it('should return true for current process PID', () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  it('should return false for obviously dead PID', () => {
    // PID 999999999 is extremely unlikely to exist
    assert.equal(isPidAlive(999999999), false);
  });

  it('should return false for non-integer PID', () => {
    assert.equal(isPidAlive(3.14), false);
  });

  it('should return false for negative PID', () => {
    assert.equal(isPidAlive(-1), false);
  });

  it('should return false for zero PID', () => {
    assert.equal(isPidAlive(0), false);
  });

  it('should return false for non-number input', () => {
    assert.equal(isPidAlive('1234'), false);
    assert.equal(isPidAlive(null), false);
    assert.equal(isPidAlive(undefined), false);
  });

  it('should return true for PID 1 (init process)', () => {
    // PID 1 always exists; may get EPERM which still means alive
    assert.equal(isPidAlive(1), true);
  });
});

// ── lockPathFor ────────────────────────────────────────────────────────────

describe('lockPathFor()', () => {
  it('should return path with agentId and .lock extension', () => {
    const p = lockPathFor('agent-writer-abc12345', '/tmp/locks');
    assert.equal(p, '/tmp/locks/agent-writer-abc12345.lock');
  });

  it('should use default lock dir when not specified', () => {
    const p = lockPathFor('agent-test-11111111');
    assert.ok(p.endsWith('agent-test-11111111.lock'));
    assert.ok(p.includes('.aweek/.locks'));
  });

  it('should throw if agentId is missing', () => {
    assert.throws(() => lockPathFor(''), { message: 'agentId is required' });
    assert.throws(() => lockPathFor(null), { message: 'agentId is required' });
    assert.throws(() => lockPathFor(undefined), { message: 'agentId is required' });
  });
});

// ── readLockFile ───────────────────────────────────────────────────────────

describe('readLockFile()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempLockDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('should return null for nonexistent file', async () => {
    const result = await readLockFile(join(lockDir, 'missing.lock'));
    assert.equal(result, null);
  });

  it('should parse valid JSON lock file', async () => {
    const lockPath = join(lockDir, 'test.lock');
    await writeFile(lockPath, JSON.stringify({ agentId: 'test', pid: 1234 }));
    const result = await readLockFile(lockPath);
    assert.deepStrictEqual(result, { agentId: 'test', pid: 1234 });
  });

  it('should return null for corrupt JSON', async () => {
    const lockPath = join(lockDir, 'corrupt.lock');
    await writeFile(lockPath, 'not json{{{');
    const result = await readLockFile(lockPath);
    assert.equal(result, null);
  });
});

// ── isLockStale ────────────────────────────────────────────────────────────

describe('isLockStale()', () => {
  it('should return true for null lockData', () => {
    assert.equal(isLockStale(null, 60000), true);
  });

  it('should return true for lockData without createdAt', () => {
    assert.equal(isLockStale({}, 60000), true);
  });

  it('should return false for recent lock', () => {
    const lockData = { createdAt: new Date().toISOString() };
    assert.equal(isLockStale(lockData, 60000), false);
  });

  it('should return true for old lock', () => {
    const old = new Date(Date.now() - 120000).toISOString();
    assert.equal(isLockStale({ createdAt: old }, 60000), true);
  });

  it('should return false for lock within boundary', () => {
    const lockData = { createdAt: new Date(Date.now() - 59000).toISOString() };
    assert.equal(isLockStale(lockData, 60000), false);
  });
});

// ── isLockOrphaned ─────────────────────────────────────────────────────────

describe('isLockOrphaned()', () => {
  it('should return true for null lockData', () => {
    assert.equal(isLockOrphaned(null), true);
  });

  it('should return true for lockData without pid', () => {
    assert.equal(isLockOrphaned({ agentId: 'test' }), true);
  });

  it('should return false for current process PID', () => {
    assert.equal(isLockOrphaned({ pid: process.pid }), false);
  });

  it('should return true for dead process PID', () => {
    assert.equal(isLockOrphaned({ pid: 999999999 }), true);
  });
});

// ── lockStatus ─────────────────────────────────────────────────────────────

describe('lockStatus()', () => {
  it('should return absent for null lockData', () => {
    assert.equal(lockStatus(null, 60000), 'absent');
  });

  it('should return stale for old lock', () => {
    const old = { createdAt: new Date(Date.now() - 120000).toISOString(), pid: process.pid };
    assert.equal(lockStatus(old, 60000), 'stale');
  });

  it('should return orphaned for dead PID', () => {
    const data = { createdAt: new Date().toISOString(), pid: 999999999 };
    assert.equal(lockStatus(data, 60000), 'orphaned');
  });

  it('should return active for live PID within age', () => {
    const data = { createdAt: new Date().toISOString(), pid: process.pid };
    assert.equal(lockStatus(data, 60000), 'active');
  });

  it('should prioritize stale over orphaned', () => {
    // Both stale AND orphaned — stale wins (checked first)
    const data = { createdAt: new Date(Date.now() - 120000).toISOString(), pid: 999999999 };
    assert.equal(lockStatus(data, 60000), 'stale');
  });
});

// ── acquireLock ────────────────────────────────────────────────────────────

describe('acquireLock()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempLockDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('should acquire lock on fresh directory', async () => {
    const result = await acquireLock('agent-test-11111111', { lockDir });
    assert.equal(result.acquired, true);
    assert.ok(result.lockData);
    assert.equal(result.lockData.agentId, 'agent-test-11111111');
    assert.equal(result.lockData.pid, process.pid);
    assert.ok(result.lockData.createdAt);
    assert.ok(result.lockData.staleAfter);
  });

  it('should write lock file to disk', async () => {
    await acquireLock('agent-disk-22222222', { lockDir });
    const lockPath = lockPathFor('agent-disk-22222222', lockDir);
    const raw = await readFile(lockPath, 'utf-8');
    const data = JSON.parse(raw);
    assert.equal(data.agentId, 'agent-disk-22222222');
    assert.equal(data.pid, process.pid);
  });

  it('should fail if lock already held by live process', async () => {
    await acquireLock('agent-dup-33333333', { lockDir });
    const result = await acquireLock('agent-dup-33333333', { lockDir });
    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'already_locked');
    assert.ok(result.existingLock);
  });

  it('should replace stale lock', async () => {
    await acquireLock('agent-stale-44444444', { lockDir, maxLockAgeMs: 1 });
    await new Promise((r) => setTimeout(r, 10));

    const result = await acquireLock('agent-stale-44444444', { lockDir, maxLockAgeMs: 1 });
    assert.equal(result.acquired, true);
    assert.equal(result.replacedStatus, 'stale');
  });

  it('should replace orphaned lock (dead PID)', async () => {
    // Manually write a lock with a dead PID
    const lockPath = lockPathFor('agent-orphan-55555555', lockDir);
    const { mkdir: mkdirSync } = await import('node:fs/promises');
    await mkdirSync(lockDir, { recursive: true });
    const fakeLock = {
      agentId: 'agent-orphan-55555555',
      pid: 999999999,
      createdAt: new Date().toISOString(),
      staleAfter: new Date(Date.now() + 7200000).toISOString(),
    };
    await writeFile(lockPath, JSON.stringify(fakeLock));

    const result = await acquireLock('agent-orphan-55555555', { lockDir });
    assert.equal(result.acquired, true);
    assert.equal(result.replacedStatus, 'orphaned');
    assert.equal(result.lockData.pid, process.pid);
  });

  it('should throw if agentId is missing', async () => {
    await assert.rejects(
      () => acquireLock('', { lockDir }),
      { message: 'agentId is required' }
    );
  });

  it('should allow locks for different agents simultaneously', async () => {
    const r1 = await acquireLock('agent-a-11111111', { lockDir });
    const r2 = await acquireLock('agent-b-22222222', { lockDir });
    assert.equal(r1.acquired, true);
    assert.equal(r2.acquired, true);
  });

  it('should store sessionInfo when provided', async () => {
    const result = await acquireLock('agent-meta-66666666', {
      lockDir,
      sessionInfo: { taskId: 'task-001', weekOf: '2026-04-13' },
    });
    assert.equal(result.acquired, true);
    assert.deepStrictEqual(result.lockData.sessionInfo, {
      taskId: 'task-001',
      weekOf: '2026-04-13',
    });

    // Verify persisted to disk
    const lockPath = lockPathFor('agent-meta-66666666', lockDir);
    const raw = await readFile(lockPath, 'utf-8');
    const data = JSON.parse(raw);
    assert.deepStrictEqual(data.sessionInfo, { taskId: 'task-001', weekOf: '2026-04-13' });
  });

  it('should handle corrupt lock file gracefully', async () => {
    const lockPath = lockPathFor('agent-corrupt-77777777', lockDir);
    const { mkdir: mkdirFn } = await import('node:fs/promises');
    await mkdirFn(lockDir, { recursive: true });
    await writeFile(lockPath, 'not-valid-json!!!');

    const result = await acquireLock('agent-corrupt-77777777', { lockDir });
    assert.equal(result.acquired, true);
  });
});

// ── releaseLock ────────────────────────────────────────────────────────────

describe('releaseLock()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempLockDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('should release an existing lock', async () => {
    await acquireLock('agent-rel-11111111', { lockDir });
    const result = await releaseLock('agent-rel-11111111', { lockDir });
    assert.equal(result.released, true);
  });

  it('should be idempotent — releasing nonexistent lock succeeds', async () => {
    const result = await releaseLock('agent-nope-99999999', { lockDir });
    assert.equal(result.released, true);
  });

  it('should allow re-acquiring after release', async () => {
    await acquireLock('agent-reacq-55555555', { lockDir });
    await releaseLock('agent-reacq-55555555', { lockDir });
    const result = await acquireLock('agent-reacq-55555555', { lockDir });
    assert.equal(result.acquired, true);
  });

  it('should throw if agentId is missing', async () => {
    await assert.rejects(
      () => releaseLock('', { lockDir }),
      { message: 'agentId is required' }
    );
  });
});

// ── queryLock ──────────────────────────────────────────────────────────────

describe('queryLock()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempLockDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('should return locked=false, status=absent when no lock exists', async () => {
    const result = await queryLock('agent-none-00000000', { lockDir });
    assert.equal(result.locked, false);
    assert.equal(result.status, 'absent');
    assert.equal(result.lockData, undefined);
  });

  it('should return locked=true, status=active for live lock', async () => {
    await acquireLock('agent-active-11111111', { lockDir });
    const result = await queryLock('agent-active-11111111', { lockDir });
    assert.equal(result.locked, true);
    assert.equal(result.status, 'active');
    assert.ok(result.lockData);
    assert.equal(result.lockData.pid, process.pid);
  });

  it('should return locked=false, status=stale for old lock', async () => {
    await acquireLock('agent-old-22222222', { lockDir, maxLockAgeMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    const result = await queryLock('agent-old-22222222', { lockDir, maxLockAgeMs: 1 });
    assert.equal(result.locked, false);
    assert.equal(result.status, 'stale');
    assert.ok(result.lockData);
  });

  it('should return locked=false, status=orphaned for dead PID', async () => {
    const lockPath = lockPathFor('agent-dead-33333333', lockDir);
    const { mkdir: mkdirFn } = await import('node:fs/promises');
    await mkdirFn(lockDir, { recursive: true });
    const fakeLock = {
      agentId: 'agent-dead-33333333',
      pid: 999999999,
      createdAt: new Date().toISOString(),
      staleAfter: new Date(Date.now() + 7200000).toISOString(),
    };
    await writeFile(lockPath, JSON.stringify(fakeLock));

    const result = await queryLock('agent-dead-33333333', { lockDir });
    assert.equal(result.locked, false);
    assert.equal(result.status, 'orphaned');
  });

  it('should return locked=false after release', async () => {
    await acquireLock('agent-freed-44444444', { lockDir });
    await releaseLock('agent-freed-44444444', { lockDir });
    const result = await queryLock('agent-freed-44444444', { lockDir });
    assert.equal(result.locked, false);
    assert.equal(result.status, 'absent');
  });

  it('should throw if agentId is missing', async () => {
    await assert.rejects(
      () => queryLock('', { lockDir }),
      { message: 'agentId is required' }
    );
  });
});

// ── breakLock ──────────────────────────────────────────────────────────────

describe('breakLock()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempLockDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('should break an active lock', async () => {
    await acquireLock('agent-break-11111111', { lockDir });
    const result = await breakLock('agent-break-11111111', { lockDir });
    assert.equal(result.broken, true);
    assert.ok(result.previousLock);
    assert.equal(result.previousLock.agentId, 'agent-break-11111111');

    // Verify lock is gone
    const q = await queryLock('agent-break-11111111', { lockDir });
    assert.equal(q.locked, false);
    assert.equal(q.status, 'absent');
  });

  it('should be idempotent — breaking nonexistent lock succeeds', async () => {
    const result = await breakLock('agent-none-99999999', { lockDir });
    assert.equal(result.broken, true);
    assert.equal(result.previousLock, undefined);
  });

  it('should throw if agentId is missing', async () => {
    await assert.rejects(
      () => breakLock('', { lockDir }),
      { message: 'agentId is required' }
    );
  });
});

// ── createLockManager ──────────────────────────────────────────────────────

describe('createLockManager()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempLockDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('should create manager with default options', () => {
    const mgr = createLockManager();
    assert.equal(mgr.lockDir, '.aweek/.locks');
    assert.equal(mgr.maxLockAgeMs, 2 * 60 * 60 * 1000);
  });

  it('should create manager with custom options', () => {
    const mgr = createLockManager({ lockDir: '/custom/locks', maxLockAgeMs: 5000 });
    assert.equal(mgr.lockDir, '/custom/locks');
    assert.equal(mgr.maxLockAgeMs, 5000);
  });

  it('should provide working lockPathFor', () => {
    const mgr = createLockManager({ lockDir });
    const p = mgr.lockPathFor('agent-test-11111111');
    assert.ok(p.endsWith('agent-test-11111111.lock'));
  });

  it('should provide working acquire / release / query cycle', async () => {
    const mgr = createLockManager({ lockDir });

    const acquired = await mgr.acquire('agent-mgr-11111111');
    assert.equal(acquired.acquired, true);

    const q = await mgr.query('agent-mgr-11111111');
    assert.equal(q.locked, true);
    assert.equal(q.status, 'active');

    await mgr.release('agent-mgr-11111111');
    const q2 = await mgr.query('agent-mgr-11111111');
    assert.equal(q2.locked, false);
  });

  it('should provide working break', async () => {
    const mgr = createLockManager({ lockDir });
    await mgr.acquire('agent-brk-22222222');
    const result = await mgr.break('agent-brk-22222222');
    assert.equal(result.broken, true);
    assert.ok(result.previousLock);
  });

  it('should pass sessionInfo through acquire', async () => {
    const mgr = createLockManager({ lockDir });
    const result = await mgr.acquire('agent-sess-33333333', {
      sessionInfo: { taskId: 'task-x' },
    });
    assert.equal(result.acquired, true);
    assert.deepStrictEqual(result.lockData.sessionInfo, { taskId: 'task-x' });
  });
});
