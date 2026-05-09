/**
 * Tests for `src/serve/slack-listener.ts` — the embedded Slack
 * Socket-Mode listener bootstrap that {@link startServer} calls
 * alongside the HTTP listener.
 *
 * Coverage:
 *   - Returns a null adapter (and skips the factory) when the loader
 *     returns null. This is the "no credentials" path that must never
 *     brick `aweek serve`.
 *   - Constructs the adapter and calls `connect()` when credentials
 *     are present. Verifies the adapter config is forwarded verbatim
 *     (botToken, appToken, signingSecret).
 *   - Returns a null adapter when `connect()` throws and best-effort
 *     calls `disconnect()` to release any partially-allocated
 *     resources. This is the "bad token / scope error" path.
 *   - Returns a null adapter when the factory itself throws.
 *   - Surfaces a single-line log message on each branch (connected /
 *     disabled / failed) so operators see the boot status.
 *   - Calls the loader with `<dataDir>/agents` (matching every other
 *     store's calling convention) and forwards the env-source override.
 *   - Returned `disconnect()` is idempotent and never rethrows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  startSlackListener,
  type SlackAdapterFactory,
  type SlackCredentialsLoader,
} from './slack-listener.js';

/**
 * Build a minimal `ChannelAdapter` test double. Records each lifecycle
 * call so the tests can assert on call counts without standing up the
 * real `@slack/bolt` runtime.
 */
function makeFakeAdapter(overrides = {}) {
  const calls = { connect: 0, disconnect: 0 };
  const adapter = {
    name: 'slack' as const,
    connect: async () => {
      calls.connect += 1;
    },
    disconnect: async () => {
      calls.disconnect += 1;
    },
    onMessage: () => {},
    sendMessage: async () => {},
    startStream: async () => ({
      append: async () => {},
      finish: async () => {},
    }),
    ...overrides,
  };
  return { adapter, calls };
}

