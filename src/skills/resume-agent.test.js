import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentStore } from '../storage/agent-store.js';
import { createAgentConfig } from '../models/agent.js';
import {
  RESUME_ACTIONS,
  listPausedAgents,
  getPausedAgentDetails,
  validateResumeAction,
  executeResume,
  formatPausedAgentsList,
  formatPausedAgentDetails,
  formatResumeResult,
} from './resume-agent.js';

// Helper: create a valid agent config and save it, then optionally patch budget fields
async function createTestAgent(dataDir, nameStr, { role, budget: budgetOverrides, weeklyTokenLimit } = {}) {
  const agentStore = new AgentStore(dataDir);
  const config = createAgentConfig({
    subagentRef: nameStr,
    weeklyTokenLimit: weeklyTokenLimit || budgetOverrides?.weeklyTokenLimit || 100000,
  });

  // Apply budget overrides after creation
  if (budgetOverrides) {
    if (budgetOverrides.paused !== undefined) config.budget.paused = budgetOverrides.paused;
    if (budgetOverrides.currentUsage !== undefined) config.budget.currentUsage = budgetOverrides.currentUsage;
    if (budgetOverrides.weeklyTokenLimit !== undefined) {
      config.budget.weeklyTokenLimit = budgetOverrides.weeklyTokenLimit;
      config.weeklyTokenBudget = budgetOverrides.weeklyTokenLimit;
    }
  }

  await agentStore.save(config);
  return config;
}

