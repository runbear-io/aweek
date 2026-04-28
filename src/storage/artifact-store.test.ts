/**
 * Tests for ArtifactStore — deliverable artifact persistence.
 *
 * The runtime/contract assertions are unchanged from the original `.js`
 * test — this file is the strict-mode TypeScript port that lands as part
 * of seed-03-storage-C-final's storage migration. Types are imported
 * from the migrated `./artifact-store.js` source via NodeNext extension
 * resolution; the record shape is inferred from the factory's return
 * type so the test stays in lockstep with the source without forcing
 * a hard re-export of an internal type alias.
 *
 * Covers:
 * - createArtifactRecord() — factory with defaults and optional fields
 * - ArtifactStore.register() — single artifact registration (idempotent)
 * - ArtifactStore.registerBatch() — multi-artifact registration
 * - ArtifactStore.load() — load manifest (empty on missing)
 * - ArtifactStore.remove() — remove record (idempotent, file untouched)
 * - ArtifactStore.query() — filter by taskId, type, week
 * - ArtifactStore.verify() — check which artifacts exist on disk
 * - ArtifactStore.summary() — aggregate counts by type and size
 * - ArtifactStore.listAll() — list artifacts across all agents
 * - Schema validation — rejects invalid records
 * - getFileSize / artifactFileExists — utility functions
 * - Auto-size population — sizeBytes auto-populated from disk
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ArtifactStore,
  createArtifactRecord,
  getFileSize,
  artifactFileExists,
  resolveArtifactDir,
} from './artifact-store.js';
import { validateArtifactRecord, validateArtifactManifest } from '../schemas/validator.js';

/**
 * Inferred from the migrated `createArtifactRecord` factory so the
 * test stays in lockstep with the source's declared return shape.
 */
type ArtifactRecord = ReturnType<typeof createArtifactRecord>;

describe('resolveArtifactDir', () => {
  it('joins dataDir/<slug>/artifacts/<taskId>_<executionId>', () => {
    assert.equal(
      resolveArtifactDir('/a/b/agents', 'writer', 'task-abc', 'session-1'),
      join('/a/b/agents', 'writer', 'artifacts', 'task-abc_session-1'),
    );
  });

  it('uses `_` as the separator between taskId and executionId', () => {
    // Both IDs may legitimately contain `-` (task-<slug>, session-<ts>);
    // `_` is the unambiguous split point that lets consumers recover the
    // original pair from the basename.
    const dir = resolveArtifactDir('/data', 'agent', 'task-foo-bar', 'session-2026-04-27');
    const basename = dir.split('/').pop()!;
    assert.equal(basename, 'task-foo-bar_session-2026-04-27');
    const [taskId, executionId] = basename.split('_', 2);
    assert.equal(taskId, 'task-foo-bar');
    assert.equal(executionId, 'session-2026-04-27');
  });

  it('mirrors execution-log-store partitioning so log + artifacts are co-keyed', () => {
    // Sibling layout under <agentsDir>/<slug>/:
    //   executions/<taskId>_<executionId>.jsonl   (execution-log-store)
    //   artifacts/<taskId>_<executionId>/         (this helper)
    const dir = resolveArtifactDir('/agents', 'writer', 'task-1', 'exec-1');
    assert.equal(dir, join('/agents', 'writer', 'artifacts', 'task-1_exec-1'));
  });

  it('rejects missing arguments', () => {
    assert.throws(() => resolveArtifactDir('', 'a', 't', 'e'), /dataDir is required/);
    assert.throws(() => resolveArtifactDir('/a', '', 't', 'e'), /slug is required/);
    assert.throws(() => resolveArtifactDir('/a', 'b', '', 'e'), /taskId is required/);
    assert.throws(() => resolveArtifactDir('/a', 'b', 't', ''), /executionId is required/);
  });

  it('returns a directory path (no trailing slash, no file extension)', () => {
    const dir = resolveArtifactDir('/agents', 'writer', 'task-1', 'exec-1');
    assert.ok(!dir.endsWith('/'), 'should not have a trailing slash');
    assert.ok(!dir.endsWith('.jsonl'), 'should not be confused with the execution log file');
  });
});

