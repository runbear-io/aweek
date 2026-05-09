/**
 * Slack-init skill — bootstrap an aweek-branded Slack app and persist its
 * credentials so the embedded `SlackAdapter` inside `aweek serve` can
 * connect to Slack via Socket Mode.
 *
 * Two destructive surfaces, both gated on `confirmed: true`:
 *
 *   1. `provisionSlackApp` — calls `SlackManifestAPI`
 *      (alias of agentchannels' `SlackApiClient`) to:
 *
 *        a. Rotate a Slack **Refresh Token** (`xoxe-…`) into a short-lived
 *           access token (Slack invalidates the old refresh token and
 *           returns a new one — the new value is surfaced back so the
 *           caller can re-store it).
 *        b. `apps.manifest.create` with the aweek-branded manifest
 *           produced by `buildSlackManifest({ appName, appDescription,
 *           socketMode: true })`. This creates a real Slack app on the
 *           workspace so it counts as a remote write — confirmation
 *           gated.
 *        c. `apps.token.create` to produce the Socket-Mode app-level
 *           token (`xapp-…`) the `SlackAdapter` consumes.
 *
 *   2. `persistSlackCredentials` — writes the resolved credentials to
 *      `.aweek/channels/slack/config.json`. The bot token (`xoxb-…`) is
 *      obtained via the workspace OAuth install flow (which is
 *      interactive and lives outside this module — Slack returns the
 *      OAuth authorize URL on app creation). Callers feed the bot token
 *      back in once the human has completed the install.
 *
 * The composite `slackInit` is the high-level entry the `/aweek:slack-init`
 * skill markdown calls — it accepts whatever the user has supplied so far
 * (refresh token, manifest knobs, bot token, …) and runs whichever stages
 * apply. All disk writes go through `persistSlackCredentials` and refuse
 * to run without `confirmed: true`.
 *
 * Path layout (gitignored — `.aweek/` is in the repo's `.gitignore`):
 *
 *   `.aweek/channels/slack/config.json`
 *
 * Slack credentials are read at runtime by the embedded listener with
 * `process.env` taking precedence over this file (per project policy).
 *
 * Test seams:
 *   - `manifestApiCtor` injects a stand-in for `SlackManifestAPI` so
 *     tests don't talk to slack.com.
 *   - `rotateConfigTokenFn` injects a stand-in for the static
 *     `SlackManifestAPI.rotateConfigToken`.
 *   - `writeFileFn` / `mkdirFn` / `readFileFn` swap the filesystem.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  SlackManifestAPI,
  buildSlackManifest,
  type AppLevelTokenResult,
  type CreateAppResult,
  type SlackManifestOptions,
  type TokenRotationResult,
} from 'agentchannels';

import { resolveProjectDir } from './setup.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Error code thrown when a destructive operation runs without `confirmed: true`. */
export const ESLACK_INIT_NOT_CONFIRMED = 'ESLACK_INIT_NOT_CONFIRMED';

/** Default branding for the aweek Slack app. */
export const DEFAULT_SLACK_APP_NAME = 'aweek';
export const DEFAULT_SLACK_APP_DESCRIPTION =
  'aweek project-level Claude — chat with the project Claude through Slack.';

/** Default Socket-Mode app-level token name. */
export const DEFAULT_APP_TOKEN_NAME = 'aweek-socket';

/**
 * Path layout — `.aweek/channels/slack/` lives under the project root and
 * is gitignored via the repo-wide `.aweek/` rule.
 */
export const SLACK_CHANNEL_DIR = '.aweek/channels/slack';
export const SLACK_CONFIG_FILENAME = 'config.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The persisted Slack credential document. Every field is optional so
 * partial fills (e.g. before the user has completed the OAuth install)
 * remain valid on disk.
 */
export interface SlackCredentials {
  /** Bot token (`xoxb-…`) — obtained via the workspace OAuth install flow. */
  botToken?: string;
  /** Socket-Mode app-level token (`xapp-…`). */
  appToken?: string;
  /** Slack signing secret (returned from `apps.manifest.create`). */
  signingSecret?: string;
  /** Slack app ID (e.g. `A01ABC23DEF`). */
  appId?: string;
  /** OAuth client ID. */
  clientId?: string;
  /** OAuth client secret. */
  clientSecret?: string;
  /** Slack team ID (populated after token rotation, when available). */
  teamId?: string;
  /** Refresh token (`xoxe-…`). Slack rotates this on every access; the
   *  newest value is what callers should re-save. */
  refreshToken?: string;
  /** OAuth install URL the user must visit to install the app in their
   *  workspace and obtain the bot token. */
  oauthAuthorizeUrl?: string;
  /** Unix epoch (ms) of the most recent successful update. */
  updatedAt?: number;
}

