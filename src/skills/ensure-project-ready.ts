/**
 * Skill prelude that replaces the "first run /aweek:setup" step.
 *
 * Every aweek skill calls this at the top of its entry function. The
 * helper composes the existing init primitives — {@link ensureDataDir},
 * {@link detectInitState}, {@link installHeartbeat} — into one
 * idempotent call:
 *
 *   1. Bootstrap `.aweek/` and seed `config.json` (non-destructive).
 *   2. Probe the heartbeat install state and reconcile it with
 *      {@link AweekConfig.heartbeat} so a manually-deleted plist
 *      forces a re-prompt.
 *   3. Either honor a sticky `decision`, install given the user's
 *      `heartbeatAnswer`, or surface a centralized prompt for the
 *      caller to put through `AskUserQuestion`.
 *
 * Read-only skills (summary, query) pass `skipHeartbeat: true` to
 * keep the bootstrap but skip the prompt path.
 */
import { join } from 'node:path';

import {
  loadConfig,
  saveConfig,
  type HeartbeatDecision,
  type AweekConfig,
} from '../storage/config-store.js';
import {
  ensureDataDir,
  detectInitState,
  installHeartbeat,
  resolveProjectDir,
  DEFAULT_DATA_DIR,
  type EnsureDataDirResult,
  type DetectInitStateResult,
  type InstallHeartbeatOptions,
  type DetectInitStateOptions,
  type EnsureDataDirOptions,
} from './setup.js';

/** What the user told us to do about the heartbeat this turn. */
export type HeartbeatAnswer = 'install' | 'skip' | 'skip-remember';

/** Outcome of the heartbeat reconciliation step. */
export type HeartbeatStep =
  | 'installed' // installed during this call (heartbeatAnswer === 'install')
  | 'existed' // already installed per detectInitState
  | 'declined' // sticky AweekConfig.heartbeat.decision === 'declined'
  | 'skipped' // user said 'skip' once, or caller passed skipHeartbeat
  | 'awaiting-confirm'; // need an AskUserQuestion answer; caller re-invokes

/**
 * Centralized prompt copy used by every skill that needs to ask the user
 * about the heartbeat install. Lives here so wording stays consistent
 * across hire/plan/manage/calendar/delegate-task.
 */
export const HEARTBEAT_PROMPT = Object.freeze({
  title: 'Install the aweek heartbeat?',
  description:
    'aweek runs scheduled tasks via a recurring heartbeat. ' +
    'On macOS this writes ~/Library/LaunchAgents/io.aweek.heartbeat.<hash>.plist; ' +
    'on other platforms it appends a single crontab line. ' +
    "Without it, agents won't auto-execute their weekly plans.",
  options: Object.freeze(['install', 'skip', 'skip-remember'] as const),
});

export interface HeartbeatPromptCopy {
  title: string;
  description: string;
  options: readonly ['install', 'skip', 'skip-remember'];
}

export interface EnsureProjectReadyOptions {
  projectDir?: string;
  /** Path (relative to projectDir) to `.aweek/agents`. Defaults to `.aweek/agents`. */
  dataDir?: string;
  /**
   * Pass when re-invoking after the caller showed {@link HEARTBEAT_PROMPT}
   * to the user via AskUserQuestion. Without it, an absent heartbeat plus
   * no sticky decision returns `steps.heartbeat: 'awaiting-confirm'`.
   */
  heartbeatAnswer?: HeartbeatAnswer;
  /**
   * True for read-only skills (summary, query) that bootstrap the data
   * dir but should never prompt about the heartbeat — even on a fresh
   * project. Returns `steps.heartbeat: 'skipped'`.
   */
  skipHeartbeat?: boolean;
  /** Used to stamp `AweekConfig.heartbeat.promptedAt`. Defaults to `() => new Date()`. */
  nowFn?: () => Date;
  /** Used by {@link detectInitState} for crontab inspection. */
  readCrontabFn?: DetectInitStateOptions['readCrontabFn'];
  /** Used by {@link installHeartbeat} when writing the crontab line. */
  writeCrontabFn?: InstallHeartbeatOptions['writeCrontabFn'];
  /** Override the platform — useful so non-macOS hosts can drive the launchd path in tests. */
  platform?: NodeJS.Platform;
  /** Override `$HOME` for launchd plist resolution. */
  home?: string;
  /** Backend override for {@link installHeartbeat} / {@link detectInitState}. */
  backend?: InstallHeartbeatOptions['backend'];
  /** Test seam — replace the install dispatcher entirely. */
  installHeartbeatFn?: typeof installHeartbeat;
  /** Test seam — replace the read-only state probe entirely. */
  detectInitStateFn?: typeof detectInitState;
  /** Test seam — replace the data-dir bootstrap. */
  ensureDataDirFn?: typeof ensureDataDir;
  /** launchctl invocation hook used by both detect and install on darwin. */
  launchctlFn?: InstallHeartbeatOptions['launchctlFn'];
  /** Override `getuid()` for launchd plist resolution. */
  getUidFn?: InstallHeartbeatOptions['getUidFn'];
}

export interface EnsureProjectReadyResult {
  /** Resolved abs path to `.aweek/agents`. */
  dataDir: string;
  /** Resolved abs path to `.aweek/`. */
  aweekRoot: string;
  steps: {
    dataDir: 'created' | 'existed';
    config: 'created' | 'existed';
    heartbeat: HeartbeatStep;
  };
  /**
   * The currently-loaded config after the helper reconciled it with the
   * filesystem state. Includes the freshly-written `heartbeat` decision
   * record when applicable.
   */
  config: AweekConfig;
  /** Populated iff `steps.heartbeat === 'awaiting-confirm'`. */
  heartbeatPrompt?: HeartbeatPromptCopy;
}

