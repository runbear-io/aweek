/**
 * Per-agent recurring-task management skill.
 *
 * This module is the CLI/skill entry point for the four lifecycle
 * operations users perform against an agent's recurrence rules:
 *
 *   - `listRecurringTasks`   — read every rule for one agent
 *   - `addRecurringTask`     — append a new rule (auto-derives the `rec-<slug>` id)
 *   - `updateRecurringTask`  — patch the template / rule / exceptions of an existing rule
 *   - `removeRecurringTask`  — delete a rule by id
 *
 * Each handler is a thin orchestrator on top of {@link RecurringTaskStore}
 * (see `src/storage/recurring-task-store.ts`): the storage layer owns
 * AJV validation, atomic writes, and the `recurring-tasks.json` on-disk
 * shape. This module only adds:
 *
 *   - argument parsing / pre-flight validation that surfaces a friendly
 *     error message before the AJV blob would (mirrors {@link notify} and
 *     {@link delegateTask});
 *   - auto-population of `id`, `createdAt`, and `updatedAt` so callers can
 *     submit a bare `{ template, rule }` instead of having to hand-mint the
 *     `rec-<slug>` id pattern;
 *   - sender-agent existence checks against {@link AgentStore} so a typo
 *     in the slug fails fast instead of writing an orphan
 *     `recurring-tasks.json` under a non-existent agent's directory;
 *   - small formatters used by the dispatcher / CLI for human-readable output.
 *
 * Destructive operations (`remove`, the rule-changing branch of `update`)
 * are confirmation-gated at the SKILL.md layer per project policy — this
 * module enforces the `confirmed: true` flag the dispatcher forwards from
 * the skill's AskUserQuestion gate. When the gate is bypassed (caller
 * forgot to forward `confirmed`, passed `false`, or passed a truthy-but-
 * non-true value such as `"true"`/`1`), the underlying validators throw
 * an Error decorated with `code: ERECURRING_NOT_CONFIRMED` (mirrors
 * `ESLACK_INIT_NOT_CONFIRMED` in `slack-init.ts`) so the dispatcher /
 * tests can branch on `err.code` instead of regex-matching the message
 * string. The store itself stays unaware of the gate (mirrors how
 * `slack-init.ts` separates persistence from consent).
 *
 * Idempotence: re-running `addRecurringTask` with the same `id` (when the
 * caller supplies one explicitly) replaces the prior record verbatim via
 * `RecurringTaskStore.save()`. `removeRecurringTask` on a non-existent id
 * is a no-op that returns `{ removed: false }` rather than throwing.
 *
 * v1 scope note (matches the seed's "v1 out of scope" constraint):
 *   - FREQ=YEARLY is rejected up-front (the AJV schema only allows
 *     daily | weekly | monthly anyway, but we surface a clearer error).
 *   - Only one rule per `RecurringTask` (no multi-RRULE).
 *   - RDATE / EXDATE are not accepted (use the `exceptions` array on the
 *     existing record instead).
 *   - No iCalendar import/export.
 */
import { AgentStore } from '../storage/agent-store.js';
import {
  RecurringTaskStore,
  type RecurringTask,
  type RecurringTaskTemplate,
  type RecurrenceRule,
  type RecurrenceException,
  type RecurrenceFreq,
  type RecurrenceByDay,
  type RecurringTaskPriority,
} from '../storage/recurring-task-store.js';

/**
 * Error code thrown when a destructive recurring-task operation
 * (`remove`, or `update` carrying a rule overlay) runs without
 * `confirmed: true` having been collected through the SKILL.md's
 * `AskUserQuestion` gate. Mirrors `ESLACK_INIT_NOT_CONFIRMED` —
 * callers branch on `err.code` to distinguish "consent missing" from
 * other validation failures so the dispatcher can surface a recoverable
 * "re-run with confirmation" message instead of a generic Error.
 */
export const ERECURRING_NOT_CONFIRMED = 'ERECURRING_NOT_CONFIRMED';

/** Default `<projectRoot>/.aweek/agents` location — matches every other skill. */
const DEFAULT_AGENTS_DIR = '.aweek/agents';

/**
 * Construct an Error decorated with `code: ERECURRING_NOT_CONFIRMED` so
 * callers can branch on the failure mode (mirrors `slack-init.ts`'s
 * pattern). Kept private so every confirmation gate goes through the same
 * factory and the code stays in lock-step with the constant.
 */
