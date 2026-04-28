/**
 * Tests for `src/serve/artifact-mutations.ts` — the small write-side helper
 * the dashboard's HTTP layer uses to delete artifacts. Covers:
 *
 *   - happy path: file unlinked + manifest entry removed
 *   - idempotency: missing file (`ENOENT`) is absorbed; manifest still
 *     drops the record
 *   - 404 path: returns `{ ok: false, reason: 'not-found' }` when the
 *     artifact id isn't in the manifest
 *   - traversal guard: rejects manifest entries pointing outside the
 *     project root, both via absolute paths and via `..` segments
 *   - input validation: missing `projectDir` / `slug` / `artifactId`
 *     throw synchronous TypeErrors
 *
 * Plus a focused unit test on `isPathInsideRoot` so the boundary check
 * (with `+ sep` to defeat `<root>-evil` prefix attacks) is locked down
 * regardless of how `removeAgentArtifact` evolves.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isPathInsideRoot,
  removeAgentArtifact,
} from './artifact-mutations.js';
import {
  ArtifactStore,
  createArtifactRecord,
  type ArtifactRecord,
} from '../storage/artifact-store.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  projectDir: string;
  agentsDir: string;
  slug: string;
  store: ArtifactStore;
  cleanup: () => Promise<void>;
}

async function makeFixture(slug = 'test-agent'): Promise<Fixture> {
  const projectDir = await mkdtemp(join(tmpdir(), 'aweek-art-mutate-'));
  const agentsDir = join(projectDir, '.aweek', 'agents');
  await mkdir(agentsDir, { recursive: true });
  const store = new ArtifactStore(agentsDir, projectDir);
  return {
    projectDir,
    agentsDir,
    slug,
    store,
    cleanup: () => rm(projectDir, { recursive: true, force: true }),
  };
}

/**
 * Drop a deliverable file inside the agent's per-execution artifact dir
 * and register the matching record in the manifest.
 */
async function seedArtifact(
  fixture: Fixture,
  {
    fileName = 'report.md',
    body = '# hi\n',
    taskId = 'task-1',
    executionId = 'session-001',
  }: {
    fileName?: string;
    body?: string;
    taskId?: string;
    executionId?: string;
  } = {},
): Promise<{ record: ArtifactRecord; absolutePath: string }> {
  const artifactDir = join(
    fixture.agentsDir,
    fixture.slug,
    'artifacts',
    `${taskId}_${executionId}`,
  );
  await mkdir(artifactDir, { recursive: true });
  const absolutePath = join(artifactDir, fileName);
  await writeFile(absolutePath, body, 'utf-8');

  // filePath in the manifest is relative to projectDir per the existing
  // ArtifactStore convention.
  const filePath = absolutePath.slice(fixture.projectDir.length + 1);
  const record = createArtifactRecord({
    agentId: fixture.slug,
    taskId,
    filePath,
    fileName,
    type: 'document',
    description: 'Test artifact',
  });
  await fixture.store.register(fixture.slug, record);
  return { record, absolutePath };
}

// ---------------------------------------------------------------------------
// isPathInsideRoot — pure helper
// ---------------------------------------------------------------------------

describe('isPathInsideRoot', () => {
  it('accepts a path strictly inside root', () => {
    assert.equal(
      isPathInsideRoot('/tmp/proj/a/b/file.md', '/tmp/proj'),
      true,
    );
  });

  it('rejects the project root itself', () => {
    assert.equal(isPathInsideRoot('/tmp/proj', '/tmp/proj'), false);
  });

  it('rejects paths outside the project root', () => {
    assert.equal(isPathInsideRoot('/etc/passwd', '/tmp/proj'), false);
  });

  it('rejects a sibling that shares a string prefix with the root', () => {
    // `<root>-evil` must not pass the `+ sep` boundary test.
    assert.equal(
      isPathInsideRoot('/tmp/proj-evil/file.md', '/tmp/proj'),
      false,
    );
  });

  it('collapses `..` segments before comparing', () => {
    assert.equal(
      isPathInsideRoot('/tmp/proj/a/../../etc/passwd', '/tmp/proj'),
      false,
    );
  });

  it('returns false on empty inputs', () => {
    assert.equal(isPathInsideRoot('', '/tmp/proj'), false);
    assert.equal(isPathInsideRoot('/tmp/proj/x', ''), false);
  });
});

// ---------------------------------------------------------------------------
// removeAgentArtifact
// ---------------------------------------------------------------------------

