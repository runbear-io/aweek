/**
 * `cn` — minimal Tailwind class-name combiner.
 *
 * shadcn/ui primitives universally take a `className` prop and merge it
 * with their own base Tailwind classes. The canonical helper is
 * `clsx + tailwind-merge`; both are now in `package.json`, but this
 * module still ships a dependency-free implementation so the SPA can
 * boot without touching the conflict-resolution layer until a follow-up
 * swap. We do, however, reuse `clsx`'s `ClassValue` type so callers get
 * the same input contract they would from the canonical helper.
 *
 * Semantics:
 *   - Falsy entries (`null`, `undefined`, `false`, `''`, `0`) are
 *     skipped so conditional styles read naturally:
 *       cn('base', isActive && 'bg-emerald-500')
 *   - Arrays / nested arrays are flattened, matching clsx's behaviour.
 *   - Objects map key → value-as-boolean:
 *       cn({ 'text-red-500': hasError })
 *
 * Tailwind conflict resolution (e.g. `px-2` vs `px-4`) is intentionally
 * left to the caller for now; callers should order classes so later
 * entries win, as the browser's cascade already does for same-specificity
 * utility classes. A real `tailwind-merge` will be swapped in alongside
 * the rest of the shadcn deps in a follow-up.
 *
 * @module serve/spa/lib/cn
 */

import type { ClassValue } from 'clsx';

// Re-export so call sites can `import type { ClassValue } from '@/lib/cn'`
// without reaching into `clsx` directly. Keeps the abstraction boundary
// in one place if we ever swap implementations.
export type { ClassValue };

/**
 * Join class-name fragments into a single space-separated string.
 *
 * Accepts the full clsx `ClassValue` shape:
 *   - string | number | bigint
 *   - boolean | null | undefined  (all skipped)
 *   - Record<string, unknown>     (key included when value is truthy)
 *   - ClassValue[]                (recursively flattened)
 */
export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const push = (v: ClassValue): void => {
    if (!v) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') {
      out.push(String(v));
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) push(item);
      return;
    }
    if (typeof v === 'object') {
      for (const [key, enabled] of Object.entries(v)) {
        if (enabled) out.push(key);
      }
    }
  };
  for (const input of inputs) push(input);
  return out.join(' ');
}

export default cn;
