/**
 * Tests for `./use-agents.js` — the Overview page's data-fetching hook.
 *
 * Sub-AC 3 contract:
 *   1. The hook calls the summary API endpoint (`GET /api/agents`).
 *   2. Loading, error, and success states flow through the underlying
 *      `resource-controller` state machine exactly once per refresh.
 *   3. `refresh()` re-invokes the loader.
 *   4. The hook forwards `baseUrl` / `fetch` options to `fetchAgentsList`
 *      so Storybook / tests / cross-origin dev setups can inject them.
 *
 * React hooks can't run under `node --test` without a renderer, so we
 * exercise the *same* loader composition that `useAgents` builds
 * internally — `fetchAgentsList` bound to test options — via the pure
 * `createResourceController`. This proves the wiring end-to-end without
 * needing jsdom / a JSX transform.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAgentsList } from '../lib/api-client.js';

import { createResourceController } from './resource-controller.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Build a stub `fetch` that records each call and replies with the
 * queued responses in order.
 */
function makeFetchStub(queue) {
  const calls = [];
  const items = Array.isArray(queue) ? [...queue] : [queue];
  const fetchImpl = (url, init) => {
    calls.push({ url, init });
    if (items.length === 0) {
      throw new Error(`fetch stub called but queue is empty (url=${url})`);
    }
    const next = items.shift();
    if (next instanceof Error) return Promise.reject(next);
    const { ok = true, status = 200, statusText = 'OK', body = '' } = next || {};
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve({
      ok,
      status,
      statusText,
      text: () => Promise.resolve(text),
    });
  };
  return { fetch: fetchImpl, calls };
}

/** Record every state transition emitted by a controller. */
function captureStates(controller) {
  const snapshots = [];
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
  const src = readFileSync(join(HERE, 'use-agents.js'), 'utf8');

  it('imports fetchAgentsList from the api-client', () => {
    assert.match(
      src,
      /import\s*\{\s*fetchAgentsList\s*\}\s*from\s*['"][^'"]*lib\/api-client\.js['"]/,
      'use-agents.js must import { fetchAgentsList } from ../lib/api-client.js',
    );
  });

  it('imports useApiResource and delegates state handling to it', () => {
    assert.match(
      src,
      /import\s*\{\s*useApiResource\s*\}\s*from\s*['"]\.\/use-api-resource\.js['"]/,
      'use-agents.js must import { useApiResource } from ./use-api-resource.js',
    );
    assert.match(
      src,
      /useApiResource\s*\(/,
      'use-agents.js must call useApiResource(...) — loading/error/refresh come from the base hook',
    );
  });

  it('exports useAgents as a named function', () => {
    assert.match(
      src,
      /export\s+function\s+useAgents\s*\(/,
      'use-agents.js must export a named `useAgents` function',
    );
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
    const loader = (opts) => fetchAgentsList({ ...opts, fetch });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/agents');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers.Accept, 'application/json');
  });

  it('forwards baseUrl into the request URL', async () => {
    const { fetch, calls } = makeFetchStub({ body: { agents: [] } });

    const loader = (opts) =>
      fetchAgentsList({ ...opts, fetch, baseUrl: 'http://dashboard.test' });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    assert.equal(calls[0].url, 'http://dashboard.test/api/agents');
  });

  it('forwards the abort signal so cancellation works', async () => {
    const { fetch, calls } = makeFetchStub({ body: { agents: [] } });

    const loader = (opts) => fetchAgentsList({ ...opts, fetch });
    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    assert.ok(
      calls[0].init.signal && typeof calls[0].init.signal.aborted === 'boolean',
      'hook loader must forward an AbortSignal to fetchAgentsList',
    );
  });
});

// ── Loading / error state machine ────────────────────────────────────

describe('useAgents — loading/error state handling', () => {
  it('flows loading=true → success (data populated, error null)', async () => {
    const { fetch } = makeFetchStub({
      body: { agents: [{ slug: 'writer', name: 'Writer', status: 'active' }] },
    });
    const ctrl = createResourceController((opts) =>
      fetchAgentsList({ ...opts, fetch }),
    );
    const snapshots = captureStates(ctrl);

    await ctrl.refresh();

    // Expect exactly two transitions: loading=true, then success.
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].loading, true);
    assert.equal(snapshots[0].error, null);
    assert.equal(snapshots[0].data, null);

    assert.equal(snapshots[1].loading, false);
    assert.equal(snapshots[1].error, null);
    assert.deepEqual(snapshots[1].data, [
      { slug: 'writer', name: 'Writer', status: 'active' },
    ]);
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
    const ctrl = createResourceController((opts) =>
      fetchAgentsList({ ...opts, fetch }),
    );

    await ctrl.refresh();
    assert.deepEqual(ctrl.getState().data, [{ slug: 'writer', name: 'Writer' }]);

    await ctrl.refresh();
    const final = ctrl.getState();
    assert.equal(final.loading, false);
    assert.ok(final.error, 'error must be set after 500');
    assert.match(final.error.message, /boom/);
    // Previous data must still be present so the page can render the
    // `StaleBanner` alongside the last-known Overview table.
    assert.deepEqual(final.data, [{ slug: 'writer', name: 'Writer' }]);
  });

  it('flows loading=true → error on network failure (status=0)', async () => {
    const { fetch } = makeFetchStub(new Error('ECONNREFUSED'));
    const ctrl = createResourceController((opts) =>
      fetchAgentsList({ ...opts, fetch }),
    );
    await ctrl.refresh();
    const { error, loading, data } = ctrl.getState();
    assert.equal(loading, false);
    assert.equal(data, null);
    assert.ok(error);
    assert.match(error.message, /ECONNREFUSED/);
  });

  it('refresh() re-invokes the loader (Refresh button contract)', async () => {
    const { fetch, calls } = makeFetchStub([
      { body: { agents: [{ slug: 'one' }] } },
      { body: { agents: [{ slug: 'two' }] } },
    ]);
    const ctrl = createResourceController((opts) =>
      fetchAgentsList({ ...opts, fetch }),
    );

    await ctrl.refresh();
    assert.deepEqual(ctrl.getState().data, [{ slug: 'one' }]);

    await ctrl.refresh();
    assert.deepEqual(ctrl.getState().data, [{ slug: 'two' }]);
    assert.equal(calls.length, 2);
  });

  it('drops stale responses when refresh is called while one is in flight', async () => {
    // Manually-resolved promises so we control ordering.
    let resolveA;
    let resolveB;
    const pA = new Promise((r) => {
      resolveA = r;
    });
    const pB = new Promise((r) => {
      resolveB = r;
    });
    const queue = [pA, pB];

    const fetchImpl = () => {
      const next = queue.shift();
      return next.then((text) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve(text),
      }));
    };

    const ctrl = createResourceController((opts) =>
      fetchAgentsList({ ...opts, fetch: fetchImpl }),
    );

    const first = ctrl.refresh();
    const second = ctrl.refresh();

    // Resolve second *first*, then first. The late-arriving first response
    // must NOT overwrite the fresh second one.
    resolveB(JSON.stringify({ agents: [{ slug: 'b' }] }));
    await second;
    assert.deepEqual(ctrl.getState().data, [{ slug: 'b' }]);

    resolveA(JSON.stringify({ agents: [{ slug: 'a' }] }));
    await first;
    assert.deepEqual(
      ctrl.getState().data,
      [{ slug: 'b' }],
      'stale response must be dropped',
    );
  });
});
