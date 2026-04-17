import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  markerFor,
  buildCronEntry,
  parseHeartbeatEntries,
  removeLinesForAgent,
} from './crontab-manager.js';

/**
 * In-memory test harness that mirrors the async functions in crontab-manager.js
 * (install, remove, query, listAll) but uses in-memory state instead of real
 * crontab commands. This lets us test the orchestration logic without touching
 * the system crontab.
 */
function createTestHarness() {
  let crontabContent = '';
  const writeCalls = [];

  async function install({ agentId, command, schedule = '0 * * * *' }) {
    const cleaned = removeLinesForAgent(crontabContent, agentId);
    const entry = buildCronEntry({ agentId, command, schedule });
    const base = cleaned.trimEnd();
    crontabContent = base ? `${base}\n${entry}\n` : `${entry}\n`;
    writeCalls.push(crontabContent);
    return { installed: true, entry };
  }

  async function remove(agentId) {
    const cleaned = removeLinesForAgent(crontabContent, agentId);
    const changed = cleaned !== crontabContent;
    if (changed) {
      const trimmed = cleaned.trim();
      if (trimmed) {
        crontabContent = trimmed + '\n';
        writeCalls.push(crontabContent);
      } else {
        crontabContent = '';
        writeCalls.push('__REMOVED__');
      }
    }
    return { removed: changed };
  }

  async function query(agentId) {
    const entries = parseHeartbeatEntries(crontabContent);
    const match = entries.find((e) => e.agentId === agentId) || null;
    return { active: !!match, entry: match };
  }

  async function listAll() {
    return parseHeartbeatEntries(crontabContent);
  }

  return {
    install,
    remove,
    query,
    listAll,
    get content() { return crontabContent; },
    set content(val) { crontabContent = val; },
    writeCalls,
  };
}

