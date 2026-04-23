/**
 * Tests for `./resource-controller.js`.
 *
 * The controller is a pure, React-free state machine — tests here exercise
 * the full loading / error / abort / dedupe lifecycle against an injected
 * loader function, without needing any DOM or React test renderer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createResourceController } from './resource-controller.js';

/** Deferred promise helper — lets tests control resolution ordering. */
function defer() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Snapshot-the-sequence of state updates a controller emits. */
function captureStates(controller) {
  const snapshots = [];
  const unsub = controller.subscribe((state) => {
    // Structured clone via JSON round-trip so later mutations (e.g. by
    // `setState`'s shallow merge) can't retroactively alter snapshots.
    snapshots.push({
      data: state.data,
      error: state.error ? { message: state.error.message } : null,
      loading: state.loading,
    });
  });
  return { snapshots, unsub };
}

describe('createResourceController', () => {
  it('throws if loader is not a function', () => {
    assert.throws(() => createResourceController(undefined), TypeError);
    assert.throws(() => createResourceController(42), TypeError);
    assert.throws(() => createResourceController(null), TypeError);
  });

  it('starts with idle state (no data, no error, not loading)', () => {
    const ctrl = createResourceController(async () => 'x');
    const state = ctrl.getState();
    assert.equal(state.data, null);
    assert.equal(state.error, null);
    assert.equal(state.loading, false);
  });

  it('refresh() flips loading=true, then emits data on success', async () => {
    const d = defer();
    const ctrl = createResourceController(() => d.promise);
    const { snapshots } = captureStates(ctrl);

    const pending = ctrl.refresh();
    // Synchronous side effect: loading flipped true, error cleared.
    assert.equal(ctrl.getState().loading, true);
    assert.equal(ctrl.getState().error, null);

    d.resolve({ hello: 'world' });
    await pending;

    assert.deepEqual(ctrl.getState().data, { hello: 'world' });
    assert.equal(ctrl.getState().loading, false);
    assert.equal(ctrl.getState().error, null);

    // Sequence of emitted states: loading → success.
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].loading, true);
    assert.deepEqual(snapshots[1].data, { hello: 'world' });
  });

  it('refresh() reports error and keeps prior data intact', async () => {
    let call = 0;
    const ctrl = createResourceController(async () => {
      call += 1;
      if (call === 1) return { first: true };
      throw new Error('boom');
    });

    await ctrl.refresh();
    assert.deepEqual(ctrl.getState().data, { first: true });

    await ctrl.refresh();
    // Error surfaces, but `data` stays so components can render stale-with-banner.
    assert.equal(ctrl.getState().error.message, 'boom');
    assert.deepEqual(ctrl.getState().data, { first: true });
    assert.equal(ctrl.getState().loading, false);
  });

  it('wraps non-Error rejections into Error instances', async () => {
    const ctrl = createResourceController(async () => {
      // Simulate a loader rejecting with a plain string (bad practice
      // but possible in user code / third-party libs).
      // eslint-disable-next-line no-throw-literal
      throw 'plain-string';
    });
    await ctrl.refresh();
    const { error } = ctrl.getState();
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'plain-string');
  });

  it('aborts the in-flight loader when refresh() is called again', async () => {
    /** @type {AbortSignal[]} */
    const signals = [];
    const d1 = defer();
    const d2 = defer();
    const queue = [d1.promise, d2.promise];
    const ctrl = createResourceController(({ signal }) => {
      signals.push(signal);
      return queue.shift();
    });

    const first = ctrl.refresh();
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, false);

    const second = ctrl.refresh();
    // First signal must be aborted by the second refresh.
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);

    // First resolving after it was aborted must NOT flip state to its value.
    d1.resolve({ stale: true });
    await first;
    assert.equal(ctrl.getState().data, null);
    assert.equal(ctrl.getState().loading, true);

    d2.resolve({ fresh: true });
    await second;
    assert.deepEqual(ctrl.getState().data, { fresh: true });
    assert.equal(ctrl.getState().loading, false);
  });

  it('ignores AbortError rejections from the loader', async () => {
    const ctrl = createResourceController(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    await ctrl.refresh();
    assert.equal(ctrl.getState().error, null);
    assert.equal(ctrl.getState().data, null);
    // Loading may still be true because we neither succeeded nor failed
    // "legitimately". This matches the semantics of a cancelled request.
    assert.equal(ctrl.getState().loading, true);
  });

  it('ignores Node-style ABORT_ERR rejections from the loader', async () => {
    const ctrl = createResourceController(async () => {
      const err = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
      throw err;
    });
    await ctrl.refresh();
    assert.equal(ctrl.getState().error, null);
  });

  it('drops late-arriving responses when superseded by a newer refresh', async () => {
    const d1 = defer();
    const d2 = defer();
    let call = 0;
    const ctrl = createResourceController(() => {
      call += 1;
      return call === 1 ? d1.promise : d2.promise;
    });

    const first = ctrl.refresh();
    const second = ctrl.refresh();

    // Resolve second first — this should win.
    d2.resolve('B');
    await second;
    assert.equal(ctrl.getState().data, 'B');

    // Late arrival from the first call must be discarded even though it
    // technically resolved (not aborted) — the generation guard catches it.
    d1.resolve('A');
    await first;
    assert.equal(ctrl.getState().data, 'B');
  });

  it('subscribe() returns an unsubscribe thunk that stops further updates', async () => {
    const ctrl = createResourceController(async () => 'ok');
    const { snapshots, unsub } = captureStates(ctrl);

    await ctrl.refresh();
    assert.equal(snapshots.length, 2); // loading + success

    unsub();
    await ctrl.refresh();
    assert.equal(snapshots.length, 2); // no additional emissions
  });

  it('subscribe() rejects non-function listeners', () => {
    const ctrl = createResourceController(async () => 'ok');
    assert.throws(() => ctrl.subscribe(undefined), TypeError);
    assert.throws(() => ctrl.subscribe('not a fn'), TypeError);
  });

  it('isolates a faulty listener from other listeners', async () => {
    const ctrl = createResourceController(async () => 'ok');
    const otherCalls = [];
    ctrl.subscribe(() => {
      throw new Error('faulty');
    });
    ctrl.subscribe((state) => otherCalls.push(state.loading));
    await ctrl.refresh();
    // Despite the first listener throwing, the second still receives both
    // transitions (loading=true, loading=false).
    assert.deepEqual(otherCalls, [true, false]);
  });

  it('destroy() aborts the in-flight loader and clears listeners', async () => {
    /** @type {AbortSignal | null} */
    let capturedSignal = null;
    const d = defer();
    const ctrl = createResourceController(({ signal }) => {
      capturedSignal = signal;
      return d.promise;
    });
    const { snapshots } = captureStates(ctrl);

    const pending = ctrl.refresh();
    assert.equal(capturedSignal.aborted, false);

    ctrl.destroy();
    assert.equal(capturedSignal.aborted, true);

    // Even if the loader resolves after destroy(), no more snapshots.
    d.resolve({ leaked: true });
    await pending;
    assert.equal(snapshots.length, 1); // only the initial loading=true transition
  });

  it('destroy() is idempotent', () => {
    const ctrl = createResourceController(async () => 'x');
    ctrl.destroy();
    assert.doesNotThrow(() => ctrl.destroy());
  });

  it('refresh() after destroy() is a no-op', async () => {
    let loaderCalled = 0;
    const ctrl = createResourceController(async () => {
      loaderCalled += 1;
      return 'x';
    });
    ctrl.destroy();
    await ctrl.refresh();
    assert.equal(loaderCalled, 0);
  });
});
