/**
 * Friendly error helpers for `aweek serve`.
 *
 * AC 8 scope: when the user runs `aweek serve` in a directory that has no
 * `.aweek/` folder, we want a multi-line, actionable message — not a raw
 * stack trace and not a single-line "Serve failed" blurb that points at
 * a path without explaining what to do.
 *
 * Keeping the helper in a dedicated file lets the HTTP server module
 * (server.js) import the constant + formatter without growing, and gives
 * the CLI layer (bin/aweek.js) a stable import target for the friendly
 * rendering path.
 */

import { resolve } from 'node:path';

/**
 * Error code attached to the thrown `Error` when `.aweek/` is missing.
 * The CLI branches on this code to swap the generic "Serve failed: ..."
 * one-liner for the friendly block produced by `formatNoAweekDirMessage`.
 */
export const MISSING_AWEEK_DIR_CODE = 'ENOAWEEKDIR' as const;

/**
 * Error shape produced by {@link createNoAweekDirError}. Carries the
 * stable `code` plus both the missing `dataDir` and its parent
 * `projectDir` so CLI formatters can render a friendly remediation block
 * without having to re-derive paths.
 */
export interface NoAweekDirError extends Error {
  code: typeof MISSING_AWEEK_DIR_CODE;
  dataDir: string;
  projectDir: string;
}

/**
 * Build the single-line `Error.message` used when `.aweek/` is missing.
 *
 * The message is intentionally short (one line, no embedded newlines) so
 * it round-trips cleanly through `err.message` logging and test
 * assertions. The full multi-line friendly rendering is
 * `formatNoAweekDirMessage`, which the CLI prints separately.
 *
 * @param dataDir — absolute path of the missing `.aweek/` folder
 */
export function buildNoAweekDirErrorMessage(dataDir: string): string {
  return `No .aweek/ folder found at ${dataDir}. Run "aweek init" first or pass --project-dir.`;
}

/**
 * Construct the `Error` thrown by `startServer()` when the configured
 * project directory has no `.aweek/` folder. Centralised here so the
 * server module and its tests share a single source of truth for both
 * the error code and the message shape.
 *
 * @param dataDir — absolute path of the missing `.aweek/` folder
 */
export function createNoAweekDirError(dataDir: string): NoAweekDirError {
  const err = new Error(buildNoAweekDirErrorMessage(dataDir)) as NoAweekDirError;
  err.code = MISSING_AWEEK_DIR_CODE;
  err.dataDir = dataDir;
  // `projectDir` is the parent of `.aweek/` — the path the user actually
  // picked, either via `--project-dir` or by running `aweek serve` from
  // that cwd. Surfacing it explicitly lets CLI formatters print it
  // without having to re-derive from `dataDir`.
  err.projectDir = resolve(dataDir, '..');
  return err;
}

/** Optional input shape for {@link formatNoAweekDirMessage}. */
export interface FormatNoAweekDirMessageOptions {
  dataDir?: string;
  projectDir?: string;
}

/**
 * Render a multi-line, human-friendly block describing the missing
 * `.aweek/` folder and how to fix it.
 *
 * The output intentionally looks like this (no leading/trailing blank
 * line, no ANSI colors — the CLI decides how to decorate):
 *
 *     No .aweek/ folder found.
 *
 *     aweek serve expects a .aweek/ folder at:
 *       /Users/me/myproj/.aweek/
 *
 *     To fix this, try one of:
 *       • cd into a project that was already initialised with /aweek:init
 *       • run `aweek init` from this directory to bootstrap one
 *       • pass --project-dir <path> to point aweek serve at the right folder
 *
 * Why it matters: new users frequently type `aweek serve` before running
 * `/aweek:init`, so the very first experience hinges on this message
 * being actionable rather than a stack trace.
 *
 * @param ctx
 *   Either `dataDir` (absolute `.aweek/` path) or `projectDir` (parent)
 *   may be passed — any one is sufficient. If both are absent the
 *   message falls back to a generic "<cwd>/.aweek/" reference using
 *   `process.cwd()`.
 */
export function formatNoAweekDirMessage(
  { dataDir, projectDir }: FormatNoAweekDirMessageOptions = {},
): string {
  const resolvedDataDir = resolve(
    dataDir ||
      (projectDir ? resolve(projectDir, '.aweek') : resolve(process.cwd(), '.aweek')),
  );

  return [
    'No .aweek/ folder found.',
    '',
    'aweek serve expects a .aweek/ folder at:',
    `  ${resolvedDataDir}`,
    '',
    'To fix this, try one of:',
    '  • cd into a project that was already initialised with /aweek:init',
    '  • run `aweek init` from this directory to bootstrap one',
    '  • pass --project-dir <path> to point aweek serve at the right folder',
  ].join('\n');
}

/**
 * Quick predicate for CLI error handling: is this the "no .aweek/" case?
 *
 * Centralising the check here means bin/aweek.js does not need to import
 * the constant directly — it can just ask `isNoAweekDirError(err)`.
 */
export function isNoAweekDirError(err: unknown): err is NoAweekDirError {
  return Boolean(err) &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === MISSING_AWEEK_DIR_CODE;
}
