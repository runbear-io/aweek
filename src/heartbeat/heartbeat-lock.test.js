/**
 * Tests for heartbeat-lock — PID-tracked lock isolation for heartbeat invocations.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  generateHeartbeatId,
  runWithHeartbeatLock,
  runAllWithHeartbeatLock,
  queryHeartbeatLock,
  breakHeartbeatLock,
  createHeartbeatLock,
} from './heartbeat-lock.js';
import { acquireLock } from '../lock/lock-manager.js';

async function makeTempDir(prefix = 'aweek-hbl-') {
  return mkdtemp(join(tmpdir(), prefix));
}

// ── generateHeartbeatId ────────────────────────────────────────────────────

describe('generateHeartbeatId()', () => {
  it('returns a string starting with "hb-"', () => {
    const id = generateHeartbeatId();
    assert.ok(typeof id === 'string');
    assert.ok(id.startsWith('hb-'));
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateHeartbeatId()));
    assert.equal(ids.size, 100, 'All 100 IDs should be unique');
  });
});

// ── runWithHeartbeatLock ───────────────────────────────────────────────────

describe('runWithHeartbeatLock()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('throws if agentId is missing', async () => {
    await assert.rejects(
      () => runWithHeartbeatLock('', async () => {}, { lockDir }),
      { message: 'agentId is required' }
    );
  });

  it('throws if callback is not a function', async () => {
    await assert.rejects(
      () => runWithHeartbeatLock('agent-test-11111111', 'not-fn', { lockDir }),
      { message: 'callback must be a function' }
    );
  });

  it('executes callback and returns completed status', async () => {
    const result = await runWithHeartbeatLock(
      'agent-run-11111111',
      async (id) => ({ executed: true, id }),
      { lockDir }
    );

    assert.equal(result.status, 'completed');
    assert.equal(result.agentId, 'agent-run-11111111');
    assert.deepStrictEqual(result.result, { executed: true, id: 'agent-run-11111111' });
    assert.ok(result.heartbeatId.startsWith('hb-'));
    assert.ok(result.startedAt);
    assert.ok(result.completedAt);
    assert.ok(result.durationMs >= 0);
  });

  it('accepts custom heartbeatId', async () => {
    const result = await runWithHeartbeatLock(
      'agent-custom-22222222',
      async () => 'ok',
      { lockDir, heartbeatId: 'hb-custom-123' }
    );

    assert.equal(result.status, 'completed');
    assert.equal(result.heartbeatId, 'hb-custom-123');
  });

  it('writes lock file with PID and heartbeat metadata', async () => {
    let lockContents;
    await runWithHeartbeatLock(
      'agent-meta-33333333',
      async () => {
        // Read lock file while callback is running
        const lockPath = join(lockDir, 'agent-meta-33333333.lock');
        const raw = await readFile(lockPath, 'utf-8');
        lockContents = JSON.parse(raw);
        return 'ok';
      },
      { lockDir }
    );

    assert.ok(lockContents);
    assert.equal(lockContents.agentId, 'agent-meta-33333333');
    assert.equal(lockContents.pid, process.pid);
    assert.ok(lockContents.sessionInfo);
    assert.ok(lockContents.sessionInfo.heartbeatId);
    assert.equal(lockContents.sessionInfo.type, 'heartbeat');
    assert.ok(lockContents.sessionInfo.triggerTime);
  });

  it('releases lock after successful execution', async () => {
    await runWithHeartbeatLock(
      'agent-release-44444444',
      async () => 'done',
      { lockDir }
    );

    const lockState = await queryHeartbeatLock('agent-release-44444444', { lockDir });
    assert.equal(lockState.locked, false);
  });

  it('releases lock after failed execution', async () => {
    const result = await runWithHeartbeatLock(
      'agent-fail-55555555',
      async () => { throw new Error('boom'); },
      { lockDir }
    );

    assert.equal(result.status, 'error');
    assert.equal(result.error.message, 'boom');
    assert.ok(result.reason.includes('boom'));
    assert.ok(result.heartbeatId);
    assert.ok(result.completedAt);
    assert.ok(result.durationMs >= 0);

    const lockState = await queryHeartbeatLock('agent-fail-55555555', { lockDir });
    assert.equal(lockState.locked, false);
  });

  it('skips if agent is already locked by another heartbeat', async () => {
    // Acquire lock externally (simulating another heartbeat in progress)
    await acquireLock('agent-busy-66666666', {
      lockDir,
      sessionInfo: { heartbeatId: 'hb-other', type: 'heartbeat' },
    });

    const result = await runWithHeartbeatLock(
      'agent-busy-66666666',
      async () => 'should not run',
      { lockDir }
    );

    assert.equal(result.status, 'skipped');
    assert.ok(result.reason.includes('already in progress'));
    assert.ok(result.existingLock);
    assert.ok(result.heartbeatId);
    assert.ok(result.startedAt);
    assert.equal(result.completedAt, undefined);
  });

  it('is idempotent — concurrent calls for same agent are serialized', async () => {
    let callCount = 0;
    const slowCallback = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 100));
      return 'done';
    };

    // Fire two heartbeats concurrently for the same agent
    const p1 = runWithHeartbeatLock('agent-idem-77777777', slowCallback, { lockDir });
    await new Promise((r) => setTimeout(r, 10)); // let p1 acquire lock
    const p2 = runWithHeartbeatLock('agent-idem-77777777', slowCallback, { lockDir });

    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.status, 'completed');
    assert.equal(r2.status, 'skipped');
    assert.equal(callCount, 1, 'Callback should only execute once');
  });

  it('replaces stale lock and reports replacedStatus', async () => {
    // Acquire lock with very short max age
    await acquireLock('agent-stale-88888888', {
      lockDir,
      maxLockAgeMs: 1,
      sessionInfo: { heartbeatId: 'hb-old', type: 'heartbeat' },
    });

    // Wait for it to become stale
    await new Promise((r) => setTimeout(r, 10));

    const result = await runWithHeartbeatLock(
      'agent-stale-88888888',
      async () => 'recovered',
      { lockDir, maxLockAgeMs: 1 }
    );

    assert.equal(result.status, 'completed');
    assert.equal(result.result, 'recovered');
    assert.equal(result.replacedStatus, 'stale');
  });

  it('passes agentId to callback', async () => {
    let receivedId;
    await runWithHeartbeatLock(
      'agent-pass-99999999',
      async (id) => { receivedId = id; },
      { lockDir }
    );
    assert.equal(receivedId, 'agent-pass-99999999');
  });

  it('records timing data accurately', async () => {
    const result = await runWithHeartbeatLock(
      'agent-time-10101010',
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        return 'ok';
      },
      { lockDir }
    );

    assert.equal(result.status, 'completed');
    assert.ok(result.durationMs >= 15, `Expected durationMs >= 15, got ${result.durationMs}`);
  });

  it('allows different agents to run in parallel', async () => {
    const results = await Promise.all([
      runWithHeartbeatLock('agent-a-11111111', async () => 'a', { lockDir }),
      runWithHeartbeatLock('agent-b-22222222', async () => 'b', { lockDir }),
    ]);

    assert.equal(results[0].status, 'completed');
    assert.equal(results[0].result, 'a');
    assert.equal(results[1].status, 'completed');
    assert.equal(results[1].result, 'b');
  });
});

// ── runAllWithHeartbeatLock ────────────────────────────────────────────────

describe('runAllWithHeartbeatLock()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('throws if agentIds is not an array', async () => {
    await assert.rejects(
      () => runAllWithHeartbeatLock('not-array', async () => {}, { lockDir }),
      { message: 'agentIds must be an array' }
    );
  });

  it('throws if callback is not a function', async () => {
    await assert.rejects(
      () => runAllWithHeartbeatLock([], null, { lockDir }),
      { message: 'callback must be a function' }
    );
  });

  it('runs heartbeats for multiple agents in parallel', async () => {
    const executed = [];
    const results = await runAllWithHeartbeatLock(
      ['agent-p1-11111111', 'agent-p2-22222222', 'agent-p3-33333333'],
      async (id) => { executed.push(id); return `done-${id}`; },
      { lockDir }
    );

    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.status === 'completed'));
    assert.equal(executed.length, 3);
  });

  it('returns empty array for empty agent list', async () => {
    const results = await runAllWithHeartbeatLock([], async () => {}, { lockDir });
    assert.deepStrictEqual(results, []);
  });

  it('isolates errors — one agent failure does not affect others', async () => {
    const results = await runAllWithHeartbeatLock(
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

  it('handles mixed results — some locked, some free', async () => {
    await acquireLock('agent-locked-22222222', {
      lockDir,
      sessionInfo: { type: 'heartbeat' },
    });

    const results = await runAllWithHeartbeatLock(
      ['agent-free-11111111', 'agent-locked-22222222'],
      async () => 'ok',
      { lockDir }
    );

    const free = results.find((r) => r.agentId === 'agent-free-11111111');
    const locked = results.find((r) => r.agentId === 'agent-locked-22222222');

    assert.equal(free.status, 'completed');
    assert.equal(locked.status, 'skipped');
  });
});

// ── queryHeartbeatLock ─────────────────────────────────────────────────────

describe('queryHeartbeatLock()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('throws if agentId is missing', async () => {
    await assert.rejects(
      () => queryHeartbeatLock('', { lockDir }),
      { message: 'agentId is required' }
    );
  });

  it('returns locked=false when no lock exists', async () => {
    const result = await queryHeartbeatLock('agent-none-00000000', { lockDir });
    assert.equal(result.locked, false);
    assert.equal(result.status, 'absent');
  });

  it('returns locked=true when heartbeat is running', async () => {
    let queryResult;
    await runWithHeartbeatLock(
      'agent-query-11111111',
      async () => {
        queryResult = await queryHeartbeatLock('agent-query-11111111', { lockDir });
        return 'ok';
      },
      { lockDir }
    );

    assert.equal(queryResult.locked, true);
    assert.equal(queryResult.status, 'active');
    assert.ok(queryResult.lockData);
    assert.equal(queryResult.lockData.pid, process.pid);
  });

  it('returns locked=false after heartbeat completes', async () => {
    await runWithHeartbeatLock(
      'agent-done-22222222',
      async () => 'done',
      { lockDir }
    );

    const result = await queryHeartbeatLock('agent-done-22222222', { lockDir });
    assert.equal(result.locked, false);
  });
});

// ── breakHeartbeatLock ─────────────────────────────────────────────────────

describe('breakHeartbeatLock()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('throws if agentId is missing', async () => {
    await assert.rejects(
      () => breakHeartbeatLock('', { lockDir }),
      { message: 'agentId is required' }
    );
  });

  it('breaks an existing lock', async () => {
    await acquireLock('agent-break-11111111', {
      lockDir,
      sessionInfo: { type: 'heartbeat' },
    });

    const result = await breakHeartbeatLock('agent-break-11111111', { lockDir });
    assert.equal(result.broken, true);
    assert.ok(result.previousLock);

    // Lock should now be gone
    const query = await queryHeartbeatLock('agent-break-11111111', { lockDir });
    assert.equal(query.locked, false);
  });

  it('is idempotent — breaking nonexistent lock succeeds', async () => {
    const result = await breakHeartbeatLock('agent-nope-99999999', { lockDir });
    assert.equal(result.broken, true);
  });

  it('allows re-running heartbeat after break', async () => {
    // Acquire lock externally
    await acquireLock('agent-rerun-22222222', {
      lockDir,
      sessionInfo: { type: 'heartbeat' },
    });

    // Break the lock
    await breakHeartbeatLock('agent-rerun-22222222', { lockDir });

    // Now heartbeat should run
    const result = await runWithHeartbeatLock(
      'agent-rerun-22222222',
      async () => 'recovered',
      { lockDir }
    );

    assert.equal(result.status, 'completed');
    assert.equal(result.result, 'recovered');
  });
});

// ── createHeartbeatLock ────────────────────────────────────────────────────

describe('createHeartbeatLock()', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('creates instance with default options', () => {
    const hbLock = createHeartbeatLock();
    assert.equal(hbLock.lockDir, 'data/.heartbeat-locks');
    assert.equal(hbLock.maxLockAgeMs, 90 * 60 * 1000);
  });

  it('creates instance with custom options', () => {
    const hbLock = createHeartbeatLock({ lockDir: '/custom/locks', maxLockAgeMs: 5000 });
    assert.equal(hbLock.lockDir, '/custom/locks');
    assert.equal(hbLock.maxLockAgeMs, 5000);
  });

  it('provides working run()', async () => {
    const hbLock = createHeartbeatLock({ lockDir });
    const result = await hbLock.run('agent-inst-11111111', async (id) => `ok-${id}`);

    assert.equal(result.status, 'completed');
    assert.equal(result.result, 'ok-agent-inst-11111111');
    assert.ok(result.heartbeatId);
  });

  it('provides working runAll()', async () => {
    const hbLock = createHeartbeatLock({ lockDir });
    const results = await hbLock.runAll(
      ['agent-m1-11111111', 'agent-m2-22222222'],
      async (id) => `done-${id}`
    );

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === 'completed'));
  });

  it('provides working query()', async () => {
    const hbLock = createHeartbeatLock({ lockDir });

    const before = await hbLock.query('agent-q-11111111');
    assert.equal(before.locked, false);

    let duringQuery;
    await hbLock.run('agent-q-11111111', async () => {
      duringQuery = await hbLock.query('agent-q-11111111');
      return 'ok';
    });
    assert.equal(duringQuery.locked, true);

    const after = await hbLock.query('agent-q-11111111');
    assert.equal(after.locked, false);
  });

  it('provides working break()', async () => {
    const hbLock = createHeartbeatLock({ lockDir });

    // Create a lock via acquireLock directly
    await acquireLock('agent-brk-11111111', { lockDir });

    const breakResult = await hbLock.break('agent-brk-11111111');
    assert.equal(breakResult.broken, true);

    const query = await hbLock.query('agent-brk-11111111');
    assert.equal(query.locked, false);
  });

  it('run() rejects duplicate concurrent heartbeats via instance', async () => {
    const hbLock = createHeartbeatLock({ lockDir });
    let callCount = 0;

    const slowCb = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 100));
      return 'done';
    };

    const p1 = hbLock.run('agent-dup-11111111', slowCb);
    await new Promise((r) => setTimeout(r, 10));
    const p2 = hbLock.run('agent-dup-11111111', slowCb);

    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.status, 'completed');
    assert.equal(r2.status, 'skipped');
    assert.equal(callCount, 1);
  });
});
