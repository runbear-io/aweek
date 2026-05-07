/**
 * Post-execution task verifier.
 *
 * Asks an Anthropic model to judge whether a completed task actually
 * achieved the outcome the user described. The heartbeat marks a task
 * `completed` whenever the underlying CLI session does not throw — but
 * "no thrown error" does not mean "the agent did the thing". A task
 * that says *"publish a post on X about the new feature"* may end with
 * exit code 0 yet never actually invoke a publish tool; the user wants
 * to be warned about that.
 *
 * The verifier is intentionally lightweight: one short SDK call per
 * completed task, returning structured JSON. It is **best-effort** —
 * any exception, unparseable response, or missing SDK collapses to a
 * `skipped` result and the heartbeat tick continues normally.
 *
 * @module services/task-verifier
 */

import type {
  Options as AgentSdkOptions,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Test-injectable Agent SDK runner — same shape as `AgentSdkRunner` in
 * `src/serve/data/chat.ts` but copied here to keep `src/services/`
 * independent of the dashboard's HTTP layer.
 */
export type TaskVerifierRunner = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: AgentSdkOptions;
}) => AsyncIterable<SDKMessage>;

/**
 * Inputs to the verifier. The verifier reads the task description and
 * the agent's stdout transcript and judges whether the task's stated
 * outcome was achieved.
 */
export interface VerifyTaskOutcomeInput {
  /** Identifying fields used only for log prefixes. */
  taskId: string;
  /** Short label shown to the verifier as the task summary. */
  title: string;
  /** Long-form prompt the heartbeat sent to the agent. */
  prompt: string;
  /**
   * Captured stdout from the agent's CLI session. Truncated by the
   * caller — the verifier additionally caps the embedded copy at
   * {@link MAX_OUTPUT_CHARS} so very long transcripts don't bloat
   * the verifier prompt.
   */
  output: string;
  /** Optional captured stderr (concatenated after stdout). */
  stderr?: string;
  /** Optional working directory passed through to the SDK runner. */
  cwd?: string;
  /** Test seam — defaults to the lazy-loaded real SDK runner. */
  runQuery?: TaskVerifierRunner;
  /** Abort signal — fires when the heartbeat tick is cancelled. */
  signal?: AbortSignal;
}

/**
 * Outcome verdict. `kind === 'verdict'` carries the structured judgement;
 * `kind === 'skipped'` means the verifier could not complete (no SDK,
 * unparseable response, abort, exception) and the caller should leave
 * the task's `outcomeAchieved` / `warnings` fields untouched.
 */
export type TaskVerifierResult =
  | {
      kind: 'verdict';
      achieved: boolean;
      concerns: string[];
    }
  | {
      kind: 'skipped';
      reason: string;
    };

/**
 * Cap on the embedded stdout/stderr length. Picked to comfortably fit
 * the verifier prompt within a single short call; tasks with very long
 * transcripts get truncated tail-first since the final lines usually
 * carry the actionable signal (publish confirmations, error trailers).
 */
const MAX_OUTPUT_CHARS = 8000;

/** Cap on the number of distinct concerns the verifier can return. */
const MAX_CONCERNS = 5;

/**
 * Cached lazy-loaded default runner — the SDK pulls in zod and the MCP
 * SDK at import time, so we defer the cost until the first verifier
 * call fires. Once loaded the runner is cached for the process
 * lifetime.
 */
let cachedDefaultRunner: TaskVerifierRunner | null = null;

async function getDefaultRunner(): Promise<TaskVerifierRunner> {
  if (cachedDefaultRunner) return cachedDefaultRunner;
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  cachedDefaultRunner = (params) => sdk.query(params);
  return cachedDefaultRunner;
}

/**
 * Build the prompt that asks the verifier to judge the agent's output.
 * Exported for tests so they can pin the prompt format without poking
 * the runner directly.
 */
