/**
 * Tests for `./chat-panel.tsx` — the composable chat-surface container
 * shipped in Sub-AC 2 of the chat-panel feature (AC 9).
 *
 * Contract pinned by these tests:
 *   1. The panel is unmounted (returns null) until the first time
 *      `open` flips to `true`. There's no hidden DOM node before then.
 *   2. After `open` flips to `true` the panel mounts in the visually
 *      `closed` state (`data-state="closed"`) and transitions to
 *      `"open"` on the next event-loop tick — that's what drives the
 *      CSS open animation.
 *   3. After `open` flips back to `false` the panel transitions to
 *      `"closed"` immediately, then unmounts after the configured
 *      `animationDuration` so React doesn't rip the element out
 *      mid-transition.
 *   4. `animationDuration={0}` short-circuits both phases — mount is
 *      synchronous and visually `"open"`, unmount is synchronous.
 *   5. The composable subcomponents (`ChatPanelHeader`,
 *      `ChatPanelBody`, `ChatPanelFooter`) carry the canonical
 *      `data-component` markers and render the children passed to
 *      them.
 *   6. The panel surfaces the `aria-label`, `role="dialog"`, and
 *      `data-mobile` attributes the floating-bubble sub-ACs depend on
 *      for downstream wiring.
 *   7. The `isMobile` flag swaps the panel sizing between desktop and
 *      mobile-aware classes so the panel respects the < 768px
 *      breakpoint policy.
 *
 * Vitest + jsdom + Testing Library (config: vitest.config.js +
 * vitest.setup.js).
 */

import * as React from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import {
  CHAT_PANEL_ANIMATION_MS,
  ChatPanel,
  ChatPanelBody,
  ChatPanelFooter,
  ChatPanelHeader,
} from './chat-panel.tsx';

afterEach(() => {
  cleanup();
});

// ── Mount lifecycle ───────────────────────────────────────────────────

