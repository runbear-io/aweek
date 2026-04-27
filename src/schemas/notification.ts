/**
 * Typed wrapper for the notification JSON Schema.
 *
 * The runtime AJV schema definitions live in the sibling
 * `notification.schema.js` file (kept as raw `.js` to match the rest of
 * `src/schemas/*.schema.js` and AJV's preferred plain-object-literal
 * authoring path; the existing `notification.schema.js` wiring through
 * `validator.js` MUST be preserved). This module is the typed companion:
 *
 *   1. Re-exports the runtime schema constants so TypeScript callers
 *      can lean on a single typed import boundary
 *      (`from './notification.js'`) instead of reaching directly into
 *      the raw `.js` schema definition file.
 *
 *   2. Defines the canonical TypeScript types that mirror the runtime
 *      schema's `link` field — most notably the `NotificationLink`
 *      polymorphic union (string | object), which the JS schema models
 *      via `oneOf`. TS consumers must narrow before reading nested
 *      fields:
 *
 *        if (typeof n.link === 'string') open(n.link);
 *        else if (n.link) open(n.link.href);
 *
 *   3. Re-exports the convenience validators (`validateNotification`,
 *      `validateNotificationFeed`, `validateNotificationLink`) so
 *      dispatch / skill / dashboard code can validate payloads without
 *      importing the AJV plumbing directly.
 *
 * Naming convention
 * -----------------
 * This file mirrors the `agent.ts` ↔ `agent.schema.ts` split documented
 * in CLAUDE.md, but inverted because the schema-of-record stays as
 * `.js` (to keep AJV registration intact). For notification:
 *
 *   notification.schema.js   → raw runtime schema (AJV $id-keyed)
 *   notification.ts          → typed companion (this file)
 *
 * The two coexist without a basename collision: `.js` and `.ts` here
 * have different stems (`notification.schema.*` vs `notification.*`)
 * so NodeNext module resolution never has to disambiguate them.
 *
 * The `Notification`, `NotificationSource`, and `NotificationSystemEvent`
 * runtime-shape types continue to live in `src/storage/notification-store.ts`
 * per the AC 17 decoupling — that file is the canonical surface for the
 * full notification record, while this module owns the typed link union
 * introduced by AC 1 sub-AC 1.
 */

// ---------------------------------------------------------------------------
// Re-exports from the runtime schema definition file.
// ---------------------------------------------------------------------------

export {
  NOTIFICATION_SOURCES,
  NOTIFICATION_SYSTEM_EVENTS,
  notificationLinkSchema,
  notificationSchema,
  notificationFeedSchema,
} from './notification.schema.js';

// ---------------------------------------------------------------------------
// Re-exports of the convenience validators that consume the AJV registry.
// These are the typed entry points downstream code should reach for; the
// schema constants above are exposed for tooling / introspection only.
// ---------------------------------------------------------------------------

export {
  validateNotification,
  validateNotificationFeed,
  validateNotificationLink,
} from './validator.js';

// ---------------------------------------------------------------------------
// Typed link union — mirrors the `oneOf` body of `notificationLinkSchema`.
// ---------------------------------------------------------------------------

/**
 * Structured link branch — used when a notification needs richer link
 * metadata than a bare URL provides.
 *
 * `additionalProperties: true` on the runtime schema lets future ACs add
 * fields (`target`, `tracking`, `iconHref`, …) without a breaking schema
 * revision; this interface mirrors that intent via the index signature.
 * Required vs. optional matches the `oneOf` object branch in
 * `notificationLinkSchema` exactly.
 */
export interface NotificationLinkObject {
  /** Required URL or in-app path the link points to. */
  href: string;
  /**
   * Optional human-friendly label rendered in place of the bare href.
   * The dashboard falls back to `href` when this is omitted.
   */
  label?: string;
  /**
   * Optional routing hint — true means external (open in new tab),
   * false means an in-app SPA route handled by the React router.
   * Omitted when the agent does not care or the dashboard infers
   * the value heuristically from the href.
   */
  external?: boolean;
  /** Forward-compatible extension slot — see schema docstring. */
  [key: string]: unknown;
}

/**
 * Polymorphic link payload — bare URL string OR structured object.
 *
 * Mirrors the `oneOf` union expressed by `notificationLinkSchema` in
 * the sibling `.js` file. Consumers MUST narrow before reading nested
 * fields:
 *
 * ```ts
 * if (typeof notification.link === 'string') {
 *   open(notification.link);
 * } else if (notification.link) {
 *   open(notification.link.href);
 * }
 * ```
 */
export type NotificationLink = string | NotificationLinkObject;
