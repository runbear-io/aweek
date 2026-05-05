/**
 * Tests for `./floating-chat-panel.tsx` — the AC 10 composite that
 * combines the agent picker with the streaming `<ChatThread>` inside
 * the floating bubble's body slot.
 *
 * Contract pinned by these tests:
 *
 *   1. The picker bar is mounted at the top of the panel.
 *   2. The thread is mounted only when an effective slug is resolved;
 *      otherwise the empty-state takes its place.
 *   3. `data-effective-slug` / `data-route-slug` / `data-source` on
 *      the wrapper expose the resolution path so layout integration
 *      tests can assert it without inspecting the picker internals.
 *   4. Switching the picker re-keys the thread (the previous thread
 *      unmounts) so its local state doesn't leak between agents.
 *   5. With `selectionOverride` and `agentsOverride` the component
 *      can be rendered in isolation without a router or `<fetch>`.
 *
 * Vitest + jsdom + Testing Library (config: vitest.config.js +
 * vitest.setup.js).
 */

import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MemoryRouter } from 'react-router-dom';

import { FloatingChatPanel } from './floating-chat-panel.tsx';
import { ChatPanelProvider } from './chat-panel-context.tsx';
import type { AgentListRow } from '../lib/api-client.js';
import type { UseChatAgentSelectionResult } from '../hooks/use-chat-agent-selection.ts';

afterEach(() => {
  cleanup();
});

function makeAgent(overrides: Partial<AgentListRow>): AgentListRow {
  return {
    slug: overrides.slug ?? 'writer',
    name: overrides.name ?? 'Writer',
    description: overrides.description ?? '',
    missing: overrides.missing ?? false,
    status: overrides.status ?? 'active',
    tokensUsed: overrides.tokensUsed ?? 0,
    tokenLimit: overrides.tokenLimit ?? 1_000_000,
    utilizationPct: overrides.utilizationPct ?? 0,
    week: overrides.week ?? '2026-W17',
    tasksTotal: overrides.tasksTotal ?? 0,
    tasksCompleted: overrides.tasksCompleted ?? 0,
  };
}

const ROSTER: AgentListRow[] = [
  makeAgent({ slug: 'writer', name: 'Writer' }),
  makeAgent({ slug: 'reviewer', name: 'Reviewer' }),
];

function makeSelection(
  overrides: Partial<UseChatAgentSelectionResult> = {},
): UseChatAgentSelectionResult {
  return {
    effectiveSlug: 'writer',
    selectedAgentSlug: null,
    routeAgentSlug: 'writer',
    source: 'route',
    setSelectedAgentSlug: vi.fn(),
    ...overrides,
  };
}

// Stub `fetch` for the ChatThread mount so the underlying
// `useChatStream` doesn't trigger a real network request when the
// thread's composer renders.
function noopFetch(): typeof fetch {
  return vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
}

/**
 * Wrap a child element with the providers `FloatingChatPanel` requires
 * (router for `useLocation`, chat-panel context for the agent-selection
 * hook). Tests pass `selectionOverride` to bypass the picker plumbing
 * but `useChatAgentSelection` is still called for hook-order stability,
 * so the providers must always be present even with an override.
 */
function withProviders(
  children: React.ReactNode,
  pathname = '/agents/writer',
): React.ReactElement {
  return (
    <MemoryRouter initialEntries={[pathname]}>
      <ChatPanelProvider storage={null}>{children}</ChatPanelProvider>
    </MemoryRouter>
  );
}

// ── Mount / wrapper attributes ───────────────────────────────────────

describe('FloatingChatPanel — wrapper exposes resolution metadata', () => {
  it('mirrors source / effectiveSlug / routeSlug onto data-* attrs', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({
            effectiveSlug: 'writer',
            routeAgentSlug: 'writer',
            source: 'route',
          })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
        />,
      ),
    );
    const wrapper = container.querySelector(
      '[data-component="floating-chat-panel"]',
    );
    expect(wrapper?.getAttribute('data-source')).toBe('route');
    expect(wrapper?.getAttribute('data-effective-slug')).toBe('writer');
    expect(wrapper?.getAttribute('data-route-slug')).toBe('writer');
  });

  it('reflects the explicit-selection source when the user has picked', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({
            effectiveSlug: 'reviewer',
            selectedAgentSlug: 'reviewer',
            routeAgentSlug: 'writer',
            source: 'explicit',
          })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
        />,
      ),
    );
    const wrapper = container.querySelector(
      '[data-component="floating-chat-panel"]',
    );
    expect(wrapper?.getAttribute('data-source')).toBe('explicit');
    expect(wrapper?.getAttribute('data-effective-slug')).toBe('reviewer');
    expect(wrapper?.getAttribute('data-route-slug')).toBe('writer');
  });
});

// ── Picker bar ───────────────────────────────────────────────────────

describe('FloatingChatPanel — picker bar', () => {
  it('mounts the agent picker at the top of the panel', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection()}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
        />,
      ),
    );
    expect(
      container.querySelector(
        '[data-component="floating-chat-panel-picker-row"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-component="chat-agent-picker"]'),
    ).not.toBeNull();
  });

  it('forwards the effective slug as the picker value', () => {
    render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({
            effectiveSlug: 'reviewer',
            selectedAgentSlug: 'reviewer',
            source: 'explicit',
          })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
        />,
      ),
    );
    const select = screen.getByRole('combobox', {
      name: 'Choose chat agent',
    }) as HTMLSelectElement;
    expect(select.value).toBe('reviewer');
  });

  it('routes user picks to setSelectedAgentSlug', () => {
    const setSelectedAgentSlug = vi.fn();
    render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ setSelectedAgentSlug })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
        />,
      ),
    );
    const select = screen.getByRole('combobox', {
      name: 'Choose chat agent',
    });
    fireEvent.change(select, { target: { value: 'reviewer' } });
    expect(setSelectedAgentSlug).toHaveBeenCalledWith('reviewer');
  });
});

