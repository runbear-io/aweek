/**
 * /aweek:config skill — display and update the project's `.aweek/config.json`.
 *
 * Mirrors the read-only Settings page (`src/serve/data/config.ts`) at the CLI
 * level: `showConfig` returns every knob the Settings page surfaces (the
 * config-backed fields plus the curated hardcoded constants) so the user
 * sees the same picture in both places. `editConfig` writes only the
 * config-backed fields (today: just `timeZone`) — hardcoded constants ship
 * with the binary and are display-only.
 *
 * All persistence routes through `src/storage/config-store.ts`; this module
 * never touches `.aweek/config.json` directly. Per project policy,
 * `editConfig` refuses to write unless the caller passes `confirmed: true`,
 * which the SKILL markdown collects via `AskUserQuestion` after showing a
 * before → after preview.
 */

import {
  configPath,
  loadConfigWithStatus,
  saveConfig,
  isValidStaleTaskWindowMs,
  isValidHeartbeatIntervalSec,
  DEFAULT_STALE_TASK_WINDOW_MS,
  DEFAULT_HEARTBEAT_INTERVAL_SEC,
  type AweekConfig,
} from '../storage/config-store.js';
import { DEFAULT_TZ, isValidTimeZone } from '../time/zone.js';

// All knobs surfaced by this module are config-backed today. The previous
// `lockDir` / `maxLockAgeMs` read-only entries were dropped — those remain
// hardcoded in `src/lock/lock-manager.ts` but are no longer surfaced through
// the Settings page or `/aweek:config`. Lock layout is an implementation
// detail, not a user knob.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfigSource = 'config' | 'hardcoded';

export interface ConfigKnob {
  /** Stable machine key (e.g. `timeZone`). */
  key: string;
  /** Human-readable label shown in the rendered output. */
  label: string;
  /** Display category (`Configuration` / `Scheduler`). */
  category: string;
  /** Where the live value comes from. */
  source: ConfigSource;
  /** True when `editConfig` accepts this key. */
  editable: boolean;
  /** Current effective value, formatted as a string for display. */
  value: string;
  /** Default value, formatted as a string. */
  defaultValue: string;
  /** One-line description shown next to the value. */
  description: string;
}

export interface ShowConfigResult {
  /** Status of the underlying `.aweek/config.json` file. See `ConfigFileStatus`. */
  status: 'ok' | 'missing';
  /** Absolute path to `.aweek/config.json` (whether it exists or not). */
  configFile: string;
  /** Ordered list of knobs (config-backed first, then hardcoded constants). */
  knobs: ConfigKnob[];
}

