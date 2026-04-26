/**
 * Init skill — project bootstrap primitives for `/aweek:init`.
 *
 * This Sub-AC (2 of AC 1) owns the two lowest-level init primitives:
 *
 *   1. `installDependencies` — runs `pnpm install` in the project root so a
 *      fresh checkout has every aweek runtime dependency available before any
 *      other skill (`/aweek:hire`, `/aweek:plan`, etc.) is invoked.
 *
 *   2. `ensureDataDir` — creates the `.aweek/` data root along with its three
 *      canonical subdirectories (`agents/`, `logs/`, `state/`).
 *
 * Both primitives are:
 *   - **Idempotent.** Safe to call on an already-initialized project. Each
 *     call reports one of `created`, `skipped`, or `updated` per resource.
 *   - **Pure-ish.** Accept an injectable `spawnFn` (for `installDependencies`)
 *     so tests can exercise the full control flow without actually shelling
 *     out to pnpm.
 *   - **Framework-agnostic.** No AskUserQuestion / Claude Code harness coupling.
 *     The `skills/aweek-init.md` wrapper handles interactive confirmation.
 *
 * Higher-level init helpers compose on top of these primitives:
 * `detectInitState` reports idempotency state, and `installHeartbeat`
 * gates the destructive crontab write behind explicit user confirmation.
 * Slash-command discovery is handled by the Claude Code plugin system
 * (see `.claude-plugin/plugin.json`), not this module.
 */
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { configPath, loadConfig, saveConfig } from '../storage/config-store.js';
import { DEFAULT_TZ } from '../time/zone.js';
import {
  installLaunchdHeartbeat,
  queryLaunchdHeartbeat,
  uninstallLaunchdHeartbeat,
} from './launchd.js';

const execFileAsync = promisify(execFile);

/**
 * Loose error shape that crontab/spawn helpers throw — we narrow on `.code`
 * and `.stderr` without insisting on a full `NodeJS.ErrnoException` shape.
 */
interface ErrnoLike extends Error {
  code?: string;
  stderr?: string;
  stdout?: string;
  exitCode?: number;
  cause?: unknown;
}

/**
 * Read the current user crontab.
 *
 * Returns empty string when the user has no crontab yet — `crontab -l` emits
 * "no crontab for <user>" on stderr and exits non-zero in that state, which
 * we treat as a normal empty-crontab result rather than an error.
 *
 * Inlined here (rather than imported from the former
 * `src/heartbeat/crontab-manager.js`) because the project-level heartbeat in
 * this module is now the ONLY automated crontab interaction surface in aweek.
 */
async function defaultReadCrontab(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('crontab', ['-l']);
    return stdout;
  } catch (err) {
    const e = err as ErrnoLike;
    if (e.stderr && e.stderr.includes('no crontab')) {
      return '';
    }
    throw err;
  }
}

/**
 * Write a full crontab string, replacing the current user crontab.
 *
 * Pipes `content` into `crontab -` via stdin. Like {@link defaultReadCrontab},
 * this is the sole automated write path into the user's crontab.
 */
async function defaultWriteCrontab(content: string): Promise<void> {
  const child = execFileAsync('crontab', ['-'], {});
  child.child.stdin!.write(content);
  child.child.stdin!.end();
  await child;
}

/** Async crontab read function signature. */
export type ReadCrontabFn = () => Promise<string>;
/** Async crontab write function signature. */
export type WriteCrontabFn = (content: string) => Promise<void>;

/**
 * Canonical subdirectories that live under `.aweek/`.
 *
 *   - `agents/` — per-agent JSON config + per-agent `logs/` and other
 *     subdirs created lazily by each store (activity logs, inbox, usage,
 *     executions, plans, reviews).
 *
 * The `locks/` directory is created lazily by the heartbeat runner on
 * first tick, not by init.
 *
 * Frozen to discourage ad-hoc mutation; subdir additions should be an explicit
 * code change with a matching test update.
 */
export const AWEEK_SUBDIRS: readonly string[] = Object.freeze(['agents']);

/**
 * Default aweek data-root path (relative to `projectDir`).
 *
 * Kept as `.aweek` rather than `.aweek/agents` so init reasons about the
 * whole directory tree. Callers that want just the agent config directory
 * should compose it as `join(dataDir, 'agents')`.
 */
export const DEFAULT_DATA_DIR = '.aweek';

/**
 * Default package manager for dependency installation.
 *
 * Matches `package.json#packageManager` (pnpm v10.7.0). Exposed as a constant
 * so tests can override via the `packageManager` option without hard-coding
 * the string in multiple places.
 */
export const DEFAULT_PACKAGE_MANAGER = 'pnpm';

/**
 * Resolve `projectDir` to an absolute path, falling back to `process.cwd()`.
 */
export function resolveProjectDir(projectDir?: string): string {
  return projectDir ? resolve(projectDir) : process.cwd();
}

/**
 * Check whether a path exists and is a directory.
 *
 * Distinguishes "missing" (returns false) from "exists but not a directory"
 * (throws) so callers can surface the latter as an error without silently
 * overwriting a regular file.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      const err = new Error(`Path exists but is not a directory: ${path}`) as ErrnoLike;
      err.code = 'ENOTDIR';
      throw err;
    }
    return true;
  } catch (err) {
    const e = err as ErrnoLike;
    if (e && e.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Check whether a path exists (file or directory) without reading it.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a caller-supplied `dataDir` to the `.aweek/` root.
 *
 * The skill markdown historically documents `dataDir: '.aweek/agents'`
 * (because `AgentStore` is pointed at the agents subdir). `init` reasons about
 * the whole tree, so we tolerate both forms:
 *
 *   - `.aweek` / `.aweek/` → treat as the aweek root.
 *   - `.aweek/agents`      → step up one level.
 */
function normalizeAweekRoot(absoluteDataDir: string): string {
  const leaf = basename(absoluteDataDir);
  if (leaf === 'agents') {
    return dirname(absoluteDataDir);
  }
  return absoluteDataDir;
}

/** Options accepted by {@link ensureDataDir}. */
export interface EnsureDataDirOptions {
  projectDir?: string;
  /**
   * Path (relative to `projectDir`) for the `.aweek/` root. Accepts
   * `.aweek/agents` for backwards compatibility with the original
   * skill-markdown default.
   */
  dataDir?: string;
}