describe('resume-agent skill', () => {
  let dataDir;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'resume-agent-test-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // RESUME_ACTIONS constant
  // -----------------------------------------------------------------------
  describe('RESUME_ACTIONS', () => {
    it('contains resume, top-up, and cancel', () => {
      assert.deepStrictEqual(RESUME_ACTIONS, ['resume', 'top-up', 'cancel']);
    });
  });

  // -----------------------------------------------------------------------
  // listPausedAgents
  // -----------------------------------------------------------------------
  describe('listPausedAgents', () => {
    it('returns empty list when no agents exist', async () => {
      const result = await listPausedAgents({ dataDir });
      assert.equal(result.paused.length, 0);
      assert.equal(result.active.length, 0);
      assert.equal(result.total, 0);
    });

    it('separates paused and active agents', async () => {
      const alice = await createTestAgent(dataDir, 'alice', {
        budget: { paused: true, currentUsage: 120000, weeklyTokenLimit: 100000 },
      });
      const bob = await createTestAgent(dataDir, 'bob', {
        budget: { paused: false },
      });

      const result = await listPausedAgents({ dataDir });
      assert.equal(result.total, 2);
      assert.equal(result.paused.length, 1);
      assert.equal(result.paused[0].id, alice.id);
      assert.equal(result.paused[0].budget.paused, true);
      assert.equal(result.active.length, 1);
      assert.equal(result.active[0], bob.id);
    });

    it('includes budget details for paused agents', async () => {
      const agent = await createTestAgent(dataDir, 'pausedone', {
        role: 'worker',
        budget: { paused: true, currentUsage: 150000, weeklyTokenLimit: 100000 },
      });

      const result = await listPausedAgents({ dataDir });
      assert.equal(result.paused[0].name, 'pausedone');
      assert.equal(result.paused[0].role, '');
      assert.equal(result.paused[0].budget.currentUsage, 150000);
      assert.equal(result.paused[0].budget.weeklyTokenLimit, 100000);
    });

    it('throws if dataDir is missing', async () => {
      await assert.rejects(() => listPausedAgents({}), /dataDir is required/);
    });
  });

  // -----------------------------------------------------------------------
  // getPausedAgentDetails
  // -----------------------------------------------------------------------
  describe('getPausedAgentDetails', () => {
    it('returns paused details with budget info', async () => {
      const agent = await createTestAgent(dataDir, 'agentx', {
        role: 'coder',
        budget: { paused: true, currentUsage: 110000, weeklyTokenLimit: 100000 },
      });

      const details = await getPausedAgentDetails(agent.id, { dataDir });
      assert.equal(details.paused, true);
      assert.equal(details.agentId, agent.id);
      assert.equal(details.name, 'agentx');
      assert.equal(details.budget.weeklyTokenLimit, 100000);
      assert.equal(details.budget.currentUsage, 110000);
      assert.equal(details.budget.exceededBy, 10000);
    });

    it('returns not-paused message for active agents', async () => {
      const agent = await createTestAgent(dataDir, 'activeone', {
        budget: { paused: false },
      });

      const details = await getPausedAgentDetails(agent.id, { dataDir });
      assert.equal(details.paused, false);
      assert.ok(details.message.includes('not paused'));
    });

    it('includes alert info when alert file exists', async () => {
      const agent = await createTestAgent(dataDir, 'alerted', {
        budget: { paused: true, currentUsage: 120000, weeklyTokenLimit: 100000 },
      });
      // Write an alert file
      const alertDir = join(dataDir, agent.id, 'alerts');
      await mkdir(alertDir, { recursive: true });
      const alertData = {
        type: 'budget-exhausted',
        agentId: agent.id,
        weekMonday: '2026-04-13',
        used: 120000,
        budget: 100000,
        exceededBy: 20000,
        timestamp: '2026-04-15T10:00:00.000Z',
        message: `Agent "${agent.id}" has exhausted its weekly token budget.`,
      };
      await writeFile(join(alertDir, 'budget-exhausted-2026-04-13.json'), JSON.stringify(alertData));

      const details = await getPausedAgentDetails(agent.id, { dataDir, weekMonday: '2026-04-13' });
      assert.ok(details.alert);
      assert.equal(details.alert.timestamp, '2026-04-15T10:00:00.000Z');
      assert.equal(details.alert.exceededBy, 20000);
    });

    it('throws if agentId is missing', async () => {
      await assert.rejects(() => getPausedAgentDetails(null, { dataDir }), /agentId is required/);
    });

    it('throws if dataDir is missing', async () => {
      await assert.rejects(() => getPausedAgentDetails('x', {}), /dataDir is required/);
    });
  });

  // -----------------------------------------------------------------------
  // validateResumeAction
  // -----------------------------------------------------------------------
  describe('validateResumeAction', () => {
    it('accepts valid actions', () => {
      for (const action of RESUME_ACTIONS) {
        assert.equal(validateResumeAction(action).valid, true);
      }
    });

    it('rejects invalid action', () => {
      const result = validateResumeAction('nope');
      assert.equal(result.valid, false);
      assert.ok(result.error.includes('Invalid action'));
    });

    it('rejects null action', () => {
      assert.equal(validateResumeAction(null).valid, false);
    });

    it('rejects negative newLimit for top-up', () => {
      const result = validateResumeAction('top-up', { newLimit: -500 });
      assert.equal(result.valid, false);
      assert.ok(result.error.includes('positive number'));
    });

    it('accepts top-up with valid newLimit', () => {
      assert.equal(validateResumeAction('top-up', { newLimit: 200000 }).valid, true);
    });

    it('accepts top-up without newLimit', () => {
      assert.equal(validateResumeAction('top-up').valid, true);
    });
  });

  // -----------------------------------------------------------------------
  // executeResume — simple resume
  // -----------------------------------------------------------------------
  describe('executeResume — resume action', () => {
    it('clears pause flag on a paused agent', async () => {
      const agent = await createTestAgent(dataDir, 'pausedagent', {
        budget: { paused: true, currentUsage: 120000, weeklyTokenLimit: 100000 },
      });

      const result = await executeResume(agent.id, 'resume', { dataDir });
      assert.equal(result.success, true);
      assert.equal(result.action, 'resume');
      assert.equal(result.wasPaused, true);
      assert.ok(result.message.includes('resumed'));

      // Verify persistence
      const store = new AgentStore(dataDir);
      const config = await store.load(agent.id);
      assert.equal(config.budget.paused, false);
    });

    it('handles already-active agent gracefully', async () => {
      const agent = await createTestAgent(dataDir, 'okagent', {
        budget: { paused: false },
      });

      const result = await executeResume(agent.id, 'resume', { dataDir });
      assert.equal(result.success, true);
      assert.equal(result.wasPaused, false);
      assert.ok(result.message.includes('not paused'));
    });

    it('is idempotent — resuming twice is safe', async () => {
      const agent = await createTestAgent(dataDir, 'idemagent', {
        budget: { paused: true },
      });

      await executeResume(agent.id, 'resume', { dataDir });
      const result2 = await executeResume(agent.id, 'resume', { dataDir });
      assert.equal(result2.success, true);

      const store = new AgentStore(dataDir);
      const config = await store.load(agent.id);
      assert.equal(config.budget.paused, false);
    });
  });

  // -----------------------------------------------------------------------
  // executeResume — top-up action
  // -----------------------------------------------------------------------
  describe('executeResume — top-up action', () => {
    it('resets usage and resumes agent', async () => {
      const agent = await createTestAgent(dataDir, 'topupagent', {
        budget: { paused: true, currentUsage: 150000, weeklyTokenLimit: 100000 },
      });

      const result = await executeResume(agent.id, 'top-up', { dataDir });
      assert.equal(result.success, true);
      assert.equal(result.action, 'top-up');
      assert.equal(result.wasPaused, true);
      assert.equal(result.resumed, true);
      assert.equal(result.previousUsage, 150000);
      assert.equal(result.limitChanged, false);

      // Verify persistence
      const store = new AgentStore(dataDir);
      const config = await store.load(agent.id);
      assert.equal(config.budget.paused, false);
      assert.equal(config.budget.currentUsage, 0);
    });

    it('allows setting a new budget limit', async () => {
      const agent = await createTestAgent(dataDir, 'newlimitagent', {
        budget: { paused: true, currentUsage: 120000, weeklyTokenLimit: 100000 },
      });

      const result = await executeResume(agent.id, 'top-up', {
        dataDir,
        newLimit: 200000,
      });
      assert.equal(result.success, true);
      assert.equal(result.newLimit, 200000);
      assert.equal(result.previousLimit, 100000);
      assert.equal(result.limitChanged, true);

      const store = new AgentStore(dataDir);
      const config = await store.load(agent.id);
      assert.equal(config.budget.weeklyTokenLimit, 200000);
      assert.equal(config.weeklyTokenBudget, 200000);
    });

    it('message describes the top-up clearly', async () => {
      const agent = await createTestAgent(dataDir, 'msgagent', {
        budget: { paused: true, currentUsage: 50000, weeklyTokenLimit: 100000 },
      });

      const result = await executeResume(agent.id, 'top-up', { dataDir });
      assert.ok(result.message.includes('topped up and resumed'));
      assert.ok(result.message.includes('reset to 0'));
      assert.ok(result.message.includes('100,000'));
    });
  });

  // -----------------------------------------------------------------------
  // executeResume — validation
  // -----------------------------------------------------------------------
  describe('executeResume — validation', () => {
    it('throws on missing agentId', async () => {
      await assert.rejects(() => executeResume(null, 'resume', { dataDir }), /agentId is required/);
    });

    it('throws on missing dataDir', async () => {
      await assert.rejects(() => executeResume('x', 'resume', {}), /dataDir is required/);
    });

    it('throws on invalid action', async () => {
      await assert.rejects(() => executeResume('x', 'cancel', { dataDir }), /Invalid action/);
    });
  });

  // -----------------------------------------------------------------------
  // Formatting functions
  // -----------------------------------------------------------------------
  describe('formatPausedAgentsList', () => {
    it('shows "no paused agents" message when list is empty', () => {
      const output = formatPausedAgentsList({ paused: [], active: ['a'], total: 1 });
      assert.ok(output.includes('No paused agents'));
      assert.ok(output.includes('Total agents: 1'));
    });

    it('lists paused agents with budget details', () => {
      const output = formatPausedAgentsList({
        paused: [
          { id: 'agent-1', name: 'Alice', role: 'dev', budget: { weeklyTokenLimit: 100000, currentUsage: 120000, paused: true } },
        ],
        active: ['agent-2'],
        total: 2,
      });
      assert.ok(output.includes('[PAUSED] Alice (dev)'));
      assert.ok(output.includes('agent-1'));
      assert.ok(output.includes('120,000'));
      assert.ok(output.includes('100,000'));
      assert.ok(output.includes('1 paused, 1 active'));
    });
  });

  describe('formatPausedAgentDetails', () => {
    it('shows not-paused message for active agent', () => {
      const output = formatPausedAgentDetails({ paused: false, message: 'Agent is not paused' });
      assert.equal(output, 'Agent is not paused');
    });

    it('shows detailed budget info for paused agent', () => {
      const output = formatPausedAgentDetails({
        agentId: 'agent-x',
        name: 'AgentX',
        role: 'coder',
        paused: true,
        budget: { weeklyTokenLimit: 100000, storeUsage: 110000, currentUsage: 110000, exceededBy: 10000 },
        alert: { timestamp: '2026-04-15T10:00:00.000Z', message: 'Budget exhausted', exceededBy: 10000 },
      });
      assert.ok(output.includes('AgentX'));
      assert.ok(output.includes('PAUSED'));
      assert.ok(output.includes('100,000'));
      assert.ok(output.includes('110,000'));
      assert.ok(output.includes('10,000'));
      assert.ok(output.includes('resume'));
      assert.ok(output.includes('top-up'));
      assert.ok(output.includes('cancel'));
    });

    it('omits alert section when no alert exists', () => {
      const output = formatPausedAgentDetails({
        agentId: 'a', name: 'A', role: 'r', paused: true,
        budget: { weeklyTokenLimit: 1000, storeUsage: 1500, currentUsage: 1500, exceededBy: 500 },
        alert: null,
      });
      assert.ok(!output.includes('Alert time:'));
    });
  });

  describe('formatResumeResult', () => {
    it('formats successful resume', () => {
      const output = formatResumeResult({
        success: true,
        action: 'resume',
        agentId: 'agent-x',
        message: 'Agent "agent-x" has been resumed.',
      });
      assert.ok(output.includes('Resume Result'));
      assert.ok(output.includes('resumed'));
      assert.ok(output.includes('next heartbeat'));
    });

    it('formats failure', () => {
      const output = formatResumeResult({
        success: false,
        action: 'resume',
        agentId: 'agent-x',
        error: 'not found',
      });
      assert.ok(output.includes('Failed'));
      assert.ok(output.includes('not found'));
    });
  });
});
