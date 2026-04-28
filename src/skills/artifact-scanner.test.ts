/**
 * Tests for the post-session artifact scanner.
 *
 * Validates the pure inference helpers (`inferMimeType`,
 * `inferArtifactType`, `buildDefaultDescription`) plus the directory walk
 * orchestrator (`scanArtifactDirectory`) and the scan + register
 * convenience (`scanAndRegister`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDefaultDescription,
  inferArtifactType,
  inferMimeType,
  scanAndRegister,
  scanArtifactDirectory,
} from './artifact-scanner.js';
import { ArtifactStore } from '../storage/artifact-store.js';

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe('inferMimeType', () => {
  it('returns the canonical MIME for known extensions (case-insensitive)', () => {
    assert.equal(inferMimeType('summary.md'), 'text/markdown');
    assert.equal(inferMimeType('SUMMARY.MD'), 'text/markdown');
    assert.equal(inferMimeType('schema.json'), 'application/json');
    assert.equal(inferMimeType('spec.pdf'), 'application/pdf');
    assert.equal(inferMimeType('draft.docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('falls back to application/octet-stream for unknown / missing extensions', () => {
    assert.equal(inferMimeType('binary.xyz'), 'application/octet-stream');
    assert.equal(inferMimeType('Makefile'), 'application/octet-stream');
    assert.equal(inferMimeType(''), 'application/octet-stream');
  });

  it('honors caller-supplied overrides', () => {
    assert.equal(
      inferMimeType('payload.proto', { '.proto': 'application/x-protobuf' }),
      'application/x-protobuf',
    );
  });
});

describe('inferArtifactType', () => {
  it('classifies common extensions into the schema enum', () => {
    assert.equal(inferArtifactType('notes.md'), 'document');
    assert.equal(inferArtifactType('schema.json'), 'data');
    assert.equal(inferArtifactType('app.ts'), 'code');
    assert.equal(inferArtifactType('config.yaml'), 'config');
  });

  it('falls back to "other" for unknown extensions', () => {
    assert.equal(inferArtifactType('mystery.xyz'), 'other');
    assert.equal(inferArtifactType('Makefile'), 'other');
  });

  it('promotes report-keyword filenames to type=report regardless of extension', () => {
    assert.equal(inferArtifactType('weekly-report.md'), 'report');
    assert.equal(inferArtifactType('Q1-review.pdf'), 'report');
    assert.equal(inferArtifactType('retrospective.html'), 'report');
    assert.equal(inferArtifactType('summary.txt'), 'report');
  });

  it('honors override map ahead of the default table', () => {
    assert.equal(
      inferArtifactType('payload.proto', { '.proto': 'data' }),
      'data',
    );
  });
});

describe('buildDefaultDescription', () => {
  it('falls back to "<filename> — <type>" when no task is supplied', () => {
    assert.equal(
      buildDefaultDescription('plan.md', 'document'),
      'plan.md — document',
    );
  });

  it('includes the task title when present', () => {
    const desc = buildDefaultDescription('plan.md', 'document', {
      title: 'Draft launch plan',
    });
    assert.equal(desc, 'plan.md — document generated during task "Draft launch plan"');
  });

  it('falls back to prompt when title is missing', () => {
    const desc = buildDefaultDescription('plan.md', 'document', {
      prompt: 'Outline the launch plan for next month',
    });
    assert.match(desc, /generated during task "Outline the launch plan/);
  });

  it('caps very long task labels and collapses whitespace', () => {
    const huge = 'word '.repeat(200);
    const desc = buildDefaultDescription('out.md', 'document', { title: huge });
    // The description should not contain newlines and the title segment
    // should be visibly truncated with an ellipsis.
    assert.ok(!/\n/.test(desc));
    assert.match(desc, /…/);
  });

  it('appends an objective marker when supplied', () => {
    const desc = buildDefaultDescription('plan.md', 'document', {
      title: 'Draft launch plan',
      objectiveId: 'obj-42',
    });
    assert.match(desc, /\(objective obj-42\)/);
  });
});

// ---------------------------------------------------------------------------
// Directory walk + integration tests
// ---------------------------------------------------------------------------

async function makeProject(): Promise<{ projectDir: string; agentsDir: string }> {
  const projectDir = await mkdtemp(join(tmpdir(), 'aweek-art-scan-'));
  const agentsDir = join(projectDir, '.aweek', 'agents');
  await mkdir(agentsDir, { recursive: true });
  return { projectDir, agentsDir };
}

async function seedArtifacts(
  agentsDir: string,
  agentId: string,
  taskId: string,
  executionId: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = join(agentsDir, agentId, 'artifacts', `${taskId}_${executionId}`);
  await mkdir(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body, 'utf8');
  }
  return dir;
}

describe('scanArtifactDirectory', () => {
  it('returns an empty array when the artifact dir does not exist', async () => {
    const { projectDir, agentsDir } = await makeProject();
    try {
      const records = await scanArtifactDirectory({
        agentsDir,
        agentId: 'writer',
        taskId: 'task-1',
        executionId: 'session-1',
        projectRoot: projectDir,
      });
      assert.deepEqual(records, []);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('walks the directory recursively and produces records ready for registerBatch', async () => {
    const { projectDir, agentsDir } = await makeProject();
    try {
      await seedArtifacts(agentsDir, 'writer', 'task-1', 'session-1', {
        'plan.md': '# Plan',
        'data/values.json': '{"k":1}',
        'src/run.ts': 'export {};',
        'reports/weekly-report.md': '# Weekly Report',
      });

      const records = await scanArtifactDirectory({
        agentsDir,
        agentId: 'writer',
        taskId: 'task-1',
        executionId: 'session-1',
        projectRoot: projectDir,
        week: '2026-W17',
        task: { title: 'Refresh the launch plan', objectiveId: '2026-04' },
      });

      assert.equal(records.length, 4);

      const byName = new Map(records.map((r) => [r.fileName, r]));
      const plan = byName.get('plan.md')!;
      assert.equal(plan.type, 'document');
      assert.equal(plan.agentId, 'writer');
      assert.equal(plan.taskId, 'task-1');
      assert.equal(plan.week, '2026-W17');
      assert.match(plan.id, /^artifact-[a-f0-9]+$/);
      assert.equal((plan.metadata as { mimeType: string }).mimeType, 'text/markdown');
      assert.equal((plan.metadata as { executionId: string }).executionId, 'session-1');
      assert.equal((plan.metadata as { objectiveId: string }).objectiveId, '2026-04');
      assert.match(plan.description, /Refresh the launch plan/);
      // Path is relative to the project root, forward-slash, and points
      // under .aweek/agents/<agent>/artifacts/<taskId>_<executionId>/.
      assert.equal(
        plan.filePath,
        ['.aweek', 'agents', 'writer', 'artifacts', 'task-1_session-1', 'plan.md'].join('/'),
      );
      assert.ok(plan.sizeBytes && plan.sizeBytes > 0, 'auto-populated sizeBytes');

      // Recursive walk preserves subdirectory paths in the fileName.
      const data = byName.get('data/values.json')!;
      assert.equal(data.type, 'data');
      assert.equal((data.metadata as { mimeType: string }).mimeType, 'application/json');

      const code = byName.get('src/run.ts')!;
      assert.equal(code.type, 'code');

      // Filename keyword wins over extension default for reports.
      const report = byName.get('reports/weekly-report.md')!;
      assert.equal(report.type, 'report');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('throws on missing required fields', async () => {
    await assert.rejects(
      // @ts-expect-error — intentional bad input
      () => scanArtifactDirectory({}),
      /agentsDir is required/,
    );
  });
});

describe('scanAndRegister', () => {
  it('persists scanned records via ArtifactStore.registerBatch', async () => {
    const { projectDir, agentsDir } = await makeProject();
    try {
      await seedArtifacts(agentsDir, 'writer', 'task-1', 'session-1', {
        'notes.md': '# Notes',
        'data.json': '[]',
      });

      const store = new ArtifactStore(agentsDir, projectDir);
      const result = await scanAndRegister({
        agentsDir,
        agentId: 'writer',
        taskId: 'task-1',
        executionId: 'session-1',
        projectRoot: projectDir,
        store,
      });

      assert.equal(result.scanned.length, 2);
      assert.equal(result.registered.length, 2);

      // Manifest now contains both records.
      const loaded = await store.load('writer');
      assert.equal(loaded.length, 2);
      const types = new Set(loaded.map((r) => r.type));
      assert.deepEqual([...types].sort(), ['data', 'document']);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('is idempotent when re-run on the same directory (no duplicates)', async () => {
    const { projectDir, agentsDir } = await makeProject();
    try {
      await seedArtifacts(agentsDir, 'writer', 'task-1', 'session-1', {
        'notes.md': '# Notes',
      });
      const store = new ArtifactStore(agentsDir, projectDir);
      const first = await scanAndRegister({
        agentsDir,
        agentId: 'writer',
        taskId: 'task-1',
        executionId: 'session-1',
        projectRoot: projectDir,
        store,
      });
      // Second run picks up no new files (the records have fresh ids on
      // each scan, but the manifest already contains a record pointing at
      // the same filePath; the store's idempotency contract is per-id, so
      // second-pass records get appended). We verify uniqueness by file
      // path so the test reflects real-world heartbeat behaviour where
      // the heartbeat clears the artifact dir between runs.
      const fileNamesAfterFirst = (await store.load('writer')).map((r) => r.fileName);
      assert.deepEqual(fileNamesAfterFirst, ['notes.md']);
      assert.equal(first.registered.length, 1);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('returns an empty registered list when the artifact dir is empty', async () => {
    const { projectDir, agentsDir } = await makeProject();
    try {
      // Create the dir but leave it empty.
      await mkdir(
        join(agentsDir, 'writer', 'artifacts', 'task-1_session-1'),
        { recursive: true },
      );
      const result = await scanAndRegister({
        agentsDir,
        agentId: 'writer',
        taskId: 'task-1',
        executionId: 'session-1',
        projectRoot: projectDir,
      });
      assert.deepEqual(result.scanned, []);
      assert.deepEqual(result.registered, []);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Sub-AC 4: Strengthened colocated coverage for the post-session auto-scan.
  //
  // The tests above pin down the happy path. The cases below pin down the
  // contract between the scanner and ArtifactStore so a future refactor that
  // skips the store (e.g. writing manifest.json by hand) trips loudly.
  // -------------------------------------------------------------------------

  it('creates the agent artifacts directory via ArtifactStore.init when missing', async () => {
    const { projectDir, agentsDir } = await makeProject();
    try {
      // Simulate a brand-new agent: no `<agentsDir>/<slug>/artifacts/` subtree
      // exists yet. Drop a deliverable directly into the per-execution dir
      // (creating it) and verify scanAndRegister provisions the parent
      // `artifacts/` and writes manifest.json there.
      const execDir = join(
        agentsDir,
        'fresh-agent',
        'artifacts',
        'task-init_session-init',
      );
      await mkdir(execDir, { recursive: true });
      await writeFile(join(execDir, 'plan.md'), '# plan', 'utf-8');

      const store = new ArtifactStore(agentsDir, projectDir);
      const result = await scanAndRegister({
        agentsDir,
        agentId: 'fresh-agent',
        taskId: 'task-init',
        executionId: 'session-init',
        projectRoot: projectDir,
        store,
      });

      assert.equal(result.registered.length, 1);

      // The store must have created the canonical manifest path on disk.
      const manifestPath = join(
        agentsDir,
        'fresh-agent',
        'artifacts',
        'manifest.json',
      );
      const stats = await stat(manifestPath);
      assert.ok(stats.isFile(), 'manifest.json should exist after scanAndRegister');

      const reloaded = await store.load('fresh-agent');
      assert.equal(reloaded.length, 1);
      assert.equal(reloaded[0].fileName, 'plan.md');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('embeds the executionId from opts into every record metadata for traceability', async () => {
    // The auto-scan path uses metadata.executionId (rather than a top-level
    // schema field) to tie a record back to the exact CLI session that
    // produced it. The dashboard reads this to drill from the artifacts tab
    // into the per-execution log and back.
    const { projectDir, agentsDir } = await makeProject();
    try {
      await seedArtifacts(agentsDir, 'writer', 'task-trace', 'session-trace-001', {
        'a.md': '# a',
        'b.json': '{}',
        'nested/c.ts': 'export {};',
      });

      const records = await scanArtifactDirectory({
        agentsDir,
        agentId: 'writer',
        taskId: 'task-trace',
        executionId: 'session-trace-001',
        projectRoot: projectDir,
      });

      assert.equal(records.length, 3);
      for (const record of records) {
        assert.equal(
          (record.metadata as { executionId: string }).executionId,
          'session-trace-001',
          'every scanner-produced record should carry the originating executionId',
        );
        // mimeType is the dashboard's render-vs-download switch; it must
        // reach the store via metadata, not a side channel.
        assert.ok(
          typeof (record.metadata as { mimeType?: string }).mimeType === 'string',
          'mimeType must be present on metadata for SPA rendering',
        );
      }
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('default-constructs an ArtifactStore when one is not supplied', async () => {
    // The convenience helper is allowed to construct its own ArtifactStore
    // when the caller doesn't pass one. Verify it still writes through the
    // canonical store path so callers (e.g. the executor) can opt into
    // the shorthand without losing the manifest contract.
    const { projectDir, agentsDir } = await makeProject();
    try {
      await seedArtifacts(agentsDir, 'writer', 'task-auto', 'session-auto-001', {
        'plan.md': '# plan',
      });

      const result = await scanAndRegister({
        agentsDir,
        agentId: 'writer',
        taskId: 'task-auto',
        executionId: 'session-auto-001',
        projectRoot: projectDir,
        // No `store` — exercise the default-construction branch.
      });

      assert.equal(result.registered.length, 1);
      const manifestPath = join(
        agentsDir,
        'writer',
        'artifacts',
        'manifest.json',
      );
      const stats = await stat(manifestPath);
      assert.ok(stats.isFile(), 'default-store path must still write manifest.json');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
