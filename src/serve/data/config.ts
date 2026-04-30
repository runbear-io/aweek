/**
 * App-config data source for the SPA Settings page.
 *
 * Read-only JSON gatherer that surfaces:
 *   1. All config.json fields (currently: timeZone) with live values.
 *   2. A curated set of hardcoded runtime constants from the scheduler,
 *      lock, and heartbeat subsystems — grouped by category.
 *
 * Constants are hardcoded here (not imported from the source files) so
 * the data layer stays within its allowed import set (src/storage/* only).
 * The values are sourced from:
 *   - DEFAULT_LOCK_DIR       → src/lock/lock-manager.ts
 *   - DEFAULT_MAX_LOCK_AGE_MS → src/lock/lock-manager.ts
 *   - Heartbeat interval      → launchd StartInterval / cron schedule
 *
 * `staleTaskWindowMs` is config-backed (read live from .aweek/config.json
 * via loadConfigWithStatus) so users can adjust it via /aweek:config
 * without recompiling.
 *
 * Status semantics (per the Settings page spec):
 *   'ok'      — config.json absent (ENOENT) OR valid. Defaults render silently.
 *   'missing' — config.json exists but is malformed JSON or has an invalid
 *               timeZone. The Settings page surfaces an inline warning.
 *
 * No new persistence, no writes. Satisfies the AC 9 read-only invariant.
 *
 * Endpoint mapping:
 *   GET /api/config → gatherAppConfig
 */

import { join } from 'node:path';
import { loadConfigWithStatus } from '../../storage/config-store.js';

// ---------------------------------------------------------------------------
// Curated hardcoded constants
// ---------------------------------------------------------------------------

// staleTaskWindowMs is now config-backed (see config.staleTaskWindowMs in
// loadConfigWithStatus). The Settings page reads it from config; the
// fallback default is `DEFAULT_STALE_TASK_WINDOW_MS` exported from
// src/storage/config-store.ts.

/**
 * How often the launchd user agent (or cron fallback) fires the heartbeat.
 * Source: StartInterval in the launchd plist written by src/skills/launchd.ts;
 * cron line `*\/10 * * * *` written by src/skills/init.ts.
 */
const HEARTBEAT_INTERVAL_SEC = 600; // 10 minutes

/**
 * Directory where per-agent and heartbeat-level PID lock files are written.
 * Source: DEFAULT_LOCK_DIR in src/lock/lock-manager.ts
 */
const DEFAULT_LOCK_DIR = '.aweek/.locks';

/**
 * Locks older than this value are considered stale and auto-replaced on
 * the next acquire attempt.
 * Source: DEFAULT_MAX_LOCK_AGE_MS in src/lock/lock-manager.ts
 */
const DEFAULT_MAX_LOCK_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of the config.json file. */
export type ConfigFileStatus = 'ok' | 'missing';

/** A single display row inside a category. */
export interface ConfigItem {
  /** Machine-readable identifier for this setting. */
  key: string;
  /** Human-readable label displayed in the Settings page UI. */
  label: string;
  /** Current value (string, number, or boolean). */
  value: string | number | boolean;
  /** One-sentence explanation shown as secondary text. */
  description: string;
}

/** A named group of related settings shown as a card on the Settings page. */
export interface ConfigCategory {
  /** Stable identifier for the category. */
  id: string;
  /** Human-readable heading for the settings card. */
  label: string;
  /** Ordered list of settings rows rendered inside the card. */
  items: ConfigItem[];
}

/** Full payload returned by GET /api/config. */
export interface AppConfigPayload {
  /**
   * 'ok'      — config.json absent or valid (defaults render silently).
   * 'missing' — config.json malformed or has an invalid timeZone field
   *             (Settings page shows an inline warning banner).
   */
  status: ConfigFileStatus;
  /** Ordered list of settings categories rendered as cards on the Settings page. */
  categories: ConfigCategory[];
}

/** Options accepted by {@link gatherAppConfig}. */
export interface GatherAppConfigOptions {
  projectDir?: string;
}

// ---------------------------------------------------------------------------
// Gatherer
// ---------------------------------------------------------------------------

/**
 * Gather the full config payload for the SPA Settings page.
 *
 * Reads `.aweek/config.json` via {@link loadConfigWithStatus} to:
 *   - obtain the live timeZone value (or the UTC default when the file is
 *     absent), and
 *   - determine whether the config file is malformed so the UI can surface
 *     a warning for that case while keeping ENOENT silent.
 *
 * The hardcoded constants (scheduler, locks) are always returned regardless
 * of the config file's status — they are compiled into the binary and
 * cannot be overridden by the user.
 *
 * Returns the full {@link AppConfigPayload}. Never returns null — the
 * Settings page always has something to render (even when the config file
 * is absent, the constants still show).
 */
export async function gatherAppConfig(
  { projectDir }: GatherAppConfigOptions = {},
): Promise<AppConfigPayload> {
  if (!projectDir) throw new Error('gatherAppConfig: projectDir is required');
  const dataDir = join(projectDir, '.aweek', 'agents');

  const { config, status } = await loadConfigWithStatus(dataDir);

  const categories: ConfigCategory[] = [
    {
      id: 'configuration',
      label: 'Configuration',
      items: [
        {
          key: 'timeZone',
          label: 'Time Zone',
          value: config.timeZone,
          description:
            'IANA time zone used for scheduling, week-key derivation, and calendar display. Set in .aweek/config.json.',
        },
      ],
    },
    {
      id: 'scheduler',
      label: 'Scheduler',
      items: [
        {
          key: 'heartbeatIntervalSec',
          label: 'Heartbeat Interval',
          value: HEARTBEAT_INTERVAL_SEC,
          description:
            'How often the launchd user agent (or cron fallback) fires the heartbeat, in seconds.',
        },
        {
          key: 'staleTaskWindowMs',
          label: 'Stale Task Window',
          value: config.staleTaskWindowMs,
          description:
            'Tasks whose runAt is older than this window (ms) are marked skipped on the next heartbeat tick instead of being dispatched late. Set in .aweek/config.json.',
        },
      ],
    },
    {
      id: 'locks',
      label: 'Locks',
      items: [
        {
          key: 'lockDir',
          label: 'Lock Directory',
          value: DEFAULT_LOCK_DIR,
          description:
            'Directory where per-agent and heartbeat-level PID lock files are written, relative to the project root.',
        },
        {
          key: 'maxLockAgeMs',
          label: 'Max Lock Age',
          value: DEFAULT_MAX_LOCK_AGE_MS,
          description:
            'Locks older than this value (ms) are considered stale and are automatically replaced on the next acquire attempt.',
        },
      ],
    },
  ];

  return { status, categories };
}
