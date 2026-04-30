/**
 * `SettingsPage` — read-only dashboard view of runtime configuration.
 *
 * Data contract:
 *   All data is sourced from `useAppConfig()` which calls `GET /api/config`.
 *   The page is strictly read-only — no write API, no edit/save UI.
 *   Props are UI-orchestration only (`baseUrl` / `fetch` for test injection).
 *
 * Layout:
 *   A page-header card (title, description, Refresh button) sits above one
 *   shadcn `Card` per category returned by the API. Each card renders a
 *   `<dl>` list of `{ label, value, description }` rows.
 *
 * Config-file status semantics:
 *   'ok'      — config.json absent (ENOENT) or valid. Defaults render
 *               silently, no warning shown.
 *   'missing' — config.json exists but is malformed JSON or has an invalid
 *               timeZone field. An inline advisory banner is shown so the
 *               user knows the dashboard is using compiled-in defaults for
 *               that field.
 *
 * Styling uses canonical shadcn/ui token utilities only (`bg-card`,
 * `text-muted-foreground`, `border-border`, …) so light and dark modes
 * render correctly without per-palette overrides.
 *
 * TypeScript migration note:
 *   This module follows the `.tsx` convention for SPA pages per the project
 *   style guide. shadcn/ui primitives in `../components/ui/*.jsx` remain
 *   `.jsx` during the incremental migration and are imported through the
 *   "cross-boundary shim" pattern (permissive `ComponentType` casts).
 *
 * @module serve/spa/pages/settings-page
 */

import * as React from 'react';

import * as ButtonModule from '../components/ui/button.jsx';
import * as CardModule from '../components/ui/card.jsx';
import { useAppConfig } from '../hooks/use-app-config.js';
import type { AppConfigPayload, ConfigCategory, ConfigItem } from '../lib/api-client.js';

// ── Cross-boundary shims for still-`.jsx` shadcn/ui primitives ──────
//
// The primitives under `../components/ui/*` expose `React.forwardRef`
// components with JSDoc but no TypeScript generics, so we re-alias each
// used primitive as a permissive `ComponentType` here. Once those files
// are converted to `.tsx` in a later sub-AC, the casts can be removed.

type ButtonVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'ghost'
  | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
};
type CardProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
};
type CardSectionProps = React.HTMLAttributes<HTMLDivElement>;
type CardTitleProps = React.HTMLAttributes<HTMLHeadingElement> & {
  as?: React.ElementType;
};
type CardDescriptionProps = React.HTMLAttributes<HTMLParagraphElement>;

const Button = ButtonModule.Button as React.ComponentType<ButtonProps>;
const Card = CardModule.Card as React.ComponentType<CardProps>;
const CardContent = CardModule.CardContent as React.ComponentType<CardSectionProps>;
const CardDescription =
  CardModule.CardDescription as React.ComponentType<CardDescriptionProps>;
const CardHeader = CardModule.CardHeader as React.ComponentType<CardSectionProps>;
const CardTitle = CardModule.CardTitle as React.ComponentType<CardTitleProps>;

// ── Public interface ────────────────────────────────────────────────

export interface SettingsPageProps {
  /** Override the default same-origin base URL used by the data hook (tests). */
  baseUrl?: string;
  /** Inject a custom fetch implementation (tests / Storybook). */
  fetch?: typeof fetch;
}

// ── Page component ──────────────────────────────────────────────────

/**
 * Read-only Settings page. Renders config.json fields and compiled-in
 * runtime constants grouped into shadcn `Card` panels by category.
 */
export function SettingsPage({
  baseUrl,
  fetch: fetchImpl,
}: SettingsPageProps = {}): React.ReactElement {
  const { data, error, loading, refresh } = useAppConfig({
    baseUrl,
    fetch: fetchImpl,
  });

  if (loading && !data) return <SettingsPageSkeleton />;
  if (error && !data) return <SettingsPageError error={error} onRetry={refresh} />;

  const categories: ConfigCategory[] = data?.categories ?? [];

  return (
    <section className="flex flex-col gap-4" data-page="settings">
      <SettingsPageHeader loading={loading} onRefresh={refresh} />
      {data?.status === 'missing' ? <ConfigWarningBanner /> : null}
      {categories.map((category) => (
        <CategoryCard key={category.id} category={category} />
      ))}
    </section>
  );
}

