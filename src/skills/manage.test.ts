/**
 * Tests for the `manage` skill adapter.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
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
  deleteAgent,
  formatPauseResult,
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
      assert.match(result.error!, /Invalid action/);
    });

    it('rejects non-positive top-up newLimit', () => {
      const result = validateAction('top-up', { newLimit: -1 });
      assert.equal(result.valid, false);
      assert.match(result.error!, /positive number/);
    });
  });

  describe('topUp destructive confirmation gate', () => {
    it('refuses to run when confirmed is missing', async () => {
      const result = await topUp({ agentId: 'agent-x', dataDir: '/tmp/unused' });
      assert.equal(result.success, false);
      assert.ok(result.errors!.some((e) => /explicit confirmation/i.test(e)));
    });

    it('refuses to run when confirmed is false', async () => {
      const result = await topUp({ agentId: 'agent-x', dataDir: '/tmp/unused', confirmed: false });
      assert.equal(result.success, false);
      assert.ok(result.errors!.some((e) => /explicit confirmation/i.test(e)));
    });
  });

  describe('executeAction destructive confirmation gate', () => {
    it('refuses top-up without confirmation', async () => {
      const result = await executeAction('agent-x', 'top-up', { dataDir: '/tmp/unused' });
      assert.equal(result.success, false);
      assert.ok(result.errors!.some((e) => /explicit confirmation/i.test(e)));
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end resume / top-up with a real on-disk agent store
  // -------------------------------------------------------------------------
  describe('action dispatching (with filesystem)', () => {
    let tmpDir: string;
    let pausedAgent: ReturnType<typeof createAgentConfig>;

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
        subagentRef: 'alice',
        weeklyTokenLimit: 100_000,
      });
      // Mutate only the fields we care about — leave schema-required fields
      // (like `periodStart`) intact.
      config.budget!.paused = true;
      (config.budget as { currentUsage?: number }).currentUsage = 150_000;
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
      assert.equal(reloaded.budget!.paused, false);
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
      assert.equal(reloaded.budget!.paused, false);
      assert.equal((reloaded.budget as { currentUsage?: number }).currentUsage, 0);
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
      assert.equal((reloaded.budget as { currentUsage?: number }).currentUsage, 0);
      assert.equal(reloaded.budget!.paused, false);
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
      assert.equal(list.paused[0]!.id, pausedAgent.id);
      assert.equal(list.active.length, 0);
    });

    it('getPausedAgentDetails returns detailed budget info', async () => {
      const details = await getPausedAgentDetails(pausedAgent.id, { dataDir: tmpDir });
      assert.equal(details.paused, true);
      assert.equal(details.agentId, pausedAgent.id);
      assert.equal(details.budget!.weeklyTokenLimit, 100_000);
      assert.ok(details.budget!.exceededBy > 0);
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
    let tmpDir: string;
    let agent: ReturnType<typeof createAgentConfig>;

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
        subagentRef: 'bob',
        weeklyTokenLimit: 100_000,
      });
      // Active (not paused)
      config.budget!.paused = false;
      await store.save(config);
      agent = config;
    });

    it('requires agentId', async () => {
      const result = await pause({ dataDir: tmpDir });
      assert.equal(result.success, false);
      assert.ok(result.errors!.some((e) => /agentId/i.test(e)));
    });

    it('pauses an active agent (wasPaused:false)', async () => {
      const result = await pause({ agentId: agent.id, dataDir: tmpDir });
      assert.equal(result.success, true);
      assert.equal(result.action, 'pause');
      assert.equal(result.wasPaused, false);

      const store = new AgentStore(tmpDir);
      const reloaded = await store.load(agent.id);
      assert.equal(reloaded.budget!.paused, true);
    });

    it('is idempotent — pausing an already-paused agent is a no-op', async () => {
      await pause({ agentId: agent.id, dataDir: tmpDir });
      const second = await pause({ agentId: agent.id, dataDir: tmpDir });
      assert.equal(second.success, true);
      assert.equal(second.wasPaused, true);
      assert.match(second.message!, /already paused/i);
    });

    it('returns a structured error for a missing agent', async () => {
      const result = await pause({ agentId: 'agent-nope-deadbeef', dataDir: tmpDir });
      assert.equal(result.success, false);
      assert.ok(Array.isArray(result.errors));
      assert.ok(result.errors!.length > 0);
    });
  });

  describe('deleteAgent (destructive, confirmation-gated)', () => {
    let tmpDir: string;
    let agent: ReturnType<typeof createAgentConfig>;

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
        subagentRef: 'dave',
        weeklyTokenLimit: 100_000,
      });
      await store.save(config);
      agent = config;
    });

    it('refuses to run without confirmed: true', async () => {
      const result = await deleteAgent({ agentId: agent.id, dataDir: tmpDir });
      assert.equal(result.success, false);
      assert.ok(result.errors!.some((e) => /explicit confirmation/i.test(e)));

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
      assert.ok(result.errors!.some((e) => /explicit confirmation/i.test(e)));
    });

    it('requires agentId', async () => {
      const result = await deleteAgent({ dataDir: tmpDir, confirmed: true });
      assert.equal(result.success, false);
      assert.ok(result.errors!.some((e) => /agentId/i.test(e)));
    });

    it('surfaces a descriptive not-found error when the agent does not exist', async () => {
      const result = await deleteAgent({
        agentId: 'agent-notthere-deadbeef',
        dataDir: tmpDir,
        confirmed: true,
      });
      assert.equal(result.success, false);
      assert.ok(result.errors!.some((e) => /not found|ENOENT/i.test(e)));
    });

    it('deletes the agent config when confirmed:true', async () => {
      const result = await deleteAgent({
        agentId: agent.id,
        dataDir: tmpDir,
        confirmed: true,
      });
      assert.equal(result.success, true);
      assert.equal(result.deleted, true);
      assert.equal(result.snapshot!.id, agent.id);

      const store = new AgentStore(tmpDir);
      assert.equal(await store.exists(agent.id), false);
    });
  });

  // -------------------------------------------------------------------------
  // AC 10 — delete also handles the Claude Code subagent .md file.
  // -------------------------------------------------------------------------
  describe('deleteAgent — subagent .md handling (AC 10)', () => {
    let tmpDir: string;
    let dataDir: string;
    let subagentsDir: string;
    const slug = 'test-subagent';

    before(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'aweek-manage-delete-md-'));
    });

    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      // Fresh project layout on every test.
      await rm(tmpDir, { recursive: true, force: true });
      dataDir = join(tmpDir, '.aweek', 'agents');
      subagentsDir = join(tmpDir, '.claude', 'agents');
      await mkdir(dataDir, { recursive: true });
      await mkdir(subagentsDir, { recursive: true });

      const store = new AgentStore(dataDir);
      // Use the post-AC1 schema shape: id === subagentRef (slug), no identity.
      const config = createAgentConfig({
        subagentRef: slug,
        weeklyTokenLimit: 100_000,
      });
      await store.save(config);

      // And a matching subagent .md file.
      await writeFile(
        join(subagentsDir, `${slug}.md`),
        '---\nname: test-subagent\ndescription: test\n---\n\nBody.\n',
        'utf-8',
      );
    });

    /** Assert whether a path currently exists on disk. */
    async function pathExists(p: string): Promise<boolean> {
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    }

    it('defaults to keeping the .md file (deleteSubagentMd omitted)', async () => {
      const result = await deleteAgent({
        agentId: slug,
        dataDir,
        subagentsDir,
        confirmed: true,
      });

      assert.equal(result.success, true);
      assert.equal(result.deleted, true);
      // JSON gone.
      assert.equal(await pathExists(join(dataDir, `${slug}.json`)), false);
      // .md kept.
      const mdPath = join(subagentsDir, `${slug}.md`);
      assert.equal(await pathExists(mdPath), true);

      // Result records the kept .md explicitly.
      assert.ok(result.subagentMd, 'expected subagentMd metadata on result');
      assert.equal(result.subagentMd!.requested, false);
      assert.equal(result.subagentMd!.deleted, false);
      assert.equal(result.subagentMd!.path, mdPath);
    });

    it('defaults to keeping the .md file when deleteSubagentMd is explicitly false', async () => {
      const result = await deleteAgent({
        agentId: slug,
        dataDir,
        subagentsDir,
        confirmed: true,
        deleteSubagentMd: false,
      });

      assert.equal(result.success, true);
      const mdPath = join(subagentsDir, `${slug}.md`);
      assert.equal(await pathExists(mdPath), true);
      assert.equal(result.subagentMd!.requested, false);
      assert.equal(result.subagentMd!.deleted, false);
    });

    it('deletes the .md file when deleteSubagentMd is true', async () => {
      const mdPath = join(subagentsDir, `${slug}.md`);
      assert.equal(await pathExists(mdPath), true, 'precondition: .md exists');

      const result = await deleteAgent({
        agentId: slug,
        dataDir,
        subagentsDir,
        confirmed: true,
        deleteSubagentMd: true,
      });

      assert.equal(result.success, true);
      assert.equal(await pathExists(join(dataDir, `${slug}.json`)), false);
      assert.equal(await pathExists(mdPath), false);
      assert.equal(result.subagentMd!.requested, true);
      assert.equal(result.subagentMd!.existed, true);
      assert.equal(result.subagentMd!.deleted, true);
      assert.equal(result.subagentMd!.path, mdPath);
    });

    it('is graceful when deleteSubagentMd:true but the .md is already missing', async () => {
      // Remove the .md file before the delete runs.
      const mdPath = join(subagentsDir, `${slug}.md`);
      await rm(mdPath, { force: true });
      assert.equal(await pathExists(mdPath), false);

      const result = await deleteAgent({
        agentId: slug,
        dataDir,
        subagentsDir,
        confirmed: true,
        deleteSubagentMd: true,
      });

      // The overall delete still succeeds — a missing .md is not an error.
      assert.equal(result.success, true);
      assert.equal(result.deleted, true);
      assert.equal(result.subagentMd!.requested, true);
      assert.equal(result.subagentMd!.existed, false);
      assert.equal(result.subagentMd!.deleted, false);
      assert.ok(!result.subagentMd!.error, 'no error expected for missing .md');
    });

    it('formatDeleteResult renders "Subagent file kept" for the default path', async () => {
      const result = await deleteAgent({
        agentId: slug,
        dataDir,
        subagentsDir,
        confirmed: true,
      });
      const text = formatDeleteResult(result);
      assert.match(text, /Subagent file kept/);
      assert.match(text, new RegExp(`${slug}\\.md`));
    });

    it('formatDeleteResult renders "Subagent file deleted" when opted-in', async () => {
      const result = await deleteAgent({
        agentId: slug,
        dataDir,
        subagentsDir,
        confirmed: true,
        deleteSubagentMd: true,
      });
      const text = formatDeleteResult(result);
      assert.match(text, /Subagent file deleted/);
    });

    it('formatDeleteResult renders the "nothing to delete" path for missing .md', async () => {
      await rm(join(subagentsDir, `${slug}.md`), { force: true });
      const result = await deleteAgent({
        agentId: slug,
        dataDir,
        subagentsDir,
        confirmed: true,
        deleteSubagentMd: true,
      });
      const text = formatDeleteResult(result);
      assert.match(text, /Subagent file not found/);
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
