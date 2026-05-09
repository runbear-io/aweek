/**
 * Tests for `src/storage/slack-thread-store.ts`.
 *
 * Sub-AC 5 of the Slack-aweek integration seed. The store mirrors the
 * Claude Code CLI session id captured from the project-level Claude
 * stream-json `system` `init` line back to disk so subsequent turns in
 * the same Slack thread can pass `--resume <sessionId>`.
 *
 * Coverage:
 *
 *   1. Path resolution
 *      - `slackThreadPath` walks up from `<.aweek>/agents` to
 *        `<.aweek>/channels/slack/threads/` and produces a
 *        filename-safe basename.
 *      - `encodeThreadKey` maps colons / dots to safe runs of
 *        underscores.
 *
 *   2. Cold-start (file missing) → `null`.
 *
 *   3. Round-trip
 *      - `saveSlackThread` writes the record; `loadSlackThread`
 *        reads back the SAME `claudeSessionId` and a `lastUsedAt`
 *        equal to the configured clock.
 *
 *   4. Lazy GC on read
 *      - A record older than 24h is deleted on read and the loader
 *        returns `null`.
 *      - A record exactly at the boundary is also evicted (`>=`).
 *      - A fresh record (within 24h) is preserved.
 *
 *   5. Failure tolerance
 *      - Malformed JSON file → loader warns, deletes the file, returns
 *        `null`. Subsequent reads see a clean cold start.
 *      - Missing required fields → same handling.
 *
 *   6. Idempotency
 *      - `saveSlackThread` twice on the same key overwrites in-place.
 *      - `deleteSlackThread` on a missing file is a no-op.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeThreadKey,
  loadSlackThread,
  saveSlackThread,
  deleteSlackThread,
  slackThreadPath,
  SLACK_THREAD_TTL_MS,
  SLACK_THREADS_DIRNAME,
} from './slack-thread-store.js';

async function tempDataDir(): Promise<{ base: string; dataDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'aweek-slack-thread-'));
  const dataDir = join(base, '.aweek', 'agents');
  await mkdir(dataDir, { recursive: true });
  return { base, dataDir };
}

describe('slack-thread-store — path helpers', () => {
  it('slackThreadPath resolves under <projectRoot>/.aweek/channels/slack/threads/', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const path = slackThreadPath(dataDir, 'slack:C123:T456');
      assert.equal(
        path,
        join(
          base,
          '.aweek',
          'channels',
          'slack',
          SLACK_THREADS_DIRNAME,
          'slack_C123_T456.json',
        ),
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('encodeThreadKey replaces unsafe filename characters with underscores', () => {
    assert.equal(encodeThreadKey('slack:C123:T456'), 'slack_C123_T456');
    // Periods are fine on every supported OS, hyphens too.
    assert.equal(encodeThreadKey('slack:C123:1762560000.000123-T'), 'slack_C123_1762560000.000123-T');
    // Leading dot would create a hidden file on POSIX → defended.
    assert.equal(encodeThreadKey('.foo'), '_foo');
  });

  it('slackThreadPath throws when dataDir or threadKey is empty', () => {
    assert.throws(() => slackThreadPath('', 'slack:x'), /dataDir is required/);
    assert.throws(() => slackThreadPath('/tmp/.aweek/agents', ''), /threadKey is required/);
  });
});

describe('slack-thread-store — cold start', () => {
  it('returns null when no file exists', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const record = await loadSlackThread(dataDir, 'slack:C123:T_first');
      assert.equal(record, null);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('slack-thread-store — round trip', () => {
  it('saves and reads back the same claudeSessionId + lastUsedAt', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const fixedNow = 1_700_000_000_000;
      const saved = await saveSlackThread(dataDir, {
        threadKey: 'slack:C123:T456',
        claudeSessionId: 'sess_abc',
        now: () => fixedNow,
      });
      assert.deepEqual(saved, {
        threadKey: 'slack:C123:T456',
        claudeSessionId: 'sess_abc',
        lastUsedAt: fixedNow,
      });

      const loaded = await loadSlackThread(
        dataDir,
        'slack:C123:T456',
        () => fixedNow + 1000,
      );
      assert.deepEqual(loaded, {
        threadKey: 'slack:C123:T456',
        claudeSessionId: 'sess_abc',
        lastUsedAt: fixedNow,
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('overwrites an existing record idempotently', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await saveSlackThread(dataDir, {
        threadKey: 'slack:C123:T456',
        claudeSessionId: 'sess_v1',
        now: () => 1_700_000_000_000,
      });
      await saveSlackThread(dataDir, {
        threadKey: 'slack:C123:T456',
        claudeSessionId: 'sess_v2',
        now: () => 1_700_000_001_000,
      });
      const loaded = await loadSlackThread(
        dataDir,
        'slack:C123:T456',
        () => 1_700_000_002_000,
      );
      assert.equal(loaded?.claudeSessionId, 'sess_v2');
      assert.equal(loaded?.lastUsedAt, 1_700_000_001_000);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('slack-thread-store — lazy GC', () => {
  it('returns null AND deletes the file when the record is older than 24h', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const past = 1_000_000;
      await saveSlackThread(dataDir, {
        threadKey: 'slack:C123:T_old',
        claudeSessionId: 'sess_old',
        now: () => past,
      });
      const path = slackThreadPath(dataDir, 'slack:C123:T_old');
      // Sanity: file exists right after save.
      const before = await readFile(path, 'utf8');
      assert.match(before, /sess_old/);

      const loaded = await loadSlackThread(
        dataDir,
        'slack:C123:T_old',
        () => past + SLACK_THREAD_TTL_MS + 1,
      );
      assert.equal(loaded, null);

      // File must be gone after the lazy GC sweep.
      let stillExists = true;
      try {
        await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          stillExists = false;
        } else {
          throw err;
        }
      }
      assert.equal(stillExists, false, 'expired file must be unlinked');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('preserves a record that is exactly 1ms younger than the TTL', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const t0 = 1_000_000;
      await saveSlackThread(dataDir, {
        threadKey: 'slack:C123:T_edge',
        claudeSessionId: 'sess_edge',
        now: () => t0,
      });
      const loaded = await loadSlackThread(
        dataDir,
        'slack:C123:T_edge',
        () => t0 + SLACK_THREAD_TTL_MS - 1,
      );
      assert.equal(loaded?.claudeSessionId, 'sess_edge');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('evicts a record at exactly the TTL boundary (>=)', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const t0 = 1_000_000;
      await saveSlackThread(dataDir, {
        threadKey: 'slack:C123:T_boundary',
        claudeSessionId: 'sess_boundary',
        now: () => t0,
      });
      const loaded = await loadSlackThread(
        dataDir,
        'slack:C123:T_boundary',
        () => t0 + SLACK_THREAD_TTL_MS,
      );
      assert.equal(loaded, null, 'record at exact TTL boundary must be evicted');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('slack-thread-store — failure tolerance', () => {
  it('treats a malformed JSON file as missing and deletes it on read', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const path = slackThreadPath(dataDir, 'slack:C123:T_corrupt');
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'not valid json{{{', 'utf8');

      const loaded = await loadSlackThread(dataDir, 'slack:C123:T_corrupt');
      assert.equal(loaded, null);

      // The corrupt file must have been deleted so the next load is a
      // clean cold start instead of repeating the same parse error.
      let stillExists = true;
      try {
        await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          stillExists = false;
        } else {
          throw err;
        }
      }
      assert.equal(stillExists, false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('treats a JSON file that is missing required fields as missing', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const path = slackThreadPath(dataDir, 'slack:C123:T_partial');
      await mkdir(join(path, '..'), { recursive: true });
      // claudeSessionId missing.
      await writeFile(
        path,
        JSON.stringify({ threadKey: 'slack:C123:T_partial', lastUsedAt: 1 }),
        'utf8',
      );

      const loaded = await loadSlackThread(dataDir, 'slack:C123:T_partial');
      assert.equal(loaded, null);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('slack-thread-store — deleteSlackThread', () => {
  it('removes the persisted record', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await saveSlackThread(dataDir, {
        threadKey: 'slack:C123:T_del',
        claudeSessionId: 'sess_del',
        now: () => 1_000_000,
      });
      await deleteSlackThread(dataDir, 'slack:C123:T_del');
      const loaded = await loadSlackThread(
        dataDir,
        'slack:C123:T_del',
        () => 1_000_001,
      );
      assert.equal(loaded, null);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('is a no-op when the file is already missing', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await deleteSlackThread(dataDir, 'slack:C123:T_neverexisted');
      // Reaching here without throwing is the assertion.
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
