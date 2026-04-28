/**
 * Component tests for `AgentArtifactsPage` — Sub-AC 5.2.
 *
 * The page must:
 *   - Source the artifact list exclusively from `useAgentArtifacts(slug)`.
 *   - Render the records grouped by ISO week, with one section header
 *     per bucket (week label + count) and one row per artifact below.
 *   - Surface filename, type chip, formatted size, and created date on
 *     every row.
 *   - Preserve the hook's ordering (newest week first; the `'unknown'`
 *     sentinel sinks to the bottom).
 *   - Cover the loading / 404 / error / empty states with the same
 *     shadcn theme tokens the sibling tabs use.
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Config : `vitest.config.js`.
 * Command: `pnpm test:spa`.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';

import { AgentArtifactsPage } from './agent-artifacts-page.tsx';

// ── Fixtures ─────────────────────────────────────────────────────────

/** Matches the server-side `gatherAgentArtifacts` return shape. */
const FULL_ARTIFACTS = {
  slug: 'alice',
  artifacts: [
    {
      id: 'artifact-aaa',
      agentId: 'alice',
      taskId: 'task-1',
      filePath: '.aweek/agents/alice/artifacts/task-1_session-1/report.md',
      fileName: 'report.md',
      type: 'report',
      description: 'Weekly summary',
      createdAt: '2026-04-22T14:30:00.000Z',
      week: '2026-W17',
      sizeBytes: 4096,
    },
    {
      id: 'artifact-bbb',
      agentId: 'alice',
      taskId: 'task-2',
      filePath: '.aweek/agents/alice/artifacts/task-2_session-2/notes.txt',
      fileName: 'notes.txt',
      type: 'document',
      description: '',
      createdAt: '2026-04-21T09:00:00.000Z',
      week: '2026-W17',
      sizeBytes: 1024,
    },
    {
      id: 'artifact-ccc',
      agentId: 'alice',
      taskId: 'task-3',
      filePath: '.aweek/agents/alice/artifacts/task-3_session-3/data.csv',
      fileName: 'data.csv',
      type: 'data',
      description: 'Q1 export',
      createdAt: '2026-04-15T08:00:00.000Z',
      week: '2026-W16',
      sizeBytes: 2048,
    },
  ],
  summary: {
    totalArtifacts: 3,
    byType: { report: 1, document: 1, data: 1 },
    totalSizeBytes: 7168,
  },
};

const EMPTY_ARTIFACTS = {
  slug: 'alice',
  artifacts: [],
  summary: {
    totalArtifacts: 0,
    byType: {},
    totalSizeBytes: 0,
  },
};

// ── Fetch stub helpers ───────────────────────────────────────────────

function makeFetchStub(
  artifacts: unknown,
  { ok = true, status = 200, statusText = 'OK' } = {},
) {
  const body = ok
    ? JSON.stringify({ artifacts })
    : JSON.stringify({ error: 'boom' });
  const calls: Array<{ url: string; init?: unknown }> = [];
  const fetchImpl = vi.fn((url, init) => {
    calls.push({ url: String(url), init });
    return Promise.resolve({
      ok,
      status,
      statusText,
      text: () => Promise.resolve(body),
    });
  });
  return { fetch: fetchImpl, calls };
}

function renderArtifacts(
  artifacts: { slug?: string } | null | undefined,
  stubOpts = {},
  props = {},
) {
  const { fetch, calls } = makeFetchStub(artifacts, stubOpts);
  const utils = render(
    <AgentArtifactsPage
      slug={artifacts?.slug || 'alice'}
      fetch={fetch as unknown as typeof globalThis.fetch}
      {...props}
    />,
  );
  return { ...utils, fetch, calls };
}

// ── Lifecycle ────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Loading / empty / error states ───────────────────────────────────

describe('AgentArtifactsPage — loading / empty / error states', () => {
  it('renders a skeleton while the first fetch is in flight', async () => {
    const fetch = vi.fn(
      () => new Promise(() => {}),
    ) as unknown as typeof globalThis.fetch;
    const { container } = render(
      <AgentArtifactsPage slug="alice" fetch={fetch} />,
    );
    const loader = await screen.findByRole('status');
    expect(loader).toHaveTextContent(/loading artifacts/i);
    const wrapper = container.querySelector(
      '[data-page="agent-artifacts"][data-loading="true"]',
    );
    expect(wrapper).not.toBeNull();
  });

  it('renders an empty state when no slug is supplied', () => {
    const { container } = render(<AgentArtifactsPage slug="" />);
    const empty = container.querySelector(
      '[data-page="agent-artifacts"][data-state="empty"]',
    );
    expect(empty).not.toBeNull();
    expect(empty).toHaveTextContent(/select an agent/i);
  });

  it('renders a 404 empty state when the slug is unknown', async () => {
    const { container } = renderArtifacts(FULL_ARTIFACTS, {
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
    const empty = await waitFor(() => {
      const el = container.querySelector(
        '[data-page="agent-artifacts"][data-state="empty"]',
      );
      expect(el).not.toBeNull();
      return el;
    });
    expect(empty).toHaveTextContent(/no agent found for slug "alice"/i);
  });

  it('renders an error alert with Retry for 500s', async () => {
    renderArtifacts(FULL_ARTIFACTS, {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('button', { name: /retry/i }),
    ).toBeInTheDocument();
  });

  it('renders a zero-row state when the agent has no artifacts yet', async () => {
    const { container } = renderArtifacts(EMPTY_ARTIFACTS);
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-page="agent-artifacts"][data-state="empty"]',
        ),
      ).not.toBeNull();
    });
    expect(container).toHaveTextContent(/no artifacts have been registered/i);
  });
});