/** Per-subdir outcome reported by {@link ensureDataDir}. */
export interface EnsureSubdirOutcome {
  path: string;
  outcome: 'created' | 'skipped';
}

/** Result of {@link ensureDataDir}. */
export interface EnsureDataDirResult {
  root: string;
  outcome: 'created' | 'skipped';
  subdirs: Record<string, EnsureSubdirOutcome>;
  agentsPath: string;
  config: {
    path: string;
    outcome: 'created' | 'skipped';
    timeZone: string;
  };
}

/**
 * Ensure the `.aweek/` directory tree exists.
 *
 * Creates (if missing) the aweek data root and its canonical `agents/`
 * subdirectory. Safe to call repeatedly — each resource reports its own
 * `created` / `skipped` outcome.
 */
export async function ensureDataDir({
  projectDir,
  dataDir = DEFAULT_DATA_DIR,
}: EnsureDataDirOptions = {}): Promise<EnsureDataDirResult> {
  const resolvedProject = resolveProjectDir(projectDir);
  const absoluteDataDir = resolve(resolvedProject, dataDir);
  const aweekRoot = normalizeAweekRoot(absoluteDataDir);

  // Record root existence BEFORE mkdir so we can report `created` vs `skipped`.
  const rootExisted = await isDirectory(aweekRoot);
  await mkdir(aweekRoot, { recursive: true });

  const subdirs: Record<string, EnsureSubdirOutcome> = {};
  for (const sub of AWEEK_SUBDIRS) {
    const subPath = join(aweekRoot, sub);
    const existed = await isDirectory(subPath);
    await mkdir(subPath, { recursive: true });
    subdirs[sub] = {
      path: subPath,
      outcome: existed ? 'skipped' : 'created',
    };
  }

  // Seed `.aweek/config.json` with the detected system time zone on a
  // fresh init. A re-init against an existing config is a no-op — we
  // don't touch a user-edited `timeZone` value, just report `skipped`.
  const agentsEntry = subdirs.agents!;
  const configAbsPath = configPath(agentsEntry.path);
  const configExisted = await pathExists(configAbsPath);
  let configOutcome: 'created' | 'skipped';
  if (configExisted) {
    configOutcome = 'skipped';
  } else {
    await saveConfig(agentsEntry.path, { timeZone: DEFAULT_TZ });
    configOutcome = 'created';
  }
  const configState = await loadConfig(agentsEntry.path);

  return {
    root: aweekRoot,
    outcome: rootExisted ? 'skipped' : 'created',
    subdirs,
    agentsPath: agentsEntry.path,
    config: {
      path: configAbsPath,
      outcome: configOutcome,
      timeZone: configState.timeZone,
    },
  };
}

/** Args passed to {@link SpawnFn}. */
export interface SpawnFnArgs {
  command: string;
  args: string[];
  cwd: string;
}

/** Result of a {@link SpawnFn} call. */
export interface SpawnFnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable spawner signature accepted by {@link installDependencies}. */
export type SpawnFn = (args: SpawnFnArgs) => Promise<SpawnFnResult>;

/**
 * Default spawner — boring, well-typed wrapper around `child_process.spawn`.
 *
 * Captures stdout/stderr as strings and resolves with the exit code. Kept as
 * a standalone function so tests can inject their own spawner via the
 * `spawnFn` option on {@link installDependencies} without having to stub
 * `child_process` globally.
 */
