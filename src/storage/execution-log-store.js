/**
 * Per-execution CLI execution-log storage.
 *
 * Each Claude Code CLI session the heartbeat spawns for a task writes a
 * full NDJSON execution log to
 *
 *   <agentsDir>/<agentId>/executions/<taskId>-<executionId>.jsonl
 *
 * One line per `stream-json` event emitted by the CLI (system init, user
 * prompt, assistant turn with tool_use blocks, user turn with tool_result
 * blocks, final result + usage). The secret redactor runs on each line
 * before it's written, so obvious API-key shapes are scrubbed at source.
 *
 * The dashboard reads these files back to render a task-detail execution
 * log view. Missing files are treated as "no execution log captured for
 * this execution" (older runs or sessions that crashed before any event
 * arrived), and the reader returns an empty iterator rather than
 * throwing.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import { redactLine } from '../execution/secret-redactor.js';

/**
 * Absolute path to an execution's execution-log file. Keeps the naming
 * flat (`<taskId>-<executionId>.jsonl`) so discovery by taskId is a cheap
 * glob — no need to walk per-run subdirectories.
 *
 * @param {string} agentsDir `.aweek/agents` root
 * @param {string} agentId
 * @param {string} taskId
 * @param {string} executionId
 * @returns {string}
 */
export function executionLogPath(agentsDir, agentId, taskId, executionId) {
  if (!agentsDir) throw new TypeError('agentsDir is required');
  if (!agentId) throw new TypeError('agentId is required');
  if (!taskId) throw new TypeError('taskId is required');
  if (!executionId) throw new TypeError('executionId is required');
  // Use `_` as the separator between taskId and executionId because both
  // IDs contain `-` (taskId pattern `task-<slug>`, executionId shape
  // `session-<timestamp>`). `_` cannot appear in a valid taskId, so the
  // first `_` unambiguously splits the basename back into its parts when
  // the dashboard resolves a URL.
  return join(agentsDir, agentId, 'executions', `${taskId}_${executionId}.jsonl`);
}

/**
 * Open an append-mode writer for a new execution log. Caller is
 * responsible for calling `close()` when the session ends. Every line
 * passed to `writeLine` is routed through the secret redactor before
 * hitting disk.
 *
 * @param {string} agentsDir
 * @param {string} agentId
 * @param {string} taskId
 * @param {string} executionId
 * @returns {Promise<{ writeLine: (line: string) => void, close: () => Promise<void>, path: string }>}
 */
export async function openExecutionLogWriter(agentsDir, agentId, taskId, executionId) {
  const path = executionLogPath(agentsDir, agentId, taskId, executionId);
  await mkdir(dirname(path), { recursive: true });

  const stream = createWriteStream(path, { flags: 'a', encoding: 'utf8' });

  const writeLine = (line) => {
    if (typeof line !== 'string' || line.length === 0) return;
    const redacted = redactLine(line);
    stream.write(redacted.endsWith('\n') ? redacted : redacted + '\n');
  };

  const close = () =>
    new Promise((resolve, reject) => {
      stream.end((err) => (err ? reject(err) : resolve()));
    });

  return { writeLine, close, path };
}

/**
 * Check whether an execution log exists on disk. Useful for the
 * dashboard — older executions recorded before this feature landed won't
 * have a file.
 *
 * @param {string} agentsDir
 * @param {string} agentId
 * @param {string} taskId
 * @param {string} executionId
 * @returns {Promise<boolean>}
 */
export async function executionLogExists(agentsDir, agentId, taskId, executionId) {
  try {
    const s = await stat(executionLogPath(agentsDir, agentId, taskId, executionId));
    return s.isFile();
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Stream the execution-log lines back. Yields raw strings — one per
 * event in the underlying JSONL. Missing files yield nothing. Callers
 * that want parsed events can `JSON.parse` each line.
 *
 * @param {string} agentsDir
 * @param {string} agentId
 * @param {string} taskId
 * @param {string} executionId
 * @returns {AsyncGenerator<string>}
 */
export async function* readExecutionLogLines(agentsDir, agentId, taskId, executionId) {
  const path = executionLogPath(agentsDir, agentId, taskId, executionId);
  let stream;
  try {
    stream = createReadStream(path, { encoding: 'utf8' });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }

  try {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      yield line;
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}
