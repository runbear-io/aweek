/**
 * Component tests for `AgentProfilePage` — AC 2, Sub-AC 5.
 *
 * The Profile tab surfaces the live subagent identity from
 * `.claude/agents/<slug>.md` (name, description, system prompt)
 * alongside the scheduling + budget summary. These tests verify the
 * rendering contract through the `useAgentProfile` hook — the page
 * takes no domain props, so we inject a `fetch` stub that resolves
 * with a fixture payload matching `gatherAgentProfile`'s shape.
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Config : `vitest.config.js` (scoped to `**\/*.test.jsx`).
 * Command: `pnpm test:spa`
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';

import { AgentProfilePage } from './agent-profile-page.jsx';

// ── Fixtures ─────────────────────────────────────────────────────────

/** Healthy agent with a real .md on disk. */
const ALICE = {
  slug: 'alice',
  name: 'Alice the Writer',
  description: 'Content lead agent',
  systemPrompt:
    'You are Alice, the lead content writer.\n\nRules:\n- be concise\n- cite sources',
  missing: false,
  identityPath: '/tmp/project/.claude/agents/alice.md',
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-20T00:00:00Z',
  paused: false,
  pausedReason: null,
  periodStart: '2026-04-20T00:00:00Z',
  tokenLimit: 100_000,
  tokensUsed: 25_000,
  remaining: 75_000,
  overBudget: false,
  utilizationPct: 25,
  weekMonday: '2026-04-20',
};

/** Subagent .md missing (file deleted after hire). */
const ORPHAN = {
  ...ALICE,
  slug: 'orphan',
  name: 'orphan',
  description: '',
  systemPrompt: '',
  missing: true,
  identityPath: '/tmp/project/.claude/agents/orphan.md',
};

/** Subagent .md exists but body is empty. */
const BLANK_PROMPT = {
  ...ALICE,
  slug: 'blank',
  name: 'Blank',
  systemPrompt: '',
};

/**
 * Build an `AgentUsage` payload (Sub-AC 4) from a profile fixture. Keeps
 * the budget scalars in lock-step with the profile so tests that check
 * the Budget card via profile values still pass, while also exposing
 * the usage-only breakdown fields (input / output / cost / records) for
 * assertions that exercise the usage endpoint path.
 *
 * @param {typeof ALICE} profile
 * @param {Partial<{ inputTokens:number, outputTokens:number, costUsd:number, recordCount:number, weeks:Array<object> }>} [overrides]
 */
function makeUsage(profile, overrides = {}) {
  const defaults = {
    slug: profile.slug,
    name: profile.name,
    missing: !!profile.missing,
    paused: !!profile.paused,
    pausedReason: profile.pausedReason ?? null,
    weekMonday: profile.weekMonday,
    tokenLimit: profile.tokenLimit,
    tokensUsed: profile.tokensUsed,
    inputTokens: Math.floor((profile.tokensUsed || 0) * 0.6),
    outputTokens: Math.floor((profile.tokensUsed || 0) * 0.4),
    costUsd: 1.2345,
    recordCount: 3,
    remaining: profile.remaining,
    overBudget: profile.overBudget,
    utilizationPct: profile.utilizationPct,
    weeks: [
      {
        weekMonday: profile.weekMonday,
        recordCount: 3,
        inputTokens: Math.floor((profile.tokensUsed || 0) * 0.6),
        outputTokens: Math.floor((profile.tokensUsed || 0) * 0.4),
        totalTokens: profile.tokensUsed,
        costUsd: 1.2345,
      },
    ],
  };
  return { ...defaults, ...overrides };
}

