/**
 * Component tests for `ActivityTimeline` — AC 4, Sub-AC 3.
 *
 * Contract: merge `ActivityLogStore` entries and `ExecutionStore` records
 * into a single chronological, newest-first timeline with a per-source
 * visual tag (so operators can scan both heartbeat ticks and user-facing
 * activity rows in one stream).
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Config : `vitest.config.js`.
 * Command: `pnpm test:spa`
 *
 * TypeScript migration note (AC 204, Sub-AC 3.4):
 *   Renamed `.test.jsx` → `.test.tsx` alongside the component conversion.
 *   The component module (`./activity-timeline`) is now `.tsx` and exports
 *   typed `ActivityTimelineProps` / `TimelineItem` / `ActivityLogEntry` /
 *   `ExecutionRecord` shapes; the import below stays on the `.jsx`
 *   extension because TypeScript's Bundler resolution maps a `.jsx`
 *   import onto the `.tsx` source file (same as the existing
 *   `agent-activity-page.tsx` callsite).
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import {
  ActivityTimeline,
  buildTimeline,
} from './activity-timeline.jsx';

// ── Fixtures ─────────────────────────────────────────────────────────

/** Activity-log entries, matching `createLogEntry` shape. */
const ENTRIES = [
  {
    id: 'log-newer',
    agentId: 'alice',
    timestamp: '2026-04-22T15:00:00.000Z',
    status: 'completed',
    title: 'Wednesday retro',
    duration: 120_000,
  },
  {
    id: 'log-mid',
    agentId: 'alice',
    timestamp: '2026-04-22T13:00:00.000Z',
    status: 'started',
    title: 'Kickoff review',
    taskId: 'task-a',
  },
  {
    id: 'log-older',
    agentId: 'alice',
    timestamp: '2026-04-20T09:00:00.000Z',
    status: 'failed',
    title: 'Syntax breakage',
  },
];

/** Execution records, matching `createExecutionRecord` shape. */
const EXECUTIONS = [
  {
    id: 'exec-14',
    idempotencyKey: 'idem-14',
    agentId: 'alice',
    timestamp: '2026-04-22T14:00:00.000Z',
    windowStart: '2026-04-22T14:00:00.000Z',
    windowEnd: '2026-04-22T15:00:00.000Z',
    status: 'completed',
    taskId: 'task-b',
    duration: 45_000,
    metadata: { totalTokens: 12_345, costUsd: 0.1234 },
  },
  {
    id: 'exec-10',
    idempotencyKey: 'idem-10',
    agentId: 'alice',
    timestamp: '2026-04-22T10:00:00.000Z',
    windowStart: '2026-04-22T10:00:00.000Z',
    windowEnd: '2026-04-22T11:00:00.000Z',
    status: 'skipped',
  },
  {
    id: 'exec-fail',
    idempotencyKey: 'idem-fail',
    agentId: 'alice',
    timestamp: '2026-04-20T10:00:00.000Z',
    windowStart: '2026-04-20T10:00:00.000Z',
    windowEnd: '2026-04-20T11:00:00.000Z',
    status: 'failed',
    error: 'rate limit',
  },
];

// ── Lifecycle ────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
});

// ── buildTimeline (pure merge) ───────────────────────────────────────

