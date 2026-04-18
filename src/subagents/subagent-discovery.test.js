/**
 * Tests for `subagent-discovery.js` — the combined project + user scope
 * scanner used by the `/aweek:hire` wizard when offering existing subagents
 * to wrap.
 *
 * Coverage targets:
 *   - `resolveUserSubagentsDir` / `userSubagentFilePath` compute paths under
 *     the supplied `userHome` override (so tests never touch `$HOME`).
 *   - `listUserSubagentSlugs` mirrors the project-scope scanner: alphabetical
 *     sort, invalid/non-.md filtering, missing-dir tolerance.
 *   - `discoverSubagents` merges both scopes with project-wins-on-collision
 *     semantics and applies the hired/plugin filters per the v1 constraints.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  USER_SUBAGENT_SCOPE,
  PROJECT_SUBAGENT_SCOPE,
  resolveUserSubagentsDir,
  userSubagentFilePath,
  listUserSubagentSlugs,
  discoverSubagents,
} from './subagent-discovery.js';
import { writeSubagentFile } from './subagent-file.js';
import { AgentStore } from '../storage/agent-store.js';
import { createAgentConfig } from '../models/agent.js';

/**
 * Write a user-level subagent .md file under `<userHome>/.claude/agents/`.
 * Mirrors `writeSubagentFile` but targets the user scope, which has no
 * public helper (aweek never writes to user-level at runtime — this is a
 * test fixture only).
 */
async function writeUserSubagent(userHome, slug, description = 'Test') {
  const dir = join(userHome, '.claude', 'agents');
  await mkdir(dir, { recursive: true });
  const body = `---\nname: ${slug}\ndescription: ${description}\n---\n\nHi.\n`;
  await writeFile(join(dir, `${slug}.md`), body, 'utf8');
}

/**
 * Write a hired aweek JSON for `slug` under `<projectDir>/.aweek/agents/`.
 * Uses the minimum viable schema-valid config shape.
 */
async function writeHiredAgent(projectDir, slug) {
  const config = createAgentConfig({
    subagentRef: slug,
    weeklyTokenLimit: 500000,
  });
  const store = new AgentStore(join(projectDir, '.aweek', 'agents'));
  await store.save(config);
  return config;
}

describe('subagent-discovery — resolveUserSubagentsDir + userSubagentFilePath', () => {
  it('composes <userHome>/.claude/agents when userHome is supplied', () => {
    const dir = resolveUserSubagentsDir({ userHome: '/tmp/fake-home' });
    assert.equal(dir, '/tmp/fake-home/.claude/agents');
  });

  it('composes the .md file path from slug + userHome', () => {
    const path = userSubagentFilePath('writer', { userHome: '/tmp/fake-home' });
    assert.equal(path, '/tmp/fake-home/.claude/agents/writer.md');
  });

  it('falls back to os.homedir() when no userHome is supplied', () => {
    // We don't assert the exact path (it's machine-dependent) but it must be
    // absolute and end with `.claude/agents`.
    const dir = resolveUserSubagentsDir();
    assert.ok(dir.startsWith('/') || /^[A-Za-z]:/.test(dir), 'dir should be absolute');
    assert.ok(
      dir.endsWith('/.claude/agents') || dir.endsWith('\\.claude\\agents'),
      'dir should end with .claude/agents',
    );
  });
});

describe('subagent-discovery — listUserSubagentSlugs', () => {
  let userHome;

  before(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'aweek-subagent-discovery-user-'));
  });

  after(async () => {
    await rm(userHome, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(join(userHome, '.claude'), { recursive: true, force: true });
  });

  it('returns an empty array when ~/.claude/agents does not exist', async () => {
    const slugs = await listUserSubagentSlugs({ userHome });
    assert.deepEqual(slugs, []);
  });

  it('returns well-formed slugs sorted alphabetically', async () => {
    await writeUserSubagent(userHome, 'writer');
    await writeUserSubagent(userHome, 'analyst');
    await writeUserSubagent(userHome, 'researcher');

    const slugs = await listUserSubagentSlugs({ userHome });
    assert.deepEqual(slugs, ['analyst', 'researcher', 'writer']);
  });

  it('ignores non-.md files and files with invalid slug basenames', async () => {
    const dir = join(userHome, '.claude', 'agents');
    await mkdir(dir, { recursive: true });

    await writeUserSubagent(userHome, 'valid-one');

    await writeFile(join(dir, 'README'), 'not a subagent', 'utf8');
    await writeFile(join(dir, 'notes.txt'), 'nope', 'utf8');
    await writeFile(join(dir, 'Draft Copy.md'), '---\nname: x\n---\n', 'utf8');
    await writeFile(join(dir, 'BAD-CAPS.md'), '---\nname: x\n---\n', 'utf8');

    const slugs = await listUserSubagentSlugs({ userHome });
    assert.deepEqual(slugs, ['valid-one']);
  });
});

