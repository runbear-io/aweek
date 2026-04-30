/**
 * Tests for the /api/config data gatherer.
 *
 * Covers:
 *   - gatherAppConfig returns the expected payload shape.
 *   - status 'ok' when config.json is absent (ENOENT — fresh project).
 *   - status 'ok' when config.json is present and valid.
 *   - status 'missing' when config.json exists but is malformed JSON.
 *   - status 'missing' when config.json has an invalid timeZone.
 *   - All three categories (configuration, scheduler, locks) are always present.
 *   - Hardcoded constants surface with the expected compiled-in values.
 *   - Requires projectDir; throws on missing arg.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { gatherAppConfig } from './config.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function makeTmp(): Promise<string> {
  const base = join(
    tmpdir(),
    `aweek-config-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(base, { recursive: true });
  return base;
}

async function makeProject(configJson?: string): Promise<string> {
  const root = await makeTmp();
  const aweekDir = join(root, '.aweek');
  await mkdir(aweekDir, { recursive: true });
  // The gatherer uses the agents dir; config.json lives one level up at .aweek/config.json.
  await mkdir(join(aweekDir, 'agents'), { recursive: true });
  if (configJson !== undefined) {
    await writeFile(join(aweekDir, 'config.json'), configJson, 'utf-8');
  }
  return root;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('gatherAppConfig: requires projectDir', async () => {
  await assert.rejects(() => gatherAppConfig({}), /projectDir is required/);
  await assert.rejects(() => gatherAppConfig(), /projectDir is required/);
});

// ---------------------------------------------------------------------------
// Status semantics
// ---------------------------------------------------------------------------

test('gatherAppConfig: absent config.json → status ok (ENOENT is not a warning)', async () => {
  const root = await makeProject(); // no config.json written
  try {
    const payload = await gatherAppConfig({ projectDir: root });
    assert.equal(payload.status, 'ok', 'ENOENT must yield status ok, not missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAppConfig: valid config.json → status ok', async () => {
  const root = await makeProject(JSON.stringify({ timeZone: 'America/New_York' }));
  try {
    const payload = await gatherAppConfig({ projectDir: root });
    assert.equal(payload.status, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAppConfig: malformed JSON → status missing', async () => {
  const root = await makeProject('{ "timeZone": '); // truncated / broken JSON
  try {
    const payload = await gatherAppConfig({ projectDir: root });
    assert.equal(payload.status, 'missing', 'malformed JSON must yield status missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAppConfig: invalid timeZone → status missing', async () => {
  const root = await makeProject(JSON.stringify({ timeZone: 'Not/A/Real/Zone' }));
  try {
    const payload = await gatherAppConfig({ projectDir: root });
    assert.equal(payload.status, 'missing', 'invalid timeZone must yield status missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Category structure
// ---------------------------------------------------------------------------

test('gatherAppConfig: always returns the configured categories with expected ids', async () => {
  const root = await makeProject();
  try {
    const payload = await gatherAppConfig({ projectDir: root });
    assert.ok(Array.isArray(payload.categories));
    const ids = payload.categories.map((c) => c.id);
    assert.deepEqual(ids, ['configuration', 'scheduler']);
    for (const cat of payload.categories) {
      assert.equal(typeof cat.id, 'string');
      assert.equal(typeof cat.label, 'string');
      assert.ok(Array.isArray(cat.items));
      assert.ok(cat.items.length > 0, `category ${cat.id} must have at least one item`);
      for (const item of cat.items) {
        assert.equal(typeof item.key, 'string');
        assert.equal(typeof item.label, 'string');
        assert.ok(
          typeof item.value === 'string' ||
            typeof item.value === 'number' ||
            typeof item.value === 'boolean',
          `item ${item.key} value must be string | number | boolean`,
        );
        assert.equal(typeof item.description, 'string');
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Configuration category — live values
// ---------------------------------------------------------------------------

test('gatherAppConfig: absent config surfaces a non-empty default timeZone', async () => {
  const root = await makeProject();
  try {
    const payload = await gatherAppConfig({ projectDir: root });
    const cfg = payload.categories.find((c) => c.id === 'configuration');
    assert.ok(cfg);
    const tz = cfg.items.find((i) => i.key === 'timeZone');
    assert.ok(tz, 'timeZone item must exist in configuration category');
    // Default is the host system timezone (DEFAULT_TZ from src/time/zone.ts) — we
    // cannot assert a fixed value across machines, but it must be a non-empty IANA string.
    assert.equal(typeof tz.value, 'string');
    assert.ok((tz.value as string).length > 0, 'default timeZone must be a non-empty string');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherAppConfig: valid config surfaces the configured timeZone', async () => {
  const root = await makeProject(JSON.stringify({ timeZone: 'Europe/Paris' }));
  try {
    const payload = await gatherAppConfig({ projectDir: root });
    const cfg = payload.categories.find((c) => c.id === 'configuration');
    assert.ok(cfg);
    const tz = cfg.items.find((i) => i.key === 'timeZone');
    assert.ok(tz);
    assert.equal(tz.value, 'Europe/Paris');
    assert.equal(payload.status, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scheduler category — compiled-in constants
// ---------------------------------------------------------------------------

test('gatherAppConfig: scheduler category surfaces heartbeatIntervalSec and staleTaskWindowMs', async () => {
  const root = await makeProject();
  try {
    const payload = await gatherAppConfig({ projectDir: root });
    const scheduler = payload.categories.find((c) => c.id === 'scheduler');
    assert.ok(scheduler, 'scheduler category must be present');

    const heartbeat = scheduler.items.find((i) => i.key === 'heartbeatIntervalSec');
    assert.ok(heartbeat, 'heartbeatIntervalSec item must exist');
    assert.equal(heartbeat.value, 600, 'heartbeat interval must be 600 s (10 min)');

    const stale = scheduler.items.find((i) => i.key === 'staleTaskWindowMs');
    assert.ok(stale, 'staleTaskWindowMs item must exist');
    assert.equal(stale.value, 3_600_000, 'stale window must be 3 600 000 ms (60 min)');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Lock layout (lockDir / maxLockAgeMs) was intentionally dropped from the
// Settings page surface — those remain hardcoded in src/lock/lock-manager.ts
// but are no longer surfaced through /api/config or /aweek:config.

// ---------------------------------------------------------------------------
// Graceful degradation — malformed config still returns the scheduler defaults
// ---------------------------------------------------------------------------

test('gatherAppConfig: malformed config still returns the scheduler defaults', async () => {
  const root = await makeProject('not valid json at all');
  try {
    const payload = await gatherAppConfig({ projectDir: root });
    assert.equal(payload.status, 'missing');
    // Scheduler items still render with the loadConfig defaults — a malformed
    // file falls back to defaults rather than dropping the category.
    const scheduler = payload.categories.find((c) => c.id === 'scheduler');
    assert.ok(scheduler && scheduler.items.length >= 2);
    // No locks category is surfaced anymore.
    const locks = payload.categories.find((c) => c.id === 'locks');
    assert.equal(locks, undefined);
    // timeZone falls back to the system default (DEFAULT_TZ from zone.ts).
    const cfg = payload.categories.find((c) => c.id === 'configuration');
    const tz = cfg?.items.find((i) => i.key === 'timeZone');
    assert.ok(tz, 'timeZone item must be present even with malformed config');
    assert.equal(typeof tz.value, 'string');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