/**
 * URL-aware fetch stub. The Profile page fetches *two* endpoints:
 *
 *   GET /api/agents/:slug         → `{ agent: <AgentProfile> }`
 *   GET /api/agents/:slug/usage   → `{ usage: <AgentUsage> }`  (Sub-AC 4)
 *
 * We dispatch on the URL suffix so each hook receives the envelope it
 * expects. Tests that want to exercise the "usage missing / errored"
 * code path can pass `usage: null` to force a failing usage response.
 *
 * @param {typeof ALICE} profile
 * @param {{
 *   ok?: boolean,
 *   status?: number,
 *   statusText?: string,
 *   usage?: ReturnType<typeof makeUsage> | null,
 *   usageOk?: boolean,
 *   usageStatus?: number,
 * }} [opts]
 */
function makeFetchStub(
  profile,
  {
    ok = true,
    status = 200,
    statusText = 'OK',
    usage,
    usageOk = true,
    usageStatus = 200,
  } = {},
) {
  const usagePayload = usage === undefined ? makeUsage(profile) : usage;
  return vi.fn((url) => {
    const isUsageEndpoint = String(url).endsWith('/usage');
    if (isUsageEndpoint) {
      return Promise.resolve({
        ok: usageOk,
        status: usageStatus,
        statusText: usageOk ? 'OK' : 'Error',
        text: () =>
          Promise.resolve(
            usageOk && usagePayload
              ? JSON.stringify({ usage: usagePayload })
              : JSON.stringify({ error: 'usage boom' }),
          ),
      });
    }
    return Promise.resolve({
      ok,
      status,
      statusText,
      text: () =>
        Promise.resolve(
          ok
            ? JSON.stringify({ agent: profile })
            : JSON.stringify({ error: 'boom' }),
        ),
    });
  });
}

/**
 * Render the page and wait for the hook's first fetch to settle by
 * looking for the page's stable data marker (`[data-page="agent-profile"]`
 * without `data-loading`). Tests assert against this marker instead of
 * the agent name because the name appears in both the header and the
 * identity card — `findByText` would return a multi-match error.
 */
async function renderReady(profile, stubOpts) {
  const fetch = makeFetchStub(profile, stubOpts);
  const utils = render(<AgentProfilePage slug={profile.slug} fetch={fetch} />);
  await waitFor(() => {
    const el = utils.container.querySelector(
      '[data-page="agent-profile"]:not([data-loading])',
    );
    expect(el).not.toBeNull();
  });
  return utils;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AgentProfilePage — identity from .claude/agents/<slug>.md', () => {
  it('renders the subagent name and description from the fixture', async () => {
    await renderReady(ALICE);
    // Name appears in both the header and the identity card — parity
    // with status.js which prints the name twice in its drill-down.
    const nameMatches = screen.getAllByText('Alice the Writer');
    expect(nameMatches.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Content lead agent')).toBeInTheDocument();
  });

  it('renders the identity file path inside the Identity card', async () => {
    await renderReady(ALICE);
    expect(screen.getByText(ALICE.identityPath)).toBeInTheDocument();
  });

  it('shows the missing-subagent banner when identity is absent', async () => {
    await renderReady(ORPHAN);
    expect(screen.getByText(/Subagent file missing/i)).toBeInTheDocument();
  });
});

describe('AgentProfilePage — system prompt card (Sub-AC 5)', () => {
  it('renders the multi-line system prompt verbatim in a preformatted block', async () => {
    const { container } = await renderReady(ALICE);
    const promptBlock = container.querySelector('[data-field="system-prompt"]');
    expect(promptBlock).not.toBeNull();
    // Line breaks and bullet characters must survive — the prompt is
    // rendered in a <pre> with whitespace-pre-wrap so multi-line rules
    // remain readable.
    expect(promptBlock.textContent).toContain(
      'You are Alice, the lead content writer.',
    );
    expect(promptBlock.textContent).toContain('- be concise');
    expect(promptBlock.textContent).toContain('- cite sources');
  });

  it('renders an empty-state message when the .md has no body', async () => {
    const { container } = await renderReady(BLANK_PROMPT);
    // No <pre data-field="system-prompt"> when body is empty — the UI
    // shows a placeholder sentence instead so users know the prompt is
    // actually blank (not that the page is broken).
    expect(container.querySelector('[data-field="system-prompt"]')).toBeNull();
    expect(screen.getByText(/no system prompt is set/i)).toBeInTheDocument();
  });

  it('renders a "missing" message on the System prompt card when identity is absent', async () => {
    await renderReady(ORPHAN);
    const promptCard = screen
      .getAllByLabelText('System prompt')
      .find((el) => el.tagName === 'SECTION');
    expect(promptCard).toBeTruthy();
    expect(
      within(promptCard).getByText(/no system prompt to show/i),
    ).toBeInTheDocument();
    expect(
      within(promptCard).getByText(/subagent \.md file is missing/i),
    ).toBeInTheDocument();
  });
});

