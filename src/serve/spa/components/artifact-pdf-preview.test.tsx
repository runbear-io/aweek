/**
 * Component tests for `ArtifactPdfPreview` — AC 8.
 *
 * The component must:
 *   - Render an `<iframe>` so PDFs preview inline.
 *   - Point its `src` at `/api/agents/:slug/artifacts/:id/file` — the
 *     file-streaming endpoint registered in `src/serve/server.ts`.
 *   - Provide a download fallback `<a>` inside the iframe body for
 *     browsers that refuse inline PDF rendering, with the original
 *     filename hinted via the `download` attribute.
 *   - Carry an accessible `title` so screen readers can announce the
 *     iframe contents.
 *   - Render nothing when `slug` or `artifactId` is missing — defensive
 *     no-op so callers can pass partial props during routing.
 *   - Use the canonical `buildArtifactFileUrl` helper from
 *     `api-client.ts` so slug-encoding rules stay centralised across
 *     all inline renderers.
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Config : `vitest.config.js`.
 * Command: `pnpm test:spa`.
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { ArtifactPdfPreview } from './artifact-pdf-preview.tsx';

afterEach(() => {
  cleanup();
});

// ── ArtifactPdfPreview ───────────────────────────────────────────────

describe('ArtifactPdfPreview', () => {
  it('renders an iframe pointing at /api/agents/:slug/artifacts/:id/file', () => {
    const { container } = render(
      <ArtifactPdfPreview
        slug="alice"
        artifactId="artifact-aaa"
        fileName="paper.pdf"
      />,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src')).toBe(
      '/api/agents/alice/artifacts/artifact-aaa/file',
    );
  });

  it('uri-encodes the artifact id in the iframe src', () => {
    const { container } = render(
      <ArtifactPdfPreview
        slug="alice"
        artifactId="id with spaces"
        fileName="x.pdf"
      />,
    );
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
      '/api/agents/alice/artifacts/id%20with%20spaces/file',
    );
  });

  it('marks the wrapper for downstream selectors', () => {
    const { container } = render(
      <ArtifactPdfPreview slug="alice" artifactId="artifact-aaa" />,
    );
    const wrapper = container.querySelector('[data-artifact-preview="pdf"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.getAttribute('data-artifact-id')).toBe('artifact-aaa');
  });

  it('exposes an accessible iframe title that mentions the filename', () => {
    const { container } = render(
      <ArtifactPdfPreview
        slug="alice"
        artifactId="art-1"
        fileName="readme.pdf"
      />,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('title')).toMatch(/readme\.pdf/);
  });

  it('falls back to the artifact id in the title when filename is missing', () => {
    const { container } = render(
      <ArtifactPdfPreview slug="alice" artifactId="art-xyz" />,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('title')).toMatch(/art-xyz/);
  });

  it('honours a custom accessible title when provided', () => {
    const { container } = render(
      <ArtifactPdfPreview
        slug="alice"
        artifactId="art-1"
        fileName="x.pdf"
        title="Q1 financials"
      />,
    );
    expect(container.querySelector('iframe')?.getAttribute('title')).toBe(
      'Q1 financials',
    );
  });

  it('exposes a download fallback <a> inside the iframe body', () => {
    const { container } = render(
      <ArtifactPdfPreview
        slug="alice"
        artifactId="art-1"
        fileName="report.pdf"
      />,
    );
    const fallback = container.querySelector('iframe a[href]');
    expect(fallback).not.toBeNull();
    expect(fallback?.getAttribute('href')).toBe(
      '/api/agents/alice/artifacts/art-1/file',
    );
    expect(fallback?.getAttribute('download')).toBe('report.pdf');
  });

  it('omits the download attribute when no filename is supplied', () => {
    const { container } = render(
      <ArtifactPdfPreview slug="alice" artifactId="art-1" />,
    );
    const fallback = container.querySelector('iframe a[href]');
    expect(fallback).not.toBeNull();
    expect(fallback?.hasAttribute('download')).toBe(false);
  });

  it('respects the height prop (numeric → "<n>px", string → as-is)', () => {
    const { container, rerender } = render(
      <ArtifactPdfPreview slug="alice" artifactId="art-1" height={640} />,
    );
    expect(container.querySelector('iframe')?.getAttribute('height')).toBe(
      '640px',
    );
    rerender(
      <ArtifactPdfPreview slug="alice" artifactId="art-1" height="80vh" />,
    );
    expect(container.querySelector('iframe')?.getAttribute('height')).toBe(
      '80vh',
    );
  });

  it('renders nothing when slug or artifactId is missing', () => {
    const { container: c1 } = render(
      <ArtifactPdfPreview slug="" artifactId="art-1" />,
    );
    expect(c1.querySelector('iframe')).toBeNull();
    expect(c1.querySelector('[data-artifact-preview]')).toBeNull();

    const { container: c2 } = render(
      <ArtifactPdfPreview slug="alice" artifactId="" />,
    );
    expect(c2.querySelector('iframe')).toBeNull();
  });

  it('renders nothing when slug is malformed (canonical helper throws)', () => {
    // `buildArtifactFileUrl` rejects slugs with `/` — we swallow the throw
    // and render nothing so a bad row never crashes the surrounding list.
    const { container } = render(
      <ArtifactPdfPreview slug="bad/slug" artifactId="art-1" />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-artifact-preview]')).toBeNull();
  });

  it('joins the iframe src against an absolute baseUrl', () => {
    const { container } = render(
      <ArtifactPdfPreview
        slug="alice"
        artifactId="art-1"
        baseUrl="http://localhost:3000"
      />,
    );
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
      'http://localhost:3000/api/agents/alice/artifacts/art-1/file',
    );
  });

  it('uses canonical shadcn theme tokens on the wrapper', () => {
    const { container } = render(
      <ArtifactPdfPreview slug="alice" artifactId="art-1" />,
    );
    const wrapper = container.querySelector('[data-artifact-preview="pdf"]');
    const className = wrapper?.getAttribute('class') || '';
    expect(className).toMatch(/border-border/);
    expect(className).toMatch(/bg-card/);
    // No hardcoded slate-* utilities — keep the dashboard tokens canonical.
    expect(className).not.toMatch(/slate-/);
  });

  it('appends caller-supplied className without dropping defaults', () => {
    const { container } = render(
      <ArtifactPdfPreview
        slug="alice"
        artifactId="art-1"
        className="my-custom-class"
      />,
    );
    const wrapper = container.querySelector('[data-artifact-preview="pdf"]');
    const className = wrapper?.getAttribute('class') || '';
    expect(className).toMatch(/my-custom-class/);
    expect(className).toMatch(/border-border/);
  });
});