describe('buildTimeline — pure merge helper', () => {
  it('produces newest-first chronological order across both sources', () => {
    const items = buildTimeline(ENTRIES, EXECUTIONS);
    const timestamps = items.map((i) => i.timestamp);
    expect(timestamps).toEqual([
      '2026-04-22T15:00:00.000Z', // log-newer
      '2026-04-22T14:00:00.000Z', // exec-14
      '2026-04-22T13:00:00.000Z', // log-mid
      '2026-04-22T10:00:00.000Z', // exec-10
      '2026-04-20T10:00:00.000Z', // exec-fail
      '2026-04-20T09:00:00.000Z', // log-older
    ]);
  });

  it('tags every item with its originating source', () => {
    const items = buildTimeline(ENTRIES, EXECUTIONS);
    const sources = items.map((i) => i.source);
    // 3 activity entries + 3 executions, interleaved chronologically.
    expect(sources.filter((s) => s === 'activity')).toHaveLength(3);
    expect(sources.filter((s) => s === 'execution')).toHaveLength(3);
    expect(new Set(sources)).toEqual(new Set(['activity', 'execution']));
  });

  it('handles empty inputs without throwing', () => {
    expect(buildTimeline()).toEqual([]);
    expect(buildTimeline([], [])).toEqual([]);
    expect(buildTimeline([ENTRIES[0]], [])).toHaveLength(1);
    expect(buildTimeline([], [EXECUTIONS[0]])).toHaveLength(1);
  });

  it('applies stable ordering on identical timestamps (activity before execution)', () => {
    const collide = '2026-04-22T14:00:00.000Z';
    const items = buildTimeline(
      [{ id: 'a', timestamp: collide, status: 'completed', title: 'tied' }],
      [{ id: 'e', timestamp: collide, status: 'completed' }],
    );
    expect(items.map((i) => i.source)).toEqual(['activity', 'execution']);
  });

  it('keeps rows with missing / unparseable timestamps but sinks them to the bottom', () => {
    const items = buildTimeline(
      [
        { id: 'a1', timestamp: '2026-04-22T14:00:00.000Z', status: 'ok', title: 'has-ts' },
        { id: 'a2', status: 'ok', title: 'no-ts' },
      ],
      [
        { id: 'e1', timestamp: 'not-a-date', status: 'ok' },
      ],
    );
    expect(items).toHaveLength(3);
    // First has a real timestamp, last two are sort-key 0.
    expect(items[0].raw.id).toBe('a1');
    expect(items.slice(1).map((i) => i.raw.id).sort()).toEqual(['a2', 'e1']);
  });
});

// ── Render — empty state ─────────────────────────────────────────────

describe('ActivityTimeline — empty state', () => {
  it('renders the empty message when both lists are empty', () => {
    const { container } = render(<ActivityTimeline entries={[]} executions={[]} />);
    const root = container.querySelector('[data-component="activity-timeline"]');
    expect(root).not.toBeNull();
    expect(root!.getAttribute('data-row-count')).toBe('0');
    const empty = container.querySelector('[data-timeline-empty="true"]');
    expect(empty).not.toBeNull();
    expect(empty).toHaveTextContent(/no activity in this range/i);
  });

  it('honours a custom emptyMessage prop', () => {
    render(
      <ActivityTimeline
        entries={[]}
        executions={[]}
        emptyMessage="Quiet week."
      />,
    );
    expect(screen.getByText(/quiet week/i)).toBeInTheDocument();
  });

  it('renders the caller-supplied title', () => {
    const { container } = render(
      <ActivityTimeline entries={[]} executions={[]} title="Unified stream" />,
    );
    expect(container).toHaveTextContent(/unified stream/i);
  });
});

// ── Render — chronological merge ─────────────────────────────────────

