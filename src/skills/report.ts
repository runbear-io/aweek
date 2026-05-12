/**
 * Agent → CEO report skill.
 *
 * Canonical surface for an agent to "report" or "ask" the user (CEO) during
 * a heartbeat session. Semantically narrower than the generic `notify` skill:
 *
 *   - The `kind` discriminator (`'report' | 'question'`) is required so the
 *     Slack-side renderer can label the message correctly (Report vs.
 *     Question) and the dashboard can group on intent.
 *   - Every emitted notification carries `metadata.kind` AND
 *     `metadata.channel: 'ceo-report'` — the `channel` tag is a stable
 *     handle future filters (dashboard inbox tabs, Slack routing rules)
 *     can key off without having to inspect text.
 *   - When the project's Slack config provides both `botToken` and
 *     `ceoChannel`, this skill attaches a `SlackNotificationDelivery`
 *     channel to the per-call `NotificationStore` BEFORE the
 *     {@link notify.sendNotification} call fires `append()`. The
 *     `NotificationStore` fan-out then push-delivers the report to Slack
 *     IN-PROCESS — which is the only delivery model that survives the
 *     `aweek exec report send` grandchild-process lifecycle (the
 *     long-running `aweek serve` does NOT see the write and cannot push
 *     on the agent's behalf — see the contract comment in
 *     `src/channels/slack/notification-delivery.ts`).
 *
 * v1 contract:
 *
 *   - `senderSlug`: required, mirrors the {@link notify.sendNotification}
 *     contract — the dispatcher passes the calling agent's slug from
 *     runtime context.
 *   - `kind`: required, must be `'report' | 'question'`. The skill does
 *     NOT default to `'report'` so a typo in the CLI invocation surfaces
 *     loudly instead of silently mislabelling a question as a report.
 *   - `title`: required, ≤ 200 chars (matches notification schema).
 *   - `body`: required, ≤ 5000 chars (matches notification schema).
 *   - `severity`: optional (`'info' | 'warning' | 'error'`); defaults to
 *     `'info'`. Mirrored into the notification + the Slack header emoji.
 *     Matches the canonical `NotificationSeverity` enum in
 *     `src/schemas/notification.schema.js` — keep aligned so AJV doesn't
 *     reject the on-disk write.
 *   - `link`, `sourceTaskId`, `metadata`: optional, forwarded as-is. The
 *     skill adds `kind` and `channel: 'ceo-report'` to whatever metadata
 *     the caller provides — caller-supplied keys win on conflict.
 *
 * Return shape: `{ notification, deliveredToSlack }`. The boolean is true
 * iff a Slack channel was successfully attached AND the per-call store
 * fan-out fired (it doesn't await delivery, but it does fire it). Used by
 * the CLI to phrase the success line accurately.
 */

import { resolve } from 'node:path';

import { AgentStore } from '../storage/agent-store.js';
import {
  NotificationStore,
  type Notification,
  type NotificationDeliveryChannel,
  type NotificationSeverity,
  type NotificationLink,
} from '../storage/notification-store.js';
import {
  loadSlackCredentials,
  type SlackCredentials,
  type SlackEnvSource,
} from '../storage/slack-config-store.js';
import { SlackNotificationDelivery } from '../channels/slack/notification-delivery.js';
import {
  saveReportThread,
  type SaveReportThreadOptions,
  type SlackReportThreadRecord,
} from '../storage/slack-report-thread-store.js';

/**
 * agentchannels `SlackAdapter.name`. Used to construct the `threadKey`
 * the inbound listener will emit on replies — keep aligned with the
 * adapter so the bridge can rehydrate the report-thread record by the
 * SAME key the bot sees on inbound traffic.
 */
const SLACK_ADAPTER_NAME = 'slack';

