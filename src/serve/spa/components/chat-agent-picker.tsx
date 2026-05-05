/**
 * `ChatAgentPicker` — agent dropdown for the floating chat panel
 * (AC 10).
 *
 * Renders a styled native `<select>` populated with the live agent
 * roster. The picker is presentational: its value, options, and
 * change handler are passed in by the caller, who is responsible for
 * sourcing the agents (typically via `useAgents`) and forwarding the
 * change back into the `ChatPanelContext` (via
 * `setSelectedAgentSlug`).
 *
 * Why a native `<select>` instead of a shadcn `Select`:
 *   - The shadcn Select primitive isn't installed in this project's
 *     `components/ui/` tree (see the listing in `serve/spa/components/
 *     ui/`), and adding a new shadcn primitive is out of scope for
 *     AC 10.
 *   - A native `<select>` gives us keyboard handling, accessibility,
 *     and mobile-friendly OS pickers for free, with zero new
 *     dependencies.
 *   - The styling matches shadcn `<input>` / `<textarea>` (border,
 *     `bg-background`, `text-sm`, focus ring) so it visually fits
 *     into the existing design system.
 *
 * Each option carries:
 *   - the agent slug as `value`
 *   - the agent display name as the visible text
 *   - a status indicator suffix (`paused`, `over budget`) so the
 *     user knows whether the agent is currently runnable.
 *
 * The picker also surfaces a subtle "(viewing)" suffix on the option
 * matching the current `/agents/:slug/*` route — this lets the user
 * see at a glance which agent the panel WOULD default to if they
 * cleared their selection.
 *
 * @module serve/spa/components/chat-agent-picker
 */

import * as React from 'react';

import { cn } from '../lib/cn.js';
import type { AgentListRow } from '../lib/api-client.js';

// ── Public types ─────────────────────────────────────────────────────

export interface ChatAgentPickerProps {
  /**
   * Slug currently shown as the picker's selected option. May be
   * `null` when the agent roster is empty (or still loading and no
   * fallback is yet resolvable) — the picker renders a placeholder
   * option in that case.
   */
  value: string | null;
  /**
   * Notified when the user picks a different agent. Always invoked
   * with a non-null slug — the empty placeholder option is disabled
   * so it cannot be re-selected after the user picks a real agent.
   */
  onChange: (slug: string) => void;
  /**
   * Live agent roster from `useAgents`. The picker shows one option
   * per row, ordered by the array's existing order (the API returns
   * the canonical sort, so we don't re-sort here).
   */
  agents: ReadonlyArray<AgentListRow>;
  /**
   * Slug currently in the URL (`/agents/:slug/*`). When provided AND
   * different from `value`, the matching option gets a "(viewing)"
   * suffix so the user can see which agent would be the default if
   * they cleared their selection.
   */
  routeSlug?: string | null;
  /** When true, renders a loading placeholder instead of the select. */
  loading?: boolean;
  /** When set, renders an inline error string in place of the select. */
  error?: string | null;
  /** className merged onto the wrapper `<div>`. */
  className?: string;
  /** Caller-supplied id forwarded to the `<select>` (for label-for). */
  id?: string;
  /**
   * Aria-label for the select element. Defaults to "Choose agent" so
   * the surface always advertises a sensible name even when the
   * caller forgets to override.
   */
  ariaLabel?: string;
}

// ── Public component ─────────────────────────────────────────────────

const PLACEHOLDER_VALUE = '';

/**
 * Styled native `<select>` rendering one option per agent slug.
 *
 * Behaviour:
 *   - When `agents.length === 0` (roster still loading or genuinely
 *     empty), renders a disabled select with a "No agents yet"
 *     placeholder so the panel layout stays stable.
 *   - When `value` is `null`, the placeholder option is selected; it
 *     is `disabled` so the user can't deliberately re-select it.
 *   - When `value` doesn't match any roster slug (e.g. the user's
 *     persisted selection points at a deleted agent) the picker
 *     transparently falls back to the placeholder so the empty value
 *     surfaces as "no agent picked yet" rather than a stale slug.
 */
