/// <reference types="node" />
/**
 * Tests for `./use-agents.ts` — the Overview page's data-fetching hook.
 *
 * Sub-AC 3 contract:
 *   1. The hook calls the summary API endpoint (`GET /api/agents`).
 *   2. Loading, error, and success states flow through the underlying
 *      `resource-controller` state machine exactly once per refresh.
 *   3. `refresh()` re-invokes the loader.
 *   4. The hook forwards `baseUrl` / `fetch` options to `fetchAgentsList`
 *      so Storybook / tests / cross-origin dev setups can inject them.
 *
 * React hooks can't run without a renderer, so we exercise the *same*
 * loader composition that `useAgents` builds internally —
 * `fetchAgentsList` bound to test options — via the pure
 * `createResourceController`. This proves the wiring end-to-end without
 * needing jsdom / a JSX transform.
 *
 * AC 301 sub-AC 4.1 note: the hook source is `use-agents.ts`. We still
 * validate the source-level wiring with regex-on-text since the regex
 * checks are oblivious to the type-checker.
 *
 * AC 403 sub-AC 5.3 note: this suite was promoted from `node --test`
 * (raw `.js`) → vitest (`.ts`) in lockstep with `api-client.js` →
 * `api-client.ts`. Node's ESM resolver can't follow the `.js → .ts`
 * rewrite at runtime, so any `node --test` file that imports
 * `'../lib/api-client.js'` would fail to resolve. Vitest's bundler-style
 * resolver handles the indirection transparently. Vitest is invoked via
 * `pnpm test:spa`; the backend `node --test` suite continues to run via
 * `pnpm test`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAgentsList } from '../lib/api-client.js';

import { createResourceController } from './resource-controller.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface QueueResponseDescriptor {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
}

type QueueItem = QueueResponseDescriptor | Error | Promise<string>;

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface FetchStub {
  fetch: typeof fetch;
  calls: FetchCall[];
}

/**
 * Build a stub `fetch` that records each call and replies with the
 * queued responses in order.
 */
