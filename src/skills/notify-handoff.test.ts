/**
 * AC 15: Deliverable hand-offs work via the same agent-initiated free-form
 * notify tool (no separate mechanism).
 *
 * This test file pins the contract that there is exactly ONE agent-initiated
 * user-facing write surface — `aweek exec notify send` (the
 * `sendNotification` skill) — and that artifact / deliverable hand-offs flow
 * through it. The notify skill's `link`, `sourceTaskId`, and `metadata`
 * fields together carry every shape of deliverable reference (artifact-store
 * entries, raw URLs, in-app dashboard routes) without requiring a parallel
 * "deliver" / "handoff" / "ship" CLI.
 *
 * Coverage:
 *   - End-to-end deliverable hand-off: register a real artifact via
 *     ArtifactStore, then hand it off through `sendNotification` and assert
 *     the persisted notification carries the artifact's identity, file path
 *     (via `link`), and originating-task backlink (via `sourceTaskId`).
 *   - Bare-URL hand-off (an external deliverable URL with no on-disk file)
 *     uses the same skill — no special path.
 *   - Multi-deliverable hand-off (agent ships two artifacts in the same
 *     week) uses two notify-send calls — no batch hand-off mechanism.
 *   - Dispatcher contract: `notify` is the only module on the registry
 *     that targets agent-initiated user-facing writes; no separate
 *     `handoff` / `deliverable` / `ship` / `deliver` module exists.
 *   - The legacy delegate-task surface is inter-agent (not agent→user) and
 *     therefore not a competing hand-off mechanism — pinned for clarity.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentStore } from '../storage/agent-store.js';
import { NotificationStore } from '../storage/notification-store.js';
import { ArtifactStore, createArtifactRecord } from '../storage/artifact-store.js';
import { createAgentConfig } from '../models/agent.js';
import { sendNotification } from './notify.js';
import { REGISTRY, listModules } from '../cli/dispatcher.js';

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

interface HandoffFixture {
  tmpDir: string;
  projectDir: string;
  agentStore: AgentStore;
  notificationStore: NotificationStore;
  artifactStore: ArtifactStore;
  senderId: string;
}

let fx: HandoffFixture;

async function setup(): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'notify-handoff-test-'));
  // ArtifactStore needs a separate "project root" so artifact files live
  // outside the .aweek/agents tree.
  const projectDir = await mkdtemp(join(tmpdir(), 'notify-handoff-proj-'));

  const agentStore = new AgentStore(tmpDir);
  const notificationStore = new NotificationStore(tmpDir);
  const artifactStore = new ArtifactStore(tmpDir, projectDir);

  const sender = createAgentConfig({
    subagentRef: 'shipper',
    weeklyTokenLimit: 100_000,
  });
  await agentStore.save(sender);

  fx = {
    tmpDir,
    projectDir,
    agentStore,
    notificationStore,
    artifactStore,
    senderId: sender.id,
  };
}

async function teardown(): Promise<void> {
  await rm(fx.tmpDir, { recursive: true, force: true });
  await rm(fx.projectDir, { recursive: true, force: true });
}

/** Materialize an artifact file on disk under the project dir. */
async function writeProjectFile(relativePath: string, contents: string): Promise<void> {
  const fullPath = join(fx.projectDir, relativePath);
  const parent = fullPath.slice(0, fullPath.lastIndexOf('/'));
  if (parent && parent !== fx.projectDir) {
    await mkdir(parent, { recursive: true });
  }
  await writeFile(fullPath, contents, 'utf-8');
}

// ---------------------------------------------------------------------------
// AC 15 — end-to-end deliverable hand-off through the same notify tool
// ---------------------------------------------------------------------------

