/**
 * Tests for the chat-conversation JSON Schema.
 *
 * Sub-AC 1 of AC 4 contract: validate that the schema enforces the
 * messages / metadata / conversation-id fields described in the seed,
 * and that registration through the AJV validator routes by `$id`. The
 * tool-block sub-schema is exercised standalone (`validateChatToolBlock`)
 * AND through a parent message (`validateChatMessage`) to confirm the
 * `$ref` registration order in `validator.js` resolves correctly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_MESSAGE_ROLES,
  CHAT_TOOL_BLOCK_TYPES,
  chatToolBlockSchema,
  chatMessageSchema,
  chatConversationSchema,
  chatConversationListSchema,
} from './chat-conversation.schema.js';
import {
  validate,
  validateChatToolBlock,
  validateChatMessage,
  validateChatConversation,
  validateChatConversationList,
} from './validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid chat message, optionally overriding fields. */
function makeMessage(overrides = {}) {
  return {
    id: 'msg-aaaaaaaa',
    role: 'user',
    content: 'hello',
    createdAt: '2026-04-27T12:00:00.000Z',
    ...overrides,
  };
}

/** Build a minimal valid chat conversation, optionally overriding fields. */
function makeConversation(overrides = {}) {
  return {
    id: 'chat-deadbeef',
    agentId: 'researcher',
    messages: [makeMessage()],
    createdAt: '2026-04-27T12:00:00.000Z',
    updatedAt: '2026-04-27T12:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('chat-conversation schema — constants', () => {
  it('CHAT_MESSAGE_ROLES contains user + assistant only', () => {
    assert.deepStrictEqual(CHAT_MESSAGE_ROLES, ['user', 'assistant']);
  });

  it('CHAT_TOOL_BLOCK_TYPES contains tool_use + tool_result', () => {
    assert.deepStrictEqual(CHAT_TOOL_BLOCK_TYPES, ['tool_use', 'tool_result']);
  });
});

// ---------------------------------------------------------------------------
// $id wiring
// ---------------------------------------------------------------------------

describe('chat-conversation schema — $id wiring', () => {
  it('chatToolBlockSchema has the canonical $id', () => {
    assert.equal(chatToolBlockSchema.$id, 'aweek://schemas/chat-tool-block');
  });

  it('chatMessageSchema has the canonical $id', () => {
    assert.equal(chatMessageSchema.$id, 'aweek://schemas/chat-message');
  });

  it('chatConversationSchema has the canonical $id', () => {
    assert.equal(
      chatConversationSchema.$id,
      'aweek://schemas/chat-conversation',
    );
  });

  it('chatConversationListSchema has the canonical $id', () => {
    assert.equal(
      chatConversationListSchema.$id,
      'aweek://schemas/chat-conversation-list',
    );
  });

  it('chatMessageSchema references the tool-block sub-schema via $ref', () => {
    const toolsProp = chatMessageSchema.properties.tools;
    assert.ok(toolsProp, 'chatMessageSchema.properties.tools must exist');
    assert.equal(toolsProp.items.$ref, 'aweek://schemas/chat-tool-block');
  });

  it('chatConversationSchema references the message sub-schema via $ref', () => {
    const messagesProp = chatConversationSchema.properties.messages;
    assert.ok(messagesProp, 'chatConversationSchema.properties.messages must exist');
    assert.equal(messagesProp.items.$ref, 'aweek://schemas/chat-message');
  });

  it('chatConversationListSchema references the conversation sub-schema via $ref', () => {
    assert.equal(
      chatConversationListSchema.items.$ref,
      'aweek://schemas/chat-conversation',
    );
  });
});

// ---------------------------------------------------------------------------
// chat-message — required fields
// ---------------------------------------------------------------------------

