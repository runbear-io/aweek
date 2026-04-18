/**
 * Tests for `hire-all.js` — the handler that iterates over discovered
 * subagent slugs and creates minimal aweek JSON wrappers for each one.
 *
 * Coverage
 * --------
 *   - Happy path: every provided slug gets a fresh shell on disk and the
 *     result lists them under `created`. The written file matches the
 *     `createAgentConfig({ subagentRef })` schema (empty goals / plans /
 *     inbox, default budget, id === subagentRef === slug).
 *   - Skip: plugin-namespaced slugs (`oh-my-claudecode-*`, `geo-*`) are
 *     NEVER wrapped and land under `skipped`.
 *   - Skip: slugs that already have an aweek JSON wrapper are left
 *     untouched (idempotency) and land under `skipped`.
 *   - Skip: duplicate slugs in the same input list are deduplicated — one
 *     create, one skip.
 *   - Fail: slugs missing the `.claude/agents/<slug>.md` file are
 *     recorded under `failed` (never wrapped — the heartbeat would
 *     auto-pause them immediately as `subagent_missing`).
 *   - Fail: invalid slug shapes land under `failed` with the slug regex
 *     error surfaced by `validateSubagentSlug`.
 *   - Empty input is a legal no-op.
 *   - `success` flag flips off when any slug fails; skips alone do NOT
 *     trigger a failure.
 *   - `formatHireAllSummary` produces a readable block that omits empty
 *     sections and handles the all-empty edge case.
 *   - Budget: `weeklyTokenLimit` override propagates to every shell; the
 *     default matches `DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT`.
 */
import { describe, it, before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  hireAllSubagents,
  formatHireAllSummary,
  DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT,
} from './hire-all.js';
import { writeSubagentFile } from '../subagents/subagent-file.js';
import { AgentStore } from '../storage/agent-store.js';
import { createAgentConfig } from '../models/agent.js';

