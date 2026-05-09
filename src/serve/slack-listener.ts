/**
 * Embedded Slack Socket-Mode listener bootstrap for `aweek serve`.
 *
 * Sub-AC 2.2 of the Slack-aweek integration seed: this is the helper
 * that {@link startServer} calls right after the HTTP listener is bound
 * so the Slack WebSocket boots in the SAME Node process — no second
 * daemon, no second port, Socket Mode WebSocket only.
 *
 * Behaviour:
 *
 *   1. Resolve credentials via the Sub-AC 2.1 loader
 *      ({@link loadSlackCredentials}) — env-first, file-fallback.
 *   2. If the loader returns `null`, log a single info-level line and
 *      return a no-op handle. `aweek serve` keeps running with the HTTP
 *      dashboard only — the seed contract is explicit that Slack is
 *      OPTIONAL and missing credentials must NOT brick the boot.
 *   3. If the loader returns credentials, instantiate `SlackAdapter`
 *      from agentchannels and call `connect()`. On success, return a
 *      handle whose `disconnect()` tears the WebSocket down (called
 *      from `ServerHandle.close()`).
 *   4. If the adapter constructor or `connect()` throws (bad token,
 *      Bolt scope error, network), log a warning and return a no-op
 *      handle. We never propagate the error — the dashboard stays up
 *      so the user can run `/aweek:slack-init` to re-provision the
 *      bot without restarting the whole server.
 *
 * Test seams:
 *
 *   - `loader`         override the credentials loader (defaults to
 *                      `loadSlackCredentials`).
 *   - `adapterFactory` override the SlackAdapter constructor (defaults
 *                      to `(cfg) => new SlackAdapter(cfg)`).
 *   - `envSource`      override `process.env` (passed straight through
 *                      to the loader). Tests pass a frozen object so
 *                      they don't leak across the parallel
 *                      `node --test` runs.
 *   - `log`            override stderr writes. Tests pin a sink array
 *                      so they can assert on the boot message without
 *                      spraying production stderr.
 *
 * @module serve/slack-listener
 */

import { join } from 'node:path';

import {
  SlackAdapter,
  type ChannelAdapter,
  type SlackAdapterConfig,
} from 'agentchannels';

import {
  loadSlackCredentials,
  type SlackCredentials,
  type SlackEnvSource,
} from '../storage/slack-config-store.js';

/**
 * Loader signature compatible with {@link loadSlackCredentials}. Carried
 * as a named type so the test seam in {@link SlackListenerOptions} is
 * self-documenting.
 *
 * @param agentsDir absolute path to `<projectDir>/.aweek/agents` — the
 *                  same calling convention every other store in the
 *                  codebase uses. The loader walks one level up to find
 *                  `<projectDir>/.aweek/channels/slack/config.json`.
 * @param envSource optional override of `process.env`.
 */
export type SlackCredentialsLoader = (
  agentsDir: string,
  envSource?: SlackEnvSource,
) => Promise<SlackCredentials | null>;

/**
 * Factory signature for instantiating a Slack `ChannelAdapter`. Tests
 * pin a fake adapter that records `connect()` / `disconnect()` calls
 * without spinning up a real WebSocket.
 */
export type SlackAdapterFactory = (config: SlackAdapterConfig) => ChannelAdapter;

/** Options accepted by {@link startSlackListener}. */
export interface SlackListenerOptions {
  /**
   * Absolute path to `<projectDir>/.aweek/`. The listener appends
   * `/agents` internally before handing the path to the loader so
   * the existing `slackConfigPath()` helper resolves
   * `<projectDir>/.aweek/channels/slack/config.json`.
   */
  dataDir: string;
  /** Test-only override for the credentials loader. */
  loader?: SlackCredentialsLoader;
  /** Test-only override for the SlackAdapter constructor. */
  adapterFactory?: SlackAdapterFactory;
  /** Test-only override for `process.env`. */
  envSource?: SlackEnvSource;
  /**
   * Logger sink used for the single-line boot status messages
   * (connected / disabled / failed). Defaults to stderr so the lines
   * surface alongside the existing `aweek serve` console output. Tests
   * pin a `string[]` sink and assert on its contents.
   */
  log?: (message: string) => void;
}

/**
 * Handle returned by {@link startSlackListener}.
 *
 * `adapter` is `null` whenever the listener decided to stay disabled
 * (no credentials, factory threw, `connect()` threw). In that case
 * `disconnect()` is a no-op — callers can invoke it unconditionally
 * from `ServerHandle.close()` without a feature check.
 */
