/**
 * Storage layer for per-agent recurring tasks.
 *
 * Persists the canonical RecurringTask documents to
 * `.aweek/agents/<agentId>/recurring-tasks.json` — one file per agent,
 * containing an array of RecurringTask records. The on-disk shape is
 * validated by `aweek://schemas/recurring-task-list` (which $refs the
 * single-record schema), so a corrupt or schema-drifted file fails
 * loudly at read time.
 *
 * Why one file per agent (vs one file per record like `goals/` or
 * `weekly-plans/`)? Per-agent cardinality is small (a handful of
 * recurrence rules), and the heartbeat materializer reads every rule on
 * every tick — a single JSON file is cheaper to read than N file syscalls.
 * The notification feed follows the same shape (`notifications.json`).
 *
 * Occurrences themselves are NEVER persisted here. They are derived from
 * the rule + exceptions at read time by the recurrence-expander, and
 * either rendered lazily by the SPA calendar or materialized eagerly
 * into the existing WeeklyPlanStore by the heartbeat.
 */
import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertValid } from '../schemas/validator.js';

const SCHEMA_ID_LIST = 'aweek://schemas/recurring-task-list';
const SCHEMA_ID_RECORD = 'aweek://schemas/recurring-task';

/** Filename for the per-agent recurring-tasks file. */
export const RECURRING_TASKS_FILENAME = 'recurring-tasks.json';

/** Valid recurrence frequencies — v1 ships daily/weekly/monthly only. */
export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly';

/** Valid two-letter weekday codes (RFC 5545 BYDAY subset). */
export type RecurrenceByDay = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

/** Valid kinds for a per-occurrence exception. */
export type RecurrenceExceptionKind = 'skip' | 'override';

/** Priority levels — must match WeeklyTaskPriority. */
export type RecurringTaskPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Canonical shape of the inheritable task template — mirrors
 * `recurringTaskTemplateSchema` in
 * `src/schemas/recurring-task.schema.js`.
 */
export interface RecurringTaskTemplate {
  /** Short single-line label (1–80 chars). */
  title: string;
  /** Long-form instruction text sent to Claude. */
  prompt: string;
  /** Free-form tag linking back to a plan.md section. */
  objectiveId?: string;
  priority?: RecurringTaskPriority;
  /** Estimated time in minutes (1–480). */
  estimatedMinutes?: number;
  /** Independent pacing lane (e.g. `x-com`). */
  track?: string;
}

/**
 * Canonical shape of the recurrence rule — an RFC 5545 subset.
 * `count` and `until` are mutually exclusive (enforced by AJV `oneOf`).
 */
export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** Interval ≥ 1 (e.g. 2 for biweekly). */
  interval: number;
  /** Weekday filter — required for FREQ=WEEKLY in practice, optional here. */
  byDay?: RecurrenceByDay[];
  /** Calendar day of month (1..31) for FREQ=MONTHLY. */
  byMonthDay?: number;
  /** nth match within the recurrence set (-5..-1 or 1..5). */
  bySetPos?: number;
  /** Anchor instant — UTC ISO date-time. */
  dtStart: string;
  /** IANA zone name for wall-clock projection. */
  timeZone: string;
  /** COUNT terminator (mutually exclusive with `until`). */
  count?: number;
  /** UNTIL terminator (mutually exclusive with `count`). */
  until?: string;
}

/**
 * Canonical shape of a per-occurrence exception — mirrors
 * `recurrenceExceptionSchema`.
 */
export interface RecurrenceException {
  /** UTC ISO instant the expander would have produced before this exception. */
  originalRunAt: string;
  kind: RecurrenceExceptionKind;
  /**
   * Partial template overlay applied when kind=override. Any omitted
   * field falls back to the template value. A `runAt` here moves the
   * occurrence in time (Google-Calendar "move this occurrence" UX).
   */
  override?: Partial<RecurringTaskTemplate> & { runAt?: string };
}

/**
 * Canonical shape of a single RecurringTask document — mirrors
 * `recurringTaskSchema` in `src/schemas/recurring-task.schema.js`.
 */
