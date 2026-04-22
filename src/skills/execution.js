/**
 * Execution-log maintenance skill module.
 *
 * Per-execution NDJSON logs accumulate under
 * `<projectDir>/.aweek/agents/<slug>/executions/*.jsonl` every time the
 * heartbeat spawns a Claude Code CLI session. Disk usage is bounded
 * loosely (Read tool output + tool_use inputs dominate — a session can
 * be 100 KB to several MB), so users will eventually want a prune
 * command. This module implements that: scan all agents' executions
 * directories, delete any execution log whose mtime is older than
 * `olderThanWeeks` weeks (default 4), and report what went.
 *
 * Everything here is read/write on disk only — no LLM calls, no
 * git/crontab interaction. Designed to be callable both programmatically
 * (tests, internal tooling) and from the CLI dispatcher.
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_OLDER_THAN_WEEKS = 4;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete execution logs older than a cutoff.
 *
 * @param {object} opts
 * @param {string} opts.projectDir - Project root (parent of `.aweek`).
 * @param {number} [opts.olderThanWeeks] - Retention cutoff in whole weeks.
 *   Execution logs with mtime older than `now - olderThanWeeks * 1 week`
 *   are deleted. `0` prunes everything; negative values throw.
 * @param {Date} [opts.now] - Injectable "now" for deterministic tests.
 * @returns {Promise<{
 *   deleted: string[],  // Absolute paths of files removed.
 *   kept: number,       // Count of execution logs retained.
 *   scannedAgents: string[],  // Agent slugs whose executions dir was scanned.
 *   cutoffIso: string,  // The resolved cutoff instant, for reporting.
 * }>}
 */
export async function pruneExecutionLogs({
  projectDir,
  olderThanWeeks = DEFAULT_OLDER_THAN_WEEKS,
  now = new Date(),
} = {}) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new Error('projectDir is required');
  }
  if (typeof olderThanWeeks !== 'number' || Number.isNaN(olderThanWeeks)) {
    throw new Error('olderThanWeeks must be a number');
  }
  if (olderThanWeeks < 0) {
    throw new Error('olderThanWeeks must be >= 0');
  }

  const cutoffMs = now.getTime() - olderThanWeeks * MS_PER_WEEK;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const agentsDir = join(projectDir, '.aweek', 'agents');
  const deleted = [];
  let kept = 0;
  const scannedAgents = [];

  let agentEntries;
  try {
    agentEntries = await readdir(agentsDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { deleted, kept, scannedAgents, cutoffIso };
    }
    throw err;
  }

  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;
    const slug = agentEntry.name;
    const execDir = join(agentsDir, slug, 'executions');

    let files;
    try {
      files = await readdir(execDir);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    scannedAgents.push(slug);

    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const full = join(execDir, name);
      let s;
      try {
        s = await stat(full);
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        throw err;
      }
      if (!s.isFile()) continue;
      if (s.mtimeMs <= cutoffMs) {
        try {
          await unlink(full);
          deleted.push(full);
        } catch (err) {
          // Missing-during-delete is a race we tolerate silently; anything
          // else bubbles so callers see real failures rather than a lie.
          if (err && err.code === 'ENOENT') continue;
          throw err;
        }
      } else {
        kept += 1;
      }
    }
  }

  return { deleted, kept, scannedAgents, cutoffIso };
}

export { DEFAULT_OLDER_THAN_WEEKS };
