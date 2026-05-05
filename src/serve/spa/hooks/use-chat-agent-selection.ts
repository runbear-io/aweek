/**
 * `useChatAgentSelection` — resolve which agent the floating chat
 * panel should target right now (AC 10).
 *
 * The floating panel shows a thread for **one** agent at a time. The
 * agent is picked from three sources, in priority order:
 *
 *   1. **Explicit selection** — the user picked an agent from the
 *      panel's picker. Stored in the `ChatPanelContext` and persisted
 *      to `localStorage` (`aweek:chat-panel:agent`) so the choice
 *      survives route transitions and full page reloads.
 *   2. **URL-derived slug** — when the user is on `/agents/:slug/*`
 *      (the agent detail page) and has not yet picked an agent
 *      explicitly, the panel defaults to the agent in the URL. This
 *      gives "open chat → start typing" parity with the page they're
 *      already looking at.
 *   3. **Roster fallback** — when neither of the above applies (the
 *      user is on `/agents`, `/settings`, or any other non-detail
 *      route AND has not picked an agent), the caller can supply a
 *      `fallbackSlug` (typically the first agent in the roster) so
 *      the picker has a non-null default. When omitted the hook
 *      returns `null` and the consumer renders an empty-state.
 *
 * This hook is router-aware (it calls `useLocation`) and therefore
 * MUST be invoked inside the `<BrowserRouter>` subtree. The
 * `<ChatPanelProvider>` lives above the router (see `main.tsx`) so
 * the context is always available; `useLocation` is the constrained
 * dependency.
 *
 * URL parsing is intentionally permissive — we only care about the
 * `:slug` segment of `/agents/:slug` (and any deeper path like
 * `/agents/:slug/calendar/:taskId`). Slugs that fail validation
 * (`validateAgentSlug`) are dropped so a malformed URL can't smuggle
 * a junk slug into the chat-stream URL.
 *
 * @module serve/spa/hooks/use-chat-agent-selection
 */

import * as React from 'react';
import { useLocation } from 'react-router-dom';

import {
  useChatPanel,
  validateAgentSlug,
} from '../components/chat-panel-context.js';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract the `:slug` segment from a `/agents/:slug/*` pathname. Returns
 * `null` for any other path or when the slug fails
 * {@link validateAgentSlug}. Exported so unit tests can pin the parsing
 * contract without standing up a full router tree.
 *
 *   parseAgentSlugFromPath('/agents/writer')                 → 'writer'
 *   parseAgentSlugFromPath('/agents/writer/calendar')        → 'writer'
 *   parseAgentSlugFromPath('/agents/writer/calendar/abc123') → 'writer'
 *   parseAgentSlugFromPath('/agents')                        → null
 *   parseAgentSlugFromPath('/settings')                      → null
 *   parseAgentSlugFromPath('/agents/INVALID_SLUG!')          → null
 */
export function parseAgentSlugFromPath(pathname: string): string | null {
  if (typeof pathname !== 'string' || pathname.length === 0) return null;
  // Strip leading slashes then split on `/`. The pathname always
  // starts with `/` in react-router so `parts[0]` is the empty string
  // before the leading slash; we discard it via `.filter`.
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] !== 'agents') return null;
  const candidate = parts[1];
  if (!candidate) return null;
  // Decode in case the URL was percent-encoded (the navigator wraps
  // segments in `encodeURIComponent`); a malformed encoding throws
  // and is treated as an invalid slug.
  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return null;
  }
  return validateAgentSlug(decoded);
}

// ── Public API ───────────────────────────────────────────────────────

export interface UseChatAgentSelectionOptions {
  /**
   * Optional fallback slug used when no explicit selection has been
   * made AND the current URL does not match `/agents/:slug/*`. Pass
   * the first agent in the roster so the picker has a sensible
   * default value the moment the panel opens.
   *
   * Validated via {@link validateAgentSlug} — junk values fall back
   * to `null`.
   */
  fallbackSlug?: string | null;
}