describe('AC 15: deliverable hand-off via the agent-initiated notify tool', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('artifact deliverables hand off through `sendNotification` (no separate mechanism)', async () => {
    // 1. Agent produces a real deliverable on disk and registers it through
    //    the canonical artifact store. ArtifactStore stays a tracking layer —
    //    it does NOT surface anything to the user.
    await writeProjectFile('output/weekly-report.md', '# Weekly Report\n\nAll done.\n');

    const artifact = await fx.artifactStore.register(
      fx.senderId,
      createArtifactRecord({
        agentId: fx.senderId,
        taskId: 'task-weekly-report-1',
        filePath: 'output/weekly-report.md',
        fileName: 'Weekly Report',
        type: 'report',
        description: 'Weekly progress report for week 17',
        week: '2026-W17',
      }),
    );

    // 2. Agent hands the deliverable off to the user via the SAME free-form
    //    notify tool any agent message would use. The hand-off is just a
    //    notification with `link` + `sourceTaskId` + artifact metadata.
    const handoff = await sendNotification(
      {
        senderSlug: fx.senderId,
        title: 'Weekly report ready',
        body: 'Your weekly progress report is ready for review.',
        options: {
          link: {
            href: artifact.filePath,
            label: artifact.fileName,
            external: false,
          },
          sourceTaskId: artifact.taskId,
          metadata: {
            artifactId: artifact.id,
            artifactType: artifact.type,
            week: artifact.week,
          },
        },
      },
      { agentStore: fx.agentStore, notificationStore: fx.notificationStore },
    );

    // 3. The persisted notification must carry the full deliverable
    //    reference — file path (via link.href), originating task (via
    //    sourceTaskId), artifact id (via metadata) — so the dashboard /
    //    future push channels can render the hand-off without reaching
    //    into the artifact manifest themselves.
    assert.equal(handoff.source, 'agent', 'hand-offs are agent-source notifications');
    assert.equal(handoff.systemEvent, undefined, 'hand-offs are NOT system events');
    assert.equal(handoff.title, 'Weekly report ready');
    assert.deepEqual(handoff.link, {
      href: 'output/weekly-report.md',
      label: 'Weekly Report',
      external: false,
    });
    assert.equal(handoff.sourceTaskId, 'task-weekly-report-1');
    assert.deepEqual(handoff.metadata, {
      artifactId: artifact.id,
      artifactType: 'report',
      week: '2026-W17',
    });

    // 4. The notification lands in the same per-agent feed as any other
    //    agent-authored notification — the dashboard inbox UI reads from
    //    a single source of truth.
    const feed = await fx.notificationStore.load(fx.senderId);
    assert.equal(feed.length, 1);
    assert.equal(feed[0]?.id, handoff.id);
  });

  it('bare-URL deliverables (external URLs) use the SAME notify tool — no special path', async () => {
    // External deliverables (e.g., a Loom recording, a published Notion
    // page, a deployed preview URL) skip the artifact store entirely.
    // They still ride the same notify-send surface — the `link` field
    // accepts a bare string URL.
    const handoff = await sendNotification(
      {
        senderSlug: fx.senderId,
        title: 'Demo recording posted',
        body: 'Recorded the tutorial walkthrough — link below.',
        options: {
          link: 'https://example.com/recordings/demo-2026-W17',
          sourceTaskId: 'task-demo-recording-1',
        },
      },
      { agentStore: fx.agentStore, notificationStore: fx.notificationStore },
    );

    assert.equal(handoff.source, 'agent');
    assert.equal(handoff.link, 'https://example.com/recordings/demo-2026-W17');
    assert.equal(handoff.sourceTaskId, 'task-demo-recording-1');
  });

  it('multiple deliverables in one week each ride a separate notify-send (no batch mechanism)', async () => {
    await writeProjectFile('output/research.md', '# Research\n');
    await writeProjectFile('output/summary.md', '# Summary\n');

    const research = await fx.artifactStore.register(
      fx.senderId,
      createArtifactRecord({
        agentId: fx.senderId,
        taskId: 'task-research-1',
        filePath: 'output/research.md',
        fileName: 'Research',
        type: 'document',
        description: 'Background research',
        week: '2026-W17',
      }),
    );
    const summary = await fx.artifactStore.register(
      fx.senderId,
      createArtifactRecord({
        agentId: fx.senderId,
        taskId: 'task-summary-1',
        filePath: 'output/summary.md',
        fileName: 'Summary',
        type: 'report',
        description: 'Executive summary',
        week: '2026-W17',
      }),
    );

    await sendNotification(
      {
        senderSlug: fx.senderId,
        title: 'Research draft ready',
        body: 'Background research complete.',
        options: {
          link: research.filePath,
          sourceTaskId: research.taskId,
          metadata: { artifactId: research.id },
        },
      },
      { agentStore: fx.agentStore, notificationStore: fx.notificationStore },
    );
    await sendNotification(
      {
        senderSlug: fx.senderId,
        title: 'Summary ready',
        body: 'Executive summary complete.',
        options: {
          link: summary.filePath,
          sourceTaskId: summary.taskId,
          metadata: { artifactId: summary.id },
        },
      },
      { agentStore: fx.agentStore, notificationStore: fx.notificationStore },
    );

    const feed = await fx.notificationStore.load(fx.senderId);
    assert.equal(feed.length, 2, 'each deliverable produces one notify-send');
    const titles = feed.map((n) => n.title).sort();
    assert.deepEqual(titles, ['Research draft ready', 'Summary ready']);
  });

  it('hand-off notifications dedup the same way other notify-sends do (storage layer is shared)', async () => {
    // Re-emitting the same hand-off (same dedupKey) while the previous one
    // is still unread is a no-op — proves the hand-off path goes through
    // the same idempotency pipeline as agent-authored notifications and
    // system events. There is no parallel storage path to maintain.
    const dedupKey = `handoff:task-loop-1:artifact-stable`;
    const first = await sendNotification(
      {
        senderSlug: fx.senderId,
        title: 'Loop output v1',
        body: 'First emit.',
        options: {
          link: 'output/loop.md',
          sourceTaskId: 'task-loop-1',
          dedupKey,
          metadata: { artifactId: 'artifact-stable' },
        },
      },
      { agentStore: fx.agentStore, notificationStore: fx.notificationStore },
    );

    await sendNotification(
      {
        senderSlug: fx.senderId,
        title: 'Loop output v2',
        body: 'Second emit (should be suppressed).',
        options: {
          link: 'output/loop.md',
          sourceTaskId: 'task-loop-1',
          dedupKey,
          metadata: { artifactId: 'artifact-stable' },
        },
      },
      { agentStore: fx.agentStore, notificationStore: fx.notificationStore },
    );

    // Per `NotificationStore.append` contract, the suppressed second send
    // is observed in the FEED (length still 1, original payload retained)
    // — the in-memory return value of the second call is a fresh object
    // built by `createNotification` and is not relevant here.
    const feed = await fx.notificationStore.load(fx.senderId);
    assert.equal(feed.length, 1, 'dedup collision must not append a second entry');
    assert.equal(feed[0]?.id, first.id, 'on-disk record stays the original');
    assert.equal(feed[0]?.body, 'First emit.', 'original payload retained');
  });
});

