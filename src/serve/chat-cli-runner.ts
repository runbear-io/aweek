/**
 * Chat CLI runner — drives the Interactive Chat Panel through a
 * non-Claude execution runner (Gemini / Hermes) and translates that
 * CLI's output into the SAME {@link ChatStreamEvent} sequence the Agent
 * SDK path in `chat.ts` emits, so the SSE handler in `server.ts` consumes
 * both identically.
 *
 * Why this exists: the default chat path uses the Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`), which is Claude-only. When
 * `.aweek/config.json` (or a per-agent override) selects `gemini` or
 * `hermes`, `streamAgentTurn` delegates here instead so the chat panel
 * talks to the configured runtime — mirroring the heartbeat, which
 * already runs each runner via `src/execution/cli-session.ts`.
 *
 * Runner mapping (same identity + YOLO contract as the heartbeat):
 *   - gemini — `gemini --output-format stream-json --prompt <p> --yolo
 *     --skip-trust`; identity injected via the `GEMINI_SYSTEM_MD` env var
 *     (the subagent `.claude/agents/<slug>.md`). The NDJSON stream maps
 *     line-by-line onto ChatStreamEvents, so tokens stream live.
 *   - hermes — `hermes --oneshot <p> --yolo --accept-hooks`; identity
 *     embedded at the head of the prompt (Hermes has no system-prompt
 *     flag/env). One-shot prints only the final text with no usage
 *     metadata, so the whole reply is emitted as a single text-delta and
 *     `turn-complete` carries zero usage.
 *
 * Both runners run permission-free (YOLO): the dashboard is a single-user
 * surface over the user's own `.aweek/`, matching the heartbeat posture
 * and the Claude chat path's `bypassPermissions`.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import type { SpawnFn } from '../execution/cli-session.js';
import {
  GEMINI_SYSTEM_MD_ENV,
  RUNNER_BINARY,
} from '../execution/runner.js';
import { resolveSubagentFile, parseSubagentBody } from '../subagents/subagent-file.js';
import type { ChatStreamEvent, ChatTokenUsage } from './data/chat.js';

/** The runners this module handles (Claude uses the Agent SDK, not this). */
export type ChatCliRunnerKind = 'gemini' | 'hermes';

export interface ChatCliRunnerParams {
  /** Which non-Claude runner to spawn. */
  runner: ChatCliRunnerKind;
  /** The conversational prompt, already collapsed from the thread. */
  prompt: string;
  /** Subagent slug — used to locate `.claude/agents/<slug>.md` for identity. */
  slug: string;
  /** Working directory for the spawned CLI (the aweek project root). */
  cwd?: string;
  /** Abort signal — fires SIGTERM (then SIGKILL) at the child and ends the stream. */
  signal?: AbortSignal;
  /** Optional system preamble prepended to the prompt (first-turn context). */
  systemPromptAppend?: string;
  /** Test seam — injectable spawn (defaults to `node:child_process` spawn). */
  spawnFn?: SpawnFn;
  /** Binary override (defaults to the runner's `RUNNER_BINARY` entry). */
  cli?: string;
}

const PROMPT_SEP = '\n\n---\n\n';

/**
 * Resolve the subagent identity for a chat turn. Returns the pieces each
 * runner needs: Gemini takes the `.md` file **path** via `GEMINI_SYSTEM_MD`,
 * Hermes takes the `.md` **body** embedded in the prompt. Best-effort —
 * a missing/unreadable file leaves identity uninjected (the turn still runs).
 */
async function resolveIdentity(
  runner: ChatCliRunnerKind,
  slug: string,
  cwd: string | undefined,
): Promise<{ env: NodeJS.ProcessEnv; identityPrefix: string }> {
  try {
    const resolved = await resolveSubagentFile(slug, cwd ? { projectDir: cwd } : {});
    if (!resolved.exists) return { env: {}, identityPrefix: '' };
    const mdPath =
      resolved.location === 'user' ? resolved.userPath : resolved.projectPath;
    if (runner === 'gemini') {
      return { env: { [GEMINI_SYSTEM_MD_ENV]: mdPath }, identityPrefix: '' };
    }
    const body = parseSubagentBody(await readFile(mdPath, 'utf8'));
    return { env: {}, identityPrefix: body ? `${body}${PROMPT_SEP}` : '' };
  } catch {
    return { env: {}, identityPrefix: '' };
  }
}

/** Build the runner-appropriate argv for a raw conversational prompt. */
function buildArgs(runner: ChatCliRunnerKind, prompt: string): string[] {
  if (runner === 'gemini') {
    return ['--output-format', 'stream-json', '--prompt', prompt, '--yolo', '--skip-trust'];
  }
  // hermes
  return ['--oneshot', prompt, '--yolo', '--accept-hooks'];
}

/**
 * Translate one Gemini `stream-json` NDJSON line into zero or more
 * ChatStreamEvents. Gemini's event shapes (see the Gemini CLI's
 * StreamJsonFormatter): `init` / `message` (role assistant, delta) /
 * `tool_use` / `tool_result` / `result` (usage under `stats`).
 */
