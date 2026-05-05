/**
 * Storage layer for floating-chat conversations.
 *
 * Persists chat threads as one JSON document per conversation under
 *
 *   .aweek/agents/<agentId>/chat/<conversation-id>.json
 *
 * via the same atomic write-tmp-then-rename pattern used by
 * `notification-store`. Each conversation is a single thread between the
 * dashboard user and one aweek agent and stores the full append-only
 * message history (user / assistant turns plus optional tool-invocation
 * blocks) so the floating panel can replay state across page reloads
 * and browser sessions.
 *
 * v1 invariants:
 *
 *   - Append-only messages (no edit, no delete-message, no regenerate).
 *     Thread-level delete is allowed via {@link ChatConversationStore.delete}.
 *   - Last-writer-wins for concurrent mutations on the same thread —
 *     two callers writing the same conversation file race for the
 *     atomic `rename()`; the loser's payload is discarded silently.
 *   - AJV schema validation on every write. Loads also re-validate the
 *     persisted document so a corrupt thread surfaces as an error
 *     rather than silently re-serialising bad shape on the next save.
 *
 * Per-thread files (rather than one shared array) keep:
 *
 *   1. Concurrent-writer scope tight (the heartbeat & a chat handler
 *      can both be appending against the same agent without colliding
 *      across threads).
 *   2. Thread enumeration cheap (the list endpoint reads filenames +
 *      `title` / `updatedAt` only).
 *   3. Thread deletion cheap (`unlink()` on a single file, no array
 *      mutation under a lock).
 *
 * The schema-of-record is `aweek://schemas/chat-conversation` (defined
 * in `src/schemas/chat-conversation.schema.js`); the typed companion
 * lives at `src/schemas/chat-conversation.ts`.
 */

import { readFile, writeFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertValid } from '../schemas/validator.js';
import type {
  ChatConversation,
  ChatMessage,
  ChatMessageRole,
  ChatToolBlock,
} from '../schemas/chat-conversation.js';

const CONVERSATION_SCHEMA_ID = 'aweek://schemas/chat-conversation';
const MESSAGE_SCHEMA_ID = 'aweek://schemas/chat-message';

/** Generate a short random hex id (used for file tmp suffixes + ids). */
const shortId = (): string => randomBytes(4).toString('hex');

/**
 * Inputs accepted by {@link createChatConversation}.
 *
 * The store auto-populates the four pieces of metadata callers should
 * never have to fabricate by hand: a unique `id`, `createdAt`,
 * `updatedAt`, and an empty `messages[]`. The `agentId` and an optional
 * `title` are the only required identity inputs.
 */
export interface CreateChatConversationOptions {
  /** Slug of the aweek agent / Claude Code subagent this thread targets. */
  agentId: string;
  /** Optional short user-editable label rendered in the thread list. */
  title?: string;
  /**
   * Override timestamp (defaults to now). Provided as an escape hatch for
   * tests and replay tooling; leave unset in production callers.
   */
  createdAt?: string;
  /** Optional forward-compatible metadata bag. */
  metadata?: Record<string, unknown>;
}

/** Inputs accepted by {@link createChatMessage}. */
export interface CreateChatMessageOptions {
  /** `user` for composer-authored turns, `assistant` for agent replies. */
  role: ChatMessageRole;
  /** Concatenated natural-language text for the turn. */
  content: string;
  /** Optional ordered tool-invocation blocks emitted during this turn. */
  tools?: ChatToolBlock[];
  /**
   * Override timestamp (defaults to now). Provided as an escape hatch for
   * tests and replay tooling; leave unset in production callers.
   */
  createdAt?: string;
  /**
   * Override id (defaults to a server-generated `msg-<hex>`). User turns
   * may pass a client-side id; assistant turns typically inherit the
   * SDK's message UUID.
   */
  id?: string;
  /** Forward-compatible extension slot. */
  metadata?: Record<string, unknown>;
}

/**
 * Lightweight summary returned by {@link ChatConversationStore.listSummaries}.
 *
 * Reading every full thread document just to render the thread-list
 * sidebar is wasteful — this struct exposes only the fields the list UI
 * needs (id, title, timestamps, lastMessage preview, message count).
 */
export interface ChatConversationSummary {
  id: string;
  agentId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Truncated content of the most recent message (oldest-first ordering). */
  lastMessagePreview?: string;
  /** Role of the most recent message — handy for sidebar icons. */
  lastMessageRole?: ChatMessageRole;
}

/** Optional filters for {@link ChatConversationStore.list}. */
export interface ChatConversationListOptions {
  /**
   * Sort order. Defaults to `updatedAt-desc` so the most recently
   * touched thread surfaces first in the panel sidebar.
   */
  sort?: 'updatedAt-desc' | 'updatedAt-asc' | 'createdAt-desc' | 'createdAt-asc';
  /** Cap the number of returned threads. */
  limit?: number;
}

/**
 * Build a fresh chat conversation document.
 *
 * Stamps a unique `id` (`chat-<hex>`), defaults `createdAt`/`updatedAt`
 * to "now", and starts the thread with an empty message list. The
 * resulting struct is schema-valid by construction — the store runs
 * AJV again on write as belt-and-braces so a hand-mutated document
 * cannot persist a malformed shape.
 */
