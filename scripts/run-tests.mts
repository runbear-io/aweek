#!/usr/bin/env node

/**
 * `pnpm test` / `pnpm test:verbose` — Node-version-agnostic test runner.
 *
 * The previous test command relied on `node --test` expanding glob patterns
 * passed as argv (`node --test "src/foo/**\/*.test.ts" ...`). That feature
 * only landed in Node 22, so the script silently broke on Node 20 (the LTS
 * baseline this project advertises via `engines.node`).
 *
 * This script enumerates the same set of test files via a small directory
 * walker (no extra deps), then spawns `node --import tsx --test` with
 * concrete file paths — which works on every Node 20+ version.
 *
 * Glob coverage parity with the prior `package.json` script:
 *   src/channels/**\/*.test.{js,ts}
 *   src/cli/**\/*.test.{js,ts}
 *   src/execution/**\/*.test.{js,ts}
 *   src/heartbeat/**\/*.test.{js,ts}
 *   src/lock/**\/*.test.{js,ts}
 *   src/models/**\/*.test.{js,ts}
 *   src/queue/**\/*.test.{js,ts}
 *   src/schemas/**\/*.test.{js,ts}
 *   src/services/**\/*.test.{js,ts}
 *   src/serve/data/**\/*.test.{js,ts}
 *   src/serve/*.test.{js,ts}                     (top level only)
 *   src/skills/**\/*.test.{js,ts}
 *   src/storage/**\/*.test.{js,ts}
 *   src/subagents/**\/*.test.{js,ts}
 *   src/time/**\/*.test.{js,ts}
 *   src/serve/spa/pages/pages.contract.test.{js,ts}
 *
 * Pass `--reporter=<name>` (alias: `--test-reporter=<name>`) to forward
 * a reporter to `node --test` — the verbose script uses `--reporter=spec`.
 */

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface DirSpec {
  /** Directory relative to ROOT. */
  dir: string;
  /** When true, walk subdirectories. When false, only the top level. */
  recursive: boolean;
}

interface ExactSpec {
  /** Directory relative to ROOT. */
  dir: string;
  /** Base name without the `.test.{js,ts}` suffix. */
  baseName: string;
}

const DIR_SPECS: DirSpec[] = [
  { dir: 'src/channels', recursive: true },
  { dir: 'src/cli', recursive: true },
  { dir: 'src/execution', recursive: true },
  { dir: 'src/heartbeat', recursive: true },
  { dir: 'src/lock', recursive: true },
  { dir: 'src/models', recursive: true },
  { dir: 'src/queue', recursive: true },
  { dir: 'src/schemas', recursive: true },
  { dir: 'src/services', recursive: true },
  { dir: 'src/serve/data', recursive: true },
  { dir: 'src/serve', recursive: false },
  { dir: 'src/skills', recursive: true },
  { dir: 'src/storage', recursive: true },
  { dir: 'src/subagents', recursive: true },
  { dir: 'src/time', recursive: true },
];

const EXACT_SPECS: ExactSpec[] = [
  { dir: 'src/serve/spa/pages', baseName: 'pages.contract' },
];

const TEST_FILE_RE = /\.test\.(?:js|ts)$/;

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function walk(dir: string, recursive: boolean): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        out.push(...(await walk(full, true)));
      }
      continue;
    }
    if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function collectTestFiles(): Promise<string[]> {
  const collected = new Set<string>();
  for (const spec of DIR_SPECS) {
    const files = await walk(resolve(ROOT, spec.dir), spec.recursive);
    for (const f of files) collected.add(f);
  }
  for (const spec of EXACT_SPECS) {
    for (const ext of ['js', 'ts']) {
      const candidate = resolve(ROOT, spec.dir, `${spec.baseName}.test.${ext}`);
      if (await pathExists(candidate)) collected.add(candidate);
    }
  }
  return [...collected].sort();
}

function parseReporter(argv: string[]): string | null {
  for (const arg of argv) {
    const m = arg.match(/^--(?:test-)?reporter=(.+)$/);
    if (m) return m[1] ?? null;
  }
  return null;
}

async function main(): Promise<void> {
  const reporter = parseReporter(process.argv.slice(2));
  const files = await collectTestFiles();
  if (files.length === 0) {
    console.error('run-tests: no test files matched the configured specs');
    process.exit(1);
  }

  const args = ['--import', 'tsx', '--test'];
  if (reporter) args.push(`--test-reporter=${reporter}`);
  args.push(...files);

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
  });
  child.once('error', (err) => {
    console.error(`run-tests: failed to spawn node --test: ${err.message}`);
    process.exit(1);
  });
  child.once('exit', (code, signal) => {
    if (signal) {
      // Preserve the signal exit semantics that `pnpm test` callers expect.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`run-tests: ${msg}`);
  process.exit(1);
});