/** Valid report kind discriminators. */
export const REPORT_KINDS = ['report', 'question'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Free-form parameters accepted by {@link reportToCeo}. */
export interface ReportToCeoParams {
  /** Calling agent's slug — passed through by the CLI dispatcher. */
  senderSlug?: string;
  /** Discriminator: is this a status update or an open question? */
  kind?: string;
  /** Free-form short title. */
  title?: string;
  /** Free-form longer body. */
  body?: string;
  /** Optional visual severity hint. Defaults to `'info'`. */
  severity?: string;
  /** Optional polymorphic link. */
  link?: NotificationLink;
  /** Optional traceability link to the originating weekly task. */
  sourceTaskId?: string;
  /** Free-form metadata bag — caller keys win over `kind`/`channel` injects. */
  metadata?: Record<string, unknown>;
  /**
   * Override `.aweek/agents` data-dir root. Defaults to `.aweek/agents`
   * relative to the cwd (matches the {@link notify.sendNotification}
   * convention). Tests pin a temp dir.
   */
  dataDir?: string;
  /**
   * Test/replay-only override: set the notification's `createdAt` so the
   * persisted shape is deterministic across reruns. Production callers
   * leave this unset.
   */
  createdAt?: string;
}

/** Validated/normalised payload returned by {@link validateReportParams}. */
export interface ValidatedReportParams {
  senderSlug: string;
  kind: ReportKind;
  title: string;
  body: string;
  severity: NotificationSeverity;
  link?: NotificationLink;
  sourceTaskId?: string;
  metadata?: Record<string, unknown>;
  dataDir: string;
  createdAt?: string;
}

const VALID_SEVERITIES: readonly NotificationSeverity[] = ['info', 'warning', 'error'];

/**
 * Validate the user-supplied params up front so the CLI surfaces a friendly
 * error before any AgentStore/NotificationStore I/O. Pure function — see
 * {@link notify.validateSendParams} for the analogous shape on the lower
 * level skill.
 */
export function validateReportParams(params: ReportToCeoParams = {}): ValidatedReportParams {
  const {
    senderSlug,
    kind,
    title,
    body,
    severity,
    link,
    sourceTaskId,
    metadata,
    dataDir,
    createdAt,
  } = params;

  if (!senderSlug || typeof senderSlug !== 'string') {
    throw new Error('senderSlug is required and must be a non-empty string');
  }
  if (!kind || typeof kind !== 'string') {
    throw new Error(
      `kind is required and must be one of ${REPORT_KINDS.join(', ')}`,
    );
  }
  if (!REPORT_KINDS.includes(kind as ReportKind)) {
    throw new Error(
      `kind must be one of ${REPORT_KINDS.join(', ')}; got "${kind}"`,
    );
  }
  if (!title || typeof title !== 'string') {
    throw new Error('title is required and must be a non-empty string');
  }
  if (!body || typeof body !== 'string') {
    throw new Error('body is required and must be a non-empty string');
  }

  let resolvedSeverity: NotificationSeverity = 'info';
  if (severity !== undefined) {
    if (
      typeof severity !== 'string' ||
      !VALID_SEVERITIES.includes(severity as NotificationSeverity)
    ) {
      throw new Error(
        `severity must be one of ${VALID_SEVERITIES.join(', ')}; got "${String(severity)}"`,
      );
    }
    resolvedSeverity = severity as NotificationSeverity;
  }

  if (metadata !== undefined) {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      throw new Error('metadata must be a plain object');
    }
  }

  const validated: ValidatedReportParams = {
    senderSlug,
    kind: kind as ReportKind,
    title,
    body,
    severity: resolvedSeverity,
    dataDir: typeof dataDir === 'string' && dataDir.length > 0 ? dataDir : '.aweek/agents',
  };
  if (link !== undefined) validated.link = link;
  if (sourceTaskId !== undefined) validated.sourceTaskId = sourceTaskId;
  if (metadata !== undefined) validated.metadata = metadata;
  if (createdAt !== undefined) validated.createdAt = createdAt;
  return validated;
}

/** Factory shape used to construct a Slack delivery channel — overridable in tests. */
export type SlackDeliveryFactory = (
  creds: SlackCredentials,
) => SlackNotificationDelivery;

