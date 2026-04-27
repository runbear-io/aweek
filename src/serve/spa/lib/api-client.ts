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

// ── Test-facing internals ────────────────────────────────────────────
// Exported for unit tests only — not part of the SPA's public API.

export const __test = {
  assertValidSlug,
  joinUrl,
  getJson,
} as const;
