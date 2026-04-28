/**
 * `ArtifactPdfPreview` — inline PDF rendering for the Artifacts tab.
 *
 * AC 8: PDF artifacts must render inline via an `<iframe>` (or `<embed>`)
 * element so users can read deliverables directly inside the dashboard
 * without opening an external viewer.
 *
 * Source URL contract:
 *   The component renders an `<iframe>` whose `src` points at the
 *   pre-existing file-streaming endpoint:
 *
 *     GET /api/agents/:slug/artifacts/:id/file
 *
 *   That endpoint is implemented in `src/serve/data/artifacts.ts`
 *   (`resolveArtifactFile`) and wired into `src/serve/server.ts`. It
 *   returns the raw bytes with a `Content-Type` header derived from the
 *   filename extension via `resolveArtifactContentType` —
 *   `application/pdf` for `*.pdf`. Browsers natively render PDF bytes
 *   served with that MIME inside an iframe, so we do not need any
 *   client-side PDF library.
 *
 * Design choices:
 *   - `<iframe>` over `<embed>`: iframes carry richer accessibility
 *     semantics (`title`, focus, `<a>` fallback) and are CSP-friendly.
 *   - Built-in `<a>` fallback inside the iframe body for browsers that
 *     refuse inline PDF rendering (legacy iOS, sandboxed environments).
 *   - Theme-token surface (`bg-card`, `border-border`) so the chrome
 *     around the preview keeps the dashboard's shadcn aesthetic in
 *     light + dark mode.
 *   - URL construction reuses the canonical `buildArtifactFileUrl`
 *     helper from `api-client.ts` so slug-encoding rules stay
 *     centralised across all inline renderers (markdown / image / PDF).
 *
 * @module serve/spa/components/artifact-pdf-preview
 */

import * as React from 'react';

import { buildArtifactFileUrl } from '../lib/api-client.js';

// ── Public types ────────────────────────────────────────────────────────

export interface ArtifactPdfPreviewProps {
  /** Agent slug that owns the artifact (path segment under `/api/agents/`). */
  slug: string;
  /** Artifact ID — path segment under `/artifacts/<id>/file`. */
  artifactId: string;
  /** Filename used as a download fallback `download` attribute hint. */
  fileName?: string;
  /**
   * Optional override for the same-origin base URL used when constructing
   * the file endpoint. Mirrors the `baseUrl` opt accepted by the data
   * hooks and is intended for tests / cross-origin dev setups.
   */
  baseUrl?: string;
  /** Pixel height of the iframe. Defaults to a comfortable reading height. */
  height?: number | string;
  /** Optional accessible title for the iframe. */
  title?: string;
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
 * Render a PDF artifact inline using an `<iframe>` whose src points at
 * the file-streaming endpoint. The iframe ships an inline `<a>`
 * fallback for browsers that refuse to render PDFs inline — the link
 * preserves the original filename via the `download` attribute.
 */
export function ArtifactPdfPreview({
  slug,
  artifactId,
  fileName,
  baseUrl = '',
  height = 480,
  title,
  className,
}: ArtifactPdfPreviewProps): React.ReactElement | null {
  const url = safeBuildFileUrl(slug, artifactId, baseUrl);
  if (!url) return null;

  const iframeTitle = title || `PDF preview: ${fileName || artifactId}`;
  const wrapperClass = [
    'overflow-hidden rounded-md border border-border bg-card',
    className || '',
  ]
    .filter(Boolean)
    .join(' ');

  // The `<a>` inside the iframe body is the legacy/CSP fallback path —
  // browsers that refuse inline PDF rendering surface it instead of an
  // empty frame. Modern browsers ignore the body and render the PDF.
  return (
    <div
      className={wrapperClass}
      data-artifact-preview="pdf"
      data-artifact-id={artifactId}
    >
      <iframe
        src={url}
        title={iframeTitle}
        width="100%"
        height={typeof height === 'number' ? `${height}px` : height}
        className="block w-full border-0 bg-card"
        loading="lazy"
      >
        <a
          href={url}
          download={fileName || undefined}
          className="text-xs text-muted-foreground underline"
        >
          Download {fileName || 'PDF'}
        </a>
      </iframe>
    </div>
  );
}

export default ArtifactPdfPreview;