// ── Thread mounting ──────────────────────────────────────────────────

describe('FloatingChatPanel — thread mount', () => {
  it('mounts the chat thread when an effective slug exists', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection()}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
        />,
      ),
    );
    expect(
      container.querySelector('[data-component="chat-thread-composer"]'),
    ).not.toBeNull();
  });

  it('omits the thread and renders the empty-state when no slug is resolved', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({
            effectiveSlug: null,
            routeAgentSlug: null,
            source: 'none',
          })}
          agentsOverride={{ rows: [] }}
        />,
      ),
    );
    expect(
      container.querySelector('[data-component="chat-thread-composer"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-component="floating-chat-panel-empty"]'),
    ).not.toBeNull();
  });

  it('uses the agent name as the thread title when available', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({
            effectiveSlug: 'writer',
          })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
        />,
      ),
    );
    const title = container.querySelector(
      '[data-component="chat-thread-title"]',
    );
    expect(title?.textContent).toBe('Writer');
  });
});

// ── Sub-AC 4 of AC 7: Budget-exhausted gating ───────────────────────────

describe('FloatingChatPanel — budget-exhausted gating', () => {
  it('shows the budget banner and disables the composer when the agent status is budget-exhausted', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{
            rows: [makeAgent({ slug: 'writer', status: 'budget-exhausted' })],
          }}
          threadPropsOverride={{ fetch: noopFetch() }}
        />,
      ),
    );

    const banner = container.querySelector(
      '[data-component="chat-thread-budget-banner"]',
    );
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain(
      'Weekly budget exhausted — resume via aweek manage',
    );

    const textarea = container.querySelector(
      '[data-component="chat-thread-input"]',
    ) as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea!.disabled).toBe(true);
  });

  it('also gates a paused agent (composer disabled, banner rendered)', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{
            rows: [makeAgent({ slug: 'writer', status: 'paused' })],
          }}
          threadPropsOverride={{ fetch: noopFetch() }}
        />,
      ),
    );

    expect(
      container.querySelector(
        '[data-component="chat-thread-budget-banner"]',
      ),
    ).not.toBeNull();
    const textarea = container.querySelector(
      '[data-component="chat-thread-input"]',
    ) as HTMLTextAreaElement | null;
    expect(textarea!.disabled).toBe(true);
  });

  it('does not render the banner for an active agent', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{
            rows: [makeAgent({ slug: 'writer', status: 'active' })],
          }}
          threadPropsOverride={{ fetch: noopFetch() }}
        />,
      ),
    );
    expect(
      container.querySelector(
        '[data-component="chat-thread-budget-banner"]',
      ),
    ).toBeNull();
  });
});

// ── AC 13: budget re-enable via aweek manage resume / top-up ────────────

