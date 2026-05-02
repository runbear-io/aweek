/**
 * Four-option hire menu for the `/aweek:init` skill (Sub-AC 2 of AC 6) plus the
 * automatic fall-through delegation to `/aweek:hire` when there is nothing to
 * adopt (Sub-AC 3 of AC 6).
 *
 * After `/aweek:init` finishes its infrastructure steps (ensure data dir,
 * register skills, optional heartbeat install) the skill markdown presents a
 * final interactive prompt offering to hire one or more Claude Code subagents
 * right now. When at least one **unhired** subagent exists under
 * `.claude/agents/<slug>.md` the user sees an interactive four-option menu:
 *
 *   1. **Hire all**    — wrap every unhired subagent into an aweek JSON in one
 *                        pass.
 *   2. **Select some** — pick specific unhired slugs to wrap.
 *   3. **Create new**  — skip adoption and jump straight into the `/aweek:hire`
 *                        create-new wizard (three-field identity capture).
 *   4. **Skip**        — finish here; the user can always run `/aweek:hire`
 *                        later.
 *
 * **Fall-through (Sub-AC 3 of AC 6).** When no unhired subagents exist the
 * menu is **skipped entirely** and the wizard automatically delegates to
 * `/aweek:hire` (create-new branch). Showing a 2-option "create-new vs skip"
 * picker in this state would be noise — the user already triggered init,
 * infrastructure setup is done, and there is nothing to adopt, so the only
 * useful next action is to launch the create-new hire wizard. The new
 * {@link resolveInitHireMenu} helper bakes this decision in: it returns
 * `{ fallThrough: true, route: <hire descriptor> }` when there is nothing to
 * adopt and `{ fallThrough: false, menu, ... }` when the four-option picker
 * should be shown.
 *
 * The original {@link buildInitHireMenu} still collapses its `options` list to
 * `create-new` + `skip` when no unhired subagents exist — that is the menu
 * state the skill markdown would render IF it ever bypassed the fall-through.
 * In the canonical flow `resolveInitHireMenu` is the entry point and the
 * collapsed two-option list is never shown to the user.
 *
 * This module is the **data primitive** for the menu. It:
 *
 *   - enumerates the canonical choice identifiers,
 *   - builds the menu state (available options + unhired slug list),
 *   - formats a ready-to-show prompt body the skill markdown can pass to
 *     `AskUserQuestion`, and
 *   - maps the user's selection back to a stable route handler descriptor the
 *     markdown can act on (which skill to launch, which slugs to hire, which
 *     branch of `/aweek:hire` to enter).
 *
 * The module is deliberately pure — no `AskUserQuestion`, no filesystem writes,
 * no claude CLI invocation. UX and orchestration live in
 * `skills/aweek-init.md`; this file is the testable backing logic.
 */
import { listUnhiredSubagents } from './hire-route.js';
import type { AgentStore } from '../storage/agent-store.js';

/**
 * Canonical choice identifiers returned by the four-option menu.
 *
 * Exposed as a frozen object so consumers use dot access (`INIT_HIRE_MENU_CHOICE.HIRE_ALL`)
 * without drifting stringly-typed from the menu definition below.
 */
export const INIT_HIRE_MENU_CHOICE = Object.freeze({
  HIRE_ALL: 'hire-all',
  SELECT_SOME: 'select-some',
  CREATE_NEW: 'create-new',
  SKIP: 'skip',
} as const);

/** Union of every canonical choice identifier. */
export type InitHireMenuChoice =
  (typeof INIT_HIRE_MENU_CHOICE)[keyof typeof INIT_HIRE_MENU_CHOICE];

/**
 * Set form of the choice identifiers, handy for validation.
 */
const ALL_CHOICES: ReadonlySet<string> = new Set(Object.values(INIT_HIRE_MENU_CHOICE));

/** Shape of a single entry in {@link INIT_HIRE_MENU_OPTIONS}. */
export interface InitHireMenuOption {
  value: InitHireMenuChoice;
  label: string;
  description: string;
  requiresUnhired: boolean;
}

