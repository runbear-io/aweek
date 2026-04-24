/**
 * API client for the aweek SPA dashboard.
 *
 * Thin, typed (JSDoc) fetch wrapper around the read-only JSON endpoints
 * exposed by `src/serve/server.js`. The SPA components import these
 * functions instead of calling `fetch` directly so that:
 *
 *   - URL construction is centralised (slug encoding, query strings).
 *   - Non-2xx responses throw a structured `ApiError` with the HTTP
 *     status and any server-provided `{ error }` message — components
 *     can branch on `err.status === 404` for "agent not found" UX.
 *   - Envelope unwrapping (`{ agents: [...] }` → `[...]`) happens once
 *     in one place; consumers get the payload they actually care about.
 *   - `AbortSignal` plumbing is uniform — every call accepts `{ signal }`
 *     so the SPA can cancel in-flight requests on navigation.
 *   - JSDoc typedefs double as SDK-level documentation for each shape.
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
 * @module serve/spa/lib/api-client
 */

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Status derivation shared with the terminal `/aweek:summary` baseline.
 *
 * @typedef {'active' | 'paused' | 'budget-exhausted'} AgentStatus
 */

/**
 * Date-range preset accepted by `/api/agents/:slug/logs`. Unknown values
 * are coerced to `'all'` server-side (`computeDateRangeBounds`), but we
 * narrow the public type so consumers catch typos at the IDE layer.
 *
 * @typedef {'all' | 'this-week' | 'last-7-days'} DateRangePreset
 */

/**
 * Overview-row shape returned by `GET /api/agents`.
 *
 * The `week` / `tasksTotal` / `tasksCompleted` fields give terminal
 * `/aweek:summary` parity — the Overview table shows the same week
 * context and tasks-this-week ratio the CLI does.
 *
 * @typedef {object} AgentListRow
 * @property {string} slug
 * @property {string} name
 * @property {string} description
 * @property {boolean} missing          `.claude/agents/<slug>.md` absent
 * @property {AgentStatus} status
 * @property {number} tokensUsed
 * @property {number} tokenLimit
 * @property {number | null} utilizationPct
 * @property {string} week              ISO week key (e.g. "2026-W17")
 * @property {number} tasksTotal        weekly tasks total (0 if no plan)
 * @property {number} tasksCompleted    weekly tasks completed (0 if no plan)
 */

/**
 * Detail payload returned by `GET /api/agents/:slug`.
 *
 * `systemPrompt` is the live body of `.claude/agents/<slug>.md` (everything
 * after the closing frontmatter fence). Empty string when the .md is
 * missing so the Profile tab can render a deterministic empty block
 * without null-checking.
 *
 * @typedef {object} AgentProfile
 * @property {string} slug
 * @property {string} name
 * @property {string} description
 * @property {string} systemPrompt
 * @property {boolean} missing
 * @property {string} identityPath
 * @property {string | null} createdAt
 * @property {string | null} updatedAt
 * @property {boolean} paused
 * @property {string | null} pausedReason
 * @property {string | null} periodStart
 * @property {number} tokenLimit
 * @property {number} tokensUsed
 * @property {number} remaining
 * @property {boolean} overBudget
 * @property {number | null} utilizationPct
 * @property {string} weekMonday
 */

/**
 * Single weekly-plan entry embedded in `AgentPlan.weeklyPlans`.
 * Shape mirrors `weekly-plan.schema.js` — only the fields the SPA is
 * currently known to render are typed explicitly; extra fields pass
 * through as the server emits them.
 *
 * @typedef {object} WeeklyPlan
 * @property {string} week             ISO week key, e.g. `"2026-W15"`
 * @property {boolean} approved
 * @property {string | null} [approvedAt]
 * @property {Array<object>} tasks
 */

/**
 * Plan payload returned by `GET /api/agents/:slug/plan`.
 *
 * @typedef {object} AgentPlan
 * @property {string} slug
 * @property {string} name
 * @property {boolean} hasPlan
 * @property {string} markdown               freeform plan.md body
 * @property {WeeklyPlan[]} weeklyPlans       sorted ascending by week
 * @property {WeeklyPlan | null} latestApproved
 */