/** Optional dependency injection points — production callers leave all unset. */
export interface ReportToCeoDeps {
  agentStore?: AgentStore;
  notificationStore?: NotificationStore;
  slackCredentialsLoader?: (
    dataDir: string,
    envSource?: SlackEnvSource,
  ) => Promise<SlackCredentials | null>;
  slackDeliveryFactory?: SlackDeliveryFactory;
  /** Test-only env-source override forwarded to the credentials loader. */
  slackEnvSource?: SlackEnvSource;
  /**
   * Sink for delivery-channel errors. Defaults to writing a one-line
   * warning to stderr so a misconfigured `ceoChannel` doesn't silently
   * swallow Slack push failures while storage stays green.
   */
  onSlackError?: (err: unknown) => void;
  /**
   * Test seam — overrides the report-thread persistence function the
   * default Slack delivery channel's `onPosted` hook calls. Production
   * callers leave this unset; the skill writes through the canonical
   * {@link saveReportThread} to `.aweek/channels/slack/report-threads/`.
   */
  saveReportThreadFn?: (
    dataDir: string,
    options: SaveReportThreadOptions,
  ) => Promise<SlackReportThreadRecord>;
  /**
   * Test seam — replaces the global `fetch` the default
   * `SlackNotificationDelivery` constructor uses. Lets tests exercise
   * the canonical default-factory path (the one that wires the
   * skill-built `onPosted` closure) without touching slack.com.
   * Production callers leave this unset.
   */
  slackFetchFn?: typeof fetch;
}

/** Result returned by {@link reportToCeo}. */
export interface ReportToCeoResult {
  /** Persisted notification — same shape as {@link notify.sendNotification}'s return. */
  notification: Notification;
  /**
   * Reflects the actual Slack delivery outcome — `true` iff a Slack
   * delivery channel was attached AND its `deliver()` resolved without
   * error (Slack returned `{ ok: true }`). `false` means one of:
   *
   *   - no `ceoChannel` was configured → Slack push was skipped on
   *     purpose, only the dashboard inbox got the write;
   *   - Slack returned `{ ok: false, error }` (e.g. `channel_not_found`,
   *     `not_in_channel`, `invalid_auth`) → the error code surfaces via
   *     the `onSlackError` sink (stderr by default);
   *   - the Slack `fetch()` itself threw before getting a response.
   *
   * The skill awaits the per-call `NotificationStore.drain()` BEFORE
   * returning so the outcome is honest by the time the function
   * resolves — earlier versions of this contract returned `true` the
   * moment a channel was wired (before the POST happened), which lied
   * to short-lived CLI callers whose `process.exit(0)` aborted the
   * in-flight `fetch()`.
   */
  deliveredToSlack: boolean;
  /**
   * True iff the storage write resolved (idempotent re-sends still
   * report `persisted: true` per the underlying contract). Mirrors the
   * existing `notify.sendNotification` semantics so the CLI can compose
   * with both.
   */
  persisted: true;
}

/**
 * Send a CEO report on behalf of an agent. See module docstring for the
 * full contract.
 *
 *   1. Validate the parameters via {@link validateReportParams}.
 *   2. Resolve Slack credentials (env-first, file-fallback via
 *      `loadSlackCredentials`). If both `botToken` AND `ceoChannel` are
 *      present, instantiate a `SlackNotificationDelivery` channel and
 *      subscribe it to the per-call `NotificationStore`. Missing
 *      credentials degrade to dashboard-only delivery (no error).
 *   3. Hand off to {@link notify.sendNotification}, which:
 *      - verifies the sender agent exists,
 *      - auto-populates `id`, `agentId`, `createdAt`, and `read=false`,
 *      - runs the full idempotency / dedupe pipeline, and
 *      - fires the store's fan-out (which now includes the Slack channel
 *        if one was subscribed).
 *   4. Return `{ notification, deliveredToSlack }`.
 */
