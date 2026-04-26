/**
 * Tests for plan-markdown-store.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CANONICAL_SECTIONS,
  PLAN_FILENAME,
  buildInitialPlan,
  buildPlanFromInterview,
  buildPlanFromLegacy,
  exists,
  migrateLegacyPlan,
  parsePlanMarkdownSections,
  planPath,
  readPlan,
  writePlan,
} from './plan-markdown-store.js';

interface TempAgentsDir {
  base: string;
  agentsDir: string;
}

async function tempAgentsDir(): Promise<TempAgentsDir> {
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
    // Cast through `unknown` so we can probe the runtime guard with
    // intentionally invalid inputs the type system would otherwise reject.
    assert.throws(() => planPath(null as unknown as string, 'slug'), /agentsDir is required/);
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
        // Cast through `unknown` so we can probe the runtime guard with
        // an intentionally non-string body.
        () => writePlan(agentsDir, 'a', { not: 'a string' } as unknown as string),
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

describe('plan-markdown-store — parsePlanMarkdownSections', () => {
  it('returns the empty shape on missing / blank input', () => {
    const empty = parsePlanMarkdownSections('');
    assert.equal(empty.heading, null);
    assert.equal(empty.preamble, '');
    assert.deepEqual(empty.sections, []);
    assert.deepEqual(empty.byTitle, {});
    assert.deepEqual(parsePlanMarkdownSections(null), empty);
    assert.deepEqual(parsePlanMarkdownSections(undefined), empty);
  });

  it('captures the H1 heading, optional preamble, and H2 sections in order', () => {
    const body = [
      '# Writer bot',
      '',
      'Ships a weekly blog post.',
      '',
      '## Long-term goals',
      '- 1y: 50 posts',
      '',
      '## Strategies',
      'Prefer draft over polish.',
    ].join('\n');
    const parsed = parsePlanMarkdownSections(body);
    assert.equal(parsed.heading, 'Writer bot');
    assert.equal(parsed.preamble, 'Ships a weekly blog post.');
    assert.deepEqual(parsed.sections.map((s) => s.title), [
      'Long-term goals',
      'Strategies',
    ]);
    assert.equal(parsed.byTitle['Long-term goals'], '- 1y: 50 posts');
    assert.equal(parsed.byTitle['Strategies'], 'Prefer draft over polish.');
  });

  it('preserves subsection content (### ...) inside its parent H2', () => {
    const body = [
      '# Agent',
      '## Monthly plans',
      '### 2026-04',
      '- Ship the newsletter',
      '### 2026-05',
      '- Start a podcast',
    ].join('\n');
    const parsed = parsePlanMarkdownSections(body);
    const monthly = parsed.byTitle['Monthly plans'] ?? '';
    assert.ok(monthly.includes('### 2026-04'));
    assert.ok(monthly.includes('### 2026-05'));
    assert.ok(monthly.includes('Start a podcast'));
  });

  it('treats a heading-less markdown body as preamble only', () => {
    const body = 'Just some prose, no headings at all.';
    const parsed = parsePlanMarkdownSections(body);
    assert.equal(parsed.heading, null);
    assert.equal(parsed.preamble, body);
    assert.deepEqual(parsed.sections, []);
  });

  it('exposes the canonical section list the template emits', () => {
    assert.ok(Array.isArray(CANONICAL_SECTIONS));
    assert.ok(CANONICAL_SECTIONS.includes('Long-term goals'));
    assert.ok(CANONICAL_SECTIONS.includes('Monthly plans'));
    assert.ok(CANONICAL_SECTIONS.includes('Strategies'));
    assert.ok(CANONICAL_SECTIONS.includes('Notes'));
  });
});

describe('plan-markdown-store — buildPlanFromLegacy', () => {
  it('renders goals as horizon-tagged bullets under Long-term goals', () => {
    const body = buildPlanFromLegacy({
      name: 'Writer',
      goals: [
        { id: 'g1', description: 'Publish weekly', horizon: '3mo', status: 'active' },
        { id: 'g2', description: 'Retire ads',     horizon: '1yr', status: 'paused' },
      ],
    });
    const parsed = parsePlanMarkdownSections(body);
    const longTerm = parsed.byTitle['Long-term goals'] ?? '';
    assert.ok(longTerm.includes('(3mo) Publish weekly'));
    // Paused status gets an explicit tag.
    assert.ok(longTerm.includes('(1yr) Retire ads [paused]'));
  });

  it('emits ### YYYY-MM subsections and objective bullets under Monthly plans', () => {
    const body = buildPlanFromLegacy({
      name: 'Writer',
      monthlyPlans: [
        {
          month: '2026-04',
          objectives: [
            { id: 'o1', description: 'Ship 4 posts' },
            { id: 'o2', description: 'Start podcast', status: 'in-progress' },
          ],
        },
      ],
    });
    const parsed = parsePlanMarkdownSections(body);
    const monthly = parsed.byTitle['Monthly plans'] ?? '';
    assert.ok(monthly.includes('### 2026-04'));
    assert.ok(monthly.includes('- Ship 4 posts'));
    assert.ok(monthly.includes('- Start podcast [in-progress]'));
  });

  it('leaves placeholder comments when no legacy data was passed', () => {
    const body = buildPlanFromLegacy();
    assert.ok(body.includes('No long-term goals recorded'));
    assert.ok(body.includes('No monthly plans yet'));
  });
});

describe('plan-markdown-store — migrateLegacyPlan', () => {
  it('writes plan.md from legacy fields when the file is missing', async () => {
    const { base, agentsDir } = await tempAgentsDir();
    try {
      const result = await migrateLegacyPlan({
        agentsDir,
        agentId: 'writer',
        config: {
          identity: { name: 'Writer' },
          goals: [{ description: 'Publish weekly', horizon: '3mo', status: 'active' }],
          monthlyPlans: [],
        },
      });
      assert.equal(result.outcome, 'migrated');
      const body = await readPlan(agentsDir, 'writer');
      assert.ok(body);
      assert.ok(body.includes('Publish weekly'));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('skips when plan.md already exists', async () => {
    const { base, agentsDir } = await tempAgentsDir();
    try {
      await writePlan(agentsDir, 'writer', '# Existing\n');
      const result = await migrateLegacyPlan({
        agentsDir,
        agentId: 'writer',
        config: { goals: [{ description: 'x', horizon: '3mo' }] },
      });
      assert.equal(result.outcome, 'skipped');
      assert.match(result.reason ?? '', /already exists/);
      // Untouched.
      assert.equal(await readPlan(agentsDir, 'writer'), '# Existing\n');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('skips with a no-legacy-data reason when goals and monthlyPlans are empty', async () => {
    const { base, agentsDir } = await tempAgentsDir();
    try {
      const result = await migrateLegacyPlan({
        agentsDir,
        agentId: 'writer',
        config: { goals: [], monthlyPlans: [] },
      });
      assert.equal(result.outcome, 'skipped');
      assert.match(result.reason ?? '', /no legacy/);
      assert.equal(await exists(agentsDir, 'writer'), false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('plan-markdown-store — buildPlanFromInterview', () => {
  it('renders each interview answer under its canonical H2', () => {
    const body = buildPlanFromInterview({
      name: 'Writer bot',
      description: 'Writes blog posts.',
      longTermGoals: '- 1yr: 50 posts\n- 3mo: launch newsletter',
      monthlyPlans: '### 2026-04\n- Ship 4 posts',
      strategies: '- Prefer draft over polish.',
      notes: 'Voice: plain, direct.',
    });
    assert.match(body, /^# Writer bot/);
    assert.ok(body.includes('Writes blog posts.'));
    const parsed = parsePlanMarkdownSections(body);
    assert.match(parsed.byTitle['Long-term goals'] ?? '', /50 posts/);
    assert.match(parsed.byTitle['Monthly plans'] ?? '', /### 2026-04/);
    assert.match(parsed.byTitle['Strategies'] ?? '', /draft over polish/);
    assert.match(parsed.byTitle['Notes'] ?? '', /plain, direct/);
  });

  it('falls back to placeholder comments for empty / missing answers', () => {
    const body = buildPlanFromInterview({ name: 'Writer bot' });
    const parsed = parsePlanMarkdownSections(body);
    // Every canonical section exists even without answers.
    for (const title of CANONICAL_SECTIONS) {
      assert.ok(title in parsed.byTitle, `missing section ${title}`);
      assert.match(parsed.byTitle[title] ?? '', /^<!--/);
    }
  });

  it('trims whitespace in supplied answers', () => {
    const body = buildPlanFromInterview({
      name: 'A',
      longTermGoals: '   \n\nHit the 1yr goal.\n\n   ',
    });
    const parsed = parsePlanMarkdownSections(body);
    assert.equal(parsed.byTitle['Long-term goals'], 'Hit the 1yr goal.');
  });
});