export default SettingsPage;

// ── Subcomponents ────────────────────────────────────────────────────

interface SettingsPageHeaderProps {
  loading: boolean;
  onRefresh: () => void | Promise<void>;
}

function SettingsPageHeader({
  loading,
  onRefresh,
}: SettingsPageHeaderProps): React.ReactElement {
  return (
    <header>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex flex-col gap-1">
            <CardTitle as="h1" className="text-base">
              Settings
            </CardTitle>
            <CardDescription className="text-xs">
              Read-only view of{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                .aweek/config.json
              </code>{' '}
              fields and compiled-in runtime constants.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </CardHeader>
      </Card>
    </header>
  );
}

/**
 * Inline advisory banner shown when config.json exists on disk but is
 * malformed JSON or contains an invalid timeZone value. Not shown when the
 * file is simply absent (ENOENT) — that case is `status === 'ok'` and
 * renders defaults silently.
 *
 * Styling note: the stock shadcn palette does not expose a warning/amber
 * token, so we follow the same approach used by `StaleBanner` in
 * `agents-page.tsx` — muted surface + muted text signals "advisory, not
 * destructive" without any per-palette overrides.
 */
function ConfigWarningBanner(): React.ReactElement {
  return (
    <Card
      role="alert"
      data-config-warning="true"
      className="bg-muted"
    >
      <CardContent className="p-4 text-sm text-muted-foreground">
        ⚠{' '}
        <span className="font-medium text-foreground">
          config.json missing or malformed
        </span>{' '}
        — configurable fields are showing compiled-in defaults.
      </CardContent>
    </Card>
  );
}

interface CategoryCardProps {
  category: ConfigCategory;
}

function CategoryCard({ category }: CategoryCardProps): React.ReactElement {
  const headingId = `settings-cat-${category.id}`;
  return (
    <Card aria-labelledby={headingId} data-category={category.id}>
      <CardHeader className="pb-2 space-y-0.5">
        <CardTitle
          as="h2"
          id={headingId}
          className="text-sm font-semibold"
        >
          {category.label}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 pb-2">
        <dl className="divide-y divide-border">
          {category.items.map((item) => (
            <ConfigRow key={item.key} item={item} />
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

interface ConfigRowProps {
  item: ConfigItem;
}

function ConfigRow({ item }: ConfigRowProps): React.ReactElement {
  return (
    <div
      className="flex flex-col gap-1 px-6 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
      data-setting-key={item.key}
    >
      <dt className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">
          {item.label}
        </span>
        <span className="text-xs text-muted-foreground">
          {item.description}
        </span>
      </dt>
      <dd className="flex shrink-0 items-start sm:justify-end">
        <code className="rounded bg-muted px-2 py-1 text-xs text-foreground tabular-nums">
          {formatConfigValue(item.value)}
        </code>
      </dd>
    </div>
  );
}

// ── State variants ───────────────────────────────────────────────────

function SettingsPageSkeleton(): React.ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-pulse text-sm text-muted-foreground"
      data-page="settings"
      data-loading="true"
    >
      Loading settings…
    </div>
  );
}

interface SettingsPageErrorProps {
  error: Error | { message?: string } | null;
  onRetry: () => void | Promise<void>;
}

function SettingsPageError({
  error,
  onRetry,
}: SettingsPageErrorProps): React.ReactElement {
  return (
    <Card
      role="alert"
      data-page="settings"
      data-error="true"
      className="border-destructive/40 bg-destructive/10 text-destructive"
    >
      <CardHeader className="space-y-1">
        <CardTitle as="h2" className="text-sm text-destructive">
          Failed to load settings.
        </CardTitle>
        <CardDescription className="text-xs text-destructive/80">
          {(error as Error | null)?.message ?? String(error)}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Utilities ────────────────────────────────────────────────────────

/**
 * Format a config item value for display.
 *
 * - `boolean` → `'true'` / `'false'`
 * - `number`  → locale-formatted string with thousands separators
 * - `string`  → as-is
 */
function formatConfigValue(value: AppConfigPayload['status'] | string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return value.toLocaleString();
  return String(value);
}