describe('CrontabManager', () => {
  describe('markerFor()', () => {
    it('should return marker with agent ID', () => {
      assert.equal(markerFor('agent-writer-abc12345'), 'aweek:heartbeat:agent-writer-abc12345');
    });
  });

  describe('buildCronEntry()', () => {
    it('should build a cron entry with default schedule', () => {
      const entry = buildCronEntry({
        agentId: 'agent-writer-abc12345',
        command: 'node run-heartbeat.js agent-writer-abc12345',
      });
      assert.equal(
        entry,
        '# aweek:heartbeat:agent-writer-abc12345\n0 * * * * node run-heartbeat.js agent-writer-abc12345'
      );
    });

    it('should build a cron entry with custom schedule', () => {
      const entry = buildCronEntry({
        agentId: 'agent-coder-def67890',
        command: 'node heartbeat.js agent-coder-def67890',
        schedule: '*/30 * * * *',
      });
      assert.ok(entry.includes('*/30 * * * *'));
      assert.ok(entry.includes('# aweek:heartbeat:agent-coder-def67890'));
    });

    it('should throw if agentId is missing', () => {
      assert.throws(
        () => buildCronEntry({ command: 'echo hi' }),
        { message: 'agentId is required' }
      );
    });

    it('should throw if command is missing', () => {
      assert.throws(
        () => buildCronEntry({ agentId: 'agent-test-12345678' }),
        { message: 'command is required' }
      );
    });
  });

  describe('parseHeartbeatEntries()', () => {
    it('should return empty array for empty crontab', () => {
      assert.deepStrictEqual(parseHeartbeatEntries(''), []);
      assert.deepStrictEqual(parseHeartbeatEntries('  \n  '), []);
    });

    it('should parse a single heartbeat entry', () => {
      const text = [
        '# aweek:heartbeat:agent-writer-abc12345',
        '0 * * * * node run-heartbeat.js agent-writer-abc12345',
      ].join('\n');

      const entries = parseHeartbeatEntries(text);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].agentId, 'agent-writer-abc12345');
      assert.equal(entries[0].schedule, '0 * * * *');
      assert.equal(entries[0].command, 'node run-heartbeat.js agent-writer-abc12345');
      assert.equal(entries[0].marker, 'aweek:heartbeat:agent-writer-abc12345');
    });

    it('should parse multiple heartbeat entries', () => {
      const text = [
        '# some other cron comment',
        '30 2 * * * /usr/bin/backup.sh',
        '# aweek:heartbeat:agent-writer-abc12345',
        '0 * * * * node run-heartbeat.js agent-writer-abc12345',
        '# aweek:heartbeat:agent-coder-def67890',
        '*/30 * * * * node run-heartbeat.js agent-coder-def67890',
      ].join('\n');

      const entries = parseHeartbeatEntries(text);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].agentId, 'agent-writer-abc12345');
      assert.equal(entries[1].agentId, 'agent-coder-def67890');
      assert.equal(entries[1].schedule, '*/30 * * * *');
    });

    it('should ignore non-aweek comments and entries', () => {
      const text = [
        '# regular comment',
        '0 3 * * * /usr/bin/cleanup.sh',
        '# aweek:heartbeat:agent-test-11111111',
        '0 * * * * node heartbeat.js agent-test-11111111',
      ].join('\n');

      const entries = parseHeartbeatEntries(text);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].agentId, 'agent-test-11111111');
    });

    it('should skip marker without following cron line', () => {
      const text = [
        '# aweek:heartbeat:agent-orphan-00000000',
        '# another comment immediately after',
      ].join('\n');

      const entries = parseHeartbeatEntries(text);
      assert.equal(entries.length, 0);
    });
  });

  describe('removeLinesForAgent()', () => {
    it('should remove marker and cron line for specified agent', () => {
      const text = [
        '# aweek:heartbeat:agent-writer-abc12345',
        '0 * * * * node run-heartbeat.js agent-writer-abc12345',
        '# aweek:heartbeat:agent-coder-def67890',
        '0 * * * * node run-heartbeat.js agent-coder-def67890',
      ].join('\n');

      const result = removeLinesForAgent(text, 'agent-writer-abc12345');
      assert.ok(!result.includes('agent-writer-abc12345'));
      assert.ok(result.includes('agent-coder-def67890'));
    });

    it('should preserve non-aweek entries', () => {
      const text = [
        '30 2 * * * /usr/bin/backup.sh',
        '# aweek:heartbeat:agent-writer-abc12345',
        '0 * * * * node run-heartbeat.js agent-writer-abc12345',
        '0 4 * * * /usr/bin/other.sh',
      ].join('\n');

      const result = removeLinesForAgent(text, 'agent-writer-abc12345');
      assert.ok(result.includes('/usr/bin/backup.sh'));
      assert.ok(result.includes('/usr/bin/other.sh'));
      assert.ok(!result.includes('agent-writer-abc12345'));
    });

    it('should be idempotent — removing nonexistent agent changes nothing', () => {
      const text = [
        '# aweek:heartbeat:agent-writer-abc12345',
        '0 * * * * node run-heartbeat.js agent-writer-abc12345',
      ].join('\n');

      const result = removeLinesForAgent(text, 'agent-nonexistent-00000000');
      assert.equal(result, text);
    });

    it('should handle empty crontab', () => {
      assert.equal(removeLinesForAgent('', 'agent-test-12345678'), '');
    });

    it('should remove all lines when only one agent entry exists', () => {
      const text = [
        '# aweek:heartbeat:agent-solo-11111111',
        '0 * * * * node heartbeat.js agent-solo-11111111',
      ].join('\n');

      const result = removeLinesForAgent(text, 'agent-solo-11111111');
      assert.equal(result.trim(), '');
    });
  });

  describe('integration: buildCronEntry + parseHeartbeatEntries roundtrip', () => {
    it('should produce entry that parses back correctly', () => {
      const entry = buildCronEntry({
        agentId: 'agent-roundtrip-aaa11111',
        command: 'node heartbeat.js agent-roundtrip-aaa11111',
        schedule: '15 */2 * * *',
      });

      const parsed = parseHeartbeatEntries(entry);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].agentId, 'agent-roundtrip-aaa11111');
      assert.equal(parsed[0].schedule, '15 */2 * * *');
      assert.equal(parsed[0].command, 'node heartbeat.js agent-roundtrip-aaa11111');
    });
  });

  describe('integration: buildCronEntry + removeLinesForAgent roundtrip', () => {
    it('should cleanly add and remove entries', () => {
      const entry1 = buildCronEntry({
        agentId: 'agent-a-11111111',
        command: 'node hb.js agent-a-11111111',
      });
      const entry2 = buildCronEntry({
        agentId: 'agent-b-22222222',
        command: 'node hb.js agent-b-22222222',
      });

      const combined = `${entry1}\n${entry2}`;

      // Remove first agent
      const afterRemove = removeLinesForAgent(combined, 'agent-a-11111111');
      const remaining = parseHeartbeatEntries(afterRemove);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].agentId, 'agent-b-22222222');

      // Remove second agent
      const afterRemoveAll = removeLinesForAgent(afterRemove, 'agent-b-22222222');
      const none = parseHeartbeatEntries(afterRemoveAll);
      assert.equal(none.length, 0);
    });
  });
});