/**
 * Option metadata for every menu choice.
 *
 * Each entry is:
 *   - `value`       — canonical identifier sent back by `AskUserQuestion`.
 *   - `label`       — short button label shown in the picker.
 *   - `description` — longer one-line explanation rendered under the label.
 *   - `requiresUnhired` — when `true`, the option is only offered if the menu
 *                         has at least one unhired subagent. `select-some`
 *                         and `hire-all` both require at least one candidate.
 *
 * Order is the canonical display order. `buildInitHireMenu` preserves this
 * order when filtering out options that don't apply to the current state —
 * the user always sees "Hire all" before "Select some" before "Create new"
 * before "Skip" when all four are active.
 */
export const INIT_HIRE_MENU_OPTIONS: readonly InitHireMenuOption[] = Object.freeze([
  Object.freeze({
    value: INIT_HIRE_MENU_CHOICE.HIRE_ALL,
    label: 'Hire all',
    description:
      'Wrap every unhired subagent under .claude/agents/ into an aweek scheduling JSON in one pass.',
    requiresUnhired: true,
  }),
  Object.freeze({
    value: INIT_HIRE_MENU_CHOICE.SELECT_SOME,
    label: 'Select some',
    description:
      'Pick specific unhired subagents to wrap; the rest stay untouched and can be hired later.',
    requiresUnhired: true,
  }),
  Object.freeze({
    value: INIT_HIRE_MENU_CHOICE.CREATE_NEW,
    label: 'Create new',
    description:
      'Skip adoption and launch the /aweek:hire wizard to create a brand-new subagent from scratch.',
    requiresUnhired: false,
  }),
  Object.freeze({
    value: INIT_HIRE_MENU_CHOICE.SKIP,
    label: 'Skip',
    description:
      'Finish init without hiring. You can always run /aweek:hire later.',
    requiresUnhired: false,
  }),
]);

/**
 * Default prompt text shown above the menu choices when at least one unhired
 * subagent is available.
 */
export const DEFAULT_MENU_PROMPT_TEXT =
  'Infrastructure setup is complete. How would you like to hire subagents into aweek?';

/**
 * Prompt text shown when no unhired subagents are available. The menu is
 * reduced to `create-new` + `skip` in this state — there is nothing to adopt.
 */
export const DEFAULT_MENU_PROMPT_TEXT_NO_UNHIRED =
  'Infrastructure setup is complete. No unhired subagents were found under .claude/agents/. Would you like to create one now or skip?';

/** Injectable discovery helper signature. */
export type ListUnhiredFn = (
  opts: BuildInitHireMenuOptions,
) => Promise<string[] | null | undefined>;

/** Options accepted by {@link buildInitHireMenu}. */
export interface BuildInitHireMenuOptions {
  /** Project root; defaults to `process.cwd()`. */
  projectDir?: string;
  /** aweek data directory override. */
  dataDir?: string;
  /** Pre-constructed store (test hook). */
  agentStore?: AgentStore;
  /** Override for the primary prompt copy. */
  promptText?: string;
  /**
   * Override for the empty-menu prompt copy (shown when there are zero
   * unhired subagents).
   */
  promptTextNoUnhired?: string;
  /**
   * Injectable discovery helper. Mirrors the `hasAgentsFn` pattern used by
   * `finalizeInit` so unit tests can exercise the full control flow without
   * touching the filesystem.
   */
  listUnhiredFn?: ListUnhiredFn;
}

/** Result of {@link buildInitHireMenu}. */
export interface InitHireMenu {
  unhired: string[];
  hasUnhired: boolean;
  fallThrough: boolean;
  options: InitHireMenuOption[];
  promptText: string;
  projectDir: string;
}

/**
 * Build the menu state the skill markdown renders.
 *
 * Discovers unhired subagents (plugin-namespaced slugs filtered out per the v1
 * constraint — see `hire-route.ts`) and returns the filtered option list plus
 * the right prompt copy for the current state. The markdown passes `options`
 * directly to `AskUserQuestion`.
 *
 * Note: when `hasUnhired === false` the canonical `/aweek:init` flow uses
 * {@link resolveInitHireMenu} to bypass the menu entirely and delegate
 * straight to `/aweek:hire` (Sub-AC 3 of AC 6). The collapsed
 * `create-new` + `skip` options on this return value are kept for backwards
 * compatibility with callers that opt out of the fall-through helper.
 */
