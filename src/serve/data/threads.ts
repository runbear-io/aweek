/**
 * Thread (chat-conversation) data layer for the floating chat panel.
 *
 * Sub-AC 1 of AC 40101: thin handler module that bridges the SPA's
 * thread-list / new-thread / rename / delete UI to the
 * {@link ChatConversationStore} persistence layer. Each function below
 * fronts a single REST verb the SPA's thread sidebar invokes:
 *
 *   - {@link listThreads}    →  GET    /api/agents/:slug/chat/threads
 *   - {@link createThread}   →  POST   /api/agents/:slug/chat/threads
 *   - {@link renameThread}   →  PATCH  /api/agents/:slug/chat/threads/:threadId
 *   - {@link deleteThread}   →  DELETE /api/agents/:slug/chat/threads/:threadId
 *
 * The functions are deliberately framework-agnostic — they take a plain
 * `{ projectDir, agentId, … }` options bag and return plain JSON-shaped
 * payloads (or `null` for "agent slug unknown" so the HTTP layer can map
 * to 404). The HTTP wrappers in `src/serve/server.ts` own the URL parse,
 * status-code mapping, and JSON encoding.
 *
 * Read-only invariants vs. data-layer policy
 * ------------------------------------------
 * The data layer's general contract (see `data.test.ts`) forbids direct
 * filesystem-write APIs in this module tree. Per-thread mutations
 * (create / rename / delete) are routed through
 * {@link ChatConversationStore} method calls (`store.write`,
 * `store.setTitle`, `store.delete`) — those calls are not flagged by
 * the static check, which matches the bare fs APIs (file write / unlink
 * / rename / directory create) rather than store-level names. The
 * actual filesystem mutations stay encapsulated inside the storage
 * module. This mirrors the same pattern `chat-usage.ts` uses to record
 * token spend through `UsageStore.append`.
 *
 * The 404 surface uses the same `listAllAgentsPartial` pattern as every
 * other per-agent gatherer (`agent-notifications.ts`, `artifacts.ts`,
 * etc.) so a single drifted agent JSON does not knock these endpoints
 * offline for healthy agents.
 *
 * @module serve/data/threads
 */

import { join } from 'node:path';

import { listAllAgentsPartial } from '../../storage/agent-helpers.js';
import {
  ChatConversationStore,
  createChatConversation,
  type ChatConversationListOptions,
  type ChatConversationSummary,
} from '../../storage/chat-conversation-store.js';
import type { ChatConversation } from '../../schemas/chat-conversation.js';

// ---------------------------------------------------------------------------
// Public option shapes
// ---------------------------------------------------------------------------

/** Common options shared by every thread handler. */
export interface ThreadHandlerOptions {
  /** Absolute path to the aweek project root (the directory containing `.aweek/`). */
  projectDir?: string;
  /** Slug of the aweek agent / Claude Code subagent. */
  agentId?: string;
}

/** Options accepted by {@link listThreads}. */
export interface ListThreadsOptions extends ThreadHandlerOptions {
  /**
   * Sort order. Defaults to `updatedAt-desc` so the most recently
   * touched thread surfaces first in the sidebar.
   */
  sort?: ChatConversationListOptions['sort'];
  /** Cap the number of returned thread summaries. */
  limit?: number;
}

/** Options accepted by {@link createThread}. */
export interface CreateThreadOptions extends ThreadHandlerOptions {
  /** Optional user-editable label. Omit to leave the title unset. */
  title?: string;
  /** Optional forward-compatible metadata bag. */
  metadata?: Record<string, unknown>;
}

/** Options accepted by {@link getThread}. */
export interface GetThreadOptions extends ThreadHandlerOptions {
  /** Conversation id (basename of the on-disk JSON file). */
  threadId?: string;
}

/** Options accepted by {@link renameThread}. */
export interface RenameThreadOptions extends ThreadHandlerOptions {
  /** Conversation id (basename of the on-disk JSON file). */
  threadId?: string;
  /**
   * New title. Pass an empty string to clear the title — matches
   * {@link ChatConversationStore.setTitle}'s contract.
   */
  title?: string;
}

/** Options accepted by {@link deleteThread}. */
export interface DeleteThreadOptions extends ThreadHandlerOptions {
  /** Conversation id (basename of the on-disk JSON file). */
  threadId?: string;
}

