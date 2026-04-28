/**
 * Tests for the artifact-file resolver / content-type helpers in
 * `src/serve/data/artifacts.ts`. These are the data-layer pieces that
 * back `GET /api/agents/:slug/artifacts/:id/file` (the file-streaming
 * endpoint added by AC 4 of the artifacts feature).
 *
 * Coverage:
 *   - resolveArtifactContentType — extension lookup with octet-stream fallback
 *   - resolveArtifactFile — agent / artifact lookup, path-traversal guard,
 *     missing-file detection, success path returning record + abs path +
 *     content-type + size.
 *   - isResolveArtifactFileError — narrows the union.
 *
 * The HTTP route that wraps these helpers (`handleAgentArtifactFile`) is
 * exercised by integration tests in `src/serve/server.artifact-file.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  gatherAgentArtifacts,
  isResolveArtifactFileError,
  resolveArtifactContentType,
  resolveArtifactFile,
} from './artifacts.js';
import { ArtifactStore, createArtifactRecord } from '../../storage/artifact-store.js';

async function makeFixtureProject() {
  const root = await mkdtemp(join(tmpdir(), 'aweek-artifact-file-'));
  const agentsDir = join(root, '.aweek', 'agents');
  await mkdir(agentsDir, { recursive: true });
  const slug = 'writer';
  const now = new Date().toISOString();
  // Minimal valid agent config so listAllAgentsPartial picks it up.
  const config = {
    id: slug,
    subagentRef: slug,
    createdAt: now,
    updatedAt: now,
    weeklyTokenBudget: 10_000,
    budget: {
      weeklyTokenLimit: 10_000,
      currentUsage: 0,
      periodStart: now,
      paused: false,
    },
  };
  await writeFile(
    join(agentsDir, `${slug}.json`),
    JSON.stringify(config, null, 2) + '\n',
    'utf-8',
  );
  return { root, slug, agentsDir };
}

// ── resolveArtifactContentType ──────────────────────────────────────────────

test('resolveArtifactContentType maps common extensions to canonical types', () => {
  assert.equal(resolveArtifactContentType('readme.md'), 'text/markdown; charset=utf-8');
  assert.equal(resolveArtifactContentType('Report.MD'), 'text/markdown; charset=utf-8');
  assert.equal(resolveArtifactContentType('chart.png'), 'image/png');
  assert.equal(resolveArtifactContentType('photo.JPG'), 'image/jpeg');
  assert.equal(resolveArtifactContentType('paper.pdf'), 'application/pdf');
  assert.equal(resolveArtifactContentType('data.csv'), 'text/csv; charset=utf-8');
  assert.equal(resolveArtifactContentType('config.json'), 'application/json; charset=utf-8');
  assert.equal(resolveArtifactContentType('snippet.ts'), 'text/x-typescript; charset=utf-8');
});

test('resolveArtifactContentType falls back to octet-stream for unknown extensions', () => {
  assert.equal(resolveArtifactContentType('file.xyz'), 'application/octet-stream');
  assert.equal(resolveArtifactContentType('Makefile'), 'application/octet-stream');
  assert.equal(resolveArtifactContentType(''), 'application/octet-stream');
  assert.equal(resolveArtifactContentType('trailing.'), 'application/octet-stream');
  // The fallback is the browser-safe default that triggers a download
  // rather than guessing a renderable type — protects against
  // mislabelled or hostile content masquerading as text/html.
});

// ── isResolveArtifactFileError ──────────────────────────────────────────────

test('isResolveArtifactFileError narrows the union', () => {
  const err = { reason: 'agent-not-found' as const };
  const ok = {
    record: createArtifactRecord({
      agentId: 'a',
      taskId: 't',
      filePath: 'f.md',
      fileName: 'f.md',
      type: 'document' as const,
      description: 'd',
    }),
    absolutePath: '/tmp/f.md',
    contentType: 'text/plain',
    sizeBytes: 0,
  };
  assert.equal(isResolveArtifactFileError(err), true);
  assert.equal(isResolveArtifactFileError(ok), false);
});

// ── resolveArtifactFile ─────────────────────────────────────────────────────

test('resolveArtifactFile returns record + path + content-type + size on success', async () => {
  const { root, slug, agentsDir } = await makeFixtureProject();
  try {
    // Drop a deliverable file inside the project root.
    const filePath = 'reports/weekly.md';
    const absolute = join(root, filePath);
    await mkdir(join(root, 'reports'), { recursive: true });
    const body = '# Weekly Report\n\nHello world.\n';
    await writeFile(absolute, body, 'utf-8');

    // Register it via the existing ArtifactStore — the same path the
    // heartbeat / CLI auto-scan uses, so we exercise the production
    // manifest format end-to-end.
    const store = new ArtifactStore(agentsDir, root);
    const record = createArtifactRecord({
      agentId: slug,
      taskId: 'task-1',
      filePath,
      fileName: 'weekly.md',
      type: 'report',
      description: 'Weekly report',
    });
    await store.register(slug, record);

    const result = await resolveArtifactFile({
      projectDir: root,
      slug,
      artifactId: record.id,
    });
    assert.equal(isResolveArtifactFileError(result), false);
    if (isResolveArtifactFileError(result)) return; // narrow for TS

    assert.equal(result.record.id, record.id);
    assert.equal(result.absolutePath, absolute);
    assert.equal(result.contentType, 'text/markdown; charset=utf-8');
    assert.equal(result.sizeBytes, Buffer.byteLength(body, 'utf-8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveArtifactFile returns agent-not-found for an unknown slug', async () => {
  const { root } = await makeFixtureProject();
  try {
    const result = await resolveArtifactFile({
      projectDir: root,
      slug: 'does-not-exist',
      artifactId: 'artifact-deadbeef',
    });
    assert.deepEqual(result, { reason: 'agent-not-found' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveArtifactFile returns artifact-not-found for an unknown id', async () => {
  const { root, slug } = await makeFixtureProject();
  try {
    const result = await resolveArtifactFile({
      projectDir: root,
      slug,
      artifactId: 'artifact-deadbeef',
    });
    assert.deepEqual(result, { reason: 'artifact-not-found' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveArtifactFile rejects relative ../ traversal in filePath', async () => {
  const { root, slug, agentsDir } = await makeFixtureProject();
  try {
    // Construct a manifest with a path that escapes the project root.
    const store = new ArtifactStore(agentsDir, root);
    const record = createArtifactRecord({
      agentId: slug,
      taskId: 'task-1',
      // Many-levels of `../` should always escape any tmpdir.
      filePath: '../../../../../../../../etc/passwd',
      fileName: 'passwd',
      type: 'other',
      description: 'evil',
    });
    // Bypass autoSize so the missing target file doesn't cause a separate
    // failure inside register().
    await store.register(slug, record, { autoSize: false });

    const result = await resolveArtifactFile({
      projectDir: root,
      slug,
      artifactId: record.id,
    });
    assert.deepEqual(result, { reason: 'path-traversal' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveArtifactFile rejects absolute filePath outside project root', async () => {
  const { root, slug, agentsDir } = await makeFixtureProject();
  try {
    const store = new ArtifactStore(agentsDir, root);
    const record = createArtifactRecord({
      agentId: slug,
      taskId: 'task-1',
      filePath: '/etc/passwd',
      fileName: 'passwd',
      type: 'other',
      description: 'evil',
    });
    await store.register(slug, record, { autoSize: false });

    const result = await resolveArtifactFile({
      projectDir: root,
      slug,
      artifactId: record.id,
    });
    assert.deepEqual(result, { reason: 'path-traversal' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveArtifactFile returns file-missing when manifest entry exists but file is gone', async () => {
  const { root, slug, agentsDir } = await makeFixtureProject();
  try {
    const store = new ArtifactStore(agentsDir, root);
    const record = createArtifactRecord({
      agentId: slug,
      taskId: 'task-1',
      filePath: 'reports/missing.md',
      fileName: 'missing.md',
      type: 'report',
      description: 'gone',
    });
    // Register without the file existing — autoSize would otherwise
    // skip populating sizeBytes silently, which is fine.
    await store.register(slug, record, { autoSize: false });

    const result = await resolveArtifactFile({
      projectDir: root,
      slug,
      artifactId: record.id,
    });
    assert.deepEqual(result, { reason: 'file-missing' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveArtifactFile returns file-missing when path resolves to a directory', async () => {
  const { root, slug, agentsDir } = await makeFixtureProject();
  try {
    // Create a directory at the recorded path.
    await mkdir(join(root, 'a-directory-not-a-file'), { recursive: true });

    const store = new ArtifactStore(agentsDir, root);
    const record = createArtifactRecord({
      agentId: slug,
      taskId: 'task-1',
      filePath: 'a-directory-not-a-file',
      fileName: 'dir',
      type: 'other',
      description: 'oops',
    });
    await store.register(slug, record, { autoSize: false });

    const result = await resolveArtifactFile({
      projectDir: root,
      slug,
      artifactId: record.id,
    });
    assert.deepEqual(result, { reason: 'file-missing' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveArtifactFile validates required arguments', async () => {
  await assert.rejects(
    () => resolveArtifactFile({}),
    /projectDir is required/,
  );
  await assert.rejects(
    () => resolveArtifactFile({ projectDir: '/tmp' }),
    /slug is required/,
  );
  await assert.rejects(
    () => resolveArtifactFile({ projectDir: '/tmp', slug: 'a' }),
    /artifactId is required/,
  );
});

// ── gatherAgentArtifacts — AC 11: aggregate size via ArtifactStore.summary() ─

test('gatherAgentArtifacts returns summary.totalSizeBytes sourced from ArtifactStore.summary()', async () => {
  const { root, slug, agentsDir } = await makeFixtureProject();
  try {
    // Create three deliverables on disk so autoSize can populate
    // sizeBytes for each registered record. The exact bytes-on-disk
    // are what ArtifactStore.summary() must roll up — and what the
    // SPA Artifacts tab header surfaces in the per-agent rollup.
    const files: Array<{ rel: string; body: string; type: 'report' | 'document' | 'data'; }> = [
      { rel: 'reports/weekly.md', body: 'a'.repeat(4096), type: 'report' },
      { rel: 'notes.txt', body: 'b'.repeat(1024), type: 'document' },
      { rel: 'data/q1.csv', body: 'c'.repeat(2048), type: 'data' },
    ];
    await mkdir(join(root, 'reports'), { recursive: true });
    await mkdir(join(root, 'data'), { recursive: true });
    for (const f of files) {
      await writeFile(join(root, f.rel), f.body, 'utf-8');
    }

    const store = new ArtifactStore(agentsDir, root);
    const records = files.map((f) =>
      createArtifactRecord({
        agentId: slug,
        taskId: 'task-1',
        filePath: f.rel,
        fileName: f.rel.split('/').pop()!,
        type: f.type,
        description: 'fixture',
        week: '2026-W17',
      }),
    );
    for (const r of records) {
      await store.register(slug, r);
    }

    // Cross-check: ArtifactStore.summary() reports the same total.
    // The data-layer summary block must mirror this byte-for-byte —
    // that's the explicit AC 11 contract.
    const expected = await store.summary(slug);
    assert.equal(expected.totalSizeBytes, 4096 + 1024 + 2048);

    const payload = await gatherAgentArtifacts({ projectDir: root, slug });
    assert.ok(payload, 'expected gatherAgentArtifacts to return a payload');
    assert.equal(payload!.summary.totalArtifacts, expected.totalArtifacts);
    assert.equal(payload!.summary.totalSizeBytes, expected.totalSizeBytes);
    assert.deepEqual(payload!.summary.byType, expected.byType);
    // Slug round-trips and the artifact list is non-empty so the SPA
    // header has both the size + the rows to back it up.
    assert.equal(payload!.slug, slug);
    assert.equal(payload!.artifacts.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentArtifacts returns a zero-summary when the agent has no artifacts yet', async () => {
  const { root, slug } = await makeFixtureProject();
  try {
    const payload = await gatherAgentArtifacts({ projectDir: root, slug });
    assert.ok(payload, 'expected gatherAgentArtifacts to return a payload');
    assert.equal(payload!.summary.totalArtifacts, 0);
    assert.equal(payload!.summary.totalSizeBytes, 0);
    assert.deepEqual(payload!.summary.byType, {});
    assert.equal(payload!.artifacts.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAgentArtifacts returns null for an unknown slug', async () => {
  const { root } = await makeFixtureProject();
  try {
    const payload = await gatherAgentArtifacts({
      projectDir: root,
      slug: 'does-not-exist',
    });
    assert.equal(payload, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
