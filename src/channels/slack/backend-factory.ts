/**
 * Slack backend factory — wires {@link ProjectClaudeBackend} to the
 * disk-backed {@link saveSlackThread} / {@link loadSlackThread} layer
 * so the Claude Code CLI session id captured on the first turn is
 * mirrored to `.aweek/channels/slack/threads/<threadKey>.json` and
 * subsequent turns can pass `--resume <sessionId>`.
 *
 * Sub-AC 5 of the Slack-aweek integration seed:
 *
 *   - First message in a Slack thread → backend constructed with NO
 *     `claudeSessionId` → spawn helper omits `--resume` → CLI mints a
 *     fresh `session_id` on its leading `system init` line → the
 *     backend's `onSessionInit` hook calls {@link saveSlackThread}
 *     → `.aweek/channels/slack/threads/<threadKey>.json` is created
 *     with `{ claudeSessionId, lastUsedAt }`.
 *   - Second message in the same Slack thread → factory loads the
 *     persisted record (lazy-GC checks the 24h TTL) → backend
 *     constructed with `claudeSessionId` from disk → spawn helper
 *     emits `--resume <sessionId>` → CLI continues the thread.
 *   - Backend instance is cached per thread by the agentchannels
 *     `BackendRegistry` so the same in-memory `claudeSessionId` is
 *     reused across turns within a single `aweek serve` lifetime;
 *     persistence kicks in on restart and on cross-process Slack
 *     listener handoffs.
 *
 * The factory is the SINGLE place that knows about the
 * `.aweek/channels/slack/threads/` directory. The rest of the Slack
 * surface (the listener, the agentchannels bridge, the
 * {@link ProjectClaudeBackend}) stays oblivious to the on-disk shape
 * — the backend exposes `onSessionInit` / `onResult` hooks and the
 * factory snaps the persistence layer in.
 *
 * @module channels/slack/backend-factory
 */

import { join } from 'node:path';

import type { ThreadContext } from 'agentchannels';

import {
  ProjectClaudeBackend,
  type ProjectClaudeBackendOptions,
} from './project-claude-backend.js';
import {
  loadSlackThread,
  saveSlackThread,
  type NowFn,
  type SlackThreadRecord,
} from '../../storage/slack-thread-store.js';

/**
 * Options accepted by {@link createPersistedSlackBackend}.
 *
 * The factory takes the absolute project root (the same path passed to
 * `aweek serve --project-dir`) and the agentchannels `ThreadContext`
 * for the inbound message and returns a fully wired backend.
 *
 * Test seams (`spawnFn`, `cli`, `now`) mirror the underlying
 * {@link ProjectClaudeBackend} / {@link saveSlackThread} options so
 * unit tests can drive the whole vertical slice (Slack message →
 * project Claude argv → on-disk thread file) without a real CLI or a
 * real wall clock.
 */
export interface CreatePersistedSlackBackendOptions {
  /** Absolute path of the aweek project root. */
  projectRoot: string;
  /** Stable agentchannels thread context. */
  thread: ThreadContext;
  /**
   * Optional Slack-mode banner appended via `--append-system-prompt`.
   * The seed contract requires a "conversational human chat, not task
   * reports" banner so Slack replies don't read like heartbeat task
   * summaries.
   */
  systemPromptAppend?: string;
  /**
   * Optional clock injection — defaults to `Date.now`. The factory
   * forwards it to the thread store so the persisted `lastUsedAt`
   * matches the test's expected value.
   */
  now?: NowFn;
  /** Test seam — injectable spawn function. */
  spawnFn?: ProjectClaudeBackendOptions['spawnFn'];
  /** Test seam — CLI binary override. */
  cli?: ProjectClaudeBackendOptions['cli'];
  /**
   * Optional callback fired AFTER the thread store has been updated.
   * Useful for analytics / logging / cross-cutting observers; the
   * factory itself only depends on the persistence side effect.
   */
  onPersisted?: (record: SlackThreadRecord) => void;
  /**
   * Optional callback fired with the terminal `result` line. The
   * factory passes this through to the backend so the Slack usage
   * bucket layer (sibling AC) can hook in without learning about the
   * backend constructor.
   */
  onResult?: ProjectClaudeBackendOptions['onResult'];
}

/**
 * Resolve `<projectRoot>/.aweek/agents` — the calling convention every
 * other store in the codebase accepts. Centralising the join here
 * keeps the factory the only place that translates "project root"
 * (what callers know) into "data dir" (what stores expect).
 */
function resolveDataDir(projectRoot: string): string {
  return join(projectRoot, '.aweek', 'agents');
}

