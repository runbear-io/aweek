/**
 * Tests for agent.schema.js — subagentRef-based identity model.
 *
 * These tests lock in the 1-to-1 subagent wrapper contract:
 *   - No `identity` field in aweek JSON.
 *   - `subagentRef` is a required slug matching lowercase alphanumeric with hyphens.
 *   - `identitySchema` no longer exists (single source of truth moved to
 *     `.claude/agents/SLUG.md`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as agentSchemaModule from './agent.schema.js';
import { agentConfigSchema, SUBAGENT_SLUG_PATTERN } from './agent.schema.js';
import { validateAgentConfig } from './validator.js';

const baseBudget = {
  weeklyTokenLimit: 500000,
  currentUsage: 0,
  periodStart: '2026-04-13T00:00:00.000Z',
};

function makeValidConfig(overrides = {}) {
  return {
    id: 'writer',
    subagentRef: 'writer',
    goals: [],
    budget: baseBudget,
    createdAt: '2026-04-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('agent.schema — subagentRef refactor', () => {
  describe('identity removal', () => {
    it('does not export identitySchema', () => {
      assert.equal(
        'identitySchema' in agentSchemaModule,
        false,
        'identitySchema must be deleted from agent.schema.js',
      );
    });

    it('agentConfigSchema has no `identity` property', () => {
      assert.equal(
        Object.prototype.hasOwnProperty.call(agentConfigSchema.properties, 'identity'),
        false,
      );
      assert.equal(agentConfigSchema.required.includes('identity'), false);
    });

    it('rejects configs that still carry an `identity` object (additionalProperties: false)', () => {
      const result = validateAgentConfig({
        ...makeValidConfig(),
        identity: { name: 'Writer', role: 'writer', systemPrompt: 'hi' },
      });
      assert.equal(result.valid, false);
    });
  });

  describe('subagentRef field', () => {
    it('is listed as required on agentConfigSchema', () => {
      assert.ok(agentConfigSchema.required.includes('subagentRef'));
    });

    it('uses the slug pattern', () => {
      assert.equal(
        agentConfigSchema.properties.subagentRef.pattern,
        SUBAGENT_SLUG_PATTERN,
      );
      assert.equal(agentConfigSchema.properties.subagentRef.type, 'string');
    });

    it('accepts a valid lowercase-hyphen slug', () => {
      const result = validateAgentConfig(
        makeValidConfig({ id: 'content-writer', subagentRef: 'content-writer' }),
      );
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it('accepts single-segment lowercase slugs', () => {
      const result = validateAgentConfig(
        makeValidConfig({ id: 'writer', subagentRef: 'writer' }),
      );
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it('accepts alphanumeric slugs', () => {
      const result = validateAgentConfig(
        makeValidConfig({ id: 'agent-42', subagentRef: 'agent-42' }),
      );
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it('rejects slugs with uppercase characters', () => {
      const result = validateAgentConfig(
        makeValidConfig({ id: 'writer', subagentRef: 'Writer' }),
      );
      assert.equal(result.valid, false);
    });

    it('rejects slugs with underscores', () => {
      const result = validateAgentConfig(
        makeValidConfig({ id: 'writer', subagentRef: 'content_writer' }),
      );
      assert.equal(result.valid, false);
    });

    it('rejects slugs with spaces', () => {
      const result = validateAgentConfig(
        makeValidConfig({ id: 'writer', subagentRef: 'content writer' }),
      );
      assert.equal(result.valid, false);
    });

    it('rejects leading hyphen', () => {
      const result = validateAgentConfig(
        makeValidConfig({ id: 'writer', subagentRef: '-writer' }),
      );
      assert.equal(result.valid, false);
    });

    it('rejects trailing hyphen', () => {
      const result = validateAgentConfig(
        makeValidConfig({ id: 'writer', subagentRef: 'writer-' }),
      );
      assert.equal(result.valid, false);
    });

    it('rejects consecutive hyphens', () => {
      const result = validateAgentConfig(
        makeValidConfig({ id: 'writer', subagentRef: 'content--writer' }),
      );
      assert.equal(result.valid, false);
    });

    it('rejects empty string', () => {
      const result = validateAgentConfig(
        makeValidConfig({ id: 'writer', subagentRef: '' }),
      );
      assert.equal(result.valid, false);
    });

    it('rejects missing subagentRef', () => {
      const config = makeValidConfig();
      delete config.subagentRef;
      const result = validateAgentConfig(config);
      assert.equal(result.valid, false);
      const message = result.errors.map((e) => e.message).join(' ');
      assert.match(message, /subagentRef/);
    });

    it('rejects non-string subagentRef', () => {
      const result = validateAgentConfig(
        makeValidConfig({ subagentRef: 42 }),
      );
      assert.equal(result.valid, false);
    });
  });

  describe('id field', () => {
    it('uses the same slug pattern as subagentRef', () => {
      assert.equal(agentConfigSchema.properties.id.pattern, SUBAGENT_SLUG_PATTERN);
    });

    it('rejects the legacy `agent-...` prefix requirement being gone — plain slugs pass', () => {
      const result = validateAgentConfig(
        makeValidConfig({ id: 'writer', subagentRef: 'writer' }),
      );
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });
  });
});
