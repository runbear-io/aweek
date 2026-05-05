/**
 * JSON Schema definitions for the persisted floating-chat conversation
 * model.
 *
 * One record represents a single chat *thread* between the dashboard
 * user and one aweek agent. Threads are append-only in v1 (no in-place
 * message edits, no regenerate) and persist to disk under
 *
 *     .aweek/agents/<slug>/chat/<conversation-id>.json
 *
 * via the same atomic write-tmp-then-rename pattern used by the rest of
 * `src/storage/*`. The store and HTTP handlers in
 * `src/serve/data/chat.ts` will land in subsequent sub-ACs; this schema
 * is the interchange contract they all agree on.
 *
 * Schema layout
 * -------------
 *   - `chat-message` — one user / assistant turn inside a conversation.
 *     Required: `id`, `role`, `content`, `createdAt`. Optional `tools`
 *     payload mirrors the tool-use / tool-result blocks the Anthropic
 *     Agent SDK surfaces during a turn so the floating panel can re-
 *     render historical tool invocations after a page reload.
 *   - `chat-conversation` — the top-level document persisted per
 *     thread. Required: `id`, `agentId`, `messages`, `createdAt`,
 *     `updatedAt`. Optional `title` is a short user-editable label;
 *     `metadata` is a forward-compatible bag.
 *   - `chat-conversation-list` — array of conversations, used by the
 *     thread-list endpoint to enumerate all threads for an agent.
 *
 * Why an explicit list schema? The list-style sibling
 * (`activity-log` → `activity-log-entry`, `usage-log` → `usage-record`,
 * `notification-feed` → `notification`) is a project convention that
 * lets callers validate either a single record or a full collection by
 * `$ref`-ing the same definition. Following the convention keeps the
 * AJV registry in `validator.js` one-line per addition.
 *
 * Per-record vs per-file storage
 * ------------------------------
 * Conversations live in **separate files** (one JSON document per
 * thread) rather than a single multi-thread document. This matches:
 *
 *   1. The append-only-with-concurrent-writers requirement — the
 *      heartbeat and chat handlers can both write tokens against the
 *      same agent at the same time, and a per-thread file lets the
 *      atomic write-then-rename pattern keep last-writer-wins
 *      semantics scoped to the thread, not the whole conversation set.
 *   2. Cheap thread switching — the list endpoint reads filenames +
 *      `title` / `updatedAt` only; the body endpoint loads exactly one
 *      JSON document.
 *   3. Cheap thread deletion — `unlink()` on a single file vs a
 *      mutation of a shared array.
 *
 * The two schemas are typed in the sibling `chat-conversation.ts`
 * companion (`JSONSchemaType<ChatConversation>` / `<ChatMessage>`) per
 * the same `*.schema.js` ↔ `*.ts` split documented in CLAUDE.md.
 */

/** Valid chat-message roles. v1 is text-only between user and agent. */
export const CHAT_MESSAGE_ROLES = ['user', 'assistant'];

/**
 * Valid chat-message tool-block types. Mirrors the Anthropic Agent
 * SDK's `tool_use` and `tool_result` block types — when persisted on a
 * historical message they let the floating panel re-render the same
 * collapsible tool-invocation cards the live stream surfaces.
 */
export const CHAT_TOOL_BLOCK_TYPES = ['tool_use', 'tool_result'];

/**
 * AJV sub-schema for a single tool-invocation block on a persisted
 * chat message. Two `oneOf` branches mirror the SDK shapes:
 *
 *   - `tool_use`    — agent invokes a tool. Required: `toolUseId`,
 *                     `name`, `input`.
 *   - `tool_result` — tool finished. Required: `toolUseId`, `content`,
 *                     `isError`.
 *
 * Both branches keep `additionalProperties: true` so future SDK fields
 * (cache markers, server-side timing, …) can be threaded through
 * without a breaking schema migration.
 */
export const chatToolBlockSchema = {
  $id: 'aweek://schemas/chat-tool-block',
  oneOf: [
    {
      type: 'object',
      required: ['type', 'toolUseId', 'name', 'input'],
      properties: {
        type: { const: 'tool_use' },
        toolUseId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description:
            'Stable id correlating a tool_use block to its eventual ' +
            'tool_result block. Surfaced by the Anthropic Agent SDK as ' +
            '`tool_use.id`.',
        },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description:
            'Tool name as the SDK reports it (e.g. `Read`, `Bash`, or ' +
            'an MCP-prefixed name like `mcp__attio__list-records`).',
        },
        input: {
          type: 'object',
          additionalProperties: true,
          description:
            'JSON-serialisable input arguments the agent passed to the ' +
            'tool. Kept open so the floating panel can render any tool ' +
            "args verbatim without the schema being aware of every " +
            'tool surface.',
        },
      },
      additionalProperties: true,
    },
    {
      type: 'object',
      required: ['type', 'toolUseId', 'content', 'isError'],
      properties: {
        type: { const: 'tool_result' },
        toolUseId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description:
            'Matches the `toolUseId` of the originating tool_use ' +
            'block.',
        },
        content: {
          // Tool results can be a plain string, an array of structured
          // content parts, or an SDK-shaped object. We keep the field
          // schema-less (`additionalProperties: true` on the outer
          // object lets `content` accept any JSON value) by omitting a
          // `type` constraint here. AJV without `strictTypes` accepts
          // an absent `type` as "any JSON value" — exactly the shape
          // we want.
          description:
            'Tool result payload as the SDK surfaced it. May be a ' +
            'string, an array of content blocks, or a structured ' +
            'object — the floating panel renders the value verbatim.',
        },
        isError: {
          type: 'boolean',
          description:
            'True when the SDK flagged the tool result as an error so ' +
            'the floating panel can render a destructive variant.',
        },
      },
      additionalProperties: true,
    },
  ],
  description:
    'One persisted tool-invocation block — either a `tool_use` ' +
    'request or its matching `tool_result`.',
};

