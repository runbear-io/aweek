import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createScheduler,
  lockPathFor,
  isLockStale,
  acquireLock,
  releaseLock,
  isLocked,
  runHeartbeat,
  runHeartbeatAll,
} from './scheduler.js';

/** Create a temporary lock directory for test isolation */
async function makeTempLockDir() {
  return mkdtemp(join(tmpdir(), 'aweek-scheduler-test-'));
}

// ── lockPathFor ─────────────────────────────────────────────────────────────

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

// ── isLockStale ─────────────────────────────────────────────────────────────

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
    const lockData = { createdAt: old };
    assert.equal(isLockStale(lockData, 60000), true);
  });

  it('should return false for lock exactly at boundary', () => {
    // Lock created just under maxAge ago
    const lockData = { createdAt: new Date(Date.now() - 59000).toISOString() };
    assert.equal(isLockStale(lockData, 60000), false);
  });
});

// ── acquireLock / releaseLock / isLocked ─────────────────────────────────────

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
    assert.ok(result.lockData.createdAt);
    assert.ok(result.lockData.pid);
  });

  it('should write lock file to disk', async () => {
    await acquireLock('agent-disk-22222222', { lockDir });
    const lockPath = lockPathFor('agent-disk-22222222', lockDir);
    const raw = await readFile(lockPath, 'utf-8');
    const data = JSON.parse(raw);
    assert.equal(data.agentId, 'agent-disk-22222222');
  });

  it('should fail if lock already held', async () => {
    await acquireLock('agent-dup-33333333', { lockDir });
    const result = await acquireLock('agent-dup-33333333', { lockDir });
    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'already_locked');
    assert.ok(result.existingLock);
  });

  it('should replace stale lock', async () => {
    // Acquire with very short max age
    await acquireLock('agent-stale-44444444', { lockDir, maxLockAgeMs: 1 });

    // Wait for it to become stale
    await new Promise((r) => setTimeout(r, 10));

    const result = await acquireLock('agent-stale-44444444', { lockDir, maxLockAgeMs: 1 });
    assert.equal(result.acquired, true);
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
});

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

describe('isLocked()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempLockDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('should return locked=false when no lock exists', async () => {
    const result = await isLocked('agent-none-00000000', { lockDir });
    assert.equal(result.locked, false);
  });

  it('should return locked=true when lock is active', async () => {
    await acquireLock('agent-active-11111111', { lockDir });
    const result = await isLocked('agent-active-11111111', { lockDir });
    assert.equal(result.locked, true);
    assert.equal(result.stale, false);
    assert.ok(result.lockData);
  });

  it('should return locked=false with stale=true for stale lock', async () => {
    await acquireLock('agent-old-22222222', { lockDir, maxLockAgeMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    const result = await isLocked('agent-old-22222222', { lockDir, maxLockAgeMs: 1 });
    assert.equal(result.locked, false);
    assert.equal(result.stale, true);
    assert.ok(result.lockData);
  });

  it('should return locked=false after release', async () => {
    await acquireLock('agent-freed-33333333', { lockDir });
    await releaseLock('agent-freed-33333333', { lockDir });
    const result = await isLocked('agent-freed-33333333', { lockDir });
    assert.equal(result.locked, false);
  });
});

// ── runHeartbeat ────────────────────────────────────────────────────────────

describe('runHeartbeat()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempLockDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('should execute callback and return completed status', async () => {
    const result = await runHeartbeat(
      'agent-run-11111111',
      async (id) => ({ executed: true, id }),
      { lockDir }
    );

    assert.equal(result.status, 'completed');
    assert.equal(result.agentId, 'agent-run-11111111');
    assert.deepStrictEqual(result.result, { executed: true, id: 'agent-run-11111111' });
    assert.ok(result.startedAt);
    assert.ok(result.completedAt);
    assert.ok(result.durationMs >= 0);
  });

  it('should release lock after successful execution', async () => {
    await runHeartbeat(
      'agent-cleanup-22222222',
      async () => 'done',
      { lockDir }
    );

    const lockState = await isLocked('agent-cleanup-22222222', { lockDir });
    assert.equal(lockState.locked, false);
  });

  it('should release lock after failed execution', async () => {
    const result = await runHeartbeat(
      'agent-fail-33333333',
      async () => { throw new Error('boom'); },
      { lockDir }
    );

    assert.equal(result.status, 'error');
    assert.equal(result.error.message, 'boom');

    const lockState = await isLocked('agent-fail-33333333', { lockDir });
    assert.equal(lockState.locked, false);
  });

  it('should skip if agent is already locked', async () => {
    // Acquire lock externally to simulate another heartbeat in progress
    await acquireLock('agent-busy-44444444', { lockDir });

    const result = await runHeartbeat(
      'agent-busy-44444444',
      async () => 'should not run',
      { lockDir }
    );

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'already_locked');
    assert.ok(result.existingLock);

    // Release the externally-held lock
    await releaseLock('agent-busy-44444444', { lockDir });
  });

  it('should be idempotent — repeated calls with active lock are no-ops', async () => {
    let callCount = 0;
    const slowCallback = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 100));
      return 'done';
    };

    // Start one heartbeat
    const p1 = runHeartbeat('agent-idem-55555555', slowCallback, { lockDir });

    // Wait a bit, then try to run another
    await new Promise((r) => setTimeout(r, 10));
    const p2 = runHeartbeat('agent-idem-55555555', slowCallback, { lockDir });

    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.status, 'completed');
    assert.equal(r2.status, 'skipped');
    assert.equal(callCount, 1, 'Callback should only execute once');
  });

  it('should throw if agentId is missing', async () => {
    await assert.rejects(
      () => runHeartbeat('', async () => {}, { lockDir }),
      { message: 'agentId is required' }
    );
  });

  it('should throw if callback is not a function', async () => {
    await assert.rejects(
      () => runHeartbeat('agent-test-66666666', 'not a function', { lockDir }),
      { message: 'callback must be a function' }
    );
  });

  it('should pass agentId to callback', async () => {
    let receivedId;
    await runHeartbeat(
      'agent-passid-77777777',
      async (id) => { receivedId = id; },
      { lockDir }
    );
    assert.equal(receivedId, 'agent-passid-77777777');
  });

  it('should record timing data', async () => {
    const result = await runHeartbeat(
      'agent-time-88888888',
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        return 'ok';
      },
      { lockDir }
    );

    assert.equal(result.status, 'completed');
    assert.ok(result.durationMs >= 15, `Expected durationMs >= 15, got ${result.durationMs}`);
  });
});

