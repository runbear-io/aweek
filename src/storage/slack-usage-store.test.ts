/**
 * Tests for the Slack-channel usage store.
 *
 * Coverage areas:
 *
 *   - Path resolution mirrors `slack-config-store`'s `<projectRoot>/
 *     .aweek/channels/slack/usage.json` placement.
 *   - `createSlackUsageRecord` factory: required-input validation,
 *     `totalTokens` math, optional-field omission, id/timestamp
 *     auto-stamping.
 *   - Append path: writes a fresh record, is idempotent on `id`,
 *     creates the parent directory on first use.
 *   - Read path: returns `[]` on ENOENT, on corrupt JSON, and on
 *     non-array JSON; never throws.
 *   - Write path: round-trips through atomic tmp-then-rename without
 *     leaving stale tmp artefacts behind.
 *   - Independence from per-agent UsageStore — Slack usage records
 *     never land in the per-agent usage tree.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  appendSlackUsageRecord,
  createSlackUsageRecord,
  readSlackUsage,
  slackUsagePath,
  SLACK_USAGE_FILENAME,
  writeSlackUsage,
  type SlackUsageRecord,
} from './slack-usage-store.js';

/**
 * Build a fresh tmpdir laid out the way the Slack listener sees it:
 * a project root with `.aweek/agents` already created (mirrors how
 * `aweek setup` provisions the data dir).
 */
async function tempDataDir(): Promise<{ base: string; dataDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'aweek-slack-usage-'));
  const dataDir = join(base, '.aweek', 'agents');
  await mkdir(dataDir, { recursive: true });
  return { base, dataDir };
}

