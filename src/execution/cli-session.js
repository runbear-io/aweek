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
import { createInterface } from 'node:readline';

/** Default CLI binary name */
const DEFAULT_CLI = 'claude';

/** Default session timeout: 30 minutes (in ms) */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * @typedef {object} TaskContext
 * @property {string} taskId - Unique task identifier
 * @property {string} [title] - Short calendar label (used in log lines)
 * @property {string} prompt - Long-form instruction text handed to Claude
 * @property {string} [objectiveId] - Parent objective ID for traceability
 * @property {string} [week] - The plan week (YYYY-Www)
 * @property {string} [additionalContext] - Extra context to append to the prompt
 */

/**
 * @typedef {object} SessionResult
 * @property {string} agentId - The agent that ran
 * @property {string} subagentRef - The subagent slug used for `--agent`
 * @property {string} taskId - The task that was executed
 * @property {string} stdout - Captured standard output
 * @property {string} stderr - Captured standard error
 * @property {number|null} exitCode - Process exit code (null if killed)
 * @property {boolean} timedOut - Whether the session was killed due to timeout
 * @property {string} startedAt - ISO timestamp
 * @property {string} completedAt - ISO timestamp
 * @property {number} durationMs - Wall-clock duration in milliseconds
 * @property {string[]} cliArgs - The CLI arguments used (for debugging)
 */

/**
 * Validate that a subagent reference is a non-empty string.
 *
 * We intentionally DO NOT re-validate the slug pattern here — the aweek
 * JSON schema and subagent-file primitives own slug validation at
 * write-time, so by the time we reach the launcher the slug is already
 * trusted. This keeps the CLI launcher decoupled from the schema layer
 * while still failing loudly on obviously bad input.
 *
 * @param {string} subagentRef
 */
function assertSubagentRef(subagentRef) {
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
 *
 * @param {TaskContext} task - Task context object
 * @returns {string} Composed runtime-context string
 */
export function buildRuntimeContext(task) {
  if (!task) throw new Error('task is required');
  if (!task.taskId) throw new Error('task.taskId is required');

  const lines = [
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
 *
 * @param {TaskContext} task - Task context object
 * @returns {string} Composed user prompt
 */
export function buildTaskPrompt(task) {
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
 *
 * @param {string} subagentRef - Subagent slug (e.g. "marketer")
 * @param {TaskContext} task - Task context
 * @param {object} [opts]
 * @param {string} [opts.model] - Override model (e.g. 'opus', 'sonnet')
 * @param {boolean} [opts.dangerouslySkipPermissions=false] - Skip permission prompts
 * @returns {string[]} Array of CLI arguments
 */
export function buildCliArgs(subagentRef, task, opts = {}) {
  assertSubagentRef(subagentRef);
  const runtimeContext = buildRuntimeContext(task);
  const userPrompt = buildTaskPrompt(task);

  const args = [
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
 *
 * @param {string} agentId - Agent identifier (equals subagent slug)
 * @param {string} subagentRef - Subagent slug for `--agent`
 * @param {TaskContext} task - Task context
 * @param {object} [opts]
 * @param {string} [opts.cli='claude'] - CLI binary path/name
 * @param {string} [opts.cwd] - Working directory for the CLI process
 * @param {number} [opts.timeoutMs=1800000] - Session timeout in milliseconds
 * @param {string} [opts.model] - Override model
 * @param {boolean} [opts.dangerouslySkipPermissions=false] - Skip permission prompts
 * @param {function} [opts.spawnFn] - Injectable spawn function (for testing)
 * @param {object} [opts.env] - Additional environment variables
 * @param {{writeLine: (line: string) => void}} [opts.executionLogWriter]
 *   Receives each stdout line (one stream-json event per line) as it
 *   arrives. The heartbeat passes an execution-log-store writer so the
 *   full session is persisted to
 *   `<agentsDir>/<agent>/executions/<taskId>-<executionId>.jsonl`. The
 *   writer is responsible for its own close — the launcher never calls
 *   close(), so the caller controls the file lifetime.
 * @returns {Promise<SessionResult>}
 */
export async function launchSession(agentId, subagentRef, task, opts = {}) {
  if (!agentId) throw new Error('agentId is required');
  assertSubagentRef(subagentRef);
  if (!task) throw new Error('task is required');

  const cli = opts.cli || DEFAULT_CLI;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = opts.spawnFn || nodeSpawn;
  const executionLogWriter = opts.executionLogWriter || null;

  const cliArgs = buildCliArgs(subagentRef, task, {
    model: opts.model,
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
  });

  const startedAt = new Date().toISOString();

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const spawnOpts = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    };

    if (opts.cwd) {
      spawnOpts.cwd = opts.cwd;
    }

    let child;
    try {
      child = spawnFn(cli, cliArgs, spawnOpts);
    } catch (err) {
      reject(new Error(`Failed to spawn CLI process: ${err.message}`));
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

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`CLI process error: ${err.message}`));
      }
    });

    // Resolve only when both the child has exited AND readline has flushed
    // any buffered stdout lines. Otherwise we may race past trailing events
    // (notably the final `{type:"result"}` event that carries token usage).
    let childExitCode = null;
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

    child.on('close', (exitCode) => {
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
 *
 * @param {object} agentConfig - Full agent config (from AgentStore)
 * @param {object} selectedTask - Task object (from task-selector)
 * @param {object} [opts]
 * @param {string} [opts.week] - Plan week for traceability
 * @param {string} [opts.additionalContext] - Extra context
 * @returns {{ agentId: string, subagentRef: string, task: TaskContext }}
 */
export function buildSessionConfig(agentConfig, selectedTask, opts = {}) {
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

/**
 * Parse token usage from CLI session JSON output.
 *
 * Claude Code CLI with --output-format json includes token usage in its output.
 * This function extracts the total tokens used from the session output.
 *
 * @param {string} stdout - Raw stdout from the CLI session
 * @returns {{ inputTokens: number, outputTokens: number, totalTokens: number, costUsd: number } | null}
 */
export function parseTokenUsage(stdout) {
  if (!stdout || typeof stdout !== 'string') return null;

  try {
    const parsed = JSON.parse(stdout);

    // Claude CLI JSON output may include usage at the top level or nested
    const usage = parsed.usage || parsed.result?.usage;
    if (!usage) return null;

    const inputTokens = usage.input_tokens || usage.inputTokens || 0;
    const outputTokens = usage.output_tokens || usage.outputTokens || 0;
    const totalTokens = inputTokens + outputTokens;
    const costUsd = parsed.cost_usd || parsed.costUsd || usage.cost_usd || 0;

    return { inputTokens, outputTokens, totalTokens, costUsd };
  } catch {
    // Output may contain multiple JSON objects or non-JSON content
    // Try line-by-line parsing for streaming JSON output
    const lines = stdout.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = JSON.parse(lines[i]);
        if (line.usage || line.result?.usage) {
          const usage = line.usage || line.result.usage;
          const inputTokens = usage.input_tokens || usage.inputTokens || 0;
          const outputTokens = usage.output_tokens || usage.outputTokens || 0;
          return {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            costUsd: line.cost_usd || line.costUsd || usage.cost_usd || 0,
          };
        }
      } catch {
        continue;
      }
    }
    return null;
  }
}