export interface SlackListenerHandle {
  /** Connected adapter, or `null` when the listener is disabled. */
  adapter: ChannelAdapter | null;
  /**
   * Tear down the Socket-Mode WebSocket. Idempotent and never throws
   * — `ServerHandle.close()` must always be able to complete even if
   * Slack disconnect errors out, otherwise Ctrl-C of `aweek serve`
   * would hang.
   */
  disconnect: () => Promise<void>;
}

/**
 * Default logger: write a `\n`-terminated line to stderr. Hidden behind
 * a function so tests can pin a sink without monkey-patching
 * `process.stderr`.
 */
function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** No-op disconnect used by every "listener disabled" return path. */
const noopDisconnect = async (): Promise<void> => {};

/**
 * Boot the Slack Socket-Mode listener if credentials are available.
 *
 * Always resolves — failures are logged and surface as a `null`
 * adapter on the returned handle. See module docstring for the full
 * behaviour matrix.
 */
export async function startSlackListener(
  opts: SlackListenerOptions,
): Promise<SlackListenerHandle> {
  if (!opts || typeof opts.dataDir !== 'string' || opts.dataDir.length === 0) {
    throw new TypeError('startSlackListener: opts.dataDir is required');
  }

  const loader: SlackCredentialsLoader = opts.loader ?? loadSlackCredentials;
  const factory: SlackAdapterFactory =
    opts.adapterFactory ?? ((cfg) => new SlackAdapter(cfg));
  const log = opts.log ?? defaultLog;

  // Match the loader's `<.aweek>/agents` calling convention. The loader
  // walks up to `<.aweek>/channels/slack/config.json` from there — see
  // `slackConfigPath()` in `src/storage/slack-config-store.ts`.
  const agentsDir = join(opts.dataDir, 'agents');

  let credentials: SlackCredentials | null;
  try {
    credentials = await loader(agentsDir, opts.envSource);
  } catch (err) {
    // The loader itself only throws on a missing dataDir or unexpected
    // I/O failure (ENOENT is swallowed). Treat any throw the same as
    // "no credentials" so the dashboard stays up.
    log(
      `aweek: Slack listener disabled (credentials loader error: ${formatError(err)})`,
    );
    return { adapter: null, disconnect: noopDisconnect };
  }

  if (!credentials) {
    log(
      'aweek: Slack listener disabled (no credentials in env or .aweek/channels/slack/config.json)',
    );
    return { adapter: null, disconnect: noopDisconnect };
  }

  // Build the adapter config. The loader guarantees both required
  // tokens are present and trimmed; signing secret is optional.
  const adapterConfig: SlackAdapterConfig = {
    botToken: credentials.botToken,
    appToken: credentials.appToken,
  };
  if (credentials.signingSecret) {
    adapterConfig.signingSecret = credentials.signingSecret;
  }

  let adapter: ChannelAdapter;
  try {
    adapter = factory(adapterConfig);
  } catch (err) {
    log(
      `aweek: Slack listener disabled (adapter init failed: ${formatError(err)})`,
    );
    return { adapter: null, disconnect: noopDisconnect };
  }

  try {
    await adapter.connect();
  } catch (err) {
    log(
      `aweek: Slack listener failed to connect (${formatError(err)}). Continuing without Slack.`,
    );
    // Best-effort cleanup: the adapter may have allocated resources
    // (Bolt app, WebSocket retry timers) before throwing.
    try {
      await adapter.disconnect();
    } catch {
      // ignored — already in the failure path
    }
    return { adapter: null, disconnect: noopDisconnect };
  }

  log('aweek: Slack listener connected (Socket Mode)');

  return {
    adapter,
    disconnect: async () => {
      try {
        await adapter.disconnect();
      } catch (err) {
        // ServerHandle.close() must always be able to complete; surface
        // disconnect errors as a warning but do NOT rethrow.
        log(`aweek: Slack listener disconnect warning: ${formatError(err)}`);
      }
    },
  };
}

/**
 * Stringify an unknown thrown value for the single-line log messages.
 * Prefers `Error.message` so the user sees the actionable detail
 * (Slack API error codes, scope hints) without a stack trace.
 */
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'Error';
  if (typeof err === 'string') return err;
  return String(err);
}