function notConfirmedError(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = ERECURRING_NOT_CONFIRMED;
  return err;
}

/** Allowed `freq` values — v1 explicitly omits `yearly`. */
const ALLOWED_FREQS: ReadonlyArray<RecurrenceFreq> = ['daily', 'weekly', 'monthly'];

/** Allowed weekday codes — Monday-first to match ISO 8601 / aweek's calendar. */
const ALLOWED_BYDAY: ReadonlyArray<RecurrenceByDay> = [
  'MO',
  'TU',
  'WE',
  'TH',
  'FR',
  'SA',
  'SU',
];

/** Priority enum mirror (matches `recurringTaskTemplateSchema`). */
const ALLOWED_PRIORITIES: ReadonlyArray<RecurringTaskPriority> = [
  'critical',
  'high',
  'medium',
  'low',
];

/** Allowed exception kinds. */
const ALLOWED_EXCEPTION_KINDS: ReadonlyArray<RecurrenceException['kind']> = [
  'skip',
  'override',
];

/** Template title cap mirrors the AJV schema (1..80). */
const MAX_TITLE_LENGTH = 80;
/** Template `track` cap mirrors the AJV schema (1..64). */
const MAX_TRACK_LENGTH = 64;
/** estimatedMinutes is bounded 1..480 in the schema. */
const MIN_ESTIMATED_MINUTES = 1;
const MAX_ESTIMATED_MINUTES = 480;
/** byMonthDay range. */
const MIN_BY_MONTH_DAY = 1;
const MAX_BY_MONTH_DAY = 31;
/** bySetPos range — {-5..-1, 1..5}, never 0. */
const MIN_BY_SET_POS = -5;
const MAX_BY_SET_POS = 5;