describe('hire-all — hireAllSubagents', () => {
  let tmpProject;
  let dataDir;
  let store;

  beforeEach(async () => {
    tmpProject = await mkdtemp(join(tmpdir(), 'aweek-hire-all-'));
    dataDir = join(tmpProject, '.aweek', 'agents');
    store = new AgentStore(dataDir);
  });

  afterEach(async () => {
    await rm(tmpProject, { recursive: true, force: true });
  });

  it('wraps every well-formed slug with a fresh aweek JSON shell', async () => {
    // Two subagent .md files on disk; no existing aweek wrappers.
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write things.',
      projectDir: tmpProject,
    });
    await writeSubagentFile({
      slug: 'analyst',
      description: 'Analyst',
      systemPrompt: 'Analyse things.',
      projectDir: tmpProject,
    });

    const result = await hireAllSubagents({
      slugs: ['writer', 'analyst'],
      projectDir: tmpProject,
      dataDir,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.created.sort(), ['analyst', 'writer']);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.failed, []);

    // Verify each shell is on disk with the expected shape.
    for (const slug of ['writer', 'analyst']) {
      const loaded = await store.load(slug);
      assert.equal(loaded.id, slug);
      assert.equal(loaded.subagentRef, slug);
      assert.deepEqual(loaded.goals, []);
      assert.deepEqual(loaded.monthlyPlans, []);
      assert.deepEqual(loaded.weeklyPlans, []);
      assert.deepEqual(loaded.inbox, []);
      assert.equal(loaded.budget.paused, false);
      // pausedReason is explicitly null on a fresh hire — distinguishable
      // from "field missing because the schema predates the column".
      assert.strictEqual(loaded.budget.pausedReason, null);
      assert.equal(
        loaded.budget.weeklyTokenLimit,
        DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT,
      );
      assert.equal(loaded.budget.currentUsage, 0);
      // No identity fields are persisted — identity lives in the .md.
      assert.equal(loaded.identity, undefined);
      assert.equal(loaded.name, undefined);
    }
  });

  it('writes pausedReason: null literally to disk on every shell (Sub-AC 1 of AC 11)', async () => {
    // Regression guard: the explicit `pausedReason: null` marker must
    // survive JSON serialisation. A plain `undefined` would be silently
    // dropped by `JSON.stringify` and that would defeat the "never
    // paused, no reason" signal downstream readers rely on.
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write things.',
      projectDir: tmpProject,
    });
    await writeSubagentFile({
      slug: 'analyst',
      description: 'Analyst',
      systemPrompt: 'Analyse things.',
      projectDir: tmpProject,
    });

    const result = await hireAllSubagents({
      slugs: ['writer', 'analyst'],
      projectDir: tmpProject,
      dataDir,
    });
    assert.equal(result.success, true);

    for (const slug of ['writer', 'analyst']) {
      const raw = await readFile(join(dataDir, `${slug}.json`), 'utf-8');
      const parsed = JSON.parse(raw);
      // The serialised JSON must carry an explicit `null` value for
      // `pausedReason`, not omit the property.
      assert.ok(
        Object.prototype.hasOwnProperty.call(parsed.budget, 'pausedReason'),
        `${slug}.json should serialise pausedReason as a property, not omit it`,
      );
      assert.strictEqual(parsed.budget.pausedReason, null);
      assert.strictEqual(parsed.budget.paused, false);
      // Empty plan arrays survive serialisation (defensive check that the
      // shell never leaks populated defaults from a future model drift).
      assert.deepEqual(parsed.goals, []);
      assert.deepEqual(parsed.monthlyPlans, []);
      assert.deepEqual(parsed.weeklyPlans, []);
      assert.deepEqual(parsed.inbox, []);
      // Raw JSON must literally contain the `"pausedReason": null` token.
      assert.match(raw, /"pausedReason":\s*null/);
    }
  });

  it('applies a custom weeklyTokenLimit to every created shell', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write things.',
      projectDir: tmpProject,
    });

    const customLimit = 123_456;
    const result = await hireAllSubagents({
      slugs: ['writer'],
      weeklyTokenLimit: customLimit,
      projectDir: tmpProject,
      dataDir,
    });

    assert.equal(result.success, true);
    const loaded = await store.load('writer');
    assert.equal(loaded.budget.weeklyTokenLimit, customLimit);
    assert.equal(loaded.weeklyTokenBudget, customLimit);
  });

  it('skips plugin-namespaced slugs per v1 constraint', async () => {
    // Plugin-namespaced slugs should never be wrapped, even if a .md file
    // happens to exist for them on disk. The handler is the second line
    // of defense after `listUnhiredSubagents` already filters them out.
    await writeSubagentFile({
      slug: 'oh-my-claudecode-executor',
      description: 'Plugin',
      systemPrompt: 'hi.',
      projectDir: tmpProject,
    });
    await writeSubagentFile({
      slug: 'geo-audit',
      description: 'Plugin',
      systemPrompt: 'hi.',
      projectDir: tmpProject,
    });

    const result = await hireAllSubagents({
      slugs: ['oh-my-claudecode-executor', 'geo-audit'],
      projectDir: tmpProject,
      dataDir,
    });

    // Skips do NOT flip `success` off — they're a legal outcome.
    assert.equal(result.success, true);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.failed, []);
    assert.equal(result.skipped.length, 2);
    for (const entry of result.skipped) {
      assert.match(entry.reason, /plugin-namespaced/i);
    }
    // Nothing was persisted.
    assert.equal(await store.exists('oh-my-claudecode-executor'), false);
    assert.equal(await store.exists('geo-audit'), false);
  });

  it('skips already-hired slugs (idempotent re-run)', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write things.',
      projectDir: tmpProject,
    });
    // Pre-hire the slug so the handler sees an existing wrapper.
    await store.save(
      createAgentConfig({ subagentRef: 'writer', weeklyTokenLimit: 999 }),
    );

    const result = await hireAllSubagents({
      slugs: ['writer'],
      projectDir: tmpProject,
      dataDir,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.created, []);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].slug, 'writer');
    assert.match(result.skipped[0].reason, /already (hired|exists)/i);

    // The pre-existing wrapper is NOT overwritten — the custom budget
    // from the seed config is still there.
    const loaded = await store.load('writer');
    assert.equal(loaded.budget.weeklyTokenLimit, 999);
  });

  it('deduplicates repeated slugs in a single input list', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write things.',
      projectDir: tmpProject,
    });

    const result = await hireAllSubagents({
      slugs: ['writer', 'writer', 'writer'],
      projectDir: tmpProject,
      dataDir,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.created, ['writer']);
    assert.equal(result.skipped.length, 2);
    for (const entry of result.skipped) {
      assert.equal(entry.slug, 'writer');
    }
  });

  it('records missing .md files as `failed` (never wraps them)', async () => {
    // No subagent file written — the directory may not even exist.
    const result = await hireAllSubagents({
      slugs: ['ghost'],
      projectDir: tmpProject,
      dataDir,
    });

    assert.equal(result.success, false);
    assert.deepEqual(result.created, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].slug, 'ghost');
    assert.match(result.failed[0].errors[0], /\.claude\/agents\/ghost\.md/);
    assert.match(result.failed[0].errors[0], /not found|does not exist/i);

    // No wrapper was created.
    assert.equal(await store.exists('ghost'), false);
  });

  it('does not short-circuit the batch when one slug fails', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write things.',
      projectDir: tmpProject,
    });

    const result = await hireAllSubagents({
      slugs: ['writer', 'ghost'],
      projectDir: tmpProject,
      dataDir,
    });

    // Overall success flips to false because at least one slug failed,
    // but the good slug is still wrapped.
    assert.equal(result.success, false);
    assert.deepEqual(result.created, ['writer']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].slug, 'ghost');
    assert.equal(await store.exists('writer'), true);
    assert.equal(await store.exists('ghost'), false);
  });

  it('records invalid slug shapes as `failed`', async () => {
    // Underscores + uppercase + spaces are all disallowed by
    // SUBAGENT_SLUG_PATTERN. Each bad input lands in `failed`.
    const result = await hireAllSubagents({
      slugs: ['Bad_Slug', 'another bad slug', '-leading-hyphen'],
      projectDir: tmpProject,
      dataDir,
    });

    assert.equal(result.success, false);
    assert.deepEqual(result.created, []);
    assert.equal(result.failed.length, 3);
    for (const entry of result.failed) {
      assert.ok(Array.isArray(entry.errors));
      assert.ok(entry.errors.length > 0);
    }
  });

  it('records non-string slug entries as `failed` without throwing', async () => {
    const result = await hireAllSubagents({
      slugs: ['writer', null, 42, {}],
      projectDir: tmpProject,
      dataDir,
    });

    // `writer` has no .md in this test — so it is failed too. The point
    // of this test is to confirm that non-string entries do NOT throw
    // and instead land in `failed`.
    assert.equal(result.success, false);
    const badShapes = result.failed.filter((e) => e.slug !== 'writer');
    assert.equal(badShapes.length, 3);
  });

  it('returns an empty-success result on empty input', async () => {
    const result = await hireAllSubagents({
      slugs: [],
      projectDir: tmpProject,
      dataDir,
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.failed, []);
  });

  it('rejects non-array slugs input with a structured failure (no throw)', async () => {
    for (const bad of [undefined, null, 'writer', { 0: 'writer' }, 42]) {
      const result = await hireAllSubagents({
        slugs: bad,
        projectDir: tmpProject,
        dataDir,
      });
      assert.equal(result.success, false);
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0].slug, '(input)');
      assert.match(result.failed[0].errors[0], /slugs.*array/i);
    }
  });

  it('accepts an injected agentStore (test hook)', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write things.',
      projectDir: tmpProject,
    });

    // Use a store pointed at a different directory; the handler should
    // write there instead of the default `.aweek/agents/` under cwd.
    const altDir = join(tmpProject, 'custom-aweek-dir');
    const injected = new AgentStore(altDir);
    const result = await hireAllSubagents({
      slugs: ['writer'],
      projectDir: tmpProject,
      agentStore: injected,
    });

    assert.equal(result.success, true);
    assert.equal(result.created[0], 'writer');
    assert.equal(await injected.exists('writer'), true);
  });

  it('preserves the per-slug result order to match the input order', async () => {
    // Order matters for UX — the summary renders slugs in the same order
    // the user saw them in the menu.
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write things.',
      projectDir: tmpProject,
    });
    await writeSubagentFile({
      slug: 'analyst',
      description: 'Analyst',
      systemPrompt: 'Analyse things.',
      projectDir: tmpProject,
    });
    await writeSubagentFile({
      slug: 'researcher',
      description: 'Researcher',
      systemPrompt: 'Research things.',
      projectDir: tmpProject,
    });

    const result = await hireAllSubagents({
      slugs: ['researcher', 'analyst', 'writer'],
      projectDir: tmpProject,
      dataDir,
    });
    assert.deepEqual(result.created, ['researcher', 'analyst', 'writer']);
  });
});

