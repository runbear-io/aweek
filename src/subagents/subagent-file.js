/**
 * Subagent file primitives for the aweek ↔ Claude Code 1-to-1 wrapper refactor.
 *
 * Each aweek agent is a thin scheduling wrapper around a Claude Code subagent
 * defined in a project-level file at `.claude/agents/SLUG.md`. That file is
 * the single source of truth for identity (name, description), system prompt,
 * model, tool allowlist, skills, and MCP server bindings. The aweek JSON
 * stored alongside owns only the scheduling concerns — goals, monthly and
 * weekly plans, token budget, inbox, and execution logs.
 *
 * This module is the one place in the codebase that knows how to:
 *
 *   - resolve the project-level subagent directory (never the user-level
 *     `~/.claude/agents/` — per project constraint, we only ever write into
 *     the current project's `.claude/agents/`),
 *   - validate a subagent slug (it doubles as the filesystem basename and as
 *     the aweek agent id, so it has to be filesystem-safe),
 *   - render the minimal frontmatter that Claude Code expects (`name` plus
 *     `description`) followed by the system-prompt body,
 *   - write a brand-new subagent file without ever clobbering an existing
 *     one (the "create-new" path refuses on collision and the wizard then
 *     pivots to "adopt-existing").
 *
 * By isolating these primitives here we keep the hire wizard, the heartbeat,
 * the delete flow, and the summary dashboard all pointing at one
 * implementation of "what does a subagent file look like on disk".
 */
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SUBAGENT_SLUG_PATTERN } from '../schemas/agent.schema.js';

/**
 * Relative path to the project-level subagent directory.
 *
 * All writes and reads happen under this directory. User-level
 * `~/.claude/agents/` is intentionally out of scope: aweek must never write
 * to the user-level directory so per-project configuration stays per-project.
 */
export const SUBAGENTS_DIR_RELATIVE = join('.claude', 'agents');

const SLUG_REGEX = new RegExp(SUBAGENT_SLUG_PATTERN);

/**
 * Resolve the absolute path to the project-level subagent directory.
 *
 * @param {string} [projectDir] - Override for the project root (used by tests
 *   and by callers that already know the working directory). When omitted,
 *   falls back to `process.cwd()` — evaluated on every call so tests that
 *   `process.chdir()` around see the fresh value.
 * @returns {string} Absolute path to `<projectDir>/.claude/agents`.
 */
export function resolveSubagentsDir(projectDir) {
  const base = projectDir || process.cwd();
  return resolve(base, SUBAGENTS_DIR_RELATIVE);
}

/**
 * Build the absolute path to a specific subagent .md file.
 *
 * @param {string} slug - Subagent slug (filesystem basename minus `.md`).
 * @param {string} [projectDir] - Optional project-root override.
 * @returns {string}
 */
export function subagentFilePath(slug, projectDir) {
  return join(resolveSubagentsDir(projectDir), `${slug}.md`);
}

/**
 * Check whether a subagent slug is well-formed.
 *
 * The slug doubles as the filesystem basename of `.claude/agents/SLUG.md`
 * AND as the aweek agent id, so it must match `SUBAGENT_SLUG_PATTERN` —
 * lowercase alphanumeric with single hyphens, no leading/trailing hyphen,
 * no consecutive hyphens.
 *
 * @param {string} slug
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSubagentSlug(slug) {
  if (typeof slug !== 'string' || slug.length === 0) {
    return {
      valid: false,
      errors: ['Subagent slug is required and must be a non-empty string'],
    };
  }
  if (!SLUG_REGEX.test(slug)) {
    return {
      valid: false,
      errors: [
        'Subagent slug must be lowercase alphanumeric with single hyphens (no underscores, spaces, leading/trailing, or consecutive hyphens)',
      ],
    };
  }
  return { valid: true, errors: [] };
}

/**
 * Slugify a human-readable agent name into a valid subagent slug.
 *
 * The wizard accepts free-form names (e.g. "Content Writer") and this helper
 * collapses them to the canonical slug form (`content-writer`). Callers
 * should always re-run {@link validateSubagentSlug} on the result because an
 * empty or all-symbol input collapses to `""`, which is not a valid slug.
 *
 * @param {string} name
 * @returns {string} Slug string, possibly empty if the input had no
 *   alphanumeric characters.
 */
