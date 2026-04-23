/**
 * `ThemeProvider` — light/dark theme controller backed by the shadcn
 * token set defined in `styles/globals.css` (AC 5).
 *
 * Behaviour:
 *   - Two concrete themes are supported: `'light'` and `'dark'`. Light is
 *     the default on first load — the server never sees the preference, so
 *     the provider resolves synchronously from `localStorage` before the
 *     first paint inside {@link getInitialTheme}.
 *   - The resolved theme is persisted to `localStorage` under
 *     {@link THEME_STORAGE_KEY} so a refresh picks up the last choice.
 *   - Mounting toggles the `.dark` class on `<html>` (shadcn convention,
 *     matching `darkMode: ["class"]` in `tailwind.config.js`). No `.light`
 *     class is required — the absence of `.dark` is what light mode means.
 *   - Context exposes `{ theme, setTheme, toggleTheme }` through
 *     {@link useTheme} for downstream consumers (e.g. the theme toggle
 *     button in the header).
 *
 * The provider is intentionally tiny (no external deps like `next-themes`)
 * because our runtime is a plain SPA — the simpler the provider, the
 * fewer edges to debug when hopping between `light` and `dark`.
 *
 * @module serve/spa/components/theme-provider
 */

import React from 'react';

/**
 * Canonical localStorage key for the persisted theme. Namespaced to
 * `aweek:` to match the sidebar's `aweek:sidebar:open` key and keep all
 * SPA-owned storage under a single prefix.
 */
export const THEME_STORAGE_KEY = 'aweek:theme';

/**
 * The two supported themes. A tuple (not a Set) so consumers can iterate
 * deterministically in tests.
 *
 * @type {ReadonlyArray<'light' | 'dark'>}
 */
export const THEMES = Object.freeze(['light', 'dark']);

/** Default theme on first load (light, per AC 5). */
export const DEFAULT_THEME = 'light';

/**
 * @typedef {'light' | 'dark'} Theme
 */

/**
 * @typedef {object} ThemeContextValue
 * @property {Theme} theme                 Current theme.
 * @property {(next: Theme) => void} setTheme   Set the theme explicitly.
 * @property {() => void} toggleTheme      Flip between light and dark.
 */

const ThemeContext = React.createContext(/** @type {ThemeContextValue | null} */ (null));

/**
 * Narrow an arbitrary value to a supported theme, falling back to
 * `DEFAULT_THEME` when the value is missing / malformed.
 *
 * @param {unknown} value
 * @returns {Theme}
 */
export function coerceTheme(value) {
  return value === 'dark' || value === 'light' ? value : DEFAULT_THEME;
}

/**
 * Resolve the initial theme synchronously. Prefers a previously
 * persisted value in `localStorage`; falls back to `DEFAULT_THEME` when
 * storage is unavailable (SSR, private mode) or the stored value is
 * unknown.
 *
 * @param {{ storage?: Pick<Storage, 'getItem'> | null, storageKey?: string }} [opts]
 * @returns {Theme}
 */
export function getInitialTheme({
  storage = typeof window === 'undefined' ? null : window.localStorage,
  storageKey = THEME_STORAGE_KEY,
} = {}) {
  if (!storage) return DEFAULT_THEME;
  try {
    const stored = storage.getItem(storageKey);
    return coerceTheme(stored);
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * Apply `theme` to `root` by toggling the `.dark` class. Idempotent.
 *
 * @param {Theme} theme
 * @param {HTMLElement | null | undefined} [root]
 */
export function applyThemeClass(theme, root) {
  const target =
    root ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (!target) return;
  if (theme === 'dark') {
    target.classList.add('dark');
  } else {
    target.classList.remove('dark');
  }
}

/**
 * Provider — wire once at the SPA entry point so all pages share the
 * same theme state.
 *
 * @param {{
 *   children?: React.ReactNode,
 *   defaultTheme?: Theme,
 *   storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
 *   storageKey?: string,
 * }} [props]
 */
export function ThemeProvider({
  children,
  defaultTheme,
  storage = typeof window === 'undefined' ? null : window.localStorage,
  storageKey = THEME_STORAGE_KEY,
} = {}) {
  const [theme, setThemeState] = React.useState(() => {
    if (defaultTheme) return coerceTheme(defaultTheme);
    return getInitialTheme({ storage, storageKey });
  });

  // Sync the `<html>` class whenever the theme changes. Runs on mount
  // too, so any stale class left by a previous session is corrected.
  React.useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  const setTheme = React.useCallback(
    (next) => {
      const resolved = coerceTheme(next);
      setThemeState(resolved);
      if (!storage) return;
      try {
        storage.setItem(storageKey, resolved);
      } catch {
        // Storage unavailable (quota / private mode). The in-memory
        // state still flips so the UI responds; persistence is a
        // best-effort concern.
      }
    },
    [storage, storageKey],
  );

  const toggleTheme = React.useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [setTheme, theme]);

  const value = React.useMemo(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Access the current theme + setters. Throws when used outside a
 * `ThemeProvider` so mis-wiring is loud.
 *
 * @returns {ThemeContextValue}
 */
export function useTheme() {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme() must be used inside a <ThemeProvider>.');
  }
  return ctx;
}

export default ThemeProvider;
