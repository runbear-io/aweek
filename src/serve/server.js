/**
 * aweek serve — local HTTP dashboard.
 *
 * Entry point for the `aweek serve` subcommand. Launches a lightweight
 * HTTP server that renders a read-only dashboard over live data read
 * from the `.aweek/` folder on each request.
 *
 * Sub-AC 2 wires up the HTTP server skeleton: it binds to the configured
 * host/port, serves a root dashboard HTML shell at `GET /`, and returns
 * a startup result with the resolved URL. Later sub-ACs add the data
 * endpoints (agents, calendar, plan, budget) that the shell will hydrate
 * from. The HTML shell ships with the reference dark-theme tokens so the
 * look-and-feel is in place from day one; section bodies are intentionally
 * placeholder until the data routes land.
 */

import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { platform as nodePlatform } from 'node:process';
import { networkInterfaces as nodeNetworkInterfaces } from 'node:os';
import { readTranscriptLines } from '../storage/transcript-store.js';
import { formatTranscriptLine } from './transcript-formatter.js';
import {
  buildTranscriptSummary,
  parseRawTranscript,
  renderTranscriptSummaryHtml,
} from './transcript-summary.js';
import {
  MISSING_AWEEK_DIR_CODE,
  createNoAweekDirError,
  formatNoAweekDirMessage,
  isNoAweekDirError,
} from './errors.js';
import { gatherAgents, agentsSectionStyles } from './agents-section.js';
import { renderSidebar, sidebarStyles } from './sidebar-section.js';
import { renderTabBar, tabBarStyles, resolveActiveTab } from './tabs-section.js';
import {
  gatherActivity,
  renderActivitySection,
  activitySectionStyles,
} from './activity-section.js';
import {
  gatherBudget,
  renderBudgetSection,
  budgetSectionStyles,
} from './budget-section.js';
import {
  gatherPlans,
  renderPlanSection,
  planSectionStyles,
} from './plan-section.js';
import {
  renderStrategySection,
  strategySectionStyles,
} from './strategy-section.js';
import {
  gatherProfile,
  renderProfileSection,
  profileSectionStyles,
} from './profile-section.js';
import {
  gatherCalendar,
  gatherCalendarView,
  renderCalendarSection,
  calendarSectionStyles,
} from './calendar-section.js';

// Re-export the friendly-error surface so callers that already import
// from `./server.js` (CLI layer, tests) don't need to reach into the
// submodule. Keeps the public surface of the serve module cohesive.
export {
  MISSING_AWEEK_DIR_CODE,
  createNoAweekDirError,
  formatNoAweekDirMessage,
  isNoAweekDirError,
};

/** Default port when `--port` is not provided. */
export const DEFAULT_PORT = 3000;

/** Default bind host: `0.0.0.0` so the dashboard is reachable on the LAN. */
export const DEFAULT_HOST = '0.0.0.0';

/**
 * Maximum number of port increments to try when the requested port is
 * already in use. Successive attempts use port + 1, port + 2, ... up to
 * this cap before giving up.
 */
export const PORT_SCAN_LIMIT = 20;

/**
 * Hosts that should not be surfaced verbatim in the user-facing URL. A
 * `0.0.0.0` (or `::`) bind means "all interfaces"; the user-reachable
 * address on the local machine is `localhost`. We display that instead
 * and print the LAN hint separately (see bin/aweek.js).
 */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '::0']);

/**
 * A bound host is "wildcard" — i.e. the server actually accepts
 * connections on every interface, so the LAN should be able to reach
 * it — when the user (or default config) passed `0.0.0.0` or an IPv6
 * equivalent. Exposed as a helper so both `startServer` consumers and
 * the CLI layer stay in sync about what "LAN-reachable" means.
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isWildcardHost(host) {
  return WILDCARD_HOSTS.has(host);
}

/**
 * Normalise and validate CLI flags for `aweek serve`. Returns an options
 * object with sensible defaults applied and invalid inputs coerced into
 * errors with `code: 'EUSAGE'` so the CLI prints a clean usage message.
 *
 * @param {object} raw
 * @param {number|string} [raw.port]
 * @param {string} [raw.host]
 * @param {boolean} [raw.open]
 * @param {string} [raw.projectDir]
 * @returns {{ port: number, host: string, open: boolean, projectDir: string }}
 */
export function normaliseServeOptions(raw = {}) {
  const projectDir = raw.projectDir ? resolve(raw.projectDir) : process.cwd();

  let port = DEFAULT_PORT;
  if (raw.port !== undefined && raw.port !== null && raw.port !== '') {
    const parsed = typeof raw.port === 'number' ? raw.port : Number.parseInt(String(raw.port), 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw Object.assign(new Error(`Invalid --port value: ${raw.port}`), {
        code: 'EUSAGE',
      });
    }
    port = parsed;
  }

  const host = typeof raw.host === 'string' && raw.host.length > 0 ? raw.host : DEFAULT_HOST;
  const open = raw.open !== false; // default true; `--no-open` sets false

  return { port, host, open, projectDir };
}

/**
 * Build the user-facing URL for the dashboard. Wildcard bind hosts
 * (`0.0.0.0`, `::`) are displayed as `localhost` since that is what the
 * user should actually click; the LAN address is surfaced separately
 * by the CLI layer.
 *
 * @param {string} host
 * @param {number} port
 * @returns {string}
 */
export function formatDashboardUrl(host, port) {
  const displayHost = WILDCARD_HOSTS.has(host) ? 'localhost' : host;
  // IPv6 literal hosts need square brackets in URLs.
  const bracketed = displayHost.includes(':') ? `[${displayHost}]` : displayHost;
  return `http://${bracketed}:${port}/`;
}