/**
 * Calendar task slot metadata (day/hour placement within the plan's week).
 * Mirrors the shape emitted by `src/serve/data/calendar.js` →
 * `computeTaskSlot`. Tasks without a `runAt` (or with a `runAt` outside the
 * plan's week) carry `slot: null` and are surfaced as unscheduled.
 *
 * @typedef {object} CalendarTaskSlot
 * @property {'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun'} dayKey
 * @property {number} dayOffset   0 (Mon) … 6 (Sun)
 * @property {number} hour        0–23 (local or UTC per `AgentCalendar.timeZone`)
 * @property {number} minute      0–59
 * @property {string} iso         runAt re-serialised to ISO for stability
 */

/**
 * Calendar task row — one per weekly-plan task, with its computed slot and
 * full metadata so the grid renderer can show status icons, titles,
 * numbers, and tooltip detail without additional round-trips.
 *
 * @typedef {object} CalendarTask
 * @property {string} id
 * @property {string} title
 * @property {string | null} prompt
 * @property {string} status
 * @property {string | null} priority
 * @property {number | null} estimatedMinutes
 * @property {string | null} objectiveId
 * @property {string | null} track
 * @property {string | null} runAt
 * @property {string | null} completedAt
 * @property {string | null} delegatedTo
 * @property {CalendarTaskSlot | null} slot
 */

/**
 * Calendar payload returned by `GET /api/agents/:slug/calendar[?week]`.
 * Mirrors the `gatherAgentCalendar` return shape in `src/serve/data/calendar.js`.
 *
 * When the agent has no weekly plan yet, `noPlan === true`, `tasks === []`,
 * and `week` / `weekMonday` / `month` are `null` so the SPA can render a
 * dedicated empty state that points the user at `/aweek:plan`.
 *
 * `activityByTask` is a map from `task.id` to recent activity rows (see
 * `gatherTaskActivity`) so the grid can show per-task execution history
 * in a drawer without an extra fetch.
 *
 * @typedef {object} AgentCalendar
 * @property {string} agentId
 * @property {string | null} week             ISO week key, e.g. "2026-W17"
 * @property {string | null} month
 * @property {boolean} approved
 * @property {string} timeZone                IANA zone or `"UTC"`
 * @property {string | null} weekMonday       Monday 00:00 as ISO timestamp
 * @property {boolean} noPlan
 * @property {CalendarTask[]} tasks
 * @property {{ total: number, pending: number, inProgress: number,
 *              completed: number, failed: number, delegated: number,
 *              skipped: number, other: number }} counts
 * @property {Record<string, Array<object>>} activityByTask
 */

/**
 * Per-week usage roll-up entry embedded in `AgentUsage.weeks`.
 *
 * @typedef {object} UsageWeek
 * @property {string} weekMonday    ISO date `YYYY-MM-DD`
 * @property {number} recordCount
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} totalTokens
 * @property {number} costUsd
 */

/**
 * Usage payload returned by `GET /api/agents/:slug/usage`.
 *
 * @typedef {object} AgentUsage
 * @property {string} slug
 * @property {string} name
 * @property {boolean} missing
 * @property {boolean} paused
 * @property {string | null} pausedReason
 * @property {string} weekMonday
 * @property {number} tokenLimit
 * @property {number} tokensUsed
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} costUsd
 * @property {number} recordCount
 * @property {number} remaining
 * @property {boolean} overBudget
 * @property {number | null} utilizationPct
 * @property {UsageWeek[]} weeks
 */

/**
 * Logs payload returned by `GET /api/agents/:slug/logs`. `entries` are
 * user-facing activity rows (from `activity-log-store`). `executions`
 * are heartbeat audit rows (from `execution-store`). Each list is
 * already sorted newest-first and capped at MAX_ENTRIES on the server.
 *
 * @typedef {object} AgentLogs
 * @property {string} slug
 * @property {DateRangePreset} dateRange
 * @property {Array<object>} entries
 * @property {Array<object>} executions
 */

