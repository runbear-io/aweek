/**
 * Component tests for `ArtifactDownloadLink` — AC 9.
 *
 * The component must:
 *   - Render an `<a>` whose `href` points at
 *     `/api/agents/:slug/artifacts/:id/file` — the file-streaming
 *     endpoint registered in `src/serve/server.ts` (which sets
 *     `Content-Disposition: attachment` for unknown file types).
 *   - Carry the `download` attribute with the artifact's original
 *     filename so the browser's Save-As dialog reflects it.
 *   - URI-encode both the slug and artifact id so values with special
 *     characters can't break the URL.
 *   - Accept a `baseUrl` for cross-origin dev / test setups.
 *   - Render nothing when `slug` or `artifactId` is missing — defensive
 *     no-op so callers can pass partial props during routing.
 *   - Use canonical shadcn theme tokens (`bg-card`, `border-border`,
 *     `text-muted-foreground`) — no hardcoded `slate-*` utilities.
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Config : `vitest.config.js`.
 * Command: `pnpm test:spa`.
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { ArtifactDownloadLink } from './artifact-download-link.tsx';

afterEach(() => {
  cleanup();
});

describe('ArtifactDownloadLink', () => {
  it('renders an <a> pointing at /api/agents/:slug/artifacts/:id/file', () => {
    const { container } = render(
      <ArtifactDownloadLink
        slug="alice"
        artifactId="artifact-aaa"
        fileName="blob.xyz"
      />,
    );
    const link = container.querySelector('a[href]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe(
      '/api/agents/alice/artifacts/artifact-aaa/file',
    );
  });

  it('marks the wrapper for downstream selectors', () => {
    const { container } = render(
      <ArtifactDownloadLink
        slug="alice"
        artifactId="artifact-aaa"
        fileName="blob.xyz"
      />,
    );
    const wrapper = container.querySelector(
      '[data-artifact-preview="download"]',
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper?.getAttribute('data-artifact-id')).toBe('artifact-aaa');
  });

  it('hints the original filename via the download attribute', () => {
    const { container } = render(
      <ArtifactDownloadLink
        slug="alice"
        artifactId="art-1"
        fileName="weird.xyz"
      />,
    );
    const link = container.querySelector('a[href]');
    expect(link?.getAttribute('download')).toBe('weird.xyz');
  });

  it('still renders an <a> when no filename is supplied (download attr empty)', () => {
    const { container } = render(
      <ArtifactDownloadLink slug="alice" artifactId="art-1" />,
    );
    const link = container.querySelector('a[href]');
    expect(link).not.toBeNull();
    // The download attr exists with an empty string — the browser falls
    // back to deriving the filename from Content-Disposition.
    expect(link?.hasAttribute('download')).toBe(true);
  });

  it('uri-encodes special characters in slug and artifact id', () => {
    // `assertValidSlug` rejects `/`, `\`, `\0`, `.`, `..` but otherwise
    // allows arbitrary characters — spaces and other URL-unsafe glyphs
    // must round-trip through `encodeURIComponent` cleanly.
    const { container } = render(
      <ArtifactDownloadLink
        slug="a bc"
        artifactId="id with spaces"
        fileName="x.bin"
      />,
    );
    const link = container.querySelector('a[href]');
    expect(link?.getAttribute('href')).toBe(
      '/api/agents/a%20bc/artifacts/id%20with%20spaces/file',
    );
  });

  it('joins the link href against an absolute baseUrl', () => {
    const { container } = render(
      <ArtifactDownloadLink
        slug="alice"
        artifactId="art-1"
        fileName="x.bin"
        baseUrl="http://localhost:3000"
      />,
    );
    expect(container.querySelector('a[href]')?.getAttribute('href')).toBe(
      'http://localhost:3000/api/agents/alice/artifacts/art-1/file',
    );
  });

  it('shows the size label when provided', () => {
    const { container } = render(
      <ArtifactDownloadLink
        slug="alice"
        artifactId="art-1"
        fileName="x.bin"
        sizeLabel="2.5 KB"
      />,
    );
    expect(container.textContent).toMatch(/2\.5 KB/);
  });

  it('omits the size chip when no sizeLabel is supplied', () => {
    const { container } = render(
      <ArtifactDownloadLink
        slug="alice"
        artifactId="art-1"
        fileName="x.bin"
      />,
    );
    // No "(<size>)" suffix in the body when sizeLabel is absent.
    expect(container.textContent || '').not.toMatch(/\(\s*\d/);
  });

  it('uses a default accessible label that includes the filename', () => {
    const { container } = render(
      <ArtifactDownloadLink
        slug="alice"
        artifactId="art-1"
        fileName="report.bin"
      />,
    );
    const link = container.querySelector('a[href]');
    expect(link?.getAttribute('aria-label')).toMatch(/report\.bin/);
    expect(link?.textContent).toMatch(/Download report\.bin/);
  });

  it('honours a custom label when provided', () => {
    const { container } = render(
      <ArtifactDownloadLink
        slug="alice"
        artifactId="art-1"
        fileName="x.bin"
        label="Save the blob"
      />,
    );
    const link = container.querySelector('a[href]');
    expect(link?.textContent).toBe('Save the blob');
    expect(link?.getAttribute('aria-label')).toBe('Save the blob');
  });

  it('renders nothing when slug or artifactId is missing', () => {
    const { container: c1 } = render(
      <ArtifactDownloadLink slug="" artifactId="art-1" fileName="x.bin" />,
    );
    expect(c1.querySelector('a[href]')).toBeNull();
    expect(c1.querySelector('[data-artifact-preview]')).toBeNull();

    const { container: c2 } = render(
      <ArtifactDownloadLink slug="alice" artifactId="" fileName="x.bin" />,
    );
    expect(c2.querySelector('a[href]')).toBeNull();
    expect(c2.querySelector('[data-artifact-preview]')).toBeNull();
  });

  it('uses canonical shadcn theme tokens on the wrapper', () => {
    const { container } = render(
      <ArtifactDownloadLink
        slug="alice"
        artifactId="art-1"
        fileName="x.bin"
      />,
    );
    const wrapper = container.querySelector(
      '[data-artifact-preview="download"]',
    );
    const className = wrapper?.getAttribute('class') || '';
    expect(className).toMatch(/border-border/);
    expect(className).toMatch(/bg-card/);
    // No hardcoded slate-* utilities — keep the dashboard tokens canonical.
    expect(className).not.toMatch(/slate-/);
  });

  it('appends caller-supplied className without dropping defaults', () => {
    const { container } = render(
      <ArtifactDownloadLink
        slug="alice"
        artifactId="art-1"
        fileName="x.bin"
        className="my-custom-class"
      />,
    );
    const wrapper = container.querySelector(
      '[data-artifact-preview="download"]',
    );
    const className = wrapper?.getAttribute('class') || '';
    expect(className).toMatch(/my-custom-class/);
    expect(className).toMatch(/border-border/);
  });
});
