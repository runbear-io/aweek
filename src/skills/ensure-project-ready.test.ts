/**
 * Tests for the ensureProjectReady prelude. Real fs in a tmp dir for the
 * data-dir bootstrap; detectInitState + installHeartbeat are stubbed
 * since they're already covered by their own modules' tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, saveConfig } from '../storage/config-store.js';
import {
  ensureProjectReady,
  HEARTBEAT_PROMPT,
  type EnsureProjectReadyOptions,
} from './ensure-project-ready.js';

async function tempProject(): Promise<{ projectDir: string; cleanup: () => Promise<void> }> {
  const projectDir = await mkdtemp(join(tmpdir(), 'aweek-ensure-'));
  return {
    projectDir,
    cleanup: () => rm(projectDir, { recursive: true, force: true }),
  };
}

function fakeDetect(installed: boolean) {
  // Returns a stub detectInitStateFn that always reports the given install state.
  return async () => ({
    projectDir: '/fake',
    dataDir: { path: '/fake/.aweek', exists: true, agentCount: 0 },
    heartbeat: {
      installed,
      schedule: installed ? '*/10 * * * *' : null,
      command: installed ? 'aweek heartbeat' : null,
    },
    needsWork: { dataDir: false, heartbeat: !installed },
    fullyInitialized: installed,
  });
}

function recordingInstall() {
  const calls: Array<Record<string, unknown>> = [];
  const fn = async (opts: Record<string, unknown> = {}) => {
    calls.push(opts);
    return { backend: 'cron' as const };
  };
  return { fn, calls };
}

