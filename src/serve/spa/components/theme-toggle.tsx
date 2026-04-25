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

import * as React from 'react';
import { Moon, Sun } from 'lucide-react';

import * as ButtonModule from './ui/button.jsx';
import { useTheme } from './theme-provider.jsx';

// ── Cross-boundary shim for the still-`.jsx` shadcn/ui Button ───────
//
// `components/ui/button.jsx` is excluded from `tsconfig.spa.json` per
// the migration plan (shadcn primitives stay `.jsx` for this phase),
// so TypeScript can't recover the prop types from the `forwardRef`
// declaration. Re-alias the import to a permissive `ComponentType`
// that mirrors the JSDoc surface in `button.jsx`. Once the primitive
// is converted in a later sub-AC, this cast can be deleted and the
// real types take over.
type ButtonVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'ghost'
  | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
};

const Button = ButtonModule.Button as React.ComponentType<ButtonProps>;

export interface ThemeToggleProps {
  /** Optional class name forwarded to the underlying `<Button>`. */
  className?: string;
}

/**
 * Icon-only toggle. Relies on the surrounding `ThemeProvider` for state.
 *
 * `useTheme()` returns the typed context value `{ theme, setTheme,
 * toggleTheme }` declared by the JSDoc on `theme-provider.jsx`. The
 * `onClick` handler is a `MouseEventHandler<HTMLButtonElement>`-compatible
 * wrapper around `toggleTheme` — wrapping (rather than passing the
 * setter directly) makes the React-event signature explicit and ignores
 * the unused event argument cleanly.
 */
export function ThemeToggle({ className }: ThemeToggleProps = {}): React.JSX.Element {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  const handleClick: React.MouseEventHandler<HTMLButtonElement> = () => {
    toggleTheme();
  };
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
      onClick={handleClick}
    >
      <Sun
        className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0"
        aria-hidden="true"
      />
      <Moon
        className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
    </Button>
  );
}

export default ThemeToggle;
