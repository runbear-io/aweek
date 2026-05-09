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
      'artifact',
      'calendar',
      'config',
      'daily-review',
      'delegate-task',
      'execution',
      'hire',
      'hire-all',
      'hire-create-new-menu',
      'hire-route',
      'hire-select-some',
      'manage',
      'next-week-context',
      'notify',
      'plan',
      'plan-ambiguity',
      'plan-interview-store',
      'plan-markdown',
      'query',
      'run-once',
      'setup',
      'setup-hire-menu',
      'slack-init',
      'summary',
      'teardown',
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
      () => dispatchExec({ moduleKey: 'setup' }),
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
      () => dispatchExec({ moduleKey: 'setup', fnName: 'internalHelperNotExposed' }),
      (err) => err instanceof DispatchError && err.code === 'EUNKNOWN_FN',
    );
  });
});

describe('dispatchExec routing', () => {
  it('invokes a whitelisted function with the input object as the single arg', async () => {
    // detectInitState is pure-read; safe to exercise on the live FS.
    const result = (await dispatchExec({
      moduleKey: 'setup',
      fnName: 'detectInitState',
      input: { projectDir: process.cwd() },
    })) as { fullyInitialized: boolean; dataDir: { exists: boolean } };
    assert.equal(typeof result, 'object');
    assert.equal(typeof result.fullyInitialized, 'boolean');
    assert.equal(typeof result.dataDir.exists, 'boolean');
  });

  it('defaults input to an empty object when omitted', async () => {
    const result = (await dispatchExec({
      moduleKey: 'setup',
      fnName: 'detectInitState',
    })) as { projectDir: string };
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
    };
    const text = REGISTRY.plan!.formatApprovalResult!({ result, action: 'approve' }) as string;
    assert.equal(typeof text, 'string');
    assert.match(text, /approve/i);
  });

  it('formatAdjustmentResult adapter accepts {results} or the raw results', () => {
    const results = {
      goals: [],
      monthly: [],
      weekly: [],
    };
    const viaWrapper = REGISTRY.plan!.formatAdjustmentResult!({ results }) as string;
    const viaRaw = REGISTRY.plan!.formatAdjustmentResult!(results) as string;
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
    const viaWrapper = REGISTRY['setup-hire-menu']!.formatInitHireMenuPrompt!({ menu }) as string;
    const viaRaw = REGISTRY['setup-hire-menu']!.formatInitHireMenuPrompt!(menu) as string;
    assert.equal(typeof viaWrapper, 'string');
    assert.equal(viaWrapper, viaRaw);
  });

  it('calendar.listAgentsForCalendar adapter forwards dataDir as a positional arg', async () => {
    // Pass an unlikely-to-exist data dir so the underlying fn returns []
    // rather than hitting real agent JSON.
    const result = (await REGISTRY.calendar!.listAgentsForCalendar!({
      dataDir: '/tmp/aweek-nonexistent-xyz',
    })) as unknown[];
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });

  it('notify.validateSendParams is exposed and runs through the registry as a pure pre-flight', () => {
    const validated = REGISTRY.notify!.validateSendParams!({
      senderSlug: 'alice-12345678',
      title: 'Hello',
      body: 'World',
    }) as { senderSlug: string; title: string; body: string; source: string };
    assert.equal(validated.senderSlug, 'alice-12345678');
    assert.equal(validated.title, 'Hello');
    assert.equal(validated.body, 'World');
    assert.equal(validated.source, 'agent');
  });

  it('notify.formatNotificationResult adapter unwraps {notification} or the raw notification', () => {
    const notification = {
      id: 'notif-abc12345',
      agentId: 'alice-12345678',
      source: 'agent',
      title: 'Hello',
      body: 'World',
      createdAt: '2026-04-17T10:00:00.000Z',
      read: false,
    };
    const viaWrapper = REGISTRY.notify!.formatNotificationResult!({ notification }) as string;
    const viaRaw = REGISTRY.notify!.formatNotificationResult!(notification) as string;
    assert.equal(typeof viaWrapper, 'string');
    assert.equal(viaWrapper, viaRaw);
    assert.match(viaWrapper, /Notification sent successfully/);
    assert.match(viaWrapper, /notif-abc12345/);
  });

  it('notify.send is a function on the registry (wired to the skill\'s sendNotification)', () => {
    // Don't actually invoke `send` here — it would need a populated AgentStore
    // and tmp dir. The notify.test.ts suite already exercises the happy paths;
    // this test only pins that the registry entry resolves to a callable so a
    // future rename of the underlying export trips the dispatcher contract.
    assert.equal(typeof REGISTRY.notify!.send, 'function');
  });
});

