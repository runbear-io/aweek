/**
 * Argv parser + runner for the top-level `aweek recurring` subcommand
 * (and its `aweek plan recurring` alias). Lives next to {@link dispatchExec}
 * so the recurring CLI surface stays a thin adapter between argv flags and
 * the JSON-object input shape every recurring dispatcher entry expects.
 *
 * Why a dedicated subcommand on top of the existing `aweek exec recurring
 * <fn>` surface? `aweek exec` is a low-level escape hatch — it takes the
 * raw skill-input JSON via `--input-json -`, which is fine for skill
 * markdown but unfriendly for humans typing at the shell. The
 * `recurring` subcommand maps Google-Calendar-style flags
 * (`--freq weekly --interval 2 --byday MO,WE`) onto that JSON shape so the
 * CLI flow stays readable.
 *
 * Four operations mirror the dispatcher entries:
 *
 *   - `aweek recurring list`    → `recurring:listRecurringTasks`
 *   - `aweek recurring add`     → `recurring:addRecurringTask`
 *   - `aweek recurring update`  → `recurring:updateRecurringTask`
 *   - `aweek recurring remove`  → `recurring:removeRecurringTask`
 *
 * Destructive operations (`remove`, `update` with a rule overlay) require
 * `--confirmed` on the CLI just as the skill module requires
 * `confirmed: true` in its JSON input — the SKILL markdown layer collects
 * the AskUserQuestion gate before passing the flag through.
 *
 * The handler returns a `Promise<void>` and writes its formatted output
 * via injectable stdout/stderr callbacks so the colocated test suite can
 * capture without touching `process.stdout`.
 */
import { resolve, join } from 'node:path';
import { dispatchExec } from './dispatcher.js';
import {
  formatListResult,
  formatAddResult,
  formatUpdateResult,
  formatRemoveResult,
} from '../skills/recurring.js';
import type {
  RecurringTask,
} from '../storage/recurring-task-store.js';

/** The four operations the recurring subcommand exposes. */
export type RecurringOperation = 'list' | 'add' | 'update' | 'remove';

/**
 * Default agents-dir, relative to the resolved project dir. Mirrors the
 * constant baked into `src/skills/recurring.ts` so both layers agree on
 * the on-disk location when neither side passes an override.
 */
const DEFAULT_AGENTS_DIR_REL = '.aweek/agents';

/**
 * Help banner emitted by `aweek recurring --help`, `aweek recurring help`,
 * and the top-level `aweek --help` (re-exported so callers don't have to
 * import it through this module's barrel).
 */
export const RECURRING_HELP: string = `Usage:
  aweek recurring list --agent <slug> [options]
  aweek recurring add --agent <slug> --title <s> --prompt <s>
                       --freq <daily|weekly|monthly> --interval <n>
                       --dtstart <iso> --timezone <iana> [rule options]
                       [template options]
  aweek recurring update --agent <slug> --id <rec-id>
                       [template options] [rule options] [--confirmed]
  aweek recurring remove --agent <slug> --id <rec-id> --confirmed

Common options:
  --project-dir <dir>          Project root directory (default: cwd)
  --format json|text           Output format (default: text)

Template options (add / update):
  --title <s>                  Template title (required on add)
  --prompt <s>                 Template prompt (required on add)
  --priority <p>               critical | high | medium | low
  --estimated-minutes <n>      1..480
  --track <s>                  Independent pacing lane (e.g. "x-com")
  --objective-id <s>           Free-form link back to plan.md
  --id <rec-...>               Caller-supplied recurring-task id
                               (auto-derived on add when omitted;
                                required on update and remove)

Rule options (add / update):
  --freq <f>                   daily | weekly | monthly (required on add)
  --interval <n>               Interval >= 1 (required on add)
  --dtstart <iso>              UTC ISO anchor (required on add)
  --timezone <iana>            IANA zone name (required on add)
  --byday <MO,TU,...>          Comma-separated weekday codes
  --bymonthday <n>             1..31
  --bysetpos <n>               -5..-1 or 1..5 (never 0)
  --count <n>                  COUNT terminator (XOR with --until)
  --until <iso>                UNTIL terminator (XOR with --count)

Destructive-edit gate:
  --confirmed                  Required for remove; required for update
                               when a rule overlay is supplied.

Alias:
  aweek plan recurring <op>    Equivalent to aweek recurring <op>.`;

/** Map a CLI operation onto the dispatcher fn name in the `recurring` module. */
const OP_TO_FN: Record<RecurringOperation, string> = {
  list: 'listRecurringTasks',
  add: 'addRecurringTask',
  update: 'updateRecurringTask',
  remove: 'removeRecurringTask',
};

/** Parsed-flag bag. All fields are optional until the per-op builder validates them. */
export interface ParsedRecurringFlags {
  agent?: string;
  id?: string;
  title?: string;
  prompt?: string;
  priority?: string;
  estimatedMinutes?: number;
  track?: string;
  objectiveId?: string;
  freq?: string;
  interval?: number;
  dtstart?: string;
  timezone?: string;
  byDay?: string[];
  byMonthDay?: number;
  bySetPos?: number;
  count?: number;
  until?: string;
  confirmed: boolean;
  projectDir?: string;
  format: 'json' | 'text';
}

