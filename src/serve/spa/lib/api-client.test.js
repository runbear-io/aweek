/**
 * Tests for `src/serve/spa/lib/api-client.js` — SPA-side fetch wrappers
 * around the read-only JSON endpoints exposed by `aweek serve`.
 *
 * These tests never start a real HTTP server; they inject a stub
 * `fetch` and assert:
 *   - URL construction (baseUrl + path + query string + encoded slug)
 *   - Envelope unwrapping (`{ agents: [...] }` → `[...]`)
 *   - Error propagation (non-2xx → `ApiError` with status + message)
 *   - Slug validation (path traversal / NUL / empty → TypeError)
 *   - AbortSignal plumbing (forwarded to the underlying fetch)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ApiError,
  fetchAgentsList,
  fetchAgentProfile,
  fetchAgentPlan,
  fetchAgentUsage,
  fetchAgentLogs,
  __test,
} from './api-client.js';

const { assertValidSlug, joinUrl } = __test;

/**
 * Build a stub `fetch` that records each call and replies with the
 * queued responses in order. Each queued entry is either a full
 * `Response`-like `{ ok, status, statusText, text }` descriptor or an
 * Error to throw synchronously (simulates network failure).
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
    const {
      ok = true,
      status = 200,
      statusText = 'OK',
      body = '',
    } = next || {};
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

// ── Helpers ────────────────────────────────────────────────────────────

describe('joinUrl()', () => {
  it('returns endpoint as-is when baseUrl is empty', () => {
    assert.equal(joinUrl('', '/api/agents'), '/api/agents');
  });

  it('joins baseUrl + endpoint with exactly one slash', () => {
    assert.equal(joinUrl('http://x', '/api/agents'), 'http://x/api/agents');
    assert.equal(joinUrl('http://x/', '/api/agents'), 'http://x/api/agents');
    assert.equal(joinUrl('http://x/', 'api/agents'), 'http://x/api/agents');
    assert.equal(joinUrl('http://x', 'api/agents'), 'http://x/api/agents');
  });
});

describe('assertValidSlug()', () => {
  it('accepts normal slugs', () => {
    assert.equal(assertValidSlug('writer'), 'writer');
    assert.equal(assertValidSlug('some-agent_123'), 'some-agent_123');
  });

  it('rejects non-strings and empty strings', () => {
    assert.throws(() => assertValidSlug(undefined), TypeError);
    assert.throws(() => assertValidSlug(null), TypeError);
    assert.throws(() => assertValidSlug(42), TypeError);
    assert.throws(() => assertValidSlug(''), TypeError);
  });

  it('rejects path-traversal shapes', () => {
    assert.throws(() => assertValidSlug('../evil'), TypeError);
    assert.throws(() => assertValidSlug('a/b'), TypeError);
    assert.throws(() => assertValidSlug('a\\b'), TypeError);
    assert.throws(() => assertValidSlug('a\0b'), TypeError);
    assert.throws(() => assertValidSlug('.'), TypeError);
    assert.throws(() => assertValidSlug('..'), TypeError);
  });
});

// ── fetchAgentsList ───────────────────────────────────────────────────

describe('fetchAgentsList()', () => {
  it('GETs /api/agents and unwraps the envelope', async () => {
    const { fetch, calls } = makeFetchStub({
      ok: true,
      status: 200,
      body: { agents: [{ slug: 'writer', name: 'Writer' }] },
    });
    const rows = await fetchAgentsList({ fetch });
    assert.deepEqual(rows, [{ slug: 'writer', name: 'Writer' }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/agents');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers.Accept, 'application/json');
  });

  it('honors baseUrl', async () => {
    const { fetch, calls } = makeFetchStub({
      body: { agents: [] },
    });
    await fetchAgentsList({ fetch, baseUrl: 'http://example.test' });
    assert.equal(calls[0].url, 'http://example.test/api/agents');
  });

  it('returns an empty array when the envelope is missing', async () => {
    const { fetch } = makeFetchStub({ body: {} });
    const rows = await fetchAgentsList({ fetch });
    assert.deepEqual(rows, []);
  });

  it('throws ApiError with the server message on 500', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: { error: 'boom' },
    });
    await assert.rejects(
      () => fetchAgentsList({ fetch }),
      (err) =>
        err instanceof ApiError &&
        err.status === 500 &&
        err.message === 'boom' &&
        err.endpoint === '/api/agents',
    );
  });

  it('forwards AbortSignal to the underlying fetch', async () => {
    const { fetch, calls } = makeFetchStub({ body: { agents: [] } });
    const controller = new AbortController();
    await fetchAgentsList({ fetch, signal: controller.signal });
    assert.equal(calls[0].init.signal, controller.signal);
  });

  it('propagates AbortError unchanged (does not wrap)', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { fetch } = makeFetchStub(abort);
    await assert.rejects(
      () => fetchAgentsList({ fetch }),
      (err) => err.name === 'AbortError',
    );
  });
});

// ── fetchAgentProfile ─────────────────────────────────────────────────

describe('fetchAgentProfile()', () => {
  it('GETs /api/agents/:slug and unwraps the `agent` envelope', async () => {
    const { fetch, calls } = makeFetchStub({
      body: { agent: { slug: 'writer', name: 'Writer' } },
    });
    const agent = await fetchAgentProfile('writer', { fetch });
    assert.deepEqual(agent, { slug: 'writer', name: 'Writer' });
    assert.equal(calls[0].url, '/api/agents/writer');
  });

  it('URL-encodes slugs with special characters', async () => {
    const { fetch, calls } = makeFetchStub({
      body: { agent: { slug: 'a b' } },
    });
    await fetchAgentProfile('a b', { fetch });
    assert.equal(calls[0].url, '/api/agents/a%20b');
  });

  it('rejects invalid slugs synchronously (before fetching)', async () => {
    const { fetch, calls } = makeFetchStub({ body: {} });
    await assert.rejects(
      () => fetchAgentProfile('../evil', { fetch }),
      TypeError,
    );
    assert.equal(calls.length, 0, 'fetch must not be called on invalid slug');
  });

  it('maps 404 to ApiError with status=404 and server message', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      body: { error: 'Agent not found: ghost' },
    });
    await assert.rejects(
      () => fetchAgentProfile('ghost', { fetch }),
      (err) =>
        err instanceof ApiError &&
        err.status === 404 &&
        /Agent not found/.test(err.message),
    );
  });

  it('throws ApiError on malformed envelope (missing `agent`)', async () => {
    const { fetch } = makeFetchStub({ body: { something: 'else' } });
    await assert.rejects(
      () => fetchAgentProfile('writer', { fetch }),
      (err) => err instanceof ApiError && /Malformed agent/.test(err.message),
    );
  });
});

// ── fetchAgentPlan ────────────────────────────────────────────────────

describe('fetchAgentPlan()', () => {
  it('GETs /api/agents/:slug/plan and unwraps `plan`', async () => {
    const { fetch, calls } = makeFetchStub({
      body: {
        plan: {
          slug: 'writer',
          name: 'Writer',
          hasPlan: true,
          markdown: '# Plan',
          weeklyPlans: [],
          latestApproved: null,
        },
      },
    });
    const plan = await fetchAgentPlan('writer', { fetch });
    assert.equal(plan.slug, 'writer');
    assert.equal(plan.markdown, '# Plan');
    assert.equal(calls[0].url, '/api/agents/writer/plan');
  });

  it('maps 404 to ApiError with status=404', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 404,
      body: { error: 'Agent not found: ghost' },
    });
    await assert.rejects(
      () => fetchAgentPlan('ghost', { fetch }),
      (err) => err instanceof ApiError && err.status === 404,
    );
  });
});

// ── fetchAgentUsage ───────────────────────────────────────────────────

describe('fetchAgentUsage()', () => {
  it('GETs /api/agents/:slug/usage and unwraps `usage`', async () => {
    const { fetch, calls } = makeFetchStub({
      body: {
        usage: {
          slug: 'writer',
          name: 'Writer',
          missing: false,
          paused: false,
          pausedReason: null,
          weekMonday: '2026-04-20',
          tokenLimit: 10_000,
          tokensUsed: 1_234,
          inputTokens: 800,
          outputTokens: 434,
          costUsd: 0.01,
          recordCount: 3,
          remaining: 8_766,
          overBudget: false,
          utilizationPct: 12,
          weeks: [],
        },
      },
    });
    const usage = await fetchAgentUsage('writer', { fetch });
    assert.equal(usage.slug, 'writer');
    assert.equal(usage.tokensUsed, 1_234);
    assert.equal(calls[0].url, '/api/agents/writer/usage');
  });

  it('throws ApiError on malformed envelope', async () => {
    const { fetch } = makeFetchStub({ body: {} });
    await assert.rejects(
      () => fetchAgentUsage('writer', { fetch }),
      (err) => err instanceof ApiError && /Malformed usage/.test(err.message),
    );
  });
});

// ── fetchAgentLogs ────────────────────────────────────────────────────

describe('fetchAgentLogs()', () => {
  it('GETs /api/agents/:slug/logs with no query string by default', async () => {
    const { fetch, calls } = makeFetchStub({
      body: {
        logs: { slug: 'writer', dateRange: 'all', entries: [], executions: [] },
      },
    });
    const logs = await fetchAgentLogs('writer', { fetch });
    assert.equal(logs.dateRange, 'all');
    assert.equal(calls[0].url, '/api/agents/writer/logs');
  });

  it('serializes the dateRange preset into ?dateRange=', async () => {
    const { fetch, calls } = makeFetchStub({
      body: {
        logs: {
          slug: 'writer',
          dateRange: 'this-week',
          entries: [],
          executions: [],
        },
      },
    });
    await fetchAgentLogs('writer', { fetch, dateRange: 'this-week' });
    assert.equal(calls[0].url, '/api/agents/writer/logs?dateRange=this-week');
  });

  it('omits dateRange when undefined (no dangling ?)', async () => {
    const { fetch, calls } = makeFetchStub({
      body: {
        logs: { slug: 'writer', dateRange: 'all', entries: [], executions: [] },
      },
    });
    await fetchAgentLogs('writer', { fetch, dateRange: undefined });
    assert.equal(calls[0].url, '/api/agents/writer/logs');
  });

  it('maps 400 traversal slug (server-side) to ApiError with status=400', async () => {
    // The client slug validator catches local traversal; this case covers
    // the server returning 400 for a slug that happened to bypass us.
    const { fetch } = makeFetchStub({
      ok: false,
      status: 400,
      body: { error: 'Invalid agent slug' },
    });
    await assert.rejects(
      () => fetchAgentLogs('writer', { fetch }),
      (err) => err instanceof ApiError && err.status === 400,
    );
  });

  it('honors baseUrl + query string combination', async () => {
    const { fetch, calls } = makeFetchStub({
      body: {
        logs: {
          slug: 'writer',
          dateRange: 'last-7-days',
          entries: [],
          executions: [],
        },
      },
    });
    await fetchAgentLogs('writer', {
      fetch,
      baseUrl: 'http://example.test',
      dateRange: 'last-7-days',
    });
    assert.equal(
      calls[0].url,
      'http://example.test/api/agents/writer/logs?dateRange=last-7-days',
    );
  });
});

// ── Transport-level error handling ────────────────────────────────────

describe('transport errors', () => {
  it('wraps fetch rejection into ApiError with status=0', async () => {
    const { fetch } = makeFetchStub(new Error('ECONNREFUSED'));
    await assert.rejects(
      () => fetchAgentsList({ fetch }),
      (err) =>
        err instanceof ApiError &&
        err.status === 0 &&
        /ECONNREFUSED/.test(err.message),
    );
  });

  it('throws ApiError when the body is not valid JSON', async () => {
    const { fetch } = makeFetchStub({
      ok: true,
      status: 200,
      body: 'not-json{{',
    });
    await assert.rejects(
      () => fetchAgentsList({ fetch }),
      (err) => err instanceof ApiError && /parse JSON/i.test(err.message),
    );
  });
});