describe('hire-all — formatHireAllSummary', () => {
  it('lists every outcome block, skipping empty sections', () => {
    const text = formatHireAllSummary({
      success: false,
      created: ['writer'],
      skipped: [{ slug: 'oh-my-claudecode-explore', reason: 'plugin-namespaced' }],
      failed: [{ slug: 'ghost', errors: ['not found'] }],
    });
    assert.match(text, /Created 1 aweek JSON wrapper/);
    assert.match(text, /\+ writer/);
    assert.match(text, /Skipped 1/);
    assert.match(text, /oh-my-claudecode-explore — plugin-namespaced/);
    assert.match(text, /Failed 1/);
    assert.match(text, /! ghost: not found/);
  });

  it('omits the Skipped block when there are zero skips', () => {
    const text = formatHireAllSummary({
      success: true,
      created: ['writer'],
      skipped: [],
      failed: [],
    });
    assert.match(text, /Created 1/);
    assert.ok(!/Skipped/.test(text));
    assert.ok(!/Failed/.test(text));
  });

  it('returns a single-line message when every bucket is empty', () => {
    const text = formatHireAllSummary({
      success: true,
      created: [],
      skipped: [],
      failed: [],
    });
    assert.match(text, /no slugs to process/i);
  });

  it('returns an empty string on null / undefined', () => {
    assert.equal(formatHireAllSummary(null), '');
    assert.equal(formatHireAllSummary(undefined), '');
  });

  it('pluralises counts correctly', () => {
    const text = formatHireAllSummary({
      success: true,
      created: ['a', 'b'],
      skipped: [],
      failed: [],
    });
    assert.match(text, /Created 2 aweek JSON wrappers/);
  });
});

describe('hire-all — constants', () => {
  it('DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT matches the shared default', () => {
    assert.equal(DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT, 500_000);
  });
});
