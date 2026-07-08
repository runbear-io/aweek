/**
 * Tests for the Sunday plan safety-net (`ensureWeeklyPlansForSunday`).
 *
 * Contract: on a Sunday (in the configured zone) the heartbeat guarantees a
 * weekly plan exists for the upcoming week and backfills the current week if
 * it was never planned. The normal creation path — chainNextWeekPlanner,
 * which fires only after a successful weekly review — can silently never run
 * (agent paused, budget exhausted, plan deleted, hired mid-week). This net
 * closes that gap so the week ahead always starts with tasks.
 *
 * Verified here:
 *   1. Sunday + no plans → both current and next week plans are created.
 *   2. Non-Sunday → nothing is created (weekday gate).
 *   3. Sunday + an existing next-week plan → it is NOT overwritten (idempotent).
 *   4. Best-effort: a broken store never throws out of the net.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { ensureWeeklyPlansForSunday } from './run.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { AgentStore } from '../storage/agent-store.js';

const uid = () => randomBytes(4).toString('hex');

// 2026-07-12T12:00Z is a Sunday (ISO weekday 7): week 2026-W28, next 2026-W29.
const SUNDAY = new Date('2026-07-12T12:00:00Z');
// 2026-07-15T12:00Z is a Wednesday (ISO weekday 3): week 2026-W29.
const WEDNESDAY = new Date('2026-07-15T12:00:00Z');
const CURRENT_WEEK = '2026-W28';
const NEXT_WEEK = '2026-W29';
const TZ = 'UTC';

function makeAgentConfig(agentId) {
  return {
    id: agentId,
    subagentRef: agentId,
    goals: [],
    budget: {
      weeklyTokenLimit: 500000,
      currentUsage: 0,
      periodStart: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
  };
}

describe('ensureWeeklyPlansForSunday', () => {
  let projectDir;
  let agentsDir;
  let agentId;
  let weeklyPlanStore;
  let agentStore;
  let deps;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'aweek-sunday-'));
    agentsDir = join(projectDir, '.aweek', 'agents');
    await mkdir(agentsDir, { recursive: true });

    agentId = `agent-${uid()}`;
    weeklyPlanStore = new WeeklyPlanStore(agentsDir);
    agentStore = new AgentStore(agentsDir);
    await agentStore.save(makeAgentConfig(agentId));

    deps = { agentId, agentsDir, weeklyPlanStore, agentStore };
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('creates both the current and next week plans on a Sunday when none exist', async () => {
    assert.equal(await weeklyPlanStore.exists(agentId, CURRENT_WEEK), false);
    assert.equal(await weeklyPlanStore.exists(agentId, NEXT_WEEK), false);

    await ensureWeeklyPlansForSunday(deps, TZ, SUNDAY);

    assert.equal(
      await weeklyPlanStore.exists(agentId, CURRENT_WEEK),
      true,
      'current-week plan should be backfilled',
    );
    assert.equal(
      await weeklyPlanStore.exists(agentId, NEXT_WEEK),
      true,
      'next-week plan should be created',
    );

    // Generated plans always carry the six review slots even with no goals.
    const next = await weeklyPlanStore.load(agentId, NEXT_WEEK);
    assert.ok(next.tasks.length >= 6, 'generated plan should include review tasks');
    assert.equal(next.week, NEXT_WEEK);
  });

  it('does nothing on a non-Sunday', async () => {
    await ensureWeeklyPlansForSunday(deps, TZ, WEDNESDAY);

    assert.equal(
      await weeklyPlanStore.exists(agentId, '2026-W29'),
      false,
      'no plan should be created midweek',
    );
    assert.equal(await weeklyPlanStore.exists(agentId, '2026-W30'), false);
  });

  it('does not overwrite an existing next-week plan (idempotent)', async () => {
    // Seed a hand-authored next-week plan with a sentinel task.
    const sentinel = {
      id: 'task-sentinel',
      title: 'hand-authored task',
      prompt: 'do the thing',
      status: 'pending',
    };
    await weeklyPlanStore.save(agentId, {
      week: NEXT_WEEK,
      month: '2026-07',
      tasks: [sentinel],
      createdAt: new Date().toISOString(),
    });

    await ensureWeeklyPlansForSunday(deps, TZ, SUNDAY);

    const next = await weeklyPlanStore.load(agentId, NEXT_WEEK);
    assert.equal(next.tasks.length, 1, 'existing plan must be left untouched');
    assert.equal(next.tasks[0].id, 'task-sentinel');

    // The missing current-week plan is still backfilled in the same run.
    assert.equal(await weeklyPlanStore.exists(agentId, CURRENT_WEEK), true);
  });

  it('never throws — a broken store degrades to a warning', async () => {
    const brokenStore = {
      load: async () => {
        throw new Error('simulated ENOENT');
      },
      save: async () => {
        throw new Error('simulated disk full');
      },
    };
    const brokenDeps = { agentId, agentsDir, weeklyPlanStore: brokenStore, agentStore };

    await assert.doesNotReject(
      () => ensureWeeklyPlansForSunday(brokenDeps, TZ, SUNDAY),
      'safety-net must swallow store errors',
    );
  });
});