/** Build an EUSAGE-coded error with the same shape `aweek exec` errors carry. */
function makeUsage(message: string): Error {
  return Object.assign(new Error(message), { code: 'EUSAGE' });
}

/**
 * Parse a string into an integer, rejecting anything that isn't a clean
 * `[-]?digits` token. Surfaces a user-friendly error before the dispatcher
 * gets a NaN.
 */
function parseIntStrict(flagName: string, raw: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw makeUsage(`${flagName} must be an integer; got "${raw}"`);
  }
  return Number.parseInt(raw, 10);
}

/**
 * Parse the post-operation argv into the flag bag. Throws on unknown
 * flags, missing values, or invalid `--format` enums — the caller catches
 * EUSAGE and prints the message + help.
 *
 * Exported so the colocated test suite can pin every flag's parse without
 * round-tripping through `runRecurringCli`.
 */
export function parseRecurringFlags(argv: string[]): ParsedRecurringFlags {
  const flags: ParsedRecurringFlags = { confirmed: false, format: 'text' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const need = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw makeUsage(`${arg} requires a value`);
      i++;
      return next;
    };
    switch (arg) {
      case '--agent':
      case '--agent-id':
        flags.agent = need();
        break;
      case '--id':
        flags.id = need();
        break;
      case '--title':
        flags.title = need();
        break;
      case '--prompt':
        flags.prompt = need();
        break;
      case '--priority':
        flags.priority = need();
        break;
      case '--estimated-minutes':
        flags.estimatedMinutes = parseIntStrict('--estimated-minutes', need());
        break;
      case '--track':
        flags.track = need();
        break;
      case '--objective-id':
        flags.objectiveId = need();
        break;
      case '--freq':
        flags.freq = need();
        break;
      case '--interval':
        flags.interval = parseIntStrict('--interval', need());
        break;
      case '--dtstart':
        flags.dtstart = need();
        break;
      case '--timezone':
      case '--time-zone':
        flags.timezone = need();
        break;
      case '--byday':
      case '--by-day':
        flags.byDay = need()
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
      case '--bymonthday':
      case '--by-month-day':
        flags.byMonthDay = parseIntStrict('--bymonthday', need());
        break;
      case '--bysetpos':
      case '--by-set-pos':
        flags.bySetPos = parseIntStrict('--bysetpos', need());
        break;
      case '--count':
        flags.count = parseIntStrict('--count', need());
        break;
      case '--until':
        flags.until = need();
        break;
      case '--confirmed':
        flags.confirmed = true;
        break;
      case '--project-dir':
        flags.projectDir = need();
        break;
      case '--format': {
        const fmt = need();
        if (fmt !== 'json' && fmt !== 'text') {
          throw makeUsage(
            `Invalid --format value: ${fmt} (expected "json" or "text")`,
          );
        }
        flags.format = fmt;
        break;
      }
      default:
        throw makeUsage(`Unknown flag: ${arg}`);
    }
  }
  return flags;
}

/** Output of {@link buildDispatchInput}. */
export interface RecurringDispatchInput {
  moduleKey: 'recurring';
  fnName: string;
  input: Record<string, unknown>;
}

/**
 * Build the dispatcher-input object for one of the four operations.
 * Performs the per-op required-flag check up front (so the error message
 * mentions the missing CLI flag, not the deeper JSON-field name from the
 * skill validator) and lets every other validation fall through to the
 * skill's `validate*Params` helpers.
 *
 * Exported alongside {@link parseRecurringFlags} so unit tests can assert
 * the input shape without invoking the real dispatcher.
 */
