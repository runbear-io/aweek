/**
 * Create-new path for the `/aweek:hire` wizard.
 *
 * This is the "I'm starting from scratch" branch of the hire flow. The
 * wizard prompts the user for exactly three fields — agent name, a short
 * description, and the system prompt — and hands them to this module. We
 * derive a filesystem-safe slug from the name, validate all three inputs,
 * and write a brand-new subagent file at `.claude/agents/SLUG.md` with
 * minimal frontmatter (`name` + `description`) plus the system prompt as
 * the body.
 *
 * The subagent file is the single source of truth for identity per the
 * refactor plan, so once this helper returns a successful result the caller
 * can reuse the returned `slug` as both the aweek agent id and the
 * `subagentRef` field on the scheduling JSON — no duplication of identity
 * data between the two artifacts.
 *
 * Deliberately narrow scope:
 *   - 3 prompts only (name, description, systemPrompt).
 *   - No model / tools / skills / MCP prompts (the wizard stays minimal per
 *     the `minimal_new_code_surface` constraint; users who want to override
 *     any of those open the generated `.md` file and edit it).
 *   - Never writes to the user-level `~/.claude/agents/` directory — only
 *     to the project-level `.claude/agents/`.
 *   - Adopt-on-collision: if `.claude/agents/<slug>.md` already exists, the
 *     helper leaves the existing file untouched and returns
 *     `{ success: true, adopted: true, ... }` with the on-disk content. The
 *     user's provided `description` / `systemPrompt` are intentionally
 *     discarded in that case — the `.md` file is the single source of truth
 *     for identity, so adoption means "keep what's on disk as-is". The
 *     caller still gets the slug back and reuses it as both the aweek agent
 *     id and the `subagentRef` on the scheduling JSON.
 */
import {
  slugifyName,
  validateSubagentSlug,
  validateDescription,
  validateSystemPrompt,
  subagentFileExists,
  readSubagentFile,
  writeSubagentFile,
  subagentFilePath,
} from '../subagents/subagent-file.js';
/** Inputs for {@link validateCreateNewInput} and {@link createNewSubagent}. */
export interface CreateNewInput {
  /** Human-readable agent name (e.g. "Content Writer"). */
  name?: string;
  /** Short single-line description. */
  description?: string;
  /** Body of the subagent `.md` file. */
  systemPrompt?: string;
}

/** Result of {@link validateCreateNewInput}. */
export interface ValidateCreateNewResult {
  valid: boolean;
  errors: string[];
  /**
   * Slugified form of `name` — empty string if the name had no
   * alphanumeric characters, in which case `valid` is false.
   */
  slug: string;
}

/**
 * Validate the three free-form inputs collected by the create-new wizard.
 *
 * Returns every validation error at once so the wizard can re-prompt for
 * only the invalid fields rather than one-at-a-time ping-ponging.
 */
export function validateCreateNewInput(
  { name, description, systemPrompt }: CreateNewInput = {},
): ValidateCreateNewResult {
  const errors: string[] = [];

  if (typeof name !== 'string' || name.trim().length === 0) {
    errors.push('Name is required and must be a non-empty string');
  } else if (name.length > 100) {
    errors.push('Name must be 100 characters or fewer');
  }

  const slug = slugifyName(name || '');
  if (slug.length === 0) {
    errors.push(
      'Name must contain at least one alphanumeric character so it can be slugified into a .claude/agents/<slug>.md filename',
    );
  } else {
    const slugCheck = validateSubagentSlug(slug);
    if (!slugCheck.valid) errors.push(...slugCheck.errors);
  }

  const descCheck = validateDescription(description);
  if (!descCheck.valid) errors.push(...descCheck.errors);

  const promptCheck = validateSystemPrompt(systemPrompt);
  if (!promptCheck.valid) errors.push(...promptCheck.errors);

  return { valid: errors.length === 0, errors, slug };
}

/** Inputs for {@link createNewSubagent}. */
export interface CreateNewSubagentInput extends CreateNewInput {
  /**
   * Override for the project root. Tests use this to write into a temp dir;
   * production code leaves it unset and gets `process.cwd()`.
   */
  projectDir?: string;
}

/** Successful outcome of {@link createNewSubagent}. */
export interface CreateNewSubagentSuccess {
  success: true;
  adopted: boolean;
  slug: string;
  path: string;
  content: string;
}

/** Failure outcome of {@link createNewSubagent}. */
export interface CreateNewSubagentFailure {
  success: false;
  errors: string[];
  slug?: string;
  path?: string;
  alreadyExists?: boolean;
}

/** Discriminated union covering every outcome of {@link createNewSubagent}. */
export type CreateNewSubagentResult =
  | CreateNewSubagentSuccess
  | CreateNewSubagentFailure;

/**
 * Create a brand-new subagent — or adopt an existing one on collision — by
 * ensuring `.claude/agents/<slug>.md` is present on disk.
 *
 * On a fresh create, returns `{ success: true, adopted: false, slug, path,
 * content }` where `content` is the bytes just written.
 *
 * On adopt-on-collision (the file already existed), returns
 * `{ success: true, adopted: true, slug, path, content }` where `content` is
 * the existing bytes read from disk — the file is never overwritten. The
 * caller's `description` / `systemPrompt` arguments are intentionally
 * discarded in the adopt case: the `.md` file is the single source of truth
 * for identity per the refactor plan, so adoption means "reuse what's
 * already on disk as-is". The caller should still confirm adoption with the
 * user (the wizard layer surfaces the on-disk content so the user can see
 * what they're adopting).
 *
 * All other failures (invalid input, filesystem errors) surface as
 * `{ success: false, errors: [...] }`.
 */
export async function createNewSubagent({
  name,
  description,
  systemPrompt,
  projectDir,
}: CreateNewSubagentInput = {}): Promise<CreateNewSubagentResult> {
  const inputCheck = validateCreateNewInput({ name, description, systemPrompt });
  if (!inputCheck.valid) {
    return { success: false, errors: inputCheck.errors, slug: inputCheck.slug };
  }

  const { slug } = inputCheck;
  const path = subagentFilePath(slug, projectDir);

  // Adopt-on-collision: if a subagent with this slug already exists, leave
  // the .md untouched and return its current bytes. The user's provided
  // description/systemPrompt are intentionally discarded — the .md file is
  // the single source of truth for identity, so adopting means "use what's
  // on disk as-is". The wizard still reuses the slug for both the aweek
  // agent id and the `subagentRef` on the scheduling JSON.
  if (await subagentFileExists(slug, projectDir)) {
    const content = await readSubagentFile(slug, projectDir);
    return {
      success: true,
      adopted: true,
      slug,
      path,
      content,
    };
  }

  const result = await writeSubagentFile({
    slug,
    description: description as string,
    systemPrompt: systemPrompt as string,
    projectDir,
  });

  if (!result.success) {
    return { ...result, slug };
  }

  return {
    success: true,
    adopted: false,
    slug: result.slug,
    path: result.path,
    content: result.content,
  };
}
