/**
 * Tests for the Slack conversation transcript store (the Gemini/Hermes
 * memory layer) — src/storage/slack-transcript-store.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadSlackTranscript,
  appendSlackTranscript,
  slackTranscriptPath,
  MAX_TRANSCRIPT_MESSAGES,
} from './slack-transcript-store.js';
import { SLACK_THREAD_TTL_MS } from './slack-thread-store.js';

async function tempDataDir(): Promise<{ base: string; dataDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'aweek-slack-transcript-'));
  const dataDir = join(base, '.aweek', 'agents');
  await mkdir(dataDir, { recursive: true });
  return { base, dataDir };
}

const KEY = 'slack:C123:T456';

describe('slack-transcript-store', () => {
  it('returns null for a thread with no transcript', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      assert.equal(await loadSlackTranscript(dataDir, KEY), null);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('appends and reloads messages in order', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await appendSlackTranscript(dataDir, { threadKey: KEY, role: 'user', content: 'hi' });
      await appendSlackTranscript(dataDir, { threadKey: KEY, role: 'assistant', content: 'hello' });
      const rec = await loadSlackTranscript(dataDir, KEY);
      assert.ok(rec);
      assert.equal(rec!.threadKey, KEY);
      assert.deepEqual(
        rec!.messages,
        [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('caps the transcript at MAX_TRANSCRIPT_MESSAGES (oldest dropped)', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      for (let i = 0; i < MAX_TRANSCRIPT_MESSAGES + 5; i++) {
        await appendSlackTranscript(dataDir, {
          threadKey: KEY,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `msg-${i}`,
        });
      }
      const rec = await loadSlackTranscript(dataDir, KEY);
      assert.ok(rec);
      assert.equal(rec!.messages.length, MAX_TRANSCRIPT_MESSAGES);
      // Oldest five were dropped — first kept message is msg-5.
      assert.equal(rec!.messages[0]!.content, 'msg-5');
      assert.equal(rec!.messages.at(-1)!.content, `msg-${MAX_TRANSCRIPT_MESSAGES + 4}`);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('GCs a transcript older than the 24h idle TTL on read', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      let clock = 1_000_000;
      const now = () => clock;
      await appendSlackTranscript(dataDir, { threadKey: KEY, role: 'user', content: 'hi', now });
      // Advance past the TTL — the next read should evict and return null.
      clock += SLACK_THREAD_TTL_MS + 1;
      assert.equal(await loadSlackTranscript(dataDir, KEY, now), null);
      // File deleted → a fresh append starts a new record.
      await appendSlackTranscript(dataDir, { threadKey: KEY, role: 'user', content: 'again', now });
      const rec = await loadSlackTranscript(dataDir, KEY, now);
      assert.equal(rec!.messages.length, 1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('treats a malformed transcript file as a cold start', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const path = slackTranscriptPath(dataDir, KEY);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'not json', 'utf8');
      assert.equal(await loadSlackTranscript(dataDir, KEY), null);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