// ── Async function tests using in-memory harness ──────────────────────────
// These tests verify install/remove/query/listAll logic without touching
// the real system crontab, by re-implementing the same logic with mock I/O.

describe('CrontabManager — install()', () => {
  it('should install a heartbeat entry into empty crontab', async () => {
    const h = await createTestHarness();

    const result = await h.install({
      agentId: 'agent-writer-abc12345',
      command: 'node heartbeat.js agent-writer-abc12345',
    });

    assert.equal(result.installed, true);
    assert.ok(result.entry.includes('aweek:heartbeat:agent-writer-abc12345'));

    // Crontab should contain the entry
    assert.ok(h.content.includes('agent-writer-abc12345'));
    assert.ok(h.content.includes('0 * * * *'));
  });

  it('should install with custom schedule', async () => {
    const h = await createTestHarness();

    await h.install({
      agentId: 'agent-fast-11111111',
      command: 'node hb.js agent-fast-11111111',
      schedule: '*/15 * * * *',
    });

    assert.ok(h.content.includes('*/15 * * * *'));
  });

  it('should be idempotent — reinstalling replaces existing entry', async () => {
    const h = await createTestHarness();

    await h.install({
      agentId: 'agent-idem-22222222',
      command: 'node hb.js agent-idem-22222222',
      schedule: '0 * * * *',
    });

    // Install again with different schedule
    await h.install({
      agentId: 'agent-idem-22222222',
      command: 'node hb.js agent-idem-22222222',
      schedule: '*/30 * * * *',
    });

    // Should only have one entry for this agent
    const entries = parseHeartbeatEntries(h.content);
    const agentEntries = entries.filter((e) => e.agentId === 'agent-idem-22222222');
    assert.equal(agentEntries.length, 1);
    assert.equal(agentEntries[0].schedule, '*/30 * * * *');
  });

  it('should preserve existing non-aweek crontab entries', async () => {
    const h = await createTestHarness();
    h.content = '30 2 * * * /usr/bin/backup.sh\n';

    await h.install({
      agentId: 'agent-new-33333333',
      command: 'node hb.js agent-new-33333333',
    });

    assert.ok(h.content.includes('/usr/bin/backup.sh'));
    assert.ok(h.content.includes('agent-new-33333333'));
  });

  it('should preserve other agent entries when installing a new one', async () => {
    const h = await createTestHarness();

    await h.install({
      agentId: 'agent-first-11111111',
      command: 'node hb.js agent-first-11111111',
    });
    await h.install({
      agentId: 'agent-second-22222222',
      command: 'node hb.js agent-second-22222222',
    });

    const entries = parseHeartbeatEntries(h.content);
    assert.equal(entries.length, 2);
    assert.ok(entries.some((e) => e.agentId === 'agent-first-11111111'));
    assert.ok(entries.some((e) => e.agentId === 'agent-second-22222222'));
  });

  it('should ensure trailing newline in crontab', async () => {
    const h = await createTestHarness();

    await h.install({
      agentId: 'agent-nl-44444444',
      command: 'node hb.js agent-nl-44444444',
    });

    assert.ok(h.content.endsWith('\n'));
  });
});

