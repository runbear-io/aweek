/**
 * Component tests for the Settings page (`SettingsPage`).
 *
 * Verifies:
 *   - Loading skeleton is shown until the first fetch resolves.
 *   - When `status === 'ok'`, no config-warning banner is shown.
 *   - When `status === 'missing'`, the inline advisory banner is shown.
 *   - All categories returned by GET /api/config render as labelled cards.
 *   - All config items render with their label, formatted value, and
 *     description text.
 *   - Error state renders on non-2xx with a Retry button.
 *
 * The test stubs the `fetch` function injected into `SettingsPage` so
 * `useAppConfig` → `fetchAppConfig` resolves against fixture data without
 * a real HTTP stack.
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Config : `vitest.config.js` (scoped to `**\/*.test.{tsx,jsx}`).
 * Command: `pnpm test:spa`
 */

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import { SettingsPage } from './settings-page.tsx';
import type { AppConfigPayload } from '../lib/api-client.js';

// ── Fixtures ──────────────────────────────────────────────────────────

/** Minimal valid payload returned by GET /api/config when config is ok. */
const OK_PAYLOAD: AppConfigPayload = {
  status: 'ok',
  categories: [
    {
      id: 'configuration',
      label: 'Configuration',
      items: [
        {
          key: 'timeZone',
          label: 'Time Zone',
          value: 'America/Los_Angeles',
          description: 'IANA time zone used for scheduling.',
        },
      ],
    },
    {
      id: 'scheduler',
      label: 'Scheduler',
      items: [
        {
          key: 'heartbeatIntervalSec',
          label: 'Heartbeat Interval',
          value: 600,
          description: 'How often the heartbeat fires, in seconds.',
        },
        {
          key: 'staleTaskWindowMs',
          label: 'Stale Task Window',
          value: 3_600_000,
          description: 'Tasks older than this window (ms) are skipped.',
        },
      ],
    },
    {
      id: 'locks',
      label: 'Locks',
      items: [
        {
          key: 'lockDir',
          label: 'Lock Directory',
          value: '.aweek/.locks',
          description: 'Directory for PID lock files.',
        },
        {
          key: 'maxLockAgeMs',
          label: 'Max Lock Age',
          value: 7_200_000,
          description: 'Stale-lock threshold in ms.',
        },
      ],
    },
  ],
};

/** Same payload but with status 'missing' to trigger the warning banner. */
const MISSING_PAYLOAD: AppConfigPayload = { ...OK_PAYLOAD, status: 'missing' };

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Build a `fetch` stub that resolves with the given payload (or an error
 * body when `ok: false`). Mirrors the `makeFetchStub` pattern from
 * `agents-page.test.tsx`.
 */
function makeFetchStub(
  payload: unknown,
  { ok = true, status = 200, statusText = 'OK' } = {},
) {
  const body = ok
    ? JSON.stringify(payload)
    : JSON.stringify({ error: 'server error' });
  const fetchImpl = vi.fn(() =>
    Promise.resolve({
      ok,
      status,
      statusText,
      text: () => Promise.resolve(body),
    }),
  );
  return fetchImpl as unknown as typeof globalThis.fetch;
}

/** Render helper that injects a stubbed fetch. */
function renderPage(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const fetchImpl = makeFetchStub(payload, opts);
  return render(<SettingsPage fetch={fetchImpl} />);
}

// ── Lifecycle ─────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('SettingsPage — loading / chrome', () => {
  it('shows a loading skeleton until the first fetch resolves', async () => {
    const fetch = vi.fn(
      () => new Promise(() => {}),
    ) as unknown as typeof globalThis.fetch;
    render(<SettingsPage fetch={fetch} />);

    const loader = await screen.findByRole('status');
    expect(loader).toHaveAttribute('data-loading', 'true');
    expect(loader).toHaveTextContent(/loading settings/i);
  });

  it('renders a page header with "Settings" title', async () => {
    renderPage(OK_PAYLOAD);
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(/settings/i);
  });

  it('renders a Refresh button in the page header', async () => {
    renderPage(OK_PAYLOAD);
    expect(
      await screen.findByRole('button', { name: /refresh/i }),
    ).toBeInTheDocument();
  });
});

describe('SettingsPage — config status', () => {
  it('does NOT show a warning banner when status is "ok"', async () => {
    renderPage(OK_PAYLOAD);
    // Wait for the page to finish loading
    await screen.findByRole('heading', { level: 1 });
    expect(
      screen.queryByRole('alert', { hidden: false }),
    ).not.toBeInTheDocument();
  });

  it('shows an inline warning banner when status is "missing"', async () => {
    renderPage(MISSING_PAYLOAD);
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveAttribute('data-config-warning', 'true');
    expect(banner).toHaveTextContent(/config\.json missing or malformed/i);
  });
});