// ── Group + row rendering ────────────────────────────────────────────

describe('AgentArtifactsPage — grouped list rendering', () => {
  it('renders one section per ISO week with the count', async () => {
    const { container } = renderArtifacts(FULL_ARTIFACTS);
    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-artifact-week]').length,
      ).toBeGreaterThan(0);
    });
    const sections = container.querySelectorAll('[data-artifact-week]');
    expect(sections.length).toBe(2);
    // Newest week first (W17 before W16).
    expect(sections[0].getAttribute('data-artifact-week')).toBe('2026-W17');
    expect(sections[1].getAttribute('data-artifact-week')).toBe('2026-W16');
    // Per-section count chip
    expect(sections[0]).toHaveTextContent(/2 artifacts/i);
    expect(sections[1]).toHaveTextContent(/1 artifact/);
  });

  it('renders every artifact row with filename, type, size, and date', async () => {
    const { container } = renderArtifacts(FULL_ARTIFACTS);
    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-artifact-id][data-artifact-type]')
          .length,
      ).toBeGreaterThan(0);
    });
    // Scope to row-level nodes — the inner inline-renderer wrappers
    // (ArtifactPdfPreview, ArtifactDownloadLink) also carry
    // `data-artifact-id` for their own component-level tests, so the
    // row selector must combine with `data-artifact-type` to avoid
    // counting them.
    const rows = container.querySelectorAll(
      '[data-artifact-id][data-artifact-type]',
    );
    expect(rows.length).toBe(3);
    // Filenames
    expect(container).toHaveTextContent(/report\.md/);
    expect(container).toHaveTextContent(/notes\.txt/);
    expect(container).toHaveTextContent(/data\.csv/);
    // Types surfaced as chips
    expect(rows[0].getAttribute('data-artifact-type')).toBe('report');
    expect(rows[1].getAttribute('data-artifact-type')).toBe('document');
    expect(rows[2].getAttribute('data-artifact-type')).toBe('data');
    // Size formatting (base-1024, one decimal under 10).
    expect(container).toHaveTextContent(/4\.0 KB/);
    expect(container).toHaveTextContent(/1\.0 KB/);
    expect(container).toHaveTextContent(/2\.0 KB/);
    // Each row has a <time> element with the createdAt ISO.
    expect(
      container.querySelectorAll('time[datetime]').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('surfaces the slug and per-type chip totals in the header', async () => {
    const { container } = renderArtifacts(FULL_ARTIFACTS);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-artifacts"]'),
      ).not.toBeNull();
    });
    expect(container).toHaveTextContent(/alice/);
    expect(container).toHaveTextContent(/3 artifacts/i);
    const chipRow = container.querySelector('[data-summary-by-type="true"]');
    expect(chipRow).not.toBeNull();
    expect(chipRow).toHaveTextContent(/report/i);
    expect(chipRow).toHaveTextContent(/document/i);
    expect(chipRow).toHaveTextContent(/data/i);
  });

  // AC 11 — Artifacts tab surfaces aggregate size per agent via
  // ArtifactStore.summary().totalSizeBytes. The fixture sums to 7168
  // bytes (4096 + 1024 + 2048), which the page formats base-1024 as
  // "7.0 KB total". The header must render that aggregate so users
  // see the disk footprint for the agent's deliverables at a glance.
  it('surfaces the aggregate size from summary.totalSizeBytes in the header', async () => {
    const { container } = renderArtifacts(FULL_ARTIFACTS);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-artifacts"]'),
      ).not.toBeNull();
    });
    // The header sub-line embeds the formatted total alongside the
    // count, prefixed with " · " as the visual separator.
    const header = container.querySelector('[data-page="agent-artifacts"] header');
    expect(header).not.toBeNull();
    expect(header).toHaveTextContent(/7\.0 KB total/);
  });

  // AC 11 follow-on — when the agent has artifacts but every record
  // has sizeBytes === 0 (or undefined), the summary's totalSizeBytes
  // should be 0 and the page should NOT render a "0 B total" suffix
  // (confirms the > 0 guard in the header renderer).
  it('omits the size suffix when summary.totalSizeBytes is zero', async () => {
    const ZERO_SIZE = {
      slug: 'alice',
      artifacts: [
        {
          id: 'artifact-zzz',
          agentId: 'alice',
          taskId: 'task-1',
          filePath: '.aweek/agents/alice/artifacts/task-1_session-1/empty.md',
          fileName: 'empty.md',
          type: 'document',
          description: '',
          createdAt: '2026-04-22T14:30:00.000Z',
          week: '2026-W17',
          sizeBytes: 0,
        },
      ],
      summary: {
        totalArtifacts: 1,
        byType: { document: 1 },
        totalSizeBytes: 0,
      },
    };
    const { container } = renderArtifacts(ZERO_SIZE);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-artifacts"]'),
      ).not.toBeNull();
    });
    const header = container.querySelector(
      '[data-page="agent-artifacts"] header',
    );
    expect(header).not.toBeNull();
    expect(header).not.toHaveTextContent(/total/i);
  });
});