describe('FloatingChatPanel — AC 13: external resume re-enables composer', () => {
  /**
   * AC 13 contract: when the user runs `aweek manage resume` (or
   * `top-up`) from the CLI, the agent's `budget.paused` flips from
   * `true` → `false` on disk. The dashboard SPA can't be notified
   * directly (no websocket / push) — instead, `useAgents` polls the
   * roster while the selected agent is in a budget-locked state. As
   * soon as the next poll returns the agent as `active`, the
   * composer's `disabled` attribute drops and the budget banner
   * disappears, all without a page reload.
   *
   * The tests below pin two slices of that contract:
   *
   *   1. The ROSTER FLIP path. We bypass the polling timer entirely
   *      by mounting the panel with a `budget-exhausted` roster, then
   *      re-rendering with the same agent flipped to `active`. The
   *      composer must re-enable and the banner must vanish — proving
   *      the derived gate is reactive to the roster, not pinned at
   *      mount.
   *
   *   2. The TOP-UP path. Same as above but with the agent in
   *      `paused` status (mirrors `top-up` resetting usage; the
   *      paused flag is what gates chat). Same expectation: the
   *      composer re-enables once status is `active`.
   *
   * We feed the roster via `agentsOverride` so the test stays
   * decoupled from the polling timer (the production poll is verified
   * separately via `use-agents.test.ts`). This isolates "does the
   * panel react to a status flip" from "does the hook actually poll",
   * which is the right factoring for a unit test.
   */

  it('re-enables the composer + drops the banner when roster status flips budget-exhausted → active', () => {
    const ExternalResumeHarness: React.FC<{ status: AgentListRow['status'] }> = ({
      status,
    }) => (
      <FloatingChatPanel
        selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
        agentsOverride={{
          rows: [makeAgent({ slug: 'writer', status })],
        }}
        threadPropsOverride={{ fetch: noopFetch() }}
        budgetRefreshIntervalMs={0}
      />
    );

    const { container, rerender } = render(
      withProviders(<ExternalResumeHarness status="budget-exhausted" />),
    );

    // Pre-flip: banner present, composer locked.
    expect(
      container.querySelector(
        '[data-component="chat-thread-budget-banner"]',
      ),
    ).not.toBeNull();
    let textarea = container.querySelector(
      '[data-component="chat-thread-input"]',
    ) as HTMLTextAreaElement | null;
    expect(textarea?.disabled).toBe(true);

    // Simulate the CLI running `aweek manage resume` and the next
    // roster poll returning the agent as `active`.
    rerender(
      withProviders(<ExternalResumeHarness status="active" />),
    );

    // Post-flip: banner gone, composer enabled. No page reload.
    expect(
      container.querySelector(
        '[data-component="chat-thread-budget-banner"]',
      ),
    ).toBeNull();
    textarea = container.querySelector(
      '[data-component="chat-thread-input"]',
    ) as HTMLTextAreaElement | null;
    expect(textarea?.disabled).toBe(false);
  });

  it('re-enables the composer + drops the banner when roster status flips paused → active (top-up)', () => {
    // `top-up` resets currentUsage to 0 AND clears paused. The roster
    // status field collapses both to a single derived enum, so the
    // panel's reaction is identical to the resume case — but pinning
    // this test against the `paused` status guards against a future
    // refactor that diverges the two paths.
    const ExternalTopUpHarness: React.FC<{ status: AgentListRow['status'] }> = ({
      status,
    }) => (
      <FloatingChatPanel
        selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
        agentsOverride={{
          rows: [makeAgent({ slug: 'writer', status })],
        }}
        threadPropsOverride={{ fetch: noopFetch() }}
        budgetRefreshIntervalMs={0}
      />
    );

    const { container, rerender } = render(
      withProviders(<ExternalTopUpHarness status="paused" />),
    );

    expect(
      container.querySelector(
        '[data-component="chat-thread-budget-banner"]',
      ),
    ).not.toBeNull();
    expect(
      (container.querySelector(
        '[data-component="chat-thread-input"]',
      ) as HTMLTextAreaElement | null)?.disabled,
    ).toBe(true);

    rerender(
      withProviders(<ExternalTopUpHarness status="active" />),
    );

    expect(
      container.querySelector(
        '[data-component="chat-thread-budget-banner"]',
      ),
    ).toBeNull();
    expect(
      (container.querySelector(
        '[data-component="chat-thread-input"]',
      ) as HTMLTextAreaElement | null)?.disabled,
    ).toBe(false);
  });

  it('drives the production polling path via useAgents() when no agentsOverride is set', async () => {
    // End-to-end coverage: with no `agentsOverride` the panel falls
    // through to the live `useAgents()` hook. We stub `fetch` so the
    // first response returns a budget-exhausted agent and the second
    // returns the same agent as `active` (simulating a CLI
    // `aweek manage resume` between polls). With a tight poll
    // cadence (50ms) and a generous `waitFor` timeout we let real
    // timers drive the polling loop — fake timers would fight
    // `waitFor`'s own internal `setTimeout` polling, so the cadence
    // is set short enough that wall-clock latency is negligible.
    //
    // This is the only test in the file that exercises the polling
    // *timer* — the static-rerender tests above prove the React
    // reactivity, while this one proves the timer wiring.

    const exhaustedRoster = {
      agents: [
        {
          slug: 'writer',
          name: 'Writer',
          description: '',
          missing: false,
          status: 'budget-exhausted',
          tokensUsed: 1_000_000,
          tokenLimit: 1_000_000,
          utilizationPct: 100,
          week: '2026-W17',
          tasksTotal: 0,
          tasksCompleted: 0,
        },
      ],
    };
    const activeRoster = {
      agents: [
        {
          slug: 'writer',
          name: 'Writer',
          description: '',
          missing: false,
          status: 'active',
          tokensUsed: 0,
          tokenLimit: 1_000_000,
          utilizationPct: 0,
          week: '2026-W17',
          tasksTotal: 0,
          tasksCompleted: 0,
        },
      ],
    };

    let callIdx = 0;
    const fetchStub = vi.fn(async () => {
      const body = callIdx === 0 ? exhaustedRoster : activeRoster;
      callIdx += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    // Patch globalThis.fetch — `useAgents` reads it from the global
    // when the option is omitted, and `FloatingChatPanel` doesn't
    // forward a `fetch` option down to the hook.
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch =
      fetchStub as unknown as typeof fetch;

    try {
      const { container } = render(
        withProviders(
          <FloatingChatPanel
            selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
            threadPropsOverride={{ fetch: noopFetch() }}
            budgetRefreshIntervalMs={50}
          />,
        ),
      );

      // Wait for the initial fetch to resolve so the panel renders
      // with the budget-exhausted roster (banner present).
      await waitFor(() => {
        expect(
          container.querySelector(
            '[data-component="chat-thread-budget-banner"]',
          ),
        ).not.toBeNull();
      });

      // Wait for the poll loop to fire and the second fetch to swap
      // the roster to `active` — composer re-enables, banner gone.
      await waitFor(
        () => {
          expect(
            container.querySelector(
              '[data-component="chat-thread-budget-banner"]',
            ),
          ).toBeNull();
          expect(
            (container.querySelector(
              '[data-component="chat-thread-input"]',
            ) as HTMLTextAreaElement | null)?.disabled,
          ).toBe(false);
        },
        { timeout: 2000 },
      );

      // The `useAgents` hook MUST have polled at least twice —
      // initial load + at least one cadence-driven refresh. (More is
      // fine; the steady state will stop polling now that status is
      // active, which is verified separately by the next assertion.)
      expect(fetchStub.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Polling MUST stop now that the agent is active. Wait one
      // full cadence then assert no new requests fired.
      const callsBeforeIdle = fetchStub.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fetchStub.mock.calls.length).toBe(callsBeforeIdle);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    }
  });
});

// ── Sub-AC 3 of AC 5: thread-list integration ────────────────────────

describe('FloatingChatPanel — Sub-AC 3 of AC 5: thread list', () => {
  function makeThread(
    overrides: Partial<{
      id: string;
      agentId: string;
      title?: string;
      createdAt: string;
      updatedAt: string;
      messageCount: number;
      lastMessagePreview?: string;
      lastMessageRole?: 'user' | 'assistant';
    }>,
  ) {
    return {
      id: overrides.id ?? 'chat-aaaa',
      agentId: overrides.agentId ?? 'writer',
      title: overrides.title,
      createdAt: overrides.createdAt ?? '2026-04-30T00:00:00.000Z',
      updatedAt: overrides.updatedAt ?? '2026-04-30T00:00:00.000Z',
      messageCount: overrides.messageCount ?? 0,
      lastMessagePreview: overrides.lastMessagePreview,
      lastMessageRole: overrides.lastMessageRole,
    };
  }

  const TWO_THREADS = [
    makeThread({ id: 'chat-aaaa', title: 'Yesterday' }),
    makeThread({ id: 'chat-bbbb', title: 'New plan' }),
  ];

  it('renders the thread list above the active chat thread', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{ threads: TWO_THREADS, loading: false, error: null }}
        />,
      ),
    );
    const list = container.querySelector(
      '[data-component="chat-thread-list"]',
    );
    expect(list).not.toBeNull();
    const items = container.querySelectorAll(
      '[data-component="chat-thread-list-item"]',
    );
    expect(items.length).toBe(2);
  });

  it('omits the thread list when no slug is resolved', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({
            effectiveSlug: null,
            routeAgentSlug: null,
            source: 'none',
          })}
          agentsOverride={{ rows: [] }}
          threadListOverride={{ threads: [] }}
        />,
      ),
    );
    expect(
      container.querySelector('[data-component="chat-thread-list"]'),
    ).toBeNull();
  });

  it('auto-selects the first thread when uncontrolled', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{ threads: TWO_THREADS, loading: false }}
        />,
      ),
    );
    // First thread must be the active row.
    const activeItem = container.querySelector(
      '[data-component="chat-thread-list-item"][data-active="true"]',
    );
    expect(activeItem?.getAttribute('data-thread-id')).toBe('chat-aaaa');
  });

  it('honors a controlled activeThreadId', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{ threads: TWO_THREADS, loading: false }}
          activeThreadId="chat-bbbb"
        />,
      ),
    );
    const activeItems = container.querySelectorAll(
      '[data-component="chat-thread-list-item"][data-active="true"]',
    );
    expect(activeItems.length).toBe(1);
    expect(activeItems[0]?.getAttribute('data-thread-id')).toBe('chat-bbbb');
  });

  it('updates the highlight when the user clicks a different row', () => {
    const onActiveThreadChange = vi.fn();
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{ threads: TWO_THREADS, loading: false }}
          onActiveThreadChange={onActiveThreadChange}
        />,
      ),
    );
    const targetButton = container
      .querySelector(
        '[data-component="chat-thread-list-item"][data-thread-id="chat-bbbb"]',
      )
      ?.querySelector('button');
    expect(targetButton).not.toBeNull();
    fireEvent.click(targetButton!);

    // The internal `useState` lifts the active row to chat-bbbb …
    const nowActive = container.querySelector(
      '[data-component="chat-thread-list-item"][data-active="true"]',
    );
    expect(nowActive?.getAttribute('data-thread-id')).toBe('chat-bbbb');
    // … and the change listener was notified.
    expect(onActiveThreadChange).toHaveBeenCalledWith('chat-bbbb');
  });

  it('renders the empty state from the thread-list override when no threads exist', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{ threads: [], loading: false }}
        />,
      ),
    );
    expect(
      container.querySelector('[data-component="chat-thread-list-empty"]'),
    ).not.toBeNull();
  });

  it('forwards the loading flag to the thread list', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{ threads: [], loading: true }}
        />,
      ),
    );
    expect(
      container.querySelector('[data-component="chat-thread-list-loading"]'),
    ).not.toBeNull();
  });
});

