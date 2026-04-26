/**
 * launchd backend for the aweek project heartbeat (macOS only).
 *
 * On macOS, a cron entry can't reach the user's Keychain, so Claude
 * Code's OAuth subscription tokens are invisible to cron-invoked
 * `claude` processes. launchd user agents run inside the user's aqua
 * session, so Keychain access works exactly like from Terminal — no
 * cleartext passwords, no ACL edits, no token-refresh surprises.
 *
 * Surface mirrors the cron surface in `init.js` so the two backends are
 * interchangeable behind the platform dispatcher:
 *
 *   - `buildLaunchdPlist`          — pure plist XML builder
 *   - `installLaunchdHeartbeat`    — write the plist + `launchctl bootstrap`
 *   - `queryLaunchdHeartbeat`      — read plist + check `launchctl print`
 *   - `uninstallLaunchdHeartbeat`  — `launchctl bootout` + delete plist
 *
 * All side-effect boundaries (fs, launchctl, uid) are injectable so
 * tests never touch the real system. Defaults are lazy-evaluated so
 * importing this module on Linux/Windows is harmless.
 */

import { createHash } from 'node:crypto';
import { execFile as _execFile } from 'node:child_process';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const pExecFile = promisify(_execFile);

/** Loose error shape for child_process / fs errors. */
interface ErrnoLike extends Error {
  code?: string | number;
  stderr?: string;
  stdout?: string;
}

/**
 * Prefix for the launchd service label. The full label is
 * `${LAUNCHD_LABEL_PREFIX}.${shortHash(projectDir)}` so multiple aweek
 * projects coexist without stomping each other's plist files.
 */
export const LAUNCHD_LABEL_PREFIX = 'io.aweek.heartbeat';

/**
 * Default tick interval in seconds (10 minutes). Matches the cron
 * backend's default `every-10-minutes` schedule.
 */
export const DEFAULT_LAUNCHD_INTERVAL_SECONDS = 600;

/**
 * Minimum StartInterval launchd accepts without complaint. Anything
 * below this is a tight-loop and almost certainly a bug.
 */
const MIN_LAUNCHD_INTERVAL_SECONDS = 60;

/** Result returned by {@link defaultLaunchctl}. */
export interface LaunchctlResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Async launchctl runner signature. */
export type LaunchctlFn = (args: string[]) => Promise<LaunchctlResult>;

/**
 * Convert a cron-style "every N minutes" schedule string to seconds.
 */
export function cronScheduleToSeconds(schedule: unknown): number {
  if (typeof schedule !== 'string') {
    throw new Error('schedule must be a string');
  }
  const match = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(schedule.trim());
  if (!match) {
    throw new Error(
      `Cannot convert cron schedule ${JSON.stringify(schedule)} to launchd StartInterval. ` +
        'Only `*/N * * * *` is supported; pass { intervalSeconds } for custom schedules.',
    );
  }
  const minutes = Number(match[1]);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`Invalid minute interval in schedule: ${schedule}`);
  }
  return minutes * 60;
}

/**
 * Short, stable hash of a project directory for the launchd label +
 * plist filename.
 */
function projectHash(projectDir: string): string {
  return createHash('sha1').update(projectDir).digest('hex').slice(0, 10);
}

/**
 * Build the full launchd service label for a project.
 */
export function launchdLabel(projectDir?: string): string {
  if (!projectDir) throw new Error('projectDir is required');
  return `${LAUNCHD_LABEL_PREFIX}.${projectHash(projectDir)}`;
}

/**
 * Absolute path to the plist file for a project.
 */
export function launchdPlistPath(
  projectDir: string,
  { home = homedir() }: { home?: string } = {},
): string {
  return join(
    home,
    'Library',
    'LaunchAgents',
    `${launchdLabel(projectDir)}.plist`,
  );
}

/**
 * Escape a string for safe inclusion in a POSIX single-quoted shell word.
 */