// ---------------------------------------------------------------------------
// AC 15 — dispatcher contract: NO separate hand-off mechanism
// ---------------------------------------------------------------------------

describe('AC 15: dispatcher exposes only `notify` for agent-initiated user-facing writes', () => {
  it('there is no separate hand-off / deliverable / ship module on the registry', () => {
    const modules = listModules();
    // Anything that smells like a parallel hand-off CLI surface is forbidden
    // for v1. If a future feature needs one, the right move is to extend
    // `notify` (extra metadata fields, action buttons via the schema's
    // forward-compat `metadata` bag) rather than fork the surface.
    const forbidden = [
      'handoff',
      'hand-off',
      'deliverable',
      'deliverables',
      'deliver',
      'ship',
      'shipping',
      'shipped',
      'announce',
      'broadcast',
    ];
    for (const name of forbidden) {
      assert.equal(
        modules.includes(name),
        false,
        `dispatcher must not expose a "${name}" module — deliverable hand-offs flow through "notify"`,
      );
    }
  });

  it('`notify` is the canonical agent → user write surface', () => {
    assert.ok(REGISTRY.notify, 'notify module must be registered');
    assert.equal(typeof REGISTRY.notify.send, 'function', 'notify.send must be a function');
    // The skill exposes exactly the trio of `send`, pre-flight `validateSendParams`,
    // and the human-readable `formatNotificationResult`. New hand-off-shaped
    // capabilities should extend this trio (or piggyback on metadata) — they
    // must not introduce a sibling "hand-off" function on a different module.
    const exposed = Object.keys(REGISTRY.notify).sort();
    assert.deepEqual(exposed, ['formatNotificationResult', 'send', 'validateSendParams']);
  });

  it('`delegate-task` is inter-agent (not agent → user), so it is NOT a competing hand-off mechanism', () => {
    // delegate-task lands a message in another agent's inbox. It does not
    // surface anything in the user-facing notifications feed. Pinned here
    // so a future reviewer knows the two surfaces are intentionally
    // distinct: agent → agent vs. agent → user.
    assert.ok(REGISTRY['delegate-task'], 'delegate-task must remain registered');
    assert.equal(
      typeof REGISTRY['delegate-task'].delegateTask,
      'function',
      'delegate-task.delegateTask is the inter-agent surface',
    );
    // delegate-task does not (and must not) write to the notifications feed.
    // The dispatcher entry stays focused on inbox-message creation.
    const exposed = Object.keys(REGISTRY['delegate-task']).sort();
    assert.deepEqual(exposed, ['delegateTask', 'formatDelegationResult']);
  });
});
