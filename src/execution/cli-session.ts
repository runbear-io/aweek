/**
 * CLI Session Launcher — spawns Claude Code CLI processes for agent task execution.
 *
 * Responsibilities:
 * - Build CLI argv that references a Claude Code subagent by slug
 *   (`--agent SUBAGENT_REF`), never by inline identity.
 * - Append runtime scheduling context (task id, objective, week, extra
 *   context) to the subagent's system prompt via `--append-system-prompt`,
 *   so the subagent's `.claude/agents/<slug>.md` file remains the sole
 *   source of truth for identity, system prompt, model, tools, skills, and
 *   MCP servers.
 * - Spawn `claude` CLI as a child process with proper argument injection.
 * - Capture stdout/stderr for downstream token-usage parsing.
 * - Return structured session results (output, exit code, duration).
 * - Support configurable CLI path, working directory, and timeout.
 *
 * Design:
 * - spawn function is injectable for testability (no real CLI needed in tests).
 * - All arguments are validated before spawning.
 * - Idempotent: launching the same task twice produces independent sessions.
 * - File source of truth: session results are returned for the caller to persist.
 *
 * IMPORTANT: This module does NOT construct a system prompt from agent
 * JSON. The aweek JSON is scheduling-only — goals, plans, budget, inbox,
 * logs. The `.claude/agents/<slug>.md` file owns identity. Callers pass
 * only the subagent slug plus a task context.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Default CLI binary name */
const DEFAULT_CLI = 'claude';

/** Default session timeout: 30 minutes (in ms) */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface TaskContext {
  /** Unique task identifier */
  taskId: string;
  /** Short calendar label (used in log lines) */
  title?: string;
  /** Long-form instruction text handed to Claude */
  prompt: string;
  /** Parent objective ID for traceability */
  objectiveId?: string;
  /** The plan week (YYYY-Www) */
  week?: string;
  /** Extra context to append to the prompt */
  additionalContext?: string;
  /**
   * Absolute path of the per-execution artifact directory created by the
   * session executor (`<agentsDir>/<agent>/artifacts/<taskId>_<executionId>/`).
   *
   * When set, the path is announced to the subagent via the runtime-context
   * block AND exported as the `AWEEK_ARTIFACT_DIR` environment variable on
   * the spawned CLI process. The subagent can drop deliverables into this
   * folder; downstream auto-scan will pick them up after the session
   * finishes.
   */
  artifactDir?: string;
}

export interface SessionResult {
  /** The agent that ran */
  agentId: string;
  /** The subagent slug used for `--agent` */
  subagentRef: string;
  /** The task that was executed */
  taskId: string;
  /** Captured standard output */
  stdout: string;
  /** Captured standard error */
  stderr: string;
  /** Process exit code (null if killed) */
  exitCode: number | null;
  /** Whether the session was killed due to timeout */
  timedOut: boolean;
  /** ISO timestamp */
  startedAt: string;
  /** ISO timestamp */
  completedAt: string;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** The CLI arguments used (for debugging) */
  cliArgs: string[];
}

export interface ExecutionLogWriter {
  writeLine: (line: string) => void;
}

export interface BuildCliArgsOpts {
  /** Override model (e.g. 'opus', 'sonnet') */
  model?: string;
  /** Skip permission prompts */
  dangerouslySkipPermissions?: boolean;
}

/**
 * Spawn function signature — compatible with `node:child_process` `spawn`.
 *
 * Tests inject a mock; production uses `nodeSpawn` from `node:child_process`.
 */
export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

export interface LaunchSessionOpts {
  /** CLI binary path/name (default: 'claude') */
  cli?: string;
  /** Working directory for the CLI process */
  cwd?: string;
  /** Session timeout in milliseconds (default: 1800000) */
  timeoutMs?: number;
  /** Override model */
  model?: string;
  /** Skip permission prompts */
  dangerouslySkipPermissions?: boolean;
  /** Injectable spawn function (for testing) */
  spawnFn?: SpawnFn;
  /** Additional environment variables */
  env?: NodeJS.ProcessEnv;
  /**
   * Receives each stdout line (one stream-json event per line) as it
   * arrives. The heartbeat passes an execution-log-store writer so the
   * full session is persisted to
   * `<agentsDir>/<agent>/executions/<taskId>-<executionId>.jsonl`. The
   * writer is responsible for its own close — the launcher never calls
   * close(), so the caller controls the file lifetime.
   */
  executionLogWriter?: ExecutionLogWriter | null;
}

