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

/**
 * Convert a cron-style "every N minutes" schedule string to seconds. Used
 * so callers can keep the existing `heartbeatSchedule` option shape and
 * have it Just Work on macOS without learning a new knob.
 *
 * Anything more complex than "every N minutes" is rejected — we
 * deliberately do not paper over the impedance mismatch between cron's
 * 5-field grammar and launchd's `StartCalendarInterval` dict. Callers
 * that need a calendar-style schedule pass `intervalSeconds` directly.
 *
 * @param {string} schedule
 * @returns {number} Interval in seconds.
 */
export function cronScheduleToSeconds(schedule) {
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
 * plist filename. 10 hex chars ≈ 40 bits, plenty for disambiguation
 * between aweek projects on one user's machine.
 *
 * @param {string} projectDir
 * @returns {string}
 */
function projectHash(projectDir) {
  return createHash('sha1').update(projectDir).digest('hex').slice(0, 10);
}

/**
 * Build the full launchd service label for a project.
 *
 * @param {string} projectDir
 * @returns {string}
 */
export function launchdLabel(projectDir) {
  if (!projectDir) throw new Error('projectDir is required');
  return `${LAUNCHD_LABEL_PREFIX}.${projectHash(projectDir)}`;
}

/**
 * Absolute path to the plist file for a project.
 *
 * @param {string} projectDir
 * @param {object} [opts]
 * @param {string} [opts.home=homedir()]
 * @returns {string}
 */
export function launchdPlistPath(projectDir, { home = homedir() } = {}) {
  return join(
    home,
    'Library',
    'LaunchAgents',
    `${launchdLabel(projectDir)}.plist`,
  );
}

/**
 * Escape a string for safe inclusion in a POSIX single-quoted shell
 * word. Kept local (rather than imported from init.js) so this module
 * stays independent of the cron backend.
 *
 * @param {string} arg
 * @returns {string}
 */
function shellSingleQuote(arg) {
  return `'${String(arg).replaceAll("'", `'\\''`)}'`;
}

/**
 * Escape a string for safe inclusion in a plist XML `<string>` value.
 *
 * @param {string} value
 * @returns {string}
 */
function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Resolve the heartbeat command's {shell, loginFlag, innerCommand}
 * components. The launchd plist stores these as three separate argv
 * elements in `ProgramArguments`, so we intentionally skip the
 * cron-style "one giant shell string" packaging.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {string} [opts.shell='/bin/zsh']
 * @param {string} [opts.loginFlag='-lic']
 * @returns {{ shell: string, loginFlag: string, innerCommand: string }}
 */
function resolveLaunchdCommand({ projectDir, shell = '/bin/zsh', loginFlag = '-lic' }) {
  if (!projectDir) throw new Error('projectDir is required');
  const innerCommand = `aweek heartbeat --all --project-dir ${shellSingleQuote(
    projectDir,
  )}`;
  return { shell, loginFlag, innerCommand };
}

/**
 * Build the plist XML for a project heartbeat.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {number} [opts.intervalSeconds=DEFAULT_LAUNCHD_INTERVAL_SECONDS]
 * @param {string} [opts.schedule] - Alternative to intervalSeconds:
 *   a cron-style "every N minutes" string, converted via {@link cronScheduleToSeconds}.
 * @param {string} [opts.shell='/bin/zsh']
 * @param {string} [opts.loginFlag='-lic']
 * @param {string} [opts.logsDir] - Directory for stdout/stderr logs
 *   (defaults to `<projectDir>/.aweek/logs`).
 * @returns {string} Plist XML.
 */
export function buildLaunchdPlist({
  projectDir,
  intervalSeconds,
  schedule,
  shell,
  loginFlag,
  logsDir,
} = {}) {
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

/**
 * Extract the StartInterval (seconds) and the three-element
 * ProgramArguments from a plist XML blob. Deliberately loose — we only
 * parse what we need to decide "is the installed plist the same as
 * what we'd produce now" for the install idempotency contract.
 *
 * @param {string} plistXml
 * @returns {{ intervalSeconds: number | null, programArguments: string[] } | null}
 */
export function parseLaunchdPlist(plistXml) {
  if (typeof plistXml !== 'string' || plistXml.length === 0) return null;

  const intervalMatch =
    /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/i.exec(plistXml);
  const intervalSeconds = intervalMatch ? Number(intervalMatch[1]) : null;

  const argsMatch =
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(plistXml);
  const programArguments = [];
  if (argsMatch) {
    const stringRe = /<string>([\s\S]*?)<\/string>/gi;
    let m;
    while ((m = stringRe.exec(argsMatch[1])) !== null) {
      programArguments.push(xmlUnescape(m[1]));
    }
  }

  return { intervalSeconds, programArguments };
}

function xmlUnescape(value) {
  return String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * Default `launchctl` runner. Accepts a verb + args, returns
 * `{ code, stdout, stderr }` instead of throwing on non-zero exit so
 * the caller can distinguish "service not loaded" from "launchctl
 * missing".
 *
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function defaultLaunchctl(args) {
  try {
    const { stdout, stderr } = await pExecFile('launchctl', args);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return { code: err.code, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
    // launchctl missing entirely (non-macOS), or spawn failure.
    throw err;
  }
}

function currentUidOrThrow(getUid) {
  const uid = typeof getUid === 'function' ? getUid() : null;
  if (typeof uid !== 'number' || !Number.isFinite(uid) || uid < 0) {
    throw new Error(
      'Cannot resolve current user UID; launchd install requires process.getuid().',
    );
  }
  return uid;
}

function defaultGetUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * Query the installed plist (if any) and whether launchd currently
 * tracks the service. Mirrors `queryHeartbeat` on the cron side.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir]
 * @param {string} [opts.home=homedir()]
 * @param {Function} [opts.readFileFn]
 * @param {Function} [opts.launchctlFn] - `(args) => Promise<{code,stdout,stderr}>`
 * @param {Function} [opts.getUidFn]
 * @returns {Promise<{
 *   installed: boolean,
 *   loaded: boolean,
 *   label: string,
 *   plistPath: string,
 *   projectDir: string,
 *   intervalSeconds: number | null,
 *   programArguments: string[],
 * }>}
 */
export async function queryLaunchdHeartbeat({
  projectDir,
  home = homedir(),
  readFileFn = readFile,
  launchctlFn = defaultLaunchctl,
  getUidFn = defaultGetUid,
} = {}) {
  if (!projectDir) throw new Error('projectDir is required');

  const plistPath = launchdPlistPath(projectDir, { home });
  const label = launchdLabel(projectDir);

  let plistXml = null;
  try {
    plistXml = await readFileFn(plistPath, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
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

/**
 * Install (or refresh) the launchd user agent for a project.
 *
 * DESTRUCTIVE: writes `~/Library/LaunchAgents/<label>.plist` and runs
 * `launchctl bootstrap`. Requires `confirmed: true` for symmetry with
 * the cron backend's gate.
 *
 * Idempotency:
 *   - If the plist on disk matches what we would produce and the
 *     service is already loaded, outcome is `skipped`.
 *   - Otherwise the old plist is booted out (best-effort), the new
 *     plist is written, and `launchctl bootstrap` is invoked. Outcome
 *     is `created` or `updated` accordingly.
 *
 * @param {object} opts
 * @param {string} [opts.projectDir]
 * @param {number} [opts.intervalSeconds]
 * @param {string} [opts.schedule] - Cron-style shorthand, converted via
 *   {@link cronScheduleToSeconds}.
 * @param {string} [opts.shell]
 * @param {string} [opts.loginFlag]
 * @param {string} [opts.logsDir]
 * @param {boolean} [opts.confirmed=false]
 * @param {string} [opts.home=homedir()]
 * @param {Function} [opts.writeFileFn]
 * @param {Function} [opts.readFileFn]
 * @param {Function} [opts.mkdirFn]
 * @param {Function} [opts.launchctlFn]
 * @param {Function} [opts.getUidFn]
 * @returns {Promise<{
 *   outcome: 'created' | 'updated' | 'skipped',
 *   label: string,
 *   plistPath: string,
 *   projectDir: string,
 *   intervalSeconds: number,
 *   plist: string,
 *   previous: { intervalSeconds: number | null } | null,
 * }>}
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
  writeFileFn = writeFile,
  readFileFn = readFile,
  mkdirFn = mkdir,
  launchctlFn = defaultLaunchctl,
  getUidFn = defaultGetUid,
} = {}) {
  if (confirmed !== true) {
    const err = new Error(
      'installLaunchdHeartbeat requires explicit user confirmation. ' +
        'Collect consent via AskUserQuestion and pass `confirmed: true`.',
    );
    err.code = 'EHB_NOT_CONFIRMED';
    throw err;
  }
  if (!projectDir) throw new Error('projectDir is required');

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
  const parsedNew = parseLaunchdPlist(plist);

  let existing = null;
  try {
    const prev = await readFileFn(plistPath, 'utf8');
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
    if (err && err.code !== 'ENOENT') throw err;
  }

  // Ensure ~/Library/LaunchAgents exists.
  const parent = join(home, 'Library', 'LaunchAgents');
  await mkdirFn(parent, { recursive: true });

  // Best-effort bootout before we overwrite — launchctl dislikes
  // overlapping the same label with new on-disk content.
  const uid = currentUidOrThrow(getUidFn);
  await launchctlFn(['bootout', `gui/${uid}/${label}`]).catch(() => null);

  await writeFileFn(plistPath, plist, 'utf8');

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

/**
 * Remove the launchd user agent for a project. Idempotent.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {boolean} [opts.confirmed=false]
 * @param {string} [opts.home=homedir()]
 * @param {Function} [opts.unlinkFn]
 * @param {Function} [opts.statFn]
 * @param {Function} [opts.launchctlFn]
 * @param {Function} [opts.getUidFn]
 * @returns {Promise<{
 *   outcome: 'removed' | 'absent',
 *   label: string,
 *   plistPath: string,
 * }>}
 */
export async function uninstallLaunchdHeartbeat({
  projectDir,
  confirmed = false,
  home = homedir(),
  unlinkFn = unlink,
  statFn = stat,
  launchctlFn = defaultLaunchctl,
  getUidFn = defaultGetUid,
} = {}) {
  if (confirmed !== true) {
    const err = new Error(
      'uninstallLaunchdHeartbeat requires explicit user confirmation. ' +
        'Collect consent via AskUserQuestion and pass `confirmed: true`.',
    );
    err.code = 'EHB_NOT_CONFIRMED';
    throw err;
  }
  if (!projectDir) throw new Error('projectDir is required');

  const plistPath = launchdPlistPath(projectDir, { home });
  const label = launchdLabel(projectDir);

  let present = false;
  try {
    await statFn(plistPath);
    present = true;
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }

  // Best-effort unload even if the file is already gone — covers the
  // case where the plist was hand-deleted but launchd still has it.
  const uid = currentUidOrThrow(getUidFn);
  await launchctlFn(['bootout', `gui/${uid}/${label}`]).catch(() => null);

  if (present) {
    try {
      await unlinkFn(plistPath);
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
  }

  return {
    outcome: present ? 'removed' : 'absent',
    label,
    plistPath,
  };
}
