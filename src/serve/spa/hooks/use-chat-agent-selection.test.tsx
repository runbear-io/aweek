/**
 * Tests for `./use-chat-agent-selection.ts` — the AC 10 hook that
 * resolves the slug the floating chat panel should currently target.
 *
 * Contract pinned by these tests:
 *
 *   1. `parseAgentSlugFromPath`
 *      - returns the slug for `/agents/<slug>` and deeper paths
 *      - returns `null` for non-detail routes (`/agents`, `/settings`)
 *      - returns `null` for malformed slugs (uppercase, special chars)
 *      - decodes percent-encoded segments
 *
 *   2. `useChatAgentSelection` (router + context integration)
 *      - returns the URL slug when no explicit selection exists
 *        (defaulting to current page when on `/agents/:slug/*`)
 *      - returns the explicit selection when set, even on agent
 *        detail routes (user's pick beats the URL)
 *      - returns the fallback slug when neither URL nor explicit
 *        selection resolves
 *      - exposes `routeAgentSlug` so the picker can show the
 *        "currently viewing" hint independently of the active value
 *      - reflects `source` so consumers can distinguish explicit vs.
 *        route vs. fallback resolution paths
 *      - `setSelectedAgentSlug` writes through to the context so the
 *        next render sees the explicit selection
 *
 * Vitest + jsdom + Testing Library (config: vitest.config.js +
 * vitest.setup.js).
 */

import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ChatPanelProvider } from '../components/chat-panel-context.tsx';
import {
  parseAgentSlugFromPath,
  useChatAgentSelection,
  type UseChatAgentSelectionResult,
} from './use-chat-agent-selection.ts';

afterEach(() => {
  cleanup();
});

// ── parseAgentSlugFromPath ────────────────────────────────────────────

describe('parseAgentSlugFromPath', () => {
  it('extracts the slug from /agents/:slug', () => {
    expect(parseAgentSlugFromPath('/agents/writer')).toBe('writer');
  });
  it('extracts the slug from /agents/:slug/calendar', () => {
    expect(parseAgentSlugFromPath('/agents/writer/calendar')).toBe('writer');
  });
  it('extracts the slug from a deep activities link', () => {
    expect(
      parseAgentSlugFromPath('/agents/writer/activities/2026-W17-monday'),
    ).toBe('writer');
  });
  it('returns null for the agents list root', () => {
    expect(parseAgentSlugFromPath('/agents')).toBeNull();
    expect(parseAgentSlugFromPath('/agents/')).toBeNull();
  });
  it('returns null for non-agents routes', () => {
    expect(parseAgentSlugFromPath('/settings')).toBeNull();
    expect(parseAgentSlugFromPath('/calendar')).toBeNull();
    expect(parseAgentSlugFromPath('/')).toBeNull();
  });
  it('rejects malformed slugs', () => {
    expect(parseAgentSlugFromPath('/agents/INVALID')).toBeNull();
    expect(parseAgentSlugFromPath('/agents/-leading-hyphen')).toBeNull();
    expect(parseAgentSlugFromPath('/agents/has space')).toBeNull();
    expect(parseAgentSlugFromPath('/agents/special!chars')).toBeNull();
  });
  it('decodes percent-encoded segments', () => {
    // Slugs the navigator wraps in `encodeURIComponent` should still
    // match — `writer-2026` is unaffected by encoding but the test
    // pins the decode path is invoked.
    expect(parseAgentSlugFromPath('/agents/writer-2026')).toBe(
      'writer-2026',
    );
  });
  it('returns null for empty strings', () => {
    expect(parseAgentSlugFromPath('')).toBeNull();
  });
});

// ── useChatAgentSelection hook integration ───────────────────────────

interface ProbeResult {
  current: UseChatAgentSelectionResult | null;
}

function renderHook(
  initialPath: string,
  options: {
    fallbackSlug?: string | null;
    defaultSelectedAgentSlug?: string | null;
  } = {},
): { probe: ProbeResult; rerender: () => void; unmount: () => void } {
  const probe: ProbeResult = { current: null };

  function Probe(): null {
    const result = useChatAgentSelection({
      ...(options.fallbackSlug !== undefined
        ? { fallbackSlug: options.fallbackSlug }
        : {}),
    });
    probe.current = result;
    return null;
  }

  const view = render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ChatPanelProvider
        storage={null}
        defaultSelectedAgentSlug={options.defaultSelectedAgentSlug ?? null}
      >
        <Probe />
      </ChatPanelProvider>
    </MemoryRouter>,
  );

  return {
    probe,
    rerender: () =>
      view.rerender(
        view.container.firstChild as unknown as React.ReactElement,
      ),
    unmount: view.unmount,
  };
}

