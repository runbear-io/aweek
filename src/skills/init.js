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
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  readCrontab as defaultReadCrontab,
  writeCrontab as defaultWriteCrontab,
} from '../heartbeat/crontab-manager.js';

/**
 * Canonical subdirectories that live under `.aweek/`.
 *
 * Every aweek subsystem reads/writes through one of these roots:
 *   - `agents/` — per-agent JSON config files (used by `AgentStore`)
 *   - `logs/`   — activity logs, heartbeat logs, weekly reviews
 *   - `state/`  — transient execution/lock/queue state
 *
 * Frozen to discourage ad-hoc mutation; subdir additions should be an explicit
 * code change with a matching test update.
 */
export const AWEEK_SUBDIRS = Object.freeze(['agents', 'logs', 'state']);

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
 *
 * @param {string} [projectDir]
 * @returns {string}
 */
export function resolveProjectDir(projectDir) {
  return projectDir ? resolve(projectDir) : process.cwd();
}

/**
 * Check whether a path exists and is a directory.
 *
 * Distinguishes "missing" (returns false) from "exists but not a directory"
 * (throws) so callers can surface the latter as an error without silently
 * overwriting a regular file.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function isDirectory(path) {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      const err = new Error(`Path exists but is not a directory: ${path}`);
      err.code = 'ENOTDIR';
      throw err;
    }
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Check whether a path exists (file or directory) without reading it.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function pathExists(path) {
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
 *   - `.aweek/agents`      → step up one level so we manage the siblings too.
 *
 * This keeps the skill markdown's default value valid while letting init
 * still create `logs/` and `state/`.
 *
 * @param {string} absoluteDataDir
 * @returns {string} Absolute path to the `.aweek/` root.
 */
function normalizeAweekRoot(absoluteDataDir) {
  const leaf = basename(absoluteDataDir);
  if (leaf === 'agents' || leaf === 'logs' || leaf === 'state') {
    return dirname(absoluteDataDir);
  }
  return absoluteDataDir;
}

/**
 * Ensure the `.aweek/` directory tree exists.
 *
 * Creates (if missing) the aweek data root and each of its canonical
 * subdirectories: `agents/`, `logs/`, `state/`. Safe to call repeatedly — each
 * resource reports its own `created` / `skipped` outcome.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Project root (defaults to `process.cwd()`).
 * @param {string} [opts.dataDir=DEFAULT_DATA_DIR] - Path (relative to
 *   `projectDir`) for the `.aweek/` root. Accepts `.aweek/agents` for
 *   backwards compatibility with the original skill-markdown default.
 * @returns {Promise<{
 *   root: string,
 *   outcome: 'created' | 'skipped',
 *   subdirs: Record<string, { path: string, outcome: 'created' | 'skipped' }>,
 *   agentsPath: string,
 *   logsPath: string,
 *   statePath: string,
 * }>}
 */
export async function ensureDataDir({
  projectDir,
  dataDir = DEFAULT_DATA_DIR,
} = {}) {
  const resolvedProject = resolveProjectDir(projectDir);
  const absoluteDataDir = resolve(resolvedProject, dataDir);
  const aweekRoot = normalizeAweekRoot(absoluteDataDir);

  // Record root existence BEFORE mkdir so we can report `created` vs `skipped`.
  const rootExisted = await isDirectory(aweekRoot);
  await mkdir(aweekRoot, { recursive: true });

  const subdirs = {};
  for (const sub of AWEEK_SUBDIRS) {
    const subPath = join(aweekRoot, sub);
    const existed = await isDirectory(subPath);
    await mkdir(subPath, { recursive: true });
    subdirs[sub] = {
      path: subPath,
      outcome: existed ? 'skipped' : 'created',
    };
  }

  return {
    root: aweekRoot,
    outcome: rootExisted ? 'skipped' : 'created',
    subdirs,
    agentsPath: subdirs.agents.path,
    logsPath: subdirs.logs.path,
    statePath: subdirs.state.path,
  };
}