export interface ShowConfigOpts {
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// Show
// ---------------------------------------------------------------------------

/**
 * Build the full set of knobs the skill renders. Each entry mirrors the
 * Settings-page item with the same `key`/`label`/`description` so users
 * see consistent text in both surfaces.
 */
export async function showConfig({ dataDir }: ShowConfigOpts = {}): Promise<ShowConfigResult> {
  if (!dataDir) throw new Error('showConfig: dataDir is required');
  const { config, status } = await loadConfigWithStatus(dataDir);
  const knobs: ConfigKnob[] = [
    {
      key: 'timeZone',
      label: 'Time Zone',
      category: 'Configuration',
      source: 'config',
      editable: true,
      value: config.timeZone,
      defaultValue: DEFAULT_TZ,
      description:
        'IANA time zone used for scheduling, week-key derivation, and calendar display.',
    },
    {
      key: 'heartbeatIntervalSec',
      label: 'Heartbeat Interval (sec)',
      category: 'Scheduler',
      source: 'config',
      editable: true,
      value: String(config.heartbeatIntervalSec),
      defaultValue: String(DEFAULT_HEARTBEAT_INTERVAL_SEC),
      description:
        'How often the launchd user agent (or cron fallback) fires the heartbeat. Editing this value writes to .aweek/config.json — re-run /aweek:init to rotate the live launchd plist or crontab line.',
    },
    {
      key: 'staleTaskWindowMs',
      label: 'Stale Task Window (ms)',
      category: 'Scheduler',
      source: 'config',
      editable: true,
      value: String(config.staleTaskWindowMs),
      defaultValue: String(DEFAULT_STALE_TASK_WINDOW_MS),
      description:
        'Tasks whose runAt is older than this window are skipped on the next heartbeat instead of dispatched late.',
    },
  ];
  return {
    status,
    configFile: configPath(dataDir),
    knobs,
  };
}

/**
 * Render `showConfig`'s result for direct CLI output. The format mirrors
 * the visual structure of the Settings page (cards grouped by category)
 * adapted for a terminal: one section per category, one knob per line, key
 * + source on a sub-line, description on a sub-line.
 */
export function formatShowConfigResult(result: ShowConfigResult): string {
  const lines: string[] = [];
  lines.push('=== aweek Configuration ===');
  lines.push(`Config file: ${result.configFile}`);
  const statusLine =
    result.status === 'missing'
      ? 'File status: missing  (malformed JSON or invalid timeZone — running on defaults)'
      : 'File status: ok';
  lines.push(statusLine);
  lines.push('');
  // Group knobs by category while preserving the original order.
  const groups: { category: string; knobs: ConfigKnob[] }[] = [];
  const groupIndex = new Map<string, number>();
  for (const k of result.knobs) {
    let idx = groupIndex.get(k.category);
    if (idx === undefined) {
      idx = groups.length;
      groupIndex.set(k.category, idx);
      groups.push({ category: k.category, knobs: [] });
    }
    groups[idx]!.knobs.push(k);
  }
  for (const { category, knobs } of groups) {
    lines.push(`-- ${category} --`);
    for (const k of knobs) {
      const editTag = k.editable ? '' : ' (read-only)';
      const defaultTag =
        k.value === k.defaultValue ? '' : `  [default: ${k.defaultValue}]`;
      lines.push(`  ${k.label}: ${k.value}${editTag}${defaultTag}`);
      lines.push(`    key: ${k.key} · source: ${k.source}`);
      lines.push(`    ${k.description}`);
    }
    lines.push('');
  }
  const editable = result.knobs.filter((k) => k.editable);
  if (editable.length === 0) {
    lines.push('No editable fields available.');
  } else {
    lines.push(`Editable fields: ${editable.map((k) => k.key).join(', ')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Editable-field registry
// ---------------------------------------------------------------------------

/**
 * The runtime type a field's validator produces. Strings for IANA-zone /
 * path-like fields; numbers for ms / seconds. Mirrors the field's
 * declared type in `AweekConfig` so `editConfig` can pass `normalized`
 * straight through to `saveConfig` without further conversion.
 */
export type EditableFieldValue = string | number;

export interface EditableFieldSpec {
  key: string;
  label: string;
  description: string;
  defaultValue: string;
  /**
   * Returns the canonical typed value on success (the value that gets
   * written to .aweek/config.json) or a reason on failure. Display-side
   * code stringifies `normalized` for the before → after preview.
   */
  validate(
    value: string,
  ): { ok: true; normalized: EditableFieldValue } | { ok: false; reason: string };
}

/**
 * Single source of truth for which fields `editConfig` accepts and how they
 * validate. Adding a new editable field today means: (1) extend
 * `AweekConfig` in `src/storage/config-store.ts` and its `saveConfig`
 * validator, and (2) add an entry here. The `showConfig` knob list also
 * needs the corresponding `editable: true` flag.
 */
export function listEditableFields(): EditableFieldSpec[] {
  return [
    {
      key: 'timeZone',
      label: 'Time Zone',
      description:
        'IANA time zone used for scheduling. Examples: America/Los_Angeles, Asia/Seoul, Europe/Berlin, UTC.',
      defaultValue: DEFAULT_TZ,
      validate(raw: string) {
        const v = String(raw ?? '').trim();
        if (!v) return { ok: false, reason: 'Time zone cannot be empty.' };
        if (!isValidTimeZone(v))
          return {
            ok: false,
            reason: `"${v}" is not a recognised IANA time zone. Try names like America/Los_Angeles or Asia/Seoul.`,
          };
        return { ok: true, normalized: v };
      },
    },
    {
      key: 'staleTaskWindowMs',
      label: 'Stale Task Window (ms)',
      description:
        'How far in the past a task\'s runAt can be before the heartbeat marks it skipped instead of dispatching it late. Integer milliseconds between 60_000 (1 min) and 86_400_000 (24 h). Common values: 1200000 (20 min), 1800000 (30 min), 3600000 (60 min, default).',
      defaultValue: String(DEFAULT_STALE_TASK_WINDOW_MS),
      validate(raw: string) {
        const v = String(raw ?? '').trim();
        if (!v) return { ok: false, reason: 'Stale task window cannot be empty.' };
        const n = Number(v);
        if (!Number.isFinite(n))
          return {
            ok: false,
            reason: `"${v}" is not a number. Pass an integer milliseconds value (e.g. 1200000 for 20 min).`,
          };
        const intN = Math.trunc(n);
        if (!isValidStaleTaskWindowMs(intN))
          return {
            ok: false,
            reason: `${intN} ms is out of range. Stale window must be an integer between 60000 (1 min) and 86400000 (24 h).`,
          };
        return { ok: true, normalized: intN };
      },
    },
    {
      key: 'heartbeatIntervalSec',
      label: 'Heartbeat Interval (sec)',
      description:
        'How often the heartbeat fires, in integer seconds. Range: 60 (1 min) to 86400 (24 h). Common values: 300 (5 min), 600 (10 min, default), 900 (15 min), 1800 (30 min). Editing this value alone does not rotate the live schedule — re-run /aweek:init to rewrite the launchd plist or crontab line.',
      defaultValue: String(DEFAULT_HEARTBEAT_INTERVAL_SEC),
      validate(raw: string) {
        const v = String(raw ?? '').trim();
        if (!v) return { ok: false, reason: 'Heartbeat interval cannot be empty.' };
        const n = Number(v);
        if (!Number.isFinite(n))
          return {
            ok: false,
            reason: `"${v}" is not a number. Pass an integer seconds value (e.g. 600 for 10 min).`,
          };
        const intN = Math.trunc(n);
        if (!isValidHeartbeatIntervalSec(intN))
          return {
            ok: false,
            reason: `${intN} s is out of range. Heartbeat interval must be an integer between 60 (1 min) and 86400 (24 h).`,
          };
        return { ok: true, normalized: intN };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export interface EditConfigOpts {
  dataDir?: string;
  field?: string;
  value?: string;
  /**
   * Required for any write that would change the file. The skill markdown
   * collects an explicit `AskUserQuestion` confirmation before passing
   * `confirmed: true`. Skill modules never bypass this gate.
   */
  confirmed?: boolean;
}

export type EditConfigResult =
  | {
      ok: true;
      field: string;
      label: string;
      before: string;
      after: string;
      configFile: string;
      /** False for no-op writes (value already matched). */
      changed: boolean;
    }
  | {
      ok: false;
      field?: string;
      reason: string;
      configFile?: string;
    };

/**
 * Validate, gate, and persist a single config-field edit.
 *
 * Refuses to write when:
 *   - `field` is unknown or not in the editable registry,
 *   - the new value fails the field's `validate` function,
 *   - or `confirmed` is anything other than `true` and the value would
 *     actually change. (No-op edits return `changed: false` without a
 *     write and don't require confirmation.)
 */
export async function editConfig({
  dataDir,
  field,
  value,
  confirmed,
}: EditConfigOpts = {}): Promise<EditConfigResult> {
  if (!dataDir) return { ok: false, reason: 'editConfig: dataDir is required' };
  if (!field) return { ok: false, reason: 'editConfig: field is required' };
  if (value === undefined || value === null)
    return { ok: false, field, reason: 'editConfig: value is required' };

  const editable = listEditableFields();
  const spec = editable.find((f) => f.key === field);
  if (!spec)
    return {
      ok: false,
      field,
      reason: `Field "${field}" is not editable. Editable fields: ${editable.map((f) => f.key).join(', ') || '(none)'}.`,
    };

  const validation = spec.validate(String(value));
  if (!validation.ok) return { ok: false, field, reason: validation.reason };

  const path = configPath(dataDir);
  const { config: current } = await loadConfigWithStatus(dataDir);
  // Compare typed values so a numeric-field edit (e.g. staleTaskWindowMs)
  // doesn't false-positive as a no-op when the on-disk value is also a
  // number. Display continues to use the stringified form.
  const beforeRaw = (current as unknown as Record<string, unknown>)[field];
  const before = beforeRaw === undefined || beforeRaw === null ? '' : String(beforeRaw);
  const after = String(validation.normalized);
  const isNoop = beforeRaw === validation.normalized;

  if (isNoop) {
    return {
      ok: true,
      field,
      label: spec.label,
      before,
      after,
      configFile: path,
      changed: false,
    };
  }

  if (confirmed !== true) {
    return {
      ok: false,
      field,
      reason:
        'editConfig: confirmed=true is required before writing. The /aweek:config skill collects this via AskUserQuestion after showing the before → after preview.',
      configFile: path,
    };
  }

  const patch = { [field]: validation.normalized } as Partial<AweekConfig>;
  await saveConfig(dataDir, patch);

  return {
    ok: true,
    field,
    label: spec.label,
    before,
    after,
    configFile: path,
    changed: true,
  };
}

/** Render `editConfig`'s result for direct CLI output. */
export function formatEditConfigResult(result: EditConfigResult): string {
  if (!result.ok) {
    const lines: string[] = ['=== aweek Config Edit (failed) ==='];
    lines.push(`Reason: ${result.reason}`);
    if (result.field) lines.push(`Field: ${result.field}`);
    if (result.configFile) lines.push(`Config file: ${result.configFile}`);
    return lines.join('\n');
  }
  const lines: string[] = ['=== aweek Config Edit ==='];
  if (result.changed) {
    lines.push(`Updated ${result.label} (${result.field}):`);
    lines.push(`  ${result.before}  →  ${result.after}`);
    lines.push(`Wrote ${result.configFile}.`);
  } else {
    lines.push(
      `${result.label} (${result.field}) is already ${result.after}. No write performed.`,
    );
    lines.push(`Config file: ${result.configFile}`);
  }
  return lines.join('\n');
}
