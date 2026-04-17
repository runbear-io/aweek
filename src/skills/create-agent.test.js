import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateIdentityInput,
  validateGoalsInput,
  validateObjectivesInput,
  validateTasksInput,
  validateTokenLimit,
  assembleAndSaveAgent,
  formatAgentSummary,
  getCurrentMonth,
  getCurrentWeek,
} from './create-agent.js';
import { AgentStore } from '../storage/agent-store.js';

describe('create-agent skill', () => {
  describe('validateIdentityInput', () => {
    it('should accept valid identity', () => {
      const result = validateIdentityInput({
        name: 'TestBot',
        role: 'A test agent',
        systemPrompt: 'You are a test bot.',
      });
      assert.equal(result.valid, true);
      assert.deepStrictEqual(result.errors, []);
    });

    it('should reject empty name', () => {
      const result = validateIdentityInput({
        name: '',
        role: 'A test agent',
        systemPrompt: 'You are a test bot.',
      });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('Name')));
    });

    it('should reject name over 100 chars', () => {
      const result = validateIdentityInput({
        name: 'x'.repeat(101),
        role: 'A test agent',
        systemPrompt: 'You are a test bot.',
      });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('100')));
    });

    it('should reject empty role', () => {
      const result = validateIdentityInput({
        name: 'Bot',
        role: '',
        systemPrompt: 'Prompt',
      });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('Role')));
    });

    it('should reject role over 200 chars', () => {
      const result = validateIdentityInput({
        name: 'Bot',
        role: 'x'.repeat(201),
        systemPrompt: 'Prompt',
      });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('200')));
    });

    it('should reject empty system prompt', () => {
      const result = validateIdentityInput({
        name: 'Bot',
        role: 'Role',
        systemPrompt: '',
      });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('System prompt')));
    });
  });

  describe('validateGoalsInput', () => {
    it('should accept valid goals', () => {
      const result = validateGoalsInput(['A goal that is long enough']);
      assert.equal(result.valid, true);
    });

    it('should reject empty array', () => {
      const result = validateGoalsInput([]);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('At least 1')));
    });

    it('should reject more than 5 goals', () => {
      const goals = Array.from({ length: 6 }, (_, i) => `Goal number ${i + 1} with detail`);
      const result = validateGoalsInput(goals);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('Maximum 5')));
    });

    it('should reject goal shorter than 10 chars', () => {
      const result = validateGoalsInput(['Too short']);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('10 characters')));
    });
  });

  describe('validateObjectivesInput', () => {
    it('should accept valid objectives', () => {
      const result = validateObjectivesInput(
        [{ description: 'Build core module', goalIndex: 0 }],
        1
      );
      assert.equal(result.valid, true);
    });

    it('should reject empty array', () => {
      const result = validateObjectivesInput([], 1);
      assert.equal(result.valid, false);
    });

    it('should reject invalid goal index', () => {
      const result = validateObjectivesInput(
        [{ description: 'Objective', goalIndex: 5 }],
        2
      );
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('valid goal')));
    });

    it('should reject more than 5 objectives', () => {
      const objs = Array.from({ length: 6 }, (_, i) => ({
        description: `Objective ${i}`,
        goalIndex: 0,
      }));
      const result = validateObjectivesInput(objs, 1);
      assert.equal(result.valid, false);
    });
  });

  describe('validateTasksInput', () => {
    it('should accept valid tasks', () => {
      const result = validateTasksInput(
        [{ description: 'Write tests', objectiveIndex: 0 }],
        1
      );
      assert.equal(result.valid, true);
    });

    it('should reject empty array', () => {
      const result = validateTasksInput([], 1);
      assert.equal(result.valid, false);
    });

    it('should reject invalid objective index', () => {
      const result = validateTasksInput(
        [{ description: 'Task', objectiveIndex: 3 }],
        2
      );
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('valid objective')));
    });

    it('should reject more than 100 tasks', () => {
      const tasks = Array.from({ length: 101 }, (_, i) => ({
        description: `Task ${i}`,
        objectiveIndex: 0,
      }));
      const result = validateTasksInput(tasks, 1);
      assert.equal(result.valid, false);
    });
  });

  describe('validateTokenLimit', () => {
    it('should accept valid positive integer', () => {
      assert.equal(validateTokenLimit(500000).valid, true);
    });

    it('should reject zero', () => {
      assert.equal(validateTokenLimit(0).valid, false);
    });

    it('should reject negative', () => {
      assert.equal(validateTokenLimit(-100).valid, false);
    });

    it('should reject non-integer', () => {
      assert.equal(validateTokenLimit(500.5).valid, false);
    });

    it('should reject string', () => {
      assert.equal(validateTokenLimit('500000').valid, false);
    });
  });

  describe('getCurrentMonth', () => {
    it('should return YYYY-MM format', () => {
      const month = getCurrentMonth();
      assert.match(month, /^\d{4}-\d{2}$/);
    });
  });

  describe('getCurrentWeek', () => {
    it('should return YYYY-Www format', () => {
      const week = getCurrentWeek();
      assert.match(week, /^\d{4}-W\d{2}$/);
    });
  });

  describe('assembleAndSaveAgent', () => {
    let tmpDir;

    before(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'aweek-create-test-'));
    });

    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should create and save a valid agent', async () => {
      const result = await assembleAndSaveAgent({
        name: 'ResearchBot',
        role: 'Researches topics and writes summaries',
        systemPrompt: 'You are a research assistant.',
        weeklyTokenLimit: 300000,
        goalDescriptions: ['Research and summarize AI developments weekly'],
        objectives: [{ description: 'Survey recent papers', goalIndex: 0 }],
        tasks: [{ description: 'Read arxiv feed', objectiveIndex: 0 }],
        dataDir: tmpDir,
      });

      assert.equal(result.success, true);
      assert.ok(result.config);
      assert.ok(result.config.id.startsWith('agent-'));
      assert.equal(result.config.identity.name, 'ResearchBot');
      assert.equal(result.config.goals.length, 1);
      assert.equal(result.config.monthlyPlans.length, 1);
      assert.equal(result.config.weeklyPlans.length, 1);
      assert.equal(result.config.weeklyPlans[0].approved, false);
      assert.equal(result.config.budget.weeklyTokenLimit, 300000);

      // Verify persisted to disk
      const store = new AgentStore(tmpDir);
      const loaded = await store.load(result.config.id);
      assert.deepStrictEqual(loaded, result.config);
    });

    it('should return errors for invalid input', async () => {
      const result = await assembleAndSaveAgent({
        name: '',
        role: '',
        systemPrompt: '',
        goalDescriptions: [],
        objectives: [],
        tasks: [],
        dataDir: tmpDir,
      });

      assert.equal(result.success, false);
      assert.ok(result.errors.length > 0);
    });

    it('should trace objectives to goals and tasks to objectives', async () => {
      const result = await assembleAndSaveAgent({
        name: 'TracerBot',
        role: 'Tests traceability between plans',
        systemPrompt: 'You trace things.',
        goalDescriptions: [
          'First goal with enough characters',
          'Second goal with enough characters',
        ],
        objectives: [
          { description: 'Obj for goal 1', goalIndex: 0 },
          { description: 'Obj for goal 2', goalIndex: 1 },
        ],
        tasks: [
          { description: 'Task for obj 1', objectiveIndex: 0 },
          { description: 'Task for obj 2', objectiveIndex: 1 },
        ],
        dataDir: tmpDir,
      });

      assert.equal(result.success, true);
      const config = result.config;

      // Verify traceability: objective -> goal
      const obj0 = config.monthlyPlans[0].objectives[0];
      assert.equal(obj0.goalId, config.goals[0].id);

      const obj1 = config.monthlyPlans[0].objectives[1];
      assert.equal(obj1.goalId, config.goals[1].id);

      // Verify traceability: task -> objective
      const task0 = config.weeklyPlans[0].tasks[0];
      assert.equal(task0.objectiveId, obj0.id);

      const task1 = config.weeklyPlans[0].tasks[1];
      assert.equal(task1.objectiveId, obj1.id);
    });

    it('should use default token limit of 500000', async () => {
      const result = await assembleAndSaveAgent({
        name: 'DefaultBudget',
        role: 'Tests default token budget value',
        systemPrompt: 'You have a default budget.',
        goalDescriptions: ['Test the default budget setting works'],
        objectives: [{ description: 'Check defaults', goalIndex: 0 }],
        tasks: [{ description: 'Verify default', objectiveIndex: 0 }],
        dataDir: tmpDir,
      });

      assert.equal(result.success, true);
      assert.equal(result.config.budget.weeklyTokenLimit, 500000);
    });
  });

  describe('formatAgentSummary', () => {
    it('should produce a readable summary string', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'aweek-fmt-'));
      const result = await assembleAndSaveAgent({
        name: 'SummaryBot',
        role: 'Tests summary formatting output',
        systemPrompt: 'Summarize.',
        goalDescriptions: ['Generate readable agent summaries'],
        objectives: [{ description: 'Format output', goalIndex: 0 }],
        tasks: [{ description: 'Check formatting', objectiveIndex: 0 }],
        dataDir: tmpDir,
      });

      const summary = formatAgentSummary(result.config);
      assert.ok(summary.includes('Agent created successfully!'));
      assert.ok(summary.includes('SummaryBot'));
      assert.ok(summary.includes(result.config.id));
      assert.ok(summary.includes('1 goal'));
      assert.ok(summary.includes('1 objective'));
      assert.ok(summary.includes('1 task'));
      assert.ok(summary.includes('pending approval'));
      assert.ok(summary.includes('/aweek:approve-plan'));

      await rm(tmpDir, { recursive: true, force: true });
    });
  });
});