describe('ChatPanel — mount lifecycle', () => {
  it('does not mount any DOM node when open=false from the start', () => {
    const { container } = render(
      <ChatPanel open={false}>
        <ChatPanelBody>body</ChatPanelBody>
      </ChatPanel>,
    );
    expect(container.querySelector('[data-component="chat-panel"]')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('mounts the panel when open=true and transitions to the open state', async () => {
    const { container } = render(
      <ChatPanel open animationDuration={20}>
        <ChatPanelBody>body</ChatPanelBody>
      </ChatPanel>,
    );

    const panel = container.querySelector('[data-component="chat-panel"]');
    expect(panel).not.toBeNull();
    // First render lands with the closed visual state so CSS can
    // animate from the closed-state defaults to the open values.
    expect(panel).toHaveAttribute('data-state', 'closed');

    await waitFor(() => {
      expect(panel).toHaveAttribute('data-state', 'open');
    });
  });

  it('renders role="dialog" and the supplied aria-label', async () => {
    render(
      <ChatPanel open animationDuration={0} ariaLabel="writer chat">
        <ChatPanelBody>body</ChatPanelBody>
      </ChatPanel>,
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-label', 'writer chat');
  });

  it('falls back to the default aria-label when none is supplied', async () => {
    render(
      <ChatPanel open animationDuration={0}>
        <ChatPanelBody>body</ChatPanelBody>
      </ChatPanel>,
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-label', 'Chat panel');
  });
});

// ── Open / close animation ────────────────────────────────────────────

describe('ChatPanel — open / close animation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    // Drain any pending timers before swapping back to real timers so
    // a test that didn't advance the close-out doesn't bleed React
    // state-updates into the next case.
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  it('keeps the panel mounted during the close-out animation, then unmounts', () => {
    const { container, rerender } = render(
      <ChatPanel open animationDuration={CHAT_PANEL_ANIMATION_MS}>
        <ChatPanelBody>body</ChatPanelBody>
      </ChatPanel>,
    );

    // Advance past the appear timer so the panel sits in the open state.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    let panel = container.querySelector('[data-component="chat-panel"]');
    expect(panel).toHaveAttribute('data-state', 'open');

    // Flip to closed — the panel should stay mounted but flip visual state.
    rerender(
      <ChatPanel open={false} animationDuration={CHAT_PANEL_ANIMATION_MS}>
        <ChatPanelBody>body</ChatPanelBody>
      </ChatPanel>,
    );
    panel = container.querySelector('[data-component="chat-panel"]');
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('data-state', 'closed');

    // Run the close-out timer to completion — the panel should unmount.
    act(() => {
      vi.advanceTimersByTime(CHAT_PANEL_ANIMATION_MS);
    });
    expect(
      container.querySelector('[data-component="chat-panel"]'),
    ).toBeNull();
  });

  it('writes the animationDuration into the inline transitionDuration style', () => {
    const { container } = render(
      <ChatPanel open animationDuration={350}>
        <ChatPanelBody>body</ChatPanelBody>
      </ChatPanel>,
    );

    act(() => {
      vi.advanceTimersByTime(1);
    });

    const panel = container.querySelector(
      '[data-component="chat-panel"]',
    ) as HTMLElement | null;
    expect(panel).not.toBeNull();
    expect(panel!.style.transitionDuration).toBe('350ms');
  });

  it('short-circuits both mount + unmount when animationDuration=0', () => {
    const { container, rerender } = render(
      <ChatPanel open animationDuration={0}>
        <ChatPanelBody>body</ChatPanelBody>
      </ChatPanel>,
    );

    // No need to advance timers — synchronous mount in the open state.
    const panel = container.querySelector('[data-component="chat-panel"]');
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('data-state', 'open');

    // Close synchronously.
    rerender(
      <ChatPanel open={false} animationDuration={0}>
        <ChatPanelBody>body</ChatPanelBody>
      </ChatPanel>,
    );
    expect(
      container.querySelector('[data-component="chat-panel"]'),
    ).toBeNull();
  });
});

// ── Region composition ────────────────────────────────────────────────

describe('ChatPanel — region composition', () => {
  it('renders header, body, and footer regions in document order', async () => {
    const { container } = render(
      <ChatPanel open animationDuration={0}>
        <ChatPanelHeader>
          <span data-testid="header-slot">header</span>
        </ChatPanelHeader>
        <ChatPanelBody>
          <span data-testid="body-slot">body</span>
        </ChatPanelBody>
        <ChatPanelFooter>
          <span data-testid="footer-slot">footer</span>
        </ChatPanelFooter>
      </ChatPanel>,
    );

    expect(screen.getByTestId('header-slot')).toBeInTheDocument();
    expect(screen.getByTestId('body-slot')).toBeInTheDocument();
    expect(screen.getByTestId('footer-slot')).toBeInTheDocument();

    const header = container.querySelector(
      '[data-component="chat-panel-header"]',
    );
    const body = container.querySelector(
      '[data-component="chat-panel-body"]',
    );
    const footer = container.querySelector(
      '[data-component="chat-panel-footer"]',
    );

    expect(header).not.toBeNull();
    expect(body).not.toBeNull();
    expect(footer).not.toBeNull();

    // Document order: header before body before footer.
    expect(header!.compareDocumentPosition(body!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(body!.compareDocumentPosition(footer!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('uses semantic header/footer elements for the title and action regions', async () => {
    const { container } = render(
      <ChatPanel open animationDuration={0}>
        <ChatPanelHeader>head</ChatPanelHeader>
        <ChatPanelBody>body</ChatPanelBody>
        <ChatPanelFooter>foot</ChatPanelFooter>
      </ChatPanel>,
    );

    const header = container.querySelector(
      '[data-component="chat-panel-header"]',
    );
    const footer = container.querySelector(
      '[data-component="chat-panel-footer"]',
    );

    expect(header!.tagName).toBe('HEADER');
    expect(footer!.tagName).toBe('FOOTER');
  });

  it('lets the body region grow while header + footer stay shrink-0', () => {
    const { container } = render(
      <ChatPanel open animationDuration={0}>
        <ChatPanelHeader>head</ChatPanelHeader>
        <ChatPanelBody>body</ChatPanelBody>
        <ChatPanelFooter>foot</ChatPanelFooter>
      </ChatPanel>,
    );

    const header = container.querySelector(
      '[data-component="chat-panel-header"]',
    );
    const body = container.querySelector(
      '[data-component="chat-panel-body"]',
    );
    const footer = container.querySelector(
      '[data-component="chat-panel-footer"]',
    );

    const headerCls = header!.getAttribute('class') ?? '';
    const bodyCls = body!.getAttribute('class') ?? '';
    const footerCls = footer!.getAttribute('class') ?? '';

    expect(headerCls).toContain('shrink-0');
    expect(footerCls).toContain('shrink-0');
    expect(bodyCls).toContain('flex-1');
    expect(bodyCls).toContain('overflow-y-auto');
  });

  it('forwards className overrides on each subcomponent', () => {
    const { container } = render(
      <ChatPanel open animationDuration={0}>
        <ChatPanelHeader className="custom-header-cls">head</ChatPanelHeader>
        <ChatPanelBody className="custom-body-cls">body</ChatPanelBody>
        <ChatPanelFooter className="custom-footer-cls">foot</ChatPanelFooter>
      </ChatPanel>,
    );

    expect(
      container
        .querySelector('[data-component="chat-panel-header"]')!
        .getAttribute('class'),
    ).toContain('custom-header-cls');
    expect(
      container
        .querySelector('[data-component="chat-panel-body"]')!
        .getAttribute('class'),
    ).toContain('custom-body-cls');
    expect(
      container
        .querySelector('[data-component="chat-panel-footer"]')!
        .getAttribute('class'),
    ).toContain('custom-footer-cls');
  });
});

// ── Mobile responsiveness ─────────────────────────────────────────────

describe('ChatPanel — mobile responsiveness', () => {
  it('reflects the isMobile flag via data-mobile and applies mobile sizing', () => {
    const { container } = render(
      <ChatPanel open animationDuration={0} isMobile>
        <ChatPanelBody>body</ChatPanelBody>
      </ChatPanel>,
    );
    const panel = container.querySelector('[data-component="chat-panel"]');
    expect(panel).toHaveAttribute('data-mobile', 'true');
    const cls = panel!.getAttribute('class') ?? '';
    expect(cls).toContain('h-[calc(100svh-6rem)]');
    expect(cls).toContain('w-[calc(100vw-1.5rem)]');
    expect(cls).toContain('max-w-md');
  });

  it('uses desktop sizing when isMobile is omitted', () => {
    const { container } = render(
      <ChatPanel open animationDuration={0}>
        <ChatPanelBody>body</ChatPanelBody>
      </ChatPanel>,
    );
    const panel = container.querySelector('[data-component="chat-panel"]');
    expect(panel).toHaveAttribute('data-mobile', 'false');
    const cls = panel!.getAttribute('class') ?? '';
    expect(cls).toContain('h-[36rem]');
    expect(cls).toContain('w-96');
    expect(cls).toContain('max-h-[calc(100svh-2rem)]');
  });
});

// ── className passthrough ─────────────────────────────────────────────

describe('ChatPanel — className passthrough', () => {
  it('merges caller className onto the panel surface', () => {
    const { container } = render(
      <ChatPanel
        open
        animationDuration={0}
        className="custom-panel-cls border-2"
      >
        <ChatPanelBody>body</ChatPanelBody>
      </ChatPanel>,
    );
    const panel = container.querySelector('[data-component="chat-panel"]');
    const cls = panel!.getAttribute('class') ?? '';
    expect(cls).toContain('custom-panel-cls');
    expect(cls).toContain('border-2');
    // Base surface utilities should still be present.
    expect(cls).toContain('rounded-lg');
    expect(cls).toContain('bg-card');
  });

  it('marks the panel non-interactive while in the closed visual state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      const { container } = render(
        <ChatPanel open animationDuration={CHAT_PANEL_ANIMATION_MS}>
          <ChatPanelBody>body</ChatPanelBody>
        </ChatPanel>,
      );
      // Before the appear timer fires, the panel is mounted in the closed
      // state and should set `pointer-events-none` so it can't intercept
      // clicks intended for other floating chrome (e.g. the bubble it
      // pops out of).
      const panel = container.querySelector('[data-component="chat-panel"]');
      expect(panel).toHaveAttribute('data-state', 'closed');
      expect(panel!.getAttribute('class') ?? '').toContain(
        'pointer-events-none',
      );

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(panel).toHaveAttribute('data-state', 'open');
      expect(panel!.getAttribute('class') ?? '').not.toContain(
        'pointer-events-none',
      );
    } finally {
      act(() => {
        vi.runOnlyPendingTimers();
      });
      vi.useRealTimers();
    }
  });
});
