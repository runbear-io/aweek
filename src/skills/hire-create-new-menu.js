/**
 * Create-new handler (Sub-AC 3 of AC 50303).
 *
 * The `/aweek:init` four-option menu's **Create new** branch launches the
 * `/aweek:hire` skill's create-new path — a three-field identity capture
 * (name, description, systemPrompt) that writes a brand-new
 * `.claude/agents/<slug>.md` and wraps it into a minimal aweek scheduling
 * JSON shell. This module is the programmatic counterpart to the
 * `hire-all.js` / `hire-select-some.js` handlers so the markdown can
 * delegate to one entry point and get back a structured result instead of
 * re-implementing the two-step (`createNewSubagent` → aweek JSON wrapper)
 * plumbing at every call site.
 *
 * The module offers two surfaces that match the two ways `/aweek:init`
 * surfaces the create-new branch:
 *
 *   - {@link buildCreateNewLaunchInstruction} — the *non-interactive*
 *     descriptor the skill markdown renders when it needs to hand control
 *     off to the interactive `/aweek:hire` wizard. Mirrors the shape of
 *     `buildHireLaunchInstruction` in `init.js` so the markdown can
 *     dispatch off a single type regardless of which branch it came from.
 *   - {@link runCreateNewHire} — the *in-process* handler that performs
 *     the same work the interactive wizard would, but from pre-collected
 *     parameters. It validates the three-field input, calls
 *     `createNewSubagent` (write-new or adopt-existing on the `.md` file),
 *     and then delegates to `hireAllSubagents` to create the minimal aweek
 *     JSON shell for the freshly-created slug. The delegation keeps the
 *     "what does a wrapper look like" logic in one place so all three
 *     menu branches (Hire all, Select some, Create new) write the same
 *     shape of wrapper.
 *
 * ### Design contract
 *
 * - Identity lives in `.claude/agents/<slug>.md` (the sole source of truth
 *   per the refactor). This handler only materialises the aweek-side
 *   wrapper; it never edits the `.md` outside of the initial write.
 * - On collision with an existing `.md`, `createNewSubagent` **adopts** the
 *   on-disk file verbatim — the caller's `description` / `systemPrompt`
 *   are intentionally discarded. The handler surfaces the adoption via
 *   `subagent.adopted: true` so the markdown can tell the user.
 * - Plugin-namespaced slugs (`oh-my-claudecode-*`, `geo-*`) are excluded
 *   from hireable lists in v1. The create-new branch does not need an
 *   extra filter because the caller types the name freely — if they
 *   somehow produce a plugin-namespaced slug, `hireAllSubagents` will
 *   skip it with a "plugin-namespaced" reason.
 * - The module is pure data / orchestration — no `AskUserQuestion` calls.
 *   UX lives in the skill markdown.
 *
 * @module skills/hire-create-new-menu
 */
import {
  createNewSubagent,
  validateCreateNewInput,
} from './hire-create-new.js';
import {
  hireAllSubagents,
  formatHireAllSummary,
  DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT,
} from './hire-all.js';

/**
 * Stable skill identifier the create-new branch delegates to. Exposed as a
 * constant so markdown, docs, and downstream dispatchers stay in sync if
 * `/aweek:hire` is ever renamed.
 */
export const CREATE_NEW_SKILL_NAME = '/aweek:hire';

/**
 * Stable route name passed through to the `/aweek:hire` skill so it knows
 * to enter the three-field create-new wizard rather than the
 * pick-existing branch.
 */
export const CREATE_NEW_ROUTE_NAME = 'create-new';

/**
 * Default user-facing prompt copy shown when `/aweek:init` is about to
 * launch the `/aweek:hire` create-new wizard. Kept short so the handoff
 * feels continuous — longer context lives in the init skill markdown.
 */
export const DEFAULT_CREATE_NEW_PROMPT_TEXT =
  'Launching /aweek:hire to create a brand-new Claude Code subagent + aweek wrapper. Collect the three-field identity (name, description, system prompt) in the wizard.';

/**
 * Build the handoff descriptor the `/aweek:init` skill markdown renders
 * when it delegates the create-new branch to the interactive `/aweek:hire`
 * wizard.
 *
 * Returned shape mirrors {@link buildHireLaunchInstruction} in `init.js`
 * plus a `route` field so the markdown can distinguish "launch the
 * wizard's create-new branch" from "launch the pick-existing branch" on a
 * single descriptor type.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Project root (defaults to `process.cwd()`).
 * @param {string} [opts.promptText=DEFAULT_CREATE_NEW_PROMPT_TEXT]
 * @returns {{
 *   skill: string,
 *   route: string,
 *   projectDir: string,
 *   promptText: string,
 *   reason: string,
 * }}
 */
export function buildCreateNewLaunchInstruction({
  projectDir,
  promptText = DEFAULT_CREATE_NEW_PROMPT_TEXT,
} = {}) {
  const resolvedProject =
    typeof projectDir === 'string' && projectDir.length > 0
      ? projectDir
      : process.cwd();
  return {
    skill: CREATE_NEW_SKILL_NAME,
    route: CREATE_NEW_ROUTE_NAME,
    projectDir: resolvedProject,
    promptText,
    reason:
      'User selected "Create new" on the /aweek:init hire menu — delegate to /aweek:hire create-new so the wizard can collect the three-field identity and write both the .claude/agents/<slug>.md and the aweek JSON wrapper.',
  };
}