/** Optional dependency injection bag — used by tests to swap in temp stores. */
export interface RecurringSkillDeps {
  agentStore?: any;
  recurringTaskStore?: any;
  /**
   * Skip the agent-existence check. Defaults to `false` (i.e. we DO verify
   * the agent exists). Useful for tests that want to drive the storage
   * layer without seeding an `AgentStore`.
   */
  skipAgentCheck?: boolean;
  /**
   * Injectable clock so tests can pin `createdAt` / `updatedAt` to a
   * deterministic value without monkey-patching `Date`.
   */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/** Free-form params for `listRecurringTasks`. */
export interface ListRecurringTasksParams {
  /** Agents data dir (defaults to `.aweek/agents`). */
  agentsDir?: string;
  /** Target agent slug. Required. */
  agentId?: string;
}

/** Free-form params for `addRecurringTask`. */
export interface AddRecurringTaskParams {
  agentsDir?: string;
  agentId?: string;
  /**
   * Caller-supplied id (`rec-<slug>`). Optional — when omitted the handler
   * derives one from `template.title` so the skill markdown can stay terse.
   * When supplied and a record with this id already exists, the call
   * replaces the prior record verbatim (idempotent re-run).
   */
  id?: string;
  template?: RecurringTaskTemplate;
  rule?: RecurrenceRule;
  exceptions?: RecurrenceException[];
}

/** Free-form params for `updateRecurringTask`. */
export interface UpdateRecurringTaskParams {
  agentsDir?: string;
  agentId?: string;
  /** Required — target the existing record by id. */
  id?: string;
  /**
   * Partial template overlay. Any field omitted keeps its prior value.
   * Replaces top-level template fields wholesale (no deep merge inside
   * the optional `track` / `objectiveId` strings).
   */
  template?: Partial<RecurringTaskTemplate>;
  /**
   * Partial rule overlay. As with `template`, omitted fields keep their
   * prior values. Setting `count` or `until` clears the OTHER terminator
   * to keep the RFC 5545 XOR invariant satisfied even on update.
   */
  rule?: Partial<RecurrenceRule>;
  /**
   * When supplied, replaces the exceptions array wholesale. Omit to keep
   * the existing exceptions intact. Pass `[]` to clear all exceptions.
   */
  exceptions?: RecurrenceException[];
  /**
   * Destructive-edit gate. Required to be `true` when the update changes
   * `rule` (which affects every future occurrence). Optional when only
   * the template / exceptions are being edited.
   */
  confirmed?: boolean;
}

/** Free-form params for `removeRecurringTask`. */
export interface RemoveRecurringTaskParams {
  agentsDir?: string;
  agentId?: string;
  /** Required — id of the recurring task to delete. */
  id?: string;
  /** Required to be `true` — `remove` is unconditionally destructive. */
  confirmed?: boolean;
}

// ---------------------------------------------------------------------------
// Validated payloads
// ---------------------------------------------------------------------------

/** Output of {@link validateListParams}. */
export interface ValidatedListParams {
  agentsDir: string;
  agentId: string;
}

/** Output of {@link validateAddParams}. */
export interface ValidatedAddParams {
  agentsDir: string;
  agentId: string;
  /** Caller-supplied id (when present) — auto-derived later when absent. */
  id?: string;
  template: RecurringTaskTemplate;
  rule: RecurrenceRule;
  exceptions?: RecurrenceException[];
}

/** Output of {@link validateUpdateParams}. */
export interface ValidatedUpdateParams {
  agentsDir: string;
  agentId: string;
  id: string;
  template?: Partial<RecurringTaskTemplate>;
  rule?: Partial<RecurrenceRule>;
  exceptions?: RecurrenceException[];
  confirmed: boolean;
}

/** Output of {@link validateRemoveParams}. */
export interface ValidatedRemoveParams {
  agentsDir: string;
  agentId: string;
  id: string;
  confirmed: boolean;
}

// ---------------------------------------------------------------------------
// Pure validators
// ---------------------------------------------------------------------------

/**
 * Pure validator for the `list` operation. Throws descriptive errors for
 * every failure mode so the CLI dispatcher can surface a user-readable
 * message before any storage I/O.
 */
export function validateListParams(
  params: ListRecurringTasksParams = {},
): ValidatedListParams {
  const agentId = requireAgentId(params.agentId);
  const agentsDir = params.agentsDir || DEFAULT_AGENTS_DIR;
  return { agentsDir, agentId };
}

/**
 * Pure validator for the `add` operation. Runs the full template + rule +
 * exceptions shape check so the AJV blob is replaced by friendly messages.
 * AJV runs a second time inside the store on `save()` — this layer is
 * defense-in-depth, not the schema gate of record.
 */
export function validateAddParams(
  params: AddRecurringTaskParams = {},
): ValidatedAddParams {
  const agentId = requireAgentId(params.agentId);
  const agentsDir = params.agentsDir || DEFAULT_AGENTS_DIR;

  if (!params.template || typeof params.template !== 'object') {
    throw new Error('template is required and must be an object');
  }
  if (!params.rule || typeof params.rule !== 'object') {
    throw new Error('rule is required and must be an object');
  }
  const template = validateTemplate(params.template);
  const rule = validateRule(params.rule);
  const exceptions =
    params.exceptions === undefined
      ? undefined
      : validateExceptionsArray(params.exceptions);

  const result: ValidatedAddParams = { agentsDir, agentId, template, rule };
  if (params.id !== undefined) {
    result.id = validateRecurringTaskId(params.id);
  }
  if (exceptions !== undefined) {
    result.exceptions = exceptions;
  }
  return result;
}

/**
 * Pure validator for the `update` operation. Requires `confirmed: true`
 * whenever a `rule` overlay is supplied — rule edits affect every future
 * occurrence and are treated as destructive per project policy.
 */
export function validateUpdateParams(
  params: UpdateRecurringTaskParams = {},
): ValidatedUpdateParams {
  const agentId = requireAgentId(params.agentId);
  const agentsDir = params.agentsDir || DEFAULT_AGENTS_DIR;
  const id = requireRecurringTaskId(params.id);

  if (
    params.template === undefined &&
    params.rule === undefined &&
    params.exceptions === undefined
  ) {
    throw new Error(
      'update requires at least one of template, rule, or exceptions',
    );
  }

  const result: ValidatedUpdateParams = {
    agentsDir,
    agentId,
    id,
    confirmed: params.confirmed === true,
  };

  if (params.template !== undefined) {
    result.template = validateTemplate(params.template, { partial: true });
  }
  if (params.rule !== undefined) {
    result.rule = validateRule(params.rule, { partial: true });
  }
  if (params.exceptions !== undefined) {
    result.exceptions = validateExceptionsArray(params.exceptions);
  }

  if (result.rule !== undefined && !result.confirmed) {
    throw notConfirmedError(
      'update with a rule overlay requires confirmed: true — ' +
        'rule edits affect every future occurrence. Collect consent via ' +
        'AskUserQuestion in the SKILL.md gate before passing confirmed: true.',
    );
  }

  return result;
}

/**
 * Pure validator for the `remove` operation. Always requires
 * `confirmed: true` — deleting a recurring task drops every future
 * occurrence.
 */
export function validateRemoveParams(
  params: RemoveRecurringTaskParams = {},
): ValidatedRemoveParams {
  const agentId = requireAgentId(params.agentId);
  const agentsDir = params.agentsDir || DEFAULT_AGENTS_DIR;
  const id = requireRecurringTaskId(params.id);
  if (params.confirmed !== true) {
    throw notConfirmedError(
      'remove requires confirmed: true — deleting a recurring task ' +
        'drops every future occurrence. Collect consent via ' +
        'AskUserQuestion in the SKILL.md gate before passing confirmed: true.',
    );
  }
  return { agentsDir, agentId, id, confirmed: true };
}

// ---------------------------------------------------------------------------
// Handler functions — list / add / update / remove
// ---------------------------------------------------------------------------

/**
 * List every RecurringTask for one agent. Returns `[]` when the agent has
 * no `recurring-tasks.json` on disk (preserves the backward-compat
 * baseline: an agent without recurring tasks behaves identically to
 * current main).
 */
export async function listRecurringTasks(
  params: ListRecurringTasksParams,
  deps: RecurringSkillDeps = {},
): Promise<{ agentId: string; recurringTasks: RecurringTask[] }> {
  const validated = validateListParams(params);
  const agentStore = deps.agentStore || new AgentStore(validated.agentsDir);
  const recurringTaskStore =
    deps.recurringTaskStore || new RecurringTaskStore(validated.agentsDir);

  if (!deps.skipAgentCheck) {
    const exists = await agentStore.exists(validated.agentId);
    if (!exists) {
      throw new Error(`Agent not found: ${validated.agentId}`);
    }
  }

  const recurringTasks = await recurringTaskStore.loadAll(validated.agentId);
  return { agentId: validated.agentId, recurringTasks };
}

/**
 * Append a new RecurringTask. Auto-derives `id` from `template.title` when
 * the caller does not pass one, stamps `createdAt` to the injectable
 * clock's `now()`, and hands off to `RecurringTaskStore.save()` for AJV
 * validation + atomic persistence.
 */
export async function addRecurringTask(
  params: AddRecurringTaskParams,
  deps: RecurringSkillDeps = {},
): Promise<RecurringTask> {
  const validated = validateAddParams(params);
  const agentStore = deps.agentStore || new AgentStore(validated.agentsDir);
  const recurringTaskStore =
    deps.recurringTaskStore || new RecurringTaskStore(validated.agentsDir);

  if (!deps.skipAgentCheck) {
    const exists = await agentStore.exists(validated.agentId);
    if (!exists) {
      throw new Error(`Agent not found: ${validated.agentId}`);
    }
  }

  const id = validated.id ?? deriveRecurringTaskId(validated.template.title);
  const now = (deps.now ?? (() => new Date()))().toISOString();

  const record: RecurringTask = {
    id,
    template: validated.template,
    rule: validated.rule,
    createdAt: now,
  };
  if (validated.exceptions !== undefined) {
    record.exceptions = validated.exceptions;
  }

  // RecurringTaskStore.save replaces an existing record with the same id
  // (idempotent re-runs) and otherwise appends. AJV runs inside save().
  return recurringTaskStore.save(validated.agentId, record);
}

/**
 * Patch an existing RecurringTask. Loads the prior record, applies the
 * supplied template / rule / exceptions overlays, then hands off to
 * `RecurringTaskStore.update()` so AJV runs against the merged result and
 * `updatedAt` is auto-stamped.
 *
 * Rule overlays that touch the `count` / `until` terminators clear the
 * OTHER terminator before persistence — the RFC 5545 XOR is otherwise
 * violated when a caller sets `count` on a record that previously had
 * `until` (or vice-versa).
 */
export async function updateRecurringTask(
  params: UpdateRecurringTaskParams,
  deps: RecurringSkillDeps = {},
): Promise<RecurringTask> {
  const validated = validateUpdateParams(params);
  const agentStore = deps.agentStore || new AgentStore(validated.agentsDir);
  const recurringTaskStore =
    deps.recurringTaskStore || new RecurringTaskStore(validated.agentsDir);

  if (!deps.skipAgentCheck) {
    const exists = await agentStore.exists(validated.agentId);
    if (!exists) {
      throw new Error(`Agent not found: ${validated.agentId}`);
    }
  }

  const updated = await recurringTaskStore.update(
    validated.agentId,
    validated.id,
    (current: RecurringTask) => mergeRecurringTask(current, validated),
  );

  if (!updated) {
    throw new Error(
      `RecurringTask not found: ${validated.id} (agent ${validated.agentId})`,
    );
  }
  return updated;
}

/**
 * Delete a RecurringTask by id. Returns `{ removed: false }` (no throw)
 * when the id doesn't exist so re-running a delete from a stale UI is a
 * safe no-op. Confirmation is enforced inside the validator.
 */
export async function removeRecurringTask(
  params: RemoveRecurringTaskParams,
  deps: RecurringSkillDeps = {},
): Promise<{ agentId: string; id: string; removed: boolean }> {
  const validated = validateRemoveParams(params);
  const agentStore = deps.agentStore || new AgentStore(validated.agentsDir);
  const recurringTaskStore =
    deps.recurringTaskStore || new RecurringTaskStore(validated.agentsDir);

  if (!deps.skipAgentCheck) {
    const exists = await agentStore.exists(validated.agentId);
    if (!exists) {
      throw new Error(`Agent not found: ${validated.agentId}`);
    }
  }

  const removed = await recurringTaskStore.delete(validated.agentId, validated.id);
  return { agentId: validated.agentId, id: validated.id, removed };
}

// ---------------------------------------------------------------------------
// Formatters — used by the dispatcher / CLI for human-readable output
// ---------------------------------------------------------------------------

/**
 * Format the result of `listRecurringTasks` as a compact multi-line
 * summary suitable for direct CLI output.
 */
export function formatListResult(result: {
  agentId: string;
  recurringTasks: RecurringTask[];
}): string {
  if (result.recurringTasks.length === 0) {
    return `No recurring tasks configured for ${result.agentId}.`;
  }
  const lines = [
    `${result.recurringTasks.length} recurring task(s) for ${result.agentId}:`,
  ];
  for (const r of result.recurringTasks) {
    lines.push(`  • ${r.id} — ${r.template.title} [${describeRule(r.rule)}]`);
  }
  return lines.join('\n');
}

/** Format the result of `addRecurringTask` as a human-readable summary. */
export function formatAddResult(record: RecurringTask): string {
  return [
    `Recurring task added:`,
    `  ID: ${record.id}`,
    `  Title: ${record.template.title}`,
    `  Rule: ${describeRule(record.rule)}`,
    `  Time zone: ${record.rule.timeZone}`,
    `  Anchor: ${record.rule.dtStart}`,
    `  Created: ${record.createdAt}`,
  ].join('\n');
}

/** Format the result of `updateRecurringTask`. */
export function formatUpdateResult(record: RecurringTask): string {
  return [
    `Recurring task updated:`,
    `  ID: ${record.id}`,
    `  Title: ${record.template.title}`,
    `  Rule: ${describeRule(record.rule)}`,
    `  Updated: ${record.updatedAt ?? '(unchanged)'}`,
  ].join('\n');
}

/** Format the result of `removeRecurringTask`. */
export function formatRemoveResult(result: {
  agentId: string;
  id: string;
  removed: boolean;
}): string {
  if (result.removed) {
    return `Recurring task removed: ${result.id} (agent ${result.agentId}).`;
  }
  return `Recurring task ${result.id} not found for agent ${result.agentId} — nothing to remove.`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Render a one-line human-readable description of a recurrence rule for
 * the list / add / update formatters. Mirrors the GCal-style phrasing
 * users see in the SPA so the CLI output is recognisable.
 */
function describeRule(rule: RecurrenceRule): string {
  const parts: string[] = [];
  const interval = rule.interval;
  if (rule.freq === 'daily') {
    parts.push(interval === 1 ? 'daily' : `every ${interval} days`);
  } else if (rule.freq === 'weekly') {
    parts.push(interval === 1 ? 'weekly' : `every ${interval} weeks`);
    if (rule.byDay && rule.byDay.length > 0) {
      parts.push(`on ${rule.byDay.join(', ')}`);
    }
  } else {
    parts.push(interval === 1 ? 'monthly' : `every ${interval} months`);
    if (rule.byMonthDay !== undefined) {
      parts.push(`on day ${rule.byMonthDay}`);
    }
    if (rule.bySetPos !== undefined && rule.byDay) {
      parts.push(`pos ${rule.bySetPos} of ${rule.byDay.join(', ')}`);
    }
  }
  if (rule.count !== undefined) parts.push(`x${rule.count}`);
  if (rule.until !== undefined) parts.push(`until ${rule.until}`);
  return parts.join(' ');
}

/**
 * Derive a `rec-<slug>` id from a free-form title. Lowercases the title,
 * collapses non-alphanumerics into single hyphens, trims leading/trailing
 * hyphens, and appends a short timestamp suffix so two adds in the same
 * minute with the same title still get distinct ids.
 */
function deriveRecurringTaskId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Date.now().toString(36);
  const body = slug.length > 0 ? `${slug}-${suffix}` : suffix;
  return `rec-${body}`;
}

/** Throw a friendly error when `agentId` is missing / wrong-typed. */
function requireAgentId(agentId: unknown): string {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('agentId is required and must be a non-empty string');
  }
  return agentId;
}