describe('subagent-discovery — discoverSubagents', () => {
  let projectDir;
  let userHome;

  before(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'aweek-subagent-discovery-proj-'));
    userHome = await mkdtemp(join(tmpdir(), 'aweek-subagent-discovery-home-'));
  });

  after(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(userHome, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(join(projectDir, '.claude'), { recursive: true, force: true });
    await rm(join(projectDir, '.aweek'), { recursive: true, force: true });
    await rm(join(userHome, '.claude'), { recursive: true, force: true });
  });

  it('returns an empty array when both scopes are empty', async () => {
    const out = await discoverSubagents({
      projectDir,
      userHome,
      dataDir: join(projectDir, '.aweek', 'agents'),
    });
    assert.deepEqual(out, []);
  });

  it('returns project-scope entries with scope="project"', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Project writer',
      systemPrompt: 'Hi.',
      projectDir,
    });

    const out = await discoverSubagents({
      projectDir,
      userHome,
      dataDir: join(projectDir, '.aweek', 'agents'),
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].slug, 'writer');
    assert.equal(out[0].scope, PROJECT_SUBAGENT_SCOPE);
    assert.equal(out[0].hired, false);
    assert.ok(out[0].path.endsWith('/.claude/agents/writer.md'));
  });

  it('returns user-scope entries with scope="user"', async () => {
    await writeUserSubagent(userHome, 'researcher');

    const out = await discoverSubagents({
      projectDir,
      userHome,
      dataDir: join(projectDir, '.aweek', 'agents'),
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].slug, 'researcher');
    assert.equal(out[0].scope, USER_SUBAGENT_SCOPE);
    assert.equal(out[0].hired, false);
    assert.ok(out[0].path.startsWith(userHome));
  });

  it('merges project + user scopes, sorted alphabetically', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'W',
      systemPrompt: 'Hi.',
      projectDir,
    });
    await writeUserSubagent(userHome, 'analyst');
    await writeUserSubagent(userHome, 'researcher');

    const out = await discoverSubagents({
      projectDir,
      userHome,
      dataDir: join(projectDir, '.aweek', 'agents'),
    });
    assert.deepEqual(
      out.map((e) => [e.slug, e.scope]),
      [
        ['analyst', USER_SUBAGENT_SCOPE],
        ['researcher', USER_SUBAGENT_SCOPE],
        ['writer', PROJECT_SUBAGENT_SCOPE],
      ],
    );
  });

  it('project scope wins when the same slug exists in both scopes', async () => {
    // Claude Code resolves `--agent SLUG` in project-over-user order, so
    // discovery must surface the project entry (the one the heartbeat will
    // actually invoke) when slugs collide.
    await writeUserSubagent(userHome, 'writer', 'USER writer');
    await writeSubagentFile({
      slug: 'writer',
      description: 'PROJECT writer',
      systemPrompt: 'Hi.',
      projectDir,
    });

    const out = await discoverSubagents({
      projectDir,
      userHome,
      dataDir: join(projectDir, '.aweek', 'agents'),
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].slug, 'writer');
    assert.equal(out[0].scope, PROJECT_SUBAGENT_SCOPE);
    assert.ok(out[0].path.startsWith(projectDir));
  });

  it('filters out already-hired subagents by default', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'W',
      systemPrompt: 'Hi.',
      projectDir,
    });
    await writeUserSubagent(userHome, 'analyst');
    await writeUserSubagent(userHome, 'researcher');

    // Hire "writer" (project) and "analyst" (user) — both should drop out.
    await writeHiredAgent(projectDir, 'writer');
    await writeHiredAgent(projectDir, 'analyst');

    const out = await discoverSubagents({
      projectDir,
      userHome,
      dataDir: join(projectDir, '.aweek', 'agents'),
    });
    assert.deepEqual(
      out.map((e) => e.slug),
      ['researcher'],
    );
  });

  it('keeps hired subagents when includeHired: true and marks them hired=true', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'W',
      systemPrompt: 'Hi.',
      projectDir,
    });
    await writeUserSubagent(userHome, 'analyst');

    await writeHiredAgent(projectDir, 'writer');

    const out = await discoverSubagents({
      projectDir,
      userHome,
      dataDir: join(projectDir, '.aweek', 'agents'),
      includeHired: true,
    });
    const byslug = Object.fromEntries(out.map((e) => [e.slug, e]));
    assert.equal(byslug.writer.hired, true);
    assert.equal(byslug.analyst.hired, false);
  });

  it('filters out plugin-namespaced subagents by default', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'W',
      systemPrompt: 'Hi.',
      projectDir,
    });
    // Project copied a plugin subagent (against recommendation).
    await writeSubagentFile({
      slug: 'oh-my-claudecode-explore',
      description: 'Plugin',
      systemPrompt: 'Hi.',
      projectDir,
    });
    // User has a geo plugin subagent at user-scope.
    await writeUserSubagent(userHome, 'geo-audit');

    const out = await discoverSubagents({
      projectDir,
      userHome,
      dataDir: join(projectDir, '.aweek', 'agents'),
    });
    assert.deepEqual(
      out.map((e) => e.slug),
      ['writer'],
    );
  });

  it('keeps plugin-namespaced subagents when includePlugins: true', async () => {
    await writeUserSubagent(userHome, 'geo-audit');
    await writeSubagentFile({
      slug: 'oh-my-claudecode-explore',
      description: 'Plugin',
      systemPrompt: 'Hi.',
      projectDir,
    });

    const out = await discoverSubagents({
      projectDir,
      userHome,
      dataDir: join(projectDir, '.aweek', 'agents'),
      includePlugins: true,
    });
    assert.deepEqual(
      out.map((e) => e.slug),
      ['geo-audit', 'oh-my-claudecode-explore'],
    );
  });

  it('tolerates a missing aweek data directory (fresh project)', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'W',
      systemPrompt: 'Hi.',
      projectDir,
    });

    // No .aweek directory at all — listAllAgents should return [], and
    // discovery should not crash.
    const out = await discoverSubagents({
      projectDir,
      userHome,
      dataDir: join(projectDir, '.aweek', 'agents'),
    });
    assert.deepEqual(
      out.map((e) => e.slug),
      ['writer'],
    );
  });
});