/**
 * Start the dashboard HTTP server.
 *
 * Binds the HTTP server to the configured host/port (with port
 * auto-increment on EADDRINUSE), performs a `.aweek/` sanity check, and
 * returns a handle with the resolved URL, the bound port/host, the raw
 * server instance, and a `close()` helper. The returned `url` uses
 * `localhost` when the bind host is a wildcard (`0.0.0.0`/`::`) so it is
 * directly clickable by the user; callers that want the raw bind host
 * can read `host` from the result.
 *
 * Later sub-ACs attach the full dashboard router; for now the server
 * serves a read-only HTML shell at `GET /` with the four target sections
 * stubbed out, plus a health check at `GET /healthz` and a 404 for all
 * other paths.
 *
 * @param {object} [options] — see `normaliseServeOptions` for shape
 * @returns {Promise<{ server: import('node:http').Server, port: number, host: string, url: string, projectDir: string, close: () => Promise<void> }>}
 */
export async function startServer(options = {}) {
  const { port, host, projectDir } = normaliseServeOptions(options);

  const dataDir = resolve(projectDir, '.aweek');
  if (!existsSync(dataDir)) {
    // Delegate to the shared error factory (see ./errors.js) so the
    // thrown shape (code, dataDir, projectDir, message) stays in lockstep
    // with the CLI's friendly renderer.
    throw createNoAweekDirError(dataDir);
  }

  const server = createServer((req, res) => {
    // Promise-returning handler: swallow rejections so a single request
    // error cannot crash the process. Emit a plain-text 500 when the
    // headers have not already been sent so the user sees something
    // actionable rather than a broken pipe.
    Promise.resolve(handleRequest(req, res, { projectDir, dataDir })).catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(`Internal Server Error: ${err && err.message ? err.message : err}\n`);
      } else {
        try {
          res.end();
        } catch {
          // connection may already be closed — nothing to recover
        }
      }
    });
  });
  const boundPort = await listenWithRetry(server, port, host, PORT_SCAN_LIMIT);
  const url = formatDashboardUrl(host, boundPort);

  return {
    server,
    port: boundPort,
    host,
    url,
    projectDir,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

/**
 * Request router. Sub-AC 2 only wires up the shell route and a health
 * check; later sub-ACs will register JSON endpoints for the four
 * dashboard sections. All handlers re-read `.aweek/` on every request
 * so the dashboard reflects live state without a server restart.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ projectDir: string, dataDir: string }} ctx
 */
async function handleRequest(req, res, ctx) {
  const method = req.method || 'GET';
  const rawUrl = req.url || '/';
  const pathname = rawUrl.split('?')[0];

  if (method !== 'GET' && method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Method Not Allowed');
    return;
  }

  if (pathname === '/healthz') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, projectDir: ctx.projectDir }));
    return;
  }

  // JSON data endpoint: one agent's current-week calendar / task list.
  // Path shape: `/api/agents/<slug>/calendar`. The slug is URL-decoded so
  // plugin-prefixed agent ids (e.g. `oh-my-claudecode-writer`) and any
  // non-ASCII slugs round-trip correctly. `?week=YYYY-Www` overrides the
  // default "current week" resolution so the dashboard can paginate
  // without a separate endpoint.
  // Execution transcript endpoint.
  // Path shape: `/api/executions/<agent-slug>/<basename>` where basename is
  // `<taskId>-<executionId>` — the filename stem the heartbeat writes under
  // `.aweek/agents/<slug>/executions/`. Returns a formatted plain-text
  // transcript (one or more lines per stream-json event) so users can
  // read, tail, or grep the session from a browser.
  const transcriptMatch = /^\/api\/executions\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (transcriptMatch) {
    const slug = safeDecode(transcriptMatch[1]);
    const basename = safeDecode(transcriptMatch[2]);
    await handleTranscriptRequest(req, res, {
      projectDir: ctx.projectDir,
      agentId: slug,
      basename,
    });
    return;
  }

  // Human-readable execution summary page.
  // Path shape: `/executions/<agent-slug>/<basename>`. Parses the same
  // JSONL the `/api/executions/...` endpoint streams, but renders a
  // progressive-disclosure HTML view: headline + final output +
  // permission denials + per-turn timeline up top, full raw JSON
  // collapsed at the bottom. The raw endpoint remains available for
  // curl / grep / tail workflows.
  const summaryMatch = /^\/executions\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (summaryMatch) {
    const slug = safeDecode(summaryMatch[1]);
    const basename = safeDecode(summaryMatch[2]);
    await handleTranscriptSummaryRequest(req, res, {
      projectDir: ctx.projectDir,
      agentId: slug,
      basename,
    });
    return;
  }

  const calendarMatch = /^\/api\/agents\/([^/]+)\/calendar\/?$/.exec(pathname);
  if (calendarMatch) {
    const slug = safeDecode(calendarMatch[1]);
    const query = parseQuery(rawUrl);
    const payload = await gatherCalendar({
      projectDir: ctx.projectDir,
      agentId: slug,
      week: query.week,
    });
    if (payload && payload.notFound) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Agent not found', agentId: slug }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    // Pull the currently-selected agent from the query string. The plan
    // section (and future calendar section) honour `?agent=<slug>` so
    // users can deep-link to a specific agent. `URL` wants a base, so
    // we give it a dummy one — only `searchParams` is consumed.
    const url = new URL(rawUrl, 'http://localhost');
    const selectedSlug = url.searchParams.get('agent') || undefined;
    const activeTab = url.searchParams.get('tab') || undefined;

    // Re-read `.aweek/` on every request so the dashboard reflects live
    // state without a server restart. Each section gatherer is awaited in
    // parallel so a slow filesystem read on one card does not serialize
    // the others. Each gatherer also absorbs its own errors into an empty
    // list so a single broken section cannot knock the whole dashboard
    // offline — read-only tooling must prefer "degraded" over "500".
    const calendarWeek = url.searchParams.get('week') || undefined;
    const dateRange = url.searchParams.get('dateRange') || undefined;
    const resolvedActiveTab = resolveActiveTab(activeTab);
    const [agents, budget, plans, calendarView, activityView, profileView] = await Promise.all([
      gatherAgents({ projectDir: ctx.projectDir }).catch(() => []),
      gatherBudget({ projectDir: ctx.projectDir }).catch(() => []),
      gatherPlans({ projectDir: ctx.projectDir, selectedSlug }).catch(() => ({
        agents: [],
        selected: null,
      })),
      gatherCalendarView({
        projectDir: ctx.projectDir,
        selectedSlug,
        week: calendarWeek,
      }).catch(() => ({ agents: [], selected: null })),
      // Activity log is only fetched when the activity tab is active to
      // avoid unnecessary filesystem reads on every request.
      resolvedActiveTab === 'activity'
        ? gatherActivity({ projectDir: ctx.projectDir, selectedSlug, dateRange }).catch(() => ({
            agents: [],
            selected: null,
          }))
        : Promise.resolve(null),
      // Profile data is only fetched when the profile tab is active.
      resolvedActiveTab === 'profile'
        ? gatherProfile({ projectDir: ctx.projectDir, selectedSlug }).catch(() => ({
            agents: [],
            selected: null,
          }))
        : Promise.resolve(null),
    ]);

    const html = renderDashboardShell({
      zeroAgents: agents.length === 0,
      projectDir: ctx.projectDir,
      sidebar: renderSidebar(agents, selectedSlug),
      tabBar: renderTabBar(selectedSlug, activeTab),
      activeTab: resolvedActiveTab,
      sections: {
        budget: renderBudgetSection(budget),
        plan: renderPlanSection(plans),
        calendar: renderCalendarSection(calendarView),
        activity: activityView ? renderActivitySection(activityView) : '',
        strategy: renderStrategySection(plans),
        profile: profileView ? renderProfileSection(profileView) : '',
      },
      extraStyles:
        sidebarStyles() +
        agentsSectionStyles() +
        budgetSectionStyles() +
        planSectionStyles() +
        calendarSectionStyles() +
        tabBarStyles() +
        activitySectionStyles() +
        strategySectionStyles() +
        profileSectionStyles(),
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(html);
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(`Not found: ${pathname}\n`);
}

/**
 * Render the dashboard HTML shell. The shell is self-contained (no
 * external network requests), ships the reference dark-theme CSS
 * tokens, and lays out the four target sections as cards:
 *
 *   1. Agents         — list with status
 *   2. Calendar       — weekly calendar / task list per agent
 *   3. Plan           — rendered plan.md
 *   4. Budget / Usage — usage with over-budget highlighting
 *
 * Sections not present in `ctx.sections` render a "will appear here"
 * placeholder so this function remains callable in isolation (used by
 * the shell snapshot test and by any future static-export mode).
 *
 * @param {{
 *   projectDir: string,
 *   sections?: {
 *     agents?: string,
 *     calendar?: string,
 *     plan?: string,
 *     budget?: string,
 *   },
 *   extraStyles?: string,
 * }} ctx
 * @returns {string}
 */
export function renderDashboardShell({
  projectDir,
  sidebar = '',
  tabBar = '',
  sections = {},
  extraStyles = '',
  zeroAgents = false,
  activeTab = 'calendar',
} = {}) {
  const projectLabel = escapeHtml(projectDir);

  // Render a content section into a card body. `data-section` is kept on
  // every card so server-level snapshot tests and integration tests can
  // locate sections by key without depending on surrounding layout structure.
  const renderSection = (key, placeholder) => {
    const body = sections[key];
    if (typeof body === 'string' && body.length > 0) {
      return `<div class="card-body" data-section="${key}">${body}</div>`;
    }
    return `<div class="card-body placeholder" data-section="${key}">${placeholder}</div>`;
  };

  // Sidebar HTML: if a pre-rendered sidebar was supplied use it, otherwise
  // fall back to the agents section value so the function stays backward-
  // compatible with callers that don't provide a sidebar (e.g. unit tests
  // that call renderDashboardShell directly).
  const sidebarBody = typeof sidebar === 'string' && sidebar.length > 0
    ? sidebar
    : (typeof sections.agents === 'string' && sections.agents.length > 0
        ? sections.agents
        : '<div class="sidebar-empty"><p>No agents yet.</p><p>Run <code>/aweek:hire</code> to create one.</p></div>');

  // Compute per-tab content so the template stays readable. Only one tab's
  // section renders at a time — the active tab drives which card is shown.
  // Tabs not yet implemented by their respective ACs fall through to the
  // `calendar` default (sibling ACs will add their own branches).
  const tabContent = zeroAgents
    ? `<div class="zero-agents-empty" data-section="zero-agents">
      <div class="zero-agents-icon" aria-hidden="true">🤖</div>
      <h2 class="zero-agents-title">No agents yet</h2>
      <p class="zero-agents-body">Hire your first agent to see their calendar, activity, strategy, and profile here.</p>
      <p class="zero-agents-cta">Run <code>/aweek:hire</code> in Claude Code to get started.</p>
    </div>`
    : activeTab === 'strategy'
      ? `<section class="card card-strategy" aria-labelledby="strategy-head">
      <div class="card-head"><h2 id="strategy-head">Strategy</h2></div>
      ${renderSection('strategy', 'Rendered <code>plan.md</code> will appear here.')}
    </section>`
    : activeTab === 'profile'
      ? `<section class="card card-profile" aria-labelledby="profile-head">
      <div class="card-head"><h2 id="profile-head">Profile</h2></div>
      ${renderSection('profile', 'Agent identity, scheduling metadata, and budget breakdown will appear here.')}
    </section>
    <section class="card card-budget" aria-labelledby="budget-head">
      <div class="card-head"><h2 id="budget-head">Budget &amp; usage</h2></div>
      ${renderSection('budget', 'Budget and usage (with over-budget highlighting) will appear here.')}
    </section>`
      : activeTab === 'activity'
        ? `<section class="card card-activity" aria-labelledby="activity-head">
      <div class="card-head"><h2 id="activity-head">Activity</h2></div>
      ${renderSection('activity', 'Activity log will appear here.')}
    </section>`
        : `<section class="card card-calendar" aria-labelledby="calendar-head">
      <div class="card-head"><h2 id="calendar-head">Weekly calendar</h2></div>
      ${renderSection('calendar', 'Weekly calendar / task list will appear here.')}
    </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>aweek dashboard</title>
<style>
  :root {
    --bg: #0b0c10;
    --panel: #12141a;
    --panel-2: #1a1d26;
    --border: #262a36;
    --text: #e5e7ef;
    --muted: #8b93a7;
    --accent: #8ab4ff;
    --critical: #ff6b6b;
    --high: #ffb86b;
    --medium: #6bd1ff;
    --low: #a2a8b8;
    --status-pending: #8b93a7;
    --status-in-progress: #6bd1ff;
    --status-completed: #72e2a4;
    --status-failed: #ff6b6b;
    --over-budget: #ff6b6b;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
    font-size: 13.5px;
    line-height: 1.45;
    height: 100%;
  }
  header {
    padding: 18px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
  }
  header h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  header h1 span {
    color: var(--muted);
    font-weight: 400;
    margin-left: 8px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    margin: 16px;
  }
  .card:first-child { margin-top: 16px; }
  .card-head {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .card-head h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .card-body {
    padding: 14px 16px;
    font-size: 13.5px;
    color: var(--text);
  }
  .card-body.placeholder {
    color: var(--muted);
    font-style: italic;
  }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px;
    background: rgba(138,180,255,.1);
    padding: 1px 5px;
    border-radius: 3px;
  }
  footer {
    padding: 18px 24px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 11.5px;
  }
  .over-budget {
    color: var(--over-budget);
    font-weight: 600;
  }
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.45);
    opacity: 0;
    pointer-events: none;
    transition: opacity .18s ease;
    z-index: 40;
  }
  .scrim.show { opacity: 1; pointer-events: auto; }
  .drawer {
    position: fixed;
    inset: 0 0 0 auto;
    width: min(460px, 94vw);
    background: var(--panel);
    border-left: 1px solid var(--border);
    transform: translateX(102%);
    transition: transform .18s ease;
    display: flex;
    flex-direction: column;
    z-index: 50;
  }
  .drawer.open { transform: translateX(0); }
  .drawer-head {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .drawer-head h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .drawer-close {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
  }
  .drawer-close:hover { color: var(--text); }
  .drawer-body { padding: 16px 20px; overflow-y: auto; flex: 1; }
  .drawer-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  .drawer-desc {
    font-size: 13.5px;
    line-height: 1.55;
    padding: 0 0 16px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 16px;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .drawer-desc:empty { display: none; }
  .drawer-fields {
    margin: 0;
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 8px 14px;
    font-size: 12.5px;
  }
  .drawer-fields dt { color: var(--muted); font-weight: 500; }
  .drawer-fields dd { margin: 0; color: var(--text); word-break: break-word; }
  .chip {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .chip-status-pending { background: rgba(139,147,167,.18); color: var(--status-pending); }
  .chip-status-in-progress { background: rgba(107,209,255,.18); color: var(--status-in-progress); }
  .chip-status-completed { background: rgba(114,226,164,.18); color: var(--status-completed); }
  .chip-status-failed { background: rgba(255,107,107,.18); color: var(--status-failed); }
  .chip-status-delegated { background: rgba(138,180,255,.18); color: var(--accent); }
  .chip-status-skipped { background: rgba(139,147,167,.18); color: var(--muted); }
  .chip-priority-critical { background: rgba(255,107,107,.18); color: var(--critical); }
  .chip-priority-high { background: rgba(255,184,107,.18); color: var(--high); }
  .chip-priority-medium { background: rgba(107,209,255,.18); color: var(--medium); }
  .chip-priority-low { background: rgba(162,168,184,.18); color: var(--low); }
  .chip-track {
    background: rgba(138,180,255,.14);
    color: var(--accent);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    text-transform: none;
    letter-spacing: 0;
  }
  .drawer-activity {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  .drawer-section-title {
    margin: 0 0 10px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .drawer-activity-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .drawer-activity-item {
    position: relative;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    font-size: 12px;
    transition: border-color 0.12s, background 0.12s;
  }
  .drawer-activity-item:hover {
    border-color: var(--accent);
    background: rgba(138,180,255,.06);
  }
  .drawer-activity-link {
    position: absolute;
    inset: 0;
    border-radius: 6px;
    z-index: 0;
  }
  .drawer-activity-item > :not(.drawer-activity-link) {
    position: relative;
    z-index: 1;
  }
  .drawer-activity-desc {
    margin: 4px 0 6px;
    color: var(--text);
    font-size: 12px;
    line-height: 1.45;
    word-break: break-word;
  }
  .drawer-activity-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }
  .drawer-activity-ts {
    color: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .drawer-activity-meta {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    color: var(--muted);
    font-size: 11px;
  }
  .drawer-activity-meta strong { color: var(--text); font-weight: 500; margin-left: 4px; }
  .drawer-activity-urls {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
    margin-top: 6px;
  }
  .drawer-activity-url {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    background: rgba(138,180,255,.1);
    border: 1px solid var(--border);
    color: var(--accent);
    text-decoration: none;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .drawer-activity-url:hover { border-color: var(--accent); }
  .drawer-activity-transcript {
    position: relative;
    z-index: 1;
    margin-top: 6px;
  }
  .drawer-activity-transcript-link {
    display: inline-block;
    font: 11px/1 var(--font-mono);
    color: var(--muted);
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }
  .drawer-activity-transcript-link:hover { color: var(--accent); }
  .drawer-activity-error {
    margin-top: 6px;
    color: var(--status-failed);
    font-size: 11.5px;
    word-break: break-word;
  }
  .drawer-activity-empty {
    color: var(--muted);
    font-size: 12px;
    font-style: italic;
  }
${extraStyles}
</style>
</head>
<body data-project-dir="${projectLabel}">
<header>
  <div>
    <h1>aweek dashboard<span>· read-only · live data from <code>.aweek/</code></span></h1>
  </div>
</header>
<div class="dashboard-layout">
  <nav class="sidebar" data-section="agents" aria-label="Agents">
    <div class="sidebar-head">Agents</div>
    ${sidebarBody}
  </nav>
  <div class="content-area">
    ${tabBar}
    ${tabContent}
  </div>
</div>
<div class="scrim" data-scrim hidden></div>
<aside class="drawer" data-drawer aria-hidden="true" aria-labelledby="drawer-title" role="dialog">
  <div class="drawer-head">
    <h2 id="drawer-title" data-drawer-title>Task</h2>
    <button type="button" class="drawer-close" data-drawer-close aria-label="Close">Close</button>
  </div>
  <div class="drawer-body">
    <div class="drawer-chips" data-drawer-chips></div>
    <div class="drawer-desc" data-drawer-desc></div>
    <dl class="drawer-fields" data-drawer-fields></dl>
    <section class="drawer-activity" data-drawer-activity aria-label="Task activity" hidden>
      <h3 class="drawer-section-title">Activity</h3>
      <div class="drawer-activity-list" data-drawer-activity-list></div>
    </section>
  </div>
</aside>
<footer>
  Serving live data from <code>${projectLabel}/.aweek/</code>. Refresh to re-read state.
</footer>
<script>
(function() {
  var drawer = document.querySelector('[data-drawer]');
  var scrim = document.querySelector('[data-scrim]');
  if (!drawer || !scrim) return;
  var titleEl = drawer.querySelector('[data-drawer-title]');
  var chipsEl = drawer.querySelector('[data-drawer-chips]');
  var descEl = drawer.querySelector('[data-drawer-desc]');
  var fieldsEl = drawer.querySelector('[data-drawer-fields]');
  var activityEl = drawer.querySelector('[data-drawer-activity]');
  var activityListEl = drawer.querySelector('[data-drawer-activity-list]');

  // Activity log entries embedded server-side and keyed by taskId. Parsed
  // once on load so per-task drawer opens stay sync.
  var taskActivity = {};
  try {
    var embed = document.getElementById('aweek-task-activity');
    if (embed && embed.textContent) {
      var parsed = JSON.parse(embed.textContent);
      if (parsed && typeof parsed === 'object') taskActivity = parsed;
    }
  } catch (err) { /* leave taskActivity empty */ }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }
  function fmtDuration(ms) {
    if (!ms || ms < 0) return '';
    if (ms < 1000) return ms + 'ms';
    var s = Math.round(ms / 100) / 10;
    if (s < 60) return s + 's';
    var mins = Math.floor(s / 60);
    var rem = Math.round(s - mins * 60);
    return mins + 'm ' + rem + 's';
  }
  function fmtNum(n) {
    return Number(n).toLocaleString('en-US');
  }
  function chip(cls, label) {
    if (!label) return '';
    return '<span class="chip ' + esc(cls) + '">' + esc(label) + '</span>';
  }
  function row(label, value) {
    if (value === undefined || value === null || value === '') return '';
    return '<dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd>';
  }
  function truncate(s, max) {
    var str = String(s == null ? '' : s);
    if (str.length <= max) return str;
    return str.slice(0, max - 1) + '…';
  }
  function activityEntryHref(entry) {
    // Deep-link into the activity tab with the selected agent + entry id.
    // Read the agent slug from the current URL so switching to activity
    // keeps the same agent context; drop the agent param when the
    // current URL does not carry one.
    var agent = new URLSearchParams(location.search).get('agent') || '';
    var params = new URLSearchParams();
    if (agent) params.set('agent', agent);
    params.set('tab', 'activity');
    if (entry && entry.id) params.set('entry', entry.id);
    return '?' + params.toString();
  }
  function renderActivity(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return '<div class="drawer-activity-empty">No activity logged for this task yet.</div>';
    }
    return entries.map(function(e) {
      var status = e.status || 'unknown';
      var head = '<div class="drawer-activity-head">'
        + chip('chip-status chip-status-' + status, status.replace(/-/g, ' '))
        + '<span class="drawer-activity-ts">' + esc(fmtDate(e.timestamp)) + '</span>'
        + '</div>';
      var descHtml = e.title
        ? '<div class="drawer-activity-desc">' + esc(truncate(e.title, 140)) + '</div>'
        : '';
      var meta = [];
      if (e.duration) meta.push('<span>duration<strong>' + esc(fmtDuration(e.duration)) + '</strong></span>');
      if (typeof e.tokens === 'number') meta.push('<span>tokens<strong>' + esc(fmtNum(e.tokens)) + '</strong></span>');
      if (typeof e.exitCode === 'number' && e.exitCode !== 0) meta.push('<span>exit<strong>' + esc(e.exitCode) + '</strong></span>');
      if (e.timedOut) meta.push('<span>timed out</span>');
      var metaHtml = meta.length
        ? '<div class="drawer-activity-meta">' + meta.join('') + '</div>'
        : '';
      var urlsHtml = '';
      if (Array.isArray(e.urls) && e.urls.length) {
        urlsHtml = '<div class="drawer-activity-urls">' + e.urls.slice(0, 6).map(function(u) {
          var label = String(u);
          if (label.indexOf('https://') === 0) label = label.slice(8);
          else if (label.indexOf('http://') === 0) label = label.slice(7);
          if (label.length > 46) label = label.slice(0, 43) + '…';
          return '<a class="drawer-activity-url" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" title="' + esc(u) + '">' + esc(label) + '</a>';
        }).join('') + '</div>';
      }
      var errHtml = '';
      if (status === 'failed' && e.errorMessage) {
        errHtml = '<div class="drawer-activity-error">' + esc(e.errorMessage) + '</div>';
      }
      var transcriptHtml = '';
      if (e.transcriptBasename) {
        // Link to the full per-execution transcript as plain text, opened
        // in a new tab so the drawer context is preserved. The outer
        // overlay link (drawer-activity-link) sits underneath via z-index,
        // so this inner anchor is the one the click lands on.
        var agent = new URLSearchParams(location.search).get('agent') || '';
        var tHref = '/executions/'
          + encodeURIComponent(agent) + '/' + encodeURIComponent(e.transcriptBasename);
        transcriptHtml = '<div class="drawer-activity-transcript">'
          + '<a class="drawer-activity-transcript-link" href="' + esc(tHref)
          + '" target="_blank" rel="noopener noreferrer">view transcript</a>'
          + '</div>';
      }
      var body = head + descHtml + metaHtml + urlsHtml + transcriptHtml + errHtml;
      var href = esc(activityEntryHref(e));
      // The whole item is a link into the activity tab. Nested <a> (the
      // URL chips) are still allowed by most browsers in practice even
      // though the HTML spec disallows them — to stay conformant we keep
      // the outer wrapper clickable via an overlay pseudo-link instead.
      return ''
        + '<div class="drawer-activity-item">'
        +   '<a class="drawer-activity-link" href="' + href + '" aria-label="Open activity entry in Activity tab"></a>'
        +   body
        + '</div>';
    }).join('');
  }
  function open(t) {
    var status = t.status || 'pending';
    var priority = t.priority || '';
    var track = t.track || '';
    titleEl.textContent = t.num ? ('Task #' + t.num) : 'Task';
    var chips = '';
    chips += chip('chip-status chip-status-' + status, status.replace(/-/g, ' '));
    if (priority) chips += chip('chip-priority chip-priority-' + priority, priority);
    if (track) chips += chip('chip-track', track);
    chipsEl.innerHTML = chips;
    descEl.textContent = t.desc || '';
    var rows = '';
    rows += row('Status', status);
    if (priority) rows += row('Priority', priority);
    if (track) rows += row('Track', track);
    if (t.objective) rows += row('Objective', t.objective);
    if (t.runAt) rows += row('Run at', fmtDate(t.runAt));
    if (t.minutes) rows += row('Estimated', t.minutes + ' min');
    if (t.completedAt) rows += row('Completed', fmtDate(t.completedAt));
    if (t.delegatedTo) rows += row('Delegated to', t.delegatedTo);
    if (t.id) rows += row('Task ID', t.id);
    fieldsEl.innerHTML = rows;
    if (activityEl && activityListEl) {
      if (t.id) {
        activityListEl.innerHTML = renderActivity(taskActivity[t.id] || []);
        activityEl.hidden = false;
      } else {
        activityEl.hidden = true;
      }
    }
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    scrim.classList.add('show');
    scrim.hidden = false;
  }
  function close() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    scrim.classList.remove('show');
    scrim.hidden = true;
  }

  document.addEventListener('click', function(e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var card = target.closest('.calendar-task');
    if (card) {
      var d = card.dataset || {};
      open({
        id: d.taskId,
        num: d.taskNum,
        desc: d.taskTitle,
        status: d.taskStatus,
        priority: d.taskPriority,
        track: d.taskTrack,
        runAt: d.taskRunAt,
        objective: d.taskObjective,
        minutes: d.taskMinutes,
        completedAt: d.taskCompletedAt,
        delegatedTo: d.taskDelegatedTo,
      });
      return;
    }
    if (target.closest('[data-drawer-close]')) { close(); return; }
    if (target.matches && target.matches('[data-scrim]')) { close(); return; }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && drawer.classList.contains('open')) close();
  });
})();
(function() {
  // ── URL routing: preserve active tab when switching agents ─────────────
  // Sidebar links are rendered as plain ?agent=<slug> by the server so they
  // work without JS (deep-link / no-JS fallback). When JavaScript is active
  // we intercept those clicks and append the currently-active tab so the
  // user's tab context is preserved when they switch to a different agent.
  //
  // Tab links already carry both agent + tab params and need no interception.

  function getQueryParam(name) {
    return new URLSearchParams(location.search).get(name) || '';
  }

  document.addEventListener('click', function(e) {
    var target = e.target;
    if (!target || !target.closest) return;

    // Only intercept sidebar agent-picker links (.sidebar-item-link).
    var agentLink = target.closest('.sidebar-item-link');
    if (!agentLink) return;

    var li = agentLink.closest('[data-agent-slug]');
    if (!li) return;
    var slug = li.getAttribute('data-agent-slug') || '';
    if (!slug) return;

    var tab = getQueryParam('tab');
    if (tab) {
      // A non-default tab is active — rewrite the navigation URL to
      // include it so the selected tab is preserved after the agent switch.
      e.preventDefault();
      var newUrl = '?agent=' + encodeURIComponent(slug) + '&tab=' + encodeURIComponent(tab);
      history.pushState(null, '', newUrl);
      location.reload();
    }
    // No active tab → the plain ?agent=<slug> href is already correct;
    // let the default link navigation proceed unchanged.
  });

  // When the user navigates back or forward (e.g. after an agent switch
  // that used history.pushState), reload the page so the server renders
  // the correct agent + tab content for the restored URL.
  window.addEventListener('popstate', function() {
    location.reload();
  });
})();
</script>
</body>
</html>
`;
}

/**
 * URL-decode a path segment without throwing on malformed input. A broken
 * percent-encoding from a crawler or a misbehaving client should result
 * in a 404, not a 500 — so we fall back to the raw segment and let the
 * downstream matcher decide whether it's a known slug.
 *
 * @param {string} segment
 * @returns {string}
 */
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Render the NDJSON transcript for a single execution as plain text.
 *
 * The `basename` segment is the file stem — `<taskId>-<executionId>` —
 * that the heartbeat wrote under
 * `.aweek/agents/<agentId>/executions/<basename>.jsonl`. We reject any
 * basename containing a path separator or `..` so the URL can never
 * escape the executions directory. Missing files return 404 with a
 * friendly plain-text body.
 *
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 * @param {{projectDir: string, agentId: string, basename: string}} ctx
 */
async function handleTranscriptRequest(_req, res, ctx) {
  const { projectDir, agentId, basename } = ctx;
  const safeAgent = typeof agentId === 'string' && agentId.length > 0
    && !agentId.includes('/') && !agentId.includes('..');
  const safeBase = typeof basename === 'string' && basename.length > 0
    && !basename.includes('/') && !basename.includes('..');
  if (!safeAgent || !safeBase) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Bad Request');
    return;
  }

  // basename arrives as `<taskId>_<executionId>`. Split on the FIRST `_`
  // because taskId's schema disallows `_` (it's `task-<a-z0-9-only>`), so
  // the underscore is an unambiguous separator — executionId may itself
  // contain dashes without confusing the split.
  const cutIdx = basename.indexOf('_');
  if (cutIdx <= 0 || cutIdx === basename.length - 1) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Bad Request — basename must be <taskId>_<executionId>');
    return;
  }
  const taskId = basename.slice(0, cutIdx);
  const executionId = basename.slice(cutIdx + 1);

  const agentsDir = join(projectDir, '.aweek', 'agents');

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  let wrote = false;
  for await (const rawLine of readTranscriptLines(agentsDir, agentId, taskId, executionId)) {
    const formatted = formatTranscriptLine(rawLine);
    if (formatted.length === 0) continue;
    wrote = true;
    res.write(formatted.join('\n') + '\n');
  }

  if (!wrote) {
    // readTranscriptLines yields nothing on ENOENT — surface a 404 body so
    // the dashboard can distinguish "no transcript captured" from "empty
    // transcript". The 200 status was already committed on the first
    // write(), so only rewrite when we haven't sent any bytes yet. Node's
    // response is still mutable because headersSent is false until the
    // first write.
    if (!res.headersSent) {
      res.statusCode = 404;
    }
    res.end('No transcript captured for this execution.\n');
    return;
  }

  res.end();
}

