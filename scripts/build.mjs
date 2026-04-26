#!/usr/bin/env node

/**
 * `pnpm build` — produce the publishable `dist/` tarball:
 *
 *   1. Wipe any previous `dist/` so stale `.js` from a removed `.ts`
 *      doesn't end up in the published tarball.
 *   2. Compile `bin/` + `src/` (excluding tests + the SPA tree) via
 *      `tsc -p tsconfig.build.json` → `dist/src/...` and `dist/bin/...`.
 *   3. Build the React SPA via `vite build` → `src/serve/spa/dist/`,
 *      then copy that bundle into `dist/src/serve/spa/dist/` so the
 *      compiled `dist/src/serve/server.js` finds it via the same
 *      relative path it uses today (`./spa/dist/` from server.js).
 *   4. Restore the executable bit on `dist/bin/aweek.js` (tsc emits
 *      with mode 0644 even when the source was 0755).
 *
 * Each step shells out to a child process so the pnpm hooks for `tsc`
 * and `vite` resolve through pnpm's local bin shim — mirrors what the
 * old single-line `build` script did.
 */

import { spawn } from 'node:child_process';
import { rm, cp, chmod, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const VITE_OUT = resolve(ROOT, 'src/serve/spa/dist');
const SPA_TARGET = resolve(DIST, 'src/serve/spa/dist');
const BIN_TARGET = resolve(DIST, 'bin/aweek.js');

function run(cmd, args, { tolerateExitCode = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code) => {
      if (code === 0 || tolerateExitCode) resolveRun();
      else rejectRun(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function main() {
  await rm(DIST, { recursive: true, force: true });
  // `tsc -p tsconfig.build.json` is wider than `tsconfig.node.json` —
  // it picks up the five heartbeat files temporarily excluded from the
  // type-check pass so they get emitted into `dist/`. Those files have
  // unresolved type errors (signature drift against still-`.js`
  // collaborators) but their JavaScript output is runtime-correct, and
  // `noEmitOnError: false` in tsconfig.build.json makes tsc emit even
  // when it reports errors. We tolerate the non-zero exit code here
  // and let the type-check gate (`pnpm typecheck`) catch real
  // regressions on the strict-scope set.
  await run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
    tolerateExitCode: true,
  });
  await run('pnpm', ['exec', 'vite', 'build', '--config', 'vite.config.js']);
  await mkdir(dirname(SPA_TARGET), { recursive: true });
  await cp(VITE_OUT, SPA_TARGET, { recursive: true });
  await chmod(BIN_TARGET, 0o755);
  // Sanity probe: a missing or unparseable `dist/bin/aweek.js` is the
  // most disruptive failure mode for the published tarball. `node
  // --check` does a full parse without executing the CLI.
  await run(process.execPath, ['--check', BIN_TARGET]);
  console.log('build: dist/ ready');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