describe('ensureProjectReady', () => {
  it('bootstraps .aweek/ when absent and reports created', async () => {
    const { projectDir, cleanup } = await tempProject();
    try {
      const result = await ensureProjectReady({
        projectDir,
        skipHeartbeat: true,
      });
      assert.equal(result.steps.dataDir, 'created');
      assert.equal(result.steps.config, 'created');
      assert.equal(result.steps.heartbeat, 'skipped');
      assert.ok(result.dataDir.endsWith(join('.aweek', 'agents')));
    } finally {
      await cleanup();
    }
  });

  it('reports existed on the second call', async () => {
    const { projectDir, cleanup } = await tempProject();
    try {
      await ensureProjectReady({ projectDir, skipHeartbeat: true });
      const result = await ensureProjectReady({ projectDir, skipHeartbeat: true });
      assert.equal(result.steps.dataDir, 'existed');
      assert.equal(result.steps.config, 'existed');
    } finally {
      await cleanup();
    }
  });

  it('returns existed when the heartbeat is already installed and records the decision', async () => {
    const { projectDir, cleanup } = await tempProject();
    try {
      const opts: EnsureProjectReadyOptions = {
        projectDir,
        detectInitStateFn: fakeDetect(true),
        nowFn: () => new Date('2026-05-01T12:00:00.000Z'),
      };
      const result = await ensureProjectReady(opts);
      assert.equal(result.steps.heartbeat, 'existed');
      assert.deepEqual(result.config.heartbeat, {
        promptedAt: '2026-05-01T12:00:00.000Z',
        decision: 'installed',
      });
    } finally {
      await cleanup();
    }
  });

  it('honors a sticky declined decision without prompting', async () => {
    const { projectDir, cleanup } = await tempProject();
    try {
      // Bootstrap, then write a declined record.
      await ensureProjectReady({ projectDir, skipHeartbeat: true });
      const dataDir = join(projectDir, '.aweek', 'agents');
      await saveConfig(dataDir, {
        heartbeat: { promptedAt: '2026-05-01T12:00:00.000Z', decision: 'declined' },
      });
      const installer = recordingInstall();
      const result = await ensureProjectReady({
        projectDir,
        detectInitStateFn: fakeDetect(false),
        installHeartbeatFn: installer.fn as never,
      });
      assert.equal(result.steps.heartbeat, 'declined');
      assert.equal(installer.calls.length, 0);
      assert.equal(result.heartbeatPrompt, undefined);
    } finally {
      await cleanup();
    }
  });

  it('installs the heartbeat when the user answers install', async () => {
    const { projectDir, cleanup } = await tempProject();
    try {
      const installer = recordingInstall();
      const result = await ensureProjectReady({
        projectDir,
        detectInitStateFn: fakeDetect(false),
        installHeartbeatFn: installer.fn as never,
        heartbeatAnswer: 'install',
        nowFn: () => new Date('2026-05-01T12:00:00.000Z'),
      });
      assert.equal(result.steps.heartbeat, 'installed');
      assert.equal(installer.calls.length, 1);
      assert.equal(installer.calls[0]!.confirmed, true);
      assert.deepEqual(result.config.heartbeat, {
        promptedAt: '2026-05-01T12:00:00.000Z',
        decision: 'installed',
      });
    } finally {
      await cleanup();
    }
  });

  it('writes a skipped decision without installing when the user answers skip', async () => {
    const { projectDir, cleanup } = await tempProject();
    try {
      const installer = recordingInstall();
      const result = await ensureProjectReady({
        projectDir,
        detectInitStateFn: fakeDetect(false),
        installHeartbeatFn: installer.fn as never,
        heartbeatAnswer: 'skip',
        nowFn: () => new Date('2026-05-01T12:00:00.000Z'),
      });
      assert.equal(result.steps.heartbeat, 'skipped');
      assert.equal(installer.calls.length, 0);
      assert.deepEqual(result.config.heartbeat, {
        promptedAt: '2026-05-01T12:00:00.000Z',
        decision: 'skipped',
      });
    } finally {
      await cleanup();
    }
  });

  it('writes a declined decision when the user answers skip-remember', async () => {
    const { projectDir, cleanup } = await tempProject();
    try {
      const installer = recordingInstall();
      const result = await ensureProjectReady({
        projectDir,
        detectInitStateFn: fakeDetect(false),
        installHeartbeatFn: installer.fn as never,
        heartbeatAnswer: 'skip-remember',
        nowFn: () => new Date('2026-05-01T12:00:00.000Z'),
      });
      assert.equal(result.steps.heartbeat, 'declined');
      assert.equal(installer.calls.length, 0);
      assert.deepEqual(result.config.heartbeat, {
        promptedAt: '2026-05-01T12:00:00.000Z',
        decision: 'declined',
      });
    } finally {
      await cleanup();
    }
  });

  it('returns awaiting-confirm with the prompt when no answer and no decision', async () => {
    const { projectDir, cleanup } = await tempProject();
    try {
      const result = await ensureProjectReady({
        projectDir,
        detectInitStateFn: fakeDetect(false),
      });
      assert.equal(result.steps.heartbeat, 'awaiting-confirm');
      assert.equal(result.heartbeatPrompt?.title, HEARTBEAT_PROMPT.title);
      assert.deepEqual(
        result.heartbeatPrompt?.options,
        ['install', 'skip', 'skip-remember'],
      );
    } finally {
      await cleanup();
    }
  });

  it('re-prompts when cached decision is installed but the plist is absent', async () => {
    const { projectDir, cleanup } = await tempProject();
    try {
      // Cache says installed.
      await ensureProjectReady({ projectDir, skipHeartbeat: true });
      const dataDir = join(projectDir, '.aweek', 'agents');
      await saveConfig(dataDir, {
        heartbeat: { promptedAt: '2026-05-01T12:00:00.000Z', decision: 'installed' },
      });
      // But fs probe says not installed.
      const result = await ensureProjectReady({
        projectDir,
        detectInitStateFn: fakeDetect(false),
      });
      assert.equal(result.steps.heartbeat, 'awaiting-confirm');
      // Cached decision is preserved on disk until the user answers.
      const cfg = await loadConfig(dataDir);
      assert.equal(cfg.heartbeat?.decision, 'installed');
    } finally {
      await cleanup();
    }
  });

  it('does not probe the heartbeat when skipHeartbeat is true on a fresh project', async () => {
    const { projectDir, cleanup } = await tempProject();
    try {
      let probeCalls = 0;
      const result = await ensureProjectReady({
        projectDir,
        skipHeartbeat: true,
        detectInitStateFn: (async () => {
          probeCalls += 1;
          return fakeDetect(false)();
        }) as never,
      });
      assert.equal(probeCalls, 0);
      assert.equal(result.steps.heartbeat, 'skipped');
    } finally {
      await cleanup();
    }
  });

  it('seeds .aweek/config.json with a timeZone on first call', async () => {
    const { projectDir, cleanup } = await tempProject();
    try {
      await ensureProjectReady({ projectDir, skipHeartbeat: true });
      const raw = await readFile(join(projectDir, '.aweek', 'config.json'), 'utf8');
      assert.match(raw, /"timeZone"/);
    } finally {
      await cleanup();
    }
  });
});
