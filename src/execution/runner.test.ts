/**
 * Tests for the execution-runner abstraction — src/execution/runner.ts.
 *
 * Pins the runner vocabulary shared by config, the agent schema, the
 * heartbeat, and the CLI: the supported kinds, the default, the
 * binary map, and the agent-over-config-over-default resolution order.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RUNNER,
  RUNNER_KINDS,
  RUNNER_BINARY,
  GEMINI_SYSTEM_MD_ENV,
  isRunnerKind,
  resolveRunner,
} from './runner.js';

describe('runner constants', () => {
  it('defaults to claude (preserves prior behaviour)', () => {
    assert.equal(DEFAULT_RUNNER, 'claude');
  });

  it('supports exactly claude + gemini + hermes', () => {
    assert.deepEqual([...RUNNER_KINDS], ['claude', 'gemini', 'hermes']);
  });

  it('maps each runner to its CLI binary', () => {
    assert.equal(RUNNER_BINARY.claude, 'claude');
    assert.equal(RUNNER_BINARY.gemini, 'gemini');
    assert.equal(RUNNER_BINARY.hermes, 'hermes');
  });

  it('exposes the Gemini system-prompt env var name', () => {
    assert.equal(GEMINI_SYSTEM_MD_ENV, 'GEMINI_SYSTEM_MD');
  });
});

describe('isRunnerKind', () => {
  it('accepts supported kinds', () => {
    assert.equal(isRunnerKind('claude'), true);
    assert.equal(isRunnerKind('gemini'), true);
    assert.equal(isRunnerKind('hermes'), true);
  });

  it('rejects everything else', () => {
    for (const bad of ['Claude', 'GEMINI', 'Hermes', 'gpt', '', null, undefined, 1, {}]) {
      assert.equal(isRunnerKind(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('resolveRunner', () => {
  it('returns the default when nothing is set', () => {
    assert.equal(resolveRunner(undefined, undefined), 'claude');
  });

  it('uses the config runner when the agent has none', () => {
    assert.equal(resolveRunner(undefined, 'gemini'), 'gemini');
  });

  it('lets the agent runner win over config', () => {
    assert.equal(resolveRunner('gemini', 'claude'), 'gemini');
    assert.equal(resolveRunner('claude', 'gemini'), 'claude');
    assert.equal(resolveRunner('hermes', 'gemini'), 'hermes');
    assert.equal(resolveRunner(undefined, 'hermes'), 'hermes');
  });

  it('falls through invalid values to the next level', () => {
    assert.equal(resolveRunner('bogus', 'gemini'), 'gemini');
    assert.equal(resolveRunner('bogus', 'also-bogus'), 'claude');
    assert.equal(resolveRunner(null, undefined), 'claude');
  });
});
