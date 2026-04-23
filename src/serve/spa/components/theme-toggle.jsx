/**
 * `ThemeToggle` — icon button that flips between light and dark mode.
 *
 * Uses the stock shadcn `Button` primitive (size `icon`, variant
 * `ghost`) + lucide `Sun` / `Moon` icons. All colors resolve via token
 * utilities (`text-foreground`, `bg-accent`, …) so the control itself
 * re-themes for free when `useTheme().setTheme(...)` toggles the `.dark`
 * class on `<html>`.
 *
 * The icon swap is driven by CSS (`hidden dark:block` / `block
 * dark:hidden`) rather than JS state so the render tree is identical
 * across themes — avoiding hydration skew and keeping the button a pure
 * read of `useTheme().theme`.
 *
 * @module serve/spa/components/theme-toggle
 */

import React from 'react';
import { Moon, Sun } from 'lucide-react';

import { Button } from './ui/button.jsx';
import { useTheme } from './theme-provider.jsx';

/**
 * Icon-only toggle. Relies on the surrounding `ThemeProvider` for state.
 *
 * @param {{ className?: string }} [props]
 */
export function ThemeToggle({ className } = {}) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      data-component="theme-toggle"
      data-theme={theme}
      aria-label={label}
      title={label}
      onClick={toggleTheme}
    >
      <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" aria-hidden="true" />
      <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </Button>
  );
}

export default ThemeToggle;
