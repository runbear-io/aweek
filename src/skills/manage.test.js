/**
 * Tests for the `manage` skill adapter.
 *
 * The adapter is a thin composition layer over `./resume-agent.js` (which
 * already has comprehensive tests). Here we only verify:
 *
 *   1. Re-exports are verbatim (same function references) so there is a
 *      single source of truth.
 *   2. `resume` / `topUp` wrappers dispatch to the correct underlying
 *      action and preserve semantics.
 *   3. Destructive operations (`topUp`) are confirmation-gated per project
 *      constraints and fail cleanly without `confirmed: true`.
 *   4. `executeAction('top-up', ...)` honors the same confirmation guard.
 *   5. Validation / formatting aliases pass through correctly.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  RESUME_ACTIONS,
  listPausedAgents,
  getPausedAgentDetails,
  resume,
  topUp,
  executeAction,
  validateAction,
  validateResumeAction,
  executeResume,
  formatPausedAgentsList,
  formatPausedAgentDetails,
  formatActionResult,
  formatResumeResult,
  pause,
  editIdentity,
  deleteAgent,
  formatPauseResult,
  formatIdentityResult,
  formatDeleteResult,
} from './manage.js';
import * as resumeAgent from './resume-agent.js';
import { AgentStore } from '../storage/agent-store.js';
import { createAgentConfig } from '../models/agent.js';

describe('manage skill (adapter over resume-agent)', () => {
  describe('re-exports', () => {
    it('re-exports canonical pipeline functions verbatim', () => {
      // Same function references — the adapter is a true shim.
      assert.equal(validateResumeAction, resumeAgent.validateResumeAction);
      assert.equal(executeResume, resumeAgent.executeResume);
      assert.equal(formatResumeResult, resumeAgent.formatResumeResult);
      assert.deepEqual(RESUME_ACTIONS, resumeAgent.RESUME_ACTIONS);
    });
  });

  describe('validateAction', () => {
    it('accepts valid actions', () => {
      assert.deepEqual(validateAction('resume'), { valid: true });
      assert.deepEqual(validateAction('top-up'), { valid: true });
      assert.deepEqual(validateAction('cancel'), { valid: true });
    });

    it('rejects invalid actions', () => {
      const result = validateAction('bogus');
      assert.equal(result.valid, false);
      assert.match(result.error, /Invalid action/);
    });

    it('rejects non-positive top-up newLimit', () => {
      const result = validateAction('top-up', { newLimit: -1 });
      assert.equal(result.valid, false);
      assert.match(result.error, /positive number/);
    });
  });

  describe('topUp destructive confirmation gate', () => {
    it('refuses to run when confirmed is missing', async () => {
      const result = await topUp({ agentId: 'agent-x', dataDir: '/tmp/unused' });
      assert.equal(result.success, false);
      assert.ok(result.errors.some((e) => /explicit confirmation/i.test(e)));
    });

    it('refuses to run when confirmed is false', async () => {
      const result = await topUp({ agentId: 'agent-x', dataDir: '/tmp/unused', confirmed: false });
      assert.equal(result.success, false);
      assert.ok(result.errors.some((e) => /explicit confirmation/i.test(e)));
    });
  });

  describe('executeAction destructive confirmation gate', () => {
    it('refuses top-up without confirmation', async () => {
      const result = await executeAction('agent-x', 'top-up', { dataDir: '/tmp/unused' });
      assert.equal(result.success, false);
      assert.ok(result.errors.some((e) => /explicit confirmation/i.test(e)));
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end resume / top-up with a real on-disk agent store
  // -------------------------------------------------------------------------
  describe('action dispatching (with filesystem)', () => {
    let tmpDir;
    let pausedAgent;

    before(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'aweek-manage-test-'));
    });

    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      // Reset on-disk state and seed a single paused agent
      await rm(tmpDir, { recursive: true, force: true });

      const store = new AgentStore(tmpDir);
      const config = createAgentConfig({
        name: 'Alice',
        role: 'developer',
        systemPrompt: 'You are Alice, a developer agent.',
        weeklyTokenLimit: 100_000,
      });
      // Mutate only the fields we care about — leave schema-required fields
      // (like `periodStart`) intact.
      config.budget.paused = true;
      config.budget.currentUsage = 150_000;
      await store.save(config);
      pausedAgent = config;
    });

    it('resume clears the paused flag (non-destructive, no confirmation)', async () => {
      const result = await resume({ agentId: pausedAgent.id, dataDir: tmpDir });

      assert.equal(result.success, true);
      assert.equal(result.action, 'resume');
      assert.equal(result.wasPaused, true);

      const store = new AgentStore(tmpDir);
      const reloaded = await store.load(pausedAgent.id);
      assert.equal(reloaded.budget.paused, false);
    });

    it('topUp with confirmed:true resets usage and clears the pause flag', async () => {
      const result = await topUp({
        agentId: pausedAgent.id,
        dataDir: tmpDir,
        confirmed: true,
      });

      assert.equal(result.success, true);
      assert.equal(result.action, 'top-up');

      const store = new AgentStore(tmpDir);
      const reloaded = await store.load(pausedAgent.id);
      assert.equal(reloaded.budget.paused, false);
      assert.equal(reloaded.budget.currentUsage, 0);
    });

    it('topUp with a new limit updates the weekly token budget', async () => {
      const result = await topUp({
        agentId: pausedAgent.id,
        dataDir: tmpDir,
        confirmed: true,
        newLimit: 500_000,
      });

      assert.equal(result.success, true);
      assert.equal(result.newLimit, 500_000);
      assert.equal(result.limitChanged, true);

      const store = new AgentStore(tmpDir);
      const reloaded = await store.load(pausedAgent.id);
      assert.equal(reloaded.budget.currentUsage, 0);
      assert.equal(reloaded.budget.paused, false);
    });

    it('executeAction("resume") dispatches to the resume path', async () => {
      const result = await executeAction(pausedAgent.id, 'resume', { dataDir: tmpDir });
      assert.equal(result.success, true);
      assert.equal(result.action, 'resume');
    });

    it('executeAction("top-up") with confirmed:true runs the top-up path', async () => {
      const result = await executeAction(pausedAgent.id, 'top-up', {
        dataDir: tmpDir,
        confirmed: true,
      });
      assert.equal(result.success, true);
      assert.equal(result.action, 'top-up');
    });

    it('listPausedAgents surfaces the seeded agent', async () => {
      const list = await listPausedAgents({ dataDir: tmpDir });
      assert.equal(list.total, 1);
      assert.equal(list.paused.length, 1);
      assert.equal(list.paused[0].id, pausedAgent.id);
      assert.equal(list.active.length, 0);
    });

    it('getPausedAgentDetails returns detailed budget info', async () => {
      const details = await getPausedAgentDetails(pausedAgent.id, { dataDir: tmpDir });
      assert.equal(details.paused, true);
      assert.equal(details.agentId, pausedAgent.id);
      assert.equal(details.budget.weeklyTokenLimit, 100_000);
      assert.ok(details.budget.exceededBy > 0);
    });
  });

  describe('formatters', () => {
    it('formatPausedAgentsList renders an empty state', () => {
      const text = formatPausedAgentsList({ paused: [], active: [], total: 0 });
      assert.match(text, /No paused agents found/);
    });

    it('formatActionResult renders a success message', () => {
      const text = formatActionResult({
        agentId: 'a',
        action: 'resume',
        success: true,
        wasPaused: true,
        message: 'ok',
      });
      assert.match(text, /Resume Result/);
      assert.match(text, /heartbeat tick/);
    });

    it('formatPausedAgentDetails renders a non-paused message', () => {
      const text = formatPausedAgentDetails({
        agentId: 'a',
        paused: false,
        message: 'Agent "a" is not paused — no action needed.',
      });
      assert.match(text, /not paused/);
    });
  });

  // -------------------------------------------------------------------------
  // AC 8 — pause, editIdentity, deleteAgent lifecycle ops
  // -------------------------------------------------------------------------
  describe('pause', () => {
    let tmpDir;
    let agent;

    before(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'aweek-manage-pause-'));
    });

    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
      const store = new AgentStore(tmpDir);
      const config = createAgentConfig({
        name: 'Bob',
        role: 'researcher',
        systemPrompt: 'You are Bob, a researcher.',
        weeklyTokenLimit: 100_000,
      });
      // Active (not paused)
      config.budget.paused = false;
      await store.save(config);
      agent = config;
    });

    it('requires agentId', async () => {
      const result = await pause({ dataDir: tmpDir });
      assert.equal(result.success, false);
      assert.ok(result.errors.some((e) => /agentId/i.test(e)));
    });

    it('pauses an active agent (wasPaused:false)', async () => {
      const result = await pause({ agentId: agent.id, dataDir: tmpDir });
      assert.equal(result.success, true);
      assert.equal(result.action, 'pause');
      assert.equal(result.wasPaused, false);

      const store = new AgentStore(tmpDir);
      const reloaded = await store.load(agent.id);
      assert.equal(reloaded.budget.paused, true);
    });

    it('is idempotent — pausing an already-paused agent is a no-op', async () => {
      await pause({ agentId: agent.id, dataDir: tmpDir });
      const second = await pause({ agentId: agent.id, dataDir: tmpDir });
      assert.equal(second.success, true);
      assert.equal(second.wasPaused, true);
      assert.match(second.message, /already paused/i);
    });

    it('returns a structured error for a missing agent', async () => {
      const result = await pause({ agentId: 'agent-nope-deadbeef', dataDir: tmpDir });
      assert.equal(result.success, false);
      assert.ok(Array.isArray(result.errors));
      assert.ok(result.errors.length > 0);
    });
  });

  describe('editIdentity', () => {
    let tmpDir;
    let agent;

    before(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'aweek-manage-edit-'));
    });

    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
      const store = new AgentStore(tmpDir);
      const config = createAgentConfig({
        name: 'Carol',
        role: 'writer',
        systemPrompt: 'You are Carol, a writer.',
        weeklyTokenLimit: 100_000,
      });
      await store.save(config);
      agent = config;
    });

    it('requires agentId', async () => {
      const result = await editIdentity({ name: 'Dave', dataDir: tmpDir });
      assert.equal(result.success, false);
      assert.ok(result.errors.some((e) => /agentId/i.test(e)));
    });

    it('refuses when no editable fields are provided', async () => {
      const result = await editIdentity({ agentId: agent.id, dataDir: tmpDir });
      assert.equal(result.success, false);
      assert.ok(result.errors.some((e) => /at least one/i.test(e)));
    });

    it('updates only the provided fields', async () => {
      const result = await editIdentity({
        agentId: agent.id,
        name: 'Carol Renamed',
        dataDir: tmpDir,
      });
      assert.equal(result.success, true);
      assert.deepEqual(result.changed, ['name']);
      assert.equal(result.previous.name, 'Carol');
      assert.equal(result.current.name, 'Carol Renamed');
      assert.equal(result.current.role, 'writer');
      assert.equal(result.current.systemPrompt, 'You are Carol, a writer.');

      const store = new AgentStore(tmpDir);
      const reloaded = await store.load(agent.id);
      assert.equal(reloaded.identity.name, 'Carol Renamed');
      assert.equal(reloaded.identity.role, 'writer');
    });

    it('updates all three identity fields together', async () => {
      const result = await editIdentity({
        agentId: agent.id,
        name: 'Carol2',
        role: 'senior writer',
        systemPrompt: 'You are Carol2, a senior writer.',
        dataDir: tmpDir,
      });
      assert.equal(result.success, true);
      assert.deepEqual(result.changed.sort(), ['name', 'role', 'systemPrompt']);
    });

    it('rejects an identity that fails schema validation', async () => {
      // Name > 100 chars violates the schema.
      const tooLong = 'x'.repeat(150);
      const result = await editIdentity({
        agentId: agent.id,
        name: tooLong,
        dataDir: tmpDir,
      });
      assert.equal(result.success, false);
      assert.ok(result.errors.length > 0);

      // Agent file was not touched.
      const store = new AgentStore(tmpDir);
      const reloaded = await store.load(agent.id);
      assert.equal(reloaded.identity.name, 'Carol');
    });

    it('reports success with no changes when the new values match existing values', async () => {
      const result = await editIdentity({
        agentId: agent.id,
        name: 'Carol',
        dataDir: tmpDir,
      });
      assert.equal(result.success, true);
      assert.deepEqual(result.changed, []);
    });

    it('surfaces a descriptive not-found error for unknown agent', async () => {
      const result = await editIdentity({
        agentId: 'agent-ghost-12345678',
        name: 'Ghost',
        dataDir: tmpDir,
      });
      assert.equal(result.success, false);
    });
  });

  describe('deleteAgent (destructive, confirmation-gated)', () => {
    let tmpDir;
    let agent;

    before(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'aweek-manage-delete-'));
    });

    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
      const store = new AgentStore(tmpDir);
      const config = createAgentConfig({
        name: 'Dave',
        role: 'analyst',
        systemPrompt: 'You are Dave, an analyst.',
        weeklyTokenLimit: 100_000,
      });
      await store.save(config);
      agent = config;
    });

    it('refuses to run without confirmed: true', async () => {
      const result = await deleteAgent({ agentId: agent.id, dataDir: tmpDir });
      assert.equal(result.success, false);
      assert.ok(result.errors.some((e) => /explicit confirmation/i.test(e)));

      // File untouched.
      const store = new AgentStore(tmpDir);
      assert.equal(await store.exists(agent.id), true);
    });

    it('refuses to run when confirmed is false', async () => {
      const result = await deleteAgent({
        agentId: agent.id,
        dataDir: tmpDir,
        confirmed: false,
      });
      assert.equal(result.success, false);
      assert.ok(result.errors.some((e) => /explicit confirmation/i.test(e)));
    });

    it('requires agentId', async () => {
      const result = await deleteAgent({ dataDir: tmpDir, confirmed: true });
      assert.equal(result.success, false);
      assert.ok(result.errors.some((e) => /agentId/i.test(e)));
    });

    it('surfaces a descriptive not-found error when the agent does not exist', async () => {
      const result = await deleteAgent({
        agentId: 'agent-notthere-deadbeef',
        dataDir: tmpDir,
        confirmed: true,
      });
      assert.equal(result.success, false);
      assert.ok(result.errors.some((e) => /not found|ENOENT/i.test(e)));
    });

    it('deletes the agent config when confirmed:true', async () => {
      const result = await deleteAgent({
        agentId: agent.id,
        dataDir: tmpDir,
        confirmed: true,
      });
      assert.equal(result.success, true);
      assert.equal(result.deleted, true);
      assert.equal(result.snapshot.id, agent.id);
      assert.equal(result.snapshot.name, 'Dave');
      assert.equal(result.snapshot.role, 'analyst');

      const store = new AgentStore(tmpDir);
      assert.equal(await store.exists(agent.id), false);
    });
  });

  describe('new-action formatters', () => {
    it('formatPauseResult renders a success message', () => {
      const text = formatPauseResult({
        agentId: 'a',
        action: 'pause',
        success: true,
        wasPaused: false,
        message: 'Agent "a" has been paused.',
      });
      assert.match(text, /Pause Result/);
      assert.match(text, /resume/i);
    });

    it('formatPauseResult renders errors', () => {
      const text = formatPauseResult({
        agentId: 'a',
        action: 'pause',
        success: false,
        errors: ['not found'],
      });
      assert.match(text, /Failed to pause/);
      assert.match(text, /not found/);
    });

    it('formatIdentityResult renders changed fields', () => {
      const text = formatIdentityResult({
        agentId: 'a',
        action: 'edit-identity',
        success: true,
        changed: ['name', 'role'],
        previous: { name: 'Old', role: 'old-role', systemPrompt: 'x' },
        current: { name: 'New', role: 'new-role', systemPrompt: 'x' },
      });
      assert.match(text, /Identity Updated/);
      assert.match(text, /name: Old → New/);
      assert.match(text, /role: old-role → new-role/);
    });

    it('formatIdentityResult renders a no-op message', () => {
      const text = formatIdentityResult({
        agentId: 'a',
        action: 'edit-identity',
        success: true,
        changed: [],
        message: 'No identity fields changed for agent "a".',
      });
      assert.match(text, /No identity fields changed/);
    });

    it('formatDeleteResult renders success with a snapshot', () => {
      const text = formatDeleteResult({
        agentId: 'a',
        action: 'delete',
        success: true,
        deleted: true,
        snapshot: { id: 'a', name: 'Dave', role: 'analyst', goalCount: 2, weeklyPlanCount: 1 },
        message: 'Agent "Dave" (a) has been deleted.',
      });
      assert.match(text, /Agent Deleted/);
      assert.match(text, /Dave/);
      assert.match(text, /2 goal/);
      assert.match(text, /cannot be undone/);
    });

    it('formatDeleteResult renders failure', () => {
      const text = formatDeleteResult({
        agentId: 'a',
        action: 'delete',
        success: false,
        errors: ['nope'],
      });
      assert.match(text, /Failed to delete/);
    });
  });
});
