/**
 * Tests for `./chat-agent-picker.tsx` — the AC 10 dropdown that lets
 * the user switch which agent the floating chat panel chats with.
 *
 * Contract pinned by these tests:
 *
 *   1. Renders one `<option>` per agent in the supplied roster.
 *   2. Reflects the `value` prop as the `<select>`'s current value
 *      (or the placeholder when the value is null / unknown).
 *   3. Calls `onChange(slug)` with the picked slug when the user
 *      selects a non-placeholder option; ignores the placeholder.
 *   4. Disables the placeholder option once a real agent exists, so
 *      the picker can't drop back to the empty state by accident.
 *   5. Decorates the option label with status / route hints
 *      (`(viewing)`, `(paused)`, `(over budget)`, `(missing)`).
 *   6. Renders the loading + error states without crashing and hides
 *      the select element in those branches.
 *   7. When the supplied `value` doesn't match any agent in the
 *      roster (e.g. a stale persisted slug pointing at a deleted
 *      agent) falls back to the placeholder so no junk slug surfaces.
 *
 * Vitest + jsdom + Testing Library (config: vitest.config.js +
 * vitest.setup.js).
 */

import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ChatAgentPicker, __test } from './chat-agent-picker.tsx';
import type { AgentListRow } from '../lib/api-client.js';

afterEach(() => {
  cleanup();
});

// ── Fixtures ─────────────────────────────────────────────────────────

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
  makeAgent({ slug: 'reviewer', name: 'Reviewer', status: 'paused' }),
  makeAgent({
    slug: 'planner',
    name: 'Planner',
    status: 'budget-exhausted',
  }),
];

// ── Render ───────────────────────────────────────────────────────────

describe('ChatAgentPicker — render', () => {
  it('renders one option per agent in the roster (plus the placeholder)', () => {
    render(
      <ChatAgentPicker
        value="writer"
        onChange={() => {}}
        agents={ROSTER}
      />,
    );
    const select = screen.getByRole('combobox', { name: 'Choose agent' });
    // 3 agents + 1 placeholder = 4 options.
    expect(select.querySelectorAll('option')).toHaveLength(4);
  });

  it('reflects the value prop on the underlying select', () => {
    render(
      <ChatAgentPicker
        value="reviewer"
        onChange={() => {}}
        agents={ROSTER}
      />,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('reviewer');
  });

  it('falls back to the placeholder when the value is null', () => {
    render(
      <ChatAgentPicker value={null} onChange={() => {}} agents={ROSTER} />,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe(__test.PLACEHOLDER_VALUE);
  });

  it('falls back to the placeholder when the value is not in the roster', () => {
    render(
      <ChatAgentPicker
        value="ghost-agent"
        onChange={() => {}}
        agents={ROSTER}
      />,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe(__test.PLACEHOLDER_VALUE);
  });

  it('disables the placeholder option (cannot be re-selected)', () => {
    render(
      <ChatAgentPicker
        value="writer"
        onChange={() => {}}
        agents={ROSTER}
      />,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const placeholder = select.querySelector('option[value=""]');
    expect(placeholder).not.toBeNull();
    expect((placeholder as HTMLOptionElement).disabled).toBe(true);
  });

  it('shows the status suffixes for paused / budget-exhausted / missing agents', () => {
    render(
      <ChatAgentPicker
        value="writer"
        onChange={() => {}}
        agents={ROSTER}
      />,
    );
    expect(screen.getByText(/Reviewer \(paused\)/)).toBeTruthy();
    expect(screen.getByText(/Planner \(over budget\)/)).toBeTruthy();
  });

  it('appends "(viewing)" to the option matching routeSlug', () => {
    render(
      <ChatAgentPicker
        value="reviewer"
        onChange={() => {}}
        agents={ROSTER}
        routeSlug="writer"
      />,
    );
    expect(screen.getByText(/Writer \(viewing\)/)).toBeTruthy();
  });

  it('marks the route-matching option via data-route-match', () => {
    const { container } = render(
      <ChatAgentPicker
        value="reviewer"
        onChange={() => {}}
        agents={ROSTER}
        routeSlug="writer"
      />,
    );
    const writerOption = container.querySelector(
      'option[data-slug="writer"]',
    );
    expect(writerOption?.getAttribute('data-route-match')).toBe('true');
  });
});

// ── Empty / loading / error ──────────────────────────────────────────

describe('ChatAgentPicker — non-ready states', () => {
  it('renders an empty placeholder when no agents are loaded', () => {
    render(
      <ChatAgentPicker value={null} onChange={() => {}} agents={[]} />,
    );
    const wrapper = screen.getByText('No agents yet');
    expect(wrapper).toBeTruthy();
    // The select itself is disabled in this branch.
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it('renders the loading row when loading=true', () => {
    const { container } = render(
      <ChatAgentPicker
        value={null}
        onChange={() => {}}
        agents={[]}
        loading
      />,
    );
    expect(
      container.querySelector('[data-component="chat-agent-picker"]')
        ?.getAttribute('data-state'),
    ).toBe('loading');
    // No select element rendered in the loading branch.
    expect(container.querySelector('select')).toBeNull();
  });

  it('renders the error row when error is set', () => {
    const { container } = render(
      <ChatAgentPicker
        value={null}
        onChange={() => {}}
        agents={[]}
        error="boom"
      />,
    );
    expect(
      container.querySelector('[data-component="chat-agent-picker"]')
        ?.getAttribute('data-state'),
    ).toBe('error');
    expect(
      container.querySelector('[data-component="chat-agent-picker-error"]')
        ?.textContent,
    ).toBe('boom');
    expect(container.querySelector('select')).toBeNull();
  });
});

// ── Interaction ──────────────────────────────────────────────────────

describe('ChatAgentPicker — onChange', () => {
  it('invokes onChange with the picked slug', () => {
    const onChange = vi.fn();
    render(
      <ChatAgentPicker value="writer" onChange={onChange} agents={ROSTER} />,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'reviewer' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('reviewer');
  });

  it('does NOT invoke onChange for the placeholder value', () => {
    const onChange = vi.fn();
    // We have to start with no real selection (so value="") to even
    // surface the placeholder as a selectable option in jsdom; even
    // then, attempting to fire `change` with value="" should be a no-op.
    render(
      <ChatAgentPicker value={null} onChange={onChange} agents={ROSTER} />,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ── formatOptionLabel helper ─────────────────────────────────────────

describe('formatOptionLabel', () => {
  it('returns just the name when there are no suffixes', () => {
    const label = __test.formatOptionLabel(
      makeAgent({ slug: 'writer', name: 'Writer' }),
      null,
    );
    expect(label).toBe('Writer');
  });

  it('combines viewing + paused suffixes', () => {
    const label = __test.formatOptionLabel(
      makeAgent({ slug: 'reviewer', name: 'Reviewer', status: 'paused' }),
      'reviewer',
    );
    expect(label).toBe('Reviewer (viewing, paused)');
  });

  it('falls back to slug when name is empty', () => {
    const label = __test.formatOptionLabel(
      makeAgent({ slug: 'writer', name: '' }),
      null,
    );
    expect(label).toBe('writer');
  });

  it('shows "missing" suffix for missing agents', () => {
    const label = __test.formatOptionLabel(
      makeAgent({ slug: 'writer', missing: true }),
      null,
    );
    expect(label).toContain('missing');
  });
});
