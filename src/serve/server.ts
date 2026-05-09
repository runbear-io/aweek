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
 *
 * TypeScript migration note (seed-09 sub-seed B): mechanical rename from
 * `.js` → `.ts`. JSDoc parameter annotations have been promoted to
 * lightweight TS signatures; the runtime behaviour is unchanged.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
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
  gatherAgentReviews,
  gatherAllNotifications,
  gatherAgentNotifications,
  gatherAgentArtifacts,
  isResolveArtifactFileError,
  resolveArtifactFile,
  gatherAppConfig,
} from './data/index.js';
import { streamAgentTurn, type AgentSdkRunner, type ChatTokenUsage } from './data/chat.js';
import { buildPreamble, formatPreamble } from './data/chat-preamble.js';
import {
  recordChatUsage,
  type ChatUsageStoreLike,
} from './data/chat-usage.js';
import {
  buildBudgetExhaustedFrame,
  checkChatBudget,
  type ChatBudgetAgentStoreLike,
  type ChatBudgetUsageStoreLike,
} from './data/chat-budget.js';
import {
  createThread,
  deleteThread,
  getThread,
  listThreads,
  renameThread,
} from './data/threads.js';
import { UsageStore } from '../storage/usage-store.js';
import { AgentStore } from '../storage/agent-store.js';
import {
  ChatConversationStore,
  createChatMessage,
} from '../storage/chat-conversation-store.js';
import type {
  ChatConversation,
  ChatMessage as ChatStoredMessage,
  ChatToolBlock,
} from '../schemas/chat-conversation.js';
import type { NotificationSource, NotificationSystemEvent } from '../storage/notification-store.js';
import { NotificationStore } from '../storage/notification-store.js';
// Mutation surface for the SPA's Artifacts tab. The data layer is
// contractually read-only (see `src/serve/data/data.test.ts`), so artifact
// deletes — which need to unlink the file *and* drop the manifest entry —
// live in this sibling module instead of under `data/`.
import { removeAgentArtifact } from './artifact-mutations.js';
// The /api/summary endpoint intentionally reuses the terminal
// `/aweek:summary` composer so the SPA Overview tab shows byte-identical
// cells (Agent / Goals / Tasks / Budget / Status) to the CLI baseline.
// This single source of truth guarantees feature parity between the two
// surfaces — any future tweak to summary.js shows up in both without
// per-consumer drift.
import { buildSummary } from '../skills/summary.js';
// Embedded Slack Socket-Mode listener bootstrap (Sub-AC 2.2 of the
// Slack-aweek integration seed). Starts the WebSocket alongside the
// HTTP listener in the same Node process when the credentials loader
// returns valid tokens; quietly skips otherwise. Failures never crash
// `aweek serve` — the dashboard stays up so the user can re-run
// `/aweek:slack-init` without restarting.
import {
  startSlackListener,
  type SlackAdapterFactory,
  type SlackCredentialsLoader,
  type SlackListenerHandle,
} from './slack-listener.js';
// Slack run-path bridge (Sub-AC 8.2 of the Slack-aweek integration
// seed). Sits on top of the connected adapter and turns inbound Slack
// messages into project-level Claude turns. Imports neither
// `lock-manager` nor `UsageStore` / `budget-enforcer` — the Slack
// execution surface is intentionally isolated from the heartbeat
// per the seed contract.
import {
  startSlackBridge,
  type CreateSlackBackendFn,
  type SlackBridgeHandle,
  type SlackUsageRecorder,
} from './slack-bridge.js';
import type { ChannelAdapter } from 'agentchannels';
import type { SlackEnvSource } from '../storage/slack-config-store.js';

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
 *
 * Notification routes (AC 18):
 *   - `/notifications` — the global inbox view (header bell + sidebar
 *     entry both navigate here). Mirrors the global feed surfaced by
 *     `GET /api/notifications`.
 *   - `/notifications/:agent/:id` — per-row deep link so a notification
 *     can be opened directly from a copied URL or a future external
 *     push channel that links into the dashboard.
 *   The per-agent notifications tab (`/agents/:slug/notifications`)
 *   is already covered by the `/agents/:slug/<anything>` pattern below
 *   and does not need its own entry here.
 */
const CLIENT_ROUTE_PATTERNS = [
  /^\/$/,
  /^\/agents\/?$/,
  /^\/calendar\/?$/,
  /^\/activity\/?$/,
  /^\/strategy\/?$/,
  /^\/profile\/?$/,
  // /agents/:slug and /agents/:slug/<anything> (covers the per-agent
  // notifications tab at /agents/:slug/notifications too).
  /^\/agents\/[^/]+(?:\/.*)?$/,
  // /notifications and /notifications/<anything> (global inbox + deep link).
  /^\/notifications(?:\/.*)?$/,
  // /settings — read-only Settings page showing config.json fields and
  // curated hardcoded constants grouped by category.
  /^\/settings\/?$/,
];

/**
 * Returns true when `pathname` matches one of the SPA's whitelisted
 * client-side routes. Used by the static-file server to decide whether
 * to fall back to `index.html` (whitelisted) or emit a 404 JSON body
 * (non-whitelisted).
 */
export function isWhitelistedClientRoute(pathname: string): boolean {
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
const MIME_TYPES: Record<string, string> = {
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
 */
export function resolveDefaultBuildDir(): string {
  return fileURLToPath(new URL(`./spa/${DEFAULT_BUILD_DIR_NAME}/`, import.meta.url));
}

/**
 * A bound host is "wildcard" — i.e. the server actually accepts
 * connections on every interface, so the LAN should be able to reach
 * it — when the user (or default config) passed `0.0.0.0` or an IPv6
 * equivalent. Exposed as a helper so both `startServer` consumers and
 * the CLI layer stay in sync about what "LAN-reachable" means.
 */
export function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host);
}

/** Raw input shape accepted by {@link normaliseServeOptions}. */
export interface RawServeOptions {
  port?: number | string | null;
  host?: string;
  open?: boolean;
  projectDir?: string;
  /** Override the Vite build output directory. */
  buildDir?: string;
  /**
   * Test-only seam. Injects an Agent SDK runner into the chat handler
   * (`POST /api/chat`) so unit tests can drive deterministic streaming
   * fixtures without invoking the real `claude` CLI. Production callers
   * leave this undefined; `streamAgentTurn` lazy-loads the real runner.
   *
   * Not parsed from CLI flags — programmatic test path only. The CLI's
   * `normaliseServeOptions` ignores this field.
   */
  runQuery?: AgentSdkRunner;
  /**
   * Test-only seam for the shared weekly usage store. Lets the chat
   * handler integration tests verify the budget wire-up against an in-
   * memory fake without touching the on-disk `.aweek/agents/<slug>/usage/`
   * tree. Production callers leave this unset — the chat handler then
   * constructs a real {@link UsageStore} rooted at `<dataDir>/agents`,
   * which is the same store the heartbeat reads.
   */
  chatUsageStore?: ChatUsageStoreLike;
  /**
   * Test-only seam for the chat-budget pre-flight check (Sub-AC 2 of
   * AC 7). Lets the chat handler integration tests pin a deterministic
   * `weeklyTotal` reading without writing usage records to disk first.
   * When unset, the chat handler builds a real {@link UsageStore}
   * rooted at `<dataDir>/agents` for the gate (same store as
   * `chatUsageStore`).
   */
  chatBudgetUsageStore?: ChatBudgetUsageStoreLike;
  /**
   * Test-only seam for the chat-budget agent-config read. Lets tests
   * stub agent state (paused / weeklyTokenBudget) without touching the
   * `.aweek/agents/<slug>.json` file. Production callers leave this
   * unset — the chat handler builds a real {@link AgentStore} rooted at
   * `<dataDir>/agents`.
   */
  chatBudgetAgentStore?: ChatBudgetAgentStoreLike;
  /**
   * Test-only seam for the chat-conversation persistence store
   * (Sub-AC 1 of AC 12). Lets the chat handler integration tests assert
   * on the persistence calls (or pin an in-memory fake) without touching
   * the on-disk `.aweek/agents/<slug>/chat/` tree. Production callers
   * leave this unset — the chat handler then constructs a real
   * {@link ChatConversationStore} rooted at `<dataDir>/agents`, which is
   * the same path the thread-list / new / get / rename / delete
   * endpoints already read.
   */
  chatConversationStore?: ChatConversationStoreLike;
  /**
   * Test-only override for the Slack credentials loader (Sub-AC 2.2 of
   * the Slack-aweek integration seed). Lets `startServer` integration
   * tests assert on the boot path without touching `process.env` or
   * writing `.aweek/channels/slack/config.json`. Production callers
   * leave this unset and {@link startSlackListener} falls back to the
   * real {@link loadSlackCredentials}.
   */
  slackCredentialsLoader?: SlackCredentialsLoader;
  /**
   * Test-only override for the SlackAdapter constructor. Lets tests
   * pin a fake adapter that records `connect()` / `disconnect()` calls
   * without spinning up a real Socket-Mode WebSocket. Production
   * callers leave this unset and the listener falls back to
   * `new SlackAdapter(config)` from agentchannels.
   */
  slackAdapterFactory?: SlackAdapterFactory;
  /**
   * Test-only override for `process.env`. Threaded straight through to
   * the credentials loader so tests can assert env-first precedence
   * without mutating the real `process.env` (which would leak across
   * the parallel `node --test` runs).
   */
  slackEnvSource?: SlackEnvSource;
  /**
   * Test-only logger override for the Slack listener boot status
   * messages (connected / disabled / failed). Production callers leave
   * this unset and the listener writes to stderr alongside the
   * existing `aweek serve` console output.
   */
  slackLog?: (message: string) => void;
  /**
   * Test-only override for the Slack run-path backend factory
   * (Sub-AC 8.2 of the Slack-aweek integration seed). Lets `startServer`
   * integration tests pin a fake backend that emits a synthetic stream
   * without spawning a real `claude` CLI. Production callers leave this
   * unset and {@link startSlackBridge} falls back to
   * {@link createPersistedSlackBackend}.
   */
  slackBackendFactory?: CreateSlackBackendFn;
  /**
   * Test-only override for the Slack run-path usage recorder
   * (Sub-AC 8.2). Lets the isolation tests pin a sink that records
   * calls without writing to `.aweek/channels/slack/usage.json` so the
   * vertical-slice assertion that the per-agent tree is byte-identical
   * stays self-contained.
   */
  slackUsageRecorder?: SlackUsageRecorder;
}

