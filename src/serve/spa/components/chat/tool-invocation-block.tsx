/**
 * `ToolInvocationBlock` — collapsible inline renderer for a single
 * tool invocation surfaced inside the chat thread.
 *
 * Sub-AC 1 of AC 3: this component is the visual baseline for the
 * "tool-use transparency" requirement — every tool call the agent
 * makes is rendered inline next to the assistant's prose so the user
 * can see _what_ the model actually did. The block has two states:
 *
 *   - **Collapsed (default)** — only the header is visible. The header
 *     shows a small caret, the tool name (e.g. `Read`, `Bash`,
 *     `mcp__github__create_issue`), and a one-line truncated summary
 *     of the tool's argument payload so the user can skim the call
 *     without expanding it.
 *   - **Expanded** — caret rotates 90°, and a body slot is revealed
 *     beneath the header. The body is consumer-supplied (typically the
 *     full JSON args + the tool result, rendered by a sibling sub-AC)
 *     so this component stays focused on the toggle/affordance and the
 *     header summary.
 *
 * Local state only. Subsequent sub-ACs may layer a `defaultExpanded`
 * convention on top (e.g. auto-expand the active tool while it's
 * running, then collapse on completion) — `defaultExpanded` is
 * already exposed for that purpose. There is no controlled-mode prop
 * yet because the panel never needs to drive the toggle from the
 * outside in v1; tests can pass `defaultExpanded` to start in either
 * state.
 *
 * Accessibility:
 *   - The header is a real `<button type="button">` so it works with
 *     keyboard `Enter`/`Space` and shows up in the focus ring.
 *   - `aria-expanded` reflects the current state; `aria-controls`
 *     points at the body region's `id` (auto-generated via
 *     `React.useId()` so multiple blocks coexist on the page).
 *   - The chevron is `aria-hidden` — the toggle's accessible name
 *     comes from the visible tool name + summary, matching how the
 *     Claude Code CLI announces tool use.
 *
 * Visual contract — matches the rest of the chat panel chrome:
 *   - shadcn theme tokens only (`bg-muted/40`, `border-border`,
 *     `text-muted-foreground`, …) so light/dark themes pick it up
 *     automatically.
 *   - Monospace tool name so it reads as code, prose-cased summary so
 *     the args aren't a wall of brackets.
 *   - Truncation via `truncate` (CSS `text-overflow: ellipsis`) so a
 *     long argument string doesn't force the panel to scroll
 *     horizontally — the full payload lives in the expanded body.
 *
 * @module serve/spa/components/chat/tool-invocation-block
 */

import * as React from 'react';
import { AlertTriangle, ChevronRight, Loader2 } from 'lucide-react';

import { cn } from '../../lib/cn.js';

// ── Constants ─────────────────────────────────────────────────────────

/**
 * Maximum length of the truncated argument summary rendered in the
 * collapsed header. Long values are sliced and suffixed with an
 * ellipsis so the header always fits on one line; the full payload is
 * still available in the expanded body.
 *
 * Exported so tests and downstream callers can pin the exact cutoff
 * without re-deriving the heuristic.
 */
export const TOOL_INVOCATION_SUMMARY_MAX_LENGTH = 80;

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Render a single argument value into a one-line readable string.
 *
 * Strings are quoted, primitives are stringified, objects/arrays are
 * collapsed into JSON. Errors during stringify (e.g. circular refs)
 * fall back to `[object]` so the header never throws.
 */
function formatArgValue(value: unknown): string {
  if (typeof value === 'string') {
    // Strip surrounding whitespace + collapse interior newlines so
    // multi-line file contents don't blow out the header.
    const flattened = value.replace(/\s+/g, ' ').trim();
    return JSON.stringify(flattened);
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return String(value);
  }
  if (typeof value === 'undefined') {
    return 'undefined';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[object]';
  }
}

/**
 * Build the truncated args summary rendered in the collapsed header.
 *
 * Strategy:
 *   - `null` / `undefined` / non-object input → empty string (header
 *     hides the summary span entirely).
 *   - Empty object → empty string (same).
 *   - Single-key object → `{key}: {value}` so the most common case
 *     (e.g. `Read({ file_path: "..." })`) reads naturally.
 *   - Multi-key object → `{key1}: {value1}, {key2}: {value2}, …`
 *     joined by commas, in input order, capped at
 *     {@link TOOL_INVOCATION_SUMMARY_MAX_LENGTH} characters.
 *
 * The cap is applied to the joined string, not per-key, so the
 * summary always fits on one line. Truncation suffixes a single
 * Unicode ellipsis (`…`) — one character that browsers and screen
 * readers handle uniformly.
 */