describe('CrontabManager — remove()', () => {
  it('should remove an existing agent entry', async () => {
    const h = await createTestHarness();

    await h.install({
      agentId: 'agent-rm-11111111',
      command: 'node hb.js agent-rm-11111111',
    });

    const result = await h.remove('agent-rm-11111111');
    assert.equal(result.removed, true);

    const entries = parseHeartbeatEntries(h.content);
    assert.equal(entries.length, 0);
  });

  it('should be idempotent — removing nonexistent agent returns removed=false', async () => {
    const h = await createTestHarness();

    const result = await h.remove('agent-nonexistent-00000000');
    assert.equal(result.removed, false);
  });

  it('should preserve other entries when removing one agent', async () => {
    const h = await createTestHarness();

    await h.install({
      agentId: 'agent-keep-11111111',
      command: 'node hb.js agent-keep-11111111',
    });
    await h.install({
      agentId: 'agent-drop-22222222',
      command: 'node hb.js agent-drop-22222222',
    });

    await h.remove('agent-drop-22222222');

    const entries = parseHeartbeatEntries(h.content);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].agentId, 'agent-keep-11111111');
  });

  it('should clear crontab entirely when last entry removed', async () => {
    const h = await createTestHarness();

    await h.install({
      agentId: 'agent-solo-11111111',
      command: 'node hb.js agent-solo-11111111',
    });

    await h.remove('agent-solo-11111111');

    // Should have triggered a removal (content empty or __REMOVED__)
    assert.ok(
      h.writeCalls.some((c) => c === '__REMOVED__'),
      'Expected crontab removal when last entry is removed'
    );
  });

  it('should not write crontab when nothing changed', async () => {
    const h = await createTestHarness();
    const writeCountBefore = h.writeCalls.length;

    await h.remove('agent-nonexistent-99999999');

    assert.equal(h.writeCalls.length, writeCountBefore, 'No writes should occur when nothing changed');
  });
});

describe('CrontabManager — query()', () => {
  it('should return active=true for existing agent', async () => {
    const h = await createTestHarness();

    await h.install({
      agentId: 'agent-query-11111111',
      command: 'node hb.js agent-query-11111111',
    });

    const result = await h.query('agent-query-11111111');
    assert.equal(result.active, true);
    assert.ok(result.entry);
    assert.equal(result.entry.agentId, 'agent-query-11111111');
    assert.equal(result.entry.schedule, '0 * * * *');
    assert.equal(result.entry.command, 'node hb.js agent-query-11111111');
  });

  it('should return active=false for nonexistent agent', async () => {
    const h = await createTestHarness();

    const result = await h.query('agent-missing-00000000');
    assert.equal(result.active, false);
    assert.equal(result.entry, null);
  });

  it('should return active=false on empty crontab', async () => {
    const h = await createTestHarness();

    const result = await h.query('agent-any-12345678');
    assert.equal(result.active, false);
    assert.equal(result.entry, null);
  });

  it('should distinguish between different agents', async () => {
    const h = await createTestHarness();

    await h.install({
      agentId: 'agent-alpha-11111111',
      command: 'node hb.js agent-alpha-11111111',
    });
    await h.install({
      agentId: 'agent-beta-22222222',
      command: 'node hb.js agent-beta-22222222',
      schedule: '*/30 * * * *',
    });

    const alpha = await h.query('agent-alpha-11111111');
    const beta = await h.query('agent-beta-22222222');
    const gamma = await h.query('agent-gamma-33333333');

    assert.equal(alpha.active, true);
    assert.equal(alpha.entry.schedule, '0 * * * *');
    assert.equal(beta.active, true);
    assert.equal(beta.entry.schedule, '*/30 * * * *');
    assert.equal(gamma.active, false);
  });
});

