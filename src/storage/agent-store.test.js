import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentStore } from './agent-store.js';
import {
  createAgentConfig,
  createGoal,
  createObjective,
  createMonthlyPlan,
  createTask,
  createWeeklyPlan,
  createInboxMessage,
} from '../models/agent.js';
import { validateAgentConfig } from '../schemas/validator.js';

describe('AgentStore', () => {
  let store;
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-test-'));
    store = new AgentStore(tmpDir);
    await store.init();
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should save and load an agent config', async () => {
    const config = createAgentConfig({
      name: 'TestBot',
      role: 'Test agent for unit tests',
      systemPrompt: 'You are a test agent.',
    });

    await store.save(config);
    const loaded = await store.load(config.id);

    assert.deepStrictEqual(loaded, config);
  });

  it('should validate agent config schema', () => {
    const config = createAgentConfig({
      name: 'Validator',
      role: 'Schema test',
      systemPrompt: 'You validate things.',
    });

    const result = validateAgentConfig(config);
    assert.equal(result.valid, true);
    assert.equal(result.errors, null);
  });

  it('should reject invalid agent config', () => {
    const result = validateAgentConfig({ id: 'bad', goals: [] });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('should list agent IDs', async () => {
    const config1 = createAgentConfig({
      name: 'Agent1',
      role: 'Lister test 1',
      systemPrompt: 'Prompt 1',
    });
    const config2 = createAgentConfig({
      name: 'Agent2',
      role: 'Lister test 2',
      systemPrompt: 'Prompt 2',
    });

    await store.save(config1);
    await store.save(config2);

    const ids = await store.list();
    assert.ok(ids.includes(config1.id));
    assert.ok(ids.includes(config2.id));
  });

  it('should check agent existence', async () => {
    const config = createAgentConfig({
      name: 'Exists',
      role: 'Existence test',
      systemPrompt: 'Do I exist?',
    });

    assert.equal(await store.exists(config.id), false);
    await store.save(config);
    assert.equal(await store.exists(config.id), true);
  });

  it('should delete an agent', async () => {
    const config = createAgentConfig({
      name: 'Deletable',
      role: 'Delete test',
      systemPrompt: 'Delete me.',
    });

    await store.save(config);
    assert.equal(await store.exists(config.id), true);

    await store.delete(config.id);
    assert.equal(await store.exists(config.id), false);
  });

  it('should update an agent config via updater function', async () => {
    const config = createAgentConfig({
      name: 'Updatable',
      role: 'Update test',
      systemPrompt: 'Update me.',
    });

    await store.save(config);

    // Small delay so updatedAt changes
    await new Promise((r) => setTimeout(r, 5));

    const updated = await store.update(config.id, (current) => {
      current.goals.push(createGoal('Learn to test'));
      return current;
    });

    assert.equal(updated.goals.length, 1);
    assert.equal(updated.goals[0].description, 'Learn to test');
    assert.ok(updated.updatedAt >= config.updatedAt);
  });

  it('should save agent with full monthly and weekly plans', async () => {
    const config = createAgentConfig({
      name: 'Planner',
      role: 'Planning test agent',
      systemPrompt: 'You plan things.',
    });

    const goal = createGoal('Ship v1');
    config.goals.push(goal);

    const obj = createObjective('Build core module', goal.id);
    const monthlyPlan = createMonthlyPlan('2026-04', [obj]);
    config.monthlyPlans.push(monthlyPlan);

    const task = createTask('Write unit tests', obj.id);
    const weeklyPlan = createWeeklyPlan('2026-W16', '2026-04', [task]);
    config.weeklyPlans.push(weeklyPlan);

    const msg = createInboxMessage('agent-other-abc12345', config.id, 'Please review my PR');
    config.inbox.push(msg);

    // Validate
    const result = validateAgentConfig(config);
    assert.equal(result.valid, true, `Validation errors: ${JSON.stringify(result.errors)}`);

    // Save & reload
    await store.save(config);
    const loaded = await store.load(config.id);
    assert.equal(loaded.goals.length, 1);
    assert.equal(loaded.monthlyPlans.length, 1);
    assert.equal(loaded.weeklyPlans.length, 1);
    assert.equal(loaded.inbox.length, 1);
    assert.equal(loaded.weeklyPlans[0].approved, false);
  });

  it('should be idempotent — saving same config twice produces same result', async () => {
    const config = createAgentConfig({
      name: 'Idempotent',
      role: 'Idempotency test',
      systemPrompt: 'Same same.',
    });

    await store.save(config);
    await store.save(config);

    const loaded = await store.load(config.id);
    assert.deepStrictEqual(loaded, config);
  });

  it('should throw on load of nonexistent agent', async () => {
    await assert.rejects(
      () => store.load('agent-nonexistent-00000000'),
      { code: 'ENOENT' }
    );
  });

  it('should loadAll agents', async () => {
    // Create a fresh store in its own dir to have controlled count
    const freshDir = await mkdtemp(join(tmpdir(), 'aweek-loadall-'));
    const freshStore = new AgentStore(freshDir);
    await freshStore.init();

    const c1 = createAgentConfig({ name: 'A', role: 'r', systemPrompt: 'p' });
    const c2 = createAgentConfig({ name: 'B', role: 'r', systemPrompt: 'p' });
    await freshStore.save(c1);
    await freshStore.save(c2);

    const all = await freshStore.loadAll();
    assert.equal(all.length, 2);

    await rm(freshDir, { recursive: true, force: true });
  });
});
