/**
 * Per-agent environment variables loaded from `.aweek/agents/<slug>/.env`.
 *
 * The heartbeat reads this file on each tick and passes the parsed map as
 * `opts.env` into the spawned Claude Code CLI session, so different agents
 * can carry different secrets (API keys, provider toggles, etc.) without
 * polluting the user's shell or the agent JSON.
 *
 * The format is a small subset of dotenv:
 *   - `KEY=value` or `export KEY=value`
 *   - `#` at the start of a line, or after whitespace on an unquoted value,
 *     begins a comment.
 *   - Double-quoted values support `\n`, `\r`, `\t`, `\\`, `\"` escapes.
 *   - Single-quoted values are taken verbatim (no interpolation).
 *   - Unquoted values are trimmed.
 *
 * Missing or unreadable file → empty object. The parser is intentionally
 * strict-but-lenient: malformed lines are skipped, not fatal, so a single
 * bad line never stops a tick.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Filename of an agent's per-agent dotenv file inside its slug directory. */
export const AGENT_ENV_FILENAME = '.env';

/**
 * Parsed env-file map. Values are always strings — the dotenv subset this
 * module understands has no notion of typed scalars.
 */
export type AgentEnvMap = Record<string, string>;

/**
 * Absolute path to an agent's env file.
 *
 * @param agentsDir - `.aweek/agents` root.
 * @param agentId - Agent slug.
 */
export function envPath(agentsDir: string, agentId: string): string {
  if (!agentsDir) throw new TypeError('agentsDir is required');
  if (!agentId) throw new TypeError('agentId is required');
  return join(agentsDir, agentId, AGENT_ENV_FILENAME);
}

/**
 * Parse a dotenv-style string into a plain object.
 *
 * Accepts `unknown` so that callers passing values of uncertain type
 * (legacy JS callers, JSON-derived blobs) do not need to pre-cast — we
 * defensively return `{}` for any non-string input.
 */
export function parseEnvFile(text: unknown): AgentEnvMap {
  const result: AgentEnvMap = {};
  if (typeof text !== 'string' || text.length === 0) return result;

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = stripExport(raw.trimStart());
    if (line.length === 0 || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    const rest = line.slice(eq + 1);
    const value = parseValue(rest);
    if (value === null) continue;

    result[key] = value;
  }
  return result;
}

function stripExport(line: string): string {
  if (line.startsWith('export ') || line.startsWith('export\t')) {
    return line.slice(7).trimStart();
  }
  return line;
}

function parseValue(rest: string): string | null {
  const trimmed = rest.trim();
  if (trimmed.length === 0) return '';

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const close = findClosingQuote(trimmed, quote);
    if (close === -1) return null;
    const body = trimmed.slice(1, close);
    return quote === '"' ? unescapeDoubleQuoted(body) : body;
  }

  // Unquoted: cut at first `#` preceded by whitespace (inline comment).
  const cut = findInlineCommentStart(trimmed);
  const value = cut === -1 ? trimmed : trimmed.slice(0, cut);
  return value.trim();
}

function findClosingQuote(s: string, quote: string): number {
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && quote === '"') {
      i += 1;
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

function findInlineCommentStart(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '#' && (i === 0 || /\s/.test(s[i - 1] as string))) return i;
  }
  return -1;
}

function unescapeDoubleQuoted(s: string): string {
  return s.replace(/\\(.)/g, (_m, ch: string) => {
    switch (ch) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case '\\': return '\\';
      case '"': return '"';
      default: return ch;
    }
  });
}

/**
 * Load and parse the agent's `.env`. Returns `{}` when the file is absent.
 */
export async function loadAgentEnv(
  agentsDir: string,
  agentId: string,
): Promise<AgentEnvMap> {
  let text: string;
  try {
    text = await readFile(envPath(agentsDir, agentId), 'utf8');
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return parseEnvFile(text);
}
