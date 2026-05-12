/**
 * Tests for the Slack report-thread store.
 *
 * Coverage mirrors `slack-thread-store.test.ts` since the two stores
 * share the same lazy-GC + atomic-write contract — every behavioural
 * branch is exercised: cold start, round-trip, lazy GC on expired
 * records, malformed JSON, schema-mismatch, kind enum validation,
 * sourceTaskId optionality, and the filename-encoding mirror with
 * slack-thread-store so the inbound bridge looks up identical keys.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  loadReportThread,
  saveReportThread,
  slackReportThreadPath,
  SLACK_REPORT_THREADS_DIRNAME,
  SLACK_REPORT_THREAD_TTL_MS,
} from './slack-report-thread-store.js';
import {
  encodeThreadKey,
  slackThreadPath,
} from './slack-thread-store.js';

let base: string;
let dataDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'report-thread-store-test-'));
  dataDir = join(base, '.aweek', 'agents');
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const THREAD_KEY = 'slack:C0123ABC:1762560000.000123';

describe('slackReportThreadPath', () => {
  it('resolves under .aweek/channels/slack/report-threads/<encoded>.json', () => {
    const p = slackReportThreadPath(dataDir, THREAD_KEY);
    assert.equal(
      p,
      join(
        base,
        '.aweek',
        'channels',
        'slack',
        SLACK_REPORT_THREADS_DIRNAME,
        `${encodeThreadKey(THREAD_KEY)}.json`,
      ),
    );
  });

  it('uses the same filename encoder as slack-thread-store (collision-free siblings)', () => {
    const reportPath = slackReportThreadPath(dataDir, THREAD_KEY);
    const chatPath = slackThreadPath(dataDir, THREAD_KEY);
    // Same filename slug — different directories ensure no on-disk collision.
    assert.equal(dirname(reportPath).split('/').pop(), SLACK_REPORT_THREADS_DIRNAME);
    assert.equal(dirname(chatPath).split('/').pop(), 'threads');
    assert.equal(
      reportPath.split('/').pop(),
      chatPath.split('/').pop(),
      'filename slugs must match so the bridge can swap stores transparently',
    );
  });

  it('rejects an empty threadKey', () => {
    assert.throws(() => slackReportThreadPath(dataDir, ''));
  });
});

describe('loadReportThread', () => {
  it('returns null when the file does not exist', async () => {
    const out = await loadReportThread(dataDir, THREAD_KEY);
    assert.equal(out, null);
  });

  it('round-trips a saved record', async () => {
    const saved = await saveReportThread(dataDir, {
      threadKey: THREAD_KEY,
      senderSlug: 'marketer-sam',
      kind: 'question',
      title: 'Need approval',
      body: 'On the W21 budget',
      sourceTaskId: 'task-abc',
      now: () => 1700000000000,
    });
    assert.equal(saved.postedAt, 1700000000000);

    const loaded = await loadReportThread(dataDir, THREAD_KEY, () => 1700000000000);
    assert.deepEqual(loaded, {
      threadKey: THREAD_KEY,
      senderSlug: 'marketer-sam',
      kind: 'question',
      title: 'Need approval',
      body: 'On the W21 budget',
      sourceTaskId: 'task-abc',
      postedAt: 1700000000000,
    });
  });

  it('omits sourceTaskId from the loaded record when it was not persisted', async () => {
    await saveReportThread(dataDir, {
      threadKey: THREAD_KEY,
      senderSlug: 'marketer-sam',
      kind: 'report',
      title: 't',
      body: 'b',
      now: () => 1,
    });
    const loaded = await loadReportThread(dataDir, THREAD_KEY, () => 1);
    assert.equal(loaded?.sourceTaskId, undefined);
    assert.ok(!('sourceTaskId' in (loaded ?? {})));
  });

  it('lazy-GCs records older than the 30-day TTL and deletes the file', async () => {
    const saveTime = 1_700_000_000_000;
    await saveReportThread(dataDir, {
      threadKey: THREAD_KEY,
      senderSlug: 'a',
      kind: 'report',
      title: 't',
      body: 'b',
      now: () => saveTime,
    });
    const beyondTtl = saveTime + SLACK_REPORT_THREAD_TTL_MS + 1;
    const out = await loadReportThread(dataDir, THREAD_KEY, () => beyondTtl);
    assert.equal(out, null);

    // File was deleted as part of the lazy GC — a follow-up load is a
    // pure ENOENT, not a re-parse of the same stale record.
    const p = slackReportThreadPath(dataDir, THREAD_KEY);
    await assert.rejects(() => stat(p), /ENOENT/);
  });

  it('treats a record exactly at the TTL boundary as expired (>= comparison)', async () => {
    const saveTime = 1_700_000_000_000;
    await saveReportThread(dataDir, {
      threadKey: THREAD_KEY,
      senderSlug: 'a',
      kind: 'report',
      title: 't',
      body: 'b',
      now: () => saveTime,
    });
    const atBoundary = saveTime + SLACK_REPORT_THREAD_TTL_MS;
    const out = await loadReportThread(dataDir, THREAD_KEY, () => atBoundary);
    assert.equal(out, null);
  });

  it('returns null and deletes the file on malformed JSON', async () => {
    const p = slackReportThreadPath(dataDir, THREAD_KEY);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, '{not valid json', 'utf8');

    // Silence the stderr warning during the assertion.
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
    try {
      const out = await loadReportThread(dataDir, THREAD_KEY);
      assert.equal(out, null);
      await assert.rejects(() => stat(p), /ENOENT/);
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
  });

  it('returns null on schema-mismatch (missing required fields) and deletes the file', async () => {
    const p = slackReportThreadPath(dataDir, THREAD_KEY);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(
      p,
      JSON.stringify({ threadKey: THREAD_KEY, senderSlug: 'a' /* no title/body/kind/postedAt */ }),
      'utf8',
    );

    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
    try {
      const out = await loadReportThread(dataDir, THREAD_KEY);
      assert.equal(out, null);
      await assert.rejects(() => stat(p), /ENOENT/);
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
  });

  it('returns null on an unknown kind value', async () => {
    const p = slackReportThreadPath(dataDir, THREAD_KEY);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(
      p,
      JSON.stringify({
        threadKey: THREAD_KEY,
        senderSlug: 'a',
        kind: 'announcement',
        title: 't',
        body: 'b',
        postedAt: 1,
      }),
      'utf8',
    );
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
    try {
      const out = await loadReportThread(dataDir, THREAD_KEY, () => 2);
      assert.equal(out, null);
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
  });
});

