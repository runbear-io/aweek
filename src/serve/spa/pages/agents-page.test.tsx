/**
 * Component tests for the Overview page (`AgentsPage`) — Sub-AC 4.2.
 *
 * These tests verify **rendering parity** between the SPA Overview table
 * and the terminal baseline produced by `renderTable` + `buildSummaryRow`
 * in `src/skills/summary.js`. The two surfaces present the same
 * information (week header, per-agent row with tasks + budget + status);
 * the SPA drops the Goals column because goals now live in free-form
 * `plan.md` without a programmatic count (documented in
 * `agents-page.jsx`), so parity is checked on the four kept columns:
 *
 *   Terminal (renderTable) : Agent | Goals | Tasks  | Budget | Status
 *   SPA     (AgentsPage)   : Agent | Tasks |        | Budget | Status
 *
 * We render `AgentsPage` with an injected `fetch` stub so `useAgents`
 * resolves against fixture data rather than the real `aweek serve`
 * endpoints. The fixtures are then fed into the same terminal
 * formatters the CLI uses — `formatTasksCell`, `formatBudgetCell`,
 * `stateLabel` — and we assert the SPA's DOM surface carries the same
 * user-visible tokens (e.g. "2/5", "25%", "ACTIVE").
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Config : `vitest.config.js` (scoped to `**\/*.test.jsx`).
 * Command: `pnpm test:spa`
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';

// `agents-page` was migrated to TypeScript (AC 101 sub-AC 1). Vitest's
// oxc resolver imports `.tsx` extensions identically to `.jsx`.
import { AgentsPage } from './agents-page.tsx';
import {
  formatTasksCell,
  formatBudgetCell,
  stateLabel,
} from '../../../skills/summary.js';

// ── Fixtures ─────────────────────────────────────────────────────────
// `AgentListRow` shape mirrors `src/serve/data/agents.js` → `gatherAgentsList`.
// We use two rows to exercise both the "active / under budget" and the
// "budget exhausted / no plan" terminal states.

const WEEK = '2026-W16';

/** Active, under budget, has a plan. */
const ALICE = {
  slug: 'alice',
  name: 'Alice',
  description: 'lead dev',
  missing: false,
  status: 'active',
  tokensUsed: 25_000,
  tokenLimit: 100_000,
  utilizationPct: 25,
  week: WEEK,
  tasksTotal: 5,
  tasksCompleted: 2,
};

/** Paused / budget exhausted, no weekly plan. */
const BOB = {
  slug: 'bob',
  name: 'Bob',
  description: 'writer',
  missing: false,
  status: 'budget-exhausted',
  tokensUsed: 100_000,
  tokenLimit: 100_000,
  utilizationPct: 100,
  week: WEEK,
  tasksTotal: 0,
  tasksCompleted: 0,
};

/** Subagent .md absent — mirrors [subagent missing] marker from summary.js. */
const ORPHAN = {
  slug: 'orphan',
  name: 'orphan', // gatherer falls back to slug when identity is missing
  description: '',
  missing: true,
  status: 'paused',
  tokensUsed: 0,
  tokenLimit: 0,
  utilizationPct: null,
  week: WEEK,
  tasksTotal: 0,
  tasksCompleted: 0,
};

/**
 * Build a `fetch` stub matching the `api-client.getJson` contract:
 *   - Returns `{ ok, status, statusText, text() }`.
 *   - Body is `JSON.stringify({ agents: rows })` to mirror the `/api/agents`
 *     envelope that `fetchAgentsList` unwraps.
 */
function makeFetchStub(rows: unknown, { ok = true, status = 200, statusText = 'OK' } = {}) {
  const body = ok ? JSON.stringify({ agents: rows }) : JSON.stringify({ error: 'boom' });
  const calls: Array<{ url: unknown; init?: unknown }> = [];
  const fetchImpl = vi.fn((url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok,
      status,
      statusText,
      text: () => Promise.resolve(body),
    });
  });
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

/** Render helper that threads the stubbed fetch into the hook. */
function renderPage(rows: unknown, options: { ok?: boolean; status?: number; statusText?: string } = {}) {
  const { fetch } = makeFetchStub(rows, options);
  const utils = render(<AgentsPage fetch={fetch} />);
  return { ...utils, fetch };
}

