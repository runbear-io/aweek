/**
 * aweek serve — local HTTP dashboard.
 *
 * Entry point for the `aweek serve` subcommand. Launches a lightweight
 * HTTP server that serves a React + Vite SPA build from disk with SPA
 * fallback routing so client-side routes resolve back to the app shell
 * without reloading through a 404.
 *
 * Sub-AC 1 scope (AC 7): the command handler is refactored from SSR to
 * static file serving. JSON data endpoints that hydrate the SPA come in
 * later sub-ACs. Surface for this sub-AC:
 *
 *   GET /healthz            → liveness probe (JSON)
 *   GET /<asset>            → static file from the Vite build directory
 *   GET /<anything-else>    → SPA fallback → index.html
 *
 * When the build directory is missing (fresh clone, no `pnpm build` yet),
 * the server serves a friendly HTML stub with build instructions instead
 * of a hard 404. This keeps the CLI runnable during development and in
 * CI smoke tests that never run the frontend build.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
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
  gatherAgentsList,
  gatherAgentProfile,
  gatherAgentPlan,
  gatherAgentCalendar,
  gatherAgentUsage,
  gatherAgentLogs,
  streamExecutionLogLines,
} from './data/index.js';
// The /api/summary endpoint intentionally reuses the terminal
// `/aweek:summary` composer so the SPA Overview tab shows byte-identical
// cells (Agent / Goals / Tasks / Budget / Status) to the CLI baseline.
// This single source of truth guarantees feature parity between the two
// surfaces — any future tweak to summary.js shows up in both without
// per-consumer drift.
import { buildSummary } from '../skills/summary.js';

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
 * Directory name of the Vite build output relative to the package root.
 * The actual absolute path is computed by `resolveDefaultBuildDir()` so
 * tests can override it via `--build-dir` / `normaliseServeOptions({ buildDir })`.
 */
export const DEFAULT_BUILD_DIR_NAME = 'dist';

/**
 * Hosts that should not be surfaced verbatim in the user-facing URL. A
 * `0.0.0.0` (or `::`) bind means "all interfaces"; the user-reachable
 * address on the local machine is `localhost`. We display that instead
 * and print the LAN hint separately (see bin/aweek.js).
 */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '::0']);

/**
 * Whitelist of SPA client-side route patterns. Any request whose
 * pathname matches one of these is considered a legitimate SPA route
 * and gets the `index.html` shell returned (200 OK) so the React router
 * can render the page. Every other pathname (unknown slugs under `/xyz`,
 * bare `/api`, typo'd routes) returns a 404 JSON envelope.
 *
 * The whitelist is intentionally narrow — it mirrors the tab list in
 * the SPA sidebar plus the per-agent detail routes — so accidental
 * typos / probe requests don't silently serve the shell and mask real
 * 404s in operator logs.
 */
const CLIENT_ROUTE_PATTERNS = [
  /^\/$/,
  /^\/agents\/?$/,
  /^\/calendar\/?$/,
  /^\/activity\/?$/,
  /^\/strategy\/?$/,
  /^\/profile\/?$/,
  // /agents/:slug and /agents/:slug/<anything>
  /^\/agents\/[^/]+(?:\/.*)?$/,
];

/**
 * Returns true when `pathname` matches one of the SPA's whitelisted
 * client-side routes. Used by the static-file server to decide whether
 * to fall back to `index.html` (whitelisted) or emit a 404 JSON body
 * (non-whitelisted).
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isWhitelistedClientRoute(pathname) {
  if (typeof pathname !== 'string') return false;
  return CLIENT_ROUTE_PATTERNS.some((rx) => rx.test(pathname));
}

/**
 * MIME type lookup for the file extensions the Vite bundle emits. Anything
 * not listed falls back to `application/octet-stream` which the browser
 * reliably treats as an opaque download — a safe default for unknown
 * extensions that prevents accidental script-injection via mislabelled
 * content types.
 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * Resolve the default Vite build output directory. The SPA bundle lives at
 * `src/serve/spa/dist/` — one directory over from this file — matching the
 * `build.outDir` in `vite.config.js`. Exported so tests and any future CLI
 * flag can override it via the `buildDir` option of `startServer`.
 *
 * @returns {string} absolute path to the default build directory
 */