/** Constructor signature for the injectable `SlackManifestAPI`. */
export type SlackManifestApiCtor = new (opts: { accessToken: string }) => {
  createAppFromManifest(manifest: object): Promise<CreateAppResult>;
  generateAppLevelToken(
    appId: string,
    tokenName?: string,
    scopes?: string[],
  ): Promise<AppLevelTokenResult>;
};

/** Static rotate function signature — defaults to `SlackManifestAPI.rotateConfigToken`. */
export type RotateConfigTokenFn = (
  refreshToken: string,
  apiBase?: string,
) => Promise<TokenRotationResult>;

/** Filesystem seams — injectable for tests. */
export type WriteFileFn = (path: string, contents: string) => Promise<void>;
export type ReadFileFn = (path: string) => Promise<string>;
export type MkdirFn = (
  path: string,
  opts?: { recursive?: boolean },
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Absolute path to the Slack channel directory for a given project. */
export function slackChannelDir(projectDir?: string): string {
  return resolve(resolveProjectDir(projectDir), SLACK_CHANNEL_DIR);
}

/** Absolute path to the persisted Slack config file. */
export function slackConfigPath(projectDir?: string): string {
  return resolve(slackChannelDir(projectDir), SLACK_CONFIG_FILENAME);
}

// ---------------------------------------------------------------------------
// Manifest builder
// ---------------------------------------------------------------------------

export interface BuildAweekManifestOptions {
  appName?: string;
  appDescription?: string;
  /** Socket Mode is the only supported transport for the embedded listener. */
  socketMode?: boolean;
}

/**
 * Build the aweek-branded Slack manifest. Thin wrapper around agentchannels'
 * `buildSlackManifest` that bakes in aweek defaults so the skill markdown
 * doesn't have to repeat them.
 */
export function buildAweekSlackManifest({
  appName = DEFAULT_SLACK_APP_NAME,
  appDescription = DEFAULT_SLACK_APP_DESCRIPTION,
  socketMode = true,
}: BuildAweekManifestOptions = {}): object {
  const opts: SlackManifestOptions = { appName, appDescription, socketMode };
  return buildSlackManifest(opts);
}

// ---------------------------------------------------------------------------
// provisionSlackApp — Slack-side writes
// ---------------------------------------------------------------------------

export interface ProvisionSlackAppOptions extends BuildAweekManifestOptions {
  /** Slack Refresh Token (`xoxe-…`). Required for programmatic provisioning. */
  refreshToken?: string;
  /** Human-readable name for the Socket-Mode app-level token. */
  appTokenName?: string;
  /** Test seam — replaces `SlackManifestAPI`. */
  manifestApiCtor?: SlackManifestApiCtor;
  /** Test seam — replaces `SlackManifestAPI.rotateConfigToken`. */
  rotateConfigTokenFn?: RotateConfigTokenFn;
  /** Required gate — Slack app creation is a durable remote write. */
  confirmed?: boolean;
}

export interface ProvisionSlackAppResult {
  ok: true;
  appId: string;
  oauthAuthorizeUrl: string;
  signingSecret: string;
  clientId: string;
  clientSecret: string;
  appToken: string;
  /** Newest refresh token returned by Slack. The previous one is now invalid. */
  refreshToken: string;
  teamId: string | undefined;
}

/**
 * Provision a Slack app from the aweek manifest and generate the
 * Socket-Mode app-level token.
 *
 * Refuses to run without `confirmed: true` — `apps.manifest.create` and
 * `apps.token.create` are durable side-effects on Slack's side, so the
 * skill markdown must collect explicit consent before invoking this.
 */
export async function provisionSlackApp(
  opts: ProvisionSlackAppOptions = {},
): Promise<ProvisionSlackAppResult> {
  if (opts.confirmed !== true) {
    const err = new Error(
      'provisionSlackApp requires explicit user confirmation. ' +
        'Collect consent via AskUserQuestion and pass `confirmed: true`.',
    ) as NodeJS.ErrnoException;
    err.code = ESLACK_INIT_NOT_CONFIRMED;
    throw err;
  }

  const refreshToken = opts.refreshToken;
  if (!refreshToken) {
    throw new Error(
      'provisionSlackApp requires a Slack Refresh Token (xoxe-…). ' +
        'Issue one at https://api.slack.com/apps → "Your Apps" → "Refresh tokens".',
    );
  }

  const Ctor = opts.manifestApiCtor ?? (SlackManifestAPI as unknown as SlackManifestApiCtor);
  const rotate =
    opts.rotateConfigTokenFn ??
    ((token: string) =>
      (SlackManifestAPI as unknown as { rotateConfigToken: RotateConfigTokenFn })
        .rotateConfigToken(token));

  // 1. Rotate refresh → access token. Slack invalidates the old refresh
  //    token here; the new one is part of the result.
  const rotation = await rotate(refreshToken);

  // 2. Create the Slack app from the aweek-branded manifest.
  const client = new Ctor({ accessToken: rotation.token });
  const manifest = buildAweekSlackManifest({
    appName: opts.appName,
    appDescription: opts.appDescription,
    socketMode: opts.socketMode ?? true,
  });
  const created = await client.createAppFromManifest(manifest);

  // 3. Generate the Socket-Mode app-level token (xapp-…).
  const appToken = await client.generateAppLevelToken(
    created.app_id,
    opts.appTokenName ?? DEFAULT_APP_TOKEN_NAME,
    ['connections:write'],
  );

  return {
    ok: true,
    appId: created.app_id,
    oauthAuthorizeUrl: created.oauth_authorize_url,
    signingSecret: created.credentials.signing_secret,
    clientId: created.credentials.client_id,
    clientSecret: created.credentials.client_secret,
    appToken: appToken.token,
    refreshToken: rotation.refresh_token,
    teamId: rotation.team?.id,
  };
}

// ---------------------------------------------------------------------------
// previewCredentialOverwrite — read-only safety preview
// ---------------------------------------------------------------------------

export interface PreviewCredentialOverwriteOptions {
  projectDir?: string;
  /** Proposed credential merge — the same shape `persistSlackCredentials` accepts. */
  proposed?: Partial<SlackCredentials>;
  /** Test seam — replaces `readFile`. */
  readFileFn?: ReadFileFn;
}

export interface CredentialFieldChange {
  /** Field name. */
  field: keyof SlackCredentials;
  /** Whether the field is currently present on disk. */
  currentlyPresent: boolean;
  /** True when the proposed write would change an existing value. */
  wouldOverwrite: boolean;
  /** True when the proposed write adds a new field that wasn't on disk. */
  wouldAdd: boolean;
}

export interface PreviewCredentialOverwriteResult {
  ok: true;
  /** Absolute path to the credentials file. */
  configPath: string;
  /** Whether the credentials file already exists on disk. */
  fileExists: boolean;
  /** Whether the existing file (if any) is malformed JSON. Treated as empty doc on write. */
  fileMalformed: boolean;
  /** Names of fields currently set on disk (excludes `updatedAt`). */
  fieldsCurrentlyPresent: (keyof SlackCredentials)[];
  /** Names of fields the proposed write would overwrite (existing → different). */
  fieldsThatWouldBeOverwritten: (keyof SlackCredentials)[];
  /** Names of fields the proposed write would add (not present → present). */
  fieldsThatWouldBeAdded: (keyof SlackCredentials)[];
  /** Per-field breakdown of the proposed change. */
  changes: CredentialFieldChange[];
}

/**
 * Read-only preview of what {@link persistSlackCredentials} would do. Returns
 * the absolute config path, whether the file already exists, the list of
 * fields currently set, and a per-field diff against the proposed write.
 *
 * Surfaced through the dispatcher so the SKILL markdown can render concrete
 * overwrite implications inside the AskUserQuestion confirmation step before
 * `confirmed: true` is ever passed downstream.
 *
 * Does NOT require `confirmed: true` — this call performs no writes.
 */
export async function previewCredentialOverwrite(
  opts: PreviewCredentialOverwriteOptions = {},
): Promise<PreviewCredentialOverwriteResult> {
  const path = slackConfigPath(opts.projectDir);
  const reader: ReadFileFn = opts.readFileFn ?? ((p) => readFile(p, 'utf8'));
  const proposed = opts.proposed ?? {};

  let existing: SlackCredentials = {};
  let fileExists = false;
  let fileMalformed = false;
  try {
    const raw = await reader(path);
    fileExists = true;
    const parsed = parseSlackCredentials(raw);
    existing = parsed;
    // If the file exists but parses to {} from non-empty content, it's malformed.
    if (raw.trim() !== '' && Object.keys(parsed).length === 0) {
      try {
        JSON.parse(raw);
      } catch {
        fileMalformed = true;
      }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code !== 'ENOENT') {
      // Surface unexpected errors — only ENOENT is treated as "no file yet".
      throw err;
    }
  }

  const allFields: readonly (keyof SlackCredentials)[] = [
    'botToken',
    'appToken',
    'signingSecret',
    'appId',
    'clientId',
    'clientSecret',
    'teamId',
    'refreshToken',
    'oauthAuthorizeUrl',
  ] as const;

  const fieldsCurrentlyPresent: (keyof SlackCredentials)[] = [];
  const fieldsThatWouldBeOverwritten: (keyof SlackCredentials)[] = [];
  const fieldsThatWouldBeAdded: (keyof SlackCredentials)[] = [];
  const changes: CredentialFieldChange[] = [];

  for (const field of allFields) {
    const currentlyPresent = existing[field] !== undefined;
    if (currentlyPresent) fieldsCurrentlyPresent.push(field);

    const proposedValue = proposed[field];
    const proposedIsSet = proposedValue !== undefined;
    if (!proposedIsSet) continue;

    const wouldOverwrite =
      currentlyPresent && existing[field] !== proposedValue;
    const wouldAdd = !currentlyPresent;
    if (wouldOverwrite) fieldsThatWouldBeOverwritten.push(field);
    if (wouldAdd) fieldsThatWouldBeAdded.push(field);

    changes.push({
      field,
      currentlyPresent,
      wouldOverwrite,
      wouldAdd,
    });
  }

  return {
    ok: true,
    configPath: path,
    fileExists,
    fileMalformed,
    fieldsCurrentlyPresent,
    fieldsThatWouldBeOverwritten,
    fieldsThatWouldBeAdded,
    changes,
  };
}

// ---------------------------------------------------------------------------
// persistSlackCredentials — disk writes
// ---------------------------------------------------------------------------

export interface PersistSlackCredentialsOptions {
  projectDir?: string;
  /** Credentials to merge into the existing on-disk document. */
  credentials: Partial<SlackCredentials>;
  /** Required gate — writes `.aweek/channels/slack/config.json`. */
  confirmed?: boolean;
  /** Wall-clock for `updatedAt`. Defaults to `Date.now`. */
  now?: () => number;
  /** Test seams. */
  writeFileFn?: WriteFileFn;
  readFileFn?: ReadFileFn;
  mkdirFn?: MkdirFn;
}

export interface PersistSlackCredentialsResult {
  ok: true;
  configPath: string;
  credentials: SlackCredentials;
  outcome: 'created' | 'updated';
}

/**
 * Persist Slack credentials to `.aweek/channels/slack/config.json`,
 * merging with the existing on-disk document (if any). Refuses to write
 * without `confirmed: true`.
 *
 * Atomic at the file-system level: writes the merged JSON in a single
 * `writeFile` call after creating the parent directory recursively.
 */
export async function persistSlackCredentials(
  opts: PersistSlackCredentialsOptions,
): Promise<PersistSlackCredentialsResult> {
  if (opts.confirmed !== true) {
    const err = new Error(
      'persistSlackCredentials requires explicit user confirmation. ' +
        'Collect consent via AskUserQuestion and pass `confirmed: true`.',
    ) as NodeJS.ErrnoException;
    err.code = ESLACK_INIT_NOT_CONFIRMED;
    throw err;
  }

  const path = slackConfigPath(opts.projectDir);
  const writer: WriteFileFn = opts.writeFileFn ?? ((p, c) => writeFile(p, c, 'utf8'));
  const reader: ReadFileFn = opts.readFileFn ?? ((p) => readFile(p, 'utf8'));
  const mkdirer: MkdirFn = opts.mkdirFn ?? ((p, o) => mkdir(p, o));
  const now = opts.now ?? (() => Date.now());

  // Load existing document (if any) so we can merge new fields without
  // clobbering credentials the caller didn't pass this time.
  let existing: SlackCredentials = {};
  let outcome: 'created' | 'updated' = 'created';
  try {
    const raw = await reader(path);
    existing = parseSlackCredentials(raw);
    outcome = 'updated';
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code !== 'ENOENT') {
      // A malformed file is surprising — but we treat it as an empty
      // doc rather than refusing to write. The merged write will fix it.
      existing = {};
    }
  }

  const merged: SlackCredentials = {
    ...existing,
    ...opts.credentials,
    updatedAt: now(),
  };

  await mkdirer(dirname(path), { recursive: true });
  await writer(path, JSON.stringify(merged, null, 2) + '\n');

  return { ok: true, configPath: path, credentials: merged, outcome };
}

