/**
 * Best-effort secret redactor for CLI transcript lines.
 *
 * Applied as each stream-json line comes out of the Claude Code CLI before
 * it's persisted to `.aweek/agents/<slug>/executions/<taskId>-<executionId>.jsonl`.
 * Catches common API-key shapes (OpenAI, Anthropic, GitHub, AWS, Google, Slack,
 * generic Bearer tokens) and obvious `NAME=value` envvar-style secrets.
 *
 * This is a defense-in-depth layer, NOT a security guarantee. Custom token
 * formats, free-text secrets in prompts, and anything the agent happens to
 * read from disk can still leak. Treat the transcript files as machine-local
 * only and keep `.aweek/` gitignored.
 */

const MARKER = '[REDACTED]';

/**
 * Ordered list of redaction patterns. Specific shapes (prefixed keys) come
 * before the generic catch-all so the specific marker wins on overlap.
 */
const PATTERNS = [
  // OpenAI / Anthropic / other prefix "sk-<chars>" keys.
  { name: 'sk', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g },
  // GitHub personal-access tokens (classic + fine-grained).
  { name: 'ghp', re: /\bghp_[A-Za-z0-9]{30,}\b/g },
  { name: 'ghu', re: /\bghu_[A-Za-z0-9]{30,}\b/g },
  { name: 'ghs', re: /\bghs_[A-Za-z0-9]{30,}\b/g },
  { name: 'gho', re: /\bgho_[A-Za-z0-9]{30,}\b/g },
  { name: 'ghr', re: /\bghr_[A-Za-z0-9]{30,}\b/g },
  { name: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  // Slack tokens.
  { name: 'slack', re: /\bxox[baprso]-[A-Za-z0-9-]{10,}\b/g },
  // AWS access-key ID + secret-access-key (shape-only; IDs leak identity too).
  { name: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'aws-asia', re: /\bASIA[0-9A-Z]{16}\b/g },
  // Google API keys.
  { name: 'google', re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  // Stripe secret keys (live + test + restricted).
  { name: 'stripe', re: /\b(?:rk|sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  // Bearer tokens — capture a reasonable token body length.
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g },
  // JWTs (three base64url segments separated by dots).
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Catch-all: `SOMETHING_(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)_? = value` assignments.
  // The NAME part allows digits/underscores; the value captures until whitespace
  // or common terminators. Intentionally broad — false positives trade off
  // against missed secrets.
  {
    name: 'envvar',
    re: /\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY)[A-Z0-9_]*\s*[=:]\s*["']?[^\s"'&<>]{6,}/g,
  },
];

/**
 * Apply all patterns to a line and return the redacted form. Each match is
 * replaced with `[REDACTED]`. For `NAME=value` style hits the name is kept so
 * readers can see which env var was scrubbed.
 *
 * @param {string} line
 * @returns {string}
 */
export function redactLine(line) {
  if (typeof line !== 'string' || line.length === 0) return line;

  let out = line;
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    if (name === 'envvar') {
      out = out.replace(re, (match) => {
        const eq = match.search(/[=:]/);
        if (eq === -1) return MARKER;
        return `${match.slice(0, eq + 1)} ${MARKER}`;
      });
    } else {
      out = out.replace(re, MARKER);
    }
  }
  return out;
}

/**
 * Exposed for tests — the pattern list is stable across callers.
 *
 * @returns {ReadonlyArray<{name: string, re: RegExp}>}
 */
export function __patternsForTest() {
  return PATTERNS;
}

export const REDACTION_MARKER = MARKER;
