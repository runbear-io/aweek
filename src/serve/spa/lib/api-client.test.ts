/**
 * Tests for `src/serve/spa/lib/api-client.ts` — SPA-side fetch wrappers
 * around the read-only JSON endpoints exposed by `aweek serve`.
 *
 * These tests never start a real HTTP server; they inject a stub
 * `fetch` and assert:
 *   - URL construction (baseUrl + path + query string + encoded slug)
 *   - Envelope unwrapping (`{ agents: [...] }` → `{ rows, issues }`)
 *   - Error propagation (non-2xx → `ApiError` with status + message)
 *   - Slug validation (path traversal / NUL / empty → TypeError)
 *   - AbortSignal plumbing (forwarded to the underlying fetch)
 *
 * TypeScript migration note (AC 403 sub-AC 5.3):
 *   This suite was promoted from `node --test` (raw `.js`) → vitest
 *   (`.ts`) in lockstep with `api-client.js` → `api-client.ts`. The move
 *   was forced by Node's ESM resolver — `node --test` cannot follow
 *   `import '../lib/api-client.js'` once the on-disk file becomes a
 *   `.ts`, but Vitest's bundler-style resolver can. Vitest is invoked
 *   via `pnpm test:spa` (it owns every SPA-side test that lives under
 *   `src/serve/spa/`); the backend `node --test` suite at the repo root
 *   keeps running unchanged.
 */

import { describe, it, expect } from 'vitest';

import {
  ApiError,
  fetchAgentsList,
  fetchAgentProfile,
  fetchAgentPlan,
  fetchAgentUsage,
  fetchAgentLogs,
  markNotificationRead,
  __test,
  type AgentListRow,
  type AgentProfile,
  type AgentPlan,
  type AgentUsage,
  type AgentLogs,
  type AgentsListResponse,
  type NotificationRow,
} from './api-client.js';

const { assertValidSlug, joinUrl } = __test;

// ── Stub fetch ────────────────────────────────────────────────────────

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
 * queued responses in order. Each queued entry is either a full
 * `Response`-like `{ ok, status, statusText, body }` descriptor or an
 * Error to throw synchronously (simulates network failure).
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
    const {
      ok = true,
      status = 200,
      statusText = 'OK',
      body = '',
    } = next;
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

// ── Helpers ────────────────────────────────────────────────────────────

describe('joinUrl()', () => {
  it('returns endpoint as-is when baseUrl is empty', () => {
    expect(joinUrl('', '/api/agents')).toBe('/api/agents');
  });

  it('joins baseUrl + endpoint with exactly one slash', () => {
    expect(joinUrl('http://x', '/api/agents')).toBe('http://x/api/agents');
    expect(joinUrl('http://x/', '/api/agents')).toBe('http://x/api/agents');
    expect(joinUrl('http://x/', 'api/agents')).toBe('http://x/api/agents');
    expect(joinUrl('http://x', 'api/agents')).toBe('http://x/api/agents');
  });
});

describe('assertValidSlug()', () => {
  it('accepts normal slugs', () => {
    expect(assertValidSlug('writer')).toBe('writer');
    expect(assertValidSlug('some-agent_123')).toBe('some-agent_123');
  });

  it('rejects non-strings and empty strings', () => {
    expect(() => assertValidSlug(undefined)).toThrow(TypeError);
    expect(() => assertValidSlug(null)).toThrow(TypeError);
    expect(() => assertValidSlug(42)).toThrow(TypeError);
    expect(() => assertValidSlug('')).toThrow(TypeError);
  });

  it('rejects path-traversal shapes', () => {
    expect(() => assertValidSlug('../evil')).toThrow(TypeError);
    expect(() => assertValidSlug('a/b')).toThrow(TypeError);
    expect(() => assertValidSlug('a\\b')).toThrow(TypeError);
    expect(() => assertValidSlug('a\0b')).toThrow(TypeError);
    expect(() => assertValidSlug('.')).toThrow(TypeError);
    expect(() => assertValidSlug('..')).toThrow(TypeError);
  });
});