export interface BuildSessionConfigOpts {
  /** Plan week for traceability */
  week?: string;
  /** Extra context */
  additionalContext?: string;
}

export interface SessionConfig {
  agentId: string;
  subagentRef: string;
  task: TaskContext;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

/**
 * Shape of the agent config required by `buildSessionConfig`. The actual
 * agent record carries many more fields, but only `id` and `subagentRef`
 * are read here.
 */
export interface BuildSessionAgentConfig {
  id: string;
  subagentRef: string;
}

/**
 * Shape of the selected task required by `buildSessionConfig`.
 */
export interface BuildSessionSelectedTask {
  id: string;
  title?: string;
  prompt: string;
  objectiveId?: string;
}

/**
 * Validate that a subagent reference is a non-empty string.
 *
 * We intentionally DO NOT re-validate the slug pattern here — the aweek
 * JSON schema and subagent-file primitives own slug validation at
 * write-time, so by the time we reach the launcher the slug is already
 * trusted. This keeps the CLI launcher decoupled from the schema layer
 * while still failing loudly on obviously bad input.
 */
function assertSubagentRef(subagentRef: unknown): asserts subagentRef is string {
  if (typeof subagentRef !== 'string' || subagentRef.length === 0) {
    throw new Error('subagentRef is required and must be a non-empty string');
  }
}

/**
 * Build the runtime-context block that is APPENDED to the subagent's own
 * system prompt via `--append-system-prompt`.
 *
 * The subagent's `.md` system prompt defines *who* the agent is (identity,
 * style, domain). The runtime context adds scheduling coordinates so the
 * subagent knows which aweek task this invocation maps to — task id,
 * parent objective, week, and any caller-supplied additional context.
 *
 * Keeping runtime context here (and out of the subagent .md) means the
 * subagent file stays stable across every heartbeat tick; only the
 * append-system-prompt changes per task.
 */
export function buildRuntimeContext(task: TaskContext | null | undefined): string {
  if (!task) throw new Error('task is required');
  if (!task.taskId) throw new Error('task.taskId is required');

  const lines: string[] = [
    '## aweek Runtime Context',
    '',
    'You are running as a scheduled aweek heartbeat task. The identity,',
    'tools, skills, and model you see above are defined in your subagent',
    '`.claude/agents/<slug>.md` file — this section adds the per-tick',
    'scheduling coordinates for the current invocation.',
    '',
    `Task ID: ${task.taskId}`,
  ];

  if (task.objectiveId) lines.push(`Objective ID: ${task.objectiveId}`);
  if (task.week) lines.push(`Week: ${task.week}`);

  if (task.artifactDir) {
    lines.push(
      '',
      '### Artifact Directory',
      '',
      'Save deliverable files (documents, code, data, reports) you produce',
      'during this task into the absolute path below. Files dropped here are',
      'auto-scanned and registered as persistent artifacts tied to this',
      'task execution. The same path is also exported as the',
      '`AWEEK_ARTIFACT_DIR` environment variable for tools that prefer env.',
      '',
      `Artifact Directory: ${task.artifactDir}`,
    );
  }

  if (task.additionalContext) {
    lines.push('', '### Additional Context', '', task.additionalContext);
  }

  return lines.join('\n');
}

/**
 * Build the positional user-prompt (the "TASK") that goes at the end of
 * the claude CLI argv. This is the actionable request: the task's long-form
 * `prompt` text plus execution instructions. Scheduling metadata lives in
 * the runtime context; this string is intentionally narrow so the subagent
 * focuses on the work.
 *
 * The short `title` field is for calendar / dashboard display and is NOT
 * routed to Claude — only `prompt` enters the model context.
 */
export function buildTaskPrompt(task: TaskContext | null | undefined): string {
  if (!task) throw new Error('task is required');
  if (!task.taskId) throw new Error('task.taskId is required');
  if (!task.prompt) throw new Error('task.prompt is required');

  return [
    `## Task: ${task.prompt}`,
    '',
    `Task ID: ${task.taskId}`,
    '',
    '## Instructions',
    '',
    'Execute this task thoroughly. When complete, summarize what was accomplished.',
    'If you encounter blockers, explain them clearly.',
  ].join('\n');
}

/**
 * Build CLI arguments array for the `claude` command.
 *
 * Constructs the argument list:
 *   claude --print --output-format stream-json --verbose --agent REF --append-system-prompt RUNTIME_CONTEXT TASK
 *
 * - `--print` runs the CLI non-interactively.
 * - `--output-format stream-json --verbose` emits one JSON event per line
 *   covering system init, the user prompt, every assistant turn (with
 *   tool_use blocks), every tool_result, and the final result + usage.
 *   Claude Code requires `--verbose` alongside `stream-json` under
 *   `--print`. The heartbeat persists the full NDJSON stream per
 *   execution so the dashboard can render an execution log; token usage is
 *   pulled from the final `{type:"result"}` event by `parseTokenUsage`.
 * - `--agent REF` selects the Claude Code subagent defined by
 *   `.claude/agents/<REF>.md` (owner of identity, model, tools, skills,
 *   and MCP servers).
 * - `--append-system-prompt` layers per-task scheduling metadata onto the
 *   subagent's own system prompt without mutating the .md file.
 * - The final positional argument is the user-prompt TASK.
 */
export function buildCliArgs(
  subagentRef: string,
  task: TaskContext,
  opts: BuildCliArgsOpts = {},
): string[] {
  assertSubagentRef(subagentRef);
  const runtimeContext = buildRuntimeContext(task);
  const userPrompt = buildTaskPrompt(task);

  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--agent', subagentRef,
    '--append-system-prompt', runtimeContext,
  ];

