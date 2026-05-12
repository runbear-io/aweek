/**
 * Tests for the Slack notification delivery channel.
 *
 * Coverage:
 *   - constructor validation (missing token / channel)
 *   - happy path: deliver() posts to chat.postMessage with the expected
 *     Block Kit payload, Authorization header, and JSON body
 *   - Slack `ok: false` response surfaces as a thrown Error and a warning
 *   - non-JSON response surfaces as a thrown Error
 *   - kind metadata routes to the human-readable context label
 *   - link / sourceTaskId / severity rendering
 *   - integration with NotificationStore.subscribe — the channel only
 *     fires for FRESH appends (dedupKey re-emits are skipped)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SlackNotificationDelivery,
  buildSlackMessage,
} from './notification-delivery.js';
import {
  NotificationStore,
  createNotification,
} from '../../storage/notification-store.js';

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
  body: unknown;
}

/** Build a fetch stub that records every call and returns a canned JSON response. */
function makeFetchStub(
  response: { ok?: boolean; error?: string } | { nonJsonBody: string },
  records: RecordedRequest[],
): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const bodyText =
      typeof init?.body === 'string' ? init.body : init?.body?.toString() ?? '';
    let parsedBody: unknown = bodyText;
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      // leave as string
    }
    records.push({ url: String(url), init, body: parsedBody });

    if ('nonJsonBody' in response) {
      return new Response(response.nonJsonBody, { status: 200 });
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('SlackNotificationDelivery constructor', () => {
  it('refuses to construct without a bot token', () => {
    assert.throws(
      () =>
        new SlackNotificationDelivery({
          botToken: '',
          ceoChannel: 'C123',
        }),
      /botToken is required/,
    );
  });

  it('refuses to construct without a ceoChannel', () => {
    assert.throws(
      () =>
        new SlackNotificationDelivery({
          botToken: 'xoxb-test',
          ceoChannel: '',
        }),
      /ceoChannel is required/,
    );
  });

  it('exposes the resolved ceoChannel', () => {
    const channel = new SlackNotificationDelivery({
      botToken: 'xoxb-test',
      ceoChannel: '  C12345  ',
    });
    assert.equal(channel.ceoChannel, 'C12345');
    assert.equal(channel.name, 'slack');
  });
});

describe('SlackNotificationDelivery.deliver', () => {
  it('posts to chat.postMessage with the bot token and rendered blocks', async () => {
    const records: RecordedRequest[] = [];
    const channel = new SlackNotificationDelivery({
      botToken: 'xoxb-test-token',
      ceoChannel: 'D9999',
      fetchFn: makeFetchStub({ ok: true }, records),
    });

    const notification = createNotification({
      agentId: 'marketer-sam',
      title: 'Need approval on W21 plan',
      body: 'Blocked on the holiday campaign mix.',
      metadata: { kind: 'question' },
      severity: 'warning',
      sourceTaskId: 'task-abc',
      link: 'https://example.com/plan',
    });

    await channel.deliver(notification, 'marketer-sam');

    assert.equal(records.length, 1);
    const req = records[0]!;
    assert.equal(req.url, 'https://slack.com/api/chat.postMessage');
    const headers = (req.init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer xoxb-test-token');
    assert.match(
      headers['Content-Type'] ?? '',
      /^application\/json/,
    );

    const body = req.body as {
      channel: string;
      text: string;
      blocks: Array<Record<string, unknown>>;
    };
    assert.equal(body.channel, 'D9999');
    assert.match(body.text, /Need approval on W21 plan/);
    assert.match(body.text, /from marketer-sam/);

    const header = body.blocks[0] as {
      type: string;
      text: { text: string };
    };
    assert.equal(header.type, 'header');
    assert.match(header.text.text, /:warning:/);
    assert.match(header.text.text, /Need approval on W21 plan/);

    const section = body.blocks[1] as { type: string; text: { text: string } };
    assert.equal(section.type, 'section');
    assert.match(section.text.text, /Blocked on the holiday campaign mix/);

    const context = body.blocks[2] as {
      type: string;
      elements: Array<{ text: string }>;
    };
    assert.equal(context.type, 'context');
    const contextText = context.elements[0]!.text;
    assert.match(contextText, /Question/);
    assert.match(contextText, /marketer-sam/);
    assert.match(contextText, /<https:\/\/example.com\/plan\|open>/);
    assert.match(contextText, /task `task-abc`/);
  });

  it('surfaces Slack ok=false responses as a thrown Error and a warning', async () => {
    const records: RecordedRequest[] = [];
    const logs: string[] = [];
    const channel = new SlackNotificationDelivery({
      botToken: 'xoxb-test',
      ceoChannel: 'C404',
      fetchFn: makeFetchStub({ ok: false, error: 'channel_not_found' }, records),
      log: (msg) => logs.push(msg),
    });

    const notification = createNotification({
      agentId: 'a',
      title: 't',
      body: 'b',
    });

    await assert.rejects(() => channel.deliver(notification, 'a'), /channel_not_found/);
    assert.equal(records.length, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /channel_not_found/);
  });

  it('throws when Slack returns a non-JSON body', async () => {
    const records: RecordedRequest[] = [];
    const channel = new SlackNotificationDelivery({
      botToken: 'xoxb-test',
      ceoChannel: 'C500',
      fetchFn: makeFetchStub({ nonJsonBody: '<html>oops</html>' }, records),
    });

    const notification = createNotification({
      agentId: 'a',
      title: 't',
      body: 'b',
    });

    await assert.rejects(
      () => channel.deliver(notification, 'a'),
      /non-JSON response/,
    );
  });
});

describe('buildSlackMessage rendering edge cases', () => {
  it('falls back to info severity when notification.severity is unset', () => {
    const notification = createNotification({
      agentId: 'a',
      title: 'untitled',
      body: 'body',
    });
    const msg = buildSlackMessage(notification, 'a', 'C1');
    const header = msg.blocks[0] as { text: { text: string } };
    assert.match(header.text.text, /:information_source:/);
  });

  it('renders object link with label', () => {
    const notification = createNotification({
      agentId: 'a',
      title: 't',
      body: 'b',
      link: { href: 'https://x.com/y', label: 'View on dashboard' },
    });
    const msg = buildSlackMessage(notification, 'a', 'C1');
    const context = msg.blocks[2] as {
      elements: Array<{ text: string }>;
    };
    assert.match(context.elements[0]!.text, /<https:\/\/x\.com\/y\|View on dashboard>/);
  });

  it('omits link / task fragments when absent', () => {
    const notification = createNotification({
      agentId: 'a',
      title: 't',
      body: 'b',
    });
    const msg = buildSlackMessage(notification, 'a', 'C1');
    const context = msg.blocks[2] as {
      elements: Array<{ text: string }>;
    };
    assert.doesNotMatch(context.elements[0]!.text, /open|task /);
    assert.match(context.elements[0]!.text, /from `a`/);
  });

  it('truncates body sections that exceed the 2900-char block limit', () => {
    const longBody = 'x'.repeat(5000);
    const notification = createNotification({
      agentId: 'a',
      title: 't',
      body: longBody,
    });
    const msg = buildSlackMessage(notification, 'a', 'C1');
    const section = msg.blocks[1] as { text: { text: string } };
    assert.ok(section.text.text.length <= 2900);
    assert.match(section.text.text, /…$/);
  });

  it('handles unknown kind values by passing them through capitalised', () => {
    const notification = createNotification({
      agentId: 'a',
      title: 't',
      body: 'b',
      metadata: { kind: 'milestone' },
    });
    const msg = buildSlackMessage(notification, 'a', 'C1');
    const context = msg.blocks[2] as { elements: Array<{ text: string }> };
    assert.match(context.elements[0]!.text, /\*Milestone\*/);
  });
});

describe('NotificationStore subscribe integration', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'slack-delivery-test-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('fires deliver() exactly once per fresh notification, never on dedupKey skip', async () => {
    const records: RecordedRequest[] = [];
    const store = new NotificationStore(tmpDir);
    const channel = new SlackNotificationDelivery({
      botToken: 'xoxb-test',
      ceoChannel: 'D1',
      fetchFn: makeFetchStub({ ok: true }, records),
    });
    store.subscribe(channel);

    // First notification with a dedupKey — fires once.
    await store.send('agent-a', {
      source: 'system',
      systemEvent: 'task-warnings',
      title: 'first',
      body: 'b',
      dedupKey: 'warn:agent-a',
    });
    // Wait a microtask so the async fan-out has a chance to settle.
    await new Promise((r) => setImmediate(r));
    assert.equal(records.length, 1);

    // Second emit with the SAME dedupKey while the prior is still unread —
    // store.append() short-circuits without persisting OR firing fan-out.
    await store.send('agent-a', {
      source: 'system',
      systemEvent: 'task-warnings',
      title: 'second',
      body: 'b',
      dedupKey: 'warn:agent-a',
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(records.length, 1, 'dedupKey collision must NOT re-fire Slack');
  });

  it('surfaces delivery errors via the onChannelError sink without throwing through send()', async () => {
    const errors: unknown[] = [];
    const store = new NotificationStore(tmpDir, {
      onChannelError: (err) => {
        errors.push(err);
      },
    });
    const channel = new SlackNotificationDelivery({
      botToken: 'xoxb-test',
      ceoChannel: 'C404',
      fetchFn: makeFetchStub({ ok: false, error: 'channel_not_found' }, []),
      log: () => {},
    });
    store.subscribe(channel);

    // send() must NOT throw — storage already succeeded.
    const notif = await store.send('agent-a', {
      title: 'title',
      body: 'body',
    });
    assert.ok(notif.id);

    // Let the async fan-out resolve before asserting on the sink.
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1);
    assert.match((errors[0] as Error).message, /channel_not_found/);
  });
});