/** Throw a friendly error when `id` is missing / wrong-typed. */
function requireRecurringTaskId(id: unknown): string {
  if (!id || typeof id !== 'string') {
    throw new Error('id is required and must be a non-empty string');
  }
  return validateRecurringTaskId(id);
}

/** Surface a friendly error when an id violates the `rec-<slug>` pattern. */
function validateRecurringTaskId(id: string): string {
  if (!/^rec-[a-z0-9-]+$/.test(id)) {
    throw new Error(
      `id must match the pattern rec-<slug> (lowercase alphanum + hyphens); got "${id}"`,
    );
  }
  return id;
}

interface TemplateValidationOptions {
  /** When true, omitted required fields are allowed (used by `update`). */
  partial?: boolean;
}

/**
 * Pre-AJV validator for the template shape — mirrors `recurringTaskTemplateSchema`.
 * Returns the validated subset (only the keys the caller actually supplied)
 * so partial updates don't accidentally widen the record.
 */
function validateTemplate(
  template: Partial<RecurringTaskTemplate>,
  opts: TemplateValidationOptions = {},
): RecurringTaskTemplate {
  const partial = opts.partial === true;

  // Reject unknown keys up-front so a typo (e.g. `promt`) surfaces here
  // instead of being silently dropped.
  const knownKeys: ReadonlyArray<keyof RecurringTaskTemplate> = [
    'title',
    'prompt',
    'objectiveId',
    'priority',
    'estimatedMinutes',
    'track',
  ];
  for (const key of Object.keys(template)) {
    if (!knownKeys.includes(key as keyof RecurringTaskTemplate)) {
      throw new Error(`template has unknown key "${key}"`);
    }
  }

  if (!partial) {
    if (template.title === undefined) throw new Error('template.title is required');
    if (template.prompt === undefined) throw new Error('template.prompt is required');
  }

  const out = {} as RecurringTaskTemplate;

  if (template.title !== undefined) {
    if (typeof template.title !== 'string' || template.title.length < 1) {
      throw new Error('template.title must be a non-empty string');
    }
    if (template.title.length > MAX_TITLE_LENGTH) {
      throw new Error(
        `template.title must not exceed ${MAX_TITLE_LENGTH} characters`,
      );
    }
    out.title = template.title;
  }

  if (template.prompt !== undefined) {
    if (typeof template.prompt !== 'string' || template.prompt.length < 1) {
      throw new Error('template.prompt must be a non-empty string');
    }
    out.prompt = template.prompt;
  }

  if (template.objectiveId !== undefined) {
    if (typeof template.objectiveId !== 'string' || template.objectiveId.length < 1) {
      throw new Error('template.objectiveId must be a non-empty string');
    }
    out.objectiveId = template.objectiveId;
  }

  if (template.priority !== undefined) {
    if (!ALLOWED_PRIORITIES.includes(template.priority)) {
      throw new Error(
        `template.priority must be one of ${ALLOWED_PRIORITIES.join(', ')}`,
      );
    }
    out.priority = template.priority;
  }

  if (template.estimatedMinutes !== undefined) {
    if (
      !Number.isInteger(template.estimatedMinutes) ||
      template.estimatedMinutes < MIN_ESTIMATED_MINUTES ||
      template.estimatedMinutes > MAX_ESTIMATED_MINUTES
    ) {
      throw new Error(
        `template.estimatedMinutes must be an integer in [${MIN_ESTIMATED_MINUTES}, ${MAX_ESTIMATED_MINUTES}]`,
      );
    }
    out.estimatedMinutes = template.estimatedMinutes;
  }

  if (template.track !== undefined) {
    if (typeof template.track !== 'string' || template.track.length < 1) {
      throw new Error('template.track must be a non-empty string');
    }
    if (template.track.length > MAX_TRACK_LENGTH) {
      throw new Error(`template.track must not exceed ${MAX_TRACK_LENGTH} characters`);
    }
    out.track = template.track;
  }

  return out;
}