describe('saveReportThread', () => {
  it('rejects empty / missing required fields', async () => {
    await assert.rejects(
      () =>
        saveReportThread(dataDir, {
          threadKey: '',
        } as Parameters<typeof saveReportThread>[1]),
    );
    await assert.rejects(
      () =>
        saveReportThread(dataDir, {
          threadKey: THREAD_KEY,
          senderSlug: '',
          kind: 'report',
          title: 't',
          body: 'b',
        }),
    );
    await assert.rejects(
      () =>
        saveReportThread(dataDir, {
          threadKey: THREAD_KEY,
          senderSlug: 'a',
          kind: 'announcement' as 'report',
          title: 't',
          body: 'b',
        }),
    );
  });

  it('overwrites an existing record in place (idempotent-write contract)', async () => {
    await saveReportThread(dataDir, {
      threadKey: THREAD_KEY,
      senderSlug: 'first',
      kind: 'report',
      title: 'first',
      body: 'first body',
      now: () => 1,
    });
    await saveReportThread(dataDir, {
      threadKey: THREAD_KEY,
      senderSlug: 'second',
      kind: 'question',
      title: 'second',
      body: 'second body',
      now: () => 2,
    });
    const loaded = await loadReportThread(dataDir, THREAD_KEY, () => 2);
    assert.equal(loaded?.senderSlug, 'second');
    assert.equal(loaded?.title, 'second');
    assert.equal(loaded?.kind, 'question');
    assert.equal(loaded?.postedAt, 2);
  });

  it('writes pretty-printed JSON with a trailing newline (matches the rest of the storage layer)', async () => {
    await saveReportThread(dataDir, {
      threadKey: THREAD_KEY,
      senderSlug: 'a',
      kind: 'report',
      title: 't',
      body: 'b',
      now: () => 1,
    });
    const p = slackReportThreadPath(dataDir, THREAD_KEY);
    const raw = await readFile(p, 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.ok(raw.includes('\n  "threadKey":'));
  });
});
