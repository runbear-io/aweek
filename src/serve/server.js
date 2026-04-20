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
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { platform as nodePlatform } from 'node:process';
import { networkInterfaces as nodeNetworkInterfaces } from 'node:os';
import {
  MISSING_AWEEK_DIR_CODE,
  createNoAweekDirError,
  formatNoAweekDirMessage,
  isNoAweekDirError,
} from './errors.js';
import {
  gatherAgents,
  renderAgentsSection,
  agentsSectionStyles,
} from './agents-section.js';
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

    // Re-read `.aweek/` on every request so the dashboard reflects live
    // state without a server restart. Each section gatherer is awaited in
    // parallel so a slow filesystem read on one card does not serialize
    // the others. Each gatherer also absorbs its own errors into an empty
    // list so a single broken section cannot knock the whole dashboard
    // offline — read-only tooling must prefer "degraded" over "500".
    const calendarWeek = url.searchParams.get('week') || undefined;
    const [agents, budget, plans, calendarView] = await Promise.all([
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
    ]);

    const html = renderDashboardShell({
      projectDir: ctx.projectDir,
      sections: {
        agents: renderAgentsSection(agents),
        budget: renderBudgetSection(budget),
        plan: renderPlanSection(plans),
        calendar: renderCalendarSection(calendarView),
      },
      extraStyles:
        agentsSectionStyles() +
        budgetSectionStyles() +
        planSectionStyles() +
        calendarSectionStyles(),
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
export function renderDashboardShell({ projectDir, sections = {}, extraStyles = '' } = {}) {
  const projectLabel = escapeHtml(projectDir);
  const renderSection = (key, placeholder) => {
    const body = sections[key];
    if (typeof body === 'string' && body.length > 0) {
      return `<div class="card-body" data-section="${key}">${body}</div>`;
    }
    return `<div class="card-body placeholder" data-section="${key}">${placeholder}</div>`;
  };

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
  main {
    padding: 20px 24px 60px;
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
  }
  @media (min-width: 1100px) {
    main {
      grid-template-columns: minmax(260px, 320px) 1fr;
      grid-template-rows: auto auto;
      grid-template-areas:
        "agents calendar"
        "budget plan";
    }
    .card-agents { grid-area: agents; }
    .card-calendar { grid-area: calendar; }
    .card-plan { grid-area: plan; }
    .card-budget { grid-area: budget; }
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
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
${extraStyles}
</style>
</head>
<body data-project-dir="${projectLabel}">
<header>
  <div>
    <h1>aweek dashboard<span>· read-only · live data from <code>.aweek/</code></span></h1>
  </div>
</header>
<main>
  <section class="card card-agents" aria-labelledby="agents-head">
    <div class="card-head"><h2 id="agents-head">Agents</h2></div>
    ${renderSection('agents', 'Agents list will appear here.')}
  </section>
  <section class="card card-calendar" aria-labelledby="calendar-head">
    <div class="card-head"><h2 id="calendar-head">Weekly calendar</h2></div>
    ${renderSection('calendar', 'Weekly calendar / task list will appear here.')}
  </section>
  <section class="card card-plan" aria-labelledby="plan-head">
    <div class="card-head"><h2 id="plan-head">Plan</h2></div>
    ${renderSection('plan', 'Rendered <code>plan.md</code> will appear here.')}
  </section>
  <section class="card card-budget" aria-labelledby="budget-head">
    <div class="card-head"><h2 id="budget-head">Budget &amp; usage</h2></div>
    ${renderSection('budget', 'Budget and usage (with over-budget highlighting) will appear here.')}
  </section>
</main>
<footer>
  Serving live data from <code>${projectLabel}/.aweek/</code>. Refresh to re-read state.
</footer>
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