function* translateGeminiLine(
  line: string,
  turnUuid: string,
): Generator<ChatStreamEvent, void, void> {
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // non-JSON noise (e.g. a stray warning) — skip
  }
  switch (evt.type) {
    case 'init': {
      yield {
        type: 'agent-init',
        sessionId: typeof evt.session_id === 'string' ? evt.session_id : turnUuid,
        tools: [],
        cwd: typeof evt.cwd === 'string' ? evt.cwd : '',
      };
      return;
    }
    case 'message': {
      if (evt.role === 'assistant' && typeof evt.content === 'string' && evt.content.length > 0) {
        yield { type: 'text-delta', delta: evt.content, messageUuid: turnUuid };
      }
      return;
    }
    case 'tool_use': {
      const input = evt.parameters;
      yield {
        type: 'tool-use',
        toolUseId: typeof evt.tool_id === 'string' ? evt.tool_id : randomUUID(),
        name: typeof evt.tool_name === 'string' ? evt.tool_name : 'tool',
        input: input && typeof input === 'object' ? (input as Record<string, unknown>) : {},
        messageUuid: turnUuid,
      };
      return;
    }
    case 'tool_result': {
      yield {
        type: 'tool-result',
        toolUseId: typeof evt.tool_id === 'string' ? evt.tool_id : '',
        content: evt.output,
        isError: evt.status === 'error',
      };
      return;
    }
    case 'result': {
      const stats = (evt.stats as Record<string, unknown> | undefined) ?? {};
      const usage: ChatTokenUsage = {
        inputTokens: (stats.input_tokens as number | undefined) ?? 0,
        outputTokens: (stats.output_tokens as number | undefined) ?? 0,
      };
      yield {
        type: 'turn-complete',
        usage,
        durationMs: (stats.duration_ms as number | undefined) ?? 0,
        stopReason: typeof evt.status === 'string' ? evt.status : null,
      };
      return;
    }
    default:
      return;
  }
}

/**
 * Spawn the configured runner CLI and yield ChatStreamEvents as its
 * output arrives. Non-buffering for Gemini (each NDJSON line is
 * translated and yielded as it lands); Hermes one-shot emits its final
 * text once the process closes.
 */
export async function* streamCliRunnerTurn(
  params: ChatCliRunnerParams,
): AsyncGenerator<ChatStreamEvent, void, void> {
  if (params.signal?.aborted) return;

  const { env: identityEnv, identityPrefix } = await resolveIdentity(
    params.runner,
    params.slug,
    params.cwd,
  );
  if (params.signal?.aborted) return;

  const preamble =
    typeof params.systemPromptAppend === 'string' && params.systemPromptAppend.length > 0
      ? `${params.systemPromptAppend}${PROMPT_SEP}`
      : '';
  // Gemini receives identity via GEMINI_SYSTEM_MD, so only Hermes prepends it.
  const fullPrompt =
    params.runner === 'hermes'
      ? `${identityPrefix}${preamble}${params.prompt}`
      : `${preamble}${params.prompt}`;

  const args = buildArgs(params.runner, fullPrompt);
  const cli = params.cli ?? RUNNER_BINARY[params.runner];
  const spawnFn: SpawnFn = params.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  const turnUuid = randomUUID();

  // ── push/pull bridge: the readline callback pushes events; the
  // generator pulls them. A parked pull resolves the moment an event
  // lands or the child closes, so the loop never spins. ──────────────
  const queue: ChatStreamEvent[] = [];
  let finished = false;
  let wake: (() => void) | null = null;
  const emit = (e: ChatStreamEvent): void => {
    queue.push(e);
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  const finish = (): void => {
    finished = true;
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  const spawnOpts: SpawnOptions = {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...identityEnv },
  };
  if (params.cwd) spawnOpts.cwd = params.cwd;

  let child: ChildProcess;
  try {
    child = spawnFn(cli, args, spawnOpts);
  } catch (err) {
    yield {
      type: 'turn-error',
      error: `Failed to spawn ${cli}: ${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  // Hermes one-shot has no streaming JSON — accumulate stdout and emit it
  // as one message when the process closes. Gemini streams NDJSON.
  let hermesText = '';
  let emittedTerminal = false;

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (params.runner === 'gemini') {
        for (const e of translateGeminiLine(line, turnUuid)) {
          if (e.type === 'turn-complete') emittedTerminal = true;
          emit(e);
        }
      } else {
        hermesText += (hermesText ? '\n' : '') + line;
      }
    });
  }

  let stderr = '';
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
  }

  // Abort: SIGTERM now, SIGKILL after a 5s grace, then end the stream.
  let killTimer: NodeJS.Timeout | null = null;
  const onAbort = (): void => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, 5000);
  };
  params.signal?.addEventListener('abort', onAbort, { once: true });

  child.on('error', (err: Error) => {
    emit({ type: 'turn-error', error: `${cli} error: ${err.message}` });
    finish();
  });

  child.on('close', (code: number | null) => {
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (!params.signal?.aborted) {
      if (params.runner === 'hermes') {
        // One-shot final text → one assistant message, then turn-complete.
        const text = hermesText.trim();
        emit({ type: 'agent-init', sessionId: turnUuid, tools: [], cwd: params.cwd ?? '' });
        if (text.length > 0) {
          emit({ type: 'text-delta', delta: text, messageUuid: turnUuid });
        }
        if (code !== 0 && text.length === 0) {
          emit({
            type: 'turn-error',
            error: stderr.trim() || `hermes exited with code ${code}`,
          });
        } else {
          emit({
            type: 'turn-complete',
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 0,
            stopReason: code === 0 ? 'end_turn' : null,
          });
        }
      } else if (!emittedTerminal) {
        // Gemini closed without a `result` event (e.g. auth failure). Surface
        // stderr so the panel shows why instead of a silent empty reply.
        if (code !== 0) {
          emit({
            type: 'turn-error',
            error: stderr.trim() || `gemini exited with code ${code}`,
          });
        } else {
          emit({
            type: 'turn-complete',
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 0,
            stopReason: null,
          });
        }
      }
    }
    finish();
  });

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift() as ChatStreamEvent;
      }
      if (finished) return;
      if (params.signal?.aborted) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    params.signal?.removeEventListener('abort', onAbort);
    if (killTimer) clearTimeout(killTimer);
  }
}
