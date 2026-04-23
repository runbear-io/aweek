/**
 * Component tests for the shadcn/ui Breadcrumb primitive family (AC 3).
 *
 * Scope: render the primitives in isolation and assert the shadcn-style
 * contract — canonical data-attributes, native markup (`<nav>`, `<ol>`,
 * `<li>`), ARIA semantics (`aria-label="breadcrumb"`, `aria-current`),
 * and the `cn()`-driven `className` override slot. These tests protect
 * against accidental regressions when the underlying Tailwind tokens are
 * tweaked.
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Command: `pnpm test:spa`
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from './breadcrumb.jsx';

afterEach(() => {
  cleanup();
});

describe('Breadcrumb', () => {
  it('renders a <nav> landmark labelled "breadcrumb"', () => {
    const { container } = render(<Breadcrumb />);
    const nav = container.querySelector('[data-component="breadcrumb"]');
    expect(nav).not.toBeNull();
    expect(nav.tagName).toBe('NAV');
    expect(nav).toHaveAttribute('aria-label', 'breadcrumb');
  });

  it('forwards refs to the underlying DOM node', () => {
    const ref = React.createRef();
    render(<Breadcrumb ref={ref} />);
    expect(ref.current).not.toBeNull();
    expect(ref.current.tagName).toBe('NAV');
  });
});

describe('BreadcrumbList', () => {
  it('renders an <ol> with the canonical muted foreground chrome', () => {
    const { container } = render(<BreadcrumbList />);
    const list = container.querySelector('[data-component="breadcrumb-list"]');
    expect(list).not.toBeNull();
    expect(list.tagName).toBe('OL');
    expect(list.className).toContain('text-muted-foreground');
    expect(list.className).toContain('flex-wrap');
  });

  it('composes caller className last so overrides win', () => {
    const { container } = render(<BreadcrumbList className="gap-4" />);
    const list = container.querySelector('[data-component="breadcrumb-list"]');
    expect(list.className).toContain('gap-4');
  });
});

describe('BreadcrumbItem', () => {
  it('renders an <li> slot for a crumb', () => {
    const { container } = render(<BreadcrumbItem>Agents</BreadcrumbItem>);
    const item = container.querySelector('[data-component="breadcrumb-item"]');
    expect(item).not.toBeNull();
    expect(item.tagName).toBe('LI');
    expect(item).toHaveTextContent('Agents');
  });
});

describe('BreadcrumbLink', () => {
  it('renders a native <a> by default', () => {
    const { container } = render(
      <BreadcrumbLink href="/agents">Agents</BreadcrumbLink>,
    );
    const link = container.querySelector('[data-component="breadcrumb-link"]');
    expect(link).not.toBeNull();
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/agents');
    expect(link.className).toContain('hover:text-foreground');
  });

  it('delegates rendering via asChild (canonical shadcn Slot pattern)', () => {
    const { container } = render(
      <BreadcrumbLink asChild>
        <button type="button">Agents</button>
      </BreadcrumbLink>,
    );
    const link = container.querySelector('[data-component="breadcrumb-link"]');
    expect(link).not.toBeNull();
    expect(link.tagName).toBe('BUTTON');
    expect(link).toHaveTextContent('Agents');
  });
});

describe('BreadcrumbPage', () => {
  it('marks the current segment with aria-current="page"', () => {
    const { container } = render(<BreadcrumbPage>Calendar</BreadcrumbPage>);
    const page = container.querySelector('[data-component="breadcrumb-page"]');
    expect(page).not.toBeNull();
    expect(page.tagName).toBe('SPAN');
    expect(page).toHaveAttribute('aria-current', 'page');
    expect(page).toHaveAttribute('aria-disabled', 'true');
    expect(page).toHaveAttribute('role', 'link');
    expect(page.className).toContain('text-foreground');
  });
});

describe('BreadcrumbSeparator', () => {
  it('renders a presentational <li> with a chevron by default', () => {
    const { container } = render(<BreadcrumbSeparator />);
    const sep = container.querySelector(
      '[data-component="breadcrumb-separator"]',
    );
    expect(sep).not.toBeNull();
    expect(sep.tagName).toBe('LI');
    expect(sep).toHaveAttribute('role', 'presentation');
    expect(sep).toHaveAttribute('aria-hidden', 'true');
    expect(sep.querySelector('svg')).not.toBeNull();
  });

  it('honours a custom separator via children', () => {
    const { container } = render(<BreadcrumbSeparator>/</BreadcrumbSeparator>);
    const sep = container.querySelector(
      '[data-component="breadcrumb-separator"]',
    );
    expect(sep).toHaveTextContent('/');
  });
});

describe('BreadcrumbEllipsis', () => {
  it('renders a presentational overflow marker with an icon + sr-only label', () => {
    const { container } = render(<BreadcrumbEllipsis />);
    const dots = container.querySelector(
      '[data-component="breadcrumb-ellipsis"]',
    );
    expect(dots).not.toBeNull();
    expect(dots).toHaveAttribute('aria-hidden', 'true');
    expect(dots).toHaveTextContent(/more/i);
  });
});

describe('Breadcrumb composition', () => {
  it('assembles the canonical Agents → slug → tab trail', () => {
    render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/agents">Agents</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="/agents/alice">alice</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Calendar</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>,
    );

    const nav = screen.getByRole('navigation', { name: /breadcrumb/i });
    const list = within(nav).getByRole('list');
    const items = within(list).getAllByRole('listitem');
    // Separators carry role="presentation" per the shadcn contract, so
    // only the 3 BreadcrumbItem crumbs surface as listitems.
    expect(items).toHaveLength(3);
    // Presentational separators still live in the DOM as <li>s — assert
    // on the data-component hook so we confirm they were rendered.
    expect(
      list.querySelectorAll('[data-component="breadcrumb-separator"]').length,
    ).toBe(2);

    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent.trim())).toEqual([
      'Agents',
      'alice',
      'Calendar',
    ]);
    const current = within(nav).getByText('Calendar');
    expect(current).toHaveAttribute('aria-current', 'page');
  });
});