/**
 * Parse a raw JSON blob into a {@link SlackCredentials}. Tolerant — unknown
 * keys are dropped, malformed JSON returns an empty doc.
 */
export function parseSlackCredentials(raw: string): SlackCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const obj = parsed as Record<string, unknown>;
  const out: SlackCredentials = {};
  const stringKeys: readonly (keyof SlackCredentials)[] = [
    'botToken',
    'appToken',
    'signingSecret',
    'appId',
    'clientId',
    'clientSecret',
    'teamId',
    'refreshToken',
    'oauthAuthorizeUrl',
  ] as const;
  for (const k of stringKeys) {
    const v = obj[k];
    if (typeof v === 'string') {
      // `out[k]` resolves to a union that includes `number` (updatedAt is
      // not in this list, but TS narrows the type at the union level).
      // We've keyed only string-valued fields, so the cast is safe.
      (out as Record<string, string>)[k] = v;
    }
  }
  if (typeof obj.updatedAt === 'number') out.updatedAt = obj.updatedAt;
  return out;
}

// ---------------------------------------------------------------------------
// slackInit — composite entry
// ---------------------------------------------------------------------------

export interface SlackInitOptions
  extends ProvisionSlackAppOptions,
    Omit<PersistSlackCredentialsOptions, 'credentials'> {
  /** Bot token (`xoxb-…`) the user supplies after completing OAuth install. */
  botToken?: string;
  /** Optional pre-supplied credentials to merge into the persisted doc. */
  credentials?: Partial<SlackCredentials>;
  /** Skip the SlackManifestAPI invocation (e.g. when the user already has
   *  a Slack app and only wants to record credentials). */
  skipProvision?: boolean;
}