// ── Markdown inline rendering (AC 6) ────────────────────────────────

/**
 * Branching fetch stub: serves the JSON artifact-list envelope for the
 * `/artifacts` endpoint, and the raw markdown body for any
 * `/artifacts/:id/file` endpoint. Mirrors the wire-shape the SPA sees in
 * production: two distinct endpoints, two distinct content types.
 */
function makeBranchingFetchStub(
  artifacts: unknown,
  fileBodies: Record<string, string>,
) {
  const calls: Array<{ url: string; init?: unknown }> = [];
  const fetchImpl = vi.fn((url: unknown, init?: unknown) => {
    const u = String(url);
    calls.push({ url: u, init });
    // /api/agents/:slug/artifacts/:id/file → text body.
    const fileMatch = u.match(/\/artifacts\/([^/?]+)\/file(?:[?#]|$)/);
    if (fileMatch) {
      const id = decodeURIComponent(fileMatch[1]);
      const body = fileBodies[id];
      if (typeof body === 'string') {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: () => Promise.resolve(body),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve(JSON.stringify({ error: 'gone' })),
      });
    }
    // Default: artifact-list JSON envelope.
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(JSON.stringify({ artifacts })),
    });
  });
  return { fetch: fetchImpl, calls };
}

describe('AgentArtifactsPage — markdown inline rendering', () => {
  it('renders a markdown artifact body inline via the shared Markdown component', async () => {
    const markdownBody = [
      '# Weekly summary',
      '',
      'Some **bold** progress and a [link](https://example.com).',
      '',
      '- one',
      '- two',
    ].join('\n');
    const { fetch } = makeBranchingFetchStub(FULL_ARTIFACTS, {
      'artifact-aaa': markdownBody,
    });
    const { container } = render(
      <AgentArtifactsPage
        slug="alice"
        fetch={fetch as unknown as typeof globalThis.fetch}
      />,
    );

    // Wait for the rendered preview to show up.
    const article = await waitFor(() => {
      const el = container.querySelector('[data-artifact-markdown="true"]');
      expect(el).not.toBeNull();
      return el!;
    });

    // The shared Markdown component renders headings as <h1>, lists as
    // <ul>, etc. — assert the parsed structure landed.
    expect(article.querySelector('h1')).not.toBeNull();
    expect(article).toHaveTextContent(/weekly summary/i);
    expect(article.querySelector('strong')).not.toBeNull();
    expect(article.querySelector('a[href="https://example.com"]')).not.toBeNull();
    expect(article.querySelectorAll('li').length).toBe(2);

    // Only the markdown artifact (.md) should render an inline preview;
    // .txt and .csv must not.
    const previews = container.querySelectorAll(
      '[data-artifact-markdown="true"]',
    );
    expect(previews.length).toBe(1);

    // Sanity check: the artifact-list endpoint was called once and the
    // file endpoint was called for the markdown artifact id.
    const calls = fetch.mock.calls.map(
      ([u]: [unknown, ...unknown[]]) => String(u),
    );
    expect(calls.some((u) => /\/artifacts$/.test(u))).toBe(true);
    expect(
      calls.some((u) => /\/artifacts\/artifact-aaa\/file$/.test(u)),
    ).toBe(true);
  });

  it('shows an error retry banner when the markdown body fails to load', async () => {
    // No file body registered → branching stub returns a 404 for the
    // /file endpoint.
    const { fetch } = makeBranchingFetchStub(FULL_ARTIFACTS, {});
    const { container } = render(
      <AgentArtifactsPage
        slug="alice"
        fetch={fetch as unknown as typeof globalThis.fetch}
      />,
    );

    const errorBanner = await waitFor(() => {
      const el = container.querySelector(
        '[data-artifact-markdown-state="error"]',
      );
      expect(el).not.toBeNull();
      return el!;
    });
    expect(errorBanner).toHaveTextContent(/preview failed/i);
    expect(within(errorBanner as HTMLElement).getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