export function resolveDefaultBuildDir() {
  return fileURLToPath(new URL(`./spa/${DEFAULT_BUILD_DIR_NAME}/`, import.meta.url));
}

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
 * @param {string} [raw.buildDir] — override the Vite build output directory
 * @returns {{ port: number, host: string, open: boolean, projectDir: string, buildDir: string }}
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
  const buildDir = raw.buildDir ? resolve(raw.buildDir) : resolveDefaultBuildDir();

  return { port, host, open, projectDir, buildDir };
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
 * The router is intentionally minimal for sub-AC 1 of AC 7:
 *   - GET /healthz          → `{ ok: true, projectDir }`
 *   - GET /<file>           → static file from the Vite build directory
 *   - GET /<anything-else>  → SPA fallback → index.html
 *
 * JSON data endpoints that feed the SPA are added by subsequent sub-ACs.
 *
 * @param {object} [options] — see `normaliseServeOptions` for shape
 * @returns {Promise<{ server: import('node:http').Server, port: number, host: string, url: string, projectDir: string, buildDir: string, close: () => Promise<void> }>}
 */
export async function startServer(options = {}) {
  const { port, host, projectDir, buildDir } = normaliseServeOptions(options);

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
    Promise.resolve(handleRequest(req, res, { projectDir, dataDir, buildDir })).catch((err) => {
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
    buildDir,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

/**
 * HTTP request router. Method-checks once, routes `/healthz` to a JSON
 * liveness probe, and otherwise hands off to the SPA static-file
 * handler. Data endpoints (`/api/...`) are added in follow-up sub-ACs.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ projectDir: string, dataDir: string, buildDir: string }} ctx
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
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ ok: true, projectDir: ctx.projectDir }));
    return;
  }

  if (pathname === '/api/summary' || pathname === '/api/summary/') {
    await handleSummary(res, ctx);
    return;
  }

  if (pathname === '/api/agents' || pathname === '/api/agents/') {
    await handleAgentsList(res, ctx);
    return;
  }

  const agentDetailMatch = pathname.match(/^\/api\/agents\/([^/]+)\/?$/);
  if (agentDetailMatch) {
    const slug = decodeSlug(agentDetailMatch[1]);
    if (slug === null) {
      sendJson(res, 400, { error: 'Invalid agent slug' });
      return;
    }
    await handleAgentDetail(res, ctx, slug);
    return;
  }

  const agentPlanMatch = pathname.match(/^\/api\/agents\/([^/]+)\/plan\/?$/);
  if (agentPlanMatch) {
    const slug = decodeSlug(agentPlanMatch[1]);
    if (slug === null) {
      sendJson(res, 400, { error: 'Invalid agent slug' });
      return;
    }
    await handleAgentPlan(res, ctx, slug);
    return;
  }

  const agentCalendarMatch = pathname.match(/^\/api\/agents\/([^/]+)\/calendar\/?$/);
  if (agentCalendarMatch) {
    const slug = decodeSlug(agentCalendarMatch[1]);
    if (slug === null) {
      sendJson(res, 400, { error: 'Invalid agent slug' });
      return;
    }
    const queryString = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
    const params = new URLSearchParams(queryString);
    const week = params.get('week') || undefined;
    await handleAgentCalendar(res, ctx, slug, week);
    return;
  }

  const agentUsageMatch = pathname.match(/^\/api\/agents\/([^/]+)\/usage\/?$/);
  if (agentUsageMatch) {
    const slug = decodeSlug(agentUsageMatch[1]);
    if (slug === null) {
      sendJson(res, 400, { error: 'Invalid agent slug' });
      return;
    }
    await handleAgentUsage(res, ctx, slug);
    return;
  }

  const agentLogsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/logs\/?$/);
  if (agentLogsMatch) {
    const slug = decodeSlug(agentLogsMatch[1]);
    if (slug === null) {
      sendJson(res, 400, { error: 'Invalid agent slug' });
      return;
    }
    // The dashboard's date-range pill maps to a `?dateRange=` query
    // string. Unknown / missing values fall back to "all" inside the
    // gatherer so we don't need to validate it here.
    const queryString = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
    const params = new URLSearchParams(queryString);
    const dateRange = params.get('dateRange') || undefined;
    await handleAgentLogs(res, ctx, slug, dateRange);
    return;
  }

  const agentExecLogMatch = pathname.match(
    /^\/api\/agents\/([^/]+)\/executions\/([^/]+)\/?$/,
  );
  if (agentExecLogMatch) {
    const slug = decodeSlug(agentExecLogMatch[1]);
    const basename = decodeSlug(agentExecLogMatch[2]);
    if (slug === null || basename === null) {
      sendJson(res, 400, { error: 'Invalid slug or basename' });
      return;
    }
    await handleAgentExecutionLog(res, ctx, slug, basename);
    return;
  }

  await serveSpa(req, res, pathname, ctx);
}

/**
 * Decode a URL-encoded slug segment and validate it is safe to pass
 * downstream as a filesystem key (no traversal, no NUL bytes, no
 * path separators). Returns `null` when the segment is malformed.
 *
 * @param {string} raw
 * @returns {string | null}
 */
function decodeSlug(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (
    decoded.length === 0 ||
    decoded.includes('\0') ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    decoded === '.' ||
    decoded === '..'
  ) {
    return null;
  }
  return decoded;
}

/**
 * Send a JSON response with a stable envelope. Always `no-store` so
 * the dashboard reflects the filesystem truth on every manual refresh.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {unknown} body
 */
function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * GET /api/summary — return the compact dashboard payload used by the
 * SPA Overview tab. This endpoint is intentionally a thin shim over
 * `buildSummary` from `src/skills/summary.js` so the web view and the
 * terminal `/aweek:summary` render the same Agent / Goals / Tasks /
 * Budget / Status cells. `buildSummary` composes every row through
 * `buildSummaryRow`, which in turn pulls data from the existing
 * `src/storage/*` stores — honouring the read-only contract for
 * `aweek serve`.
 *
 * Response shape:
 *   200 { rows:   [{ agent, goals, tasks, budget, status }, ...],
 *         week:   'YYYY-Www',
 *         weekMonday: 'YYYY-MM-DD',
 *         agentCount: number }
 *   500 { error: string }
 *
 * Per-row fields map 1:1 to the terminal summary table:
 *   - agent  → display name from `.claude/agents/<slug>.md` (or slug + missing marker)
 *   - goals  → "N" / "active/total"
 *   - tasks  → "completed/total" for the current week
 *   - budget → "used / limit (pct%)" or "no limit"
 *   - status → label like "ACTIVE" / "PAUSED" / "RUNNING"
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{ projectDir: string }} ctx
 */
async function handleSummary(res, ctx) {
  try {
    // `buildSummary` expects the per-agent data directory (.aweek/agents)
    // and needs the project root separately so it can resolve the
    // subagent identity markdown under `.claude/agents/`.
    const dataDir = join(ctx.projectDir, '.aweek', 'agents');
    const { rows, week, weekMonday, agentCount } = await buildSummary({
      dataDir,
      projectDir: ctx.projectDir,
    });
    sendJson(res, 200, { rows, week, weekMonday, agentCount });
  } catch (err) {
    sendJson(res, 500, {
      error: err && err.message ? err.message : 'Failed to load summary',
    });
  }
}

/**
 * GET /api/agents — return the overview list row for every agent on disk.
 *
 * Delegates to `gatherAgentsList`, which fans out to `AgentStore.loadAll`
 * (via `listAllAgents`), `UsageStore.weeklyTotal`, and the `.claude/agents/<slug>.md`
 * identity primitive. The data layer enforces the read-only contract;
 * this handler only translates its return value to HTTP JSON.
 *
 * Response shape:
 *   200 { agents: [{ slug, name, description, missing, status,
 *                    tokensUsed, tokenLimit, utilizationPct }, ...] }
 *   500 { error: string }
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{ projectDir: string }} ctx
 */
async function handleAgentsList(res, ctx) {
  try {
    const agents = await gatherAgentsList({ projectDir: ctx.projectDir });
    sendJson(res, 200, { agents });
  } catch (err) {
    sendJson(res, 500, {
      error: err && err.message ? err.message : 'Failed to load agents',
    });
  }
}

/**
 * GET /api/agents/:slug — return the detail payload for a single agent.
 *
 * Delegates to `gatherAgentProfile`, which returns `null` when the slug
 * does not exist on disk so we map that to a 404. Any other failure
 * bubbles up as a 500 so the SPA can render an actionable error state.
 *
 * Response shape:
 *   200 { agent: { slug, name, description, missing, identityPath,
 *                  createdAt, updatedAt, paused, pausedReason,
 *                  periodStart, tokenLimit, tokensUsed, remaining,
 *                  overBudget, utilizationPct, weekMonday } }
 *   404 { error: 'Agent not found: <slug>' }
 *   500 { error: string }
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{ projectDir: string }} ctx
 * @param {string} slug
 */
async function handleAgentDetail(res, ctx, slug) {
  try {
    const agent = await gatherAgentProfile({ projectDir: ctx.projectDir, slug });
    if (!agent) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, { agent });
  } catch (err) {
    sendJson(res, 500, {
      error: err && err.message ? err.message : 'Failed to load agent',
    });
  }
}

/**
 * GET /api/agents/:slug/plan — return the plan payload for an agent.
 *
 * Delegates to `gatherAgentPlan`, which returns `null` when the slug
 * does not exist on disk so we map that to 404. The envelope carries
 * both the freeform `plan.md` body (from `plan-markdown-store`) and
 * the structured weekly plans (from `weekly-plan-store`) so the SPA
 * can render the Strategy / Plan / Calendar tabs without additional
 * round-trips. Any other failure bubbles up as a 500 so the SPA can
 * render an actionable error state.
 *
 * Response shape:
 *   200 { plan: { slug, name, hasPlan, markdown,
 *                 weeklyPlans: [...], latestApproved: {...}|null } }
 *   404 { error: 'Agent not found: <slug>' }
 *   500 { error: string }
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{ projectDir: string }} ctx
 * @param {string} slug
 */
async function handleAgentPlan(res, ctx, slug) {
  try {
    const plan = await gatherAgentPlan({ projectDir: ctx.projectDir, slug });
    if (!plan) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, { plan });
  } catch (err) {
    sendJson(res, 500, {
      error: err && err.message ? err.message : 'Failed to load plan',
    });
  }
}

