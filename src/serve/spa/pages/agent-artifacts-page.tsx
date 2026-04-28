/**
 * `AgentArtifactsPage` — per-agent Artifacts tab.
 *
 * Renders the merged artifact list for a single agent grouped by ISO
 * week. Each week section shows a header (week key + count), and each
 * artifact row shows the human filename, type chip, formatted size, and
 * created date.
 *
 * Data contract:
 *   Sourced exclusively from `useAgentArtifacts(slug)`. The hook returns
 *   the loose `AgentArtifacts` payload alongside a derived `groups`
 *   collection that is already bucketed and sorted newest-first (with
 *   the `'unknown'` week sentinel sinking to the bottom). The page never
 *   re-derives the bucketing — it just renders.
 *
 * Layout (Sub-AC 5.2):
 *   - Header — title, slug + total count, optional refresh action.
 *   - Section per ISO week — header card + per-row table-like list.
 *   - Per-row metadata — filename, type chip, size, created date.
 *
 * Empty / loading / error states match the sibling tabs (Activity,
 * Reviews) for consistency: shadcn `Card` envelopes with stock theme
 * tokens (`bg-card`, `text-muted-foreground`, `border-border`).
 *
 * Sub-AC 5.2 explicitly limits this component to *rendering the list*.
 * Inline preview/render of the file body, download buttons, and delete
 * controls land in subsequent sub-ACs and slot in here as additional
 * row affordances.
 *
 * @module serve/spa/pages/agent-artifacts-page
 */

import * as React from 'react';

import { ArtifactDownloadLink } from '../components/artifact-download-link.js';
import { ArtifactPdfPreview } from '../components/artifact-pdf-preview.js';
import * as BadgeModule from '../components/ui/badge.jsx';
import * as ButtonModule from '../components/ui/button.jsx';
import * as CardModule from '../components/ui/card.jsx';
import { useAgentArtifacts } from '../hooks/use-agent-artifacts.js';
import {
  buildArtifactFileUrl,
  fetchArtifactFileText,
} from '../lib/api-client.js';
import { Markdown } from '../lib/markdown.js';

// ── Cross-boundary shims for still-`.jsx` shadcn/ui primitives ──────

type ShadcnVariant = 'default' | 'secondary' | 'destructive' | 'outline';
type ButtonVariant = ShadcnVariant | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: ShadcnVariant;
  asChild?: boolean;
};
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

const Badge = BadgeModule.Badge as React.ComponentType<BadgeProps>;
const Button = ButtonModule.Button as React.ComponentType<ButtonProps>;
const Card = CardModule.Card as React.ComponentType<CardProps>;
const CardContent = CardModule.CardContent as React.ComponentType<CardSectionProps>;
const CardDescription =
  CardModule.CardDescription as React.ComponentType<CardDescriptionProps>;
const CardHeader = CardModule.CardHeader as React.ComponentType<CardSectionProps>;
const CardTitle = CardModule.CardTitle as React.ComponentType<CardTitleProps>;

// ── Domain types ────────────────────────────────────────────────────

type AgentArtifacts = import('../lib/api-client.js').AgentArtifacts;
type ArtifactRecord = import('../lib/api-client.js').ArtifactRecord;
type ArtifactWeekGroup =
  import('../hooks/use-agent-artifacts.js').ArtifactWeekGroup;

const UNKNOWN_WEEK_LABEL = 'Unscheduled';

/**
 * Map an artifact `type` to a stock shadcn `Badge` variant. Keeps the
 * tonal distinction between deliverable categories without introducing
 * bespoke palette utilities.
 */
function artifactTypeBadgeVariant(type: string): ShadcnVariant {
  if (type === 'report' || type === 'document') return 'default';
  if (type === 'code' || type === 'config') return 'secondary';
  if (type === 'data') return 'outline';
  return 'outline';
}

// ── Prop types ──────────────────────────────────────────────────────

export interface AgentArtifactsPageProps {
  /** Agent slug — selects which agent's artifact list the page loads. */
  slug: string;
  /** Override the default same-origin base URL used by the data hook. */
  baseUrl?: string;
  /** Inject a custom fetch impl (Storybook, tests, MSW). */
  fetch?: typeof fetch;
}

// ── Component ───────────────────────────────────────────────────────