export function buildVerifierPrompt(input: VerifyTaskOutcomeInput): string {
  const truncatedOutput = truncateForPrompt(input.output);
  const stderrBlock =
    input.stderr && input.stderr.length > 0
      ? `\n\n[Captured stderr]\n${truncateForPrompt(input.stderr)}`
      : '';
  return [
    'You are a strict task-outcome verifier. Read the task description and',
    'the agent\'s captured output, then judge whether the task\'s stated',
    'outcome was actually achieved.',
    '',
    'Reply with a SINGLE JSON object on one line, no prose, no code fences:',
    '{"achieved": <boolean>, "concerns": [<short concern strings>]}',
    '',
    'Rules:',
    '- "achieved" is true ONLY when the captured output contains evidence',
    '  the stated outcome happened (a tool call ran, a file was written,',
    '  a post was published, etc.). Plans, intentions, and "I will…"',
    '  language are NOT evidence.',
    '- Each concern is at most 200 characters and describes ONE specific',
    `  problem. Cap the array at ${MAX_CONCERNS} entries.`,
    '- If the agent succeeded, return {"achieved": true, "concerns": []}.',
    '- Do NOT include trailing commentary or markdown — JSON only.',
    '',
    `[Task title]\n${input.title}`,
    '',
    `[Task prompt]\n${input.prompt}`,
    '',
    `[Captured stdout]\n${truncatedOutput}${stderrBlock}`,
  ].join('\n');
}

function truncateForPrompt(text: string): string {
  if (typeof text !== 'string') return '';
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  // Tail-first truncation — the last bytes of a CLI session are
  // typically the most actionable (publish confirmations, error
  // trailers, exit summaries).
  return `…[truncated ${text.length - MAX_OUTPUT_CHARS} chars]…\n${text.slice(
    -MAX_OUTPUT_CHARS,
  )}`;
}

/**
 * Run the verifier and return its verdict. Best-effort: returns a
 * `skipped` result on any failure so the heartbeat tick keeps moving.
 */
export async function verifyTaskOutcome(
  input: VerifyTaskOutcomeInput,
): Promise<TaskVerifierResult> {
  if (input.signal?.aborted) {
    return { kind: 'skipped', reason: 'aborted-before-start' };
  }

  let runner: TaskVerifierRunner;
  try {
    runner = input.runQuery ?? (await getDefaultRunner());
  } catch (err) {
    return {
      kind: 'skipped',
      reason: `sdk-load-failed: ${errMsg(err)}`,
    };
  }

  const prompt = buildVerifierPrompt(input);

  const options: AgentSdkOptions = {};
  if (input.cwd !== undefined) options.cwd = input.cwd;
  // Constrain the verifier — no tool calls, no MCP, no preamble. We
  // just want the model to judge the captured transcript and emit JSON.
  options.allowedTools = [];

  let buffer = '';
  try {
    for await (const message of runner({ prompt, options })) {
      if (input.signal?.aborted) {
        return { kind: 'skipped', reason: 'aborted-mid-stream' };
      }
      buffer += extractAssistantText(message);
    }
  } catch (err) {
    return {
      kind: 'skipped',
      reason: `verifier-stream-failed: ${errMsg(err)}`,
    };
  }

  return parseVerifierVerdict(buffer);
}

/**
 * Concatenate text content from a single assistant SDK message. Other
 * message types (system init, tool calls, etc.) are ignored — the
 * verifier prompt forbids tool calls so any non-text content is noise
 * we don't care about.
 */
function extractAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return '';
  const content = message.message?.content;
  if (!Array.isArray(content)) return '';
  let acc = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      acc += block.text;
    }
  }
  return acc;
}

/**
 * Parse the verifier's response. Tolerant of leading/trailing whitespace,
 * accidental code fences, and stray prose preceding the JSON object —
 * we extract the first balanced `{…}` substring and parse that.
 *
 * Exported for unit tests.
 */
export function parseVerifierVerdict(raw: string): TaskVerifierResult {
  const text = (raw ?? '').trim();
  if (text.length === 0) {
    return { kind: 'skipped', reason: 'empty-verifier-response' };
  }
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    return { kind: 'skipped', reason: 'no-json-object-in-response' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch (err) {
    return {
      kind: 'skipped',
      reason: `unparseable-verifier-json: ${errMsg(err)}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { kind: 'skipped', reason: 'verdict-not-object' };
  }
  const obj = parsed as Record<string, unknown>;
  const achieved = typeof obj['achieved'] === 'boolean' ? obj['achieved'] : null;
  if (achieved === null) {
    return { kind: 'skipped', reason: 'verdict-missing-achieved' };
  }
  const rawConcerns = Array.isArray(obj['concerns']) ? obj['concerns'] : [];
  const concerns: string[] = [];
  for (const entry of rawConcerns) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    concerns.push(trimmed.slice(0, 200));
    if (concerns.length >= MAX_CONCERNS) break;
  }
  // Sanity: when achieved is true, drop any leftover concerns —
  // contradiction means the model is confused; trust the boolean.
  if (achieved && concerns.length > 0) {
    return { kind: 'verdict', achieved: true, concerns: [] };
  }
  return { kind: 'verdict', achieved, concerns };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