/**
 * Build a {@link ProjectClaudeBackend} pre-wired with disk persistence.
 *
 * Lifecycle:
 *
 *   1. **Rehydrate.** Load any persisted thread record. Lazy GC inside
 *      the store evicts records older than 24h and returns `null`, so
 *      a stale thread starts a fresh Claude session naturally — the
 *      contract's "deterministic and safe across restarts and clock
 *      skew" idempotency requirement.
 *   2. **Construct.** Build the backend with `claudeSessionId` from
 *      step 1 (or `undefined` for cold starts) so the spawn helper
 *      either appends `--resume <id>` or omits it — exactly the
 *      argument-shape contract sub-AC 4.2 enforces.
 *   3. **Wire onSessionInit.** Every time the CLI emits its leading
 *      `system init` line, `onSessionInit` calls `saveSlackThread`
 *      with the captured id and the current clock. Failures inside
 *      the persistence path are best-effort (a stderr warning) so a
 *      single I/O hiccup cannot orphan an in-flight Slack reply.
 *
 * The returned promise resolves with the backend instance. Resolution
 * is async because the rehydration step reads the disk; once
 * resolved, every subsequent `sendMessage` call is synchronous on the
 * factory side (the backend itself owns the spawn).
 */
export async function createPersistedSlackBackend(
  opts: CreatePersistedSlackBackendOptions,
): Promise<ProjectClaudeBackend> {
  if (!opts) throw new TypeError('createPersistedSlackBackend: opts is required');
  if (!opts.projectRoot) {
    throw new TypeError(
      'createPersistedSlackBackend: opts.projectRoot is required',
    );
  }
  if (!opts.thread) {
    throw new TypeError('createPersistedSlackBackend: opts.thread is required');
  }
  if (!opts.thread.threadKey) {
    throw new TypeError(
      'createPersistedSlackBackend: opts.thread.threadKey is required',
    );
  }

  const dataDir = resolveDataDir(opts.projectRoot);
  const now = opts.now ?? Date.now;

  // Step 1 — rehydrate any prior session id (lazy GC inside).
  let existing: SlackThreadRecord | null = null;
  try {
    existing = await loadSlackThread(dataDir, opts.thread.threadKey, now);
  } catch (err) {
    // Treat any unexpected I/O failure as a cold start. The store
    // already swallows ENOENT and malformed-JSON cases internally; a
    // genuine throw here (permissions, FS exhaustion) means we'd
    // rather mint a fresh session than refuse to reply.
    process.stderr.write(
      `aweek: Slack thread rehydration failed for ${opts.thread.threadKey} (${
        err instanceof Error ? err.message : String(err)
      }) — starting fresh\n`,
    );
    existing = null;
  }

  // Step 2 — construct the backend. Fields are added conditionally so
  // an unset `claudeSessionId` / `systemPromptAppend` doesn't leak as
  // an explicit `undefined` (matters under `exactOptionalPropertyTypes`
  // if it's ever flipped on).
  const backendOpts: ProjectClaudeBackendOptions = {
    projectRoot: opts.projectRoot,
    thread: opts.thread,
    onSessionInit: (info) => {
      // Step 3 — mirror to disk on every system-init line. The CLI
      // re-emits the same id on resumed turns, which means resumed
      // turns are still recorded — that's intentional: it bumps
      // `lastUsedAt` so the 24h TTL is measured from the most
      // recent activity, not the first turn.
      if (!info.sessionId || info.sessionId.length === 0) return;
      void (async () => {
        try {
          const record = await saveSlackThread(dataDir, {
            threadKey: opts.thread.threadKey,
            claudeSessionId: info.sessionId,
            now,
          });
          if (opts.onPersisted) {
            try {
              opts.onPersisted(record);
            } catch {
              // Observers must not poison the persistence pipeline.
            }
          }
        } catch (err) {
          // Persistence failures are best-effort. We log a single
          // warning so the operator notices the next turn will mint
          // a fresh session instead of resuming.
          process.stderr.write(
            `aweek: Slack thread persistence failed for ${opts.thread.threadKey} (${
              err instanceof Error ? err.message : String(err)
            })\n`,
          );
        }
      })();
    },
  };
  if (existing) backendOpts.claudeSessionId = existing.claudeSessionId;
  if (opts.systemPromptAppend) {
    backendOpts.systemPromptAppend = opts.systemPromptAppend;
  }
  if (opts.spawnFn) backendOpts.spawnFn = opts.spawnFn;
  if (opts.cli) backendOpts.cli = opts.cli;
  if (opts.onResult) backendOpts.onResult = opts.onResult;

  return new ProjectClaudeBackend(backendOpts);
}