describe('ActivityTimeline — chronological visualization', () => {
  it('renders one row per combined entry and reports the row count', () => {
    const { container } = render(
      <ActivityTimeline entries={ENTRIES} executions={EXECUTIONS} />,
    );
    const root = container.querySelector('[data-component="activity-timeline"]');
    expect(root!.getAttribute('data-row-count')).toBe('6');
    const list = screen.getByRole('list', { name: /chronological activity timeline/i });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(6);
    // 6 rows singular check: reports "6 rows"
    expect(container).toHaveTextContent(/6 rows/i);
  });

  it('interleaves activity + execution rows in newest-first order', () => {
    const { container } = render(
      <ActivityTimeline entries={ENTRIES} executions={EXECUTIONS} />,
    );
    const items = container.querySelectorAll('[data-component="activity-timeline"] li');
    const orderedSources = Array.from(items).map((li) =>
      li.getAttribute('data-timeline-source'),
    );
    // Expected (newest → oldest):
    //   15:00 activity, 14:00 execution, 13:00 activity,
    //   10:00 execution, 10:00 execution (04-20), 09:00 activity.
    expect(orderedSources).toEqual([
      'activity',
      'execution',
      'activity',
      'execution',
      'execution',
      'activity',
    ]);
  });

  it('tags each row with a visible source badge (Activity / Heartbeat)', () => {
    const { container } = render(
      <ActivityTimeline entries={ENTRIES} executions={EXECUTIONS} />,
    );
    const activityBadges = container.querySelectorAll(
      '[data-timeline-badge="activity"]',
    );
    const heartbeatBadges = container.querySelectorAll(
      '[data-timeline-badge="execution"]',
    );
    expect(activityBadges.length).toBe(3);
    expect(heartbeatBadges.length).toBe(3);
    expect(activityBadges[0]).toHaveTextContent(/activity/i);
    expect(heartbeatBadges[0]).toHaveTextContent(/heartbeat/i);
  });

  it('renders per-source rail dots on every row for visual scanning', () => {
    const { container } = render(
      <ActivityTimeline entries={ENTRIES} executions={EXECUTIONS} />,
    );
    const activityDots = container.querySelectorAll(
      '[data-rail-dot="activity"]',
    );
    const executionDots = container.querySelectorAll(
      '[data-rail-dot="execution"]',
    );
    expect(activityDots.length).toBe(3);
    expect(executionDots.length).toBe(3);
  });

  it('surfaces activity-log fields (title, status, taskId, duration)', () => {
    const { container } = render(
      <ActivityTimeline entries={ENTRIES} executions={EXECUTIONS} />,
    );
    // Titles from the activity rows:
    expect(container).toHaveTextContent(/Wednesday retro/);
    expect(container).toHaveTextContent(/Kickoff review/);
    expect(container).toHaveTextContent(/Syntax breakage/);
    // Status badges for entries:
    expect(container).toHaveTextContent(/started/i);
    expect(container).toHaveTextContent(/failed/i);
    // taskId and formatted duration ("2.0m" for 120_000ms) visible.
    expect(container).toHaveTextContent(/task-a/);
    expect(container).toHaveTextContent(/2\.0m/);
  });

  it('surfaces execution-record fields (status, taskId, tokens, cost, error)', () => {
    const { container } = render(
      <ActivityTimeline entries={ENTRIES} executions={EXECUTIONS} />,
    );
    // Execution rows bring taskId "task-b", token count "12k", cost "$0.1234", window, error.
    expect(container).toHaveTextContent(/task-b/);
    expect(container).toHaveTextContent(/12k tokens/);
    expect(container).toHaveTextContent(/\$0\.1234/);
    expect(container).toHaveTextContent(/rate limit/);
    // Status labels: completed / skipped / failed.
    expect(container).toHaveTextContent(/skipped/i);
  });

  it('attaches the entry timestamp as a data attribute for DOM assertions', () => {
    const { container } = render(
      <ActivityTimeline entries={ENTRIES} executions={EXECUTIONS} />,
    );
    const items = container.querySelectorAll('[data-timeline-timestamp]');
    const stamps = Array.from(items).map((el) =>
      el.getAttribute('data-timeline-timestamp'),
    );
    expect(stamps[0]).toBe('2026-04-22T15:00:00.000Z');
    expect(stamps[stamps.length - 1]).toBe('2026-04-20T09:00:00.000Z');
  });
});

// ── Render — single-source inputs still render correctly ─────────────

describe('ActivityTimeline — single-source inputs', () => {
  it('renders only activity rows when executions is empty', () => {
    const { container } = render(
      <ActivityTimeline entries={ENTRIES} executions={[]} />,
    );
    expect(
      container.querySelectorAll('[data-timeline-source="activity"]').length,
    ).toBe(3);
    expect(
      container.querySelectorAll('[data-timeline-source="execution"]').length,
    ).toBe(0);
  });

  it('renders only execution rows when entries is empty', () => {
    const { container } = render(
      <ActivityTimeline entries={[]} executions={EXECUTIONS} />,
    );
    expect(
      container.querySelectorAll('[data-timeline-source="activity"]').length,
    ).toBe(0);
    expect(
      container.querySelectorAll('[data-timeline-source="execution"]').length,
    ).toBe(3);
  });
});