// ── Test lifecycle ───────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Loading / header / empty / error chrome ─────────────────────────

describe('AgentsPage — chrome', () => {
  it('shows a loading skeleton until the first fetch resolves', async () => {
    // Never-resolving promise keeps the hook pinned to loading=true so we
    // can observe the skeleton state.
    const fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof globalThis.fetch;
    render(<AgentsPage fetch={fetch} />);

    const loader = await screen.findByRole('status');
    expect(loader).toHaveAttribute('data-loading', 'true');
    expect(loader).toHaveTextContent(/loading agents/i);
  });

  it('renders the "no agents" empty state and still shows the week header', async () => {
    renderPage([]);

    // Empty copy mirrors the terminal `formatSummaryReport` "No agents found"
    // banner ("/aweek:hire" CTA on both surfaces).
    expect(await screen.findByText(/no agents yet/i)).toBeInTheDocument();
    expect(screen.getByText(/\/aweek:hire/i)).toBeInTheDocument();

    // Empty header: "— · 0 agents" — week placeholder, zero count.
    const header = screen.getByRole('banner');
    expect(header).toHaveTextContent(/0 agents/i);
  });

  it('renders a typed error state on non-2xx and exposes a Retry button', async () => {
    renderPage([ALICE], { ok: false, status: 500, statusText: 'Internal Server Error' });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-error', 'true');
    expect(within(alert).getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});

// ── Rendering parity with renderTable (core sub-AC 4.2 contract) ────

describe('AgentsPage — parity with terminal renderTable', () => {
  it('renders the week header matching the terminal "Week: <key>" caption', async () => {
    renderPage([ALICE]);
    // Terminal baseline: `Week: 2026-W16 (Monday: YYYY-MM-DD)` —
    // SPA drops the Monday literal (not exposed via /api/agents) but
    // keeps the week key so the two surfaces agree on the ISO week.
    const header = await screen.findByRole('banner');
    expect(header).toHaveTextContent(WEEK);
  });

  it('renders the four required column headers (Agent | Status | Tasks | Budget)', async () => {
    renderPage([ALICE]);
    const table = await screen.findByRole('table');

    // Order matters — the SPA spec in `agents-page.jsx` pins the header
    // to Agent | Status | Tasks | Budget. Parity check: same tokens the
    // terminal COLUMNS array carries, minus Goals (see file docstring).
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Agent', 'Status', 'Tasks', 'Budget']);
  });

  it('renders one row per agent with the same Tasks token renderTable would emit', async () => {
    renderPage([ALICE, BOB]);

    // Row lookup by data-agent-slug — mirrors the terminal's per-row keying.
    const aliceRow = (await screen.findByText('Alice')).closest('tr');
    const bobRow = screen.getByText('Bob').closest('tr');
    expect(aliceRow).toHaveAttribute('data-agent-slug', 'alice');
    expect(bobRow).toHaveAttribute('data-agent-slug', 'bob');

    // Terminal formatTasksCell("2/5") vs SPA rendered cell — parity.
    const aliceTasks = formatTasksCell({
      total: ALICE.tasksTotal,
      byStatus: { completed: ALICE.tasksCompleted },
    });
    expect(aliceTasks).toBe('2/5');
    // SPA splits "2/5" into "2" + "/5" across two elements for styling,
    // but the flattened row text preserves both tokens in order.
    expect(aliceRow).toHaveTextContent(/2\s*\/\s*5/);

    const bobTasks = formatTasksCell({
      total: BOB.tasksTotal,
      byStatus: { completed: BOB.tasksCompleted },
    });
    expect(bobTasks).toBe('—');
    expect(bobRow).toHaveTextContent('—');
  });

  it('renders the Budget cell with the same used / limit / pct tokens as formatBudgetCell', async () => {
    renderPage([ALICE]);
    const aliceRow = (await screen.findByText('Alice')).closest('tr');

    // Terminal rendering: "25,000 / 100,000 (25%)".
    const terminalBudget = formatBudgetCell(
      { weeklyTokenLimit: ALICE.tokenLimit, utilizationPct: ALICE.utilizationPct },
      { totalTokens: ALICE.tokensUsed },
    );
    expect(terminalBudget).toMatch(/25,000/);
    expect(terminalBudget).toMatch(/100,000/);
    expect(terminalBudget).toMatch(/25%/);

    // SPA renders a compact variant ("25.0k / 100k (25%)") — the
    // information carried is the same: a used count, a limit, and a
    // utilisation percentage. Parity is asserted on the percent token
    // (identical) and on the presence of both sides of the fraction.
    expect(aliceRow).toHaveTextContent('25%');
    expect(aliceRow).toHaveTextContent(/25\.?\d*\s*k/i); // "25.0k" / "25k"
    expect(aliceRow).toHaveTextContent(/100\s*k/i);
  });

  it('renders "no limit" for agents without a weekly token cap — matches the terminal copy', async () => {
    renderPage([ORPHAN]);
    // The orphan row is keyed by data-agent-slug — more specific than
    // findByText('orphan'), which matches both the name span and the
    // slug <code> element for a slug-equals-name fallback row.
    await screen.findByRole('table');
    const row = document.querySelector('tr[data-agent-slug="orphan"]');
    expect(row).not.toBeNull();

    // Terminal: formatBudgetCell → "no limit" when weeklyTokenLimit falsy.
    const terminalBudget = formatBudgetCell(
      { weeklyTokenLimit: ORPHAN.tokenLimit },
      { totalTokens: ORPHAN.tokensUsed },
    );
    expect(terminalBudget).toBe('no limit');
    // SPA uses the same exact phrase so a user switching between the
    // `/aweek:summary` CLI report and the dashboard sees identical copy.
    expect(row).toHaveTextContent(/no limit/i);
  });

  it('renders the Status badge with the same uppercase label stateLabel returns', async () => {
    renderPage([ALICE, BOB]);

    // Alice is `active` — both surfaces render "ACTIVE".
    const aliceRow = (await screen.findByText('Alice')).closest('tr');
    expect(within(aliceRow!).getByText(stateLabel('active'))).toBeInTheDocument();

    // Bob is `budget-exhausted` — the SPA uses the space-separated label
    // "BUDGET EXHAUSTED" to match the terminal's UPPERCASE convention
    // without inventing a new copy surface.
    const bobRow = screen.getByText('Bob').closest('tr');
    expect(within(bobRow!).getByText(/budget exhausted/i)).toBeInTheDocument();
  });

  it('renders the [subagent missing] marker next to the slug when identity.md is absent', async () => {
    renderPage([ORPHAN]);
    await screen.findByRole('table');
    // Query by data-agent-slug to avoid ambiguity with a row whose name
    // falls back to the slug (both strings read "orphan" in the DOM).
    const row = document.querySelector('tr[data-agent-slug="orphan"]');
    expect(row).not.toBeNull();

    // Terminal: `<slug> [subagent missing]` literal. SPA: a styled badge
    // reading "subagent missing" colocated with the slug — same signal.
    expect(row).toHaveTextContent(/subagent missing/i);
    expect(row).toHaveTextContent('orphan');
  });

  it('emits exactly one <tr> per agent (row-count parity with renderTable)', async () => {
    renderPage([ALICE, BOB, ORPHAN]);

    const table = await screen.findByRole('table');
    const bodyRows = within(table).getAllByRole('row')
      // Skip the header row so the count mirrors the terminal's data-row
      // count. `queryAllByRole` is used instead of `queryByRole` because a
      // single <tr> can hold multiple <th scope="col"> columnheaders, and
      // the singular variant throws on "multiple elements found".
      .filter((tr) => within(tr).queryAllByRole('columnheader').length === 0);
    expect(bodyRows).toHaveLength(3);
  });
});

// ── Interaction surface kept small for Sub-AC 4.2 — row click routing ─

describe('AgentsPage — row click routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invokes onSelectAgent(slug) when a row is clicked', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve(JSON.stringify({ agents: [ALICE] })),
      }),
    ) as unknown as typeof globalThis.fetch;
    const onSelectAgent = vi.fn();
    render(<AgentsPage fetch={fetch} onSelectAgent={onSelectAgent} />);

    const row = (await screen.findByText('Alice')).closest('tr');
    row!.click();

    await waitFor(() => {
      expect(onSelectAgent).toHaveBeenCalledWith('alice');
    });
  });
});