/**
 * GET /api/agents/:slug/calendar — return the weekly calendar payload for
 * an agent. Delegates to `gatherAgentCalendar`, which sources tasks from
 * the weekly-plan store, computes each task's day/hour slot via the
 * shared `computeTaskSlot` helper, and co-gathers per-task activity rows
 * so the Calendar tab can render the grid without additional round-trips.
 *
 * When the agent exists but has no weekly plan yet, the gatherer returns
 * `noPlan: true` and we forward that as a 200 — the SPA renders a "no
 * plan yet" empty state instead of an error. 404 only fires when the
 * slug is unknown on disk.
 *
 * Optional `?week=YYYY-Www` overrides the current-week default (matches
 * the terminal `/aweek:calendar` `--week` flag).
 *
 * Response shape:
 *   200 { calendar: { agentId, week, month, approved, timeZone,
 *                     weekMonday, noPlan, tasks: [...], counts: {...},
 *                     activityByTask: {...} } }
 *   400 { error: 'Invalid agent slug' }
 *   404 { error: 'Agent not found: <slug>' }
 *   500 { error: string }
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{ projectDir: string }} ctx
 * @param {string} slug
 * @param {string | undefined} week
 */
async function handleAgentCalendar(res, ctx, slug, week) {
  try {
    const calendar = await gatherAgentCalendar({
      projectDir: ctx.projectDir,
      slug,
      week,
    });
    if (calendar && calendar.notFound) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, { calendar });
  } catch (err) {
    sendJson(res, 500, {
      error: err && err.message ? err.message : 'Failed to load calendar',
    });
  }
}