/**
 * Source of the currently effective slug. Surfaced for the UI so the
 * picker can show subtle hints ("defaulting to current page", etc.)
 * and so tests can pin the resolution path without inferring it from
 * the slug alone.
 */
export type ChatAgentSelectionSource =
  | 'explicit'
  | 'route'
  | 'fallback'
  | 'none';

export interface UseChatAgentSelectionResult {
  /**
   * Slug currently targeted by the chat panel. `null` only when no
   * explicit selection exists, the URL is not on `/agents/:slug/*`,
   * and the caller did not supply a `fallbackSlug` — in which case
   * the consumer renders an empty-state rather than a thread.
   */
  effectiveSlug: string | null;
  /**
   * The user's explicit selection (the picker value). Distinct from
   * `effectiveSlug` so the picker can render the unselected state
   * (effectiveSlug = URL fallback) without hijacking the user's
   * intent on the next render.
   */
  selectedAgentSlug: string | null;
  /**
   * Slug parsed out of the current URL, or `null` when the user is
   * not on an agent detail route. Surfaced so the picker can render a
   * "currently viewing" hint even when the user has explicitly
   * selected a different agent.
   */
  routeAgentSlug: string | null;
  /**
   * Where {@link effectiveSlug} came from. `'explicit'` when the user
   * picked it, `'route'` when it was derived from `/agents/:slug/*`,
   * `'fallback'` when it came from the caller's `fallbackSlug`, and
   * `'none'` when no slug was resolvable.
   */
  source: ChatAgentSelectionSource;
  /**
   * Pin the panel to a specific agent. Pass `null` to clear the
   * explicit selection and let the URL / fallback take over again.
   */
  setSelectedAgentSlug: (slug: string | null) => void;
}

/**
 * React hook returning the slug the floating chat panel should
 * currently target.
 *
 * The hook composes:
 *   - the context's explicit selection,
 *   - the URL-derived slug (via `useLocation`),
 *   - and the caller-supplied fallback,
 *
 * into a single resolved `effectiveSlug` plus the metadata needed to
 * render a sensible picker UI.
 */
export function useChatAgentSelection(
  options: UseChatAgentSelectionOptions = {},
): UseChatAgentSelectionResult {
  const { fallbackSlug = null } = options;
  const { selectedAgentSlug, setSelectedAgentSlug } = useChatPanel();
  const location = useLocation();
  const pathname = location?.pathname ?? '';

  // Validate the URL-derived slug on every render; the cost is a
  // small regex match so the dep array doesn't have to thread the
  // pathname through `useMemo` for any other reason.
  const routeAgentSlug = React.useMemo(
    () => parseAgentSlugFromPath(pathname),
    [pathname],
  );

  const validatedFallback = React.useMemo(
    () => (fallbackSlug === null ? null : validateAgentSlug(fallbackSlug)),
    [fallbackSlug],
  );

  // Resolve in priority order. We DO NOT default the explicit
  // selection to the URL — keeping the explicit selection authoritative
  // means the user's pick survives navigation back to a different
  // agent's detail page.
  let effectiveSlug: string | null = null;
  let source: ChatAgentSelectionSource = 'none';
  if (selectedAgentSlug) {
    effectiveSlug = selectedAgentSlug;
    source = 'explicit';
  } else if (routeAgentSlug) {
    effectiveSlug = routeAgentSlug;
    source = 'route';
  } else if (validatedFallback) {
    effectiveSlug = validatedFallback;
    source = 'fallback';
  }

  return {
    effectiveSlug,
    selectedAgentSlug,
    routeAgentSlug,
    source,
    setSelectedAgentSlug,
  };
}

// ── Test-facing internals ────────────────────────────────────────────
// Exported for unit tests only — not part of the SPA's public API.

export const __test = {
  parseAgentSlugFromPath,
} as const;
