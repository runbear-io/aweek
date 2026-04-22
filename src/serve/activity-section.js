/**
 * Activity section — data gathering + HTML rendering for the `aweek serve`
 * dashboard's "Activity" tab.
 *
 * Reads activity-log entries from the activity-log store (one JSON file per
 * agent per week under `.aweek/agents/<slug>/logs/`) and renders them as a
 * reverse-chronological list showing agent slug, task title (description),
 * status chip, and formatted timestamp.
 *
 * The gather side (`gatherActivity`) is the data layer: it loads all
 * available weeks for the selected agent, merges the entries, sorts them
 * newest-first, and returns a view object. The render side
 * (`renderActivitySection`) is pure HTML string construction with no
 * filesystem access — matching the gather/render pattern used by
 * `calendar-section.js` and `plan-section.js`.
 *
 * Constraint (v1.1): entries come exclusively from the activity-log store.
 * The execution store is NOT merged in this version.
 */

import { join } from 'node:path';
import { listAllAgents } from '../storage/agent-helpers.js';
import { ActivityLogStore } from '../storage/activity-log-store.js';
import { readSubagentIdentity } from '../subagents/subagent-file.js';

// ---------------------------------------------------------------------------
// Date-range preset constants
// ---------------------------------------------------------------------------

/** All valid date-range preset values. */
export const DATE_RANGE_PRESETS = ['all', 'this-week', 'last-7-days'];

/** Default date-range preset used when none is supplied or the value is unknown. */
export const DEFAULT_DATE_RANGE = 'all';

/** Human-readable labels for date-range preset buttons. */
const DATE_RANGE_LABELS = {
  all: 'All time',
  'this-week': 'This week',
  'last-7-days': 'Last 7 days',
};

/**
 * Coerce an arbitrary string into a valid date-range preset key.
 * Unknown/missing values fall back to `DEFAULT_DATE_RANGE` ('all').
 *
 * @param {string | undefined} raw
 * @returns {'all' | 'this-week' | 'last-7-days'}
 */
export function resolveDateRange(raw) {
  if (typeof raw === 'string' && DATE_RANGE_PRESETS.includes(raw)) {
    return /** @type {'all' | 'this-week' | 'last-7-days'} */ (raw);
  }
  return DEFAULT_DATE_RANGE;
}

/**
 * Compute the earliest timestamp (in ms) that entries must have to be
 * included in the given date-range preset.  Returns `{ cutoff: null }` for
 * the 'all' preset (no lower bound applied).
 *
 * Uses UTC so the boundary aligns with the ISO-week convention used by the
 * activity-log store (Monday midnight UTC).
 *
 * @param {'all' | 'this-week' | 'last-7-days'} preset
 * @param {Date} [now] - Injection point for testability. Defaults to `new Date()`.
 * @returns {{ cutoff: number | null }}
 */
export function computeDateRangeBounds(preset, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (preset === 'this-week') {
    const d = new Date(nowMs);
    const utcDay = d.getUTCDay(); // 0=Sunday … 6=Saturday
    const diffToMonday = utcDay === 0 ? -6 : 1 - utcDay;
    const monday = new Date(nowMs);
    monday.setUTCDate(d.getUTCDate() + diffToMonday);
    monday.setUTCHours(0, 0, 0, 0);
    return { cutoff: monday.getTime() };
  }
  if (preset === 'last-7-days') {
    return { cutoff: nowMs - 7 * 24 * 60 * 60 * 1000 };
  }
  // 'all' — no lower bound
  return { cutoff: null };
}

/**
 * Maximum number of entries to return. Keeps the dashboard responsive
 * when an agent has years of logs on disk.
 */
const MAX_ENTRIES = 100;

/**
 * Gather the data the activity tab needs for a single request.
 *
 * Loads all log weeks for the selected agent from the activity-log store,
 * merges them into a single flat list, and sorts newest-first. Falls back
 * to the alphabetically-first agent when `selectedSlug` does not match any
 * known agent — same policy as `gatherPlans` / `gatherCalendarView`.
 *
 * Errors from the filesystem (missing logs directory, unreadable files)
 * are absorbed per-week so a single corrupt week file cannot prevent the
 * rest of the log from rendering.
 *
 * @param {object} opts
 * @param {string} opts.projectDir - Project root (contains `.aweek/`).
 * @param {string} [opts.selectedSlug] - Slug from the `?agent=` query param.
 * @param {string} [opts.dateRange] - Date-range preset: 'all' | 'this-week' | 'last-7-days'.
 *   Entries whose timestamp falls before the cutoff are excluded. Defaults to 'all'.
 * @returns {Promise<{
 *   agents: Array<{ slug: string, name: string }>,
 *   selected: {
 *     slug: string,
 *     name: string,
 *     entries: Array<object>,
 *   } | null,
 *   dateRange: string,
 * }>}
 */
