/**
 * shadcn/ui canonical utilities module.
 *
 * This file exists at the shadcn-reference path
 * (`@/lib/utils.js`) so primitives copied directly from the upstream
 * docs (including `scroll-area.jsx`) work without path edits. Its sole
 * export — `cn()` — is the Tailwind-aware class-name combiner shadcn
 * universally uses: `clsx` handles truthy/conditional composition and
 * `tailwind-merge` resolves conflicting utility classes (e.g. `px-2`
 * vs `px-4`) by letting the later class win in a Tailwind-aware way.
 *
 * The older `./cn.ts` helper is kept intact so the primitives that
 * already import from it continue to work unchanged. New primitives
 * (ScrollArea today, and future shadcn components) should import the
 * canonical `cn` from this module.
 *
 * Typed exports (Sub-AC 5.2):
 *   - `cn(...inputs: ClassValue[]): string` — the canonical class-name
 *     combiner. Input contract matches `clsx`'s `ClassValue` type so
 *     callers get the same compile-time guarantees as upstream shadcn.
 *   - `ClassValue` is re-exported as a type so call sites can pull
 *     `import type { ClassValue } from '@/lib/utils'` without reaching
 *     into the `clsx` package directly. Mirrors the abstraction
 *     boundary in the sibling `./cn.ts` helper.
 *
 * @module serve/spa/lib/utils
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Re-export so consumers can `import type { ClassValue } from '@/lib/utils'`
// without depending on `clsx` directly. Keeps the abstraction in one place
// if the underlying combiner is ever swapped.
export type { ClassValue };

/**
 * Combine class names with Tailwind-aware conflict resolution.
 *
 * Accepts the same input shapes as `clsx`:
 *   - strings / numbers / bigints
 *   - arrays (flattened recursively)
 *   - objects mapping `className` → boolean
 *   - falsy values (skipped)
 *
 * Late classes win over earlier conflicting utilities, matching the
 * cascade behaviour shadcn components rely on.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export default cn;