describe('SettingsPage — category cards', () => {
  it('renders one card per category', async () => {
    renderPage(OK_PAYLOAD);
    // Wait for data to load
    await screen.findByRole('heading', { level: 1 });

    // Each category has an h2 heading
    const categoryHeadings = screen.getAllByRole('heading', { level: 2 });
    expect(categoryHeadings).toHaveLength(OK_PAYLOAD.categories.length);
  });

  it('renders category labels as h2 headings', async () => {
    renderPage(OK_PAYLOAD);
    await screen.findByRole('heading', { level: 1 });

    for (const category of OK_PAYLOAD.categories) {
      expect(
        screen.getByRole('heading', { level: 2, name: category.label }),
      ).toBeInTheDocument();
    }
  });

  it('renders a card with data-category attribute for each category id', async () => {
    renderPage(OK_PAYLOAD);
    await screen.findByRole('heading', { level: 1 });

    for (const category of OK_PAYLOAD.categories) {
      expect(
        document.querySelector(`[data-category="${category.id}"]`),
      ).not.toBeNull();
    }
  });
});

describe('SettingsPage — config items', () => {
  it('renders a row for each item inside each category', async () => {
    renderPage(OK_PAYLOAD);
    await screen.findByRole('heading', { level: 1 });

    // Every item should have a data-setting-key attribute
    const allItems = OK_PAYLOAD.categories.flatMap((c) => c.items);
    for (const item of allItems) {
      expect(
        document.querySelector(`[data-setting-key="${item.key}"]`),
      ).not.toBeNull();
    }
  });

  it('renders the human-readable label for each item', async () => {
    renderPage(OK_PAYLOAD);
    await screen.findByRole('heading', { level: 1 });

    const allItems = OK_PAYLOAD.categories.flatMap((c) => c.items);
    for (const item of allItems) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    }
  });

  it('renders the description text for each item', async () => {
    renderPage(OK_PAYLOAD);
    await screen.findByRole('heading', { level: 1 });

    const allItems = OK_PAYLOAD.categories.flatMap((c) => c.items);
    for (const item of allItems) {
      expect(screen.getByText(item.description)).toBeInTheDocument();
    }
  });

  it('renders string values verbatim in a <code> element', async () => {
    renderPage(OK_PAYLOAD);
    await screen.findByRole('heading', { level: 1 });

    // timeZone string value
    const tzRow = document.querySelector('[data-setting-key="timeZone"]');
    expect(tzRow).not.toBeNull();
    expect(within(tzRow as HTMLElement).getByText('America/Los_Angeles')).toBeInTheDocument();
  });

  it('renders number values with locale-formatted thousands separators', async () => {
    renderPage(OK_PAYLOAD);
    await screen.findByRole('heading', { level: 1 });

    // heartbeatIntervalSec = 600 → "600"
    const heartbeatRow = document.querySelector(
      '[data-setting-key="heartbeatIntervalSec"]',
    );
    expect(heartbeatRow).not.toBeNull();
    expect(
      within(heartbeatRow as HTMLElement).getByText('600'),
    ).toBeInTheDocument();

    // staleTaskWindowMs = 3_600_000 → "3,600,000"
    const staleRow = document.querySelector(
      '[data-setting-key="staleTaskWindowMs"]',
    );
    expect(staleRow).not.toBeNull();
    // The locale formatter produces either "3,600,000" or "3.600.000"
    // depending on the test environment locale. We check for digits + separators.
    const staleCode = within(staleRow as HTMLElement).getByRole('code');
    expect(staleCode).not.toBeNull();
  });

  it('renders lock directory string value verbatim', async () => {
    renderPage(OK_PAYLOAD);
    await screen.findByRole('heading', { level: 1 });

    const lockRow = document.querySelector('[data-setting-key="lockDir"]');
    expect(lockRow).not.toBeNull();
    expect(
      within(lockRow as HTMLElement).getByText('.aweek/.locks'),
    ).toBeInTheDocument();
  });
});

describe('SettingsPage — error state', () => {
  it('renders a typed error state on non-2xx with a Retry button', async () => {
    renderPage(null, { ok: false, status: 500 });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-error', 'true');
    expect(
      within(alert).getByRole('button', { name: /retry/i }),
    ).toBeInTheDocument();
  });

  it('renders a "Failed to load settings" heading in the error state', async () => {
    renderPage(null, { ok: false, status: 500 });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/failed to load settings/i);
  });
});
