/**
 * Tests for NotificationStore — file-based per-agent notification storage.
 *
 * Covers:
 *   - load (empty / missing / valid)
 *   - append (validation, id idempotency, dedupKey idempotency)
 *   - get
 *   - markRead (idempotent, sets readAt, returns null on missing)
 *   - markAllRead (returns flipped count)
 *   - unreadCount
 *   - query (filters: source, systemEvent, read; ordering; limit)
 *   - summary (totals, unread, by-source, by-system-event)
 *   - listAgents (walks baseDir, ignores agents without notifications.json)
 *   - loadAll (global aggregate ordered newest-first)
 *   - totalUnreadCount
 *   - per-agent file isolation
 *   - persistence path: .aweek/agents/<slug>/notifications.json
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  NotificationStore,
  createNotification,
  type Notification,
  type NotificationDeliveryChannel,
  type NotificationSystemEvent,
} from './notification-store.js';
import { readFileSync } from 'node:fs';

const AGENT_A = 'agent-alice-11111111';
const AGENT_B = 'agent-bob-22222222';
const AGENT_C = 'agent-carol-33333333';

let tmpDir: string;
let store: NotificationStore;

async function setup(): Promise<void> {
  tmpDir = await mkdtemp(join(tmpdir(), 'notification-store-test-'));
  store = new NotificationStore(tmpDir);
}

async function teardown(): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true });
}

interface NotifOpts {
  source?: 'agent' | 'system';
  systemEvent?: NotificationSystemEvent;
  title?: string;
  body?: string;
  dedupKey?: string;
  sourceTaskId?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

function notif(agentId: string = AGENT_A, opts: NotifOpts = {}): Notification {
  return createNotification({
    agentId,
    source: opts.source,
    systemEvent: opts.systemEvent,
    title: opts.title || 'Hello',
    body: opts.body || 'Notification body text',
    dedupKey: opts.dedupKey,
    sourceTaskId: opts.sourceTaskId,
    metadata: opts.metadata,
    createdAt: opts.createdAt,
  });
}

// ---------------------------------------------------------------------------
// createNotification — factory defaults
// ---------------------------------------------------------------------------

describe('createNotification', () => {
  it('defaults source to agent and read to false', () => {
    const n = createNotification({
      agentId: AGENT_A,
      title: 'Hi',
      body: 'There',
    });
    assert.equal(n.source, 'agent');
    assert.equal(n.read, false);
    assert.match(n.id, /^notif-[a-f0-9]+$/);
    assert.equal(typeof n.createdAt, 'string');
  });

  it('threads system event + dedupKey through when provided', () => {
    const n = createNotification({
      agentId: AGENT_A,
      source: 'system',
      systemEvent: 'budget-exhausted',
      title: 'Budget hit',
      body: 'Agent paused',
      dedupKey: 'budget-exhausted:2026-W17',
    });
    assert.equal(n.source, 'system');
    assert.equal(n.systemEvent, 'budget-exhausted');
    assert.equal(n.dedupKey, 'budget-exhausted:2026-W17');
  });
});

// ---------------------------------------------------------------------------
// Load — empty / missing
// ---------------------------------------------------------------------------

describe('NotificationStore — load', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns empty array when no notifications file exists', async () => {
    const result = await store.load(AGENT_A);
    assert.deepStrictEqual(result, []);
  });

  it('returns empty array for nonexistent agent directory', async () => {
    const result = await store.load('agent-nonexistent-00000000');
    assert.deepStrictEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

describe('NotificationStore — append', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('persists a notification to disk under <slug>/notifications.json', async () => {
    const n = notif(AGENT_A);
    await store.append(AGENT_A, n);

    // Verify the exact storage path matches the AC requirement.
    const expectedPath = join(tmpDir, AGENT_A, 'notifications.json');
    const stats = await stat(expectedPath);
    assert.ok(stats.isFile(), 'notifications.json should be a regular file');

    const raw = await readFile(expectedPath, 'utf-8');
    const parsed = JSON.parse(raw) as Notification[];
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.id, n.id);
    assert.equal(parsed[0]?.title, n.title);
    assert.equal(parsed[0]?.body, n.body);
    assert.equal(parsed[0]?.read, false);
  });

  it('appends multiple notifications in insertion order', async () => {
    const a = notif(AGENT_A, { title: 'First' });
    const b = notif(AGENT_A, { title: 'Second' });
    const c = notif(AGENT_A, { title: 'Third' });
    await store.append(AGENT_A, a);
    await store.append(AGENT_A, b);
    await store.append(AGENT_A, c);

    const loaded = await store.load(AGENT_A);
    assert.equal(loaded.length, 3);
    assert.equal(loaded[0]?.title, 'First');
    assert.equal(loaded[1]?.title, 'Second');
    assert.equal(loaded[2]?.title, 'Third');
  });

  it('is idempotent on duplicate id', async () => {
    const n = notif(AGENT_A);
    await store.append(AGENT_A, n);
    await store.append(AGENT_A, n);

    const loaded = await store.load(AGENT_A);
    assert.equal(loaded.length, 1);
  });

  it('dedupes when dedupKey matches an existing UNREAD notification', async () => {
    const a = notif(AGENT_A, {
      source: 'system',
      systemEvent: 'repeated-task-failure',
      dedupKey: 'task-failure:task-abc123',
    });
    const b = notif(AGENT_A, {
      source: 'system',
      systemEvent: 'repeated-task-failure',
      dedupKey: 'task-failure:task-abc123',
    });
    await store.append(AGENT_A, a);
    await store.append(AGENT_A, b);

    const loaded = await store.load(AGENT_A);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.id, a.id);
  });

  it('does NOT dedupe when the prior dedupKey notification is already read', async () => {
    const a = notif(AGENT_A, {
      source: 'system',
      systemEvent: 'repeated-task-failure',
      dedupKey: 'task-failure:task-abc123',
    });
    await store.append(AGENT_A, a);
    await store.markRead(AGENT_A, a.id);

    const b = notif(AGENT_A, {
      source: 'system',
      systemEvent: 'repeated-task-failure',
      dedupKey: 'task-failure:task-abc123',
    });
    await store.append(AGENT_A, b);

    const loaded = await store.load(AGENT_A);
    assert.equal(loaded.length, 2);
  });

  it('rejects an invalid notification (schema validation)', async () => {
    // Cast through `unknown` so the test can probe the runtime validator
    // without the type system rejecting the malformed shape ahead of AJV.
    const bad = {
      id: 'bad-id-no-prefix',
      agentId: AGENT_A,
      source: 'agent',
      title: '',
      body: 'Body',
      createdAt: new Date().toISOString(),
      read: false,
    } as unknown as Notification;
    await assert.rejects(
      () => store.append(AGENT_A, bad),
      /Schema validation failed/,
    );
  });

  it('creates the agent directory if it does not exist yet', async () => {
    await store.append(AGENT_A, notif(AGENT_A));
    const stats = await stat(join(tmpDir, AGENT_A));
    assert.ok(stats.isDirectory());
  });
});

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

describe('NotificationStore — get', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns a notification by id', async () => {
    const n = notif(AGENT_A);
    await store.append(AGENT_A, n);
    const found = await store.get(AGENT_A, n.id);
    assert.ok(found);
    assert.equal(found.id, n.id);
  });

  it('returns null for a missing id', async () => {
    await store.append(AGENT_A, notif(AGENT_A));
    assert.equal(await store.get(AGENT_A, 'notif-deadbeef'), null);
  });

  it('returns null for an empty feed', async () => {
    assert.equal(await store.get(AGENT_A, 'notif-deadbeef'), null);
  });
});

// ---------------------------------------------------------------------------
// markRead / markAllRead
// ---------------------------------------------------------------------------

describe('NotificationStore — markRead', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('flips read=false → true and stamps readAt', async () => {
    const n = notif(AGENT_A);
    await store.append(AGENT_A, n);
    const updated = await store.markRead(AGENT_A, n.id);
    assert.ok(updated);
    assert.equal(updated.read, true);
    assert.ok(updated.readAt);

    const loaded = await store.load(AGENT_A);
    assert.equal(loaded[0]?.read, true);
    assert.equal(loaded[0]?.readAt, updated.readAt);
  });

  it('is idempotent when already read', async () => {
    const n = notif(AGENT_A);
    await store.append(AGENT_A, n);
    const first = await store.markRead(AGENT_A, n.id);
    const second = await store.markRead(AGENT_A, n.id);
    assert.ok(first && second);
    assert.equal(first.readAt, second.readAt);
  });

  it('returns null for a missing notification', async () => {
    const result = await store.markRead(AGENT_A, 'notif-deadbeef');
    assert.equal(result, null);
  });
});

describe('NotificationStore — markAllRead', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('flips every unread notification and returns the flipped count', async () => {
    const a = notif(AGENT_A, { title: 'A' });
    const b = notif(AGENT_A, { title: 'B' });
    const c = notif(AGENT_A, { title: 'C' });
    await store.append(AGENT_A, a);
    await store.append(AGENT_A, b);
    await store.append(AGENT_A, c);
    await store.markRead(AGENT_A, b.id);

    const flipped = await store.markAllRead(AGENT_A);
    assert.equal(flipped, 2);

    const loaded = await store.load(AGENT_A);
    assert.ok(loaded.every((n) => n.read));
  });

  it('returns 0 when nothing is unread', async () => {
    const a = notif(AGENT_A);
    await store.append(AGENT_A, a);
    await store.markRead(AGENT_A, a.id);
    const flipped = await store.markAllRead(AGENT_A);
    assert.equal(flipped, 0);
  });

  it('returns 0 for an empty feed', async () => {
    assert.equal(await store.markAllRead(AGENT_A), 0);
  });
});

// ---------------------------------------------------------------------------
// unreadCount / totalUnreadCount
// ---------------------------------------------------------------------------

describe('NotificationStore — unreadCount', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('counts only unread notifications', async () => {
    const a = notif(AGENT_A);
    const b = notif(AGENT_A, { title: 'B' });
    const c = notif(AGENT_A, { title: 'C' });
    await store.append(AGENT_A, a);
    await store.append(AGENT_A, b);
    await store.append(AGENT_A, c);
    await store.markRead(AGENT_A, b.id);
    assert.equal(await store.unreadCount(AGENT_A), 2);
  });

  it('returns 0 for empty / missing feed', async () => {
    assert.equal(await store.unreadCount(AGENT_A), 0);
  });
});

describe('NotificationStore — totalUnreadCount', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('aggregates unread counts across every agent', async () => {
    await store.append(AGENT_A, notif(AGENT_A));
    await store.append(AGENT_B, notif(AGENT_B));
    await store.append(AGENT_B, notif(AGENT_B));
    await store.append(AGENT_C, notif(AGENT_C));
    assert.equal(await store.totalUnreadCount(), 4);
  });

  it('returns 0 when no agents have notifications', async () => {
    assert.equal(await store.totalUnreadCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

describe('NotificationStore — query', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns every notification with no filters (oldest first)', async () => {
    const a = notif(AGENT_A, { title: 'A' });
    const b = notif(AGENT_A, { title: 'B' });
    await store.append(AGENT_A, a);
    await store.append(AGENT_A, b);
    const results = await store.query(AGENT_A);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.title, 'A');
    assert.equal(results[1]?.title, 'B');
  });

  it('orders newest-first when newestFirst is true', async () => {
    const a = notif(AGENT_A, { title: 'A' });
    const b = notif(AGENT_A, { title: 'B' });
    await store.append(AGENT_A, a);
    await store.append(AGENT_A, b);
    const results = await store.query(AGENT_A, { newestFirst: true });
    assert.equal(results[0]?.title, 'B');
    assert.equal(results[1]?.title, 'A');
  });

  it('filters by source', async () => {
    await store.append(AGENT_A, notif(AGENT_A, { source: 'agent' }));
    await store.append(
      AGENT_A,
      notif(AGENT_A, {
        source: 'system',
        systemEvent: 'plan-ready',
      }),
    );
    const sys = await store.query(AGENT_A, { source: 'system' });
    assert.equal(sys.length, 1);
    assert.equal(sys[0]?.source, 'system');
  });

  it('filters by systemEvent', async () => {
    await store.append(
      AGENT_A,
      notif(AGENT_A, {
        source: 'system',
        systemEvent: 'budget-exhausted',
      }),
    );
    await store.append(
      AGENT_A,
      notif(AGENT_A, {
        source: 'system',
        systemEvent: 'plan-ready',
      }),
    );
    const planReady = await store.query(AGENT_A, { systemEvent: 'plan-ready' });
    assert.equal(planReady.length, 1);
    assert.equal(planReady[0]?.systemEvent, 'plan-ready');
  });

  it('filters by read state', async () => {
    const a = notif(AGENT_A);
    const b = notif(AGENT_A, { title: 'B' });
    await store.append(AGENT_A, a);
    await store.append(AGENT_A, b);
    await store.markRead(AGENT_A, a.id);
    const unread = await store.query(AGENT_A, { read: false });
    assert.equal(unread.length, 1);
    assert.equal(unread[0]?.id, b.id);
    const read = await store.query(AGENT_A, { read: true });
    assert.equal(read.length, 1);
    assert.equal(read[0]?.id, a.id);
  });

  it('respects limit after ordering', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append(AGENT_A, notif(AGENT_A, { title: `T${i}` }));
    }
    const results = await store.query(AGENT_A, { newestFirst: true, limit: 2 });
    assert.equal(results.length, 2);
    assert.equal(results[0]?.title, 'T4');
    assert.equal(results[1]?.title, 'T3');
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe('NotificationStore — summary', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns an empty summary for an empty feed', async () => {
    const s = await store.summary(AGENT_A);
    assert.equal(s.total, 0);
    assert.equal(s.unread, 0);
    assert.deepStrictEqual(s.bySource, {});
    assert.deepStrictEqual(s.bySystemEvent, {});
  });

  it('counts totals, unread, by-source, by-system-event correctly', async () => {
    const a = notif(AGENT_A, { source: 'agent' });
    const b = notif(AGENT_A, {
      source: 'system',
      systemEvent: 'budget-exhausted',
    });
    const c = notif(AGENT_A, {
      source: 'system',
      systemEvent: 'plan-ready',
    });
    await store.append(AGENT_A, a);
    await store.append(AGENT_A, b);
    await store.append(AGENT_A, c);
    await store.markRead(AGENT_A, b.id);

    const s = await store.summary(AGENT_A);
    assert.equal(s.total, 3);
    assert.equal(s.unread, 2);
    assert.equal(s.bySource.agent, 1);
    assert.equal(s.bySource.system, 2);
    assert.equal(s.bySystemEvent['budget-exhausted'], 1);
    assert.equal(s.bySystemEvent['plan-ready'], 1);
  });
});

// ---------------------------------------------------------------------------
// listAgents + loadAll (global aggregate)
// ---------------------------------------------------------------------------

describe('NotificationStore — listAgents', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('lists every agent slug that has a notifications file', async () => {
    await store.append(AGENT_A, notif(AGENT_A));
    await store.append(AGENT_C, notif(AGENT_C));
    const agents = await store.listAgents();
    assert.deepStrictEqual(agents, [AGENT_A, AGENT_C].sort());
  });

  it('ignores agent dirs that have no notifications file', async () => {
    // Create a bare agent dir (e.g. one that only has inbox.json)
    await mkdir(join(tmpDir, AGENT_B), { recursive: true });
    await store.append(AGENT_A, notif(AGENT_A));
    const agents = await store.listAgents();
    assert.deepStrictEqual(agents, [AGENT_A]);
  });

  it('returns empty array when baseDir does not exist', async () => {
    await rm(tmpDir, { recursive: true, force: true });
    assert.deepStrictEqual(await store.listAgents(), []);
    // Re-create so teardown does not double-fail.
    await mkdir(tmpDir, { recursive: true });
  });
});

describe('NotificationStore — loadAll', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('aggregates every agent feed and orders newest-first by default', async () => {
    const t0 = '2026-04-25T10:00:00.000Z';
    const t1 = '2026-04-26T10:00:00.000Z';
    const t2 = '2026-04-27T10:00:00.000Z';
    await store.append(AGENT_A, notif(AGENT_A, { title: 'A0', createdAt: t0 }));
    await store.append(AGENT_B, notif(AGENT_B, { title: 'B1', createdAt: t1 }));
    await store.append(AGENT_C, notif(AGENT_C, { title: 'C2', createdAt: t2 }));

    const all = await store.loadAll();
    assert.equal(all.length, 3);
    assert.equal(all[0]?.title, 'C2');
    assert.equal(all[0]?.agent, AGENT_C);
    assert.equal(all[1]?.title, 'B1');
    assert.equal(all[1]?.agent, AGENT_B);
    assert.equal(all[2]?.title, 'A0');
    assert.equal(all[2]?.agent, AGENT_A);
  });

  it('respects limit + filter combinations across agents', async () => {
    await store.append(AGENT_A, notif(AGENT_A, { source: 'agent' }));
    await store.append(
      AGENT_B,
      notif(AGENT_B, {
        source: 'system',
        systemEvent: 'budget-exhausted',
      }),
    );
    await store.append(
      AGENT_C,
      notif(AGENT_C, {
        source: 'system',
        systemEvent: 'plan-ready',
      }),
    );
    const sysOnly = await store.loadAll({ source: 'system' });
    assert.equal(sysOnly.length, 2);
    assert.ok(sysOnly.every((n) => n.source === 'system'));

    const limited = await store.loadAll({ limit: 1 });
    assert.equal(limited.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Per-agent file isolation
// ---------------------------------------------------------------------------

describe('NotificationStore — agent isolation', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('writes are scoped to a single per-agent file', async () => {
    await store.append(AGENT_A, notif(AGENT_A, { title: 'For A' }));
    await store.append(AGENT_B, notif(AGENT_B, { title: 'For B' }));

    const a = await store.load(AGENT_A);
    const b = await store.load(AGENT_B);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0]?.title, 'For A');
    assert.equal(b[0]?.title, 'For B');

    // Verify the actual disk layout matches the AC requirement.
    const aPath = join(tmpDir, AGENT_A, 'notifications.json');
    const bPath = join(tmpDir, AGENT_B, 'notifications.json');
    assert.ok((await stat(aPath)).isFile());
    assert.ok((await stat(bPath)).isFile());
  });

  it('mark-read on one agent does not affect another', async () => {
    const nA = notif(AGENT_A);
    const nB = notif(AGENT_B);
    await store.append(AGENT_A, nA);
    await store.append(AGENT_B, nB);
    await store.markAllRead(AGENT_A);

    const aLoaded = await store.load(AGENT_A);
    const bLoaded = await store.load(AGENT_B);
    assert.equal(aLoaded[0]?.read, true);
    assert.equal(bLoaded[0]?.read, false);
  });
});

// ---------------------------------------------------------------------------
// AC 17 — Storage / delivery decoupling
// ---------------------------------------------------------------------------
//
// These tests pin the seam that lets future external delivery channels
// (Slack, email, OS push, webhooks) hook into the notification feed
// without modifying the store. They assert:
//
//   1. The on-disk module imports nothing from the dashboard, CLI, or
//      heartbeat layers — storage is the lowest layer in the stack.
//   2. `subscribe()` registers a channel that fires once per freshly
//      persisted notification, in registration order.
//   3. Idempotent no-ops (duplicate id, dedupKey collision) MUST NOT
//      fire delivery — channels only see new notifications.
//   4. Errors from a channel never propagate through `append()` and
//      never block sibling channels — they surface via the optional
//      error sink instead.
//   5. Async channels are fire-and-forget: `append()` resolves before
//      a slow channel finishes.
//   6. `subscribe()` returns an unsubscribe handle that is idempotent.

describe('NotificationStore — storage/delivery decoupling (AC 17)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('source file imports nothing from serve/, skills/, cli/, or heartbeat/', () => {
    // Locate the source file relative to this compiled test file. The
    // .ts source sits next to the .test.ts so a same-directory read is
    // safe in both source and built layouts.
    const src = readFileSync(
      new URL('./notification-store.ts', import.meta.url),
      'utf-8',
    );
    // Ban any relative import that crosses into a UI / orchestration layer.
    // We deliberately allow `../schemas/validator.js` (peer storage helpers
    // are also fine) — anything reaching into the dashboard or CLI would be
    // a regression.
    const offending = [
      /from\s+['"]\.\.\/serve\//,
      /from\s+['"]\.\.\/skills\//,
      /from\s+['"]\.\.\/cli\//,
      /from\s+['"]\.\.\/heartbeat\//,
      /from\s+['"]\.\.\/services\//,
    ];
    for (const re of offending) {
      assert.equal(
        re.test(src),
        false,
        `notification-store.ts must not import from a higher layer (matched ${re})`,
      );
    }
  });

  it('subscribe() fires deliver() once per newly persisted notification', async () => {
    const seen: Array<{ id: string; agent: string }> = [];
    const channel: NotificationDeliveryChannel = {
      name: 'test-channel',
      deliver(n, agent) {
        seen.push({ id: n.id, agent });
      },
    };
    store.subscribe(channel);

    const a = notif(AGENT_A, { title: 'A' });
    const b = notif(AGENT_B, { title: 'B' });
    await store.append(AGENT_A, a);
    await store.append(AGENT_B, b);

    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.id, a.id);
    assert.equal(seen[0]?.agent, AGENT_A);
    assert.equal(seen[1]?.id, b.id);
    assert.equal(seen[1]?.agent, AGENT_B);
  });

  it('multiple channels fire in registration order', async () => {
    const order: string[] = [];
    store.subscribe({ name: 'first', deliver: () => void order.push('first') });
    store.subscribe({ name: 'second', deliver: () => void order.push('second') });
    store.subscribe({ name: 'third', deliver: () => void order.push('third') });

    await store.append(AGENT_A, notif(AGENT_A));
    assert.deepStrictEqual(order, ['first', 'second', 'third']);
  });

  it('does NOT fire delivery on duplicate-id idempotent no-op', async () => {
    let calls = 0;
    store.subscribe({
      name: 'count',
      deliver: () => {
        calls++;
      },
    });
    const n = notif(AGENT_A);
    await store.append(AGENT_A, n);
    await store.append(AGENT_A, n);
    assert.equal(calls, 1, 'duplicate id append should not re-fire delivery');
  });

  it('does NOT fire delivery on dedupKey idempotent no-op', async () => {
    let calls = 0;
    store.subscribe({
      name: 'count',
      deliver: () => {
        calls++;
      },
    });
    await store.append(
      AGENT_A,
      notif(AGENT_A, {
        source: 'system',
        systemEvent: 'repeated-task-failure',
        dedupKey: 'task-failure:t-1',
      }),
    );
    await store.append(
      AGENT_A,
      notif(AGENT_A, {
        source: 'system',
        systemEvent: 'repeated-task-failure',
        dedupKey: 'task-failure:t-1',
      }),
    );
    assert.equal(calls, 1, 'dedupKey collision must not re-fire delivery');
  });

  it('synchronous channel error never propagates through append()', async () => {
    const errors: Array<{ err: unknown; channel: string }> = [];
    const failingStore = new NotificationStore(tmpDir, {
      onChannelError: (err, ctx) => {
        errors.push({ err, channel: ctx.channel });
      },
    });
    failingStore.subscribe({
      name: 'broken',
      deliver: () => {
        throw new Error('boom');
      },
    });
    failingStore.subscribe({
      name: 'healthy',
      deliver: () => {
        // healthy sibling — must still run
      },
    });

    // The append must succeed AND fully persist even though the first
    // channel threw.
    await failingStore.append(AGENT_A, notif(AGENT_A));
    const loaded = await failingStore.load(AGENT_A);
    assert.equal(loaded.length, 1);

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.channel, 'broken');
    assert.ok(errors[0]?.err instanceof Error);
    assert.equal((errors[0]?.err as Error).message, 'boom');
  });

  it('async channel rejection surfaces via onChannelError, not append()', async () => {
    // Wire the error sink first so we have a promise to await.
    const errors: string[] = [];
    let sinkResolve!: () => void;
    const sinkFired = new Promise<void>((r) => {
      sinkResolve = r;
    });
    const asyncStore = new NotificationStore(tmpDir, {
      onChannelError: (err, ctx) => {
        errors.push(`${ctx.channel}:${(err as Error).message}`);
        sinkResolve();
      },
    });
    // The channel returns a freshly-built rejected promise on every call.
    // The `.catch()` wired by the store inside `_fanout` is what observes
    // the rejection — by attaching it on the same tick the promise is
    // returned, we avoid the "unhandled rejection" race that would happen
    // if we constructed the rejected promise outside the channel.
    asyncStore.subscribe({
      name: 'flaky',
      deliver: () => Promise.reject(new Error('async-fail')),
    });

    // append() must resolve regardless of the channel's eventual rejection.
    await asyncStore.append(AGENT_A, notif(AGENT_A));
    // Now wait for the sink to observe the rejection.
    await sinkFired;
    assert.deepStrictEqual(errors, ['flaky:async-fail']);
  });

  it('returned unsubscribe handle stops further deliveries and is idempotent', async () => {
    let calls = 0;
    const unsub = store.subscribe({
      name: 'count',
      deliver: () => {
        calls++;
      },
    });

    await store.append(AGENT_A, notif(AGENT_A, { title: 'pre' }));
    assert.equal(calls, 1);

    unsub();
    unsub(); // calling twice must be a safe no-op
    assert.equal(store.channelCount, 0);

    await store.append(AGENT_A, notif(AGENT_A, { title: 'post' }));
    assert.equal(calls, 1, 'no further deliveries after unsubscribe');
  });

  it('channels passed via constructor options are pre-registered', async () => {
    let calls = 0;
    const preStore = new NotificationStore(tmpDir, {
      channels: [
        {
          name: 'ctor',
          deliver: () => {
            calls++;
          },
        },
      ],
    });
    assert.equal(preStore.channelCount, 1);
    await preStore.append(AGENT_A, notif(AGENT_A));
    assert.equal(calls, 1);
  });

  it('zero channels — append() works exactly like before', async () => {
    // No channels, no error sink — the legacy storage path must be
    // untouched. This guards against any regression from adding the
    // observer hook.
    assert.equal(store.channelCount, 0);
    const n = notif(AGENT_A);
    const out = await store.append(AGENT_A, n);
    assert.equal(out.id, n.id);
    const loaded = await store.load(AGENT_A);
    assert.equal(loaded.length, 1);
  });
});

// ---------------------------------------------------------------------------
// AC 2 — storage layer auto-populates sender slug, ID, timestamp, read state
//
// `NotificationStore.send(senderSlug, opts)` is the high-level entry point
// the CLI dispatcher and system-event emitters call. Per AC 2 the caller
// supplies only content (title + body) plus any optional fields, and the
// store stamps the four pieces of metadata that should never be the
// agent's responsibility:
//
//   - sender slug (`agentId`) — taken from the senderSlug argument
//   - unique `id`             — generated as notif-<hex>
//   - `createdAt` timestamp   — stamped at write time (UTC ISO-8601)
//   - `read` flag             — defaulted to false
// ---------------------------------------------------------------------------

describe('NotificationStore — send() auto-population (AC 2)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('auto-populates sender slug from the senderSlug argument', async () => {
    const persisted = await store.send(AGENT_A, {
      title: 'Hello',
      body: 'World',
    });
    assert.equal(persisted.agentId, AGENT_A);

    // The on-disk feed lives under the sender's slug.
    const onDisk = JSON.parse(
      readFileSync(join(tmpDir, AGENT_A, 'notifications.json'), 'utf-8'),
    ) as Notification[];
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0]?.agentId, AGENT_A);
  });

  it('auto-generates a unique notif-<hex> id', async () => {
    const a = await store.send(AGENT_A, { title: 'A', body: 'a' });
    const b = await store.send(AGENT_A, { title: 'B', body: 'b' });
    assert.match(a.id, /^notif-[a-f0-9]+$/);
    assert.match(b.id, /^notif-[a-f0-9]+$/);
    assert.notEqual(a.id, b.id);
  });

  it('auto-stamps createdAt with a current ISO-8601 UTC timestamp', async () => {
    const before = Date.now();
    const persisted = await store.send(AGENT_A, {
      title: 'Hello',
      body: 'World',
    });
    const after = Date.now();
    const stamped = Date.parse(persisted.createdAt);
    assert.ok(!Number.isNaN(stamped), 'createdAt must parse as a valid date');
    assert.ok(stamped >= before, 'createdAt must be >= call start');
    assert.ok(stamped <= after, 'createdAt must be <= call end');
    // ISO-8601 UTC ends in `Z`.
    assert.match(persisted.createdAt, /Z$/);
  });

  it('auto-defaults read=false and leaves readAt unset', async () => {
    const persisted = await store.send(AGENT_A, {
      title: 'Hello',
      body: 'World',
    });
    assert.equal(persisted.read, false);
    assert.equal(persisted.readAt, undefined);
  });

  it('defaults source to "agent" so CLI calls do not need to pass it', async () => {
    const persisted = await store.send(AGENT_A, {
      title: 'Hello',
      body: 'World',
    });
    assert.equal(persisted.source, 'agent');
  });

  it('threads optional fields (source/systemEvent/dedupKey/metadata/sourceTaskId) through unchanged', async () => {
    const persisted = await store.send(AGENT_A, {
      source: 'system',
      systemEvent: 'budget-exhausted',
      title: 'Budget hit',
      body: 'Agent paused',
      dedupKey: 'budget-exhausted:2026-W17',
      sourceTaskId: 'task-abc123',
      metadata: { weekKey: '2026-W17', limit: 100000 },
    });
    assert.equal(persisted.source, 'system');
    assert.equal(persisted.systemEvent, 'budget-exhausted');
    assert.equal(persisted.dedupKey, 'budget-exhausted:2026-W17');
    assert.equal(persisted.sourceTaskId, 'task-abc123');
    assert.deepEqual(persisted.metadata, {
      weekKey: '2026-W17',
      limit: 100000,
    });
    // Auto-populated fields still take precedence over caller input.
    assert.match(persisted.id, /^notif-[a-f0-9]+$/);
    assert.equal(persisted.read, false);
    assert.equal(persisted.agentId, AGENT_A);
  });

  it('honors a caller-supplied createdAt as the test/replay escape hatch', async () => {
    const fixed = '2026-04-25T10:00:00.000Z';
    const persisted = await store.send(AGENT_A, {
      title: 'Backfill',
      body: 'Replayed event',
      createdAt: fixed,
    });
    assert.equal(persisted.createdAt, fixed);
  });

  it('rejects empty / non-string senderSlug', async () => {
    await assert.rejects(
      // @ts-expect-error — runtime probe for the storage-layer guard
      () => store.send('', { title: 'Hi', body: 'There' }),
      /senderSlug is required/,
    );
    await assert.rejects(
      // @ts-expect-error — runtime probe for the storage-layer guard
      () => store.send(undefined, { title: 'Hi', body: 'There' }),
      /senderSlug is required/,
    );
  });

  it('still validates content (empty title fails schema validation)', async () => {
    await assert.rejects(
      () =>
        store.send(AGENT_A, {
          title: '',
          body: 'There',
        }),
      /Schema validation failed/,
    );
  });

  it('persists through the same pipeline as append() (idempotency by dedupKey honored)', async () => {
    // Two system-event sends with the same unread dedupKey collapse to one.
    await store.send(AGENT_A, {
      source: 'system',
      systemEvent: 'repeated-task-failure',
      title: 'Task is failing',
      body: 'task-abc123 failed twice',
      dedupKey: 'task-failure:task-abc123',
    });
    await store.send(AGENT_A, {
      source: 'system',
      systemEvent: 'repeated-task-failure',
      title: 'Task is failing',
      body: 'task-abc123 failed twice',
      dedupKey: 'task-failure:task-abc123',
    });
    const feed = await store.load(AGENT_A);
    assert.equal(feed.length, 1);
  });

  it('fan-out delivery channels see the auto-populated notification', async () => {
    const seen: Array<{ agentId: string; notification: Notification }> = [];
    const channel: NotificationDeliveryChannel = {
      name: 'send-test-channel',
      deliver(notification, agentId) {
        seen.push({ agentId, notification });
      },
    };
    store.subscribe(channel);

    const persisted = await store.send(AGENT_A, {
      title: 'Hello',
      body: 'World',
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.agentId, AGENT_A);
    assert.equal(seen[0]?.notification.id, persisted.id);
    assert.equal(seen[0]?.notification.read, false);
    assert.equal(seen[0]?.notification.agentId, AGENT_A);
  });
});

// ---------------------------------------------------------------------------
// AC 10 — Each notification tracks unread/read state persistently
//
// The read/unread bit must survive across process boundaries: it lives on
// disk in the per-agent notifications.json file, not in an in-memory cache
// owned by the NotificationStore instance. These tests pin that contract by
// performing every mutation on one store instance, then constructing a
// FRESH NotificationStore against the same baseDir and verifying the read
// state is observable on the new instance.
//
// Together these assertions guarantee:
//   1. Newly appended/sent notifications start `read: false` and persist
//      that flag verbatim to disk (no implicit auto-mark-read).
//   2. `markRead` flips `read: true` AND writes a `readAt` ISO-8601
//      timestamp to disk; both fields survive a fresh store instance.
//   3. `markAllRead` persists the bulk transition for every unread row.
//   4. The persisted read flag drives `query({read})`, `unreadCount`,
//      `totalUnreadCount`, and `summary` consistently after a reload.
//   5. Per-agent read-state isolation is preserved on disk — flipping one
//      agent's feed must not bleed into another's persisted file.
// ---------------------------------------------------------------------------

describe('NotificationStore — persistent unread/read state (AC 10)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('newly appended notifications persist read=false on disk and survive a fresh store instance', async () => {
    const n = notif(AGENT_A);
    await store.append(AGENT_A, n);

    // Inspect the raw on-disk JSON (no NotificationStore intermediation).
    const raw = await readFile(
      join(tmpDir, AGENT_A, 'notifications.json'),
      'utf-8',
    );
    const onDisk = JSON.parse(raw) as Notification[];
    assert.equal(onDisk[0]?.read, false, 'fresh notification persists as unread on disk');
    assert.equal(onDisk[0]?.readAt, undefined, 'readAt must not be set until markRead fires');

    // A brand-new store instance pointed at the same baseDir must observe
    // the same unread state without any prior in-memory context.
    const fresh = new NotificationStore(tmpDir);
    const reloaded = await fresh.load(AGENT_A);
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0]?.id, n.id);
    assert.equal(reloaded[0]?.read, false);
    assert.equal(reloaded[0]?.readAt, undefined);
    assert.equal(await fresh.unreadCount(AGENT_A), 1);
  });

  it('markRead persists read=true + readAt to disk and survives a fresh store instance', async () => {
    const n = notif(AGENT_A);
    await store.append(AGENT_A, n);
    const updated = await store.markRead(AGENT_A, n.id);
    assert.ok(updated);
    assert.equal(updated.read, true);
    assert.ok(updated.readAt, 'markRead must stamp readAt');
    assert.match(updated.readAt!, /Z$/, 'readAt is ISO-8601 UTC');

    // Verify the on-disk JSON carries both fields verbatim.
    const raw = await readFile(
      join(tmpDir, AGENT_A, 'notifications.json'),
      'utf-8',
    );
    const onDisk = JSON.parse(raw) as Notification[];
    assert.equal(onDisk[0]?.read, true);
    assert.equal(onDisk[0]?.readAt, updated.readAt);

    // Reload through a fresh NotificationStore — the persisted state must
    // be observable without reusing the original instance.
    const fresh = new NotificationStore(tmpDir);
    const reloaded = await fresh.get(AGENT_A, n.id);
    assert.ok(reloaded);
    assert.equal(reloaded.read, true);
    assert.equal(reloaded.readAt, updated.readAt);
    assert.equal(await fresh.unreadCount(AGENT_A), 0);
  });

  it('markAllRead persists the bulk transition for every row across a fresh store instance', async () => {
    const a = notif(AGENT_A, { title: 'A' });
    const b = notif(AGENT_A, { title: 'B' });
    const c = notif(AGENT_A, { title: 'C' });
    await store.append(AGENT_A, a);
    await store.append(AGENT_A, b);
    await store.append(AGENT_A, c);
    assert.equal(await store.markAllRead(AGENT_A), 3);

    // Disk inspection: every row should now be read=true with readAt set.
    const raw = await readFile(
      join(tmpDir, AGENT_A, 'notifications.json'),
      'utf-8',
    );
    const onDisk = JSON.parse(raw) as Notification[];
    assert.equal(onDisk.length, 3);
    for (const row of onDisk) {
      assert.equal(row.read, true);
      assert.ok(row.readAt, 'readAt must be persisted for every flipped row');
    }

    // Fresh store sees the same persisted state.
    const fresh = new NotificationStore(tmpDir);
    const reloaded = await fresh.load(AGENT_A);
    assert.equal(reloaded.length, 3);
    assert.ok(reloaded.every((n) => n.read === true));
    assert.equal(await fresh.unreadCount(AGENT_A), 0);
    assert.equal(await fresh.markAllRead(AGENT_A), 0);
  });

  it('persisted read flag drives query/unreadCount/summary after a reload', async () => {
    const a = notif(AGENT_A, { title: 'A' });
    const b = notif(AGENT_A, { title: 'B' });
    const c = notif(AGENT_A, { title: 'C' });
    await store.append(AGENT_A, a);
    await store.append(AGENT_A, b);
    await store.append(AGENT_A, c);
    await store.markRead(AGENT_A, a.id);
    await store.markRead(AGENT_A, c.id);

    // Discard the original store and rebuild from disk only.
    const fresh = new NotificationStore(tmpDir);

    const unread = await fresh.query(AGENT_A, { read: false });
    assert.equal(unread.length, 1);
    assert.equal(unread[0]?.id, b.id);

    const read = await fresh.query(AGENT_A, { read: true });
    assert.equal(read.length, 2);
    const readIds = read.map((n) => n.id).sort();
    assert.deepStrictEqual(readIds, [a.id, c.id].sort());

    assert.equal(await fresh.unreadCount(AGENT_A), 1);

    const sum = await fresh.summary(AGENT_A);
    assert.equal(sum.total, 3);
    assert.equal(sum.unread, 1);
  });

  it('totalUnreadCount aggregates persisted read state across agents on a fresh store', async () => {
    await store.append(AGENT_A, notif(AGENT_A));
    await store.append(AGENT_A, notif(AGENT_A, { title: 'A2' }));
    await store.append(AGENT_B, notif(AGENT_B));
    await store.append(AGENT_C, notif(AGENT_C));
    // Mark one read per A and the only one in B.
    const aFeed = await store.load(AGENT_A);
    await store.markRead(AGENT_A, aFeed[0]!.id);
    const bFeed = await store.load(AGENT_B);
    await store.markRead(AGENT_B, bFeed[0]!.id);

    const fresh = new NotificationStore(tmpDir);
    // Persisted unread totals: A=1, B=0, C=1 → 2
    assert.equal(await fresh.totalUnreadCount(), 2);
    assert.equal(await fresh.unreadCount(AGENT_A), 1);
    assert.equal(await fresh.unreadCount(AGENT_B), 0);
    assert.equal(await fresh.unreadCount(AGENT_C), 1);
  });

  it('per-agent read state is isolated on disk — flipping one feed does not bleed into another', async () => {
    const nA = notif(AGENT_A);
    const nB = notif(AGENT_B);
    await store.append(AGENT_A, nA);
    await store.append(AGENT_B, nB);
    await store.markRead(AGENT_A, nA.id);

    // Inspect both files independently.
    const rawA = await readFile(
      join(tmpDir, AGENT_A, 'notifications.json'),
      'utf-8',
    );
    const rawB = await readFile(
      join(tmpDir, AGENT_B, 'notifications.json'),
      'utf-8',
    );
    const diskA = JSON.parse(rawA) as Notification[];
    const diskB = JSON.parse(rawB) as Notification[];
    assert.equal(diskA[0]?.read, true);
    assert.ok(diskA[0]?.readAt);
    assert.equal(diskB[0]?.read, false);
    assert.equal(diskB[0]?.readAt, undefined);

    // Fresh store sees the same isolation.
    const fresh = new NotificationStore(tmpDir);
    const aReloaded = await fresh.get(AGENT_A, nA.id);
    const bReloaded = await fresh.get(AGENT_B, nB.id);
    assert.equal(aReloaded?.read, true);
    assert.equal(bReloaded?.read, false);
  });

  it('readAt is monotonic per notification — re-marking does not rewrite the stamp', async () => {
    // Idempotency contract: once a notification has been marked read, the
    // readAt timestamp is immutable through subsequent markRead calls.
    // Persisting the original stamp is what lets the dashboard show "read
    // 2 hours ago" instead of "read just now" on every page load.
    const n = notif(AGENT_A);
    await store.append(AGENT_A, n);
    const first = await store.markRead(AGENT_A, n.id);
    assert.ok(first?.readAt);

    // Reload through a fresh store, re-call markRead — the persisted
    // readAt must be preserved verbatim.
    const fresh = new NotificationStore(tmpDir);
    const second = await fresh.markRead(AGENT_A, n.id);
    assert.ok(second);
    assert.equal(second.readAt, first.readAt);

    // And the on-disk JSON should still carry the same value.
    const raw = await readFile(
      join(tmpDir, AGENT_A, 'notifications.json'),
      'utf-8',
    );
    const onDisk = JSON.parse(raw) as Notification[];
    assert.equal(onDisk[0]?.readAt, first.readAt);
  });

  it('send() output participates in the same persistent read-state lifecycle as append()', async () => {
    // The CLI `aweek exec notify send` path uses store.send(); AC 2 +
    // AC 10 together require its output to behave identically to append()
    // in terms of read-state persistence.
    const persisted = await store.send(AGENT_A, {
      title: 'Hello',
      body: 'World',
    });
    assert.equal(persisted.read, false);

    // Mark read through the same store, then verify a fresh instance sees
    // the persisted transition.
    await store.markRead(AGENT_A, persisted.id);
    const fresh = new NotificationStore(tmpDir);
    const reloaded = await fresh.get(AGENT_A, persisted.id);
    assert.ok(reloaded);
    assert.equal(reloaded.read, true);
    assert.ok(reloaded.readAt);
  });
});