  if (opts.model) {
    args.push('--model', opts.model);
  }

  if (opts.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  // The user prompt is the positional argument
  args.push(userPrompt);

  return args;
}

/**
 * Spawn a Claude Code CLI session for an agent task.
 *
 * This is the main entry point. It:
 * 1. Validates inputs
 * 2. Builds CLI arguments from the subagent slug + task
 * 3. Spawns the CLI process
 * 4. Captures stdout/stderr
 * 5. Enforces a timeout (kills process if exceeded)
 * 6. Returns a structured SessionResult
 *
 * The `spawnFn` parameter allows injecting a mock for testing.
 */
export async function launchSession(
  agentId: string,
  subagentRef: string,
  task: TaskContext,
  opts: LaunchSessionOpts = {},
): Promise<SessionResult> {
  if (!agentId) throw new Error('agentId is required');
  assertSubagentRef(subagentRef);
  if (!task) throw new Error('task is required');

  const cli = opts.cli || DEFAULT_CLI;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn: SpawnFn = opts.spawnFn || (nodeSpawn as unknown as SpawnFn);
  const executionLogWriter = opts.executionLogWriter || null;

  const cliArgs = buildCliArgs(subagentRef, task, {
    model: opts.model,
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
  });

  const startedAt = new Date().toISOString();

  return new Promise<SessionResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    };

    if (opts.cwd) {
      spawnOpts.cwd = opts.cwd;
    }

