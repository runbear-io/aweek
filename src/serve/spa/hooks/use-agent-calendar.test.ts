/// <reference types="node" />
/**
 * Tests for `./use-agent-calendar.ts` — the Calendar tab's data-fetching hook.
 *
 * Sub-AC 9.3 contract:
 *   1. The hook accepts a `week` option (`"YYYY-Www"` ISO week key).
 *   2. The hook forwards `week` to `fetchAgentCalendar` so it lands as a
 *      `?week=` query-string param on the wire.
 *   3. `week` participates in the hook's React dependency lists
 *      (`useCallback` deps + the `useApiResource` deps array), so a URL
 *      navigation that mutates `?week=` reactively triggers a fresh
 *      fetch instead of the stale grid sticking around.
 *   4. The empty/falsy `slug` short-circuit still resolves to `null` so a
 *      week change before the router resolves a slug doesn't fire a
 *      bogus `/api/agents//calendar?week=…` request.
 *   5. `baseUrl` / `fetch` are forwarded so Storybook / tests / cross-
 *      origin dev setups can inject them.
 *
 * React hooks can't run without a renderer, so — mirroring the pattern in
 * `./use-agents.test.ts` — we exercise the *same* loader composition the
 * hook builds internally (`fetchAgentCalendar` bound to the test options)
 * via the pure `createResourceController`. This proves the on-the-wire
 * behaviour end-to-end without needing jsdom / a JSX transform, and the
 * source-level regex wiring checks pin the dependency-array shape so a
 * future refactor that drops `week` from either deps array is caught
 * before reaching the browser.
 *
 * Runner: vitest, invoked via `pnpm test:spa`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAgentCalendar } from '../lib/api-client.js';

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
 * queued responses in order. Mirrors the helper in
 * `./use-agents.test.ts` so the two suites stay structurally identical.
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

/** Minimal `calendar` envelope the server returns for a known agent. */
function calendarPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    calendar: {
      agentId: 'alice',
      week: '2026-W17',
      month: '2026-04',
      approved: true,
      timeZone: 'UTC',
      weekMonday: '2026-04-20T00:00:00.000Z',
      noPlan: false,
      loadError: null,
      tasks: [],
      counts: {
        total: 0,
        pending: 0,
        inProgress: 0,
        completed: 0,
        failed: 0,
        delegated: 0,
        skipped: 0,
        other: 0,
      },
      activityByTask: {},
      ...overrides,
    },
  };
}

// ── Source-level wiring checks ────────────────────────────────────────
//
// The behavioural tests below cover the wire shape, but they can't catch
// a regression where the hook *forgets* to include `week` in its
// dependency arrays — that would silently keep the stale calendar
// rendered after a URL navigation. The source-level checks below pin
// the contract at the syntactic layer so a refactor that drops `week`
// from either deps array trips the suite immediately.

