/**
 * Tests for the per-agent dotenv loader.
 *
 * Migrated to TypeScript as part of seed-01-storage-A. The test file is
 * excluded from `tsc --noEmit -p tsconfig.node.json` (see the
 * `src/**\/*.test.ts` glob in that config's `exclude` block), so this
 * module is parsed by `tsx` at test time but does not participate in the
 * type-check pass — keeping the type surface lightweight is fine here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_ENV_FILENAME,
  envPath,
  parseEnvFile,
  loadAgentEnv,
} from './agent-env-store.js';

async function makeAgentsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aweek-env-'));
  const agentsDir = join(root, 'agents');
  await mkdir(agentsDir, { recursive: true });
  return agentsDir;
}

describe('agent-env-store — envPath', () => {
  it('joins agentsDir/<slug>/.env', () => {
    assert.equal(
      envPath('/a/b/agents', 'writer'),
      join('/a/b/agents', 'writer', AGENT_ENV_FILENAME),
    );
  });

  it('throws on missing args', () => {
    assert.throws(() => envPath('', 'x'), /agentsDir is required/);
    assert.throws(() => envPath('/a', ''), /agentId is required/);
  });
});

describe('agent-env-store — parseEnvFile', () => {
  it('returns {} for empty / non-string input', () => {
    assert.deepEqual(parseEnvFile(''), {});
    assert.deepEqual(parseEnvFile(null), {});
    assert.deepEqual(parseEnvFile(undefined), {});
  });

  it('parses simple KEY=value pairs', () => {
    const env = parseEnvFile('A=1\nB=two\nC=three');
    assert.deepEqual(env, { A: '1', B: 'two', C: 'three' });
  });

  it('ignores blank lines and full-line comments', () => {
    const env = parseEnvFile('# comment\n\nA=1\n  # indented comment\nB=2\n');
    assert.deepEqual(env, { A: '1', B: '2' });
  });

  it('accepts `export KEY=value` (POSIX-style)', () => {
    const env = parseEnvFile('export A=1\n  export\tB=two\n');
    assert.deepEqual(env, { A: '1', B: 'two' });
  });

  it('trims unquoted values and strips inline comments after whitespace', () => {
    const env = parseEnvFile('A=  hello   # trailing comment\nB=world');
    assert.deepEqual(env, { A: 'hello', B: 'world' });
  });

  it('does NOT treat `#` as a comment when not preceded by whitespace', () => {
    const env = parseEnvFile('TAG=v1.2#beta');
    assert.deepEqual(env, { TAG: 'v1.2#beta' });
  });

  it('reads single-quoted values verbatim (no escaping)', () => {
    const env = parseEnvFile("A='hello world'\nB='a\\nb'\nC='has # hash'");
    assert.deepEqual(env, { A: 'hello world', B: 'a\\nb', C: 'has # hash' });
  });

  it('unescapes \\n \\r \\t \\\\ \\" inside double quotes', () => {
    const env = parseEnvFile('A="line1\\nline2"\nB="tab\\there"\nC="he said \\"hi\\""');
    assert.deepEqual(env, {
      A: 'line1\nline2',
      B: 'tab\there',
      C: 'he said "hi"',
    });
  });

  it('ignores `#` inside quoted values', () => {
    const env = parseEnvFile('A="has # hash"\nB=\'also # hash\'');
    assert.deepEqual(env, { A: 'has # hash', B: 'also # hash' });
  });

  it('keeps `=` characters inside values (only first `=` splits)', () => {
    const env = parseEnvFile('URL=postgres://u:p=hunter2@host/db');
    assert.deepEqual(env, { URL: 'postgres://u:p=hunter2@host/db' });
  });

  it('rejects invalid key names (starts with digit, has dash)', () => {
    const env = parseEnvFile('1BAD=x\nALSO-BAD=y\nGOOD=z');
    assert.deepEqual(env, { GOOD: 'z' });
  });

  it('skips lines without `=`', () => {
    const env = parseEnvFile('not an env line\nA=1');
    assert.deepEqual(env, { A: '1' });
  });

  it('skips lines with unterminated quotes rather than throwing', () => {
    const env = parseEnvFile('A="missing close\nB=ok');
    assert.deepEqual(env, { B: 'ok' });
  });

  it('last assignment wins on duplicate keys', () => {
    const env = parseEnvFile('A=1\nA=2\nA=3');
    assert.deepEqual(env, { A: '3' });
  });

  it('empty value → empty string', () => {
    const env = parseEnvFile('A=\nB=   ');
    assert.deepEqual(env, { A: '', B: '' });
  });
});

describe('agent-env-store — loadAgentEnv', () => {
  it('returns {} when the file is missing', async () => {
    const agentsDir = await makeAgentsDir();
    const env = await loadAgentEnv(agentsDir, 'writer');
    assert.deepEqual(env, {});
  });

  it('returns parsed env when the file exists', async () => {
    const agentsDir = await makeAgentsDir();
    await mkdir(join(agentsDir, 'writer'), { recursive: true });
    await writeFile(
      join(agentsDir, 'writer', AGENT_ENV_FILENAME),
      'OPENAI_API_KEY=sk-test\nREGION=us-west-2\n',
    );
    const env = await loadAgentEnv(agentsDir, 'writer');
    assert.deepEqual(env, { OPENAI_API_KEY: 'sk-test', REGION: 'us-west-2' });
  });

  it('is isolated per agent', async () => {
    const agentsDir = await makeAgentsDir();
    await mkdir(join(agentsDir, 'writer'), { recursive: true });
    await mkdir(join(agentsDir, 'coder'), { recursive: true });
    await writeFile(join(agentsDir, 'writer', AGENT_ENV_FILENAME), 'ROLE=writer\n');
    await writeFile(join(agentsDir, 'coder', AGENT_ENV_FILENAME), 'ROLE=coder\n');

    assert.deepEqual(await loadAgentEnv(agentsDir, 'writer'), { ROLE: 'writer' });
    assert.deepEqual(await loadAgentEnv(agentsDir, 'coder'), { ROLE: 'coder' });
  });
});
