import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  removeHeartbeat,
  removeProject,
  teardown,
  ETEARDOWN_NOT_CONFIRMED,
} from './teardown.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeUninstallStub(outcome = 'removed') {
  return async (_opts: any) => ({ backend: 'launchd', outcome });
}

function makeRmStub(removedPaths: string[]) {
  return async (path: string, _opts: any) => {
    removedPaths.push(path);
  };
}

function makeAccessStub(exists: boolean) {
  return async (_path: string) => {
    if (!exists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
}

// ---------------------------------------------------------------------------
// removeHeartbeat
// ---------------------------------------------------------------------------

describe('removeHeartbeat', () => {
  it('throws ETEARDOWN_NOT_CONFIRMED when confirmed is missing', async () => {
    await assert.rejects(
      () => removeHeartbeat({}),
      (err: any) => {
        assert.equal(err.code, ETEARDOWN_NOT_CONFIRMED);
        return true;
      },
    );
  });

  it('throws ETEARDOWN_NOT_CONFIRMED when confirmed is false', async () => {
    await assert.rejects(
      () => removeHeartbeat({ confirmed: false }),
      (err: any) => {
        assert.equal(err.code, ETEARDOWN_NOT_CONFIRMED);
        return true;
      },
    );
  });

  it('delegates to uninstallHeartbeat when confirmed', async () => {
    const result = await removeHeartbeat({
      confirmed: true,
      projectDir: '/tmp/test-project',
      uninstallHeartbeatFn: makeUninstallStub('removed') as any,
    });

    assert.equal(result.ok, true);
    assert.equal(result.backend, 'launchd');
    assert.equal(result.outcome, 'removed');
    assert.match(result.projectDir, /test-project/);
  });

  it('propagates uninstall outcome (absent)', async () => {
    const result = await removeHeartbeat({
      confirmed: true,
      projectDir: '/tmp/test-project',
      uninstallHeartbeatFn: makeUninstallStub('absent') as any,
    });

    assert.equal(result.outcome, 'absent');
  });
});

// ---------------------------------------------------------------------------
// removeProject
// ---------------------------------------------------------------------------

describe('removeProject', () => {
  it('throws ETEARDOWN_NOT_CONFIRMED when confirmed is missing', async () => {
    await assert.rejects(
      () => removeProject({}),
      (err: any) => {
        assert.equal(err.code, ETEARDOWN_NOT_CONFIRMED);
        return true;
      },
    );
  });

  it('throws ETEARDOWN_NOT_CONFIRMED when confirmed is false', async () => {
    await assert.rejects(
      () => removeProject({ confirmed: false }),
      (err: any) => {
        assert.equal(err.code, ETEARDOWN_NOT_CONFIRMED);
        return true;
      },
    );
  });

  it('removes .aweek/ when it exists', async () => {
    const removed: string[] = [];
    const result = await removeProject({
      confirmed: true,
      projectDir: '/tmp/test-project',
      accessFn: makeAccessStub(true),
      rmFn: makeRmStub(removed),
    });

    assert.equal(result.ok, true);
    assert.equal(result.existed, true);
    assert.match(result.removed, /\.aweek/);
    assert.equal(removed.length, 1);
    assert.match(removed[0]!, /\.aweek/);
  });

  it('succeeds gracefully when .aweek/ does not exist', async () => {
    const removed: string[] = [];
    const result = await removeProject({
      confirmed: true,
      projectDir: '/tmp/test-project',
      accessFn: makeAccessStub(false),
      rmFn: makeRmStub(removed),
    });

    assert.equal(result.ok, true);
    assert.equal(result.existed, false);
    assert.equal(removed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// teardown (both-together)
// ---------------------------------------------------------------------------

describe('teardown', () => {
  it('throws ETEARDOWN_NOT_CONFIRMED without confirmation', async () => {
    await assert.rejects(
      () => teardown({}),
      (err: any) => {
        assert.equal(err.code, ETEARDOWN_NOT_CONFIRMED);
        return true;
      },
    );
  });

  it('runs both removeHeartbeat and removeProject when confirmed', async () => {
    const removed: string[] = [];
    const result = await teardown({
      confirmed: true,
      projectDir: '/tmp/test-project',
      uninstallHeartbeatFn: makeUninstallStub('removed') as any,
      accessFn: makeAccessStub(true),
      rmFn: makeRmStub(removed),
    });

    assert.equal(result.ok, true);
    assert.ok(result.heartbeat !== null);
    assert.ok(result.project !== null);
    assert.equal(result.heartbeat!.ok, true);
    assert.equal(result.project!.ok, true);
    assert.equal(removed.length, 1);
  });
});