/**
 * GET /api/agents/:slug/usage — return the budget + usage payload for an agent.
 *
 * Delegates to `gatherAgentUsage`, which returns `null` when the slug does
 * not exist on disk so we map that to 404. The envelope carries the
 * current week's token usage compared against the configured weekly
 * budget plus a per-week historical roll-up so the SPA can render a
 * trend chart without additional round-trips. Any other failure bubbles
 * up as a 500 so the SPA can render an actionable error state.
 *
 * Response shape:
 *   200 { usage: { slug, name, missing, paused, pausedReason,
 *                  weekMonday, tokenLimit, tokensUsed,
 *                  inputTokens, outputTokens, costUsd, recordCount,
 *                  remaining, overBudget, utilizationPct,
 *                  weeks: [{ weekMonday, recordCount, inputTokens,
 *                            outputTokens, totalTokens, costUsd }] } }
 *   404 { error: 'Agent not found: <slug>' }
 *   500 { error: string }
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{ projectDir: string }} ctx
 * @param {string} slug
 */
async function handleAgentUsage(res, ctx, slug) {
  try {
    const usage = await gatherAgentUsage({ projectDir: ctx.projectDir, slug });
    if (!usage) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, { usage });
  } catch (err) {
    sendJson(res, 500, {
      error: err && err.message ? err.message : 'Failed to load usage',
    });
  }
}