/**
 * Default spawner — boring, well-typed wrapper around `child_process.spawn`.
 *
 * Captures stdout/stderr as strings and resolves with the exit code. Kept as
 * a standalone function so tests can inject their own spawner via the
 * `spawnFn` option on {@link installDependencies} without having to stub
 * `child_process` globally.
 *
 * @param {object} params
 * @param {string} params.command
 * @param {string[]} params.args
 * @param {string} params.cwd
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function defaultSpawn({ command, args, cwd }) {
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
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Project root (defaults to `process.cwd()`).
 * @param {string} [opts.packageManager=DEFAULT_PACKAGE_MANAGER] - Binary to
 *   invoke. Defaults to `pnpm` to match `package.json#packageManager`.
 * @param {string[]} [opts.args=['install']] - Arguments passed to the package
 *   manager. Tests can override with `['install', '--offline']` etc.
 * @param {Function} [opts.spawnFn] - Injectable spawner for tests.
 *   Receives `{ command, args, cwd }`, resolves with `{ code, stdout, stderr }`.
 * @returns {Promise<{
 *   outcome: 'created' | 'updated' | 'skipped',
 *   packageManager: string,
 *   cwd: string,
 *   stdout: string,
 *   stderr: string,
 *   reason?: string,
 * }>}
 */
