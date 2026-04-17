import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  hireAgent,
  formatHireSummary,
  assembleAndSaveAgent,
  formatAgentSummary,
  validateIdentityInput,
  validateGoalsInput,
  validateObjectivesInput,
  validateTasksInput,
  validateTokenLimit,
  getCurrentMonth,
  getCurrentWeek,
} from './hire.js';
import * as createAgent from './create-agent.js';
import { AgentStore } from '../storage/agent-store.js';

describe('hire skill (adapter over create-agent)', () => {
  describe('re-exports', () => {
    it('re-exports the shared pipeline functions verbatim', () => {
      // The adapter must be a true shim: same function references as
      // create-agent.js so there is a single source of truth.
      assert.equal(assembleAndSaveAgent, createAgent.assembleAndSaveAgent);
      assert.equal(formatAgentSummary, createAgent.formatAgentSummary);
      assert.equal(validateIdentityInput, createAgent.validateIdentityInput);
      assert.equal(validateGoalsInput, createAgent.validateGoalsInput);
      assert.equal(validateObjectivesInput, createAgent.validateObjectivesInput);
      assert.equal(validateTasksInput, createAgent.validateTasksInput);
      assert.equal(validateTokenLimit, createAgent.validateTokenLimit);
      assert.equal(getCurrentMonth, createAgent.getCurrentMonth);
      assert.equal(getCurrentWeek, createAgent.getCurrentWeek);
    });
  });

  describe('hireAgent', () => {
    let tmpDir;

    before(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'aweek-hire-test-'));
    });

    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('creates and persists an agent via the shared pipeline', async () => {
      const result = await hireAgent({
        name: 'HireBot',
        role: 'Tests the hire adapter end-to-end',
        systemPrompt: 'You are hired.',
        weeklyTokenLimit: 250000,
        goalDescriptions: ['Prove the hire adapter delegates correctly'],
        objectives: [{ description: 'Run a full save', goalIndex: 0 }],
        tasks: [{ description: 'Confirm on disk', objectiveIndex: 0 }],
        dataDir: tmpDir,
      });

      assert.equal(result.success, true);
      assert.ok(result.config);
      assert.equal(result.config.identity.name, 'HireBot');
      assert.equal(result.config.budget.weeklyTokenLimit, 250000);

      // Verify the agent is actually on disk — confirms the adapter is
      // wired to the real storage layer, not a stub.
      const store = new AgentStore(tmpDir);
      const loaded = await store.load(result.config.id);
      assert.deepStrictEqual(loaded, result.config);
    });

    it('returns the same error shape as assembleAndSaveAgent on invalid input', async () => {
      const result = await hireAgent({
        name: '',
        role: '',
        systemPrompt: '',
        goalDescriptions: [],
        objectives: [],
        tasks: [],
        dataDir: tmpDir,
      });

      assert.equal(result.success, false);
      assert.ok(Array.isArray(result.errors));
      assert.ok(result.errors.length > 0);
    });
  });

  describe('formatHireSummary', () => {
    it('produces the same output as formatAgentSummary', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'aweek-hire-fmt-'));
      const result = await hireAgent({
        name: 'SummaryHire',
        role: 'Exercises the formatter shim',
        systemPrompt: 'Format me.',
        goalDescriptions: ['Ensure formatter parity between modules'],
        objectives: [{ description: 'Format a result', goalIndex: 0 }],
        tasks: [{ description: 'Compare strings', objectiveIndex: 0 }],
        dataDir: tmpDir,
      });

      const hireSummary = formatHireSummary(result.config);
      const createSummary = formatAgentSummary(result.config);
      assert.equal(hireSummary, createSummary);

      // And the summary points at the new consolidated plan skill.
      assert.ok(hireSummary.includes('/aweek:plan'));
      assert.ok(!hireSummary.includes('/aweek:approve-plan'));

      await rm(tmpDir, { recursive: true, force: true });
    });
  });
});