export async function buildInitHireMenu({
  projectDir,
  dataDir,
  agentStore,
  promptText = DEFAULT_MENU_PROMPT_TEXT,
  promptTextNoUnhired = DEFAULT_MENU_PROMPT_TEXT_NO_UNHIRED,
  listUnhiredFn,
}: BuildInitHireMenuOptions = {}): Promise<InitHireMenu> {
  const discover: ListUnhiredFn = listUnhiredFn || (listUnhiredSubagents as ListUnhiredFn);
  const unhired = await discover({ projectDir, dataDir, agentStore });
  const hasUnhired = Array.isArray(unhired) && unhired.length > 0;

  const options = INIT_HIRE_MENU_OPTIONS.filter((opt) =>
    hasUnhired ? true : !opt.requiresUnhired,
  );

  return {
    unhired: Array.isArray(unhired) ? [...unhired] : [],
    hasUnhired,
    // Sub-AC 3 of AC 6: when nothing is available to adopt the canonical
    // entry point (`resolveInitHireMenu`) bypasses the prompt and auto-
    // delegates to `/aweek:hire`. Surface the flag here so consumers that
    // call `buildInitHireMenu` directly can branch on it without a second
    // probe of the unhired list.
    fallThrough: !hasUnhired,
    options: [...options],
    promptText: hasUnhired ? promptText : promptTextNoUnhired,
    projectDir: projectDir || process.cwd(),
  };
}

/**
 * Default user-facing reason copy used when `/aweek:init` skips the menu and
 * automatically delegates to `/aweek:hire` because there are no unhired
 * subagents on disk. Surfaced through the `route.reason` field so the skill
 * markdown can echo it to the user in place of the dropped prompt.
 */
export const DEFAULT_FALL_THROUGH_REASON =
  'No unhired subagents were found under .claude/agents/. Auto-delegating to /aweek:hire (create-new) — there is nothing to adopt and the only useful next action is to create a new agent.';

/** Options accepted by {@link resolveInitHireMenu}. */
export interface ResolveInitHireMenuOptions extends BuildInitHireMenuOptions {
  /**
   * Override for the auto-delegation reason copy. Defaults to
   * {@link DEFAULT_FALL_THROUGH_REASON}.
   */
  fallThroughReason?: string;
}

/** Fall-through route descriptor returned by {@link resolveInitHireMenu}. */
export interface InitHireMenuFallThroughRoute {
  action: typeof INIT_HIRE_MENU_CHOICE.CREATE_NEW;
  nextSkill: '/aweek:hire';
  route: 'create-new';
  slugs: string[];
  bulk: false;
  reason: string;
  fallThrough: true;
}

/** Result of {@link resolveInitHireMenu}. */
export interface ResolveInitHireMenuResult {
  fallThrough: boolean;
  menu: InitHireMenu;
  route: InitHireMenuFallThroughRoute | null;
  reason: string | null;
}

/**
 * Resolve the post-init hire decision, applying the Sub-AC 3 fall-through.
 *
 * This is the canonical entry point the `/aweek:init` skill markdown calls at
 * Step 6. It composes {@link buildInitHireMenu} with the fall-through rule so
 * the markdown gets one of two stable shapes back:
 *
 * **Fall-through path** (no unhired subagents):
 * The markdown MUST skip `AskUserQuestion` and invoke `/aweek:hire` directly
 * — the user has nothing to pick between.
 *
 * **Choose path** (one or more unhired subagents):
 * The markdown renders `menu.options` via `AskUserQuestion`, then routes the
 * user's selection through {@link routeInitHireMenuChoice} as before.
 *
 * The fall-through `route` reuses the same `{ action, nextSkill, route, slugs,
 * bulk, reason }` shape as {@link routeInitHireMenuChoice} so callers can
 * dispatch off a single descriptor type. The extra `fallThrough: true` flag
 * on the route distinguishes "user picked create-new" from "we auto-delegated
 * because nothing was available" — useful when the markdown wants to echo a
 * different status line.
 */