describe('createArtifactRecord', () => {
  it('creates a valid record with required fields', () => {
    const record = createArtifactRecord({
      agentId: 'agent-1',
      taskId: 'task-1',
      filePath: 'output/report.md',
      fileName: 'Weekly Report',
      type: 'document',
      description: 'Weekly progress report',
    });

    assert.ok(record.id.startsWith('artifact-'));
    assert.equal(record.agentId, 'agent-1');
    assert.equal(record.taskId, 'task-1');
    assert.equal(record.filePath, 'output/report.md');
    assert.equal(record.fileName, 'Weekly Report');
    assert.equal(record.type, 'document');
    assert.equal(record.description, 'Weekly progress report');
    assert.ok(record.createdAt);

    const result = validateArtifactRecord(record);
    assert.ok(result.valid, `Validation errors: ${JSON.stringify(result.errors)}`);
  });

  it('includes optional fields when provided', () => {
    const record = createArtifactRecord({
      agentId: 'agent-1',
      taskId: 'task-1',
      filePath: 'src/utils.js',
      fileName: 'utils.js',
      type: 'code',
      description: 'Utility functions',
      week: '2026-W16',
      sizeBytes: 1024,
      metadata: { language: 'javascript' },
    });

    assert.equal(record.week, '2026-W16');
    assert.equal(record.sizeBytes, 1024);
    assert.deepEqual(record.metadata, { language: 'javascript' });

    const result = validateArtifactRecord(record);
    assert.ok(result.valid);
  });

  it('omits optional fields when not provided', () => {
    const record = createArtifactRecord({
      agentId: 'agent-1',
      taskId: 'task-1',
      filePath: 'output/data.json',
      fileName: 'data.json',
      type: 'data',
      description: 'Processed data output',
    });

    assert.equal(record.week, undefined);
    assert.equal(record.sizeBytes, undefined);
    assert.equal(record.metadata, undefined);
  });

  it('generates unique IDs', () => {
    const r1 = createArtifactRecord({ agentId: 'a', taskId: 't', filePath: 'f', fileName: 'f', type: 'other', description: 'd' });
    const r2 = createArtifactRecord({ agentId: 'a', taskId: 't', filePath: 'f', fileName: 'f', type: 'other', description: 'd' });
    assert.notEqual(r1.id, r2.id);
  });
});

describe('Schema validation', () => {
  it('rejects record with missing required fields', () => {
    const result = validateArtifactRecord({ id: 'artifact-abc', agentId: 'a' });
    assert.equal(result.valid, false);
  });

  it('rejects record with invalid type', () => {
    const result = validateArtifactRecord({
      id: 'artifact-abc12345',
      agentId: 'a',
      taskId: 't',
      filePath: 'f',
      fileName: 'f',
      type: 'invalid-type',
      description: 'd',
      createdAt: new Date().toISOString(),
    });
    assert.equal(result.valid, false);
  });

  it('rejects record with invalid id pattern', () => {
    const result = validateArtifactRecord({
      id: 'bad-id',
      agentId: 'a',
      taskId: 't',
      filePath: 'f',
      fileName: 'f',
      type: 'code',
      description: 'd',
      createdAt: new Date().toISOString(),
    });
    assert.equal(result.valid, false);
  });

  it('validates a manifest (array of records)', () => {
    const records: ArtifactRecord[] = [
      createArtifactRecord({ agentId: 'a', taskId: 't1', filePath: 'f1', fileName: 'f1', type: 'code', description: 'd1' }),
      createArtifactRecord({ agentId: 'a', taskId: 't2', filePath: 'f2', fileName: 'f2', type: 'document', description: 'd2' }),
    ];
    const result = validateArtifactManifest(records);
    assert.ok(result.valid);
  });

  it('validates empty manifest', () => {
    const result = validateArtifactManifest([]);
    assert.ok(result.valid);
  });
});

