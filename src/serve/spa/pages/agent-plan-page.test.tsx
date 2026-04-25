/**
 * Component tests for `AgentPlanPage` — AC 2, Sub-AC 4.
 *
 * The Strategy tab renders an agent's `plan.md` (the single source of
 * truth for long-term goals, monthly plans, strategies, and notes, per
 * `src/storage/plan-markdown-store.js`) together with the structured
 * weekly-plan list. These tests verify feature parity with that baseline:
 *
 *   - All four canonical H2 sections round-trip to the DOM when present
 *     in the plan.md body fetched from `GET /api/agents/:slug/plan`.
 *   - Markdown subset (headings / lists / bold / italic / inline code /
 *     code fences / blockquotes / links) renders through the minimal
 *     CommonMark parser.
 *   - Weekly plans list surfaces week keys, task counts, approval
 *     badges, and the "latest approved" marker.
 *   - Empty plan.md → dedicated "No plan yet" empty state that points
 *     the user at `/aweek:plan` (mirrors the terminal guidance).
 *   - Loading / 404 / error states + Refresh button re-triggers fetch.
 *
 * Data is sourced exclusively via `useAgentPlan(slug)` (Sub-AC 3.3
 * invariant) — the tests drive the hook through a stubbed `fetch` so
 * no SSR-injected globals leak into the render path.
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Config : `vitest.config.js`.
 * Command: `pnpm test:spa`
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import { AgentPlanPage } from './agent-plan-page.tsx';

// ── Fixtures ─────────────────────────────────────────────────────────
//
// Plan.md shape mirrors `src/storage/plan-markdown-store.js` canonical
// layout: H1 agent name + optional preamble, then four H2 sections
// (Long-term goals / Monthly plans / Strategies / Notes). Subsections
// like `### 2026-04` live inside their parent section — the parser
// treats them as part of the section body.

const FULL_PLAN_MD = `# Alice

Lead developer for aweek.

## Long-term goals

- (1yr) Ship v1 of the aweek dashboard
- (3mo) Migrate SSR server to a Vite SPA
- (1mo) Parity pass on the Strategy tab [active]

## Monthly plans

### 2026-04

- Wire the Strategy tab to \`plan-markdown-store\`
- Add component tests for Sub-AC 4

### 2026-05

- Cut a beta release

## Strategies

Prefers **theme-day scheduling** with *focused mornings*.
Keep rituals lightweight — see \`/aweek:plan\` Branch A.

> Rule of thumb: fewer meetings, more deep work.

## Notes

Link: [aweek docs](https://example.com/aweek)

\`\`\`bash
aweek exec plan-markdown write
\`\`\`
`;

const FULL_PLAN = {
  slug: 'alice',
  name: 'Alice',
  hasPlan: true,
  markdown: FULL_PLAN_MD,
  weeklyPlans: [
    {
      week: '2026-W16',
      approved: true,
      approvedAt: '2026-04-13T09:00:00.000Z',
      tasks: [
        { id: 't1', title: 'Kickoff review', status: 'completed' },
        { id: 't2', title: 'Draft SPA shell', status: 'completed' },
      ],
    },
    {
      week: '2026-W17',
      approved: true,
      approvedAt: '2026-04-20T09:00:00.000Z',
      tasks: [
        { id: 't3', title: 'Wire Strategy tab', status: 'in-progress' },
        { id: 't4', title: 'Author tests', status: 'pending' },
        { id: 't5', title: 'Verify parity', status: 'pending' },
      ],
    },
    {
      week: '2026-W18',
      approved: false,
      tasks: [{ id: 't6', title: 'Cut beta', status: 'pending' }],
    },
  ],
  latestApproved: {
    week: '2026-W17',
    approved: true,
  },
};

/** Agent exists on disk but has not yet drafted a plan.md. */
const NO_PLAN = {
  slug: 'bob',
  name: 'Bob',
  hasPlan: false,
  markdown: '',
  weeklyPlans: [],
  latestApproved: null,
};