/**
 * Handle the `GET /executions/<agent>/<basename>` HTML summary page.
 *
 * Buffers the entire JSONL before rendering — transcripts are a few
 * hundred KB at most, and the summary builder needs the terminal
 * `result` event to produce the headline. The raw-bytes endpoint
 * (`/api/executions/...`) stays streaming for curl/tail workflows that
 * want to watch a session tick-by-tick.
 */
async function handleTranscriptSummaryRequest(_req, res, ctx) {
  const { projectDir, agentId, basename } = ctx;
  const safeAgent = typeof agentId === 'string' && agentId.length > 0
    && !agentId.includes('/') && !agentId.includes('..');
  const safeBase = typeof basename === 'string' && basename.length > 0
    && !basename.includes('/') && !basename.includes('..');
  if (!safeAgent || !safeBase) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Bad Request');
    return;
  }

  const cutIdx = basename.indexOf('_');
  if (cutIdx <= 0 || cutIdx === basename.length - 1) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Bad Request — basename must be <taskId>_<executionId>');
    return;
  }
  const taskId = basename.slice(0, cutIdx);
  const executionId = basename.slice(cutIdx + 1);
  const agentsDir = join(projectDir, '.aweek', 'agents');

  const rawLines = [];
  for await (const line of readTranscriptLines(agentsDir, agentId, taskId, executionId)) {
    rawLines.push(line);
  }

  if (rawLines.length === 0) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('No transcript captured for this execution.\n');
    return;
  }

  const events = parseRawTranscript(rawLines);
  const summary = buildTranscriptSummary(events);
  const html = renderTranscriptSummaryHtml(summary, {
    agentId,
    basename,
    rawHref: `/api/executions/${encodeURIComponent(agentId)}/${encodeURIComponent(basename)}`,
  });

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(html);
}

