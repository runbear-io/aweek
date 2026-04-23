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
 * The older `./cn.js` helper is kept intact so the primitives that
 * already import from it continue to work unchanged. New primitives
 * (ScrollArea today, and future shadcn components) should import the
 * canonical `cn` from this module.
 *
 * @module serve/spa/lib/utils
 */

import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Combine class names with Tailwind-aware conflict resolution.
 *
 * Accepts the same input shapes as `clsx`:
 *   - strings / numbers
 *   - arrays (flattened recursively)
 *   - objects mapping `className` → boolean
 *   - falsy values (skipped)
 *
 * Late classes win over earlier conflicting utilities, matching the
 * cascade behaviour shadcn components rely on.
 *
 * @param {...(string | number | false | null | undefined | Record<string, unknown> | Array<unknown>)} inputs
 * @returns {string}
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export default cn;