export function slugifyName(name) {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Validate a short description string (frontmatter value, not a schema field).
 *
 * The Claude Code subagent spec requires a non-empty `description`. We keep
 * it on a single line so the emitted YAML stays trivially parseable — the
 * wizard asks for a brief one-sentence summary.
 *
 * @param {string} description
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDescription(description) {
  if (typeof description !== 'string' || description.trim().length === 0) {
    return {
      valid: false,
      errors: ['Description is required and must be a non-empty string'],
    };
  }
  if (/[\r\n]/.test(description)) {
    return {
      valid: false,
      errors: ['Description must be a single line (no newlines)'],
    };
  }
  return { valid: true, errors: [] };
}

/**
 * Validate a system-prompt body. Non-empty string — that's the only hard
 * requirement. The wizard trims trailing whitespace at render time.
 *
 * @param {string} systemPrompt
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSystemPrompt(systemPrompt) {
  if (typeof systemPrompt !== 'string' || systemPrompt.trim().length === 0) {
    return {
      valid: false,
      errors: ['System prompt is required and must be a non-empty string'],
    };
  }
  return { valid: true, errors: [] };
}

/**
 * Escape a string for safe single-line YAML output.
 *
 * We quote conservatively: any character outside a small "plain" alphabet
 * triggers double-quoted YAML with `\` and `"` escaped. This keeps the
 * emitted frontmatter readable for the common case (plain ASCII
 * descriptions) while staying correct for apostrophes, colons, and the
 * occasional emoji.
 *
 * @param {string} value
 * @returns {string}
 */
function yamlQuoteIfNeeded(value) {
  const s = String(value ?? '');
  // Characters that are safe to emit as a YAML plain scalar on one line.
  // Keep the set conservative; anything else gets double-quoted.
  if (s.length > 0 && /^[A-Za-z0-9 _.,/()\-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build the minimal Claude Code subagent markdown document.
 *
 * Frontmatter carries only the two fields the Claude Code loader actually
 * needs to address the subagent — `name` and `description`. Optional fields
 * (`model`, `allowed-tools`, `skills`, `mcp-servers`) are intentionally
 * omitted so the emitted file is the absolute minimum. Users who want to
 * override any of those open the `.md` file and hand-edit it; the aweek
 * wizard deliberately does not prompt for them (per the
 * `minimal_new_code_surface` and 3-fields-only constraints).
 *
 * The system prompt is written verbatim into the body. The function
 * guarantees exactly one trailing newline so subsequent appends are clean.
 *
 * @param {object} params
 * @param {string} params.name - Subagent slug; written as the `name` field.
 * @param {string} params.description - One-line description for frontmatter.
 * @param {string} params.systemPrompt - Body text (the prompt itself).
 * @returns {string} Full markdown document.
 */
export function buildSubagentMarkdown({ name, description, systemPrompt }) {
  const body = String(systemPrompt ?? '').replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
  return [
    '---',
    `name: ${name}`,
    `description: ${yamlQuoteIfNeeded(description)}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

/**
 * Check whether a subagent file already exists on disk.
 *
 * Used by the hire wizard to detect the "collision" case and pivot to the
 * adopt-existing path instead of clobbering an existing subagent.
 *
 * @param {string} slug
 * @param {string} [projectDir]
 * @returns {Promise<boolean>}
 */
export async function subagentFileExists(slug, projectDir) {
  try {
    await access(subagentFilePath(slug, projectDir), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the absolute path to a user-level subagent .md file (`~/.claude/agents/<slug>.md`).
 *
 * aweek NEVER writes to this location (per the non-destructive-defaults
 * constraint), but at heartbeat time we must honour Claude Code's resolution
 * order: a subagent is considered installed if EITHER the project-level file
 * or the user-level file exists. This helper centralises the user-level path
 * resolution so tests can stub `home` without monkey-patching `os.homedir`.
 *
 * @param {string} slug
 * @param {string} [home] - Override for the user home directory (tests only).
 *   When omitted, falls back to `os.homedir()`.
 * @returns {string}
 */
export function userSubagentFilePath(slug, home) {
  const base = home || homedir();
  return join(base, '.claude', 'agents', `${slug}.md`);
}

/**
 * Check whether a subagent .md file exists at EITHER the project level
 * (`.claude/agents/<slug>.md`) or the user level (`~/.claude/agents/<slug>.md`).
 *
 * This is the authoritative "is this subagent resolvable by Claude Code?"
 * check. The heartbeat uses it before spawning a session — if neither file
 * exists, the agent is auto-paused with `pausedReason: 'subagent_missing'`
 * instead of being spawned into a crash-loop.
 *
 * Returns a structured result so callers can surface the checked paths in
 * error messages (crucial for the summary dashboard's "missing" marker and
 * for the heartbeat log).
 *
 * @param {string} slug
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Project root override.
 * @param {string} [opts.home] - User home override (tests only).
 * @returns {Promise<{ exists: boolean, location: 'project'|'user'|null, projectPath: string, userPath: string }>}
 */
export async function resolveSubagentFile(slug, opts = {}) {
  const { projectDir, home } = opts;
  const projectPath = subagentFilePath(slug, projectDir);
  const userPath = userSubagentFilePath(slug, home);

  try {
    await access(projectPath, fsConstants.F_OK);
    return { exists: true, location: 'project', projectPath, userPath };
  } catch {
    // fall through to user-level check
  }

  try {
    await access(userPath, fsConstants.F_OK);
    return { exists: true, location: 'user', projectPath, userPath };
  } catch {
    return { exists: false, location: null, projectPath, userPath };
  }
}

/**
 * Read the raw contents of an existing subagent .md file.
 *
 * Callers that just need the slug-to-path mapping should prefer
 * {@link subagentFilePath}; this helper exists for components (summary
 * dashboard, heartbeat error reporting) that need to display or parse the
 * frontmatter.
 *
 * @param {string} slug
 * @param {string} [projectDir]
 * @returns {Promise<string>}
 * @throws If the file does not exist.
 */
export async function readSubagentFile(slug, projectDir) {
  return readFile(subagentFilePath(slug, projectDir), 'utf8');
}

/**
 * Unquote a single-line YAML scalar value.
 *
 * Handles the three shapes `writeSubagentFile` emits:
 *   - plain (unquoted) — returned verbatim after trimming outer whitespace.
 *   - double-quoted — `\\` and `\"` are unescaped.
 *   - single-quoted — doubled single quotes (`''`) are collapsed.
 *
 * @param {string} raw
 * @returns {string}
 */
function unquoteYamlScalar(raw) {
  const s = String(raw ?? '').trim();
  if (s.length === 0) return '';
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/**
 * Parse the YAML frontmatter of a subagent .md into `{ name, description }`.
 *
 * Matches the exact shape that {@link buildSubagentMarkdown} emits — a
 * leading `---` fence, `key: value` lines, a closing `---`, then the system
 * prompt body. Only `name` and `description` are surfaced because those are
 * the only two fields the summary dashboard and heartbeat error reporting
 * need to display live from the .md. Additional frontmatter keys are ignored
 * without error so hand-edited subagents (e.g. ones that set `model:` or
 * `allowed-tools:`) still parse cleanly.
 *
 * @param {string} content - Full .md file contents.
 * @returns {{ name: string, description: string }}
 */
export function parseSubagentFrontmatter(content) {
  const out = { name: '', description: '' };
  if (typeof content !== 'string' || content.length === 0) return out;

  // Tolerate BOM + leading blank lines before the opening fence.
  const normalized = content.replace(/^\uFEFF/, '');
  const match = normalized.match(/^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return out;

  const body = match[1];
  for (const line of body.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2];
    if (key === 'name') out.name = unquoteYamlScalar(value);
    else if (key === 'description') out.description = unquoteYamlScalar(value);
  }
  return out;
}

/**
 * Extract the system-prompt body of a subagent .md file — everything after
 * the closing `---` frontmatter fence, trimmed of leading/trailing blank
 * lines. When no frontmatter fence is present (e.g. a hand-crafted file
 * without YAML), the entire (right-trimmed) content is returned so the
 * caller still sees the prompt instead of an empty string.
 *
 * Used by the SPA Profile tab so users can read the live system prompt
 * without opening the .md on disk. Matches the body written by
 * {@link buildSubagentMarkdown} so writer/reader round-trips are lossless.
 *
 * @param {string} content
 * @returns {string}
 */
export function parseSubagentBody(content) {
  if (typeof content !== 'string' || content.length === 0) return '';
  const normalized = content.replace(/^\uFEFF/, '');
  const match = normalized.match(
    /^\s*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
  );
  let body;
  if (!match) {
    // No frontmatter — treat the whole content as the body.
    body = normalized;
  } else {
    body = normalized.slice(match[0].length);
  }
  // Strip leading blank lines (separator whitespace between fence + body)
  // and trailing whitespace so the rendered block is tight.
  return body.replace(/^[\r\n]+/, '').replace(/\s+$/, '');
}

/**
 * Read a subagent's live frontmatter from disk.
 *
 * Returns `{ missing: true }` when the .md file is absent — the single
 * source of truth for identity is the .md, so anything relying on live name
 * or description (summary dashboard, heartbeat error reporting) must render
 * a missing marker instead of pulling stale data from aweek JSON. When the
 * file exists but frontmatter fails to parse we still return `missing:
 * false` so callers can distinguish "file vanished" from "file malformed".
 *
 * The system-prompt `body` is returned alongside name/description so the
 * SPA Profile tab can render the live prompt without a second file read.
 * Existing callers that only destructure `{ name, description, path }`
 * continue to work unchanged — the extra field is purely additive.
 *
 * @param {string} slug
 * @param {string} [projectDir]
 * @returns {Promise<{ missing: boolean, name: string, description: string, body: string, path: string }>}
 */
export async function readSubagentIdentity(slug, projectDir) {
  const path = subagentFilePath(slug, projectDir);
  try {
    const content = await readFile(path, 'utf8');
    const parsed = parseSubagentFrontmatter(content);
    const body = parseSubagentBody(content);
    return {
      missing: false,
      name: parsed.name,
      description: parsed.description,
      body,
      path,
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { missing: true, name: '', description: '', body: '', path };
    }
    throw err;
  }
}

/**
 * Write a brand-new subagent .md file to the project-level directory.
 *
 * Create-new semantics:
 *   - Validates `slug`, `description`, and `systemPrompt` up front.
 *   - Refuses to overwrite an existing file (returns `success: false` so the
 *     caller can route the user into the adopt-existing path). The file on
 *     disk is never touched in this case.
 *   - Creates `.claude/agents/` recursively if it does not exist yet —
 *     matches the behaviour of the existing aweek storage helpers, which
 *     tolerate a fresh install.
 *   - Writes ONLY to the project directory. `projectDir` defaults to
 *     `process.cwd()`; the function never resolves to the user-level
 *     `~/.claude/agents/`.
 *
 * The returned `content` is the exact bytes written — useful in tests and
 * summary output so callers don't need to re-read the file.
 *
 * @param {object} params
 * @param {string} params.slug
 * @param {string} params.description
 * @param {string} params.systemPrompt
 * @param {string} [params.projectDir]
 * @returns {Promise<
 *   | { success: true, path: string, slug: string, content: string }
 *   | { success: false, errors: string[], path?: string, alreadyExists?: boolean }
 * >}
 */
export async function writeSubagentFile({
  slug,
  description,
  systemPrompt,
  projectDir,
} = {}) {
  const errors = [];

  const slugResult = validateSubagentSlug(slug);
  if (!slugResult.valid) errors.push(...slugResult.errors);

  const descResult = validateDescription(description);
  if (!descResult.valid) errors.push(...descResult.errors);

  const promptResult = validateSystemPrompt(systemPrompt);
  if (!promptResult.valid) errors.push(...promptResult.errors);

  if (errors.length > 0) {
    return { success: false, errors };
  }

  const dir = resolveSubagentsDir(projectDir);
  const path = join(dir, `${slug}.md`);

  if (await subagentFileExists(slug, projectDir)) {
    return {
      success: false,
      alreadyExists: true,
      path,
      errors: [
        `Subagent file already exists at ${path}. Pick a different name or adopt the existing subagent instead of creating a new one.`,
      ],
    };
  }

  await mkdir(dir, { recursive: true });

  const content = buildSubagentMarkdown({
    name: slug,
    description,
    systemPrompt,
  });
  await writeFile(path, content, 'utf8');

  return { success: true, path, slug, content };
}
