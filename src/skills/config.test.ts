/**
 * Tests for the /aweek:config skill module.
 *
 * Covers:
 *   - showConfig: reads via loadConfigWithStatus, returns the canonical
 *     5-knob list grouped by category, surfaces file status.
 *   - editConfig: rejects missing args, unknown fields, invalid values,
 *     and unconfirmed writes; returns changed:false for no-ops without
 *     touching the file; persists when confirmed and the value differs.
 *   - listEditableFields: timeZone is the only editable field today,
 *     validation rejects empty / non-IANA strings.
 *   - formatShowConfigResult / formatEditConfigResult: spot-check the
 *     human-readable rendering so the skill markdown can rely on the
 *     output shape.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  showConfig,
  editConfig,
  listEditableFields,
  formatShowConfigResult,
  formatEditConfigResult,
} from './config.js';

let tmpRoot: string;
let dataDir: string;
let configFilePath: string;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'aweek-config-skill-'));
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Each test gets a fresh `.aweek/agents` (the canonical dataDir shape) +
  // an empty `.aweek/` so tests can write `.aweek/config.json` directly.
  const aweekRoot = join(tmpRoot, `case-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(join(aweekRoot, 'agents'), { recursive: true });
  dataDir = join(aweekRoot, 'agents');
  configFilePath = join(aweekRoot, 'config.json');
});

describe('showConfig', () => {
  it('returns 3 knobs grouped across Configuration / Scheduler', async () => {
    const result = await showConfig({ dataDir });
    assert.equal(result.knobs.length, 3);
    const categories = result.knobs.map((k) => k.category);
    assert.deepEqual(categories, [
      'Configuration',
      'Scheduler',
      'Scheduler',
    ]);
    const keys = result.knobs.map((k) => k.key);
    assert.deepEqual(keys, [
      'timeZone',
      'heartbeatIntervalSec',
      'staleTaskWindowMs',
    ]);
  });

  it('marks every surfaced knob editable and config-backed', async () => {
    const result = await showConfig({ dataDir });
    const editable = result.knobs.filter((k) => k.editable);
    assert.deepEqual(
      editable.map((k) => k.key),
      ['timeZone', 'heartbeatIntervalSec', 'staleTaskWindowMs'],
    );
    for (const k of result.knobs) {
      assert.equal(k.editable, true);
      assert.equal(k.source, 'config');
    }
  });

  it('reads the live staleTaskWindowMs from config.json when set', async () => {
    await writeFile(
      configFilePath,
      JSON.stringify({ timeZone: 'UTC', staleTaskWindowMs: 1_200_000 }),
    );
    const result = await showConfig({ dataDir });
    const stale = result.knobs.find((k) => k.key === 'staleTaskWindowMs')!;
    assert.equal(stale.value, '1200000');
    assert.equal(stale.defaultValue, '3600000');
  });

  it('reports status=ok when the config file is absent', async () => {
    const result = await showConfig({ dataDir });
    assert.equal(result.status, 'ok');
    assert.equal(result.configFile, configFilePath);
    // timeZone falls back to the system default; just assert it's a non-empty string.
    const tz = result.knobs.find((k) => k.key === 'timeZone')!;
    assert.equal(typeof tz.value, 'string');
    assert.ok(tz.value.length > 0);
  });

  it('reports status=ok and the loaded value when the config file is valid', async () => {
    await writeFile(configFilePath, JSON.stringify({ timeZone: 'Asia/Seoul' }));
    const result = await showConfig({ dataDir });
    assert.equal(result.status, 'ok');
    assert.equal(result.knobs.find((k) => k.key === 'timeZone')!.value, 'Asia/Seoul');
  });

  it('reports status=missing when the config file is malformed JSON', async () => {
    await writeFile(configFilePath, 'not valid json');
    const result = await showConfig({ dataDir });
    assert.equal(result.status, 'missing');
  });

  it('throws when dataDir is omitted', async () => {
    await assert.rejects(() => showConfig({}), /dataDir is required/);
  });
});

describe('listEditableFields', () => {
  it('exposes timeZone, staleTaskWindowMs, and heartbeatIntervalSec', () => {
    const keys = listEditableFields().map((f) => f.key);
    assert.deepEqual(keys, [
      'timeZone',
      'staleTaskWindowMs',
      'heartbeatIntervalSec',
    ]);
  });

  it('timeZone validator rejects empty / non-IANA strings, accepts canonical zones', () => {
    const tz = listEditableFields().find((f) => f.key === 'timeZone')!;
    assert.equal(tz.validate('').ok, false);
    assert.equal(tz.validate('   ').ok, false);
    assert.equal(tz.validate('Mars/Olympus').ok, false);
    const goodSeoul = tz.validate('Asia/Seoul');
    assert.equal(goodSeoul.ok, true);
    if (goodSeoul.ok) assert.equal(goodSeoul.normalized, 'Asia/Seoul');
    const goodLA = tz.validate('  America/Los_Angeles  ');
    assert.equal(goodLA.ok, true);
    if (goodLA.ok) assert.equal(goodLA.normalized, 'America/Los_Angeles');
  });

  it('staleTaskWindowMs validator parses, range-checks, and returns a number', () => {
    const stale = listEditableFields().find((f) => f.key === 'staleTaskWindowMs')!;
    assert.equal(stale.validate('').ok, false);
    assert.equal(stale.validate('not a number').ok, false);
    assert.equal(stale.validate('0').ok, false);
    assert.equal(stale.validate('100').ok, false); // below 60_000 floor
    assert.equal(stale.validate(String(25 * 60 * 60 * 1000)).ok, false); // above 24h ceiling
    const ok = stale.validate('1200000'); // 20 minutes
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.normalized, 1_200_000);
      assert.equal(typeof ok.normalized, 'number');
    }
    // Decimals are truncated then range-checked.
    const truncated = stale.validate('1200000.7');
    assert.equal(truncated.ok, true);
    if (truncated.ok) assert.equal(truncated.normalized, 1_200_000);
  });
});

describe('editConfig', () => {
  it('refuses missing dataDir / field / value', async () => {
    assert.equal((await editConfig({})).ok, false);
    assert.equal((await editConfig({ dataDir })).ok, false);
    assert.equal((await editConfig({ dataDir, field: 'timeZone' })).ok, false);
  });

  it('rejects unknown fields with an explanatory reason', async () => {
    const result = await editConfig({
      dataDir,
      field: 'lockDir',
      value: '.aweek/.locks',
      confirmed: true,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not editable/);
  });

  it('rejects invalid timeZone before any write', async () => {
    const result = await editConfig({
      dataDir,
      field: 'timeZone',
      value: 'Mars/Olympus',
      confirmed: true,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not a recognised IANA/);
    // No file should have been created.
    await assert.rejects(() => readFile(configFilePath, 'utf8'), /ENOENT/);
  });

  it('refuses to write a real change without confirmed=true', async () => {
    const result = await editConfig({
      dataDir,
      field: 'timeZone',
      value: 'Asia/Seoul',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /confirmed=true is required/);
    await assert.rejects(() => readFile(configFilePath, 'utf8'), /ENOENT/);
  });

  it('returns changed:false on a no-op edit without requiring confirmation', async () => {
    await writeFile(configFilePath, JSON.stringify({ timeZone: 'Asia/Seoul' }));
    const result = await editConfig({
      dataDir,
      field: 'timeZone',
      value: 'Asia/Seoul',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.changed, false);
      assert.equal(result.before, 'Asia/Seoul');
      assert.equal(result.after, 'Asia/Seoul');
    }
  });

  it('persists a real change when confirmed=true', async () => {
    await writeFile(configFilePath, JSON.stringify({ timeZone: 'America/Los_Angeles' }));
    const result = await editConfig({
      dataDir,
      field: 'timeZone',
      value: 'Asia/Seoul',
      confirmed: true,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.changed, true);
      assert.equal(result.before, 'America/Los_Angeles');
      assert.equal(result.after, 'Asia/Seoul');
    }
    const written = JSON.parse(await readFile(configFilePath, 'utf8'));
    assert.equal(written.timeZone, 'Asia/Seoul');
  });

  it('creates the config file when absent and confirmed write differs from default', async () => {
    const result = await editConfig({
      dataDir,
      field: 'timeZone',
      value: 'Asia/Seoul',
      confirmed: true,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.changed, true);
    const written = JSON.parse(await readFile(configFilePath, 'utf8'));
    assert.equal(written.timeZone, 'Asia/Seoul');
  });

  it('rejects out-of-range staleTaskWindowMs without writing', async () => {
    const result = await editConfig({
      dataDir,
      field: 'staleTaskWindowMs',
      value: '500',
      confirmed: true,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /out of range/);
    await assert.rejects(() => readFile(configFilePath, 'utf8'), /ENOENT/);
  });

  it('refuses to write a real staleTaskWindowMs change without confirmed=true', async () => {
    const result = await editConfig({
      dataDir,
      field: 'staleTaskWindowMs',
      value: '1200000',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /confirmed=true is required/);
    await assert.rejects(() => readFile(configFilePath, 'utf8'), /ENOENT/);
  });

  it('persists staleTaskWindowMs as a number (not a string) when confirmed', async () => {
    const result = await editConfig({
      dataDir,
      field: 'staleTaskWindowMs',
      value: '1200000',
      confirmed: true,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.changed, true);
      assert.equal(result.before, '3600000');
      assert.equal(result.after, '1200000');
    }
    const written = JSON.parse(await readFile(configFilePath, 'utf8'));
    assert.equal(written.staleTaskWindowMs, 1_200_000);
    assert.equal(typeof written.staleTaskWindowMs, 'number');
  });

  it('returns changed:false when staleTaskWindowMs already matches', async () => {
    await writeFile(
      configFilePath,
      JSON.stringify({ timeZone: 'UTC', staleTaskWindowMs: 1_200_000 }),
    );
    const result = await editConfig({
      dataDir,
      field: 'staleTaskWindowMs',
      value: '1200000',
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.changed, false);
  });
});

describe('formatShowConfigResult', () => {
  it('renders header, file status, category sections, and the editable-fields footer', async () => {
    const rendered = formatShowConfigResult(await showConfig({ dataDir }));
    assert.match(rendered, /=== aweek Configuration ===/);
    assert.match(rendered, /Config file: /);
    assert.match(rendered, /File status: ok/);
    assert.match(rendered, /-- Configuration --/);
    assert.match(rendered, /-- Scheduler --/);
    assert.doesNotMatch(rendered, /-- Locks --/);
    assert.match(
      rendered,
      /Editable fields: timeZone, heartbeatIntervalSec, staleTaskWindowMs/,
    );
  });

  it('annotates malformed file status', async () => {
    await writeFile(configFilePath, 'not valid json');
    const rendered = formatShowConfigResult(await showConfig({ dataDir }));
    assert.match(rendered, /File status: missing/);
  });
});

describe('formatEditConfigResult', () => {
  it('renders the success block with the diff', () => {
    const rendered = formatEditConfigResult({
      ok: true,
      field: 'timeZone',
      label: 'Time Zone',
      before: 'America/Los_Angeles',
      after: 'Asia/Seoul',
      configFile: '/tmp/example/.aweek/config.json',
      changed: true,
    });
    assert.match(rendered, /Updated Time Zone \(timeZone\)/);
    assert.match(rendered, /America\/Los_Angeles\s+→\s+Asia\/Seoul/);
    assert.match(rendered, /Wrote \/tmp\/example\/.aweek\/config\.json/);
  });

  it('renders the no-op block', () => {
    const rendered = formatEditConfigResult({
      ok: true,
      field: 'timeZone',
      label: 'Time Zone',
      before: 'Asia/Seoul',
      after: 'Asia/Seoul',
      configFile: '/tmp/example/.aweek/config.json',
      changed: false,
    });
    assert.match(rendered, /Time Zone \(timeZone\) is already Asia\/Seoul/);
    assert.match(rendered, /No write performed/);
  });

  it('renders failures with reason and field', () => {
    const rendered = formatEditConfigResult({
      ok: false,
      field: 'timeZone',
      reason: 'invalid time zone',
    });
    assert.match(rendered, /=== aweek Config Edit \(failed\) ===/);
    assert.match(rendered, /Reason: invalid time zone/);
    assert.match(rendered, /Field: timeZone/);
  });
});
