/**
 * `ArtifactDownloadLink` — fallback inline affordance for the Artifacts
 * tab.
 *
 * AC 9: Unknown file types fall back to a download link with
 * `Content-Disposition: attachment`. The server-side disposition lives
 * in `handleAgentArtifactFile` (`src/serve/server.ts`); this SPA
 * component renders the user-facing entry point — an `<a download>`
 * link that targets the file-streaming endpoint:
 *
 *     GET /api/agents/:slug/artifacts/:id/file
 *
 * When a user clicks the link the server sets
 * `Content-Disposition: attachment; filename="…"` for any extension that
 * `resolveArtifactContentType` doesn't recognise (i.e. anything that
 * resolves to `application/octet-stream`), so the browser unconditionally
 * triggers a Save-As dialog instead of attempting to render an opaque
 * body. The `download` attribute on the anchor is a defensive belt for
 * known-renderable types in case this component is reused for them.
 *
 * Design choices:
 *   - Pure presentational anchor — no fetching, no hooks. The browser
 *     does all the work via the `<a download>` semantics + the server's
 *     attachment disposition.
 *   - Theme-token surface (`bg-card`, `border-border`,
 *     `text-muted-foreground`) so the chrome around the link keeps the
 *     dashboard's shadcn aesthetic in light + dark mode.
 *   - URL construction reuses the canonical `buildArtifactFileUrl`
 *     helper from `api-client.ts` so slug-encoding rules stay
 *     centralised across all inline renderers (markdown / image / PDF /
 *     download).
 *   - Renders nothing when slug or artifactId is missing — defensive
 *     no-op so callers can pass partial props during routing without
 *     crashing the surrounding tree.
 *
 * @module serve/spa/components/artifact-download-link
 */

import * as React from 'react';

import { buildArtifactFileUrl } from '../lib/api-client.js';

// ── Public types ────────────────────────────────────────────────────────

export interface ArtifactDownloadLinkProps {
  /** Agent slug that owns the artifact (path segment under `/api/agents/`). */
  slug: string;
  /** Artifact ID — path segment under `/artifacts/<id>/file`. */
  artifactId: string;
  /**
   * Filename suggested as the `download` attribute hint. Browsers use it
   * as the default Save-As filename when the user activates the link.
   */
  fileName?: string;
  /**
   * Formatted file size string (e.g. `"4.0 KB"`) shown next to the
   * link. Optional — when omitted the size chip is skipped.
   */
  sizeLabel?: string;
  /**
   * Optional override for the same-origin base URL used when
   * constructing the file endpoint. Mirrors the `baseUrl` opt accepted
   * by the data hooks and is intended for tests / cross-origin dev
   * setups.
   */
  baseUrl?: string;
  /** Optional accessible label override. Defaults to `Download <fileName>`. */
  label?: string;
  /** Extra class names appended to the wrapper element. */
  className?: string;
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Defensive wrapper around `buildArtifactFileUrl` — the canonical helper
 * throws on malformed slug / empty id (good defence for fetch callers),
 * but inside an inline-render component we'd rather render nothing than
 * blow up the surrounding tree. Returns the URL on success or `null` on
 * any throw.
 */
function safeBuildFileUrl(
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

// ── Component ───────────────────────────────────────────────────────────

/**
 * Render a download affordance for an artifact. The anchor's `href`
 * points at the file-streaming endpoint and the `download` attribute
 * surfaces the original filename to the browser's Save-As dialog. When
 * the server returns the artifact with `Content-Disposition: attachment`
 * (the case for unknown file types — AC 9), the browser triggers a
 * download immediately without trying to render the body.
 */
export function ArtifactDownloadLink({
  slug,
  artifactId,
  fileName,
  sizeLabel,
  baseUrl = '',
  label,
  className,
}: ArtifactDownloadLinkProps): React.ReactElement | null {
  const url = safeBuildFileUrl(slug, artifactId, baseUrl);
  if (!url) return null;

  const linkLabel = label || `Download ${fileName || 'file'}`;
  const wrapperClass = [
    'flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs',
    className || '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={wrapperClass}
      data-artifact-preview="download"
      data-artifact-id={artifactId}
    >
      <span className="text-muted-foreground">
        Inline preview not available for this file type.
      </span>
      <a
        href={url}
        // The `download` attribute hints the Save-As filename; the
        // server's `Content-Disposition: attachment` is what actually
        // forces the download. Belt + suspenders.
        download={fileName || ''}
        className="font-medium text-foreground underline-offset-2 hover:underline"
        aria-label={linkLabel}
      >
        {linkLabel}
      </a>
      {sizeLabel ? (
        <span className="tabular-nums text-muted-foreground">
          ({sizeLabel})
        </span>
      ) : null}
    </div>
  );
}

export default ArtifactDownloadLink;
