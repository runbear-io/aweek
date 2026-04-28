/**
 * Tests for the explicit artifact registration skill module.
 *
 * Pins the contract that the dispatcher's `artifact.register` entry point
 * relies on: filePath traversal rejection, manifest persistence via
 * `ArtifactStore.register`, executionId/mimeType/checksum metadata
 * stamping, and the (task, execution) existence preconditions that keep
 * the manifest pointing at real plan tasks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { register, normalizeArtifactFilePath } from './artifact.js';
import { ArtifactStore } from '../storage/artifact-store.js';
import { WeeklyPlanStore, type WeeklyPlan } from '../storage/weekly-plan-store.js';

async function makeProject(): Promise<{ projectDir: string; agentsDir: string }> {
  const projectDir = await mkdtemp(join(tmpdir(), 'aweek-artifact-skill-'));
  const agentsDir = join(projectDir, '.aweek', 'agents');
  await mkdir(agentsDir, { recursive: true });
  return { projectDir, agentsDir };
}

/**
 * Seed a minimal valid weekly plan so the task-existence check passes.
 * The artifact register handler walks every plan for the agent looking
 * for `taskId`, so we stash the test's task IDs into a single plan.
 */
async function seedWeeklyPlan(
  agentsDir: string,
  agentId: string,
  taskIds: string[],
  week = '2026-W17',
): Promise<void> {
  const plan: WeeklyPlan = {
    week,
    month: '2026-04',
    tasks: taskIds.map((id) => ({
      id,
      title: `Title for ${id}`,
      prompt: `Prompt for ${id}`,
      status: 'pending',
    })),
    approved: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const store = new WeeklyPlanStore(agentsDir);
  await store.save(agentId, plan);
}

describe('normalizeArtifactFilePath', () => {
  it('returns a forward-slash project-relative path for inputs already inside the project', () => {
    const projectRoot = '/tmp/proj';
    assert.equal(
      normalizeArtifactFilePath(projectRoot, 'a/b/file.md'),
      'a/b/file.md',
    );
  });

  it('accepts an absolute path that lives inside the project root', () => {
    const projectRoot = resolve('/tmp/proj');
    assert.equal(
      normalizeArtifactFilePath(projectRoot, resolve(projectRoot, 'docs/out.md')),
      'docs/out.md',
    );
  });

  it('rejects paths that escape via "../"', () => {
    assert.throws(
      () => normalizeArtifactFilePath('/tmp/proj', '../escape.md'),
      /escapes the project root/,
    );
  });

  it('rejects absolute paths outside the project root', () => {
    assert.throws(
      () => normalizeArtifactFilePath('/tmp/proj', '/etc/passwd'),
      /escapes the project root/,
    );
  });

  it('rejects the empty string', () => {
    assert.throws(
      () => normalizeArtifactFilePath('/tmp/proj', ''),
      /filePath is required/,
    );
  });

  it('rejects pointing at the project root itself', () => {
    assert.throws(
      () => normalizeArtifactFilePath('/tmp/proj', '.'),
      /must point at a file/,
    );
  });
});

describe('register (explicit artifact registration)', () => {
  it('persists a record via ArtifactStore.register and stamps executionId / mimeType / checksum metadata', async () => {
    const { projectDir, agentsDir } = await makeProject();
    try {
      const execDir = join(agentsDir, 'writer', 'artifacts', 'task-1_session-1');
      await mkdir(execDir, { recursive: true });
      const relPath = '.aweek/agents/writer/artifacts/task-1_session-1/plan.md';
      const fileBody = '# Plan';
      await writeFile(join(projectDir, relPath), fileBody, 'utf-8');
      await seedWeeklyPlan(agentsDir, 'writer', ['task-1']);

      const record = await register({
        projectRoot: projectDir,
        agentsDir,
        agentId: 'writer',
        taskId: 'task-1',
        executionId: 'session-1',
        filePath: relPath,
        type: 'document',
        description: 'Launch plan',
        week: '2026-W17',
        metadata: { source: 'test' },
      });

      assert.match(record.id, /^artifact-[a-f0-9]+$/);
      assert.equal(record.agentId, 'writer');
      assert.equal(record.taskId, 'task-1');
      assert.equal(record.filePath, relPath);
      assert.equal(record.fileName, 'plan.md');
      assert.equal(record.type, 'document');
      assert.equal(record.week, '2026-W17');
      assert.equal(record.sizeBytes, Buffer.byteLength(fileBody, 'utf-8'));

      const meta = record.metadata as Record<string, unknown>;
      assert.equal(meta.executionId, 'session-1');
      assert.equal(meta.source, 'test');
      assert.equal(meta.mimeType, 'text/markdown');
      assert.equal(meta.checksumAlgorithm, 'sha256');
      const expectedChecksum = createHash('sha256').update(fileBody).digest('hex');
      assert.equal(meta.checksum, expectedChecksum);

      // Manifest now contains the record.
      const store = new ArtifactStore(agentsDir, projectDir);
      const loaded = await store.load('writer');
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].id, record.id);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('refuses to register a filePath that escapes the project root', async () => {
    const { projectDir, agentsDir } = await makeProject();
    try {
      await assert.rejects(
        () =>
          register({
            projectRoot: projectDir,
            agentsDir,
            agentId: 'writer',
            taskId: 'task-1',
            executionId: 'session-1',
            filePath: '../etc/passwd',
            type: 'other',
            description: 'should never persist',
          }),
        /escapes the project root/,
      );

      // Manifest must not have been written.
      const store = new ArtifactStore(agentsDir, projectDir);
      const loaded = await store.load('writer');
      assert.deepEqual(loaded, []);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('rejects missing required fields', async () => {
    await assert.rejects(
      // @ts-expect-error — intentional bad input
      () => register({}),
      /projectRoot is required/,
    );
  });

  it('defaults fileName to the basename of filePath when omitted', async () => {
    const { projectDir, agentsDir } = await makeProject();
    try {
      const execDir = join(agentsDir, 'writer', 'artifacts', 'task-2_session-2');
      await mkdir(execDir, { recursive: true });
      const relPath = '.aweek/agents/writer/artifacts/task-2_session-2/nested/report.pdf';
      await mkdir(join(projectDir, '.aweek/agents/writer/artifacts/task-2_session-2/nested'), {
        recursive: true,
      });
      await writeFile(join(projectDir, relPath), 'pdf-bytes', 'utf-8');
      await seedWeeklyPlan(agentsDir, 'writer', ['task-2']);

      const record = await register({
        projectRoot: projectDir,
        agentsDir,
        agentId: 'writer',
        taskId: 'task-2',
        executionId: 'session-2',
        filePath: relPath,
        type: 'report',
        description: 'Quarterly review',
      });

      assert.equal(record.fileName, 'report.pdf');
      const meta = record.metadata as Record<string, unknown>;
      assert.equal(meta.mimeType, 'application/pdf');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('rejects when the on-disk file does not exist (EARTIFACT_FILE_MISSING)', async () => {
    const { projectDir, agentsDir } = await makeProject();
    try {
      const execDir = join(agentsDir, 'writer', 'artifacts', 'task-3_session-3');
      await mkdir(execDir, { recursive: true });
      // Note: do NOT write the file — only the directory exists.
      await seedWeeklyPlan(agentsDir, 'writer', ['task-3']);

      await assert.rejects(
        () =>
          register({
            projectRoot: projectDir,
            agentsDir,
            agentId: 'writer',
            taskId: 'task-3',
            executionId: 'session-3',
            filePath: '.aweek/agents/writer/artifacts/task-3_session-3/missing.md',
            type: 'document',
            description: 'Phantom artifact',
          }),
        (err: NodeJS.ErrnoException) => {
          assert.equal(err.code, 'EARTIFACT_FILE_MISSING');
          assert.match(err.message, /does not exist on disk/);
          return true;
        },
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('rejects when the per-execution directory is missing (EARTIFACT_UNKNOWN_EXECUTION)', async () => {
    const { projectDir, agentsDir } = await makeProject();
    try {
      // Drop the file inside the project but DON'T create the
      // per-execution directory — the executionId is bogus.
      const relPath = '.aweek/random/file.md';
      await mkdir(join(projectDir, '.aweek/random'), { recursive: true });
      await writeFile(join(projectDir, relPath), 'body', 'utf-8');
      await seedWeeklyPlan(agentsDir, 'writer', ['task-4']);

      await assert.rejects(
        () =>
          register({
            projectRoot: projectDir,
            agentsDir,
            agentId: 'writer',
            taskId: 'task-4',
            executionId: 'session-never-ran',
            filePath: relPath,
            type: 'document',
            description: 'should never persist',
          }),
        (err: NodeJS.ErrnoException) => {
          assert.equal(err.code, 'EARTIFACT_UNKNOWN_EXECUTION');
          assert.match(err.message, /Execution directory not found/);
          return true;
        },
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('rejects when the taskId is not in any weekly plan (EARTIFACT_UNKNOWN_TASK)', async () => {
    const { projectDir, agentsDir } = await makeProject();
    try {
      const execDir = join(agentsDir, 'writer', 'artifacts', 'task-ghost_session-5');
      await mkdir(execDir, { recursive: true });
      const relPath = '.aweek/agents/writer/artifacts/task-ghost_session-5/note.md';
      await writeFile(join(projectDir, relPath), 'body', 'utf-8');
      // Seed a plan that contains a *different* taskId so the lookup misses.
      await seedWeeklyPlan(agentsDir, 'writer', ['task-real']);

      await assert.rejects(
        () =>
          register({
            projectRoot: projectDir,
            agentsDir,
            agentId: 'writer',
            taskId: 'task-ghost',
            executionId: 'session-5',
            filePath: relPath,
            type: 'document',
            description: 'orphaned artifact',
          }),
        (err: NodeJS.ErrnoException) => {
          assert.equal(err.code, 'EARTIFACT_UNKNOWN_TASK');
          assert.match(err.message, /not found in any weekly plan/);
          return true;
        },
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('skips the weekly-plan task-existence check when skipTaskExistenceCheck is true', async () => {
    const { projectDir, agentsDir } = await makeProject();
    try {
      const execDir = join(agentsDir, 'writer', 'artifacts', 'adhoc-abcd1234_session-6');
      await mkdir(execDir, { recursive: true });
      const relPath = '.aweek/agents/writer/artifacts/adhoc-abcd1234_session-6/scratch.txt';
      await writeFile(join(projectDir, relPath), 'scratch body', 'utf-8');
      // No weekly plan seeded — caller must skip the check.

      const record = await register({
        projectRoot: projectDir,
        agentsDir,
        agentId: 'writer',
        taskId: 'adhoc-abcd1234',
        executionId: 'session-6',
        filePath: relPath,
        type: 'other',
        description: 'ad-hoc scratch',
        skipTaskExistenceCheck: true,
      });

      assert.equal(record.taskId, 'adhoc-abcd1234');
      const meta = record.metadata as Record<string, unknown>;
      assert.equal(meta.mimeType, 'text/plain');
      assert.equal(meta.checksumAlgorithm, 'sha256');
      assert.equal(typeof meta.checksum, 'string');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
