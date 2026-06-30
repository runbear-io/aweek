/**
 * Execution runner abstraction.
 *
 * aweek can drive an agent task with more than one underlying coding-agent
 * CLI. Supported runners:
 *
 *   - `'claude'` — Anthropic's Claude Code CLI (`claude`). The historical
 *     default; the only runner before multi-runner support landed.
 *     Identity is resolved natively via `--agent <slug>` and scheduling
 *     context is layered on with `--append-system-prompt`.
 *   - `'gemini'` — Google's Gemini CLI (`gemini`). Has no `--agent` flag,
 *     so the subagent's `.claude/agents/<slug>.md` is injected as the
 *     system prompt via the `GEMINI_SYSTEM_MD` environment variable and
 *     scheduling context is prepended to the task prompt.
 *   - `'hermes'` — Nous' Hermes Agent CLI (`hermes`). Runs one-shot via
 *     `--oneshot`; has no `--agent` flag, no system-prompt flag, and no
 *     system-prompt env var, so the subagent identity AND scheduling
 *     context are both embedded directly in the one-shot prompt text.
 *
 * This module is the single source of truth for the runner *kind* — the
 * argv-building and token-usage parsing that differ per runner live in
 * `cli-session.ts` (they need the task / runtime-context helpers there),
 * but the type, the default-binary map, the env-var name, and the
 * resolution precedence are centralised here so config, schema, heartbeat,
 * and CLI all agree on one vocabulary.
 */

/** The coding-agent CLI used to execute an agent's tasks. */
export type RunnerKind = 'claude' | 'gemini' | 'hermes';

/** Every supported runner, in display order. */
export const RUNNER_KINDS: readonly RunnerKind[] = ['claude', 'gemini', 'hermes'];

/**
 * The runner used when neither the agent nor the project config picks one.
 * Stays `'claude'` so existing projects keep their exact prior behaviour.
 */
export const DEFAULT_RUNNER: RunnerKind = 'claude';

/**
 * Default CLI binary name per runner. Overridable per call via the
 * `cli` launch option (used by tests and by users with a non-PATH binary).
 */
export const RUNNER_BINARY: Record<RunnerKind, string> = {
  claude: 'claude',
  gemini: 'gemini',
  hermes: 'hermes',
};

/**
 * Environment variable the Gemini CLI reads to load a custom system prompt
 * from a file path. We point it at the subagent's `.claude/agents/<slug>.md`
 * so the same file that defines a Claude subagent's identity also defines
 * the Gemini run's system prompt — keeping the `.md` the single source of
 * truth for identity across both runners.
 */
export const GEMINI_SYSTEM_MD_ENV = 'GEMINI_SYSTEM_MD';

/** True when `value` is a supported {@link RunnerKind}. */
export function isRunnerKind(value: unknown): value is RunnerKind {
  return value === 'claude' || value === 'gemini' || value === 'hermes';
}

/**
 * Resolve the effective runner for a task.
 *
 * Precedence (most specific wins):
 *   1. The agent's own `runner` field (`.aweek/agents/<slug>.json`).
 *   2. The project-wide default (`.aweek/config.json` `runner`).
 *   3. {@link DEFAULT_RUNNER} (`'claude'`).
 *
 * Invalid / absent values at each level fall through to the next, so a
 * corrupt field can never select a runner that doesn't exist.
 */
export function resolveRunner(
  agentRunner?: unknown,
  configRunner?: unknown,
): RunnerKind {
  if (isRunnerKind(agentRunner)) return agentRunner;
  if (isRunnerKind(configRunner)) return configRunner;
  return DEFAULT_RUNNER;
}
