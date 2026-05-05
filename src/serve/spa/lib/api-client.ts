/**
 * API client for the aweek SPA dashboard.
 *
 * Thin, typed fetch wrapper around the read-only JSON endpoints exposed
 * by `src/serve/server.js`. The SPA components import these functions
 * instead of calling `fetch` directly so that:
 *
 *   - URL construction is centralised (slug encoding, query strings).
 *   - Non-2xx responses throw a structured `ApiError` with the HTTP
 *     status and any server-provided `{ error }` message — components
 *     can branch on `err.status === 404` for "agent not found" UX.
 *   - Envelope unwrapping (`{ agents: [...] }` → `[...]`) happens once
 *     in one place; consumers get the payload they actually care about.
 *   - `AbortSignal` plumbing is uniform — every call accepts `{ signal }`
 *     so the SPA can cancel in-flight requests on navigation.
 *   - The exported request/response interfaces double as SDK-level
 *     documentation for each shape.
 *
 * Endpoints covered (matches `src/serve/server.js` + `src/serve/data/*`):
 *
 *   GET /api/agents                       → fetchAgentsList
 *   GET /api/agents/:slug                 → fetchAgentProfile
 *   GET /api/agents/:slug/plan            → fetchAgentPlan
 *   GET /api/agents/:slug/calendar[?week] → fetchAgentCalendar
 *   GET /api/agents/:slug/usage           → fetchAgentUsage
 *   GET /api/agents/:slug/logs[?dateRange]→ fetchAgentLogs
 *
 * All functions are `GET`-only and never mutate state — the SPA itself
 * is read-only per the v1 contract; writes remain in `/aweek:*` slash
 * commands.
 *
 * The `baseUrl` argument defaults to a relative `''` so the SPA can be
 * served from the same origin as the JSON endpoints (the intended
 * production topology for `aweek serve`). Tests inject a stub `fetch`
 * plus a base URL to exercise URL construction without a real HTTP stack.
 *
 * TypeScript migration note (AC 403 sub-AC 5.3):
 *   This module was promoted from `.js` (with JSDoc typedefs) → `.ts`.
 *   Every previously-`@typedef`'d shape is now a first-class `interface`
 *   or `type` alias, and every public function carries an explicit return
 *   type. Existing TS callers (the converted hooks under `../hooks/`)
 *   already pulled types via `import { type ... } from '../lib/api-client.js'`;
 *   under `moduleResolution: "Bundler"` (`tsconfig.spa.json`) those
 *   import specifiers continue to resolve to this `.ts` file with no
 *   churn at the call sites.
 *
 * @module serve/spa/lib/api-client
 */

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Status derivation shared with the terminal `/aweek:summary` baseline.
 */
export type AgentStatus = 'active' | 'paused' | 'budget-exhausted';

/**
 * Date-range preset accepted by `/api/agents/:slug/logs`. Unknown values
 * are coerced to `'all'` server-side (`computeDateRangeBounds`), but we
 * narrow the public type so consumers catch typos at the IDE layer.
 */
export type DateRangePreset = 'all' | 'this-week' | 'last-7-days';

/**
 * Day-of-week key used by the calendar grid to place a task into a
 * column. Mirrors the keys emitted by `computeTaskSlot` in
 * `src/serve/data/calendar.js`.
 */
export type CalendarDayKey =
  | 'mon'
  | 'tue'
  | 'wed'
  | 'thu'
  | 'fri'
  | 'sat'
  | 'sun';

/**
 * Per-agent load failure surfaced by `GET /api/agents` alongside the
 * successfully-loaded rows. The dashboard renders these inline as a
 * banner instead of silently dropping invalid records.
 */
export interface AgentsListIssue {
  id: string;
  message: string;
}

/**
 * Overview-row shape returned by `GET /api/agents`.
 *
 * The `week` / `tasksTotal` / `tasksCompleted` fields give terminal
 * `/aweek:summary` parity — the Overview table shows the same week
 * context and tasks-this-week ratio the CLI does.
 */
export interface AgentListRow {
  slug: string;
  name: string;
  description: string;
  /** `.claude/agents/<slug>.md` absent. */
  missing: boolean;
  status: AgentStatus;
  tokensUsed: number;
  tokenLimit: number;
  utilizationPct: number | null;
  /** ISO week key (e.g. `"2026-W17"`). */
  week: string;
  /** Weekly tasks total (0 if no plan). */
  tasksTotal: number;
  /** Weekly tasks completed (0 if no plan). */
  tasksCompleted: number;
}

/**
 * Detail payload returned by `GET /api/agents/:slug`.
 *
 * `systemPrompt` is the live body of `.claude/agents/<slug>.md`
 * (everything after the closing frontmatter fence). Empty string when
 * the .md is missing so the Profile tab can render a deterministic
 * empty block without null-checking.
 */
export interface AgentProfile {
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  missing: boolean;
  identityPath: string;
  createdAt: string | null;
  updatedAt: string | null;
  paused: boolean;
  pausedReason: string | null;
  periodStart: string | null;
  tokenLimit: number;
  tokensUsed: number;
  remaining: number;
  overBudget: boolean;
  utilizationPct: number | null;
  weekMonday: string;
}

/**
 * Single weekly-plan entry embedded in `AgentPlan.weeklyPlans`.
 * Shape mirrors `weekly-plan.schema.js` — only the fields the SPA is
 * currently known to render are typed explicitly; extra fields pass
 * through via the index signature so future server-side additions reach
 * consumers without lockstep client changes.
 */
export interface WeeklyPlan {
  /** ISO week key, e.g. `"2026-W15"`. */
  week: string;
  approved: boolean;
  approvedAt?: string | null;
  tasks: ReadonlyArray<Record<string, unknown>>;
  [key: string]: unknown;
}

/** A single strategy document returned within `AgentPlan`. */
export interface AgentStrategyEntry {
  /** Basename without extension, e.g. `"2026-W17-strategy"`. */
  name: string;
  /** Raw markdown body. */
  markdown: string;
}

/**
 * Plan payload returned by `GET /api/agents/:slug/plan`.
 */
