/**
 * Tests for `./floating-chat-bubble.tsx` — the floating chat trigger
 * shipped in Sub-AC 1 of the chat-panel feature (AC 9).
 *
 * Contract pinned by these tests:
 *   1. Default state is collapsed; the trigger renders as a shadcn
 *      icon `Button` with a `data-component` hook.
 *   2. The trigger sits inside a fixed-position wrapper anchored to
 *      the bottom-right of the viewport.
 *   3. Clicking the trigger expands the panel; the panel renders a
 *      header (with the supplied title), a body slot, and a close
 *      button. Clicking the close button or pressing `Escape`
 *      collapses back to the bubble.
 *   4. The component supports both controlled (`open` + `onOpenChange`)
 *      and uncontrolled (`defaultOpen`) flows, mirroring the shadcn
 *      Dialog convention.
 *   5. The wrapper / trigger / close button mark themselves with
 *      `data-mobile="true|false"` so downstream styles (and these
 *      tests) can verify the mobile responsiveness contract.
 *
 * Vitest + jsdom + Testing Library (config: vitest.config.js +
 * vitest.setup.js).
 */

import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { FloatingChatBubble } from './floating-chat-bubble.tsx';

afterEach(() => {
  cleanup();
});

describe('FloatingChatBubble — collapsed state (default)', () => {
  it('renders as a shadcn icon button by default', () => {
    const { container } = render(<FloatingChatBubble />);

    const wrapper = container.querySelector(
      '[data-component="floating-chat-bubble"]',
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute('data-state', 'closed');

    const trigger = container.querySelector(
      '[data-component="floating-chat-bubble-trigger"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger!.tagName).toBe('BUTTON');
    expect(trigger).toHaveAttribute('data-variant', 'default');
    expect(trigger).toHaveAttribute('data-size', 'icon');
  });

  it('anchors the wrapper to the bottom-right of the viewport', () => {
    const { container } = render(<FloatingChatBubble />);

    const wrapper = container.querySelector(
      '[data-component="floating-chat-bubble"]',
    );
    expect(wrapper).not.toBeNull();
    // The wrapper carries the canonical Tailwind anchor utilities; the
    // test pins the contract by string-matching the className so a
    // refactor that drops the corner anchor surfaces immediately.
    const cls = wrapper!.getAttribute('class') ?? '';
    expect(cls).toContain('fixed');
    expect(cls).toContain('bottom-');
    expect(cls).toContain('right-');
  });

  it('exposes a default aria-label of "Open chat"', () => {
    render(<FloatingChatBubble />);
    const trigger = screen.getByRole('button', { name: /open chat/i });
    expect(trigger).toHaveAttribute('aria-label', 'Open chat');
  });

  it('honours a caller-supplied triggerLabel', () => {
    render(<FloatingChatBubble triggerLabel="Talk to writer" />);
    const trigger = screen.getByRole('button', { name: /talk to writer/i });
    expect(trigger).toHaveAttribute('aria-label', 'Talk to writer');
  });

  it('does not render the panel surface when collapsed', () => {
    const { container } = render(<FloatingChatBubble />);
    expect(
      container.querySelector(
        '[data-component="floating-chat-bubble-panel"]',
      ),
    ).toBeNull();
  });
});

describe('FloatingChatBubble — toggle behaviour (uncontrolled)', () => {
  it('expands into the panel when the trigger is clicked', () => {
    const { container } = render(<FloatingChatBubble />);
    const trigger = screen.getByRole('button', { name: /open chat/i });

    fireEvent.click(trigger);

    const wrapper = container.querySelector(
      '[data-component="floating-chat-bubble"]',
    );
    expect(wrapper).toHaveAttribute('data-state', 'open');

    const panel = container.querySelector(
      '[data-component="floating-chat-bubble-panel"]',
    );
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('role', 'dialog');

    // The collapsed trigger is gone while expanded — the close button
    // is the new toggle surface.
    expect(
      container.querySelector(
        '[data-component="floating-chat-bubble-trigger"]',
      ),
    ).toBeNull();
  });

  it('renders the supplied title in the panel header', () => {
    render(<FloatingChatBubble title="writer" />);
    fireEvent.click(screen.getByRole('button', { name: /open chat/i }));

    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('writer');
  });

  it('falls back to the default title when none is supplied', () => {
    render(<FloatingChatBubble />);
    fireEvent.click(screen.getByRole('button', { name: /open chat/i }));

    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('Chat');
  });

  it('renders children in the panel body slot when provided', () => {
    render(
      <FloatingChatBubble>
        <div data-testid="chat-body-slot">thread surface</div>
      </FloatingChatBubble>,
    );
    fireEvent.click(screen.getByRole('button', { name: /open chat/i }));

    expect(screen.getByTestId('chat-body-slot')).toBeInTheDocument();
    // The placeholder empty-state should NOT render when a body slot
    // is supplied.
    expect(
      document.querySelector(
        '[data-component="floating-chat-bubble-panel-empty"]',
      ),
    ).toBeNull();
  });

  it('shows the placeholder empty-state when no children are passed', () => {
    render(<FloatingChatBubble />);
    fireEvent.click(screen.getByRole('button', { name: /open chat/i }));

    expect(
      document.querySelector(
        '[data-component="floating-chat-bubble-panel-empty"]',
      ),
    ).not.toBeNull();
  });

  it('collapses back to the bubble when the close button is clicked', () => {
    const { container } = render(<FloatingChatBubble />);
    fireEvent.click(screen.getByRole('button', { name: /open chat/i }));

    const closeBtn = screen.getByRole('button', { name: /close chat/i });
    fireEvent.click(closeBtn);

    const wrapper = container.querySelector(
      '[data-component="floating-chat-bubble"]',
    );
    expect(wrapper).toHaveAttribute('data-state', 'closed');
    expect(
      container.querySelector(
        '[data-component="floating-chat-bubble-panel"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-component="floating-chat-bubble-trigger"]',
      ),
    ).not.toBeNull();
  });

  it('collapses on Escape when the panel is open', () => {
    const { container } = render(<FloatingChatBubble />);
    fireEvent.click(screen.getByRole('button', { name: /open chat/i }));

    fireEvent.keyDown(document, { key: 'Escape' });

    const wrapper = container.querySelector(
      '[data-component="floating-chat-bubble"]',
    );
    expect(wrapper).toHaveAttribute('data-state', 'closed');
  });

  it('does NOT react to Escape while collapsed', () => {
    const { container } = render(<FloatingChatBubble />);
    fireEvent.keyDown(document, { key: 'Escape' });

    const wrapper = container.querySelector(
      '[data-component="floating-chat-bubble"]',
    );
    expect(wrapper).toHaveAttribute('data-state', 'closed');
    // Sanity: still showing the trigger, never expanded.
    expect(
      container.querySelector(
        '[data-component="floating-chat-bubble-trigger"]',
      ),
    ).not.toBeNull();
  });

  it('honours defaultOpen=true on first render', () => {
    const { container } = render(<FloatingChatBubble defaultOpen />);

    const wrapper = container.querySelector(
      '[data-component="floating-chat-bubble"]',
    );
    expect(wrapper).toHaveAttribute('data-state', 'open');
    expect(
      container.querySelector(
        '[data-component="floating-chat-bubble-panel"]',
      ),
    ).not.toBeNull();
  });

  it('invokes onOpenChange in uncontrolled mode as a change listener', () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    render(<FloatingChatBubble onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole('button', { name: /open chat/i }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: /close chat/i }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });
});

describe('FloatingChatBubble — controlled mode', () => {
  it('renders the panel when `open` is true and the trigger when false', () => {
    const { container, rerender } = render(
      <FloatingChatBubble open={false} onOpenChange={() => {}} />,
    );
    expect(
      container.querySelector(
        '[data-component="floating-chat-bubble-panel"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-component="floating-chat-bubble-trigger"]',
      ),
    ).not.toBeNull();

    rerender(<FloatingChatBubble open onOpenChange={() => {}} />);
    expect(
      container.querySelector(
        '[data-component="floating-chat-bubble-panel"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-component="floating-chat-bubble-trigger"]',
      ),
    ).toBeNull();
  });

  it('does NOT mutate its own state when controlled — relies on the parent', () => {
    // No onOpenChange handler here; clicking should not flip the panel.
    const { container } = render(<FloatingChatBubble open={false} />);
    fireEvent.click(screen.getByRole('button', { name: /open chat/i }));

    // Still closed — the parent never updated the controlled prop.
    const wrapper = container.querySelector(
      '[data-component="floating-chat-bubble"]',
    );
    expect(wrapper).toHaveAttribute('data-state', 'closed');
  });

  it('forwards every toggle through onOpenChange in controlled mode', () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const { rerender } = render(
      <FloatingChatBubble open={false} onOpenChange={onOpenChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /open chat/i }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    rerender(<FloatingChatBubble open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: /close chat/i }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});

describe('FloatingChatBubble — wrapper / className passthrough', () => {
  it('merges caller className onto the wrapper element', () => {
    const { container } = render(
      <FloatingChatBubble className="z-[60] custom-floating" />,
    );
    const wrapper = container.querySelector(
      '[data-component="floating-chat-bubble"]',
    );
    expect(wrapper).not.toBeNull();
    const cls = wrapper!.getAttribute('class') ?? '';
    expect(cls).toContain('custom-floating');
    expect(cls).toContain('z-[60]');
  });

  it('exposes data-mobile reflecting the matchMedia state', () => {
    // jsdom's default matchMedia returns matches=false, so isMobile is
    // false and the desktop class set is in play.
    const { container } = render(<FloatingChatBubble />);
    const wrapper = container.querySelector(
      '[data-component="floating-chat-bubble"]',
    );
    expect(wrapper).toHaveAttribute('data-mobile', 'false');
  });
});
