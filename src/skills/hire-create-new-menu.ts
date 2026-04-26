/**
 * Create-new handler (Sub-AC 3 of AC 50303).
 *
 * The `/aweek:init` four-option menu's **Create new** branch launches the
 * `/aweek:hire` skill's create-new path — a three-field identity capture
 * (name, description, systemPrompt) that writes a brand-new
 * `.claude/agents/<slug>.md` and wraps it into a minimal aweek scheduling
 * JSON shell.
 *
 * @module skills/hire-create-new-menu
 */
import {
  createNewSubagent,
  validateCreateNewInput,
} from './hire-create-new.js';
import type {
  CreateNewSubagentInput,
  CreateNewSubagentResult,
  ValidateCreateNewResult,
} from './hire-create-new.js';
import {
  hireAllSubagents,
  formatHireAllSummary,
  DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT,
} from './hire-all.js';
import type { HireAllResult } from './hire-all.js';
import type { AgentStore } from '../storage/agent-store.js';

/**
 * Stable skill identifier the create-new branch delegates to.
 */
export const CREATE_NEW_SKILL_NAME = '/aweek:hire';

/**
 * Stable route name passed through to the `/aweek:hire` skill.
 */
export const CREATE_NEW_ROUTE_NAME = 'create-new';

/**
 * Default user-facing prompt copy shown when `/aweek:init` is about to
 * launch the `/aweek:hire` create-new wizard.
 */
export const DEFAULT_CREATE_NEW_PROMPT_TEXT =
  'Launching /aweek:hire to create a brand-new Claude Code subagent + aweek wrapper. Collect the three-field identity (name, description, system prompt) in the wizard.';

/** Result of {@link buildCreateNewLaunchInstruction}. */
export interface CreateNewLaunchInstruction {
  skill: string;
  route: string;
  projectDir: string;
  promptText: string;
  reason: string;
}

/**
 * Build the handoff descriptor the `/aweek:init` skill markdown renders
 * when it delegates the create-new branch to the interactive `/aweek:hire`
 * wizard.
 */
export function buildCreateNewLaunchInstruction({
  projectDir,
  promptText = DEFAULT_CREATE_NEW_PROMPT_TEXT,
}: { projectDir?: unknown; promptText?: string } = {}): CreateNewLaunchInstruction {
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

/** Params for {@link runCreateNewHire}. */
export interface RunCreateNewHireParams {
  name?: string;
  description?: string;
  systemPrompt?: string;
  weeklyTokenLimit?: number;
  projectDir?: string;
  dataDir?: string;
  agentStore?: AgentStore;
  createNewSubagentFn?: (input: CreateNewSubagentInput) => Promise<CreateNewSubagentResult>;
  hireFn?: (args: {
    slugs: string[];
    weeklyTokenLimit?: number;
    projectDir?: string;
    dataDir?: string;
    agentStore?: AgentStore;
  }) => Promise<HireAllResult | undefined | null>;
}

/** Result of {@link runCreateNewHire}. */
export interface RunCreateNewHireResult {
  success: boolean;
  validation: ValidateCreateNewResult;
  subagent: CreateNewSubagentResult | null;
  hire: HireAllResult | null | undefined;
}

/**
 * Run the create-new branch end-to-end from pre-collected parameters.
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
}: RunCreateNewHireParams = {}): Promise<RunCreateNewHireResult> {
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
 */
export function formatCreateNewResult(result: RunCreateNewHireResult | null | undefined): string {
  if (!result) return '';

  const lines: string[] = [];

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
      subagent && Array.isArray((subagent as { errors?: string[] }).errors)
        ? (subagent as { errors: string[] }).errors
        : [];
    for (const err of errs) {
      lines.push(`  ! ${err}`);
    }
    return lines.join('\n');
  }

  const headline = subagent.adopted
    ? `Adopted existing subagent file: ${subagent.path}`
    : `Wrote subagent file: ${subagent.path}`;
  lines.push(headline);

  const hireBlock = formatHireAllSummary(result.hire as HireAllResult | null | undefined);
  if (hireBlock) {
    lines.push('');
    lines.push(hireBlock);
  }

  return lines.join('\n');
}

// Re-export the default token limit for the menu test
export { DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT };
