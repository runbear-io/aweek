import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoalStore, type Goal } from './goal-store.js';
import { createGoal } from '../models/agent.js';
import { validateGoal } from '../schemas/validator.js';

describe('GoalStore', () => {
  let store: GoalStore;
  let tmpDir: string;
  const agentId = 'agent-test-abc12345';

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-goal-test-'));
    store = new GoalStore(tmpDir);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should save and load a goal', async () => {
    const goal = createGoal('Ship MVP', '3mo') as Goal;
    await store.save(agentId, goal);
    const loaded = await store.load(agentId, goal.id);
    assert.deepStrictEqual(loaded, goal);
  });

  it('should validate goals on save', () => {
    const goal = createGoal('Valid goal') as Goal;
    const result = validateGoal(goal);
    assert.equal(result.valid, true);
  });

  it('should reject invalid goal on save', async () => {
    // The bad object intentionally violates the schema (missing required
    // `horizon` / `status` fields and an empty description). Cast through
    // `unknown` so the test can probe the runtime validator without the
    // type system silently rejecting the malformed shape ahead of AJV.
    const badGoal = { id: 'bad', description: '' } as unknown as Goal;
    await assert.rejects(
      () => store.save(agentId, badGoal),
      /Schema validation failed/,
    );
  });

  it('should check goal existence', async () => {
    const goal = createGoal('Existence check') as Goal;
    assert.equal(await store.exists(agentId, goal.id), false);
    await store.save(agentId, goal);
    assert.equal(await store.exists(agentId, goal.id), true);
  });

  it('should list goal IDs', async () => {
    const freshAgent = 'agent-list-test-00000001';
    const g1 = createGoal('Goal A') as Goal;
    const g2 = createGoal('Goal B') as Goal;
    await store.save(freshAgent, g1);
    await store.save(freshAgent, g2);

    const ids = await store.list(freshAgent);
    assert.ok(ids.includes(g1.id));
    assert.ok(ids.includes(g2.id));
    assert.equal(ids.length, 2);
  });

  it('should loadAll goals for an agent', async () => {
    const freshAgent = 'agent-loadall-00000002';
    const g1 = createGoal('Goal X', '1mo') as Goal;
    const g2 = createGoal('Goal Y', '1yr') as Goal;
    await store.save(freshAgent, g1);
    await store.save(freshAgent, g2);

    const all = await store.loadAll(freshAgent);
    assert.equal(all.length, 2);
  });

  it('should loadByHorizon', async () => {
    const freshAgent = 'agent-horizon-00000003';
    const short = createGoal('Short-term', '1mo') as Goal;
    const mid = createGoal('Mid-term', '3mo') as Goal;
    const long = createGoal('Long-term', '1yr') as Goal;
    await store.save(freshAgent, short);
    await store.save(freshAgent, mid);
    await store.save(freshAgent, long);

    const shortGoals = await store.loadByHorizon(freshAgent, '1mo');
    assert.equal(shortGoals.length, 1);
    assert.equal(shortGoals[0]?.description, 'Short-term');

    const longGoals = await store.loadByHorizon(freshAgent, '1yr');
    assert.equal(longGoals.length, 1);
    assert.equal(longGoals[0]?.description, 'Long-term');
  });

  it('should loadActive goals', async () => {
    const freshAgent = 'agent-active-00000004';
    const active = createGoal('Active goal') as Goal;
    const completed = createGoal('Done goal') as Goal;
    completed.status = 'completed';
    completed.completedAt = new Date().toISOString();

    await store.save(freshAgent, active);
    await store.save(freshAgent, completed);

    const actives = await store.loadActive(freshAgent);
    assert.equal(actives.length, 1);
    assert.equal(actives[0]?.description, 'Active goal');
  });

  it('should delete a goal', async () => {
    const goal = createGoal('Deletable') as Goal;
    await store.save(agentId, goal);
    assert.equal(await store.exists(agentId, goal.id), true);
    await store.delete(agentId, goal.id);
    assert.equal(await store.exists(agentId, goal.id), false);
  });

  it('should update a goal via updater function', async () => {
    const goal = createGoal('Updatable') as Goal;
    await store.save(agentId, goal);

    const updated = await store.update(agentId, goal.id, (g) => {
      g.description = 'Updated description';
      return g;
    });

    assert.equal(updated.description, 'Updated description');
    const loaded = await store.load(agentId, goal.id);
    assert.equal(loaded.description, 'Updated description');
  });

  it('should updateStatus to completed with completedAt', async () => {
    const goal = createGoal('Complete me') as Goal;
    await store.save(agentId, goal);

    const updated = await store.updateStatus(agentId, goal.id, 'completed');
    assert.equal(updated.status, 'completed');
    assert.ok(updated.completedAt);
  });

  it('should updateStatus to paused without completedAt', async () => {
    const goal = createGoal('Pause me') as Goal;
    await store.save(agentId, goal);

    const updated = await store.updateStatus(agentId, goal.id, 'paused');
    assert.equal(updated.status, 'paused');
    assert.equal(updated.completedAt, undefined);
  });

  it('should be idempotent — saving same goal twice produces same result', async () => {
    const goal = createGoal('Idempotent goal') as Goal;
    await store.save(agentId, goal);
    await store.save(agentId, goal);

    const loaded = await store.load(agentId, goal.id);
    assert.deepStrictEqual(loaded, goal);
  });

  it('should throw on load of nonexistent goal', async () => {
    await assert.rejects(
      () => store.load(agentId, 'goal-nonexistent-00000000'),
      { code: 'ENOENT' },
    );
  });

  it('should return empty list for agent with no goals', async () => {
    const freshAgent = 'agent-empty-00000005';
    const ids = await store.list(freshAgent);
    assert.deepStrictEqual(ids, []);
  });
});