function decisionMatches(
  config: AweekConfig,
  decision: HeartbeatDecision,
): boolean {
  return config.heartbeat?.decision === decision;
}

async function persistDecision(
  dataDir: string,
  decision: HeartbeatDecision,
  nowFn: () => Date,
): Promise<AweekConfig> {
  const promptedAt = nowFn().toISOString();
  await saveConfig(dataDir, { heartbeat: { promptedAt, decision } });
  return loadConfig(dataDir);
}

/**
 * Idempotent project-readiness preamble. See module docstring.
 */
export async function ensureProjectReady(
  opts: EnsureProjectReadyOptions = {},
): Promise<EnsureProjectReadyResult> {
  const projectDir = resolveProjectDir(opts.projectDir);
  const dataDirOpt: EnsureDataDirOptions = {
    projectDir,
    dataDir: opts.dataDir ?? DEFAULT_DATA_DIR,
  };
  const ensureFn = opts.ensureDataDirFn ?? ensureDataDir;
  const dataDirResult: EnsureDataDirResult = await ensureFn(dataDirOpt);
  const aweekRoot = dataDirResult.root;
  const agentsPath = dataDirResult.agentsPath;

  let config = await loadConfig(agentsPath);
  const nowFn = opts.nowFn ?? (() => new Date());

  // Read-only skills: bootstrap the data dir, then bail out without
  // touching the heartbeat. The caller proceeds as if the heartbeat
  // doesn't matter for this operation.
  if (opts.skipHeartbeat) {
    return {
      dataDir: agentsPath,
      aweekRoot,
      steps: {
        dataDir: dataDirResult.outcome === 'created' ? 'created' : 'existed',
        config: dataDirResult.config.outcome === 'created' ? 'created' : 'existed',
        heartbeat: 'skipped',
      },
      config,
    };
  }

  const detectFn = opts.detectInitStateFn ?? detectInitState;
  const detect: DetectInitStateResult = await detectFn({
    projectDir,
    dataDir: opts.dataDir ?? DEFAULT_DATA_DIR,
    readCrontabFn: opts.readCrontabFn,
    backend: opts.backend,
    platform: opts.platform,
    home: opts.home,
    launchctlFn: opts.launchctlFn,
    getUidFn: opts.getUidFn,
  });

  const baseSteps = {
    dataDir: (dataDirResult.outcome === 'created' ? 'created' : 'existed') as
      | 'created'
      | 'existed',
    config: (dataDirResult.config.outcome === 'created' ? 'created' : 'existed') as
      | 'created'
      | 'existed',
  };

  // Filesystem state wins over cached decision. If the plist exists,
  // heartbeat is running regardless of what the config says.
  if (detect.heartbeat.installed) {
    if (!decisionMatches(config, 'installed')) {
      config = await persistDecision(agentsPath, 'installed', nowFn);
    }
    return {
      dataDir: agentsPath,
      aweekRoot,
      steps: { ...baseSteps, heartbeat: 'existed' },
      config,
    };
  }

  // Heartbeat is not installed. Honor a sticky decline so the user
  // doesn't get re-prompted on every skill call.
  if (decisionMatches(config, 'declined')) {
    return {
      dataDir: agentsPath,
      aweekRoot,
      steps: { ...baseSteps, heartbeat: 'declined' },
      config,
    };
  }

  // Heartbeat absent + no sticky decline. If the caller already collected
  // the user's answer this turn, act on it.
  if (opts.heartbeatAnswer === 'install') {
    const installFn = opts.installHeartbeatFn ?? installHeartbeat;
    await installFn({
      projectDir,
      confirmed: true,
      backend: opts.backend,
      platform: opts.platform,
      home: opts.home,
      readCrontabFn: opts.readCrontabFn,
      writeCrontabFn: opts.writeCrontabFn,
      launchctlFn: opts.launchctlFn,
      getUidFn: opts.getUidFn,
    });
    config = await persistDecision(agentsPath, 'installed', nowFn);
    return {
      dataDir: agentsPath,
      aweekRoot,
      steps: { ...baseSteps, heartbeat: 'installed' },
      config,
    };
  }
  if (opts.heartbeatAnswer === 'skip') {
    config = await persistDecision(agentsPath, 'skipped', nowFn);
    return {
      dataDir: agentsPath,
      aweekRoot,
      steps: { ...baseSteps, heartbeat: 'skipped' },
      config,
    };
  }
  if (opts.heartbeatAnswer === 'skip-remember') {
    config = await persistDecision(agentsPath, 'declined', nowFn);
    return {
      dataDir: agentsPath,
      aweekRoot,
      steps: { ...baseSteps, heartbeat: 'declined' },
      config,
    };
  }

  // No answer — surface the prompt for the caller to render.
  return {
    dataDir: agentsPath,
    aweekRoot,
    steps: { ...baseSteps, heartbeat: 'awaiting-confirm' },
    config,
    heartbeatPrompt: {
      title: HEARTBEAT_PROMPT.title,
      description: HEARTBEAT_PROMPT.description,
      options: HEARTBEAT_PROMPT.options,
    },
  };
}
