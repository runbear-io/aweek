/**
 * Tests for `./resource-controller.ts`.
 *
 * The controller is a pure, React-free state machine — tests here exercise
 * the full loading / error / abort / dedupe lifecycle against an injected
 * loader function, without needing any DOM or React test renderer.
 *
 * TypeScript migration note (seed-09 sub-seed B): this suite was promoted
 * from `node --test` (raw `.js`) → vitest (`.ts`) alongside the production
 * module migration. Vitest's bundler-style resolver handles the `.js → .ts`
 * import indirection cleanly; Node's ESM resolver can't.
 */

import { describe, it, expect } from 'vitest';

import { createResourceController } from './resource-controller.js';

/** Deferred promise helper — lets tests control resolution ordering. */
function defer<T = unknown>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Snapshot shape recorded by `captureStates`. */
interface CapturedState {
  data: unknown;
  error: { message: string } | null;
  loading: boolean;
}

/** Snapshot-the-sequence of state updates a controller emits. */
function captureStates(controller: {
  subscribe: (listener: (state: {
    data: unknown;
    error: Error | null;
    loading: boolean;
  }) => void) => () => void;
}): { snapshots: CapturedState[]; unsub: () => void } {
  const snapshots: CapturedState[] = [];
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
    expect(() => createResourceController(undefined as unknown as never)).toThrow(TypeError);
    expect(() => createResourceController(42 as unknown as never)).toThrow(TypeError);
    expect(() => createResourceController(null as unknown as never)).toThrow(TypeError);
  });

  it('starts with idle state (no data, no error, not loading)', () => {
    const ctrl = createResourceController(async () => 'x');
    const state = ctrl.getState();
    expect(state.data).toBe(null);
    expect(state.error).toBe(null);
    expect(state.loading).toBe(false);
  });

  it('refresh() flips loading=true, then emits data on success', async () => {
    const d = defer<{ hello: string }>();
    const ctrl = createResourceController(() => d.promise);
    const { snapshots } = captureStates(ctrl);

    const pending = ctrl.refresh();
    // Synchronous side effect: loading flipped true, error cleared.
    expect(ctrl.getState().loading).toBe(true);
    expect(ctrl.getState().error).toBe(null);

    d.resolve({ hello: 'world' });
    await pending;

    expect(ctrl.getState().data).toEqual({ hello: 'world' });
    expect(ctrl.getState().loading).toBe(false);
    expect(ctrl.getState().error).toBe(null);

    // Sequence of emitted states: loading → success.
    expect(snapshots.length).toBe(2);
    expect(snapshots[0].loading).toBe(true);
    expect(snapshots[1].data).toEqual({ hello: 'world' });
  });

  it('refresh() reports error and keeps prior data intact', async () => {
    let call = 0;
    const ctrl = createResourceController(async () => {
      call += 1;
      if (call === 1) return { first: true };
      throw new Error('boom');
    });

    await ctrl.refresh();
    expect(ctrl.getState().data).toEqual({ first: true });

    await ctrl.refresh();
    // Error surfaces, but `data` stays so components can render stale-with-banner.
    expect(ctrl.getState().error?.message).toBe('boom');
    expect(ctrl.getState().data).toEqual({ first: true });
    expect(ctrl.getState().loading).toBe(false);
  });

  it('wraps non-Error rejections into Error instances', async () => {
    const ctrl = createResourceController(async () => {
      // Simulate a loader rejecting with a plain string (bad practice
      // but possible in user code / third-party libs).
      throw 'plain-string';
    });
    await ctrl.refresh();
    const { error } = ctrl.getState();
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe('plain-string');
  });

  it('aborts the in-flight loader when refresh() is called again', async () => {
    const signals: AbortSignal[] = [];
    const d1 = defer<{ stale: boolean }>();
    const d2 = defer<{ fresh: boolean }>();
    const queue: Array<Promise<{ stale: boolean } | { fresh: boolean }>> = [
      d1.promise,
      d2.promise,
    ];
    const ctrl = createResourceController(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return queue.shift()!;
    });

    const first = ctrl.refresh();
    expect(signals.length).toBe(1);
    expect(signals[0].aborted).toBe(false);

    const second = ctrl.refresh();
    // First signal must be aborted by the second refresh.
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);

    // First resolving after it was aborted must NOT flip state to its value.
    d1.resolve({ stale: true });
    await first;
    expect(ctrl.getState().data).toBe(null);
    expect(ctrl.getState().loading).toBe(true);

    d2.resolve({ fresh: true });
    await second;
    expect(ctrl.getState().data).toEqual({ fresh: true });
    expect(ctrl.getState().loading).toBe(false);
  });

  it('ignores AbortError rejections from the loader', async () => {
    const ctrl = createResourceController(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    await ctrl.refresh();
    expect(ctrl.getState().error).toBe(null);
    expect(ctrl.getState().data).toBe(null);
    // Loading may still be true because we neither succeeded nor failed
    // "legitimately". This matches the semantics of a cancelled request.
    expect(ctrl.getState().loading).toBe(true);
  });

  it('ignores Node-style ABORT_ERR rejections from the loader', async () => {
    const ctrl = createResourceController(async () => {
      const err = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
      throw err;
    });
    await ctrl.refresh();
    expect(ctrl.getState().error).toBe(null);
  });

  it('drops late-arriving responses when superseded by a newer refresh', async () => {
    const d1 = defer<string>();
    const d2 = defer<string>();
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
    expect(ctrl.getState().data).toBe('B');

    // Late arrival from the first call must be discarded even though it
    // technically resolved (not aborted) — the generation guard catches it.
    d1.resolve('A');
    await first;
    expect(ctrl.getState().data).toBe('B');
  });

  it('subscribe() returns an unsubscribe thunk that stops further updates', async () => {
    const ctrl = createResourceController(async () => 'ok');
    const { snapshots, unsub } = captureStates(ctrl);

    await ctrl.refresh();
    expect(snapshots.length).toBe(2); // loading + success

    unsub();
    await ctrl.refresh();
    expect(snapshots.length).toBe(2); // no additional emissions
  });

  it('subscribe() rejects non-function listeners', () => {
    const ctrl = createResourceController(async () => 'ok');
    expect(() => ctrl.subscribe(undefined as unknown as never)).toThrow(TypeError);
    expect(() => ctrl.subscribe('not a fn' as unknown as never)).toThrow(TypeError);
  });

  it('isolates a faulty listener from other listeners', async () => {
    const ctrl = createResourceController(async () => 'ok');
    const otherCalls: boolean[] = [];
    ctrl.subscribe(() => {
      throw new Error('faulty');
    });
    ctrl.subscribe((state) => otherCalls.push(state.loading));
    await ctrl.refresh();
    // Despite the first listener throwing, the second still receives both
    // transitions (loading=true, loading=false).
    expect(otherCalls).toEqual([true, false]);
  });

  it('destroy() aborts the in-flight loader and clears listeners', async () => {
    let capturedSignal: AbortSignal | null = null;
    const d = defer<{ leaked: boolean }>();
    const ctrl = createResourceController(({ signal }: { signal: AbortSignal }) => {
      capturedSignal = signal;
      return d.promise;
    });
    const { snapshots } = captureStates(ctrl);

    const pending = ctrl.refresh();
    expect(capturedSignal!.aborted).toBe(false);

    ctrl.destroy();
    expect(capturedSignal!.aborted).toBe(true);

    // Even if the loader resolves after destroy(), no more snapshots.
    d.resolve({ leaked: true });
    await pending;
    expect(snapshots.length).toBe(1); // only the initial loading=true transition
  });

  it('destroy() is idempotent', () => {
    const ctrl = createResourceController(async () => 'x');
    ctrl.destroy();
    expect(() => ctrl.destroy()).not.toThrow();
  });

  it('refresh() after destroy() is a no-op', async () => {
    let loaderCalled = 0;
    const ctrl = createResourceController(async () => {
      loaderCalled += 1;
      return 'x';
    });
    ctrl.destroy();
    await ctrl.refresh();
    expect(loaderCalled).toBe(0);
  });
});
