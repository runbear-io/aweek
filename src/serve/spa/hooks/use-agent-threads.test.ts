/// <reference types="node" />
/**
 * Tests for `./use-agent-threads.ts` — Sub-AC 3 of AC 5.
 *
 * Strategy mirrors `./use-agents.test.ts`: exercise the same loader
 * composition the hook builds internally — `fetchAgentThreads` bound
 * to a stubbed `fetch` — via the pure `createResourceController`
 * state machine. This proves the URL construction + envelope
 * unwrapping + dependency-driven re-fetch behaviour end-to-end without
 * needing to render React.
 *
 * Source-level checks are kept as regex-on-text guards so the wiring
 * (re-fetch on slug change, no fetch when slug is null) is pinned even
 * when the type-checker is happy.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAgentThreads } from '../lib/api-client.js';
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

function makeFetchStub(queue: QueueItem | QueueItem[]): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const items: QueueItem[] = Array.isArray(queue) ? [...queue] : [queue];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (items.length === 0) {
      throw new Error(`fetch stub called but queue is empty (url=${url})`);
    }
    const next = items.shift()!;
    if (next instanceof Error) return Promise.reject(next);
    const { ok = true, status = 200, statusText = 'OK', body = {} } = next;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve(
      new Response(text, {
        status,
        statusText,
      }),
    );
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const SAMPLE_THREADS = [
  {
    id: 'chat-aaaa',
    agentId: 'writer',
    title: 'first',
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    messageCount: 3,
    lastMessagePreview: 'Hi there',
    lastMessageRole: 'assistant',
  },
  {
    id: 'chat-bbbb',
    agentId: 'writer',
    title: 'second',
    createdAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:00.000Z',
    messageCount: 1,
    lastMessagePreview: 'OK',
    lastMessageRole: 'user',
  },
];

describe('fetchAgentThreads', () => {
  it('hits /api/agents/:slug/chat/threads with the GET method', async () => {
    const { fetch, calls } = makeFetchStub({
      body: { agentId: 'writer', threads: SAMPLE_THREADS },
    });
    const out = await fetchAgentThreads('writer', { fetch });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe('/api/agents/writer/chat/threads');
    expect(calls[0]?.init.method).toBe('GET');
    expect(out.agentId).toBe('writer');
    expect(out.threads.length).toBe(2);
    expect(out.threads[0]?.id).toBe('chat-aaaa');
  });

  it('throws ApiError on a 404 with the server-supplied message', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      body: { error: 'Agent not found: ghost' },
    });
    await expect(fetchAgentThreads('ghost', { fetch })).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'Agent not found: ghost',
    });
  });

  it('rejects malformed bodies (missing threads array) with ApiError', async () => {
    const { fetch } = makeFetchStub({
      body: { agentId: 'writer' /* threads missing */ },
    });
    await expect(fetchAgentThreads('writer', { fetch })).rejects.toMatchObject({
      name: 'ApiError',
    });
  });

  it('rejects an invalid slug synchronously', async () => {
    const { fetch } = makeFetchStub([]);
    await expect(fetchAgentThreads('../etc', { fetch })).rejects.toThrow(
      /invalid slug/,
    );
  });
});

describe('useAgentThreads — controller wiring', () => {
  it('invokes the loader once per controller refresh and surfaces threads', async () => {
    const { fetch, calls } = makeFetchStub({
      body: { agentId: 'writer', threads: SAMPLE_THREADS },
    });
    // Mirrors the loader the hook builds internally for `slug='writer'`.
    const controller = createResourceController(({ signal }) =>
      fetchAgentThreads('writer', { fetch, signal }),
    );
    let payload: unknown = null;
    controller.subscribe((next: { data: unknown }) => {
      payload = next.data ?? payload;
    });
    await controller.refresh();
    expect(calls.length).toBe(1);
    const out = payload as { agentId: string; threads: unknown[] };
    expect(out.agentId).toBe('writer');
    expect(out.threads.length).toBe(2);
    controller.destroy();
  });

  it('a fresh controller for a new slug fires a separate fetch', async () => {
    const { fetch, calls } = makeFetchStub([
      { body: { agentId: 'writer', threads: SAMPLE_THREADS } },
      {
        body: {
          agentId: 'reviewer',
          threads: [
            {
              id: 'chat-cccc',
              agentId: 'reviewer',
              title: 'review',
              createdAt: '2026-04-30T00:00:00.000Z',
              updatedAt: '2026-04-30T00:00:00.000Z',
              messageCount: 0,
            },
          ],
        },
      },
    ]);
    const writerController = createResourceController(({ signal }) =>
      fetchAgentThreads('writer', { fetch, signal }),
    );
    const reviewerController = createResourceController(({ signal }) =>
      fetchAgentThreads('reviewer', { fetch, signal }),
    );
    await writerController.refresh();
    await reviewerController.refresh();
    expect(calls.length).toBe(2);
    expect(calls[0]?.url).toBe('/api/agents/writer/chat/threads');
    expect(calls[1]?.url).toBe('/api/agents/reviewer/chat/threads');
    writerController.destroy();
    reviewerController.destroy();
  });
});

// ── Source-level wiring guards ───────────────────────────────────────

describe('useAgentThreads — source-level wiring', () => {
  it('depends on slug + baseUrl + fetch in the controller deps', () => {
    const text = readFileSync(join(HERE, 'use-agent-threads.ts'), 'utf-8');
    // The deps tuple drives re-fetching on slug change. Pin the exact
    // shape so a regression that drops `slug` (and silently caches the
    // first agent's threads forever) lights up the test.
    expect(text).toMatch(/useApiResource[^]*\[\s*slug,\s*baseUrl,\s*fetchImpl\s*\]/);
  });

  it('short-circuits the fetch when slug is null/undefined/empty', () => {
    const text = readFileSync(join(HERE, 'use-agent-threads.ts'), 'utf-8');
    // The empty-slug branch is a key UX guarantee — the floating panel
    // can mount even when no agent has been selected yet, and a fetch
    // would 400 against `assertValidSlug`. Source-level pin so the
    // safeguard isn't accidentally removed.
    expect(text).toMatch(/if\s*\(!slug\)/);
  });
});