/**
 * Run the create-new branch end-to-end from pre-collected parameters.
 *
 * Steps, in order:
 *
 *   1. Validate the three-field input via {@link validateCreateNewInput}.
 *      On failure, return `{ success: false, validation, subagent: null,
 *      hire: null }` — nothing is written.
 *   2. Call {@link createNewSubagent} to either create a fresh
 *      `.claude/agents/<slug>.md` (when the slug is free) or adopt the
 *      existing one (when the `.md` is already on disk). The `adopted`
 *      flag on the returned subagent record distinguishes the two paths.
 *      On failure, return `{ success: false, subagent: { ... }, hire:
 *      null }` — no aweek JSON wrapper is written because the `.md` did
 *      not land.
 *   3. Delegate to {@link hireAllSubagents} with a single-slug batch so
 *      the aweek JSON wrapper is created using the same shell logic the
 *      Hire all and Select some branches rely on. This keeps wrapper
 *      shape consistent across all three menu branches.
 *
 * The top-level `success` flag is only `true` when validation succeeded,
 * the `.md` wrote/adopted cleanly, AND the wrapper step reported
 * `hire.success === true` (a slug that was already hired lands under
 * `hire.skipped` with `success: true` because idempotent re-hires are a
 * valid no-op — matching `hireAllSubagents`'s own contract).
 *
 * @param {object} params
 * @param {string} params.name - Human-readable agent name (slugified).
 * @param {string} params.description - Short single-line description
 *   written to the `.md` frontmatter. Ignored on collision.
 * @param {string} params.systemPrompt - Body of the `.md`. Ignored on
 *   collision.
 * @param {number} [params.weeklyTokenLimit] - Weekly token budget for the
 *   aweek scheduling shell. Defaults to
 *   {@link DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT}.
 * @param {string} [params.projectDir] - Project root for both the `.md`
 *   write and the `.aweek` data directory lookup. Defaults to
 *   `process.cwd()`.
 * @param {string} [params.dataDir] - aweek data directory override;
 *   forwarded to `hireAllSubagents`.
 * @param {import('../storage/agent-store.js').AgentStore} [params.agentStore]
 *   Pre-constructed store (test hook); forwarded to `hireAllSubagents`.
 * @param {typeof createNewSubagent} [params.createNewSubagentFn] -
 *   Injectable `.md` writer (test hook).
 * @param {typeof hireAllSubagents} [params.hireFn] - Injectable hire-all
 *   delegate (test hook).
 * @returns {Promise<{
 *   success: boolean,
 *   validation: { valid: boolean, errors: string[], slug: string },
 *   subagent: Awaited<ReturnType<typeof createNewSubagent>> | null,
 *   hire: Awaited<ReturnType<typeof hireAllSubagents>> | null,
 * }>}
 */
export async function runCreateNewHire({
  name,
  description,
  systemPrompt,
  weeklyTokenLimit,
  projectDir,
  dataDir,
  agentStore,
  createNewSubagentFn,
  hireFn,
} = {}) {
  const validation = validateCreateNewInput({ name, description, systemPrompt });
  if (!validation.valid) {
    return {
      success: false,
      validation,
      subagent: null,
      hire: null,
    };
  }

  const writeSubagent = createNewSubagentFn || createNewSubagent;
  const subagent = await writeSubagent({
    name,
    description,
    systemPrompt,
    projectDir,
  });

  if (!subagent || !subagent.success) {
    return {
      success: false,
      validation,
      subagent: subagent || null,
      hire: null,
    };
  }

  const delegate = hireFn || hireAllSubagents;
  const hire = await delegate({
    slugs: [subagent.slug],
    weeklyTokenLimit,
    projectDir,
    dataDir,
    agentStore,
  });

  return {
    success: Boolean(hire && hire.success),
    validation,
    subagent,
    hire,
  };
}

/**
 * Render a {@link runCreateNewHire} result as a human-readable block the
 * skill markdown can echo after dispatch.
 *
 * Three failure modes get distinct output:
 *
 *   - Validation failed → "Input rejected" header plus the per-error
 *     list. No `.md` or JSON was written.
 *   - Subagent `.md` write failed → "Subagent file error" header plus
 *     the underlying errors. No aweek JSON wrapper was written.
 *   - `.md` landed but the aweek JSON wrapper step failed → the nested
 *     {@link formatHireAllSummary} block verbatim. Matches the output
 *     shape the user sees from hire-all / select-some so the summary is
 *     consistent across all three menu branches.
 *
 * On success, the output combines a one-line "adopted vs created"
 * headline about the `.md` file with the `formatHireAllSummary` block for
 * the wrapper.
 *
 * @param {Awaited<ReturnType<typeof runCreateNewHire>>} result
 * @returns {string}
 */
export function formatCreateNewResult(result) {
  if (!result) return '';

  const lines = [];

  if (result.validation && !result.validation.valid) {
    lines.push('Input rejected — create-new wizard needs a valid name, description, and system prompt.');
    for (const err of result.validation.errors) {
      lines.push(`  ! ${err}`);
    }
    return lines.join('\n');
  }

  const subagent = result.subagent;
  if (!subagent || !subagent.success) {
    lines.push('Subagent file error — .claude/agents/<slug>.md was not created.');
    const errs =
      subagent && Array.isArray(subagent.errors) ? subagent.errors : [];
    for (const err of errs) {
      lines.push(`  ! ${err}`);
    }
    return lines.join('\n');
  }

  const headline = subagent.adopted
    ? `Adopted existing subagent file: ${subagent.path}`
    : `Wrote subagent file: ${subagent.path}`;
  lines.push(headline);

  const hireBlock = formatHireAllSummary(result.hire);
  if (hireBlock) {
    lines.push('');
    lines.push(hireBlock);
  }

  return lines.join('\n');
}