export function summarizeToolArgs(
  args: unknown,
  maxLength: number = TOOL_INVOCATION_SUMMARY_MAX_LENGTH,
): string {
  if (args === null || args === undefined) return '';
  if (typeof args !== 'object') return formatArgValue(args);

  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return '';

  const joined = entries
    .map(([key, value]) => `${key}: ${formatArgValue(value)}`)
    .join(', ');

  if (joined.length <= maxLength) return joined;
  // Trim just below the limit so the ellipsis lands inside the cap.
  return `${joined.slice(0, Math.max(0, maxLength - 1))}…`;
}

// ── Body helpers ──────────────────────────────────────────────────────

/**
 * Lifecycle states the expanded body renders. Mirrors the way Claude
 * Code CLI reports tool calls inline:
 *
 *   - `pending` — the tool has been invoked but no result has arrived
 *     yet. The body shows a small spinner + "Running…" placeholder.
 *   - `success` — the tool returned cleanly. The result region renders
 *     as a neutral monospace block.
 *   - `error`   — the tool failed (threw / returned an error result).
 *     The result region renders with destructive theming and an
 *     `AlertTriangle` icon so the failure is visually distinct.
 */
export type ToolInvocationState = 'pending' | 'success' | 'error';

/**
 * Pretty-print arbitrary tool args as a 2-space indented JSON string.
 *
 *   - Returns `null` for `null` / `undefined` / non-object input so the
 *     body renderer can decide whether to show the "Arguments" section
 *     at all (a tool with no args shouldn't render an empty block).
 *   - Falls back to `'[unserialisable]'` for circular structures so
 *     the body never throws when the SDK hands us something exotic.
 */
function formatArgsAsJson(args: unknown): string | null {
  if (args === null || args === undefined) return null;
  if (typeof args !== 'object') return String(args);
  // Empty object is treated as "no args worth showing" — same UX as
  // the header summary which hides itself for `{}`.
  if (Array.isArray(args)) {
    if (args.length === 0) return null;
  } else {
    if (Object.keys(args as Record<string, unknown>).length === 0) return null;
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return '[unserialisable]';
  }
}

/**
 * Format a tool result for display. Strings pass through verbatim
 * (matches CLI behaviour — most file/shell tools already return
 * pre-formatted text); objects/arrays are pretty-printed as JSON.
 *
 * Returns an empty string for `null` / `undefined` so the caller can
 * detect "no output" and substitute placeholder copy.
 */