/** Agent exists and has plan.md but no weekly plans yet. */
const PLAN_NO_WEEKS = {
  slug: 'carol',
  name: 'Carol',
  hasPlan: true,
  markdown: '# Carol\n\n## Long-term goals\n\n- Learn Rust\n',
  weeklyPlans: [],
  latestApproved: null,
};

// ── Fetch stub helpers ───────────────────────────────────────────────

/**
 * Build a `fetch` stub returning `{ plan }` envelopes matching the
 * server contract consumed by `fetchAgentPlan`.
 */
function makeFetchStub(
  plan: unknown,
  { ok = true, status = 200, statusText = 'OK' } = {},
) {
  const body = ok
    ? JSON.stringify({ plan })
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

function renderPlan(plan: { slug?: string } | null | undefined, stubOpts = {}, props = {}) {
  const { fetch, calls } = makeFetchStub(plan, stubOpts);
  const utils = render(
    <AgentPlanPage
      slug={plan?.slug || 'alice'}
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

describe('AgentPlanPage — loading / empty / error states', () => {
  it('renders a skeleton while the first fetch is in flight', async () => {
    const fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof globalThis.fetch; // never resolves
    const { container } = render(
      <AgentPlanPage slug="alice" fetch={fetch} />,
    );
    const loader = await screen.findByRole('status');
    expect(loader).toHaveTextContent(/loading plan/i);
    expect(container.querySelector('[data-loading="true"]')).not.toBeNull();
  });

  it('renders an empty state when no slug is supplied', () => {
    const { container } = render(<AgentPlanPage slug="" />);
    const empty = container.querySelector(
      '[data-page="agent-plan"][data-state="empty"]',
    );
    expect(empty).not.toBeNull();
    expect(empty).toHaveTextContent(/select an agent/i);
  });

  it('renders a 404 empty state when the slug is unknown on disk', async () => {
    const { container } = renderPlan(FULL_PLAN, {
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
    const empty = await waitFor(() => {
      const el = container.querySelector(
        '[data-page="agent-plan"][data-state="empty"]',
      );
      expect(el).not.toBeNull();
      return el;
    });
    expect(empty).toHaveTextContent(/no agent found for slug "alice"/i);
  });

  it('renders an error alert with Retry for 500s', async () => {
    renderPlan(FULL_PLAN, {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('button', { name: /retry/i }),
    ).toBeInTheDocument();
  });

  it('renders the "no plan yet" empty state when hasPlan=false, pointing the user at /aweek:plan', async () => {
    const { container } = renderPlan(NO_PLAN);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-plan"]'),
      ).not.toBeNull();
    });
    // The terminal baseline (`src/skills/plan.js` + plan.md) directs
    // operators at `/aweek:plan` when the body is missing; the SPA must
    // too so users have an obvious next step.
    expect(container).toHaveTextContent(/plan\.md/);
    expect(container).toHaveTextContent(/\/aweek:plan/);
  });
});

// ── plan.md rendering (Strategy tab baseline parity) ────────────────

describe('AgentPlanPage — plan.md rendering parity with plan-markdown-store', () => {
  it('renders the agent name + slug in the Strategy header', async () => {
    const { container } = renderPlan(FULL_PLAN);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-plan"]'),
      ).not.toBeNull();
    });
    const header = within(container).getByRole('banner', { hidden: true }) ||
      container.querySelector('header');
    expect(container).toHaveTextContent(/alice\s+—\s+plan/i);
    expect(container).toHaveTextContent('alice');
  });

  it('renders all four canonical H2 section headings from plan.md', async () => {
    const { container } = renderPlan(FULL_PLAN);
    const body = await waitFor(() => {
      const el = container.querySelector('[data-plan-body="true"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const h2Headings = Array.from(body.querySelectorAll('h2')).map((h) =>
      h.textContent.trim(),
    );
    // Order follows the markdown source; every canonical section must
    // make it into the DOM when present in plan.md.
    expect(h2Headings).toEqual([
      'Long-term goals',
      'Monthly plans',
      'Strategies',
      'Notes',
    ]);
  });

  it('renders the agent H1 heading from plan.md body', async () => {
    const { container } = renderPlan(FULL_PLAN);
    const body = await waitFor(() => {
      const el = container.querySelector('[data-plan-body="true"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const h1 = body.querySelector('h1');
    expect(h1).not.toBeNull();
    expect(h1).toHaveTextContent('Alice');
  });

  it('renders the `### 2026-04` / `### 2026-05` monthly subsections under Monthly plans', async () => {
    const { container } = renderPlan(FULL_PLAN);
    const body = await waitFor(() => {
      const el = container.querySelector('[data-plan-body="true"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const h3Texts = Array.from(body.querySelectorAll('h3')).map((h) =>
      h.textContent.trim(),
    );
    expect(h3Texts).toContain('2026-04');
    expect(h3Texts).toContain('2026-05');
  });

  it('renders unordered list items for long-term goals and monthly plan objectives', async () => {
    const { container } = renderPlan(FULL_PLAN);
    const body = await waitFor(() => {
      const el = container.querySelector('[data-plan-body="true"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const listItems = Array.from(body.querySelectorAll('ul li')).map((li) =>
      li.textContent.trim(),
    );
    expect(listItems.some((t) => /Ship v1 of the aweek dashboard/.test(t))).toBe(
      true,
    );
    expect(
      listItems.some((t) => /Migrate SSR server to a Vite SPA/.test(t)),
    ).toBe(true);
    expect(
      listItems.some((t) => /Wire the Strategy tab/.test(t)),
    ).toBe(true);
  });

  it('renders inline emphasis (bold / italic) from the Strategies section', async () => {
    const { container } = renderPlan(FULL_PLAN);
    const body = await waitFor(() => {
      const el = container.querySelector('[data-plan-body="true"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const strong = body.querySelector('strong');
    const em = body.querySelector('em');
    expect(strong).not.toBeNull();
    expect(strong).toHaveTextContent(/theme-day scheduling/i);
    expect(em).not.toBeNull();
    expect(em).toHaveTextContent(/focused mornings/i);
  });

  it('renders inline and fenced code blocks', async () => {
    const { container } = renderPlan(FULL_PLAN);
    const body = await waitFor(() => {
      const el = container.querySelector('[data-plan-body="true"]');
      expect(el).not.toBeNull();
      return el!;
    });
    // Inline code from the Strategies section.
    const inlines = Array.from(body.querySelectorAll('p code')).map((c) =>
      c.textContent.trim(),
    );
    expect(inlines).toContain('/aweek:plan');
    // Fenced code block from the Notes section.
    const pre = body.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre).toHaveTextContent(/aweek exec plan-markdown write/);
  });

  it('renders blockquote content from the Strategies section', async () => {
    const { container } = renderPlan(FULL_PLAN);
    const body = await waitFor(() => {
      const el = container.querySelector('[data-plan-body="true"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const quote = body.querySelector('blockquote');
    expect(quote).not.toBeNull();
    expect(quote).toHaveTextContent(/fewer meetings, more deep work/i);
  });

  it('renders links with their URL preserved from the Notes section', async () => {
    const { container } = renderPlan(FULL_PLAN);
    const body = await waitFor(() => {
      const el = container.querySelector('[data-plan-body="true"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const anchor = body.querySelector('a[href="https://example.com/aweek"]');
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveTextContent(/aweek docs/i);
  });

  it('does not render raw HTML from plan.md — escapes user content', async () => {
    const DANGEROUS = {
      ...NO_PLAN,
      slug: 'mallory',
      name: 'Mallory',
      hasPlan: true,
      markdown:
        '# Mallory\n\n## Notes\n\n<script>window.__pwned = true;</script>\n',
    };
    const { container } = renderPlan(DANGEROUS);
    await waitFor(() => {
      expect(
        container.querySelector('[data-plan-body="true"]'),
      ).not.toBeNull();
    });
    // The `<script>` must be inert — neither injected as a tag nor run.
    expect(container.querySelector('script')).toBeNull();
    expect((globalThis as unknown as Record<string, unknown>).__pwned).not.toBe(true);
  });
});

// ── Weekly plans list ────────────────────────────────────────────────

describe('AgentPlanPage — weekly plans list parity with WeeklyPlanStore', () => {
  it('renders one row per weekly plan with its ISO week key and task count', async () => {
    const { container } = renderPlan(FULL_PLAN);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-plan"]'),
      ).not.toBeNull();
    });
    const rows = Array.from(container.querySelectorAll('li[data-week]'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute('data-week', '2026-W16');
    expect(rows[1]).toHaveAttribute('data-week', '2026-W17');
    expect(rows[2]).toHaveAttribute('data-week', '2026-W18');
    // Task counts surfaced per row.
    expect(rows[0]).toHaveTextContent(/2 tasks/);
    expect(rows[1]).toHaveTextContent(/3 tasks/);
    // Singular "task" (no trailing "s"). The row's textContent
    // concatenates "1 task" with the sibling "pending" badge, so we
    // use a negative lookahead rather than a word boundary.
    expect(rows[2]).toHaveTextContent(/1 task(?!s)/);
  });

  it('marks the latest-approved week with its badge', async () => {
    const { container } = renderPlan(FULL_PLAN);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-plan"]'),
      ).not.toBeNull();
    });
    const latest = container.querySelector('li[data-week="2026-W17"]');
    expect(latest).not.toBeNull();
    expect(latest).toHaveTextContent(/latest approved/i);
    // Older approved rows should NOT carry the "latest approved" badge.
    const older = container.querySelector('li[data-week="2026-W16"]');
    expect(older).not.toBeNull();
    expect(older!.textContent).not.toMatch(/latest approved/i);
  });

  it('renders the approval badge tone per week (approved vs pending)', async () => {
    const { container } = renderPlan(FULL_PLAN);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-plan"]'),
      ).not.toBeNull();
    });
    const approved = container.querySelector('li[data-week="2026-W16"]');
    const pending = container.querySelector('li[data-week="2026-W18"]');
    expect(approved!.textContent).toMatch(/approved/i);
    expect(pending!.textContent).toMatch(/pending/i);
  });

  it('surfaces the plan count in the Strategy header summary', async () => {
    const { container } = renderPlan(FULL_PLAN);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-plan"]'),
      ).not.toBeNull();
    });
    // 3 weekly plans in the fixture.
    expect(container).toHaveTextContent(/3 weekly plans/i);
  });

  it('omits the weekly plans section entirely when the list is empty', async () => {
    const { container } = renderPlan(PLAN_NO_WEEKS);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-plan"]'),
      ).not.toBeNull();
    });
    expect(container.querySelector('li[data-week]')).toBeNull();
    // Plan body still renders so the Strategy tab isn't blank.
    expect(
      container.querySelector('[data-plan-body="true"]'),
    ).not.toBeNull();
  });
});

// ── Refresh wiring ───────────────────────────────────────────────────

describe('AgentPlanPage — refresh wiring', () => {
  it('clicking Refresh re-invokes the plan fetch', async () => {
    const { fetch, container } = renderPlan(FULL_PLAN);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-plan"]'),
      ).not.toBeNull();
    });
    const initialCalls = fetch.mock.calls.length;
    const refresh = within(container).getByRole('button', {
      name: /refresh/i,
    });
    await act(async () => {
      refresh.click();
    });
    await waitFor(() => {
      expect(fetch.mock.calls.length).toBeGreaterThan(initialCalls);
    });
    // Hook still hits the `/plan` endpoint (Sub-AC 3.3: data is sourced
    // only via `useAgentPlan`, i.e. `GET /api/agents/:slug/plan`).
    const lastCall = fetch.mock.calls[fetch.mock.calls.length - 1];
    expect(lastCall[0]).toMatch(/\/api\/agents\/alice\/plan$/);
  });
});