/**
 * GET /api/agents/:slug/logs — return the merged execution-log payload
 * for an agent. Sources the user-facing activity-log entries from
 * `activity-log-store.js` and the heartbeat audit trail from
 * `execution-store.js` via the `gatherAgentLogs` data layer. Returns
 * `null` (→ 404) when the slug does not exist on disk.
 *
 * The optional `?dateRange=` query string accepts the same presets as
 * the SPA's date filter — `all` (default), `this-week`, `last-7-days`.
 * Unknown values fall back to `all` inside the gatherer so they cannot
 * leak garbage into the response.
 *
 * Response shape:
 *   200 { logs: { slug, dateRange,
 *                 entries: [...activity-log entries, newest first],
 *                 executions: [...execution records, newest first] } }
 *   400 { error: 'Invalid agent slug' }
 *   404 { error: 'Agent not found: <slug>' }
 *   500 { error: string }
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{ projectDir: string }} ctx
 * @param {string} slug
 * @param {string | undefined} dateRange
 */
async function handleAgentLogs(res, ctx, slug, dateRange) {
  try {
    const logs = await gatherAgentLogs({
      projectDir: ctx.projectDir,
      slug,
      dateRange,
    });
    if (!logs) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, { logs });
  } catch (err) {
    sendJson(res, 500, {
      error: err && err.message ? err.message : 'Failed to load logs',
    });
  }
}

/**
 * GET /api/agents/:slug/executions/:basename — return the NDJSON body of
 * a single execution log as a JSON array of lines. The SPA's execution
 * log page consumes this endpoint; server-side streaming keeps memory
 * bounded while the response materialises the list for the client.
 *
 * Response shape:
 *   200 { log: { slug, basename, lines: [...raw NDJSON lines] } }
 *   400 { error: 'Invalid slug or basename' }
 *   500 { error: string }
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{ projectDir: string }} ctx
 * @param {string} slug
 * @param {string} basename — `<taskId>_<executionId>` (no `.jsonl`).
 */
