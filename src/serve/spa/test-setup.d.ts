/**
 * Registers @testing-library/jest-dom matchers (toBeInTheDocument,
 * toHaveTextContent, toHaveAttribute, etc.) into Vitest's Assertion
 * interface so they type-check in *.test.tsx files.
 *
 * The runtime setup is handled by vitest.setup.js (which imports
 * '@testing-library/jest-dom/vitest'). This file provides the
 * corresponding TypeScript declarations for tsc / tsconfig.spa.json,
 * which only scans `src/serve/spa/**` and therefore doesn't see the
 * root-level vitest.setup.js.
 */
import '@testing-library/jest-dom/vitest';
