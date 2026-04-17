/**
 * Tests for the shared agent selection / storage helpers.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentStore } from './agent-store.js';
import { createAgentConfig } from '../models/agent.js';
import {
  DEFAULT_DATA_DIR,
  getDefaultDataDir,
  resolveDataDir,
  createAgentStore,
  listAllAgents,
  loadAgent,
  getAgentChoices,
  findAgentByQuery,
  formatAgentChoice,
} from './agent-helpers.js';

let tmpDir;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'aweek-helpers-'));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clear out any agent files from prior tests in the shared tmpDir.
  const store = new AgentStore(tmpDir);
  try {
    const ids = await store.list();
    await Promise.all(ids.map((id) => store.delete(id)));
  } catch {
    // Directory may not exist yet — that's fine.
  }
});

describe('getDefaultDataDir / DEFAULT_DATA_DIR', () => {
  it('resolves to .aweek/agents under the current cwd', () => {
    assert.ok(getDefaultDataDir().endsWith('/.aweek/agents'));
  });

  it('DEFAULT_DATA_DIR is an absolute path', () => {
    assert.ok(DEFAULT_DATA_DIR.startsWith('/'));
    assert.ok(DEFAULT_DATA_DIR.endsWith('/.aweek/agents'));
  });
});

describe('resolveDataDir', () => {
  it('returns the provided directory verbatim when truthy', () => {
    assert.equal(resolveDataDir('/some/path'), '/some/path');
  });

  it('falls back to the default when the argument is missing', () => {
    assert.equal(resolveDataDir(), getDefaultDataDir());
  });

  it('falls back to the default on empty string / null / undefined', () => {
    assert.equal(resolveDataDir(''), getDefaultDataDir());
    assert.equal(resolveDataDir(null), getDefaultDataDir());
    assert.equal(resolveDataDir(undefined), getDefaultDataDir());
  });
});

describe('createAgentStore', () => {
  it('creates an AgentStore with the resolved data dir', () => {
    const store = createAgentStore(tmpDir);
    assert.ok(store instanceof AgentStore);
    assert.equal(store.baseDir, tmpDir);
  });

  it('defaults to getDefaultDataDir when no arg', () => {
    const store = createAgentStore();
    assert.equal(store.baseDir, getDefaultDataDir());
  });
});

describe('listAllAgents', () => {
  it('returns an empty array when the data dir is missing', async () => {
    const missing = join(tmpDir, 'does-not-exist');
    const result = await listAllAgents({ dataDir: missing });
    assert.deepEqual(result, []);
  });

  it('loads all saved agent configs', async () => {
    const store = new AgentStore(tmpDir);
    await store.save(createAgentConfig({
      name: 'Ada',
      role: 'engineer',
      systemPrompt: 'Help with code.',
    }));
    await store.save(createAgentConfig({
      name: 'Bob',
      role: 'writer',
      systemPrompt: 'Help with docs.',
    }));

    const configs = await listAllAgents({ dataDir: tmpDir });
    assert.equal(configs.length, 2);
    const names = configs.map((c) => c.identity.name).sort();
    assert.deepEqual(names, ['Ada', 'Bob']);
  });

  it('accepts a pre-constructed agentStore for injection', async () => {
    const store = new AgentStore(tmpDir);
    await store.save(createAgentConfig({
      name: 'Inj',
      role: 'tester',
      systemPrompt: 'x',
    }));
    const configs = await listAllAgents({ agentStore: store });
    assert.equal(configs.length, 1);
    assert.equal(configs[0].identity.name, 'Inj');
  });
});

describe('loadAgent', () => {
  it('throws "Agent not found: ID" when the file does not exist', async () => {
    await assert.rejects(
      () => loadAgent({ agentId: 'missing', dataDir: tmpDir }),
      /Agent not found: missing/
    );
  });

  it('loads a saved agent by id', async () => {
    const store = new AgentStore(tmpDir);
    const saved = await store.save(createAgentConfig({
      name: 'Ada',
      role: 'engineer',
      systemPrompt: 'Help with code.',
    }));

    const loaded = await loadAgent({ agentId: saved.id, dataDir: tmpDir });
    assert.equal(loaded.id, saved.id);
    assert.equal(loaded.identity.name, 'Ada');
  });

  it('rejects with a helpful error when agentId is missing', async () => {
    await assert.rejects(
      () => loadAgent({ dataDir: tmpDir }),
      /agentId is required/
    );
  });
});

describe('getAgentChoices', () => {
  it('returns an empty array when there are no agents', async () => {
    const choices = await getAgentChoices({ dataDir: tmpDir });
    assert.deepEqual(choices, []);
  });

  it('returns lightweight choice entries with label / paused / latest week', async () => {
    const store = new AgentStore(tmpDir);
    const agent = createAgentConfig({
      name: 'Ada',
      role: 'engineer',
      systemPrompt: 'x',
    });
    agent.weeklyPlans = [
      { week: '2026-W16', month: '2026-04', tasks: [], approved: true },
    ];
    agent.budget.paused = true;
    await store.save(agent);

    const [choice] = await getAgentChoices({ dataDir: tmpDir });
    assert.equal(choice.id, agent.id);
    assert.equal(choice.name, 'Ada');
    assert.equal(choice.role, 'engineer');
    assert.equal(choice.paused, true);
    assert.equal(choice.latestWeek, '2026-W16');
    assert.equal(choice.approved, true);
    assert.equal(choice.taskCount, 0);
    assert.match(choice.label, /Ada \(engineer\) \[paused\]/);
  });
});

describe('findAgentByQuery', () => {
  const configs = [
    { id: 'abc-123', identity: { name: 'Ada', role: 'engineer' } },
    { id: 'def-456', identity: { name: 'Bob', role: 'writer' } },
    { id: 'ghi-789', identity: { name: 'Adam', role: 'ops' } },
  ];

  it('matches on exact id', () => {
    const match = findAgentByQuery('def-456', configs);
    assert.equal(match.identity.name, 'Bob');
  });

  it('matches on case-insensitive exact name', () => {
    const match = findAgentByQuery('ADA', configs);
    assert.equal(match.id, 'abc-123');
  });

  it('returns the single prefix match', () => {
    const match = findAgentByQuery('def', configs);
    assert.equal(match.id, 'def-456');
  });

  it('returns null on ambiguous prefix', () => {
    // "Ad" matches both "Ada" and "Adam".
    assert.equal(findAgentByQuery('Ad', configs), null);
  });

  it('returns null on no match', () => {
    assert.equal(findAgentByQuery('zzz', configs), null);
  });

  it('returns null on empty / invalid input', () => {
    assert.equal(findAgentByQuery('', configs), null);
    assert.equal(findAgentByQuery(null, configs), null);
    assert.equal(findAgentByQuery('abc', null), null);
  });
});

describe('formatAgentChoice', () => {
  it('handles the lightweight shape from getAgentChoices', () => {
    const label = formatAgentChoice({
      id: 'x',
      name: 'Ada',
      role: 'engineer',
      paused: false,
    });
    assert.equal(label, 'Ada (engineer)');
  });

  it('handles the full agent config shape', () => {
    const label = formatAgentChoice({
      id: 'x',
      identity: { name: 'Ada', role: 'engineer' },
      budget: { paused: true },
    });
    assert.equal(label, 'Ada (engineer) [paused]');
  });

  it('omits empty role cleanly', () => {
    const label = formatAgentChoice({ id: 'x', name: 'Ada' });
    assert.equal(label, 'Ada');
  });

  it('falls back to id when name is missing', () => {
    const label = formatAgentChoice({ id: 'x' });
    assert.equal(label, 'x');
  });

  it('returns empty string for null input', () => {
    assert.equal(formatAgentChoice(null), '');
  });
});