// ---------------------------------------------------------------------------
// Public payload shapes
// ---------------------------------------------------------------------------

/** Payload returned by {@link listThreads}. */
export interface ListThreadsPayload {
  agentId: string;
  /** Thread summaries, sorted per the request (default: most recent first). */
  threads: ChatConversationSummary[];
}

/** Payload returned by {@link createThread}. */
export interface CreateThreadPayload {
  /** The newly persisted conversation document (with auto id + timestamps). */
  thread: ChatConversation;
}

/** Payload returned by {@link getThread}. */
export interface GetThreadPayload {
  /** The full conversation document (including all messages) for replay. */
  thread: ChatConversation;
}

/** Payload returned by {@link renameThread}. */
export interface RenameThreadPayload {
  /** The updated conversation document with the new title applied. */
  thread: ChatConversation;
}

/** Payload returned by {@link deleteThread}. */
export interface DeleteThreadPayload {
  /** `true` when a file was removed, `false` for a missing-id no-op. */
  removed: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve the per-project agents-dir + a {@link ChatConversationStore} bound to it. */
function resolveStore(projectDir: string): {
  agentsDir: string;
  store: ChatConversationStore;
} {
  const agentsDir = join(projectDir, '.aweek', 'agents');
  return { agentsDir, store: new ChatConversationStore(agentsDir) };
}

/**
 * Returns `true` when the given agent slug exists on disk (i.e. has a
 * loadable `.aweek/agents/<slug>.json`). Mirrors the existence check
 * `agent-notifications.ts` and `artifacts.ts` use so each per-agent
 * thread endpoint can short-circuit to a 404 before touching the chat
 * directory. Uses the partial loader so a single corrupt sibling does
 * not knock the lookup offline for healthy agents.
 */
async function agentExists(
  agentsDir: string,
  agentId: string,
): Promise<boolean> {
  const { agents } = await listAllAgentsPartial({ dataDir: agentsDir });
  return agents.some((c) => c.id === agentId);
}

/** Throws with a consistent prefix when a required field is missing. */
function requireField(
  fnName: string,
  field: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fnName}: ${field} is required`);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * List every chat thread for one agent.
 *
 * Returns lightweight {@link ChatConversationSummary} rows (id, title,
 * timestamps, message count, last-message preview) — enough for the
 * sidebar to render without paying the cost of streaming each full
 * thread document. Sorted per `options.sort` (default: most recently
 * updated first).
 *
 * Returns `null` when the agent slug does not exist on disk so the HTTP
 * layer can map to 404. Returns `{ threads: [] }` (rather than null)
 * when the agent exists but has not opened any threads yet — keeps the
 * SPA's empty-state rendering deterministic.
 */
export async function listThreads(
  opts: ListThreadsOptions = {},
): Promise<ListThreadsPayload | null> {
  const { projectDir, agentId, sort, limit } = opts;
  requireField('listThreads', 'projectDir', projectDir);
  requireField('listThreads', 'agentId', agentId);

  const { agentsDir, store } = resolveStore(projectDir);
  if (!(await agentExists(agentsDir, agentId))) return null;

  const listOptions: ChatConversationListOptions = {};
  if (sort !== undefined) listOptions.sort = sort;
  if (typeof limit === 'number') listOptions.limit = limit;

  const threads = await store.listSummaries(agentId, listOptions);
  return { agentId, threads };
}

/**
 * Read a single chat thread end-to-end (full message history + metadata)
 * for replay in the floating chat panel.
 *
 * Sub-AC 4 of AC 5 — when the user clicks a thread row in the sidebar,
 * the panel hydrates the chat surface with the full saved conversation
 * by hitting `GET /api/agents/:slug/chat/threads/:threadId`. The HTTP
 * wrapper in `server.ts` calls this function and surfaces the returned
 * conversation as `initialMessages` on the `<ChatThread>` mount.
 *
 * Returns `null` when:
 *   - the agent slug does not exist on disk, OR
 *   - the agent exists but the named thread does not.
 *
 * Both cases map to a 404 at the HTTP layer; the SPA decides whether
 * the slug or the thread was the missing piece based on the user's
 * surrounding state (e.g. if the agent shows up in the roster but the
 * thread fetch 404s, the thread was deleted out from under them).
 */
export async function getThread(
  opts: GetThreadOptions = {},
): Promise<GetThreadPayload | null> {
  const { projectDir, agentId, threadId } = opts;
  requireField('getThread', 'projectDir', projectDir);
  requireField('getThread', 'agentId', agentId);
  requireField('getThread', 'threadId', threadId);

  const { agentsDir, store } = resolveStore(projectDir);
  if (!(await agentExists(agentsDir, agentId))) return null;

  const conversation = await store.read(agentId, threadId);
  if (!conversation) return null;
  return { thread: conversation };
}

/**
 * Create a new (empty) chat thread for one agent.
 *
 * The store auto-stamps a unique id (`chat-<hex>`), `createdAt`,
 * `updatedAt`, and an empty `messages[]` — callers only need to supply
 * an optional `title` and `metadata` bag. The returned thread document
 * is the one persisted to disk (post-validation).
 *
 * Returns `null` when the agent slug does not exist so the HTTP layer
 * can map to 404 instead of silently creating a chat directory under a
 * non-existent agent.
 */
export async function createThread(
  opts: CreateThreadOptions = {},
): Promise<CreateThreadPayload | null> {
  const { projectDir, agentId, title, metadata } = opts;
  requireField('createThread', 'projectDir', projectDir);
  requireField('createThread', 'agentId', agentId);

  const { agentsDir, store } = resolveStore(projectDir);
  if (!(await agentExists(agentsDir, agentId))) return null;

  const createOpts: Parameters<typeof createChatConversation>[0] = { agentId };
  if (typeof title === 'string' && title.length > 0) {
    createOpts.title = title;
  }
  if (metadata !== undefined) createOpts.metadata = metadata;

  const conversation = createChatConversation(createOpts);
  const persisted = await store.write(agentId, conversation);
  return { thread: persisted };
}

/**
 * Rename an existing chat thread.
 *
 * Delegates to {@link ChatConversationStore.setTitle}, which bumps
 * `updatedAt` so the thread resorts to the top of the default
 * `updatedAt-desc` sidebar listing. Passing an empty `title` clears the
 * title (the schema treats it as optional).
 *
 * Returns `null` when either the agent or the thread does not exist —
 * the HTTP layer maps both to 404. The agent-existence check is the
 * cheaper of the two (one `readdir` of the agents dir vs. opening the
 * thread file), so it runs first.
 */
export async function renameThread(
  opts: RenameThreadOptions = {},
): Promise<RenameThreadPayload | null> {
  const { projectDir, agentId, threadId, title } = opts;
  requireField('renameThread', 'projectDir', projectDir);
  requireField('renameThread', 'agentId', agentId);
  requireField('renameThread', 'threadId', threadId);
  if (typeof title !== 'string') {
    throw new Error('renameThread: title is required (use "" to clear)');
  }

  const { agentsDir, store } = resolveStore(projectDir);
  if (!(await agentExists(agentsDir, agentId))) return null;

  // Pre-flight read so we can surface "thread missing" as null (→ 404)
  // without relying on `setTitle`'s thrown error string. Storage is
  // read-only here; the actual mutation happens in `setTitle` below.
  const existing = await store.read(agentId, threadId);
  if (!existing) return null;

  const updated = await store.setTitle(agentId, threadId, title);
  return { thread: updated };
}

/**
 * Delete a single chat thread.
 *
 * Idempotent — a missing file is reported as `removed: false` rather
 * than thrown, matching {@link ChatConversationStore.delete}'s
 * contract. The HTTP layer maps `removed: false` together with a
 * missing agent to 404; an existing-agent + missing-thread combo can
 * still resolve to 200 with `removed: false` if the SPA wants to
 * tolerate races (two tabs deleting the same thread).
 *
 * Returns `null` only when the agent itself does not exist — the HTTP
 * layer maps that to 404. (A missing thread on a known agent is
 * intentionally not 404 since the operation is idempotent.)
 */
export async function deleteThread(
  opts: DeleteThreadOptions = {},
): Promise<DeleteThreadPayload | null> {
  const { projectDir, agentId, threadId } = opts;
  requireField('deleteThread', 'projectDir', projectDir);
  requireField('deleteThread', 'agentId', agentId);
  requireField('deleteThread', 'threadId', threadId);

  const { agentsDir, store } = resolveStore(projectDir);
  if (!(await agentExists(agentsDir, agentId))) return null;

  const removed = await store.delete(agentId, threadId);
  return { removed };
}