describe('chat-message schema — required fields', () => {
  it('accepts a minimal valid message', () => {
    const result = validateChatMessage(makeMessage());
    assert.equal(result.valid, true);
  });

  it('rejects a message missing id', () => {
    const bad = makeMessage();
    delete bad.id;
    const result = validateChatMessage(bad);
    assert.equal(result.valid, false);
  });

  it('rejects a message missing role', () => {
    const bad = makeMessage();
    delete bad.role;
    const result = validateChatMessage(bad);
    assert.equal(result.valid, false);
  });

  it('rejects a message missing content', () => {
    const bad = makeMessage();
    delete bad.content;
    const result = validateChatMessage(bad);
    assert.equal(result.valid, false);
  });

  it('rejects a message missing createdAt', () => {
    const bad = makeMessage();
    delete bad.createdAt;
    const result = validateChatMessage(bad);
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// chat-message — role enum
// ---------------------------------------------------------------------------

describe('chat-message schema — role enum', () => {
  it('accepts role=user', () => {
    const result = validateChatMessage(makeMessage({ role: 'user' }));
    assert.equal(result.valid, true);
  });

  it('accepts role=assistant', () => {
    const result = validateChatMessage(makeMessage({ role: 'assistant' }));
    assert.equal(result.valid, true);
  });

  it('rejects role=system (no system role on persisted threads)', () => {
    const result = validateChatMessage(makeMessage({ role: 'system' }));
    assert.equal(result.valid, false);
  });

  it('rejects an arbitrary role string', () => {
    const result = validateChatMessage(makeMessage({ role: 'tool' }));
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// chat-message — content
// ---------------------------------------------------------------------------

describe('chat-message schema — content', () => {
  it('accepts an empty string (assistant placeholders start empty)', () => {
    const result = validateChatMessage(makeMessage({ content: '' }));
    assert.equal(result.valid, true);
  });

  it('rejects a non-string content', () => {
    const result = validateChatMessage(makeMessage({ content: 123 }));
    assert.equal(result.valid, false);
  });

  it('rejects content longer than 1 MiB', () => {
    const tooLong = 'a'.repeat(1_048_577);
    const result = validateChatMessage(makeMessage({ content: tooLong }));
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// chat-message — id pattern
// ---------------------------------------------------------------------------

describe('chat-message schema — id', () => {
  it('accepts a UUID-shaped id', () => {
    const result = validateChatMessage(
      makeMessage({ id: '11111111-1111-1111-1111-111111111111' }),
    );
    assert.equal(result.valid, true);
  });

  it('accepts a server-generated msg-<hex> id', () => {
    const result = validateChatMessage(makeMessage({ id: 'msg-cafe1234' }));
    assert.equal(result.valid, true);
  });

  it('rejects an empty id', () => {
    const result = validateChatMessage(makeMessage({ id: '' }));
    assert.equal(result.valid, false);
  });

  it('rejects an id over 128 characters', () => {
    const result = validateChatMessage(makeMessage({ id: 'a'.repeat(129) }));
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// chat-message — additionalProperties: false
// ---------------------------------------------------------------------------

describe('chat-message schema — additionalProperties', () => {
  it('rejects unknown top-level fields on a message', () => {
    const result = validateChatMessage(
      makeMessage({ unknownField: 'should fail' }),
    );
    assert.equal(result.valid, false);
  });

  it('accepts arbitrary keys inside the metadata bag', () => {
    const result = validateChatMessage(
      makeMessage({
        metadata: {
          tokenCount: 42,
          model: 'claude-sonnet-4',
          finishReason: 'end_turn',
        },
      }),
    );
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// chat-tool-block — tool_use branch
// ---------------------------------------------------------------------------

describe('chat-tool-block — tool_use branch', () => {
  it('accepts a valid tool_use block', () => {
    const result = validateChatToolBlock({
      type: 'tool_use',
      toolUseId: 'toolu_abc',
      name: 'Read',
      input: { file_path: '/tmp/x' },
    });
    assert.equal(result.valid, true);
  });

  it('accepts an MCP-prefixed tool name', () => {
    const result = validateChatToolBlock({
      type: 'tool_use',
      toolUseId: 'toolu_abc',
      name: 'mcp__attio__list-records',
      input: {},
    });
    assert.equal(result.valid, true);
  });

  it('accepts an empty input object (some tools take no args)', () => {
    const result = validateChatToolBlock({
      type: 'tool_use',
      toolUseId: 'toolu_abc',
      name: 'TaskList',
      input: {},
    });
    assert.equal(result.valid, true);
  });

  it('rejects a tool_use missing toolUseId', () => {
    const result = validateChatToolBlock({
      type: 'tool_use',
      name: 'Read',
      input: {},
    });
    assert.equal(result.valid, false);
  });

  it('rejects a tool_use missing name', () => {
    const result = validateChatToolBlock({
      type: 'tool_use',
      toolUseId: 'toolu_abc',
      input: {},
    });
    assert.equal(result.valid, false);
  });

  it('rejects a tool_use missing input', () => {
    const result = validateChatToolBlock({
      type: 'tool_use',
      toolUseId: 'toolu_abc',
      name: 'Read',
    });
    assert.equal(result.valid, false);
  });

  it('rejects a tool_use with a non-object input', () => {
    const result = validateChatToolBlock({
      type: 'tool_use',
      toolUseId: 'toolu_abc',
      name: 'Read',
      input: 'not-an-object',
    });
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// chat-tool-block — tool_result branch
// ---------------------------------------------------------------------------

describe('chat-tool-block — tool_result branch', () => {
  it('accepts a string content tool_result', () => {
    const result = validateChatToolBlock({
      type: 'tool_result',
      toolUseId: 'toolu_abc',
      content: 'file contents here',
      isError: false,
    });
    assert.equal(result.valid, true);
  });

  it('accepts a structured array content tool_result', () => {
    const result = validateChatToolBlock({
      type: 'tool_result',
      toolUseId: 'toolu_abc',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
    assert.equal(result.valid, true);
  });

  it('accepts an object content tool_result', () => {
    const result = validateChatToolBlock({
      type: 'tool_result',
      toolUseId: 'toolu_abc',
      content: { stdout: 'ok', stderr: '', exitCode: 0 },
      isError: false,
    });
    assert.equal(result.valid, true);
  });

  it('accepts an isError=true result (the floating panel renders destructive variant)', () => {
    const result = validateChatToolBlock({
      type: 'tool_result',
      toolUseId: 'toolu_abc',
      content: 'permission denied',
      isError: true,
    });
    assert.equal(result.valid, true);
  });

  it('rejects a tool_result missing toolUseId', () => {
    const result = validateChatToolBlock({
      type: 'tool_result',
      content: 'x',
      isError: false,
    });
    assert.equal(result.valid, false);
  });

  it('rejects a tool_result missing isError', () => {
    const result = validateChatToolBlock({
      type: 'tool_result',
      toolUseId: 'toolu_abc',
      content: 'x',
    });
    assert.equal(result.valid, false);
  });

  it('rejects a tool_result with a non-boolean isError', () => {
    const result = validateChatToolBlock({
      type: 'tool_result',
      toolUseId: 'toolu_abc',
      content: 'x',
      isError: 'no',
    });
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// chat-tool-block — neither-branch values
// ---------------------------------------------------------------------------

describe('chat-tool-block — union rejects invalid types', () => {
  it('rejects an unknown type value', () => {
    const result = validateChatToolBlock({
      type: 'tool_call',
      toolUseId: 'toolu_abc',
    });
    assert.equal(result.valid, false);
  });

  it('rejects a primitive', () => {
    const result = validateChatToolBlock('tool_use');
    assert.equal(result.valid, false);
  });

  it('rejects null', () => {
    const result = validateChatToolBlock(null);
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// chat-message — embedded tool blocks
// ---------------------------------------------------------------------------

describe('chat-message schema — tools array', () => {
  it('accepts a message with tool_use + tool_result blocks', () => {
    const result = validateChatMessage(
      makeMessage({
        role: 'assistant',
        content: 'I read the file.',
        tools: [
          {
            type: 'tool_use',
            toolUseId: 'toolu_abc',
            name: 'Read',
            input: { file_path: '/tmp/x' },
          },
          {
            type: 'tool_result',
            toolUseId: 'toolu_abc',
            content: 'file contents',
            isError: false,
          },
        ],
      }),
    );
    assert.equal(result.valid, true);
  });

  it('accepts a message with no tools field', () => {
    const result = validateChatMessage(makeMessage());
    assert.equal(result.valid, true);
  });

  it('accepts a message with an empty tools array', () => {
    const result = validateChatMessage(makeMessage({ tools: [] }));
    assert.equal(result.valid, true);
  });

  it('rejects a message with a malformed tool block', () => {
    const result = validateChatMessage(
      makeMessage({
        tools: [
          {
            type: 'tool_use',
            // missing toolUseId / name / input
          },
        ],
      }),
    );
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// chat-conversation — required fields
// ---------------------------------------------------------------------------

describe('chat-conversation schema — required fields', () => {
  it('accepts a minimal valid conversation', () => {
    const result = validateChatConversation(makeConversation());
    assert.equal(result.valid, true);
  });

  it('accepts an empty messages array (newly created thread)', () => {
    const result = validateChatConversation(
      makeConversation({ messages: [] }),
    );
    assert.equal(result.valid, true);
  });

  it('rejects a conversation missing id', () => {
    const bad = makeConversation();
    delete bad.id;
    const result = validateChatConversation(bad);
    assert.equal(result.valid, false);
  });

  it('rejects a conversation missing agentId', () => {
    const bad = makeConversation();
    delete bad.agentId;
    const result = validateChatConversation(bad);
    assert.equal(result.valid, false);
  });

  it('rejects a conversation missing messages', () => {
    const bad = makeConversation();
    delete bad.messages;
    const result = validateChatConversation(bad);
    assert.equal(result.valid, false);
  });

  it('rejects a conversation missing createdAt', () => {
    const bad = makeConversation();
    delete bad.createdAt;
    const result = validateChatConversation(bad);
    assert.equal(result.valid, false);
  });

  it('rejects a conversation missing updatedAt', () => {
    const bad = makeConversation();
    delete bad.updatedAt;
    const result = validateChatConversation(bad);
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// chat-conversation — id pattern (filesystem-safe)
// ---------------------------------------------------------------------------

describe('chat-conversation schema — id pattern', () => {
  it('accepts a chat-<hex> id', () => {
    const result = validateChatConversation(
      makeConversation({ id: 'chat-cafef00d' }),
    );
    assert.equal(result.valid, true);
  });

  it('accepts a multi-segment id (chat-2026-04-27-abc)', () => {
    const result = validateChatConversation(
      makeConversation({ id: 'chat-2026-04-27-abc' }),
    );
    assert.equal(result.valid, true);
  });

  it('rejects an id without the chat- prefix', () => {
    const result = validateChatConversation(
      makeConversation({ id: 'thread-1' }),
    );
    assert.equal(result.valid, false);
  });

  it('rejects an id with uppercase letters (not filesystem-safe)', () => {
    const result = validateChatConversation(
      makeConversation({ id: 'chat-DEADBEEF' }),
    );
    assert.equal(result.valid, false);
  });

  it('rejects an id with path separators', () => {
    const result = validateChatConversation(
      makeConversation({ id: 'chat-../escape' }),
    );
    assert.equal(result.valid, false);
  });

  it('rejects an id over 128 characters', () => {
    const longId = `chat-${'a'.repeat(200)}`;
    const result = validateChatConversation(
      makeConversation({ id: longId }),
    );
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// chat-conversation — agentId pattern (matches subagent slug)
// ---------------------------------------------------------------------------

describe('chat-conversation schema — agentId pattern', () => {
  it('accepts a single-token slug', () => {
    const result = validateChatConversation(
      makeConversation({ agentId: 'researcher' }),
    );
    assert.equal(result.valid, true);
  });

  it('accepts a hyphenated slug', () => {
    const result = validateChatConversation(
      makeConversation({ agentId: 'research-assistant' }),
    );
    assert.equal(result.valid, true);
  });

  it('rejects a slug with uppercase letters', () => {
    const result = validateChatConversation(
      makeConversation({ agentId: 'Researcher' }),
    );
    assert.equal(result.valid, false);
  });

  it('rejects a slug with consecutive hyphens', () => {
    const result = validateChatConversation(
      makeConversation({ agentId: 'researcher--assistant' }),
    );
    assert.equal(result.valid, false);
  });

  it('rejects a slug starting with a hyphen', () => {
    const result = validateChatConversation(
      makeConversation({ agentId: '-researcher' }),
    );
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// chat-conversation — title field
// ---------------------------------------------------------------------------

describe('chat-conversation schema — title', () => {
  it('accepts an omitted title', () => {
    const c = makeConversation();
    assert.equal('title' in c, false);
    const result = validateChatConversation(c);
    assert.equal(result.valid, true);
  });

  it('accepts a non-empty title', () => {
    const result = validateChatConversation(
      makeConversation({ title: 'Research Q3 launch plan' }),
    );
    assert.equal(result.valid, true);
  });

  it('rejects an empty title', () => {
    const result = validateChatConversation(
      makeConversation({ title: '' }),
    );
    assert.equal(result.valid, false);
  });

  it('rejects a title over 200 characters', () => {
    const result = validateChatConversation(
      makeConversation({ title: 'x'.repeat(201) }),
    );
    assert.equal(result.valid, false);
  });

  it('rejects a non-string title', () => {
    const result = validateChatConversation(
      makeConversation({ title: 42 }),
    );
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// chat-conversation — additionalProperties: false + metadata bag
// ---------------------------------------------------------------------------

describe('chat-conversation schema — additionalProperties', () => {
  it('rejects unknown top-level fields on a conversation', () => {
    const result = validateChatConversation(
      makeConversation({ unknownField: 'nope' }),
    );
    assert.equal(result.valid, false);
  });

  it('accepts arbitrary keys inside the metadata bag', () => {
    const result = validateChatConversation(
      makeConversation({
        metadata: {
          pinned: true,
          tags: ['research', 'q3'],
          lastReadAt: '2026-04-27T13:00:00.000Z',
        },
      }),
    );
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// chat-conversation — embedded messages validation
// ---------------------------------------------------------------------------

describe('chat-conversation schema — embedded messages', () => {
  it('accepts a multi-turn conversation', () => {
    const result = validateChatConversation(
      makeConversation({
        messages: [
          makeMessage({ id: 'msg-1', role: 'user', content: 'hello' }),
          makeMessage({
            id: 'msg-2',
            role: 'assistant',
            content: 'hi there',
          }),
          makeMessage({ id: 'msg-3', role: 'user', content: 'thanks' }),
        ],
      }),
    );
    assert.equal(result.valid, true);
  });

  it('rejects when an embedded message has an invalid role', () => {
    const result = validateChatConversation(
      makeConversation({
        messages: [makeMessage({ role: 'system' })],
      }),
    );
    assert.equal(result.valid, false);
  });

  it('rejects when an embedded message is missing required fields', () => {
    const result = validateChatConversation(
      makeConversation({
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            // missing content + createdAt
          },
        ],
      }),
    );
    assert.equal(result.valid, false);
  });

  it('rejects when messages is not an array', () => {
    const result = validateChatConversation(
      makeConversation({ messages: 'not-an-array' }),
    );
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// chat-conversation-list — array validation
// ---------------------------------------------------------------------------

describe('chat-conversation-list schema', () => {
  it('accepts an empty list', () => {
    const result = validateChatConversationList([]);
    assert.equal(result.valid, true);
  });

  it('accepts a list of valid conversations', () => {
    const result = validateChatConversationList([
      makeConversation({ id: 'chat-aaaaaaaa' }),
      makeConversation({ id: 'chat-bbbbbbbb' }),
      makeConversation({ id: 'chat-cccccccc', title: 'Pinned thread' }),
    ]);
    assert.equal(result.valid, true);
  });

  it('rejects a list containing a malformed conversation', () => {
    const bad = makeConversation();
    delete bad.id;
    const result = validateChatConversationList([
      makeConversation({ id: 'chat-aaaaaaaa' }),
      bad,
    ]);
    assert.equal(result.valid, false);
  });

  it('rejects a non-array value', () => {
    const result = validateChatConversationList({
      not: 'an-array',
    });
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Generic validator dispatch (mirrors how callers reach the schema by id)
// ---------------------------------------------------------------------------

describe('chat-conversation schema — registered $id-based dispatch', () => {
  it('validate(aweek://schemas/chat-message, ...) routes correctly', () => {
    const result = validate('aweek://schemas/chat-message', makeMessage());
    assert.equal(result.valid, true);
  });

  it('validate(aweek://schemas/chat-conversation, ...) routes correctly', () => {
    const result = validate(
      'aweek://schemas/chat-conversation',
      makeConversation(),
    );
    assert.equal(result.valid, true);
  });

  it('validate(aweek://schemas/chat-conversation-list, ...) routes correctly', () => {
    const result = validate('aweek://schemas/chat-conversation-list', [
      makeConversation(),
    ]);
    assert.equal(result.valid, true);
  });

  it('validate(aweek://schemas/chat-tool-block, ...) routes correctly', () => {
    const result = validate('aweek://schemas/chat-tool-block', {
      type: 'tool_use',
      toolUseId: 'toolu_abc',
      name: 'Read',
      input: {},
    });
    assert.equal(result.valid, true);
  });
});
