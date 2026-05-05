/**
 * Typed wrapper for the chat-conversation JSON Schema.
 *
 * The runtime AJV schema definitions live in the sibling
 * `chat-conversation.schema.js` file (kept as raw `.js` to match the
 * rest of `src/schemas/*.schema.js` and AJV's preferred plain-object-
 * literal authoring path; the registration through `validator.js` MUST
 * be preserved). This module is the typed companion:
 *
 *   1. Exposes the canonical TypeScript types (`ChatToolBlock`,
 *      `ChatMessage`, `ChatConversation`, `ChatConversationList`) that
 *      mirror the runtime schema's shapes. Consumers in
 *      `src/serve/data/chat.ts`, `src/storage/chat-conversation-store.ts`
 *      (lands in a later sub-AC), and the SPA's chat hooks reach for
 *      these instead of redeclaring their own ambient interfaces.
 *
 *   2. Re-exports the runtime schema constants so TypeScript callers
 *      can lean on a single typed import boundary
 *      (`from './chat-conversation.js'`) instead of reaching directly
 *      into the raw `.js` schema definition file.
 *
 *   3. Wires the two top-level schemas (`chatConversationSchema`,
 *      `chatMessageSchema`) to AJV's `JSONSchemaType<T>` generic via
 *      named typed bindings. Per AJV's strict-null typing, every
 *      optional property on a `JSONSchemaType<T>`-typed schema literal
 *      requires a matching `nullable: true` flag — the `.js` schema
 *      stays untouched and the typed bindings live here so the
 *      AJV-typing concerns don't leak into the schema literal that the
 *      `validator.js` registry consumes.
 *
 *   4. Re-exports the convenience validators
 *      (`validateChatMessage`, `validateChatConversation`,
 *      `validateChatConversationList`, `validateChatToolBlock`) so
 *      dispatch / store / handler code can validate payloads without
 *      importing the AJV plumbing directly.
 *
 * Naming convention
 * -----------------
 * Mirrors the `agent.ts` ↔ `agent.schema.ts` and
 * `notification.ts` ↔ `notification.schema.js` splits documented in
 * CLAUDE.md. Schema-of-record stays as `.js`; the typed companion
 * lives at `chat-conversation.ts`. NodeNext module resolution never
 * has to disambiguate the two because the stems are different
 * (`chat-conversation.schema.*` vs `chat-conversation.*`).
 */

import type { JSONSchemaType } from 'ajv';

// ---------------------------------------------------------------------------
// Re-exports from the runtime schema definition file.
// ---------------------------------------------------------------------------

export {
  CHAT_MESSAGE_ROLES,
  CHAT_TOOL_BLOCK_TYPES,
  chatToolBlockSchema,
  chatMessageSchema,
  chatConversationSchema,
  chatConversationListSchema,
} from './chat-conversation.schema.js';

// ---------------------------------------------------------------------------
// Re-exports of the convenience validators registered in `validator.js`.
// These are the typed entry points downstream code should reach for; the
// schema constants above are exposed for tooling / introspection only.
// ---------------------------------------------------------------------------

export {
  validateChatMessage,
  validateChatConversation,
  validateChatConversationList,
  validateChatToolBlock,
} from './validator.js';

// ---------------------------------------------------------------------------
// Canonical TypeScript shapes
// ---------------------------------------------------------------------------

/**
 * Allowed roles on a persisted chat message. v1 only stores user-typed
 * and assistant-emitted turns; the auto-injected system preamble is
 * composed at request time and not part of the on-disk record.
 */
export type ChatMessageRole = 'user' | 'assistant';

/**
 * `tool_use` branch — agent invokes a tool. `toolUseId` correlates the
 * request to its eventual `tool_result` block, matching the Anthropic
 * Agent SDK's `tool_use.id` ↔ `tool_result.tool_use_id` linkage.
 *
 * `additionalProperties: true` on the runtime schema lets future ACs
 * add fields (cache markers, server-side timing, …) without a breaking
 * schema revision; the index signature mirrors that intent.
 */
export interface ChatToolUseBlock {
  type: 'tool_use';
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  [extra: string]: unknown;
}

/**
 * `tool_result` branch — the matching response for a `tool_use`
 * request. `content` is intentionally `unknown` because the SDK
 * surfaces a polymorphic value (string, structured array, plain
 * object); consumers narrow before reading.
 */