function makeFetchStub(queue: QueueItem | QueueItem[]): FetchStub {
  const calls: FetchCall[] = [];
  const items: QueueItem[] = Array.isArray(queue) ? [...queue] : [queue];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (items.length === 0) {
      throw new Error(`fetch stub called but queue is empty (url=${url})`);
    }
    const next = items.shift()!;
    if (next instanceof Error) return Promise.reject(next);
    const desc = next as QueueResponseDescriptor;
    const {
      ok = true,
      status = 200,
      statusText = 'OK',
      body = '',
    } = desc;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve({
      ok,
      status,
      statusText,
      text: () => Promise.resolve(text),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/**
 * Snapshot shape recorded by `captureStates`. Extra fields the
 * controller emits flow through the index signature without locking the
 * shape at the type-check layer.
 */
interface CapturedState {
  data: unknown;
  error: { message: string } | null;
  loading: boolean;
}

/** Record every state transition emitted by a controller. */
function captureStates(controller: {
  subscribe: (listener: (state: {
    data: unknown;
    error: Error | null;
    loading: boolean;
  }) => void) => () => void;
}): CapturedState[] {
  const snapshots: CapturedState[] = [];
  controller.subscribe((state) => {
    snapshots.push({
      data: state.data,
      error: state.error ? { message: state.error.message } : null,
      loading: state.loading,
    });
  });
  return snapshots;
}

// ── Source-level wiring checks ────────────────────────────────────────

describe('useAgents — module wiring', () => {
  const src = readFileSync(join(HERE, 'use-agents.ts'), 'utf8');

  it('imports fetchAgentsList from the api-client', () => {
    expect(src).toMatch(
      /import\s*\{\s*fetchAgentsList(?:\s*,[^}]*)?\s*\}\s*from\s*['"][^'"]*lib\/api-client\.js['"]/,
    );
  });

  it('imports useApiResource and delegates state handling to it', () => {
    expect(src).toMatch(
      /import\s*\{\s*useApiResource(?:\s*,[^}]*)?\s*\}\s*from\s*['"]\.\/use-api-resource\.js['"]/,
    );
    expect(src).toMatch(/useApiResource\s*(?:<[^>]+>)?\s*\(/);
  });

  it('exports useAgents as a named function', () => {
    expect(src).toMatch(/export\s+function\s+useAgents\s*\(/);
  });

  // AC 13: the polling option exists in the hook's options interface
  // and the body installs a `setInterval` keyed off it. We pin both
  // halves with regex so a future refactor that drops one or renames
  // the option can be caught at the source level even before the
  // behavioural test below runs.
  it('AC 13: declares pollIntervalMs option for background refresh', () => {
    expect(src).toMatch(/pollIntervalMs\s*\?\s*:\s*number\s*\|\s*null/);
  });

  it('AC 13: installs a setInterval that calls refresh() on the cadence', () => {
    expect(src).toMatch(/setInterval\s*\(/);
    expect(src).toMatch(/clearInterval\s*\(/);
    // The interval body forwards `refresh()` — anything else would
    // mean we're not actually polling the roster.
    expect(src).toMatch(/refresh\s*\(\s*\)/);
  });
});

// ── Loader wiring — the contract the hook delegates to ───────────────

describe('useAgents — summary endpoint wiring', () => {
  it('the loader composition hits GET /api/agents', async () => {
    const { fetch, calls } = makeFetchStub({
      ok: true,
      status: 200,
      body: { agents: [{ slug: 'writer', name: 'Writer' }] },
    });

    // This is the exact loader shape `useAgents` constructs internally.
    const loader = (opts: { signal: AbortSignal }) =>
      fetchAgentsList({ ...opts, fetch });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('/api/agents');
    expect(calls[0].init.method).toBe('GET');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json');
  });

  it('forwards baseUrl into the request URL', async () => {
    const { fetch, calls } = makeFetchStub({ body: { agents: [] } });

    const loader = (opts: { signal: AbortSignal }) =>
      fetchAgentsList({ ...opts, fetch, baseUrl: 'http://dashboard.test' });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    expect(calls[0].url).toBe('http://dashboard.test/api/agents');
  });

  it('forwards the abort signal so cancellation works', async () => {
    const { fetch, calls } = makeFetchStub({ body: { agents: [] } });

    const loader = (opts: { signal: AbortSignal }) =>
      fetchAgentsList({ ...opts, fetch });
    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    const signal = calls[0].init.signal;
    expect(signal).toBeTruthy();
    expect(typeof (signal as AbortSignal).aborted).toBe('boolean');
  });
});

// ── Loading / error state machine ────────────────────────────────────

describe('useAgents — loading/error state handling', () => {
  it('flows loading=true → success (data populated, error null)', async () => {
    const { fetch } = makeFetchStub({
      body: { agents: [{ slug: 'writer', name: 'Writer', status: 'active' }] },
    });
    const ctrl = createResourceController((opts: { signal: AbortSignal }) =>
      fetchAgentsList({ ...opts, fetch }),
    );
    const snapshots = captureStates(ctrl);

    await ctrl.refresh();

    // Expect exactly two transitions: loading=true, then success.
    expect(snapshots.length).toBe(2);
    expect(snapshots[0].loading).toBe(true);
    expect(snapshots[0].error).toBeNull();
    expect(snapshots[0].data).toBeNull();

    expect(snapshots[1].loading).toBe(false);
    expect(snapshots[1].error).toBeNull();
    expect(snapshots[1].data).toEqual({
      rows: [{ slug: 'writer', name: 'Writer', status: 'active' }],
      issues: [],
    });
  });

  it('flows loading=true → error on 500, keeps prior data for stale-with-banner UX', async () => {
    // First call succeeds (seed `data`), second call fails.
    const { fetch } = makeFetchStub([
      { body: { agents: [{ slug: 'writer', name: 'Writer' }] } },
      {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        body: { error: 'boom' },
      },
    ]);
    const ctrl = createResourceController((opts: { signal: AbortSignal }) =>
      fetchAgentsList({ ...opts, fetch }),
    );

    await ctrl.refresh();
    expect(ctrl.getState().data).toEqual({
      rows: [{ slug: 'writer', name: 'Writer' }],
      issues: [],
    });

    await ctrl.refresh();
    const final = ctrl.getState();
    expect(final.loading).toBe(false);
    expect(final.error).toBeTruthy();
    expect((final.error as Error).message).toMatch(/boom/);
    // Previous data must still be present so the page can render the
    // `StaleBanner` alongside the last-known Overview table.
    expect(final.data).toEqual({
      rows: [{ slug: 'writer', name: 'Writer' }],
      issues: [],
    });
  });

  it('flows loading=true → error on network failure (status=0)', async () => {
    const { fetch } = makeFetchStub(new Error('ECONNREFUSED'));
    const ctrl = createResourceController((opts: { signal: AbortSignal }) =>
      fetchAgentsList({ ...opts, fetch }),
    );
    await ctrl.refresh();
    const { error, loading, data } = ctrl.getState();
    expect(loading).toBe(false);
    expect(data).toBeNull();
    expect(error).toBeTruthy();
    expect((error as Error).message).toMatch(/ECONNREFUSED/);
  });

  it('refresh() re-invokes the loader (Refresh button contract)', async () => {
    const { fetch, calls } = makeFetchStub([
      { body: { agents: [{ slug: 'one' }] } },
      { body: { agents: [{ slug: 'two' }] } },
    ]);
    const ctrl = createResourceController((opts: { signal: AbortSignal }) =>
      fetchAgentsList({ ...opts, fetch }),
    );

    await ctrl.refresh();
    expect(ctrl.getState().data).toEqual({
      rows: [{ slug: 'one' }],
      issues: [],
    });

    await ctrl.refresh();
    expect(ctrl.getState().data).toEqual({
      rows: [{ slug: 'two' }],
      issues: [],
    });
    expect(calls.length).toBe(2);
  });

  it('drops stale responses when refresh is called while one is in flight', async () => {
    // Manually-resolved promises so we control ordering.
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const pA = new Promise<string>((r) => {
      resolveA = r;
    });
    const pB = new Promise<string>((r) => {
      resolveB = r;
    });
    const queue: Promise<string>[] = [pA, pB];

    const fetchImpl = (() => {
      const next = queue.shift();
      return next!.then(
        (text) =>
          ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: () => Promise.resolve(text),
          }) as unknown as Response,
      );
    }) as unknown as typeof fetch;

    const ctrl = createResourceController((opts: { signal: AbortSignal }) =>
      fetchAgentsList({ ...opts, fetch: fetchImpl }),
    );

    const first = ctrl.refresh();
    const second = ctrl.refresh();

    // Resolve second *first*, then first. The late-arriving first response
    // must NOT overwrite the fresh second one.
    resolveB(JSON.stringify({ agents: [{ slug: 'b' }] }));
    await second;
    expect(ctrl.getState().data).toEqual({
      rows: [{ slug: 'b' }],
      issues: [],
    });

    resolveA(JSON.stringify({ agents: [{ slug: 'a' }] }));
    await first;
    expect(ctrl.getState().data).toEqual({
      rows: [{ slug: 'b' }],
      issues: [],
    });
  });
});