export function createChatConversation(
  opts: CreateChatConversationOptions,
): ChatConversation {
  const now = opts.createdAt ?? new Date().toISOString();
  const conversation: ChatConversation = {
    id: `chat-${shortId()}`,
    agentId: opts.agentId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  if (opts.title !== undefined) conversation.title = opts.title;
  if (opts.metadata !== undefined) conversation.metadata = opts.metadata;
  return conversation;
}

/**
 * Build a fresh chat message.
 *
 * Stamps a server-generated id (`msg-<hex>`) and `createdAt` to "now"
 * unless the caller supplies overrides. The returned struct is
 * schema-valid by construction.
 */
export function createChatMessage(opts: CreateChatMessageOptions): ChatMessage {
  const message: ChatMessage = {
    id: opts.id ?? `msg-${shortId()}`,
    role: opts.role,
    content: opts.content,
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
  if (opts.tools !== undefined) message.tools = opts.tools;
  if (opts.metadata !== undefined) message.metadata = opts.metadata;
  return message;
}

/** Truncate length used for {@link ChatConversationSummary.lastMessagePreview}. */
const PREVIEW_MAX_LENGTH = 200;

function buildSummary(conversation: ChatConversation): ChatConversationSummary {
  const summary: ChatConversationSummary = {
    id: conversation.id,
    agentId: conversation.agentId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
  };
  if (conversation.title !== undefined) summary.title = conversation.title;

  const last = conversation.messages[conversation.messages.length - 1];
  if (last) {
    summary.lastMessageRole = last.role;
    const trimmed = last.content.trim();
    summary.lastMessagePreview =
      trimmed.length > PREVIEW_MAX_LENGTH
        ? `${trimmed.slice(0, PREVIEW_MAX_LENGTH - 1)}…`
        : trimmed;
  }
  return summary;
}

/**
 * Comparator factory for sorted listings. Returns the comparator suited
 * to the requested sort order.
 */
function comparatorFor(
  sort: NonNullable<ChatConversationListOptions['sort']>,
): (a: ChatConversation, b: ChatConversation) => number {
  switch (sort) {
    case 'updatedAt-desc':
      return (a, b) => b.updatedAt.localeCompare(a.updatedAt);
    case 'updatedAt-asc':
      return (a, b) => a.updatedAt.localeCompare(b.updatedAt);
    case 'createdAt-desc':
      return (a, b) => b.createdAt.localeCompare(a.createdAt);
    case 'createdAt-asc':
      return (a, b) => a.createdAt.localeCompare(b.createdAt);
  }
}

/**
 * File-based store for chat conversations.
 *
 * One conversation = one JSON file under
 * `<baseDir>/<agentId>/chat/<conversationId>.json`. The store does not
 * cache documents in memory — every method round-trips through the
 * filesystem so the heartbeat path and the chat handler can never see a
 * stale snapshot of the same thread.
 */
export class ChatConversationStore {
  /** Root data directory (e.g., `./.aweek/agents`). */
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Directory holding a single agent's per-agent files. */
  _agentDir(agentId: string): string {
    return join(this.baseDir, agentId);
  }

  /** Directory holding all chat thread files for one agent. */
  _chatDir(agentId: string): string {
    return join(this._agentDir(agentId), 'chat');
  }

  /** Path to a single conversation's JSON file. */
  _filePath(agentId: string, conversationId: string): string {
    return join(this._chatDir(agentId), `${conversationId}.json`);
  }

  /** Ensure the chat directory for an agent exists. */
  async init(agentId: string): Promise<void> {
    await mkdir(this._chatDir(agentId), { recursive: true });
  }

  /**
   * Read a single conversation. Returns `null` when the thread file
   * does not exist (lets the chat handler fall through to a 404
   * cleanly without try/catching the ENOENT). Validates the persisted
   * document on load so a corrupt file surfaces an error.
   */
  async read(
    agentId: string,
    conversationId: string,
  ): Promise<ChatConversation | null> {
    const filePath = this._filePath(agentId, conversationId);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const conversation = JSON.parse(raw) as ChatConversation;
      assertValid(CONVERSATION_SCHEMA_ID, conversation);
      return conversation;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Persist a conversation. Validates against
   * `aweek://schemas/chat-conversation` first; on validation failure
   * nothing is written. On success, writes go through an atomic
   * write-tmp-then-rename so a concurrent reader never observes a
   * partial file.
   *
   * Last-writer-wins: two callers persisting the same thread race on
   * the rename; the loser's payload is overwritten silently. This is
   * the documented v1 concurrency contract — heavyweight locking lands
   * later if a future AC ever needs stronger semantics.
   *
   * The caller is responsible for keeping `updatedAt` fresh; helper
   * methods like {@link ChatConversationStore.appendMessage} and
   * {@link ChatConversationStore.setTitle} bump it automatically.
   */
  async write(
    agentId: string,
    conversation: ChatConversation,
  ): Promise<ChatConversation> {
    if (conversation.agentId !== agentId) {
      throw new Error(
        `Chat conversation agent mismatch: file under ${agentId} but ` +
          `payload claims ${conversation.agentId}`,
      );
    }
    assertValid(CONVERSATION_SCHEMA_ID, conversation);
    await this.init(agentId);
    const filePath = this._filePath(agentId, conversation.id);
    const tmpPath = `${filePath}.tmp-${process.pid}-${shortId()}`;
    const payload = JSON.stringify(conversation, null, 2) + '\n';
    await writeFile(tmpPath, payload, 'utf-8');
    try {
      await rename(tmpPath, filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
    return conversation;
  }

  /**
   * Enumerate every conversation for an agent. Reads every JSON file
   * in `<baseDir>/<agentId>/chat/`, validates each document, and
   * returns them sorted per `options.sort` (default: most recently
   * updated first). Returns `[]` when the chat directory does not
   * exist yet — the thread-list endpoint relies on that fallback so a
   * brand-new agent renders an empty sidebar without error handling.
   *
   * Files whose names do not look like conversation IDs (e.g. lingering
   * `.tmp-*` artifacts from a crashed write) are skipped silently.
   */
  async list(
    agentId: string,
    options: ChatConversationListOptions = {},
  ): Promise<ChatConversation[]> {
    const dir = this._chatDir(agentId);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return [];
      throw err;
    }

    const conversationIds = entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      // Filter out tmp artefacts (`<id>.json.tmp-<pid>-<hex>`) that sneak
      // through the `.json` filter via their final segment.
      .filter((id) => /^chat-[a-z0-9]+(-[a-z0-9]+)*$/.test(id));

    const conversations: ChatConversation[] = [];
    for (const id of conversationIds) {
      const conversation = await this.read(agentId, id);
      if (conversation) conversations.push(conversation);
    }

    const sort = options.sort ?? 'updatedAt-desc';
    conversations.sort(comparatorFor(sort));
    if (typeof options.limit === 'number' && options.limit >= 0) {
      conversations.length = Math.min(conversations.length, options.limit);
    }
    return conversations;
  }

  /**
   * Lighter-weight variant of {@link ChatConversationStore.list} —
   * returns just the fields the thread-list sidebar needs (id, title,
   * timestamps, last-message preview, message count). Internally walks
   * the same directory; future revisions could read just the
   * `metadata`-bearing prefix of each file but the v1 implementation
   * is fine reading the whole document because conversations stay small.
   */
  async listSummaries(
    agentId: string,
    options: ChatConversationListOptions = {},
  ): Promise<ChatConversationSummary[]> {
    const conversations = await this.list(agentId, options);
    return conversations.map(buildSummary);
  }

  /**
   * Delete a single conversation. Idempotent — a missing file is a
   * no-op so callers can blindly retry without 404 handling.
   *
   * @returns `true` when a file was removed, `false` when no thread
   *          existed at the given id.
   */
  async delete(agentId: string, conversationId: string): Promise<boolean> {
    const filePath = this._filePath(agentId, conversationId);
    try {
      await unlink(filePath);
      return true;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * Append a message to an existing conversation, bump `updatedAt`,
   * and persist atomically. Returns the updated conversation.
   *
   * Idempotent on `message.id`: appending a message whose id already
   * exists in the thread is a no-op — the existing document is
   * returned unchanged. This keeps double-submitted user turns and
   * heartbeat retries safe.
   *
   * @throws When the conversation does not exist (the chat handler
   *         must create it first via {@link write}).
   * @throws When the message does not validate against
   *         `aweek://schemas/chat-message`.
   */
  async appendMessage(
    agentId: string,
    conversationId: string,
    message: ChatMessage,
  ): Promise<ChatConversation> {
    assertValid(MESSAGE_SCHEMA_ID, message);
    const conversation = await this.read(agentId, conversationId);
    if (!conversation) {
      throw new Error(
        `Chat conversation not found: ${conversationId} for agent ${agentId}`,
      );
    }
    if (conversation.messages.some((m) => m.id === message.id)) {
      return conversation;
    }
    conversation.messages.push(message);
    conversation.updatedAt = new Date().toISOString();
    return this.write(agentId, conversation);
  }

  /**
   * Update only the user-visible title. Bumps `updatedAt` so the
   * thread list resorts the renamed thread to the top per the default
   * `updatedAt-desc` ordering.
   *
   * Passing an empty string clears the title (the schema treats
   * `title` as optional with `minLength: 1`, so an empty value is
   * persisted as "field absent").
   */
  async setTitle(
    agentId: string,
    conversationId: string,
    title: string,
  ): Promise<ChatConversation> {
    const conversation = await this.read(agentId, conversationId);
    if (!conversation) {
      throw new Error(
        `Chat conversation not found: ${conversationId} for agent ${agentId}`,
      );
    }
    if (title.length === 0) {
      delete conversation.title;
    } else {
      conversation.title = title;
    }
    conversation.updatedAt = new Date().toISOString();
    return this.write(agentId, conversation);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Narrow `unknown` to a Node `ErrnoException` so we can read the `code` field. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
