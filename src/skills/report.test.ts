/**
 * Tests for the report skill module.
 *
 * Coverage:
 *   - validateReportParams happy path + every documented failure mode
 *   - reportToCeo persists a notification through the storage layer with
 *     `metadata.kind` and `metadata.channel = 'ceo-report'` stamped on
 *   - severity threads through to the on-disk record
 *   - sender existence is enforced
 *   - Slack delivery channel is subscribed only when both botToken AND
 *     ceoChannel are configured; otherwise the report still persists
 *   - The Slack delivery factory receives the resolved credentials and
 *     its returned channel sees the notification through the store's
 *     fan-out
 *   - Custom metadata keys win over the auto-stamped `kind`/`channel`
 *   - formatReportResult renders both the raw notification and the
 *     {notification, deliveredToSlack} envelope shapes
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentStore } from '../storage/agent-store.js';
import {
  NotificationStore,
  type Notification,
  type NotificationDeliveryChannel,
} from '../storage/notification-store.js';
import { createAgentConfig } from '../models/agent.js';
import {
  reportToCeo,
  validateReportParams,
  formatReportResult,
  REPORT_KINDS,
} from './report.js';
import type { SlackCredentials } from '../storage/slack-config-store.js';
import type {
  SaveReportThreadOptions,
  SlackReportThreadRecord,
} from '../storage/slack-report-thread-store.js';

function makeAgent(slug: string): any {
  return createAgentConfig({
    subagentRef: slug,
    weeklyTokenLimit: 100000,
  });
}

let tmpDir: string;
let agentStore: AgentStore;
let notificationStore: NotificationStore;
let SENDER_ID: string;

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), 'report-skill-test-'));
  agentStore = new AgentStore(tmpDir);
  notificationStore = new NotificationStore(tmpDir);
  const sender = makeAgent('alice');
  await agentStore.save(sender);
  SENDER_ID = sender.id;
}

async function teardown() {
  await rm(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// validateReportParams
// ---------------------------------------------------------------------------

describe('validateReportParams', () => {
  it('returns validated params for a minimal valid input', () => {
    const result = validateReportParams({
      senderSlug: 'agent-alice-00000001',
      kind: 'report',
      title: 'OK',
      body: 'b',
    });
    assert.equal(result.senderSlug, 'agent-alice-00000001');
    assert.equal(result.kind, 'report');
    assert.equal(result.severity, 'info');
    assert.equal(result.dataDir, '.aweek/agents');
  });

  it('accepts both REPORT_KINDS literals', () => {
    for (const kind of REPORT_KINDS) {
      const r = validateReportParams({
        senderSlug: 'a',
        kind,
        title: 't',
        body: 'b',
      });
      assert.equal(r.kind, kind);
    }
  });

  it('rejects an unknown kind', () => {
    assert.throws(
      () =>
        validateReportParams({
          senderSlug: 'a',
          kind: 'announcement',
          title: 't',
          body: 'b',
        }),
      /kind must be one of/,
    );
  });

  it('rejects missing kind explicitly', () => {
    assert.throws(
      () =>
        validateReportParams({
          senderSlug: 'a',
          title: 't',
          body: 'b',
        } as Parameters<typeof validateReportParams>[0]),
      /kind is required/,
    );
  });

  it('rejects missing senderSlug', () => {
    assert.throws(
      () =>
        validateReportParams({
          kind: 'report',
          title: 't',
          body: 'b',
        }),
      /senderSlug is required/,
    );
  });

  it('rejects empty title / body', () => {
    assert.throws(
      () =>
        validateReportParams({
          senderSlug: 'a',
          kind: 'report',
          title: '',
          body: 'b',
        }),
      /title is required/,
    );
    assert.throws(
      () =>
        validateReportParams({
          senderSlug: 'a',
          kind: 'report',
          title: 't',
          body: '',
        }),
      /body is required/,
    );
  });

  it('rejects unknown severity', () => {
    assert.throws(
      () =>
        validateReportParams({
          senderSlug: 'a',
          kind: 'report',
          title: 't',
          body: 'b',
          severity: 'panic',
        }),
      /severity must be one of/,
    );
  });

  it('accepts info / warning / error severities (matches the schema enum)', () => {
    for (const s of ['info', 'warning', 'error'] as const) {
      const r = validateReportParams({
        senderSlug: 'a',
        kind: 'report',
        title: 't',
        body: 'b',
        severity: s,
      });
      assert.equal(r.severity, s);
    }
  });

  it('rejects metadata that is not a plain object', () => {
    assert.throws(
      () =>
        validateReportParams({
          senderSlug: 'a',
          kind: 'report',
          title: 't',
          body: 'b',
          metadata: ['nope'] as unknown as Record<string, unknown>,
        }),
      /metadata must be a plain object/,
    );
  });
});

// ---------------------------------------------------------------------------
// reportToCeo — persistence happy path
// ---------------------------------------------------------------------------

describe('reportToCeo persistence', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('persists a minimal report with auto-stamped kind + channel metadata', async () => {
    const result = await reportToCeo(
      {
        senderSlug: SENDER_ID,
        kind: 'report',
        title: 'W21 launch ready',
        body: 'All channels primed, awaiting approval.',
      },
      {
        agentStore,
        notificationStore,
        slackCredentialsLoader: async () => null,
      },
    );

    assert.ok(result.notification.id.startsWith('notif-'));
    assert.equal(result.notification.agentId, SENDER_ID);
    assert.equal(result.notification.title, 'W21 launch ready');
    assert.equal(result.deliveredToSlack, false);
    assert.equal(result.persisted, true);

    assert.deepEqual(result.notification.metadata, {
      kind: 'report',
      channel: 'ceo-report',
    });
  });

  it('threads severity through to the persisted notification', async () => {
    const result = await reportToCeo(
      {
        senderSlug: SENDER_ID,
        kind: 'question',
        title: 'Blocked',
        body: 'Need direction.',
        severity: 'error',
      },
      {
        agentStore,
        notificationStore,
        slackCredentialsLoader: async () => null,
      },
    );
    assert.equal(result.notification.severity, 'error');

    const feed = await notificationStore.load(SENDER_ID);
    assert.equal(feed.length, 1);
    assert.equal(feed[0]?.severity, 'error');
  });

  it('preserves caller metadata and lets caller keys win over auto-stamped fields', async () => {
    const result = await reportToCeo(
      {
        senderSlug: SENDER_ID,
        kind: 'report',
        title: 't',
        body: 'b',
        // `channel` collides with the auto-stamped key — caller wins.
        metadata: { channel: 'override', priority: 'high' },
      },
      {
        agentStore,
        notificationStore,
        slackCredentialsLoader: async () => null,
      },
    );
    assert.deepEqual(result.notification.metadata, {
      kind: 'report',
      channel: 'override',
      priority: 'high',
    });
  });

  it('rejects when the sender agent does not exist', async () => {
    await assert.rejects(
      () =>
        reportToCeo(
          {
            senderSlug: 'agent-ghost-zzzzzzz',
            kind: 'report',
            title: 't',
            body: 'b',
          },
          {
            agentStore,
            notificationStore,
            slackCredentialsLoader: async () => null,
          },
        ),
      /Sender agent not found/,
    );
  });

  it('writes the report under the sender directory like other notifications', async () => {
    const result = await reportToCeo(
      {
        senderSlug: SENDER_ID,
        kind: 'report',
        title: 't',
        body: 'b',
      },
      {
        agentStore,
        notificationStore,
        slackCredentialsLoader: async () => null,
      },
    );
    const feed = await notificationStore.load(SENDER_ID);
    assert.equal(feed.length, 1);
    assert.equal(feed[0]?.id, result.notification.id);
  });
});

// ---------------------------------------------------------------------------
// reportToCeo — Slack delivery wiring
// ---------------------------------------------------------------------------

describe('reportToCeo Slack delivery wiring', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('subscribes the Slack channel only when ceoChannel + botToken are present', async () => {
    let factoryCalls = 0;
    const result = await reportToCeo(
      {
        senderSlug: SENDER_ID,
        kind: 'report',
        title: 't',
        body: 'b',
      },
      {
        agentStore,
        notificationStore,
        slackCredentialsLoader: async () => ({
          botToken: 'xoxb-test',
          appToken: 'xapp-test',
          ceoChannel: 'D-ceo',
        }),
        slackDeliveryFactory: () => {
          factoryCalls += 1;
          return {
            name: 'slack',
            deliver: () => undefined,
          } as unknown as ReturnType<NonNullable<
            Parameters<typeof reportToCeo>[1]
          >['slackDeliveryFactory'] extends infer F
            ? F extends ((...args: unknown[]) => infer R)
              ? R
              : never
            : never>;
        },
      },
    );
    assert.equal(factoryCalls, 1);
    assert.equal(result.deliveredToSlack, true);
  });

  it('skips the Slack channel when ceoChannel is missing even if tokens are present', async () => {
    let factoryCalls = 0;
    const result = await reportToCeo(
      {
        senderSlug: SENDER_ID,
        kind: 'report',
        title: 't',
        body: 'b',
      },
      {
        agentStore,
        notificationStore,
        slackCredentialsLoader: async () => ({
          botToken: 'xoxb-test',
          appToken: 'xapp-test',
        }),
        slackDeliveryFactory: () => {
          factoryCalls += 1;
          return {} as never;
        },
      },
    );
    assert.equal(factoryCalls, 0);
    assert.equal(result.deliveredToSlack, false);
  });

  it('fan-outs the persisted notification to the Slack channel before returning', async () => {
    const delivered: Notification[] = [];
    const fakeChannel: NotificationDeliveryChannel = {
      name: 'slack',
      deliver: (notification) => {
        delivered.push(notification);
      },
    };
    await reportToCeo(
      {
        senderSlug: SENDER_ID,
        kind: 'question',
        title: 'Need approval',
        body: 'On the W21 budget',
      },
      {
        agentStore,
        notificationStore,
        slackCredentialsLoader: async () => ({
          botToken: 'xoxb-test',
          appToken: 'xapp-test',
          ceoChannel: 'D-ceo',
        }),
        slackDeliveryFactory: () => fakeChannel as never,
      },
    );
    // The fan-out fires synchronously for sync `deliver()` impls — no
    // setImmediate wait needed.
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.title, 'Need approval');
    assert.equal(delivered[0]?.metadata?.kind, 'question');
    assert.equal(delivered[0]?.metadata?.channel, 'ceo-report');
  });

  it('captures async Slack delivery errors through the onSlackError sink', async () => {
    const errors: unknown[] = [];
    const fakeChannel: NotificationDeliveryChannel = {
      name: 'slack',
      deliver: async () => {
        throw new Error('boom_from_slack');
      },
    };
    // Build the notification store WITH our test channel-error sink so the
    // fan-out's async rejection lands in the recorded array. Production
    // callers would let reportToCeo build the store itself.
    notificationStore = new NotificationStore(tmpDir, {
      onChannelError: (err) => errors.push(err),
    });
    await reportToCeo(
      {
        senderSlug: SENDER_ID,
        kind: 'report',
        title: 't',
        body: 'b',
      },
      {
        agentStore,
        notificationStore,
        slackCredentialsLoader: async () => ({
          botToken: 'xoxb-test',
          appToken: 'xapp-test',
          ceoChannel: 'D-ceo',
        }),
        slackDeliveryFactory: () => fakeChannel as never,
      },
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1);
    assert.match((errors[0] as Error).message, /boom_from_slack/);
  });

  it('persists a report-thread record via the default factory (canonical path)', async () => {
    // Exercises the FULL canonical path with NO slackDeliveryFactory
    // override. The skill builds the SlackNotificationDelivery itself,
    // wires onPosted internally, and after fetch returns ok+channel+ts
    // the onPosted closure calls saveReportThreadFn with the threadKey
    // shape (`slack:<channel>:<ts>`) the inbound bridge will look up.
    const saves: SaveReportThreadOptions[] = [];
    let fetchCalls = 0;
    const fetchStub: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          ok: true,
          channel: 'D9999',
          ts: '1700000000.000123',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    await reportToCeo(
      {
        senderSlug: SENDER_ID,
        kind: 'question',
        title: 'Need approval',
        body: 'Approve the W21 plan?',
        sourceTaskId: 'task-xyz',
      },
      {
        agentStore,
        notificationStore,
        slackCredentialsLoader: async () => ({
          botToken: 'xoxb-test',
          appToken: 'xapp-test',
          ceoChannel: 'U1234',
        }),
        slackFetchFn: fetchStub,
        saveReportThreadFn: async (_dir, opts) => {
          saves.push(opts);
          const record: SlackReportThreadRecord = {
            threadKey: opts.threadKey,
            senderSlug: opts.senderSlug,
            kind: opts.kind,
            title: opts.title,
            body: opts.body,
            postedAt: 0,
          };
          if (opts.sourceTaskId !== undefined) record.sourceTaskId = opts.sourceTaskId;
          return record;
        },
      },
    );

    // Let the async fan-out + deliver() settle.
    await new Promise((r) => setImmediate(r));

    assert.equal(fetchCalls, 1, 'fetch must be called exactly once');
    assert.equal(saves.length, 1, 'report-thread save must fire on success');
    // Slack canonicalizes user-ID → DM-channel ID; the persisted
    // threadKey uses Slack's response value so it matches the inbound
    // bridge's threadKey on the eventual reply.
    assert.equal(saves[0]!.threadKey, 'slack:D9999:1700000000.000123');
    assert.equal(saves[0]!.senderSlug, SENDER_ID);
    assert.equal(saves[0]!.kind, 'question');
    assert.equal(saves[0]!.title, 'Need approval');
    assert.equal(saves[0]!.body, 'Approve the W21 plan?');
    assert.equal(saves[0]!.sourceTaskId, 'task-xyz');
  });

  it('does NOT persist a report-thread record when Slack push is skipped (no ceoChannel)', async () => {
    const saves: SaveReportThreadOptions[] = [];
    await reportToCeo(
      {
        senderSlug: SENDER_ID,
        kind: 'report',
        title: 't',
        body: 'b',
      },
      {
        agentStore,
        notificationStore,
        // botToken present but ceoChannel absent — Slack subscribe is skipped.
        slackCredentialsLoader: async () => ({
          botToken: 'xoxb-test',
          appToken: 'xapp-test',
        }),
        saveReportThreadFn: async (_dir, opts) => {
          saves.push(opts);
          return {} as never;
        },
      },
    );
    assert.equal(saves.length, 0);
  });

  it('forwards env-source through to the credentials loader', async () => {
    let seenEnv: Record<string, string | undefined> | undefined;
    await reportToCeo(
      {
        senderSlug: SENDER_ID,
        kind: 'report',
        title: 't',
        body: 'b',
      },
      {
        agentStore,
        notificationStore,
        slackEnvSource: { SLACK_CEO_CHANNEL: 'D-from-env' } as Record<string, string>,
        slackCredentialsLoader: async (
          _: string,
          env?: Record<string, string | undefined>,
        ): Promise<SlackCredentials | null> => {
          seenEnv = env;
          return null;
        },
      },
    );
    assert.deepEqual(seenEnv, { SLACK_CEO_CHANNEL: 'D-from-env' });
  });
});

// ---------------------------------------------------------------------------
// formatReportResult
// ---------------------------------------------------------------------------

describe('formatReportResult', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('renders both the {notification, deliveredToSlack} envelope and a bare notification', async () => {
    const envelope = await reportToCeo(
      {
        senderSlug: SENDER_ID,
        kind: 'report',
        title: 'Hello',
        body: 'World',
      },
      {
        agentStore,
        notificationStore,
        slackCredentialsLoader: async () => null,
      },
    );
    const enveloped = formatReportResult(envelope);
    assert.match(enveloped, /Report sent successfully/);
    assert.match(enveloped, /Kind: report/);
    assert.match(enveloped, /Slack delivery: skipped/);

    const bare = formatReportResult(envelope.notification);
    assert.match(bare, /Report sent successfully/);
    assert.match(bare, /Slack delivery: skipped/);
  });

  it('says "attempted" when Slack was wired up', async () => {
    const envelope = await reportToCeo(
      {
        senderSlug: SENDER_ID,
        kind: 'report',
        title: 't',
        body: 'b',
      },
      {
        agentStore,
        notificationStore,
        slackCredentialsLoader: async () => ({
          botToken: 'xoxb-test',
          appToken: 'xapp-test',
          ceoChannel: 'D-ceo',
        }),
        slackDeliveryFactory: () =>
          ({
            name: 'slack',
            deliver: () => undefined,
          } as never),
      },
    );
    assert.match(formatReportResult(envelope), /Slack delivery: attempted/);
  });
});
