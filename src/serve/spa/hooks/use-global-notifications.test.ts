/// <reference types="node" />
/**
 * Tests for `./use-global-notifications.ts` — the dashboard global inbox
 * data-fetching hook.
 *
 * AC 8 sub-AC 2 contract:
 *   1. The hook calls the global notifications endpoint
 *      (`GET /api/notifications`).
 *   2. Loading, error, and success states flow through the underlying
 *      `resource-controller` state machine exactly once per refresh.
 *   3. `refresh()` re-invokes the loader.
 *   4. The hook forwards `baseUrl` / `fetch` options to
 *      `fetchAllNotifications` so Storybook / tests / cross-origin dev
 *      setups can inject them.
 *   5. Filter options (`source`, `systemEvent`, `read`, `limit`) reach
 *      the request URL as query-string params; booleans are projected to
 *      their `'true' / 'false'` wire form.
 *
 * React hooks can't run without a renderer, so we exercise the *same*
 * loader composition that `useGlobalNotifications` builds internally —
 * `fetchAllNotifications` bound to test options — via the pure
 * `createResourceController`. This proves the wiring end-to-end without
 * needing jsdom / a JSX transform.
 *
 * The vitest harness is invoked via `pnpm test:spa`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAllNotifications } from '../lib/api-client.js';

import { createResourceController } from './resource-controller.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface QueueResponseDescriptor {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
}

type QueueItem = QueueResponseDescriptor | Error;

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

describe('useGlobalNotifications — module wiring', () => {
  const src = readFileSync(join(HERE, 'use-global-notifications.ts'), 'utf8');

  it('imports fetchAllNotifications from the api-client', () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?fetchAllNotifications[\s\S]*?\}\s*from\s*['"][^'"]*lib\/api-client\.js['"]/,
    );
  });

  it('imports useApiResource and delegates state handling to it', () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?useApiResource[\s\S]*?\}\s*from\s*['"]\.\/use-api-resource\.js['"]/,
    );
    expect(src).toMatch(/useApiResource\s*(?:<[^>]+>)?\s*\(/);
  });

  it('exports useGlobalNotifications as a named function', () => {
    expect(src).toMatch(/export\s+function\s+useGlobalNotifications\s*\(/);
  });
});

// ── Loader wiring — the contract the hook delegates to ───────────────

describe('useGlobalNotifications — global feed endpoint wiring', () => {
  it('the loader composition hits GET /api/notifications', async () => {
    const { fetch, calls } = makeFetchStub({
      ok: true,
      status: 200,
      body: { notifications: [], unreadCount: 0 },
    });

    // This is the exact loader shape `useGlobalNotifications` constructs
    // internally — we exercise it via the pure resource controller so
    // the wiring is validated without rendering React.
    const loader = (opts: { signal: AbortSignal }) =>
      fetchAllNotifications({ ...opts, fetch });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('/api/notifications');
    expect(calls[0].init.method).toBe('GET');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json');
  });

  it('forwards baseUrl into the request URL', async () => {
    const { fetch, calls } = makeFetchStub({
      body: { notifications: [], unreadCount: 0 },
    });

    const loader = (opts: { signal: AbortSignal }) =>
      fetchAllNotifications({ ...opts, fetch, baseUrl: 'http://dashboard.test' });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    expect(calls[0].url).toBe('http://dashboard.test/api/notifications');
  });

  it('forwards filter options as query-string params', async () => {
    const { fetch, calls } = makeFetchStub({
      body: { notifications: [], unreadCount: 0 },
    });

    const loader = (opts: { signal: AbortSignal }) =>
      fetchAllNotifications({
        ...opts,
        fetch,
        source: 'system',
        systemEvent: 'budget-exhausted',
        read: false,
        limit: 50,
      });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    const url = calls[0].url;
    // URLSearchParams orders by insertion; we assert each filter is
    // present rather than locking the order, since the api-client
    // `searchParams` projection can reorder keys without changing the
    // semantic contract.
    expect(url.startsWith('/api/notifications?')).toBe(true);
    expect(url).toContain('source=system');
    expect(url).toContain('systemEvent=budget-exhausted');
    expect(url).toContain('read=false');
    expect(url).toContain('limit=50');
  });

  it('omits filter params that are undefined', async () => {
    const { fetch, calls } = makeFetchStub({
      body: { notifications: [], unreadCount: 0 },
    });

    const loader = (opts: { signal: AbortSignal }) =>
      fetchAllNotifications({ ...opts, fetch });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    expect(calls[0].url).toBe('/api/notifications');
  });

  it('projects read=true to the wire form', async () => {
    const { fetch, calls } = makeFetchStub({
      body: { notifications: [], unreadCount: 0 },
    });

    const loader = (opts: { signal: AbortSignal }) =>
      fetchAllNotifications({ ...opts, fetch, read: true });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    expect(calls[0].url).toContain('read=true');
  });

  it('forwards the abort signal so cancellation works', async () => {
    const { fetch, calls } = makeFetchStub({
      body: { notifications: [], unreadCount: 0 },
    });

    const loader = (opts: { signal: AbortSignal }) =>
      fetchAllNotifications({ ...opts, fetch });
    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    const signal = calls[0].init.signal;
    expect(signal).toBeTruthy();
    expect(typeof (signal as AbortSignal).aborted).toBe('boolean');
  });
});

// ── Loading / error state machine ────────────────────────────────────

describe('useGlobalNotifications — loading/error state handling', () => {
  it('flows loading=true → success (data populated, error null)', async () => {
    const payload = {
      notifications: [
        {
          id: 'notif-aaaa1111',
          agent: 'writer',
          agentId: 'writer',
          source: 'agent',
          title: 'hello',
          body: 'hi there',
          createdAt: '2026-04-27T12:00:00.000Z',
          read: false,
        },
      ],
      unreadCount: 1,
    };
    const { fetch } = makeFetchStub({ body: payload });

    const ctrl = createResourceController((opts: { signal: AbortSignal }) =>
      fetchAllNotifications({ ...opts, fetch }),
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
    expect(snapshots[1].data).toEqual(payload);
  });

  it('flows loading=true → error on 500, keeps prior data for stale-with-banner UX', async () => {
    const seed = {
      notifications: [
        {
          id: 'notif-bbbb2222',
          agent: 'writer',
          agentId: 'writer',
          source: 'agent',
          title: 'one',
          body: 'b',
          createdAt: '2026-04-27T12:00:00.000Z',
          read: false,
        },
      ],
      unreadCount: 1,
    };
    const { fetch } = makeFetchStub([
      { body: seed },
      {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        body: { error: 'boom' },
      },
    ]);

    const ctrl = createResourceController((opts: { signal: AbortSignal }) =>
      fetchAllNotifications({ ...opts, fetch }),
    );

    await ctrl.refresh();
    expect(ctrl.getState().data).toEqual(seed);

    await ctrl.refresh();
    const final = ctrl.getState();
    expect(final.loading).toBe(false);
    expect(final.error).toBeTruthy();
    expect((final.error as Error).message).toMatch(/boom/);
    // Previous data must still be present so the page can render the
    // stale banner alongside the last-known feed.
    expect(final.data).toEqual(seed);
  });

  it('flows loading=true → error on network failure (status=0)', async () => {
    const { fetch } = makeFetchStub(new Error('ECONNREFUSED'));
    const ctrl = createResourceController((opts: { signal: AbortSignal }) =>
      fetchAllNotifications({ ...opts, fetch }),
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
      { body: { notifications: [], unreadCount: 0 } },
      {
        body: {
          notifications: [
            {
              id: 'notif-cccc3333',
              agent: 'writer',
              agentId: 'writer',
              source: 'agent',
              title: 'fresh',
              body: 'after refresh',
              createdAt: '2026-04-27T13:00:00.000Z',
              read: false,
            },
          ],
          unreadCount: 1,
        },
      },
    ]);

    const ctrl = createResourceController((opts: { signal: AbortSignal }) =>
      fetchAllNotifications({ ...opts, fetch }),
    );

    await ctrl.refresh();
    expect(ctrl.getState().data).toEqual({
      notifications: [],
      unreadCount: 0,
    });

    await ctrl.refresh();
    expect((ctrl.getState().data as { unreadCount: number }).unreadCount).toBe(1);
    expect(calls.length).toBe(2);
  });

  it('returns sane defaults when the server omits envelope fields', async () => {
    // Simulate a partial / malformed payload — `fetchAllNotifications`
    // shields the SPA from this by defaulting `notifications` to []
    // and `unreadCount` to 0.
    const { fetch } = makeFetchStub({ body: {} });
    const ctrl = createResourceController((opts: { signal: AbortSignal }) =>
      fetchAllNotifications({ ...opts, fetch }),
    );
    await ctrl.refresh();
    expect(ctrl.getState().data).toEqual({
      notifications: [],
      unreadCount: 0,
    });
  });
});