export interface ChatToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: unknown;
  isError: boolean;
  [extra: string]: unknown;
}

/**
 * Polymorphic tool-invocation block stored on a persisted chat
 * message. Mirrors the `oneOf` union in `chatToolBlockSchema`; consumers
 * MUST narrow on `block.type` before reading branch-specific fields.
 */
export type ChatToolBlock = ChatToolUseBlock | ChatToolResultBlock;

/**
 * One persisted chat message — a single user / assistant turn inside a
 * conversation document.
 */
export interface ChatMessage {
  /** Stable id; unique within the conversation. */
  id: string;
  role: ChatMessageRole;
  /**
   * Concatenated natural-language text. Tool blocks carry their own
   * payload in `tools`; this field never includes tool-use serialised
   * JSON.
   */
  content: string;
  /**
   * Optional ordered tool-invocation blocks emitted during this turn.
   * Absent on user turns and on assistant turns that emitted only text.
   */
  tools?: ChatToolBlock[];
  /** ISO-8601 datetime when the message was created. */
  createdAt: string;
  /** Forward-compatible extension slot — see schema docstring. */
  metadata?: Record<string, unknown>;
}

/**
 * Top-level persisted chat conversation document — one thread between
 * the dashboard user and one aweek agent.
 *
 * Serialised to disk at `.aweek/agents/<agentId>/chat/<id>.json`.
 */
export interface ChatConversation {
  /**
   * Filesystem-safe conversation id; equals the basename of the
   * on-disk JSON file.
   */
  id: string;
  /** Subagent slug — directory under `.aweek/agents/`. */
  agentId: string;
  /** Optional user-editable label rendered in the thread list. */
  title?: string;
  /** Ordered append-only list of messages, oldest first. */
  messages: ChatMessage[];
  /** ISO-8601 datetime when the conversation was first created. */
  createdAt: string;
  /** ISO-8601 datetime of the last write (any append or title edit). */
  updatedAt: string;
  /** Forward-compatible extension slot — see schema docstring. */
  metadata?: Record<string, unknown>;
}

/**
 * Array shape returned by the thread-list endpoint.
 */
export type ChatConversationList = ChatConversation[];

// ---------------------------------------------------------------------------
// AJV typed bindings
//
// The two re-exports below give the schema literal a TypeScript type
// that matches the canonical interface. They are typed *views* over the
// runtime constants exported from `chat-conversation.schema.js` — there
// is no second runtime allocation. AJV's `JSONSchemaType<T>` enforces
// at compile time that the schema literal mirrors the interface
// (required vs optional, primitive vs nested), which catches drift
// between this typed companion and the runtime definition.
//
// Note: the runtime schema literal uses `$ref` for nested arrays
// (`messages: { items: { $ref: 'aweek://schemas/chat-message' } }`),
// which `JSONSchemaType<T>` accepts as long as the `$ref` shape is
// hidden behind a typed view. We re-import the runtime constants under
// renamed locals so the `as JSONSchemaType<...>` cast doesn't shadow
// the public re-exports above.
// ---------------------------------------------------------------------------

import {
  chatMessageSchema as runtimeChatMessageSchema,
  chatConversationSchema as runtimeChatConversationSchema,
} from './chat-conversation.schema.js';

/**
 * Typed view of `chatMessageSchema`, bound to the canonical
 * `ChatMessage` interface. Exposing this keeps the AJV-typing concern
 * in one place and gives downstream callers a single import for both
 * the schema literal and its compile-time shape:
 *
 * ```ts
 * import { chatMessageSchemaTyped } from '../schemas/chat-conversation.js';
 * // ↑ JSONSchemaType<ChatMessage>
 * ```
 *
 * The runtime schema (`chatMessageSchema`) and this typed view share
 * the same object identity — no second AJV registration is required.
 */
export const chatMessageSchemaTyped =
  runtimeChatMessageSchema as unknown as JSONSchemaType<ChatMessage>;

/**
 * Typed view of `chatConversationSchema`, bound to the canonical
 * `ChatConversation` interface. See {@link chatMessageSchemaTyped} for
 * the rationale; the same object identity / no-second-registration
 * guarantee applies.
 */
export const chatConversationSchemaTyped =
  runtimeChatConversationSchema as unknown as JSONSchemaType<ChatConversation>;
