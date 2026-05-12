/**
 * Slack push channel for agent → CEO notifications.
 *
 * Implements {@link NotificationDeliveryChannel} so any {@link NotificationStore}
 * that subscribes an instance of this channel fan-outs every freshly persisted
 * notification to a Slack channel/DM via `chat.postMessage`. The channel is a
 * thin wrapper around `fetch` against `https://slack.com/api/chat.postMessage`
 * — no `@slack/web-api` dependency, so it survives the same env Node 20 LTS
 * baseline the rest of aweek targets and stays available in short-lived
 * `aweek exec` CLI processes (which spawn out of the heartbeat and have no
 * connection to the long-running `aweek serve` Slack adapter).
 *
 * The Slack adapter inside `aweek serve` is INBOUND-only (Socket Mode WebSocket
 * draining DMs / mentions). For OUTBOUND-initiated notifications we need a
 * separate Web-API call, which is what this module owns.
 *
 * Process-locality contract:
 *
 *   `NotificationStore.subscribe()` is process-local — the heartbeat spawns
 *   `claude --print` which spawns `aweek exec report send` as a grand-child
 *   process, and THAT process is the one that persists the notification and
 *   fires the fan-out. So this channel attaches inside the SAME process that
 *   writes the notification (see `src/skills/report.ts`'s store factory). The
 *   long-running `aweek serve` does NOT need to subscribe — its only role
 *   is rendering the on-disk feed back to the dashboard.
 *
 * Formatting:
 *
 *   The channel renders one message per notification using a small Block Kit
 *   payload — a header line carrying the severity icon + title, a section
 *   block with the body, and a context block with the sender slug and any
 *   link / sourceTaskId metadata. This keeps the Slack output readable on
 *   mobile and survives the 3000-char-per-block limit (body is truncated
 *   with a tail ellipsis if longer).
 */

import type {
  Notification,
  NotificationDeliveryChannel,
  NotificationSeverity,
} from '../../storage/notification-store.js';

/** Slack Web API endpoint for posting messages. */
const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';

/** Per-block Slack text limit. We hard-truncate body sections to stay under it. */
const SLACK_BLOCK_TEXT_LIMIT = 2900;

/** Severity → emoji mapping for the Slack header. Keep aligned with the dashboard. */
const SEVERITY_EMOJI: Record<NotificationSeverity, string> = {
  info: ':information_source:',
  warning: ':warning:',
  error: ':rotating_light:',
};

/** Constructor options for {@link SlackNotificationDelivery}. */
export interface SlackNotificationDeliveryOptions {
  /** Slack bot token (`xoxb-…`). Required — without it the channel refuses to construct. */
  botToken: string;
  /**
   * Slack target — channel ID (`C…`, `G…`), user ID (`U…`), or DM ID (`D…`).
   * `chat.postMessage` accepts all three.
   */
  ceoChannel: string;
  /**
   * Test seam — replaces the global `fetch`. Defaults to Node 20's built-in
   * global `fetch`. Tests pin a stub that records the request body without
   * hitting slack.com.
   */
  fetchFn?: typeof fetch;
  /**
   * Test seam — replaces the stderr logger used for the soft "Slack reply
   * was not ok" warning. Defaults to `process.stderr.write`. Tests pin a
   * sink array so they can assert on the warning text.
   */
  log?: (message: string) => void;
}

/** Default stderr sink — one `\n`-terminated line per warning. */
function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * `NotificationDeliveryChannel` that posts to Slack via `chat.postMessage`.
 *
 * The `deliver()` call is async fire-and-forget from `NotificationStore`'s
 * perspective — the store's `_fanout()` does NOT await the promise, so a
 * slow or failing Slack call never blocks notification persistence. Errors
 * propagate to the optional `onChannelError` sink on the host store.
 */
export class SlackNotificationDelivery implements NotificationDeliveryChannel {
  readonly name = 'slack';

  private readonly _botToken: string;
  private readonly _ceoChannel: string;
  private readonly _fetch: typeof fetch;
  private readonly _log: (message: string) => void;

  constructor(opts: SlackNotificationDeliveryOptions) {
    if (!opts || typeof opts.botToken !== 'string' || opts.botToken.trim() === '') {
      throw new TypeError('SlackNotificationDelivery: botToken is required');
    }
    if (typeof opts.ceoChannel !== 'string' || opts.ceoChannel.trim() === '') {
      throw new TypeError('SlackNotificationDelivery: ceoChannel is required');
    }
    this._botToken = opts.botToken.trim();
    this._ceoChannel = opts.ceoChannel.trim();
    this._fetch = opts.fetchFn ?? fetch;
    this._log = opts.log ?? defaultLog;
  }

  /** Slack target the channel posts to. Exposed for diagnostics / tests. */
  get ceoChannel(): string {
    return this._ceoChannel;
  }