export async function gatherActivity({ projectDir, selectedSlug, dateRange } = {}) {
  if (!projectDir) throw new Error('gatherActivity: projectDir is required');
  const resolvedDateRange = resolveDateRange(dateRange);
  const agentsDir = join(projectDir, '.aweek', 'agents');

  const configs = await listAllAgents({ dataDir: agentsDir });
  if (configs.length === 0) {
    return { agents: [], selected: null };
  }

  // Resolve friendly display names via the subagent identity files. Missing
  // .md files fall back to the slug — same rule as other section gatherers.
  const agents = await Promise.all(
    configs.map(async (config) => {
      const identity = await readSubagentIdentity(config.id, projectDir).catch(
        () => ({ missing: true, name: '' }),
      );
      const name = identity?.missing ? config.id : identity?.name || config.id;
      return { slug: config.id, name };
    }),
  );
  agents.sort((a, b) => a.name.localeCompare(b.name));

  const selection =
    (selectedSlug && agents.find((a) => a.slug === selectedSlug)) || agents[0];

  // Load all activity log entries for the selected agent across every
  // available week file, then merge and sort reverse-chronologically.
  const store = new ActivityLogStore(agentsDir);
  let entries = [];
  try {
    const weeks = await store.listWeeks(selection.slug);
    const perWeek = await Promise.all(
      weeks.map((week) => store.load(selection.slug, week).catch(() => [])),
    );
    entries = perWeek.flat();
  } catch {
    entries = [];
  }

  // Newest first — callers can paginate from the front.
  entries.sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
    return tb - ta;
  });

  // Apply date-range filtering before the MAX_ENTRIES cap so the cap is
  // applied to the already-filtered set rather than cutting off entries
  // that would have been within the window.
  const { cutoff } = computeDateRangeBounds(resolvedDateRange);
  if (cutoff !== null) {
    entries = entries.filter((e) => {
      const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
      return ts >= cutoff;
    });
  }

  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(0, MAX_ENTRIES);
  }

  return {
    agents,
    selected: {
      slug: selection.slug,
      name: selection.name,
      entries,
    },
    dateRange: resolvedDateRange,
  };
}

/**
 * Render the activity tab body as an HTML string.
 *
 * Produces a reverse-chronological log list with four columns per row:
 *   timestamp · agent slug · task title (description) · status chip
 *
 * Empty states return helpful messages with actionable CTAs so the
 * operator is never left staring at a blank card.
 *
 * All dynamic strings are HTML-escaped before interpolation.
 *
 * @param {ReturnType<typeof gatherActivity> extends Promise<infer R> ? R : never} view
 * @returns {string}
 */
export function renderActivitySection(view) {
  const agents = view?.agents || [];
  const selected = view?.selected || null;
  const dateRange = resolveDateRange(view?.dateRange);

  if (agents.length === 0) {
    return [
      `<div class="activity-empty" data-activity-state="no-agents">`,
      `<p>No agents yet.</p>`,
      `<p>Run <code>/aweek:hire</code> to create one and start logging activity.</p>`,
      `</div>`,
    ].join('');
  }

  if (!selected) {
    return `<div class="activity-empty" data-activity-state="no-selection">Select an agent to view their activity log.</div>`;
  }

  const entries = selected.entries || [];

  if (entries.length === 0) {
    return [
      `<div class="activity-empty" data-activity-state="no-entries">`,
      `<p>No activity logged yet for <strong>${escapeHtml(selected.name)}</strong>.</p>`,
      `<p>Entries will appear here after the first heartbeat tick runs a task.</p>`,
      `<p>Start the heartbeat with <code>/aweek:init</code> and approve a plan with <code>/aweek:plan</code>.</p>`,
      `</div>`,
    ].join('');
  }

  const rows = entries
    .map((entry) => renderActivityRow(entry))
    .join('');

  return [
    `<div class="activity-section-wrap" data-activity-wrap>`,
    renderFilterBar(dateRange),
    `<div class="activity-list" data-section="activity" data-agent-slug="${escapeAttr(selected.slug)}">`,
    rows,
    `</div>`,
    `</div>`,
    activityFilterScript(),
    activityExpandScript(),
  ].join('');
}