async function handleAgentExecutionLog(res, ctx, slug, basename) {
  try {
    const lines = [];
    for await (const line of streamExecutionLogLines({
      projectDir: ctx.projectDir,
      slug,
      basename,
    })) {
      lines.push(line);
    }
    sendJson(res, 200, { log: { slug, basename, lines } });
  } catch (err) {
    sendJson(res, 500, {
      error:
        err && err.message ? err.message : 'Failed to read execution log',
    });
  }
}

/**
 * Serve the Vite SPA bundle with path-traversal-safe static lookup and
 * client-side-routing fallback.
 *
 * The algorithm:
 *   1. If the build directory does not exist yet, render a friendly HTML
 *      stub with build instructions. First-run users see actionable copy
 *      instead of an opaque 404.
 *   2. Otherwise, try to resolve `pathname` to an existing file under
 *      `buildDir` (with a traversal guard). If it resolves and is a file,
 *      stream it back with an appropriate `Content-Type` + caching header.
 *   3. If the request looks like a static asset (has a recognised
 *      extension) but the file is missing, return 404. This prevents
 *      broken <script>/<img>/<link> tags from silently succeeding by
 *      falling through to `index.html`.
 *   4. Otherwise, treat the request as a client-side route and serve
 *      `index.html` (the SPA fallback). This is what lets the React
 *      router own URLs like `/agents/writer/calendar` without the server
 *      needing to know the route table.
 *
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname — decoded pathname portion of the request URL
 * @param {{ buildDir: string }} ctx
 */
async function serveSpa(_req, res, pathname, ctx) {
  const { buildDir } = ctx;

  // Static-file lookup first: any real file under `buildDir` (hashed
  // assets, favicon, etc.) wins regardless of the client-route
  // whitelist so the SPA bundle itself is always deliverable. We only
  // run this branch when the build dir exists — otherwise the request
  // can only be the SPA shell (or a 404) below.
  if (existsSync(buildDir)) {
    const resolved = resolveSafeFile(buildDir, pathname);
    if (resolved && existsSync(resolved) && statSync(resolved).isFile()) {
      await sendFile(res, resolved);
      return;
    }

    // Asset-looking requests that miss should 404 (plain text) — falling
    // back to the SPA shell for a broken `/favicon.ico` or `/assets/app.js`
    // masks real deployment bugs.
    const ext = extname(pathname).toLowerCase();
    if (ext && ext !== '.html' && MIME_TYPES[ext]) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(`Not found: ${pathname}\n`);
      return;
    }
  }

  // At this point the request is for a "client route" — either it will
  // serve the SPA shell (whitelisted) or it is a typo / probe and
  // deserves a 404 JSON envelope instead of the silent shell fallback
  // that hides real 404s from operators.
  if (!isWhitelistedClientRoute(pathname)) {
    sendJson(res, 404, { error: 'Not found', path: pathname });
    return;
  }

  // Whitelisted client route from here on.

  // Graceful degradation: the frontend bundle hasn't been built yet.
  // Serve a readable build-missing message rather than crashing the
  // request or 404-ing silently, so the first-run failure is obvious.
  if (!existsSync(buildDir)) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderBuildMissingHtml(buildDir));
    return;
  }

  // SPA fallback — the React router owns this URL.
  const indexPath = join(buildDir, 'index.html');
  if (!existsSync(indexPath)) {
    // Build dir exists but is missing the entrypoint — likely a partial
    // / broken build. Fail loud so the operator notices.
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`index.html not found in build dir: ${buildDir}\n`);
    return;
  }
  await sendFile(res, indexPath);
}

/**
 * Resolve a URL pathname to an absolute file path inside `buildDir`, or
 * return `null` when the request would escape the directory. This is the
 * traversal guard for the static file server — any `..` segment, Windows
 * backslash, or null byte is rejected here rather than at `sendFile` time
 * so a malformed URL never reads a file outside the build directory.
 *
 * @param {string} buildDir — absolute path to the Vite build directory
 * @param {string} pathname — raw (possibly percent-encoded) URL pathname
 * @returns {string | null} absolute path inside `buildDir`, or `null`
 */