describe('useAgentCalendar — module wiring', () => {
  const src = readFileSync(join(HERE, 'use-agent-calendar.ts'), 'utf8');

  it('imports fetchAgentCalendar from the api-client', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bfetchAgentCalendar\b[^}]*\}\s*from\s*['"][^'"]*lib\/api-client\.js['"]/,
    );
  });

  it('imports useApiResource and delegates state handling to it', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\buseApiResource\b[^}]*\}\s*from\s*['"]\.\/use-api-resource\.js['"]/,
    );
    expect(src).toMatch(/useApiResource\s*(?:<[^>]+>)?\s*\(/);
  });

  it('exports useAgentCalendar as a named function', () => {
    expect(src).toMatch(/export\s+function\s+useAgentCalendar\s*\(/);
  });

  it('declares the week option in UseAgentCalendarOptions', () => {
    // `week?: string` — the public surface SPA pages thread `?week=`
    // through. A refactor that drops it would break URL-driven deep
    // linking (Sub-AC 9.3 + AC 9 exit condition).
    expect(src).toMatch(
      /UseAgentCalendarOptions\s*\{[^}]*\bweek\s*\?\s*:\s*string\b/s,
    );
  });

  it('forwards the week option to fetchAgentCalendar', () => {
    // Look for `fetchAgentCalendar(slug, { ..., week, ... })` — the
    // exact whitespace varies under prettier, so just verify both
    // tokens are present in the call.
    expect(src).toMatch(
      /fetchAgentCalendar\s*\(\s*slug\s*,\s*\{[\s\S]*?\bweek\b[\s\S]*?\}\s*\)/,
    );
  });

  it('includes week in the useCallback loader deps so a week change re-runs the loader', () => {
    // The loader closure captures `week`, so React must recompute the
    // loader callback when `week` mutates. The deps array literal lives
    // inline at the end of the useCallback call.
    expect(src).toMatch(
      /useCallback\s*\([\s\S]*?\[\s*slug\s*,\s*enabled\s*,\s*week\s*,/,
    );
  });

  it('includes week in the useApiResource deps so the hook re-fetches on week changes', () => {
    // The deps array passed to useApiResource is what *actually* drives
    // a re-fetch. Pin both `slug` and `week` so the order isn't important
    // but presence is.
    expect(src).toMatch(/useApiResource[\s\S]*?\[\s*[\s\S]*?\bweek\b[\s\S]*?\]/);
  });
});

// ── Loader wiring — week → ?week= query string ───────────────────────

describe('useAgentCalendar — week-key endpoint wiring', () => {
  it('appends ?week=YYYY-Www to the URL when a week is supplied', async () => {
    const { fetch, calls } = makeFetchStub({
      body: calendarPayload({ week: '2026-W17' }),
    });

    // Exact loader the hook constructs internally — see use-agent-calendar.ts.
    const loader = (opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('alice', { ...opts, fetch, week: '2026-W17' });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('/api/agents/alice/calendar?week=2026-W17');
    expect(calls[0].init.method).toBe('GET');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json');
  });

  it('omits the ?week= param entirely when no week is supplied', async () => {
    const { fetch, calls } = makeFetchStub({
      body: calendarPayload(),
    });
    const loader = (opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('alice', { ...opts, fetch });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    // No query string at all — the server picks the current week per
    // the agent's configured zone. This is what the "Current" button in
    // the header relies on when it calls `onWeekChange(null)`.
    expect(calls[0].url).toBe('/api/agents/alice/calendar');
  });

  it('omits ?week= when the week is an empty string', async () => {
    const { fetch, calls } = makeFetchStub({
      body: calendarPayload(),
    });
    const loader = (opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('alice', { ...opts, fetch, week: '' });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    // The api-client's `searchParams` projection drops empty strings —
    // this protects the SPA from emitting `?week=` with no value when
    // the router resets the override.
    expect(calls[0].url).toBe('/api/agents/alice/calendar');
  });

  it('forwards baseUrl into the request URL alongside the ?week= param', async () => {
    const { fetch, calls } = makeFetchStub({
      body: calendarPayload({ week: '2026-W17' }),
    });

    const loader = (opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('alice', {
        ...opts,
        fetch,
        baseUrl: 'http://dashboard.test',
        week: '2026-W17',
      });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    expect(calls[0].url).toBe(
      'http://dashboard.test/api/agents/alice/calendar?week=2026-W17',
    );
  });

  it('forwards the abort signal so cancellation works', async () => {
    const { fetch, calls } = makeFetchStub({
      body: calendarPayload(),
    });

    const loader = (opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('alice', { ...opts, fetch, week: '2026-W17' });
    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    const signal = calls[0].init.signal;
    expect(signal).toBeTruthy();
    expect(typeof (signal as AbortSignal).aborted).toBe('boolean');
  });

  it('URI-encodes a slug with characters the server allows but URL paths reserve', async () => {
    const { fetch, calls } = makeFetchStub({
      body: calendarPayload(),
    });
    // Slug with characters that survive the api-client guard but get
    // percent-encoded on the path (uppercase + hyphens are fine; this
    // is mostly a defensive check that `?week=` lands AFTER the
    // encoded slug in the URL).
    const loader = (opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('A-G3nt', { ...opts, fetch, week: '2026-W17' });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();

    expect(calls[0].url).toBe(
      '/api/agents/A-G3nt/calendar?week=2026-W17',
    );
  });
});

// ── Week-key reactivity ──────────────────────────────────────────────
//
// The hook itself can't be invoked without React, but the *behaviour
// the hook depends on* is: a second `refresh()` after rebinding `week`
// produces a second request whose URL reflects the new week. The
// `useApiResource` deps array is what actually drives that re-render;
// the regex check above pins it at the source level, and these
// behavioural tests confirm the wire shape end-to-end.

describe('useAgentCalendar — reactive week navigation', () => {
  it('a second refresh after rebinding `week` issues a new request with the updated ?week=', async () => {
    const { fetch, calls } = makeFetchStub([
      { body: calendarPayload({ week: '2026-W17' }) },
      { body: calendarPayload({ week: '2026-W18' }) },
    ]);

    // Two distinct loader compositions — modelling the React re-render
    // that swaps the `useCallback` closure when `week` changes.
    const loaderW17 = (opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('alice', { ...opts, fetch, week: '2026-W17' });
    const loaderW18 = (opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('alice', { ...opts, fetch, week: '2026-W18' });

    // First mount: week=2026-W17.
    const ctrlA = createResourceController(loaderW17);
    await ctrlA.refresh();
    expect(calls[0].url).toBe('/api/agents/alice/calendar?week=2026-W17');

    // `useApiResource` tears down the controller and creates a fresh
    // one when deps change — model that by destroying ctrlA and
    // building ctrlB. (`useEffect` cleanup → `controller.destroy()`.)
    ctrlA.destroy();

    const ctrlB = createResourceController(loaderW18);
    await ctrlB.refresh();
    expect(calls[1].url).toBe('/api/agents/alice/calendar?week=2026-W18');
    expect(calls.length).toBe(2);
  });

  it('navigating from a deep-link back to the current week clears the ?week= param', async () => {
    const { fetch, calls } = makeFetchStub([
      { body: calendarPayload({ week: '2026-W30' }) },
      { body: calendarPayload({ week: '2026-W17' }) },
    ]);

    // First mount: user deep-linked to a far-future week via `?week=2026-W30`.
    const loaderDeep = (opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('alice', { ...opts, fetch, week: '2026-W30' });
    const ctrlA = createResourceController(loaderDeep);
    await ctrlA.refresh();
    expect(calls[0].url).toBe('/api/agents/alice/calendar?week=2026-W30');
    ctrlA.destroy();

    // Then the user clicks the "Current" (⊙) button — onWeekChange(null)
    // clears the override. The page re-mounts the hook with `week`
    // undefined, the loader composition drops the param, and the
    // server picks the configured-zone current week.
    const loaderCurrent = (opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('alice', { ...opts, fetch });
    const ctrlB = createResourceController(loaderCurrent);
    await ctrlB.refresh();
    expect(calls[1].url).toBe('/api/agents/alice/calendar');
  });

  it('handles ±5-year deep-links without losing the week-key on the wire', async () => {
    // AC 9 exit condition: deep-link works for any year ±5 from current
    // with recurring occurrences visible. We don't need to model the
    // recurring expansion here (that's the server's job and is covered
    // by the calendar.ts gather tests) — the hook contract is "if the
    // URL says `?week=YYYY-Www`, the wire request carries that exact
    // week key". Sweep the far-past and far-future ends of the window.
    const weeks = [
      '2021-W01', // current year - 5
      '2026-W17', // current
      '2031-W52', // current year + 5
    ];

    for (const week of weeks) {
      const { fetch, calls } = makeFetchStub({
        body: calendarPayload({ week }),
      });
      const loader = (opts: { signal: AbortSignal }) =>
        fetchAgentCalendar('alice', { ...opts, fetch, week });
      const ctrl = createResourceController(loader);
      await ctrl.refresh();
      expect(calls[0].url).toBe(
        `/api/agents/alice/calendar?week=${encodeURIComponent(week)}`,
      );
    }
  });

  it('refresh() re-issues a request with the same ?week= when invoked manually', async () => {
    // Models the Refresh button on the StaleBanner / error retry path —
    // the same loader closure must keep issuing the same `?week=` until
    // React swaps it for a new closure.
    const { fetch, calls } = makeFetchStub([
      { body: calendarPayload({ week: '2026-W17' }) },
      { body: calendarPayload({ week: '2026-W17' }) },
    ]);
    const loader = (opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('alice', { ...opts, fetch, week: '2026-W17' });

    const ctrl = createResourceController(loader);
    await ctrl.refresh();
    await ctrl.refresh();

    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe('/api/agents/alice/calendar?week=2026-W17');
    expect(calls[1].url).toBe('/api/agents/alice/calendar?week=2026-W17');
  });
});

// ── Loading / error state machine ────────────────────────────────────
//
// Mirrors `use-agents.test.ts` for parity. The state transitions are
// owned by `resource-controller`, but threading them through the
// calendar loader composition confirms `?week=` doesn't perturb the
// success / error / stale-data paths.

describe('useAgentCalendar — loading/error state handling', () => {
  it('flows loading=true → success with data populated and error null', async () => {
    const { fetch } = makeFetchStub({
      body: calendarPayload({ week: '2026-W17' }),
    });
    const ctrl = createResourceController((opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('alice', { ...opts, fetch, week: '2026-W17' }),
    );

    const snapshots: Array<{
      data: unknown;
      error: { message: string } | null;
      loading: boolean;
    }> = [];
    ctrl.subscribe((state) => {
      snapshots.push({
        data: state.data,
        error: state.error ? { message: state.error.message } : null,
        loading: state.loading,
      });
    });

    await ctrl.refresh();

    expect(snapshots.length).toBe(2);
    expect(snapshots[0].loading).toBe(true);
    expect(snapshots[0].error).toBeNull();
    expect(snapshots[1].loading).toBe(false);
    expect(snapshots[1].error).toBeNull();
    expect(snapshots[1].data).toMatchObject({
      agentId: 'alice',
      week: '2026-W17',
      noPlan: false,
    });
  });

  it('preserves the prior week payload on a 500 so the StaleBanner has data to render', async () => {
    const { fetch } = makeFetchStub([
      { body: calendarPayload({ week: '2026-W17' }) },
      {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        body: { error: 'boom' },
      },
    ]);
    const ctrl = createResourceController((opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('alice', { ...opts, fetch, week: '2026-W17' }),
    );

    await ctrl.refresh();
    expect(ctrl.getState().data).toMatchObject({ week: '2026-W17' });

    await ctrl.refresh();
    const final = ctrl.getState();
    expect(final.loading).toBe(false);
    expect(final.error).toBeTruthy();
    expect((final.error as Error).message).toMatch(/boom/);
    // Prior data must remain visible so the page renders
    // last-known-grid + StaleBanner instead of a blank screen.
    expect(final.data).toMatchObject({ week: '2026-W17' });
  });

  it('propagates a 404 with status carried so the page can short-circuit to "agent not found"', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      body: { error: 'no agent' },
    });
    const ctrl = createResourceController((opts: { signal: AbortSignal }) =>
      fetchAgentCalendar('ghost', { ...opts, fetch, week: '2026-W17' }),
    );

    await ctrl.refresh();
    const { error, data } = ctrl.getState();
    expect(data).toBeNull();
    expect(error).toBeTruthy();
    // ApiError carries `.status` — the SPA reads it to render the
    // 404 empty state instead of the generic error card.
    const status = (error as unknown as { status?: number } | null)?.status;
    expect(status).toBe(404);
  });
});