/**
 * Schema for a single message inside a conversation document.
 *
 * Required fields are intentionally minimal so user turns (which carry
 * just text) and assistant turns (which may carry text + tool blocks)
 * share one shape. The optional `tools` array exists so historical
 * tool invocations survive a page reload — without it the panel would
 * have to re-render replays as plain text.
 */
export const chatMessageSchema = {
  $id: 'aweek://schemas/chat-message',
  type: 'object',
  required: ['id', 'role', 'content', 'createdAt'],
  properties: {
    id: {
      type: 'string',
      // Permissive id pattern: client-generated UUIDs, server-generated
      // `msg-<hex>` identifiers, and Anthropic SDK message UUIDs all
      // fit. We require at least one character and cap the length so
      // pathological values can't bloat the file.
      minLength: 1,
      maxLength: 128,
      description:
        'Stable message id. Client-generated for user turns, ' +
        'server/SDK-generated for assistant turns. Must be unique ' +
        'within a conversation.',
    },
    role: {
      type: 'string',
      enum: CHAT_MESSAGE_ROLES,
      description:
        '`user` for composer-authored turns, `assistant` for agent ' +
        'replies. v1 has no `system` role on persisted threads — the ' +
        'auto-injected preamble is composed at request time and not ' +
        'stored.',
    },
    content: {
      type: 'string',
      // Length cap is generous (1 MiB worth of UTF-8) so long-form
      // assistant replies fit but a runaway loop cannot fill the file.
      maxLength: 1_048_576,
      description:
        'Concatenated natural-language text for the turn. Tool-use ' +
        'blocks live in the optional `tools` array; this field carries ' +
        'only the prose the user / agent typed.',
    },
    tools: {
      type: 'array',
      items: { $ref: 'aweek://schemas/chat-tool-block' },
      description:
        'Optional ordered list of tool-invocation blocks emitted ' +
        'during this turn. Order matches the SDK delivery order so the ' +
        'floating panel can render tool_use / tool_result pairs in ' +
        'sequence.',
    },
    createdAt: {
      type: 'string',
      format: 'date-time',
      description:
        'ISO-8601 timestamp when the message was created. User turns ' +
        'use the moment the composer submitted; assistant turns use ' +
        'the moment the SDK emitted the terminal result event.',
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description:
        'Forward-compatible extensibility bag — future fields like ' +
        'token counts, model id, finish reason, can land here without ' +
        'a breaking schema revision.',
    },
  },
  additionalProperties: false,
};

/**
 * Schema for a persisted chat conversation (one thread).
 *
 * The conversation id pattern (`^chat-[a-z0-9]+(-[a-z0-9]+)*$`) is
 * intentionally filesystem-safe so it can be used directly as the
 * basename of `<id>.json` under `.aweek/agents/<slug>/chat/`. The
 * `agentId` pattern matches the canonical subagent slug regex used by
 * `agentConfigSchema` (`SUBAGENT_SLUG_PATTERN`) so persistence callers
 * can validate that a conversation belongs to a real agent without a
 * second cross-schema check.
 */
export const chatConversationSchema = {
  $id: 'aweek://schemas/chat-conversation',
  type: 'object',
  required: ['id', 'agentId', 'messages', 'createdAt', 'updatedAt'],
  properties: {
    id: {
      type: 'string',
      pattern: '^chat-[a-z0-9]+(-[a-z0-9]+)*$',
      maxLength: 128,
      description:
        'Filesystem-safe conversation id (basename of the on-disk ' +
        'JSON file). Generated when the thread is created and ' +
        'immutable thereafter.',
    },
    agentId: {
      type: 'string',
      pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
      description:
        'Slug of the aweek agent / Claude Code subagent this thread ' +
        'targets. Equals the directory under `.aweek/agents/` that ' +
        'holds the conversation file.',
    },
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description:
        'Optional short user-editable label rendered in the thread ' +
        'list. Defaults to a derived label (e.g. the first user ' +
        'message truncated) when the user has not set one.',
    },
    messages: {
      type: 'array',
      items: { $ref: 'aweek://schemas/chat-message' },
      description:
        'Ordered append-only list of messages in the thread, oldest ' +
        'first. v1 has no edit / delete-message / regenerate; the only ' +
        'mutation is appending a new message.',
    },
    createdAt: {
      type: 'string',
      format: 'date-time',
      description:
        'ISO-8601 timestamp when the conversation was first created.',
    },
    updatedAt: {
      type: 'string',
      format: 'date-time',
      description:
        'ISO-8601 timestamp of the last write to this conversation. ' +
        'Bumped every time a message is appended or the title is ' +
        'edited so the thread list can sort by recency.',
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description:
        'Forward-compatible extensibility bag — future fields like ' +
        'pinned, archived, tags, lastReadAt can land here without a ' +
        'breaking schema revision.',
    },
  },
  additionalProperties: false,
};

/**
 * Schema for an array of chat conversations — the shape returned by the
 * thread-list endpoint when it enumerates every thread for an agent.
 */
export const chatConversationListSchema = {
  $id: 'aweek://schemas/chat-conversation-list',
  type: 'array',
  items: { $ref: 'aweek://schemas/chat-conversation' },
  description:
    'Ordered list of chat conversations for an agent (typically sorted ' +
    'by `updatedAt` descending so the most-recent thread appears first).',
};
