/**
 * aweek-wide configuration stored at `.aweek/config.json`.
 *
 * Intentionally tiny — one file, one document. Today it only carries the
 * user's configured IANA time zone, but it's the right place to grow if
 * we ever add other "user-wide, agent-independent" knobs. Config is
 * optional: when the file is absent or partial, we fall back to sensible
 * defaults so existing projects keep working.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_TZ, isValidTimeZone } from '../time/zone.js';

const CONFIG_FILENAME = 'config.json';

/**
 * Shape of the persisted aweek-wide config document.
 *
 * Currently a single field — the IANA time zone — but extra knobs can be
 * appended here without breaking older callers. New optional fields should
 * be folded into both `AweekConfig` and the defaults map in `loadConfig`.
 */
export interface AweekConfig {
  timeZone: string;
}

/**
 * Partial / user-facing input to `saveConfig`. All fields are optional so
 * callers can patch a single knob without re-stating the rest of the
 * document; missing fields are filled in from the on-disk current value.
 */
export type AweekConfigInput = Partial<AweekConfig>;

/**
 * Resolve the path to the config file given a data dir (usually
 * `.aweek/agents` — the config lives one level up at `.aweek/config.json`).
 */
export function configPath(dataDir: string): string {
  // The rest of the codebase passes dataDir as `.aweek/agents`. The config
  // itself belongs in `.aweek/`, so walk up one level.
  return join(dirname(dataDir), CONFIG_FILENAME);
}

/**
 * Status tag returned by {@link loadConfigWithStatus} to distinguish the
 * two silent-fallback cases callers (like the Settings page) need to tell apart.
 *
 *   'ok'      — file absent (ENOENT) OR file is valid. Either way defaults
 *               are in effect or the real values were loaded cleanly.
 *   'missing' — file exists but is malformed JSON or contains an invalid
 *               timeZone. The Settings page surfaces an inline warning for
 *               this case only.
 */
export type ConfigFileStatus = 'ok' | 'missing';

/** Result shape returned by {@link loadConfigWithStatus}. */
export interface LoadConfigResult {
  config: AweekConfig;
  /** See {@link ConfigFileStatus}. */
  status: ConfigFileStatus;
}

/**
 * Like {@link loadConfig} but returns an explicit status tag so callers can
 * tell apart "file absent → silently use defaults" (status 'ok') from
 * "file malformed → using defaults but user should know" (status 'missing').
 */
export async function loadConfigWithStatus(dataDir: string): Promise<LoadConfigResult> {
  const defaults: AweekConfig = { timeZone: DEFAULT_TZ };
  let raw: string;
  try {
    raw = await readFile(configPath(dataDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // File absent — silently fall back; this is the normal "fresh project"
      // state. Do NOT treat ENOENT as a warning.
      return { config: defaults, status: 'ok' };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      `aweek: ignoring malformed ${CONFIG_FILENAME} and using defaults\n`,
    );
    return { config: defaults, status: 'missing' };
  }
  const out: AweekConfig = { ...defaults };
  if (parsed && typeof parsed === 'object') {
    const candidate = (parsed as { timeZone?: unknown }).timeZone;
    if (typeof candidate === 'string') {
      if (isValidTimeZone(candidate)) {
        out.timeZone = candidate;
      } else {
        process.stderr.write(
          `aweek: ${CONFIG_FILENAME} has invalid timeZone ${JSON.stringify(candidate)}; falling back to ${DEFAULT_TZ}\n`,
        );
        return { config: out, status: 'missing' };
      }
    }
  }
  return { config: out, status: 'ok' };
}

/**
 * Load the config object. Missing file → defaults. Invalid `timeZone` in
 * the file → defaults (plus a warning on stderr) so a typo can't brick
 * scheduling.
 */
export async function loadConfig(dataDir: string): Promise<AweekConfig> {
  const defaults: AweekConfig = { timeZone: DEFAULT_TZ };
  let raw: string;
  try {
    raw = await readFile(configPath(dataDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return defaults;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      `aweek: ignoring malformed ${CONFIG_FILENAME} and using defaults\n`,
    );
    return defaults;
  }
  const out: AweekConfig = { ...defaults };
  if (parsed && typeof parsed === 'object') {
    const candidate = (parsed as { timeZone?: unknown }).timeZone;
    if (typeof candidate === 'string') {
      if (isValidTimeZone(candidate)) {
        out.timeZone = candidate;
      } else {
        process.stderr.write(
          `aweek: ${CONFIG_FILENAME} has invalid timeZone ${JSON.stringify(candidate)}; falling back to ${DEFAULT_TZ}\n`,
        );
      }
    }
  }
  return out;
}

/**
 * Write the config object. Creates parent dirs if needed, validates
 * `timeZone` before writing.
 */
export async function saveConfig(
  dataDir: string,
  config: AweekConfigInput,
): Promise<void> {
  if (!config || typeof config !== 'object') {
    throw new TypeError('saveConfig expects a config object');
  }
  if (config.timeZone != null && !isValidTimeZone(config.timeZone)) {
    throw new TypeError(
      `Invalid timeZone in config: ${JSON.stringify(config.timeZone)}`,
    );
  }
  const path = configPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  // Round-trip through loadConfig's defaults to keep shape stable.
  const current = await loadConfig(dataDir);
  const merged: AweekConfig = { ...current, ...config };
  await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}
