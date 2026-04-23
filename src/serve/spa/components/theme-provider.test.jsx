/**
 * Tests for {@link ThemeProvider}, {@link useTheme}, and the pure
 * helpers {@link coerceTheme}, {@link getInitialTheme},
 * {@link applyThemeClass} (AC 5).
 *
 * Coverage:
 *   - Default theme is `light` on first load (no stored value).
 *   - A persisted value in `localStorage` is honoured on mount.
 *   - `setTheme(...)` and `toggleTheme()` update state, the `<html>`
 *     class, and the `localStorage` entry.
 *   - `useTheme` throws outside a provider.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';

import {
  DEFAULT_THEME,
  THEMES,
  THEME_STORAGE_KEY,
  ThemeProvider,
  applyThemeClass,
  coerceTheme,
  getInitialTheme,
  useTheme,
} from './theme-provider.jsx';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('THEMES constant', () => {
  it('exposes exactly light + dark in order', () => {
    expect(THEMES).toEqual(['light', 'dark']);
  });
});

describe('coerceTheme', () => {
  it('returns the supplied theme when valid', () => {
    expect(coerceTheme('light')).toBe('light');
    expect(coerceTheme('dark')).toBe('dark');
  });

  it('falls back to the default theme for unknown values', () => {
    expect(coerceTheme(null)).toBe(DEFAULT_THEME);
    expect(coerceTheme(undefined)).toBe(DEFAULT_THEME);
    expect(coerceTheme('')).toBe(DEFAULT_THEME);
    expect(coerceTheme('system')).toBe(DEFAULT_THEME);
    expect(coerceTheme(42)).toBe(DEFAULT_THEME);
  });
});

describe('getInitialTheme', () => {
  it('prefers the persisted value', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(getInitialTheme()).toBe('dark');
  });

  it('defaults to light when nothing is persisted', () => {
    expect(getInitialTheme()).toBe('light');
  });

  it('returns the default theme when storage is missing', () => {
    expect(getInitialTheme({ storage: null })).toBe(DEFAULT_THEME);
  });

  it('returns the default theme when storage throws', () => {
    const storage = {
      getItem() {
        throw new Error('boom');
      },
    };
    expect(getInitialTheme({ storage })).toBe(DEFAULT_THEME);
  });
});

describe('applyThemeClass', () => {
  it('adds the dark class for dark and removes it for light', () => {
    const root = document.createElement('html');
    applyThemeClass('dark', root);
    expect(root.classList.contains('dark')).toBe(true);
    applyThemeClass('light', root);
    expect(root.classList.contains('dark')).toBe(false);
  });

  it('is idempotent', () => {
    const root = document.createElement('html');
    applyThemeClass('dark', root);
    applyThemeClass('dark', root);
    expect(root.classList.length).toBe(1);
  });

  it('targets document.documentElement by default', () => {
    applyThemeClass('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    applyThemeClass('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('ThemeProvider + useTheme', () => {
  function wrapper({ children }) {
    return <ThemeProvider>{children}</ThemeProvider>;
  }

  it('defaults to light on first load when nothing is persisted', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('honours a previously persisted dark theme', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('setTheme persists and applies the class', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setTheme('dark'));
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    act(() => result.current.setTheme('light'));
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('setTheme ignores unknown values and falls back to the default', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setTheme('sepia'));
    expect(result.current.theme).toBe(DEFAULT_THEME);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(DEFAULT_THEME);
  });

  it('toggleTheme flips between light and dark', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('light');
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('dark');
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('light');
  });

  it('survives a storage quota error without losing in-memory state', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    function throwingWrapper({ children }) {
      return <ThemeProvider storage={storage}>{children}</ThemeProvider>;
    }
    const { result } = renderHook(() => useTheme(), {
      wrapper: throwingWrapper,
    });
    act(() => result.current.setTheme('dark'));
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('accepts a defaultTheme override', () => {
    function darkWrapper({ children }) {
      return <ThemeProvider defaultTheme="dark">{children}</ThemeProvider>;
    }
    const { result } = renderHook(() => useTheme(), { wrapper: darkWrapper });
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

describe('useTheme outside a provider', () => {
  it('throws a descriptive error', () => {
    expect(() => renderHook(() => useTheme())).toThrow(/ThemeProvider/);
  });
});

describe('ThemeProvider rendering', () => {
  it('renders children', () => {
    const { getByText } = render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );
    expect(getByText('child')).toBeInTheDocument();
  });
});
