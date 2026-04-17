/**
 * CLI Session Launcher — spawns Claude Code CLI processes for agent task execution.
 *
 * Responsibilities:
 * - Build CLI arguments from agent identity (system prompt, name, role) and task context
 * - Spawn `claude` CLI as a child process with proper argument injection
 * - Capture stdout/stderr output for downstream token-usage parsing
 * - Return structured session results (output, exit code, duration)
 * - Support configurable CLI path, working directory, and timeout
 *
 * Design:
 * - spawn function is injectable for testability (no real CLI needed in tests)
 * - All arguments are validated before spawning
 * - Idempotent: launching the same task twice produces independent sessions
 * - File source of truth: session results are returned for the caller to persist
 */

import { spawn as nodeSpawn } from 'node:child_process';

/** Default CLI binary name */
const DEFAULT_CLI = 'claude';

/** Default session timeout: 30 minutes (in ms) */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * @typedef {object} AgentIdentity
 * @property {string} name - Agent display name
 * @property {string} role - Agent role description
 * @property {string} systemPrompt - System prompt injected into the CLI session
 */

/**
 * @typedef {object} TaskContext
 * @property {string} taskId - Unique task identifier
 * @property {string} description - Human-readable task description
 * @property {string} [objectiveId] - Parent objective ID for traceability
 * @property {string} [week] - The plan week (YYYY-Www)
 * @property {string} [additionalContext] - Extra context to append to the prompt
 */

/**
 * @typedef {object} SessionResult
 * @property {string} agentId - The agent that ran
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
 * Build the system prompt string that includes agent identity context.
 *
 * The system prompt combines the agent's configured system prompt with
 * identity metadata so the CLI session "knows who it is".
 *
 * @param {AgentIdentity} identity - Agent identity object
 * @returns {string} Composed system prompt
 */
export function buildSystemPrompt(identity) {
  if (!identity) throw new Error('identity is required');
  if (!identity.name) throw new Error('identity.name is required');
  if (!identity.role) throw new Error('identity.role is required');
  if (!identity.systemPrompt) throw new Error('identity.systemPrompt is required');

  return [
    `You are ${identity.name}, a ${identity.role}.`,
    '',
    identity.systemPrompt,
  ].join('\n');
}

/**
 * Build the user prompt string from task context.
 *
 * Constructs a clear, structured prompt that tells the agent what to do.
 *
 * @param {TaskContext} task - Task context object
 * @returns {string} Composed user prompt
 */
export function buildTaskPrompt(task) {
  if (!task) throw new Error('task is required');
  if (!task.taskId) throw new Error('task.taskId is required');
  if (!task.description) throw new Error('task.description is required');

  const lines = [
    `## Task: ${task.description}`,
    '',
    `Task ID: ${task.taskId}`,
  ];

  if (task.objectiveId) {
    lines.push(`Objective ID: ${task.objectiveId}`);
  }
  if (task.week) {
    lines.push(`Week: ${task.week}`);
  }
  if (task.additionalContext) {
    lines.push('', '## Additional Context', '', task.additionalContext);
  }

  lines.push(
    '',
    '## Instructions',
    '',
    'Execute this task thoroughly. When complete, summarize what was accomplished.',
    'If you encounter blockers, explain them clearly.'
  );

  return lines.join('\n');
}

/**
 * Build CLI arguments array for the `claude` command.
 *
 * Constructs the argument list:
 *   claude --print --system-prompt "<system>" "<user prompt>"
 *
 * Uses --print for non-interactive (single-shot) execution and
 * --output-format json to get structured output for token parsing.
 *
 * @param {AgentIdentity} identity - Agent identity
 * @param {TaskContext} task - Task context
 * @param {object} [opts]
 * @param {boolean} [opts.verbose=false] - Include --verbose flag
 * @param {string} [opts.model] - Override model (e.g., 'opus', 'sonnet')
 * @param {boolean} [opts.dangerouslySkipPermissions=false] - Skip permission prompts
 * @returns {string[]} Array of CLI arguments
 */
export function buildCliArgs(identity, task, opts = {}) {
  const systemPrompt = buildSystemPrompt(identity);
  const userPrompt = buildTaskPrompt(task);

  const args = [
    '--print',
    '--output-format', 'json',
    '--system-prompt', systemPrompt,
  ];

  if (opts.model) {
    args.push('--model', opts.model);
  }

  if (opts.verbose) {
    args.push('--verbose');
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
 * 2. Builds CLI arguments from identity + task
 * 3. Spawns the CLI process
 * 4. Captures stdout/stderr
 * 5. Enforces a timeout (kills process if exceeded)
 * 6. Returns a structured SessionResult
 *
 * The `spawnFn` parameter allows injecting a mock for testing.
 *
 * @param {string} agentId - Agent identifier
 * @param {AgentIdentity} identity - Agent identity
 * @param {TaskContext} task - Task context
 * @param {object} [opts]
 * @param {string} [opts.cli='claude'] - CLI binary path/name
 * @param {string} [opts.cwd] - Working directory for the CLI process
 * @param {number} [opts.timeoutMs=1800000] - Session timeout in milliseconds
 * @param {boolean} [opts.verbose=false] - Pass --verbose to CLI
 * @param {string} [opts.model] - Override model
 * @param {boolean} [opts.dangerouslySkipPermissions=false] - Skip permission prompts
 * @param {function} [opts.spawnFn] - Injectable spawn function (for testing)
 * @param {object} [opts.env] - Additional environment variables
 * @returns {Promise<SessionResult>}
 */
export async function launchSession(agentId, identity, task, opts = {}) {
  if (!agentId) throw new Error('agentId is required');
  if (!identity) throw new Error('identity is required');
  if (!task) throw new Error('task is required');

  const cli = opts.cli || DEFAULT_CLI;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = opts.spawnFn || nodeSpawn;

  const cliArgs = buildCliArgs(identity, task, {
    verbose: opts.verbose,
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

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
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

    child.on('close', (exitCode) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;

      const completedAt = new Date().toISOString();
      const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

      resolve({
        agentId,
        taskId: task.taskId,
        stdout,
        stderr,
        exitCode,
        timedOut,
        startedAt,
        completedAt,
        durationMs,
        cliArgs,
      });
    });
  });
}

/**
 * Build a session launch config from agent config and selected task.
 *
 * Convenience function that extracts identity and task context from
 * the data structures used by the heartbeat system.
 *
 * @param {object} agentConfig - Full agent config (from AgentStore)
 * @param {object} selectedTask - Task object (from task-selector)
 * @param {object} [opts]
 * @param {string} [opts.week] - Plan week for traceability
 * @param {string} [opts.additionalContext] - Extra context
 * @returns {{ agentId: string, identity: AgentIdentity, task: TaskContext }}
 */
export function buildSessionConfig(agentConfig, selectedTask, opts = {}) {
  if (!agentConfig) throw new Error('agentConfig is required');
  if (!agentConfig.id) throw new Error('agentConfig.id is required');
  if (!agentConfig.identity) throw new Error('agentConfig.identity is required');
  if (!selectedTask) throw new Error('selectedTask is required');
  if (!selectedTask.id) throw new Error('selectedTask.id is required');
  if (!selectedTask.description) throw new Error('selectedTask.description is required');

  return {
    agentId: agentConfig.id,
    identity: {
      name: agentConfig.identity.name,
      role: agentConfig.identity.role,
      systemPrompt: agentConfig.identity.systemPrompt,
    },
    task: {
      taskId: selectedTask.id,
      description: selectedTask.description,
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
