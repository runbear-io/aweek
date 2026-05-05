/**
 * Tests for the chat-side budget gate (`src/serve/data/chat-budget.ts`).
 *
 * Sub-AC 2 of AC 7: chat turns must be rejected with a structured
 * `budget_exhausted` verdict once the agent's weekly budget is spent.
 *
 * Coverage:
 *   - Verdict shape under each branch (allowed / numeric exhaustion /
 *     manual pause / unbounded budget).
 *   - Argument validation (missing agentId / stores throws).
 *   - SSE-frame builder produces the on-wire shape with the expected
 *     human-readable message.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBudgetExhaustedFrame,
  checkChatBudget,
  type ChatBudgetAgentConfig,
  type ChatBudgetAgentStoreLike,
  type ChatBudgetUsageStoreLike,
} from './chat-budget.js';
import type { UsageWeeklyTotal } from '../../storage/usage-store.js';

/** Build an in-memory agent store stub returning a fixed config. */
function fakeAgentStore(
  config: ChatBudgetAgentConfig,
): ChatBudgetAgentStoreLike {
  return {
    load: async (_id) => config as never,
  };
}

/** Build an in-memory usage store stub returning a fixed weekly total. */
function fakeUsageStore(totalTokens: number): ChatBudgetUsageStoreLike {
  return {
    weeklyTotal: async (_id, weekMonday): Promise<UsageWeeklyTotal> => ({
      weekMonday: weekMonday || '2026-04-13',
      recordCount: 1,
      inputTokens: totalTokens,
      outputTokens: 0,
      totalTokens,
      costUsd: 0,
    }),
  };
}

