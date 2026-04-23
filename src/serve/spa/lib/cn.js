/**
 * `cn` — minimal Tailwind class-name combiner.
 *
 * shadcn/ui primitives universally take a `className` prop and merge it
 * with their own base Tailwind classes. The canonical helper is
 * `clsx + tailwind-merge`, but until those peer deps land in
 * `package.json` (see the Seed task for frontend deps) we ship a
 * dependency-free substitute so the Table / Badge / etc. primitives
 * under `./components/ui/` can be authored in the usual shadcn style
 * today.
 *
 * Semantics:
 *   - Falsy entries (`null`, `undefined`, `false`, `''`) are skipped so
 *     conditional styles read naturally:
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

/**
 * Join class-name fragments into a single space-separated string.
 *
 * @param {...(string | number | false | null | undefined | Record<string, unknown> | Array<unknown>)} inputs
 * @returns {string}
 */
export function cn(...inputs) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    if (typeof v === 'string' || typeof v === 'number') {
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