/**
 * Parse a URL's query string into a plain object. Only the first value
 * per key is kept — the dashboard endpoints never need repeated keys,
 * and picking one keeps the downstream validation simple. Built on
 * `URLSearchParams` so percent-decoding and `+`-as-space handling match
 * what the browser sends.
 *
 * @param {string} rawUrl
 * @returns {Record<string, string>}
 */
function parseQuery(rawUrl) {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx < 0) return {};
  const params = new URLSearchParams(rawUrl.slice(qIdx + 1));
  const out = {};
  for (const [key, value] of params.entries()) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * HTML-escape untrusted text for safe interpolation into markup.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resolve the platform-appropriate command + args to launch the user's
 * default browser for `url`. Split out from `openBrowser` so it can be
 * unit-tested without actually spawning a child process.
 *
 *   - darwin:  `open <url>`
 *   - win32:   `cmd /c start "" <url>` (empty title dodges start's quoting quirk)
 *   - other:   `xdg-open <url>` (standard freedesktop.org launcher)
 *
 * @param {string} url
 * @param {NodeJS.Platform} [platform]
 * @returns {{ command: string, args: string[] }}
 */
export function resolveOpenCommand(url, platform = nodePlatform) {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  if (platform === 'win32') {
    // `start` is a cmd.exe builtin, not a standalone executable. The empty
    // string is a (required) window title — `start` treats a single quoted
    // argument as the title rather than the URL, so we pass one explicitly.
    return { command: 'cmd', args: ['/c', 'start', '""', url] };
  }
  return { command: 'xdg-open', args: [url] };
}

/**
 * Open `url` in the user's default browser. Spawns a detached child so
 * the Node.js process does not wait on the browser; swallows launch
 * failures and resolves with `{ opened: false, error }` so callers can
 * gracefully fall back to printing the URL.
 *
 * This helper is intentionally best-effort: any error (missing launcher
 * binary, headless CI environment, permission denial, ...) is reported
 * via the resolved value rather than thrown, so the dashboard stays up
 * even when we cannot open a browser.
 *
 * @param {string} url
 * @param {object} [deps]
 * @param {(command: string, args: string[], options: object) => import('node:child_process').ChildProcess} [deps.spawn]
 * @param {NodeJS.Platform} [deps.platform]
 * @returns {Promise<{ opened: boolean, error?: Error, command?: string, args?: string[] }>}
 */
export function openBrowser(url, { spawn = nodeSpawn, platform = nodePlatform } = {}) {
  return new Promise((resolvePromise) => {
    let command;
    let args;
    try {
      ({ command, args } = resolveOpenCommand(url, platform));
    } catch (err) {
      resolvePromise({ opened: false, error: err });
      return;
    }

    let child;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    try {
      child = spawn(command, args, {
        stdio: 'ignore',
        detached: true,
      });
    } catch (err) {
      settle({ opened: false, error: err, command, args });
      return;
    }

    // `spawn` can surface ENOENT (missing launcher) asynchronously via
    // the 'error' event rather than throwing. Fall back to a logged URL
    // in that case.
    child.once('error', (err) => {
      settle({ opened: false, error: err, command, args });
    });

    // Allow the Node.js event loop to exit even if the child is still
    // running — the parent CLI is kept alive by the HTTP server, not by
    // the browser launcher.
    if (typeof child.unref === 'function') {
      try {
        child.unref();
      } catch {
        // `unref` can throw on already-exited children on some platforms;
        // safe to ignore.
      }
    }

    // Resolve optimistically on the next tick: if `error` fires within
    // that window we still surface it (settle() dedupes), but otherwise
    // we do not block the CLI waiting for the browser to open.
    setImmediate(() => settle({ opened: true, command, args }));
  });
}

/**
 * Enumerate the host machine's LAN-reachable IPv4 and IPv6 addresses
 * so the CLI can print concrete URLs a phone/tablet on the same
 * network can paste into a browser. Internal (loopback) interfaces
 * are filtered out — they are never reachable from another device —
 * as are link-local IPv6 addresses (`fe80::/10`) since those require
 * a zone index to be useful and confuse most users.
 *
 * The shape matches Node's `os.networkInterfaces()` entries so callers
 * can format however they like. Injectable `networkInterfaces` dep
 * keeps the function unit-testable on any host.
 *
 * @param {object} [deps]
 * @param {() => Record<string, Array<{ address: string, family: string | number, internal: boolean }> | undefined>} [deps.networkInterfaces]
 * @returns {Array<{ name: string, address: string, family: 'IPv4' | 'IPv6' }>}
 */
export function getLanAddresses({ networkInterfaces = nodeNetworkInterfaces } = {}) {
  const interfaces = networkInterfaces() || {};
  const out = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!Array.isArray(addrs)) continue;
    for (const addr of addrs) {
      if (!addr || addr.internal) continue;
      // Node 18+ uses the string 'IPv4'/'IPv6'; older node exposed a
      // number (4 / 6). Normalise both so downstream code can branch
      // on a stable value.
      const family =
        addr.family === 'IPv4' || addr.family === 4
          ? 'IPv4'
          : addr.family === 'IPv6' || addr.family === 6
            ? 'IPv6'
            : null;
      if (!family) continue;
      // Skip link-local IPv6 — it requires a `%iface` zone index to
      // route, which browsers on the remote device cannot synthesise.
      if (family === 'IPv6' && /^fe80:/i.test(addr.address)) continue;
      out.push({ name, address: addr.address, family });
    }
  }
  return out;
}

