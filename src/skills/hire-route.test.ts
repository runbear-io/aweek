/**
 * Tests for `hire-route.js` — the initial branching logic that decides
 * whether the `/aweek:hire` wizard offers a two-option prompt (Pick existing
 * vs Create new) or forces the create-new path.
 *
 * These tests lock in:
 *   - scanning of `.claude/agents/*.md` for hireable slugs,
 *   - exclusion of plugin-namespaced slugs (oh-my-claudecode, geo) per the
 *     v1 constraint,
 *   - exclusion of already-hired slugs (ones with a matching `.aweek/agents/
 *     <slug>.json`),
 *   - the route decision: `choose` when ≥1 unhired subagent exists,
 *     `create-new` (with `forcedCreateNew: true`) when zero are available.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  PLUGIN_SUBAGENT_PREFIXES,
  isPluginSubagent,
  listProjectSubagentSlugs,
  listUnhiredSubagents,
  determineHireRoute,
} from './hire-route.js';
import { writeSubagentFile } from '../subagents/subagent-file.js';
import { AgentStore } from '../storage/agent-store.js';
import { createAgentConfig } from '../models/agent.js';

/**
 * Helper: write a hired aweek JSON for the given slug into `<tmp>/.aweek/agents`.
 * Uses the minimum viable config shape that passes schema validation.
 */
async function writeHiredAgent(tmpDir, slug) {
  const config = createAgentConfig({
    subagentRef: slug,
    weeklyTokenLimit: 500000,
  });
  const store = new AgentStore(join(tmpDir, '.aweek', 'agents'));
  await store.save(config);
  return config;
}

describe('hire-route — isPluginSubagent + PLUGIN_SUBAGENT_PREFIXES', () => {
  it('exposes the canonical plugin prefix set (oh-my-claudecode, geo)', () => {
    // Lock the v1 constraint: plugin subagents are excluded from hireable
    // lists. If a sibling plugin ships (e.g. a `figma` plugin) and we want
    // to exclude it, that's a conscious edit here, not a drive-by.
    assert.deepEqual([...PLUGIN_SUBAGENT_PREFIXES], ['oh-my-claudecode', 'geo']);
    assert.ok(Object.isFrozen(PLUGIN_SUBAGENT_PREFIXES));
  });

  it('matches exact plugin prefix slugs', () => {
    assert.equal(isPluginSubagent('oh-my-claudecode'), true);
    assert.equal(isPluginSubagent('geo'), true);
  });

  it('matches plugin-namespaced slugs via <prefix>- prefix form', () => {
    assert.equal(isPluginSubagent('oh-my-claudecode-explore'), true);
    assert.equal(isPluginSubagent('oh-my-claudecode-executor'), true);
    assert.equal(isPluginSubagent('geo-audit'), true);
    assert.equal(isPluginSubagent('geo-citability'), true);
  });

  it('does NOT match unrelated slugs that happen to contain a plugin token', () => {
    // `my-geo-notes` is NOT a plugin subagent — the prefix check must be
    // anchored at the start of the slug with a `-` separator to avoid
    // eating legitimate user slugs.
    assert.equal(isPluginSubagent('my-geo-notes'), false);
    assert.equal(isPluginSubagent('geography-bot'), false);
    assert.equal(isPluginSubagent('geolocation'), false);
    assert.equal(isPluginSubagent('oh-my-claudecode2'), false);
  });

  it('returns false for non-string or empty input', () => {
    assert.equal(isPluginSubagent(''), false);
    assert.equal(isPluginSubagent(null), false);
    assert.equal(isPluginSubagent(undefined), false);
    assert.equal(isPluginSubagent(42), false);
  });
});

describe('hire-route — listProjectSubagentSlugs', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-hire-route-scan-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(join(tmpDir, '.claude'), { recursive: true, force: true });
  });

  it('returns an empty array when .claude/agents does not exist', async () => {
    const slugs = await listProjectSubagentSlugs({ projectDir: tmpDir });
    assert.deepEqual(slugs, []);
  });

  it('returns well-formed slugs from .claude/agents/*.md, alphabetically', async () => {
    // Write three subagents in non-alphabetical order — result must come
    // back sorted so the wizard's selection prompt is deterministic.
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write things.',
      projectDir: tmpDir,
    });
    await writeSubagentFile({
      slug: 'analyst',
      description: 'Analyst',
      systemPrompt: 'Analyse things.',
      projectDir: tmpDir,
    });
    await writeSubagentFile({
      slug: 'researcher',
      description: 'Researcher',
      systemPrompt: 'Research things.',
      projectDir: tmpDir,
    });

    const slugs = await listProjectSubagentSlugs({ projectDir: tmpDir });
    assert.deepEqual(slugs, ['analyst', 'researcher', 'writer']);
  });

  it('ignores non-.md files and hand-named files whose basename is not a valid slug', async () => {
    const dir = join(tmpDir, '.claude', 'agents');
    await mkdir(dir, { recursive: true });

    // Valid subagent.
    await writeSubagentFile({
      slug: 'valid-one',
      description: 'Valid',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });

    // Noise the scanner should ignore without throwing.
    await writeFile(join(dir, 'README'), 'not a subagent', 'utf8');
    await writeFile(join(dir, 'notes.txt'), 'nope', 'utf8');
    await writeFile(join(dir, 'Draft Copy.md'), '---\nname: x\n---\n', 'utf8');
    await writeFile(join(dir, '_hidden.md'), '---\nname: x\n---\n', 'utf8');
    await writeFile(join(dir, 'BAD-CAPS.md'), '---\nname: x\n---\n', 'utf8');

    const slugs = await listProjectSubagentSlugs({ projectDir: tmpDir });
    assert.deepEqual(slugs, ['valid-one']);
  });
});

