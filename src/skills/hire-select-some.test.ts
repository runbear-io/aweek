/**
 * Tests for `hire-select-some.js` — the multi-select handler that powers
 * the `/aweek:init` four-option menu's "Select some" branch.
 *
 * Coverage
 * --------
 *   - `buildSelectSomeChoices` builds one entry per unhired slug, pulling
 *     the `label` + `description` from the live `.md` frontmatter when
 *     available.
 *   - The builder falls back to a generic description when frontmatter is
 *     missing or has no `description`.
 *   - The builder flags entries whose `.md` file is missing and never
 *     throws (degrades gracefully).
 *   - The builder accepts an injected identity reader (test hook) so it
 *     can be exercised without filesystem access.
 *   - The builder defensively copies the slug list so callers can mutate
 *     the returned payload without leaking into the menu state.
 *   - The builder returns `multiSelect: true` by default and honors a
 *     `multiSelect: false` override.
 *   - `runSelectSomeHire` validates the selection against the menu's
 *     unhired list before delegating to `hireAllSubagents`.
 *   - Validation failures (empty, unknown slug, duplicate, non-string)
 *     surface in `result.validation.errors` and `result.hire` is `null`.
 *   - Valid selections wrap every slug via `hireAllSubagents` and return
 *     the nested hire result under `result.hire`.
 *   - Per-slug failures at the hire-all layer (missing .md) surface
 *     through `result.hire.failed` and flip `result.success` to false.
 *   - Per-slug skips (already-hired) do NOT flip `result.success` off.
 *   - An injected `hireFn` is called with the validated slugs and
 *     forwarded options.
 *   - `formatSelectSomeResult` distinguishes validation failures from
 *     hire failures and delegates to `formatHireAllSummary` on success.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_SELECT_SOME_PROMPT_TEXT,
  buildSelectSomeChoices,
  defaultChoiceDescription,
  runSelectSomeHire,
  formatSelectSomeResult,
} from './hire-select-some.js';
import { buildInitHireMenu } from './setup-hire-menu.js';
import { writeSubagentFile } from '../subagents/subagent-file.js';
import { AgentStore } from '../storage/agent-store.js';
import { createAgentConfig } from '../models/agent.js';

describe('hire-select-some — buildSelectSomeChoices (injected identity reader)', () => {
  it('builds one choice entry per unhired slug', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer', 'analyst'],
    });
    const payload = await buildSelectSomeChoices(menu, {
      readIdentityFn: async (slug) => ({
        missing: false,
        name: slug === 'writer' ? 'Writer' : 'Analyst',
        description: `${slug} desc`,
        path: `/tmp/${slug}.md`,
      }),
    });

    assert.equal(payload.multiSelect, true);
    assert.equal(payload.promptText, DEFAULT_SELECT_SOME_PROMPT_TEXT);
    assert.deepEqual(payload.slugs, ['writer', 'analyst']);
    assert.equal(payload.choices.length, 2);

    const byValue = Object.fromEntries(payload.choices.map((c) => [c.value, c]));
    assert.equal(byValue.writer.label, 'Writer');
    assert.equal(byValue.writer.description, 'writer desc');
    assert.equal(byValue.writer.missing, false);
    assert.equal(byValue.analyst.label, 'Analyst');
    assert.equal(byValue.analyst.description, 'analyst desc');
  });

  it('uses the slug as the label when frontmatter has no name', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['nameless'],
    });
    const payload = await buildSelectSomeChoices(menu, {
      readIdentityFn: async () => ({
        missing: false,
        name: '',
        description: 'only has a description',
        path: '/tmp/nameless.md',
      }),
    });
    assert.equal(payload.choices[0].label, 'nameless');
    assert.equal(payload.choices[0].description, 'only has a description');
  });

  it('falls back to the generic description when frontmatter has none', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    const payload = await buildSelectSomeChoices(menu, {
      readIdentityFn: async () => ({
        missing: false,
        name: 'Writer',
        description: '',
        path: '/tmp/writer.md',
      }),
    });
    assert.equal(payload.choices[0].label, 'Writer');
    assert.equal(
      payload.choices[0].description,
      defaultChoiceDescription('writer'),
    );
    assert.match(payload.choices[0].description, /aweek scheduling JSON/);
  });

  it('flags entries whose .md is missing without throwing', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['ghost'],
    });
    const payload = await buildSelectSomeChoices(menu, {
      readIdentityFn: async () => ({
        missing: true,
        name: '',
        description: '',
        path: '/tmp/ghost.md',
      }),
    });
    assert.equal(payload.choices.length, 1);
    assert.equal(payload.choices[0].value, 'ghost');
    assert.equal(payload.choices[0].missing, true);
    // Falls back to slug label and generic description.
    assert.equal(payload.choices[0].label, 'ghost');
    assert.equal(payload.choices[0].description, defaultChoiceDescription('ghost'));
  });

  it('degrades gracefully when the identity reader throws', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['boom'],
    });
    const payload = await buildSelectSomeChoices(menu, {
      readIdentityFn: async () => {
        throw new Error('simulated read failure');
      },
    });
    // No throw; the choice is still present with fallbacks.
    assert.equal(payload.choices.length, 1);
    assert.equal(payload.choices[0].value, 'boom');
    assert.equal(payload.choices[0].missing, true);
    assert.equal(payload.choices[0].label, 'boom');
  });

  it('defensively copies the slug list', async () => {
    const unhired = ['writer'];
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => unhired,
    });
    const payload = await buildSelectSomeChoices(menu, {
      readIdentityFn: async () => ({
        missing: false,
        name: 'Writer',
        description: 'W',
        path: '/tmp/writer.md',
      }),
    });
    payload.slugs.push('injected');
    // The original menu.unhired is not mutated.
    assert.deepEqual(menu.unhired, ['writer']);
  });

  it('honors a custom promptText override', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    const payload = await buildSelectSomeChoices(menu, {
      promptText: 'CUSTOM PROMPT',
      readIdentityFn: async () => ({
        missing: false,
        name: 'Writer',
        description: 'W',
        path: '',
      }),
    });
    assert.equal(payload.promptText, 'CUSTOM PROMPT');
  });

  it('honors multiSelect: false override', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    const payload = await buildSelectSomeChoices(menu, {
      multiSelect: false,
      readIdentityFn: async () => ({
        missing: false,
        name: 'Writer',
        description: 'W',
        path: '',
      }),
    });
    assert.equal(payload.multiSelect, false);
  });

  it('returns an empty choice list when no unhired subagents are available', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => [],
    });
    const payload = await buildSelectSomeChoices(menu);
    assert.deepEqual(payload.slugs, []);
    assert.deepEqual(payload.choices, []);
  });

  it('tolerates a null/undefined menu without throwing', async () => {
    const payload = await buildSelectSomeChoices(null);
    assert.deepEqual(payload.slugs, []);
    assert.deepEqual(payload.choices, []);
  });
});

describe('hire-select-some — buildSelectSomeChoices (real filesystem round-trip)', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-hire-select-some-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reads the live frontmatter description from each .md on disk', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writes things for the company',
      systemPrompt: 'You are a writer.',
      projectDir: tmpDir,
    });
    await writeSubagentFile({
      slug: 'analyst',
      description: 'Analyses product metrics',
      systemPrompt: 'You analyse.',
      projectDir: tmpDir,
    });

    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer', 'analyst'],
    });
    const payload = await buildSelectSomeChoices(menu, { projectDir: tmpDir });

    const byValue = Object.fromEntries(payload.choices.map((c) => [c.value, c]));
    // `name` frontmatter is the slug (auto-emitted by writeSubagentFile), so
    // label falls back to the slug string.
    assert.equal(byValue.writer.description, 'Writes things for the company');
    assert.equal(byValue.writer.missing, false);
    assert.match(byValue.writer.path, /writer\.md$/);
    assert.equal(byValue.analyst.description, 'Analyses product metrics');
  });

  it('flags a slug whose .md is absent', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['ghost'],
    });
    const payload = await buildSelectSomeChoices(menu, { projectDir: tmpDir });
    assert.equal(payload.choices[0].missing, true);
    // Still falls back to a generic description so the picker is readable.
    assert.equal(
      payload.choices[0].description,
      defaultChoiceDescription('ghost'),
    );
  });
});

describe('hire-select-some — runSelectSomeHire', () => {
  let tmpProject;
  let dataDir;

  beforeEach(async () => {
    tmpProject = await mkdtemp(join(tmpdir(), 'aweek-run-select-some-'));
    dataDir = join(tmpProject, '.aweek', 'agents');
  });

  afterEach(async () => {
    await rm(tmpProject, { recursive: true, force: true });
  });

  it('wraps every selected slug via hireAllSubagents', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write.',
      projectDir: tmpProject,
    });
    await writeSubagentFile({
      slug: 'analyst',
      description: 'Analyst',
      systemPrompt: 'Analyse.',
      projectDir: tmpProject,
    });
    await writeSubagentFile({
      slug: 'researcher',
      description: 'Researcher',
      systemPrompt: 'Research.',
      projectDir: tmpProject,
    });

    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer', 'analyst', 'researcher'],
    });

    const result = await runSelectSomeHire({
      menu,
      selected: ['writer', 'researcher'],
      projectDir: tmpProject,
      dataDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.validation.valid, true);
    assert.deepEqual(result.hire.created.sort(), ['researcher', 'writer']);
    assert.deepEqual(result.hire.failed, []);

    // Non-selected slug MUST NOT be wrapped.
    const store = new AgentStore(dataDir);
    assert.equal(await store.exists('analyst'), false);
    assert.equal(await store.exists('writer'), true);
    assert.equal(await store.exists('researcher'), true);
  });

  it('returns a validation error when `selected` is empty', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });

    const result = await runSelectSomeHire({
      menu,
      selected: [],
      projectDir: tmpProject,
      dataDir,
    });

    assert.equal(result.success, false);
    assert.equal(result.validation.valid, false);
    assert.match(
      result.validation.errors.join(' '),
      /at least one subagent slug/i,
    );
    // No hire was attempted.
    assert.equal(result.hire, null);
  });

  it('returns a validation error when a slug is not in the unhired list', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write.',
      projectDir: tmpProject,
    });
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });

    const result = await runSelectSomeHire({
      menu,
      selected: ['writer', 'ghost'],
      projectDir: tmpProject,
      dataDir,
    });

    assert.equal(result.success, false);
    assert.equal(result.validation.valid, false);
    assert.match(
      result.validation.errors.join(' '),
      /"ghost" is not in the unhired list/i,
    );
    assert.equal(result.hire, null);
    // Defense in depth: nothing was wrapped even though `writer` was valid.
    const store = new AgentStore(dataDir);
    assert.equal(await store.exists('writer'), false);
  });

  it('returns a validation error when the selection has duplicates', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    const result = await runSelectSomeHire({
      menu,
      selected: ['writer', 'writer'],
      projectDir: tmpProject,
      dataDir,
    });
    assert.equal(result.validation.valid, false);
    assert.match(result.validation.errors.join(' '), /duplicate slug "writer"/i);
    assert.equal(result.hire, null);
  });

  it('forwards weeklyTokenLimit to hireAllSubagents', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write.',
      projectDir: tmpProject,
    });
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    const customLimit = 321_000;
    const result = await runSelectSomeHire({
      menu,
      selected: ['writer'],
      weeklyTokenLimit: customLimit,
      projectDir: tmpProject,
      dataDir,
    });

    assert.equal(result.success, true);
    const store = new AgentStore(dataDir);
    const loaded = await store.load('writer');
    assert.equal(loaded.budget.weeklyTokenLimit, customLimit);
  });

  it('flips success off when a per-slug failure surfaces through hire-all', async () => {
    // One slug is on disk, one is not.
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write.',
      projectDir: tmpProject,
    });
    // Menu was built from a stale snapshot that still listed `ghost` — the
    // .md was deleted before the user answered the multi-select. Validation
    // passes (slug is in the unhired list) but hire-all flags it as failed.
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer', 'ghost'],
    });

    const result = await runSelectSomeHire({
      menu,
      selected: ['writer', 'ghost'],
      projectDir: tmpProject,
      dataDir,
    });

    assert.equal(result.validation.valid, true);
    assert.equal(result.success, false);
    assert.deepEqual(result.hire.created, ['writer']);
    assert.equal(result.hire.failed.length, 1);
    assert.equal(result.hire.failed[0].slug, 'ghost');
  });

  it('keeps success=true when the only non-create outcomes are skips', async () => {
    // Pre-hire the slug so hire-all sees an existing wrapper and marks it
    // as skipped (not failed).
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write.',
      projectDir: tmpProject,
    });
    const store = new AgentStore(dataDir);
    await store.save(createAgentConfig({ subagentRef: 'writer' }));

    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });

    const result = await runSelectSomeHire({
      menu,
      selected: ['writer'],
      projectDir: tmpProject,
      dataDir,
    });
    // Skipped slug is a legal outcome; success stays true.
    assert.equal(result.success, true);
    assert.deepEqual(result.hire.created, []);
    assert.equal(result.hire.skipped.length, 1);
  });

  it('accepts an injected hireFn (test hook)', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer', 'analyst'],
    });
    let capturedArgs = null;
    const fakeHire = async (args) => {
      capturedArgs = args;
      return { success: true, created: args.slugs, skipped: [], failed: [] };
    };

    const result = await runSelectSomeHire({
      menu,
      selected: ['writer', 'analyst'],
      projectDir: '/fake',
      dataDir: '/fake/.aweek',
      weeklyTokenLimit: 42,
      hireFn: fakeHire,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.hire.created, ['writer', 'analyst']);
    // Forwarded args match what the caller passed.
    assert.deepEqual(capturedArgs.slugs, ['writer', 'analyst']);
    assert.equal(capturedArgs.projectDir, '/fake');
    assert.equal(capturedArgs.dataDir, '/fake/.aweek');
    assert.equal(capturedArgs.weeklyTokenLimit, 42);
  });

  it('rejects non-string slug entries via validation (no throw)', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    const result = await runSelectSomeHire({
      menu,
      selected: ['writer', null],
      projectDir: '/fake',
    });
    assert.equal(result.validation.valid, false);
    assert.equal(result.hire, null);
  });
});

describe('hire-select-some — formatSelectSomeResult', () => {
  it('renders a "Selection rejected" block on validation failure', () => {
    const text = formatSelectSomeResult({
      success: false,
      validation: {
        valid: false,
        errors: ['Slug "ghost" is not in the unhired list for this menu; available: writer.'],
      },
      hire: null,
    });
    assert.match(text, /Selection rejected/);
    assert.match(text, /! Slug "ghost" is not in the unhired list/);
  });

  it('delegates to formatHireAllSummary on a valid selection', () => {
    const text = formatSelectSomeResult({
      success: true,
      validation: { valid: true, errors: [] },
      hire: {
        success: true,
        created: ['writer', 'analyst'],
        skipped: [],
        failed: [],
      },
    });
    assert.match(text, /Created 2 aweek JSON wrappers/);
    assert.match(text, /\+ writer/);
    assert.match(text, /\+ analyst/);
  });

  it('returns an empty string on null / undefined', () => {
    assert.equal(formatSelectSomeResult(null), '');
    assert.equal(formatSelectSomeResult(undefined), '');
  });

  it('surfaces a per-slug failure block from the nested hire result', () => {
    const text = formatSelectSomeResult({
      success: false,
      validation: { valid: true, errors: [] },
      hire: {
        success: false,
        created: ['writer'],
        skipped: [],
        failed: [{ slug: 'ghost', errors: ['.claude/agents/ghost.md not found'] }],
      },
    });
    // Both the created and failed sections land in the output.
    assert.match(text, /Created 1 aweek JSON wrapper/);
    assert.match(text, /Failed 1/);
    assert.match(text, /! ghost:.*not found/);
  });
});

describe('hire-select-some — constants', () => {
  it('DEFAULT_SELECT_SOME_PROMPT_TEXT is non-empty and mentions selection', () => {
    assert.equal(typeof DEFAULT_SELECT_SOME_PROMPT_TEXT, 'string');
    assert.ok(DEFAULT_SELECT_SOME_PROMPT_TEXT.length > 0);
    assert.match(DEFAULT_SELECT_SOME_PROMPT_TEXT, /select|pick/i);
  });

  it('defaultChoiceDescription returns a slug-specific fallback', () => {
    const text = defaultChoiceDescription('writer');
    assert.match(text, /writer\.md/);
    assert.match(text, /aweek scheduling JSON/);
  });
});
