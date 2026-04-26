/**
 * Select-some handler (Sub-AC 2 of AC 50302).
 *
 * The `/aweek:init` four-option menu's **Select some** branch lets the user
 * multi-select a subset of the unhired Claude Code subagents discovered
 * under `.claude/agents/<slug>.md` and wrap each picked slug into a minimal
 * aweek scheduling JSON shell. This module is the data primitive for that
 * flow:
 *
 *   - {@link buildSelectSomeChoices} enumerates the available unhired
 *     subagents as a multi-select payload (`value`, `label`, `description`)
 *     the skill markdown can hand straight to `AskUserQuestion`. The
 *     description is enriched from the live frontmatter of
 *     `.claude/agents/<slug>.md` so the user sees what each subagent does
 *     before picking it.
 *   - {@link runSelectSomeHire} is the end-to-end handler: it re-validates
 *     the user's selection against the menu's unhired list (defense in
 *     depth against stale picks or slugs that were hired concurrently),
 *     then delegates to {@link hireAllSubagents} to wrap every picked slug.
 *   - {@link formatSelectSomeResult} produces a human-readable summary that
 *     distinguishes "selection was invalid" from "selection was valid but
 *     some slugs failed to wrap".
 *
 * ### Design contract
 *
 * - Identity lives in `.claude/agents/<slug>.md` (the sole source of truth
 *   per the refactor). This handler only materialises the aweek-side
 *   wrapper — it never edits the `.md` files.
 * - Per-slug safety rails (plugin-namespaced skip, already-hired skip,
 *   missing-.md fail, invalid-slug fail) are inherited from
 *   `hireAllSubagents`. Select-some does not duplicate them; its job is the
 *   multi-select UX layer plus the selection-level validation.
 * - The module is pure data / orchestration — no `AskUserQuestion` calls,
 *   no direct filesystem writes outside the delegated handler. UX lives in
 *   the skill markdown (`skills/aweek-init.md`, Step 6.1/6.2).
 *
 * @module skills/hire-select-some
 */
import {
  hireAllSubagents,
  formatHireAllSummary,
  type HireAllResult,
} from './hire-all.js';
import {
  readSubagentIdentity,
  type SubagentIdentity,
} from '../subagents/subagent-file.js';
import { validateSelectedSlugs, type InitHireMenu } from './init-hire-menu.js';
import type { AgentStore } from '../storage/agent-store.js';

/**
 * Default prompt copy shown above the multi-select list. The skill markdown
 * can override via {@link buildSelectSomeChoices}' `promptText` option when
 * it needs to echo context-specific wording.
 */
export const DEFAULT_SELECT_SOME_PROMPT_TEXT =
  'Select the subagents to wrap into aweek scheduling JSONs (pick one or more):';

/**
 * Default fallback description used for a choice entry when the subagent .md
 * has no frontmatter `description` (or the file cannot be read). Keeps the
 * multi-select picker readable even when metadata is missing.
 */
export function defaultChoiceDescription(slug: string): string {
  return `Wrap .claude/agents/${slug}.md into an aweek scheduling JSON shell (empty goals / plans, default budget).`;
}

/** Injectable identity reader signature accepted by {@link buildSelectSomeChoices}. */
export type ReadIdentityFn = (
  slug: string,
  projectDir?: string,
) => Promise<SubagentIdentity>;

/** Options for {@link buildSelectSomeChoices}. */
export interface BuildSelectSomeChoicesOptions {
  /**
   * Project root for the .md lookup; defaults to `process.cwd()` via
   * `readSubagentIdentity`.
   */
  projectDir?: string;
  /** Override for the prompt header copy. */
  promptText?: string;
  /**
   * Flag the markdown can forward to `AskUserQuestion` so the picker
   * renders with checkbox semantics instead of radio-button semantics.
   */
  multiSelect?: boolean;
  /** Injectable identity reader (test hook). Defaults to {@link readSubagentIdentity}. */
  readIdentityFn?: ReadIdentityFn;
}

/** A single choice entry built by {@link buildSelectSomeChoices}. */
export interface SelectSomeChoice {
  value: string;
  label: string;
  description: string;
  missing: boolean;
  path: string;
}

/** Result of {@link buildSelectSomeChoices}. */
export interface SelectSomeChoicesPayload {
  promptText: string;
  multiSelect: boolean;
  slugs: string[];
  choices: SelectSomeChoice[];
}

/**
 * Build the multi-select choice payload the skill markdown passes to
 * `AskUserQuestion`.
 *
 * Each unhired slug becomes one choice entry enriched with the live name +
 * description read from `.claude/agents/<slug>.md`. When the .md file is
 * missing or has no frontmatter `description`, the choice falls back to a
 * generic "Wrap into aweek scheduling JSON" line — the user still sees the
 * slug and can make an informed pick.
 *
 * Reading the frontmatter per-slug keeps the menu in sync with the .md
 * files without requiring callers to pre-load anything. Consumers that want
 * to avoid filesystem access (tests, dry-run previews) can inject a custom
 * `readIdentityFn` that returns the frontmatter shape directly.
 */