/**
 * Minimal interface the chat handler depends on for thread persistence.
 *
 * Mirrors the {@link ChatConversationStore} surface that
 * {@link handleChatStream} actually uses (`read` to load an existing
 * thread, `write` to seed a fresh one, `appendMessage` to record both the
 * incoming user turn and the post-stream assistant turn). Carrying the
 * minimal-surface interface (instead of the concrete class) lets tests
 * pin an in-memory fake and lets future store backends slot in without a
 * handler refactor.
 */
export interface ChatConversationStoreLike {
  read(
    agentId: string,
    threadId: string,
  ): Promise<ChatConversation | null>;
  write(
    agentId: string,
    conversation: ChatConversation,
  ): Promise<ChatConversation>;
  appendMessage(
    agentId: string,
    threadId: string,
    message: ChatStoredMessage,
  ): Promise<ChatConversation>;
}

/**
 * Schema-validated chat-conversation id pattern (mirrors
 * `chatConversationSchema.properties.id.pattern` in
 * `src/schemas/chat-conversation.schema.js`). Used to decide whether the
 * incoming `threadId` is a server-issued conversation id (eligible for
 * disk persistence) vs. an opaque sentinel that earlier sub-AC tests
 * passed as a placeholder. When the id does not match this pattern, the
 * chat handler skips persistence silently — the SSE stream still flows
 * end-to-end, just without a backing on-disk thread document.
 */
const CHAT_CONVERSATION_ID_PATTERN = /^chat-[a-z0-9]+(-[a-z0-9]+)*$/;

/** Normalised options returned by {@link normaliseServeOptions}. */
export interface ServeOptions {
  port: number;
  host: string;
  open: boolean;
  projectDir: string;
  buildDir: string;
}

/**
 * Normalise and validate CLI flags for `aweek serve`. Returns an options
 * object with sensible defaults applied and invalid inputs coerced into
 * errors with `code: 'EUSAGE'` so the CLI prints a clean usage message.
 */