export interface AgentPlan {
  slug: string;
  name: string;
  hasPlan: boolean;
  /** Freeform plan.md body. */
  markdown: string;
  /** Sorted ascending by week. */
  weeklyPlans: WeeklyPlan[];
  latestApproved: WeeklyPlan | null;
  /** Watchlist from `.aweek/agents/<slug>/watchlist.md`. */
  watchlist: { hasWatchlist: boolean; markdown: string };
  /** Per-strategy docs from `.aweek/agents/<slug>/strategies/*.md`. */
  strategies: AgentStrategyEntry[];
}

/**
 * Calendar task slot metadata (day/hour placement within the plan's
 * week). Mirrors the shape emitted by `src/serve/data/calendar.js` →
 * `computeTaskSlot`. Tasks without a `runAt` (or with a `runAt` outside
 * the plan's week) carry `slot: null` and are surfaced as unscheduled.
 */
export interface CalendarTaskSlot {
  dayKey: CalendarDayKey;
  /** 0 (Mon) … 6 (Sun). */
  dayOffset: number;
  /** 0–23 (local or UTC per `AgentCalendar.timeZone`). */
  hour: number;
  /** 0–59. */
  minute: number;
  /** runAt re-serialised to ISO for stability. */
  iso: string;
}

/**
 * Calendar task row — one per weekly-plan task, with its computed slot
 * and full metadata so the grid renderer can show status icons, titles,
 * numbers, and tooltip detail without additional round-trips.
 */
export interface CalendarTask {
  id: string;
  title: string;
  prompt: string | null;
  status: string;
  priority: string | null;
  estimatedMinutes: number | null;
  objectiveId: string | null;
  track: string | null;
  runAt: string | null;
  completedAt: string | null;
  delegatedTo: string | null;
  slot: CalendarTaskSlot | null;
}

/**
 * Per-status counts emitted alongside the `tasks` array so the Calendar
 * tab can render summary chips without re-iterating the list. Mirrors
 * the `counts` object in `gatherAgentCalendar`.
 */
export interface CalendarCounts {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  delegated: number;
  skipped: number;
  other: number;
}

/**
 * Calendar payload returned by `GET /api/agents/:slug/calendar[?week]`.
 * Mirrors the `gatherAgentCalendar` return shape in
 * `src/serve/data/calendar.js`.
 *
 * When the agent has no weekly plan yet, `noPlan === true`, `tasks === []`,
 * and `week` / `weekMonday` / `month` are `null` so the SPA can render a
 * dedicated empty state that points the user at `/aweek:plan`.
 *
 * `activityByTask` is a map from `task.id` to recent activity rows (see
 * `gatherTaskActivity`) so the grid can show per-task execution history
 * in a drawer without an extra fetch. Rows pass through as
 * `Record<string, unknown>` because the activity-log/execution-store
 * shapes are still authored as raw `.js` in this migration phase.
 */
export interface AgentCalendar {
  agentId: string;
  /** ISO week key, e.g. `"2026-W17"`. */
  week: string | null;
  month: string | null;
  approved: boolean;
  /** IANA zone or `"UTC"`. */
  timeZone: string;
  /** Monday 00:00 as ISO timestamp. */
  weekMonday: string | null;
  noPlan: boolean;
  /**
   * Set when the targeted weekly-plan file failed to load (schema
   * validation, JSON parse, …). The dashboard renders this as a
   * destructive banner so users can tell the difference between
   * "no plan exists" and "plan exists but the validator rejected it".
   */
  loadError: string | null;
  tasks: CalendarTask[];
  counts: CalendarCounts;
  activityByTask: Record<string, ReadonlyArray<Record<string, unknown>>>;
}

/**
 * Per-week usage roll-up entry embedded in `AgentUsage.weeks`.
 */
export interface UsageWeek {
  /** ISO date `YYYY-MM-DD`. */
  weekMonday: string;
  recordCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

/**
 * Usage payload returned by `GET /api/agents/:slug/usage`.
 */
export interface AgentUsage {
  slug: string;
  name: string;
  missing: boolean;
  paused: boolean;
  pausedReason: string | null;
  weekMonday: string;
  tokenLimit: number;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  recordCount: number;
  remaining: number;
  overBudget: boolean;
  utilizationPct: number | null;
  weeks: UsageWeek[];
}

/**
 * Logs payload returned by `GET /api/agents/:slug/logs`. `entries` are
 * user-facing activity rows (from `activity-log-store`). `executions`
 * are heartbeat audit rows (from `execution-store`). Each list is
 * already sorted newest-first and capped at MAX_ENTRIES on the server.
 *
 * Rows are intentionally typed loosely — the underlying stores remain
 * raw `.js` in this migration phase, so consumers (the Activity tab,
 * `<ActivityTimeline>`, etc.) layer their own permissive interfaces on
 * top of `Record<string, unknown>` rather than locking the wire shape.
 */
export interface AgentLogs {
  slug: string;
  dateRange: DateRangePreset;
  entries: ReadonlyArray<Record<string, unknown>>;
  executions: ReadonlyArray<Record<string, unknown>>;
}

// ── Error type ────────────────────────────────────────────────────────

/**
 * Constructor options for `ApiError`. Kept as a separate interface so
 * tests and call sites can build an explicit option bag without losing
 * the optional/`undefined` permissiveness the legacy JSDoc shape had.
 */
export interface ApiErrorOptions {
  status?: number;
  endpoint?: string;
  body?: unknown;
}

/**
 * Structured error thrown by every wrapper on a non-2xx response. Keeps
 * the HTTP status + endpoint handy so calling code can branch without
 * parsing strings.
 */
export class ApiError extends Error {
  /** HTTP status code (0 for network / transport errors). */
  public readonly status: number;

  /** Endpoint that was requested, useful for debugging logs. */
  public readonly endpoint: string;

  /** Parsed JSON body of the error response, if any. */
  public readonly body: unknown;