/**
 * Inline client-side script that wires up the per-row expand / collapse
 * affordance plus `?entry=<id>` deep-linking from the calendar drawer.
 *
 * Behavior:
 *   - A click on `.activity-row-toggle` flips `.expanded` on the
 *     surrounding `.activity-entry` and toggles the details wrapper's
 *     `hidden` attribute + `aria-expanded` on the button.
 *   - Rows whose toggle is `.is-disabled` (no details to show) are
 *     non-interactive.
 *   - On load, if the URL carries `?entry=<id>`, that entry is expanded
 *     automatically and scrolled into view so deep links from the
 *     calendar-task drawer land the user on the right row.
 *
 * @returns {string}
 */
function activityExpandScript() {
  return `<script>
(function() {
  function setExpanded(entry, expanded) {
    if (!entry) return;
    var btn = entry.querySelector('.activity-row-toggle');
    var wrap = entry.querySelector('.activity-details-wrap');
    if (!btn || !wrap || btn.classList.contains('is-disabled')) return;
    entry.classList.toggle('expanded', expanded);
    wrap.hidden = !expanded;
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  document.addEventListener('click', function(e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var btn = target.closest('.activity-row-toggle');
    if (!btn || btn.classList.contains('is-disabled')) return;
    var entry = btn.closest('.activity-entry');
    if (!entry) return;
    e.preventDefault();
    var isExpanded = entry.classList.contains('expanded');
    setExpanded(entry, !isExpanded);
  });

  // Deep-link from the calendar drawer: ?entry=<id> auto-expands and
  // scrolls the targeted row into view.
  try {
    var params = new URLSearchParams(location.search);
    var target = params.get('entry');
    if (target) {
      var match = document.querySelector('.activity-entry[data-entry-id="' + CSS.escape(target) + '"]');
      if (match) {
        setExpanded(match, true);
        match.scrollIntoView({ behavior: 'auto', block: 'center' });
      }
    }
  } catch (err) { /* ignore deep-link errors */ }
})();
</script>`;
}

/**
 * Render a single activity log row.
 *
 * Columns: formatted timestamp | agent slug | description | status chip.
 * A `.activity-details` block below the row surfaces extracted URLs
 * (clickable), token usage, exit code, and error messages when present,
 * so operators can see at a glance what artifacts the agent produced
 * without reading the raw JSON file.
 *
 * @param {object} entry - Raw activity-log entry from the store.
 * @returns {string}
 */
function renderActivityRow(entry) {
  const status = String(entry.status || 'unknown');
  // Activity-log entries store the compact task label under `title` — the
  // full prompt sent to Claude never leaks into this user-facing row.
  const title = String(entry.title || '');
  const agentId = String(entry.agentId || '');
  const timestamp = entry.timestamp ? formatTimestamp(entry.timestamp) : '—';
  const statusLabel = STATUS_LABELS[status] || status;
  const statusCls = `activity-chip activity-chip-${escapeAttr(status)}`;

  const details = renderActivityDetails(entry);
  const hasDetails = details.length > 0;
  // Entries with no details still render, but the caret / toggle is hidden
  // so users can't chase an empty expanded view.
  const toggleCls = hasDetails ? 'activity-row-toggle' : 'activity-row-toggle is-disabled';
  const entryId = String(entry.id || '');

  return [
    `<div class="activity-entry"`,
    ` data-entry-id="${escapeAttr(entryId)}"`,
    ` data-entry-status="${escapeAttr(status)}"`,
    ` data-entry-ts="${escapeAttr(entry.timestamp || '')}"`,
    ` data-has-details="${hasDetails ? '1' : '0'}">`,
    `<button type="button" class="${toggleCls}" aria-expanded="false"`,
    hasDetails ? ` aria-controls="activity-details-${escapeAttr(entryId)}"` : '',
    hasDetails ? '' : ' tabindex="-1" aria-disabled="true"',
    `>`,
    `<span class="activity-row">`,
    `<span class="activity-ts" title="${escapeAttr(entry.timestamp || '')}">${escapeHtml(timestamp)}</span>`,
    `<span class="activity-agent"><code>${escapeHtml(agentId)}</code></span>`,
    `<span class="activity-desc">${escapeHtml(title)}</span>`,
    `<span class="${statusCls}">${escapeHtml(statusLabel)}</span>`,
    hasDetails
      ? `<span class="activity-caret" aria-hidden="true">▸</span>`
      : `<span class="activity-caret activity-caret-placeholder" aria-hidden="true"></span>`,
    `</span>`,
    `</button>`,
    hasDetails
      ? `<div class="activity-details-wrap" id="activity-details-${escapeAttr(entryId)}" hidden>${details}</div>`
      : '',
    `</div>`,
  ].join('');
}