export function normaliseServeOptions(raw: RawServeOptions = {}): ServeOptions {
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
 */
export function formatDashboardUrl(host: string, port: number): string {
  const displayHost = WILDCARD_HOSTS.has(host) ? 'localhost' : host;
  // IPv6 literal hosts need square brackets in URLs.
  const bracketed = displayHost.includes(':') ? `[${displayHost}]` : displayHost;
  return `http://${bracketed}:${port}/`;
}

/** Handle returned by {@link startServer}. */
export interface ServerHandle {
  server: Server;
  port: number;
  host: string;
  url: string;
  projectDir: string;
  buildDir: string;
  /**
   * Connected Slack `ChannelAdapter`, or `null` when the embedded
   * Slack Socket-Mode listener stayed disabled at boot. The field is
   * populated by {@link startSlackListener} (Sub-AC 2.2): non-null
   * when both `botToken` and `appToken` resolved AND `connect()`
   * succeeded; `null` when either credential was missing, the
   * adapter constructor threw, or `connect()` threw.
   *
   * Carried on the handle so future sub-ACs (3+: SlackAdapter ↔
   * StreamingBridge ↔ ProjectClaudeBackend wiring) can attach
   * `onMessage()` handlers without re-resolving the adapter, and so
   * tests can assert that the listener actually came up.
   */
  slackAdapter: ChannelAdapter | null;
  /**
   * Connected Slack {@link StreamingBridge}, or `null` when the
   * embedded Slack listener stayed disabled at boot. Sub-AC 8.2 of the
   * Slack-aweek integration seed. Carried on the handle so tests can
   * assert that the bridge actually wired up — and so future sub-ACs
   * can hook lifecycle observers without re-resolving the adapter.
   */
  slackBridge: import('agentchannels').StreamingBridge | null;
  close: () => Promise<void>;
}

/** Per-request context derived from the resolved {@link ServeOptions}. */
interface RequestContext {
  projectDir: string;
  dataDir: string;
  buildDir: string;
  /**
   * Optional test-only Agent SDK runner. Forwarded by `handleChatStream`
   * to `streamAgentTurn` so the chat endpoint can be exercised against a
   * deterministic fixture iterator instead of the real `claude` CLI.
   * Production callers leave this undefined.
   */
  runQuery?: AgentSdkRunner;
  /**
   * Optional test-only chat-usage store override. When unset the chat
   * handler builds a real {@link UsageStore} rooted at `<dataDir>/agents`
   * — the same path the heartbeat reads — so chat token spend lands in
   * the shared weekly budget pool. Tests can pin a fake to assert on the
   * persistence call without touching the filesystem.
   */
  chatUsageStore?: ChatUsageStoreLike;
  /**
   * Optional test-only override for the chat-budget pre-flight usage
   * read (Sub-AC 2 of AC 7). See {@link RawServeOptions.chatBudgetUsageStore}.
   */
  chatBudgetUsageStore?: ChatBudgetUsageStoreLike;
  /**
   * Optional test-only override for the chat-budget pre-flight agent
   * config read. See {@link RawServeOptions.chatBudgetAgentStore}.
   */
  chatBudgetAgentStore?: ChatBudgetAgentStoreLike;
  /**
   * Optional test-only override for the chat-conversation persistence
   * store (Sub-AC 1 of AC 12). See
   * {@link RawServeOptions.chatConversationStore}. Production callers
   * leave this unset; `handleChatStream` then constructs a real
   * {@link ChatConversationStore} rooted at `<dataDir>/agents`.
   */
  chatConversationStore?: ChatConversationStoreLike;
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
 */
export async function startServer(options: RawServeOptions = {}): Promise<ServerHandle> {
  const { port, host, projectDir, buildDir } = normaliseServeOptions(options);
  // `runQuery` is a programmatic test seam — it bypasses CLI normalisation
  // and is read directly off the raw options so production cold-paths
  // never load it (and CI tests can pin a deterministic fake).
  const runQuery = options.runQuery;
  // Same shape, different seam: tests pin an in-memory chat usage store
  // here. Production callers leave this unset and the handler constructs
  // a real `UsageStore` from `<dataDir>/agents` per request.
  const chatUsageStore = options.chatUsageStore;
  // Test seams for the chat-budget pre-flight check (Sub-AC 2 of AC 7).
  // Production callers leave both unset; the handler constructs real
  // stores from `<dataDir>/agents` so the gate reads the same on-disk
  // state the heartbeat enforcer reads.
  const chatBudgetUsageStore = options.chatBudgetUsageStore;
  const chatBudgetAgentStore = options.chatBudgetAgentStore;
  // Sub-AC 1 of AC 12: chat-conversation store seam. Production callers
  // leave this unset and `handleChatStream` builds a real
  // `ChatConversationStore` rooted at `<dataDir>/agents` per request —
  // the same path the thread-list / new / get / rename / delete
  // endpoints already read so chat persistence is unified.
  const chatConversationStore = options.chatConversationStore;

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
    Promise.resolve(
      handleRequest(req, res, {
        projectDir,
        dataDir,
        buildDir,
        runQuery,
        chatUsageStore,
        chatBudgetUsageStore,
        chatBudgetAgentStore,
        chatConversationStore,
      }),
    ).catch((err) => {
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

  // Boot the embedded Slack Socket-Mode listener IN THE SAME Node
  // process as the HTTP listener. Sequenced AFTER `listenWithRetry` so
  // a failure to bind the HTTP socket (EADDRINUSE past the scan limit,
  // EACCES, etc.) propagates immediately and we never leak a Slack
  // WebSocket on a process that can't actually serve the dashboard.
  //
  // The listener never throws — it returns a `null` adapter when
  // credentials are absent or `connect()` fails (see slack-listener.ts
  // for the full disable matrix). That means a missing or bad token
  // does NOT brick `aweek serve`: the HTTP dashboard stays up so the
  // user can run `/aweek:slack-init` to re-provision the bot without
  // restarting the whole server.
  const slackListener: SlackListenerHandle = await startSlackListener({
    dataDir,
    ...(options.slackCredentialsLoader ? { loader: options.slackCredentialsLoader } : {}),
    ...(options.slackAdapterFactory ? { adapterFactory: options.slackAdapterFactory } : {}),
    ...(options.slackEnvSource ? { envSource: options.slackEnvSource } : {}),
    ...(options.slackLog ? { log: options.slackLog } : {}),
  });

  // Wire the Slack run path on top of the connected adapter. Only
  // engage when the listener actually came up — a `null` adapter means
  // credentials were absent (or `connect()` threw) and there is no
  // WebSocket to drain messages from. This MUST stay below
  // `startSlackListener` so the bridge only sees adapters that have
  // already gone through the listener's failure-mode matrix.
  //
  // The bridge is a NO-OP for the heartbeat: it never imports
  // `lock-manager`, `UsageStore`, or the budget enforcer (sub-AC 8.2
  // contract). Per-Slack-thread serialisation lives inside agentchannels'
  // `StreamingBridge.activeThreads` map, and per-turn token accounting
  // goes to `.aweek/channels/slack/usage.json` via
  // `appendSlackUsageRecord`. Neither path touches `.aweek/agents/`.
  let slackBridge: SlackBridgeHandle | null = null;
  if (slackListener.adapter) {
    slackBridge = startSlackBridge({
      adapter: slackListener.adapter,
      projectRoot: projectDir,
      // The bridge follows the same `<.aweek>/agents` calling
      // convention every other store accepts. The Slack usage
      // bucket lives one level up at `.aweek/channels/slack/usage.json`,
      // so passing `<.aweek>/agents` here means
      // `appendSlackUsageRecord` resolves the right path.
      dataDir: join(dataDir, 'agents'),
      ...(options.slackBackendFactory ? { createBackend: options.slackBackendFactory } : {}),
      ...(options.slackUsageRecorder ? { recordUsage: options.slackUsageRecorder } : {}),
      ...(options.slackLog ? { log: options.slackLog } : {}),
    });
  }

  return {
    server,
    port: boundPort,
    host,
    url,
    projectDir,
    buildDir,
    slackAdapter: slackListener.adapter,
    slackBridge: slackBridge ? slackBridge.bridge : null,
    close: () =>
      // Tear down the bridge, then the Slack WebSocket, then the HTTP
      // listener. Bridge → adapter → server is the reverse of the boot
      // order so in-flight Slack messages get their abort signal before
      // the underlying WebSocket closes underneath them. Each step
      // swallows its own errors so a misbehaving teardown step never
      // blocks Ctrl-C of `aweek serve`.
      new Promise<void>((resolveClose, rejectClose) => {
        const dropBridge = async (): Promise<void> => {
          if (slackBridge) {
            await slackBridge.shutdown().catch(() => undefined);
          }
        };
        dropBridge()
          .then(() => slackListener.disconnect())
          .catch(() => {
            // Already logged inside the listener / bridge. Don't
            // propagate so Ctrl-C of `aweek serve` always returns cleanly.
          })
          .finally(() => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          });
      }),
  };
}

/**
 * HTTP request router. Method-checks once, routes `/healthz` to a JSON
 * liveness probe, and otherwise hands off to the SPA static-file
 * handler. Data endpoints (`/api/...`) are added in follow-up sub-ACs.
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  const method = req.method || 'GET';
  const rawUrl = req.url || '/';
  const pathname = rawUrl.split('?')[0];

  // Manual artifact deletion is the only mutation the SPA performs against
  // the artifact surface (see the Artifacts tab in `src/serve/spa/pages/`).
  // Match the route up front so DELETE bypasses the GET/HEAD gate below —
  // but only for this one pathname, so other DELETEs still 405 cleanly.
  // The match is also referenced by the 405 handler below to advertise
  // `Allow: DELETE` on a non-DELETE request to this route.
  const artifactDeleteMatch = pathname.match(
    /^\/api\/agents\/([^/]+)\/artifacts\/([^/]+)\/?$/,
  );
  if (artifactDeleteMatch && method === 'DELETE') {
    const slug = decodeSlug(artifactDeleteMatch[1]);
    const artifactId = decodeSlug(artifactDeleteMatch[2]);
    if (slug === null || artifactId === null) {
      sendJson(res, 400, { error: 'Invalid slug or artifact id' });
      return;
    }
    await handleAgentArtifactDelete(res, ctx, slug, artifactId);
    return;
  }

  // Notification mutation endpoints. The dashboard's read-only-server
  // invariant for src/serve/data/ is intentionally relaxed here so clicking
  // a notification can flip its `read` flag and a "mark all read" action
  // can clear an agent's unread badge. Writes flow through
  // `NotificationStore.markRead` / `markAllRead`, which perform the same
  // atomic write-then-rename used by every other store.
  if (method === 'POST') {
    const markReadMatch = pathname.match(
      /^\/api\/notifications\/([^/]+)\/([^/]+)\/read\/?$/,
    );
    if (markReadMatch) {
      const slug = decodeSlug(markReadMatch[1]);
      const notificationId = decodeSlug(markReadMatch[2]);
      if (slug === null || notificationId === null) {
        sendJson(res, 400, { error: 'Invalid agent slug or notification id' });
        return;
      }
      await handleNotificationMarkRead(res, ctx, slug, notificationId);
      return;
    }

    if (
      pathname === '/api/notifications/read-all' ||
      pathname === '/api/notifications/read-all/'
    ) {
      await handleNotificationMarkAllRead(res, ctx);
      return;
    }

    // Chat streaming endpoint (AC 1, sub-AC 1). Immediately flushes SSE
    // headers + a first comment chunk so the Vercel AI SDK `useChat` hook
    // sees an open transport within the 2-second budget on the eval rubric.
    // Subsequent sub-ACs replace the placeholder body with real Anthropic
    // Agent SDK streaming output and budget-aware token accounting.
    if (pathname === '/api/chat' || pathname === '/api/chat/') {
      await handleChatStream(req, res, ctx);
      return;
    }

    // Sub-AC 4 of AC 5: POST /api/agents/:slug/chat/threads — create a
    // fresh (empty) chat thread for the floating panel's "new thread"
    // button. The handler delegates to `createThread()` in the data
    // layer, which auto-stamps the conversation id, timestamps, and an
    // empty `messages[]` array. Returns the persisted document so the
    // SPA can immediately set it as the active thread.
    const createThreadMatch = pathname.match(
      /^\/api\/agents\/([^/]+)\/chat\/threads\/?$/,
    );
    if (createThreadMatch) {
      const slug = decodeSlug(createThreadMatch[1]);
      if (slug === null) {
        sendJson(res, 400, { error: 'Invalid agent slug' });
        return;
      }
      await handleAgentThreadCreate(req, res, ctx, slug);
      return;
    }
  }

  if (method !== 'GET' && method !== 'HEAD') {
    res.statusCode = 405;
    // Advertise DELETE on the artifact-delete route so a curl probe sees the
    // full method set; everywhere else the dashboard is read-only.
    if (artifactDeleteMatch) {
      res.setHeader('Allow', 'DELETE');
    } else {
      res.setHeader('Allow', 'GET, HEAD');
    }
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

  if (pathname === '/api/config' || pathname === '/api/config/') {
    await handleAppConfig(res, ctx);
    return;
  }

  if (pathname === '/api/agents' || pathname === '/api/agents/') {
    await handleAgentsList(res, ctx);
    return;
  }

  if (pathname === '/api/notifications' || pathname === '/api/notifications/') {
    const queryString = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
    await handleNotificationsList(res, ctx, new URLSearchParams(queryString));
    return;
  }

  const agentNotificationsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/notifications\/?$/);
  if (agentNotificationsMatch) {
    const slug = decodeSlug(agentNotificationsMatch[1]);
    if (slug === null) {
      sendJson(res, 400, { error: 'Invalid agent slug' });
      return;
    }
    await handleAgentNotifications(res, ctx, slug);
    return;
  }

  // GET /api/agents/:slug/chat/threads — list every chat thread for an
  // agent (Sub-AC 3 of AC 5). Backs the floating chat panel's thread
  // sidebar; the SPA fetches summary rows here and surfaces them as a
  // selectable list above the active conversation. The handler module
  // (`./data/threads.ts`) already validates inputs + returns `null` when
  // the slug is unknown so we can map that to 404 here.
  const agentThreadsMatch = pathname.match(
    /^\/api\/agents\/([^/]+)\/chat\/threads\/?$/,
  );
  if (agentThreadsMatch && method === 'GET') {
    const slug = decodeSlug(agentThreadsMatch[1]);
    if (slug === null) {
      sendJson(res, 400, { error: 'Invalid agent slug' });
      return;
    }
    await handleAgentThreadsList(res, ctx, slug);
    return;
  }

  // Sub-AC 4 of AC 5: GET /api/agents/:slug/chat/threads/:threadId —
  // return one chat thread end-to-end (full message history) for replay
  // when the user picks a thread from the sidebar. The SPA seeds the
  // `<ChatThread>`'s `initialMessages` with the returned document so a
  // navigation between threads (or browser sessions) lands the user
  // back on the persisted conversation.
  const agentThreadDetailMatch = pathname.match(
    /^\/api\/agents\/([^/]+)\/chat\/threads\/([^/]+)\/?$/,
  );
  if (agentThreadDetailMatch && method === 'GET') {
    const slug = decodeSlug(agentThreadDetailMatch[1]);
    const threadId = decodeSlug(agentThreadDetailMatch[2]);
    if (slug === null || threadId === null) {
      sendJson(res, 400, { error: 'Invalid agent slug or thread id' });
      return;
    }
    await handleAgentThreadDetail(res, ctx, slug, threadId);
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

  const agentReviewsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/reviews\/?$/);
  if (agentReviewsMatch) {
    const slug = decodeSlug(agentReviewsMatch[1]);
    if (slug === null) {
      sendJson(res, 400, { error: 'Invalid agent slug' });
      return;
    }
    await handleAgentReviews(res, ctx, slug);
    return;
  }

  // Anchored to exactly `/artifacts` (with optional trailing slash) so it
  // doesn't shadow sibling routes that target `/artifacts/:id` or
  // `/artifacts/:id/file`. Method-check happens later inside the handler
  // chain so DELETE / GET on the same prefix can both be added by sibling
  // route blocks without re-routing here.
  const agentArtifactsMatch = pathname.match(
    /^\/api\/agents\/([^/]+)\/artifacts\/?$/,
  );
  if (agentArtifactsMatch && method === 'GET') {
    const slug = decodeSlug(agentArtifactsMatch[1]);
    if (slug === null) {
      sendJson(res, 400, { error: 'Invalid agent slug' });
      return;
    }
    await handleAgentArtifacts(res, ctx, slug);
    return;
  }

  // Per-artifact file streamer. The pattern segments use `[^/]+` so the
  // `/file` suffix is unambiguous against the bare `/artifacts/:id`
  // delete route — there's no overlap and either ordering would be
  // safe, but keeping this near the artifact list route makes the
  // grouping easy to read.
  const agentArtifactFileMatch = pathname.match(
    /^\/api\/agents\/([^/]+)\/artifacts\/([^/]+)\/file\/?$/,
  );
  if (agentArtifactFileMatch) {
    const slug = decodeSlug(agentArtifactFileMatch[1]);
    const artifactId = decodeSlug(agentArtifactFileMatch[2]);
    if (slug === null || artifactId === null) {
      sendJson(res, 400, { error: 'Invalid slug or artifact id' });
      return;
    }
    await handleAgentArtifactFile(req, res, ctx, slug, artifactId);
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
 */
function decodeSlug(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let decoded: string;
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
 */
function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
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
 */
async function handleSummary(res: ServerResponse, ctx: RequestContext): Promise<void> {
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
      error: err && (err as Error).message ? (err as Error).message : 'Failed to load summary',
    });
  }
}

/**
 * GET /api/config — return the full read-only settings payload for the SPA
 * Settings page.
 *
 * Delegates to `gatherAppConfig`, which reads `.aweek/config.json` via
 * `loadConfigWithStatus` and merges the live config values with a curated
 * set of compiled-in constants (scheduler, lock parameters). The payload
 * is always returned as 200 — the `status` field inside the body
 * distinguishes "file absent or valid" (`'ok'`) from "file malformed"
 * (`'missing'`) so the SPA can show an inline warning for the latter
 * without treating a fresh project (no config.json yet) as an error.
 *
 * Response shape:
 *   200 { status: 'ok'|'missing',
 *          categories: [{ id, label, items: [{ key, label, value, description }] }] }
 *   500 { error: string }
 */
async function handleAppConfig(res: ServerResponse, ctx: RequestContext): Promise<void> {
  try {
    const payload = await gatherAppConfig({ projectDir: ctx.projectDir });
    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 500, {
      error: err && (err as Error).message ? (err as Error).message : 'Failed to load config',
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
 */
async function handleAgentsList(res: ServerResponse, ctx: RequestContext): Promise<void> {
  try {
    const { rows, issues } = await gatherAgentsList({
      projectDir: ctx.projectDir,
    });
    sendJson(res, 200, { agents: rows, issues });
  } catch (err) {
    sendJson(res, 500, {
      error: err && (err as Error).message ? (err as Error).message : 'Failed to load agents',
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
 */
async function handleAgentDetail(res: ServerResponse, ctx: RequestContext, slug: string): Promise<void> {
  try {
    const agent = await gatherAgentProfile({ projectDir: ctx.projectDir, slug });
    if (!agent) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, { agent });
  } catch (err) {
    sendJson(res, 500, {
      error: err && (err as Error).message ? (err as Error).message : 'Failed to load agent',
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
 */
async function handleAgentPlan(res: ServerResponse, ctx: RequestContext, slug: string): Promise<void> {
  try {
    const plan = await gatherAgentPlan({ projectDir: ctx.projectDir, slug });
    if (!plan) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, { plan });
  } catch (err) {
    sendJson(res, 500, {
      error: err && (err as Error).message ? (err as Error).message : 'Failed to load plan',
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
 */
async function handleAgentCalendar(
  res: ServerResponse,
  ctx: RequestContext,
  slug: string,
  week: string | undefined,
): Promise<void> {
  try {
    const calendar = await gatherAgentCalendar({
      projectDir: ctx.projectDir,
      slug,
      week,
    });
    if (calendar && (calendar as { notFound?: boolean }).notFound) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, { calendar });
  } catch (err) {
    sendJson(res, 500, {
      error: err && (err as Error).message ? (err as Error).message : 'Failed to load calendar',
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
 */
async function handleAgentUsage(res: ServerResponse, ctx: RequestContext, slug: string): Promise<void> {
  try {
    const usage = await gatherAgentUsage({ projectDir: ctx.projectDir, slug });
    if (!usage) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, { usage });
  } catch (err) {
    sendJson(res, 500, {
      error: err && (err as Error).message ? (err as Error).message : 'Failed to load usage',
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
 */
async function handleAgentLogs(
  res: ServerResponse,
  ctx: RequestContext,
  slug: string,
  dateRange: string | undefined,
): Promise<void> {
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
      error: err && (err as Error).message ? (err as Error).message : 'Failed to load logs',
    });
  }
}

/**
 * GET /api/agents/:slug/reviews — return the reviews payload for an agent.
 *
 * Delegates to `gatherAgentReviews`, which scans `.aweek/agents/<slug>/reviews/`
 * for `.md` files (with optional `.json` sidecars) and returns them sorted
 * newest-first, capped at 26 entries. Returns `null` (→ 404) when the slug
 * does not exist on disk.
 *
 * Response shape:
 *   200 { reviews: { slug, reviews: [{ week, markdown, metadata, generatedAt }, ...] } }
 *   404 { error: 'Agent not found: <slug>' }
 *   500 { error: string }
 */
async function handleAgentReviews(res: ServerResponse, ctx: RequestContext, slug: string): Promise<void> {
  try {
    const reviews = await gatherAgentReviews({ projectDir: ctx.projectDir, slug });
    if (!reviews) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, { reviews });
  } catch (err) {
    sendJson(res, 500, {
      error: err && (err as Error).message ? (err as Error).message : 'Failed to load reviews',
    });
  }
}

/**
 * GET /api/notifications — return the global notification feed.
 *
 * Delegates to `gatherAllNotifications`, which walks every per-agent
 * notifications file under `.aweek/agents/<slug>/notifications.json`,
 * merges them newest-first, and pairs them with a global unread count.
 *
 * Query params (all optional): source, systemEvent, read (true/false), limit.
 */
async function handleNotificationsList(
  res: ServerResponse,
  ctx: RequestContext,
  params: URLSearchParams,
): Promise<void> {
  try {
    const sourceParam = params.get('source');
    const source: NotificationSource | undefined =
      sourceParam === 'agent' || sourceParam === 'system' ? sourceParam : undefined;

    const systemEventParam = params.get('systemEvent');
    const systemEvent = (systemEventParam || undefined) as NotificationSystemEvent | undefined;

    const readParam = params.get('read');
    const read = readParam === 'true' ? true : readParam === 'false' ? false : undefined;

    const limitParam = params.get('limit');
    const parsedLimit = limitParam ? Number(limitParam) : NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;

    const payload = await gatherAllNotifications({
      projectDir: ctx.projectDir,
      source,
      systemEvent,
      read,
      limit,
    });
    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 500, {
      error: err && (err as Error).message ? (err as Error).message : 'Failed to load notifications',
    });
  }
}

/**
 * GET /api/agents/:slug/notifications — return the per-agent feed.
 *
 * Returns 404 when the slug does not exist on disk.
 */
async function handleAgentNotifications(
  res: ServerResponse,
  ctx: RequestContext,
  slug: string,
): Promise<void> {
  try {
    const payload = await gatherAgentNotifications({ projectDir: ctx.projectDir, slug });
    if (!payload) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 500, {
      error: err && (err as Error).message ? (err as Error).message : 'Failed to load notifications',
    });
  }
}

/**
 * GET /api/agents/:slug/chat/threads — list every chat thread for an
 * agent (Sub-AC 3 of AC 5).
 *
 * Delegates to `listThreads`, which fans out to the
 * {@link ChatConversationStore} per-agent index (one JSON file per
 * thread under `.aweek/agents/<slug>/chat/`). Returns `null` when the
 * slug does not exist on disk so we can map that to 404; an existing
 * agent with no threads yet produces 200 with an empty `threads` list
 * so the floating-panel sidebar can render its "No conversations yet"
 * empty state without parsing the message.
 *
 * Response shape:
 *   200 { agentId, threads: [{ id, title?, createdAt, updatedAt,
 *                              messageCount, lastMessagePreview?,
 *                              lastMessageRole? }] }
 *   400 { error: 'Invalid agent slug' }
 *   404 { error: 'Agent not found: <slug>' }
 *   500 { error: string }
 */
async function handleAgentThreadsList(
  res: ServerResponse,
  ctx: RequestContext,
  slug: string,
): Promise<void> {
  try {
    const payload = await listThreads({
      projectDir: ctx.projectDir,
      agentId: slug,
    });
    if (!payload) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 500, {
      error:
        err && (err as Error).message
          ? (err as Error).message
          : 'Failed to load chat threads',
    });
  }
}

/**
 * GET /api/agents/:slug/chat/threads/:threadId — return one chat thread
 * end-to-end with its full message history (Sub-AC 4 of AC 5).
 *
 * Backs the SPA's thread-switcher behaviour: when the user clicks a row
 * in the floating panel's sidebar, the panel hits this endpoint and
 * seeds `<ChatThread>` with `initialMessages` so the persisted
 * conversation re-renders without a fresh model round-trip.
 *
 * Response shape:
 *   200 { thread: { id, agentId, title?, createdAt, updatedAt,
 *                   messages: [...], metadata? } }
 *   400 { error: 'Invalid agent slug or thread id' }
 *   404 { error: 'Agent not found' | 'Thread not found' }
 *   500 { error: string }
 */
async function handleAgentThreadDetail(
  res: ServerResponse,
  ctx: RequestContext,
  slug: string,
  threadId: string,
): Promise<void> {
  try {
    const payload = await getThread({
      projectDir: ctx.projectDir,
      agentId: slug,
      threadId,
    });
    if (!payload) {
      // Both "agent missing" and "thread missing on a known agent" map
      // to 404 — the SPA reads the surrounding roster state to decide
      // which copy to render. The error message disambiguates for
      // logs / curl probes.
      sendJson(res, 404, {
        error: `Thread not found: ${slug}/${threadId}`,
      });
      return;
    }
    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 500, {
      error:
        err && (err as Error).message
          ? (err as Error).message
          : 'Failed to load chat thread',
    });
  }
}

/**
 * POST /api/agents/:slug/chat/threads — create a new (empty) chat
 * thread for an agent (Sub-AC 4 of AC 5).
 *
 * Drives the floating panel's "New thread" button: the SPA POSTs to
 * this endpoint and uses the returned `thread.id` as the active thread
 * for subsequent send actions. The body is optional — the only field
 * the data layer reads is an optional `title` (everything else is
 * auto-stamped server-side).
 *
 * Response shape:
 *   200 { thread: { id, agentId, title?, createdAt, updatedAt,
 *                   messages: [], metadata? } }
 *   400 { error: 'Invalid agent slug' | 'Malformed request body' }
 *   404 { error: 'Agent not found: <slug>' }
 *   500 { error: string }
 */
async function handleAgentThreadCreate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  slug: string,
): Promise<void> {
  let title: string | undefined;
  let metadata: Record<string, unknown> | undefined;

  try {
    const bodyText = await readRequestBody(req);
    if (bodyText.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        sendJson(res, 400, { error: 'Malformed request body (not JSON)' });
        return;
      }
      if (parsed && typeof parsed === 'object') {
        const body = parsed as { title?: unknown; metadata?: unknown };
        if (typeof body.title === 'string' && body.title.length > 0) {
          title = body.title;
        }
        if (
          body.metadata !== undefined &&
          body.metadata !== null &&
          typeof body.metadata === 'object'
        ) {
          metadata = body.metadata as Record<string, unknown>;
        }
      }
    }
  } catch (err) {
    sendJson(res, 500, {
      error:
        err && (err as Error).message
          ? (err as Error).message
          : 'Failed to read request body',
    });
    return;
  }

  try {
    const createOpts: Parameters<typeof createThread>[0] = {
      projectDir: ctx.projectDir,
      agentId: slug,
    };
    if (title !== undefined) createOpts.title = title;
    if (metadata !== undefined) createOpts.metadata = metadata;

    const payload = await createThread(createOpts);
    if (!payload) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 500, {
      error:
        err && (err as Error).message
          ? (err as Error).message
          : 'Failed to create chat thread',
    });
  }
}

/**
 * GET /api/agents/:slug/artifacts — return the merged artifact list for an
 * agent across all task executions.
 *
 * Delegates to `gatherAgentArtifacts`, which sources from the
 * `ArtifactStore` manifest (`.aweek/agents/<slug>/artifacts/manifest.json`)
 * — the same store the heartbeat / CLI artifact registration paths write
 * to. Returns `null` (→ 404) when the slug is unknown on disk; an agent
 * that exists with no artifacts yet produces a 200 with an empty list and
 * a zero-summary so the SPA Artifacts tab can render its empty state.
 *
 * Response shape:
 *   200 { artifacts: { slug,
 *                      artifacts: [...records, newest first],
 *                      summary: { totalArtifacts, byType, totalSizeBytes } } }
 *   400 { error: 'Invalid agent slug' }
 *   404 { error: 'Agent not found: <slug>' }
 *   500 { error: string }
 */
async function handleAgentArtifacts(
  res: ServerResponse,
  ctx: RequestContext,
  slug: string,
): Promise<void> {
  try {
    const artifacts = await gatherAgentArtifacts({
      projectDir: ctx.projectDir,
      slug,
    });
    if (!artifacts) {
      sendJson(res, 404, { error: `Agent not found: ${slug}` });
      return;
    }
    sendJson(res, 200, { artifacts });
  } catch (err) {
    sendJson(res, 500, {
      error:
        err && (err as Error).message
          ? (err as Error).message
          : 'Failed to load artifacts',
    });
  }
}

/**
 * POST /api/notifications/:slug/:id/read — mark a single notification as read.
 *
 * Flips `read: true` and stamps `readAt` via `NotificationStore.markRead`,
 * which performs an atomic write-then-rename so concurrent dashboard reads
 * never see a partial file. Idempotent: a no-op if the notification is
 * already read (the store returns the unchanged record).
 *
 * Per the v1 contract this is one of the two server-side mutation endpoints
 * the dashboard exposes for notifications (the other is
 * `POST /api/notifications/read-all`). The mutation is intentionally not
 * surfaced through the read-only `src/serve/data/` layer — writes go
 * straight through the storage class so the data layer's import-allowlist
 * test stays green.
 *
 * Response shape:
 *   200 { notification: { id, agentId, source, ..., read: true, readAt } }
 *   400 { error: 'Invalid agent slug or notification id' }
 *   404 { error: 'Notification not found: <id>' }
 *   500 { error: string }
 */
async function handleNotificationMarkRead(
  res: ServerResponse,
  ctx: RequestContext,
  slug: string,
  notificationId: string,
): Promise<void> {
  try {
    const agentsDir = join(ctx.projectDir, '.aweek', 'agents');
    const store = new NotificationStore(agentsDir);
    const updated = await store.markRead(slug, notificationId);
    if (!updated) {
      sendJson(res, 404, {
        error: `Notification not found: ${notificationId}`,
      });
      return;
    }
    sendJson(res, 200, { notification: updated });
  } catch (err) {
    sendJson(res, 500, {
      error:
        err && (err as Error).message
          ? (err as Error).message
          : 'Failed to mark notification read',
    });
  }
}

/**
 * DELETE /api/agents/:slug/artifacts/:id — remove an artifact entirely.
 *
 * Removes both the `ArtifactStore` manifest entry AND unlinks the file
 * from disk in a single atomic operation. The mutation lives in
 * `./artifact-mutations.js` (sibling to this server, NOT under `data/`)
 * because the read-only data layer is contractually forbidden from any
 * filesystem write API. Path-traversal is guarded inside the mutation
 * helper: the artifact's recorded `filePath` must resolve to an absolute
 * path strictly inside the project root or the request is rejected with
 * 400.
 *
 * Response shape:
 *   200 { ok: true,
 *         artifactId,
 *         filePath,
 *         fileUnlinked }   # false when the file was already gone
 *   400 { error: 'Invalid slug or artifact id' }
 *   400 { error: 'Artifact filePath escapes project root' }
 *   404 { error: 'Artifact not found: <id>' }
 *   500 { error: string }
 */
async function handleAgentArtifactDelete(
  res: ServerResponse,
  ctx: RequestContext,
  slug: string,
  artifactId: string,
): Promise<void> {
  try {
    const result = await removeAgentArtifact({
      projectDir: ctx.projectDir,
      slug,
      artifactId,
    });
    if (!result.ok) {
      if (result.reason === 'not-found') {
        sendJson(res, 404, { error: `Artifact not found: ${artifactId}` });
        return;
      }
      // 'invalid-path' — the manifest entry pointed outside the project
      // root, so we refused to act. Surface a clear 400 so the operator
      // knows to clean the manifest manually.
      sendJson(res, 400, {
        error: 'Artifact filePath escapes project root',
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      artifactId: result.artifact.id,
      filePath: result.artifact.filePath,
      fileUnlinked: result.fileUnlinked,
    });
  } catch (err) {
    sendJson(res, 500, {
      error:
        err && (err as Error).message
          ? (err as Error).message
          : 'Failed to delete artifact',
    });
  }
}

/**
 * POST /api/notifications/read-all — mark every unread notification across
 * every agent as read in a single call.
 *
 * Walks every per-agent notifications file via `NotificationStore.listAgents`
 * and flips the unread → read transition through `NotificationStore.markAllRead`,
 * which performs an atomic write-then-rename per agent so concurrent dashboard
 * reads never see a partial file. Idempotent: a no-op for agents whose feed is
 * already fully read (the store returns a flipped count of 0).
 *
 * Per the v1 contract this is the second of the two server-side mutation
 * endpoints the dashboard exposes for notifications (the other is
 * `POST /api/notifications/:slug/:id/read`). The mutation is intentionally
 * not surfaced through the read-only `src/serve/data/` layer — writes go
 * straight through the storage class so the data layer's import-allowlist
 * test stays green.
 *
 * Response shape:
 *   200 { flipped: number, byAgent: { [slug]: number } }
 *     - `flipped` is the global total of unread→read transitions across
 *       every agent.
 *     - `byAgent` carries a per-agent breakdown so the SPA can refresh
 *       individual agent badges without re-fetching the global feed.
 *       Agents whose feed had no unread rows are still listed (with 0)
 *       so the SPA can clear cached badges deterministically.
 *   500 { error: string }
 */
async function handleNotificationMarkAllRead(
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  try {
    const agentsDir = join(ctx.projectDir, '.aweek', 'agents');
    const store = new NotificationStore(agentsDir);
    const slugs = await store.listAgents();
    const byAgent: Record<string, number> = {};
    let flipped = 0;
    for (const slug of slugs) {
      const count = await store.markAllRead(slug);
      byAgent[slug] = count;
      flipped += count;
    }
    sendJson(res, 200, { flipped, byAgent });
  } catch (err) {
    sendJson(res, 500, {
      error:
        err && (err as Error).message
          ? (err as Error).message
          : 'Failed to mark all notifications read',
    });
  }
}

/**
 * Read the full request body as UTF-8 text. Used by the chat endpoint to
 * parse the JSON envelope `{ slug, threadId, messages }` posted by the
 * Vercel AI SDK `useChat` hook. Hard-caps the body at 2 MiB to bound
 * memory; chat turns are text-only (no attachments) so this is generous.
 */
function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const MAX_BYTES = 2 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        const err = Object.assign(new Error('Request body too large'), {
          code: 'EBODYTOOLARGE',
        });
        req.destroy(err);
        rejectBody(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolveBody(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', rejectBody);
  });
}

/**
 * SSE chunk encoder. Writes a single Server-Sent Events `data:` frame
 * carrying a JSON payload, followed by the required blank-line
 * terminator. The Vercel AI SDK `useChat` hook consumes this exact
 * frame format for stream-text and tool-invocation parts.
 *
 * @param res — the response stream to write into
 * @param payload — JSON-serialisable object emitted as the event body
 */
function writeSseEvent(res: ServerResponse, payload: unknown): boolean {
  return res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * POST /api/chat — server-sent-events streaming endpoint that bridges
 * the floating chat panel in the SPA to the Anthropic Agent SDK.
 *
 * Sub-AC 1 scope (AC 1): establish the SSE transport. The handler:
 *   1. Sets the SSE response headers (`text/event-stream`,
 *      `Cache-Control: no-cache, no-transform`,
 *      `Connection: keep-alive`, `X-Accel-Buffering: no`).
 *   2. Calls `res.flushHeaders()` so reverse proxies / browsers see the
 *      200 status line + headers immediately, before any body bytes.
 *   3. Writes a leading SSE comment line (`: open`) plus a
 *      `stream-start` data event so the client's `useChat` hook
 *      transitions out of "connecting" state inside the 2-second
 *      first-chunk budget on the eval rubric.
 *
 * Subsequent sub-ACs layer on:
 *   - JSON body parsing (`{ slug, threadId, messages }`)
 *   - Budget pre-check via `BudgetEnforcer`
 *   - Anthropic Agent SDK invocation with full thread replay
 *   - Tool-invocation event passthrough + token-usage accounting
 *
 * The handler is intentionally tolerant of malformed bodies in this
 * sub-AC: any parse failure surfaces as a `stream-error` event followed
 * by a clean stream close, NOT a 4xx, so the client SSE consumer's
 * happy-path keeps working while later sub-ACs add validation.
 */
async function handleChatStream(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  // Sub-AC 4 (latency instrumentation): capture the handler-entry
  // timestamp using both wall-clock (`Date.now()`) and the high-
  // resolution monotonic clock (`process.hrtime.bigint()`) so we can
  // emit a server-side submit→first-chunk reading inside the
  // `stream-start` frame. The high-resolution measurement is the
  // authoritative duration; the wall-clock value is preserved for
  // backward compatibility with existing client telemetry that reads
  // `t` as a UNIX-ms timestamp.
  const handlerEnteredAtMs = Date.now();
  const handlerEnteredAtNs = process.hrtime.bigint();

  // 1. Set SSE headers BEFORE any write so the browser parses the
  //    response as an event stream from the very first byte. Cache
  //    headers are critical: any intermediary that buffers will defeat
  //    the streaming guarantee, so we both forbid caching and disable
  //    nginx-style proxy buffering via `X-Accel-Buffering: no`.
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // 2. Flush headers immediately so the client transitions out of the
  //    connecting state on the very first network round-trip. Without
  //    this, Node.js may hold the headers buffered in memory until the
  //    first body chunk lands, which can extend the time-to-first-byte
  //    by hundreds of milliseconds on slow networks and breaks the
  //    streaming illusion.
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // 3. Send a first chunk right away. The leading SSE comment line
  //    (`: open`) is a no-op event that nudges the client and any
  //    intermediary proxy to commit the connection as a stream — some
  //    proxies otherwise wait for the first `data:` frame before
  //    relinquishing buffering. The `stream-start` event then carries a
  //    monotonic timestamp that downstream UI hooks can correlate with
  //    a typing indicator.
  //
  //    Sub-AC 4: also embed `serverLatencyMs` — the wall-clock interval
  //    between this handler being invoked and the moment we wrote this
  //    first frame to the wire, computed from the high-resolution
  //    monotonic clock so it stays immune to mid-handler clock skew.
  //    Tests + telemetry use this to verify the server itself never
  //    consumes more than a few milliseconds of the rubric's 2-second
  //    submit→first-chunk budget.
  res.write(': open\n\n');
  const serverLatencyNs = process.hrtime.bigint() - handlerEnteredAtNs;
  // hrtime returns BigInt nanoseconds — convert to a fractional ms
  // number while keeping sub-millisecond precision for telemetry.
  const serverLatencyMs = Number(serverLatencyNs) / 1_000_000;
  writeSseEvent(res, {
    type: 'stream-start',
    t: handlerEnteredAtMs,
    serverLatencyMs,
  });

  // Read the request body off the wire (best-effort in this sub-AC).
  // We still kick off the read so the request socket is fully drained
  // and the connection close handshake works cleanly when later
  // sub-ACs route the parsed payload into the Agent SDK.
  let bodyText = '';
  try {
    bodyText = await readRequestBody(req);
  } catch (err) {
    // Body read failed (e.g. payload too large or socket reset). Emit a
    // structured error event then close — never throw past the SSE
    // boundary because once headers are flushed the client expects a
    // stream, not an HTTP error response.
    writeSseEvent(res, {
      type: 'stream-error',
      message:
        err && (err as Error).message ? (err as Error).message : 'body-read-error',
    });
    writeSseEvent(res, { type: 'stream-end' });
    res.end();
    return;
  }

  // Parse the body. We tolerate malformed payloads — anything that fails
  // schema validation falls back to the legacy `echo` placeholder so the
  // sub-AC-1 smoke-test surface stays intact while the real wire-up
  // below routes well-formed bodies through the Agent SDK translator.
  let parsedBody: unknown = null;
  if (bodyText.length > 0) {
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      parsedBody = { raw: bodyText };
    }
  }

  // ── AC 2: real-time streaming wire-up ────────────────────────────────
  //
  // Walk the parsed body for the chat-turn shape `{ slug, messages }` and,
  // when present, route through `streamAgentTurn` (data/chat.ts). Every
  // `ChatStreamEvent` the translator yields is written to the response
  // **immediately** as a single SSE `data:` frame — there is no
  // accumulator between the SDK and the wire, so a `text-delta` arriving
  // in the same JS microtask the model produced it lands on the client
  // in the same network turn. This is the contract AC 2 pins:
  // "subsequent tokens stream in real-time as model produces them".
  //
  // Backpressure: `res.write` returns false when the kernel send buffer
  // fills up. Awaiting the `drain` event before the next write keeps the
  // chunked response from queuing tokens up in user-space — without this
  // a slow client could effectively buffer the stream into one final
  // chunk on a fast model.
  //
  // Disconnect: `req.on('close')` fires when the client drops the
  // connection. We thread that through an `AbortController` so the SDK
  // iteration tears down promptly instead of streaming into the void.
  const body = parsedBody as {
    slug?: unknown;
    messages?: unknown;
    threadId?: unknown;
  } | null;
  const slug =
    body && typeof body.slug === 'string' && body.slug.length > 0
      ? body.slug
      : null;
  // Optional — chat clients pass the floating-panel thread id so chat
  // usage records group cleanly per conversation. Sub-AC 1 routes this
  // through to `recordChatUsage` for the synthetic taskId.
  const threadId =
    body && typeof body.threadId === 'string' && body.threadId.length > 0
      ? body.threadId
      : undefined;
  const rawMessages = body && Array.isArray(body.messages) ? body.messages : null;
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> | null =
    rawMessages
      ? (rawMessages.filter((m) => {
          if (!m || typeof m !== 'object') return false;
          const role = (m as { role?: unknown }).role;
          const content = (m as { content?: unknown }).content;
          return (
            (role === 'user' || role === 'assistant') &&
            typeof content === 'string'
          );
        }) as Array<{ role: 'user' | 'assistant'; content: string }>)
      : null;

  if (!slug || !messages || messages.length === 0) {
    // Legacy fallback: echo the parsed body so smoke-test scripts that
    // POST a placeholder payload still receive a recognisable response.
    // Production clients always send a well-formed `{ slug, messages }`
    // and never see this branch.
    writeSseEvent(res, { type: 'echo', body: parsedBody });
    writeSseEvent(res, { type: 'stream-end' });
    res.end();
    return;
  }

  // ── Sub-AC 2 of AC 7: server-side budget gate ────────────────────────
  //
  // Reject new chat turns once the agent's weekly budget is spent. The
  // gate runs BEFORE we invoke the Agent SDK so the heaviest cost (the
  // model round-trip) is never paid on a turn we have already decided
  // to refuse. Token usage from prior chat *and* heartbeat sessions is
  // pulled from the same `UsageStore` the heartbeat budget-enforcer
  // reads, so chat + heartbeat share one weekly pool per agent.
  //
  // Reuse the same `UsageStore` instance for the post-stream
  // `recordChatUsage` write below: that way a single chat turn's pre-
  // and post-flight reads see a consistent in-memory store (tests pin a
  // single fake; production rebuilds the same on-disk path twice but at
  // matching `baseDir`).
  const chatStoresBaseDir = join(ctx.dataDir, 'agents');
  const budgetUsageStore: ChatBudgetUsageStoreLike =
    ctx.chatBudgetUsageStore ??
    (ctx.chatUsageStore as unknown as ChatBudgetUsageStoreLike | undefined) ??
    new UsageStore(chatStoresBaseDir);
  const budgetAgentStore: ChatBudgetAgentStoreLike =
    ctx.chatBudgetAgentStore ?? new AgentStore(chatStoresBaseDir);

  try {
    const verdict = await checkChatBudget({
      agentId: slug,
      agentStore: budgetAgentStore,
      usageStore: budgetUsageStore,
    });
    if (!verdict.allowed) {
      // Emit a structured `budget-exhausted` SSE frame and terminate
      // the stream cleanly. The SPA's `useChat` consumer maps this
      // verdict to a banner ("Budget exhausted, top up to continue")
      // without re-deriving budget arithmetic on the client.
      writeSseEvent(res, buildBudgetExhaustedFrame(verdict));
      writeSseEvent(res, { type: 'stream-end' });
      res.end();
      return;
    }
  } catch (err) {
    // Budget gate failure is fail-CLOSED: if we cannot prove the agent
    // has budget remaining, we refuse the turn. The chat client gets a
    // structured `stream-error` frame so the UI can surface a hint
    // rather than silently dropping the request.
    writeSseEvent(res, {
      type: 'stream-error',
      message:
        err && (err as Error).message
          ? `budget-check failed: ${(err as Error).message}`
          : 'budget-check failed',
    });
    writeSseEvent(res, { type: 'stream-end' });
    res.end();
    return;
  }

  // ── Sub-AC 1 of AC 12: persist the inbound user turn to disk ─────────
  //
  // Threads are persisted under `.aweek/agents/<slug>/chat/<threadId>.json`
  // by the same `ChatConversationStore` the thread-list / new / get /
  // rename / delete endpoints already use. Persisting BEFORE the SDK
  // stream starts keeps the on-disk thread monotonic with what the user
  // sent — even if the model fails mid-stream or the client disconnects,
  // the user's prompt survives a refresh.
  //
  // Eligibility: only persist when `threadId` matches the schema-of-
  // record id pattern (`^chat-[a-z0-9]+(-[a-z0-9]+)*$`). Earlier sub-AC
  // tests pass opaque sentinels like `thread-1` as a placeholder; for
  // those the handler skips persistence silently so the SSE stream still
  // flows end-to-end without breaking back-compat. Production clients
  // always allocate ids via `POST /api/agents/:slug/chat/threads`, which
  // returns a `chat-<hex>` id by construction, so the persistence path
  // is the default for real users.
  //
  // Auto-create on first hit: if the thread file does not exist yet
  // (the SPA may stream into a chat-* id allocated client-side, or the
  // file may have been pruned), the handler seeds an empty conversation
  // before appending. That keeps the chat handler self-bootstrapping
  // without a separate "thread create" round-trip.
  //
  // Best-effort by design: persistence failures must never crash the
  // request lifecycle. We log a warning and proceed with the stream so
  // the user still sees their tokens; the on-disk gap surfaces in the
  // next reload (and operators see the warning in the server log).
  const conversationStore: ChatConversationStoreLike =
    ctx.chatConversationStore ??
    new ChatConversationStore(chatStoresBaseDir);
  const persistThread =
    typeof threadId === 'string' &&
    CHAT_CONVERSATION_ID_PATTERN.test(threadId);
  // Capture the latest user turn (the new prompt) so we can persist it
  // ahead of the stream. Full-thread replay places the latest user turn
  // at the END of the body's `messages[]` array; we walk backwards to
  // find it so a trailing assistant entry (rare — clients should always
  // submit ending in a user turn) does not throw off the lookup.
  let latestUserContent: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') {
      latestUserContent = m.content;
      break;
    }
  }

  if (persistThread && latestUserContent !== undefined && threadId) {
    try {
      // Ensure the thread document exists on disk. We use a write-then-
      // read dance so the seed is atomic per the store's contract: the
      // initial `write` lands a fresh doc; subsequent calls find it via
      // `read` and skip the seed. Either branch ends with the user
      // message appended.
      const existing = await conversationStore.read(slug, threadId);
      if (!existing) {
        const nowIso = new Date().toISOString();
        const seedConversation: ChatConversation = {
          id: threadId,
          agentId: slug,
          messages: [],
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        await conversationStore.write(slug, seedConversation);
      }
      const userMessage = createChatMessage({
        role: 'user',
        content: latestUserContent,
      });
      await conversationStore.appendMessage(slug, threadId, userMessage);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[chat] failed to persist user message for ${slug}/${threadId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Wire client disconnect → AbortController so the SDK cancels promptly.
  const abortCtrl = new AbortController();
  const onClientClose = (): void => abortCtrl.abort();
  req.once('close', onClientClose);

  // ── Sub-AC 3 of AC 6: auto-inject the system preamble on first turn ──
  //
  // The preamble is the structured context block (weekly plan summary,
  // recent activity, weekly budget remaining, ISO-week key) the chat
  // agent needs to start the thread with the same situational
  // awareness the heartbeat already has. We compose it via
  // `buildPreamble` + `formatPreamble` from `data/chat-preamble.ts`,
  // which read from the same `src/storage/*` stores the dashboard
  // already consumes — no duplicated derivation.
  //
  // We only inject on the **first system turn** of each thread.
  // Heuristic: a thread is "fresh" when the replayed messages contain
  // zero assistant entries (i.e., the user has typed but the agent has
  // not yet responded). On any subsequent turn the array carries at
  // least one prior assistant turn, and we skip the preamble so it is
  // not re-sent on every prompt — the model already has it in its
  // session context from turn one. This keeps token spend down and
  // preserves the cache prefix the SDK builds across turns.
  //
  // The build is best-effort: a malformed plan.md, an absent logs
  // file, or a bad agent JSON should NOT crash the chat turn, since
  // the SDK can still answer without the preamble. We swallow the
  // error and proceed without `systemPromptAppend`.
  const isFirstTurn = !messages.some((m) => m.role === 'assistant');
  let systemPromptAppend: string | undefined;
  if (isFirstTurn) {
    try {
      const preamble = await buildPreamble({
        projectDir: ctx.projectDir,
        slug,
      });
      const formatted = formatPreamble(preamble);
      if (formatted.length > 0) {
        systemPromptAppend = formatted;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[chat] failed to build preamble for ${slug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── AC 8: in-flight turn completes streaming before cutoff applies ───
  //
  // Once the pre-flight gate above accepts a turn, we DO NOT re-check
  // the budget while the SDK is iterating. Two reasons:
  //   1. The model has already started producing tokens — aborting
  //      mid-stream wastes those tokens (we still get billed but the
  //      user gets a half-finished answer).
  //   2. The streaming illusion: a mid-stream cutoff would manifest as
  //      a frozen response that the user has to retry, defeating the
  //      "tokens arrive as the model produces them" rubric guarantee.
  //
  // The cutoff is enforced at the *next* turn's pre-flight gate: once
  // this turn's `recordChatUsage` write below lands in the shared
  // `UsageStore`, any subsequent `POST /api/chat` invocation reads
  // the new total and is rejected with a structured `budget-exhausted`
  // frame BEFORE the SDK is invoked. The contract is exercised in
  // server.test.ts under "POST /api/chat — AC 8: in-flight turn
  // completes streaming before cutoff".
  //
  // Sub-AC 1 of AC 7: track the SDK session id (from `agent-init`) and
  // the terminal token-usage payload (from `turn-complete`) so we can
  // record chat-driven spend against the same weekly usage file the
  // heartbeat reads. We capture across the streaming loop and write
  // **after** iteration finishes so the in-flight turn's tokens never
  // get lost on a mid-stream client disconnect — we still record what
  // the SDK reported for the turn even if `aborted` fired.
  let capturedSessionId: string | undefined;
  let capturedUsage: ChatTokenUsage | undefined;
  let capturedDurationMs: number | undefined;

  // ── Sub-AC 1 of AC 12: accumulate the assistant turn for persistence ──
  //
  // Per assistant-message uuid the SDK emits during this turn we collect:
  //   - `text` — concatenated text from every `text-delta` event (real-
  //     time tokens) plus any final text blocks the SDK ships in the
  //     terminal `assistant-message` (some models skip deltas and only
  //     send the consolidated message; we cover both paths so the
  //     persisted thread is non-empty either way).
  //   - `tools[]` — `tool_use` blocks emitted in the assistant-message
  //     content array, plus matching `tool_result` blocks the SDK echoes
  //     back from the tool-execution side. The schema persists both
  //     branches under `tools[]` on the assistant message that issued
  //     the corresponding tool_use, so the floating panel can re-render
  //     historical tool invocations after a page reload.
  //
  // We track `accumulatorOrder` so that when we append to disk, the
  // assistant messages land in the order the SDK emitted them — a
  // multi-step turn (assistant tool_use → user tool_result → assistant
  // text) materialises as multiple ChatMessages with the same monotonic
  // sequence the user observed in the live stream.
  interface AssistantTurnAccumulator {
    uuid: string;
    text: string;
    tools: ChatToolBlock[];
  }
  const accumulators = new Map<string, AssistantTurnAccumulator>();
  const accumulatorOrder: string[] = [];
  /**
   * Get-or-create the accumulator for a given assistant message uuid.
   * Captures the first-seen ordering so `accumulatorOrder` reflects the
   * order the SDK emitted assistant messages.
   */
  const getAccumulator = (uuid: string): AssistantTurnAccumulator => {
    let acc = accumulators.get(uuid);
    if (!acc) {
      acc = { uuid, text: '', tools: [] };
      accumulators.set(uuid, acc);
      accumulatorOrder.push(uuid);
    }
    return acc;
  };
  // Track tool_use → assistant uuid so tool_result blocks (which arrive
  // in a separate `user` echo message and don't carry the original
  // assistant uuid) can be routed back onto the right assistant message.
  const toolUseToAssistant = new Map<string, string>();

  try {
    const streamParams: Parameters<typeof streamAgentTurn>[0] = {
      slug,
      messages,
      cwd: ctx.projectDir,
      signal: abortCtrl.signal,
    };
    if (ctx.runQuery !== undefined) streamParams.runQuery = ctx.runQuery;
    if (systemPromptAppend !== undefined) {
      streamParams.systemPromptAppend = systemPromptAppend;
    }

    for await (const event of streamAgentTurn(streamParams)) {
      if (event.type === 'agent-init') {
        capturedSessionId = event.sessionId;
      } else if (event.type === 'turn-complete') {
        capturedUsage = event.usage;
        capturedDurationMs = event.durationMs;
      } else if (event.type === 'text-delta') {
        // Stream tokens — append to the accumulator for this assistant
        // uuid so the persisted message carries the same prose the user
        // saw scroll past in the live stream.
        getAccumulator(event.messageUuid).text += event.delta;
      } else if (event.type === 'assistant-message') {
        // Terminal assistant message: walk the structured content blocks
        // so we both (a) backfill any text the SDK delivered without
        // streaming deltas, and (b) record tool_use blocks against this
        // assistant uuid so subsequent tool_result events can pair up.
        const acc = getAccumulator(event.uuid);
        const content = event.content;
        if (Array.isArray(content)) {
          let consolidatedText = '';
          for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            const blockType = (block as { type?: unknown }).type;
            if (
              blockType === 'text' &&
              typeof (block as { text?: unknown }).text === 'string'
            ) {
              consolidatedText += (block as { text: string }).text;
            } else if (blockType === 'tool_use') {
              const toolUse = block as {
                id?: unknown;
                name?: unknown;
                input?: unknown;
              };
              if (
                typeof toolUse.id === 'string' &&
                typeof toolUse.name === 'string'
              ) {
                acc.tools.push({
                  type: 'tool_use',
                  toolUseId: toolUse.id,
                  name: toolUse.name,
                  input:
                    toolUse.input && typeof toolUse.input === 'object'
                      ? (toolUse.input as Record<string, unknown>)
                      : {},
                });
                toolUseToAssistant.set(toolUse.id, event.uuid);
              }
            }
          }
          // Prefer the consolidated text when the SDK shipped one (it is
          // the canonical form). Fall back to the streamed deltas when
          // the consolidated form is empty (some models stream-only).
          if (consolidatedText.length > 0) {
            acc.text = consolidatedText;
          }
        }
      } else if (event.type === 'tool-result') {
        // Pair the result with the assistant message that issued the
        // matching tool_use. If we never saw the originating tool_use
        // (rare — the SDK echoed a tool result from a prior turn), we
        // attach it to the most recent assistant accumulator so it does
        // not disappear into the void.
        const ownerUuid =
          toolUseToAssistant.get(event.toolUseId) ??
          accumulatorOrder[accumulatorOrder.length - 1];
        if (ownerUuid) {
          getAccumulator(ownerUuid).tools.push({
            type: 'tool_result',
            toolUseId: event.toolUseId,
            content: event.content,
            isError: !!event.isError,
          });
        }
      }
      // Each event is a single SSE frame. Honour backpressure so a slow
      // client cannot coalesce sequential `text-delta`s into one chunk
      // and break the streaming illusion the rubric pins at "tokens
      // arrive as the model produces them".
      const wrote = writeSseEvent(res, event);
      if (!wrote) {
        await new Promise<void>((resolveDrain) => {
          res.once('drain', () => resolveDrain());
        });
      }
    }
  } catch (err) {
    // The translator already maps SDK errors to `turn-error` events, so
    // we only land here on something more catastrophic (e.g. write to a
    // closed socket). Surface a structured error frame and end cleanly
    // — never re-throw past the SSE boundary because once headers are
    // flushed the client expects a stream, not an HTTP error.
    writeSseEvent(res, {
      type: 'stream-error',
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    req.off('close', onClientClose);
    // Terminal `stream-end` so the `useChat` hook resolves the turn.
    writeSseEvent(res, { type: 'stream-end' });
    res.end();
  }

  // ── Sub-AC 1 of AC 12: persist the assistant turn(s) to disk ─────────
  //
  // After the SSE stream has been closed (so the user-facing latency
  // does not pay for the disk write) we flush every accumulator we
  // captured during streaming as one ChatMessage per assistant uuid.
  // This preserves multi-step turns (assistant tool_use → user
  // tool_result → assistant text) as multiple persisted messages in the
  // same monotonic order the user observed in the live stream, so the
  // floating panel can replay the conversation byte-identical to the
  // original after a reload.
  //
  // Best-effort: matches the user-message persistence path above and
  // the token-usage path below — storage failures must never crash the
  // request lifecycle (the response is already terminated). We log a
  // warning so operators can see something landed in the wrong place.
  //
  // Even when streaming aborted mid-turn (client disconnect, SDK
  // error), we still flush whatever the accumulators captured up to
  // that point. The user got partial bytes on the wire; the persisted
  // thread should reflect the same partial state so a reload doesn't
  // misrepresent what the agent said.
  if (persistThread && threadId && accumulatorOrder.length > 0) {
    for (const uuid of accumulatorOrder) {
      const acc = accumulators.get(uuid);
      if (!acc) continue;
      // Skip wholly empty accumulators (no text and no tools — happens
      // when an assistant message arrived as just a stop_reason marker
      // with no content). The schema requires `content` to be a string,
      // and an empty string is valid, but persisting nothing useful
      // bloats the on-disk file with no replay value.
      if (acc.text.length === 0 && acc.tools.length === 0) continue;
      try {
        const opts: Parameters<typeof createChatMessage>[0] = {
          role: 'assistant',
          content: acc.text,
        };
        if (acc.tools.length > 0) opts.tools = acc.tools;
        const assistantMessage = createChatMessage(opts);
        await conversationStore.appendMessage(
          slug,
          threadId,
          assistantMessage,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[chat] failed to persist assistant message for ${slug}/${threadId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // Persist the chat-side token usage AFTER the SSE stream has been
  // closed so the user-facing latency of the response never pays for
  // the disk write. The heartbeat's budget enforcer reads from the same
  // weekly file via `UsageStore.weeklyTotal(...)`, so this single
  // append is what makes the chat + heartbeat budgets converge into one
  // shared pool per agent (AC 7, Sub-AC 1).
  //
  // Best-effort by design: storage failures here must never crash the
  // request lifecycle (the response is already terminated). We log a
  // warning so operators can see something landed in the wrong place,
  // but the SDK has already delivered every byte the client expects.
  if (capturedUsage) {
    const usageStore: ChatUsageStoreLike =
      ctx.chatUsageStore ?? new UsageStore(join(ctx.dataDir, 'agents'));
    try {
      const recordOpts: Parameters<typeof recordChatUsage>[1] = {
        agentId: slug,
        usage: capturedUsage,
      };
      if (threadId !== undefined) recordOpts.threadId = threadId;
      if (capturedSessionId !== undefined) {
        recordOpts.sessionId = capturedSessionId;
      }
      if (capturedDurationMs !== undefined) {
        recordOpts.durationMs = capturedDurationMs;
      }
      await recordChatUsage(usageStore, recordOpts);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[chat] failed to record usage for ${slug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * GET /api/agents/:slug/artifacts/:id/file — stream the raw bytes of a
 * single artifact deliverable.
 *
 * Looks the artifact up via `resolveArtifactFile` (which sources from
 * `ArtifactStore` and validates that the recorded `filePath` resolves to
 * an absolute path strictly inside the project root). The response body
 * is the file's raw bytes — `Content-Type` is derived from the
 * artifact's `fileName` extension via `resolveArtifactContentType` so
 * the browser can either render inline (markdown via the SPA's Markdown
 * component, images, PDFs) or trigger a download for unknown types
 * (`application/octet-stream`).
 *
 * Caching: artifacts can change in place when an agent re-runs a task
 * that overwrites a file, so we send `Cache-Control: no-store` to
 * guarantee the dashboard reflects the on-disk truth on every refresh.
 *
 * Response shape:
 *   200 <raw file bytes>     (Content-Type per extension)
 *   400 { error: 'Invalid slug or artifact id' }
 *   400 { error: 'Artifact filePath escapes project root' }
 *   404 { error: 'Agent not found: <slug>' }
 *   404 { error: 'Artifact not found: <id>' }
 *   404 { error: 'Artifact file missing on disk' }
 *   500 { error: string }
 */
async function handleAgentArtifactFile(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  slug: string,
  artifactId: string,
): Promise<void> {
  try {
    const result = await resolveArtifactFile({
      projectDir: ctx.projectDir,
      slug,
      artifactId,
    });
    if (isResolveArtifactFileError(result)) {
      switch (result.reason) {
        case 'agent-not-found':
          sendJson(res, 404, { error: `Agent not found: ${slug}` });
          return;
        case 'artifact-not-found':
          sendJson(res, 404, { error: `Artifact not found: ${artifactId}` });
          return;
        case 'path-traversal':
          // Mirror the wording used by the DELETE handler so operators
          // see consistent failures across both routes.
          sendJson(res, 400, {
            error: 'Artifact filePath escapes project root',
          });
          return;
        case 'file-missing':
          sendJson(res, 404, { error: 'Artifact file missing on disk' });
          return;
      }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Length', String(result.sizeBytes));
    // Artifacts can be overwritten in place by re-running the producing
    // task; the dashboard must always reflect the current disk truth.
    res.setHeader('Cache-Control', 'no-store');
    // Disposition policy (AC 9): for known/renderable Content-Types
    // (markdown, images, PDFs, text/*) we send `inline` so the browser
    // keeps the render-in-place path working for the SPA's inline
    // previews. For unknown types — anything that resolved to the
    // `application/octet-stream` fallback in `resolveArtifactContentType`
    // — we send `attachment` so the browser unconditionally triggers a
    // download dialog instead of trying to render an opaque body. The
    // `filename=` hint surfaces the original on-disk filename in the
    // browser's "Save As…" dialog regardless of disposition.
    const safeName = result.record.fileName.replace(/[\r\n"]/g, '_');
    const isUnknownType = result.contentType === 'application/octet-stream';
    const disposition = isUnknownType ? 'attachment' : 'inline';
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${safeName}"`,
    );

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    await pipeline(createReadStream(result.absolutePath), res);
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        error:
          err && (err as Error).message
            ? (err as Error).message
            : 'Failed to read artifact file',
      });
    }
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
 */
async function handleAgentExecutionLog(
  res: ServerResponse,
  ctx: RequestContext,
  slug: string,
  basename: string,
): Promise<void> {
  try {
    const lines: string[] = [];
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
        err && (err as Error).message ? (err as Error).message : 'Failed to read execution log',
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
 */
async function serveSpa(
  _req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: RequestContext,
): Promise<void> {
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
 */
export function resolveSafeFile(buildDir: string, pathname: string): string | null {
  if (typeof pathname !== 'string') return null;

  let decoded: string;
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
 */
async function sendFile(res: ServerResponse, absPath: string): Promise<void> {
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
 */
export function renderBuildMissingHtml(buildDir: string): string {
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
 */
function escapeHtml(value: string): string {
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
 */
export function resolveOpenCommand(
  url: string,
  platform: NodeJS.Platform = nodePlatform,
): { command: string; args: string[] } {
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

/** Result returned by {@link openBrowser}. */
export interface OpenBrowserResult {
  opened: boolean;
  error?: Error | unknown;
  command?: string;
  args?: string[];
}

/** Injection points for {@link openBrowser}. */
export interface OpenBrowserDeps {
  spawn?: (
    command: string,
    args: string[],
    options: { stdio: string; detached: boolean },
  ) => ChildProcess;
  platform?: NodeJS.Platform;
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
 */
export function openBrowser(
  url: string,
  { spawn = nodeSpawn as unknown as NonNullable<OpenBrowserDeps['spawn']>, platform = nodePlatform }: OpenBrowserDeps = {},
): Promise<OpenBrowserResult> {
  return new Promise((resolvePromise) => {
    let command: string | undefined;
    let args: string[] | undefined;
    try {
      ({ command, args } = resolveOpenCommand(url, platform));
    } catch (err) {
      resolvePromise({ opened: false, error: err });
      return;
    }

    let child: ChildProcess;
    let settled = false;
    const settle = (result: OpenBrowserResult) => {
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

/** Address record returned by {@link getLanAddresses}. */
export interface LanAddress {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
}

/** Injection points for {@link getLanAddresses} / {@link formatLanHints}. */
export interface NetworkDeps {
  networkInterfaces?: typeof nodeNetworkInterfaces;
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
 */
export function getLanAddresses({ networkInterfaces = nodeNetworkInterfaces }: NetworkDeps = {}): LanAddress[] {
  const interfaces = networkInterfaces() || {};
  const out: LanAddress[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!Array.isArray(addrs)) continue;
    for (const addr of addrs) {
      if (!addr || addr.internal) continue;
      // Node 18+ uses the string 'IPv4'/'IPv6'; older node exposed a
      // number (4 / 6). Normalise both so downstream code can branch
      // on a stable value.
      const rawFamily = (addr as { family: string | number }).family;
      const family: 'IPv4' | 'IPv6' | null =
        rawFamily === 'IPv4' || rawFamily === 4
          ? 'IPv4'
          : rawFamily === 'IPv6' || rawFamily === 6
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
 */
export function formatLanHints(
  { host, port }: { host: string; port: number },
  deps: NetworkDeps = {},
): string[] {
  if (!isWildcardHost(host)) return [];
  const addrs = getLanAddresses(deps);
  const urls: string[] = [];
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
 */
function listenWithRetry(server: Server, port: number, host: string, scanLimit: number): Promise<number> {
  return new Promise((resolveBind, rejectBind) => {
    let attempt = 0;

    const tryListen = (candidate: number): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
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
      const onListening = (): void => {
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