describe('hire-route — listUnhiredSubagents', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-hire-route-unhired-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(join(tmpDir, '.claude'), { recursive: true, force: true });
    await rm(join(tmpDir, '.aweek'), { recursive: true, force: true });
  });

  it('returns an empty array when no subagents exist on disk', async () => {
    const unhired = await listUnhiredSubagents({
      projectDir: tmpDir,
      dataDir: join(tmpDir, '.aweek', 'agents'),
    });
    assert.deepEqual(unhired, []);
  });

  it('returns every .md slug when nothing is hired yet', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });
    await writeSubagentFile({
      slug: 'analyst',
      description: 'Analyst',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });

    const unhired = await listUnhiredSubagents({
      projectDir: tmpDir,
      dataDir: join(tmpDir, '.aweek', 'agents'),
    });
    assert.deepEqual(unhired, ['analyst', 'writer']);
  });

  it('excludes slugs that already have a matching .aweek/agents/<slug>.json', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });
    await writeSubagentFile({
      slug: 'analyst',
      description: 'Analyst',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });
    await writeSubagentFile({
      slug: 'researcher',
      description: 'Researcher',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });

    // Hire "writer" by writing its scheduling JSON.
    await writeHiredAgent(tmpDir, 'writer');

    const unhired = await listUnhiredSubagents({
      projectDir: tmpDir,
      dataDir: join(tmpDir, '.aweek', 'agents'),
    });
    // `writer` is hired, so only `analyst` and `researcher` remain.
    assert.deepEqual(unhired, ['analyst', 'researcher']);
  });

  it('excludes plugin-namespaced slugs (oh-my-claudecode, geo) even if present', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });
    // Simulate a project that (against recommendation) copied a plugin
    // subagent file into .claude/agents/. The wizard must still hide it.
    await writeSubagentFile({
      slug: 'oh-my-claudecode-explore',
      description: 'Plugin subagent',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });
    await writeSubagentFile({
      slug: 'geo-audit',
      description: 'Plugin subagent',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });

    const unhired = await listUnhiredSubagents({
      projectDir: tmpDir,
      dataDir: join(tmpDir, '.aweek', 'agents'),
    });
    assert.deepEqual(unhired, ['writer']);
  });
});

describe('hire-route — determineHireRoute', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-hire-route-decide-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(join(tmpDir, '.claude'), { recursive: true, force: true });
    await rm(join(tmpDir, '.aweek'), { recursive: true, force: true });
  });

  it('forces create-new when no subagents exist on disk', async () => {
    const result = await determineHireRoute({
      projectDir: tmpDir,
      dataDir: join(tmpDir, '.aweek', 'agents'),
    });
    assert.equal(result.route, 'create-new');
    assert.equal(result.forcedCreateNew, true);
    assert.deepEqual(result.unhired, []);
  });

  it('forces create-new when every subagent is already hired', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });
    await writeHiredAgent(tmpDir, 'writer');

    const result = await determineHireRoute({
      projectDir: tmpDir,
      dataDir: join(tmpDir, '.aweek', 'agents'),
    });
    assert.equal(result.route, 'create-new');
    assert.equal(result.forcedCreateNew, true);
    assert.deepEqual(result.unhired, []);
  });

  it('forces create-new when the only available subagents are plugin-namespaced', async () => {
    // Plugin subagents are excluded from hireable lists; the wizard must
    // treat this as "nothing to pick" and force create-new.
    await writeSubagentFile({
      slug: 'oh-my-claudecode-explore',
      description: 'Plugin subagent',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });
    await writeSubagentFile({
      slug: 'geo-audit',
      description: 'Plugin subagent',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });

    const result = await determineHireRoute({
      projectDir: tmpDir,
      dataDir: join(tmpDir, '.aweek', 'agents'),
    });
    assert.equal(result.route, 'create-new');
    assert.equal(result.forcedCreateNew, true);
    assert.deepEqual(result.unhired, []);
  });

  it('offers the choose branch when at least one unhired subagent is available', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });
    await writeSubagentFile({
      slug: 'analyst',
      description: 'Analyst',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });

    const result = await determineHireRoute({
      projectDir: tmpDir,
      dataDir: join(tmpDir, '.aweek', 'agents'),
    });
    assert.equal(result.route, 'choose');
    assert.equal(result.forcedCreateNew, false);
    assert.deepEqual(result.unhired, ['analyst', 'writer']);
  });

  it('returns only the unhired slugs in the choose branch, sorted alphabetically', async () => {
    // Mixed scenario: three on disk, one already hired, one plugin. The
    // caller should only be offered the single remaining unhired slug.
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });
    await writeSubagentFile({
      slug: 'analyst',
      description: 'Analyst',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });
    await writeSubagentFile({
      slug: 'geo-audit',
      description: 'Plugin subagent',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });
    await writeHiredAgent(tmpDir, 'writer');

    const result = await determineHireRoute({
      projectDir: tmpDir,
      dataDir: join(tmpDir, '.aweek', 'agents'),
    });
    assert.equal(result.route, 'choose');
    assert.equal(result.forcedCreateNew, false);
    assert.deepEqual(result.unhired, ['analyst']);
  });
});