  constructor(message: string, opts: ApiErrorOptions = {}) {
    super(message);
    this.name = 'ApiError';
    const { status, endpoint, body } = opts;
    this.status = typeof status === 'number' ? status : 0;
    this.endpoint = endpoint ?? '';
    this.body = body;
  }
}

// ── Internals ─────────────────────────────────────────────────────────

/**
 * Public option bag every fetch wrapper accepts. The named exports below
 * extend this with endpoint-specific options (e.g. `week`, `dateRange`).
 */
export interface RequestOptions {
  baseUrl?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/**
 * Internal options accepted by `getJson`. Adds `searchParams` on top of
 * the public `RequestOptions` so endpoint wrappers can pass a typed map
 * of query-string entries without hand-rolling a `URLSearchParams`.
 */
interface GetJsonOptions extends RequestOptions {
  searchParams?: Record<string, string | number | undefined | null>;
}

/**
 * Default fetch impl used when no override is passed. Kept as a lazy
 * reference so a missing global `fetch` (e.g. Node < 18 in tests that
 * forget to stub) fails with a clear message at call time instead of
 * module-load time.
 */
function getDefaultFetch(): typeof fetch {
  if (typeof globalThis.fetch !== 'function') {
    throw new TypeError(
      'api-client: global fetch is not available. Pass { fetch } explicitly or upgrade to Node 18+ / a modern browser.',
    );
  }
  return globalThis.fetch.bind(globalThis);
}

/**
 * Validate an agent slug for safe insertion into a URL path. Server-side
 * `decodeSlug` in `src/serve/server.js` enforces the same invariants; we
 * replicate the check client-side so a bad slug never makes it onto the
 * wire (and the SPA gets a synchronous throw it can surface immediately).
 */
function assertValidSlug(slug: unknown): string {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new TypeError('api-client: slug must be a non-empty string');
  }
  if (
    slug.includes('/') ||
    slug.includes('\\') ||
    slug.includes('\0') ||
    slug === '.' ||
    slug === '..'
  ) {
    throw new TypeError(`api-client: invalid slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

/**
 * Join a base URL + endpoint path into a request URL. Collapses any
 * trailing slash on `baseUrl` and leading slash on `endpoint` so callers
 * can mix either style without producing `//api/...`.
 */
function joinUrl(baseUrl: string, endpoint: string): string {
  if (!baseUrl) return endpoint;
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedEnd = endpoint.replace(/^\/+/, '/');
  return `${trimmedBase}${trimmedEnd.startsWith('/') ? '' : '/'}${trimmedEnd}`;
}

/**
 * Narrow guard for objects carrying an optional `error: string` field —
 * matches the `{ error }` envelope `src/serve/server.js` uses on non-2xx
 * responses.
 */
function isErrorEnvelope(value: unknown): value is { error: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { error?: unknown }).error === 'string'
  );
}

/**
 * Narrow guard for caller-initiated abort errors so we can re-throw them
 * without wrapping. Matches both `AbortError` (browser/undici) and
 * `ABORT_ERR` (older Node) so SPA + tests behave identically.
 */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

/**
 * Execute an HTTP GET and parse the JSON body. Throws `ApiError` on any
 * non-2xx response, extracting the server-provided `{ error }` message
 * when the body parses as JSON so the SPA can surface something better
 * than `HTTP 500`.
 */
async function getJson<T>(endpoint: string, opts: GetJsonOptions = {}): Promise<T> {
  const { baseUrl = '', signal, fetch: fetchImpl, searchParams } = opts;
  const doFetch = fetchImpl ?? getDefaultFetch();

  let path = endpoint;
  if (searchParams && typeof searchParams === 'object') {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined || value === null || value === '') continue;
      qs.set(key, String(value));
    }
    const qsStr = qs.toString();
    if (qsStr) path += (path.includes('?') ? '&' : '?') + qsStr;
  }

