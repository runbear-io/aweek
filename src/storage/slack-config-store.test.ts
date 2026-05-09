/**
 * Tests for the Slack credentials loader.
 *
 * The loader is the gate between `aweek serve` and the embedded Slack
 * listener: it must
 *
 *   1. Read `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` from `process.env` first.
 *   2. Fall back to `.aweek/channels/slack/config.json` per-key.
 *   3. Return `null` (not throw) when either required token is missing,
 *      so `aweek serve` boots cleanly on machines that haven't run
 *      `/aweek:slack-init` yet.
 *
 * We never mutate the real `process.env` — instead we pass a sealed
 * `envSource` map so parallel `node --test` runs cannot leak state.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadSlackCredentials,
  slackConfigPath,
  SLACK_CONFIG_FILENAME,
} from './slack-config-store.js';

async function tempDataDir(): Promise<{ base: string; dataDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'aweek-slack-config-'));
  const dataDir = join(base, '.aweek', 'agents');
  await mkdir(dataDir, { recursive: true });
  return { base, dataDir };
}

async function writeSlackConfig(dataDir: string, body: unknown): Promise<void> {
  const path = slackConfigPath(dataDir);
  await mkdir(join(path, '..'), { recursive: true });
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  await writeFile(path, text, 'utf8');
}

describe('slack-config-store', () => {
  it('slackConfigPath points at <projectRoot>/.aweek/channels/slack/config.json', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      assert.equal(
        slackConfigPath(dataDir),
        join(base, '.aweek', 'channels', 'slack', SLACK_CONFIG_FILENAME),
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('returns null when neither env nor file provides any tokens', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const creds = await loadSlackCredentials(dataDir, {});
      assert.equal(creds, null);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('returns null when env provides only the bot token (no app token, no file)', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const creds = await loadSlackCredentials(dataDir, {
        SLACK_BOT_TOKEN: 'xoxb-only',
      });
      assert.equal(creds, null);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('returns null when env provides only the app token (no bot token, no file)', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const creds = await loadSlackCredentials(dataDir, {
        SLACK_APP_TOKEN: 'xapp-only',
      });
      assert.equal(creds, null);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('returns credentials when both tokens come from env', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const creds = await loadSlackCredentials(dataDir, {
        SLACK_BOT_TOKEN: 'xoxb-from-env',
        SLACK_APP_TOKEN: 'xapp-from-env',
      });
      assert.deepEqual(creds, {
        botToken: 'xoxb-from-env',
        appToken: 'xapp-from-env',
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('returns credentials when both tokens come from the file (snake_case keys)', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await writeSlackConfig(dataDir, {
        bot_token: 'xoxb-from-file',
        app_token: 'xapp-from-file',
      });
      const creds = await loadSlackCredentials(dataDir, {});
      assert.deepEqual(creds, {
        botToken: 'xoxb-from-file',
        appToken: 'xapp-from-file',
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('also accepts uppercase env-var names inside the file', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await writeSlackConfig(dataDir, {
        SLACK_BOT_TOKEN: 'xoxb-loud',
        SLACK_APP_TOKEN: 'xapp-loud',
      });
      const creds = await loadSlackCredentials(dataDir, {});
      assert.deepEqual(creds, {
        botToken: 'xoxb-loud',
        appToken: 'xapp-loud',
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('env wins over file when both define the same token', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await writeSlackConfig(dataDir, {
        bot_token: 'xoxb-FILE',
        app_token: 'xapp-FILE',
      });
      const creds = await loadSlackCredentials(dataDir, {
        SLACK_BOT_TOKEN: 'xoxb-ENV',
        SLACK_APP_TOKEN: 'xapp-ENV',
      });
      assert.deepEqual(creds, {
        botToken: 'xoxb-ENV',
        appToken: 'xapp-ENV',
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('mixes sources per-key (env bot + file app)', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await writeSlackConfig(dataDir, { app_token: 'xapp-file-fill' });
      const creds = await loadSlackCredentials(dataDir, {
        SLACK_BOT_TOKEN: 'xoxb-env-only',
      });
      assert.deepEqual(creds, {
        botToken: 'xoxb-env-only',
        appToken: 'xapp-file-fill',
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('carries the optional signing secret when present (env)', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const creds = await loadSlackCredentials(dataDir, {
        SLACK_BOT_TOKEN: 'xoxb-sec',
        SLACK_APP_TOKEN: 'xapp-sec',
        SLACK_SIGNING_SECRET: 'shhh',
      });
      assert.deepEqual(creds, {
        botToken: 'xoxb-sec',
        appToken: 'xapp-sec',
        signingSecret: 'shhh',
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('carries the optional signing secret when present (file)', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await writeSlackConfig(dataDir, {
        bot_token: 'xoxb-file-sec',
        app_token: 'xapp-file-sec',
        signing_secret: 'whisper',
      });
      const creds = await loadSlackCredentials(dataDir, {});
      assert.deepEqual(creds, {
        botToken: 'xoxb-file-sec',
        appToken: 'xapp-file-sec',
        signingSecret: 'whisper',
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('omits signingSecret entirely when neither source provides one', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      const creds = await loadSlackCredentials(dataDir, {
        SLACK_BOT_TOKEN: 'xoxb-no-sec',
        SLACK_APP_TOKEN: 'xapp-no-sec',
      });
      assert.ok(creds);
      assert.equal('signingSecret' in creds, false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('treats whitespace-only tokens as missing and falls through', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await writeSlackConfig(dataDir, {
        bot_token: 'xoxb-from-file',
        app_token: 'xapp-from-file',
      });
      const creds = await loadSlackCredentials(dataDir, {
        SLACK_BOT_TOKEN: '   ',
        SLACK_APP_TOKEN: '\t',
      });
      assert.deepEqual(creds, {
        botToken: 'xoxb-from-file',
        appToken: 'xapp-from-file',
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('tolerates malformed JSON: warns on stderr and uses env-only', async () => {
    const { base, dataDir } = await tempDataDir();
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      captured.push(s);
      return true;
    };
    try {
      await writeSlackConfig(dataDir, '{not json');
      const creds = await loadSlackCredentials(dataDir, {
        SLACK_BOT_TOKEN: 'xoxb-env-fallback',
        SLACK_APP_TOKEN: 'xapp-env-fallback',
      });
      assert.deepEqual(creds, {
        botToken: 'xoxb-env-fallback',
        appToken: 'xapp-env-fallback',
      });
      assert.ok(
        captured.some((line) => line.includes('malformed')),
        `expected a malformed-config warning, got: ${JSON.stringify(captured)}`,
      );
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
      await rm(base, { recursive: true, force: true });
    }
  });

  it('tolerates malformed JSON and still returns null when env also lacks tokens', async () => {
    const { base, dataDir } = await tempDataDir();
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
    try {
      await writeSlackConfig(dataDir, '{not json');
      const creds = await loadSlackCredentials(dataDir, {});
      assert.equal(creds, null);
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
      await rm(base, { recursive: true, force: true });
    }
  });

  it('treats a JSON array as "no config" rather than throwing', async () => {
    const { base, dataDir } = await tempDataDir();
    try {
      await writeSlackConfig(dataDir, ['unexpected']);
      const creds = await loadSlackCredentials(dataDir, {});
      assert.equal(creds, null);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rejects an empty dataDir argument', async () => {
    await assert.rejects(
      () => loadSlackCredentials('', {}),
      /dataDir is required/,
    );
  });

  it('defaults to process.env when no envSource is passed', async () => {
    const { base, dataDir } = await tempDataDir();
    const prevBot = process.env.SLACK_BOT_TOKEN;
    const prevApp = process.env.SLACK_APP_TOKEN;
    try {
      process.env.SLACK_BOT_TOKEN = 'xoxb-process-env';
      process.env.SLACK_APP_TOKEN = 'xapp-process-env';
      const creds = await loadSlackCredentials(dataDir);
      assert.deepEqual(creds, {
        botToken: 'xoxb-process-env',
        appToken: 'xapp-process-env',
      });
    } finally {
      if (prevBot === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = prevBot;
      if (prevApp === undefined) delete process.env.SLACK_APP_TOKEN;
      else process.env.SLACK_APP_TOKEN = prevApp;
      await rm(base, { recursive: true, force: true });
    }
  });
});