// ── fetchAgentsList ───────────────────────────────────────────────────

describe('fetchAgentsList()', () => {
  it('GETs /api/agents and unwraps the envelope into { rows, issues }', async () => {
    const { fetch, calls } = makeFetchStub({
      ok: true,
      status: 200,
      body: { agents: [{ slug: 'writer', name: 'Writer' }], issues: [] },
    });
    const result: AgentsListResponse = await fetchAgentsList({ fetch });
    expect(result.rows).toEqual([
      { slug: 'writer', name: 'Writer' } as unknown as AgentListRow,
    ]);
    expect(result.issues).toEqual([]);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('/api/agents');
    expect(calls[0].init.method).toBe('GET');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json');
  });

  it('honors baseUrl', async () => {
    const { fetch, calls } = makeFetchStub({ body: { agents: [] } });
    await fetchAgentsList({ fetch, baseUrl: 'http://example.test' });
    expect(calls[0].url).toBe('http://example.test/api/agents');
  });

  it('returns an empty rows/issues envelope when the server fields are missing', async () => {
    const { fetch } = makeFetchStub({ body: {} });
    const result = await fetchAgentsList({ fetch });
    expect(result).toEqual({ rows: [], issues: [] });
  });

  it('surfaces server-emitted issues alongside rows', async () => {
    const { fetch } = makeFetchStub({
      body: {
        agents: [{ slug: 'writer' }],
        issues: [{ id: 'broken', message: 'parse error' }],
      },
    });
    const result = await fetchAgentsList({ fetch });
    expect(result.rows.length).toBe(1);
    expect(result.issues).toEqual([{ id: 'broken', message: 'parse error' }]);
  });

  it('throws ApiError with the server message on 500', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: { error: 'boom' },
    });
    await expect(fetchAgentsList({ fetch })).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      message: 'boom',
      endpoint: '/api/agents',
    });
  });

  it('forwards AbortSignal to the underlying fetch', async () => {
    const { fetch, calls } = makeFetchStub({ body: { agents: [] } });
    const controller = new AbortController();
    await fetchAgentsList({ fetch, signal: controller.signal });
    expect(calls[0].init.signal).toBe(controller.signal);
  });

  it('propagates AbortError unchanged (does not wrap)', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { fetch } = makeFetchStub(abort);
    await expect(fetchAgentsList({ fetch })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

// ── fetchAgentProfile ─────────────────────────────────────────────────

describe('fetchAgentProfile()', () => {
  it('GETs /api/agents/:slug and unwraps the `agent` envelope', async () => {
    const { fetch, calls } = makeFetchStub({
      body: { agent: { slug: 'writer', name: 'Writer' } },
    });
    const agent: AgentProfile = await fetchAgentProfile('writer', { fetch });
    expect(agent).toEqual({
      slug: 'writer',
      name: 'Writer',
    } as unknown as AgentProfile);
    expect(calls[0].url).toBe('/api/agents/writer');
  });

  it('URL-encodes slugs with special characters', async () => {
    const { fetch, calls } = makeFetchStub({
      body: { agent: { slug: 'a b' } },
    });
    await fetchAgentProfile('a b', { fetch });
    expect(calls[0].url).toBe('/api/agents/a%20b');
  });

  it('rejects invalid slugs synchronously (before fetching)', async () => {
    const { fetch, calls } = makeFetchStub({ body: {} });
    await expect(fetchAgentProfile('../evil', { fetch })).rejects.toThrow(
      TypeError,
    );
    expect(calls.length).toBe(0);
  });

  it('maps 404 to ApiError with status=404 and server message', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      body: { error: 'Agent not found: ghost' },
    });
    await expect(fetchAgentProfile('ghost', { fetch })).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: expect.stringMatching(/Agent not found/),
    });
  });

  it('throws ApiError on malformed envelope (missing `agent`)', async () => {
    const { fetch } = makeFetchStub({ body: { something: 'else' } });
    await expect(fetchAgentProfile('writer', { fetch })).rejects.toMatchObject({
      name: 'ApiError',
      message: expect.stringMatching(/Malformed agent/),
    });
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
    const plan: AgentPlan = await fetchAgentPlan('writer', { fetch });
    expect(plan.slug).toBe('writer');
    expect(plan.markdown).toBe('# Plan');
    expect(calls[0].url).toBe('/api/agents/writer/plan');
  });

  it('maps 404 to ApiError with status=404', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 404,
      body: { error: 'Agent not found: ghost' },
    });
    await expect(fetchAgentPlan('ghost', { fetch })).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
    });
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
    const usage: AgentUsage = await fetchAgentUsage('writer', { fetch });
    expect(usage.slug).toBe('writer');
    expect(usage.tokensUsed).toBe(1_234);
    expect(calls[0].url).toBe('/api/agents/writer/usage');
  });

  it('throws ApiError on malformed envelope', async () => {
    const { fetch } = makeFetchStub({ body: {} });
    await expect(fetchAgentUsage('writer', { fetch })).rejects.toMatchObject({
      name: 'ApiError',
      message: expect.stringMatching(/Malformed usage/),
    });
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
    const logs: AgentLogs = await fetchAgentLogs('writer', { fetch });
    expect(logs.dateRange).toBe('all');
    expect(calls[0].url).toBe('/api/agents/writer/logs');
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
    expect(calls[0].url).toBe('/api/agents/writer/logs?dateRange=this-week');
  });

  it('omits dateRange when undefined (no dangling ?)', async () => {
    const { fetch, calls } = makeFetchStub({
      body: {
        logs: { slug: 'writer', dateRange: 'all', entries: [], executions: [] },
      },
    });
    await fetchAgentLogs('writer', { fetch, dateRange: undefined });
    expect(calls[0].url).toBe('/api/agents/writer/logs');
  });

  it('maps 400 traversal slug (server-side) to ApiError with status=400', async () => {
    // The client slug validator catches local traversal; this case covers
    // the server returning 400 for a slug that happened to bypass us.
    const { fetch } = makeFetchStub({
      ok: false,
      status: 400,
      body: { error: 'Invalid agent slug' },
    });
    await expect(fetchAgentLogs('writer', { fetch })).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
    });
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
    expect(calls[0].url).toBe(
      'http://example.test/api/agents/writer/logs?dateRange=last-7-days',
    );
  });
});

