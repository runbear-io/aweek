import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  REGISTRY,
  DispatchError,
  dispatchExec,
  listModules,
  listFunctions,
} from './dispatcher.js';

describe('dispatcher registry', () => {
  it('exposes every skill module that the markdown calls', () => {
    const expected = [
      'agent-helpers',
      'calendar',
      'delegate-task',
      'hire',
      'hire-all',
      'hire-create-new-menu',
      'hire-route',
      'hire-select-some',
      'init',
      'init-hire-menu',
      'manage',
      'plan',
      'plan-markdown',
      'summary',
    ];
    assert.deepEqual(listModules(), expected);
  });

  it('never registers an undefined callable', () => {
    for (const [moduleKey, fns] of Object.entries(REGISTRY)) {
      for (const [fnName, fn] of Object.entries(fns)) {
        assert.equal(
          typeof fn,
          'function',
          `${moduleKey}.${fnName} must be a function`,
        );
      }
    }
  });

  it('listFunctions returns null for unknown modules', () => {
    assert.equal(listFunctions('not-a-module'), null);
  });
});

describe('dispatchExec usage errors', () => {
  it('rejects when moduleKey is missing', async () => {
    await assert.rejects(
      () => dispatchExec({ fnName: 'whatever' }),
      (err) => err instanceof DispatchError && err.code === 'EUSAGE',
    );
  });

  it('rejects when fnName is missing', async () => {
    await assert.rejects(
      () => dispatchExec({ moduleKey: 'init' }),
      (err) => err instanceof DispatchError && err.code === 'EUSAGE',
    );
  });

  it('rejects unknown modules with EUNKNOWN_MODULE', async () => {
    await assert.rejects(
      () => dispatchExec({ moduleKey: 'nope', fnName: 'x' }),
      (err) => err instanceof DispatchError && err.code === 'EUNKNOWN_MODULE',
    );
  });

  it('rejects functions not on the whitelist with EUNKNOWN_FN', async () => {
    await assert.rejects(
      () => dispatchExec({ moduleKey: 'init', fnName: 'internalHelperNotExposed' }),
      (err) => err instanceof DispatchError && err.code === 'EUNKNOWN_FN',
    );
  });
});

describe('dispatchExec routing', () => {
  it('invokes a whitelisted function with the input object as the single arg', async () => {
    // detectInitState is pure-read; safe to exercise on the live FS.
    const result = await dispatchExec({
      moduleKey: 'init',
      fnName: 'detectInitState',
      input: { projectDir: process.cwd() },
    });
    assert.equal(typeof result, 'object');
    assert.equal(typeof result.fullyInitialized, 'boolean');
    assert.equal(typeof result.dataDir.exists, 'boolean');
  });

  it('defaults input to an empty object when omitted', async () => {
    const result = await dispatchExec({
      moduleKey: 'init',
      fnName: 'detectInitState',
    });
    // Should not throw and should default projectDir to cwd.
    assert.equal(typeof result, 'object');
    assert.equal(typeof result.projectDir, 'string');
  });
});

describe('argument adapters', () => {
  it('formatApprovalResult adapter unpacks {result, action} into positional args', () => {
    // Minimal shape that formatApprovalResult accepts for "approve" decisions.
    const result = {
      success: true,
      action: 'approve',
      plan: {
        week: '2026-W16',
        tasks: [{ id: 't1', description: 'demo' }],
      },
      heartbeatActivated: false,
    };
    const text = REGISTRY.plan.formatApprovalResult({ result, action: 'approve' });
    assert.equal(typeof text, 'string');
    assert.match(text, /approve/i);
  });

  it('formatAdjustmentResult adapter accepts {results} or the raw results', () => {
    const results = {
      goals: [],
      monthly: [],
      weekly: [],
    };
    const viaWrapper = REGISTRY.plan.formatAdjustmentResult({ results });
    const viaRaw = REGISTRY.plan.formatAdjustmentResult(results);
    assert.equal(typeof viaWrapper, 'string');
    assert.equal(typeof viaRaw, 'string');
    assert.equal(viaWrapper, viaRaw);
  });

  it('formatInitHireMenuPrompt adapter unwraps {menu} or the raw menu', () => {
    const menu = {
      hasUnhired: false,
      unhired: [],
      options: [
        { value: 'create-new', label: 'Create new', description: '...', requiresUnhired: false },
        { value: 'skip', label: 'Skip', description: '...', requiresUnhired: false },
      ],
      promptText: 'How do you want to proceed?',
    };
    const viaWrapper = REGISTRY['init-hire-menu'].formatInitHireMenuPrompt({ menu });
    const viaRaw = REGISTRY['init-hire-menu'].formatInitHireMenuPrompt(menu);
    assert.equal(typeof viaWrapper, 'string');
    assert.equal(viaWrapper, viaRaw);
  });

  it('calendar.listAgentsForCalendar adapter forwards dataDir as a positional arg', async () => {
    // Pass an unlikely-to-exist data dir so the underlying fn returns []
    // rather than hitting real agent JSON.
    const result = await REGISTRY.calendar.listAgentsForCalendar({
      dataDir: '/tmp/aweek-nonexistent-xyz',
    });
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });
});
