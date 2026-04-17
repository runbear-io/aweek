/**
 * Crontab manager for agent heartbeat scheduling.
 * Installs, removes, and queries crontab entries that trigger heartbeat runs.
 * Each agent gets a unique crontab comment marker for idempotent management.
 *
 * Crontab entries are the source of truth for whether an agent's heartbeat is active.
 * The marker format is: # aweek:heartbeat:<agentId>
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Marker prefix used to identify aweek heartbeat entries in crontab */
const MARKER_PREFIX = 'aweek:heartbeat:';

/**
 * Build the crontab comment marker for an agent.
 * @param {string} agentId
 * @returns {string}
 */
export function markerFor(agentId) {
  return `${MARKER_PREFIX}${agentId}`;
}

/**
 * Read the current user crontab.
 * Returns empty string if no crontab exists.
 * @returns {Promise<string>}
 */
export async function readCrontab() {
  try {
    const { stdout } = await execFileAsync('crontab', ['-l']);
    return stdout;
  } catch (err) {
    // "no crontab for <user>" is a normal state
    if (err.stderr && err.stderr.includes('no crontab')) {
      return '';
    }
    throw err;
  }
}

/**
 * Write a full crontab string, replacing the current crontab.
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function writeCrontab(content) {
  const child = execFileAsync('crontab', ['-'], {});
  child.child.stdin.write(content);
  child.child.stdin.end();
  await child;
}

/**
 * Build the cron line + marker comment for an agent heartbeat.
 * Default schedule: every hour at minute 0.
 * @param {object} opts
 * @param {string} opts.agentId - Agent identifier
 * @param {string} opts.command - Shell command to run on heartbeat
 * @param {string} [opts.schedule='0 * * * *'] - Cron schedule expression
 * @returns {string} Two lines: comment marker + cron entry
 */
export function buildCronEntry({ agentId, command, schedule = '0 * * * *' }) {
  if (!agentId) throw new Error('agentId is required');
  if (!command) throw new Error('command is required');
  const marker = markerFor(agentId);
  return `# ${marker}\n${schedule} ${command}`;
}

/**
 * Parse crontab text into structured entries.
 * Groups comment-marker lines with their following cron line.
 * @param {string} crontabText
 * @returns {Array<{marker: string, agentId: string, schedule: string, command: string, raw: string}>}
 */
export function parseHeartbeatEntries(crontabText) {
  if (!crontabText.trim()) return [];

  const lines = crontabText.split('\n');
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith(`# ${MARKER_PREFIX}`)) {
      const marker = line.slice(2).trim(); // remove "# "
      const agentId = marker.slice(MARKER_PREFIX.length);
      const cronLine = (lines[i + 1] || '').trim();

      if (cronLine && !cronLine.startsWith('#')) {
        // Parse schedule (first 5 fields) and command (rest)
        const parts = cronLine.split(/\s+/);
        const schedule = parts.slice(0, 5).join(' ');
        const command = parts.slice(5).join(' ');
        entries.push({
          marker,
          agentId,
          schedule,
          command,
          raw: `${line}\n${cronLine}`,
        });
        i++; // skip the cron line since we consumed it
      }
    }
  }

  return entries;
}

/**
 * Remove all lines belonging to a specific agent from crontab text.
 * @param {string} crontabText
 * @param {string} agentId
 * @returns {string} Cleaned crontab text
 */
export function removeLinesForAgent(crontabText, agentId) {
  const marker = `# ${markerFor(agentId)}`;
  const lines = crontabText.split('\n');
  const result = [];
  let skip = false;

  for (const line of lines) {
    if (line.trim() === marker) {
      skip = true; // skip this marker line and the next cron line
      continue;
    }
    if (skip) {
      skip = false; // skip the cron line following the marker
      continue;
    }
    result.push(line);
  }

  return result.join('\n');
}

/**
 * Install a heartbeat crontab entry for an agent.
 * Idempotent: removes any existing entry for the agent first.
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {string} opts.command
 * @param {string} [opts.schedule='0 * * * *']
 * @returns {Promise<{installed: boolean, entry: string}>}
 */
export async function install({ agentId, command, schedule = '0 * * * *' }) {
  const current = await readCrontab();
  const cleaned = removeLinesForAgent(current, agentId);
  const entry = buildCronEntry({ agentId, command, schedule });

  // Append entry, ensuring trailing newline
  const base = cleaned.trimEnd();
  const newCrontab = base ? `${base}\n${entry}\n` : `${entry}\n`;

  await writeCrontab(newCrontab);
  return { installed: true, entry };
}

/**
 * Remove the heartbeat crontab entry for an agent.
 * Idempotent: no error if entry doesn't exist.
 * @param {string} agentId
 * @returns {Promise<{removed: boolean}>}
 */
export async function remove(agentId) {
  const current = await readCrontab();
  const cleaned = removeLinesForAgent(current, agentId);

  // Check if anything actually changed
  const changed = cleaned !== current;

  if (changed) {
    const trimmed = cleaned.trim();
    if (trimmed) {
      await writeCrontab(trimmed + '\n');
    } else {
      // Empty crontab — remove it entirely
      await execFileAsync('crontab', ['-r']).catch(() => {
        // Ignore errors when removing empty crontab
      });
    }
  }

  return { removed: changed };
}

/**
 * Query whether a heartbeat entry exists for an agent.
 * @param {string} agentId
 * @returns {Promise<{active: boolean, entry: object|null}>}
 */
export async function query(agentId) {
  const current = await readCrontab();
  const entries = parseHeartbeatEntries(current);
  const match = entries.find((e) => e.agentId === agentId) || null;
  return { active: !!match, entry: match };
}

/**
 * List all aweek heartbeat entries in the current crontab.
 * @returns {Promise<Array<{marker: string, agentId: string, schedule: string, command: string, raw: string}>>}
 */
export async function listAll() {
  const current = await readCrontab();
  return parseHeartbeatEntries(current);
}