export async function reportToCeo(
  params: ReportToCeoParams,
  deps: ReportToCeoDeps = {},
): Promise<ReportToCeoResult> {
  const validated = validateReportParams(params);

  const dataDir = resolve(validated.dataDir);
  const agentStore = deps.agentStore || new AgentStore(dataDir);

  // Per-call NotificationStore so the channel subscription doesn't leak
  // across invocations (production callers spawn a fresh process per
  // `aweek exec report send`; tests pin their own stores via deps).
  //
  // The error sink wired into the store is intentionally a no-op — the
  // channel wrapper below is the SOLE place that fans the failure out
  // to `deps.onSlackError` / stderr, so any caller-supplied store
  // (whose own sink we don't control) still gets the right user-facing
  // behaviour without double-firing.
  const notificationStore =
    deps.notificationStore || new NotificationStore(dataDir, { onChannelError: () => undefined });

  // Attach the Slack channel BEFORE the persist call fires the fanout.
  //
  //   slackChannelWired — `true` iff we successfully subscribed a Slack
  //                       channel to the per-call NotificationStore.
  //                       Tracks subscription, not outcome.
  //   slackDeliveryError — set inside the channel wrapper when Slack
  //                        returns `ok: false` or `fetch()` throws.
  //                        Used after `await drain()` to flip the
  //                        public `deliveredToSlack` to `false` so the
  //                        return value reflects the actual delivery
  //                        outcome the user will see in Slack — not
  //                        just "we attempted a POST".
  let slackChannelWired = false;
  let slackDeliveryError: unknown = null;
  const loader = deps.slackCredentialsLoader || loadSlackCredentials;
  const credentials = await loader(dataDir, deps.slackEnvSource);
  if (credentials && credentials.ceoChannel && credentials.botToken) {
    const persistReportThread =
      deps.saveReportThreadFn || saveReportThread;
    // `onPosted` only runs in the default factory path — tests that
    // pass `deps.slackDeliveryFactory` to override the channel
    // construction are responsible for wiring (or not wiring) their
    // own persistence. Captures `validated` + `dataDir` by closure
    // so the persisted record carries the exact report fields the
    // notification was built with.
    const onPosted = async (
      info: { channel: string; ts: string },
      _notification: Notification,
    ): Promise<void> => {
      const options: SaveReportThreadOptions = {
        threadKey: `${SLACK_ADAPTER_NAME}:${info.channel}:${info.ts}`,
        senderSlug: validated.senderSlug,
        kind: validated.kind,
        title: validated.title,
        body: validated.body,
      };
      if (validated.sourceTaskId !== undefined) {
        options.sourceTaskId = validated.sourceTaskId;
      }
      await persistReportThread(dataDir, options);
    };
    const factory: SlackDeliveryFactory =
      deps.slackDeliveryFactory ||
      ((creds) =>
        new SlackNotificationDelivery({
          botToken: creds.botToken,
          ceoChannel: creds.ceoChannel as string,
          onPosted,
          ...(deps.slackFetchFn ? { fetchFn: deps.slackFetchFn } : {}),
        }));
    const rawChannel = factory(credentials);
    // Wrap the channel so we can capture the delivery outcome locally
    // even when the caller passes their own `deps.notificationStore`
    // (whose `onChannelError` sink we don't control). The wrapper
    // re-throws the error so the store's existing fanout-error
    // reporting still fires — this is purely an observation layer.
    const wrappedChannel: NotificationDeliveryChannel = {
      name: rawChannel.name,
      deliver: async (notif, agentId) => {
        try {
          await rawChannel.deliver(notif, agentId);
        } catch (err) {
          // Record locally so the post-drain outcome check can flip
          // `deliveredToSlack` to false. ALSO forward to the user
          // sink (or stderr default) here rather than relying on the
          // store's `onChannelError` — caller-supplied stores would
          // otherwise carry their own sink and ours would never fire.
          slackDeliveryError = err;
          if (deps.onSlackError) {
            try {
              deps.onSlackError(err);
            } catch {
              // A misbehaving caller sink must not poison the
              // wrapper. The store fanout still gets the rethrow.
            }
          } else {
            process.stderr.write(
              `aweek: report Slack delivery failed: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
          throw err;
        }
      },
    };
    notificationStore.subscribe(wrappedChannel);
    slackChannelWired = true;
  }

  // Verify the sender exists so a typo surfaces immediately rather than
  // persisting an orphan notification under a non-existent agent's dir.
  // Mirrors the pre-flight check in notify.sendNotification.
  const senderExists = await agentStore.exists(validated.senderSlug);
  if (!senderExists) {
    throw new Error(`Sender agent not found: ${validated.senderSlug}`);
  }

  // Merge metadata: caller keys win over `kind`/`channel` so future
  // extensions stay open without forcing this skill to know about them.
  const mergedMetadata: Record<string, unknown> = {
    kind: validated.kind,
    channel: 'ceo-report',
    ...(validated.metadata ?? {}),
  };

  // Call NotificationStore.send directly (rather than going through
  // notify.sendNotification) so the report's severity threads through to
  // both the persisted record AND the Slack delivery channel's emoji
  // rendering — notify.sendNotification's options bag doesn't carry
  // severity through to the store.
  const notification = await notificationStore.send(validated.senderSlug, {
    title: validated.title,
    body: validated.body,
    severity: validated.severity,
    metadata: mergedMetadata,
    ...(validated.link !== undefined ? { link: validated.link } : {}),
    ...(validated.sourceTaskId !== undefined
      ? { sourceTaskId: validated.sourceTaskId }
      : {}),
    ...(validated.createdAt !== undefined ? { createdAt: validated.createdAt } : {}),
  });

  // Drain the per-call store's in-flight delivery promises BEFORE we
  // resolve, so a CLI caller's `process.exit(0)` (in `bin/aweek.ts`)
  // can't abort the in-flight `fetch()` to slack.com. Without this,
  // `deliveredToSlack: true` was a lie — it only meant "a Slack
  // channel was subscribed", not "the message landed in Slack".
  //
  // `drain()` is a no-op when no async deliveries are pending (e.g.
  // when no Slack channel was wired, or when tests pin a synchronous
  // fake channel), so this is safe to call unconditionally.
  await notificationStore.drain();

  // `deliveredToSlack` reflects the ACTUAL outcome — `true` iff a
  // Slack channel was wired AND its `deliver()` resolved cleanly
  // (Slack returned `{ ok: true }`). Any Slack-side failure already
  // surfaced through the `onSlackError` sink (stderr by default);
  // we just need to ensure the return value tells the caller the
  // truth so a CLI consumer can decide whether to retry or surface
  // the error to the user.
  const deliveredToSlack = slackChannelWired && slackDeliveryError == null;

  return {
    notification,
    deliveredToSlack,
    persisted: true,
  };
}

/**
 * Format a human-friendly summary of a sent report. Used by the CLI
 * dispatcher so `aweek exec report send` output reads like the existing
 * `notify` / `delegate-task` surfaces.
 */
export function formatReportResult(result: ReportToCeoResult | Notification): string {
  // Accept either shape — the dispatcher already passes raw objects through
  // a permissive unwrapper.
  const notification = isReportResult(result) ? result.notification : result;
  const deliveredToSlack = isReportResult(result) ? result.deliveredToSlack : false;
  const kind = readKindFromMetadata(notification);

  const lines = [
    `Report sent successfully`,
    `  Notification ID: ${notification.id}`,
    `  Agent: ${notification.agentId}`,
    `  Kind: ${kind ?? 'report'}`,
    `  Title: ${notification.title}`,
    `  Body: ${notification.body}`,
  ];
  if (notification.link !== undefined) {
    const linkText =
      typeof notification.link === 'string'
        ? notification.link
        : notification.link.href;
    lines.push(`  Link: ${linkText}`);
  }
  if (notification.sourceTaskId) {
    lines.push(`  Source Task: ${notification.sourceTaskId}`);
  }
  lines.push(
    `  Slack delivery: ${deliveredToSlack ? 'attempted' : 'skipped (no ceoChannel configured)'}`,
  );
  return lines.join('\n');
}

/** Type guard so {@link formatReportResult} can accept either shape. */
function isReportResult(input: unknown): input is ReportToCeoResult {
  return (
    typeof input === 'object' &&
    input !== null &&
    'notification' in input &&
    (input as { notification?: unknown }).notification !== undefined
  );
}

/** Pull the report kind off the persisted metadata bag, if any. */
function readKindFromMetadata(notification: Notification): string | undefined {
  const meta = notification.metadata;
  if (!meta || typeof meta !== 'object') return undefined;
  const kind = (meta as Record<string, unknown>).kind;
  return typeof kind === 'string' && kind.length > 0 ? kind : undefined;
}
