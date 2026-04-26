/**
 * Vitest config for the SPA-level component tests.
 *
 * The project's primary test runner is `node --test` for server/CLI
 * modules (see `pnpm test`). Vitest runs alongside it purely for the
 * React SPA under `src/serve/spa/` — these tests need a JSX transform
 * and a DOM, neither of which `node --test` provides.
 *
 * Scope:
 *   - Picks up `.test.jsx`, `.test.tsx`, and `.test.ts` files. The
 *     `.test.ts` extension was added during AC 403 (sub-AC 5.3) when
 *     `src/serve/spa/lib/api-client.js` was promoted to TypeScript —
 *     its colocated test (and the sibling `use-agents.test.ts`, which
 *     imports `api-client.js`) had to migrate from `node --test` to
 *     vitest because Node's ESM resolver can't follow `.js → .ts`
 *     transparently. Vitest's bundler-style resolver handles the
 *     indirection cleanly.
 *   - The legacy `.test.js` suite continues to run under `pnpm test`
 *     (`node --test`); none of those backend tests are routed through
 *     vitest.
 *   - `jsdom` environment so `@testing-library/react` can render.
 *   - Loads `./vitest.setup.js` for `jest-dom` matchers.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.js'],
    // Vitest only runs the SPA tree. The backend `*.test.ts` files
    // (execution/, heartbeat/, services/, …) use the `node:test` runner
    // and are launched by `pnpm test`. Without the `src/serve/spa/`
    // prefix here, vitest would import them and fail with "No test
    // suite found" because they don't call vitest's `describe/it`.
    include: [
      'src/serve/spa/**/*.test.jsx',
      'src/serve/spa/**/*.test.tsx',
      'src/serve/spa/**/*.test.ts',
    ],
  },
  // Vitest 4 uses `oxc` for JS/JSX transforms by default (not esbuild).
  // The automatic JSX runtime is the default in oxc, so no explicit
  // configuration is required — files import React directly where
  // they need `React.forwardRef` or equivalent.
});