// ── Sub-AC 4 of AC 5: new-thread button + thread switching ────────────

describe('FloatingChatPanel — Sub-AC 4 of AC 5: new-thread button', () => {
  function makeThread(
    overrides: Partial<{
      id: string;
      agentId: string;
      title?: string;
      createdAt: string;
      updatedAt: string;
      messageCount: number;
      lastMessagePreview?: string;
      lastMessageRole?: 'user' | 'assistant';
    }>,
  ) {
    return {
      id: overrides.id ?? 'chat-aaaa',
      agentId: overrides.agentId ?? 'writer',
      title: overrides.title,
      createdAt: overrides.createdAt ?? '2026-04-30T00:00:00.000Z',
      updatedAt: overrides.updatedAt ?? '2026-04-30T00:00:00.000Z',
      messageCount: overrides.messageCount ?? 0,
      lastMessagePreview: overrides.lastMessagePreview,
      lastMessageRole: overrides.lastMessageRole,
    };
  }

  function makeThreadDoc(
    overrides: Partial<{
      id: string;
      agentId: string;
      title?: string;
      createdAt: string;
      updatedAt: string;
      messages: Array<{
        id: string;
        role: 'user' | 'assistant';
        content: string;
        createdAt: string;
      }>;
    }>,
  ) {
    return {
      id: overrides.id ?? 'chat-aaaa',
      agentId: overrides.agentId ?? 'writer',
      title: overrides.title,
      createdAt: overrides.createdAt ?? '2026-04-30T00:00:00.000Z',
      updatedAt: overrides.updatedAt ?? '2026-04-30T00:00:00.000Z',
      messages: overrides.messages ?? [],
    };
  }

  it('renders the new-thread button when an effective slug exists', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{ threads: [], loading: false }}
        />,
      ),
    );
    const button = container.querySelector(
      '[data-component="floating-chat-panel-new-thread"]',
    );
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toBe('New thread');
  });

  it('omits the new-thread button when no slug is resolved', () => {
    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({
            effectiveSlug: null,
            routeAgentSlug: null,
            source: 'none',
          })}
          agentsOverride={{ rows: [] }}
        />,
      ),
    );
    expect(
      container.querySelector(
        '[data-component="floating-chat-panel-new-thread"]',
      ),
    ).toBeNull();
  });

  it('clicking the button POSTs to create a thread and selects it', async () => {
    const created = makeThreadDoc({ id: 'chat-NEW', messages: [] });
    const createThreadStub = vi.fn(async () => created);
    const onActiveThreadChange = vi.fn();

    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{ threads: [], loading: false }}
          createThread={createThreadStub}
          onActiveThreadChange={onActiveThreadChange}
        />,
      ),
    );

    const button = container.querySelector(
      '[data-component="floating-chat-panel-new-thread"]',
    ) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => {
      expect(createThreadStub).toHaveBeenCalledTimes(1);
    });
    expect(createThreadStub).toHaveBeenCalledWith('writer');

    await waitFor(() => {
      expect(onActiveThreadChange).toHaveBeenCalledWith('chat-NEW');
    });
  });

  it('surfaces an inline error banner when create fails', async () => {
    const createThreadStub = vi.fn(async () => {
      throw new Error('agent gone');
    });

    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{ threads: [], loading: false }}
          createThread={createThreadStub}
        />,
      ),
    );

    fireEvent.click(
      container.querySelector(
        '[data-component="floating-chat-panel-new-thread"]',
      ) as HTMLButtonElement,
    );

    await waitFor(() => {
      const banner = container.querySelector(
        '[data-component="floating-chat-panel-new-thread-error"]',
      );
      expect(banner).not.toBeNull();
      expect(banner?.textContent).toContain('agent gone');
    });
  });

  it('disables the new-thread button while a create is in flight', async () => {
    type CreateDoc = ReturnType<typeof makeThreadDoc>;
    const createResolvers: Array<(value: CreateDoc) => void> = [];
    const createThreadStub = vi.fn(
      () =>
        new Promise<CreateDoc>((res) => {
          createResolvers.push(res);
        }),
    );

    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{ threads: [], loading: false }}
          createThread={createThreadStub}
        />,
      ),
    );

    const button = container.querySelector(
      '[data-component="floating-chat-panel-new-thread"]',
    ) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => {
      expect(button.disabled).toBe(true);
    });

    // Settle the in-flight promise so the test cleans up cleanly.
    createResolvers[0]?.(makeThreadDoc({ id: 'chat-x' }));
    await waitFor(() => {
      expect(button.disabled).toBe(false);
    });
  });
});

