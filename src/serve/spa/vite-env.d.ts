// ---------------------------------------------------------------------------
// vite-env.d.ts
//
// Ambient type declarations for the SPA tree. Picked up automatically by
// `tsconfig.spa.json` via its `include` glob. Keep this file scoped to
// SPA-wide ambient typings only — module-specific types belong next to
// the source they describe.
// ---------------------------------------------------------------------------

// Side-effect CSS imports (e.g. `import './styles/globals.css'` in
// `main.tsx`) are processed by Vite at build time and resolve to a
// runtime stylesheet injection. They have no JS export surface, so the
// import statement is a side-effect-only form. This declaration tells
// TypeScript the module exists so `tsc --noEmit` doesn't flag it as
// `TS2882: Cannot find module …`. Mirrors the canonical Vite + TS
// starter (`vite-env.d.ts`) that ships with `pnpm create vite`.
declare module '*.css';

// Vitest's `expect` is augmented with `@testing-library/jest-dom` matchers
// (`toBeInTheDocument`, `toHaveAttribute`, `toHaveTextContent`, etc.) at
// runtime by `vitest.setup.js`. The reference below pulls in the
// matching ambient module augmentation so the SPA's `*.test.tsx` files
// type-check those matchers under `tsc --noEmit`. AC 4: required by the
// `.test.jsx → .test.tsx` co-conversion alongside the SPA components.
/// <reference types="@testing-library/jest-dom" />
