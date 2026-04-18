#!/usr/bin/env node

/**
 * aweek CLI — entry point for heartbeat execution and skill dispatch.
 *
 * Usage:
 *   aweek heartbeat <agentId> [--project-dir <dir>]
 *   aweek heartbeat --all [--project-dir <dir>]
 *   aweek exec <module> <fn> [--input-json - | <file>] [--format json|text]
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runHeartbeatForAgent, runHeartbeatForAll } from '../src/heartbeat/run.js';
import {
  dispatchExec,
  listModules,
  listFunctions,
} from '../src/cli/dispatcher.js';

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === '--help' || command === '-h') {
  console.log(`
aweek — Claude Code agent scheduler

Usage:
  aweek heartbeat <agentId>     Run heartbeat tick for a single agent
  aweek heartbeat --all         Run heartbeat tick for all agents
  aweek exec <module> <fn>      Invoke a skill export with JSON in/out
  aweek --help                  Show this help

Options:
  --project-dir <dir>           Project root directory (default: cwd)

exec options:
  --input-json -                Read a JSON input object from stdin
  --input-json <path>           Read a JSON input object from the given file
  --format json|text            Output format (default: json)
`.trim());
  process.exit(0);
}

if (command === 'exec') {
  try {
    await runExec(args.slice(1));
    process.exit(0);
  } catch (err) {
    const code = err && err.code ? ` [${err.code}]` : '';
    console.error(`Error${code}: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

if (command !== 'heartbeat') {
  console.error(`Unknown command: ${command}`);
  console.error('Run "aweek --help" for usage.');
  process.exit(1);
}

// Parse remaining args for heartbeat
const rest = args.slice(1);
let projectDir = process.cwd();
let agentId = null;
let runAll = false;

for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--project-dir' && rest[i + 1]) {
    projectDir = resolve(rest[i + 1]);
    i++;
  } else if (rest[i] === '--all') {
    runAll = true;
  } else if (!rest[i].startsWith('-')) {
    agentId = rest[i];
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
    await runHeartbeatForAgent(agentId, { projectDir });
  }
} catch (err) {
  console.error(`Heartbeat failed: ${err.message}`);
  process.exit(1);
}

async function runExec(execArgs) {
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

  let format = 'json';
  let input = {};

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

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw Object.assign(new Error(`Invalid JSON on stdin: ${err.message}`), {
      code: 'EINPUT_JSON',
    });
  }
}

async function readFileJson(path) {
  const raw = (await readFile(path, 'utf-8')).trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw Object.assign(
      new Error(`Invalid JSON in ${path}: ${err.message}`),
      { code: 'EINPUT_JSON' },
    );
  }
}

function writeResult(result, format) {
  if (format === 'text') {
    const text = typeof result === 'string' ? result : String(result ?? '');
    process.stdout.write(text);
    if (!text.endsWith('\n')) process.stdout.write('\n');
  } else {
    process.stdout.write(JSON.stringify(result, null, 2));
    process.stdout.write('\n');
  }
}