    let child: ChildProcess;
    try {
      child = spawnFn(cli, cliArgs, spawnOpts);
    } catch (err) {
      reject(new Error(`Failed to spawn CLI process: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    // Timeout handler
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          // Give it 5s to clean up, then SIGKILL
          setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already dead */ }
          }, 5000);
        }, timeoutMs)
      : null;

    // Stream-json emits one event per line. We consume stdout via readline
    // so the execution-log writer sees each event atomically and we still
    // accumulate the full stdout for parseTokenUsage fallbacks.
    if (!child.stdout) {
      reject(new Error('Spawned child has no stdout stream'));
      return;
    }
    if (!child.stderr) {
      reject(new Error('Spawned child has no stderr stream'));
      return;
    }
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      stdout += line + '\n';
      if (executionLogWriter) {
        try {
          executionLogWriter.writeLine(line);
        } catch {
          // Writer failures must not kill the session. Persistence is
          // best-effort — the session's primary job is running the task.
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: Error) => {
      if (timer) clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`CLI process error: ${err.message}`));
      }
    });

    // Resolve only when both the child has exited AND readline has flushed
    // any buffered stdout lines. Otherwise we may race past trailing events
    // (notably the final `{type:"result"}` event that carries token usage).
    let childExitCode: number | null = null;
    let childExited = false;
    let rlClosed = false;

    const maybeResolve = () => {
      if (!childExited || !rlClosed) return;
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;

      const completedAt = new Date().toISOString();
      const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

      resolve({
        agentId,
        subagentRef,
        taskId: task.taskId,
        stdout,
        stderr,
        exitCode: childExitCode,
        timedOut,
        startedAt,
        completedAt,
        durationMs,
        cliArgs,
      });
    };

    rl.on('close', () => {
      rlClosed = true;
      maybeResolve();
    });

    child.on('close', (exitCode: number | null) => {
      childExitCode = exitCode;
      childExited = true;
      maybeResolve();
    });
  });
}

/**
 * Build a session launch config from agent config and selected task.
 *
 * Convenience function that extracts the subagent slug and task context
 * from the data structures used by the heartbeat system. The returned
 * shape is intentionally minimal — agentId, subagentRef, and a task
 * context object. Identity, system prompt, model, and tools are NOT
 * sourced from agent JSON; they live in `.claude/agents/<slug>.md`.
 */
export function buildSessionConfig(
  agentConfig: BuildSessionAgentConfig | null | undefined,
  selectedTask: BuildSessionSelectedTask | null | undefined,
  opts: BuildSessionConfigOpts = {},
): SessionConfig {
  if (!agentConfig) throw new Error('agentConfig is required');
  if (!agentConfig.id) throw new Error('agentConfig.id is required');
  if (!agentConfig.subagentRef) throw new Error('agentConfig.subagentRef is required');
  if (!selectedTask) throw new Error('selectedTask is required');
  if (!selectedTask.id) throw new Error('selectedTask.id is required');
  if (!selectedTask.prompt) throw new Error('selectedTask.prompt is required');

  return {
    agentId: agentConfig.id,
    subagentRef: agentConfig.subagentRef,
    task: {
      taskId: selectedTask.id,
      title: selectedTask.title,
      prompt: selectedTask.prompt,
      objectiveId: selectedTask.objectiveId,
      week: opts.week,
      additionalContext: opts.additionalContext,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Project Claude Session (Slack execution surface)
// ──────────────────────────────────────────────────────────────────────
//
// The functions below are the CLI driver for the Slack channel adapter
// (`src/channels/slack/project-claude-backend.ts`). They are
// intentionally separate from `launchSession` above:
//
//   - `launchSession` is the heartbeat path: subagent-scoped, task-shaped,
//     persisted to per-agent execution logs, accounted against per-agent
//     weekly budgets.
//   - `spawnProjectClaudeSession` is the Slack path: project-level
//     Claude (no `--agent`), conversational prompt piped via stdin,
//     persisted under `.aweek/channels/slack/`, isolated from the
//     heartbeat lock and budget.
//
// Both share the spawn-based CLI plumbing (`SpawnFn`, `nodeSpawn`,
// readline-driven NDJSON capture) which is why this lives in the same
// module — but their argv shape, lifecycle, and accounting paths
// diverge so the helpers stay distinct.

/**
 * Options for {@link buildProjectClaudeCliArgs}. All fields optional;
 * an empty object yields the project-Claude default argv.
 */
export interface BuildProjectClaudeCliArgsOpts {
  /**
   * Resume an existing Claude Code CLI session id. Set on every turn
   * after the first; omitted on the first turn so the CLI mints a new
   * session id we can persist for the thread.
   */
  resumeSessionId?: string;
  /**
   * Slack-mode banner appended to the system prompt via
   * `--append-system-prompt`. Empty / undefined are treated identically
   * (the flag is omitted entirely so the CLI uses its own default).
   */
  systemPromptAppend?: string;
  /** Optional model override (e.g. `'opus'`, `'sonnet'`). */
  model?: string;
}

/**
 * Build the argv for a Slack-driven project-level Claude CLI invocation.
 *
 * Fixed flags (always present):
 *   - `--print` — non-interactive run; exit when the turn completes.
 *   - `--output-format stream-json --verbose` — one NDJSON event per
 *     line covering system init, every assistant block, every tool_use
 *     / tool_result, and the final `{type:"result"}` event with token
 *     usage. Verbose is required by the CLI under `--print stream-json`.
 *   - `--dangerously-skip-permissions` — Slack-mode bypass. The Slack
 *     thread is the human-in-the-loop, not a CLI approval prompt;
 *     mirrors `permissionMode='bypassPermissions'` +
 *     `allowDangerouslySkipPermissions=true` from
 *     `src/serve/data/chat.ts`.
 *
 * Conditional flags:
 *   - `--resume <id>` — appended only when `resumeSessionId` is set.
 *   - `--append-system-prompt <banner>` — appended only when
 *     `systemPromptAppend` is a non-empty string.
 *   - `--model <name>` — appended only when `model` is set.
 *
 * v1 NEVER appends `--agent`: subagent identities are not directly
 * addressable from Slack. Project Claude reaches them transitively via
 * `Task()` / `aweek exec` under bypassPermissions.
 */
export function buildProjectClaudeCliArgs(
  opts: BuildProjectClaudeCliArgsOpts = {},
): string[] {
  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }

  if (
    typeof opts.systemPromptAppend === 'string' &&
    opts.systemPromptAppend.length > 0
  ) {
    args.push('--append-system-prompt', opts.systemPromptAppend);
  }

  if (opts.model) {
    args.push('--model', opts.model);
  }

  return args;
}

/**
 * Options for {@link spawnProjectClaudeSession}.
 */
export interface SpawnProjectClaudeSessionOpts
  extends BuildProjectClaudeCliArgsOpts {
  /**
   * Working directory for the spawned CLI — the aweek project root.
   * The CLI inherits this path so `Task()` / `aweek exec` invocations
   * land in the right `.claude/agents/` and `.aweek/` trees.
   */
  cwd: string;
  /**
   * Prompt text. Piped verbatim to the child's stdin and stdin is then
   * closed. Stdin piping (instead of a positional argv) avoids quoting
   * traps for free-form Slack messages that may contain newlines,
   * single/double quotes, or shell metacharacters.
   */
  prompt: string;
  /** Optional CLI binary override (default: `'claude'`). */
  cli?: string;
  /** Additional environment variables merged onto `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Abort signal — when fired, the child receives `SIGTERM`, then
   * `SIGKILL` after a 5s grace period if it has not exited cleanly.
   * Idempotent: aborting twice is a no-op. Aborting after the child
   * has already exited is also a no-op.
   *
   * The promise still resolves once the child has actually exited (it
   * does NOT reject on abort) — this lets the caller distinguish
   * "killed cleanly" (`killed: true, exitCode: null`) from "errored"
   * (rejection).
   */
  signal?: AbortSignal;
  /**
   * Per-line stdout callback. Invoked once per stream-json NDJSON event
   * the CLI emits, in arrival order, with no internal buffering.
   * Callbacks that throw are swallowed so a downstream parsing bug
   * cannot orphan the spawned process.
   */
  onStdoutLine?: (line: string) => void;
  /**
   * Per-chunk stderr callback. Invoked with each decoded UTF-8 chunk
   * the CLI writes to stderr. The same content is also accumulated
   * into the resolved {@link SpawnProjectClaudeSessionResult.stderr}
   * for callers that prefer the buffered form.
   */
  onStderrChunk?: (chunk: string) => void;
  /** Injectable spawn function (testing seam). */
  spawnFn?: SpawnFn;
}

/**
 * Result of a {@link spawnProjectClaudeSession} call.
 */
export interface SpawnProjectClaudeSessionResult {
  /** Exit code reported by the child, or `null` if it was killed. */
  exitCode: number | null;
  /** True when the child was terminated via the AbortSignal. */
  killed: boolean;
  /** Full stderr capture (also delivered live via `onStderrChunk`). */
  stderr: string;
  /** Argv actually passed to spawn (for debugging / log trails). */
  cliArgs: string[];
}

/**
 * Spawn `claude --print --output-format stream-json --verbose ...` in
 * the aweek project root, pipe `prompt` to stdin, stream stdout NDJSON
 * lines back through `onStdoutLine`, and resolve with the final exit
 * code + buffered stderr.
 *
 * Designed for the Slack execution surface: project-level Claude (no
 * `--agent`), `--resume <id>` reuse for thread continuity, and
 * abort-driven termination so a stalled CLI cannot pin a Slack
 * thread's per-thread lock indefinitely.
 *
 * Lifecycle / failure modes:
 *
 *   - **Synchronous spawn failure** — `spawnFn` throws (e.g.
 *     `spawn ENOENT` because `claude` is not on PATH). The promise
 *     rejects with `Failed to spawn CLI process: <message>`.
 *
 *   - **Asynchronous child error** — the child emits an `'error'`
 *     event before close. The promise rejects with
 *     `CLI process error: <message>`.
 *
 *   - **Abort before spawn** — `opts.signal.aborted === true` on
 *     entry. The promise resolves immediately with
 *     `{ killed: true, exitCode: null, stderr: '', cliArgs }` and no
 *     child is spawned.
 *
 *   - **Abort during run** — `signal` fires while the child is alive.
 *     We deliver `SIGTERM` and start a 5s timer; if the child still
 *     hasn't exited we deliver `SIGKILL`. The promise resolves once
 *     the child actually closes, with `killed: true`.
 *
 *   - **Non-zero exit code** — the child runs to completion but exits
 *     with `code !== 0`. The promise resolves normally — non-zero is
 *     the caller's policy decision (e.g. emit an `error` AgentStreamEvent
 *     to Slack), not a spawn failure.
 *
 *   - **Clean exit** — the child closes with exit code 0. The promise
 *     resolves with `{ killed: false, exitCode: 0, ... }` once both
 *     the child has closed AND readline has flushed any buffered
 *     stdout lines (otherwise the trailing `{type:"result"}` NDJSON
 *     event can race past the resolver).
 */
export async function spawnProjectClaudeSession(
  opts: SpawnProjectClaudeSessionOpts,
): Promise<SpawnProjectClaudeSessionResult> {
  if (!opts) throw new Error('spawnProjectClaudeSession: opts is required');
  if (!opts.cwd) throw new Error('spawnProjectClaudeSession: cwd is required');
  if (typeof opts.prompt !== 'string') {
    throw new Error('spawnProjectClaudeSession: prompt must be a string');
  }

  const cliArgs = buildProjectClaudeCliArgs({
    resumeSessionId: opts.resumeSessionId,
    systemPromptAppend: opts.systemPromptAppend,
    model: opts.model,
  });

  // Fast path: caller already aborted before we did any work. Skip the
  // spawn entirely and report `killed: true` so the caller can short
  // circuit identically to the post-spawn abort branch.
  if (opts.signal?.aborted) {
    return { exitCode: null, killed: true, stderr: '', cliArgs };
  }

  const cli = opts.cli || DEFAULT_CLI;
  const spawnFn: SpawnFn = opts.spawnFn || (nodeSpawn as unknown as SpawnFn);

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...opts.env },
  };

  return new Promise<SpawnProjectClaudeSessionResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(cli, cliArgs, spawnOpts);
    } catch (err) {
      reject(
        new Error(
          `Failed to spawn CLI process: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
      return;
    }

    if (!child.stdout) {
      reject(new Error('Spawned child has no stdout stream'));
      return;
    }
    if (!child.stderr) {
      reject(new Error('Spawned child has no stderr stream'));
      return;
    }
    if (!child.stdin) {
      reject(new Error('Spawned child has no stdin stream'));
      return;
    }

    let stderr = '';
    let killed = false;
    let settled = false;
    let childExitCode: number | null = null;
    let childExited = false;
    let rlClosed = false;
    let killTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (opts.signal) {
        opts.signal.removeEventListener('abort', onAbort);
      }
    };

    const onAbort = () => {
      if (killed || childExited) return;
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already dead — `close` will fire and we resolve normally.
      }
      // Escalate to SIGKILL if the child has not closed within 5s.
      // The timer is cleared in cleanup() if the child exits cleanly
      // before the deadline.
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already dead.
        }
      }, 5000);
    };

    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const maybeResolve = () => {
      if (!childExited || !rlClosed) return;
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode: childExitCode, killed, stderr, cliArgs });
    };

    // Stream-json emits one event per line. Use readline so the caller
    // sees each event atomically and we still resolve only after every
    // buffered line has flushed.
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (opts.onStdoutLine) {
        try {
          opts.onStdoutLine(line);
        } catch {
          // Listener errors must not abort the spawn — Slack persistence
          // and AgentStreamEvent translation live in callers, and a bug
          // there should surface as a `turn-error`, not as an orphaned
          // child process.
        }
      }
    });
    rl.on('close', () => {
      rlClosed = true;
      maybeResolve();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const str = chunk.toString();
      stderr += str;
      if (opts.onStderrChunk) {
        try {
          opts.onStderrChunk(str);
        } catch {
          // Same reasoning as onStdoutLine — never let a listener
          // bug kill the child.
        }
      }
    });

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`CLI process error: ${err.message}`));
    });

    child.on('close', (code: number | null) => {
      childExitCode = code;
      childExited = true;
      // If a kill timer is still pending, the child exited before the
      // grace window — drop the SIGKILL so we don't escalate against
      // an already-closed process.
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      maybeResolve();
    });

    // Pipe the prompt to stdin and close. EPIPE shows up if the CLI
    // exits before reading all of stdin (e.g. because `--print` rejected
    // the argv); we swallow the error event because the canonical
    // signal is the child's exit code, not the stdin write status.
    child.stdin.on('error', () => {
      // Ignored on purpose — see the comment above.
    });

    try {
      child.stdin.write(opts.prompt);
      child.stdin.end();
    } catch {
      // Same reasoning — defer to the child's exit code.
    }
  });
}

/**
 * Parse token usage from CLI session JSON output.
 *
 * Claude Code CLI with --output-format json includes token usage in its output.
 * This function extracts the total tokens used from the session output.
 */
export function parseTokenUsage(stdout: unknown): TokenUsage | null {
  if (!stdout || typeof stdout !== 'string') return null;

  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    // Claude CLI JSON output may include usage at the top level or nested
    const resultObj = parsed.result as Record<string, unknown> | undefined;
    const usage = (parsed.usage as Record<string, unknown> | undefined)
      || (resultObj && (resultObj.usage as Record<string, unknown> | undefined));
    if (!usage) return null;

    const inputTokens = (usage.input_tokens as number | undefined)
      ?? (usage.inputTokens as number | undefined)
      ?? 0;
    const outputTokens = (usage.output_tokens as number | undefined)
      ?? (usage.outputTokens as number | undefined)
      ?? 0;
    const totalTokens = inputTokens + outputTokens;
    const costUsd = (parsed.cost_usd as number | undefined)
      ?? (parsed.costUsd as number | undefined)
      ?? (usage.cost_usd as number | undefined)
      ?? 0;

    return { inputTokens, outputTokens, totalTokens, costUsd };
  } catch {
    // Output may contain multiple JSON objects or non-JSON content
    // Try line-by-line parsing for streaming JSON output
    const lines = stdout.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = JSON.parse(lines[i]) as Record<string, unknown>;
        const lineResult = line.result as Record<string, unknown> | undefined;
        const lineUsage = (line.usage as Record<string, unknown> | undefined)
          || (lineResult && (lineResult.usage as Record<string, unknown> | undefined));
        if (lineUsage) {
          const usage = lineUsage;
          const inputTokens = (usage.input_tokens as number | undefined)
            ?? (usage.inputTokens as number | undefined)
            ?? 0;
          const outputTokens = (usage.output_tokens as number | undefined)
            ?? (usage.outputTokens as number | undefined)
            ?? 0;
          return {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            costUsd: (line.cost_usd as number | undefined)
              ?? (line.costUsd as number | undefined)
              ?? (usage.cost_usd as number | undefined)
              ?? 0,
          };
        }
      } catch {
        continue;
      }
    }
    return null;
  }
}
