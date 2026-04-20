/**
 * Tests for `src/serve/errors.js` — friendly error surface for `aweek serve`.
 *
 * AC 8 scope: when the user runs `aweek serve` without a `.aweek/` folder
 * present, we should produce a friendly, actionable multi-line message
 * instead of a raw stack trace. These tests pin down:
 *
 *   1. The thrown Error carries the `ENOAWEEKDIR` code + both the missing
 *      `dataDir` and its parent `projectDir`.
 *   2. The friendly formatter includes the resolved `.aweek/` path and a
 *      next-step hint (init / --project-dir) regardless of which input
 *      shape the caller passes.
 *   3. The predicate accepts only the real error shape — not random
 *      `Error` instances or `null`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import {
  MISSING_AWEEK_DIR_CODE,
  buildNoAweekDirErrorMessage,
  createNoAweekDirError,
  formatNoAweekDirMessage,
  isNoAweekDirError,
} from './errors.js';

describe('MISSING_AWEEK_DIR_CODE', () => {
  it('is the stable string CLIs and tests branch on', () => {
    assert.equal(MISSING_AWEEK_DIR_CODE, 'ENOAWEEKDIR');
  });
});

describe('buildNoAweekDirErrorMessage()', () => {
  it('produces a single-line message that names the missing path', () => {
    const msg = buildNoAweekDirErrorMessage('/tmp/demo/.aweek');
    assert.ok(!msg.includes('\n'), 'Error.message should stay single-line');
    assert.match(msg, /\/tmp\/demo\/\.aweek/);
    assert.match(msg, /aweek init/);
    assert.match(msg, /--project-dir/);
  });
});

describe('createNoAweekDirError()', () => {
  it('returns an Error tagged with ENOAWEEKDIR and the offending paths', () => {
    const err = createNoAweekDirError('/tmp/demo/.aweek');
    assert.ok(err instanceof Error);
    assert.equal(err.code, MISSING_AWEEK_DIR_CODE);
    assert.equal(err.dataDir, '/tmp/demo/.aweek');
    assert.equal(err.projectDir, resolve('/tmp/demo/.aweek', '..'));
    assert.match(err.message, /\/tmp\/demo\/\.aweek/);
  });
});

describe('formatNoAweekDirMessage()', () => {
  it('emits a friendly multi-line block with the next-step hints', () => {
    const out = formatNoAweekDirMessage({ dataDir: '/tmp/demo/.aweek' });
    const lines = out.split('\n');

    // Headline first so the user sees the problem before the path.
    assert.equal(lines[0], 'No .aweek/ folder found.');

    // The resolved path must appear, indented as a block quote.
    assert.ok(out.includes('/tmp/demo/.aweek'), 'includes the missing path');
    assert.ok(out.includes('  /tmp/demo/.aweek'), 'indents the path for scannability');

    // All three remediation paths should be surfaced.
    assert.match(out, /aweek init/);
    assert.match(out, /--project-dir/);
    assert.match(out, /\/aweek:init/);

    // Block should be multi-line (> 3 lines) but not trailing-newline padded.
    assert.ok(lines.length > 3, 'is multi-line');
    assert.notEqual(out.at(-1), '\n', 'no trailing newline — the CLI decides');
  });

  it('accepts projectDir instead of dataDir and derives the .aweek/ path', () => {
    const out = formatNoAweekDirMessage({ projectDir: '/tmp/demo' });
    // The derived path is /tmp/demo/.aweek regardless of separator conventions.
    assert.ok(
      out.includes(resolve('/tmp/demo', '.aweek')),
      'derives .aweek/ from projectDir',
    );
  });

  it('falls back to process.cwd() when neither dataDir nor projectDir is given', () => {
    const out = formatNoAweekDirMessage({});
    assert.ok(out.includes(resolve(process.cwd(), '.aweek')));
  });

  it('returns a friendly message even when called with no arguments', () => {
    const out = formatNoAweekDirMessage();
    assert.ok(out.startsWith('No .aweek/ folder found.'));
    assert.ok(out.includes(resolve(process.cwd(), '.aweek')));
  });
});

describe('isNoAweekDirError()', () => {
  it('recognises the error shape produced by createNoAweekDirError()', () => {
    const err = createNoAweekDirError('/tmp/demo/.aweek');
    assert.equal(isNoAweekDirError(err), true);
  });

  it('rejects unrelated errors and falsy values', () => {
    assert.equal(isNoAweekDirError(new Error('boom')), false);
    assert.equal(isNoAweekDirError(null), false);
    assert.equal(isNoAweekDirError(undefined), false);
    assert.equal(isNoAweekDirError({ code: 'EADDRINUSE' }), false);
    assert.equal(isNoAweekDirError('ENOAWEEKDIR'), false);
  });

  it('accepts plain error-shaped objects with the right code', () => {
    // Important so callers that re-serialise the error across a process
    // boundary (e.g. JSON-stringified + parsed) still get matched.
    assert.equal(
      isNoAweekDirError({ code: MISSING_AWEEK_DIR_CODE, message: 'x' }),
      true,
    );
  });
});