/**
 * Build the list of LAN URL hints to print after a successful bind.
 * Returns an empty list for non-wildcard binds (nothing to advertise —
 * the user is already looking at the canonical URL) and for machines
 * with no external interfaces (e.g. air-gapped laptops). IPv6 hosts
 * are bracketed per RFC 3986.
 *
 * @param {{ host: string, port: number }} bind
 * @param {object} [deps]
 * @param {() => Record<string, Array<{ address: string, family: string | number, internal: boolean }> | undefined>} [deps.networkInterfaces]
 * @returns {string[]}
 */
export function formatLanHints({ host, port }, deps = {}) {
  if (!isWildcardHost(host)) return [];
  const addrs = getLanAddresses(deps);
  const urls = [];
  for (const { address, family } of addrs) {
    const display = family === 'IPv6' ? `[${address}]` : address;
    urls.push(`http://${display}:${port}/`);
  }
  return urls;
}

/**
 * Bind the server to `host:port`, incrementing the port on EADDRINUSE
 * up to `scanLimit` times before giving up. Returns the port that was
 * successfully bound.
 *
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} host
 * @param {number} scanLimit
 * @returns {Promise<number>}
 */
function listenWithRetry(server, port, host, scanLimit) {
  return new Promise((resolveBind, rejectBind) => {
    let attempt = 0;

    const tryListen = (candidate) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err && err.code === 'EADDRINUSE' && attempt < scanLimit) {
          attempt += 1;
          // `candidate === 0` means "ask the OS" — retrying with 0 + 1 would
          // defeat the purpose, so treat port 0 as "OS picks, don't retry".
          if (candidate === 0) {
            rejectBind(err);
            return;
          }
          tryListen(candidate + 1);
          return;
        }
        rejectBind(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        // When `candidate === 0` the OS picks an ephemeral port; read the
        // actual bound port back from the server address rather than
        // returning the placeholder 0.
        const addr = server.address();
        const boundPort = addr && typeof addr === 'object' ? addr.port : candidate;
        resolveBind(boundPort);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, host);
    };

    tryListen(port);
  });
}