export async function installDependencies({
  projectDir,
  packageManager = DEFAULT_PACKAGE_MANAGER,
  args = ['install'],
  spawnFn,
} = {}) {
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

  const spawner = spawnFn || defaultSpawn;

  let result;
  try {
    result = await spawner({ command: packageManager, args, cwd });
  } catch (err) {
    // `spawn ENOENT` when pnpm isn't on PATH — give a clearer error so the
    // skill markdown can tell the user to install pnpm first.
    if (err && err.code === 'ENOENT') {
      const friendly = new Error(
        `${packageManager} is not installed or not on PATH. Install it with "npm install -g ${packageManager}" or follow https://pnpm.io/installation.`,
      );
      friendly.code = 'EPKGMGR_MISSING';
      friendly.cause = err;
      throw friendly;
    }
    throw err;
  }

  if (result.code !== 0) {
    const err = new Error(
      `${packageManager} ${args.join(' ')} failed with exit code ${result.code}`,
    );
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
 * initialized project — that wakes up hourly and runs `aweek heartbeat
 * --all --project-dir <dir>`. This is distinct from the per-agent
 * markers managed by `src/heartbeat/crontab-manager.js`, which gate
 * individual agent execution after their weekly plan is approved.
 *
 * Marker format: `# aweek:project-heartbeat:<absoluteProjectDir>`
 *
 *   - Scoped by absolute `projectDir` so multiple aweek projects on the
 *     same host can coexist in one user's crontab without collision.
 *   - Distinct prefix (`project-heartbeat` vs. `heartbeat`) so
 *     `parseHeartbeatEntries()` in `crontab-manager.js` — which keys on
 *     the per-agent prefix — cannot accidentally consume project markers.
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
 * Default cron schedule for the project heartbeat: hourly on the hour.
 */
export const DEFAULT_HEARTBEAT_SCHEDULE = '0 * * * *';

/**
 * Comment-marker prefix used to identify the aweek project heartbeat in
 * the user's crontab. Deliberately distinct from the per-agent
 * `aweek:heartbeat:` prefix used by `src/heartbeat/crontab-manager.js`.
 */
export const PROJECT_HEARTBEAT_MARKER_PREFIX = 'aweek:project-heartbeat:';

/**
 * Build the unique comment marker for a project heartbeat.
 *
 * @param {string} projectDir - Absolute path to the project root.
 * @returns {string} Marker string (without the leading `# `).
 */
export function projectHeartbeatMarker(projectDir) {
  if (!projectDir) throw new Error('projectDir is required');
  return `${PROJECT_HEARTBEAT_MARKER_PREFIX}${projectDir}`;
}

/**
 * Build the default shell command for a project heartbeat.
 *
 * Uses the `aweek` binary installed by `pnpm install` (see
 * `package.json#bin.aweek`). Keeping the command here means callers
 * don't have to reconstruct the CLI invocation manually.
 *
 * @param {object} opts
 * @param {string} opts.projectDir - Absolute path to the project root.
 * @returns {string} Shell command that the cron entry should invoke.
 */
export function buildHeartbeatCommand({ projectDir }) {
  if (!projectDir) throw new Error('projectDir is required');
  return `aweek heartbeat --all --project-dir ${projectDir}`;
}

/**
 * Build the full crontab entry (marker + cron line) for a project heartbeat.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {string} [opts.schedule=DEFAULT_HEARTBEAT_SCHEDULE]
 * @param {string} [opts.command] - Defaults to {@link buildHeartbeatCommand}.
 * @returns {string} Two lines: `# <marker>\n<schedule> <command>`
 */
export function buildHeartbeatEntry({
  projectDir,
  schedule = DEFAULT_HEARTBEAT_SCHEDULE,
  command,
} = {}) {
  if (!projectDir) throw new Error('projectDir is required');
  const marker = projectHeartbeatMarker(projectDir);
  const cmd = command || buildHeartbeatCommand({ projectDir });
  return `# ${marker}\n${schedule} ${cmd}`;
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
 *     another comment) is ignored — mirrors the tolerant behavior of
 *     `parseHeartbeatEntries` in `crontab-manager.js`.
 *
 * @param {string} crontabText
 * @param {string} projectDir
 * @returns {{ marker: string, schedule: string, command: string, raw: string } | null}
 */
export function parseProjectHeartbeat(crontabText, projectDir) {
  if (!crontabText || !projectDir) return null;
  const target = projectHeartbeatMarker(projectDir);
  const lines = crontabText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
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
 *
 * @param {string} crontabText
 * @param {string} projectDir
 * @returns {string}
 */
export function removeProjectHeartbeat(crontabText, projectDir) {
  if (!crontabText) return crontabText || '';
  const target = `# ${projectHeartbeatMarker(projectDir)}`;
  const lines = crontabText.split('\n');
  const out = [];
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

/**
 * Query whether a project heartbeat is currently installed.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Defaults to `process.cwd()`.
 * @param {Function} [opts.readCrontabFn] - Injectable reader; defaults
 *   to `readCrontab` from `src/heartbeat/crontab-manager.js`.
 * @returns {Promise<{
 *   installed: boolean,
 *   schedule: string | null,
 *   command: string | null,
 *   marker: string,
 *   projectDir: string,
 *   entry: object | null,
 * }>}
 */
export async function queryHeartbeat({
  projectDir,
  readCrontabFn,
} = {}) {
  const resolvedProject = resolveProjectDir(projectDir);
  const reader = readCrontabFn || defaultReadCrontab;
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

/**
 * Install (or refresh) the project-heartbeat crontab entry.
 *
 * DESTRUCTIVE: this writes to the caller's user crontab. Per the
 * destructive-operation policy in `skills/aweek-init.md`, the caller
 * MUST collect an explicit user confirmation via AskUserQuestion and
 * pass `confirmed: true` to this function. Invocations without
 * `confirmed: true` throw `EHB_NOT_CONFIRMED` without touching crontab.
 *
 * Idempotency contract:
 *
 *   | Current crontab state                             | Outcome  |
 *   |---------------------------------------------------|----------|
 *   | No entry for this projectDir                      | created  |
 *   | Entry exists with same schedule + command         | skipped  |
 *   | Entry exists with different schedule or command   | updated  |
 *
 * @param {object} opts
 * @param {string} [opts.projectDir] - Defaults to `process.cwd()`.
 * @param {string} [opts.schedule=DEFAULT_HEARTBEAT_SCHEDULE]
 * @param {string} [opts.command] - Defaults to {@link buildHeartbeatCommand}.
 * @param {boolean} [opts.confirmed=false] - Must be `true` to perform
 *   the destructive crontab write.
 * @param {Function} [opts.readCrontabFn] - Injectable reader.
 * @param {Function} [opts.writeCrontabFn] - Injectable writer.
 * @returns {Promise<{
 *   outcome: 'created' | 'updated' | 'skipped',
 *   marker: string,
 *   projectDir: string,
 *   schedule: string,
 *   command: string,
 *   entry: string,
 *   previous: { schedule: string, command: string } | null,
 * }>}
 */
export async function installHeartbeat({
  projectDir,
  schedule = DEFAULT_HEARTBEAT_SCHEDULE,
  command,
  confirmed = false,
  readCrontabFn,
  writeCrontabFn,
} = {}) {
  if (confirmed !== true) {
    const err = new Error(
      'installHeartbeat requires explicit user confirmation. ' +
        'Collect consent via AskUserQuestion and pass `confirmed: true`.',
    );
    err.code = 'EHB_NOT_CONFIRMED';
    throw err;
  }

  const resolvedProject = resolveProjectDir(projectDir);
  const resolvedCommand =
    command || buildHeartbeatCommand({ projectDir: resolvedProject });
  const reader = readCrontabFn || defaultReadCrontab;
  const writer = writeCrontabFn || defaultWriteCrontab;

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
 * project (no agents yet). Kept short so the AskUserQuestion dialog
 * stays scannable; longer context lives in the `skills/aweek-init.md`
 * body.
 */
export const DEFAULT_HIRE_PROMPT_TEXT =
  'Infrastructure setup is complete. Would you like to hire your first agent now via /aweek:hire?';

/**
 * Default user-facing copy for the post-init hire prompt on a re-run
 * where at least one agent already exists. Distinct from
 * {@link DEFAULT_HIRE_PROMPT_TEXT} so the skill can offer "add another
 * agent" instead of implying this is the user's first hire.
 *
 * AC 2 idempotency contract: re-running `/aweek:init` against an already
 * initialized project must still surface the hire flow — it's the
 * primary "what next?" affordance, and skipping it silently would make
 * re-runs feel like dead-ends.
 */
export const DEFAULT_ADD_AGENT_PROMPT_TEXT =
  'aweek is already initialized. Would you like to hire another agent now via /aweek:hire?';

/**
 * Check whether the project already has at least one agent config.
 *
 * Inspects `.aweek/agents/` for any `*.json` files. Missing directory
 * (fresh install before `ensureDataDir` has run, or an init that
 * aborted early) is treated as "no agents" rather than an error — this
 * matches the forgiving behavior `listAllAgents` exposes in
 * `storage/agent-helpers.js`.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Project root (defaults to `process.cwd()`).
 * @param {string} [opts.dataDir=DEFAULT_DATA_DIR] - Data dir path
 *   (accepts `.aweek` or `.aweek/agents`; normalized via
 *   {@link normalizeAweekRoot}).
 * @returns {Promise<boolean>}
 */
export async function hasExistingAgents({
  projectDir,
  dataDir = DEFAULT_DATA_DIR,
} = {}) {
  const resolvedProject = resolveProjectDir(projectDir);
  const absoluteDataDir = resolve(resolvedProject, dataDir);
  const aweekRoot = normalizeAweekRoot(absoluteDataDir);
  const agentsDir = join(aweekRoot, 'agents');

  try {
    const entries = await readdir(agentsDir);
    return entries.some((name) => name.endsWith('.json'));
  } catch (err) {
    // Missing directory is fine — that means no agents yet.
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return false;
    }
    throw err;
  }
}

/**
 * Decide whether `/aweek:init` should hand off to `/aweek:hire`.
 *
 * Returns `true` when there are no agents yet — i.e., this is a fresh
 * project that just finished infrastructure setup and has nothing to
 * manage until an agent is hired. Returns `false` when the project
 * already has one or more agent configs.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir]
 * @param {string} [opts.dataDir=DEFAULT_DATA_DIR]
 * @param {Function} [opts.hasAgentsFn] - Injectable probe for tests.
 * @returns {Promise<boolean>}
 */
export async function shouldLaunchHire({
  projectDir,
  dataDir = DEFAULT_DATA_DIR,
  hasAgentsFn,
} = {}) {
  const check = hasAgentsFn || hasExistingAgents;
  const hasAgents = await check({ projectDir, dataDir });
  return !hasAgents;
}

/**
 * Build the machine-readable `/aweek:hire` handoff instruction.
 *
 * Shape matches what the skill markdown emits to the Claude Code
 * harness so it can either (a) render a hint in the final summary or
 * (b) invoke the hire skill directly via SlashCommand.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Project root (defaults to `process.cwd()`).
 * @param {string} [opts.promptText=DEFAULT_HIRE_PROMPT_TEXT]
 * @returns {{
 *   skill: string,
 *   projectDir: string,
 *   promptText: string,
 *   reason: string,
 * }}
 */
export function buildHireLaunchInstruction({
  projectDir,
  promptText = DEFAULT_HIRE_PROMPT_TEXT,
} = {}) {
  const resolvedProject = resolveProjectDir(projectDir);
  return {
    skill: HIRE_SKILL_NAME,
    projectDir: resolvedProject,
    promptText,
    reason:
      'Post-init handoff: no agents exist yet — launching /aweek:hire as the final step.',
  };
}

/**
 * Format the user-facing prompt shown via AskUserQuestion when init
 * offers to launch `/aweek:hire` as its final step.
 *
 * @param {object} [opts]
 * @param {string} [opts.promptText=DEFAULT_HIRE_PROMPT_TEXT]
 * @returns {string}
 */
export function formatHireLaunchPrompt({
  promptText = DEFAULT_HIRE_PROMPT_TEXT,
} = {}) {
  return promptText;
}

/**
 * Orchestrate the post-infrastructure "offer /aweek:hire?" decision.
 *
 * Called by the `/aweek:init` skill markdown after Step 5 (summary)
 * completes. Returns a result the markdown can use to decide whether
 * to AskUserQuestion → invoke the hire skill.
 *
 * AC 2 idempotency contract: `/aweek:init` is safe to re-run. The hire
 * handoff is ALWAYS offered on the final step, but the user-facing
 * prompt text adapts:
 *
 *   | State                  | `mode`          | Prompt copy |
 *   |------------------------|-----------------|-------------|
 *   | No agents yet          | `first-agent`   | "hire your first agent" |
 *   | One or more agents     | `add-another`   | "hire another agent"    |
 *
 * Returning `launchHire: true` in both cases ensures re-runs still give
 * the user a clear next action — skipping silently on re-run (the
 * previous behavior) made idempotent re-runs feel like dead-ends and
 * violated the idempotent-init evaluation principle.
 *
 * The destructive-operation policy in `skills/aweek-init.md` does
 * *not* gate this handoff: `/aweek:hire` only creates new state. The
 * caller still MUST collect explicit consent via AskUserQuestion
 * before invoking the skill — that's a UX requirement, not a safety
 * gate, and it's enforced in the markdown rather than here.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir]
 * @param {string} [opts.dataDir=DEFAULT_DATA_DIR]
 * @param {string} [opts.promptText] - Override for the "first agent"
 *   prompt copy. Defaults to {@link DEFAULT_HIRE_PROMPT_TEXT}.
 * @param {string} [opts.addAnotherPromptText] - Override for the "add
 *   another agent" prompt copy shown when agents already exist.
 *   Defaults to {@link DEFAULT_ADD_AGENT_PROMPT_TEXT}.
 * @param {Function} [opts.hasAgentsFn] - Injectable probe for tests.
 * @returns {Promise<{
 *   launchHire: true,
 *   nextSkill: string,
 *   mode: 'first-agent' | 'add-another',
 *   isReRun: boolean,
 *   promptText: string,
 *   reason: string,
 *   projectDir: string,
 *   instruction: ReturnType<typeof buildHireLaunchInstruction>,
 * }>}
 */
export async function finalizeInit({
  projectDir,
  dataDir = DEFAULT_DATA_DIR,
  promptText = DEFAULT_HIRE_PROMPT_TEXT,
  addAnotherPromptText = DEFAULT_ADD_AGENT_PROMPT_TEXT,
  hasAgentsFn,
} = {}) {
  const resolvedProject = resolveProjectDir(projectDir);
  const check = hasAgentsFn || hasExistingAgents;
  const hasAgents = await check({
    projectDir: resolvedProject,
    dataDir,
  });

  const mode = hasAgents ? 'add-another' : 'first-agent';
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
 *
 * The report covers the two mutable init artifacts the plugin does not
 * handle itself:
 *
 *   1. `dataDir` — `.aweek/` existence + agent count. Feeds the
 *      "ensure data directory exists" step: if `exists === true`, the
 *      markdown reports it as skipped without re-creating.
 *
 *   2. `heartbeat` — delegates to {@link queryHeartbeat} so the
 *      markdown can avoid re-prompting for crontab install when the
 *      project heartbeat is already in place.
 *
 * Slash-command discovery is handled by the Claude Code plugin system
 * (see `.claude-plugin/plugin.json`); init no longer copies markdown
 * into `.claude/commands/`.
 */

/**
 * Probe the current init state of a project.
 *
 * Purely read-only — NEVER mutates the filesystem or crontab.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Defaults to `process.cwd()`.
 * @param {string} [opts.dataDir=DEFAULT_DATA_DIR] - `.aweek/` root
 *   (accepts `.aweek` or `.aweek/agents`; normalized internally).
 * @param {Function} [opts.readCrontabFn] - Injectable crontab reader;
 *   forwarded to {@link queryHeartbeat}.
 * @returns {Promise<{
 *   projectDir: string,
 *   dataDir: {
 *     path: string,
 *     exists: boolean,
 *     agentCount: number,
 *   },
 *   heartbeat: {
 *     installed: boolean,
 *     schedule: string | null,
 *     command: string | null,
 *   },
 *   needsWork: {
 *     dataDir: boolean,
 *     heartbeat: boolean,
 *   },
 *   fullyInitialized: boolean,
 * }>}
 */
export async function detectInitState({
  projectDir,
  dataDir = DEFAULT_DATA_DIR,
  readCrontabFn,
} = {}) {
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
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        agentCount = 0;
      } else {
        throw err;
      }
    }
  }

  const heartbeat = await queryHeartbeat({
    projectDir: resolvedProject,
    readCrontabFn,
  });

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
