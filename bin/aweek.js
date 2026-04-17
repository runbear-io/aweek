#!/usr/bin/env node

/**
 * aweek CLI — entry point for heartbeat execution and agent management.
 *
 * Usage:
 *   aweek heartbeat <agentId> [--project-dir <dir>]
 *   aweek heartbeat --all [--project-dir <dir>]
 */

import { resolve } from 'node:path';
import { runHeartbeatForAgent, runHeartbeatForAll } from '../src/heartbeat/run.js';

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === '--help' || command === '-h') {
  console.log(`
aweek — Claude Code agent scheduler

Usage:
  aweek heartbeat <agentId>     Run heartbeat tick for a single agent
  aweek heartbeat --all         Run heartbeat tick for all agents
  aweek --help                  Show this help

Options:
  --project-dir <dir>           Project root directory (default: cwd)
`.trim());
  process.exit(0);
}

if (command !== 'heartbeat') {
  console.error(`Unknown command: ${command}`);
  console.error('Run "aweek --help" for usage.');
  process.exit(1);
}

// Parse remaining args
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