export function buildDispatchInput(
  op: RecurringOperation,
  flags: ParsedRecurringFlags,
): RecurringDispatchInput {
  const fnName = OP_TO_FN[op];
  if (!flags.agent) throw makeUsage('--agent is required');

  const resolvedProjectDir =
    flags.projectDir !== undefined ? resolve(flags.projectDir) : undefined;
  const agentsDir =
    resolvedProjectDir !== undefined
      ? join(resolvedProjectDir, DEFAULT_AGENTS_DIR_REL)
      : DEFAULT_AGENTS_DIR_REL;

  const base: Record<string, unknown> = {
    agentId: flags.agent,
    agentsDir,
  };
  if (resolvedProjectDir !== undefined) base.projectDir = resolvedProjectDir;

  if (op === 'list') {
    return { moduleKey: 'recurring', fnName, input: base };
  }

  if (op === 'remove') {
    if (!flags.id) throw makeUsage('--id is required for `remove`');
    base.id = flags.id;
    base.confirmed = flags.confirmed;
    return { moduleKey: 'recurring', fnName, input: base };
  }

  // add / update share the template + rule construction. Each field is
  // forwarded only when the caller actually passed the flag — passing
  // `undefined` would cause `validateTemplate` to flag a partial update
  // payload that mutates fields the user didn't ask to touch.
  const template: Record<string, unknown> = {};
  if (flags.title !== undefined) template.title = flags.title;
  if (flags.prompt !== undefined) template.prompt = flags.prompt;
  if (flags.priority !== undefined) template.priority = flags.priority;
  if (flags.estimatedMinutes !== undefined)
    template.estimatedMinutes = flags.estimatedMinutes;
  if (flags.track !== undefined) template.track = flags.track;
  if (flags.objectiveId !== undefined) template.objectiveId = flags.objectiveId;

  const rule: Record<string, unknown> = {};
  if (flags.freq !== undefined) rule.freq = flags.freq;
  if (flags.interval !== undefined) rule.interval = flags.interval;
  if (flags.dtstart !== undefined) rule.dtStart = flags.dtstart;
  if (flags.timezone !== undefined) rule.timeZone = flags.timezone;
  if (flags.byDay !== undefined) rule.byDay = flags.byDay;
  if (flags.byMonthDay !== undefined) rule.byMonthDay = flags.byMonthDay;
  if (flags.bySetPos !== undefined) rule.bySetPos = flags.bySetPos;
  if (flags.count !== undefined) rule.count = flags.count;
  if (flags.until !== undefined) rule.until = flags.until;

  const hasTemplate = Object.keys(template).length > 0;
  const hasRule = Object.keys(rule).length > 0;

  if (op === 'add') {
    if (!hasTemplate) {
      throw makeUsage('add requires --title and --prompt');
    }
    if (!hasRule) {
      throw makeUsage(
        'add requires --freq, --interval, --dtstart, and --timezone',
      );
    }
    base.template = template;
    base.rule = rule;
    if (flags.id !== undefined) base.id = flags.id;
    return { moduleKey: 'recurring', fnName, input: base };
  }

  // op === 'update'
  if (!flags.id) throw makeUsage('--id is required for `update`');
  if (!hasTemplate && !hasRule) {
    throw makeUsage(
      'update requires at least one of --title/--prompt/--priority/' +
        '--estimated-minutes/--track/--objective-id or a --freq/--interval/' +
        '--dtstart/--timezone/--byday/--bymonthday/--bysetpos/--count/--until flag',
    );
  }
  base.id = flags.id;
  if (hasTemplate) base.template = template;
  if (hasRule) base.rule = rule;
  base.confirmed = flags.confirmed;
  return { moduleKey: 'recurring', fnName, input: base };
}

/** Loose `dispatchExec` shape so tests can stub the dispatcher cleanly. */
export type DispatchExecFn = (params: {
  moduleKey: string;
  fnName: string;
  input: unknown;
}) => Promise<unknown> | unknown;

/** Optional dependency injection bag — used by tests. */
export interface RunRecurringCliDeps {
  dispatchExecFn?: DispatchExecFn;
  /** Defaults to `process.stdout.write.bind(process.stdout)`. */
  stdoutWrite?: (chunk: string) => void;
}

/**
 * Resolve the result of a dispatcher call into a human-readable string
 * by routing through the right `format*Result` helper from the skill
 * module. The dispatcher already runs the underlying handler — this is
 * purely a presentation step.
 */
function formatTextResult(op: RecurringOperation, result: unknown): string {
  switch (op) {
    case 'list':
      return formatListResult(
        result as { agentId: string; recurringTasks: RecurringTask[] },
      );
    case 'add':
      return formatAddResult(result as RecurringTask);
    case 'update':
      return formatUpdateResult(result as RecurringTask);
    case 'remove':
      return formatRemoveResult(
        result as { agentId: string; id: string; removed: boolean },
      );
  }
}

/**
 * Entry point for the `aweek recurring` subcommand (and the `aweek plan
 * recurring` alias). `argv` is the slice AFTER the routing keyword — i.e.
 * the caller has already consumed `recurring` (or `plan recurring`).
 *
 * Returns `void` on success, throws an `EUSAGE`-coded Error on bad input.
 * Output is written through `deps.stdoutWrite` so tests can capture it
 * without touching `process.stdout`.
 */
export async function runRecurringCli(
  argv: string[],
  deps: RunRecurringCliDeps = {},
): Promise<void> {
  const stdout = deps.stdoutWrite ?? ((s: string) => process.stdout.write(s));

  const op = argv[0];
  if (!op || op === '--help' || op === '-h' || op === 'help') {
    stdout(`${RECURRING_HELP}\n`);
    return;
  }
  if (op !== 'list' && op !== 'add' && op !== 'update' && op !== 'remove') {
    throw makeUsage(`Unknown recurring operation: ${op}`);
  }

  const flags = parseRecurringFlags(argv.slice(1));
  const { moduleKey, fnName, input } = buildDispatchInput(op, flags);

  const dispatch = deps.dispatchExecFn ?? dispatchExec;
  const result = await dispatch({ moduleKey, fnName, input });

  if (flags.format === 'json') {
    stdout(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  stdout(`${formatTextResult(op, result)}\n`);
}