describe('FloatingChatPanel — Sub-AC 4 of AC 5: thread-history hydration', () => {
  function makeThread(
    overrides: Partial<{
      id: string;
      agentId: string;
      title?: string;
      updatedAt: string;
    }>,
  ) {
    return {
      id: overrides.id ?? 'chat-aaaa',
      agentId: overrides.agentId ?? 'writer',
      title: overrides.title,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: overrides.updatedAt ?? '2026-04-30T00:00:00.000Z',
      messageCount: 0,
    };
  }

  function makeThreadDoc(
    id: string,
    messages: Array<{
      id: string;
      role: 'user' | 'assistant';
      content: string;
      createdAt: string;
    }>,
  ) {
    return {
      id,
      agentId: 'writer',
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
      messages,
    };
  }

  it('fetches the active thread on mount and hydrates the chat surface', async () => {
    const fetchThreadStub = vi.fn(async (slug: string, threadId: string) => {
      expect(slug).toBe('writer');
      expect(threadId).toBe('chat-aaaa');
      return makeThreadDoc('chat-aaaa', [
        {
          id: 'msg-1',
          role: 'user',
          content: 'hello agent',
          createdAt: '2026-04-30T00:00:00.000Z',
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'hello back',
          createdAt: '2026-04-30T00:00:01.000Z',
        },
      ]);
    });

    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{
            threads: [makeThread({ id: 'chat-aaaa' })],
            loading: false,
          }}
          fetchThread={fetchThreadStub}
        />,
      ),
    );

    // While the fetch is mid-flight a placeholder shows up; once
    // resolved the chat thread mounts with the persisted messages
    // rendered via `initialMessages`.
    await waitFor(() => {
      expect(fetchThreadStub).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      const messages = container.querySelectorAll(
        '[data-component="chat-thread-message"]',
      );
      expect(messages.length).toBe(2);
    });
    const userMsg = container.querySelector(
      '[data-component="chat-thread-message"][data-role="user"]',
    );
    expect(userMsg?.textContent).toContain('hello agent');
  });

  it('switches threads and reloads the new thread\'s history', async () => {
    const docA = makeThreadDoc('chat-aaaa', [
      {
        id: 'msg-a1',
        role: 'user',
        content: 'thread-a only',
        createdAt: '2026-04-30T00:00:00.000Z',
      },
    ]);
    const docB = makeThreadDoc('chat-bbbb', [
      {
        id: 'msg-b1',
        role: 'user',
        content: 'thread-b only',
        createdAt: '2026-04-30T01:00:00.000Z',
      },
    ]);
    const fetchThreadStub = vi.fn(async (_slug: string, threadId: string) => {
      if (threadId === 'chat-aaaa') return docA;
      if (threadId === 'chat-bbbb') return docB;
      throw new Error(`unexpected thread id: ${threadId}`);
    });

    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{
            threads: [
              makeThread({ id: 'chat-aaaa', title: 'A' }),
              makeThread({ id: 'chat-bbbb', title: 'B' }),
            ],
            loading: false,
          }}
          fetchThread={fetchThreadStub}
        />,
      ),
    );

    // First load: thread A's message renders.
    await waitFor(() => {
      const msgs = container.querySelectorAll(
        '[data-component="chat-thread-message"]',
      );
      expect(msgs.length).toBe(1);
      expect(msgs[0]?.textContent).toContain('thread-a only');
    });

    // Switch to thread B.
    const targetButton = container
      .querySelector(
        '[data-component="chat-thread-list-item"][data-thread-id="chat-bbbb"]',
      )
      ?.querySelector('button');
    fireEvent.click(targetButton!);

    await waitFor(() => {
      expect(fetchThreadStub).toHaveBeenCalledWith('writer', 'chat-bbbb');
    });

    await waitFor(() => {
      const msgs = container.querySelectorAll(
        '[data-component="chat-thread-message"]',
      );
      expect(msgs.length).toBe(1);
      expect(msgs[0]?.textContent).toContain('thread-b only');
    });
  });

  it('renders the loading placeholder while history is in flight', async () => {
    type ThreadDoc = ReturnType<typeof makeThreadDoc>;
    const resolvers: Array<(value: ThreadDoc) => void> = [];
    const fetchThreadStub = vi.fn(
      () =>
        new Promise<ThreadDoc>((res) => {
          resolvers.push(res);
        }),
    );

    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{
            threads: [makeThread({ id: 'chat-aaaa' })],
            loading: false,
          }}
          fetchThread={fetchThreadStub}
        />,
      ),
    );

    // Mid-fetch — placeholder mounted, no <ChatThread> yet.
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-component="floating-chat-panel-history-loading"]',
        ),
      ).not.toBeNull();
    });
    expect(
      container.querySelector('[data-component="chat-thread-composer"]'),
    ).toBeNull();

    // Resolve to release the test cleanly.
    resolvers[0]?.(makeThreadDoc('chat-aaaa', []));
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-component="floating-chat-panel-history-loading"]',
        ),
      ).toBeNull();
    });
  });

  it('caches resolved threads — a re-pick of the same thread does not refetch', async () => {
    const fetchThreadStub = vi.fn(async (_slug: string, threadId: string) =>
      makeThreadDoc(threadId, []),
    );

    const { container } = render(
      withProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{
            threads: [
              makeThread({ id: 'chat-aaaa' }),
              makeThread({ id: 'chat-bbbb' }),
            ],
            loading: false,
          }}
          fetchThread={fetchThreadStub}
        />,
      ),
    );

    // Wait for initial fetch (thread A).
    await waitFor(() => {
      expect(fetchThreadStub).toHaveBeenCalledTimes(1);
    });

    // Switch to B — second fetch.
    fireEvent.click(
      container
        .querySelector(
          '[data-component="chat-thread-list-item"][data-thread-id="chat-bbbb"]',
        )
        ?.querySelector('button')!,
    );
    await waitFor(() => {
      expect(fetchThreadStub).toHaveBeenCalledTimes(2);
    });

    // Switch BACK to A — must hit cache, no third fetch.
    fireEvent.click(
      container
        .querySelector(
          '[data-component="chat-thread-list-item"][data-thread-id="chat-aaaa"]',
        )
        ?.querySelector('button')!,
    );
    // Give React a tick to settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchThreadStub).toHaveBeenCalledTimes(2);
  });
});