  const url = joinUrl(baseUrl, path);

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (err) {
    // Abort is a legitimate caller-initiated signal — propagate as-is so
    // callers can `if (err.name === 'AbortError') return` without having
    // to unwrap an ApiError envelope.
    if (isAbortError(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ApiError(`Network error fetching ${endpoint}: ${msg}`, {
      status: 0,
      endpoint,
    });
  }

  // Read body once. Some server errors ship JSON (the `{ error }`
  // envelope); transport-level failures may ship plain text. We try
  // JSON first and fall back to text to keep the error message useful.
  const text = await response.text();
  let parsed: unknown;
  let parseError = false;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    parseError = true;
  }

  if (!response.ok) {
    const message = isErrorEnvelope(parsed)
      ? parsed.error
      : `HTTP ${response.status} ${response.statusText || ''}`.trim();
    throw new ApiError(message, {
      status: response.status,
      endpoint,
      body: parseError ? text : parsed,
    });
  }

  if (parseError) {
    throw new ApiError(`Failed to parse JSON from ${endpoint}`, {
      status: response.status,
      endpoint,
      body: text,
    });
  }

  return parsed as T;
}

// ── Public fetch wrappers ─────────────────────────────────────────────

/**
 * Wire-shape of the `GET /api/agents` envelope. Exported so
 * tests / fixtures can build a payload without re-deriving the shape.
 */
export interface AgentsListResponse {
  rows: AgentListRow[];
  issues: AgentsListIssue[];
}

/**
 * `GET /api/agents` — list every agent with overview data for the
 * dashboard's Overview table.
 *
 * Server envelope `{ agents: [...], issues: [...] }` is split so
 * consumers get the rows + a companion list of per-agent load failures
 * the dashboard surfaces as an inline issues banner instead of silently
 * dropping invalid records.
 */
export async function fetchAgentsList(
  opts: RequestOptions = {},
): Promise<AgentsListResponse> {
  const body = await getJson<{
    agents?: AgentListRow[];
    issues?: AgentsListIssue[];
  }>('/api/agents', opts);
  return {
    rows: Array.isArray(body?.agents) ? body.agents : [],
    issues: Array.isArray(body?.issues) ? body.issues : [],
  };
}

/**
 * `GET /api/agents/:slug` — detail payload for a single agent.
 *
 * Throws `ApiError` with `status: 404` when the slug does not exist, so
 * consumers can render a "not found" state without parsing the message.
 */
export async function fetchAgentProfile(
  slug: string,
  opts: RequestOptions = {},
): Promise<AgentProfile> {
  const safeSlug = assertValidSlug(slug);
  const body = await getJson<{ agent?: AgentProfile }>(
    `/api/agents/${encodeURIComponent(safeSlug)}`,
    opts,
  );
  if (!body || typeof body !== 'object' || !body.agent) {
    throw new ApiError('Malformed agent payload (missing `agent` envelope)', {
      status: 200,
      endpoint: `/api/agents/${safeSlug}`,
      body,
    });
  }
  return body.agent;
}

/**
 * `GET /api/agents/:slug/plan` — plan.md body + structured weekly plans.
 */
export async function fetchAgentPlan(
  slug: string,
  opts: RequestOptions = {},
): Promise<AgentPlan> {
  const safeSlug = assertValidSlug(slug);
  const body = await getJson<{ plan?: AgentPlan }>(
    `/api/agents/${encodeURIComponent(safeSlug)}/plan`,
    opts,
  );
  if (!body || typeof body !== 'object' || !body.plan) {
    throw new ApiError('Malformed plan payload (missing `plan` envelope)', {
      status: 200,
      endpoint: `/api/agents/${safeSlug}/plan`,
      body,
    });
  }
  return body.plan;
}

/**
 * Options accepted by `fetchAgentCalendar`.
 *
 * `week` is an ISO week key (e.g. `"2026-W17"`); when omitted, the
 * server defaults to the current week per the agent's configured zone.
 */
export interface FetchAgentCalendarOptions extends RequestOptions {
  week?: string;
}

/**
 * `GET /api/agents/:slug/calendar[?week=YYYY-Www]` — weekly calendar
 * payload for the per-agent Calendar tab.
 *
 * When the agent exists but has no weekly plan yet, the server still
 * returns 200 with `noPlan: true` so the SPA can render a "no plan yet"
 * empty state that matches the terminal `/aweek:calendar` behaviour.
 * 404 only fires when the slug is unknown on disk.
 */
export async function fetchAgentCalendar(
  slug: string,
  opts: FetchAgentCalendarOptions = {},
): Promise<AgentCalendar> {
  const safeSlug = assertValidSlug(slug);
  const { week, ...rest } = opts;
  const body = await getJson<{ calendar?: AgentCalendar }>(
    `/api/agents/${encodeURIComponent(safeSlug)}/calendar`,
    {
      ...rest,
      searchParams: { week },
    },
  );
  if (!body || typeof body !== 'object' || !body.calendar) {
    throw new ApiError(
      'Malformed calendar payload (missing `calendar` envelope)',
      {
        status: 200,
        endpoint: `/api/agents/${safeSlug}/calendar`,
        body,
      },
    );
  }
  return body.calendar;
}

/**
 * `GET /api/agents/:slug/usage` — current-week budget + historical
 * weekly roll-up for the Usage / Budget tab.
 */
export async function fetchAgentUsage(
  slug: string,
  opts: RequestOptions = {},
): Promise<AgentUsage> {
  const safeSlug = assertValidSlug(slug);
  const body = await getJson<{ usage?: AgentUsage }>(
    `/api/agents/${encodeURIComponent(safeSlug)}/usage`,
    opts,
  );
  if (!body || typeof body !== 'object' || !body.usage) {
    throw new ApiError('Malformed usage payload (missing `usage` envelope)', {
      status: 200,
      endpoint: `/api/agents/${safeSlug}/usage`,
      body,
    });
  }
  return body.usage;
}

/**
 * Options accepted by `fetchAgentLogs`.
 *
 * Unknown `dateRange` values are coerced to `'all'` server-side but we
 * only accept the typed preset on our surface to keep the SPA honest.
 */
export interface FetchAgentLogsOptions extends RequestOptions {
  dateRange?: DateRangePreset;
}

/**
 * `GET /api/agents/:slug/logs[?dateRange=...]` — merged activity +
 * execution log payload for the Activity tab.
 */
export async function fetchAgentLogs(
  slug: string,
  opts: FetchAgentLogsOptions = {},
): Promise<AgentLogs> {
  const safeSlug = assertValidSlug(slug);
  const { dateRange, ...rest } = opts;
  const body = await getJson<{ logs?: AgentLogs }>(
    `/api/agents/${encodeURIComponent(safeSlug)}/logs`,
    {
      ...rest,
      searchParams: { dateRange },
    },
  );
  if (!body || typeof body !== 'object' || !body.logs) {
    throw new ApiError('Malformed logs payload (missing `logs` envelope)', {
      status: 200,
      endpoint: `/api/agents/${safeSlug}/logs`,
      body,
    });
  }
  return body.logs;
}

/**
 * A single review entry returned by `GET /api/agents/:slug/reviews`.
 */
export interface AgentReviewEntry {
  /** Week/date key — basename without extension, e.g. `"2026-W17"`. */
  week: string;
  /** Raw markdown body. Empty string when the file is missing. */
  markdown: string;
  /** Parsed JSON metadata sidecar, or `null` when missing/unreadable. */
  metadata: Record<string, unknown> | null;
  /** `generatedAt` from metadata for convenience, or `null`. */
  generatedAt: string | null;
}

/**
 * Reviews payload returned by `GET /api/agents/:slug/reviews`.
 */
export interface AgentReviews {
  slug: string;
  /** Sorted newest-first, capped at 26 entries. */
  reviews: AgentReviewEntry[];
}

/**
 * `GET /api/agents/:slug/reviews` — review list for the Reviews tab.
 *
 * Throws `ApiError` with `status: 404` when the slug does not exist.
 */
export async function fetchAgentReviews(
  slug: string,
  opts: RequestOptions = {},
): Promise<AgentReviews> {
  const safeSlug = assertValidSlug(slug);
  const body = await getJson<{ reviews?: AgentReviews }>(
    `/api/agents/${encodeURIComponent(safeSlug)}/reviews`,
    opts,
  );
  if (!body || typeof body !== 'object' || !body.reviews) {
    throw new ApiError('Malformed reviews payload (missing `reviews` envelope)', {
      status: 200,
      endpoint: `/api/agents/${safeSlug}/reviews`,
      body,
    });
  }
  return body.reviews;
}

// ── Notification mutation wrappers ───────────────────────────────────
//
// The notification subsystem is the one place the dashboard intentionally
// relaxes the SPA's read-only HTTP contract. Two POST endpoints exist:
//
//   POST /api/notifications/:slug/:id/read  → markNotificationRead
//   POST /api/notifications/read-all        → (sibling AC)
//
// Both flow through `NotificationStore.markRead` / `markAllRead` on the
// server, which performs an atomic write-then-rename so concurrent reads
// never see a partial file.

/**
 * Single notification row mirrored from `src/storage/notification-store.ts`.
 *
 * Kept loosely typed (string `source` / `systemEvent` rather than narrow
 * unions) so the SPA-facing wire shape can absorb future schema additions
 * without requiring a lockstep update at this typedef. The fields the SPA
 * cares about today are still pinned by name + primitive type.
 */
export interface NotificationRow {
  id: string;
  agentId: string;
  source: string;
  systemEvent?: string;
  title: string;
  body: string;
  link?: unknown;
  createdAt: string;
  read: boolean;
  readAt?: string;
  sourceTaskId?: string;
  dedupKey?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Internal helper: execute an HTTP POST with an optional JSON body and
 * parse the JSON response. Mirrors `getJson`'s error semantics so the
 * SPA's mutation paths behave identically to the read paths under
 * non-2xx and abort flows.
 *
 * The optional `body` parameter (Sub-AC 4 of AC 5) lets new-thread /
 * future mutation paths POST a typed JSON envelope without re-rolling
 * the fetch plumbing each call.
 */
async function postJson<T>(
  endpoint: string,
  opts: RequestOptions = {},
  body?: unknown,
): Promise<T> {
  const { baseUrl = '', signal, fetch: fetchImpl } = opts;
  const doFetch = fetchImpl ?? getDefaultFetch();
  const url = joinUrl(baseUrl, endpoint);

  const headers: Record<string, string> = { Accept: 'application/json' };
  let bodyText: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyText = JSON.stringify(body);
  }