// ── runHeartbeatAll ─────────────────────────────────────────────────────────

describe('runHeartbeatAll()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempLockDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('should run heartbeats for multiple agents in parallel', async () => {
    const executed = [];
    const results = await runHeartbeatAll(
      ['agent-p1-11111111', 'agent-p2-22222222', 'agent-p3-33333333'],
      async (id) => { executed.push(id); return `done-${id}`; },
      { lockDir }
    );

    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.status === 'completed'));
    assert.equal(executed.length, 3);
    assert.ok(executed.includes('agent-p1-11111111'));
    assert.ok(executed.includes('agent-p2-22222222'));
    assert.ok(executed.includes('agent-p3-33333333'));
  });

  it('should handle mixed results (some locked, some not)', async () => {
    // Lock one agent
    await acquireLock('agent-locked-22222222', { lockDir });

    const results = await runHeartbeatAll(
      ['agent-free-11111111', 'agent-locked-22222222'],
      async () => 'ok',
      { lockDir }
    );

    assert.equal(results.length, 2);
    const free = results.find((r) => r.agentId === 'agent-free-11111111');
    const locked = results.find((r) => r.agentId === 'agent-locked-22222222');
    assert.equal(free.status, 'completed');
    assert.equal(locked.status, 'skipped');

    await releaseLock('agent-locked-22222222', { lockDir });
  });

  it('should return empty array for empty agent list', async () => {
    const results = await runHeartbeatAll([], async () => {}, { lockDir });
    assert.deepStrictEqual(results, []);
  });

  it('should throw if agentIds is not an array', async () => {
    await assert.rejects(
      () => runHeartbeatAll('not-array', async () => {}, { lockDir }),
      { message: 'agentIds must be an array' }
    );
  });

  it('should throw if callback is not a function', async () => {
    await assert.rejects(
      () => runHeartbeatAll(['agent-test-11111111'], null, { lockDir }),
      { message: 'callback must be a function' }
    );
  });

  it('should isolate errors — one agent failure does not affect others', async () => {
    const results = await runHeartbeatAll(
      ['agent-ok-11111111', 'agent-err-22222222', 'agent-ok-33333333'],
      async (id) => {
        if (id === 'agent-err-22222222') throw new Error('agent error');
        return 'ok';
      },
      { lockDir }
    );

    const ok1 = results.find((r) => r.agentId === 'agent-ok-11111111');
    const err = results.find((r) => r.agentId === 'agent-err-22222222');
    const ok2 = results.find((r) => r.agentId === 'agent-ok-33333333');

    assert.equal(ok1.status, 'completed');
    assert.equal(err.status, 'error');
    assert.equal(ok2.status, 'completed');
  });
});

// ── createScheduler ─────────────────────────────────────────────────────────

describe('createScheduler()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempLockDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('should create scheduler with default options', () => {
    const s = createScheduler();
    assert.equal(s.lockDir, '.aweek/.locks');
    assert.equal(s.maxLockAgeMs, 2 * 60 * 60 * 1000);
  });

  it('should create scheduler with custom options', () => {
    const s = createScheduler({ lockDir: '/custom/locks', maxLockAgeMs: 5000 });
    assert.equal(s.lockDir, '/custom/locks');
    assert.equal(s.maxLockAgeMs, 5000);
  });

  it('should provide working lockPathFor', () => {
    const s = createScheduler({ lockDir });
    const p = s.lockPathFor('agent-test-11111111');
    assert.ok(p.endsWith('agent-test-11111111.lock'));
  });

  it('should provide working acquireLock / releaseLock / isLocked', async () => {
    const s = createScheduler({ lockDir });

    const acquired = await s.acquireLock('agent-sched-11111111');
    assert.equal(acquired.acquired, true);

    const locked = await s.isLocked('agent-sched-11111111');
    assert.equal(locked.locked, true);

    await s.releaseLock('agent-sched-11111111');
    const unlocked = await s.isLocked('agent-sched-11111111');
    assert.equal(unlocked.locked, false);
  });

  it('should provide working runHeartbeat', async () => {
    const s = createScheduler({ lockDir });

    const result = await s.runHeartbeat('agent-srun-22222222', async (id) => `ok-${id}`);
    assert.equal(result.status, 'completed');
    assert.equal(result.result, 'ok-agent-srun-22222222');
  });
});