export function resolveSafeFile(buildDir, pathname) {
  if (typeof pathname !== 'string') return null;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // Reject NUL bytes (filesystem-level foot-gun on Node + libc) and
  // Windows-style backslashes that could smuggle a traversal on cross-
  // platform deployments.
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  // Collapse leading slashes so `/` and `//` both map to the index, and
  // fall back to `index.html` when the URL points at a directory root.
  const relative = decoded.replace(/^\/+/, '');
  if (relative === '' || relative.endsWith('/')) {
    return join(resolve(buildDir), relative, 'index.html');
  }

  const normalisedBuild = resolve(buildDir);
  const candidate = resolve(normalisedBuild, relative);
  // Ensure the resolved candidate really lives inside the build dir. The
  // `+ sep` prevents `dist-sibling` from matching `dist` as a prefix.
  if (candidate !== normalisedBuild && !candidate.startsWith(normalisedBuild + sep)) {
    return null;
  }
  return candidate;
}

/**
 * Stream a file back to the response with a sensible `Content-Type` and
 * caching policy. Hashed Vite assets (anything under `/assets/`) are
 * served with long-lived immutable caching; `index.html` must stay
 * fresh so new deploys land immediately; everything else gets a short
 * default cache so repeated dev reloads are cheap.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} absPath — absolute path to a file inside the build dir
 */
async function sendFile(res, absPath) {
  const ext = extname(absPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const stats = statSync(absPath);

  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(stats.size));

  // `index.html` drives the SPA shell; caching it aggressively would
  // strand clients on stale builds. Hashed `/assets/*` can safely live
  // in immutable cache for a year since the hash changes on rebuild.
  const isHtml = ext === '.html';
  const isHashedAsset = /\/assets\/[^/]+$/.test(absPath.replace(/\\/g, '/'));
  if (isHtml) {
    res.setHeader('Cache-Control', 'no-store');
  } else if (isHashedAsset) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }

  if (res.req && res.req.method === 'HEAD') {
    res.end();
    return;
  }

  await pipeline(createReadStream(absPath), res);
}

/**
 * Render a small standalone HTML page explaining that the Vite build is
 * missing, with the expected path and a copy-pasteable fix. Used as a
 * first-run fallback so `aweek serve` is self-explanatory before the
 * frontend has been built. No external assets — the page is readable
 * without the SPA bundle.
 *
 * @param {string} buildDir — absolute path the server looked for
 * @returns {string}
 */
export function renderBuildMissingHtml(buildDir) {
  const dir = escapeHtml(buildDir);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>aweek dashboard — build missing</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0;
    padding: 32px 24px;
    background: #0b0c10;
    color: #e5e7ef;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.55;
  }
  main { max-width: 720px; margin: 0 auto; }
  h1 { margin: 0 0 8px; font-size: 20px; }
  h1 span { color: #8b93a7; font-weight: 400; margin-left: 8px; font-size: 14px; }
  p { color: #c7ccd9; }
  pre, code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12.5px;
  }
  pre {
    padding: 12px 14px;
    background: #12141a;
    border: 1px solid #262a36;
    border-radius: 8px;
    overflow-x: auto;
  }
  code { background: rgba(138,180,255,.1); padding: 1px 5px; border-radius: 3px; }
</style>
</head>
<body>
<main>
  <h1>aweek dashboard<span>· SPA bundle not found</span></h1>
  <p>The frontend has not been built yet. <code>aweek serve</code> expected the Vite build output at:</p>
  <pre>${dir}</pre>
  <p>Build the SPA, then restart the server:</p>
  <pre>pnpm install
pnpm build
aweek serve</pre>
  <p>If you are developing, <code>pnpm dev</code> will rebuild on change.</p>
</main>
</body>
</html>
`;
}

/**
 * HTML-escape untrusted text for safe interpolation into markup. The
 * build-missing template is the only HTML we render server-side in sub-AC 1,
 * so a local helper keeps this module free of an HTML-rendering dep.
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
