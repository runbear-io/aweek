/**
 * Tests for AgentStore — scheduling-only JSON persistence.
 *
 * These tests lock in the post-refactor shape:
 *   - `createAgentConfig({ subagentRef })` is the only constructor signature.
 *   - `id` equals `subagentRef` (1-to-1 with .claude/agents/SLUG.md).
 *   - No `identity` / `name` / `role` / `systemPrompt` fields ever land on disk
 *     — the aweek JSON is scheduling-only (goals, plans, budget, inbox).
 *   - `.load()` returns exactly what `.save()` wrote (idempotent round-trip).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentStore } from './agent-store.js';
import { WeeklyPlanStore } from './weekly-plan-store.js';
import {
  createAgentConfig,
  createGoal,
  createObjective,
  createMonthlyPlan,
  createTask,
  createWeeklyPlan,
} from '../models/agent.js';
import { validateAgentConfig } from '../schemas/validator.js';
import type { Agent } from '../schemas/agent.js';

/**
 * Loose loaded-config alias used in regression assertions for fields that
 * the canonical `Agent` shape intentionally drops (legacy `identity`,
 * `name`, `role`, `systemPrompt`, `weeklyPlans`). Indexing through this
 * record lets us probe for "did a banned field sneak back onto disk?"
 * without forcing the test surface to widen the canonical interface.
 */
type LoadedAgent = Agent & Record<string, unknown>;