describe('dispatchExec ensureProjectReady prelude', () => {
  // Stub that returns awaiting-confirm (no sticky decision, no heartbeat installed).
  function makePendingFn() {
    return async (_opts: any) => ({
      dataDir: '/tmp/aweek-test/agents',
      aweekRoot: '/tmp/aweek-test',
      steps: { dataDir: 'existed' as const, config: 'existed' as const, heartbeat: 'awaiting-confirm' as const },
      config: {},
      heartbeatPrompt: { title: 'Install?', description: 'desc', options: ['install', 'skip', 'skip-remember'] as const },
    });
  }

  // Stub that simulates an already-installed heartbeat (no prompt needed).
  function makeInstalledFn() {
    return async (_opts: any) => ({
      dataDir: '/tmp/aweek-test/agents',
      aweekRoot: '/tmp/aweek-test',
      steps: { dataDir: 'existed' as const, config: 'existed' as const, heartbeat: 'existed' as const },
      config: {},
    });
  }

  // Stub that simulates skipHeartbeat=true path (readonly skills).
  function makeSkippedFn() {
    return async (_opts: any) => ({
      dataDir: '/tmp/aweek-test/agents',
      aweekRoot: '/tmp/aweek-test',
      steps: { dataDir: 'existed' as const, config: 'existed' as const, heartbeat: 'skipped' as const },
      config: {},
    });
  }

  it('(a) wrapped entry returns awaiting-confirm when heartbeat not installed', async () => {
    const result = (await dispatchExec({
      moduleKey: 'plan',
      fnName: 'adjustPlan',
      input: { dataDir: '/tmp/aweek-test/agents', weeklyAdjustments: [] },
      ensureProjectReadyFn: makePendingFn() as any,
    })) as any;
    assert.equal(result.needsConfirmation, 'heartbeat');
    assert.ok(result.prompt);
    assert.equal(result.prompt.title, 'Install?');
  });

  it('(b) re-invoking with heartbeatAnswer:install proceeds past the prelude', async () => {
    // When ensureProjectReady is stubbed to return 'existed' (simulating install
    // completing), dispatchExec should forward to the underlying fn. adjustPlan
    // with no weeklyAdjustments returns a success result.
    const result = (await dispatchExec({
      moduleKey: 'plan',
      fnName: 'adjustPlan',
      input: { dataDir: '/tmp/aweek-test/agents', heartbeatAnswer: 'install', weeklyAdjustments: [] },
      ensureProjectReadyFn: makeInstalledFn() as any,
    })) as any;
    // adjustPlan propagates to adjustGoals which returns { success, errors }
    assert.equal(typeof result, 'object');
    assert.ok('success' in result || 'errors' in result);
    // heartbeatAnswer must NOT appear on the forwarded input
    assert.ok(!('heartbeatAnswer' in result));
  });

  it('(c) heartbeatAnswer:skip-remember proceeds without installing (declined path)', async () => {
    // Stub returns 'declined' (skip-remember was persisted).
    const declinedFn = async (_opts: any) => ({
      dataDir: '/tmp/aweek-test/agents',
      aweekRoot: '/tmp/aweek-test',
      steps: { dataDir: 'existed' as const, config: 'existed' as const, heartbeat: 'declined' as const },
      config: {},
    });
    const result = (await dispatchExec({
      moduleKey: 'plan',
      fnName: 'adjustPlan',
      input: { dataDir: '/tmp/aweek-test/agents', heartbeatAnswer: 'skip-remember', weeklyAdjustments: [] },
      ensureProjectReadyFn: declinedFn as any,
    })) as any;
    // Should NOT return awaiting-confirm — heartbeat is declined, proceed
    assert.ok(!result.needsConfirmation);
    assert.equal(typeof result, 'object');
  });

  it('(d) summary and query never prompt — skipHeartbeat:true path', async () => {
    let capturedOpts: any;
    const captureFn = async (opts: any) => {
      capturedOpts = opts;
      return {
        dataDir: '/tmp/aweek-test/agents',
        aweekRoot: '/tmp/aweek-test',
        steps: { dataDir: 'existed' as const, config: 'existed' as const, heartbeat: 'skipped' as const },
        config: {},
      };
    };
    // buildSummary requires dataDir; pass a dummy value so it doesn't throw before prelude
    await dispatchExec({
      moduleKey: 'summary',
      fnName: 'buildSummary',
      input: { dataDir: '/tmp/aweek-nonexistent-xyz' },
      ensureProjectReadyFn: captureFn as any,
    }).catch(() => { /* ignore downstream errors from missing agents dir */ });
    assert.equal(capturedOpts.skipHeartbeat, true);
  });

  it('(e) setup and teardown are NOT wrapped — no prelude called', async () => {
    let called = false;
    const trackFn = async (_opts: any) => {
      called = true;
      return {} as any;
    };
    // setup:detectInitState — should not call ensureProjectReadyFn
    await dispatchExec({
      moduleKey: 'setup',
      fnName: 'detectInitState',
      input: { projectDir: process.cwd() },
      ensureProjectReadyFn: trackFn as any,
    });
    assert.equal(called, false, 'setup module must not trigger the prelude');

    // teardown:removeHeartbeat — confirmed:false should throw ETEARDOWN, not prelude
    await dispatchExec({
      moduleKey: 'teardown',
      fnName: 'removeHeartbeat',
      input: { confirmed: false },
      ensureProjectReadyFn: trackFn as any,
    }).catch(() => { /* ETEARDOWN_NOT_CONFIRMED is expected */ });
    assert.equal(called, false, 'teardown module must not trigger the prelude');
  });
});