  async deliver(notification: Notification, agentId: string): Promise<void> {
    const body = buildSlackMessage(notification, agentId, this._ceoChannel);
    const response = await this._fetch(SLACK_POST_MESSAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${this._botToken}`,
      },
      body: JSON.stringify(body),
    });

    // `chat.postMessage` always returns 200 — failures surface as
    // `{ ok: false, error: '<code>' }` in the JSON body, NOT as an HTTP
    // status code. Parse the body and surface a friendly warning so the
    // user sees the actual Slack error code (e.g. `channel_not_found`,
    // `invalid_auth`, `not_in_channel`).
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // Slack returned non-JSON — possible during partial outages. Throw
      // so NotificationStore's error sink surfaces it.
      throw new Error(
        `Slack chat.postMessage returned non-JSON response (HTTP ${response.status})`,
      );
    }

    if (!isSlackOkResponse(payload)) {
      const errCode =
        payload && typeof (payload as { error?: unknown }).error === 'string'
          ? (payload as { error: string }).error
          : 'unknown_error';
      const message =
        `Slack notification delivery failed (channel=${this._ceoChannel}, ` +
        `agent=${agentId}, notif=${notification.id}): ${errCode}`;
      this._log(`aweek: ${message}`);
      throw new Error(message);
    }
  }
}

/**
 * Build the Slack `chat.postMessage` request body for a notification.
 *
 * Exported (rather than a private method) so tests can assert on the block
 * layout without spinning up a delivery instance, and so the dashboard could
 * theoretically reuse the same renderer in the future.
 */
export function buildSlackMessage(
  notification: Notification,
  agentId: string,
  channel: string,
): {
  channel: string;
  text: string;
  blocks: ReadonlyArray<Record<string, unknown>>;
} {
  const severity: NotificationSeverity = notification.severity ?? 'info';
  const emoji = SEVERITY_EMOJI[severity] ?? SEVERITY_EMOJI.info;
  const kind = readKind(notification);

  // Slack fallback text — shown in OS push notifications and in clients
  // that can't render Block Kit. Mirrors the title + body so a notification
  // is intelligible even without rendering blocks.
  const fallbackText = `${emoji} ${notification.title} — from ${agentId}`;

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        // `plain_text` only goes up to 150 chars per the Slack docs.
        text: truncate(`${emoji} ${notification.title}`, 150),
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncate(notification.body, SLACK_BLOCK_TEXT_LIMIT),
      },
    },
  ];

  // Optional context line: who sent it, what kind of report, optional link
  // and source-task traceability. Surfaced as a single `context` block with
  // a `mrkdwn` element so links render natively.
  const contextParts: string[] = [];
  const kindLabel = formatKindLabel(kind);
  if (kindLabel) contextParts.push(`*${kindLabel}*`);
  contextParts.push(`from \`${agentId}\``);
  const linkText = extractLink(notification);
  if (linkText) contextParts.push(linkText);
  if (notification.sourceTaskId) {
    contextParts.push(`task \`${notification.sourceTaskId}\``);
  }
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: contextParts.join(' · '),
      },
    ],
  });

  return {
    channel,
    text: fallbackText,
    blocks,
  };
}

/** Read the `kind` discriminator off the notification metadata if present. */
function readKind(notification: Notification): string | undefined {
  const meta = notification.metadata;
  if (!meta || typeof meta !== 'object') return undefined;
  const kind = (meta as Record<string, unknown>).kind;
  return typeof kind === 'string' && kind.trim().length > 0 ? kind : undefined;
}

/** Translate the `kind` metadata into a human-readable label for the Slack context line. */
function formatKindLabel(kind: string | undefined): string | undefined {
  if (!kind) return undefined;
  switch (kind) {
    case 'report':
      return 'Report';
    case 'question':
      return 'Question';
    default:
      // Pass through unknown kinds capitalised so future extensions surface
      // without a code change here.
      return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
}

/** Extract a renderable Slack-mrkdwn link from the notification's polymorphic `link`. */
function extractLink(notification: Notification): string | undefined {
  const link = notification.link;
  if (link === undefined) return undefined;
  if (typeof link === 'string') {
    return `<${link}|open>`;
  }
  const href = (link as { href?: unknown }).href;
  const label = (link as { label?: unknown }).label;
  if (typeof href !== 'string' || href.length === 0) return undefined;
  const linkLabel = typeof label === 'string' && label.length > 0 ? label : 'open';
  return `<${href}|${linkLabel}>`;
}

/** Truncate a string to `max` characters, suffixing with `…` when shortened. */
function truncate(text: string, max: number): string {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Narrow an unknown Slack response payload to the success shape. */
function isSlackOkResponse(payload: unknown): payload is { ok: true } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { ok?: unknown }).ok === true
  );
}