export interface RecurringTask {
  /** Unique RecurringTask id (`rec-<slug>`). */
  id: string;
  template: RecurringTaskTemplate;
  rule: RecurrenceRule;
  exceptions?: RecurrenceException[];
  /** UTC ISO date-time when created. */
  createdAt: string;
  /** UTC ISO date-time of last mutation. */
  updatedAt?: string;
}

/** Updater function signature accepted by `RecurringTaskStore.update()`. */
export type RecurringTaskUpdater = (current: RecurringTask) => RecurringTask;

/**
 * File-based store for recurring tasks. One JSON file per agent at
 * `<baseDir>/<agentId>/recurring-tasks.json`. The file is an array of
 * `RecurringTask` records (validated as `recurring-task-list`).
 */
export class RecurringTaskStore {
  /** Root data directory (e.g., ./.aweek/agents). */
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Path to an agent's recurring-tasks file. */
  _filePath(agentId: string): string {
    return join(this.baseDir, agentId, RECURRING_TASKS_FILENAME);
  }

  /** Ensure the parent directory for an agent exists. */
  async init(agentId: string): Promise<void> {
    await mkdir(dirname(this._filePath(agentId)), { recursive: true });
  }

  /** Check if a recurring-tasks file exists for an agent. */
  async exists(agentId: string): Promise<boolean> {
    try {
      await access(this._filePath(agentId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load all recurring tasks for an agent. Returns an empty array when
   * the file does not exist (agent has no recurring-tasks configured).
   * Validates the on-disk shape on every read.
   */
  async loadAll(agentId: string): Promise<RecurringTask[]> {
    let raw: string;
    try {
      raw = await readFile(this._filePath(agentId), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const parsed = JSON.parse(raw) as RecurringTask[];
    assertValid(SCHEMA_ID_LIST, parsed);
    return parsed;
  }

  /**
   * Persist the full list for an agent. Validates the array before
   * writing — a single invalid record aborts the write. Idempotent:
   * writing the same array twice produces the same file (sorted by id
   * to keep diffs stable across re-saves).
   */
  async saveAll(agentId: string, records: RecurringTask[]): Promise<RecurringTask[]> {
    const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
    assertValid(SCHEMA_ID_LIST, sorted);
    await this.init(agentId);
    const data = JSON.stringify(sorted, null, 2) + '\n';
    await writeFile(this._filePath(agentId), data, 'utf-8');
    return sorted;
  }

  /**
   * Save a single RecurringTask — appends when the id is new, replaces
   * the existing record otherwise. Validates the individual record and
   * (transitively, via `saveAll`) the full list.
   */
  async save(agentId: string, record: RecurringTask): Promise<RecurringTask> {
    assertValid(SCHEMA_ID_RECORD, record);
    const current = await this.loadAll(agentId);
    const next = current.filter((r) => r.id !== record.id);
    next.push(record);
    await this.saveAll(agentId, next);
    return record;
  }

  /** Load a single RecurringTask by id. Returns null when missing. */
  async load(agentId: string, recurringTaskId: string): Promise<RecurringTask | null> {
    const all = await this.loadAll(agentId);
    return all.find((r) => r.id === recurringTaskId) ?? null;
  }

  /**
   * Delete a single RecurringTask by id. No-op when the record is
   * missing. Returns true when a record was removed.
   */
  async delete(agentId: string, recurringTaskId: string): Promise<boolean> {
    const current = await this.loadAll(agentId);
    const next = current.filter((r) => r.id !== recurringTaskId);
    if (next.length === current.length) return false;
    if (next.length === 0) {
      // Remove the file entirely so an agent with no rules has no
      // on-disk artifact (matches the "no recurring-tasks.json" baseline
      // that backward-compat readers expect).
      await rm(this._filePath(agentId), { force: true });
      return true;
    }
    await this.saveAll(agentId, next);
    return true;
  }

  /**
   * Update a RecurringTask via an updater function. Loads, patches,
   * validates, saves. Stamps `updatedAt` automatically.
   */
  async update(
    agentId: string,
    recurringTaskId: string,
    updater: RecurringTaskUpdater,
  ): Promise<RecurringTask | null> {
    const current = await this.load(agentId, recurringTaskId);
    if (!current) return null;
    const updated = updater(current);
    updated.updatedAt = new Date().toISOString();
    await this.save(agentId, updated);
    return updated;
  }
}