/**
 * Render the secondary detail block below an activity row. Pulls URLs and
 * file paths from `metadata.resources`, token usage from `metadata.tokenUsage`,
 * and an error message from `metadata.error` when the status is `failed`.
 * Returns an empty string when there is nothing useful to show so the row
 * stays compact for trivial entries (e.g. skipped heartbeats).
 *
 * @param {object} entry
 * @returns {string}
 */
function renderActivityDetails(entry) {
  const meta = (entry && entry.metadata) || {};
  const parts = [];

  const duration = typeof entry.duration === 'number' ? entry.duration : null;
  if (duration !== null && duration > 0) {
    parts.push(
      `<span class="activity-detail-item activity-detail-duration">` +
        `<span class="activity-detail-label">duration</span>` +
        `<span class="activity-detail-value">${escapeHtml(formatDuration(duration))}</span>` +
      `</span>`,
    );
  }

  const tokens = _pickTotalTokens(meta.tokenUsage);
  if (tokens !== null) {
    parts.push(
      `<span class="activity-detail-item activity-detail-tokens">` +
        `<span class="activity-detail-label">tokens</span>` +
        `<span class="activity-detail-value">${escapeHtml(formatNumber(tokens))}</span>` +
      `</span>`,
    );
  }

  if (meta.execution && typeof meta.execution.exitCode === 'number' && meta.execution.exitCode !== 0) {
    parts.push(
      `<span class="activity-detail-item activity-detail-exit">` +
        `<span class="activity-detail-label">exit</span>` +
        `<span class="activity-detail-value">${escapeHtml(String(meta.execution.exitCode))}</span>` +
      `</span>`,
    );
  }

  if (meta.execution && meta.execution.timedOut === true) {
    parts.push(
      `<span class="activity-detail-item activity-detail-timedout">` +
        `<span class="activity-detail-label">timed out</span>` +
      `</span>`,
    );
  }

  const urls = Array.isArray(meta.resources?.urls) ? meta.resources.urls : [];
  const urlHtml = renderUrlList(urls);
  if (urlHtml) parts.push(urlHtml);

  const files = Array.isArray(meta.resources?.filePaths) ? meta.resources.filePaths : [];
  const filesHtml = renderFileList(files);
  if (filesHtml) parts.push(filesHtml);

  if (entry && entry.status === 'failed' && meta.error && typeof meta.error.message === 'string') {
    parts.push(
      `<div class="activity-detail-error" title="${escapeAttr(meta.error.message)}">` +
        `<span class="activity-detail-label">error</span>` +
        `<span class="activity-detail-value">${escapeHtml(truncate(meta.error.message, 200))}</span>` +
      `</div>`,
    );
  }

  const execLogHtml = renderExecutionLogLink(entry);
  if (execLogHtml) parts.push(execLogHtml);

  if (parts.length === 0) return '';
  return `<div class="activity-details">${parts.join('')}</div>`;
}

/**
 * Derive the dashboard URL segment from a stored execution-log path and
 * render a "view execution log" anchor. Older executions (pre–execution
 * log feature) have no `metadata.execution.executionLogPath` field and
 * get no link.
 *
 * @param {object} entry
 * @returns {string}
 */
function renderExecutionLogLink(entry) {
  const p = entry?.metadata?.execution?.executionLogPath;
  if (typeof p !== 'string' || p.length === 0) return '';
  const agentId = entry?.agentId;
  if (typeof agentId !== 'string' || agentId.length === 0) return '';
  const baseWithExt = basename(p);
  if (!baseWithExt.endsWith('.jsonl')) return '';
  const base = baseWithExt.slice(0, -'.jsonl'.length);
  const href = `/api/executions/${encodeURIComponent(agentId)}/${encodeURIComponent(base)}`;
  return (
    `<div class="activity-detail-row activity-detail-exec-log">` +
      `<a class="activity-exec-log-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" title="Open execution log in a new tab">` +
        `view execution log` +
      `</a>` +
    `</div>`
  );
}

