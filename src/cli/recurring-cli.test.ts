/**
 * Tests for the `aweek recurring` subcommand wiring.
 *
 * Sub-AC 19.1.3 coverage:
 *   - `parseRecurringFlags` handles every CLI flag (template + rule + meta)
 *   - `buildDispatchInput` maps op + flags onto the dispatcher's JSON shape
 *     for each of list / add / update / remove
 *   - `runRecurringCli` routes to the right dispatcher entry, forwards the
 *     built input, and formats the result in both `text` and `json` modes
 *   - `runRecurringCli` surfaces `--help` / `help` / no-op with the
 *     RECURRING_HELP banner and never invokes the dispatcher
 *   - Required-flag validation throws EUSAGE before any dispatcher call
 *
 * The dispatcher is stubbed via `RunRecurringCliDeps.dispatchExecFn` so the
 * test never touches `.aweek/agents/` on disk — the contract being pinned
 * is purely the argv → dispatcher-input wiring.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';

import {
  RECURRING_HELP,
  buildDispatchInput,
  parseRecurringFlags,
  runRecurringCli,
  type DispatchExecFn,
} from './recurring-cli.js';

// ---------------------------------------------------------------------------
// parseRecurringFlags — flag-by-flag coverage
// ---------------------------------------------------------------------------

describe('parseRecurringFlags', () => {
  it('defaults `confirmed` to false and `format` to text', () => {
    const flags = parseRecurringFlags([]);
    assert.equal(flags.confirmed, false);
    assert.equal(flags.format, 'text');
  });

  it('parses every template + rule + meta flag in one pass', () => {
    const flags = parseRecurringFlags([
      '--agent', 'researcher',
      '--id', 'rec-mon-standup',
      '--title', 'Monday standup',
      '--prompt', 'Run the weekly standup checklist.',
      '--priority', 'high',
      '--estimated-minutes', '45',
      '--track', 'ops',
      '--objective-id', '2026-04',
      '--freq', 'weekly',
      '--interval', '2',
      '--dtstart', '2026-05-04T15:00:00Z',
      '--timezone', 'America/Los_Angeles',
      '--byday', 'MO,WE,FR',
      '--bymonthday', '15',
      '--bysetpos', '-1',
      '--count', '12',
      '--confirmed',
      '--project-dir', '/tmp/proj',
      '--format', 'json',
    ]);
    assert.deepEqual(flags, {
      agent: 'researcher',
      id: 'rec-mon-standup',
      title: 'Monday standup',
      prompt: 'Run the weekly standup checklist.',
      priority: 'high',
      estimatedMinutes: 45,
      track: 'ops',
      objectiveId: '2026-04',
      freq: 'weekly',
      interval: 2,
      dtstart: '2026-05-04T15:00:00Z',
      timezone: 'America/Los_Angeles',
      byDay: ['MO', 'WE', 'FR'],
      byMonthDay: 15,
      bySetPos: -1,
      count: 12,
      confirmed: true,
      projectDir: '/tmp/proj',
      format: 'json',
    });
  });

  it('accepts hyphenated long-form aliases (--by-day / --by-month-day / --by-set-pos / --time-zone / --agent-id)', () => {
    const flags = parseRecurringFlags([
      '--agent-id', 'a',
      '--time-zone', 'UTC',
      '--by-day', 'TU',
      '--by-month-day', '3',
      '--by-set-pos', '2',
    ]);
    assert.equal(flags.agent, 'a');
    assert.equal(flags.timezone, 'UTC');
    assert.deepEqual(flags.byDay, ['TU']);
    assert.equal(flags.byMonthDay, 3);
    assert.equal(flags.bySetPos, 2);
  });

  it('parses --until separately from --count', () => {
    const flags = parseRecurringFlags(['--until', '2027-01-01T00:00:00Z']);
    assert.equal(flags.until, '2027-01-01T00:00:00Z');
    assert.equal(flags.count, undefined);
  });

  it('trims and drops empty entries from --byday', () => {
    const flags = parseRecurringFlags(['--byday', 'MO, ,WE,  TH']);
    assert.deepEqual(flags.byDay, ['MO', 'WE', 'TH']);
  });

  it('throws EUSAGE for an unknown flag', () => {
    assert.throws(
      () => parseRecurringFlags(['--nope']),
      (err: NodeJS.ErrnoException) =>
        err.code === 'EUSAGE' && /Unknown flag: --nope/.test(err.message),
    );
  });

  it('throws EUSAGE when a value-requiring flag is dangling', () => {
    assert.throws(
      () => parseRecurringFlags(['--title']),
      (err: NodeJS.ErrnoException) =>
        err.code === 'EUSAGE' && /--title requires a value/.test(err.message),
    );
  });

  it('throws EUSAGE on a non-integer numeric flag', () => {
    assert.throws(
      () => parseRecurringFlags(['--interval', 'abc']),
      (err: NodeJS.ErrnoException) =>
        err.code === 'EUSAGE' && /--interval must be an integer/.test(err.message),
    );
  });

  it('throws EUSAGE on an invalid --format value', () => {
    assert.throws(
      () => parseRecurringFlags(['--format', 'yaml']),
      (err: NodeJS.ErrnoException) =>
        err.code === 'EUSAGE' && /Invalid --format value: yaml/.test(err.message),
    );
  });
});

// ---------------------------------------------------------------------------
// buildDispatchInput — per-op JSON shape
// ---------------------------------------------------------------------------

describe('buildDispatchInput', () => {
  it('list — minimal happy path', () => {
    const flags = parseRecurringFlags(['--agent', 'r']);
    const out = buildDispatchInput('list', flags);
    assert.equal(out.moduleKey, 'recurring');
    assert.equal(out.fnName, 'listRecurringTasks');
    assert.deepEqual(out.input, {
      agentId: 'r',
      agentsDir: '.aweek/agents',
    });
  });

  it('list — resolves --project-dir into an absolute agentsDir + projectDir pair', () => {
    const flags = parseRecurringFlags(['--agent', 'r', '--project-dir', '/tmp/p']);
    const out = buildDispatchInput('list', flags);
    const expectedProjectDir = resolve('/tmp/p');
    assert.deepEqual(out.input, {
      agentId: 'r',
      agentsDir: join(expectedProjectDir, '.aweek/agents'),
      projectDir: expectedProjectDir,
    });
  });

  it('add — builds the full template + rule + id payload', () => {
    const flags = parseRecurringFlags([
      '--agent', 'r',
      '--id', 'rec-x',
      '--title', 'T',
      '--prompt', 'P',
      '--priority', 'high',
      '--estimated-minutes', '30',
      '--track', 'x-com',
      '--objective-id', '2026-04',
      '--freq', 'weekly',
      '--interval', '2',
      '--dtstart', '2026-05-04T15:00:00Z',
      '--timezone', 'America/Los_Angeles',
      '--byday', 'MO,WE',
      '--count', '10',
    ]);
    const out = buildDispatchInput('add', flags);
    assert.equal(out.fnName, 'addRecurringTask');
    assert.deepEqual(out.input, {
      agentId: 'r',
      agentsDir: '.aweek/agents',
      id: 'rec-x',
      template: {
        title: 'T',
        prompt: 'P',
        priority: 'high',
        estimatedMinutes: 30,
        track: 'x-com',
        objectiveId: '2026-04',
      },
      rule: {
        freq: 'weekly',
        interval: 2,
        dtStart: '2026-05-04T15:00:00Z',
        timeZone: 'America/Los_Angeles',
        byDay: ['MO', 'WE'],
        count: 10,
      },
    });
  });

  it('add — throws when template is missing', () => {
    const flags = parseRecurringFlags([
      '--agent', 'r',
      '--freq', 'daily',
      '--interval', '1',
      '--dtstart', '2026-05-04T15:00:00Z',
      '--timezone', 'UTC',
    ]);
    assert.throws(
      () => buildDispatchInput('add', flags),
      (err: NodeJS.ErrnoException) =>
        err.code === 'EUSAGE' && /add requires --title and --prompt/.test(err.message),
    );
  });

  it('add — throws when rule is missing', () => {
    const flags = parseRecurringFlags([
      '--agent', 'r',
      '--title', 'T',
      '--prompt', 'P',
    ]);
    assert.throws(
      () => buildDispatchInput('add', flags),
      (err: NodeJS.ErrnoException) =>
        err.code === 'EUSAGE' &&
        /add requires --freq, --interval, --dtstart, and --timezone/.test(err.message),
    );
  });

  it('update — forwards only the supplied overlays and the confirmed flag', () => {
    const flags = parseRecurringFlags([
      '--agent', 'r',
      '--id', 'rec-x',
      '--title', 'Renamed',
      '--confirmed',
    ]);
    const out = buildDispatchInput('update', flags);
    assert.equal(out.fnName, 'updateRecurringTask');
    assert.deepEqual(out.input, {
      agentId: 'r',
      agentsDir: '.aweek/agents',
      id: 'rec-x',
      template: { title: 'Renamed' },
      confirmed: true,
    });
  });

  it('update — forwards rule overlays + confirmed=false when --confirmed is omitted', () => {
    const flags = parseRecurringFlags([
      '--agent', 'r',
      '--id', 'rec-x',
      '--interval', '3',
    ]);
    const out = buildDispatchInput('update', flags);
    assert.deepEqual(out.input, {
      agentId: 'r',
      agentsDir: '.aweek/agents',
      id: 'rec-x',
      rule: { interval: 3 },
      confirmed: false,
    });
  });

  it('update — throws when neither template nor rule overlay is supplied', () => {
    const flags = parseRecurringFlags(['--agent', 'r', '--id', 'rec-x']);
    assert.throws(
      () => buildDispatchInput('update', flags),
      (err: NodeJS.ErrnoException) =>
        err.code === 'EUSAGE' && /update requires at least one of/.test(err.message),
    );
  });

  it('update — throws when --id is missing', () => {
    const flags = parseRecurringFlags([
      '--agent', 'r',
      '--title', 'T',
    ]);
    assert.throws(
      () => buildDispatchInput('update', flags),
      (err: NodeJS.ErrnoException) =>
        err.code === 'EUSAGE' && /--id is required for `update`/.test(err.message),
    );
  });

  it('remove — builds the destructive payload with confirmed=true', () => {
    const flags = parseRecurringFlags([
      '--agent', 'r',
      '--id', 'rec-x',
      '--confirmed',
    ]);
    const out = buildDispatchInput('remove', flags);
    assert.equal(out.fnName, 'removeRecurringTask');
    assert.deepEqual(out.input, {
      agentId: 'r',
      agentsDir: '.aweek/agents',
      id: 'rec-x',
      confirmed: true,
    });
  });

  it('remove — forwards confirmed=false when --confirmed is omitted (skill enforces gate)', () => {
    const flags = parseRecurringFlags(['--agent', 'r', '--id', 'rec-x']);
    const out = buildDispatchInput('remove', flags);
    assert.equal(out.input.confirmed, false);
  });

  it('remove — throws when --id is missing', () => {
    const flags = parseRecurringFlags(['--agent', 'r', '--confirmed']);
    assert.throws(
      () => buildDispatchInput('remove', flags),
      (err: NodeJS.ErrnoException) =>
        err.code === 'EUSAGE' && /--id is required for `remove`/.test(err.message),
    );
  });

  it('every op — throws when --agent is missing', () => {
    for (const op of ['list', 'add', 'update', 'remove'] as const) {
      const flags = parseRecurringFlags([]);
      assert.throws(
        () => buildDispatchInput(op, flags),
        (err: NodeJS.ErrnoException) =>
          err.code === 'EUSAGE' && /--agent is required/.test(err.message),
        `op=${op} should require --agent`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// runRecurringCli — dispatch + formatting integration
// ---------------------------------------------------------------------------

describe('runRecurringCli', () => {
  /** Tiny capture-stdout helper. */
  function captureStdout(): { write: (s: string) => void; output: string[] } {
    const output: string[] = [];
    return { write: (s) => { output.push(s); }, output };
  }

  /** Capture the dispatchExec call args + return a canned result. */
  function stubDispatch(result: unknown): {
    fn: DispatchExecFn;
    calls: Array<{ moduleKey: string; fnName: string; input: unknown }>;
  } {
    const calls: Array<{ moduleKey: string; fnName: string; input: unknown }> = [];
    return {
      fn: async (params) => {
        calls.push({
          moduleKey: params.moduleKey,
          fnName: params.fnName,
          input: params.input,
        });
        return result;
      },
      calls,
    };
  }

  it('prints the help banner on `--help`', async () => {
    const stdout = captureStdout();
    const dispatch = stubDispatch({});
    await runRecurringCli(['--help'], {
      dispatchExecFn: dispatch.fn,
      stdoutWrite: stdout.write,
    });
    assert.equal(dispatch.calls.length, 0, 'dispatcher must not run on --help');
    assert.match(stdout.output.join(''), /^Usage:\n {2}aweek recurring list/);
    assert.match(stdout.output.join(''), /Alias:\n {2}aweek plan recurring/);
  });

  it('prints the help banner on bare `recurring` (no op)', async () => {
    const stdout = captureStdout();
    const dispatch = stubDispatch({});
    await runRecurringCli([], {
      dispatchExecFn: dispatch.fn,
      stdoutWrite: stdout.write,
    });
    assert.equal(dispatch.calls.length, 0);
    assert.match(stdout.output.join(''), /^Usage:/);
  });

  it('throws EUSAGE on an unknown op', async () => {
    await assert.rejects(
      () =>
        runRecurringCli(['nope'], {
          dispatchExecFn: stubDispatch({}).fn,
          stdoutWrite: () => undefined,
        }),
      (err: NodeJS.ErrnoException) =>
        err.code === 'EUSAGE' && /Unknown recurring operation: nope/.test(err.message),
    );
  });

  it('list — invokes the dispatcher and renders the text formatter', async () => {
    const stdout = captureStdout();
    const dispatch = stubDispatch({
      agentId: 'researcher',
      recurringTasks: [
        {
          id: 'rec-standup',
          template: { title: 'Standup', prompt: 'Run' },
          rule: {
            freq: 'weekly',
            interval: 1,
            byDay: ['MO'],
            dtStart: '2026-05-04T15:00:00Z',
            timeZone: 'UTC',
          },
          createdAt: '2026-05-01T00:00:00Z',
        },
      ],
    });
    await runRecurringCli(['list', '--agent', 'researcher'], {
      dispatchExecFn: dispatch.fn,
      stdoutWrite: stdout.write,
    });
    assert.deepEqual(dispatch.calls, [
      {
        moduleKey: 'recurring',
        fnName: 'listRecurringTasks',
        input: { agentId: 'researcher', agentsDir: '.aweek/agents' },
      },
    ]);
    const joined = stdout.output.join('');
    assert.match(joined, /1 recurring task\(s\) for researcher:/);
    assert.match(joined, /rec-standup — Standup \[weekly on MO\]/);
  });

  it('list — emits raw JSON when --format json is set', async () => {
    const stdout = captureStdout();
    const dispatch = stubDispatch({
      agentId: 'r',
      recurringTasks: [],
    });
    await runRecurringCli(['list', '--agent', 'r', '--format', 'json'], {
      dispatchExecFn: dispatch.fn,
      stdoutWrite: stdout.write,
    });
    const parsed = JSON.parse(stdout.output.join(''));
    assert.deepEqual(parsed, { agentId: 'r', recurringTasks: [] });
  });

  it('add — forwards the full payload and renders the text formatter', async () => {
    const stdout = captureStdout();
    const dispatch = stubDispatch({
      id: 'rec-mon-standup',
      template: { title: 'Monday standup', prompt: 'Run' },
      rule: {
        freq: 'weekly',
        interval: 2,
        byDay: ['MO'],
        dtStart: '2026-05-04T15:00:00Z',
        timeZone: 'America/Los_Angeles',
      },
      createdAt: '2026-05-01T00:00:00Z',
    });
    await runRecurringCli(
      [
        'add',
        '--agent', 'r',
        '--title', 'Monday standup',
        '--prompt', 'Run',
        '--freq', 'weekly',
        '--interval', '2',
        '--dtstart', '2026-05-04T15:00:00Z',
        '--timezone', 'America/Los_Angeles',
        '--byday', 'MO',
      ],
      { dispatchExecFn: dispatch.fn, stdoutWrite: stdout.write },
    );
    assert.equal(dispatch.calls.length, 1);
    assert.equal(dispatch.calls[0]!.moduleKey, 'recurring');
    assert.equal(dispatch.calls[0]!.fnName, 'addRecurringTask');
    const input = dispatch.calls[0]!.input as Record<string, unknown>;
    assert.equal(input.agentId, 'r');
    assert.deepEqual(input.template, { title: 'Monday standup', prompt: 'Run' });
    assert.deepEqual(input.rule, {
      freq: 'weekly',
      interval: 2,
      dtStart: '2026-05-04T15:00:00Z',
      timeZone: 'America/Los_Angeles',
      byDay: ['MO'],
    });
    const joined = stdout.output.join('');
    assert.match(joined, /Recurring task added:/);
    assert.match(joined, /ID: rec-mon-standup/);
  });

  it('update — forwards confirmed=true when --confirmed is passed', async () => {
    const stdout = captureStdout();
    const dispatch = stubDispatch({
      id: 'rec-x',
      template: { title: 'New', prompt: 'P' },
      rule: {
        freq: 'weekly',
        interval: 3,
        dtStart: '2026-05-04T15:00:00Z',
        timeZone: 'UTC',
      },
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-02T00:00:00Z',
    });
    await runRecurringCli(
      [
        'update',
        '--agent', 'r',
        '--id', 'rec-x',
        '--interval', '3',
        '--confirmed',
      ],
      { dispatchExecFn: dispatch.fn, stdoutWrite: stdout.write },
    );
    const input = dispatch.calls[0]!.input as Record<string, unknown>;
    assert.equal(input.confirmed, true);
    assert.deepEqual(input.rule, { interval: 3 });
    assert.match(stdout.output.join(''), /Recurring task updated:/);
  });

  it('remove — forwards confirmed=true and renders the removed=true message', async () => {
    const stdout = captureStdout();
    const dispatch = stubDispatch({
      agentId: 'r',
      id: 'rec-x',
      removed: true,
    });
    await runRecurringCli(
      ['remove', '--agent', 'r', '--id', 'rec-x', '--confirmed'],
      { dispatchExecFn: dispatch.fn, stdoutWrite: stdout.write },
    );
    const input = dispatch.calls[0]!.input as Record<string, unknown>;
    assert.equal(input.confirmed, true);
    assert.match(stdout.output.join(''), /Recurring task removed: rec-x \(agent r\)\./);
  });

  it('exports a non-empty RECURRING_HELP banner for the top-level help', () => {
    assert.match(RECURRING_HELP, /^Usage:\n/);
    assert.match(RECURRING_HELP, /aweek recurring list/);
    assert.match(RECURRING_HELP, /aweek plan recurring/);
  });
});
