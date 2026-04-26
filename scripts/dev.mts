#!/usr/bin/env node
/**
 * `pnpm dev` — launch the aweek Express backend and the Vite SPA dev
 * server together so HMR works against live `.aweek/` data.
 *
 * Usage:
 *   pnpm dev [-- --project-dir <path>] [--api-port <n>]
 *
 * Flags (all optional):
 *   --project-dir <path>  Forwarded to `aweek serve`. Defaults to cwd.
 *   --api-port <n>        Port the backend binds. Default 3000. Also
 *                         exported as AWEEK_API_TARGET so Vite's proxy
 *                         picks it up.
 *   --vite-port <n>       Port Vite dev serves on. Default 5173.
 *
 * The script spawns both child processes, prefixes their stdout so you
 * can tell which is which, and tears them both down on SIGINT/SIGTERM.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface DevArgs {
  projectDir: string;
  apiPort: number;
  vitePort: number;
}

function parseArgs(argv: string[]): DevArgs {
  const out: DevArgs = { projectDir: process.cwd(), apiPort: 3000, vitePort: 5173 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '--project-dir' || a === '--cwd') && argv[i + 1]) {
      out.projectDir = resolve(argv[++i]);
    } else if (a === '--api-port' && argv[i + 1]) {
      out.apiPort = Number(argv[++i]);
    } else if (a === '--vite-port' && argv[i + 1]) {
      out.vitePort = Number(argv[++i]);
    } else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: pnpm dev [-- --project-dir <path>] [--api-port <n>] [--vite-port <n>]',
      );
      process.exit(0);
    }
  }
  return out;
}

function prefix(name: string, color: string): (line: string) => string {
  const reset = '\x1b[0m';
  return (line: string) => `${color}[${name}]${reset} ${line}`;
}

function pipe(
  child: ChildProcessWithoutNullStreams,
  tag: string,
  color: string,
): void {
  const fmt = prefix(tag, color);
  const forward = (chunk: Buffer | string): void => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line) process.stdout.write(`${fmt(line)}\n`);
    }
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
}

const { projectDir, apiPort, vitePort } = parseArgs(process.argv.slice(2));

// `--import tsx` registers the tsx ESM loader for the child Node
// process so `bin/aweek.js` can resolve `.js` import paths that
// have been migrated to `.ts` source (e.g. `src/heartbeat/run.js` →
// `run.ts`). Drop this flag once the dist/ build pipeline ships a
// pre-compiled `dist/bin/aweek.js`.
const backend = spawn(
  process.execPath,
  [
    '--import',
    'tsx',
    resolve(ROOT, 'bin/aweek.ts'),
    'serve',
    '--port',
    String(apiPort),
    '--host',
    '127.0.0.1',
    '--no-open',
    '--project-dir',
    projectDir,
  ],
  {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
pipe(backend, 'api', '\x1b[36m');

const vite = spawn(
  'pnpm',
  ['exec', 'vite', '--config', 'vite.config.js', '--port', String(vitePort)],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      AWEEK_API_TARGET: `http://127.0.0.1:${apiPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
pipe(vite, 'spa', '\x1b[35m');

console.log(
  `aweek dev · api=:${apiPort} · spa=:${vitePort} · project-dir=${projectDir}`,
);

let shuttingDown = false;
function shutdown(signal?: NodeJS.Signals | string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of [backend, vite]) {
    if (!child.killed) child.kill((signal as NodeJS.Signals) || 'SIGTERM');
  }
  setTimeout(() => process.exit(0), 500).unref();
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => shutdown(sig));
}

function onChildExit(name: string): (code: number | null) => void {
  return (code: number | null) => {
    if (shuttingDown) return;
    console.error(`\n[dev] ${name} exited (code ${code}). Shutting down.`);
    shutdown('SIGTERM');
  };
}

backend.on('exit', onChildExit('api'));
vite.on('exit', onChildExit('spa'));
