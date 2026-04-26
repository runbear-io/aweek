/**
 * Tests for `hire-create-new-menu.ts` — the Sub-AC 3 of AC 50303 handler
 * that wires the `/aweek:init` four-option menu's **Create new** branch
 * into the `/aweek:hire` create-new flow.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CREATE_NEW_SKILL_NAME,
  CREATE_NEW_ROUTE_NAME,
  DEFAULT_CREATE_NEW_PROMPT_TEXT,
  buildCreateNewLaunchInstruction,
  runCreateNewHire,
  formatCreateNewResult,
} from './hire-create-new-menu.js';
import {
  DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT,
} from './hire-all.js';
import {
  subagentFilePath,
  subagentFileExists,
  writeSubagentFile,
} from '../subagents/subagent-file.js';
import { AgentStore } from '../storage/agent-store.js';

describe('hire-create-new-menu — constants', () => {
  it('exports a stable skill name of /aweek:hire', () => {
    assert.equal(CREATE_NEW_SKILL_NAME, '/aweek:hire');
  });

  it('exports a stable route name of create-new', () => {
    assert.equal(CREATE_NEW_ROUTE_NAME, 'create-new');
  });

  it('exports a non-empty default prompt text', () => {
    assert.equal(typeof DEFAULT_CREATE_NEW_PROMPT_TEXT, 'string');
    assert.ok(DEFAULT_CREATE_NEW_PROMPT_TEXT.length > 0);
    assert.match(DEFAULT_CREATE_NEW_PROMPT_TEXT, /\/aweek:hire/);
  });
});

describe('hire-create-new-menu — buildCreateNewLaunchInstruction', () => {
  it('returns a descriptor targeting /aweek:hire with route=create-new', () => {
    const instr = buildCreateNewLaunchInstruction({ projectDir: '/tmp/fake' });
    assert.equal(instr.skill, '/aweek:hire');
    assert.equal(instr.route, 'create-new');
    assert.equal(instr.projectDir, '/tmp/fake');
    assert.equal(instr.promptText, DEFAULT_CREATE_NEW_PROMPT_TEXT);
    assert.equal(typeof instr.reason, 'string');
    assert.ok(instr.reason.length > 0);
  });

  it('defaults projectDir to process.cwd() when not supplied', () => {
    const instr = buildCreateNewLaunchInstruction();
    assert.equal(instr.projectDir, process.cwd());
  });

  it('falls back to process.cwd() when projectDir is empty or non-string', () => {
    assert.equal(
      buildCreateNewLaunchInstruction({ projectDir: '' }).projectDir,
      process.cwd(),
    );
    assert.equal(
      buildCreateNewLaunchInstruction({ projectDir: null }).projectDir,
      process.cwd(),
    );
    assert.equal(
      buildCreateNewLaunchInstruction({ projectDir: 42 }).projectDir,
      process.cwd(),
    );
  });

  it('honors a custom promptText override', () => {
    const instr = buildCreateNewLaunchInstruction({
      projectDir: '/tmp/fake',
      promptText: 'CUSTOM',
    });
    assert.equal(instr.promptText, 'CUSTOM');
  });

  it('mentions the create-new delegation in the reason copy', () => {
    const { reason } = buildCreateNewLaunchInstruction();
    assert.match(reason, /create-new/i);
    assert.match(reason, /\/aweek:hire/);
  });
});

describe('hire-create-new-menu — runCreateNewHire (real filesystem)', () => {
  let tmpProject: string;
  let dataDir: string;

  beforeEach(async () => {
    tmpProject = await mkdtemp(join(tmpdir(), 'aweek-hire-create-new-menu-'));
    dataDir = join(tmpProject, '.aweek', 'agents');
  });

  afterEach(async () => {
    await rm(tmpProject, { recursive: true, force: true });
  });

  it('writes .md + aweek wrapper end-to-end on a fresh slug', async () => {
    const result = await runCreateNewHire({
      name: 'Content Writer',
      description: 'Writes weekly briefs',
      systemPrompt: 'You are a content writer.',
      projectDir: tmpProject,
      dataDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.validation.valid, true);
    assert.equal(result.validation.slug, 'content-writer');

    // Subagent .md landed.
    assert.ok(result.subagent && result.subagent.success);
    const subagent = result.subagent;
    if (!subagent.success) throw new Error('expected success');
    assert.equal(subagent.adopted, false);
    assert.equal(subagent.slug, 'content-writer');
    const mdPath = subagentFilePath('content-writer', tmpProject);
    assert.equal(subagent.path, mdPath);
    assert.equal(await subagentFileExists('content-writer', tmpProject), true);
    const md = await readFile(mdPath, 'utf8');
    assert.match(md, /name: content-writer/);
    assert.match(md, /description: Writes weekly briefs/);
    assert.match(md, /You are a content writer\./);

    // aweek JSON wrapper landed.
    assert.ok(result.hire, 'expected a hire result');
    assert.equal(result.hire!.success, true);
    assert.deepEqual(result.hire!.created, ['content-writer']);
    assert.deepEqual(result.hire!.skipped, []);
    assert.deepEqual(result.hire!.failed, []);

    const store = new AgentStore(dataDir);
    assert.equal(await store.exists('content-writer'), true);
    const agent = await store.load('content-writer');
    assert.equal(agent.id, 'content-writer');
    assert.equal(agent.subagentRef, 'content-writer');
    assert.equal(agent.budget?.weeklyTokenLimit, DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT);
    assert.deepEqual(agent.goals, []);
    assert.deepEqual(agent.monthlyPlans, []);
    // Weekly plans live in the per-week file store; agent JSON never
    // carries the field.
    assert.equal((agent as { weeklyPlans?: unknown }).weeklyPlans, undefined);
  });

  it('adopts an existing .md and still creates the aweek wrapper', async () => {
    // Pre-seed the subagent .md so the wizard collides on write.
    await writeSubagentFile({
      slug: 'content-writer',
      description: 'On-disk description',
      systemPrompt: 'On-disk system prompt.',
      projectDir: tmpProject,
    });

    const result = await runCreateNewHire({
      name: 'Content Writer',
      description: 'Typed description — should be discarded',
      systemPrompt: 'Typed prompt — should be discarded',
      projectDir: tmpProject,
      dataDir,
    });

    assert.equal(result.success, true);
    const subagent = result.subagent;
    if (!subagent || !subagent.success) throw new Error('expected success');
    assert.equal(subagent.adopted, true, 'expected adopt-on-collision');
    assert.equal(subagent.slug, 'content-writer');

    // The .md bytes the caller sees match on-disk content (typed fields discarded).
    const mdPath = subagentFilePath('content-writer', tmpProject);
    const diskContent = await readFile(mdPath, 'utf8');
    assert.equal(subagent.content, diskContent);
    assert.match(diskContent, /On-disk description/);
    assert.doesNotMatch(diskContent, /Typed description/);

    // aweek wrapper is still created — adoption does not short-circuit the shell.
    assert.equal(result.hire!.success, true);
    assert.deepEqual(result.hire!.created, ['content-writer']);
    const store = new AgentStore(dataDir);
    assert.equal(await store.exists('content-writer'), true);
  });

  it('is idempotent: re-running on an already-hired slug skips the wrapper cleanly', async () => {
    // First run — fresh create of both .md and JSON.
    const first = await runCreateNewHire({
      name: 'Content Writer',
      description: 'Writes weekly briefs',
      systemPrompt: 'You are a content writer.',
      projectDir: tmpProject,
      dataDir,
    });
    assert.equal(first.success, true);
    assert.deepEqual(first.hire!.created, ['content-writer']);

    // Second run on the same name — .md adopted, wrapper skipped.
    const second = await runCreateNewHire({
      name: 'Content Writer',
      description: 'different',
      systemPrompt: 'different',
      projectDir: tmpProject,
      dataDir,
    });
    assert.equal(second.success, true, 'already-hired is a valid idempotent no-op');
    if (!second.subagent || !second.subagent.success) throw new Error('expected success');
    assert.equal(second.subagent.adopted, true);
    assert.deepEqual(second.hire!.created, []);
    assert.equal(second.hire!.skipped.length, 1);
    assert.equal(second.hire!.skipped[0]!.slug, 'content-writer');
    assert.match(second.hire!.skipped[0]!.reason, /already exists/i);
  });

  it('propagates the weeklyTokenLimit override into the aweek shell', async () => {
    const result = await runCreateNewHire({
      name: 'Writer',
      description: 'd',
      systemPrompt: 'p',
      weeklyTokenLimit: 123_456,
      projectDir: tmpProject,
      dataDir,
    });
    assert.equal(result.success, true);
    const store = new AgentStore(dataDir);
    const agent = await store.load('writer');
    assert.equal(agent.budget?.weeklyTokenLimit, 123_456);
  });
});

describe('hire-create-new-menu — runCreateNewHire (pure logic with fakes)', () => {
  it('returns a validation failure and writes nothing when input is bad', async () => {
    let subagentCalls = 0;
    let hireCalls = 0;
    const result = await runCreateNewHire({
      name: '', // invalid
      description: '',
      systemPrompt: '',
      createNewSubagentFn: async () => {
        subagentCalls += 1;
        return { success: true, adopted: false, slug: '', path: '', content: '' };
      },
      hireFn: async () => {
        hireCalls += 1;
        return { success: true, created: [], skipped: [], failed: [] };
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.validation.valid, false);
    assert.ok(result.validation.errors.length > 0);
    assert.equal(result.subagent, null);
    assert.equal(result.hire, null);
    assert.equal(subagentCalls, 0, 'must not call createNewSubagent on bad input');
    assert.equal(hireCalls, 0, 'must not call hireAllSubagents on bad input');
  });

  it('returns subagent errors and SKIPS the hire delegate when .md write fails', async () => {
    let hireCalls = 0;
    const result = await runCreateNewHire({
      name: 'Writer',
      description: 'd',
      systemPrompt: 'p',
      createNewSubagentFn: async () => ({
        success: false,
        errors: ['filesystem blew up'],
        slug: 'writer',
      }),
      hireFn: async () => {
        hireCalls += 1;
        return { success: true, created: [], skipped: [], failed: [] };
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.subagent!.success, false);
    assert.deepEqual((result.subagent as { errors: string[] }).errors, ['filesystem blew up']);
    assert.equal(result.hire, null);
    assert.equal(hireCalls, 0, 'must not call hire delegate when .md failed');
  });

  it('flips top-level success to false when the hire delegate reports a failure', async () => {
    const result = await runCreateNewHire({
      name: 'Writer',
      description: 'd',
      systemPrompt: 'p',
      createNewSubagentFn: async () => ({
        success: true,
        adopted: false,
        slug: 'writer',
        path: '/tmp/fake/writer.md',
        content: 'stub',
      }),
      hireFn: async () => ({
        success: false,
        created: [],
        skipped: [],
        failed: [{ slug: 'writer', errors: ['schema error'] }],
      }),
    });

    assert.equal(result.success, false);
    assert.equal(result.subagent!.success, true, 'subagent step still succeeded');
    assert.equal(result.hire!.success, false);
    assert.deepEqual(result.hire!.failed, [{ slug: 'writer', errors: ['schema error'] }]);
  });

  it('forwards { slugs, weeklyTokenLimit, projectDir, dataDir, agentStore } to the hire delegate', async () => {
    const captured: Record<string, unknown> = {};
    const fakeStore = { __tag: 'fake-store' } as unknown as AgentStore;
    const result = await runCreateNewHire({
      name: 'Writer',
      description: 'd',
      systemPrompt: 'p',
      weeklyTokenLimit: 9999,
      projectDir: '/tmp/fake-project',
      dataDir: '/tmp/fake-data',
      agentStore: fakeStore,
      createNewSubagentFn: async () => ({
        success: true,
        adopted: false,
        slug: 'writer',
        path: '/tmp/fake/writer.md',
        content: 'stub',
      }),
      hireFn: async (args) => {
        Object.assign(captured, args);
        return { success: true, created: ['writer'], skipped: [], failed: [] };
      },
    });

    assert.equal(result.success, true);
    assert.deepEqual(captured.slugs, ['writer']);
    assert.equal(captured.weeklyTokenLimit, 9999);
    assert.equal(captured.projectDir, '/tmp/fake-project');
    assert.equal(captured.dataDir, '/tmp/fake-data');
    assert.equal(captured.agentStore, fakeStore);
  });

  it('handles a hire delegate that returns null/undefined without throwing', async () => {
    const result = await runCreateNewHire({
      name: 'Writer',
      description: 'd',
      systemPrompt: 'p',
      createNewSubagentFn: async () => ({
        success: true,
        adopted: false,
        slug: 'writer',
        path: '/tmp/fake/writer.md',
        content: 'stub',
      }),
      hireFn: async () => undefined,
    });
    assert.equal(result.success, false);
    assert.equal(result.subagent!.success, true);
    assert.equal(result.hire, undefined);
  });
});

describe('hire-create-new-menu — formatCreateNewResult', () => {
  it('returns an empty string for null/undefined input', () => {
    assert.equal(formatCreateNewResult(null), '');
    assert.equal(formatCreateNewResult(undefined), '');
  });

  it('renders a validation-error block when the input was rejected', () => {
    const out = formatCreateNewResult({
      success: false,
      validation: {
        valid: false,
        errors: ['Name is required', 'System prompt is required'],
        slug: '',
      },
      subagent: null,
      hire: null,
    });
    assert.match(out, /Input rejected/);
    assert.match(out, /Name is required/);
    assert.match(out, /System prompt is required/);
  });

  it('renders a subagent-error block when the .md write failed', () => {
    const out = formatCreateNewResult({
      success: false,
      validation: { valid: true, errors: [], slug: 'writer' },
      subagent: {
        success: false,
        errors: ['EACCES: write permission denied'],
        slug: 'writer',
      },
      hire: null,
    });
    assert.match(out, /Subagent file error/);
    assert.match(out, /EACCES: write permission denied/);
    // The hire summary must not leak into the subagent-error path.
    assert.doesNotMatch(out, /Created/);
  });

  it('renders the "Wrote" headline plus the hire-all summary on a fresh success', () => {
    const out = formatCreateNewResult({
      success: true,
      validation: { valid: true, errors: [], slug: 'writer' },
      subagent: {
        success: true,
        adopted: false,
        slug: 'writer',
        path: '/project/.claude/agents/writer.md',
        content: '...',
      },
      hire: {
        success: true,
        created: ['writer'],
        skipped: [],
        failed: [],
      },
    });
    assert.match(out, /Wrote subagent file: \/project\/\.claude\/agents\/writer\.md/);
    assert.match(out, /Created 1 aweek JSON wrapper/);
    assert.match(out, /\+ writer/);
  });

  it('renders the "Adopted" headline when the .md already existed', () => {
    const out = formatCreateNewResult({
      success: true,
      validation: { valid: true, errors: [], slug: 'writer' },
      subagent: {
        success: true,
        adopted: true,
        slug: 'writer',
        path: '/project/.claude/agents/writer.md',
        content: '...',
      },
      hire: {
        success: true,
        created: ['writer'],
        skipped: [],
        failed: [],
      },
    });
    assert.match(out, /Adopted existing subagent file: \/project\/\.claude\/agents\/writer\.md/);
  });

  it('surfaces skipped-because-already-hired via the nested hire-all summary', () => {
    const out = formatCreateNewResult({
      success: true,
      validation: { valid: true, errors: [], slug: 'writer' },
      subagent: {
        success: true,
        adopted: true,
        slug: 'writer',
        path: '/project/.claude/agents/writer.md',
        content: '...',
      },
      hire: {
        success: true,
        created: [],
        skipped: [{ slug: 'writer', reason: 'aweek JSON wrapper already exists — re-running hire-all on an already-hired slug is a no-op' }],
        failed: [],
      },
    });
    assert.match(out, /Adopted existing subagent file/);
    assert.match(out, /Skipped 1:/);
    assert.match(out, /writer — aweek JSON wrapper already exists/);
  });
});