describe('getFileSize / artifactFileExists', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'artifact-util-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns file size for existing file', async () => {
    const content = 'hello world';
    await writeFile(join(tmpDir, 'test.txt'), content, 'utf-8');
    const size = await getFileSize(tmpDir, 'test.txt');
    assert.equal(size, Buffer.byteLength(content));
  });

  it('returns undefined for nonexistent file', async () => {
    const size = await getFileSize(tmpDir, 'nope.txt');
    assert.equal(size, undefined);
  });

  it('returns true for existing file', async () => {
    await writeFile(join(tmpDir, 'exists.txt'), 'x', 'utf-8');
    assert.ok(await artifactFileExists(tmpDir, 'exists.txt'));
  });

  it('returns false for nonexistent file', async () => {
    assert.equal(await artifactFileExists(tmpDir, 'gone.txt'), false);
  });
});

describe('ArtifactStore', () => {
  let tmpDir: string;
  let projectDir: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    projectDir = await mkdtemp(join(tmpdir(), 'artifact-project-'));
    store = new ArtifactStore(tmpDir, projectDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('returns empty array when no manifest exists', async () => {
      const records = await store.load('agent-1');
      assert.deepEqual(records, []);
    });

    it('loads existing manifest', async () => {
      const record = createArtifactRecord({
        agentId: 'agent-1',
        taskId: 'task-1',
        filePath: 'output/file.md',
        fileName: 'file.md',
        type: 'document',
        description: 'A file',
      });
      await store.register('agent-1', record, { autoSize: false });

      const loaded = await store.load('agent-1');
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].id, record.id);
    });
  });

  describe('register', () => {
    it('registers a new artifact record', async () => {
      const record = createArtifactRecord({
        agentId: 'agent-1',
        taskId: 'task-1',
        filePath: 'docs/readme.md',
        fileName: 'readme.md',
        type: 'document',
        description: 'Project readme',
      });

      const result = await store.register('agent-1', record, { autoSize: false });
      assert.equal(result.id, record.id);

      const loaded = await store.load('agent-1');
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].filePath, 'docs/readme.md');
    });

    it('is idempotent — duplicate ID not added', async () => {
      const record = createArtifactRecord({
        agentId: 'agent-1',
        taskId: 'task-1',
        filePath: 'file.txt',
        fileName: 'file.txt',
        type: 'other',
        description: 'test',
      });

      await store.register('agent-1', record, { autoSize: false });
      await store.register('agent-1', record, { autoSize: false });

      const loaded = await store.load('agent-1');
      assert.equal(loaded.length, 1);
    });

    it('auto-populates sizeBytes from file on disk', async () => {
      const content = 'artifact content here';
      await mkdir(join(projectDir, 'output'), { recursive: true });
      await writeFile(join(projectDir, 'output', 'report.txt'), content, 'utf-8');

      const record = createArtifactRecord({
        agentId: 'agent-1',
        taskId: 'task-1',
        filePath: 'output/report.txt',
        fileName: 'report.txt',
        type: 'document',
        description: 'Report',
      });

      const result = await store.register('agent-1', record);
      assert.equal(result.sizeBytes, Buffer.byteLength(content));
    });

    it('does not overwrite explicit sizeBytes', async () => {
      const record = createArtifactRecord({
        agentId: 'agent-1',
        taskId: 'task-1',
        filePath: 'file.txt',
        fileName: 'file.txt',
        type: 'other',
        description: 'test',
        sizeBytes: 999,
      });

      const result = await store.register('agent-1', record);
      assert.equal(result.sizeBytes, 999);
    });

    it('rejects invalid records', async () => {
      await assert.rejects(
        () => store.register('agent-1', { id: 'bad', agentId: 'a' } as unknown as ArtifactRecord),
        /Schema validation failed/,
      );
    });
  });

  describe('registerBatch', () => {
    it('registers multiple records at once', async () => {
      const records: ArtifactRecord[] = [
        createArtifactRecord({ agentId: 'a', taskId: 't1', filePath: 'f1.js', fileName: 'f1.js', type: 'code', description: 'd1' }),
        createArtifactRecord({ agentId: 'a', taskId: 't2', filePath: 'f2.md', fileName: 'f2.md', type: 'document', description: 'd2' }),
      ];

      const added = await store.registerBatch('a', records, { autoSize: false });
      assert.equal(added.length, 2);

      const loaded = await store.load('a');
      assert.equal(loaded.length, 2);
    });

    it('skips duplicates in batch', async () => {
      const record = createArtifactRecord({ agentId: 'a', taskId: 't', filePath: 'f', fileName: 'f', type: 'other', description: 'd' });
      await store.register('a', record, { autoSize: false });

      const added = await store.registerBatch('a', [record], { autoSize: false });
      assert.equal(added.length, 0);

      const loaded = await store.load('a');
      assert.equal(loaded.length, 1);
    });

    it('handles empty batch', async () => {
      const added = await store.registerBatch('a', []);
      assert.equal(added.length, 0);
    });
  });

  describe('remove', () => {
    it('removes an existing record', async () => {
      const record = createArtifactRecord({ agentId: 'a', taskId: 't', filePath: 'f', fileName: 'f', type: 'code', description: 'd' });
      await store.register('a', record, { autoSize: false });

      const removed = await store.remove('a', record.id);
      assert.ok(removed);

      const loaded = await store.load('a');
      assert.equal(loaded.length, 0);
    });

    it('is idempotent — removing nonexistent returns false', async () => {
      const removed = await store.remove('a', 'artifact-nonexistent');
      assert.equal(removed, false);
    });
  });

  describe('query', () => {
    let records: ArtifactRecord[];

    beforeEach(async () => {
      records = [
        createArtifactRecord({ agentId: 'a', taskId: 'task-1', filePath: 'f1', fileName: 'f1', type: 'code', description: 'd1', week: '2026-W16' }),
        createArtifactRecord({ agentId: 'a', taskId: 'task-1', filePath: 'f2', fileName: 'f2', type: 'document', description: 'd2', week: '2026-W16' }),
        createArtifactRecord({ agentId: 'a', taskId: 'task-2', filePath: 'f3', fileName: 'f3', type: 'code', description: 'd3', week: '2026-W17' }),
      ];
      await store.registerBatch('a', records, { autoSize: false });
    });

    it('returns all records with no filters', async () => {
      const result = await store.query('a');
      assert.equal(result.length, 3);
    });

    it('filters by taskId', async () => {
      const result = await store.query('a', { taskId: 'task-1' });
      assert.equal(result.length, 2);
    });

    it('filters by type', async () => {
      const result = await store.query('a', { type: 'code' });
      assert.equal(result.length, 2);
    });

    it('filters by week', async () => {
      const result = await store.query('a', { week: '2026-W17' });
      assert.equal(result.length, 1);
      assert.equal(result[0].taskId, 'task-2');
    });

    it('combines multiple filters', async () => {
      const result = await store.query('a', { taskId: 'task-1', type: 'code' });
      assert.equal(result.length, 1);
    });

    it('returns empty for no matches', async () => {
      const result = await store.query('a', { type: 'report' });
      assert.equal(result.length, 0);
    });
  });

  describe('verify', () => {
    it('partitions records into existing and missing', async () => {
      // Create one real file
      await mkdir(join(projectDir, 'output'), { recursive: true });
      await writeFile(join(projectDir, 'output', 'exists.txt'), 'data', 'utf-8');

      const r1 = createArtifactRecord({ agentId: 'a', taskId: 't', filePath: 'output/exists.txt', fileName: 'exists.txt', type: 'data', description: 'exists' });
      const r2 = createArtifactRecord({ agentId: 'a', taskId: 't', filePath: 'output/gone.txt', fileName: 'gone.txt', type: 'data', description: 'gone' });

      await store.registerBatch('a', [r1, r2], { autoSize: false });

      const { existing, missing } = await store.verify('a');
      assert.equal(existing.length, 1);
      assert.equal(existing[0].filePath, 'output/exists.txt');
      assert.equal(missing.length, 1);
      assert.equal(missing[0].filePath, 'output/gone.txt');
    });

    it('returns empty arrays for agent with no artifacts', async () => {
      const { existing, missing } = await store.verify('nobody');
      assert.equal(existing.length, 0);
      assert.equal(missing.length, 0);
    });
  });

  describe('summary', () => {
    it('returns aggregate counts and size', async () => {
      const records: ArtifactRecord[] = [
        createArtifactRecord({ agentId: 'a', taskId: 't1', filePath: 'f1', fileName: 'f1', type: 'code', description: 'd1', sizeBytes: 100 }),
        createArtifactRecord({ agentId: 'a', taskId: 't2', filePath: 'f2', fileName: 'f2', type: 'code', description: 'd2', sizeBytes: 200 }),
        createArtifactRecord({ agentId: 'a', taskId: 't3', filePath: 'f3', fileName: 'f3', type: 'document', description: 'd3', sizeBytes: 50 }),
      ];
      await store.registerBatch('a', records, { autoSize: false });

      const summary = await store.summary('a');
      assert.equal(summary.agentId, 'a');
      assert.equal(summary.totalArtifacts, 3);
      assert.equal(summary.byType.code, 2);
      assert.equal(summary.byType.document, 1);
      assert.equal(summary.totalSizeBytes, 350);
    });

    it('returns zero summary for empty agent', async () => {
      const summary = await store.summary('nobody');
      assert.equal(summary.totalArtifacts, 0);
      assert.equal(summary.totalSizeBytes, 0);
      assert.deepEqual(summary.byType, {});
    });
  });

  describe('listAll', () => {
    it('lists artifacts across multiple agents', async () => {
      const r1 = createArtifactRecord({ agentId: 'a1', taskId: 't', filePath: 'f1', fileName: 'f1', type: 'code', description: 'd' });
      const r2 = createArtifactRecord({ agentId: 'a2', taskId: 't', filePath: 'f2', fileName: 'f2', type: 'document', description: 'd' });

      await store.register('a1', r1, { autoSize: false });
      await store.register('a2', r2, { autoSize: false });

      const all = await store.listAll();
      assert.equal(all.length, 2);
    });

    it('returns empty array when no agents exist', async () => {
      const emptyStore = new ArtifactStore(join(tmpDir, 'empty'), projectDir);
      const all = await emptyStore.listAll();
      assert.equal(all.length, 0);
    });
  });

  describe('rich metadata fields', () => {
    // The schema promotes executionId / relpath / mime / checksum /
    // checksumAlgorithm to top-level optional fields so the dashboard can
    // render them without unpacking the legacy `metadata` bag. These
    // tests exercise the createArtifactRecord factory, schema validation,
    // and ArtifactStore.register round-trip for each new field, plus the
    // backward-compatibility path (records without the new fields still
    // validate and load).

    it('createArtifactRecord forwards executionId / relpath / mime / checksum / checksumAlgorithm', () => {
      const record = createArtifactRecord({
        agentId: 'agent-1',
        taskId: 'task-1',
        filePath: '.aweek/agents/agent-1/artifacts/task-1_session-42/nested/report.md',
        fileName: 'nested/report.md',
        type: 'report',
        description: 'Weekly report',
        executionId: 'session-42',
        relpath: 'nested/report.md',
        mime: 'text/markdown',
        checksum: 'deadbeefcafefeed',
        checksumAlgorithm: 'sha256',
      });

      assert.equal(record.executionId, 'session-42');
      assert.equal(record.relpath, 'nested/report.md');
      assert.equal(record.mime, 'text/markdown');
      assert.equal(record.checksum, 'deadbeefcafefeed');
      assert.equal(record.checksumAlgorithm, 'sha256');

      const result = validateArtifactRecord(record);
      assert.ok(result.valid, `Validation errors: ${JSON.stringify(result.errors)}`);
    });

    it('createArtifactRecord omits the new fields when not provided', () => {
      const record = createArtifactRecord({
        agentId: 'agent-1',
        taskId: 'task-1',
        filePath: 'output/data.json',
        fileName: 'data.json',
        type: 'data',
        description: 'data',
      });

      assert.equal(record.executionId, undefined);
      assert.equal(record.relpath, undefined);
      assert.equal(record.mime, undefined);
      assert.equal(record.checksum, undefined);
      assert.equal(record.checksumAlgorithm, undefined);

      const result = validateArtifactRecord(record);
      assert.ok(result.valid);
    });

    it('schema rejects empty-string values for the rich-metadata fields', () => {
      const baseFields = {
        id: 'artifact-abcd1234',
        agentId: 'a',
        taskId: 't',
        filePath: 'f',
        fileName: 'f',
        type: 'document' as const,
        description: 'd',
        createdAt: new Date().toISOString(),
      };

      assert.equal(validateArtifactRecord({ ...baseFields, executionId: '' }).valid, false);
      assert.equal(validateArtifactRecord({ ...baseFields, relpath: '' }).valid, false);
      assert.equal(validateArtifactRecord({ ...baseFields, mime: '' }).valid, false);
      assert.equal(validateArtifactRecord({ ...baseFields, checksum: '' }).valid, false);
    });

    it('schema rejects a non-hex checksum and an unknown checksumAlgorithm', () => {
      const baseFields = {
        id: 'artifact-abcd1234',
        agentId: 'a',
        taskId: 't',
        filePath: 'f',
        fileName: 'f',
        type: 'document' as const,
        description: 'd',
        createdAt: new Date().toISOString(),
      };

      // Non-hex chars in checksum
      assert.equal(
        validateArtifactRecord({ ...baseFields, checksum: 'not-hex!!' }).valid,
        false,
      );
      // Algorithm outside the enum (e.g. blake3 isn't supported yet)
      assert.equal(
        validateArtifactRecord({ ...baseFields, checksumAlgorithm: 'blake3' }).valid,
        false,
      );
    });

    it('register persists the rich metadata round-trip via load()', async () => {
      const record = createArtifactRecord({
        agentId: 'agent-1',
        taskId: 'task-1',
        filePath: '.aweek/agents/agent-1/artifacts/task-1_session-7/notes.md',
        fileName: 'notes.md',
        type: 'document',
        description: 'Notes',
        executionId: 'session-7',
        relpath: 'notes.md',
        mime: 'text/markdown',
        checksum: 'abcdef0123456789',
        checksumAlgorithm: 'sha256',
      });

      await store.register('agent-1', record, { autoSize: false });

      const loaded = await store.load('agent-1');
      assert.equal(loaded.length, 1);
      const stored = loaded[0];
      assert.equal(stored.id, record.id);
      assert.equal(stored.executionId, 'session-7');
      assert.equal(stored.relpath, 'notes.md');
      assert.equal(stored.mime, 'text/markdown');
      assert.equal(stored.checksum, 'abcdef0123456789');
      assert.equal(stored.checksumAlgorithm, 'sha256');
    });

    it('register survives across store instances (rich fields persist)', async () => {
      const record = createArtifactRecord({
        agentId: 'agent-1',
        taskId: 'task-9',
        filePath: '.aweek/agents/agent-1/artifacts/task-9_session-9/out.bin',
        fileName: 'out.bin',
        type: 'other',
        description: 'binary blob',
        executionId: 'session-9',
        relpath: 'out.bin',
        mime: 'application/octet-stream',
        checksum: 'CAFEBABE',
        checksumAlgorithm: 'sha256',
      });

      await store.register('agent-1', record, { autoSize: false });

      // New store instance against the same on-disk manifest; rich
      // metadata must round-trip identically (no fields dropped during
      // load → save → load).
      const store2 = new ArtifactStore(tmpDir, projectDir);
      const loaded = await store2.load('agent-1');
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].executionId, 'session-9');
      assert.equal(loaded[0].relpath, 'out.bin');
      assert.equal(loaded[0].mime, 'application/octet-stream');
      assert.equal(loaded[0].checksum, 'CAFEBABE');
      assert.equal(loaded[0].checksumAlgorithm, 'sha256');
    });

    it('registerBatch persists the rich metadata for every record', async () => {
      const records: ArtifactRecord[] = [
        createArtifactRecord({
          agentId: 'a',
          taskId: 't',
          filePath: 'a.md',
          fileName: 'a.md',
          type: 'document',
          description: 'a',
          executionId: 'session-1',
          relpath: 'a.md',
          mime: 'text/markdown',
          checksum: 'aaaa',
          checksumAlgorithm: 'sha256',
        }),
        createArtifactRecord({
          agentId: 'a',
          taskId: 't',
          filePath: 'b.md',
          fileName: 'b.md',
          type: 'document',
          description: 'b',
          executionId: 'session-1',
          relpath: 'b.md',
          mime: 'text/markdown',
          checksum: 'bbbb',
          checksumAlgorithm: 'sha256',
        }),
      ];

      const added = await store.registerBatch('a', records, { autoSize: false });
      assert.equal(added.length, 2);

      const loaded = await store.load('a');
      assert.equal(loaded.length, 2);
      const byChecksum = new Map(loaded.map((r) => [r.checksum, r]));
      assert.equal(byChecksum.get('aaaa')?.executionId, 'session-1');
      assert.equal(byChecksum.get('aaaa')?.relpath, 'a.md');
      assert.equal(byChecksum.get('aaaa')?.mime, 'text/markdown');
      assert.equal(byChecksum.get('aaaa')?.checksumAlgorithm, 'sha256');
      assert.equal(byChecksum.get('bbbb')?.executionId, 'session-1');
      assert.equal(byChecksum.get('bbbb')?.relpath, 'b.md');
    });

    it('legacy records without the rich-metadata fields still validate and load', async () => {
      // Older records (pre-promotion) only carry the required fields plus
      // optional week / sizeBytes / metadata. They must keep loading without
      // forced migration so existing manifests aren't rejected.
      const legacy = createArtifactRecord({
        agentId: 'a',
        taskId: 't',
        filePath: 'legacy.md',
        fileName: 'legacy.md',
        type: 'document',
        description: 'legacy record',
      });
      await store.register('a', legacy, { autoSize: false });

      const loaded = await store.load('a');
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].executionId, undefined);
      assert.equal(loaded[0].relpath, undefined);
      assert.equal(loaded[0].mime, undefined);
      assert.equal(loaded[0].checksum, undefined);
      assert.equal(loaded[0].checksumAlgorithm, undefined);
    });

    it('schema rejects unknown top-level fields (additionalProperties: false guard)', () => {
      // The promotion adds new top-level fields; the additionalProperties
      // guard in the schema must still block typos / drift so a misspelled
      // `mim` or `executionID` is caught at validation time instead of
      // silently shadowing the canonical field.
      const result = validateArtifactRecord({
        id: 'artifact-deadbeef',
        agentId: 'a',
        taskId: 't',
        filePath: 'f',
        fileName: 'f',
        type: 'document',
        description: 'd',
        createdAt: new Date().toISOString(),
        executionID: 'session-1', // wrong case
      });
      assert.equal(result.valid, false);
    });
  });

  describe('file persistence', () => {
    it('persists artifacts in manifest.json that survives store recreation', async () => {
      const record = createArtifactRecord({
        agentId: 'agent-1',
        taskId: 'task-1',
        filePath: 'output/deliverable.pdf',
        fileName: 'deliverable.pdf',
        type: 'report',
        description: 'Final deliverable',
        week: '2026-W16',
      });

      await store.register('agent-1', record, { autoSize: false });

      // Create a new store instance pointing at the same directory
      const store2 = new ArtifactStore(tmpDir, projectDir);
      const loaded = await store2.load('agent-1');
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].id, record.id);
      assert.equal(loaded[0].filePath, 'output/deliverable.pdf');
      assert.equal(loaded[0].type, 'report');
    });

    it('artifact files in project folder are independent of manifest', async () => {
      // Create a real file in the project folder
      await mkdir(join(projectDir, 'deliverables'), { recursive: true });
      const deliverablePath = join(projectDir, 'deliverables', 'analysis.md');
      await writeFile(deliverablePath, '# Analysis\n\nResults here.\n', 'utf-8');

      // Register it
      const record = createArtifactRecord({
        agentId: 'agent-1',
        taskId: 'task-1',
        filePath: 'deliverables/analysis.md',
        fileName: 'analysis.md',
        type: 'document',
        description: 'Analysis document',
      });
      await store.register('agent-1', record);

      // Verify the file persists and is tracked
      const { existing } = await store.verify('agent-1');
      assert.equal(existing.length, 1);
      assert.equal(existing[0].filePath, 'deliverables/analysis.md');
      assert.ok((existing[0].sizeBytes ?? 0) > 0, 'sizeBytes should be auto-populated');
    });
  });
});
