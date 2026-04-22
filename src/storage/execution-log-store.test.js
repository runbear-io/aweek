import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executionLogPath,
  openExecutionLogWriter,
  executionLogExists,
  readExecutionLogLines,
} from './execution-log-store.js';

async function makeAgentsDir() {
  const root = await mkdtemp(join(tmpdir(), 'aweek-execution-log-'));
  const agentsDir = join(root, 'agents');
  await mkdir(agentsDir, { recursive: true });
  return agentsDir;
}

async function collect(it) {
  const out = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('execution-log-store — executionLogPath', () => {
  it('joins agentsDir/<agent>/executions/<task>_<exec>.jsonl', () => {
    assert.equal(
      executionLogPath('/a/b/agents', 'writer', 'task-abc', 'exec-1'),
      join('/a/b/agents', 'writer', 'executions', 'task-abc_exec-1.jsonl'),
    );
  });

  it('rejects missing arguments', () => {
    assert.throws(() => executionLogPath('', 'a', 't', 'e'), /agentsDir is required/);
    assert.throws(() => executionLogPath('/a', '', 't', 'e'), /agentId is required/);
    assert.throws(() => executionLogPath('/a', 'b', '', 'e'), /taskId is required/);
    assert.throws(() => executionLogPath('/a', 'b', 't', ''), /executionId is required/);
  });
});

describe('execution-log-store — openExecutionLogWriter', () => {
  it('creates the executions directory and writes lines', async () => {
    const agentsDir = await makeAgentsDir();
    const w = await openExecutionLogWriter(agentsDir, 'writer', 'task-1', 'exec-1');

    w.writeLine('{"type":"system","subtype":"init"}');
    w.writeLine('{"type":"user","content":"hello"}');
    await w.close();

    const body = await readFile(w.path, 'utf8');
    assert.equal(
      body,
      '{"type":"system","subtype":"init"}\n{"type":"user","content":"hello"}\n',
    );
  });

  it('appends newlines only when missing (preserves single-line format)', async () => {
    const agentsDir = await makeAgentsDir();
    const w = await openExecutionLogWriter(agentsDir, 'writer', 'task-2', 'exec-1');

    w.writeLine('one');
    w.writeLine('two\n');
    w.writeLine('three');
    await w.close();

    const body = await readFile(w.path, 'utf8');
    assert.equal(body, 'one\ntwo\nthree\n');
  });

  it('redacts obvious secrets before they hit disk', async () => {
    const agentsDir = await makeAgentsDir();
    const w = await openExecutionLogWriter(agentsDir, 'writer', 'task-3', 'exec-1');

    w.writeLine('API_KEY=sk-abcDEF0123456789xyz used');
    w.writeLine('token=ghp_1234567890abcdefghijklmnopqrstuvwxyz');
    await w.close();

    const body = await readFile(w.path, 'utf8');
    assert.ok(!body.includes('sk-abcDEF0123456789xyz'), 'OpenAI-style key leaked');
    assert.ok(!body.includes('ghp_1234567890abcdefghijklmnopqrstuvwxyz'), 'GitHub PAT leaked');
    assert.ok(body.includes('[REDACTED]'));
  });

  it('silently drops empty / non-string lines', async () => {
    const agentsDir = await makeAgentsDir();
    const w = await openExecutionLogWriter(agentsDir, 'writer', 'task-4', 'exec-1');

    w.writeLine('');
    w.writeLine(null);
    w.writeLine(undefined);
    w.writeLine('kept');
    await w.close();

    const body = await readFile(w.path, 'utf8');
    assert.equal(body, 'kept\n');
  });
});

describe('execution-log-store — executionLogExists', () => {
  it('returns false when the file is missing', async () => {
    const agentsDir = await makeAgentsDir();
    assert.equal(
      await executionLogExists(agentsDir, 'writer', 'task-x', 'exec-x'),
      false,
    );
  });

  it('returns true after a write', async () => {
    const agentsDir = await makeAgentsDir();
    const w = await openExecutionLogWriter(agentsDir, 'writer', 'task-y', 'exec-y');
    w.writeLine('line');
    await w.close();

    assert.equal(
      await executionLogExists(agentsDir, 'writer', 'task-y', 'exec-y'),
      true,
    );
  });
});

describe('execution-log-store — readExecutionLogLines', () => {
  it('yields nothing when the file is missing', async () => {
    const agentsDir = await makeAgentsDir();
    const lines = await collect(
      readExecutionLogLines(agentsDir, 'writer', 'task-z', 'exec-z'),
    );
    assert.deepEqual(lines, []);
  });

  it('yields each non-empty line in order', async () => {
    const agentsDir = await makeAgentsDir();
    const path = executionLogPath(agentsDir, 'writer', 'task-r', 'exec-r');
    await mkdir(join(agentsDir, 'writer', 'executions'), { recursive: true });
    await writeFile(
      path,
      '{"type":"system"}\n{"type":"user"}\n\n{"type":"result"}\n',
      'utf8',
    );

    const lines = await collect(
      readExecutionLogLines(agentsDir, 'writer', 'task-r', 'exec-r'),
    );
    assert.deepEqual(lines, [
      '{"type":"system"}',
      '{"type":"user"}',
      '{"type":"result"}',
    ]);
  });
});
