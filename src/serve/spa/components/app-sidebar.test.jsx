/**
 * Component tests for the `AppSidebar` composition (AC 2).
 *
 * Asserts:
 *   - Exactly one top-level navigation entry (`/agents`) is rendered.
 *   - The Agents entry is active on `/agents` and on nested routes
 *     (`/agents/:slug`, `/agents/:slug/:tab`) but not on unrelated
 *     paths.
 *   - The entry renders as a real `<a>` link (via `asChild`) pointing
 *     at `/agents` so hard reloads + "open in new tab" work natively.
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { SidebarProvider } from './ui/sidebar.jsx';
import { ThemeProvider } from './theme-provider.jsx';
import { APP_NAV_ITEMS, AppSidebar, isAppNavItemActive } from './app-sidebar.jsx';

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  document.documentElement.classList.remove('dark');
});

/**
 * Render `<AppSidebar />` inside the required context
 * (`ThemeProvider` + `SidebarProvider` + `MemoryRouter`) at a specific
 * initial URL.
 */
function renderAt(pathname) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <ThemeProvider>
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('APP_NAV_ITEMS', () => {
  it('contains exactly one entry — /agents', () => {
    expect(APP_NAV_ITEMS).toHaveLength(1);
    expect(APP_NAV_ITEMS[0]).toMatchObject({ to: '/agents', label: 'Agents' });
  });
});

describe('isAppNavItemActive', () => {
  it('matches exact + prefix paths and ignores unrelated paths', () => {
    const [agents] = APP_NAV_ITEMS;
    expect(isAppNavItemActive(agents, '/agents')).toBe(true);
    expect(isAppNavItemActive(agents, '/agents/abc')).toBe(true);
    expect(isAppNavItemActive(agents, '/agents/abc/profile')).toBe(true);
    expect(isAppNavItemActive(agents, '/')).toBe(false);
    expect(isAppNavItemActive(agents, '/calendar')).toBe(false);
    expect(isAppNavItemActive(null, '/agents')).toBe(false);
    expect(isAppNavItemActive(agents, null)).toBe(false);
  });
});

describe('AppSidebar', () => {
  it('renders the canonical sidebar primitive markup', () => {
    const { container } = renderAt('/agents');
    expect(container.querySelector('[data-component="app-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-component="sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-component="sidebar-header"]')).not.toBeNull();
    expect(container.querySelector('[data-component="sidebar-content"]')).not.toBeNull();
    expect(container.querySelector('[data-component="sidebar-footer"]')).not.toBeNull();
  });

  it('renders a single /agents menu entry as a real <a> link', () => {
    const { container } = renderAt('/agents');
    const items = container.querySelectorAll(
      '[data-component="sidebar-menu-item"]',
    );
    expect(items).toHaveLength(1);
    const link = container.querySelector(
      '[data-component="sidebar-menu-button"]',
    );
    expect(link).not.toBeNull();
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/agents');
    expect(link).toHaveAttribute('data-nav-item', '/agents');
    expect(link).toHaveTextContent('Agents');
  });

  it('marks /agents as active on the Overview route', () => {
    const { container } = renderAt('/agents');
    const link = container.querySelector(
      '[data-component="sidebar-menu-button"]',
    );
    expect(link).toHaveAttribute('data-active', 'true');
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('keeps /agents active on nested routes', () => {
    const { container } = renderAt('/agents/example-slug/profile');
    const link = container.querySelector(
      '[data-component="sidebar-menu-button"]',
    );
    expect(link).toHaveAttribute('data-active', 'true');
  });

  it('is inactive on unrelated paths', () => {
    const { container } = renderAt('/');
    const link = container.querySelector(
      '[data-component="sidebar-menu-button"]',
    );
    expect(link).toHaveAttribute('data-active', 'false');
    expect(link).not.toHaveAttribute('aria-current');
  });

  it('renders the canonical shadcn Mode Toggle inside SidebarFooter (AC 4)', () => {
    const { container } = renderAt('/agents');
    const footer = container.querySelector(
      '[data-component="sidebar-footer"]',
    );
    expect(footer).not.toBeNull();
    const toggle = footer.querySelector('[data-component="theme-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle.tagName).toBe('BUTTON');
    // Canonical shadcn Mode Toggle recipe: icon-sized ghost button.
    expect(toggle).toHaveAttribute('data-size', 'icon');
    expect(toggle).toHaveAttribute('data-variant', 'ghost');
  });
});
