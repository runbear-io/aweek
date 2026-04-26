#!/usr/bin/env node

/**
 * aweek CLI — entry point for heartbeat execution and skill dispatch.
 *
 * Usage:
 *   aweek heartbeat <agentId> [--project-dir <dir>]
 *   aweek heartbeat --all [--project-dir <dir>]
 *   aweek exec <module> <fn> [--input-json - | <file>] [--format json|text]
 *   aweek serve [--port <n>] [--host <addr>] [--no-open] [--project-dir <dir>]
 *
 * TypeScript migration note (seed-10-glue-final): mechanical rename from
 * `.js` → `.ts`. The shebang above is preserved so `dist/bin/aweek.js`
 * (emitted by `tsconfig.build.json`) stays directly executable. JSDoc
 * parameter annotations have been promoted to lightweight TS signatures;
 * the runtime behaviour is unchanged.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runHeartbeatForAgent, runHeartbeatForAll } from '../src/heartbeat/run.js';
import {
  dispatchExec,
  listModules,
  listFunctions,
} from '../src/cli/dispatcher.js';
import {
  startServer,
  openBrowser,
  formatLanHints,
  isWildcardHost,
  formatNoAweekDirMessage,
  isNoAweekDirError,
} from '../src/serve/server.js';

/**
 * Narrow shape of the `ENOAWEEKDIR` error thrown by the serve pipeline.
 * Matches the public surface exposed by `src/serve/errors.ts` and consumed
 * by {@link formatNoAweekDirMessage} below.
 */
interface NoAweekDirError extends Error {
  code?: string;
  dataDir?: string;
  projectDir?: string;
}

const args: string[] = process.argv.slice(2);
const command: string | undefined = args[0];

if (!command || command === '--help' || command === '-h') {
  console.log(`
aweek — Claude Code agent scheduler

Usage:
  aweek heartbeat <agentId>     Run heartbeat tick for a single agent
  aweek heartbeat --all         Run heartbeat tick for all agents
  aweek exec <module> <fn>      Invoke a skill export with JSON in/out
  aweek serve                   Launch local read-only dashboard (HTTP)
  aweek --help                  Show this help

Options:
  --project-dir <dir>           Project root directory (default: cwd)

exec options:
  --input-json -                Read a JSON input object from stdin
  --input-json <path>           Read a JSON input object from the given file
  --format json|text            Output format (default: json)

serve options:
  --port <n>                    Port to bind (default: 3000, auto-increments)
  --host <addr>                 Bind address (default: 0.0.0.0 for LAN access)
  --no-open                     Do not open the dashboard in a browser
`.trim());
  process.exit(0);
}

if (command === 'exec') {
  try {
    await runExec(args.slice(1));
    process.exit(0);
  } catch (err) {
    const e = err as { code?: string; message?: string } | undefined;
    const code = e && e.code ? ` [${e.code}]` : '';
    console.error(`Error${code}: ${e && e.message ? e.message : err}`);
    process.exit(1);
  }
}

if (command === 'serve') {
  try {
    await runServe(args.slice(1));
    // Do not exit — the HTTP server keeps the event loop alive so the
    // dashboard stays reachable until the user hits Ctrl-C.
  } catch (err) {
    // ENOAWEEKDIR is the #1 first-run failure mode: the user typed
    // `aweek serve` before running `/aweek:init`. Swap the generic
    // "Serve failed [CODE]: ..." one-liner for the multi-line friendly
    // block so the next step (init / --project-dir) is obvious.
    if (isNoAweekDirError(err)) {
      const e = err as NoAweekDirError;
      console.error(
        formatNoAweekDirMessage({ dataDir: e.dataDir ?? '', projectDir: e.projectDir ?? '' }),
      );
    } else {
      const e = err as { code?: string; message?: string } | undefined;
      const code = e && e.code ? ` [${e.code}]` : '';
      console.error(`Serve failed${code}: ${e && e.message ? e.message : err}`);
    }
    process.exit(1);
  }
} else if (command === 'heartbeat') {
  await runHeartbeat(args.slice(1));
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run "aweek --help" for usage.');
  process.exit(1);
}

async function runHeartbeat(heartbeatArgs: string[]): Promise<void> {
  let projectDir: string = process.cwd();
  let agentId: string | null = null;
  let runAll = false;

  for (let i = 0; i < heartbeatArgs.length; i++) {
    if (heartbeatArgs[i] === '--project-dir' && heartbeatArgs[i + 1]) {
      projectDir = resolve(heartbeatArgs[i + 1]!);
      i++;
    } else if (heartbeatArgs[i] === '--all') {
      runAll = true;
    } else if (!heartbeatArgs[i]!.startsWith('-')) {
      agentId = heartbeatArgs[i]!;
    }
  }

  if (!runAll && !agentId) {
    console.error('Error: provide an <agentId> or use --all');
    console.error('Run "aweek --help" for usage.');
    process.exit(1);
  }

  try {
    if (runAll) {
      await runHeartbeatForAll({ projectDir });
    } else {
      await runHeartbeatForAgent(agentId!, { projectDir });
    }
  } catch (err) {
    const e = err as { message?: string } | undefined;
    console.error(`Heartbeat failed: ${e && e.message ? e.message : err}`);
    process.exit(1);
  }
}

