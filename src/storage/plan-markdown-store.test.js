/**
 * Tests for plan-markdown-store.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PLAN_FILENAME,
  buildInitialPlan,
  exists,
  planPath,
  readPlan,
  writePlan,
} from './plan-markdown-store.js';

async function tempAgentsDir() {
  const base = await mkdtemp(join(tmpdir(), 'aweek-plan-md-'));
  return { base, agentsDir: join(base, 'agents') };
}

describe('plan-markdown-store — path resolution', () => {
  it('planPath joins agentsDir/<agentId>/plan.md', async () => {
    const { base, agentsDir } = await tempAgentsDir();
    try {
      assert.equal(
        planPath(agentsDir, 'writer-bot'),
        join(agentsDir, 'writer-bot', PLAN_FILENAME),
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('planPath throws without the required args', () => {
    assert.throws(() => planPath(null, 'slug'), /agentsDir is required/);
    assert.throws(() => planPath('/tmp/agents', ''), /agentId is required/);
  });
});

describe('plan-markdown-store — read / write / exists', () => {
  it('returns null and false for a never-written plan', async () => {
    const { base, agentsDir } = await tempAgentsDir();
    try {
      assert.equal(await readPlan(agentsDir, 'nope'), null);
      assert.equal(await exists(agentsDir, 'nope'), false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('writePlan creates parent dirs, readPlan round-trips the body', async () => {
    const { base, agentsDir } = await tempAgentsDir();
    try {
      const body = '# Writer bot\n\n## Long-term goals\n- Ship the blog.\n';
      const { path, bytes } = await writePlan(agentsDir, 'writer-bot', body);
      assert.equal(path, planPath(agentsDir, 'writer-bot'));
      assert.ok(bytes > 0);
      assert.equal(await exists(agentsDir, 'writer-bot'), true);
      assert.equal(await readPlan(agentsDir, 'writer-bot'), body);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('writePlan appends a trailing newline when missing', async () => {
    const { base, agentsDir } = await tempAgentsDir();
    try {
      await writePlan(agentsDir, 'a', '# No trailing newline');
      const raw = await readFile(planPath(agentsDir, 'a'), 'utf8');
      assert.ok(raw.endsWith('\n'), 'expected trailing newline');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('writePlan rejects non-string bodies', async () => {
    const { base, agentsDir } = await tempAgentsDir();
    try {
      await assert.rejects(
        () => writePlan(agentsDir, 'a', { not: 'a string' }),
        /must be a string/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('plan-markdown-store — buildInitialPlan', () => {
  it('emits the expected H2 section skeleton', () => {
    const body = buildInitialPlan({ name: 'Writer bot' });
    assert.match(body, /^# Writer bot/);
    for (const section of ['Long-term goals', 'Monthly plans', 'Strategies', 'Notes']) {
      assert.ok(body.includes(`## ${section}`), `missing section ${section}`);
    }
  });

  it('inlines the description as a preamble', () => {
    const body = buildInitialPlan({ name: 'A', description: 'Writes blog posts.' });
    assert.ok(body.includes('Writes blog posts.'));
    // Preamble comes before the first H2.
    const firstH2 = body.indexOf('##');
    const preamble = body.indexOf('Writes blog posts.');
    assert.ok(preamble > 0 && preamble < firstH2, body);
  });

  it('defaults to "Agent" when no name is passed', () => {
    assert.match(buildInitialPlan(), /^# Agent/);
  });
});