// ── Error type ────────────────────────────────────────────────────────

/**
 * Structured error thrown by every wrapper on a non-2xx response. Keeps
 * the HTTP status + endpoint handy so calling code can branch without
 * parsing strings.
 */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, endpoint?: string, body?: unknown }} [opts]
   */
  constructor(message, { status, endpoint, body } = {}) {
    super(message);
    this.name = 'ApiError';
    /** HTTP status code (0 for network / transport errors). */
    this.status = typeof status === 'number' ? status : 0;
    /** Endpoint that was requested, useful for debugging logs. */
    this.endpoint = endpoint || '';
    /** Parsed JSON body of the error response, if any. */
    this.body = body;
  }
}

// ── Internals ─────────────────────────────────────────────────────────

/**
 * Default fetch impl used when no override is passed. Kept as a lazy
 * reference so a missing global `fetch` (e.g. Node < 18 in tests that
 * forget to stub) fails with a clear message at call time instead of
 * module-load time.
 *
 * @returns {typeof fetch}
 */
function getDefaultFetch() {
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
 *
 * @param {unknown} slug
 * @returns {string}
 */
function assertValidSlug(slug) {
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
 *
 * @param {string} baseUrl
 * @param {string} endpoint
 * @returns {string}
 */
function joinUrl(baseUrl, endpoint) {
  if (!baseUrl) return endpoint;
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedEnd = endpoint.replace(/^\/+/, '/');
  return `${trimmedBase}${trimmedEnd.startsWith('/') ? '' : '/'}${trimmedEnd}`;
}

/**
 * Execute an HTTP GET and parse the JSON body. Throws `ApiError` on any
 * non-2xx response, extracting the server-provided `{ error }` message
 * when the body parses as JSON so the SPA can surface something better
 * than `HTTP 500`.
 *
 * @template T
 * @param {string} endpoint
 * @param {{
 *   baseUrl?: string,
 *   signal?: AbortSignal,
 *   fetch?: typeof fetch,
 *   searchParams?: Record<string, string | number | undefined | null>,
 * }} [opts]
 * @returns {Promise<T>}
 */
async function getJson(endpoint, opts = {}) {
  const { baseUrl = '', signal, fetch: fetchImpl, searchParams } = opts;
  const doFetch = fetchImpl || getDefaultFetch();

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

  let response;
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
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) throw err;
    throw new ApiError(
      `Network error fetching ${endpoint}: ${err && err.message ? err.message : err}`,
      { status: 0, endpoint },
    );
  }

  // Read body once. Some server errors ship JSON (the `{ error }`
  // envelope); transport-level failures may ship plain text. We try
  // JSON first and fall back to text to keep the error message useful.
  const text = await response.text();
  let parsed;
  let parseError = false;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    parseError = true;
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && typeof parsed.error === 'string'
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

  return /** @type {T} */ (parsed);
}

// ── Public fetch wrappers ─────────────────────────────────────────────

/**
 * `GET /api/agents` — list every agent with overview data for the
 * dashboard's Overview table.
 *
 * Server envelope `{ agents: [...], issues: [...] }` is split so
 * consumers get the rows + a companion list of per-agent load failures
 * the dashboard surfaces as an inline issues banner instead of silently
 * dropping invalid records.
 *
 * @param {{
 *   baseUrl?: string,
 *   signal?: AbortSignal,
 *   fetch?: typeof fetch,
 * }} [opts]
 * @returns {Promise<{ rows: AgentListRow[], issues: Array<{ id: string, message: string }> }>}
 */