export interface SlackInitResult {
  ok: true;
  configPath: string;
  /** Present when the SlackManifestAPI was invoked. */
  provision: ProvisionSlackAppResult | null;
  /** Always present — the merged on-disk document. */
  credentials: SlackCredentials;
  outcome: 'created' | 'updated';
}

/**
 * High-level entry called by the `/aweek:slack-init` skill markdown.
 *
 * Flow:
 *   1. If `skipProvision` is false (default) and a refresh token is
 *      provided, calls {@link provisionSlackApp} to create the Slack app
 *      and generate the Socket-Mode token.
 *   2. Merges the provisioning result with the user-supplied bot token
 *      (and any pre-supplied credentials) into the persisted doc via
 *      {@link persistSlackCredentials}.
 *
 * Both stages are gated on `confirmed: true` — the gate is enforced
 * inside the underlying primitives, not duplicated here.
 */
export async function slackInit(
  opts: SlackInitOptions = {},
): Promise<SlackInitResult> {
  if (opts.confirmed !== true) {
    const err = new Error(
      'slackInit requires explicit user confirmation. ' +
        'Collect consent via AskUserQuestion and pass `confirmed: true`.',
    ) as NodeJS.ErrnoException;
    err.code = ESLACK_INIT_NOT_CONFIRMED;
    throw err;
  }

  let provision: ProvisionSlackAppResult | null = null;
  if (!opts.skipProvision && opts.refreshToken) {
    provision = await provisionSlackApp({
      confirmed: true,
      refreshToken: opts.refreshToken,
      appName: opts.appName,
      appDescription: opts.appDescription,
      socketMode: opts.socketMode,
      appTokenName: opts.appTokenName,
      manifestApiCtor: opts.manifestApiCtor,
      rotateConfigTokenFn: opts.rotateConfigTokenFn,
    });
  }

  const merged: Partial<SlackCredentials> = {
    ...(opts.credentials ?? {}),
  };
  if (provision) {
    merged.appId = provision.appId;
    merged.clientId = provision.clientId;
    merged.clientSecret = provision.clientSecret;
    merged.signingSecret = provision.signingSecret;
    merged.appToken = provision.appToken;
    merged.refreshToken = provision.refreshToken;
    merged.oauthAuthorizeUrl = provision.oauthAuthorizeUrl;
    if (provision.teamId !== undefined) merged.teamId = provision.teamId;
  }
  if (opts.botToken) merged.botToken = opts.botToken;

  const persisted = await persistSlackCredentials({
    confirmed: true,
    projectDir: opts.projectDir,
    credentials: merged,
    now: opts.now,
    writeFileFn: opts.writeFileFn,
    readFileFn: opts.readFileFn,
    mkdirFn: opts.mkdirFn,
  });

  return {
    ok: true,
    configPath: persisted.configPath,
    provision,
    credentials: persisted.credentials,
    outcome: persisted.outcome,
  };
}
