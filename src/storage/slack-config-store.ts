/**
 * Slack credentials loader for the Slack-aweek integration.
 *
 * This module is the single entry point that the embedded Slack listener
 * inside `aweek serve` uses to obtain its Socket-Mode tokens. It implements
 * the precedence rule from the seed contract:
 *
 *   1. Read each token from `process.env` first
 *      (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, optional `SLACK_SIGNING_SECRET`).
 *   2. For any missing token, fall back to
 *      `<projectRoot>/.aweek/channels/slack/config.json`.
 *   3. If after merging both sources the bot token OR the app token is still
 *      missing, return `null`. Callers treat `null` as "Slack not configured;
 *      skip the listener" rather than as an error — this keeps `aweek serve`
 *      bootable on machines that haven't run `/aweek:slack-init` yet.
 *
 * Design notes:
 *
 *   - Both sources are read on every call. There is no cache. The Slack
 *     listener calls this once at startup and again only when the manifest
 *     skill writes a new config; in both cases the few extra ms is fine and
 *     dropping the cache makes test isolation trivial.
 *   - A malformed JSON file is tolerated: a warning is written to stderr and
 *     the loader proceeds with whatever `process.env` provides. We never
 *     throw — a corrupt file should not brick the rest of `aweek serve`.
 *   - The on-disk file mirrors the env-var names but with snake_case keys
 *     (`bot_token`, `app_token`, `signing_secret`) so it aligns with Slack's
 *     own manifest schema. Both the snake_case keys and the screaming-snake
 *     env names are accepted for forward-compat with hand-rolled configs.
 *   - The file lives at `.aweek/channels/slack/config.json` (NOT next to the
 *     existing `.aweek/config.json`) so that the gitignore rule for `.aweek/`
 *     keeps secrets out of source control by default.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Subdirectory under `.aweek/` that holds Slack-specific runtime state. */
export const SLACK_CHANNEL_DIRNAME = 'slack';

/** Filename of the credentials document inside the Slack channel dir. */
export const SLACK_CONFIG_FILENAME = 'config.json';

/**
 * Resolved Slack credentials. Returned by {@link loadSlackCredentials} when
 * BOTH `botToken` and `appToken` could be sourced (env or file). Callers
 * pass this directly into `SlackAdapter` from the `agentchannels` library.
 */
export interface SlackCredentials {
  /** Slack bot user OAuth token (`xoxb-...`). Required. */
  botToken: string;
  /** Slack app-level token (`xapp-...`) used for Socket-Mode WebSocket. Required. */
  appToken: string;
  /**
   * Slack signing secret. Optional in v1 because Socket Mode does not
   * verify request signatures locally — Slack's Edge does. Carried so a
   * future HTTP-events fallback path can reuse the same loader.
   */
  signingSecret?: string;
}

/**
 * Resolve the path to the Slack credentials JSON given a data dir. The
 * rest of the codebase passes `dataDir` as `.aweek/agents`; the credentials
 * file lives one level up under `channels/slack/`.
 */
export function slackConfigPath(dataDir: string): string {
  // Walk up from `.aweek/agents` to `.aweek/`, then into `channels/slack/`.
  return join(dirname(dataDir), 'channels', SLACK_CHANNEL_DIRNAME, SLACK_CONFIG_FILENAME);
}

/**
 * Shape we tolerate on disk. Both snake_case keys (matching Slack's own
 * manifest output) and the env-var names (uppercase) are recognised so
 * users can paste either into the file without reformatting.
 */
interface RawSlackConfigDocument {
  bot_token?: unknown;
  app_token?: unknown;
  signing_secret?: unknown;
  SLACK_BOT_TOKEN?: unknown;
  SLACK_APP_TOKEN?: unknown;
  SLACK_SIGNING_SECRET?: unknown;
  // camelCase keys are what `src/skills/slack-init.ts` writes via
  // `persistSlackCredentials`. The loader has to accept them too — without
  // these, files produced by `/aweek:slack-init` would be invisible to
  // the runtime listener and the SKILL.md's own "tolerant loader" note
  // would be a lie.
  botToken?: unknown;
  appToken?: unknown;
  signingSecret?: unknown;
}

/**
 * Process-env shape consumed by {@link loadSlackCredentials}. Exposed as
 * an explicit parameter so tests can pass a sealed map without mutating
 * `process.env` (which would leak across the parallel `node --test` runs).
 */
export type SlackEnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Load Slack credentials with env-first / file-fallback precedence.
 *
 * @param dataDir   `.aweek/agents` root (matches the rest of the storage
 *                  layer's calling convention).
 * @param envSource Optional override of `process.env`. Defaults to
 *                  `process.env` when omitted; tests pass a frozen object.
 * @returns         A {@link SlackCredentials} object when both required
 *                  tokens were resolved, or `null` when either is missing.
 */
export async function loadSlackCredentials(
  dataDir: string,
  envSource: SlackEnvSource = process.env,
): Promise<SlackCredentials | null> {
  if (!dataDir) throw new TypeError('dataDir is required');

  const fileConfig = await readSlackConfigFile(dataDir);

  const botToken = pickToken(
    envSource.SLACK_BOT_TOKEN,
    fileConfig?.botToken,
    fileConfig?.bot_token,
    fileConfig?.SLACK_BOT_TOKEN,
  );
  const appToken = pickToken(
    envSource.SLACK_APP_TOKEN,
    fileConfig?.appToken,
    fileConfig?.app_token,
    fileConfig?.SLACK_APP_TOKEN,
  );
  const signingSecret = pickToken(
    envSource.SLACK_SIGNING_SECRET,
    fileConfig?.signingSecret,
    fileConfig?.signing_secret,
    fileConfig?.SLACK_SIGNING_SECRET,
  );

  if (!botToken || !appToken) return null;

  const out: SlackCredentials = { botToken, appToken };
  if (signingSecret) out.signingSecret = signingSecret;
  return out;
}

/**
 * Read and parse the Slack config file. Returns `null` for the two
 * silent-fallback cases:
 *
 *   - File does not exist (`ENOENT`).
 *   - File exists but is malformed JSON or not an object.
 *
 * The malformed-file case writes a one-line warning to stderr so a typo
 * is visible without taking down the listener.
 */
async function readSlackConfigFile(dataDir: string): Promise<RawSlackConfigDocument | null> {
  let raw: string;
  try {
    raw = await readFile(slackConfigPath(dataDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      `aweek: ignoring malformed ${SLACK_CHANNEL_DIRNAME}/${SLACK_CONFIG_FILENAME} and using env-only Slack credentials\n`,
    );
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed as RawSlackConfigDocument;
}

/**
 * Pick the first non-empty string from the candidate list. Uses
 * trim-then-non-empty rather than truthiness so a value of `"   "`
 * (whitespace-only) is treated as missing and falls through to the next
 * source. Non-string values are skipped silently.
 */
function pickToken(...candidates: ReadonlyArray<unknown>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}