describe('AgentStore', () => {
  let store: AgentStore;
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-test-'));
    store = new AgentStore(tmpDir);
    await store.init();
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should save and load an agent config', async () => {
    const config = createAgentConfig({ subagentRef: 'testbot' });

    await store.save(config);
    const loaded = await store.load(config.id);

    assert.deepStrictEqual(loaded, config);
  });

  it('persists only scheduling fields — no identity ever hits disk', async () => {
    const config = createAgentConfig({ subagentRef: 'schedbot' });
    await store.save(config);
    const loaded = (await store.load(config.id)) as LoadedAgent;

    // Scheduling-only contract: identity lives in .claude/agents/SLUG.md,
    // never in the aweek JSON. Guard against regressions that might sneak
    // a name/role/systemPrompt/identity field back into the persisted shape.
    assert.equal(loaded.identity, undefined);
    assert.equal(loaded.name, undefined);
    assert.equal(loaded.role, undefined);
    assert.equal(loaded.systemPrompt, undefined);

    // id equals subagentRef (1-to-1 with .claude/agents/<slug>.md)
    assert.equal(loaded.id, 'schedbot');
    assert.equal(loaded.subagentRef, 'schedbot');
    assert.equal(loaded.id, loaded.subagentRef);

    // Scheduling fields exist and are correctly shaped. Weekly plans
    // live in the per-week `WeeklyPlanStore` file store — the agent
    // JSON no longer carries a `weeklyPlans` field at all.
    assert.deepStrictEqual(loaded.goals, []);
    assert.deepStrictEqual(loaded.monthlyPlans, []);
    assert.equal(loaded.weeklyPlans, undefined);
    assert.deepStrictEqual(loaded.inbox, []);
    assert.ok(loaded.budget);
    assert.equal(typeof loaded.createdAt, 'string');
  });

  it('should validate agent config schema', () => {
    const config = createAgentConfig({ subagentRef: 'validator' });

    const result = validateAgentConfig(config);
    assert.equal(result.valid, true);
    assert.equal(result.errors, null);
  });

  it('should reject invalid agent config', () => {
    const result = validateAgentConfig({ id: 'bad', goals: [] });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects configs that carry a legacy identity blob', () => {
    // A config with the scheduling fields correctly filled but a stray
    // `identity` object MUST be rejected by the schema
    // (additionalProperties: false on agentConfigSchema).
    const base = createAgentConfig({ subagentRef: 'leakybot' });
    const withLegacyIdentity = {
      ...base,
      identity: { name: 'Leaky', role: 'role', systemPrompt: 'prompt' },
    };

    const result = validateAgentConfig(withLegacyIdentity);
    assert.equal(result.valid, false);
  });

  it('should list agent IDs', async () => {
    const config1 = createAgentConfig({ subagentRef: 'lister-one' });
    const config2 = createAgentConfig({ subagentRef: 'lister-two' });

    await store.save(config1);
    await store.save(config2);

    const ids = await store.list();
    assert.ok(ids.includes(config1.id));
    assert.ok(ids.includes(config2.id));
    // Ids are subagent slugs — not UUIDs or `agent-*` identifiers.
    assert.equal(config1.id, 'lister-one');
    assert.equal(config2.id, 'lister-two');
  });

  it('should check agent existence', async () => {
    const config = createAgentConfig({ subagentRef: 'exists-bot' });

    assert.equal(await store.exists(config.id), false);
    await store.save(config);
    assert.equal(await store.exists(config.id), true);
  });

  it('should delete an agent', async () => {
    const config = createAgentConfig({ subagentRef: 'deletable' });

    await store.save(config);
    assert.equal(await store.exists(config.id), true);

    await store.delete(config.id);
    assert.equal(await store.exists(config.id), false);
  });

  it('should update an agent config via updater function', async () => {
    const config = createAgentConfig({ subagentRef: 'updatable' });

    await store.save(config);

    // Small delay so updatedAt changes
    await new Promise((r) => setTimeout(r, 5));

    const updated = await store.update(config.id, (current) => {
      (current.goals ??= []).push(createGoal('Learn to test'));
      return current;
    });

    assert.equal(updated.goals?.length, 1);
    assert.equal((updated.goals?.[0] as { description?: string })?.description, 'Learn to test');
    assert.ok((updated.updatedAt ?? '') >= (config.updatedAt ?? ''));
  });

  it('should save agent with full monthly and weekly plans', async () => {
    const config = createAgentConfig({ subagentRef: 'planner' });

    const goal = createGoal('Ship v1');
    (config.goals ??= []).push(goal);

    const obj = createObjective('Build core module', goal.id);
    const monthlyPlan = createMonthlyPlan('2026-04', [obj]);
    (config.monthlyPlans ??= []).push(monthlyPlan);

    const task = createTask({ title: 'Write unit tests', prompt: 'Write unit tests' }, obj.id);
    const weeklyPlan = createWeeklyPlan('2026-W16', '2026-04', [task]);

    // Validate the config on its own (no embedded weeklyPlans field).
    const result = validateAgentConfig(config);
    assert.equal(result.valid, true, `Validation errors: ${JSON.stringify(result.errors)}`);

    // Save the config and the weekly plan via the file store.
    await store.save(config);
    const weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    await weeklyPlanStore.save(config.id, weeklyPlan);

    const loaded = (await store.load(config.id)) as LoadedAgent;
    assert.equal(loaded.goals?.length, 1);
    assert.equal(loaded.monthlyPlans?.length, 1);
    // `weeklyPlans` is no longer embedded on the agent JSON.
    assert.equal(loaded.weeklyPlans, undefined);
    assert.equal(loaded.inbox?.length, 0);

    // The weekly plan round-trips through the file store.
    const reloadedPlan = await weeklyPlanStore.load(config.id, weeklyPlan.week);
    assert.equal(reloadedPlan.approved, true);
    assert.equal(reloadedPlan.tasks.length, 1);
  });

  it('should be idempotent — saving same config twice produces same result', async () => {
    const config = createAgentConfig({ subagentRef: 'idempotent' });

    await store.save(config);
    await store.save(config);

    const loaded = await store.load(config.id);
    assert.deepStrictEqual(loaded, config);
  });

  it('should throw on load of nonexistent agent', async () => {
    await assert.rejects(
      () => store.load('nonexistent-agent'),
      { code: 'ENOENT' },
    );
  });

  it('should loadAll agents', async () => {
    // Create a fresh store in its own dir to have controlled count
    const freshDir = await mkdtemp(join(tmpdir(), 'aweek-loadall-'));
    const freshStore = new AgentStore(freshDir);
    await freshStore.init();

    const c1 = createAgentConfig({ subagentRef: 'loadall-a' });
    const c2 = createAgentConfig({ subagentRef: 'loadall-b' });
    await freshStore.save(c1);
    await freshStore.save(c2);

    const all = await freshStore.loadAll();
    assert.equal(all.length, 2);

    await rm(freshDir, { recursive: true, force: true });
  });

  it('migrates legacy embedded weeklyPlans onto the file store and drops the field', async () => {
    // Simulate a pre-Phase-3 agent JSON that still carries an embedded
    // `weeklyPlans: [...]` array. `AgentStore.load` must:
    //   1. Copy each plan into the per-week file store.
    //   2. Strip `weeklyPlans` from the returned config (the new schema
    //      does not permit the field; `assertValid` would reject it).
    const migrateDir = await mkdtemp(join(tmpdir(), 'aweek-migrate-'));
    const migrateStore = new AgentStore(migrateDir);
    await migrateStore.init();

    const goal = createGoal('Legacy goal');
    const obj = createObjective('Legacy obj', goal.id);
    const task = createTask({ title: 'Legacy task', prompt: 'Legacy task' }, obj.id);
    const legacyPlan = createWeeklyPlan('2026-W16', '2026-04', [task]);

    const base = createAgentConfig({ subagentRef: 'legacy-bot' });
    (base.goals ??= []).push(goal);
    (base.monthlyPlans ??= []).push(createMonthlyPlan('2026-04', [obj]));

    // Write the JSON file directly so we can embed the legacy
    // `weeklyPlans` field that the new schema no longer permits.
    const legacyOnDisk = { ...base, weeklyPlans: [legacyPlan] };
    await mkdir(migrateDir, { recursive: true });
    await writeFile(
      join(migrateDir, `${base.id}.json`),
      JSON.stringify(legacyOnDisk, null, 2) + '\n',
      'utf-8',
    );

    const loaded = (await migrateStore.load(base.id)) as LoadedAgent;
    assert.equal(loaded.weeklyPlans, undefined, 'weeklyPlans must be stripped from the loaded config');
    assert.equal(loaded.id, base.id);

    // The plan now lives in the file store.
    const weeklyPlanStore = new WeeklyPlanStore(migrateDir);
    const migratedPlan = await weeklyPlanStore.load(base.id, '2026-W16');
    assert.equal(migratedPlan.week, legacyPlan.week);
    assert.equal(migratedPlan.tasks.length, 1);

    await rm(migrateDir, { recursive: true, force: true });
  });
});