describe('removeAgentArtifact', () => {
  it('unlinks the file and removes the manifest entry', async () => {
    const fixture = await makeFixture();
    try {
      const { record, absolutePath } = await seedArtifact(fixture);

      // Sanity: the file and manifest entry both exist before delete.
      await stat(absolutePath); // throws if missing — pre-condition.
      const before = await fixture.store.load(fixture.slug);
      assert.equal(before.length, 1);
      assert.equal(before[0].id, record.id);

      const result = await removeAgentArtifact({
        projectDir: fixture.projectDir,
        slug: fixture.slug,
        artifactId: record.id,
      });

      assert.deepEqual(result.ok, true, 'expected ok=true');
      if (result.ok) {
        assert.equal(result.artifact.id, record.id);
        assert.equal(result.fileUnlinked, true);
      }

      // File on disk: gone.
      await assert.rejects(
        () => stat(absolutePath),
        (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
      );

      // Manifest: empty.
      const after = await fixture.store.load(fixture.slug);
      assert.equal(after.length, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('still drops the manifest entry when the file is already gone', async () => {
    const fixture = await makeFixture();
    try {
      const { record, absolutePath } = await seedArtifact(fixture);

      // Pre-delete the on-disk file to simulate a manual cleanup that
      // left the manifest entry stale.
      await rm(absolutePath, { force: true });

      const result = await removeAgentArtifact({
        projectDir: fixture.projectDir,
        slug: fixture.slug,
        artifactId: record.id,
      });
      assert.deepEqual(result.ok, true);
      if (result.ok) {
        assert.equal(
          result.fileUnlinked,
          false,
          'fileUnlinked should be false when the file was already gone',
        );
      }

      const remaining = await fixture.store.load(fixture.slug);
      assert.equal(remaining.length, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('returns not-found when the artifactId is unknown', async () => {
    const fixture = await makeFixture();
    try {
      // Register one valid artifact so the manifest exists, then ask for
      // a different id.
      await seedArtifact(fixture);

      const result = await removeAgentArtifact({
        projectDir: fixture.projectDir,
        slug: fixture.slug,
        artifactId: 'artifact-deadbeef',
      });
      assert.deepEqual(result, { ok: false, reason: 'not-found' });

      // Manifest untouched.
      const records = await fixture.store.load(fixture.slug);
      assert.equal(records.length, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('returns not-found when the agent has no manifest at all', async () => {
    const fixture = await makeFixture();
    try {
      const result = await removeAgentArtifact({
        projectDir: fixture.projectDir,
        slug: 'no-such-agent',
        artifactId: 'artifact-x',
      });
      assert.deepEqual(result, { ok: false, reason: 'not-found' });
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects manifest entries with absolute filePath', async () => {
    const fixture = await makeFixture();
    try {
      // Seed a record with an absolute filePath. We bypass the registered
      // helper's relative-path expectation by hand-writing the manifest
      // — exactly the scenario the traversal guard exists to catch.
      const record = createArtifactRecord({
        agentId: fixture.slug,
        taskId: 'task-evil',
        filePath: '/etc/passwd',
        fileName: 'passwd',
        type: 'other',
        description: 'evil',
      });
      // Register skips schema validation when absolute paths are used in
      // metadata? They aren't — schema only checks shape, not safety.
      await fixture.store.register(fixture.slug, record, { autoSize: false });

      const result = await removeAgentArtifact({
        projectDir: fixture.projectDir,
        slug: fixture.slug,
        artifactId: record.id,
      });
      assert.deepEqual(result, { ok: false, reason: 'invalid-path' });

      // Manifest untouched — we refused to act, so the operator gets a
      // chance to clean the bad entry manually.
      const records = await fixture.store.load(fixture.slug);
      assert.equal(records.length, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects manifest entries that escape via `..` segments', async () => {
    const fixture = await makeFixture();
    try {
      const record = createArtifactRecord({
        agentId: fixture.slug,
        taskId: 'task-evil',
        filePath: '../../etc/passwd',
        fileName: 'passwd',
        type: 'other',
        description: 'evil',
      });
      await fixture.store.register(fixture.slug, record, { autoSize: false });

      const result = await removeAgentArtifact({
        projectDir: fixture.projectDir,
        slug: fixture.slug,
        artifactId: record.id,
      });
      assert.deepEqual(result, { ok: false, reason: 'invalid-path' });

      const records = await fixture.store.load(fixture.slug);
      assert.equal(records.length, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('throws TypeError on missing required inputs', async () => {
    await assert.rejects(
      // @ts-expect-error — exercising runtime guard
      () => removeAgentArtifact({}),
      (err: Error) =>
        err instanceof TypeError && /projectDir is required/.test(err.message),
    );
    await assert.rejects(
      // @ts-expect-error — exercising runtime guard
      () => removeAgentArtifact({ projectDir: '/tmp/x' }),
      (err: Error) =>
        err instanceof TypeError && /slug is required/.test(err.message),
    );
    await assert.rejects(
      // @ts-expect-error — exercising runtime guard
      () => removeAgentArtifact({ projectDir: '/tmp/x', slug: 'a' }),
      (err: Error) =>
        err instanceof TypeError && /artifactId is required/.test(err.message),
    );
  });
});

// Silence unused-import warnings on helpers used inside specific tests.
void [readFile, resolve, sep];