/**
 * Render up to MAX_URLS_SHOWN URL chips as clickable links. Remaining URLs
 * are collapsed into a "+N more" counter so the row doesn't explode when
 * an agent drops a long list of references.
 *
 * @param {string[]} urls
 * @returns {string}
 */
function renderUrlList(urls) {
  if (!Array.isArray(urls) || urls.length === 0) return '';
  const MAX_URLS_SHOWN = 5;
  const shown = urls.slice(0, MAX_URLS_SHOWN);
  const overflow = urls.length - shown.length;
  const chips = shown
    .map(
      (u) =>
        `<a class="activity-url" href="${escapeAttr(u)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(u)}">` +
        `${escapeHtml(compactUrlLabel(u))}` +
        `</a>`,
    )
    .join('');
  const more =
    overflow > 0
      ? `<span class="activity-url-more">+${overflow} more</span>`
      : '';
  return (
    `<div class="activity-detail-row activity-detail-urls">` +
      `<span class="activity-detail-label">urls</span>` +
      `<div class="activity-url-list">${chips}${more}</div>` +
    `</div>`
  );
}

/**
 * Render up to MAX_FILES_SHOWN file-path chips. No link — paths only
 * resolve inside the repo — but they're useful context when the agent
 * creates or edits files during the task.
 *
 * @param {string[]} files
 * @returns {string}
 */
function renderFileList(files) {
  if (!Array.isArray(files) || files.length === 0) return '';
  const MAX_FILES_SHOWN = 5;
  const shown = files.slice(0, MAX_FILES_SHOWN);
  const overflow = files.length - shown.length;
  const chips = shown
    .map(
      (p) =>
        `<span class="activity-file" title="${escapeAttr(p)}">${escapeHtml(basename(p))}</span>`,
    )
    .join('');
  const more =
    overflow > 0
      ? `<span class="activity-url-more">+${overflow} more</span>`
      : '';
  return (
    `<div class="activity-detail-row activity-detail-files">` +
      `<span class="activity-detail-label">files</span>` +
      `<div class="activity-url-list">${chips}${more}</div>` +
    `</div>`
  );
}

/**
 * Best-effort total token count out of an anthropic-style usage payload.
 * Returns null when the shape doesn't include an interpretable count so
 * callers can skip the detail line entirely rather than showing "0".
 *
 * @param {unknown} tokenUsage
 * @returns {number | null}
 */
function _pickTotalTokens(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return null;
  if (typeof tokenUsage.totalTokens === 'number') return tokenUsage.totalTokens;
  if (typeof tokenUsage.total === 'number') return tokenUsage.total;
  const input = typeof tokenUsage.inputTokens === 'number' ? tokenUsage.inputTokens : 0;
  const output = typeof tokenUsage.outputTokens === 'number' ? tokenUsage.outputTokens : 0;
  const cacheWrite = typeof tokenUsage.cacheCreationInputTokens === 'number' ? tokenUsage.cacheCreationInputTokens : 0;
  const cacheRead = typeof tokenUsage.cacheReadInputTokens === 'number' ? tokenUsage.cacheReadInputTokens : 0;
  const sum = input + output + cacheWrite + cacheRead;
  return sum > 0 ? sum : null;
}

/**
 * Compact label for a URL. Strips the protocol and shortens the path when
 * the full URL is longer than 50 characters so rows stay scannable.
 *
 * @param {string} url
 * @returns {string}
 */