async function runServe(serveArgs: string[]): Promise<void> {
  let port: string | undefined;
  let host: string | undefined;
  let open = true;
  let projectDir: string = process.cwd();

  for (let i = 0; i < serveArgs.length; i++) {
    const arg = serveArgs[i];
    if (arg === '--port' && serveArgs[i + 1]) {
      port = serveArgs[++i]!;
    } else if (arg === '--host' && serveArgs[i + 1]) {
      host = serveArgs[++i]!;
    } else if (arg === '--no-open') {
      open = false;
    } else if (arg === '--project-dir' && serveArgs[i + 1]) {
      projectDir = resolve(serveArgs[++i]!);
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `Usage: aweek serve [--port <n>] [--host <addr>] [--no-open] [--project-dir <dir>]`,
      );
      process.exit(0);
    } else {
      throw Object.assign(new Error(`Unknown flag: ${arg}`), { code: 'EUSAGE' });
    }
  }

  const { url, port: boundPort, host: boundHost } = await startServer({
    port,
    host,
    open,
    projectDir,
  });

  console.log(`aweek dashboard listening on ${url}`);
  if (isWildcardHost(boundHost)) {
    // Wildcard bind means the server is accepting connections on every
    // interface, so phones/tablets on the same Wi-Fi can reach it. Walk
    // the host's network interfaces and print one URL per LAN address
    // (IPv4 + routable IPv6) so the user can just tap a link.
    const lanUrls = formatLanHints({ host: boundHost, port: boundPort });
    if (lanUrls.length > 0) {
      console.log('  LAN:');
      for (const lanUrl of lanUrls) {
        console.log(`    ${lanUrl}`);
      }
    } else {
      // No external interface detected (air-gapped / container without
      // a bridge / ...). Surface the bind so the user at least knows
      // the server is wildcard-bound and ready for LAN clients.
      console.log(
        `  LAN: bound to ${boundHost}:${boundPort} (no external IPv4/IPv6 detected)`,
      );
    }
  }
  console.log('  Press Ctrl-C to stop.');

  // Auto-open the dashboard in the user's default browser unless the
  // caller passed `--no-open`. Failures fall back silently to the URL
  // already printed above, with a single diagnostic line so the user
  // knows why the browser did not appear.
  if (open) {
    const result = await openBrowser(url);
    if (!result.opened) {
      const errAny = result.error as { message?: string } | undefined;
      const reason = errAny && errAny.message ? `: ${errAny.message}` : '';
      console.log(`  Could not auto-open a browser${reason}. Open ${url} manually.`);
    }
  }
}

async function runExec(execArgs: string[]): Promise<void> {
  const [moduleKey, fnName, ...flagArgs] = execArgs;

  if (!moduleKey || moduleKey === '--help' || moduleKey === '-h') {
    console.log(
      `Usage: aweek exec <module> <fn> [--input-json - | <file>] [--format json|text]\n` +
        `Modules: ${listModules().join(', ')}`,
    );
    return;
  }

  if (!fnName) {
    const fns = listFunctions(moduleKey);
    if (!fns) {
      console.error(`Unknown module: ${moduleKey}`);
      console.error(`Available modules: ${listModules().join(', ')}`);
      process.exitCode = 2;
      return;
    }
    console.log(`Module "${moduleKey}" exposes:`);
    for (const fn of fns) console.log(`  ${fn}`);
    return;
  }

  let format: 'json' | 'text' = 'json';
  let input: unknown = {};

  for (let i = 0; i < flagArgs.length; i++) {
    const arg = flagArgs[i];
    if (arg === '--format') {
      const next = flagArgs[++i];
      if (next !== 'json' && next !== 'text') {
        throw Object.assign(new Error(`Invalid --format value: ${next}`), {
          code: 'EUSAGE',
        });
      }
      format = next;
    } else if (arg === '--input-json') {
      const target = flagArgs[++i];
      if (!target) {
        throw Object.assign(new Error('--input-json requires "-" or a file path'), {
          code: 'EUSAGE',
        });
      }
      input = target === '-' ? await readStdinJson() : await readFileJson(target);
    } else {
      throw Object.assign(new Error(`Unknown flag: ${arg}`), { code: 'EUSAGE' });
    }
  }

  const result = await dispatchExec({ moduleKey, fnName, input });
  writeResult(result, format);
}

async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    const e = err as { message?: string };
    throw Object.assign(new Error(`Invalid JSON on stdin: ${e.message ?? String(err)}`), {
      code: 'EINPUT_JSON',
    });
  }
}

async function readFileJson(path: string): Promise<unknown> {
  const raw = (await readFile(path, 'utf-8')).trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    const e = err as { message?: string };
    throw Object.assign(
      new Error(`Invalid JSON in ${path}: ${e.message ?? String(err)}`),
      { code: 'EINPUT_JSON' },
    );
  }
}

function writeResult(result: unknown, format: 'json' | 'text'): void {
  if (format === 'text') {
    const text = typeof result === 'string' ? result : String(result ?? '');
    process.stdout.write(text);
    if (!text.endsWith('\n')) process.stdout.write('\n');
  } else {
    process.stdout.write(JSON.stringify(result, null, 2));
    process.stdout.write('\n');
  }
}