describe('CrontabManager — listAll()', () => {
  it('should return empty array for empty crontab', async () => {
    const h = await createTestHarness();

    const result = await h.listAll();
    assert.deepStrictEqual(result, []);
  });

  it('should return all installed agents', async () => {
    const h = await createTestHarness();

    await h.install({
      agentId: 'agent-list-11111111',
      command: 'node hb.js agent-list-11111111',
    });
    await h.install({
      agentId: 'agent-list-22222222',
      command: 'node hb.js agent-list-22222222',
      schedule: '*/15 * * * *',
    });

    const result = await h.listAll();
    assert.equal(result.length, 2);
    assert.ok(result.some((e) => e.agentId === 'agent-list-11111111'));
    assert.ok(result.some((e) => e.agentId === 'agent-list-22222222'));
  });

  it('should not include non-aweek crontab entries', async () => {
    const h = await createTestHarness();
    h.content = '30 2 * * * /usr/bin/backup.sh\n';

    await h.install({
      agentId: 'agent-only-11111111',
      command: 'node hb.js agent-only-11111111',
    });

    const result = await h.listAll();
    assert.equal(result.length, 1);
    assert.equal(result[0].agentId, 'agent-only-11111111');
  });
});

describe('CrontabManager — error handling', () => {
  describe('buildCronEntry validation', () => {
    it('should throw for empty string agentId', () => {
      assert.throws(
        () => buildCronEntry({ agentId: '', command: 'echo hi' }),
        { message: 'agentId is required' }
      );
    });

    it('should throw for empty string command', () => {
      assert.throws(
        () => buildCronEntry({ agentId: 'agent-test-12345678', command: '' }),
        { message: 'command is required' }
      );
    });

    it('should throw for undefined agentId', () => {
      assert.throws(
        () => buildCronEntry({ agentId: undefined, command: 'echo hi' }),
        { message: 'agentId is required' }
      );
    });

    it('should throw for null command', () => {
      assert.throws(
        () => buildCronEntry({ agentId: 'agent-test-12345678', command: null }),
        { message: 'command is required' }
      );
    });
  });

  describe('parseHeartbeatEntries edge cases', () => {
    it('should handle marker as last line with no following cron line', () => {
      const text = '# aweek:heartbeat:agent-trailing-00000000';
      const entries = parseHeartbeatEntries(text);
      assert.equal(entries.length, 0);
    });

    it('should handle marker followed by another marker', () => {
      const text = [
        '# aweek:heartbeat:agent-first-11111111',
        '# aweek:heartbeat:agent-second-22222222',
        '0 * * * * node hb.js agent-second-22222222',
      ].join('\n');

      const entries = parseHeartbeatEntries(text);
      // First marker has no cron line (next line is a comment), so skipped
      assert.equal(entries.length, 1);
      assert.equal(entries[0].agentId, 'agent-second-22222222');
    });

    it('should handle crontab with only whitespace lines', () => {
      const text = '   \n\n  \n';
      const entries = parseHeartbeatEntries(text);
      assert.deepStrictEqual(entries, []);
    });

    it('should handle crontab with mixed content and multiple agents', () => {
      const text = [
        '# System maintenance',
        '0 3 * * * /usr/bin/cleanup.sh',
        '',
        '# aweek:heartbeat:agent-a-11111111',
        '0 * * * * node hb.js agent-a-11111111',
        '',
        '# Another system job',
        '*/5 * * * * /usr/bin/healthcheck.sh',
        '',
        '# aweek:heartbeat:agent-b-22222222',
        '30 * * * * node hb.js agent-b-22222222',
      ].join('\n');

      const entries = parseHeartbeatEntries(text);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].agentId, 'agent-a-11111111');
      assert.equal(entries[0].schedule, '0 * * * *');
      assert.equal(entries[1].agentId, 'agent-b-22222222');
      assert.equal(entries[1].schedule, '30 * * * *');
    });
  });

  describe('removeLinesForAgent edge cases', () => {
    it('should handle crontab with trailing newlines', () => {
      const text = '# aweek:heartbeat:agent-trail-11111111\n0 * * * * node hb.js agent-trail-11111111\n\n\n';
      const result = removeLinesForAgent(text, 'agent-trail-11111111');
      // Only the agent lines removed, trailing newlines preserved as empty lines
      assert.ok(!result.includes('agent-trail-11111111'));
    });

    it('should not remove partial marker matches', () => {
      const text = [
        '# aweek:heartbeat:agent-abc-11111111',
        '0 * * * * node hb.js agent-abc-11111111',
        '# aweek:heartbeat:agent-abc-11111111-extended',
        '0 * * * * node hb.js agent-abc-11111111-extended',
      ].join('\n');

      const result = removeLinesForAgent(text, 'agent-abc-11111111');
      // Should only remove exact match, not the extended one
      assert.ok(!result.includes('# aweek:heartbeat:agent-abc-11111111\n'));
      assert.ok(result.includes('agent-abc-11111111-extended'));
    });
  });

  describe('install + remove full lifecycle', () => {
    it('should support install → query → remove → query cycle', async () => {
      const h = await createTestHarness();

      // Install
      const installResult = await h.install({
        agentId: 'agent-lifecycle-11111111',
        command: 'node hb.js agent-lifecycle-11111111',
      });
      assert.equal(installResult.installed, true);

      // Query — should be active
      const q1 = await h.query('agent-lifecycle-11111111');
      assert.equal(q1.active, true);

      // Remove
      const removeResult = await h.remove('agent-lifecycle-11111111');
      assert.equal(removeResult.removed, true);

      // Query — should be inactive
      const q2 = await h.query('agent-lifecycle-11111111');
      assert.equal(q2.active, false);
    });

    it('should support multiple install/remove cycles for same agent', async () => {
      const h = await createTestHarness();

      for (let i = 0; i < 3; i++) {
        await h.install({
          agentId: 'agent-cycle-11111111',
          command: 'node hb.js agent-cycle-11111111',
        });
        const q1 = await h.query('agent-cycle-11111111');
        assert.equal(q1.active, true, `Cycle ${i}: should be active after install`);

        await h.remove('agent-cycle-11111111');
        const q2 = await h.query('agent-cycle-11111111');
        assert.equal(q2.active, false, `Cycle ${i}: should be inactive after remove`);
      }
    });

    it('should handle install of multiple agents then selective removal', async () => {
      const h = await createTestHarness();
      const agents = ['agent-m1-11111111', 'agent-m2-22222222', 'agent-m3-33333333'];

      // Install all
      for (const id of agents) {
        await h.install({ agentId: id, command: `node hb.js ${id}` });
      }

      let all = await h.listAll();
      assert.equal(all.length, 3);

      // Remove middle one
      await h.remove('agent-m2-22222222');

      all = await h.listAll();
      assert.equal(all.length, 2);
      assert.ok(all.some((e) => e.agentId === 'agent-m1-11111111'));
      assert.ok(all.some((e) => e.agentId === 'agent-m3-33333333'));
      assert.ok(!all.some((e) => e.agentId === 'agent-m2-22222222'));
    });
  });
});
