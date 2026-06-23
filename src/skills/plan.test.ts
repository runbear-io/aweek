/**
 * Tests for the `plan` skill adapter (post-approval-removal).
 *
 * The approval / reject / edit / reviewPlan / autoApprovePlan surfaces and
 * the `plan-ready` notifier were retired alongside the human-in-the-loop
 * approval gate. This suite exercises the remaining adapter surface
 * (`adjustPlan` + `detectLayoutAmbiguity`) plus the re-exports the
 * dispatcher relies on.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  adjustPlan,
  formatAdjustmentResult,
  detectLayoutAmbiguity,
  generateSkipAssumptions,
  formatAssumptionsBlock,
  checkInterviewTriggers,
} from './plan.js';
import { AgentStore } from '../storage/agent-store.js';
import { writePlan } from '../storage/plan-markdown-store.js';
import { createAgentConfig } from '../models/agent.js';

let tmpRoot: string;
let agentsDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'aweek-plan-test-'));
  agentsDir = join(tmpRoot, '.aweek', 'agents');
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('plan skill adapter', () => {
  it('adjustPlan rejects legacy goalAdjustments / monthlyAdjustments with a redirect message', async () => {
    const result = await adjustPlan({
      agentId: 'marketer',
      goalAdjustments: [{ action: 'add', description: 'foo', horizon: '3mo' }],
      dataDir: agentsDir,
    });
    assert.equal(result.success, false);
    assert.ok(
      (result.errors ?? []).some((e) => e.includes('plan.md')),
      'expected redirect to plan.md',
    );
  });

  it('adjustPlan returns a usage error when no adjustments are supplied', async () => {
    const result = await adjustPlan({ agentId: 'marketer', dataDir: agentsDir });
    assert.equal(result.success, false);
    assert.ok(
      (result.errors ?? []).some((e) => /At least one adjustment/i.test(e)),
    );
  });

  it('detectLayoutAmbiguity returns a result shape even when no plan.md exists', async () => {
    const result = await detectLayoutAmbiguity({
      agentsDir,
      agentId: 'never-hired',
    });
    assert.equal(typeof result.mode, 'string');
    assert.equal(typeof result.modeLabel, 'string');
    assert.equal(typeof result.confident, 'boolean');
  });

  it('detectLayoutAmbiguity reads plan.md when present', async () => {
    const store = new AgentStore(agentsDir);
    await store.save(createAgentConfig({ subagentRef: 'marketer' }));
    await writePlan(agentsDir, 'marketer', '## Notes\n\nfree-form content');
    const result = await detectLayoutAmbiguity({
      agentsDir,
      agentId: 'marketer',
    });
    assert.equal(typeof result.mode, 'string');
    assert.equal(typeof result.modeLabel, 'string');
  });

  it('formatAdjustmentResult delegates to formatAdjustmentSummary', () => {
    const text = formatAdjustmentResult({
      goals: [],
      monthly: [],
      weekly: [],
    });
    assert.match(text, /Goal adjustments applied successfully/);
  });

  it('generateSkipAssumptions and formatAssumptionsBlock surface fired triggers', () => {
    const triggers = [
      {
        trigger: 'first-ever-plan',
        reason: 'first plan',
        details: {},
      },
    ];
    const assumptions = generateSkipAssumptions(triggers);
    assert.equal(assumptions.length, 1);
    assert.equal(assumptions[0]!.trigger, 'first-ever-plan');
    const block = formatAssumptionsBlock(assumptions);
    assert.match(block, /First-Ever Plan/);
  });

  it('checkInterviewTriggers is exposed', async () => {
    const result = await checkInterviewTriggers({
      agentId: 'never-hired',
      dataDir: agentsDir,
    });
    assert.ok(Array.isArray(result));
  });
});
