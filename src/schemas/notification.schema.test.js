/**
 * Tests for the notification JSON Schema — focused on the AC 1 sub-AC 1
 * contract: title (required string), body (required string), link
 * (optional string-or-object), validated through AJV via the registered
 * `validateNotification` / `validateNotificationLink` entry points.
 *
 * The link union is the focal extension introduced by this AC. AJV's
 * `oneOf` rejects values that satisfy both branches (impossible at
 * runtime — a primitive cannot be an object) and rejects values that
 * satisfy neither (e.g., a number, null, or an object missing `href`),
 * so the test suite below pins exactly those edge cases.
 *
 * The full notification record (id / agentId / source / createdAt /
 * read) is exercised end-to-end through `validateNotification` so the
 * test confirms that `$ref: 'aweek://schemas/notification-link'` from
 * the parent schema resolves correctly and that adding a link does not
 * regress any of the previously-locked-in validations.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_SOURCES,
  NOTIFICATION_SYSTEM_EVENTS,
  notificationLinkSchema,
  notificationSchema,
  notificationFeedSchema,
} from './notification.schema.js';
import {
  validate,
  validateNotification,
  validateNotificationFeed,
  validateNotificationLink,
} from './validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fully-valid notification, optionally overriding fields. */
function makeNotification(overrides = {}) {
  return {
    id: 'notif-deadbeef',
    agentId: 'researcher',
    source: 'agent',
    title: 'Hello',
    body: 'World',
    createdAt: '2026-04-27T12:00:00.000Z',
    read: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('notification schema — constants', () => {
  it('NOTIFICATION_SOURCES contains expected values', () => {
    assert.deepStrictEqual(NOTIFICATION_SOURCES, ['agent', 'system']);
  });

  it('NOTIFICATION_SYSTEM_EVENTS contains the canonical events', () => {
    assert.deepStrictEqual(NOTIFICATION_SYSTEM_EVENTS, [
      'budget-exhausted',
      'repeated-task-failure',
      'plan-ready',
      'task-warnings',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Schema $id wiring
// ---------------------------------------------------------------------------

describe('notification schema — $id wiring', () => {
  it('notificationSchema has the canonical $id', () => {
    assert.equal(notificationSchema.$id, 'aweek://schemas/notification');
  });

  it('notificationFeedSchema has the canonical $id', () => {
    assert.equal(notificationFeedSchema.$id, 'aweek://schemas/notification-feed');
  });

  it('notificationLinkSchema has the canonical $id', () => {
    assert.equal(notificationLinkSchema.$id, 'aweek://schemas/notification-link');
  });

  it('the parent schema references the link sub-schema via $ref', () => {
    const linkProp = notificationSchema.properties.link;
    assert.ok(linkProp, 'notificationSchema.properties.link must exist');
    assert.equal(linkProp.$ref, 'aweek://schemas/notification-link');
  });
});

// ---------------------------------------------------------------------------
// title / body required-string contract
// ---------------------------------------------------------------------------

describe('notification schema — title required string', () => {
  it('accepts a non-empty title', () => {
    const result = validateNotification(makeNotification({ title: 'Looks good' }));
    assert.equal(result.valid, true);
  });

  it('rejects a missing title', () => {
    const bad = makeNotification();
    delete bad.title;
    const result = validateNotification(bad);
    assert.equal(result.valid, false);
  });

  it('rejects a non-string title', () => {
    const result = validateNotification(makeNotification({ title: 42 }));
    assert.equal(result.valid, false);
  });

  it('rejects an empty title', () => {
    const result = validateNotification(makeNotification({ title: '' }));
    assert.equal(result.valid, false);
  });
});

describe('notification schema — body required string', () => {
  it('accepts a non-empty body', () => {
    const result = validateNotification(makeNotification({ body: 'detail' }));
    assert.equal(result.valid, true);
  });

  it('rejects a missing body', () => {
    const bad = makeNotification();
    delete bad.body;
    const result = validateNotification(bad);
    assert.equal(result.valid, false);
  });

  it('rejects a non-string body', () => {
    const result = validateNotification(makeNotification({ body: { text: 'x' } }));
    assert.equal(result.valid, false);
  });

  it('rejects an empty body', () => {
    const result = validateNotification(makeNotification({ body: '' }));
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Link union (the focal AC 1 sub-AC 1 contract)
// ---------------------------------------------------------------------------

describe('notification schema — link is optional', () => {
  it('passes when link is omitted entirely', () => {
    const n = makeNotification();
    assert.equal('link' in n, false);
    const result = validateNotification(n);
    assert.equal(result.valid, true);
  });
});

describe('notification schema — link string branch', () => {
  it('accepts a bare URL string', () => {
    const result = validateNotification(
      makeNotification({ link: 'https://example.com/path' }),
    );
    assert.equal(result.valid, true);
  });

  it('accepts a relative in-app path string', () => {
    const result = validateNotification(
      makeNotification({ link: '/agents/researcher' }),
    );
    assert.equal(result.valid, true);
  });

  it('rejects an empty string (minLength: 1)', () => {
    const result = validateNotification(makeNotification({ link: '' }));
    assert.equal(result.valid, false);
  });

  it('rejects a string longer than 2000 characters', () => {
    const tooLong = 'h'.repeat(2001);
    const result = validateNotification(makeNotification({ link: tooLong }));
    assert.equal(result.valid, false);
  });
});

describe('notification schema — link object branch', () => {
  it('accepts {href} only', () => {
    const result = validateNotification(
      makeNotification({ link: { href: 'https://example.com' } }),
    );
    assert.equal(result.valid, true);
  });

  it('accepts {href, label}', () => {
    const result = validateNotification(
      makeNotification({
        link: { href: 'https://example.com', label: 'Docs' },
      }),
    );
    assert.equal(result.valid, true);
  });

  it('accepts {href, label, external}', () => {
    const result = validateNotification(
      makeNotification({
        link: {
          href: 'https://example.com',
          label: 'Docs',
          external: true,
        },
      }),
    );
    assert.equal(result.valid, true);
  });

  it('accepts forward-compatible extra fields on the object branch', () => {
    // additionalProperties: true on the object branch lets future ACs add
    // fields without a breaking schema migration.
    const result = validateNotification(
      makeNotification({
        link: {
          href: 'https://example.com',
          tracking: 'utm_source=aweek',
          target: '_blank',
        },
      }),
    );
    assert.equal(result.valid, true);
  });

  it('rejects an object missing href', () => {
    const result = validateNotification(
      makeNotification({ link: { label: 'Docs' } }),
    );
    assert.equal(result.valid, false);
  });

  it('rejects an object with an empty href', () => {
    const result = validateNotification(
      makeNotification({ link: { href: '' } }),
    );
    assert.equal(result.valid, false);
  });

  it('rejects an object with a non-string href', () => {
    const result = validateNotification(
      makeNotification({ link: { href: 42 } }),
    );
    assert.equal(result.valid, false);
  });

  it('rejects an object with non-boolean external', () => {
    const result = validateNotification(
      makeNotification({
        link: { href: 'https://example.com', external: 'yes' },
      }),
    );
    assert.equal(result.valid, false);
  });
});

describe('notification schema — link union rejects neither-branch values', () => {
  it('rejects null', () => {
    const result = validateNotification(makeNotification({ link: null }));
    assert.equal(result.valid, false);
  });

  it('rejects a number', () => {
    const result = validateNotification(makeNotification({ link: 42 }));
    assert.equal(result.valid, false);
  });

  it('rejects an array', () => {
    const result = validateNotification(
      makeNotification({ link: ['https://example.com'] }),
    );
    assert.equal(result.valid, false);
  });

  it('rejects a boolean', () => {
    const result = validateNotification(makeNotification({ link: true }));
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Standalone notificationLinkSchema validator
// ---------------------------------------------------------------------------

describe('notification schema — standalone link validator', () => {
  it('validateNotificationLink accepts a string', () => {
    const result = validateNotificationLink('https://example.com');
    assert.equal(result.valid, true);
  });

  it('validateNotificationLink accepts an object with href', () => {
    const result = validateNotificationLink({ href: 'https://example.com' });
    assert.equal(result.valid, true);
  });

  it('validateNotificationLink rejects an empty string', () => {
    const result = validateNotificationLink('');
    assert.equal(result.valid, false);
  });

  it('validateNotificationLink rejects an object missing href', () => {
    const result = validateNotificationLink({ label: 'Docs' });
    assert.equal(result.valid, false);
  });

  it('validateNotificationLink rejects null', () => {
    const result = validateNotificationLink(null);
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Feed schema regression — confirms the link union didn't break feed validation
// ---------------------------------------------------------------------------

describe('notification schema — feed regression', () => {
  it('accepts a feed of mixed link shapes', () => {
    const feed = [
      makeNotification({ id: 'notif-aaaaaaaa' }),
      makeNotification({ id: 'notif-bbbbbbbb', link: 'https://example.com' }),
      makeNotification({
        id: 'notif-cccccccc',
        link: { href: 'https://example.com', label: 'Docs' },
      }),
    ];
    const result = validateNotificationFeed(feed);
    assert.equal(result.valid, true);
  });

  it('still validates an empty feed', () => {
    const result = validateNotificationFeed([]);
    assert.equal(result.valid, true);
  });

  it('rejects a feed entry with a malformed link', () => {
    const feed = [
      makeNotification({ id: 'notif-aaaaaaaa' }),
      makeNotification({ id: 'notif-bbbbbbbb', link: 42 }),
    ];
    const result = validateNotificationFeed(feed);
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Generic validator dispatch (mirrors how callers reach the schema by id)
// ---------------------------------------------------------------------------

describe('notification schema — registered $id-based dispatch', () => {
  it('validate(aweek://schemas/notification, ...) routes to the right schema', () => {
    const result = validate(
      'aweek://schemas/notification',
      makeNotification({ link: 'https://example.com' }),
    );
    assert.equal(result.valid, true);
  });

  it('validate(aweek://schemas/notification-link, ...) routes to the right schema', () => {
    const result = validate(
      'aweek://schemas/notification-link',
      'https://example.com',
    );
    assert.equal(result.valid, true);
  });
});
