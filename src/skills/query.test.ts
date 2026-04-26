/**
 * Tests for the query skill — agent filtering across role, status, keyword,
 * and budget dimensions. Mirrors the summary.test.js layout so the two
 * selection skills share a mental model for reviewers.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { UsageStore, createUsageRecord } from '../storage/usage-store.js';
import {
  createAgentConfig,
  createWeeklyPlan,
  createTask,
} from '../models/agent.js';
import {
  buildSubagentMarkdown,
  subagentFilePath,
} from '../subagents/subagent-file.js';

import {
  normalizeStatusFilter,
  matchesRole,
  matchesKeyword,
  matchesStatus,
  matchesBudget,
  queryAgents,
  formatQueryResult,
  buildQueryChoices,
  buildQueryRow,
  MISSING_SUBAGENT_MARKER,
} from './query.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('normalizeStatusFilter', () => {
  it('returns null when no filter is provided', () => {
    assert.equal(normalizeStatusFilter(undefined), null);
    assert.equal(normalizeStatusFilter(null), null);
    assert.equal(normalizeStatusFilter(''), null);
    assert.equal(normalizeStatusFilter('   '), null);
  });

  it('lowercases a single string', () => {
    assert.deepEqual(normalizeStatusFilter('ACTIVE'), ['active']);
  });

  it('splits comma-separated lists', () => {
    assert.deepEqual(
      normalizeStatusFilter('Active, paused'),
      ['active', 'paused'],
    );
  });

  it('accepts a pre-split array', () => {
    assert.deepEqual(
      normalizeStatusFilter(['Active', 'IDLE']),
      ['active', 'idle'],
    );
  });
});

describe('matchesRole', () => {
  it('passes through when no role is requested', () => {
    assert.deepEqual(matchesRole('anything', ''), { matched: true, on: [] });
    assert.deepEqual(matchesRole('anything', undefined), { matched: true, on: [] });
  });

  it('matches a case-insensitive substring of the description', () => {
    const result = matchesRole('Senior Brand Marketer', 'MARKETER');
    assert.equal(result.matched, true);
    assert.deepEqual(result.on, ['description']);
  });

  it('rejects when the substring is absent', () => {
    assert.equal(matchesRole('Backend engineer', 'marketer').matched, false);
  });
});

describe('matchesKeyword', () => {
  it('passes through when no keyword is requested', () => {
    const result = matchesKeyword({ name: 'x', description: 'y', body: 'z' }, '');
    assert.equal(result.matched, true);
  });

  it('reports every field the keyword matched on', () => {
    const result = matchesKeyword(
      { name: 'Growth Gwen', description: 'Runs growth', body: 'You drive growth KPIs.' },
      'growth',
    );
    assert.equal(result.matched, true);
    assert.deepEqual(result.on.sort(), ['description', 'name', 'systemPrompt']);
  });

  it('only reports matched fields', () => {
    const result = matchesKeyword(
      { name: 'Sam', description: 'Writes copy', body: 'You write blog posts.' },
      'blog',
    );
    assert.deepEqual(result.on, ['systemPrompt']);
  });

  it('returns matched=false when nothing hits', () => {
    const result = matchesKeyword(
      { name: 'Sam', description: 'Writes copy', body: 'Blog posts.' },
      'devops',
    );
    assert.equal(result.matched, false);
    assert.deepEqual(result.on, []);
  });
});

describe('matchesStatus', () => {
  it('passes when no filter is supplied', () => {
    assert.equal(matchesStatus('idle', null), true);
  });

  it('matches against the lowercase list', () => {
    assert.equal(matchesStatus('ACTIVE', ['active']), true);
    assert.equal(matchesStatus('idle', ['active', 'paused']), false);
  });
});

describe('matchesBudget', () => {
  it('passes through when no filter is supplied', () => {
    assert.equal(matchesBudget({ weeklyTokenLimit: 100000, utilizationPct: 25 }, null), true);
  });

  it('isolates no-limit agents', () => {
    assert.equal(matchesBudget({ weeklyTokenLimit: 0 }, 'no-limit'), true);
    assert.equal(matchesBudget({ weeklyTokenLimit: 100000, utilizationPct: 10 }, 'no-limit'), false);
  });

  it('isolates under-budget agents', () => {
    assert.equal(matchesBudget({ weeklyTokenLimit: 100000, utilizationPct: 25 }, 'under'), true);
    assert.equal(matchesBudget({ weeklyTokenLimit: 100000, utilizationPct: 100 }, 'under'), false);
    assert.equal(matchesBudget({ weeklyTokenLimit: 0 }, 'under'), false);
  });

  it('isolates over-budget agents', () => {
    assert.equal(matchesBudget({ weeklyTokenLimit: 100000, utilizationPct: 120 }, 'over'), true);
    assert.equal(matchesBudget({ weeklyTokenLimit: 100000, utilizationPct: 99 }, 'over'), false);
  });

  it('ignores unknown tokens instead of dropping every row', () => {
    assert.equal(matchesBudget({ weeklyTokenLimit: 100000, utilizationPct: 50 }, 'anywhere'), true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let projectDir: string;
let dataDir: string;

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), 'query-test-'));
  projectDir = tmpDir;
  dataDir = join(projectDir, '.aweek', 'agents');
  await mkdir(join(projectDir, '.claude', 'agents'), { recursive: true });
}

async function teardown() {
  await rm(tmpDir, { recursive: true, force: true });
}

async function writeSubagentMd(slug: string, { name, description, systemPrompt }: { name?: string; description?: string; systemPrompt?: string }): Promise<void> {
  const content = buildSubagentMarkdown({
    name: name || slug,
    description: description || `${slug} description`,
    systemPrompt: systemPrompt || `You are ${slug}.`,
  });
  await writeFile(subagentFilePath(slug, projectDir), content, 'utf8');
}

async function makeAgent(slug: string, { description, systemPrompt, writeMd = true }: { description?: string; systemPrompt?: string; writeMd?: boolean } = {}): Promise<any> {
  if (writeMd) await writeSubagentMd(slug, { name: slug, description, systemPrompt });
  return createAgentConfig({ subagentRef: slug, weeklyTokenLimit: 100000 });
}

// ---------------------------------------------------------------------------
// queryAgents
// ---------------------------------------------------------------------------

describe('queryAgents', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('requires a dataDir', async () => {
    await assert.rejects(() => queryAgents({}), /dataDir is required/);
  });

  it('returns the full roster when no filters are supplied', async () => {
    const agentStore = new AgentStore(dataDir);
    await agentStore.save(await makeAgent('sam', { description: 'content marketer' }));
    await agentStore.save(await makeAgent('pat', { description: 'backend engineer' }));

    const result = await queryAgents({
      dataDir,
      projectDir,
      date: new Date('2026-04-17'),
    });

    assert.equal(result.total, 2);
    assert.equal(result.matched, 2);
    assert.equal(result.filters.role, null);
    const ids = result.agents.map((a: any) => a.id).sort();
    assert.deepEqual(ids, ['pat', 'sam']);
  });

  it('filters by role substring against the .md description', async () => {
    const agentStore = new AgentStore(dataDir);
    await agentStore.save(await makeAgent('sam', { description: 'Content marketer' }));
    await agentStore.save(await makeAgent('ivy', { description: 'Growth marketer' }));
    await agentStore.save(await makeAgent('pat', { description: 'Backend engineer' }));

    const result = await queryAgents({
      dataDir,
      projectDir,
      role: 'marketer',
      date: new Date('2026-04-17'),
    });

    assert.equal(result.matched, 2);
    const ids = result.agents.map((a: any) => a.id).sort();
    assert.deepEqual(ids, ['ivy', 'sam']);
    for (const a of result.agents) {
      assert.ok(a.matchedOn.includes('description'));
    }
  });

  it('filters by keyword across name + description + system prompt body', async () => {
    const agentStore = new AgentStore(dataDir);
    await agentStore.save(
      await makeAgent('sam', {
        description: 'Content marketer',
        systemPrompt: 'You write X.com posts daily.',
      }),
    );
    await agentStore.save(
      await makeAgent('ivy', {
        description: 'Growth marketer',
        systemPrompt: 'You drive signups through email.',
      }),
    );

    const result = await queryAgents({
      dataDir,
      projectDir,
      keyword: 'x.com',
      date: new Date('2026-04-17'),
    });

    assert.equal(result.matched, 1);
    assert.equal(result.agents[0].id, 'sam');
    assert.ok(result.agents[0].matchedOn.includes('systemPrompt'));
  });

  it('combines role and status filters (active marketers case)', async () => {
    const agentStore = new AgentStore(dataDir);
    const weeklyPlanStore = new WeeklyPlanStore(dataDir);

    // Sam — active marketer with an approved plan
    const sam = await makeAgent('sam', { description: 'Content marketer' });
    await agentStore.save(sam);
    const samPlan = createWeeklyPlan('2026-W16', '2026-04', [
      { ...createTask({ title: 't1', prompt: 't1' }, 'obj-1'), status: 'pending' },
    ]);
    samPlan.approved = true;
    samPlan.approvedAt = new Date().toISOString();
    await weeklyPlanStore.save(sam.id, samPlan);

    // Ivy — marketer, but paused (budget exhausted)
    const ivy = await makeAgent('ivy', { description: 'Growth marketer' });
    ivy.budget.paused = true;
    await agentStore.save(ivy);

    // Pat — active engineer (not a marketer)
    const pat = await makeAgent('pat', { description: 'Backend engineer' });
    await agentStore.save(pat);
    const patPlan = createWeeklyPlan('2026-W16', '2026-04', [
      { ...createTask({ title: 't1', prompt: 't1' }, 'obj-1'), status: 'pending' },
    ]);
    patPlan.approved = true;
    patPlan.approvedAt = new Date().toISOString();
    await weeklyPlanStore.save(pat.id, patPlan);

    const result = await queryAgents({
      dataDir,
      projectDir,
      role: 'marketer',
      status: 'active',
      date: new Date('2026-04-17'),
    });

    assert.equal(result.matched, 1);
    assert.equal(result.agents[0].id, 'sam');
  });

  it('supports a comma-separated status filter', async () => {
    const agentStore = new AgentStore(dataDir);
    const sam = await makeAgent('sam', { description: 'marketer' });
    await agentStore.save(sam);

    const ivy = await makeAgent('ivy', { description: 'marketer' });
    ivy.budget.paused = true;
    await agentStore.save(ivy);

    const result = await queryAgents({
      dataDir,
      projectDir,
      status: 'active, paused, idle',
      date: new Date('2026-04-17'),
    });
    // Sam is idle (no approved plan), Ivy is paused — both should match.
    assert.equal(result.matched, 2);
  });

  it('surfaces missing-subagent rows through status=missing-subagent', async () => {
    const agentStore = new AgentStore(dataDir);
    const ghost = await makeAgent('ghost', { description: 'temp' });
    await agentStore.save(ghost);
    await unlink(subagentFilePath('ghost', projectDir));

    // No filter — the ghost row is present but its state surfaces as missing.
    const all = await queryAgents({
      dataDir,
      projectDir,
      date: new Date('2026-04-17'),
    });
    assert.equal(all.matched, 1);
    assert.equal(all.agents[0].missing, true);
    assert.equal(all.agents[0].state, 'missing-subagent');

    // Explicit filter still finds it.
    const onlyGhosts = await queryAgents({
      dataDir,
      projectDir,
      status: 'missing-subagent',
      date: new Date('2026-04-17'),
    });
    assert.equal(onlyGhosts.matched, 1);
    assert.equal(onlyGhosts.agents[0].id, 'ghost');
  });

  it('drops missing-subagent rows when role/keyword filter is active', async () => {
    const agentStore = new AgentStore(dataDir);
    const ghost = await makeAgent('ghost', { description: 'marketer' });
    await agentStore.save(ghost);
    await unlink(subagentFilePath('ghost', projectDir));

    const result = await queryAgents({
      dataDir,
      projectDir,
      role: 'marketer',
      date: new Date('2026-04-17'),
    });
    // No .md on disk → no description text to match → ghost row is filtered out.
    assert.equal(result.matched, 0);
  });

  it('filters by over-budget status', async () => {
    const agentStore = new AgentStore(dataDir);
    const usageStore = new UsageStore(dataDir);

    const heavy = await makeAgent('heavy', { description: 'marketer' });
    heavy.budget.weeklyTokenLimit = 10000;
    await agentStore.save(heavy);
    await usageStore.append(
      heavy.id,
      createUsageRecord({
        agentId: heavy.id,
        taskId: 't1',
        inputTokens: 8000,
        outputTokens: 4000,
        week: '2026-04-13',
        timestamp: '2026-04-15T10:00:00Z',
      }),
    );

    const light = await makeAgent('light', { description: 'marketer' });
    light.budget.weeklyTokenLimit = 1000000;
    await agentStore.save(light);

    const result = await queryAgents({
      dataDir,
      projectDir,
      budget: 'over',
      date: new Date('2026-04-17'),
    });
    assert.equal(result.matched, 1);
    assert.equal(result.agents[0].id, 'heavy');
  });
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

describe('formatQueryResult', () => {
  it('reports "no agents matched" when matched is zero', () => {
    const text = formatQueryResult({
      total: 3,
      matched: 0,
      filters: { role: 'marketer', keyword: null, status: null, budget: null },
      week: '2026-W16',
      weekMonday: '2026-04-13',
      agents: [],
    });
    assert.ok(text.includes('Filters: role~"marketer"'));
    assert.ok(text.includes('Matched: 0 / 3'));
    assert.ok(text.includes('No agents matched'));
  });

  it('renders a table plus a Slugs list when agents matched', () => {
    const text = formatQueryResult({
      total: 3,
      matched: 2,
      filters: {
        role: 'marketer',
        keyword: null,
        status: ['active'],
        budget: null,
      },
      week: '2026-W16',
      weekMonday: '2026-04-13',
      agents: [
        {
          id: 'sam',
          name: 'sam',
          description: 'Content marketer',
          state: 'active',
          paused: false,
          missing: false,
          matchedOn: ['description'],
          weeklyPlan: {
            week: '2026-W16',
            approved: true,
            tasks: { total: 5, byStatus: { completed: 2, pending: 3 } },
          },
          budget: { weeklyTokenLimit: 100000, utilizationPct: 25 },
        },
        {
          id: 'ivy',
          name: 'ivy',
          description: 'Growth marketer',
          state: 'active',
          paused: false,
          missing: false,
          matchedOn: ['description'],
          weeklyPlan: { week: null, approved: false, tasks: { total: 0, byStatus: {} } },
          budget: { weeklyTokenLimit: 100000, utilizationPct: 0 },
        },
      ],
    });

    for (const h of ['Agent', 'Role', 'Status', 'Tasks', 'Matched on']) {
      assert.ok(text.includes(h), `expected header ${h}`);
    }
    assert.ok(text.includes('sam'));
    assert.ok(text.includes('ivy'));
    assert.ok(text.includes('Content marketer'));
    assert.ok(text.includes('role~"marketer"'));
    assert.ok(text.includes('status=active'));
    assert.ok(text.includes('Slugs:'));
    assert.ok(text.includes('- sam'));
    assert.ok(text.includes('- ivy'));
  });
});

describe('buildQueryRow', () => {
  it('renders the missing marker on orphaned agents', () => {
    const row = buildQueryRow({
      id: 'ghost',
      name: 'ghost',
      description: '',
      state: 'missing-subagent',
      paused: false,
      missing: true,
      matchedOn: [],
      weeklyPlan: { week: null, approved: false, tasks: { total: 0, byStatus: {} } },
      budget: { weeklyTokenLimit: 0, utilizationPct: 0 },
    });
    assert.ok(row.agent.includes('ghost'));
    assert.ok(row.agent.includes(MISSING_SUBAGENT_MARKER));
    assert.equal(row.status, 'MISSING');
  });
});

describe('buildQueryChoices', () => {
  it('appends a "No thanks" sentinel and includes status in the label', () => {
    const choices = buildQueryChoices({
      agents: [
        {
          id: 'sam',
          name: 'sam',
          description: 'Content marketer',
          state: 'active',
          missing: false,
          matchedOn: ['description'],
          weeklyPlan: { week: null, approved: false, tasks: { total: 0, byStatus: {} } },
          budget: { weeklyTokenLimit: 0, utilizationPct: 0 },
        },
      ],
    });
    assert.equal(choices.length, 2);
    assert.equal(choices[0].id, 'sam');
    assert.ok(choices[0].label.includes('Content marketer'));
    assert.ok(choices[0].label.includes('ACTIVE'));
    assert.equal(choices[1].id, null);
  });

  it('returns an empty array when the result is nullish', () => {
    assert.deepEqual(buildQueryChoices(null), []);
    assert.deepEqual(buildQueryChoices({}), []);
  });
});