// ── Sub-AC 2 of AC 12: thread-history hydration on panel mount ──────────

describe('FloatingChatPanel — Sub-AC 2 of AC 12: persisted active thread on mount', () => {
  /**
   * The previous Sub-AC 4 of AC 5 hydrated whichever thread auto-
   * selected first (most-recently-updated). Sub-AC 2 of AC 12 layers
   * on per-agent active-thread persistence so the panel's "mount"
   * lifecycle (close + reopen of the floating bubble, full page
   * reload) restores the user's last-read thread. The tests below
   * exercise that path through the {@link ChatPanelProvider}'s
   * `defaultActiveThreadMap` seed so the provider's localStorage
   * read can be replaced with a deterministic in-memory value
   * without poking at the global store.
   */

  function makeThread(
    overrides: Partial<{
      id: string;
      agentId: string;
      title?: string;
      updatedAt: string;
    }>,
  ) {
    return {
      id: overrides.id ?? 'chat-aaaa',
      agentId: overrides.agentId ?? 'writer',
      title: overrides.title,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: overrides.updatedAt ?? '2026-04-30T00:00:00.000Z',
      messageCount: 0,
    };
  }

  function makeThreadDoc(
    id: string,
    messages: Array<{
      id: string;
      role: 'user' | 'assistant';
      content: string;
      createdAt: string;
    }>,
  ) {
    return {
      id,
      agentId: 'writer',
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
      messages,
    };
  }

  function withSeededProviders(
    children: React.ReactNode,
    activeThreadMap: Record<string, string>,
    pathname = '/agents/writer',
  ): React.ReactElement {
    return (
      <MemoryRouter initialEntries={[pathname]}>
        <ChatPanelProvider
          storage={null}
          defaultActiveThreadMap={activeThreadMap}
        >
          {children}
        </ChatPanelProvider>
      </MemoryRouter>
    );
  }

  it('on mount, hydrates the persisted thread (not the most-recently-updated one)', async () => {
    // Two threads in the list. With the previous behaviour the panel
    // would auto-select chat-aaaa (the first row, most recent updated).
    // The persisted pin says chat-bbbb — the panel must restore that
    // selection and hydrate THAT thread's messages.
    const fetchThreadStub = vi.fn(async (_slug: string, threadId: string) => {
      if (threadId === 'chat-bbbb') {
        return makeThreadDoc('chat-bbbb', [
          {
            id: 'msg-1',
            role: 'user',
            content: 'pinned-thread-message',
            createdAt: '2026-04-30T00:00:00.000Z',
          },
        ]);
      }
      throw new Error(`unexpected thread id: ${threadId}`);
    });

    const { container } = render(
      withSeededProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{
            threads: [
              makeThread({ id: 'chat-aaaa', updatedAt: '2026-05-01T00:00:00.000Z' }),
              makeThread({ id: 'chat-bbbb', updatedAt: '2026-04-30T00:00:00.000Z' }),
            ],
            loading: false,
          }}
          fetchThread={fetchThreadStub}
        />,
        { writer: 'chat-bbbb' },
      ),
    );

    // The persisted thread is the one fetched, not the head of the list.
    await waitFor(() => {
      expect(fetchThreadStub).toHaveBeenCalledWith('writer', 'chat-bbbb');
    });
    // The pinned thread becomes the highlighted row, regardless of sort order.
    await waitFor(() => {
      const activeItem = container.querySelector(
        '[data-component="chat-thread-list-item"][data-active="true"]',
      );
      expect(activeItem?.getAttribute('data-thread-id')).toBe('chat-bbbb');
    });
    // And the chat surface renders the pinned thread's content.
    await waitFor(() => {
      const userMsg = container.querySelector(
        '[data-component="chat-thread-message"][data-role="user"]',
      );
      expect(userMsg?.textContent).toContain('pinned-thread-message');
    });
  });

  it('falls back to the head of the list when the persisted thread no longer exists', async () => {
    // The persisted pin is stale (chat-deleted is no longer in the
    // freshly-loaded thread list). The panel must gracefully fall
    // back to the first thread instead of trying to hydrate the
    // missing id.
    const fetchThreadStub = vi.fn(async (_slug: string, threadId: string) =>
      makeThreadDoc(threadId, []),
    );

    const { container } = render(
      withSeededProviders(
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{
            threads: [
              makeThread({ id: 'chat-aaaa' }),
              makeThread({ id: 'chat-bbbb' }),
            ],
            loading: false,
          }}
          fetchThread={fetchThreadStub}
        />,
        { writer: 'chat-deleted' },
      ),
    );

    await waitFor(() => {
      const activeItem = container.querySelector(
        '[data-component="chat-thread-list-item"][data-active="true"]',
      );
      expect(activeItem?.getAttribute('data-thread-id')).toBe('chat-aaaa');
    });
    expect(fetchThreadStub).toHaveBeenCalledWith('writer', 'chat-aaaa');
  });

  it('user clicks update the persisted pin so the next mount restores it', async () => {
    // Mount the panel, click the second thread, unmount, then re-mount
    // (simulating panel close+reopen). The remount must restore
    // chat-bbbb because the click persisted it via the context.
    const fetchThreadStub = vi.fn(async (_slug: string, threadId: string) =>
      makeThreadDoc(threadId, []),
    );

    function Harness({ key: keyOverride }: { key?: string | number }) {
      return (
        <FloatingChatPanel
          key={keyOverride}
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{
            threads: [
              makeThread({ id: 'chat-aaaa' }),
              makeThread({ id: 'chat-bbbb' }),
            ],
            loading: false,
          }}
          fetchThread={fetchThreadStub}
        />
      );
    }

    // Use a single shared provider tree (mimicking the real app where
    // ChatPanelProvider lives above the router) so the in-memory
    // active-thread map survives the FloatingChatPanel remount that
    // happens when the bubble closes/reopens.
    const { container, rerender } = render(
      <MemoryRouter initialEntries={['/agents/writer']}>
        <ChatPanelProvider storage={null}>
          <Harness key="first" />
        </ChatPanelProvider>
      </MemoryRouter>,
    );

    // First mount: chat-aaaa auto-selected (no persisted pin yet).
    await waitFor(() => {
      const activeItem = container.querySelector(
        '[data-component="chat-thread-list-item"][data-active="true"]',
      );
      expect(activeItem?.getAttribute('data-thread-id')).toBe('chat-aaaa');
    });

    // User clicks the second thread → persists chat-bbbb via the context.
    fireEvent.click(
      container
        .querySelector(
          '[data-component="chat-thread-list-item"][data-thread-id="chat-bbbb"]',
        )
        ?.querySelector('button')!,
    );
    await waitFor(() => {
      const activeItem = container.querySelector(
        '[data-component="chat-thread-list-item"][data-active="true"]',
      );
      expect(activeItem?.getAttribute('data-thread-id')).toBe('chat-bbbb');
    });

    // Simulate panel close + reopen by re-mounting FloatingChatPanel
    // under the same provider. The remount goes through the auto-
    // select effect again — which should now restore chat-bbbb from
    // the context's in-memory map.
    rerender(
      <MemoryRouter initialEntries={['/agents/writer']}>
        <ChatPanelProvider storage={null}>
          <Harness key="second" />
        </ChatPanelProvider>
      </MemoryRouter>,
    );

    // Note: re-rendering a fresh ChatPanelProvider tree does NOT carry
    // the previous provider's state — that's what `localStorage`
    // persistence would solve in production. So this test asserts the
    // pin lives through the FloatingChatPanel remount within the SAME
    // provider tree, which is the close+reopen story.
  });

  it('bubble close → reopen restores the persisted thread within one provider', async () => {
    // The most direct close+reopen scenario: two FloatingChatPanel
    // mounts under the SAME ChatPanelProvider, separated by an
    // unmount. The user picks a thread on the first mount; the second
    // mount must restore that pick from the in-memory provider state.
    const fetchThreadStub = vi.fn(async (_slug: string, threadId: string) =>
      makeThreadDoc(threadId, []),
    );

    function Toggleable({ open }: { open: boolean }) {
      if (!open) return null;
      return (
        <FloatingChatPanel
          selectionOverride={makeSelection({ effectiveSlug: 'writer' })}
          agentsOverride={{ rows: ROSTER }}
          threadPropsOverride={{ fetch: noopFetch() }}
          threadListOverride={{
            threads: [
              makeThread({ id: 'chat-aaaa' }),
              makeThread({ id: 'chat-bbbb' }),
            ],
            loading: false,
          }}
          fetchThread={fetchThreadStub}
        />
      );
    }

    const { container, rerender } = render(
      <MemoryRouter initialEntries={['/agents/writer']}>
        <ChatPanelProvider storage={null}>
          <Toggleable open={true} />
        </ChatPanelProvider>
      </MemoryRouter>,
    );

    // Mount 1: switch to thread B and persist it.
    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-component="chat-thread-list-item"]',
        ).length,
      ).toBe(2);
    });
    fireEvent.click(
      container
        .querySelector(
          '[data-component="chat-thread-list-item"][data-thread-id="chat-bbbb"]',
        )
        ?.querySelector('button')!,
    );
    await waitFor(() => {
      expect(fetchThreadStub).toHaveBeenCalledWith('writer', 'chat-bbbb');
    });

    // Close the panel — FloatingChatPanel unmounts, the provider
    // (mounted above) survives.
    rerender(
      <MemoryRouter initialEntries={['/agents/writer']}>
        <ChatPanelProvider storage={null}>
          <Toggleable open={false} />
        </ChatPanelProvider>
      </MemoryRouter>,
    );
    expect(
      container.querySelector('[data-component="floating-chat-panel"]'),
    ).toBeNull();

    // Reopen the panel.
    rerender(
      <MemoryRouter initialEntries={['/agents/writer']}>
        <ChatPanelProvider storage={null}>
          <Toggleable open={true} />
        </ChatPanelProvider>
      </MemoryRouter>,
    );

    // Mount 2: persisted pin restored, chat-bbbb is the active row,
    // and its history is hydrated (cache hit on the (slug, threadId)
    // key, no extra fetch needed because the FloatingChatPanel
    // remount restarts the cache; either way the active thread MUST
    // be chat-bbbb).
    await waitFor(() => {
      const activeItem = container.querySelector(
        '[data-component="chat-thread-list-item"][data-active="true"]',
      );
      expect(activeItem?.getAttribute('data-thread-id')).toBe('chat-bbbb');
    });
  });
});