export async function fetchAgentsList(opts = {}) {
  const body = /** @type {{ agents?: AgentListRow[], issues?: Array<{id:string,message:string}> }} */ (
    await getJson('/api/agents', opts)
  );
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
 *
 * @param {string} slug
 * @param {{
 *   baseUrl?: string,
 *   signal?: AbortSignal,
 *   fetch?: typeof fetch,
 * }} [opts]
 * @returns {Promise<AgentProfile>}
 */
export async function fetchAgentProfile(slug, opts = {}) {
  const safeSlug = assertValidSlug(slug);
  const body = /** @type {{ agent: AgentProfile }} */ (
    await getJson(`/api/agents/${encodeURIComponent(safeSlug)}`, opts)
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
 *
 * @param {string} slug
 * @param {{
 *   baseUrl?: string,
 *   signal?: AbortSignal,
 *   fetch?: typeof fetch,
 * }} [opts]
 * @returns {Promise<AgentPlan>}
 */
export async function fetchAgentPlan(slug, opts = {}) {
  const safeSlug = assertValidSlug(slug);
  const body = /** @type {{ plan: AgentPlan }} */ (
    await getJson(`/api/agents/${encodeURIComponent(safeSlug)}/plan`, opts)
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
 * `GET /api/agents/:slug/calendar[?week=YYYY-Www]` — weekly calendar
 * payload for the per-agent Calendar tab.
 *
 * When the agent exists but has no weekly plan yet, the server still
 * returns 200 with `noPlan: true` so the SPA can render a "no plan yet"
 * empty state that matches the terminal `/aweek:calendar` behaviour.
 * 404 only fires when the slug is unknown on disk.
 *
 * @param {string} slug
 * @param {{
 *   week?: string,
 *   baseUrl?: string,
 *   signal?: AbortSignal,
 *   fetch?: typeof fetch,
 * }} [opts]
 * @returns {Promise<AgentCalendar>}
 */
export async function fetchAgentCalendar(slug, opts = {}) {
  const safeSlug = assertValidSlug(slug);
  const { week, ...rest } = opts || {};
  const body = /** @type {{ calendar: AgentCalendar }} */ (
    await getJson(`/api/agents/${encodeURIComponent(safeSlug)}/calendar`, {
      ...rest,
      searchParams: { week },
    })
  );
  if (!body || typeof body !== 'object' || !body.calendar) {
    throw new ApiError('Malformed calendar payload (missing `calendar` envelope)', {
      status: 200,
      endpoint: `/api/agents/${safeSlug}/calendar`,
      body,
    });
  }
  return body.calendar;
}

/**
 * `GET /api/agents/:slug/usage` — current-week budget + historical
 * weekly roll-up for the Usage / Budget tab.
 *
 * @param {string} slug
 * @param {{
 *   baseUrl?: string,
 *   signal?: AbortSignal,
 *   fetch?: typeof fetch,
 * }} [opts]
 * @returns {Promise<AgentUsage>}
 */
export async function fetchAgentUsage(slug, opts = {}) {
  const safeSlug = assertValidSlug(slug);
  const body = /** @type {{ usage: AgentUsage }} */ (
    await getJson(`/api/agents/${encodeURIComponent(safeSlug)}/usage`, opts)
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
 * `GET /api/agents/:slug/logs[?dateRange=...]` — merged activity +
 * execution log payload for the Activity tab.
 *
 * Unknown `dateRange` values are coerced to `'all'` server-side but we
 * only accept the typed preset on our surface to keep the SPA honest.
 *
 * @param {string} slug
 * @param {{
 *   dateRange?: DateRangePreset,
 *   baseUrl?: string,
 *   signal?: AbortSignal,
 *   fetch?: typeof fetch,
 * }} [opts]
 * @returns {Promise<AgentLogs>}
 */
export async function fetchAgentLogs(slug, opts = {}) {
  const safeSlug = assertValidSlug(slug);
  const { dateRange, ...rest } = opts || {};
  const body = /** @type {{ logs: AgentLogs }} */ (
    await getJson(`/api/agents/${encodeURIComponent(safeSlug)}/logs`, {
      ...rest,
      searchParams: { dateRange },
    })
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

// ── Test-facing internals ────────────────────────────────────────────
// Exported for unit tests only — not part of the SPA's public API.

export const __test = {
  assertValidSlug,
  joinUrl,
  getJson,
};
