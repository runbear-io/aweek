import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pruneTranscripts, DEFAULT_OLDER_THAN_WEEKS } from './execution.js';

async function makeProject() {
  const dir = await mkdtemp(join(tmpdir(), 'aweek-prune-'));
  await mkdir(join(dir, '.aweek', 'agents'), { recursive: true });
  return dir;
}

async function writeTranscript(projectDir, agentId, basename, { mtime } = {}) {
  const dir = join(projectDir, '.aweek', 'agents', agentId, 'executions');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${basename}.jsonl`);
  await writeFile(path, '{"type":"system"}\n', 'utf8');
  if (mtime) {
    await utimes(path, mtime, mtime);
  }
  return path;
}

describe('execution — pruneTranscripts', () => {
  it('throws when projectDir is missing', async () => {
    await assert.rejects(() => pruneTranscripts({}), /projectDir is required/);
  });

  it('throws when olderThanWeeks is negative', async () => {
    const dir = await makeProject();
    await assert.rejects(
      () => pruneTranscripts({ projectDir: dir, olderThanWeeks: -1 }),
      /must be >= 0/,
    );
  });

  it('returns empty result when .aweek/agents is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aweek-prune-'));
    const result = await pruneTranscripts({ projectDir: dir });
    assert.deepEqual(result.deleted, []);
    assert.equal(result.kept, 0);
    assert.deepEqual(result.scannedAgents, []);
  });

  it('deletes transcripts older than the cutoff and keeps fresh ones', async () => {
    const projectDir = await makeProject();
    const now = new Date('2026-04-21T00:00:00Z');
    const oldMtime = new Date('2026-03-01T00:00:00Z'); // ~7 weeks old
    const freshMtime = new Date('2026-04-20T00:00:00Z');

    const oldPath = await writeTranscript(
      projectDir,
      'writer',
      'task-1_session-1',
      { mtime: oldMtime },
    );
    const freshPath = await writeTranscript(
      projectDir,
      'writer',
      'task-2_session-2',
      { mtime: freshMtime },
    );

    const result = await pruneTranscripts({
      projectDir,
      olderThanWeeks: 4,
      now,
    });

    assert.deepEqual(result.deleted, [oldPath]);
    assert.equal(result.kept, 1);
    assert.deepEqual(result.scannedAgents, ['writer']);

    await assert.rejects(() => stat(oldPath), /ENOENT/);
    const freshStat = await stat(freshPath);
    assert.ok(freshStat.isFile());
  });

  it('scans multiple agents independently', async () => {
    const projectDir = await makeProject();
    const now = new Date('2026-04-21T00:00:00Z');
    const oldMtime = new Date('2026-01-01T00:00:00Z');

    await writeTranscript(projectDir, 'writer', 'task-a_session-a', {
      mtime: oldMtime,
    });
    await writeTranscript(projectDir, 'coder', 'task-b_session-b', {
      mtime: oldMtime,
    });

    const result = await pruneTranscripts({
      projectDir,
      olderThanWeeks: 4,
      now,
    });

    assert.equal(result.deleted.length, 2);
    // Order isn't guaranteed across agents, so compare as a set.
    assert.deepEqual(result.scannedAgents.sort(), ['coder', 'writer']);
  });

  it('ignores non-jsonl files in the executions directory', async () => {
    const projectDir = await makeProject();
    const execDir = join(projectDir, '.aweek', 'agents', 'writer', 'executions');
    await mkdir(execDir, { recursive: true });
    await writeFile(join(execDir, 'README.txt'), 'notes', 'utf8');
    await utimes(
      join(execDir, 'README.txt'),
      new Date('2020-01-01T00:00:00Z'),
      new Date('2020-01-01T00:00:00Z'),
    );

    const result = await pruneTranscripts({
      projectDir,
      olderThanWeeks: 4,
      now: new Date('2026-04-21T00:00:00Z'),
    });

    assert.deepEqual(result.deleted, []);
  });

  it('skips agents that have no executions directory yet', async () => {
    const projectDir = await makeProject();
    await mkdir(join(projectDir, '.aweek', 'agents', 'quiet-bot'), { recursive: true });

    const result = await pruneTranscripts({
      projectDir,
      now: new Date('2026-04-21T00:00:00Z'),
    });
    assert.deepEqual(result.scannedAgents, []);
  });

  it('prunes everything with olderThanWeeks: 0', async () => {
    const projectDir = await makeProject();
    const mtime = new Date('2026-04-20T12:00:00Z');
    await writeTranscript(projectDir, 'writer', 'task-1_session-1', { mtime });

    const result = await pruneTranscripts({
      projectDir,
      olderThanWeeks: 0,
      // Run the prune one second after the mtime so every existing file is
      // strictly older than the cutoff — `olderThanWeeks: 0` is the "prune
      // now" mode and the boundary does not matter here.
      now: new Date(mtime.getTime() + 1000),
    });

    assert.equal(result.deleted.length, 1);
    assert.equal(result.kept, 0);
  });

  it('exports a sensible default retention window', () => {
    assert.equal(DEFAULT_OLDER_THAN_WEEKS, 4);
  });
});