export function ChatAgentPicker({
  value,
  onChange,
  agents,
  routeSlug = null,
  loading = false,
  error = null,
  className,
  id,
  ariaLabel = 'Choose agent',
}: ChatAgentPickerProps): React.ReactElement {
  const slugInRoster = React.useMemo(
    () => agents.some((a) => a.slug === value),
    [agents, value],
  );
  const effectiveValue = value && slugInRoster ? value : PLACEHOLDER_VALUE;

  // Loading + error paths render the same wrapper / typography so the
  // panel layout stays stable as the roster fetch resolves.
  if (loading) {
    return (
      <div
        data-component="chat-agent-picker"
        data-state="loading"
        className={cn('flex items-center gap-2', className)}
      >
        <span className="text-xs text-muted-foreground">Loading agents…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div
        data-component="chat-agent-picker"
        data-state="error"
        className={cn('flex items-center gap-2', className)}
      >
        <span
          data-component="chat-agent-picker-error"
          className="text-xs text-destructive"
        >
          {error}
        </span>
      </div>
    );
  }

  const isEmpty = agents.length === 0;

  return (
    <div
      data-component="chat-agent-picker"
      data-state={isEmpty ? 'empty' : 'ready'}
      className={cn('flex items-center gap-2', className)}
    >
      <select
        id={id}
        data-component="chat-agent-picker-select"
        aria-label={ariaLabel}
        value={effectiveValue}
        disabled={isEmpty}
        onChange={(event) => {
          const next = event.target.value;
          if (!next || next === PLACEHOLDER_VALUE) return;
          onChange(next);
        }}
        className={cn(
          // Mirrors the shadcn `<input>` recipe — same height (`h-8`),
          // border, padding, focus ring — so the picker visually
          // belongs alongside the chat-panel header text.
          'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        {/*
          Placeholder option, only selectable while the roster is
          empty or no agent has been picked yet. The `disabled` flag
          on the option prevents the user from re-selecting it once a
          real agent is chosen — the picker funnel always lands on a
          valid slug.
        */}
        <option value={PLACEHOLDER_VALUE} disabled>
          {isEmpty ? 'No agents yet' : 'Pick an agent…'}
        </option>
        {agents.map((agent) => (
          <option
            key={agent.slug}
            value={agent.slug}
            data-component="chat-agent-picker-option"
            data-slug={agent.slug}
            data-route-match={
              routeSlug && agent.slug === routeSlug ? 'true' : 'false'
            }
          >
            {formatOptionLabel(agent, routeSlug)}
          </option>
        ))}
      </select>
    </div>
  );
}

export default ChatAgentPicker;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build the visible label for one agent option.
 *
 * Examples:
 *   "writer"
 *   "writer (paused)"
 *   "writer (over budget)"
 *   "writer (viewing)"           ← matches the `/agents/:slug` URL
 *   "writer (viewing, paused)"   ← combined
 *
 * Exported for unit-test reach via `__test.formatOptionLabel`.
 */
function formatOptionLabel(
  agent: AgentListRow,
  routeSlug: string | null,
): string {
  const suffixes: string[] = [];
  if (routeSlug && agent.slug === routeSlug) suffixes.push('viewing');
  if (agent.status === 'paused') suffixes.push('paused');
  else if (agent.status === 'budget-exhausted') suffixes.push('over budget');
  if (agent.missing) suffixes.push('missing');

  const baseLabel = agent.name?.trim() ? agent.name : agent.slug;
  if (suffixes.length === 0) return baseLabel;
  return `${baseLabel} (${suffixes.join(', ')})`;
}

// ── Test-facing internals ────────────────────────────────────────────
// Exported for unit tests only — not part of the SPA's public API.

export const __test = {
  formatOptionLabel,
  PLACEHOLDER_VALUE,
} as const;
