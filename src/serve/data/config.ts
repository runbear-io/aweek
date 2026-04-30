/**
 * App-config data source for the SPA Settings page.
 *
 * Read-only JSON gatherer that surfaces every config.json field with its
 * live value. As of the heartbeat-interval promotion, all knobs the
 * Settings page renders are config-backed (timeZone, staleTaskWindowMs,
 * heartbeatIntervalSec). The previous read-only "Locks" card was dropped:
 * lock layout is an implementation detail, not a user knob.
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
          value: config.heartbeatIntervalSec,
          description:
            'How often the launchd user agent (or cron fallback) fires the heartbeat, in seconds. Set in .aweek/config.json. Re-run /aweek:init to rotate the live launchd plist / crontab line after editing.',
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
  ];

  return { status, categories };
}
