/**
 * Vitest config for the SPA-level component tests.
 *
 * The project's primary test runner is `node --test` for server/CLI
 * modules (see `pnpm test`). Vitest runs alongside it purely for the
 * React SPA under `src/serve/spa/` — these tests need a JSX transform
 * and a DOM, neither of which `node --test` provides.
 *
 * Scope:
 *   - Only picks up `.test.jsx` files so the existing `.test.js` suite
 *     under `node --test` keeps running untouched.
 *   - `jsdom` environment so `@testing-library/react` can render.
 *   - Loads `./vitest.setup.js` for `jest-dom` matchers.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.js'],
    include: ['src/**/*.test.jsx'],
  },
  // Vitest 4 uses `oxc` for JS/JSX transforms by default (not esbuild).
  // The automatic JSX runtime is the default in oxc, so no explicit
  // configuration is required — files import React directly where
  // they need `React.forwardRef` or equivalent.
});