// ── Transport-level error handling ────────────────────────────────────

describe('transport errors', () => {
  it('wraps fetch rejection into ApiError with status=0', async () => {
    const { fetch } = makeFetchStub(new Error('ECONNREFUSED'));
    await expect(fetchAgentsList({ fetch })).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      message: expect.stringMatching(/ECONNREFUSED/),
    });
  });

  it('throws ApiError when the body is not valid JSON', async () => {
    const { fetch } = makeFetchStub({
      ok: true,
      status: 200,
      body: 'not-json{{',
    });
    await expect(fetchAgentsList({ fetch })).rejects.toMatchObject({
      name: 'ApiError',
      message: expect.stringMatching(/parse JSON/i),
    });
  });
});

// ── markNotificationRead ──────────────────────────────────────────────
// AC 12: clicking a notification flips it to read via
// `POST /api/notifications/:slug/:id/read`. The api-client wrapper
// constructs the URL, sends an empty-body POST, and unwraps the
// `{ notification }` envelope. These tests pin every facet of the
// contract so a regression in URL construction or error handling shows
// up before the SPA tries to wire a click handler.

describe('markNotificationRead()', () => {
  const sampleRow: NotificationRow = {
    id: 'notif-abc12345',
    agentId: 'writer',
    source: 'agent',
    title: 'Hello',
    body: 'Body text.',
    createdAt: '2026-04-22T10:00:00.000Z',
    read: true,
    readAt: '2026-04-22T11:00:00.000Z',
  };

  it('POSTs to /api/notifications/:slug/:id/read and unwraps the envelope', async () => {
    const { fetch, calls } = makeFetchStub({
      ok: true,
      status: 200,
      body: { notification: sampleRow },
    });
    const result = await markNotificationRead('writer', 'notif-abc12345', {
      fetch,
    });
    expect(result).toEqual(sampleRow);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      '/api/notifications/writer/notif-abc12345/read',
    );
    expect(calls[0].init.method).toBe('POST');
  });

  it('encodes path segments and joins the configured baseUrl', async () => {
    const { fetch, calls } = makeFetchStub({
      ok: true,
      status: 200,
      body: { notification: sampleRow },
    });
    await markNotificationRead('weird slug', 'notif-xyz', {
      fetch,
      baseUrl: 'http://localhost:3000',
    });
    expect(calls[0].url).toBe(
      'http://localhost:3000/api/notifications/weird%20slug/notif-xyz/read',
    );
  });

  it('throws TypeError on invalid slug or id (no fetch)', async () => {
    const { fetch, calls } = makeFetchStub([]);
    await expect(
      markNotificationRead('', 'notif-x', { fetch }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      markNotificationRead('writer', '', { fetch }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      markNotificationRead('writer', '../escape', { fetch }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      markNotificationRead('writer', 'has/slash', { fetch }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('propagates 404 as ApiError so the SPA can render a stale-list state', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      body: { error: 'Notification not found: notif-missing' },
    });
    await expect(
      markNotificationRead('writer', 'notif-missing', { fetch }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: /not found/i,
    });
  });

  it('rejects with ApiError on a malformed envelope (no `notification` key)', async () => {
    const { fetch } = makeFetchStub({
      ok: true,
      status: 200,
      body: { unexpected: true },
    });
    await expect(
      markNotificationRead('writer', 'notif-x', { fetch }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      message: /missing.*notification.*envelope/i,
    });
  });

  it('forwards AbortSignal to the underlying fetch and propagates AbortError', async () => {
    const ac = new AbortController();
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { fetch, calls } = makeFetchStub(abortErr);
    ac.abort();
    await expect(
      markNotificationRead('writer', 'notif-x', { fetch, signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls[0].init.signal).toBe(ac.signal);
  });

  it('idempotent on the wire: re-POSTing returns the same row', async () => {
    // Server-side `markRead` is idempotent — flipping a read=true row is a
    // no-op and returns the unchanged record. The wrapper must surface
    // that through unchanged so the SPA can blindly POST on every click.
    const { fetch } = makeFetchStub([
      { ok: true, status: 200, body: { notification: sampleRow } },
      { ok: true, status: 200, body: { notification: sampleRow } },
    ]);
    const first = await markNotificationRead('writer', 'notif-abc12345', {
      fetch,
    });
    const second = await markNotificationRead('writer', 'notif-abc12345', {
      fetch,
    });
    expect(first).toEqual(second);
    expect(first.read).toBe(true);
  });
});

// ── Type-export sanity (compile-time only) ────────────────────────────
// These assertions exist purely to keep the named type re-exports under
// load — if a downstream caller renames or removes one of these, the
// test file fails to compile, surfacing the breakage at the type-check
// step long before runtime.
describe('type exports', () => {
  it('exports the public response interfaces as types', () => {
    const _row: AgentListRow | undefined = undefined;
    const _profile: AgentProfile | undefined = undefined;
    const _plan: AgentPlan | undefined = undefined;
    const _usage: AgentUsage | undefined = undefined;
    const _logs: AgentLogs | undefined = undefined;
    const _resp: AgentsListResponse | undefined = undefined;
    const _err: ApiError | undefined = undefined;
    expect(_row).toBeUndefined();
    expect(_profile).toBeUndefined();
    expect(_plan).toBeUndefined();
    expect(_usage).toBeUndefined();
    expect(_logs).toBeUndefined();
    expect(_resp).toBeUndefined();
    expect(_err).toBeUndefined();
  });
});