describe('useChatAgentSelection — URL-derived defaults', () => {
  it('defaults to the URL slug when on /agents/:slug', () => {
    const { probe } = renderHook('/agents/writer');
    expect(probe.current?.effectiveSlug).toBe('writer');
    expect(probe.current?.routeAgentSlug).toBe('writer');
    expect(probe.current?.selectedAgentSlug).toBeNull();
    expect(probe.current?.source).toBe('route');
  });

  it('defaults to the URL slug when on a deeper agent route', () => {
    const { probe } = renderHook('/agents/writer/calendar/some-task');
    expect(probe.current?.effectiveSlug).toBe('writer');
    expect(probe.current?.source).toBe('route');
  });

  it('does not fall back to URL when the slug is malformed', () => {
    const { probe } = renderHook('/agents/INVALID');
    expect(probe.current?.effectiveSlug).toBeNull();
    expect(probe.current?.routeAgentSlug).toBeNull();
    expect(probe.current?.source).toBe('none');
  });
});

describe('useChatAgentSelection — fallback resolution', () => {
  it('uses the supplied fallback when the route is not /agents/:slug', () => {
    const { probe } = renderHook('/settings', { fallbackSlug: 'writer' });
    expect(probe.current?.effectiveSlug).toBe('writer');
    expect(probe.current?.routeAgentSlug).toBeNull();
    expect(probe.current?.source).toBe('fallback');
  });

  it('returns null when no fallback is supplied and the URL is not /agents/:slug', () => {
    const { probe } = renderHook('/settings');
    expect(probe.current?.effectiveSlug).toBeNull();
    expect(probe.current?.source).toBe('none');
  });

  it('rejects a malformed fallback slug', () => {
    const { probe } = renderHook('/settings', { fallbackSlug: 'NOT VALID' });
    expect(probe.current?.effectiveSlug).toBeNull();
    expect(probe.current?.source).toBe('none');
  });
});

describe('useChatAgentSelection — explicit selection', () => {
  it('explicit selection beats the URL slug', () => {
    const { probe } = renderHook('/agents/writer', {
      defaultSelectedAgentSlug: 'reviewer',
    });
    expect(probe.current?.effectiveSlug).toBe('reviewer');
    expect(probe.current?.routeAgentSlug).toBe('writer');
    expect(probe.current?.selectedAgentSlug).toBe('reviewer');
    expect(probe.current?.source).toBe('explicit');
  });

  it('explicit selection beats the fallback', () => {
    const { probe } = renderHook('/settings', {
      defaultSelectedAgentSlug: 'reviewer',
      fallbackSlug: 'writer',
    });
    expect(probe.current?.effectiveSlug).toBe('reviewer');
    expect(probe.current?.source).toBe('explicit');
  });

  it('setSelectedAgentSlug pins the panel to a chosen agent', () => {
    const { probe } = renderHook('/agents/writer');
    expect(probe.current?.effectiveSlug).toBe('writer');

    act(() => {
      probe.current?.setSelectedAgentSlug('reviewer');
    });

    expect(probe.current?.effectiveSlug).toBe('reviewer');
    expect(probe.current?.routeAgentSlug).toBe('writer');
    expect(probe.current?.source).toBe('explicit');
  });

  it('setSelectedAgentSlug(null) clears the selection and re-defaults to the URL', () => {
    const { probe } = renderHook('/agents/writer', {
      defaultSelectedAgentSlug: 'reviewer',
    });
    expect(probe.current?.source).toBe('explicit');

    act(() => {
      probe.current?.setSelectedAgentSlug(null);
    });

    expect(probe.current?.effectiveSlug).toBe('writer');
    expect(probe.current?.source).toBe('route');
  });

  it('setSelectedAgentSlug rejects malformed slugs (silently coerces to null)', () => {
    const { probe } = renderHook('/agents/writer');

    act(() => {
      probe.current?.setSelectedAgentSlug('NOT VALID');
    });

    // Invalid slug is coerced to null → effectiveSlug falls back to URL
    expect(probe.current?.effectiveSlug).toBe('writer');
    expect(probe.current?.selectedAgentSlug).toBeNull();
  });
});
