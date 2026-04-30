/**
 * Tests for the tiny .aweek/config.json store.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_TZ } from '../time/zone.js';
import {
  configPath,
  loadConfig,
  saveConfig,
  isValidStaleTaskWindowMs,
  DEFAULT_STALE_TASK_WINDOW_MS,
} from './config-store.js';

async function tempDataDir(): Promise<{ base: string; dataDir: string }> {
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

  describe('staleTaskWindowMs', () => {
    it('defaults to DEFAULT_STALE_TASK_WINDOW_MS (60 minutes) when no file exists', async () => {
      const { base, dataDir } = await tempDataDir();
      try {
        const cfg = await loadConfig(dataDir);
        assert.equal(cfg.staleTaskWindowMs, DEFAULT_STALE_TASK_WINDOW_MS);
        assert.equal(cfg.staleTaskWindowMs, 60 * 60 * 1000);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('saveConfig writes and loadConfig reads a custom staleTaskWindowMs', async () => {
      const { base, dataDir } = await tempDataDir();
      try {
        await saveConfig(dataDir, { staleTaskWindowMs: 20 * 60 * 1000 });
        const cfg = await loadConfig(dataDir);
        assert.equal(cfg.staleTaskWindowMs, 20 * 60 * 1000);
        const raw = await readFile(configPath(dataDir), 'utf8');
        assert.match(raw, /"staleTaskWindowMs": 1200000/);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('saveConfig merges staleTaskWindowMs with existing timeZone without losing either', async () => {
      const { base, dataDir } = await tempDataDir();
      try {
        await saveConfig(dataDir, { timeZone: 'Asia/Seoul' });
        await saveConfig(dataDir, { staleTaskWindowMs: 30 * 60 * 1000 });
        const cfg = await loadConfig(dataDir);
        assert.equal(cfg.timeZone, 'Asia/Seoul');
        assert.equal(cfg.staleTaskWindowMs, 30 * 60 * 1000);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('saveConfig rejects out-of-range values', async () => {
      const { base, dataDir } = await tempDataDir();
      try {
        await assert.rejects(
          () => saveConfig(dataDir, { staleTaskWindowMs: 500 }),
          /Invalid staleTaskWindowMs/,
        );
        await assert.rejects(
          () => saveConfig(dataDir, { staleTaskWindowMs: 25 * 60 * 60 * 1000 }),
          /Invalid staleTaskWindowMs/,
        );
        await assert.rejects(
          () => saveConfig(dataDir, { staleTaskWindowMs: 1.5 } as never),
          /Invalid staleTaskWindowMs/,
        );
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('loadConfig falls back to default for an out-of-range value on disk', async () => {
      const { base, dataDir } = await tempDataDir();
      try {
        await writeFile(
          configPath(dataDir),
          JSON.stringify({ timeZone: 'UTC', staleTaskWindowMs: 100 }),
          'utf8',
        );
        const cfg = await loadConfig(dataDir);
        assert.equal(cfg.staleTaskWindowMs, DEFAULT_STALE_TASK_WINDOW_MS);
        // timeZone is still loaded cleanly.
        assert.equal(cfg.timeZone, 'UTC');
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('isValidStaleTaskWindowMs accepts the valid range and rejects edges', () => {
      assert.equal(isValidStaleTaskWindowMs(60_000), true);
      assert.equal(isValidStaleTaskWindowMs(20 * 60 * 1000), true);
      assert.equal(isValidStaleTaskWindowMs(86_400_000), true);
      assert.equal(isValidStaleTaskWindowMs(0), false);
      assert.equal(isValidStaleTaskWindowMs(59_999), false);
      assert.equal(isValidStaleTaskWindowMs(86_400_001), false);
      assert.equal(isValidStaleTaskWindowMs(1.5), false);
      assert.equal(isValidStaleTaskWindowMs('3600000'), false);
      assert.equal(isValidStaleTaskWindowMs(null), false);
      assert.equal(isValidStaleTaskWindowMs(undefined), false);
      assert.equal(isValidStaleTaskWindowMs(Number.NaN), false);
      assert.equal(isValidStaleTaskWindowMs(Number.POSITIVE_INFINITY), false);
    });
  });
});