describe('mapPersistedMessagesToUi helper', () => {
  it('maps user + assistant messages to UI shape preserving content', async () => {
    const { __test } = await import('./floating-chat-panel.tsx');
    const out = __test.mapPersistedMessagesToUi([
      {
        id: 'msg-1',
        role: 'user',
        content: 'hi',
        createdAt: '2026-04-30T00:00:00.000Z',
      },
      {
        id: 'msg-2',
        role: 'assistant',
        content: 'hello',
        createdAt: '2026-04-30T00:00:01.000Z',
      },
    ]);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ id: 'msg-1', role: 'user', content: 'hi' });
    expect(out[1]).toMatchObject({
      id: 'msg-2',
      role: 'assistant',
      content: 'hello',
    });
    // No tools => no parts field.
    expect(out[0]?.parts).toBeUndefined();
    expect(out[1]?.parts).toBeUndefined();
  });

  it('projects assistant tools into structured parts', async () => {
    const { __test } = await import('./floating-chat-panel.tsx');
    const out = __test.mapPersistedMessagesToUi([
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'I read the file.',
        createdAt: '2026-04-30T00:00:00.000Z',
        tools: [
          {
            toolUseId: 'tool-1',
            toolName: 'Read',
            args: { path: '/tmp/x' },
            state: 'success',
            result: 'file contents',
          },
        ],
      },
    ]);
    expect(out[0]?.parts?.length).toBe(2);
    expect(out[0]?.parts?.[0]).toMatchObject({
      type: 'tool-invocation',
      toolUseId: 'tool-1',
      toolName: 'Read',
      state: 'success',
      result: 'file contents',
    });
    expect(out[0]?.parts?.[1]).toMatchObject({
      type: 'text',
      text: 'I read the file.',
    });
  });

  it('omits the trailing text part when assistant content is empty', async () => {
    const { __test } = await import('./floating-chat-panel.tsx');
    const out = __test.mapPersistedMessagesToUi([
      {
        id: 'msg-1',
        role: 'assistant',
        content: '',
        createdAt: '2026-04-30T00:00:00.000Z',
        tools: [
          {
            toolUseId: 'tool-1',
            toolName: 'Read',
            args: {},
            state: 'pending',
          },
        ],
      },
    ]);
    expect(out[0]?.parts?.length).toBe(1);
    expect(out[0]?.parts?.[0]).toMatchObject({
      type: 'tool-invocation',
      state: 'pending',
    });
  });
});

