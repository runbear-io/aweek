#!/usr/bin/env tsx
/**
 * cleanup-bunched-runat — one-shot rescue for plans whose skipped tasks
 * all share the same `runAt`.
 *
 * Why this exists: a daily-review carry-over bug stamped every adjusted
 * task with a single hardcoded `runAt` (`tomorrow @ 09:00 UTC`). Tasks
 * that subsequently aged out via the stale-sweep got marked `skipped`
 * with that timestamp intact, so dozens of them now stack at one calendar
 * cell. The forward fix preserves time-of-day in the agent's tz, but the
 * already-bunched data has to be redistributed by hand.
 *
 * What this script does:
 *   1. Loads `.aweek/agents/<slug>/weekly-plans/<week>.json`
 *   2. Reads the project tz from `.aweek/config.json` (falls back to UTC)
 *   3. Groups `skipped` tasks by `runAt` and finds buckets with >1 task
 *   4. Redistributes each bunch across the working window (default 09:00–
 *      17:00 local) at the configured spacing (default 5 min), starting
 *      on the bunched local date. Overflow wraps to subsequent local
 *      dates.
 *   5. Sorts within a bunch by task id so re-runs are deterministic.
 *
 * Usage:
 *   tsx scripts/cleanup-bunched-runat.mts \
 *     --project-dir <path> \
 *     --agent <slug> \
 *     --week <YYYY-Www> \
 *     [--dry-run] \
 *     [--start-hour 9] [--end-hour 17] [--spacing 5]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  isValidTimeZone,
  localParts,
  localWallClockToUtc,
} from '../src/time/zone.js';

interface Args {
  projectDir: string;
  agent: string;
  week: string;
  dryRun: boolean;
  startHour: number;
  endHour: number;
  spacingMinutes: number;
}

interface WeeklyTask {
  id: string;
  status?: string;
  runAt?: string;
  title?: string;
  [key: string]: unknown;
}

interface WeeklyPlan {
  tasks: WeeklyTask[];
  updatedAt?: string;
  [key: string]: unknown;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    projectDir: process.cwd(),
    startHour: 9,
    endHour: 17,
    spacingMinutes: 5,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project-dir') out.projectDir = resolve(argv[++i]!);
    else if (a === '--agent') out.agent = argv[++i];
    else if (a === '--week') out.week = argv[++i];
    else if (a === '--start-hour') out.startHour = Number(argv[++i]!);
    else if (a === '--end-hour') out.endHour = Number(argv[++i]!);
    else if (a === '--spacing') out.spacingMinutes = Number(argv[++i]!);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown flag: ${a}`);
  }
  if (!out.agent || !out.week) {
    console.error(usage());
    throw new Error('Required: --agent <slug> --week <YYYY-Www>');
  }
  return out as Args;
}

function usage(): string {
  return [
    'Usage:',
    '  tsx scripts/cleanup-bunched-runat.mts \\',
    '    --project-dir <path>     Project root holding .aweek/ (default: cwd)',
    '    --agent <slug>           Agent slug (required)',
    '    --week <YYYY-Www>        ISO week identifier (required)',
    '    [--dry-run]              Print proposed rewrites without writing',
    '    [--start-hour 9]         Working window start, local hour (0-23)',
    '    [--end-hour 17]          Working window end, local hour (0-24)',
    '    [--spacing 5]            Minutes between adjacent slots',
  ].join('\n');
}

async function readJson<T>(path: string): Promise<T> {
  const buf = await readFile(path, 'utf8');
  return JSON.parse(buf) as T;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const planPath = join(
    args.projectDir,
    '.aweek',
    'agents',
    args.agent,
    'weekly-plans',
    `${args.week}.json`,
  );
  const configPath = join(args.projectDir, '.aweek', 'config.json');

  const plan = await readJson<WeeklyPlan>(planPath);
  let tz = 'UTC';
  try {
    const config = await readJson<{ timeZone?: string }>(configPath);
    if (config.timeZone) tz = config.timeZone;
  } catch {
    // No config — use UTC
  }
  if (!isValidTimeZone(tz)) tz = 'UTC';

  console.log(`Plan:    ${planPath}`);
  console.log(`Project: ${args.projectDir}`);
  console.log(`Agent:   ${args.agent}`);
  console.log(`Week:    ${args.week}`);
  console.log(`Zone:    ${tz}`);
  console.log(
    `Window:  ${args.startHour}:00–${args.endHour}:00 local, ${args.spacingMinutes}-min spacing`,
  );
  console.log(`Mode:    ${args.dryRun ? 'dry-run' : 'apply'}`);
  console.log('');

  // Group skipped tasks with a runAt by their runAt.
  const tasksByRunAt = new Map<string, WeeklyTask[]>();
  for (const task of plan.tasks) {
    if (task.status !== 'skipped' || !task.runAt) continue;
    const bucket = tasksByRunAt.get(task.runAt) || [];
    bucket.push(task);
    tasksByRunAt.set(task.runAt, bucket);
  }

  const slotsPerDay = Math.max(
    1,
    Math.floor(((args.endHour - args.startHour) * 60) / args.spacingMinutes),
  );

  let totalReassigned = 0;
  for (const [bunchedRunAt, tasks] of tasksByRunAt) {
    if (tasks.length <= 1) continue;

    const bunchedMs = Date.parse(bunchedRunAt);
    if (Number.isNaN(bunchedMs)) continue;
    const bunchedLocal = localParts(bunchedMs, tz);
    const baseDateStr = `${bunchedLocal.year}-${String(bunchedLocal.month).padStart(2, '0')}-${String(bunchedLocal.day).padStart(2, '0')}`;

    console.log(
      `Bunch at ${bunchedRunAt} (local ${baseDateStr} ${String(bunchedLocal.hour).padStart(2, '0')}:${String(bunchedLocal.minute).padStart(2, '0')}) — ${tasks.length} tasks:`,
    );

    tasks.sort((a, b) => a.id.localeCompare(b.id));

    for (let i = 0; i < tasks.length; i++) {
      const dayOffset = Math.floor(i / slotsPerDay);
      const slotInDay = i % slotsPerDay;
      const totalMinutes =
        args.startHour * 60 + slotInDay * args.spacingMinutes;
      const hour = Math.floor(totalMinutes / 60);
      const minute = totalMinutes % 60;

      const baseDate = new Date(`${baseDateStr}T00:00:00Z`);
      baseDate.setUTCDate(baseDate.getUTCDate() + dayOffset);
      const targetDateStr = baseDate.toISOString().slice(0, 10);
      const [y, m, d] = targetDateStr.split('-');

      const inst = localWallClockToUtc(
        {
          year: Number(y),
          month: Number(m),
          day: Number(d),
          hour,
          minute,
          second: 0,
        },
        tz,
      );
      const newRunAt = inst.toISOString();

      const titleSnip = (tasks[i]!.title || '').slice(0, 50);
      console.log(
        `  ${tasks[i]!.id}: ${tasks[i]!.runAt} → ${newRunAt}  ${titleSnip}`,
      );
      tasks[i]!.runAt = newRunAt;
      totalReassigned += 1;
    }
    console.log('');
  }

  console.log(`Total reassigned: ${totalReassigned} task(s).`);

  if (args.dryRun) {
    console.log('Dry run — no changes written.');
    return;
  }
  if (totalReassigned === 0) {
    console.log('Nothing to do.');
    return;
  }

  plan.updatedAt = new Date().toISOString();
  await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${planPath}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`cleanup-bunched-runat: failed: ${msg}`);
  process.exit(1);
});