function shellSingleQuote(arg: unknown): string {
  return `'${String(arg).replaceAll("'", `'\\''`)}'`;
}

/**
 * Escape a string for safe inclusion in a plist XML `<string>` value.
 */
function xmlEscape(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Resolved heartbeat command. */
interface ResolvedLaunchdCommand {
  shell: string;
  loginFlag: string;
  innerCommand: string;
}

/**
 * Resolve the heartbeat command's components.
 */
function resolveLaunchdCommand({
  projectDir,
  shell = '/bin/zsh',
  loginFlag = '-lic',
}: {
  projectDir?: string;
  shell?: string;
  loginFlag?: string;
}): ResolvedLaunchdCommand {
  if (!projectDir) throw new Error('projectDir is required');
  const innerCommand = `aweek heartbeat --all --project-dir ${shellSingleQuote(projectDir)}`;
  return { shell, loginFlag, innerCommand };
}

/** Options accepted by {@link buildLaunchdPlist}. */
export interface BuildLaunchdPlistOptions {
  projectDir?: string;
  intervalSeconds?: number;
  schedule?: string;
  shell?: string;
  loginFlag?: string;
  logsDir?: string;
}

/**
 * Build the plist XML for a project heartbeat.
 */
export function buildLaunchdPlist({
  projectDir,
  intervalSeconds,
  schedule,
  shell,
  loginFlag,
  logsDir,
}: BuildLaunchdPlistOptions = {}): string {
  if (!projectDir) throw new Error('projectDir is required');

  const seconds =
    typeof intervalSeconds === 'number'
      ? intervalSeconds
      : schedule != null
        ? cronScheduleToSeconds(schedule)
        : DEFAULT_LAUNCHD_INTERVAL_SECONDS;
  if (!Number.isFinite(seconds) || seconds < MIN_LAUNCHD_INTERVAL_SECONDS) {
    throw new Error(
      `intervalSeconds must be >= ${MIN_LAUNCHD_INTERVAL_SECONDS}; got ${seconds}`,
    );
  }

  const resolved = resolveLaunchdCommand({ projectDir, shell, loginFlag });
  const label = launchdLabel(projectDir);
  const resolvedLogsDir = logsDir || join(projectDir, '.aweek', 'logs');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '    <key>Label</key>',
    `    <string>${xmlEscape(label)}</string>`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    `        <string>${xmlEscape(resolved.shell)}</string>`,
    `        <string>${xmlEscape(resolved.loginFlag)}</string>`,
    `        <string>${xmlEscape(resolved.innerCommand)}</string>`,
    '    </array>',
    '    <key>StartInterval</key>',
    `    <integer>${Math.floor(seconds)}</integer>`,
    '    <key>RunAtLoad</key>',
    '    <false/>',
    '    <key>StandardOutPath</key>',
    `    <string>${xmlEscape(join(resolvedLogsDir, 'heartbeat.out.log'))}</string>`,
    '    <key>StandardErrorPath</key>',
    `    <string>${xmlEscape(join(resolvedLogsDir, 'heartbeat.err.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Result of {@link parseLaunchdPlist}. */
export interface ParsedLaunchdPlist {
  intervalSeconds: number | null;
  programArguments: string[];
}

/**
 * Extract the StartInterval (seconds) and the three-element
 * ProgramArguments from a plist XML blob.
 */
export function parseLaunchdPlist(plistXml: unknown): ParsedLaunchdPlist | null {
  if (typeof plistXml !== 'string' || plistXml.length === 0) return null;

  const intervalMatch =
    /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/i.exec(plistXml);
  const intervalSeconds = intervalMatch ? Number(intervalMatch[1]) : null;

  const argsMatch =
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(plistXml);
  const programArguments: string[] = [];
  if (argsMatch) {
    const stringRe = /<string>([\s\S]*?)<\/string>/gi;
    let m: RegExpExecArray | null;
    while ((m = stringRe.exec(argsMatch[1]!)) !== null) {
      programArguments.push(xmlUnescape(m[1]!));
    }
  }

  return { intervalSeconds, programArguments };
}

function xmlUnescape(value: string): string {
  return String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * Default `launchctl` runner.
 */
async function defaultLaunchctl(args: string[]): Promise<LaunchctlResult> {
  try {
    const { stdout, stderr } = await pExecFile('launchctl', args);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as ErrnoLike;
    if (e && typeof e.code === 'number') {
      return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
    // launchctl missing entirely (non-macOS), or spawn failure.
    throw err;
  }
}

function currentUidOrThrow(getUid: (() => number | null) | undefined): number {
  const uid = typeof getUid === 'function' ? getUid() : null;
  if (typeof uid !== 'number' || !Number.isFinite(uid) || uid < 0) {
    throw new Error(
      'Cannot resolve current user UID; launchd install requires process.getuid().',
    );
  }
  return uid;
}

function defaultGetUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** Options for {@link queryLaunchdHeartbeat}. */
export interface QueryLaunchdHeartbeatOptions {
  projectDir?: string;
  home?: string;
  readFileFn?: (path: string, enc: string) => Promise<string>;
  launchctlFn?: LaunchctlFn;
  getUidFn?: () => number | null;
}

/** Result of {@link queryLaunchdHeartbeat}. */
export interface QueryLaunchdHeartbeatResult {
  installed: boolean;
  loaded: boolean;
  label: string;
  plistPath: string;
  projectDir: string;
  intervalSeconds: number | null;
  programArguments: string[];
}

/**
 * Query the installed plist (if any) and whether launchd currently
 * tracks the service.
 */
export async function queryLaunchdHeartbeat({
  projectDir,
  home = homedir(),
  readFileFn,
  launchctlFn = defaultLaunchctl,
  getUidFn = defaultGetUid,
}: QueryLaunchdHeartbeatOptions = {}): Promise<QueryLaunchdHeartbeatResult> {
  if (!projectDir) throw new Error('projectDir is required');

  const plistPath = launchdPlistPath(projectDir, { home });
  const label = launchdLabel(projectDir);

  const reader = readFileFn || ((p: string, enc: string) => readFile(p, enc as BufferEncoding));

  let plistXml: string | null = null;
  try {
    plistXml = await reader(plistPath, 'utf8');
  } catch (err) {
    const e = err as ErrnoLike;
    if (e && e.code !== 'ENOENT') throw err;
  }

  const parsed = plistXml ? parseLaunchdPlist(plistXml) : null;

  let loaded = false;
  if (plistXml) {
    try {
      const uid = currentUidOrThrow(getUidFn);
      const res = await launchctlFn(['print', `gui/${uid}/${label}`]);
      loaded = res.code === 0;
    } catch {
      loaded = false;
    }
  }

  return {
    installed: !!plistXml,
    loaded,
    label,
    plistPath,
    projectDir,
    intervalSeconds: parsed ? parsed.intervalSeconds : null,
    programArguments: parsed ? parsed.programArguments : [],
  };
}

/** Options for {@link installLaunchdHeartbeat}. */
export interface InstallLaunchdHeartbeatOptions {
  projectDir?: string;
  intervalSeconds?: number;
  schedule?: string;
  shell?: string;
  loginFlag?: string;
  logsDir?: string;
  confirmed?: boolean;
  home?: string;
  writeFileFn?: (path: string, content: string, enc: string) => Promise<void>;
  readFileFn?: (path: string, enc: string) => Promise<string>;
  mkdirFn?: (path: string, opts?: unknown) => Promise<unknown>;
  launchctlFn?: LaunchctlFn;
  getUidFn?: () => number | null;
}

/** Result of {@link installLaunchdHeartbeat}. */
export interface InstallLaunchdHeartbeatResult {
  outcome: 'created' | 'updated' | 'skipped';
  label: string;
  plistPath: string;
  projectDir: string;
  intervalSeconds: number | null;
  plist: string;
  previous: ParsedLaunchdPlist | null;
}

/**
 * Install (or refresh) the launchd user agent for a project.
 */
export async function installLaunchdHeartbeat({
  projectDir,
  intervalSeconds,
  schedule,
  shell,
  loginFlag,
  logsDir,
  confirmed = false,
  home = homedir(),
  writeFileFn,
  readFileFn,
  mkdirFn,
  launchctlFn = defaultLaunchctl,
  getUidFn = defaultGetUid,
}: InstallLaunchdHeartbeatOptions = {}): Promise<InstallLaunchdHeartbeatResult> {
  if (confirmed !== true) {
    const err = new Error(
      'installLaunchdHeartbeat requires explicit user confirmation. ' +
        'Collect consent via AskUserQuestion and pass `confirmed: true`.',
    ) as ErrnoLike;
    err.code = 'EHB_NOT_CONFIRMED';
    throw err;
  }
  if (!projectDir) throw new Error('projectDir is required');

  const writer =
    writeFileFn || ((p: string, c: string, enc: string) => writeFile(p, c, enc as BufferEncoding));
  const reader =
    readFileFn || ((p: string, enc: string) => readFile(p, enc as BufferEncoding));
  const mkdirImpl =
    mkdirFn ||
    ((p: string, opts?: unknown) => mkdir(p, opts as { recursive?: boolean } | undefined));

  const plistPath = launchdPlistPath(projectDir, { home });
  const label = launchdLabel(projectDir);
  const plist = buildLaunchdPlist({
    projectDir,
    intervalSeconds,
    schedule,
    shell,
    loginFlag,
    logsDir,
  });
  const parsedNew = parseLaunchdPlist(plist)!;

  let existing: ParsedLaunchdPlist | null = null;
  try {
    const prev = await reader(plistPath, 'utf8');
    existing = parseLaunchdPlist(prev);
    // Same-content early-return only when the service is actually loaded;
    // otherwise fall through so we bootstrap it.
    if (prev === plist) {
      const uid = currentUidOrThrow(getUidFn);
      const res = await launchctlFn(['print', `gui/${uid}/${label}`]);
      if (res.code === 0) {
        return {
          outcome: 'skipped',
          label,
          plistPath,
          projectDir,
          intervalSeconds: parsedNew.intervalSeconds,
          plist,
          previous: existing,
        };
      }
    }
  } catch (err) {
    const e = err as ErrnoLike;
    if (e && e.code !== 'ENOENT') throw err;
  }

  // Ensure ~/Library/LaunchAgents exists.
  const parent = join(home, 'Library', 'LaunchAgents');
  await mkdirImpl(parent, { recursive: true });

  // Best-effort bootout before we overwrite — launchctl dislikes
  // overlapping the same label with new on-disk content.
  const uid = currentUidOrThrow(getUidFn);
  await launchctlFn(['bootout', `gui/${uid}/${label}`]).catch(() => null);

  await writer(plistPath, plist, 'utf8');

  const boot = await launchctlFn(['bootstrap', `gui/${uid}`, plistPath]);
  if (boot.code !== 0) {
    throw new Error(
      `launchctl bootstrap failed (code=${boot.code}): ${boot.stderr || boot.stdout}`.trim(),
    );
  }

  return {
    outcome: existing ? 'updated' : 'created',
    label,
    plistPath,
    projectDir,
    intervalSeconds: parsedNew.intervalSeconds,
    plist,
    previous: existing,
  };
}

/** Options for {@link uninstallLaunchdHeartbeat}. */
export interface UninstallLaunchdHeartbeatOptions {
  projectDir?: string;
  confirmed?: boolean;
  home?: string;
  unlinkFn?: (path: string) => Promise<void>;
  statFn?: (path: string) => Promise<unknown>;
  launchctlFn?: LaunchctlFn;
  getUidFn?: () => number | null;
}

/** Result of {@link uninstallLaunchdHeartbeat}. */
export interface UninstallLaunchdHeartbeatResult {
  outcome: 'removed' | 'absent';
  label: string;
  plistPath: string;
}

/**
 * Remove the launchd user agent for a project. Idempotent.
 */
export async function uninstallLaunchdHeartbeat({
  projectDir,
  confirmed = false,
  home = homedir(),
  unlinkFn,
  statFn,
  launchctlFn = defaultLaunchctl,
  getUidFn = defaultGetUid,
}: UninstallLaunchdHeartbeatOptions = {}): Promise<UninstallLaunchdHeartbeatResult> {
  if (confirmed !== true) {
    const err = new Error(
      'uninstallLaunchdHeartbeat requires explicit user confirmation. ' +
        'Collect consent via AskUserQuestion and pass `confirmed: true`.',
    ) as ErrnoLike;
    err.code = 'EHB_NOT_CONFIRMED';
    throw err;
  }
  if (!projectDir) throw new Error('projectDir is required');

  const plistPath = launchdPlistPath(projectDir, { home });
  const label = launchdLabel(projectDir);

  const unlinkImpl = unlinkFn || ((p: string) => unlink(p));
  const statImpl = statFn || ((p: string) => stat(p));

  let present = false;
  try {
    await statImpl(plistPath);
    present = true;
  } catch (err) {
    const e = err as ErrnoLike;
    if (e && e.code !== 'ENOENT') throw err;
  }

  // Best-effort unload even if the file is already gone.
  const uid = currentUidOrThrow(getUidFn);
  await launchctlFn(['bootout', `gui/${uid}/${label}`]).catch(() => null);

  if (present) {
    try {
      await unlinkImpl(plistPath);
    } catch (err) {
      const e = err as ErrnoLike;
      if (e && e.code !== 'ENOENT') throw err;
    }
  }

  return {
    outcome: present ? 'removed' : 'absent',
    label,
    plistPath,
  };
}