export function AgentArtifactsPage({
  slug,
  baseUrl,
  fetch: fetchImpl,
}: AgentArtifactsPageProps): React.ReactElement {
  const { data, error, loading, refresh, groups } = useAgentArtifacts(slug, {
    baseUrl,
    fetch: fetchImpl,
  });

  if (!slug) return <ArtifactsEmpty message="Select an agent to view artifacts." />;
  if (loading && !data) return <ArtifactsSkeleton />;

  // `useAgentArtifacts` widens `error` to `Error | null`; ApiError carries a
  // `.status` field we can branch on for 404 short-circuit messaging.
  const errorWithStatus = error as unknown as { status?: unknown } | null;
  const errorStatus =
    errorWithStatus && typeof errorWithStatus.status === 'number'
      ? errorWithStatus.status
      : null;
  if (error && errorStatus === 404)
    return <ArtifactsEmpty message={`No agent found for slug "${slug}".`} />;
  if (error && !data)
    return <ArtifactsError error={error} onRetry={refresh} />;
  if (!data) return <ArtifactsEmpty message={`No artifacts for "${slug}".`} />;

  const totalArtifacts = data.summary?.totalArtifacts ?? data.artifacts.length;

  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-artifacts"
      data-agent-slug={data.slug}
    >
      <ArtifactsHeader data={data} loading={loading} onRefresh={refresh} />
      {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
      {totalArtifacts === 0 || groups.length === 0 ? (
        <ArtifactsEmpty
          message={`No artifacts have been registered for "${data.slug}" yet.`}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <ArtifactWeekSection
              key={group.week}
              group={group}
              slug={data.slug}
              baseUrl={baseUrl}
              fetchImpl={fetchImpl}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default AgentArtifactsPage;

// ── Sub-components ──────────────────────────────────────────────────

interface ArtifactsHeaderProps {
  data: AgentArtifacts;
  loading: boolean;
  onRefresh: () => void | Promise<void>;
}

function ArtifactsHeader({
  data,
  loading,
  onRefresh,
}: ArtifactsHeaderProps): React.ReactElement {
  const total = data.summary?.totalArtifacts ?? data.artifacts.length;
  const totalSize = data.summary?.totalSizeBytes ?? 0;
  return (
    <header className="flex flex-col gap-2 border-b pb-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-semibold leading-none tracking-tight text-foreground">
            Artifacts
          </h1>
          <p className="text-xs text-muted-foreground">
            <code>{data.slug}</code> · {total} artifact
            {total === 1 ? '' : 's'}
            {totalSize > 0 ? ` · ${formatBytes(totalSize)} total` : ''}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      {data.summary && Object.keys(data.summary.byType).length > 0 ? (
        <div className="flex flex-wrap gap-1.5" data-summary-by-type="true">
          {Object.entries(data.summary.byType).map(([type, count]) => (
            <Badge
              key={type}
              variant={artifactTypeBadgeVariant(type)}
              className="text-[10px] uppercase tracking-wider"
            >
              {type}
              <span className="ml-1 tabular-nums">{count}</span>
            </Badge>
          ))}
        </div>
      ) : null}
    </header>
  );
}

interface ArtifactWeekSectionProps {
  group: ArtifactWeekGroup;
  /** Owning agent slug — needed to construct per-artifact file URLs. */
  slug: string;
  /** Optional base URL override forwarded from the page-level prop. */
  baseUrl?: string;
  /** Optional fetch impl forwarded down to inline-render previews (tests / Storybook). */
  fetchImpl?: typeof fetch;
}

function ArtifactWeekSection({
  group,
  slug,
  baseUrl,
  fetchImpl,
}: ArtifactWeekSectionProps): React.ReactElement {
  const isUnknown = group.week === 'unknown';
  const label = isUnknown ? UNKNOWN_WEEK_LABEL : group.week;
  const count = group.artifacts.length;
  return (
    <Card as="section" data-artifact-week={group.week}>
      <CardHeader className="space-y-0 border-b bg-muted/50 p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {label}
          </span>
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {count} artifact{count === 1 ? '' : 's'}
          </span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ul role="list" className="divide-y">
          {group.artifacts.map((record, idx) => (
            <ArtifactRow
              key={record.id || `${record.fileName}-${idx}`}
              record={record}
              slug={slug}
              baseUrl={baseUrl}
              fetchImpl={fetchImpl}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

interface ArtifactRowProps {
  record: ArtifactRecord;
  /** Owning agent slug — used to build the streamed-file URL. */
  slug: string;
  /** Optional base URL override forwarded from the hook. */
  baseUrl?: string;
  /** Optional fetch impl forwarded to inline previews (markdown, tests). */
  fetchImpl?: typeof fetch;
}

function ArtifactRow({
  record,
  slug,
  baseUrl,
  fetchImpl,
}: ArtifactRowProps): React.ReactElement {
  const hasSize = typeof record.sizeBytes === 'number';
  const isMarkdown = isMarkdownArtifact(record);
  const isPdf = isPdfArtifact(record);
  const isImage = isInlineRenderableArtifact(record);
  // AC 9: When no inline renderer applies, we fall back to a download
  // link. The server pairs this with `Content-Disposition: attachment`
  // for any extension that resolves to `application/octet-stream`, so
  // the browser triggers a Save-As dialog instead of attempting to
  // render an opaque body. Mirrors `resolveArtifactContentType` in
  // `src/serve/data/artifacts.ts` — inline-renderable types stay out of
  // the fallback path.
  const renderInline = isMarkdown || isPdf || isImage;
  const showDownload = !renderInline && Boolean(record.id);
  const imageSrc =
    isImage && record.id
      ? safeBuildArtifactUrl(slug, record.id, baseUrl ?? '')
      : null;
  return (
    <li
      className="flex flex-col gap-1 px-4 py-2.5"
      data-artifact-id={record.id}
      data-artifact-type={record.type}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {record.fileName || record.filePath}
        </span>
        <Badge
          variant={artifactTypeBadgeVariant(record.type)}
          className="text-[10px] uppercase tracking-wider"
        >
          {record.type}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {hasSize ? (
          <span className="tabular-nums">{formatBytes(record.sizeBytes!)}</span>
        ) : null}
        {record.createdAt ? (
          <time dateTime={record.createdAt} className="tabular-nums">
            {formatDate(record.createdAt)}
          </time>
        ) : null}
        {record.taskId ? (
          <span className="text-[11px] text-muted-foreground">
            Task <code>{record.taskId}</code>
          </span>
        ) : null}
      </div>
      {record.description ? (
        <div className="text-xs text-muted-foreground">
          {record.description}
        </div>
      ) : null}
      {isMarkdown && record.id ? (
        <ArtifactMarkdownPreview
          slug={slug}
          artifactId={record.id}
          baseUrl={baseUrl}
          fetchImpl={fetchImpl}
        />
      ) : null}
      {isPdf && record.id ? (
        <ArtifactPdfPreview
          slug={slug}
          artifactId={record.id}
          fileName={record.fileName}
          baseUrl={baseUrl}
          className="mt-2"
        />
      ) : null}
      {isImage && imageSrc ? (
        // AC 7: Image artifacts render inline via <img>. The browser
        // streams bytes from `/api/agents/:slug/artifacts/:id/file`,
        // and the server resolves Content-Type to `image/*` for the
        // canonical extensions. URL construction is centralised via
        // `buildArtifactFileUrl` so slug-encoding stays uniform across
        // markdown / PDF / image / download paths.
        <img
          src={imageSrc}
          alt={record.fileName || 'Artifact image'}
          loading="lazy"
          decoding="async"
          className="mt-2 max-h-96 max-w-full rounded-md border border-border bg-card object-contain"
          data-artifact-image="true"
        />
      ) : null}
      {showDownload ? (
        <ArtifactDownloadLink
          slug={slug}
          artifactId={record.id}
          fileName={record.fileName}
          sizeLabel={hasSize ? formatBytes(record.sizeBytes!) : undefined}
          baseUrl={baseUrl}
          className="mt-2"
        />
      ) : null}
    </li>
  );
}

// ── Inline renderers ────────────────────────────────────────────────

/**
 * Detect markdown artifacts from a record. We accept the canonical
 * `.md` / `.markdown` extensions on the recorded `fileName` — matches
 * the server-side `resolveArtifactContentType` extension table so the
 * SPA's "render inline" decision lines up with the `text/markdown`
 * Content-Type the browser will see when streaming the file.
 */
function isMarkdownArtifact(record: ArtifactRecord): boolean {
  const name = typeof record.fileName === 'string' ? record.fileName : '';
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/**
 * Detect PDF artifacts from a record. We accept the canonical `.pdf`
 * extension on the recorded `fileName` — matches the server-side
 * `resolveArtifactContentType` table so the SPA's "render inline"
 * decision lines up with the `application/pdf` Content-Type the
 * browser will see when streaming the file. Also tolerates a
 * caller-supplied `metadata.mimeType === 'application/pdf'` so PDFs
 * without a `.pdf` extension still preview inline.
 */
function isPdfArtifact(record: ArtifactRecord): boolean {
  const name = typeof record.fileName === 'string' ? record.fileName : '';
  if (name && name.toLowerCase().endsWith('.pdf')) return true;
  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object') {
    const mime = (metadata as { mimeType?: unknown }).mimeType;
    if (typeof mime === 'string' && mime.toLowerCase() === 'application/pdf') {
      return true;
    }
  }
  return false;
}

/**
 * Detect "inline-renderable but not markdown / pdf" artifacts so the
 * AC-9 download fallback skips them. Today this covers the image
 * extensions that the parallel sibling AC will hook a `<img>` renderer
 * onto — by treating them as "inline renderable" we avoid showing a
 * redundant download link below the future image preview. Until image
 * rendering lands the row simply has no inline preview at all (still
 * accessible via the row's filename label and per-row metadata; users
 * can also right-click any modern browser's address bar to save the
 * `/file` URL).
 *
 * Extension list mirrors the `image/*` block in
 * `resolveArtifactContentType` (`src/serve/data/artifacts.ts`) so the
 * SPA's classification stays consistent with the server's Content-Type
 * resolution.
 */
const INLINE_RENDERABLE_IMAGE_EXTS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.avif',
];

/**
 * Defensive URL builder for inline `<img>` rendering. The canonical
 * `buildArtifactFileUrl` throws on a malformed slug or empty id —
 * inside an inline-render component we'd rather skip the preview than
 * blow up the surrounding tree, so this wrapper returns `null` on any
 * throw. Mirrors the same pattern used inside `<ArtifactPdfPreview>`.
 */
function safeBuildArtifactUrl(
  slug: string,
  artifactId: string,
  baseUrl: string,
): string | null {
  if (!slug || !artifactId) return null;
  try {
    return buildArtifactFileUrl(slug, artifactId, baseUrl);
  } catch {
    return null;
  }
}

function isInlineRenderableArtifact(record: ArtifactRecord): boolean {
  const name = typeof record.fileName === 'string' ? record.fileName : '';
  if (!name) return false;
  const lower = name.toLowerCase();
  if (INLINE_RENDERABLE_IMAGE_EXTS.some((ext) => lower.endsWith(ext))) {
    return true;
  }
  // Defensive metadata check — if the agent recorded an `image/*` MIME
  // type explicitly, honour it even when the extension is missing.
  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object') {
    const mime = (metadata as { mimeType?: unknown }).mimeType;
    if (typeof mime === 'string' && mime.toLowerCase().startsWith('image/')) {
      return true;
    }
  }
  return false;
}

interface ArtifactMarkdownPreviewProps {
  slug: string;
  artifactId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Inline markdown preview block for a single `.md` / `.markdown` artifact.
 *
 * Fetches the raw text body via `fetchArtifactFileText` (which proxies to
 * `GET /api/agents/:slug/artifacts/:id/file`) and feeds it into the
 * shared `<Markdown>` component (`src/serve/spa/lib/markdown.tsx`) so the
 * rendered output picks up GFM extensions (task lists, tables, autolinks)
 * and the canonical shadcn theme tokens for free.
 *
 * States:
 *   - Loading — text-muted skeleton while the body streams in.
 *   - Error — destructive Card alert with a Retry button.
 *   - Success — `<article data-artifact-markdown="true">` envelope around
 *     the rendered Markdown so tests can assert the body landed.
 *
 * Aborts on unmount via an `AbortController` so a fast-scrolling tab
 * doesn't leak in-flight requests.
 */
function ArtifactMarkdownPreview({
  slug,
  artifactId,
  baseUrl,
  fetchImpl,
}: ArtifactMarkdownPreviewProps): React.ReactElement {
  const [text, setText] = React.useState<string | null>(null);
  const [error, setError] = React.useState<Error | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [reloadKey, setReloadKey] = React.useState<number>(0);

  React.useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchArtifactFileText(slug, artifactId, {
      baseUrl,
      fetch: fetchImpl,
      signal: controller.signal,
    })
      .then((body) => {
        if (cancelled) return;
        setText(body);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Caller-aborts shouldn't surface as errors.
        if (err && typeof err === 'object') {
          const maybe = err as { name?: unknown; code?: unknown };
          if (maybe.name === 'AbortError' || maybe.code === 'ABORT_ERR') return;
        }
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [slug, artifactId, baseUrl, fetchImpl, reloadKey]);

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-2 animate-pulse rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        data-artifact-markdown-state="loading"
      >
        Loading preview…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        data-artifact-markdown-state="error"
      >
        <span>Preview failed: {error.message || String(error)}.</span>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-0 py-0 text-xs text-destructive hover:text-destructive"
          onClick={() => setReloadKey((k) => k + 1)}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <article
      className="mt-2 max-w-none rounded-md border border-border bg-card px-3 py-2 text-xs leading-5 text-foreground"
      data-artifact-markdown="true"
      data-artifact-markdown-state="ready"
    >
      <Markdown source={text ?? ''} />
    </article>
  );
}

// ── Empty / loading / error ────────────────────────────────────────

interface EmptyProps {
  message: string;
}

interface ErrorBannerProps {
  error: Error | { message?: string } | null;
  onRetry: () => void | Promise<void>;
}

function ArtifactsEmpty({ message }: EmptyProps): React.ReactElement {
  return (
    <Card
      as="div"
      className="border-dashed bg-transparent shadow-none"
      data-page="agent-artifacts"
      data-state="empty"
    >
      <CardHeader className="items-center p-8 text-center">
        <CardDescription className="text-sm italic">{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function ArtifactsSkeleton(): React.ReactElement {
  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-artifacts"
      data-loading="true"
    >
      <header className="flex flex-col gap-2 border-b pb-3">
        <div className="text-base font-semibold leading-none tracking-tight text-foreground">
          Artifacts
        </div>
      </header>
      <div
        role="status"
        aria-live="polite"
        className="animate-pulse text-sm text-muted-foreground"
      >
        Loading artifacts…
      </div>
    </section>
  );
}

function ArtifactsError({
  error,
  onRetry,
}: ErrorBannerProps): React.ReactElement {
  return (
    <Card
      role="alert"
      as="div"
      className="border-destructive/40 bg-destructive/10 text-destructive"
      data-page="agent-artifacts"
      data-error="true"
    >
      <CardHeader className="space-y-1 p-4">
        <CardTitle as="h2" className="text-sm font-semibold leading-none text-destructive">
          Failed to load artifacts.
        </CardTitle>
        <CardDescription className="text-xs text-destructive/80">
          {error?.message || String(error)}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="border-destructive/40 text-destructive hover:bg-destructive/20 hover:text-destructive"
        >
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

function StaleBanner({ error, onRetry }: ErrorBannerProps): React.ReactElement {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground"
    >
      <span>
        Refresh failed ({error?.message || 'unknown error'}) — showing
        last-known data.
      </span>
      <Button
        type="button"
        onClick={onRetry}
        variant="link"
        size="sm"
        className="h-auto px-0 py-0 text-xs"
      >
        Retry
      </Button>
    </div>
  );
}

// ── Formatters ──────────────────────────────────────────────────────

/**
 * Format an ISO timestamp as a short locale-aware string. Mirrors the
 * sibling tabs (Activity / Reviews) so dates read consistently.
 */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return String(iso);
  return new Date(ms).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Compact byte-size formatter (KB / MB / GB). Uses base-1024 to match
 * the conventions used in the rest of the dashboard. Falls back to a
 * raw byte count under 1 KB so very small artifacts read precisely.
 */
function formatBytes(bytes: number | null | undefined): string {
  const v = Number(bytes) || 0;
  if (v <= 0) return '0 B';
  if (v < 1024) return `${v} B`;
  const kb = v / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 2 : 1)} GB`;
}