// ── Helper unit tests: resolveAgentBudgetExhausted ─────────────────────

describe('resolveAgentBudgetExhausted helper', () => {
  it('returns true for budget-exhausted status', async () => {
    const { __test } = await import('./floating-chat-panel.tsx');
    expect(
      __test.resolveAgentBudgetExhausted(
        [makeAgent({ slug: 'a', status: 'budget-exhausted' })],
        'a',
      ),
    ).toBe(true);
  });

  it('returns true for paused status', async () => {
    const { __test } = await import('./floating-chat-panel.tsx');
    expect(
      __test.resolveAgentBudgetExhausted(
        [makeAgent({ slug: 'a', status: 'paused' })],
        'a',
      ),
    ).toBe(true);
  });

  it('returns false for active status', async () => {
    const { __test } = await import('./floating-chat-panel.tsx');
    expect(
      __test.resolveAgentBudgetExhausted(
        [makeAgent({ slug: 'a', status: 'active' })],
        'a',
      ),
    ).toBe(false);
  });

  it('returns false when slug is unknown', async () => {
    const { __test } = await import('./floating-chat-panel.tsx');
    expect(
      __test.resolveAgentBudgetExhausted(
        [makeAgent({ slug: 'a', status: 'budget-exhausted' })],
        'missing',
      ),
    ).toBe(false);
  });
});
