/**
 * Teardown skill — uninstall the heartbeat and/or remove the `.aweek/` data
 * directory for `/aweek:teardown`.
 *
 * Two operations, both gated on `confirmed: true`:
 *
 *   1. `removeHeartbeat` — wraps {@link uninstallHeartbeat} from
 *      `./setup.ts` with the same injectable seams so tests don't touch
 *      real launchd/crontab.
 *
 *   2. `removeProject` — `rm -rf .aweek/`. Refuses without
 *      `confirmed: true`. Returns what was removed.
 *
 * Never call either without collecting an `AskUserQuestion` confirmation
 * first — both are destructive and irreversible.
 */
import { rm, access } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  uninstallHeartbeat,
  resolveProjectDir,
  DEFAULT_DATA_DIR,
  type UninstallHeartbeatOptions,
  type ReadCrontabFn,
  type WriteCrontabFn,
  type HeartbeatBackend,
} from './setup.js';

/** Error code thrown when a destructive operation is called without `confirmed: true`. */
export const ETEARDOWN_NOT_CONFIRMED = 'ETEARDOWN_NOT_CONFIRMED';

// ---------------------------------------------------------------------------
// removeHeartbeat
// ---------------------------------------------------------------------------

export interface RemoveHeartbeatOptions {
  confirmed?: boolean;
  projectDir?: string;
  backend?: HeartbeatBackend;
  platform?: NodeJS.Platform;
  home?: string;
  /** Test seam — replace the uninstall dispatcher entirely. */
  uninstallHeartbeatFn?: typeof uninstallHeartbeat;
  unlinkFn?: UninstallHeartbeatOptions['unlinkFn'];
  statFn?: UninstallHeartbeatOptions['statFn'];
  launchctlFn?: UninstallHeartbeatOptions['launchctlFn'];
  getUidFn?: UninstallHeartbeatOptions['getUidFn'];
  readCrontabFn?: ReadCrontabFn;
  writeCrontabFn?: WriteCrontabFn;
}

export interface RemoveHeartbeatResult {
  ok: boolean;
  backend: string;
  outcome: string;
  projectDir: string;
}

/**
 * Remove the project heartbeat (launchd plist on macOS, crontab line
 * elsewhere). Requires `confirmed: true`; throws `ETEARDOWN_NOT_CONFIRMED`
 * without it.
 */
export async function removeHeartbeat(
  opts: RemoveHeartbeatOptions = {},
): Promise<RemoveHeartbeatResult> {
  if (opts.confirmed !== true) {
    const err = new Error(
      'removeHeartbeat requires explicit user confirmation. ' +
        'Collect consent via AskUserQuestion and pass `confirmed: true`.',
    ) as NodeJS.ErrnoException;
    err.code = ETEARDOWN_NOT_CONFIRMED;
    throw err;
  }

  const projectDir = resolveProjectDir(opts.projectDir);
  const uninstallFn = opts.uninstallHeartbeatFn ?? uninstallHeartbeat;
  const result = await uninstallFn({
    projectDir,
    confirmed: true,
    backend: opts.backend,
    platform: opts.platform,
    home: opts.home,
    unlinkFn: opts.unlinkFn,
    statFn: opts.statFn,
    launchctlFn: opts.launchctlFn,
    getUidFn: opts.getUidFn,
    readCrontabFn: opts.readCrontabFn,
    writeCrontabFn: opts.writeCrontabFn,
  });

  return {
    ok: true,
    backend: String((result as any).backend ?? 'unknown'),
    outcome: String((result as any).outcome ?? 'removed'),
    projectDir,
  };
}

// ---------------------------------------------------------------------------
// removeProject
// ---------------------------------------------------------------------------

export interface RemoveProjectOptions {
  confirmed?: boolean;
  projectDir?: string;
  /** Path (relative to projectDir) of the aweek root. Defaults to `.aweek`. */
  dataDir?: string;
  /** Test seam — replace the real `rm -rf` call. */
  rmFn?: (path: string, opts: { recursive: boolean; force: boolean }) => Promise<void>;
  /** Test seam — replace the real `access` probe. */
  accessFn?: (path: string) => Promise<void>;
}

export interface RemoveProjectResult {
  ok: boolean;
  removed: string;
  existed: boolean;
}

/**
 * Remove the `.aweek/` data directory. Requires `confirmed: true`; throws
 * `ETEARDOWN_NOT_CONFIRMED` without it.
 */
export async function removeProject(
  opts: RemoveProjectOptions = {},
): Promise<RemoveProjectResult> {
  if (opts.confirmed !== true) {
    const err = new Error(
      'removeProject requires explicit user confirmation. ' +
        'Collect consent via AskUserQuestion and pass `confirmed: true`.',
    ) as NodeJS.ErrnoException;
    err.code = ETEARDOWN_NOT_CONFIRMED;
    throw err;
  }

  const projectDir = resolveProjectDir(opts.projectDir);
  const aweekRoot = resolve(projectDir, opts.dataDir ?? DEFAULT_DATA_DIR);

  const accessFn = opts.accessFn ?? ((p: string) => access(p));
  const rmFn =
    opts.rmFn ??
    ((p: string, o: { recursive: boolean; force: boolean }) => rm(p, o));

  let existed = false;
  try {
    await accessFn(aweekRoot);
    existed = true;
  } catch {
    existed = false;
  }

  if (existed) {
    await rmFn(aweekRoot, { recursive: true, force: true });
  }

  return { ok: true, removed: aweekRoot, existed };
}

// ---------------------------------------------------------------------------
// teardown (both-together composition)
// ---------------------------------------------------------------------------

export interface TeardownOptions extends RemoveHeartbeatOptions, RemoveProjectOptions {
  removeHeartbeatFn?: typeof removeHeartbeat;
  removeProjectFn?: typeof removeProject;
}

export interface TeardownResult {
  ok: boolean;
  heartbeat: RemoveHeartbeatResult | null;
  project: RemoveProjectResult | null;
}

/**
 * Convenience wrapper: remove heartbeat AND project data in one call.
 * Both sub-operations require `confirmed: true`.
 */
export async function teardown(opts: TeardownOptions = {}): Promise<TeardownResult> {
  const heartbeatFn = opts.removeHeartbeatFn ?? removeHeartbeat;
  const projectFn = opts.removeProjectFn ?? removeProject;

  const heartbeat = await heartbeatFn(opts);
  const project = await projectFn(opts);

  return { ok: true, heartbeat, project };
}