function formatResultAsText(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'number' || typeof result === 'boolean') {
    return String(result);
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

// ── Body component ───────────────────────────────────────────────────

export interface ToolInvocationBodyProps {
  /**
   * Same value as the parent {@link ToolInvocationBlock}'s `args` prop.
   * Pretty-printed as 2-space indented JSON inside the "Arguments"
   * section. The section is omitted entirely when args are nullish or
   * empty so the body renders cleanly for argument-less tools.
   */
  args?: unknown;
  /**
   * Lifecycle state. Defaults to `'success'` for backwards-compat with
   * callers that only pass a result and skip the explicit state.
   *
   *   - `'pending'` — show a spinner + "Running…" placeholder. The
   *     `result` prop is ignored in this state because no result has
   *     arrived yet.
   *   - `'success'` — show the formatted result in a neutral monospace
   *     block, or "(no output)" italicised muted text when the tool
   *     returned nothing.
   *   - `'error'`  — show the formatted result (or `errorMessage`) in
   *     a destructive-tinted block with an `AlertTriangle` icon.
   */
  state?: ToolInvocationState;
  /**
   * Tool result payload. Strings render verbatim; everything else is
   * pretty-printed as JSON.
   */
  result?: unknown;
  /**
   * Optional explicit error message for the `'error'` state. When
   * provided, takes precedence over `result` so callers can pin the
   * exact copy without round-tripping through the result formatter.
   */
  errorMessage?: string;
  /** className merged onto the outer wrapper. */
  className?: string;
}

/**
 * Canonical expanded body for {@link ToolInvocationBlock}. Renders two
 * stacked sections:
 *
 *   1. **Arguments** — full pretty-printed JSON of the args payload.
 *      Hidden when args are nullish / empty so argument-less tools
 *      render a result-only body.
 *   2. **Result** — state-aware: spinner for `'pending'`, neutral
 *      monospace block for `'success'`, destructive-tinted block with
 *      an `AlertTriangle` icon for `'error'`.
 *
 * Visual contract — all classes resolve to shadcn theme tokens so the
 * body re-themes automatically with light/dark, mirroring the rest of
 * the chat panel chrome.
 */
export function ToolInvocationBody({
  args,
  state = 'success',
  result,
  errorMessage,
  className,
}: ToolInvocationBodyProps): React.ReactElement {
  const argsText = formatArgsAsJson(args);
  const resultText = formatResultAsText(result);

  return (
    <div
      data-component="chat-tool-invocation-body-content"
      data-state={state}
      className={cn('flex flex-col gap-3', className)}
    >
      {argsText !== null ? (
        <section data-component="chat-tool-invocation-args">
          <h3
            data-component="chat-tool-invocation-args-label"
            className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Arguments
          </h3>
          <pre
            data-component="chat-tool-invocation-args-pre"
            className={cn(
              'overflow-x-auto whitespace-pre-wrap break-words',
              'rounded border border-border/60 bg-background/60 px-2 py-1.5',
              'font-mono text-[0.7rem] leading-snug text-foreground',
            )}
          >
            {argsText}
          </pre>
        </section>
      ) : null}

      <section
        data-component="chat-tool-invocation-result"
        data-state={state}
      >
        <h3
          data-component="chat-tool-invocation-result-label"
          className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Result
        </h3>
        {state === 'pending' ? (
          <div
            data-component="chat-tool-invocation-pending"
            role="status"
            aria-live="polite"
            className="inline-flex items-center gap-2 text-xs text-muted-foreground"
          >
            <Loader2
              className="h-3.5 w-3.5 animate-spin"
              aria-hidden="true"
            />
            <span>Running…</span>
          </div>
        ) : state === 'error' ? (
          <div
            data-component="chat-tool-invocation-error"
            role="alert"
            className={cn(
              'flex items-start gap-2',
              'rounded border border-destructive/40 bg-destructive/10',
              'px-2 py-1.5 text-destructive',
            )}
          >
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <pre
              data-component="chat-tool-invocation-error-message"
              className={cn(
                'm-0 min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words',
                'font-mono text-[0.7rem] leading-snug',
              )}
            >
              {errorMessage && errorMessage.length > 0
                ? errorMessage
                : resultText.length > 0
                  ? resultText
                  : 'Tool invocation failed.'}
            </pre>
          </div>
        ) : resultText.length > 0 ? (
          <pre
            data-component="chat-tool-invocation-success"
            className={cn(
              'overflow-x-auto whitespace-pre-wrap break-words',
              'rounded border border-border/60 bg-background/60 px-2 py-1.5',
              'font-mono text-[0.7rem] leading-snug text-foreground',
            )}
          >
            {resultText}
          </pre>
        ) : (
          <p
            data-component="chat-tool-invocation-success-empty"
            className="text-xs italic text-muted-foreground"
          >
            (no output)
          </p>
        )}
      </section>
    </div>
  );
}

// ── Public component ─────────────────────────────────────────────────

export interface ToolInvocationBlockProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'onToggle'> {
  /**
   * Display name of the tool (e.g. `Read`, `Bash`, `Edit`, or a
   * fully-qualified MCP name like `mcp__github__create_issue`).
   * Rendered verbatim in the header — callers should not pre-truncate.
   */
  name: string;
  /**
   * Tool argument payload. Typically a `Record<string, unknown>`
   * matching the JSON Schema declared by the tool, but the component
   * accepts any value so callers can pass through whatever the SDK
   * gave them (including primitives or `null` for tools with no args).
   *
   * The header renders {@link summarizeToolArgs}(args) — a one-line
   * truncated summary so the collapsed view is always single-line.
   * The full payload is consumer-rendered inside `children`.
   */
  args?: unknown;
  /**
   * Optional pre-computed summary string to render in the header
   * instead of running {@link summarizeToolArgs} on `args`. Useful
   * when the caller wants a custom format (e.g. "writing 42 lines"
   * instead of `{ file_path: …, content: … }`) or has already
   * computed the summary upstream.
   *
   * When omitted, the component derives the summary from `args`.
   * When provided, `args` is still accepted but only the explicit
   * `summary` is rendered.
   */
  summary?: string;
  /**
   * Initial expanded state. Defaults to `false` (collapsed) so the
   * thread reads as the agent's prose first and tool calls expand on
   * demand.
   */
  defaultExpanded?: boolean;
  /**
   * Body content revealed when the block is expanded. Typically the
   * full pretty-printed args JSON + the tool result rendered by a
   * sibling sub-AC. Optional — a header-only block (no `children`)
   * still toggles open/closed but the body region renders nothing.
   *
   * When `children` is omitted but any of `state` / `result` /
   * `errorMessage` is provided, the block auto-renders a default
   * {@link ToolInvocationBody} so the most common case
   * (`<ToolInvocationBlock state="success" result="…" args={…} />`)
   * stays a one-liner. Pass explicit `children` to override the
   * auto-body with custom content.
   */
  children?: React.ReactNode;
  /**
   * Optional lifecycle state — when set without explicit `children`,
   * the block auto-renders the canonical body with this state. See
   * {@link ToolInvocationState}.
   */
  state?: ToolInvocationState;
  /**
   * Optional tool result — when set without explicit `children`, the
   * block auto-renders the canonical body and shows this result. See
   * {@link ToolInvocationBody.result}.
   */
  result?: unknown;
  /**
   * Optional explicit error message — when set without explicit
   * `children`, the block auto-renders the canonical body in error
   * state with this copy. See {@link ToolInvocationBody.errorMessage}.
   */
  errorMessage?: string;
  /**
   * Optional className merged onto the outer wrapper.
   */
  className?: string;
}

/**
 * Inline tool-invocation block. See module header for the full
 * contract.
 */
export function ToolInvocationBlock({
  name,
  args,
  summary,
  defaultExpanded = false,
  children,
  state,
  result,
  errorMessage,
  className,
  ...rest
}: ToolInvocationBlockProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState<boolean>(defaultExpanded);
  const reactId = React.useId();
  const bodyId = `tool-invocation-body-${reactId}`;

  const resolvedSummary =
    typeof summary === 'string' ? summary : summarizeToolArgs(args);

  // Resolve the body slot contents.
  //
  // Priority:
  //   1. Explicit `children` always win — callers wanting a custom body
  //      (e.g. a markdown renderer for a Read result) can pass anything.
  //   2. When `state` / `result` / `errorMessage` is set without
  //      children, auto-render the canonical {@link ToolInvocationBody}
  //      so the common case stays a one-liner.
  //   3. Otherwise leave the body unrendered (header-only block).
  const explicitChildren =
    children !== undefined && children !== null && children !== false;
  const autoBodyRequested =
    state !== undefined || result !== undefined || errorMessage !== undefined;

  let bodyContent: React.ReactNode = null;
  if (explicitChildren) {
    bodyContent = children;
  } else if (autoBodyRequested) {
    const bodyProps: ToolInvocationBodyProps = { args };
    if (state !== undefined) bodyProps.state = state;
    if (result !== undefined) bodyProps.result = result;
    if (errorMessage !== undefined) bodyProps.errorMessage = errorMessage;
    bodyContent = <ToolInvocationBody {...bodyProps} />;
  }

  const hasBody = bodyContent !== null;

  return (
    <div
      data-component="chat-tool-invocation"
      data-tool-name={name}
      data-state={expanded ? 'expanded' : 'collapsed'}
      className={cn(
        'overflow-hidden rounded-md border border-border bg-muted/30 text-sm',
        className,
      )}
      {...rest}
    >
      <button
        type="button"
        data-component="chat-tool-invocation-header"
        aria-expanded={expanded}
        aria-controls={hasBody ? bodyId : undefined}
        onClick={() => setExpanded((prev) => !prev)}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left',
          'hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        )}
      >
        <ChevronRight
          aria-hidden="true"
          data-component="chat-tool-invocation-chevron"
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <span
          data-component="chat-tool-invocation-name"
          className="shrink-0 font-mono text-xs font-semibold"
        >
          {name}
        </span>
        {resolvedSummary.length > 0 ? (
          <span
            data-component="chat-tool-invocation-summary"
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            // `title` so the full untruncated string is reachable on hover
            // even when CSS ellipsizes the visible text.
            title={resolvedSummary}
          >
            {resolvedSummary}
          </span>
        ) : null}
      </button>
      {hasBody ? (
        <div
          id={bodyId}
          data-component="chat-tool-invocation-body"
          hidden={!expanded}
          className={cn(
            'border-t border-border bg-background/40 px-3 py-2 text-xs',
          )}
        >
          {bodyContent}
        </div>
      ) : null}
    </div>
  );
}

export default ToolInvocationBlock;
