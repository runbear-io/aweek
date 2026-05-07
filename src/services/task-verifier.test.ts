/**
 * Tests for `./task-verifier.ts` — the post-execution outcome verifier.
 *
 * Pinned contract:
 *
 *   1. `parseVerifierVerdict`
 *      - parses a clean JSON verdict and returns kind:'verdict'
 *      - tolerates leading/trailing prose around the JSON
 *      - drops concerns when achieved=true (contradiction guard)
 *      - clamps to MAX_CONCERNS, drops empty / non-string entries
 *      - returns kind:'skipped' on empty / malformed / missing fields
 *
 *   2. `buildVerifierPrompt`
 *      - includes the task title + prompt + stdout
 *      - tail-truncates very long outputs
 *      - appends stderr block when supplied
 *
 *   3. `verifyTaskOutcome` (with injected runner)
 *      - returns the parsed verdict on a happy-path runner
 *      - returns kind:'skipped' when runner throws
 *      - returns kind:'skipped' when signal is pre-aborted
 *      - returns kind:'skipped' when runner emits no JSON
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVerifierPrompt,
  parseVerifierVerdict,
  verifyTaskOutcome,
  type TaskVerifierRunner,
} from './task-verifier.ts';

// ── parseVerifierVerdict ────────────────────────────────────────────

describe('parseVerifierVerdict', () => {
  it('parses a clean verdict', () => {
    const r = parseVerifierVerdict(
      '{"achieved": false, "concerns": ["No publish tool ran"]}',
    );
    assert.equal(r.kind, 'verdict');
    if (r.kind !== 'verdict') return;
    assert.equal(r.achieved, false);
    assert.deepEqual(r.concerns, ['No publish tool ran']);
  });

  it('tolerates surrounding prose', () => {
    const r = parseVerifierVerdict(
      'Sure, here is the verdict:\n{"achieved": true, "concerns": []}\nThanks.',
    );
    assert.equal(r.kind, 'verdict');
    if (r.kind !== 'verdict') return;
    assert.equal(r.achieved, true);
    assert.deepEqual(r.concerns, []);
  });

  it('tolerates code fences', () => {
    const r = parseVerifierVerdict(
      '```json\n{"achieved": true, "concerns": []}\n```',
    );
    assert.equal(r.kind, 'verdict');
  });

  it('drops concerns when achieved=true (contradiction guard)', () => {
    const r = parseVerifierVerdict(
      '{"achieved": true, "concerns": ["something"]}',
    );
    assert.equal(r.kind, 'verdict');
    if (r.kind !== 'verdict') return;
    assert.equal(r.achieved, true);
    assert.deepEqual(r.concerns, []);
  });

  it('clamps to 5 concerns and drops non-strings / empties', () => {
    const r = parseVerifierVerdict(
      JSON.stringify({
        achieved: false,
        concerns: ['a', '', 'b', 42, null, 'c', 'd', 'e', 'f', 'g'],
      }),
    );
    assert.equal(r.kind, 'verdict');
    if (r.kind !== 'verdict') return;
    assert.deepEqual(r.concerns, ['a', 'b', 'c', 'd', 'e']);
  });

  it('returns skipped when raw is empty', () => {
    const r = parseVerifierVerdict('');
    assert.equal(r.kind, 'skipped');
  });

  it('returns skipped when no JSON object present', () => {
    const r = parseVerifierVerdict('I refuse');
    assert.equal(r.kind, 'skipped');
  });

  it('returns skipped when JSON is malformed', () => {
    const r = parseVerifierVerdict('{not json');
    assert.equal(r.kind, 'skipped');
  });

  it('returns skipped when achieved is missing', () => {
    const r = parseVerifierVerdict('{"concerns": []}');
    assert.equal(r.kind, 'skipped');
  });

  it('returns skipped when achieved is not a boolean', () => {
    const r = parseVerifierVerdict('{"achieved": "yes", "concerns": []}');
    assert.equal(r.kind, 'skipped');
  });

  it('truncates concern strings to 200 chars', () => {
    const long = 'x'.repeat(500);
    const r = parseVerifierVerdict(
      JSON.stringify({ achieved: false, concerns: [long] }),
    );
    assert.equal(r.kind, 'verdict');
    if (r.kind !== 'verdict') return;
    assert.equal(r.concerns[0]?.length, 200);
  });
});

// ── buildVerifierPrompt ──────────────────────────────────────────────

describe('buildVerifierPrompt', () => {
  it('includes title, prompt, and captured stdout', () => {
    const prompt = buildVerifierPrompt({
      taskId: 'task-abc',
      title: 'Publish Friday digest',
      prompt: 'Post the Friday digest to X.',
      output: 'I will draft a post and publish it.',
    });
    assert.match(prompt, /Publish Friday digest/);
    assert.match(prompt, /Post the Friday digest to X\./);
    assert.match(prompt, /I will draft a post and publish it\./);
    assert.match(prompt, /JSON/);
  });

  it('tail-truncates very long stdout', () => {
    const big = `${'A'.repeat(5_000)}TAIL${'B'.repeat(10_000)}`;
    const prompt = buildVerifierPrompt({
      taskId: 'task-1',
      title: 't',
      prompt: 'p',
      output: big,
    });
    // Truncation marker is present and the tail is preserved.
    assert.match(prompt, /\[truncated \d+ chars\]/);
    assert.ok(prompt.endsWith('B'.repeat(40)) || prompt.includes('B'.repeat(40)));
  });

  it('appends a stderr block when supplied', () => {
    const prompt = buildVerifierPrompt({
      taskId: 'task-1',
      title: 't',
      prompt: 'p',
      output: 'stdout',
      stderr: 'connection refused',
    });
    assert.match(prompt, /Captured stderr/);
    assert.match(prompt, /connection refused/);
  });
});

// ── verifyTaskOutcome ────────────────────────────────────────────────

function makeRunner(messages: unknown[]): TaskVerifierRunner {
  return () => ({
    [Symbol.asyncIterator]: async function* () {
      for (const m of messages) yield m as never;
    },
  });
}

describe('verifyTaskOutcome', () => {
  it('returns the verdict on a happy-path runner', async () => {
    const runner = makeRunner([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: '{"achieved": false, "concerns": ["No tool calls"]}',
            },
          ],
        },
      },
    ]);
    const r = await verifyTaskOutcome({
      taskId: 't1',
      title: 'Publish post',
      prompt: 'Publish the post',
      output: 'I prepared a draft.',
      runQuery: runner,
    });
    assert.equal(r.kind, 'verdict');
    if (r.kind !== 'verdict') return;
    assert.equal(r.achieved, false);
    assert.deepEqual(r.concerns, ['No tool calls']);
  });

  it('returns skipped when the runner throws', async () => {
    const runner: TaskVerifierRunner = () => ({
      [Symbol.asyncIterator]: async function* () {
        throw new Error('boom');
      },
    });
    const r = await verifyTaskOutcome({
      taskId: 't1',
      title: 't',
      prompt: 'p',
      output: 'o',
      runQuery: runner,
    });
    assert.equal(r.kind, 'skipped');
  });

  it('returns skipped when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await verifyTaskOutcome({
      taskId: 't1',
      title: 't',
      prompt: 'p',
      output: 'o',
      signal: ctrl.signal,
      runQuery: makeRunner([]),
    });
    assert.equal(r.kind, 'skipped');
  });

  it('returns skipped when runner emits no JSON-shaped text', async () => {
    const runner = makeRunner([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'I refuse' }] },
      },
    ]);
    const r = await verifyTaskOutcome({
      taskId: 't1',
      title: 't',
      prompt: 'p',
      output: 'o',
      runQuery: runner,
    });
    assert.equal(r.kind, 'skipped');
  });

  it('concatenates multi-block assistant text', async () => {
    const runner = makeRunner([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '{"achieved": ' },
            { type: 'text', text: 'true, "concerns": []}' },
          ],
        },
      },
    ]);
    const r = await verifyTaskOutcome({
      taskId: 't1',
      title: 't',
      prompt: 'p',
      output: 'o',
      runQuery: runner,
    });
    assert.equal(r.kind, 'verdict');
    if (r.kind !== 'verdict') return;
    assert.equal(r.achieved, true);
  });
});