describe('slackUsagePath', () => {
  it('points at <projectRoot>/.aweek/channels/slack/usage.json', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      assert.equal(
        slackUsagePath(dataDir),
        join(base, '.aweek', 'channels', 'slack', SLACK_USAGE_FILENAME),
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('does NOT live next to per-agent usage', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const slackPath = slackUsagePath(dataDir);
      assert.equal(slackPath.includes(`${dataDir}/`), false);
      assert.ok(slackPath.endsWith('/channels/slack/usage.json'));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('createSlackUsageRecord', () => {
  it('builds a structurally valid record from minimal inputs', () => {
    const record = createSlackUsageRecord({
      threadKey: 'slack:C123:1700000000.000100',
      inputTokens: 100,
      outputTokens: 50,
      success: true,
    });
    assert.match(record.id, /^slack-usage-[a-f0-9]+$/);
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.threadKey, 'slack:C123:1700000000.000100');
    assert.equal(record.inputTokens, 100);
    assert.equal(record.outputTokens, 50);
    assert.equal(record.totalTokens, 150);
    assert.equal(record.success, true);
    assert.equal(record.costUsd, undefined);
    assert.equal(record.durationMs, undefined);
    assert.equal(record.model, undefined);
  });

  it('defaults inputTokens / outputTokens to 0 when omitted', () => {
    const record = createSlackUsageRecord({
      threadKey: 'slack:C1:1.0',
      success: false,
    });
    assert.equal(record.inputTokens, 0);
    assert.equal(record.outputTokens, 0);
    assert.equal(record.totalTokens, 0);
    assert.equal(record.success, false);
  });

  it('preserves cache, cost, duration, model, and stopReason when provided', () => {
    const record = createSlackUsageRecord({
      threadKey: 'slack:C1:1.0',
      inputTokens: 1000,
      outputTokens: 400,
      cacheReadTokens: 200,
      cacheCreationTokens: 50,
      costUsd: 0.012345,
      durationMs: 4321,
      model: 'claude-opus-4',
      stopReason: 'end_turn',
      success: true,
    });
    assert.equal(record.cacheReadTokens, 200);
    assert.equal(record.cacheCreationTokens, 50);
    assert.equal(record.costUsd, 0.012345);
    assert.equal(record.durationMs, 4321);
    assert.equal(record.model, 'claude-opus-4');
    assert.equal(record.stopReason, 'end_turn');
  });

  it('omits costUsd when zero', () => {
    const record = createSlackUsageRecord({
      threadKey: 'slack:C1:1.0',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0,
      success: true,
    });
    assert.equal('costUsd' in record, false);
  });

  it('honours an explicit timestamp and id', () => {
    const record = createSlackUsageRecord({
      id: 'slack-usage-deadbeef',
      timestamp: '2026-04-13T12:00:00.000Z',
      threadKey: 'slack:C1:1.0',
      inputTokens: 1,
      outputTokens: 2,
      success: true,
    });
    assert.equal(record.id, 'slack-usage-deadbeef');
    assert.equal(record.timestamp, '2026-04-13T12:00:00.000Z');
  });

  it('throws when threadKey is missing or blank', () => {
    assert.throws(
      () =>
        createSlackUsageRecord({
          threadKey: '',
          success: true,
        }),
      /threadKey is required/,
    );
    assert.throws(
      () =>
        createSlackUsageRecord({
          threadKey: '   ',
          success: true,
        }),
      /threadKey is required/,
    );
  });

  it('throws when success is not a boolean', () => {
    assert.throws(
      () =>
        createSlackUsageRecord(
          // deliberate runtime misuse
          { threadKey: 'slack:C1:1.0' } as unknown as Parameters<typeof createSlackUsageRecord>[0],
        ),
      /success must be a boolean/,
    );
  });

  it('throws on negative or non-finite token counts', () => {
    assert.throws(
      () =>
        createSlackUsageRecord({
          threadKey: 'slack:C1:1.0',
          inputTokens: -1,
          success: true,
        }),
      /inputTokens must be a non-negative finite number/,
    );
    assert.throws(
      () =>
        createSlackUsageRecord({
          threadKey: 'slack:C1:1.0',
          outputTokens: Number.POSITIVE_INFINITY,
          success: true,
        }),
      /outputTokens must be a non-negative finite number/,
    );
  });

  it('throws on negative costUsd', () => {
    assert.throws(
      () =>
        createSlackUsageRecord({
          threadKey: 'slack:C1:1.0',
          costUsd: -0.0001,
          success: true,
        }),
      /costUsd must be a non-negative finite number/,
    );
  });
});

describe('readSlackUsage', () => {
  it('returns [] when the usage file does not exist', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const records = await readSlackUsage(dataDir);
      assert.deepEqual(records, []);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('returns [] for a corrupt JSON file (and warns on stderr)', async () => {
    const { base, dataDir } = await tempDataDir();
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      captured.push(s);
      return true;
    };
    try {
      const path = slackUsagePath(dataDir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'not json{', 'utf-8');
      const records = await readSlackUsage(dataDir);
      assert.deepEqual(records, []);
      assert.ok(
        captured.some((line) => line.includes('malformed')),
        `expected a malformed-usage warning, got: ${JSON.stringify(captured)}`,
      );
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
      await rm(base, { recursive: true, force: true });
    }
  });

  it('returns [] when the file contains a non-array JSON payload', async () => {
    const { base, dataDir } = await tempDataDir();
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
    try {
      const path = slackUsagePath(dataDir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ wrong: 'shape' }), 'utf-8');
      const records = await readSlackUsage(dataDir);
      assert.deepEqual(records, []);
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
      await rm(base, { recursive: true, force: true });
    }
  });

  it('drops corrupt rows but keeps valid ones', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const path = slackUsagePath(dataDir);
      await mkdir(dirname(path), { recursive: true });
      const valid = createSlackUsageRecord({
        threadKey: 'slack:C1:1.0',
        inputTokens: 1,
        outputTokens: 2,
        success: true,
      });
      const mixed = [
        valid,
        { id: 'broken' /* missing every other required field */ },
        null,
        'string-row',
      ];
      await writeFile(path, JSON.stringify(mixed), 'utf-8');
      const records = await readSlackUsage(dataDir);
      assert.equal(records.length, 1);
      assert.equal(records[0].id, valid.id);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rejects empty dataDir', async () => {
    await assert.rejects(() => readSlackUsage(''), /dataDir is required/);
  });
});

describe('writeSlackUsage', () => {
  it('round-trips through readSlackUsage', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const r1 = createSlackUsageRecord({
        threadKey: 'slack:C1:thread-a',
        inputTokens: 100,
        outputTokens: 50,
        success: true,
      });
      const r2 = createSlackUsageRecord({
        threadKey: 'slack:C2:thread-b',
        inputTokens: 200,
        outputTokens: 80,
        success: false,
        stopReason: 'error_max_turns',
      });
      await writeSlackUsage(dataDir, [r1, r2]);
      const records = await readSlackUsage(dataDir);
      assert.equal(records.length, 2);
      assert.deepEqual(records[0], r1);
      assert.deepEqual(records[1], r2);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('does not leave .tmp- artefacts behind on success', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const r = createSlackUsageRecord({
        threadKey: 'slack:C1:1.0',
        inputTokens: 1,
        outputTokens: 1,
        success: true,
      });
      await writeSlackUsage(dataDir, [r]);
      const slackDir = dirname(slackUsagePath(dataDir));
      const entries = await readdir(slackDir);
      const tmpish = entries.filter((name) => name.includes('.tmp-'));
      assert.deepEqual(tmpish, [], `unexpected tmp artefacts: ${entries.join(', ')}`);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rejects non-array inputs', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await assert.rejects(
        () => writeSlackUsage(dataDir, 'nope' as unknown as SlackUsageRecord[]),
        /records must be an array/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rejects arrays with malformed records', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await assert.rejects(
        () =>
          writeSlackUsage(dataDir, [
            { id: 'broken' } as unknown as SlackUsageRecord,
          ]),
        /every record must be a valid SlackUsageRecord/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('writes pretty-printed JSON ending with a newline (mirrors the rest of the storage tree)', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const r = createSlackUsageRecord({
        threadKey: 'slack:C1:1.0',
        inputTokens: 1,
        outputTokens: 1,
        success: true,
      });
      await writeSlackUsage(dataDir, [r]);
      const raw = await readFile(slackUsagePath(dataDir), 'utf-8');
      assert.ok(raw.endsWith('\n'), 'usage file must end with a newline');
      // Pretty-printed: array element opens on its own line, fields indented.
      assert.ok(raw.startsWith('[\n  {'), 'usage file must be pretty-printed');
      assert.ok(raw.includes('"id":'), 'usage file must contain id field');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('appendSlackUsageRecord', () => {
  it('creates the channels/slack directory and writes the first record', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const record = createSlackUsageRecord({
        threadKey: 'slack:C1:1.0',
        inputTokens: 100,
        outputTokens: 50,
        success: true,
      });
      const persisted = await appendSlackUsageRecord(dataDir, record);
      assert.equal(persisted.id, record.id);

      const records = await readSlackUsage(dataDir);
      assert.equal(records.length, 1);
      assert.deepEqual(records[0], record);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('appends to an existing log without overwriting prior records', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const first = createSlackUsageRecord({
        threadKey: 'slack:C1:thread-a',
        inputTokens: 100,
        outputTokens: 50,
        success: true,
      });
      const second = createSlackUsageRecord({
        threadKey: 'slack:C2:thread-b',
        inputTokens: 200,
        outputTokens: 80,
        success: true,
      });
      await appendSlackUsageRecord(dataDir, first);
      await appendSlackUsageRecord(dataDir, second);

      const records = await readSlackUsage(dataDir);
      assert.equal(records.length, 2);
      assert.equal(records[0].id, first.id);
      assert.equal(records[1].id, second.id);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('is idempotent on id — duplicate append is a no-op', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const record = createSlackUsageRecord({
        threadKey: 'slack:C1:1.0',
        inputTokens: 100,
        outputTokens: 50,
        success: true,
      });
      await appendSlackUsageRecord(dataDir, record);
      await appendSlackUsageRecord(dataDir, record);
      await appendSlackUsageRecord(dataDir, record);

      const records = await readSlackUsage(dataDir);
      assert.equal(records.length, 1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('keeps multiple threads in the same file (single-bucket invariant)', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      for (let i = 0; i < 5; i++) {
        const r = createSlackUsageRecord({
          threadKey: `slack:C${i}:${i}.0`,
          inputTokens: 10 * (i + 1),
          outputTokens: 5 * (i + 1),
          success: true,
        });
        await appendSlackUsageRecord(dataDir, r);
      }
      const records = await readSlackUsage(dataDir);
      assert.equal(records.length, 5);
      const threadKeys = new Set(records.map((r) => r.threadKey));
      assert.equal(threadKeys.size, 5);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rejects malformed records', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await assert.rejects(
        () =>
          appendSlackUsageRecord(
            dataDir,
            { id: 'incomplete' } as unknown as SlackUsageRecord,
          ),
        /invalid record shape/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rejects empty dataDir', async () => {
    const r = createSlackUsageRecord({
      threadKey: 'slack:C1:1.0',
      inputTokens: 1,
      outputTokens: 1,
      success: true,
    });
    await assert.rejects(
      () => appendSlackUsageRecord('', r),
      /dataDir is required/,
    );
  });
});

describe('isolation from per-agent UsageStore', () => {
  it('Slack append never touches the per-agent .aweek/agents tree', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const before = await readdir(dataDir);
      const r = createSlackUsageRecord({
        threadKey: 'slack:C1:1.0',
        inputTokens: 1,
        outputTokens: 1,
        success: true,
      });
      await appendSlackUsageRecord(dataDir, r);
      const after = await readdir(dataDir);
      assert.deepEqual(after, before, 'per-agent tree must be untouched');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
