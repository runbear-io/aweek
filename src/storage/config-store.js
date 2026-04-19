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
 * Resolve the path to the config file given a data dir (usually
 * `.aweek/agents` — the config lives one level up at `.aweek/config.json`).
 * @param {string} dataDir
 * @returns {string}
 */
export function configPath(dataDir) {
  // The rest of the codebase passes dataDir as `.aweek/agents`. The config
  // itself belongs in `.aweek/`, so walk up one level.
  return join(dirname(dataDir), CONFIG_FILENAME);
}

/**
 * Load the config object. Missing file → defaults. Invalid `timeZone` in
 * the file → defaults (plus a warning on stderr) so a typo can't brick
 * scheduling.
 *
 * @param {string} dataDir
 * @returns {Promise<{timeZone: string}>}
 */
export async function loadConfig(dataDir) {
  const defaults = { timeZone: DEFAULT_TZ };
  let raw;
  try {
    raw = await readFile(configPath(dataDir), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return defaults;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      `aweek: ignoring malformed ${CONFIG_FILENAME} and using defaults\n`,
    );
    return defaults;
  }
  const out = { ...defaults };
  if (typeof parsed.timeZone === 'string') {
    if (isValidTimeZone(parsed.timeZone)) {
      out.timeZone = parsed.timeZone;
    } else {
      process.stderr.write(
        `aweek: ${CONFIG_FILENAME} has invalid timeZone ${JSON.stringify(parsed.timeZone)}; falling back to ${DEFAULT_TZ}\n`,
      );
    }
  }
  return out;
}

/**
 * Write the config object. Creates parent dirs if needed, validates
 * `timeZone` before writing.
 *
 * @param {string} dataDir
 * @param {{timeZone?: string}} config
 * @returns {Promise<void>}
 */
export async function saveConfig(dataDir, config) {
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
  const merged = { ...current, ...config };
  await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}
