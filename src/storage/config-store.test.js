/**
 * Tests for the tiny .aweek/config.json store.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_TZ } from '../time/zone.js';
import { configPath, loadConfig, saveConfig } from './config-store.js';

async function tempDataDir() {
  const base = await mkdtemp(join(tmpdir(), 'aweek-config-'));
  const dataDir = join(base, '.aweek', 'agents');
  await mkdir(dataDir, { recursive: true });
  return { base, dataDir };
}

describe('config-store', () => {
  it('configPath points at <dataDir>/../config.json', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      assert.equal(configPath(dataDir), join(base, '.aweek', 'config.json'));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('loadConfig returns defaults when no file exists', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const cfg = await loadConfig(dataDir);
      assert.equal(cfg.timeZone, DEFAULT_TZ);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('saveConfig writes and loadConfig reads the same timeZone', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await saveConfig(dataDir, { timeZone: 'America/Los_Angeles' });
      const cfg = await loadConfig(dataDir);
      assert.equal(cfg.timeZone, 'America/Los_Angeles');
      // And the file is a pretty-printed JSON document.
      const raw = await readFile(configPath(dataDir), 'utf8');
      assert.match(raw, /"timeZone": "America\/Los_Angeles"/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('saveConfig rejects invalid timeZone names', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await assert.rejects(
        () => saveConfig(dataDir, { timeZone: 'Not/Real' }),
        /Invalid timeZone/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('loadConfig falls back to defaults (not throws) when the file has an invalid zone', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await writeFile(
        configPath(dataDir),
        JSON.stringify({ timeZone: 'Not/Real' }),
        'utf8',
      );
      const cfg = await loadConfig(dataDir);
      assert.equal(cfg.timeZone, DEFAULT_TZ);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('loadConfig tolerates malformed JSON by returning defaults', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await writeFile(configPath(dataDir), '{not json', 'utf8');
      const cfg = await loadConfig(dataDir);
      assert.equal(cfg.timeZone, DEFAULT_TZ);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
