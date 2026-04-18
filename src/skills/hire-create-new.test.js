/**
 * Tests for the create-new path of the /aweek:hire wizard.
 *
 * The create-new path collects exactly three fields from the user (name,
 * description, system prompt), slugifies the name, and writes a minimal
 * `.claude/agents/<slug>.md` file with `name` + `description` frontmatter.
 * These tests lock that contract and the collision-refusal behaviour that
 * keeps it interoperable with the sibling adopt-existing path.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createNewSubagent, validateCreateNewInput } from './hire-create-new.js';
import { subagentFilePath, subagentFileExists } from '../subagents/subagent-file.js';

describe('hire-create-new — validateCreateNewInput', () => {
  it('accepts a valid name + description + system prompt triple', () => {
    const r = validateCreateNewInput({
      name: 'Content Writer',
      description: 'Writes weekly briefs',
      systemPrompt: 'You are a content writer.',
    });
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.slug, 'content-writer');
  });

  it('slugifies the name for the caller', () => {
    const r = validateCreateNewInput({
      name: 'Research & Summary Bot!',
      description: 'Research assistant',
      systemPrompt: 'You research.',
    });
    assert.equal(r.valid, true);
    assert.equal(r.slug, 'research-summary-bot');
  });

  it('rejects when every field is missing, returning one error per field', () => {
    const r = validateCreateNewInput({});
    assert.equal(r.valid, false);
    // Name (missing), slug (cannot derive), description (missing),
    // system prompt (missing).
    assert.ok(r.errors.length >= 3);
  });

  it('rejects names that slugify to an empty string', () => {
    const r = validateCreateNewInput({
      name: '!!!',
      description: 'Fine',
      systemPrompt: 'Fine.',
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.toLowerCase().includes('alphanumeric')));
    assert.equal(r.slug, '');
  });

  it('rejects names longer than 100 characters', () => {
    const r = validateCreateNewInput({
      name: 'x'.repeat(101),
      description: 'Fine',
      systemPrompt: 'Fine.',
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('100')));
  });

  it('rejects multi-line descriptions', () => {
    const r = validateCreateNewInput({
      name: 'Writer',
      description: 'Line one\nLine two',
      systemPrompt: 'Fine.',
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.toLowerCase().includes('single line')));
  });
});

describe('hire-create-new — createNewSubagent', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-hire-create-new-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(join(tmpDir, '.claude'), { recursive: true, force: true });
  });

  it('writes .claude/agents/<slug>.md with minimal frontmatter and flags adopted:false', async () => {
    const result = await createNewSubagent({
      name: 'Content Writer',
      description: 'Writes weekly briefs',
      systemPrompt: 'You are a content writer.',
      projectDir: tmpDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.adopted, false);
    assert.equal(result.slug, 'content-writer');
    assert.equal(result.path, subagentFilePath('content-writer', tmpDir));

    const bytes = await readFile(result.path, 'utf8');
    assert.equal(
      bytes,
      [
        '---',
        'name: content-writer',
        'description: Writes weekly briefs',
        '---',
        '',
        'You are a content writer.',
        '',
      ].join('\n'),
    );
    // The returned `content` mirrors the bytes just written so callers can
    // show a confirmation summary without re-reading from disk.
    assert.equal(result.content, bytes);
  });

  it('returns validation errors without writing anything', async () => {
    const result = await createNewSubagent({
      name: '',
      description: '',
      systemPrompt: '',
      projectDir: tmpDir,
    });
    assert.equal(result.success, false);
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors.length > 0);
    assert.equal(await subagentFileExists('', tmpDir), false);
  });

  it('adopts (does NOT overwrite) a pre-existing subagent file and flags adopted:true', async () => {
    // First create the file.
    const first = await createNewSubagent({
      name: 'Dup Bot',
      description: 'Original',
      systemPrompt: 'First version.',
      projectDir: tmpDir,
    });
    assert.equal(first.success, true);
    assert.equal(first.adopted, false);

    // Second attempt with the same (slugified) name must ADOPT the existing
    // file — no overwrite, no error. The user's new description/systemPrompt
    // are intentionally discarded because the .md on disk is the single
    // source of truth for identity.
    const second = await createNewSubagent({
      name: 'Dup Bot',
      description: 'Different description',
      systemPrompt: 'Second version.',
      projectDir: tmpDir,
    });
    assert.equal(second.success, true);
    assert.equal(second.adopted, true);
    assert.equal(second.slug, 'dup-bot');
    assert.equal(second.path, first.path);

    // Original file is untouched — the body still reflects the FIRST write.
    const bytes = await readFile(first.path, 'utf8');
    assert.ok(bytes.includes('First version.'));
    assert.ok(!bytes.includes('Second version.'));
    assert.ok(bytes.includes('description: Original'));
    assert.ok(!bytes.includes('Different description'));

    // The returned `content` matches what's on disk (i.e. the original bytes),
    // so the wizard can surface "here's what you're adopting" without a
    // second round-trip to the filesystem.
    assert.equal(second.content, bytes);
  });

  it('treats differently-cased names as the same subagent and adopts via slug normalization', async () => {
    const first = await createNewSubagent({
      name: 'Content Writer',
      description: 'Original',
      systemPrompt: 'Hello.',
      projectDir: tmpDir,
    });
    assert.equal(first.success, true);
    assert.equal(first.adopted, false);

    const second = await createNewSubagent({
      name: 'content-WRITER',
      description: 'Second attempt',
      systemPrompt: 'Hi.',
      projectDir: tmpDir,
    });
    assert.equal(second.success, true);
    assert.equal(second.adopted, true);
    assert.equal(second.slug, 'content-writer');
    // The adopted content is the original file — the slug collision routed
    // the wizard onto the adopt path instead of clobbering.
    assert.ok(second.content.includes('Hello.'));
    assert.ok(!second.content.includes('Hi.'));
  });

  it('writes ONLY into the provided projectDir', async () => {
    const result = await createNewSubagent({
      name: 'Scoped Bot',
      description: 'Stays in scope',
      systemPrompt: 'In scope only.',
      projectDir: tmpDir,
    });
    assert.equal(result.success, true);
    assert.ok(
      result.path.startsWith(tmpDir),
      `expected ${result.path} to live under ${tmpDir}`,
    );
  });

  it('returns the slug usable as both aweek id and subagentRef', async () => {
    // The refactor requires aweek agent id === subagent slug (filesystem-level
    // 1-to-1). Lock that the returned slug matches the filesystem basename.
    const result = await createNewSubagent({
      name: 'Agent 42',
      description: 'Numeric agent',
      systemPrompt: 'You are agent 42.',
      projectDir: tmpDir,
    });
    assert.equal(result.success, true);
    assert.equal(result.adopted, false);
    assert.equal(result.slug, 'agent-42');
    assert.ok(result.path.endsWith(join('.claude', 'agents', 'agent-42.md')));
  });

  it('adopts a hand-written .md that the wizard never produced itself', async () => {
    // Simulate a user who crafted `.claude/agents/handmade.md` before
    // running the hire wizard — e.g. an OMC-era subagent they want aweek
    // to schedule. The wizard must adopt the existing file verbatim instead
    // of clobbering the hand-edited content with wizard-shaped frontmatter.
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = join(tmpDir, '.claude', 'agents');
    await mkdir(dir, { recursive: true });
    const handmade = [
      '---',
      'name: handmade',
      'description: Hand-crafted before the wizard existed',
      'model: opus',
      '---',
      '',
      'Hand-written system prompt.',
      '',
    ].join('\n');
    await writeFile(join(dir, 'handmade.md'), handmade, 'utf8');

    const result = await createNewSubagent({
      name: 'Handmade',
      description: 'Wizard-supplied description (should be ignored)',
      systemPrompt: 'Wizard-supplied prompt (should be ignored).',
      projectDir: tmpDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.adopted, true);
    assert.equal(result.slug, 'handmade');
    // Returned content is the hand-written bytes — the `model: opus` line
    // that the wizard would never emit must survive adoption unchanged.
    assert.equal(result.content, handmade);
    assert.ok(result.content.includes('model: opus'));

    // Disk file is still the hand-written version.
    const onDisk = await readFile(result.path, 'utf8');
    assert.equal(onDisk, handmade);
  });

  it('still validates inputs before checking for an adoption collision', async () => {
    // Even when a .md exists, invalid inputs must surface as validation
    // errors — we don't silently ignore empty names just because the would-be
    // slug happens to have a file. (An empty name has no slug, so there is
    // nothing to adopt.)
    const result = await createNewSubagent({
      name: '',
      description: 'Fine',
      systemPrompt: 'Fine.',
      projectDir: tmpDir,
    });
    assert.equal(result.success, false);
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors.length > 0);
  });
});