function defaultSpawn({ command, args, cwd }: SpawnFnArgs): Promise<SpawnFnResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (err) {
      rejectPromise(err);
      return;
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => rejectPromise(err));
    child.on('close', (code) => {
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}

/** Options for {@link installDependencies}. */
export interface InstallDependenciesOptions {
  projectDir?: string;
  /** Defaults to `pnpm` to match `package.json#packageManager`. */
  packageManager?: string;
  /** Arguments passed to the package manager. Defaults to `['install']`. */
  args?: string[];
  /** Injectable spawner for tests. */
  spawnFn?: SpawnFn;
}

/** Result of {@link installDependencies}. */
export interface InstallDependenciesResult {
  outcome: 'created' | 'updated' | 'skipped';
  packageManager: string;
  cwd: string;
  stdout: string;
  stderr: string;
  reason?: string;
}

/**
 * Install project dependencies via pnpm (or an alternate package manager).
 *
 * The heavy lifting is delegated to the package manager itself — pnpm is
 * already idempotent (a no-op install when the lockfile is in sync with
 * `node_modules`), so this function just:
 *
 *   1. Verifies `package.json` exists — reports `skipped` if not.
 *   2. Snapshots whether `node_modules/` existed (distinguishes `created` from
 *      `updated` in the returned outcome).
 *   3. Runs `<packageManager> install` in the project directory.
 *   4. Surfaces non-zero exit codes as an `EINSTALL` error with captured
 *      stdout/stderr for debugging.
 */
export async function installDependencies({
  projectDir,
  packageManager = DEFAULT_PACKAGE_MANAGER,
  args = ['install'],
  spawnFn,
}: InstallDependenciesOptions = {}): Promise<InstallDependenciesResult> {
  const cwd = resolveProjectDir(projectDir);

  const pkgJsonPath = join(cwd, 'package.json');
  if (!(await pathExists(pkgJsonPath))) {
    return {
      outcome: 'skipped',
      reason: 'no package.json found',
      packageManager,
      cwd,
      stdout: '',
      stderr: '',
    };
  }

  const nodeModulesPath = join(cwd, 'node_modules');
  const hadNodeModules = await isDirectory(nodeModulesPath).catch(() => false);

  const spawner: SpawnFn = spawnFn || defaultSpawn;

  let result: SpawnFnResult;
  try {
    result = await spawner({ command: packageManager, args, cwd });
  } catch (err) {
    const e = err as ErrnoLike;
    // `spawn ENOENT` when pnpm isn't on PATH — give a clearer error so the
    // skill markdown can tell the user to install pnpm first.
    if (e && e.code === 'ENOENT') {
      const friendly = new Error(
        `${packageManager} is not installed or not on PATH. Install it with "npm install -g ${packageManager}" or follow https://pnpm.io/installation.`,
      ) as ErrnoLike;
      friendly.code = 'EPKGMGR_MISSING';
      friendly.cause = err;
      throw friendly;
    }
    throw err;
  }

  if (result.code !== 0) {
    const err = new Error(
      `${packageManager} ${args.join(' ')} failed with exit code ${result.code}`,
    ) as ErrnoLike;
    err.code = 'EINSTALL';
    err.exitCode = result.code;
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    throw err;
  }

  return {
    outcome: hadNodeModules ? 'updated' : 'created',
    packageManager,
    cwd,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/* ------------------------------------------------------------------ *
 * Heartbeat crontab scaffolding (Sub-AC 3 of AC 1)
 * ------------------------------------------------------------------ *
 *
 * The aweek heartbeat is a *project-level* cron entry — one per
 * initialized project — that wakes up every 10 minutes and runs `aweek heartbeat
 * --all --project-dir <dir>`. This is aweek's ONLY automated scheduling
 * mechanism: the previous per-agent crontab path (formerly in
 * `src/heartbeat/crontab-manager.js`) has been removed, so every
 * scheduled agent tick is routed through this single project-level
 * heartbeat. The `aweek heartbeat <agentId>` CLI subcommand is retained
 * for manual debugging only and is never written to crontab.
 *
 * Marker format: `# aweek:project-heartbeat:<absoluteProjectDir>`
 *
 *   - Scoped by absolute `projectDir` so multiple aweek projects on the
 *     same host can coexist in one user's crontab without collision.
 *   - Distinct prefix (`project-heartbeat`) preserved so any legacy
 *     per-agent `aweek:heartbeat:<agentId>` markers left over from an
 *     older aweek install are not disturbed by project-level writes.
 *
 * All primitives are:
 *   - **Idempotent.** Re-running with identical options reports `skipped`.
 *     Re-running with a different schedule/command reports `updated`.
 *   - **Injectable.** `installHeartbeat` accepts `readCrontabFn` /
 *     `writeCrontabFn` so tests can exercise orchestration without
 *     touching the real system crontab.
 *   - **Gated.** `installHeartbeat` throws `EHB_NOT_CONFIRMED` unless
 *     the caller passes `confirmed: true`, matching the project-wide
 *     destructive-operation policy documented in `skills/aweek-init.md`.
 */

/**
 * Default cron schedule for the project heartbeat: every 10 minutes.
 */
export const DEFAULT_HEARTBEAT_SCHEDULE = '*/10 * * * *';

/**
 * Escape a string for safe inclusion inside a POSIX single-quoted shell
 * word. Only the `'` terminator needs special handling — everything
 * else is literal inside `'…'`. Cron runs each line through `/bin/sh
 * -c`, so quoting is required for absolute paths that may contain
 * spaces or other shell metacharacters.
 */
function shellSingleQuote(arg: unknown): string {
  return `'${String(arg).replaceAll("'", `'\\''`)}'`;
}

/**
 * Shells that accept the `-i` (interactive) flag alongside `-c`.
 *
 * We gate `-lic` on this match so exotic logins like `/bin/sh`,
 * `/bin/dash`, or restricted shells don't fail at cron time on an
 * unsupported flag combination. Anything outside this whitelist gets
 * non-interactive `-c` and loses rc sourcing — surfaced as a fallback,
 * not a default.
 */
const INTERACTIVE_SHELL_RE = /\/(zsh|bash|ksh|mksh|fish)$/;

/** Options accepted by {@link detectUserShell}. */
export interface DetectUserShellOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Result of {@link detectUserShell}. */
export interface DetectUserShellResult {
  shell: string;
  loginFlag: '-lic' | '-c';
}

/**
 * Detect the user's login shell for the cron wrap.
 *
 * Cron starts each tick with an almost-empty PATH, so baking rc
 * sourcing into the wrap is the only way `pnpm`/`nvm`/`volta`/`fnm`
 * PATH exports reach the heartbeat process. Commit dd5d959 tried this
 * with `-lc`, which sources `.zprofile` / `.bash_profile` only — but
 * every common version manager injects PATH from `.zshrc` / `.bashrc`
 * (interactive). `-lic` sources both: login files first
 * (`.zprofile` → Homebrew's `brew shellenv`, etc.) then interactive
 * (`.zshrc` → nvm, pnpm, pyenv, …) before the command runs.
 *
 * Resolution order:
 *   1. `env.SHELL` if it looks like an interactive-capable shell.
 *   2. Platform default (`/bin/zsh` on macOS since Catalina; `/bin/bash`
 *      on linux and other POSIX).
 *   3. `env.SHELL` verbatim with `-c` only, when it's a POSIX `/bin/sh`
 *      or similar non-interactive shell — rc sourcing is lost but we
 *      honor the user's explicit shell choice.
 */
export function detectUserShell({
  env = process.env,
  platform = process.platform,
}: DetectUserShellOptions = {}): DetectUserShellResult {
  const candidate = env && env.SHELL ? env.SHELL : null;
  if (candidate && INTERACTIVE_SHELL_RE.test(candidate)) {
    return { shell: candidate, loginFlag: '-lic' };
  }
  if (candidate) {
    // Explicit but non-interactive-capable ($SHELL=/bin/sh, /bin/dash).
    // Keep the user's shell but drop -li; we lose rc sourcing.
    return { shell: candidate, loginFlag: '-c' };
  }
  if (platform === 'darwin') return { shell: '/bin/zsh', loginFlag: '-lic' };
  return { shell: '/bin/bash', loginFlag: '-lic' };
}

/**
 * Comment-marker prefix used to identify the aweek project heartbeat in
 * the user's crontab. Deliberately distinct from the legacy per-agent
 * `aweek:heartbeat:` prefix so any lingering markers from an older
 * aweek install (before the per-agent crontab path was removed) stay
 * untouched by project-level writes.
 */
export const PROJECT_HEARTBEAT_MARKER_PREFIX = 'aweek:project-heartbeat:';

/**
 * Build the unique comment marker for a project heartbeat.
 */
export function projectHeartbeatMarker(projectDir?: string): string {
  if (!projectDir) throw new Error('projectDir is required');
  return `${PROJECT_HEARTBEAT_MARKER_PREFIX}${projectDir}`;
}

/** Options accepted by {@link buildHeartbeatCommand}. */
export interface BuildHeartbeatCommandOptions extends DetectUserShellOptions {
  projectDir?: string;
  shell?: string;
  loginFlag?: string;
}

/**
 * Build the default shell command for a project heartbeat.
 *
 * Emits a login + interactive shell wrap around a bare `aweek`
 * invocation:
 *
 *   `'<shell>' -lic 'aweek heartbeat --all --project-dir <projectDir>'`
 *
 * Why the wrap: cron ticks with a nearly-empty environment. `aweek`,
 * `node`, and any CLI aweek shells out to (notably `claude`) live
 * somewhere only the user's rc files put on PATH — most commonly
 * `.zshrc` via nvm/volta/fnm/pnpm/Homebrew. `<shell> -lic` sources
 * both login and interactive profiles, matching what a fresh terminal
 * does, so bare-name resolution works end-to-end: the shell finds
 * `aweek` (via the npm-global bin), the `aweek` shebang finds `node`,
 * and `spawn('claude', …)` inside the aweek runtime finds `claude`.
 *
 * Why not absolute paths for `node` / aweek's entry script: once
 * we're committed to sourcing the rc files (for `claude`), baking
 * absolute paths for node/aweek adds no extra resilience — if rc
 * sourcing fails, `claude` still won't resolve, and the heartbeat
 * fails anyway. Using bare names lets the user's `nvm use` choice
 * propagate to cron without reinstalling the heartbeat, and keeps
 * the crontab line readable. Callers that need to pin a specific
 * node or aweek binary (repo-dev workflows, CI) can pass a full
 * `command` string to {@link installHeartbeat}.
 */
export function buildHeartbeatCommand({
  projectDir,
  shell,
  loginFlag,
  env,
  platform,
}: BuildHeartbeatCommandOptions = {}): string {
  if (!projectDir) throw new Error('projectDir is required');

  const detected =
    shell && loginFlag ? { shell, loginFlag } : detectUserShell({ env, platform });
  const resolvedShell = shell || detected.shell;
  const resolvedFlag = loginFlag || detected.loginFlag;

  const inner = `aweek heartbeat --all --project-dir ${shellSingleQuote(projectDir)}`;

  return `${shellSingleQuote(resolvedShell)} ${resolvedFlag} ${shellSingleQuote(inner)}`;
}

/** Options accepted by {@link buildHeartbeatEntry}. */
export interface BuildHeartbeatEntryOptions extends BuildHeartbeatCommandOptions {
  schedule?: string;
  /** Defaults to {@link buildHeartbeatCommand}. */
  command?: string;
}

/**
 * Build the full crontab entry (marker + cron line) for a project heartbeat.
 *
 * Returns two lines: `# <marker>\n<schedule> <command>`.
 */
export function buildHeartbeatEntry({
  projectDir,
  schedule = DEFAULT_HEARTBEAT_SCHEDULE,
  command,
  shell,
  loginFlag,
  env,
  platform,
}: BuildHeartbeatEntryOptions = {}): string {
  if (!projectDir) throw new Error('projectDir is required');
  const marker = projectHeartbeatMarker(projectDir);
  const cmd =
    command ||
    buildHeartbeatCommand({
      projectDir,
      shell,
      loginFlag,
      env,
      platform,
    });
  return `# ${marker}\n${schedule} ${cmd}`;
}

/** Parsed heartbeat entry returned by {@link parseProjectHeartbeat}. */
export interface ProjectHeartbeatEntry {
  marker: string;
  schedule: string;
  command: string;
  raw: string;
}

/**
 * Parse a crontab blob and return the project-heartbeat entry for the
 * given `projectDir` (or null if none exists).
 *
 * Implementation notes:
 *   - Only lines matching our exact marker prefix + projectDir are
 *     considered. Partial prefix matches (e.g. a longer projectDir that
 *     starts with the target path) are rejected to avoid false positives.
 *   - A marker with no following cron line (last line, or followed by
 *     another comment) is ignored — tolerates hand-edited crontabs
 *     without false positives.
 */
export function parseProjectHeartbeat(
  crontabText: string | null | undefined,
  projectDir: string | null | undefined,
): ProjectHeartbeatEntry | null {
  if (!crontabText || !projectDir) return null;
  const target = projectHeartbeatMarker(projectDir);
  const lines = crontabText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith('# ')) continue;
    const markerText = line.slice(2).trim();
    if (markerText !== target) continue;

    const cronLine = (lines[i + 1] || '').trim();
    if (!cronLine || cronLine.startsWith('#')) return null;

    const parts = cronLine.split(/\s+/);
    if (parts.length < 6) return null; // need 5 schedule fields + at least 1 command token
    const schedule = parts.slice(0, 5).join(' ');
    const command = parts.slice(5).join(' ');
    return {
      marker: target,
      schedule,
      command,
      raw: `${line}\n${cronLine}`,
    };
  }

  return null;
}

/**
 * Remove the project-heartbeat marker + cron line for `projectDir` from
 * the provided crontab text. Idempotent: returns the input unchanged
 * if no matching entry exists.
 */
export function removeProjectHeartbeat(
  crontabText: string | null | undefined,
  projectDir: string,
): string {
  if (!crontabText) return crontabText || '';
  const target = `# ${projectHeartbeatMarker(projectDir)}`;
  const lines = crontabText.split('\n');
  const out: string[] = [];
  let skipNext = false;

  for (const line of lines) {
    if (line.trim() === target) {
      skipNext = true;
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    out.push(line);
  }

  return out.join('\n');
}

/** Options for {@link queryCronHeartbeat}. */
export interface QueryCronHeartbeatOptions {
  projectDir?: string;
  readCrontabFn?: ReadCrontabFn;
}

/** Result of {@link queryCronHeartbeat}. */
export interface QueryCronHeartbeatResult {
  installed: boolean;
  schedule: string | null;
  command: string | null;
  marker: string;
  projectDir: string;
  entry: ProjectHeartbeatEntry | null;
}

/**
 * Query whether a project heartbeat is currently installed.
 */
export async function queryCronHeartbeat({
  projectDir,
  readCrontabFn,
}: QueryCronHeartbeatOptions = {}): Promise<QueryCronHeartbeatResult> {
  const resolvedProject = resolveProjectDir(projectDir);
  const reader: ReadCrontabFn = readCrontabFn || defaultReadCrontab;
  const current = await reader();
  const entry = parseProjectHeartbeat(current, resolvedProject);
  return {
    installed: !!entry,
    schedule: entry ? entry.schedule : null,
    command: entry ? entry.command : null,
    marker: projectHeartbeatMarker(resolvedProject),
    projectDir: resolvedProject,
    entry,
  };
}

/** Options for {@link installCronHeartbeat}. */
export interface InstallCronHeartbeatOptions extends BuildHeartbeatCommandOptions {
  schedule?: string;
  command?: string;
  /** Must be `true` to perform the destructive crontab write. */
  confirmed?: boolean;
  readCrontabFn?: ReadCrontabFn;
  writeCrontabFn?: WriteCrontabFn;
}

/** Result of {@link installCronHeartbeat}. */
export interface InstallCronHeartbeatResult {
  outcome: 'created' | 'updated' | 'skipped';
  marker: string;
  projectDir: string;
  schedule: string;
  command: string;
  entry: string;
  previous: { schedule: string; command: string } | null;
}

/**
 * Install (or refresh) the project-heartbeat crontab entry.
 *
 * DESTRUCTIVE: this writes to the caller's user crontab. Per the
 * destructive-operation policy in `skills/aweek-init.md`, the caller
 * MUST collect an explicit user confirmation via AskUserQuestion and
 * pass `confirmed: true` to this function. Invocations without
 * `confirmed: true` throw `EHB_NOT_CONFIRMED` without touching crontab.
 */
export async function installCronHeartbeat({
  projectDir,
  schedule = DEFAULT_HEARTBEAT_SCHEDULE,
  command,
  shell,
  loginFlag,
  env,
  platform,
  confirmed = false,
  readCrontabFn,
  writeCrontabFn,
}: InstallCronHeartbeatOptions = {}): Promise<InstallCronHeartbeatResult> {
  if (confirmed !== true) {
    const err = new Error(
      'installCronHeartbeat requires explicit user confirmation. ' +
        'Collect consent via AskUserQuestion and pass `confirmed: true`.',
    ) as ErrnoLike;
    err.code = 'EHB_NOT_CONFIRMED';
    throw err;
  }

  const resolvedProject = resolveProjectDir(projectDir);
  const resolvedCommand =
    command ||
    buildHeartbeatCommand({
      projectDir: resolvedProject,
      shell,
      loginFlag,
      env,
      platform,
    });
  const reader: ReadCrontabFn = readCrontabFn || defaultReadCrontab;
  const writer: WriteCrontabFn = writeCrontabFn || defaultWriteCrontab;

  const current = await reader();
  const existing = parseProjectHeartbeat(current, resolvedProject);
  const marker = projectHeartbeatMarker(resolvedProject);
  const entry = buildHeartbeatEntry({
    projectDir: resolvedProject,
    schedule,
    command: resolvedCommand,
  });

  // Fast-path: already installed identically → no-op.
  if (
    existing &&
    existing.schedule === schedule &&
    existing.command === resolvedCommand
  ) {
    return {
      outcome: 'skipped',
      marker,
      projectDir: resolvedProject,
      schedule,
      command: resolvedCommand,
      entry,
      previous: { schedule: existing.schedule, command: existing.command },
    };
  }

  // Drop any prior entry for this project, then append the fresh one.
  const cleaned = removeProjectHeartbeat(current, resolvedProject);
  const base = cleaned.trimEnd();
  const newCrontab = base ? `${base}\n${entry}\n` : `${entry}\n`;

  await writer(newCrontab);

  return {
    outcome: existing ? 'updated' : 'created',
    marker,
    projectDir: resolvedProject,
    schedule,
    command: resolvedCommand,
    entry,
    previous: existing
      ? { schedule: existing.schedule, command: existing.command }
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * Heartbeat platform dispatcher
 * ------------------------------------------------------------------ *
 *
 * Cron can't reach the macOS Keychain, so Claude Code's subscription
 * OAuth tokens are invisible to cron-spawned `claude` processes on
 * darwin — users hit a `/login` prompt every tick. Launchd user agents
 * run inside the user's aqua session and inherit Keychain access,
 * making the subscription path Just Work.
 *
 * On non-macOS platforms the cron backend is retained: Linux cron
 * inherits the user session adequately, Windows users are served by a
 * separate follow-up (Task Scheduler).
 *
 * The dispatcher is intentionally dumb — it picks a backend based on
 * `platform` (or an explicit `backend` override), then delegates.
 * Backends keep their own shape; we add a `backend: 'cron' | 'launchd'`
 * field so callers can branch on what actually ran without re-detecting.
 */

/** Heartbeat backend identifier. */
export type HeartbeatBackend = 'cron' | 'launchd';

/**
 * Pick the heartbeat backend for a given platform.
 */
export function resolveHeartbeatBackend(
  platform: NodeJS.Platform = process.platform,
): HeartbeatBackend {
  return platform === 'darwin' ? 'launchd' : 'cron';
}

/** Combined options accepted by the {@link installHeartbeat} dispatcher. */
export interface InstallHeartbeatOptions extends InstallCronHeartbeatOptions {
  backend?: HeartbeatBackend;
  intervalSeconds?: number;
  logsDir?: string;
  home?: string;
  writeFileFn?: (path: string, content: string) => Promise<void>;
  readFileFn?: (path: string) => Promise<string>;
  mkdirFn?: (path: string, opts?: unknown) => Promise<unknown>;
  launchctlFn?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  getUidFn?: () => number;
}

/**
 * Install (or refresh) the project heartbeat, dispatching to the cron
 * or launchd backend based on `platform` (or explicit `backend`).
 *
 * When installing the launchd backend on a machine that already has a
 * legacy cron entry for the same project, the cron entry is removed in
 * the same transaction and `migratedFromCron: true` is set on the
 * result. That lets users upgrade from the cron path without needing
 * to remember to clean up the old crontab line.
 */
export async function installHeartbeat(
  opts: InstallHeartbeatOptions = {},
): Promise<Record<string, unknown>> {
  const backend = opts.backend || resolveHeartbeatBackend(opts.platform);

  if (backend === 'launchd') {
    const projectDir = resolveProjectDir(opts.projectDir);
    // Best-effort migration: if a legacy cron entry exists for this
    // project, drop it now. Failures are non-fatal — the launchd install
    // is the source of truth going forward.
    let migratedFromCron = false;
    try {
      const reader: ReadCrontabFn = opts.readCrontabFn || defaultReadCrontab;
      const writer: WriteCrontabFn = opts.writeCrontabFn || defaultWriteCrontab;
      const current = await reader();
      if (current && parseProjectHeartbeat(current, projectDir)) {
        if (opts.confirmed !== true) {
          // Mirror the cron gate — never touch the user's crontab
          // without `confirmed: true`, even for a migration.
          const err = new Error(
            'installHeartbeat requires explicit user confirmation. ' +
              'Collect consent via AskUserQuestion and pass `confirmed: true`.',
          ) as ErrnoLike;
          err.code = 'EHB_NOT_CONFIRMED';
          throw err;
        }
        const cleaned = removeProjectHeartbeat(current, projectDir);
        await writer(cleaned);
        migratedFromCron = true;
      }
    } catch (err) {
      // Only re-throw the confirmation gate; swallow crontab-read
      // errors so missing `crontab` doesn't block the launchd install.
      const e = err as ErrnoLike;
      if (e && e.code === 'EHB_NOT_CONFIRMED') throw err;
    }

    const res = (await installLaunchdHeartbeat({
      projectDir,
      intervalSeconds: opts.intervalSeconds,
      schedule: opts.schedule,
      shell: opts.shell,
      loginFlag: opts.loginFlag,
      logsDir: opts.logsDir,
      confirmed: opts.confirmed,
      home: opts.home,
      writeFileFn: opts.writeFileFn,
      readFileFn: opts.readFileFn,
      mkdirFn: opts.mkdirFn,
      launchctlFn: opts.launchctlFn,
      getUidFn: opts.getUidFn,
    })) as unknown as { outcome: string; [key: string]: unknown };
    return {
      backend: 'launchd',
      migratedFromCron,
      ...(migratedFromCron && res.outcome === 'created'
        ? { outcome: 'migrated' }
        : null),
      ...res,
      outcome: migratedFromCron && res.outcome === 'created' ? 'migrated' : res.outcome,
    };
  }

  const res = await installCronHeartbeat(opts);
  return { backend: 'cron', ...res };
}

/** Options accepted by the {@link queryHeartbeat} dispatcher. */
export interface QueryHeartbeatOptions extends QueryCronHeartbeatOptions {
  backend?: HeartbeatBackend;
  platform?: NodeJS.Platform;
  home?: string;
  readFileFn?: (path: string) => Promise<string>;
  launchctlFn?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  getUidFn?: () => number;
}

/**
 * Query the installed heartbeat, dispatching to the cron or launchd
 * backend.
 */
export async function queryHeartbeat(
  opts: QueryHeartbeatOptions = {},
): Promise<Record<string, unknown>> {
  const backend = opts.backend || resolveHeartbeatBackend(opts.platform);
  if (backend === 'launchd') {
    const res = await queryLaunchdHeartbeat({
      projectDir: resolveProjectDir(opts.projectDir),
      home: opts.home,
      readFileFn: opts.readFileFn,
      launchctlFn: opts.launchctlFn,
      getUidFn: opts.getUidFn,
    });
    return { backend: 'launchd', ...(res as object) };
  }
  const res = await queryCronHeartbeat(opts);
  return { backend: 'cron', ...res };
}

/** Options accepted by the {@link uninstallHeartbeat} dispatcher. */
export interface UninstallHeartbeatOptions {
  backend?: HeartbeatBackend;
  platform?: NodeJS.Platform;
  projectDir?: string;
  confirmed?: boolean;
  home?: string;
  unlinkFn?: (path: string) => Promise<void>;
  statFn?: (path: string) => Promise<unknown>;
  launchctlFn?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  getUidFn?: () => number;
  readCrontabFn?: ReadCrontabFn;
  writeCrontabFn?: WriteCrontabFn;
}

/**
 * Uninstall the project heartbeat, dispatching to the cron or launchd
 * backend. Included for symmetry + to give the skill markdown a single
 * call for teardown; the cron uninstall path simply writes an empty
 * crontab line for this project via {@link removeProjectHeartbeat}.
 */
export async function uninstallHeartbeat(
  opts: UninstallHeartbeatOptions = {},
): Promise<Record<string, unknown>> {
  const backend = opts.backend || resolveHeartbeatBackend(opts.platform);
  if (backend === 'launchd') {
    const res = await uninstallLaunchdHeartbeat({
      projectDir: resolveProjectDir(opts.projectDir),
      confirmed: opts.confirmed,
      home: opts.home,
      unlinkFn: opts.unlinkFn,
      statFn: opts.statFn,
      launchctlFn: opts.launchctlFn,
      getUidFn: opts.getUidFn,
    });
    return { backend: 'launchd', ...(res as object) };
  }

  // Cron uninstall is a thin wrapper around removeProjectHeartbeat.
  if (opts.confirmed !== true) {
    const err = new Error(
      'uninstallHeartbeat requires explicit user confirmation. ' +
        'Collect consent via AskUserQuestion and pass `confirmed: true`.',
    ) as ErrnoLike;
    err.code = 'EHB_NOT_CONFIRMED';
    throw err;
  }
  const projectDir = resolveProjectDir(opts.projectDir);
  const reader: ReadCrontabFn = opts.readCrontabFn || defaultReadCrontab;
  const writer: WriteCrontabFn = opts.writeCrontabFn || defaultWriteCrontab;
  const current = await reader();
  const existing = parseProjectHeartbeat(current, projectDir);
  if (!existing) {
    return { backend: 'cron', outcome: 'absent', projectDir };
  }
  const cleaned = removeProjectHeartbeat(current, projectDir);
  await writer(cleaned);
  return { backend: 'cron', outcome: 'removed', projectDir };
}

/* ------------------------------------------------------------------ *
 * Hire-flow handoff (Sub-AC 4 of AC 1)
 * ------------------------------------------------------------------ *
 *
 * After `/aweek:init` finishes its infrastructure steps (data dir,
 * skill registration, optional heartbeat) the skill markdown needs to
 * decide whether to hand the user straight over to `/aweek:hire` so
 * they can create their first agent without leaving the wizard.
 *
 * These helpers provide:
 *
 *   1. `hasExistingAgents` — does `.aweek/agents/` contain any agent
 *      config files? A fresh init should answer "no" and suggest the
 *      hire flow; a re-run against an already-populated project should
 *      answer "yes" and skip the suggestion.
 *
 *   2. `shouldLaunchHire` — a thin convenience wrapper over
 *      `hasExistingAgents` that returns the launch decision directly
 *      (inverse of "has agents").
 *
 *   3. `buildHireLaunchInstruction` — produces a machine-readable
 *      payload describing the `/aweek:hire` handoff. The skill markdown
 *      consumes this to render the handoff prompt consistently and to
 *      drive the `SlashCommand` / skill invocation.
 *
 *   4. `formatHireLaunchPrompt` — user-facing prompt text presented via
 *      `AskUserQuestion` to gate the handoff on explicit consent.
 *
 *   5. `finalizeInit` — the orchestrating helper that composes the
 *      above into a single `{ launchHire, nextSkill, instruction, ... }`
 *      result the skill markdown can act on after printing the Step 5
 *      summary. Kept separate from `runInit` (landing in a later sub-AC)
 *      so this sub-AC can be merged independently.
 *
 * All helpers are:
 *   - **Pure / injectable.** Accept a `hasAgentsFn` override for tests
 *     so we can exercise the full control flow without touching the
 *     real filesystem.
 *   - **Non-destructive.** Launching `/aweek:hire` creates a *new*
 *     agent; it does not mutate existing state. No `confirmed: true`
 *     gate is required — the skill markdown still asks the user via
 *     `AskUserQuestion` as a UX courtesy, but init.js does not enforce
 *     a confirmation token the way `installHeartbeat` does.
 */

/**
 * Canonical slash-command name for the hire skill.
 *
 * Exposed as a constant so the markdown step and downstream tooling
 * stay in sync if we ever rename the command.
 */
export const HIRE_SKILL_NAME = '/aweek:hire';

/**
 * Default user-facing copy for the post-init hire prompt on a fresh
 * project (no agents yet).
 */
export const DEFAULT_HIRE_PROMPT_TEXT =
  'Infrastructure setup is complete. Would you like to hire your first agent now via /aweek:hire?';

/**
 * Default user-facing copy for the post-init hire prompt on a re-run
 * where at least one agent already exists.
 */
export const DEFAULT_ADD_AGENT_PROMPT_TEXT =
  'aweek is already initialized. Would you like to hire another agent now via /aweek:hire?';

/** Options for {@link hasExistingAgents}. */
export interface HasExistingAgentsOptions {
  projectDir?: string;
  /** Accepts `.aweek` or `.aweek/agents`; normalized via {@link normalizeAweekRoot}. */
  dataDir?: string;
}

/** Probe signature accepted by {@link shouldLaunchHire} / {@link finalizeInit}. */
export type HasAgentsFn = (opts: HasExistingAgentsOptions) => Promise<boolean>;

/**
 * Check whether the project already has at least one agent config.
 *
 * Inspects `.aweek/agents/` for any `*.json` files. Missing directory
 * (fresh install before `ensureDataDir` has run, or an init that
 * aborted early) is treated as "no agents" rather than an error — this
 * matches the forgiving behavior `listAllAgents` exposes in
 * `storage/agent-helpers.ts`.
 */
export async function hasExistingAgents({
  projectDir,
  dataDir = DEFAULT_DATA_DIR,
}: HasExistingAgentsOptions = {}): Promise<boolean> {
  const resolvedProject = resolveProjectDir(projectDir);
  const absoluteDataDir = resolve(resolvedProject, dataDir);
  const aweekRoot = normalizeAweekRoot(absoluteDataDir);
  const agentsDir = join(aweekRoot, 'agents');

  try {
    const entries = await readdir(agentsDir);
    return entries.some((name) => name.endsWith('.json'));
  } catch (err) {
    const e = err as ErrnoLike;
    // Missing directory is fine — that means no agents yet.
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      return false;
    }
    throw err;
  }
}

/** Options for {@link shouldLaunchHire}. */
export interface ShouldLaunchHireOptions extends HasExistingAgentsOptions {
  /** Injectable probe for tests. */
  hasAgentsFn?: HasAgentsFn;
}

/**
 * Decide whether `/aweek:init` should hand off to `/aweek:hire`.
 *
 * Returns `true` when there are no agents yet — i.e., this is a fresh
 * project that just finished infrastructure setup and has nothing to
 * manage until an agent is hired. Returns `false` when the project
 * already has one or more agent configs.
 */
export async function shouldLaunchHire({
  projectDir,
  dataDir = DEFAULT_DATA_DIR,
  hasAgentsFn,
}: ShouldLaunchHireOptions = {}): Promise<boolean> {
  const check: HasAgentsFn = hasAgentsFn || hasExistingAgents;
  const hasAgents = await check({ projectDir, dataDir });
  return !hasAgents;
}

/** Options for {@link buildHireLaunchInstruction}. */
export interface BuildHireLaunchInstructionOptions {
  projectDir?: string;
  promptText?: string;
}

/** Result of {@link buildHireLaunchInstruction}. */
export interface HireLaunchInstruction {
  skill: string;
  projectDir: string;
  promptText: string;
  reason: string;
}

/**
 * Build the machine-readable `/aweek:hire` handoff instruction.
 *
 * Shape matches what the skill markdown emits to the Claude Code
 * harness so it can either (a) render a hint in the final summary or
 * (b) invoke the hire skill directly via SlashCommand.
 */
export function buildHireLaunchInstruction({
  projectDir,
  promptText = DEFAULT_HIRE_PROMPT_TEXT,
}: BuildHireLaunchInstructionOptions = {}): HireLaunchInstruction {
  const resolvedProject = resolveProjectDir(projectDir);
  return {
    skill: HIRE_SKILL_NAME,
    projectDir: resolvedProject,
    promptText,
    reason:
      'Post-init handoff: no agents exist yet — launching /aweek:hire as the final step.',
  };
}

/** Options accepted by {@link formatHireLaunchPrompt}. */
export interface FormatHireLaunchPromptOptions {
  promptText?: string;
}

/**
 * Format the user-facing prompt shown via AskUserQuestion when init
 * offers to launch `/aweek:hire` as its final step.
 */
export function formatHireLaunchPrompt({
  promptText = DEFAULT_HIRE_PROMPT_TEXT,
}: FormatHireLaunchPromptOptions = {}): string {
  return promptText;
}

/** Options for {@link finalizeInit}. */
export interface FinalizeInitOptions {
  projectDir?: string;
  dataDir?: string;
  promptText?: string;
  addAnotherPromptText?: string;
  hasAgentsFn?: HasAgentsFn;
}

/** Result of {@link finalizeInit}. */
export interface FinalizeInitResult {
  launchHire: true;
  nextSkill: string;
  mode: 'first-agent' | 'add-another';
  isReRun: boolean;
  promptText: string;
  reason: string;
  projectDir: string;
  instruction: HireLaunchInstruction;
}

/**
 * Orchestrate the post-infrastructure "offer /aweek:hire?" decision.
 *
 * Called by the `/aweek:init` skill markdown after Step 5 (summary)
 * completes. Returns a result the markdown can use to decide whether
 * to AskUserQuestion → invoke the hire skill.
 */
export async function finalizeInit({
  projectDir,
  dataDir = DEFAULT_DATA_DIR,
  promptText = DEFAULT_HIRE_PROMPT_TEXT,
  addAnotherPromptText = DEFAULT_ADD_AGENT_PROMPT_TEXT,
  hasAgentsFn,
}: FinalizeInitOptions = {}): Promise<FinalizeInitResult> {
  const resolvedProject = resolveProjectDir(projectDir);
  const check: HasAgentsFn = hasAgentsFn || hasExistingAgents;
  const hasAgents = await check({
    projectDir: resolvedProject,
    dataDir,
  });

  const mode: 'first-agent' | 'add-another' = hasAgents ? 'add-another' : 'first-agent';
  const activePromptText = hasAgents ? addAnotherPromptText : promptText;
  const reason = hasAgents
    ? 'Agents already exist — offering /aweek:hire as the final step so the user can add another agent.'
    : 'No agents found — init should hand off to /aweek:hire as the final interactive step.';

  return {
    launchHire: true,
    nextSkill: HIRE_SKILL_NAME,
    mode,
    isReRun: hasAgents,
    promptText: activePromptText,
    reason,
    projectDir: resolvedProject,
    instruction: buildHireLaunchInstruction({
      projectDir: resolvedProject,
      promptText: activePromptText,
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Init-state detection (AC 2 — idempotency)
 * ------------------------------------------------------------------ *
 *
 * `detectInitState` is the "what's already done?" probe the
 * `/aweek:init` skill markdown runs at the top of every invocation.
 * It lets the wizard skip completed steps (idempotency) and present a
 * readable state summary to the user before taking any action.
 */

/** Options accepted by {@link detectInitState}. */
export interface DetectInitStateOptions {
  projectDir?: string;
  dataDir?: string;
  readCrontabFn?: ReadCrontabFn;
  backend?: HeartbeatBackend;
  platform?: NodeJS.Platform;
  home?: string;
  readFileFn?: (path: string) => Promise<string>;
  launchctlFn?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  getUidFn?: () => number;
}

/** Result of {@link detectInitState}. */
export interface DetectInitStateResult {
  projectDir: string;
  dataDir: {
    path: string;
    exists: boolean;
    agentCount: number;
  };
  heartbeat: {
    installed: boolean;
    schedule: string | null;
    command: string | null;
  };
  needsWork: {
    dataDir: boolean;
    heartbeat: boolean;
  };
  fullyInitialized: boolean;
}

/**
 * Probe the current init state of a project.
 *
 * Purely read-only — NEVER mutates the filesystem or crontab.
 */
export async function detectInitState({
  projectDir,
  dataDir = DEFAULT_DATA_DIR,
  readCrontabFn,
  backend,
  platform,
  home,
  readFileFn,
  launchctlFn,
  getUidFn,
}: DetectInitStateOptions = {}): Promise<DetectInitStateResult> {
  const resolvedProject = resolveProjectDir(projectDir);
  const absoluteDataDir = resolve(resolvedProject, dataDir);
  const aweekRoot = normalizeAweekRoot(absoluteDataDir);
  const agentsDir = join(aweekRoot, 'agents');
  const rootExists = await isDirectory(aweekRoot).catch(() => false);

  let agentCount = 0;
  if (rootExists) {
    try {
      const entries = await readdir(agentsDir);
      agentCount = entries.filter((name) => name.endsWith('.json')).length;
    } catch (err) {
      const e = err as ErrnoLike;
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        agentCount = 0;
      } else {
        throw err;
      }
    }
  }

  const heartbeat = (await queryHeartbeat({
    projectDir: resolvedProject,
    readCrontabFn,
    backend,
    platform,
    home,
    readFileFn,
    launchctlFn,
    getUidFn,
  })) as { installed: boolean; schedule: string | null; command: string | null };

  const needsDataDir = !rootExists;
  const needsHeartbeat = !heartbeat.installed;

  return {
    projectDir: resolvedProject,
    dataDir: {
      path: agentsDir,
      exists: rootExists,
      agentCount,
    },
    heartbeat: {
      installed: heartbeat.installed,
      schedule: heartbeat.schedule,
      command: heartbeat.command,
    },
    needsWork: {
      dataDir: needsDataDir,
      heartbeat: needsHeartbeat,
    },
    fullyInitialized: !needsDataDir && !needsHeartbeat,
  };
}

/**
 * Internal export bundle for tests / later sub-ACs that want to compose these
 * primitives without re-implementing helpers. Not part of the public surface.
 *
 * @internal
 */
export const __internals = Object.freeze({
  isDirectory,
  pathExists,
  normalizeAweekRoot,
  defaultSpawn,
});
