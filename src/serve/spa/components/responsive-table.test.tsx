/**
 * Component tests for `ResponsiveTable` (AC 40002, sub-AC 2).
 *
 * Contract:
 *   - Accepts `columns` + `rows` and renders a desktop table at ≥768px and
 *     stacked mobile cards at <768px (CSS-only swap, both DOM trees
 *     present).
 *   - Click handler fires on both layouts and supports keyboard
 *     activation (Enter / Space) on the desktop row.
 *   - Mobile cards meet the 44 × 44 px minimum touch-target requirement
 *     (`min-h-[44px]` is applied to clickable cards).
 *   - Column flags `primary`, `hideOnMobile`, and `mobileLabel` are
 *     respected on the mobile layout.
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 *   The CSS classes (`hidden md:block` / `md:hidden`) are not evaluated
 *   in jsdom, so both layouts are queryable in tests. We assert structure
 *   via `data-responsive-layout` attributes rather than CSS visibility.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';

import {
  ResponsiveTable,
  type ResponsiveTableColumn,
} from './responsive-table.tsx';

// ── Fixtures ─────────────────────────────────────────────────────────

interface AgentRow {
  slug: string;
  name: string;
  status: 'active' | 'paused';
  tasks: string;
}

const ROWS: AgentRow[] = [
  { slug: 'alice', name: 'Alice', status: 'active', tasks: '2/5' },
  { slug: 'bob', name: 'Bob', status: 'paused', tasks: '0/3' },
];

const COLUMNS: ResponsiveTableColumn<AgentRow>[] = [
  {
    key: 'name',
    header: 'Agent',
    cell: (row) => row.name,
    primary: true,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => row.status,
  },
  {
    key: 'tasks',
    header: 'Tasks',
    cell: (row) => row.tasks,
    cellClassName: 'text-right',
    headClassName: 'text-right',
  },
];

afterEach(() => {
  cleanup();
});

// ── Layout structure ─────────────────────────────────────────────────

describe('ResponsiveTable — dual layout', () => {
  it('renders both a desktop table and a mobile card layout simultaneously', () => {
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.slug}
      />,
    );
    const desktop = container.querySelector(
      '[data-responsive-layout="desktop"]',
    );
    const mobile = container.querySelector(
      '[data-responsive-layout="mobile"]',
    );
    expect(desktop).not.toBeNull();
    expect(mobile).not.toBeNull();
    // CSS gating: desktop is `hidden md:block`, mobile is `md:hidden`.
    expect(desktop?.className).toMatch(/hidden/);
    expect(desktop?.className).toMatch(/md:block/);
    expect(mobile?.className).toMatch(/md:hidden/);
  });

  it('reports the row count on the outer wrapper', () => {
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.slug}
      />,
    );
    const root = container.querySelector('[data-component="responsive-table"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('data-row-count')).toBe('2');
  });
});

// ── Desktop table ────────────────────────────────────────────────────

describe('ResponsiveTable — desktop layout', () => {
  it('renders a header cell per column with the canonical content', () => {
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.slug}
      />,
    );
    const desktop = container.querySelector(
      '[data-responsive-layout="desktop"]',
    )!;
    const heads = within(desktop as HTMLElement).getAllByRole('columnheader');
    expect(heads).toHaveLength(3);
    expect(heads[0]).toHaveTextContent('Agent');
    expect(heads[1]).toHaveTextContent('Status');
    expect(heads[2]).toHaveTextContent('Tasks');
  });

  it('renders one body row per data row with all column values', () => {
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.slug}
      />,
    );
    const desktop = container.querySelector(
      '[data-responsive-layout="desktop"]',
    )!;
    const rows = (desktop as HTMLElement).querySelectorAll('[data-row-key]');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-row-key')).toBe('alice');
    expect(rows[0]).toHaveTextContent('Alice');
    expect(rows[0]).toHaveTextContent('active');
    expect(rows[0]).toHaveTextContent('2/5');
  });

  it('applies cellClassName + headClassName to the right column', () => {
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.slug}
      />,
    );
    const tasksHead = container.querySelector(
      '[data-responsive-layout="desktop"] [data-column-key="tasks"]',
    );
    expect(tasksHead?.className).toMatch(/text-right/);
  });

  it('fires onRowSelect for both click and keyboard activation', () => {
    const onRowSelect = vi.fn();
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.slug}
        onRowSelect={onRowSelect}
      />,
    );
    const desktop = container.querySelector(
      '[data-responsive-layout="desktop"]',
    )!;
    const rows = (desktop as HTMLElement).querySelectorAll('[data-row-key]');
    expect(rows[0].getAttribute('role')).toBe('link');
    expect(rows[0].getAttribute('tabindex')).toBe('0');

    fireEvent.click(rows[0]);
    expect(onRowSelect).toHaveBeenCalledTimes(1);
    expect(onRowSelect).toHaveBeenLastCalledWith(ROWS[0], 0);

    fireEvent.keyDown(rows[1], { key: 'Enter' });
    expect(onRowSelect).toHaveBeenCalledTimes(2);
    expect(onRowSelect).toHaveBeenLastCalledWith(ROWS[1], 1);

    fireEvent.keyDown(rows[0], { key: ' ' });
    expect(onRowSelect).toHaveBeenCalledTimes(3);
    expect(onRowSelect).toHaveBeenLastCalledWith(ROWS[0], 0);
  });

  it('keeps rows non-interactive when no onRowSelect is supplied', () => {
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.slug}
      />,
    );
    const desktop = container.querySelector(
      '[data-responsive-layout="desktop"]',
    )!;
    const rows = (desktop as HTMLElement).querySelectorAll('[data-row-key]');
    expect(rows[0].getAttribute('role')).toBeNull();
    expect(rows[0].getAttribute('tabindex')).toBeNull();
  });

  it('renders the desktop caption below the table', () => {
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.slug}
        caption="Roster snapshot"
      />,
    );
    const desktop = container.querySelector(
      '[data-responsive-layout="desktop"]',
    )!;
    expect(within(desktop as HTMLElement).getByText('Roster snapshot')).toBeInTheDocument();
  });
});

// ── Mobile cards ─────────────────────────────────────────────────────

describe('ResponsiveTable — mobile layout', () => {
  it('renders one card per row with the primary column promoted to the title', () => {
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.slug}
      />,
    );
    const mobile = container.querySelector(
      '[data-responsive-layout="mobile"]',
    )!;
    const cards = (mobile as HTMLElement).querySelectorAll(
      '[data-mobile-card-key]',
    );
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute('data-mobile-card-key')).toBe('alice');
    // Primary cell is rendered without a label.
    const primary = cards[0].querySelector('[data-mobile-cell="primary"]');
    expect(primary).not.toBeNull();
    expect(primary).toHaveTextContent('Alice');
  });

  it('renders non-primary columns as labeled detail rows', () => {
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.slug}
      />,
    );
    const mobile = container.querySelector(
      '[data-responsive-layout="mobile"]',
    )!;
    const card = (mobile as HTMLElement).querySelectorAll(
      '[data-mobile-card-key]',
    )[0]!;
    const details = card.querySelectorAll('[data-mobile-cell="detail"]');
    expect(details).toHaveLength(2);
    // Status and Tasks labels both surface; values follow.
    expect(details[0]).toHaveTextContent('Status');
    expect(details[0]).toHaveTextContent('active');
    expect(details[1]).toHaveTextContent('Tasks');
    expect(details[1]).toHaveTextContent('2/5');
  });

  it('honours `mobileLabel` overrides (including null to suppress the label)', () => {
    const cols: ResponsiveTableColumn<AgentRow>[] = [
      { key: 'name', header: 'Agent', cell: (row) => row.name, primary: true },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => row.status,
        mobileLabel: 'State',
      },
      {
        key: 'tasks',
        header: 'Tasks',
        cell: (row) => row.tasks,
        mobileLabel: null,
      },
    ];
    const { container } = render(
      <ResponsiveTable columns={cols} rows={ROWS} getRowKey={(row) => row.slug} />,
    );
    const card = container.querySelectorAll('[data-mobile-card-key]')[0]!;
    const statusDetail = card.querySelector(
      '[data-mobile-cell="detail"][data-column-key="status"]',
    );
    const tasksDetail = card.querySelector(
      '[data-mobile-cell="detail"][data-column-key="tasks"]',
    );
    // Custom label.
    expect(statusDetail).toHaveTextContent('State');
    expect(statusDetail).not.toHaveTextContent(/^Status/);
    // null label → the <dt> is absent so there's no label text.
    expect(tasksDetail!.querySelector('dt')).toBeNull();
    expect(tasksDetail).toHaveTextContent('2/5');
  });

  it('omits columns flagged `hideOnMobile` from cards', () => {
    const cols: ResponsiveTableColumn<AgentRow>[] = [
      { key: 'name', header: 'Agent', cell: (row) => row.name, primary: true },
      { key: 'status', header: 'Status', cell: (row) => row.status },
      {
        key: 'tasks',
        header: 'Tasks',
        cell: (row) => row.tasks,
        hideOnMobile: true,
      },
    ];
    const { container } = render(
      <ResponsiveTable columns={cols} rows={ROWS} getRowKey={(row) => row.slug} />,
    );
    const card = container.querySelectorAll('[data-mobile-card-key]')[0]!;
    expect(
      card.querySelector('[data-mobile-cell][data-column-key="tasks"]'),
    ).toBeNull();
    // Tasks still appears in the desktop layout.
    const desktop = container.querySelector(
      '[data-responsive-layout="desktop"]',
    )!;
    expect(
      desktop.querySelector('[data-column-key="tasks"]'),
    ).not.toBeNull();
  });

  it('makes clickable cards a 44px-tall <button> with focusable role', () => {
    const onRowSelect = vi.fn();
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.slug}
        onRowSelect={onRowSelect}
        getRowAriaLabel={(row) => `Open ${row.name}`}
      />,
    );
    const card = container.querySelectorAll(
      '[data-responsive-layout="mobile"] [data-mobile-card-key]',
    )[0]!;
    expect(card.tagName.toLowerCase()).toBe('button');
    expect(card.getAttribute('data-clickable')).toBe('true');
    expect(card.getAttribute('aria-label')).toBe('Open Alice');
    // 44px minimum touch target.
    expect(card.className).toMatch(/min-h-\[44px\]/);
    // Inner CardContent also enforces the 44px floor.
    const inner = card.querySelector('[data-component="card-content"]');
    expect(inner!.className).toMatch(/min-h-\[44px\]/);
    fireEvent.click(card);
    expect(onRowSelect).toHaveBeenCalledWith(ROWS[0], 0);
  });

  it('renders read-only cards with at least 44px height when no onRowSelect is supplied', () => {
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.slug}
      />,
    );
    const card = container.querySelectorAll(
      '[data-responsive-layout="mobile"] [data-mobile-card-key]',
    )[0]!;
    expect(card.tagName.toLowerCase()).not.toBe('button');
    expect(card.getAttribute('data-clickable')).toBeNull();
    // Still meets WCAG 2.5.5 minimum touch area.
    expect(card.className).toMatch(/min-h-\[44px\]/);
  });
});

// ── Empty state ──────────────────────────────────────────────────────

describe('ResponsiveTable — empty state', () => {
  it('renders the default empty message in both layouts', () => {
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={(row: AgentRow) => row.slug}
      />,
    );
    const empties = container.querySelectorAll(
      '[data-responsive-empty="true"]',
    );
    expect(empties).toHaveLength(2);
    empties.forEach((el) => {
      expect(el).toHaveTextContent(/no rows to display/i);
    });
  });

  it('honours a custom empty message', () => {
    render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={(row: AgentRow) => row.slug}
        emptyMessage="No agents yet."
      />,
    );
    const matches = screen.getAllByText(/no agents yet\./i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('reports a zero row-count on the outer wrapper', () => {
    const { container } = render(
      <ResponsiveTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={(row: AgentRow) => row.slug}
      />,
    );
    const root = container.querySelector('[data-component="responsive-table"]');
    expect(root?.getAttribute('data-row-count')).toBe('0');
  });
});
