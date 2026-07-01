/**
 * ProjectRunnerBackend — the Gemini / Hermes counterpart to
 * {@link ProjectClaudeBackend} for the inbound Slack surface.
 *
 * When `.aweek/config.json` selects `runner: 'gemini' | 'hermes'`, the
 * Slack bridge resolves threads to THIS backend instead of the Claude
 * one, so a Slack conversation runs on the same runtime the heartbeat,
 * `run-once`, and the dashboard chat panel use.
 *
 * Two things differ from the Claude backend:
 *
 *   1. **Runtime.** It spawns the configured runner CLI via the shared
 *      {@link streamCliRunnerTurn} helper (the same one the dashboard chat
 *      panel uses) and translates that helper's `ChatStreamEvent`s into
 *      agentchannels `AgentStreamEvent`s.
 *   2. **Memory.** Gemini / Hermes have no clean "resume a headless run by
 *      id" flag, so continuity is provided by replaying the persisted
 *      thread transcript (`slack-transcript-store.ts`) into each prompt.
 *      Every completed turn appends the user message and the assistant
 *      reply, capped and TTL'd by the store.
 *
 * v1 is project-level (no `--agents` / subagent identity), matching the
 * Claude Slack backend — project Claude/Gemini/Hermes reaches subagents
 * transitively via `Task()` / `aweek exec`.
 *
 * @module channels/slack/project-runner-backend
 */

import { join, dirname } from 'node:path';

import type {
  AgentStreamEvent,
  Backend,
  BackendSendOptions,
  ThreadContext,
} from 'agentchannels';

import type { SpawnFn } from '../../execution/cli-session.js';
import { streamCliRunnerTurn } from '../../serve/chat-cli-runner.js';
import {
  loadSlackTranscript,
  appendSlackTranscript,
  type SlackTranscriptMessage,
} from '../../storage/slack-transcript-store.js';
import type { NowFn } from '../../storage/slack-thread-store.js';
import type { ResultInfo } from '../../serve/slack-stream-event-parser.js';

/** The runners this backend handles (Claude uses ProjectClaudeBackend). */
export type RunnerBackendKind = 'gemini' | 'hermes';

/**
 * Slug handed to {@link streamCliRunnerTurn} for a project-level Slack
 * run. It intentionally does NOT match any `.claude/agents/<slug>.md`, so
 * no subagent identity is injected — Slack v1 is project-level. The
 * conversational banner arrives via `systemPromptAppend` instead.
 */
const SLACK_PROJECT_SLUG = '__slack_project__';

export interface ProjectRunnerBackendOptions {
  /** Absolute path of the aweek project root (CLI working directory). */
  projectRoot: string;
  /** `<projectRoot>/.aweek/agents` — where the transcript store roots. */
  dataDir: string;
  /** Stable agentchannels thread context for this backend instance. */
  thread: ThreadContext;
  /** Which non-Claude runner to spawn. */
  runner: RunnerBackendKind;
  /** Conversational + first-turn banner, prepended to each prompt. */
  systemPromptAppend?: string;
  /** Fired once per completed turn with the token-usage breakdown. */
  onResult?: (info: ResultInfo) => void;
  /** Test seam — injectable spawn. */
  spawnFn?: SpawnFn;
  /** Test seam — CLI binary override. */
  cli?: string;
  /** Clock injection (transcript timestamps). Defaults to `Date.now`. */
  now?: NowFn;
}

/**
 * Collapse the persisted transcript plus the new user message into a
 * single conversational prompt. Mirrors the dashboard chat panel's
 * `formatPromptFromMessages`: a single opening user turn is sent verbatim;
 * multi-turn threads render a `User:` / `Assistant:` transcript ending on
 * an `Assistant:` cue so the model knows where its reply belongs.
 */
export function formatTranscriptPrompt(
  prior: SlackTranscriptMessage[],
  newUserText: string,
): string {
  const turns = [
    ...prior.filter((m) => m && typeof m.content === 'string' && m.content.length > 0),
    { role: 'user' as const, content: newUserText },
  ];
  if (turns.length === 1) return newUserText;
  const transcript = turns
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n\n');
  return `${transcript}\n\nAssistant:`;
}

