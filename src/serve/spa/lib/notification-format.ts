/**
 * Shared formatters for notification UI surfaces.
 *
 * Lifted out of `components/notification-bell.tsx` so the standalone
 * {@link import('../components/notification-list').NotificationList}
 * (Sub-AC 4 of AC 8) and the bell drawer can render identical relative
 * timestamps without duplicating the rounding contract. The bell
 * continues to re-export `formatRelativeTime` for backwards compat with
 * its existing test suite.
 *
 * Architectural decoupling note (AC 17):
 *   These formatters are pure presentational helpers — they never touch
 *   the storage layer, never reach into `NotificationStore`, and have
 *   no I/O dependencies. They sit in `lib/` so future external push
 *   channels (Slack / email / OS push) can also reuse the same wording
 *   if they ever render a dashboard summary.
 *
 * @module serve/spa/lib/notification-format
 */

/**
 * Format an ISO timestamp as a compact relative-time label
 * (e.g. `"3m"`, `"2h"`, `"5d"`). Falls back to the raw ISO string when
 * the input is unparseable so the row at least stays dateTime-aware.
 *
 * Buckets:
 *   - `< 45s`   → `"just now"`
 *   - `< 60m`   → `"<n>m"`
 *   - `< 24h`   → `"<n>h"`
 *   - `< 7d`    → `"<n>d"`
 *   - `< 5w`    → `"<n>w"`
 *   - `< 12mo`  → `"<n>mo"`
 *   - else      → `"<n>y"`
 *
 * Future-dated timestamps (negative deltas) collapse to `"just now"` so
 * a clock skew between the agent host and the dashboard host can't
 * surface a confusing "in 3m" row.
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  if (typeof iso !== 'string' || iso.length === 0) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const diffMs = now.getTime() - ts;
  if (diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}