interface RuleValidationOptions {
  partial?: boolean;
}

/**
 * Pre-AJV validator for the rule shape — mirrors `recurrenceRuleSchema`.
 * Enforces the RFC 5545 XOR between `count` and `until`, the v1
 * out-of-scope rejection of FREQ=YEARLY, and the bySetPos ≠ 0 invariant.
 */
function validateRule(
  rule: Partial<RecurrenceRule>,
  opts: RuleValidationOptions = {},
): RecurrenceRule {
  const partial = opts.partial === true;

  const knownKeys: ReadonlyArray<keyof RecurrenceRule> = [
    'freq',
    'interval',
    'byDay',
    'byMonthDay',
    'bySetPos',
    'dtStart',
    'timeZone',
    'count',
    'until',
  ];
  for (const key of Object.keys(rule)) {
    if (!knownKeys.includes(key as keyof RecurrenceRule)) {
      throw new Error(`rule has unknown key "${key}"`);
    }
  }

  if (!partial) {
    if (rule.freq === undefined) throw new Error('rule.freq is required');
    if (rule.interval === undefined) throw new Error('rule.interval is required');
    if (rule.dtStart === undefined) throw new Error('rule.dtStart is required');
    if (rule.timeZone === undefined) throw new Error('rule.timeZone is required');
  }

  const out = {} as RecurrenceRule;

  if (rule.freq !== undefined) {
    if (!ALLOWED_FREQS.includes(rule.freq)) {
      throw new Error(
        `rule.freq must be one of ${ALLOWED_FREQS.join(', ')} — ` +
          'FREQ=YEARLY is out of scope for v1',
      );
    }
    out.freq = rule.freq;
  }

  if (rule.interval !== undefined) {
    if (!Number.isInteger(rule.interval) || rule.interval < 1) {
      throw new Error('rule.interval must be an integer ≥ 1');
    }
    out.interval = rule.interval;
  }

  if (rule.byDay !== undefined) {
    if (!Array.isArray(rule.byDay) || rule.byDay.length === 0) {
      throw new Error('rule.byDay must be a non-empty array of weekday codes');
    }
    const seen = new Set<string>();
    for (const code of rule.byDay) {
      if (!ALLOWED_BYDAY.includes(code)) {
        throw new Error(
          `rule.byDay contains invalid weekday code "${code}"; ` +
            `allowed: ${ALLOWED_BYDAY.join(', ')}`,
        );
      }
      if (seen.has(code)) {
        throw new Error(`rule.byDay contains duplicate weekday code "${code}"`);
      }
      seen.add(code);
    }
    out.byDay = [...rule.byDay];
  }

  if (rule.byMonthDay !== undefined) {
    if (
      !Number.isInteger(rule.byMonthDay) ||
      rule.byMonthDay < MIN_BY_MONTH_DAY ||
      rule.byMonthDay > MAX_BY_MONTH_DAY
    ) {
      throw new Error(
        `rule.byMonthDay must be an integer in [${MIN_BY_MONTH_DAY}, ${MAX_BY_MONTH_DAY}]`,
      );
    }
    out.byMonthDay = rule.byMonthDay;
  }

  if (rule.bySetPos !== undefined) {
    if (
      !Number.isInteger(rule.bySetPos) ||
      rule.bySetPos < MIN_BY_SET_POS ||
      rule.bySetPos > MAX_BY_SET_POS ||
      rule.bySetPos === 0
    ) {
      throw new Error(
        `rule.bySetPos must be a non-zero integer in [${MIN_BY_SET_POS}, ${MAX_BY_SET_POS}]`,
      );
    }
    out.bySetPos = rule.bySetPos;
  }

  if (rule.dtStart !== undefined) {
    if (typeof rule.dtStart !== 'string' || Number.isNaN(Date.parse(rule.dtStart))) {
      throw new Error('rule.dtStart must be a UTC ISO-8601 date-time string');
    }
    out.dtStart = rule.dtStart;
  }

  if (rule.timeZone !== undefined) {
    if (typeof rule.timeZone !== 'string' || rule.timeZone.length < 1) {
      throw new Error('rule.timeZone must be a non-empty IANA zone name');
    }
    out.timeZone = rule.timeZone;
  }

  if (rule.count !== undefined && rule.until !== undefined) {
    throw new Error(
      'rule.count and rule.until are mutually exclusive (RFC 5545 XOR)',
    );
  }

  if (rule.count !== undefined) {
    if (!Number.isInteger(rule.count) || rule.count < 1) {
      throw new Error('rule.count must be an integer ≥ 1');
    }
    out.count = rule.count;
  }

  if (rule.until !== undefined) {
    if (typeof rule.until !== 'string' || Number.isNaN(Date.parse(rule.until))) {
      throw new Error('rule.until must be a UTC ISO-8601 date-time string');
    }
    out.until = rule.until;
  }

  return out;
}