/**
 * Per-Slack-thread Backend that proxies a project-level Gemini / Hermes
 * run and keeps memory via the transcript store.
 */
export class ProjectRunnerBackend implements Backend {
  readonly kind: RunnerBackendKind;
  readonly projectRoot: string;
  readonly dataDir: string;
  readonly thread: ThreadContext;

  protected currentAbort: AbortController | undefined;
  protected readonly systemPromptAppend: string | undefined;
  protected readonly onResult: ((info: ResultInfo) => void) | undefined;
  protected readonly spawnFn: SpawnFn | undefined;
  protected readonly cli: string | undefined;
  protected readonly now: NowFn;

  constructor(opts: ProjectRunnerBackendOptions) {
    if (!opts) throw new Error('ProjectRunnerBackend: opts is required');
    if (!opts.projectRoot) throw new Error('ProjectRunnerBackend: projectRoot is required');
    if (!opts.dataDir) throw new Error('ProjectRunnerBackend: dataDir is required');
    if (!opts.thread) throw new Error('ProjectRunnerBackend: thread is required');
    if (opts.runner !== 'gemini' && opts.runner !== 'hermes') {
      throw new Error(`ProjectRunnerBackend: unsupported runner ${JSON.stringify(opts.runner)}`);
    }
    this.kind = opts.runner;
    this.projectRoot = opts.projectRoot;
    this.dataDir = opts.dataDir;
    this.thread = opts.thread;
    this.systemPromptAppend = opts.systemPromptAppend;
    this.onResult = opts.onResult;
    this.spawnFn = opts.spawnFn;
    this.cli = opts.cli;
    this.now = opts.now ?? Date.now;
  }

  sendMessage(
    text: string,
    options?: BackendSendOptions,
  ): AsyncIterable<AgentStreamEvent> {
    if (typeof text !== 'string') {
      throw new Error('ProjectRunnerBackend.sendMessage: text must be a string');
    }
    const controller = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    this.currentAbort = controller;
    return this.run(text, controller);
  }

  private async *run(
    text: string,
    controller: AbortController,
  ): AsyncGenerator<AgentStreamEvent> {
    try {
      // Replay memory: load the prior transcript and fold the new user
      // message onto the end to form the prompt.
      const existing = await loadSlackTranscript(this.dataDir, this.thread.threadKey, this.now);
      const prior = existing?.messages ?? [];
      const prompt = formatTranscriptPrompt(prior, text);

      let assistantText = '';
      let usage = { inputTokens: 0, outputTokens: 0 };
      let turnError: string | null = null;

      const runnerParams: Parameters<typeof streamCliRunnerTurn>[0] = {
        runner: this.kind,
        prompt,
        slug: SLACK_PROJECT_SLUG,
        cwd: this.projectRoot,
        signal: controller.signal,
      };
      if (this.systemPromptAppend !== undefined) {
        runnerParams.systemPromptAppend = this.systemPromptAppend;
      }
      if (this.spawnFn !== undefined) runnerParams.spawnFn = this.spawnFn;
      if (this.cli !== undefined) runnerParams.cli = this.cli;

      for await (const evt of streamCliRunnerTurn(runnerParams)) {
        switch (evt.type) {
          case 'text-delta':
            assistantText += evt.delta;
            yield { type: 'text_delta', text: evt.delta };
            break;
          case 'tool-use':
            yield { type: 'tool_use', name: evt.name, input: evt.input };
            break;
          case 'tool-result':
            yield { type: 'tool_result', toolUseId: evt.toolUseId };
            break;
          case 'turn-complete':
            usage = {
              inputTokens: evt.usage.inputTokens,
              outputTokens: evt.usage.outputTokens,
            };
            break;
          case 'turn-error':
            turnError = evt.error;
            break;
          // 'agent-init' / 'assistant-message' carry no Slack-facing value.
          default:
            break;
        }
      }

      if (turnError) {
        // Failed turn — surface the error and do NOT commit it to memory,
        // so a retry starts from the last good state.
        yield { type: 'error', error: turnError };
        return;
      }

      // Commit the turn to memory (best-effort). User first, then the
      // assistant reply, preserving order for the next replay.
      try {
        await appendSlackTranscript(this.dataDir, {
          threadKey: this.thread.threadKey,
          role: 'user',
          content: text,
          now: this.now,
        });
        if (assistantText.length > 0) {
          await appendSlackTranscript(this.dataDir, {
            threadKey: this.thread.threadKey,
            role: 'assistant',
            content: assistantText,
            now: this.now,
          });
        }
      } catch (err) {
        process.stderr.write(
          `aweek: Slack transcript persistence failed for ${this.thread.threadKey} (${
            err instanceof Error ? err.message : String(err)
          })\n`,
        );
      }

      if (this.onResult) {
        try {
          this.onResult({ isError: false, usage });
        } catch {
          // Usage-bucket failures are best-effort — never poison the reply.
        }
      }

      yield { type: 'done', stopReason: 'end_turn' };
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (this.currentAbort === controller) this.currentAbort = undefined;
    }
  }

