// -----------------------------------------------------------------------
// summary.d.ts — cross-boundary type shim for the SPA migration phase.
//
// Why this file exists
// --------------------
// The SPA → TypeScript migration (`tsconfig.spa.json`) converts only the
// browser tree under `src/serve/spa/` to `.ts`/`.tsx`. Backend modules in
// `src/skills/`, `src/storage/`, etc. stay raw `.js` for this phase.
//
// One SPA test — `src/serve/spa/pages/agents-page.test.tsx` — imports
// three pure render-helpers from this backend module to verify *parity*
// between the React Overview table and the terminal `summary` skill that
// powers `/aweek:summary`. Without type information, that import would
// fail strict `tsc --noEmit` against `tsconfig.spa.json`:
//
//   import { formatTasksCell, formatBudgetCell, stateLabel }
//     from '../../../skills/summary.js';
//
// Because `src/skills/` lives outside the SPA tsconfig's `include` glob,
// TypeScript would treat the import as untyped and (under strict mode)
// raise a declaration-file error.
//
// What this shim does
// -------------------
// Declares **only the three functions the SPA actually consumes**, with
// the precise call signatures the test uses. TypeScript's module
// resolution prefers a sibling `.d.ts` over a `.js` of the same basename,
// so this file becomes the source of truth for type info at SPA build
// time. The runtime behavior continues to come from `summary.js`; this
// file emits zero runtime output.
//
// Scope discipline
// ----------------
// - This is a **partial shim**, not a full type declaration for
//   `summary.js`. Other backend code (also `.js`) doesn't consume types
//   yet — it doesn't run through `tsc` at all in this phase.
// - If a future SPA file imports another export from `summary.js`, add
//   the matching declaration here rather than widening the file with
//   speculative types.
// - When the migration's later phase converts `src/skills/summary.js`
//   itself to TypeScript (or turns on `checkJs` for backend code), this
//   shim should be deleted in the same change so there is exactly one
//   source of truth.
//
// Cross-references
// ----------------
// - Migration plan note on shims: `tsconfig.spa.json` header comment.
// - Consumer: `src/serve/spa/pages/agents-page.test.tsx`.
// - Runtime implementation: `src/skills/summary.js` (same directory).
// -----------------------------------------------------------------------

/**
 * Short uppercase status label used in the terminal `Status` column and
 * the SPA Overview row. Mirrors `summary.js#stateLabel`. Unknown states
 * fall back to the upper-cased form of the input (or `'UNKNOWN'`), so
 * the parameter is intentionally widened to accept any incoming string.
 *
 * @example
 *   stateLabel('active')           // 'ACTIVE'
 *   stateLabel('budget-exhausted') // 'BUDGET-EXHAUSTED'
 *   stateLabel(undefined)          // 'UNKNOWN'
 */
export function stateLabel(state: string | null | undefined): string;

/**
 * Render the per-week tasks cell ("<completed>/<total>" or em-dash when
 * there are no tasks). Mirrors `summary.js#formatTasksCell`.
 *
 * `byStatus` is a free-form bucket map; the function only reads
 * `byStatus.completed`, but other status keys may also be present in the
 * incoming payload.
 *
 * @example
 *   formatTasksCell({ total: 5, byStatus: { completed: 2 } })  // '2/5'
 *   formatTasksCell({ total: 0, byStatus: {} })                // '—'
 *   formatTasksCell(null)                                       // '—'
 */
export function formatTasksCell(
  tasks:
    | {
        total: number;
        byStatus?: Record<string, number>;
      }
    | null
    | undefined
): string;

/**
 * Render the per-week budget cell ("<used> / <limit> (<pct>%)" or
 * the literal `'no limit'` when no weekly token cap is configured).
 * Mirrors `summary.js#formatBudgetCell`.
 *
 * @example
 *   formatBudgetCell(
 *     { weeklyTokenLimit: 100000, utilizationPct: 25 },
 *     { totalTokens: 25000 },
 *   )                                                  // '25,000 / 100,000 (25%)'
 *   formatBudgetCell({ weeklyTokenLimit: 0 }, {})      // 'no limit'
 *   formatBudgetCell(null, null)                        // 'no limit'
 */
export function formatBudgetCell(
  budget:
    | {
        weeklyTokenLimit?: number;
        utilizationPct?: number;
      }
    | null
    | undefined,
  usage:
    | {
        totalTokens?: number;
      }
    | null
    | undefined
): string;