export async function resolveInitHireMenu({
  projectDir,
  dataDir,
  agentStore,
  promptText,
  promptTextNoUnhired,
  fallThroughReason = DEFAULT_FALL_THROUGH_REASON,
  listUnhiredFn,
}: ResolveInitHireMenuOptions = {}): Promise<ResolveInitHireMenuResult> {
  const menu = await buildInitHireMenu({
    projectDir,
    dataDir,
    agentStore,
    promptText,
    promptTextNoUnhired,
    listUnhiredFn,
  });

  if (menu.fallThrough) {
    return {
      fallThrough: true,
      menu,
      route: {
        action: INIT_HIRE_MENU_CHOICE.CREATE_NEW,
        nextSkill: '/aweek:hire',
        route: 'create-new',
        slugs: [],
        bulk: false,
        reason: fallThroughReason,
        // Distinguish "auto-delegated because nothing to adopt" from the
        // user-driven `create-new` choice on the choose path. Markdown can
        // echo a different status line ("Skipping menu — auto-delegating to
        // /aweek:hire") when this flag is true.
        fallThrough: true,
      },
      reason: fallThroughReason,
    };
  }

  return {
    fallThrough: false,
    menu,
    route: null,
    reason: null,
  };
}

/**
 * Render the menu prompt as a human-readable string for consumers that can't
 * use a structured `AskUserQuestion` payload (CLI fallbacks, log output,
 * summary displays).
 *
 * The primary skill markdown uses `menu.options` directly with `AskUserQuestion`
 * — this helper is the fallback for environments without structured pickers.
 */
export function formatInitHireMenuPrompt(
  menu: InitHireMenu | null | undefined,
): string {
  if (!menu) return '';
  const lines = [menu.promptText, ''];
  if (menu.hasUnhired) {
    lines.push('Unhired subagents available:');
    for (const slug of menu.unhired) {
      lines.push(`  - ${slug}`);
    }
    lines.push('');
  }
  lines.push('Options:');
  for (const opt of menu.options) {
    lines.push(`  - ${opt.label} (${opt.value}) — ${opt.description}`);
  }
  return lines.join('\n');
}

/** Result shape returned by validation helpers in this module. */
export interface MenuValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a raw user selection against the current menu state.
 *
 * Accepts any string; returns an `errors` array the markdown can surface so
 * the user gets an actionable message instead of a silent failure.
 */
