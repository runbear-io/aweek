/**
 * Tests for {@link ThemeToggle} (AC 5).
 *
 * Coverage:
 *   - Renders as a stock shadcn button with size `icon`.
 *   - `aria-label` + `data-theme` reflect the current theme.
 *   - Clicking toggles the theme, the persisted value, and the `.dark`
 *     class on `<html>`.
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { ThemeToggle } from './theme-toggle.tsx';
import {
  THEME_STORAGE_KEY,
  ThemeProvider,
} from './theme-provider.jsx';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
});

function renderWithProvider(ui: React.ReactNode, { defaultTheme }: { defaultTheme?: 'light' | 'dark' } = {}) {
  return render(
    <ThemeProvider defaultTheme={defaultTheme}>{ui}</ThemeProvider>,
  );
}

describe('ThemeToggle', () => {
  it('renders as a shadcn icon button', () => {
    const { container } = renderWithProvider(<ThemeToggle />);
    const btn = container.querySelector('[data-component="theme-toggle"]');
    expect(btn).not.toBeNull();
    expect(btn!.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('data-component', 'theme-toggle');
    // The underlying Button forwards its own data-attrs.
    expect(btn).toHaveAttribute('data-size', 'icon');
    expect(btn).toHaveAttribute('data-variant', 'ghost');
  });

  it('exposes the current theme via aria-label and data-theme (light)', () => {
    const { container } = renderWithProvider(<ThemeToggle />);
    const btn = container.querySelector('[data-component="theme-toggle"]');
    expect(btn).toHaveAttribute('data-theme', 'light');
    expect(btn).toHaveAttribute('aria-label', 'Switch to dark theme');
  });

  it('exposes the current theme via aria-label and data-theme (dark)', () => {
    const { container } = renderWithProvider(<ThemeToggle />, {
      defaultTheme: 'dark',
    });
    const btn = container.querySelector('[data-component="theme-toggle"]');
    expect(btn).toHaveAttribute('data-theme', 'dark');
    expect(btn).toHaveAttribute('aria-label', 'Switch to light theme');
  });

  it('toggles theme on click — persists and updates the html class', () => {
    const { container } = renderWithProvider(<ThemeToggle />);
    const btn = container.querySelector('[data-component="theme-toggle"]');

    // Starts light.
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    fireEvent.click(btn!);
    expect(btn).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    fireEvent.click(btn!);
    expect(btn).toHaveAttribute('data-theme', 'light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('applies the caller-supplied className without discarding button classes', () => {
    const { container } = renderWithProvider(
      <ThemeToggle className="custom-class" />,
    );
    const btn = container.querySelector('[data-component="theme-toggle"]');
    expect(btn!.className).toMatch(/custom-class/);
    // The ghost variant contributes `hover:bg-accent`; confirm the CVA
    // output survived the merge.
    expect(btn!.className).toMatch(/hover:bg-accent/);
  });

  it('renders both sun and moon icons so the swap is CSS-only', () => {
    const { container } = renderWithProvider(<ThemeToggle />);
    const icons = container.querySelectorAll('[data-component="theme-toggle"] svg');
    expect(icons.length).toBe(2);
  });
});