  let response: Response;
  try {
    const requestInit: RequestInit = {
      method: 'POST',
      headers,
      signal,
    };
    if (bodyText !== undefined) requestInit.body = bodyText;
    response = await doFetch(url, requestInit);
  } catch (err) {
    if (isAbortError(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ApiError(`Network error posting ${endpoint}: ${msg}`, {
      status: 0,
      endpoint,
    });
  }

  const text = await response.text();
  let parsed: unknown;
  let parseError = false;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    parseError = true;
  }

  if (!response.ok) {
    const message = isErrorEnvelope(parsed)
      ? parsed.error
      : `HTTP ${response.status} ${response.statusText || ''}`.trim();
    throw new ApiError(message, {
      status: response.status,
      endpoint,
      body: parseError ? text : parsed,
    });
  }

  if (parseError) {
    throw new ApiError(`Failed to parse JSON from ${endpoint}`, {
      status: response.status,
      endpoint,
      body: text,
    });
  }

  return parsed as T;
}

/**
 * `POST /api/notifications/:slug/:id/read` — flip a single notification's
 * `read` flag to `true` and stamp `readAt`.
 *
 * Idempotent: returns the unchanged row when the notification is already
 * read, so the SPA can blindly POST on every click without first checking
 * the current state. Throws `ApiError` with `status: 404` when the slug
 * has no notification with that id (allowing consumers to gracefully
 * handle a stale list view), and `status: 400` when the slug or id fails
 * the server-side path-segment guard.
 */
export async function markNotificationRead(
  slug: string,
  notificationId: string,
  opts: RequestOptions = {},
): Promise<NotificationRow> {
  const safeSlug = assertValidSlug(slug);
  if (typeof notificationId !== 'string' || notificationId.length === 0) {
    throw new TypeError(
      'api-client: notificationId must be a non-empty string',
    );
  }
  if (
    notificationId.includes('/') ||
    notificationId.includes('\\') ||
    notificationId.includes('\0') ||
    notificationId === '.' ||
    notificationId === '..'
  ) {
    throw new TypeError(
      `api-client: invalid notificationId: ${JSON.stringify(notificationId)}`,
    );
  }
  const endpoint = `/api/notifications/${encodeURIComponent(safeSlug)}/${encodeURIComponent(notificationId)}/read`;
  const body = await postJson<{ notification?: NotificationRow }>(endpoint, opts);
  if (!body || typeof body !== 'object' || !body.notification) {
    throw new ApiError(
      'Malformed mark-read payload (missing `notification` envelope)',
      {
        status: 200,
        endpoint,
        body,
      },
    );
  }
  return body.notification;
}

// ── Notifications (global feed) ──────────────────────────────────────

/**
 * Aggregated notification row returned by `GET /api/notifications`. Adds
 * the per-agent slug under `agent` (alongside the inherited `agentId`)
 * so the dashboard can preserve sender attribution when multiple agents'
 * notifications interleave in a single newest-first feed.
 */
export interface NotificationWithAgentRow extends NotificationRow {
  /** Agent slug whose feed the notification was loaded from. */
  agent: string;
}

/**
 * Wire-shape of the `GET /api/notifications` envelope. Exported so
 * tests / fixtures can build a payload without re-deriving the shape.
 *
 * `unreadCount` is intentionally derived from the *unfiltered* feed on
 * the server (see `gatherAllNotifications`), so it stays accurate when
 * the SPA narrows the visible rows by `source` / `read` / `systemEvent`.
 */
export interface AllNotificationsResponse {
  /** Reverse-chronological (newest-first) global feed across all agents. */
  notifications: NotificationWithAgentRow[];
  /** Total unread count across every agent's feed. */
  unreadCount: number;
}

/**
 * Options accepted by `fetchAllNotifications`.
 *
 * The filter set mirrors `GatherAllNotificationsOptions` on the server:
 * `source`, `systemEvent`, `read`, `limit`. Each is forwarded as a
 * `searchParams` entry; omitted values are dropped.
 */
export interface FetchAllNotificationsOptions extends RequestOptions {
  /** Filter by source (`'agent' | 'system'`). */
  source?: 'agent' | 'system';
  /** Filter by system event id. */
  systemEvent?: 'budget-exhausted' | 'repeated-task-failure' | 'plan-ready';
  /** Filter by read flag. */
  read?: boolean;
  /** Cap the response (applied after the reverse-chronological sort). */
  limit?: number;
}

/**
 * `GET /api/notifications` — global notification feed across every
 * agent. Backs the dashboard's global inbox view.
 *
 * The server-side `gatherAllNotifications` (in
 * `src/serve/data/notifications.ts`) walks every per-agent
 * `.aweek/agents/<slug>/notifications.json` file via
 * `NotificationStore.loadAll`, merges the entries newest-first, and
 * pairs them with a global `unreadCount` derived from the unfiltered
 * feed.
 */
export async function fetchAllNotifications(
  opts: FetchAllNotificationsOptions = {},
): Promise<AllNotificationsResponse> {
  const { source, systemEvent, read, limit, ...rest } = opts;
  const body = await getJson<{
    notifications?: NotificationWithAgentRow[];
    unreadCount?: number;
  }>('/api/notifications', {
    ...rest,
    searchParams: {
      source,
      systemEvent,
      // Booleans don't survive `String(value)` cleanly through the
      // `searchParams` projection (which only types string|number), so
      // explicitly project a present `read` flag to its 'true' / 'false'
      // wire form.
      read: read === undefined ? undefined : read ? 'true' : 'false',
      limit,
    },
  });
  return {
    notifications: Array.isArray(body?.notifications) ? body.notifications : [],
    unreadCount: typeof body?.unreadCount === 'number' ? body.unreadCount : 0,
  };
}

// ── Artifacts ────────────────────────────────────────────────────────

/**
 * Canonical artifact-record shape mirrored from
 * `src/storage/artifact-store.ts`. Re-declared at the api-client layer so
 * SPA consumers don't need to reach into the backend storage module to
 * import the type — the storage source uses Node-only globals (`fs`,
 * `path`) and would drag the wrong module graph into the bundler.
 *
 * Required vs. optional matches the schema's `required` array exactly.
 * Extra/forward-compatible fields pass through via the index signature so
 * server-side schema additions don't lockstep-break the SPA.
 */
export interface ArtifactRecord {
  id: string;
  agentId: string;
  taskId: string;
  filePath: string;
  fileName: string;
  type: 'document' | 'code' | 'data' | 'config' | 'report' | 'other';
  description: string;
  /** ISO-8601 datetime when the artifact was registered. */
  createdAt: string;
  /** Plan week (`YYYY-Www`) for traceability. May be absent on legacy records. */
  week?: string;
  sizeBytes?: number;
  /**
   * IANA MIME type promoted from the manifest's first-class field (see
   * `src/storage/artifact-store.ts`). Optional because legacy records
   * pre-date the `mime` schema field. SPA renderers should treat the
   * filename extension as the authoritative fallback.
   */
  mime?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Aggregate artifact counts by type, returned alongside the full list by
 * `GET /api/agents/:slug/artifacts`. Mirrors `ArtifactSummaryPayload` in
 * `src/serve/data/artifacts.ts`.
 */
export interface ArtifactSummary {
  totalArtifacts: number;
  byType: Record<string, number>;
  totalSizeBytes: number;
}

/**
 * Artifacts payload returned by `GET /api/agents/:slug/artifacts`.
 * Mirrors `AgentArtifactsPayload` in `src/serve/data/artifacts.ts`.
 *
 * `artifacts` is sorted newest-first server-side.
 */
export interface AgentArtifacts {
  slug: string;
  artifacts: ArtifactRecord[];
  summary: ArtifactSummary;
}

/**
 * `GET /api/agents/:slug/artifacts` — merged artifact list for the
 * Artifacts tab on the per-agent detail page.
 *
 * Throws `ApiError` with `status: 404` when the slug does not exist; an
 * existing agent with no artifacts yet produces a 200 with an empty
 * `artifacts` list and a zero-summary so the SPA can render its empty
 * state without parsing the message.
 */
export async function fetchAgentArtifacts(
  slug: string,
  opts: RequestOptions = {},
): Promise<AgentArtifacts> {
  const safeSlug = assertValidSlug(slug);
  const body = await getJson<{ artifacts?: AgentArtifacts }>(
    `/api/agents/${encodeURIComponent(safeSlug)}/artifacts`,
    opts,
  );
  if (!body || typeof body !== 'object' || !body.artifacts) {
    throw new ApiError(
      'Malformed artifacts payload (missing `artifacts` envelope)',
      {
        status: 200,
        endpoint: `/api/agents/${safeSlug}/artifacts`,
        body,
      },
    );
  }
  return body.artifacts;
}

/**
 * Build the URL the browser hits to stream the raw bytes of a single
 * artifact: `GET /api/agents/:slug/artifacts/:id/file`.
 *
 * Used by the inline-renderers on the SPA Artifacts tab (`<img>` for
 * images, `<iframe>` for PDFs, `<a download>` for unknown types) so URL
 * construction stays centralised — slug encoding, base-URL prefixing,
 * and the `/file` path suffix all live in one place.
 *
 * The slug is validated against the same character set the JSON
 * endpoints enforce so a malformed slug fails synchronously instead of
 * round-tripping through a 400. The artifact id is URI-encoded for the
 * same defence-in-depth reason — registered ids are UUID-shaped today,
 * but the public type permits arbitrary strings.
 *
 * @example
 *   buildArtifactFileUrl('alice', 'artifact-aaa')
 *   // → '/api/agents/alice/artifacts/artifact-aaa/file'
 */
export function buildArtifactFileUrl(
  slug: string,
  artifactId: string,
  baseUrl: string = '',
): string {
  const safeSlug = assertValidSlug(slug);
  if (typeof artifactId !== 'string' || artifactId.length === 0) {
    throw new TypeError('api-client: artifactId must be a non-empty string');
  }
  return joinUrl(
    baseUrl,
    `/api/agents/${encodeURIComponent(safeSlug)}/artifacts/${encodeURIComponent(artifactId)}/file`,
  );
}

/**
 * `GET /api/agents/:slug/artifacts/:id/file` (text body) — fetch the raw
 * UTF-8 text content of an artifact file for inline rendering.
 *
 * Backs the markdown preview path on the Artifacts tab: the SPA decodes
 * the body as UTF-8 text and feeds it into the shared `<Markdown>`
 * component (`src/serve/spa/lib/markdown.tsx`). Throws `ApiError` (status
 * carried) on non-2xx so the caller can branch on `err.status === 404`
 * for "artifact gone" UX.
 *
 * Binary types (images, PDFs, archives) should reference
 * `buildArtifactFileUrl` directly — those are loaded by the browser via
 * `<img>` / `<iframe>` / `<a download>` and don't pass through this
 * helper.
 */
export async function fetchArtifactFileText(
  slug: string,
  artifactId: string,
  opts: RequestOptions = {},
): Promise<string> {
  const { baseUrl = '', signal, fetch: fetchImpl } = opts;
  const url = buildArtifactFileUrl(slug, artifactId);
  const fullUrl = joinUrl(baseUrl, url);
  const doFetch = fetchImpl ?? getDefaultFetch();

  let response: Response;
  try {
    response = await doFetch(fullUrl, {
      method: 'GET',
      // Text-ish Accept header keeps proxies from negotiating an
      // unexpected representation. The server picks Content-Type by
      // extension regardless.
      headers: { Accept: 'text/markdown, text/plain, text/*;q=0.9, */*;q=0.5' },
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ApiError(`Network error fetching ${url}: ${msg}`, {
      status: 0,
      endpoint: url,
    });
  }

  const text = await response.text();
  if (!response.ok) {
    // Server error responses ship a JSON `{ error }` envelope; try to
    // surface that for a useful message, falling back to the raw body.
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    const message = isErrorEnvelope(parsed)
      ? parsed.error
      : `HTTP ${response.status} ${response.statusText || ''}`.trim();
    throw new ApiError(message, {
      status: response.status,
      endpoint: url,
      body: parsed,
    });
  }
  return text;
}

// ── Settings / App config ────────────────────────────────────────────

/**
 * Status of the `.aweek/config.json` file as reported by the server.
 *
 *   'ok'      — file absent (ENOENT) or valid. Defaults render silently.
 *   'missing' — file exists but is malformed JSON or has an invalid
 *               timeZone. The Settings page surfaces an inline warning.
 */
export type ConfigFileStatus = 'ok' | 'missing';

/**
 * A single display row inside a settings category.
 * Mirrors `ConfigItem` in `src/serve/data/config.ts`.
 */
export interface ConfigItem {
  /** Machine-readable identifier for this setting. */
  key: string;
  /** Human-readable label displayed in the Settings page UI. */
  label: string;
  /** Current value (string, number, or boolean). */
  value: string | number | boolean;
  /** One-sentence explanation shown as secondary text. */
  description: string;
}

/**
 * A named group of related settings shown as a card on the Settings page.
 * Mirrors `ConfigCategory` in `src/serve/data/config.ts`.
 */
export interface ConfigCategory {
  /** Stable identifier for the category. */
  id: string;
  /** Human-readable heading for the settings card. */
  label: string;
  /** Ordered list of settings rows rendered inside the card. */
  items: ConfigItem[];
}

/**
 * Full payload returned by `GET /api/config`.
 * Mirrors `AppConfigPayload` in `src/serve/data/config.ts`.
 *
 * The server sends this object directly (no outer envelope) — the
 * `status` field inside the body distinguishes config-file states so
 * the SPA can show an inline warning for `'missing'` while keeping
 * `'ok'` (including ENOENT / file absent) silent.
 */
export interface AppConfigPayload {
  status: ConfigFileStatus;
  categories: ConfigCategory[];
}

/**
 * `GET /api/config` — full read-only settings payload for the SPA
 * Settings page.
 *
 * The server always returns 200; the `status` field inside the body
 * distinguishes whether config.json is absent/valid (`'ok'`) or
 * malformed (`'missing'`).
 */
export async function fetchAppConfig(
  opts: RequestOptions = {},
): Promise<AppConfigPayload> {
  const body = await getJson<AppConfigPayload>('/api/config', opts);
  if (!body || typeof body !== 'object' || !Array.isArray(body.categories)) {
    throw new ApiError(
      'Malformed config payload (missing `categories` field)',
      { status: 200, endpoint: '/api/config', body },
    );
  }
  return body;
}

// ── Chat threads ─────────────────────────────────────────────────────
//
// AC 5 Sub-AC 3: thread-list UI. The floating chat panel's sidebar
// fetches summary rows (one per persisted conversation) so it can
// surface a selectable list above the active thread. Mutation
// endpoints (create / rename / delete) are wired in sibling sub-ACs;
// this client surface keeps the read path isolated so the list UI
// can land independently.

/**
 * Allowed roles on a persisted chat message. Mirrors
 * `ChatMessageRole` in `src/schemas/chat-conversation.ts`.
 *
 * Re-declared in the api-client layer (rather than imported from the
 * backend schema module) so SPA consumers don't drag the Node-only
 * AJV plumbing into the bundler. The string-union shape is identical
 * to the schema-of-record, and the `validateAgentSlug`-style
 * defensive narrowing on each consumer keeps the wire boundary
 * honest.
 */
export type ChatMessageRoleWire = 'user' | 'assistant';

/**
 * Lightweight summary row returned by `GET /api/agents/:slug/chat/threads`.
 *
 * Mirrors `ChatConversationSummary` in
 * `src/storage/chat-conversation-store.ts` — kept purposely narrow so
 * the thread sidebar can render without paying the cost of streaming
 * each full thread document.
 */
export interface ChatThreadSummary {
  /** Conversation id (basename of the on-disk JSON file). */
  id: string;
  /** Owning agent slug — equal to the URL slug under which it was fetched. */
  agentId: string;
  /** Optional user-editable label rendered in the sidebar. */
  title?: string;
  /** ISO-8601 datetime when the thread was created. */
  createdAt: string;
  /** ISO-8601 datetime of the last write (any append or title edit). */
  updatedAt: string;
  /** Total message count (user + assistant turns). */
  messageCount: number;
  /** Truncated content of the most recent message (≤ 200 chars). */
  lastMessagePreview?: string;
  /** Role of the most recent message — handy for sidebar icons. */
  lastMessageRole?: ChatMessageRoleWire;
}

/**
 * Wire-shape of the `GET /api/agents/:slug/chat/threads` envelope.
 * Exported so tests / fixtures can build a payload without re-deriving
 * the shape.
 *
 * The response carries the agent's slug back so a stale list returned
 * after a rapid re-target can be detected by the consumer (the slug
 * mismatches what the request was sent for).
 */
export interface AgentThreadsResponse {
  agentId: string;
  /** Sorted newest-updated-first server-side. */
  threads: ChatThreadSummary[];
}

/**
 * Single tool-invocation block embedded in a persisted chat message.
 * Mirrors `ChatToolBlock` in `src/schemas/chat-conversation.ts` —
 * re-declared at the api-client layer so SPA consumers don't pull in
 * the Node-only AJV schema module through the bundler.
 */
export interface ChatToolBlockWire {
  toolUseId: string;
  toolName: string;
  args: Record<string, unknown>;
  state: 'pending' | 'success' | 'error';
  result?: unknown;
  errorMessage?: string;
}

/**
 * Single message inside a persisted chat thread. Mirrors `ChatMessage`
 * in `src/schemas/chat-conversation.ts`. Re-declared at the SPA layer
 * for the same reason as {@link ChatThreadSummary} — keep the bundler
 * graph clean.
 */
export interface ChatMessageWire {
  id: string;
  role: ChatMessageRoleWire;
  content: string;
  createdAt: string;
  tools?: ChatToolBlockWire[];
  metadata?: Record<string, unknown>;
}

/**
 * Full chat thread document returned by
 * `GET /api/agents/:slug/chat/threads/:threadId`. Mirrors
 * `ChatConversation` in `src/schemas/chat-conversation.ts`.
 *
 * Sub-AC 4 of AC 5: backs the thread-switching behaviour in the
 * floating panel — the SPA fetches one of these and seeds the
 * `<ChatThread>`'s `initialMessages` with the persisted history so the
 * conversation reappears across navigation and browser sessions.
 */
export interface ChatThreadDocument {
  id: string;
  agentId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessageWire[];
  metadata?: Record<string, unknown>;
}

/**
 * `GET /api/agents/:slug/chat/threads/:threadId` — return one chat
 * thread end-to-end with its full message history.
 *
 * Throws `ApiError` with `status: 404` when either the slug or the
 * thread id does not exist on disk; the dashboard reads its
 * surrounding state to decide which copy to render (e.g. "thread was
 * deleted" vs "agent gone").
 */
export async function fetchAgentThread(
  slug: string,
  threadId: string,
  opts: RequestOptions = {},
): Promise<ChatThreadDocument> {
  const safeSlug = assertValidSlug(slug);
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new TypeError('api-client: threadId must be a non-empty string');
  }
  if (
    threadId.includes('/') ||
    threadId.includes('\\') ||
    threadId.includes('\0') ||
    threadId === '.' ||
    threadId === '..'
  ) {
    throw new TypeError(
      `api-client: invalid threadId: ${JSON.stringify(threadId)}`,
    );
  }
  const endpoint = `/api/agents/${encodeURIComponent(safeSlug)}/chat/threads/${encodeURIComponent(threadId)}`;
  const body = await getJson<{ thread?: ChatThreadDocument }>(endpoint, opts);
  if (!body || typeof body !== 'object' || !body.thread) {
    throw new ApiError(
      'Malformed thread payload (missing `thread` envelope)',
      { status: 200, endpoint, body },
    );
  }
  return body.thread;
}

/**
 * Options accepted by {@link createAgentThread}.
 */
export interface CreateAgentThreadOptions extends RequestOptions {
  /** Optional user-editable label rendered in the sidebar. */
  title?: string;
  /** Optional forward-compatible metadata bag. */
  metadata?: Record<string, unknown>;
}

/**
 * `POST /api/agents/:slug/chat/threads` — create a new (empty) chat
 * thread for an agent (Sub-AC 4 of AC 5).
 *
 * The server auto-stamps the conversation id (`chat-<hex>`) and the
 * `createdAt` / `updatedAt` timestamps. Returns the persisted document
 * so the SPA can immediately set it as the active thread without a
 * follow-up list refresh.
 *
 * Throws `ApiError` with `status: 404` when the agent slug does not
 * exist; 400 when the body fails validation server-side.
 */
export async function createAgentThread(
  slug: string,
  opts: CreateAgentThreadOptions = {},
): Promise<ChatThreadDocument> {
  const safeSlug = assertValidSlug(slug);
  const { title, metadata, ...rest } = opts;
  const endpoint = `/api/agents/${encodeURIComponent(safeSlug)}/chat/threads`;
  // Build a minimal POST body — only forward fields the caller set so
  // the server's optional-field paths stay clean.
  const requestBody: { title?: string; metadata?: Record<string, unknown> } = {};
  if (typeof title === 'string' && title.length > 0) {
    requestBody.title = title;
  }
  if (metadata !== undefined) {
    requestBody.metadata = metadata;
  }
  const body = await postJson<{ thread?: ChatThreadDocument }>(
    endpoint,
    rest,
    requestBody,
  );
  if (!body || typeof body !== 'object' || !body.thread) {
    throw new ApiError(
      'Malformed create-thread payload (missing `thread` envelope)',
      { status: 200, endpoint, body },
    );
  }
  return body.thread;
}

/**
 * `GET /api/agents/:slug/chat/threads` — list every chat thread for a
 * single agent. Backs the floating chat panel's thread sidebar
 * (Sub-AC 3 of AC 5).
 *
 * Throws `ApiError` with `status: 404` when the slug does not exist on
 * disk, matching the same convention every other per-agent gatherer
 * uses. An existing agent with no threads yet produces 200 with an
 * empty `threads` list so the SPA can render its "No conversations
 * yet" empty state without parsing the message.
 */
export async function fetchAgentThreads(
  slug: string,
  opts: RequestOptions = {},
): Promise<AgentThreadsResponse> {
  const safeSlug = assertValidSlug(slug);
  const body = await getJson<{
    agentId?: string;
    threads?: ChatThreadSummary[];
  }>(
    `/api/agents/${encodeURIComponent(safeSlug)}/chat/threads`,
    opts,
  );
  if (!body || typeof body !== 'object' || !Array.isArray(body.threads)) {
    throw new ApiError(
      'Malformed threads payload (missing `threads` envelope)',
      {
        status: 200,
        endpoint: `/api/agents/${safeSlug}/chat/threads`,
        body,
      },
    );
  }
  return {
    agentId: typeof body.agentId === 'string' ? body.agentId : safeSlug,
    threads: body.threads,
  };
}

// ── Test-facing internals ────────────────────────────────────────────
// Exported for unit tests only — not part of the SPA's public API.

export const __test = {
  assertValidSlug,
  joinUrl,
  getJson,
  postJson,
} as const;