export function validateInitHireMenuChoice(
  choice: unknown,
  menu: InitHireMenu | null | undefined,
): MenuValidationResult {
  const errors: string[] = [];

  if (typeof choice !== 'string' || choice.length === 0) {
    errors.push('Menu choice is required and must be a non-empty string');
    return { valid: false, errors };
  }

  if (!ALL_CHOICES.has(choice)) {
    errors.push(
      `Unknown menu choice "${choice}". Expected one of: ${[...ALL_CHOICES].join(', ')}`,
    );
    return { valid: false, errors };
  }

  if (menu && !menu.hasUnhired) {
    if (
      choice === INIT_HIRE_MENU_CHOICE.HIRE_ALL ||
      choice === INIT_HIRE_MENU_CHOICE.SELECT_SOME
    ) {
      errors.push(
        `Choice "${choice}" is not available: no unhired subagents were found under .claude/agents/. Pick "create-new" or "skip" instead.`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a caller-supplied `selected` slug list for the `select-some` branch.
 *
 * `select-some` requires at least one slug and every slug must appear in the
 * menu's `unhired` list — callers can't "select" something that doesn't exist
 * on disk or is already hired.
 */
export function validateSelectedSlugs(
  selected: unknown,
  menu: InitHireMenu | null | undefined,
): MenuValidationResult {
  const errors: string[] = [];
  if (!Array.isArray(selected) || selected.length === 0) {
    errors.push(
      'Select-some requires at least one subagent slug; pass a non-empty array.',
    );
    return { valid: false, errors };
  }

  const available = new Set<string>(menu?.unhired || []);
  const seen = new Set<string>();
  for (const slug of selected as unknown[]) {
    if (typeof slug !== 'string' || slug.length === 0) {
      errors.push('Every entry in `selected` must be a non-empty slug string.');
      continue;
    }
    if (seen.has(slug)) {
      errors.push(`Duplicate slug "${slug}" in selection.`);
      continue;
    }
    seen.add(slug);
    if (!available.has(slug)) {
      errors.push(
        `Slug "${slug}" is not in the unhired list for this menu; available: ${
          available.size > 0 ? [...available].join(', ') : '(none)'
        }.`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Options for {@link routeInitHireMenuChoice}. */
export interface RouteInitHireMenuChoiceOptions {
  choice?: string;
  menu?: InitHireMenu | null;
  /** Required when `choice === 'select-some'`. */
  selected?: string[];
}

/** Stable handler descriptor returned by {@link routeInitHireMenuChoice}. */
export interface InitHireMenuRoute {
  action: InitHireMenuChoice;
  nextSkill: string | null;
  route: 'pick-existing' | 'create-new' | null;
  slugs: string[];
  bulk: boolean;
  reason: string;
}

/** Error class signature emitted by {@link routeInitHireMenuChoice}. */
interface MenuChoiceError extends Error {
  code: string;
  errors: string[];
}

function makeMenuChoiceError(
  code: string,
  errors: string[],
): MenuChoiceError {
  const err = new Error(errors.join('; ')) as MenuChoiceError;
  err.code = code;
  err.errors = errors;
  return err;
}

/**
 * Map a validated menu choice (plus, for `select-some`, the chosen slug list)
 * into a stable handler descriptor the skill markdown can act on.
 *
 * Returned shape by choice:
 *
 *   - `hire-all`    → `{ action, nextSkill: '/aweek:hire', route: 'pick-existing',
 *                        slugs: [<every unhired>], bulk: true }`
 *   - `select-some` → `{ action, nextSkill: '/aweek:hire', route: 'pick-existing',
 *                        slugs: [<selected>], bulk: true }`
 *   - `create-new`  → `{ action, nextSkill: '/aweek:hire', route: 'create-new',
 *                        slugs: [], bulk: false }`
 *   - `skip`        → `{ action, nextSkill: null, route: null, slugs: [],
 *                        bulk: false }`
 *
 * The `nextSkill` is always `/aweek:hire` for non-skip choices so the markdown
 * has a single dispatch target — the `route` field tells the hire skill which
 * of its branches to enter. Bulk choices (`hire-all`, `select-some`) surface
 * every slug the markdown should loop the hire skill over, rather than
 * launching the wizard once per agent.
 */
export function routeInitHireMenuChoice(
  { choice, menu, selected }: RouteInitHireMenuChoiceOptions = {},
): InitHireMenuRoute {
  const validChoice = validateInitHireMenuChoice(choice, menu);
  if (!validChoice.valid) {
    throw makeMenuChoiceError(
      'EINIT_HIRE_MENU_BAD_CHOICE',
      validChoice.errors,
    );
  }

  switch (choice) {
    case INIT_HIRE_MENU_CHOICE.HIRE_ALL:
      return {
        action: INIT_HIRE_MENU_CHOICE.HIRE_ALL,
        nextSkill: '/aweek:hire',
        route: 'pick-existing',
        slugs: [...(menu?.unhired || [])],
        bulk: true,
        reason:
          'User chose to hire every unhired subagent at once; dispatch /aweek:hire pick-existing once per slug.',
      };

    case INIT_HIRE_MENU_CHOICE.SELECT_SOME: {
      const validSelected = validateSelectedSlugs(selected, menu);
      if (!validSelected.valid) {
        throw makeMenuChoiceError(
          'EINIT_HIRE_MENU_BAD_SELECTION',
          validSelected.errors,
        );
      }
      return {
        action: INIT_HIRE_MENU_CHOICE.SELECT_SOME,
        nextSkill: '/aweek:hire',
        route: 'pick-existing',
        slugs: [...(selected as string[])],
        bulk: true,
        reason:
          'User picked a subset of unhired subagents; dispatch /aweek:hire pick-existing once per selected slug.',
      };
    }

    case INIT_HIRE_MENU_CHOICE.CREATE_NEW:
      return {
        action: INIT_HIRE_MENU_CHOICE.CREATE_NEW,
        nextSkill: '/aweek:hire',
        route: 'create-new',
        slugs: [],
        bulk: false,
        reason:
          'User opted to create a new subagent from scratch; launch /aweek:hire create-new wizard.',
      };

    case INIT_HIRE_MENU_CHOICE.SKIP:
    default:
      return {
        action: INIT_HIRE_MENU_CHOICE.SKIP,
        nextSkill: null,
        route: null,
        slugs: [],
        bulk: false,
        reason:
          'User declined to hire any subagents during init; finish with a reminder that /aweek:hire is available later.',
      };
  }
}