describe('startSlackListener()', () => {
  it('throws when dataDir is missing', async () => {
    await assert.rejects(
      // @ts-expect-error — intentionally bad input
      () => startSlackListener({}),
      /dataDir is required/,
    );
  });

  it('returns a null adapter when the loader returns null and skips the factory', async () => {
    const messages: string[] = [];
    let factoryCalls = 0;

    const loader: SlackCredentialsLoader = async () => null;
    const adapterFactory: SlackAdapterFactory = () => {
      factoryCalls += 1;
      throw new Error('factory must not be called when credentials are missing');
    };

    const handle = await startSlackListener({
      dataDir: '/tmp/fake-aweek/.aweek',
      loader,
      adapterFactory,
      log: (m) => messages.push(m),
    });

    assert.equal(handle.adapter, null);
    assert.equal(factoryCalls, 0);
    assert.ok(
      messages.some((m) => /Slack listener disabled/.test(m)),
      `expected a "disabled" log line, got: ${JSON.stringify(messages)}`,
    );

    // disconnect() must be a safe no-op on the null-adapter handle.
    await handle.disconnect();
    await handle.disconnect();
  });

  it('constructs the adapter and calls connect() when credentials are present', async () => {
    const messages: string[] = [];
    const { adapter, calls } = makeFakeAdapter();
    let receivedConfig: unknown = null;

    const handle = await startSlackListener({
      dataDir: '/tmp/fake-aweek/.aweek',
      loader: async () => ({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'sig-test',
      }),
      adapterFactory: (config) => {
        receivedConfig = config;
        return adapter;
      },
      log: (m) => messages.push(m),
    });

    assert.equal(handle.adapter, adapter);
    assert.equal(calls.connect, 1);
    assert.equal(calls.disconnect, 0);
    assert.deepEqual(receivedConfig, {
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'sig-test',
    });
    assert.ok(
      messages.some((m) => /connected \(Socket Mode\)/.test(m)),
      `expected a "connected" log line, got: ${JSON.stringify(messages)}`,
    );

    await handle.disconnect();
    assert.equal(calls.disconnect, 1);
  });

  it('omits signingSecret from the adapter config when the loader does not provide one', async () => {
    let receivedConfig: { signingSecret?: unknown; botToken?: unknown; appToken?: unknown } = {};
    const { adapter } = makeFakeAdapter();

    await startSlackListener({
      dataDir: '/tmp/fake-aweek/.aweek',
      loader: async () => ({ botToken: 'xoxb-test', appToken: 'xapp-test' }),
      adapterFactory: (config) => {
        receivedConfig = config as typeof receivedConfig;
        return adapter;
      },
      log: () => {},
    });

    assert.equal(receivedConfig.botToken, 'xoxb-test');
    assert.equal(receivedConfig.appToken, 'xapp-test');
    assert.ok(
      !('signingSecret' in receivedConfig),
      'signingSecret must NOT be present when the loader did not surface one',
    );
  });

  it('returns a null adapter and best-effort disconnects when connect() throws', async () => {
    const messages: string[] = [];
    const calls = { connect: 0, disconnect: 0 };
    const adapter = {
      name: 'slack' as const,
      connect: async () => {
        calls.connect += 1;
        throw new Error('invalid_app_token');
      },
      disconnect: async () => {
        calls.disconnect += 1;
      },
      onMessage: () => {},
      sendMessage: async () => {},
      startStream: async () => ({ append: async () => {}, finish: async () => {} }),
    };

    const handle = await startSlackListener({
      dataDir: '/tmp/fake-aweek/.aweek',
      loader: async () => ({ botToken: 'xoxb-test', appToken: 'xapp-test' }),
      adapterFactory: () => adapter,
      log: (m) => messages.push(m),
    });

    assert.equal(handle.adapter, null);
    assert.equal(calls.connect, 1);
    assert.equal(
      calls.disconnect,
      1,
      'expected best-effort disconnect on connect() failure',
    );
    assert.ok(
      messages.some((m) => /failed to connect/.test(m) && /invalid_app_token/.test(m)),
      `expected a "failed to connect" log line, got: ${JSON.stringify(messages)}`,
    );

    // Handle's disconnect() must remain a no-op after connect() failure.
    await handle.disconnect();
    assert.equal(calls.disconnect, 1, 'no-op disconnect must not call adapter again');
  });

  it('returns a null adapter when the adapter factory itself throws', async () => {
    const messages: string[] = [];

    const handle = await startSlackListener({
      dataDir: '/tmp/fake-aweek/.aweek',
      loader: async () => ({ botToken: 'xoxb-test', appToken: 'xapp-test' }),
      adapterFactory: () => {
        throw new Error('boom-during-construction');
      },
      log: (m) => messages.push(m),
    });

    assert.equal(handle.adapter, null);
    assert.ok(
      messages.some((m) => /adapter init failed/.test(m) && /boom-during-construction/.test(m)),
      `expected an "adapter init failed" log line, got: ${JSON.stringify(messages)}`,
    );
    await handle.disconnect();
  });

  it('hands the loader <dataDir>/agents and forwards the envSource', async () => {
    let receivedAgentsDir: string | null = null;
    let receivedEnv: Record<string, string | undefined> | undefined;

    const envSource = Object.freeze({
      SLACK_BOT_TOKEN: 'xoxb-from-env',
    });

    await startSlackListener({
      dataDir: '/tmp/fake-aweek/.aweek',
      loader: async (agentsDir, env) => {
        receivedAgentsDir = agentsDir;
        receivedEnv = env as Record<string, string | undefined> | undefined;
        return null;
      },
      envSource,
      log: () => {},
    });

    // The loader's documented contract is "pass me .aweek/agents". We
    // own the dataDir → agentsDir translation so the surrounding server
    // code can keep using its own `dataDir = .aweek` convention.
    assert.equal(
      receivedAgentsDir,
      '/tmp/fake-aweek/.aweek/agents',
      `expected dataDir/agents, got ${receivedAgentsDir}`,
    );
    assert.deepEqual(
      receivedEnv,
      { SLACK_BOT_TOKEN: 'xoxb-from-env' },
      'envSource override must reach the loader verbatim',
    );
  });

  it('treats a loader exception as "disabled" rather than propagating', async () => {
    const messages: string[] = [];

    const handle = await startSlackListener({
      dataDir: '/tmp/fake-aweek/.aweek',
      loader: async () => {
        throw new Error('disk-on-fire');
      },
      log: (m) => messages.push(m),
    });

    assert.equal(handle.adapter, null);
    assert.ok(
      messages.some((m) => /Slack listener disabled/.test(m) && /disk-on-fire/.test(m)),
      `expected a "disabled" log line referencing the error, got: ${JSON.stringify(messages)}`,
    );
    await handle.disconnect();
  });

  it("disconnect() never rethrows even when the adapter's disconnect throws", async () => {
    const messages: string[] = [];
    const adapter = {
      name: 'slack' as const,
      connect: async () => {},
      disconnect: async () => {
        throw new Error('socket-already-closed');
      },
      onMessage: () => {},
      sendMessage: async () => {},
      startStream: async () => ({ append: async () => {}, finish: async () => {} }),
    };

    const handle = await startSlackListener({
      dataDir: '/tmp/fake-aweek/.aweek',
      loader: async () => ({ botToken: 'xoxb-test', appToken: 'xapp-test' }),
      adapterFactory: () => adapter,
      log: (m) => messages.push(m),
    });

    assert.equal(handle.adapter, adapter);
    // Must not reject — `ServerHandle.close()` calls this and the HTTP
    // close must always succeed.
    await assert.doesNotReject(() => handle.disconnect());
    assert.ok(
      messages.some((m) => /disconnect warning/.test(m) && /socket-already-closed/.test(m)),
      `expected a disconnect-warning log line, got: ${JSON.stringify(messages)}`,
    );
  });
});
