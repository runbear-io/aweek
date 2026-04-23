/**
 * Vite configuration for the aweek SPA.
 *
 * The SPA source lives under `src/serve/spa/` (pages, components, hooks,
 * lib). This config wires Vite's dev server + production bundler at that
 * directory so the Express-based `aweek serve` command can serve the
 * compiled assets from `src/serve/spa/dist/` in production.
 *
 * Scope (AC 6):
 *   - `root` points at the SPA source directory so Vite looks for
 *     `index.html` next to the React tree rather than at the repo root.
 *   - `build.outDir` resolves to `src/serve/spa/dist/` (relative to `root`)
 *     so the server's static-file handler can find the bundle without an
 *     extra env var or flag. Emptied on every rebuild to avoid stale
 *     hashed chunks.
 *   - `server` enables HMR on a dedicated Vite port with `host: true`
 *     so the dev server is reachable on the LAN (parity with the
 *     `aweek serve --host 0.0.0.0` default).
 *   - `resolve.alias['@']` maps to `src/serve/spa/` so shadcn-style
 *     `@/components/ui/*` imports work without fragile relative paths.
 *   - `esbuild.jsx = 'automatic'` is the React 17+ runtime — this is
 *     sufficient for the SPA tree (no class-component-era features
 *     that would need `@vitejs/plugin-react`'s Fast Refresh hooks).
 *     Vitest picks up its own oxc-based JSX transform via
 *     `vitest.config.js`, so this block only affects `vite dev` /
 *     `vite build`.
 *
 * This file is the canonical source of the SPA's build contract — the
 * Express server in `src/serve/server.js` reads compiled assets from
 * `build.outDir` via `resolveDefaultBuildDir()` (or the equivalent
 * path resolution logic once that server is updated to point at
 * `src/serve/spa/dist/` in a sibling AC).
 */

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const spaRoot = fileURLToPath(new URL('./src/serve/spa/', import.meta.url));

export default defineConfig({
  // Anchor Vite at the SPA source tree. `index.html` is the conventional
  // entry point Vite looks for inside `root`; a sibling AC adds it.
  root: spaRoot,

  // SPA is served from the application root URL in production (`/`), and
  // the dev server proxies identically so relative asset URLs resolve
  // the same way in both environments.
  base: '/',

  build: {
    // `outDir` is resolved relative to `root`, so this produces
    // `src/serve/spa/dist/` — the path the Express server serves from.
    outDir: 'dist',
    // Wipe the previous bundle on every build to prevent stale hashed
    // chunks (e.g. `assets/index-<hash>.js`) from accumulating between
    // releases. Without this, `src/serve/spa/dist/assets/` would grow
    // unbounded across repeated `pnpm build` runs.
    emptyOutDir: true,
    // Emit source maps so stack traces from the deployed SPA remain
    // debuggable. Hashed chunks keep the map files cacheable alongside
    // the JS they describe.
    sourcemap: true,
    // Target modern evergreen browsers — matches Vite 6 defaults but
    // pinned here explicitly so a Vite upgrade doesn't silently shift
    // the baseline.
    target: 'es2020',
    rollupOptions: {
      // The HTML entry point is `src/serve/spa/index.html` (added by a
      // sibling AC). Declaring it explicitly keeps the build resilient
      // to future root relocations.
      input: fileURLToPath(new URL('./src/serve/spa/index.html', import.meta.url)),
    },
  },

  server: {
    // Dedicated port for the Vite dev server so it doesn't collide with
    // `aweek serve`'s default 3000. `strictPort: false` (Vite default)
    // means Vite auto-increments on conflict, matching the Express
    // server's `PORT_SCAN_LIMIT` behaviour.
    port: 5173,
    // Bind on every interface (parity with `aweek serve --host 0.0.0.0`)
    // so the dev server is reachable from a phone/tablet on the LAN.
    host: true,
    // Explicit HMR config — Vite enables HMR by default, but pinning it
    // here makes the behaviour discoverable and future-proofs the file
    // against a Vite default change.
    hmr: true,
    // Proxy `/api/*` to the Express server running via `aweek serve`
    // (defaults to `http://127.0.0.1:3000`). This lets the SPA hit the
    // same-origin URLs it will use in production (`/api/agents`,
    // `/api/agents/:slug/plan`, ...) while Vite owns routing/HMR for the
    // client shell. `changeOrigin` rewrites the `Host` header so the
    // Express server sees the proxy target as its origin, avoiding
    // surprises with host-based logic. The target is overridable via
    // `AWEEK_API_TARGET` for non-default ports (e.g. when the API was
    // auto-incremented through `PORT_SCAN_LIMIT`).
    proxy: {
      '/api': {
        target: process.env.AWEEK_API_TARGET || 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },

  resolve: {
    alias: {
      // shadcn/ui primitives (see `src/serve/spa/components/ui/*`) use
      // `@/lib/cn` and `@/components/ui/*` import paths. Mapping `@` to
      // the SPA root keeps those imports portable if files are moved
      // within the tree.
      '@': spaRoot,
    },
  },

  esbuild: {
    // React 17+ automatic runtime — lets components omit `import React`
    // for plain JSX. The SPA already mixes automatic-style tags with
    // explicit `React.forwardRef` imports where needed, so this is safe.
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
});