describe('checkChatBudget — verdict branches', () => {
  it('allows the turn when usage is below the limit', async () => {
    const verdict = await checkChatBudget({
      agentId: 'writer',
      agentStore: fakeAgentStore({
        weeklyTokenBudget: 1000,
        budget: { weeklyTokenLimit: 1000, paused: false },
      }),
      usageStore: fakeUsageStore(500),
      weekMonday: '2026-04-13',
    });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reason, null);
    assert.equal(verdict.used, 500);
    assert.equal(verdict.budget, 1000);
    assert.equal(verdict.remaining, 500);
    assert.equal(verdict.paused, false);
  });

  it('blocks the turn when usage equals the limit (numeric exhaustion)', async () => {
    const verdict = await checkChatBudget({
      agentId: 'writer',
      agentStore: fakeAgentStore({
        weeklyTokenBudget: 1000,
        budget: { weeklyTokenLimit: 1000, paused: false },
      }),
      usageStore: fakeUsageStore(1000),
      weekMonday: '2026-04-13',
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'budget_exhausted');
    assert.equal(verdict.used, 1000);
    assert.equal(verdict.budget, 1000);
    assert.equal(verdict.remaining, 0);
  });

  it('blocks the turn when usage exceeds the limit', async () => {
    const verdict = await checkChatBudget({
      agentId: 'writer',
      agentStore: fakeAgentStore({
        weeklyTokenBudget: 1000,
        budget: { weeklyTokenLimit: 1000, paused: false },
      }),
      usageStore: fakeUsageStore(1500),
      weekMonday: '2026-04-13',
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'budget_exhausted');
    assert.equal(verdict.used, 1500);
    assert.equal(verdict.remaining, 0);
  });

  it('blocks the turn when the agent is paused even with usage below the limit', async () => {
    const verdict = await checkChatBudget({
      agentId: 'writer',
      agentStore: fakeAgentStore({
        weeklyTokenBudget: 1000,
        budget: { weeklyTokenLimit: 1000, paused: true },
      }),
      usageStore: fakeUsageStore(100),
      weekMonday: '2026-04-13',
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'budget_exhausted');
    assert.equal(verdict.paused, true);
  });

  it('falls back to budget.weeklyTokenLimit when weeklyTokenBudget is absent', async () => {
    const verdict = await checkChatBudget({
      agentId: 'writer',
      agentStore: fakeAgentStore({
        budget: { weeklyTokenLimit: 500, paused: false },
      }),
      usageStore: fakeUsageStore(600),
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.budget, 500);
  });

  it('does not gate on numeric exhaustion when no budget is configured', async () => {
    // Unbounded agent (budget = 0). Pause flag is the only gate, so
    // raw usage above 0 must not block.
    const verdict = await checkChatBudget({
      agentId: 'writer',
      agentStore: fakeAgentStore({
        budget: { paused: false },
      }),
      usageStore: fakeUsageStore(99999),
    });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.budget, 0);
    assert.equal(verdict.remaining, 0);
  });

  it('still blocks on pause when no budget is configured', async () => {
    const verdict = await checkChatBudget({
      agentId: 'writer',
      agentStore: fakeAgentStore({
        budget: { paused: true },
      }),
      usageStore: fakeUsageStore(0),
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'budget_exhausted');
    assert.equal(verdict.paused, true);
  });

  it('rejects missing agentId', async () => {
    await assert.rejects(
      checkChatBudget({
        agentId: '',
        agentStore: fakeAgentStore({}),
        usageStore: fakeUsageStore(0),
      }),
      /agentId/,
    );
  });

  it('rejects missing stores', async () => {
    // @ts-expect-error — intentionally exercising the runtime guard
    await assert.rejects(checkChatBudget({ agentId: 'writer' }), /agentStore/);
  });

  it('falls through (allow) when the agent config is missing (ENOENT)', async () => {
    // Production: an unhired-but-typed slug is a misconfiguration, but
    // it's the SDK invocation's job to surface that as a turn-error.
    // The budget gate should not stand in front of that — its only
    // contract is exhaustion enforcement.
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const verdict = await checkChatBudget({
      agentId: 'writer',
      agentStore: { load: async () => { throw enoent; } },
      usageStore: fakeUsageStore(0),
    });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.budget, 0);
  });

  it('re-throws non-ENOENT agent-config errors so the handler can fail-closed', async () => {
    const boom = Object.assign(new Error('schema mismatch'), { code: 'EVALIDATE' });
    await assert.rejects(
      checkChatBudget({
        agentId: 'writer',
        agentStore: { load: async () => { throw boom; } },
        usageStore: fakeUsageStore(0),
      }),
      /schema mismatch/,
    );
  });
});

describe('buildBudgetExhaustedFrame', () => {
  it('produces a structured SSE frame with reason=budget_exhausted', () => {
    const frame = buildBudgetExhaustedFrame({
      allowed: false,
      reason: 'budget_exhausted',
      agentId: 'writer',
      weekMonday: '2026-04-13',
      used: 1500,
      budget: 1000,
      remaining: 0,
      paused: true,
    });
    assert.equal(frame.type, 'budget-exhausted');
    assert.equal(frame.reason, 'budget_exhausted');
    assert.equal(frame.agentId, 'writer');
    assert.equal(frame.used, 1500);
    assert.equal(frame.budget, 1000);
    assert.equal(frame.paused, true);
    assert.match(frame.message, /weekly token budget/);
    assert.match(frame.message, /Used 1500 of 1000/);
    assert.match(frame.message, /over by 500/);
  });

  it('omits the over-by clause when at-the-limit', () => {
    const frame = buildBudgetExhaustedFrame({
      allowed: false,
      reason: 'budget_exhausted',
      agentId: 'writer',
      weekMonday: '2026-04-13',
      used: 1000,
      budget: 1000,
      remaining: 0,
      paused: false,
    });
    assert.doesNotMatch(frame.message, /over by/);
  });

  it('uses the unbounded-pause message when no budget is configured', () => {
    const frame = buildBudgetExhaustedFrame({
      allowed: false,
      reason: 'budget_exhausted',
      agentId: 'writer',
      weekMonday: '2026-04-13',
      used: 0,
      budget: 0,
      remaining: 0,
      paused: true,
    });
    assert.match(frame.message, /paused/);
    assert.doesNotMatch(frame.message, /weekly token budget/);
  });
});