export async function buildSelectSomeChoices(
  menu: InitHireMenu | null | undefined,
  opts: BuildSelectSomeChoicesOptions = {},
): Promise<SelectSomeChoicesPayload> {
  const {
    projectDir,
    promptText = DEFAULT_SELECT_SOME_PROMPT_TEXT,
    multiSelect = true,
    readIdentityFn,
  } = opts;

  // Defensive copy — keep the returned `slugs` array independent of the
  // caller's menu so mutations do not leak back into the menu state.
  const slugs: string[] = Array.isArray(menu?.unhired) ? [...menu!.unhired] : [];
  const readIdentity: ReadIdentityFn = readIdentityFn || readSubagentIdentity;

  const choices: SelectSomeChoice[] = [];
  for (const slug of slugs) {
    let identity: SubagentIdentity;
    try {
      identity = await readIdentity(slug, projectDir);
    } catch {
      // Never throw from the builder — a malformed .md should degrade to
      // a generic choice entry, not crash the whole picker. The user can
      // still select the slug and the downstream wrapper will surface any
      // actual file errors.
      identity = { missing: true, name: '', description: '', body: '', path: '' };
    }

    const name =
      identity && typeof identity.name === 'string' && identity.name.length > 0
        ? identity.name
        : slug;
    const description =
      identity &&
      typeof identity.description === 'string' &&
      identity.description.length > 0
        ? identity.description
        : defaultChoiceDescription(slug);

    choices.push({
      value: slug,
      label: name,
      description,
      missing: Boolean(identity?.missing),
      path: identity?.path || '',
    });
  }

  return {
    promptText,
    multiSelect,
    slugs,
    choices,
  };
}

/** Options accepted by {@link runSelectSomeHire}. */
export interface RunSelectSomeHireOptions {
  /** Return value of `buildInitHireMenu`. */
  menu?: InitHireMenu | null;
  /** Slugs picked in the multi-select UI. */
  selected?: unknown;
  /** Override forwarded to `hireAllSubagents`. */
  weeklyTokenLimit?: number;
  /** Project root; forwarded to `hireAllSubagents`. */
  projectDir?: string;
  /** aweek data directory override; forwarded to `hireAllSubagents`. */
  dataDir?: string;
  /** Pre-constructed store (test hook); forwarded to `hireAllSubagents`. */
  agentStore?: AgentStore;
  /**
   * Injectable hire-all delegate for tests that want to assert the exact
   * call args without touching the filesystem.
   */
  hireFn?: typeof hireAllSubagents;
}

/** Result of {@link runSelectSomeHire}. */
export interface RunSelectSomeHireResult {
  success: boolean;
  validation: { valid: boolean; errors: string[] };
  hire: HireAllResult | null;
}

/**
 * Run the select-some branch end-to-end.
 *
 * Takes the user's multi-select response (an array of slug strings) plus
 * the originating menu, validates the selection against the menu's unhired
 * list via {@link validateSelectedSlugs}, and delegates to
 * {@link hireAllSubagents} to wrap every valid slug with a minimal aweek
 * JSON shell.
 *
 * The return shape distinguishes two failure modes so the skill markdown
 * can render a targeted error instead of an opaque "something went wrong":
 *
 *   - **Validation failure** (`validation.valid === false`): the user's
 *     selection itself was bad (empty array, unknown slug, duplicate slug,
 *     non-string entry). `hire` is `null` — no wrapper was written. The
 *     markdown should re-prompt for a valid multi-select subset.
 *   - **Per-slug failure** (`hire.success === false`): the selection was
 *     structurally valid but one or more slugs failed to wrap at the
 *     hire-all layer (missing .md, invalid slug shape, filesystem error).
 *     The `hire` result carries the per-slug outcome breakdown.
 *
 * The top-level `success` flag is only `true` when validation succeeded
 * AND every slug was wrapped (or legitimately skipped as a no-op).
 */
export async function runSelectSomeHire({
  menu,
  selected,
  weeklyTokenLimit,
  projectDir,
  dataDir,
  agentStore,
  hireFn,
}: RunSelectSomeHireOptions = {}): Promise<RunSelectSomeHireResult> {
  const validation = validateSelectedSlugs(selected, menu);
  if (!validation.valid) {
    return {
      success: false,
      validation,
      hire: null,
    };
  }

  const delegate = hireFn || hireAllSubagents;
  const hire = await delegate({
    slugs: selected as string[],
    weeklyTokenLimit,
    projectDir,
    dataDir,
    agentStore,
  });

  return {
    success: Boolean(hire && hire.success),
    validation,
    hire,
  };
}

/**
 * Render a {@link runSelectSomeHire} result as a human-readable block the
 * skill markdown can echo after dispatch.
 *
 * The two failure modes get distinct output:
 *
 *   - Validation failed → "Selection rejected" header plus the per-error
 *     list. No hire output is shown because no wrapper was written.
 *   - Selection was valid → the nested {@link formatHireAllSummary} block
 *     verbatim. When a selection succeeded, the output matches what
 *     hire-all would print, so users see a consistent summary regardless
 *     of which branch they came in from.
 */
export function formatSelectSomeResult(
  result: RunSelectSomeHireResult | null | undefined,
): string {
  if (!result) return '';

  if (result.validation && !result.validation.valid) {
    const lines = ['Selection rejected — pick a valid subset of unhired subagents.'];
    for (const err of result.validation.errors) {
      lines.push(`  ! ${err}`);
    }
    return lines.join('\n');
  }

  return formatHireAllSummary(result.hire);
}
