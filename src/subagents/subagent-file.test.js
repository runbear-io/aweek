/**
 * Tests for subagent-file.js — minimal Claude Code subagent `.md` primitives.
 *
 * The create-new path of the hire wizard (see hire-create-new.js) writes
 * exactly one file: `.claude/agents/<slug>.md`, with minimal frontmatter
 * (`name` + `description`) and the system prompt as the body. These tests
 * lock that contract down so the behaviour can't silently regress if the
 * wizard or the heartbeat reads the file later.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SUBAGENTS_DIR_RELATIVE,
  resolveSubagentsDir,
  subagentFilePath,
  validateSubagentSlug,
  slugifyName,
  validateDescription,
  validateSystemPrompt,
  buildSubagentMarkdown,
  subagentFileExists,
  readSubagentFile,
  writeSubagentFile,
  parseSubagentFrontmatter,
  readSubagentIdentity,
  userSubagentFilePath,
  resolveSubagentFile,
} from './subagent-file.js';

describe('subagent-file — path helpers', () => {
  it('SUBAGENTS_DIR_RELATIVE points at the project-level subagent dir', () => {
    // The whole refactor hinges on project-level writes only; lock the
    // relative path in so nobody changes it to `~/.claude/agents` later.
    assert.equal(SUBAGENTS_DIR_RELATIVE, join('.claude', 'agents'));
  });

  it('resolveSubagentsDir uses cwd by default', () => {
    assert.equal(resolveSubagentsDir(), resolve(process.cwd(), '.claude', 'agents'));
  });

  it('resolveSubagentsDir honours an explicit project override', () => {
    assert.equal(
      resolveSubagentsDir('/tmp/project'),
      resolve('/tmp/project', '.claude', 'agents'),
    );
  });

  it('subagentFilePath joins slug + .md onto the subagent dir', () => {
    assert.equal(
      subagentFilePath('content-writer', '/tmp/project'),
      resolve('/tmp/project', '.claude', 'agents', 'content-writer.md'),
    );
  });
});

describe('subagent-file — slug validation and slugify', () => {
  it('accepts lowercase alphanumeric slugs with hyphens', () => {
    for (const slug of ['writer', 'content-writer', 'agent-42', 'a', 'x-y-z']) {
      const r = validateSubagentSlug(slug);
      assert.equal(r.valid, true, `${slug} should be valid: ${JSON.stringify(r.errors)}`);
    }
  });

  it('rejects uppercase, underscores, spaces, leading/trailing/consecutive hyphens, and empty', () => {
    for (const slug of ['Writer', 'content_writer', 'content writer', '-writer', 'writer-', 'a--b', '']) {
      const r = validateSubagentSlug(slug);
      assert.equal(r.valid, false, `${slug} should be invalid`);
      assert.ok(r.errors.length > 0);
    }
  });

  it('rejects non-string input', () => {
    assert.equal(validateSubagentSlug(null).valid, false);
    assert.equal(validateSubagentSlug(42).valid, false);
    assert.equal(validateSubagentSlug(undefined).valid, false);
  });

  it('slugifyName collapses spaces and symbols to single hyphens', () => {
    assert.equal(slugifyName('Content Writer'), 'content-writer');
    assert.equal(slugifyName('  Content   Writer  '), 'content-writer');
    assert.equal(slugifyName('Research & Summary!'), 'research-summary');
    assert.equal(slugifyName('Agent 42'), 'agent-42');
  });

  it('slugifyName returns empty string for all-symbol input', () => {
    assert.equal(slugifyName('!!!'), '');
    assert.equal(slugifyName(''), '');
    assert.equal(slugifyName('   '), '');
  });

  it('slugifyName output is always a valid slug when non-empty', () => {
    for (const name of ['Content Writer', 'Agent 42', 'ResearchBot', 'My-Very-Cool-Bot']) {
      const slug = slugifyName(name);
      assert.ok(slug.length > 0);
      assert.equal(validateSubagentSlug(slug).valid, true);
    }
  });
});

describe('subagent-file — description and system-prompt validators', () => {
  it('accepts a non-empty single-line description', () => {
    assert.equal(validateDescription('Summarises weekly research').valid, true);
  });

  it('rejects empty, whitespace-only, and non-string descriptions', () => {
    assert.equal(validateDescription('').valid, false);
    assert.equal(validateDescription('   ').valid, false);
    assert.equal(validateDescription(null).valid, false);
    assert.equal(validateDescription(undefined).valid, false);
  });

  it('rejects descriptions that contain newlines', () => {
    const r = validateDescription('Line one\nLine two');
    assert.equal(r.valid, false);
    assert.ok(r.errors.join(' ').toLowerCase().includes('single line'));
  });

  it('accepts a non-empty system prompt', () => {
    assert.equal(validateSystemPrompt('You are a helpful assistant.').valid, true);
  });

  it('rejects empty and non-string system prompts', () => {
    assert.equal(validateSystemPrompt('').valid, false);
    assert.equal(validateSystemPrompt('   ').valid, false);
    assert.equal(validateSystemPrompt(null).valid, false);
  });
});

describe('subagent-file — buildSubagentMarkdown', () => {
  it('emits minimal frontmatter: name + description only, no model/tools/skills', () => {
    const md = buildSubagentMarkdown({
      name: 'writer',
      description: 'Writes things',
      systemPrompt: 'You are a writer.',
    });

    // Frontmatter block delimiters are present exactly twice.
    const fmMatches = md.match(/^---$/gm);
    assert.ok(fmMatches && fmMatches.length === 2, `expected two --- lines, got ${fmMatches?.length}`);

    // Lock the minimal set of fields so nobody silently adds model/tools.
    assert.match(md, /^name: writer$/m);
    assert.match(md, /^description: Writes things$/m);
    assert.doesNotMatch(md, /^model:/m);
    assert.doesNotMatch(md, /^allowed-tools:/m);
    assert.doesNotMatch(md, /^tools:/m);
    assert.doesNotMatch(md, /^skills:/m);
    assert.doesNotMatch(md, /^mcp-servers:/m);

    // System prompt appears verbatim in the body.
    assert.ok(md.includes('You are a writer.'));
  });

  it('double-quotes descriptions that contain special YAML characters', () => {
    const md = buildSubagentMarkdown({
      name: 'researcher',
      description: 'Uses colons: commas, and "quotes" carefully',
      systemPrompt: 'Do research.',
    });
    // A bare colon in the value would break YAML — the helper must quote.
    const descLine = md.split('\n').find((l) => l.startsWith('description:'));
    assert.ok(descLine?.startsWith('description: "'));
    assert.ok(descLine?.endsWith('"'));
    assert.ok(descLine?.includes('\\"quotes\\"'));
  });

  it('ends with exactly one trailing newline', () => {
    const md = buildSubagentMarkdown({
      name: 'writer',
      description: 'Writes things',
      systemPrompt: 'You are a writer.\n\n\n',
    });
    assert.ok(md.endsWith('\n'));
    assert.ok(!md.endsWith('\n\n'));
  });

  it('places frontmatter before the body', () => {
    const md = buildSubagentMarkdown({
      name: 'writer',
      description: 'Writes things',
      systemPrompt: 'BODY CONTENT HERE',
    });
    const fmEnd = md.indexOf('---', md.indexOf('---') + 3);
    const bodyIdx = md.indexOf('BODY CONTENT HERE');
    assert.ok(fmEnd > 0 && bodyIdx > fmEnd);
  });
});

describe('subagent-file — filesystem operations', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-subagent-file-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    // Reset the .claude/agents dir between tests so each one starts clean.
    await rm(join(tmpDir, '.claude'), { recursive: true, force: true });
  });

  it('subagentFileExists returns false when the file is missing', async () => {
    assert.equal(await subagentFileExists('nope', tmpDir), false);
  });

  it('subagentFileExists returns true after writeSubagentFile succeeds', async () => {
    const result = await writeSubagentFile({
      slug: 'writer',
      description: 'Writes things',
      systemPrompt: 'You are a writer.',
      projectDir: tmpDir,
    });
    assert.equal(result.success, true);
    assert.equal(await subagentFileExists('writer', tmpDir), true);
  });

  it('writeSubagentFile creates .claude/agents/ recursively', async () => {
    const result = await writeSubagentFile({
      slug: 'fresh',
      description: 'Fresh install',
      systemPrompt: 'You are fresh.',
      projectDir: tmpDir,
    });
    assert.equal(result.success, true);
    const dirStat = await stat(join(tmpDir, '.claude', 'agents'));
    assert.ok(dirStat.isDirectory());
  });

  it('writeSubagentFile writes minimal frontmatter to disk', async () => {
    const result = await writeSubagentFile({
      slug: 'minimal',
      description: 'Minimal frontmatter test',
      systemPrompt: 'You are minimal.',
      projectDir: tmpDir,
    });
    assert.equal(result.success, true);
    const bytes = await readFile(result.path, 'utf8');
    // Exact content check — locks the minimal-frontmatter contract.
    assert.equal(
      bytes,
      [
        '---',
        'name: minimal',
        'description: Minimal frontmatter test',
        '---',
        '',
        'You are minimal.',
        '',
      ].join('\n'),
    );
  });

  it('writeSubagentFile refuses to overwrite an existing file', async () => {
    // First create it.
    const first = await writeSubagentFile({
      slug: 'dup',
      description: 'Original',
      systemPrompt: 'First version.',
      projectDir: tmpDir,
    });
    assert.equal(first.success, true);

    // Then try again with different content.
    const second = await writeSubagentFile({
      slug: 'dup',
      description: 'Overwritten?',
      systemPrompt: 'Second version.',
      projectDir: tmpDir,
    });
    assert.equal(second.success, false);
    assert.equal(second.alreadyExists, true);
    assert.ok(second.errors.some((e) => e.toLowerCase().includes('already exists')));
    assert.equal(second.path, first.path);

    // And the on-disk bytes are unchanged.
    const bytes = await readFile(first.path, 'utf8');
    assert.ok(bytes.includes('First version.'));
    assert.ok(!bytes.includes('Second version.'));
  });

  it('writeSubagentFile returns validation errors without touching disk', async () => {
    const result = await writeSubagentFile({
      slug: 'Bad Slug',
      description: '',
      systemPrompt: '',
      projectDir: tmpDir,
    });
    assert.equal(result.success, false);
    assert.ok(result.errors.length >= 3);
    assert.equal(await subagentFileExists('Bad Slug', tmpDir), false);
  });

  it('writes ONLY to the given projectDir — never to ~/.claude/agents', async () => {
    // Smoke test: the function must never resolve its target outside the
    // provided projectDir. We verify by writing into a sandbox and confirming
    // the absolute path is a child of tmpDir.
    const result = await writeSubagentFile({
      slug: 'scoped',
      description: 'Stays in scope',
      systemPrompt: 'Only in project.',
      projectDir: tmpDir,
    });
    assert.equal(result.success, true);
    assert.ok(
      result.path.startsWith(tmpDir),
      `expected ${result.path} to live under ${tmpDir}`,
    );
  });

  it('readSubagentFile returns the bytes we wrote', async () => {
    const result = await writeSubagentFile({
      slug: 'reader',
      description: 'Readable',
      systemPrompt: 'You are readable.',
      projectDir: tmpDir,
    });
    assert.equal(result.success, true);

    const bytes = await readSubagentFile('reader', tmpDir);
    assert.equal(bytes, result.content);
  });

  it('readSubagentFile throws when the file is missing', async () => {
    await assert.rejects(() => readSubagentFile('ghost', tmpDir));
  });
});

describe('subagent-file — parseSubagentFrontmatter', () => {
  it('parses the minimal frontmatter written by buildSubagentMarkdown', () => {
    const md = buildSubagentMarkdown({
      name: 'writer',
      description: 'Writes things',
      systemPrompt: 'You are a writer.',
    });
    const parsed = parseSubagentFrontmatter(md);
    assert.equal(parsed.name, 'writer');
    assert.equal(parsed.description, 'Writes things');
  });

  it('unquotes double-quoted descriptions with special YAML characters', () => {
    const md = buildSubagentMarkdown({
      name: 'researcher',
      description: 'Uses colons: commas, and "quotes" carefully',
      systemPrompt: 'Do research.',
    });
    const parsed = parseSubagentFrontmatter(md);
    assert.equal(parsed.name, 'researcher');
    assert.equal(
      parsed.description,
      'Uses colons: commas, and "quotes" carefully'
    );
  });

  it('ignores extra frontmatter keys (model, tools, etc.) without error', () => {
    const md = [
      '---',
      'name: ops',
      'description: Ops agent',
      'model: sonnet',
      'allowed-tools: [Read, Edit]',
      '---',
      '',
      'Ops system prompt.',
      '',
    ].join('\n');
    const parsed = parseSubagentFrontmatter(md);
    assert.equal(parsed.name, 'ops');
    assert.equal(parsed.description, 'Ops agent');
  });

  it('returns empty values when no frontmatter is present', () => {
    const parsed = parseSubagentFrontmatter('# just a body\n\nno fence here');
    assert.equal(parsed.name, '');
    assert.equal(parsed.description, '');
  });

  it('returns empty values on non-string input', () => {
    assert.deepEqual(parseSubagentFrontmatter(null), { name: '', description: '' });
    assert.deepEqual(parseSubagentFrontmatter(undefined), { name: '', description: '' });
    assert.deepEqual(parseSubagentFrontmatter(''), { name: '', description: '' });
  });
});

describe('subagent-file — readSubagentIdentity', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-read-identity-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(join(tmpDir, '.claude'), { recursive: true, force: true });
  });

  it('returns { missing: true } when the .md is absent', async () => {
    const identity = await readSubagentIdentity('ghost', tmpDir);
    assert.equal(identity.missing, true);
    assert.equal(identity.name, '');
    assert.equal(identity.description, '');
    // path is still resolved so callers can show the user where the file
    // *should* have been — useful for missing-marker output.
    assert.ok(identity.path.endsWith(join('.claude', 'agents', 'ghost.md')));
  });

  it('returns the live name and description when the .md exists', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Live description from disk',
      systemPrompt: 'You are a writer.',
      projectDir: tmpDir,
    });

    const identity = await readSubagentIdentity('writer', tmpDir);
    assert.equal(identity.missing, false);
    assert.equal(identity.name, 'writer');
    assert.equal(identity.description, 'Live description from disk');
  });

  it('picks up edits made directly to the .md file', async () => {
    const dir = join(tmpDir, '.claude', 'agents');
    await mkdir(dir, { recursive: true });
    // Hand-write a .md that uses an arbitrary display name (not the slug),
    // to prove we're reading frontmatter — not guessing from the filename.
    await writeFile(
      join(dir, 'writer.md'),
      buildSubagentMarkdown({
        name: 'Hand-Edited Name',
        description: 'Hand-edited desc',
        systemPrompt: 'Body.',
      }),
      'utf8'
    );

    const identity = await readSubagentIdentity('writer', tmpDir);
    assert.equal(identity.missing, false);
    assert.equal(identity.name, 'Hand-Edited Name');
    assert.equal(identity.description, 'Hand-edited desc');
  });
});

// ---------------------------------------------------------------------------
// AC 5 helpers: userSubagentFilePath + resolveSubagentFile
//
// Claude Code resolves a subagent in BOTH `<project>/.claude/agents/<slug>.md`
// (project-level, authoritative) AND `~/.claude/agents/<slug>.md` (user-level
// global fallback). The heartbeat must respect that same lookup order — if
// either location has the .md, the session is spawnable; only when BOTH are
// missing does the heartbeat auto-pause the agent with
// `pausedReason: 'subagent_missing'`.
// ---------------------------------------------------------------------------

describe('subagent-file — userSubagentFilePath', () => {
  it('points at ~/.claude/agents/<slug>.md under the supplied home dir', () => {
    assert.equal(
      userSubagentFilePath('writer', '/tmp/fake-home'),
      join('/tmp/fake-home', '.claude', 'agents', 'writer.md'),
    );
  });

  it('falls back to os.homedir() when home is omitted', () => {
    const path = userSubagentFilePath('writer');
    // os.homedir() is non-empty on every platform we support; just make sure
    // we appended `.claude/agents/<slug>.md` to it.
    assert.match(path, /\/\.claude\/agents\/writer\.md$/);
  });
});

describe('subagent-file — resolveSubagentFile', () => {
  let projectDir;
  let homeDir;

  before(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'aweek-resolve-proj-'));
    homeDir = await mkdtemp(join(tmpdir(), 'aweek-resolve-home-'));
  });

  after(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(join(projectDir, '.claude'), { recursive: true, force: true });
    await rm(join(homeDir, '.claude'), { recursive: true, force: true });
  });

  async function writeProject(slug) {
    const dir = join(projectDir, '.claude', 'agents');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${slug}.md`), '---\nname: x\n---\n', 'utf8');
  }

  async function writeUser(slug) {
    const dir = join(homeDir, '.claude', 'agents');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${slug}.md`), '---\nname: x\n---\n', 'utf8');
  }

  it('returns exists=false with both paths when neither file is present', async () => {
    const result = await resolveSubagentFile('writer', {
      projectDir,
      home: homeDir,
    });
    assert.equal(result.exists, false);
    assert.equal(result.location, null);
    assert.equal(result.projectPath, join(projectDir, '.claude', 'agents', 'writer.md'));
    assert.equal(result.userPath, join(homeDir, '.claude', 'agents', 'writer.md'));
  });

  it('returns location=project when only the project-level .md exists', async () => {
    await writeProject('writer');
    const result = await resolveSubagentFile('writer', {
      projectDir,
      home: homeDir,
    });
    assert.equal(result.exists, true);
    assert.equal(result.location, 'project');
  });

  it('returns location=user when only the user-level .md exists', async () => {
    await writeUser('writer');
    const result = await resolveSubagentFile('writer', {
      projectDir,
      home: homeDir,
    });
    assert.equal(result.exists, true);
    assert.equal(result.location, 'user');
  });

  it('prefers the project-level .md when BOTH exist', async () => {
    await writeProject('writer');
    await writeUser('writer');
    const result = await resolveSubagentFile('writer', {
      projectDir,
      home: homeDir,
    });
    assert.equal(result.exists, true);
    assert.equal(result.location, 'project');
  });
});

// ---------------------------------------------------------------------------
// Sub-AC 1: extended parser/writer coverage
//
// The previous suites lock the happy-path contract for the create-new path.
// These additional tests harden the .md read/write logic against:
//   - hand-edited files with CRLF, BOM, single-quoted YAML, or extra
//     whitespace in the frontmatter (parser robustness),
//   - round-trip safety (write → read → parse yields identity), and
//   - body-formatting edge cases (multi-line bodies, per-line trailing
//     whitespace, internal blank lines).
//
// These branches are exercised the moment a user hand-edits
// `.claude/agents/<slug>.md` between heartbeats, so they need coverage even
// though the wizard itself never produces them.
// ---------------------------------------------------------------------------

describe('subagent-file — parseSubagentFrontmatter (robustness)', () => {
  it('tolerates a UTF-8 BOM at the very start of the file', () => {
    const md =
      '\uFEFF---\nname: writer\ndescription: With BOM\n---\n\nBody.\n';
    const parsed = parseSubagentFrontmatter(md);
    assert.equal(parsed.name, 'writer');
    assert.equal(parsed.description, 'With BOM');
  });

  it('parses CRLF (Windows) line endings', () => {
    const md =
      '---\r\nname: writer\r\ndescription: CRLF desc\r\n---\r\n\r\nBody.\r\n';
    const parsed = parseSubagentFrontmatter(md);
    assert.equal(parsed.name, 'writer');
    assert.equal(parsed.description, 'CRLF desc');
  });

  it('unquotes single-quoted YAML scalars (collapses doubled apostrophes)', () => {
    const md = [
      '---',
      "name: writer",
      "description: 'It''s a single-quoted desc'",
      '---',
      '',
      'Body.',
      '',
    ].join('\n');
    const parsed = parseSubagentFrontmatter(md);
    assert.equal(parsed.description, "It's a single-quoted desc");
  });

  it('tolerates leading whitespace and an extra blank line before the opening fence', () => {
    const md = [
      '',
      '   ---',
      'name: writer',
      'description: Extra ws',
      '---',
      '',
      'Body.',
      '',
    ].join('\n');
    const parsed = parseSubagentFrontmatter(md);
    assert.equal(parsed.name, 'writer');
    assert.equal(parsed.description, 'Extra ws');
  });

  it('tolerates extra whitespace around the colon in key/value lines', () => {
    const md = [
      '---',
      'name   :   writer',
      'description :    spaced out',
      '---',
      '',
    ].join('\n');
    const parsed = parseSubagentFrontmatter(md);
    assert.equal(parsed.name, 'writer');
    assert.equal(parsed.description, 'spaced out');
  });

  it('returns empty string for keys present but with empty values', () => {
    const md = [
      '---',
      'name: ',
      'description: ',
      '---',
      '',
    ].join('\n');
    const parsed = parseSubagentFrontmatter(md);
    assert.equal(parsed.name, '');
    assert.equal(parsed.description, '');
  });

  it('parses frontmatter even when the closing fence is the final line (no trailing body)', () => {
    const md = '---\nname: writer\ndescription: No body\n---';
    const parsed = parseSubagentFrontmatter(md);
    assert.equal(parsed.name, 'writer');
    assert.equal(parsed.description, 'No body');
  });

  it('returns empty values when the closing fence is missing entirely', () => {
    const md = '---\nname: writer\ndescription: Never closed\n\n# body forever\n';
    const parsed = parseSubagentFrontmatter(md);
    // Without a closing fence, the regex bails — parser fails closed.
    assert.equal(parsed.name, '');
    assert.equal(parsed.description, '');
  });

  it('does not surface unrelated keys (model, allowed-tools, skills, mcp-servers)', () => {
    const md = [
      '---',
      'name: ops',
      'description: Ops',
      'model: opus',
      'allowed-tools: Read,Edit',
      'skills: a,b',
      'mcp-servers: x',
      '---',
      '',
    ].join('\n');
    const parsed = parseSubagentFrontmatter(md);
    // Only `name` and `description` are surfaced — extra keys are dropped
    // silently so the returned shape stays { name, description }.
    assert.deepEqual(Object.keys(parsed).sort(), ['description', 'name']);
  });
});

describe('subagent-file — buildSubagentMarkdown (body formatting)', () => {
  it('preserves a multi-line system prompt verbatim', () => {
    const prompt = [
      'Line one.',
      '',
      'Line three after blank.',
      '- bullet a',
      '- bullet b',
    ].join('\n');
    const md = buildSubagentMarkdown({
      name: 'writer',
      description: 'Multi-line',
      systemPrompt: prompt,
    });
    // The body block (everything after the second `---` and the blank) must
    // contain the prompt's structural newlines.
    assert.ok(md.includes('Line one.\n\nLine three after blank.\n- bullet a\n- bullet b'));
  });

  it('strips per-line trailing spaces/tabs from the system prompt body', () => {
    const md = buildSubagentMarkdown({
      name: 'writer',
      description: 'Trim trailing ws',
      systemPrompt: 'Line one.   \nLine two.\t\t\nLine three.',
    });
    // No line in the body should have trailing whitespace before its newline.
    assert.doesNotMatch(md, /[ \t]+\n/);
    assert.ok(md.includes('Line one.\nLine two.\nLine three.'));
  });

  it('collapses repeated trailing newlines on the body to exactly one', () => {
    const md = buildSubagentMarkdown({
      name: 'writer',
      description: 'Trim trailing newlines',
      systemPrompt: 'Body.\n\n\n\n',
    });
    assert.ok(md.endsWith('Body.\n'));
    assert.ok(!md.endsWith('Body.\n\n'));
  });

  it('double-quotes a description that contains a non-plain character (apostrophe)', () => {
    const md = buildSubagentMarkdown({
      name: 'writer',
      description: "It's complicated",
      systemPrompt: 'Body.',
    });
    const descLine = md.split('\n').find((l) => l.startsWith('description:'));
    // Apostrophe is outside the plain-scalar alphabet → must be double-quoted.
    assert.ok(descLine?.startsWith('description: "'));
    assert.ok(descLine?.endsWith('"'));
  });
});

describe('subagent-file — writeSubagentFile + parser round-trip', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-subagent-roundtrip-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(join(tmpDir, '.claude'), { recursive: true, force: true });
  });

  it('round-trips: write → read → parseSubagentFrontmatter recovers name + description', async () => {
    const description = 'Round-trip with: colons, "quotes", and commas.';
    const result = await writeSubagentFile({
      slug: 'roundtrip',
      description,
      systemPrompt: 'You are a round-tripper.',
      projectDir: tmpDir,
    });
    assert.equal(result.success, true);

    const bytes = await readSubagentFile('roundtrip', tmpDir);
    const parsed = parseSubagentFrontmatter(bytes);
    assert.equal(parsed.name, 'roundtrip');
    assert.equal(parsed.description, description);
  });

  it('round-trips through readSubagentIdentity (live disk read)', async () => {
    const description = 'Live identity from disk';
    await writeSubagentFile({
      slug: 'live',
      description,
      systemPrompt: 'You are live.',
      projectDir: tmpDir,
    });

    const identity = await readSubagentIdentity('live', tmpDir);
    assert.equal(identity.missing, false);
    assert.equal(identity.name, 'live');
    assert.equal(identity.description, description);
  });

  it('is idempotent across delete + re-create with different content', async () => {
    // Create.
    const first = await writeSubagentFile({
      slug: 'recycled',
      description: 'First',
      systemPrompt: 'First body.',
      projectDir: tmpDir,
    });
    assert.equal(first.success, true);

    // Delete just the .md file (simulate the user removing it).
    await rm(first.path, { force: true });
    assert.equal(await subagentFileExists('recycled', tmpDir), false);

    // Re-create with different content — should succeed (no longer collides).
    const second = await writeSubagentFile({
      slug: 'recycled',
      description: 'Second',
      systemPrompt: 'Second body.',
      projectDir: tmpDir,
    });
    assert.equal(second.success, true);
    const identity = await readSubagentIdentity('recycled', tmpDir);
    assert.equal(identity.description, 'Second');
  });

  it('returns a content payload that exactly equals the bytes written to disk', async () => {
    const result = await writeSubagentFile({
      slug: 'echo',
      description: 'Echo back',
      systemPrompt: 'You echo.',
      projectDir: tmpDir,
    });
    assert.equal(result.success, true);
    const bytes = await readFile(result.path, 'utf8');
    assert.equal(result.content, bytes);
  });

  it('aggregates ALL validation errors before bailing (slug + description + prompt)', async () => {
    const result = await writeSubagentFile({
      slug: 'BAD SLUG',
      description: '',
      systemPrompt: '',
      projectDir: tmpDir,
    });
    assert.equal(result.success, false);
    // Each validator contributes at least one error; the writer must surface
    // all of them, not bail at the first failure.
    assert.ok(result.errors.length >= 3, `expected at least 3 errors, got ${result.errors.length}`);
  });
});

describe('subagent-file — subagentFilePath (cwd default)', () => {
  it('falls back to process.cwd() when projectDir is omitted', () => {
    const expected = resolve(process.cwd(), '.claude', 'agents', 'writer.md');
    assert.equal(subagentFilePath('writer'), expected);
  });
});