/**
 * Validate the per-exception entries (and the array shape itself).
 * Surfaces a friendly error before AJV runs in the store. Returns a fresh
 * copy of the array so callers don't share mutable state with the store.
 */
function validateExceptionsArray(
  exceptions: RecurrenceException[],
): RecurrenceException[] {
  if (!Array.isArray(exceptions)) {
    throw new Error('exceptions must be an array');
  }
  return exceptions.map((ex, idx) => validateException(ex, idx));
}

/** Validate a single exception entry. */
function validateException(
  ex: RecurrenceException,
  idx: number,
): RecurrenceException {
  if (!ex || typeof ex !== 'object') {
    throw new Error(`exceptions[${idx}] must be an object`);
  }
  if (
    typeof ex.originalRunAt !== 'string' ||
    Number.isNaN(Date.parse(ex.originalRunAt))
  ) {
    throw new Error(
      `exceptions[${idx}].originalRunAt must be a UTC ISO-8601 date-time string`,
    );
  }
  if (!ALLOWED_EXCEPTION_KINDS.includes(ex.kind)) {
    throw new Error(
      `exceptions[${idx}].kind must be one of ${ALLOWED_EXCEPTION_KINDS.join(', ')}`,
    );
  }
  const result: RecurrenceException = {
    originalRunAt: ex.originalRunAt,
    kind: ex.kind,
  };
  if (ex.override !== undefined) {
    if (typeof ex.override !== 'object' || ex.override === null) {
      throw new Error(`exceptions[${idx}].override must be an object`);
    }
    // override is a Partial<template> with an extra optional `runAt`.
    // Run it through the template validator in partial mode, then re-attach
    // the optional `runAt` (which the template validator rejects as
    // unknown).
    const { runAt, ...rest } = ex.override;
    const overlay = validateTemplate(rest, { partial: true }) as Partial<
      RecurringTaskTemplate
    > & { runAt?: string };
    if (runAt !== undefined) {
      if (typeof runAt !== 'string' || Number.isNaN(Date.parse(runAt))) {
        throw new Error(
          `exceptions[${idx}].override.runAt must be a UTC ISO-8601 date-time string`,
        );
      }
      overlay.runAt = runAt;
    }
    result.override = overlay;
  }
  if (ex.kind === 'override' && result.override === undefined) {
    throw new Error(
      `exceptions[${idx}] has kind=override but no override body`,
    );
  }
  return result;
}

/**
 * Merge an update overlay into the current RecurringTask. Pure function
 * (no I/O) — the storage layer calls this inside `update()`'s updater
 * callback and then AJV-validates the merged record on save.
 */
function mergeRecurringTask(
  current: RecurringTask,
  overlay: ValidatedUpdateParams,
): RecurringTask {
  const next: RecurringTask = {
    ...current,
    template: { ...current.template },
    rule: { ...current.rule },
  };

  if (overlay.template) {
    Object.assign(next.template, overlay.template);
  }

  if (overlay.rule) {
    Object.assign(next.rule, overlay.rule);
    // Re-enforce the RFC 5545 XOR after the merge — setting `count` on a
    // record that previously had `until` (or vice-versa) must clear the
    // other terminator, otherwise AJV's `oneOf` rejects on save.
    if (overlay.rule.count !== undefined) {
      delete next.rule.until;
    } else if (overlay.rule.until !== undefined) {
      delete next.rule.count;
    }
  }

  if (overlay.exceptions !== undefined) {
    next.exceptions = overlay.exceptions;
  }

  return next;
}