function compactUrlLabel(url) {
  const trimmed = String(url).replace(/^https?:\/\//, '');
  if (trimmed.length <= 50) return trimmed;
  return trimmed.slice(0, 47) + '…';
}

/**
 * Last segment of a file path.
 * @param {string} path
 * @returns {string}
 */
function basename(path) {
  const str = String(path);
  const idx = str.lastIndexOf('/');
  if (idx < 0) return str;
  return str.slice(idx + 1) || str;
}

/**
 * Format milliseconds as a human-readable duration.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  const rem = Math.round(s - minutes * 60);
  return `${minutes}m ${rem}s`;
}

/**
 * Format an integer with thousands separators.
 * @param {number} n
 * @returns {string}
 */
function formatNumber(n) {
  return Number(n).toLocaleString('en-US');
}

/**
 * Truncate a string to `max` characters (plus an ellipsis when shortened).
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function truncate(s, max) {
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

/**
 * The ordered set of status values shown as filter buttons.
 * "all" is a pseudo-status meaning "show every entry".
 */
const FILTER_STATUSES = ['all', 'started', 'completed', 'failed', 'skipped', 'delegated'];

/** Human-readable labels for each filter button. */
const FILTER_LABELS = {
  all: 'All',
  started: 'Started',
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
  delegated: 'Delegated',
};

/**
 * Render the filter bar HTML.  The bar is split into two groups:
 *
 *   1. Date-range selector — "All time | This week | Last 7 days"
 *      The active preset is determined by the `dateRange` argument (server-
 *      rendered from the `?dateRange=` query param).  Each button carries
 *      `data-date-range="<preset>"` for the client-side script to target.
 *
 *   2. Status filter — "All | Started | Completed | Failed | Skipped | Delegated"
 *      The "All" status button is always active on initial render (server has
 *      already applied the date-range filter; the status filter is client-only).
 *      Each button carries `data-filter="<status>"`.
 *
 * Both groups use the same `.activity-filter-btn` / `.activity-filter-btn-active`
 * classes so they share a consistent visual style.
 *
 * @param {'all' | 'this-week' | 'last-7-days'} [dateRange='all']
 * @returns {string}
 */
function renderFilterBar(dateRange = DEFAULT_DATE_RANGE) {
  const resolvedRange = resolveDateRange(dateRange);

  const dateRangeButtons = DATE_RANGE_PRESETS.map((p) => {
    const isActive = p === resolvedRange;
    const cls = `activity-filter-btn${isActive ? ' activity-filter-btn-active' : ''}`;
    return (
      `<button class="${cls}" data-date-range="${p}" aria-pressed="${isActive ? 'true' : 'false'}">` +
      `${DATE_RANGE_LABELS[p]}</button>`
    );
  }).join('');

  const statusButtons = FILTER_STATUSES.map((s) => {
    const isAll = s === 'all';
    const cls = `activity-filter-btn${isAll ? ' activity-filter-btn-active' : ''}`;
    return (
      `<button class="${cls}" data-filter="${s}" aria-pressed="${isAll ? 'true' : 'false'}">` +
      `${FILTER_LABELS[s]}</button>`
    );
  }).join('');

  return [
    `<div class="activity-filter-bar" data-activity-filter>`,
    `<div class="activity-filter-group" data-filter-group="date-range">${dateRangeButtons}</div>`,
    `<div class="activity-filter-sep" aria-hidden="true"></div>`,
    `<div class="activity-filter-group" data-filter-group="status">${statusButtons}</div>`,
    `</div>`,
  ].join('');
}

/**
 * Inline client-side script that wires up the filter bar. Uses vanilla JS
 * (no framework) per the single-HTTP-request constraint.
 *
 * The script manages two independent filter dimensions:
 *
 *   1. **Date-range** (`[data-date-range]` buttons) — filters rows whose
 *      `data-entry-ts` attribute falls before the computed cutoff.
 *      Presets: 'all' (no cutoff), 'this-week' (since Monday UTC midnight),
 *      'last-7-days' (since now − 7 d).
 *
 *   2. **Status** (`[data-filter]` buttons) — filters rows by
 *      `data-entry-status`.  'all' is the default (show every status).
 *
 * Both filters are applied together on each click so the intersection of
 * the two selections is what remains visible.  A "no entries match" notice
 * appears when every row is hidden.
 *
 * @returns {string}
 */
function activityFilterScript() {
  return `<script>
(function() {
  document.querySelectorAll('[data-activity-wrap]').forEach(function(wrap) {
    var bar = wrap.querySelector('[data-activity-filter]');
    var list = wrap.querySelector('[data-section="activity"]');
    if (!bar || !list) return;

    // Track active selections. Date-range starts from what the server rendered
    // (read from the initially-active data-date-range button).
    var currentStatus = 'all';
    var activeDateBtn = bar.querySelector('[data-date-range][aria-pressed="true"]');
    var currentDateRange = activeDateBtn ? activeDateBtn.getAttribute('data-date-range') : 'all';

    // Compute the earliest timestamp (ms) allowed for the given preset.
    function getCutoff(preset) {
      if (preset === 'this-week') {
        var now = new Date();
        var day = now.getUTCDay(); // 0=Sun … 6=Sat
        var diff = day === 0 ? -6 : 1 - day;
        var mon = new Date(now.getTime());
        mon.setUTCDate(now.getUTCDate() + diff);
        mon.setUTCHours(0, 0, 0, 0);
        return mon.getTime();
      }
      if (preset === 'last-7-days') {
        return Date.now() - 7 * 24 * 60 * 60 * 1000;
      }
      return null; // 'all' — no lower bound
    }

    // Re-apply both filters and update the "no results" notice.
    function applyFilters() {
      var cutoff = getCutoff(currentDateRange);
      var rows = list.querySelectorAll('.activity-row');
      var visible = 0;
      for (var j = 0; j < rows.length; j++) {
        var statusOk = currentStatus === 'all' ||
          rows[j].getAttribute('data-entry-status') === currentStatus;
        var ts = rows[j].getAttribute('data-entry-ts');
        var dateOk = cutoff === null || (ts && Date.parse(ts) >= cutoff);
        var show = statusOk && dateOk;
        rows[j].style.display = show ? '' : 'none';
        if (show) visible++;
      }
      var notice = list.querySelector('.activity-filter-no-results');
      if (visible === 0) {
        if (!notice) {
          notice = document.createElement('div');
          notice.className = 'activity-filter-no-results';
          notice.textContent = 'No entries match this filter.';
          list.appendChild(notice);
        }
        notice.style.display = '';
      } else if (notice) {
        notice.style.display = 'none';
      }
    }

    bar.addEventListener('click', function(e) {
      var btn = e.target && e.target.closest
        ? e.target.closest('[data-filter],[data-date-range]')
        : null;
      if (!btn || !bar.contains(btn)) return;

      if (btn.hasAttribute('data-date-range')) {
        // Date-range group click.
        currentDateRange = btn.getAttribute('data-date-range');
        var rangeBtns = bar.querySelectorAll('[data-date-range]');
        for (var k = 0; k < rangeBtns.length; k++) {
          var ra = rangeBtns[k] === btn;
          if (ra) rangeBtns[k].classList.add('activity-filter-btn-active');
          else rangeBtns[k].classList.remove('activity-filter-btn-active');
          rangeBtns[k].setAttribute('aria-pressed', ra ? 'true' : 'false');
        }
      } else if (btn.hasAttribute('data-filter')) {
        // Status group click.
        currentStatus = btn.getAttribute('data-filter');
        var statusBtns = bar.querySelectorAll('[data-filter]');
        for (var i = 0; i < statusBtns.length; i++) {
          var sa = statusBtns[i] === btn;
          if (sa) statusBtns[i].classList.add('activity-filter-btn-active');
          else statusBtns[i].classList.remove('activity-filter-btn-active');
          statusBtns[i].setAttribute('aria-pressed', sa ? 'true' : 'false');
        }
      }

      applyFilters();
    });
  });
})();
</script>`;
}

/**
 * Human-readable labels for the activity-log status enum values.
 * Mirrors the values produced by `createLogEntry` in the store.
 */
const STATUS_LABELS = {
  started: 'started',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
  delegated: 'delegated',
};

/**
 * Format an ISO timestamp into a compact local-style label
 * (e.g. "Apr 20, 14:30"). Uses `en-US` locale for consistent
 * 24-hour output across environments.
 *
 * @param {string} iso
 * @returns {string}
 */
function formatTimestamp(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * CSS fragment for the activity section. Injected into the dashboard
 * shell's `<style>` block via `extraStyles` so this module owns its own
 * styling and the shell stays agnostic about section internals.
 *
 * @returns {string}
 */
export function activitySectionStyles() {
  return `
  /* ── Activity section ─────────────────────────────────────────────── */
  /* Filter bar */
  .activity-filter-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding-bottom: 12px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  /* Each group (date-range / status) is a flex row of buttons */
  .activity-filter-group {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    align-items: center;
  }
  /* Thin vertical separator between date-range and status groups */
  .activity-filter-sep {
    width: 1px;
    height: 18px;
    background: var(--border);
    flex-shrink: 0;
    margin: 0 2px;
  }
  .activity-filter-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 6px;
    padding: 3px 10px;
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
    line-height: 1.4;
  }
  .activity-filter-btn:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .activity-filter-btn-active {
    background: rgba(138, 180, 255, 0.12);
    border-color: var(--accent);
    color: var(--accent);
  }
  .activity-filter-no-results {
    color: var(--muted);
    font-size: 13px;
    padding: 12px 0;
  }
  .activity-list {
    display: flex;
    flex-direction: column;
  }
  .activity-entry {
    border-bottom: 1px solid var(--border);
  }
  .activity-entry:last-child { border-bottom: none; }
  /* The row toggle is a full-width button so the whole row is
     clickable. Reset the native <button> styles so it visually reads
     as a list row, not a button. */
  .activity-row-toggle {
    display: block;
    width: 100%;
    padding: 9px 0;
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
    transition: background 0.12s;
  }
  .activity-row-toggle:hover:not(.is-disabled) {
    background: rgba(138,180,255,.04);
  }
  .activity-row-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .activity-row-toggle.is-disabled {
    cursor: default;
  }
  .activity-row {
    display: grid;
    grid-template-columns: 130px 130px 1fr auto 18px;
    align-items: center;
    gap: 12px;
    font-size: 12.5px;
  }
  .activity-caret {
    color: var(--muted);
    font-size: 11px;
    transition: transform 0.15s, color 0.15s;
    display: inline-block;
    width: 12px;
    text-align: center;
    line-height: 1;
    flex-shrink: 0;
  }
  .activity-caret-placeholder { visibility: hidden; }
  .activity-entry.expanded .activity-caret {
    transform: rotate(90deg);
    color: var(--accent);
  }
  .activity-details-wrap[hidden] { display: none; }
  .activity-details-wrap {
    padding: 4px 0 10px;
  }
  .activity-details {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 14px;
    align-items: flex-start;
    margin: 6px 0 0 142px;
    font-size: 11.5px;
    color: var(--muted);
  }
  @media (max-width: 720px) {
    .activity-details { margin-left: 0; }
  }
  .activity-detail-item {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    white-space: nowrap;
  }
  .activity-detail-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
    width: 100%;
  }
  .activity-detail-label {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10px;
    color: var(--muted);
  }
  .activity-detail-value {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .activity-detail-error {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
    width: 100%;
    color: var(--status-failed);
  }
  .activity-detail-error .activity-detail-value {
    color: var(--status-failed);
    word-break: break-word;
  }
  .activity-detail-timedout {
    color: var(--high);
  }
  .activity-detail-timedout .activity-detail-label {
    color: var(--high);
  }
  .activity-url-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
    min-width: 0;
    flex: 1;
  }
  .activity-url,
  .activity-file {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--accent);
    text-decoration: none;
    max-width: 340px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .activity-url:hover { border-color: var(--accent); }
  .activity-file {
    color: var(--text);
    cursor: default;
  }
  .activity-url-more {
    font-size: 10.5px;
    color: var(--muted);
    align-self: center;
  }
  .activity-ts {
    color: var(--muted);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .activity-agent {
    flex-shrink: 0;
    overflow: hidden;
  }
  .activity-agent code {
    font-size: 11px;
    background: transparent;
    padding: 0;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
  }
  .activity-desc {
    color: var(--text);
    word-break: break-word;
    line-height: 1.4;
    min-width: 0;
  }
  /* Status chips for activity log entries */
  .activity-chip {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .activity-chip-started {
    background: rgba(107, 209, 255, 0.15);
    color: var(--status-in-progress);
    border: 1px solid rgba(107, 209, 255, 0.25);
  }
  .activity-chip-completed {
    background: rgba(114, 226, 164, 0.15);
    color: var(--status-completed);
    border: 1px solid rgba(114, 226, 164, 0.25);
  }
  .activity-chip-failed {
    background: rgba(255, 107, 107, 0.15);
    color: var(--status-failed);
    border: 1px solid rgba(255, 107, 107, 0.25);
  }
  .activity-chip-skipped {
    background: rgba(139, 147, 167, 0.15);
    color: var(--status-pending);
    border: 1px solid rgba(139, 147, 167, 0.2);
  }
  .activity-chip-delegated {
    background: rgba(138, 180, 255, 0.15);
    color: var(--accent);
    border: 1px solid rgba(138, 180, 255, 0.2);
  }
  /* Empty states */
  .activity-empty {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }
  .activity-empty p { margin: 0 0 8px; }
  .activity-empty p:last-child { margin-bottom: 0; }
  .activity-empty strong { color: var(--text); font-style: normal; }
  `;
}

// ---------------------------------------------------------------------------
// HTML escaping — local copies so this module can be tested in isolation
// without pulling server.js in (matches the pattern used by every other
// section module).
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