  abort(): void {
    const controller = this.currentAbort;
    if (!controller) return;
    controller.abort();
  }

  async dispose(): Promise<void> {
    this.abort();
  }
}

/**
 * Options for {@link createRunnerSlackBackend}. Mirrors
 * `CreatePersistedSlackBackendOptions` (the Claude factory) plus the
 * `runner` discriminator, so the Slack bridge can pass one factoryOpts
 * shape to whichever factory the config runner selects.
 */
export interface CreateRunnerSlackBackendOptions {
  projectRoot: string;
  thread: ThreadContext;
  runner: RunnerBackendKind;
  systemPromptAppend?: string;
  now?: NowFn;
  spawnFn?: SpawnFn;
  cli?: string;
  onResult?: (info: ResultInfo) => void;
  /**
   * Consulted ONLY on the first turn of a thread (no existing transcript)
   * — same one-shot report-context injection contract as the Claude
   * factory's `loadFirstTurnSystemPromptAppend`.
   */
  loadFirstTurnSystemPromptAppend?: () => Promise<string | null | undefined>;
}

function resolveDataDir(projectRoot: string): string {
  return join(projectRoot, '.aweek', 'agents');
}

/**
 * Build a {@link ProjectRunnerBackend} with the first-turn banner
 * composed. Symmetric with `createPersistedSlackBackend`: on a cold-start
 * thread (no transcript yet) the optional first-turn context is appended
 * to the conversational banner; on a warm thread it is skipped so the
 * one-shot report context isn't replayed every turn.
 */
export async function createRunnerSlackBackend(
  opts: CreateRunnerSlackBackendOptions,
): Promise<ProjectRunnerBackend> {
  if (!opts) throw new TypeError('createRunnerSlackBackend: opts is required');
  if (!opts.projectRoot) throw new TypeError('createRunnerSlackBackend: projectRoot is required');
  if (!opts.thread?.threadKey) {
    throw new TypeError('createRunnerSlackBackend: thread.threadKey is required');
  }

  const dataDir = resolveDataDir(opts.projectRoot);
  const now = opts.now ?? Date.now;

  let existing = null;
  try {
    existing = await loadSlackTranscript(dataDir, opts.thread.threadKey, now);
  } catch {
    existing = null;
  }

  let banner = opts.systemPromptAppend;
  if (!existing && opts.loadFirstTurnSystemPromptAppend) {
    try {
      const extra = await opts.loadFirstTurnSystemPromptAppend();
      if (typeof extra === 'string' && extra.length > 0) {
        banner = banner ? `${banner}\n\n${extra}` : extra;
      }
    } catch (err) {
      process.stderr.write(
        `aweek: Slack first-turn context loader failed for ${opts.thread.threadKey} (${
          err instanceof Error ? err.message : String(err)
        }) — falling back to conversational banner only\n`,
      );
    }
  }

  const backendOpts: ProjectRunnerBackendOptions = {
    projectRoot: opts.projectRoot,
    dataDir,
    thread: opts.thread,
    runner: opts.runner,
    now,
  };
  if (banner) backendOpts.systemPromptAppend = banner;
  if (opts.spawnFn) backendOpts.spawnFn = opts.spawnFn;
  if (opts.cli) backendOpts.cli = opts.cli;
  if (opts.onResult) backendOpts.onResult = opts.onResult;

  return new ProjectRunnerBackend(backendOpts);
}