describe('AgentProfilePage — budget / usage summary', () => {
  it('renders the weekly budget card with tokens used / limit / utilisation', async () => {
    await renderReady(ALICE);
    const budgetCard = screen
      .getAllByLabelText('Budget')
      .find((el) => el.tagName === 'SECTION');
    expect(budgetCard).toBeTruthy();
    // 25_000 renders as "25k"; 100_000 renders as "100k" — see formatTokens.
    expect(within(budgetCard).getByText(/25k/)).toBeInTheDocument();
    expect(within(budgetCard).getByText(/100k/)).toBeInTheDocument();
    expect(within(budgetCard).getByText(/25%/)).toBeInTheDocument();
  });

  it('flags over-budget state with the "over budget" pill', async () => {
    const over = {
      ...ALICE,
      slug: 'spender',
      name: 'Spender',
      tokensUsed: 110_000,
      remaining: 0,
      overBudget: true,
      utilizationPct: 110,
      paused: true,
      pausedReason: 'budget_exhausted',
    };
    await renderReady(over);
    expect(screen.getByText(/over budget/i)).toBeInTheDocument();
  });

  it('shows "week of" header sourced from the usage endpoint', async () => {
    await renderReady(ALICE);
    const budgetCard = screen
      .getAllByLabelText('Budget')
      .find((el) => el.tagName === 'SECTION');
    // The "Week of 2026-04-20" header is rendered inside the Budget
    // card using the `weekMonday` from the usage endpoint (falls back
    // to the profile value while the usage fetch is in-flight).
    expect(within(budgetCard).getByText(/Week of/i)).toBeInTheDocument();
    expect(within(budgetCard).getByText('2026-04-20')).toBeInTheDocument();
  });

  it('renders the usage-endpoint breakdown (input / output / cost / records)', async () => {
    // Wait long enough for *both* the profile and usage fetches to settle
    // before asserting on the usage-only breakdown block.
    const fetch = makeFetchStub(ALICE);
    const { container } = render(<AgentProfilePage slug={ALICE.slug} fetch={fetch} />);
    await waitFor(() => {
      const el = container.querySelector(
        '[data-page="agent-profile"]:not([data-loading])',
      );
      expect(el).not.toBeNull();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-field="usage-breakdown"]')).not.toBeNull();
    });
    const budgetCard = screen
      .getAllByLabelText('Budget')
      .find((el) => el.tagName === 'SECTION');
    expect(budgetCard).toBeTruthy();
    // 25_000 * 0.6 = 15_000 → "15k"; 25_000 * 0.4 = 10_000 → "10k"
    const breakdown = within(budgetCard).getByTestId
      ? null // fallback — we key off data-field instead
      : null;
    void breakdown;
    // The input/output labels live in the breakdown sub-block.
    expect(within(budgetCard).getByText(/Input tokens/i)).toBeInTheDocument();
    expect(within(budgetCard).getByText(/Output tokens/i)).toBeInTheDocument();
    expect(within(budgetCard).getByText('15k')).toBeInTheDocument();
    expect(within(budgetCard).getByText('10k')).toBeInTheDocument();
    // Cost rendered to 4 decimals from `costUsd: 1.2345`
    expect(within(budgetCard).getByText('$1.2345')).toBeInTheDocument();
    // Record count (3 in makeUsage)
    expect(within(budgetCard).getByText('3')).toBeInTheDocument();
  });

  it('hits the /usage endpoint for the Profile Budget card', async () => {
    const fetch = makeFetchStub(ALICE);
    const { container } = render(<AgentProfilePage slug={ALICE.slug} fetch={fetch} />);
    await waitFor(() => {
      expect(container.querySelector('[data-field="usage-breakdown"]')).not.toBeNull();
    });
    // Sub-AC 4 explicit contract: the Budget card on the Profile tab
    // consumes the *usage* endpoint, not just the profile endpoint.
    const usageHits = fetch.mock.calls.filter((call) =>
      String(call[0]).endsWith(`/api/agents/${ALICE.slug}/usage`),
    );
    expect(usageHits.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to profile budget values while the usage fetch is in-flight', async () => {
    // Build a fetch that resolves the profile immediately but leaves
    // the usage request pending so we can observe the fallback path.
    let resolveUsage;
    const pendingUsage = new Promise((resolve) => {
      resolveUsage = resolve;
    });
    const fetch = vi.fn((url) => {
      if (String(url).endsWith('/usage')) return pendingUsage;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve(JSON.stringify({ agent: ALICE })),
      });
    });

    const { container } = render(<AgentProfilePage slug={ALICE.slug} fetch={fetch} />);
    await waitFor(() => {
      const el = container.querySelector(
        '[data-page="agent-profile"]:not([data-loading])',
      );
      expect(el).not.toBeNull();
    });
    // Fallback rendering: budget card shows the profile token values
    // and surfaces a "Loading usage details…" affordance until the
    // pending usage request completes.
    const budgetCard = screen
      .getAllByLabelText('Budget')
      .find((el) => el.tagName === 'SECTION');
    expect(within(budgetCard).getByText(/25k/)).toBeInTheDocument();
    expect(within(budgetCard).getByText(/100k/)).toBeInTheDocument();
    expect(container.querySelector('[data-field="usage-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-field="usage-breakdown"]')).toBeNull();

    // Let the usage request resolve so the breakdown block renders.
    resolveUsage({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(JSON.stringify({ usage: makeUsage(ALICE) })),
    });
    await waitFor(() => {
      expect(container.querySelector('[data-field="usage-breakdown"]')).not.toBeNull();
    });
  });

  it('shows an inline error affordance when the usage fetch fails', async () => {
    const fetch = makeFetchStub(ALICE, { usageOk: false, usageStatus: 500 });
    const { container } = render(<AgentProfilePage slug={ALICE.slug} fetch={fetch} />);
    await waitFor(() => {
      expect(container.querySelector('[data-field="usage-error"]')).not.toBeNull();
    });
    // The Budget card must still show the profile's fallback values
    // (25k / 100k / 25%) so the tab is useful even with the usage
    // endpoint offline.
    const budgetCard = screen
      .getAllByLabelText('Budget')
      .find((el) => el.tagName === 'SECTION');
    expect(within(budgetCard).getByText(/25k/)).toBeInTheDocument();
    expect(within(budgetCard).getByText(/100k/)).toBeInTheDocument();
  });
});

describe('AgentProfilePage — error + empty states', () => {
  it('shows a not-found empty state when the API returns 404', async () => {
    const fetch = makeFetchStub(ALICE, { ok: false, status: 404, statusText: 'Not Found' });
    const { container } = render(
      <AgentProfilePage slug="ghost" fetch={fetch} />,
    );
    await waitFor(() => {
      const empty = container.querySelector(
        '[data-page="agent-profile"][data-state="empty"]',
      );
      expect(empty).not.toBeNull();
    });
  });

  it('shows an empty state when no slug is provided', () => {
    const { container } = render(<AgentProfilePage slug="" />);
    const empty = container.querySelector(
      '[data-page="agent-profile"][data-state="empty"]',
    );
    expect(empty).not.toBeNull();
    expect(empty.textContent).toMatch(/select an agent/i);
  });
});
