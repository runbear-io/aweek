/**
 * Free-form planning markdown per agent.
 *
 * Each agent has a single `plan.md` at `.aweek/agents/<slug>/plan.md` that
 * captures long-term goals, monthly plans, strategies, and notes. This
 * file REPLACES the structured `config.goals` and `config.monthlyPlans`
 * arrays on the agent JSON: users edit prose instead of filling in ids,
 * horizons, and objective linkages. The weekly-plan generator reads the
 * whole file as context and lets the model synthesize concrete tasks.
 *
 * The store is intentionally thin:
 *   - `readPlan(agentId)` — returns the file body or `null` when absent.
 *   - `writePlan(agentId, body)` — writes verbatim; `mkdir -p` semantics.
 *   - `exists(agentId)` — cheap presence probe.
 *   - `planPath(agentId)` — resolve the absolute path for editor handoff.
 *   - `buildInitialPlan({name, description})` — render the starter
 *     template shown on first `/aweek:hire`. The headings we emit
 *     (`## Long-term goals`, `## Monthly plans`, `## Strategies`,
 *     `## Notes`) are conventions, not a schema — the user is free to
 *     reorganize.
 *
 * Per the CLAUDE.md destructive-operation policy, `writePlan` is
 * non-destructive (overwrite is expected for an editor save loop);
 * callers that want to preserve history should stage through git.
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const PLAN_FILENAME = 'plan.md';

/** Section emitted under each canonical H2 heading by the parser. */
export interface PlanMarkdownSection {
  title: string;
  body: string;
}

/** Output of `parsePlanMarkdownSections`. */
export interface ParsedPlanMarkdown {
  /** Text after `# ` on the first H1, or null when absent. */
  heading: string | null;
  /** Body between H1 and the first H2. */
  preamble: string;
  /** Sections in document order. */
  sections: PlanMarkdownSection[];
  /** Title → body, latest-wins on duplicate titles. */
  byTitle: Record<string, string>;
}

/** Result of `writePlan`. */
export interface WritePlanResult {
  path: string;
  bytes: number;
}

/** Outcome of the legacy plan migration. */
export interface MigrateLegacyPlanResult {
  outcome: 'migrated' | 'skipped';
  path: string;
  reason?: string;
}

/** Minimal shape of a legacy goal entry on `config.goals`. */
interface LegacyGoal {
  id?: string;
  description?: string;
  horizon?: string;
  status?: string;
}

/** Minimal shape of a legacy monthly plan entry on `config.monthlyPlans`. */
interface LegacyMonthlyObjective {
  id?: string;
  description?: string;
  status?: string;
}

interface LegacyMonthlyPlan {
  month?: string;
  summary?: string;
  objectives?: LegacyMonthlyObjective[];
}

/** Minimal shape of a legacy agent config consumed by the migrator. */
interface LegacyAgentConfig {
  identity?: { name?: string; description?: string };
  goals?: LegacyGoal[];
  monthlyPlans?: LegacyMonthlyPlan[];
}

/**
 * Resolve the absolute path to an agent's plan markdown.
 */
export function planPath(agentsDir: string, agentId: string): string {
  if (!agentsDir) throw new TypeError('agentsDir is required');
  if (!agentId) throw new TypeError('agentId is required');
  return join(agentsDir, agentId, PLAN_FILENAME);
}

/**
 * Return true if the agent's plan.md exists.
 */
export async function exists(agentsDir: string, agentId: string): Promise<boolean> {
  try {
    const s = await stat(planPath(agentsDir, agentId));
    return s.isFile();
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Read the plan markdown. Returns `null` when the file is absent so
 * callers can branch on "first-time agent" vs "existing".
 */
export async function readPlan(agentsDir: string, agentId: string): Promise<string | null> {
  try {
    return await readFile(planPath(agentsDir, agentId), 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write the plan markdown verbatim. Creates the parent agent directory
 * if it doesn't exist yet. Trailing newline is appended when missing so
 * editors that rely on POSIX-end-of-file semantics don't trip.
 */
export async function writePlan(
  agentsDir: string,
  agentId: string,
  body: string,
): Promise<WritePlanResult> {
  if (typeof body !== 'string') {
    throw new TypeError('writePlan body must be a string');
  }
  const path = planPath(agentsDir, agentId);
  await mkdir(dirname(path), { recursive: true });
  const withNewline = body.endsWith('\n') ? body : `${body}\n`;
  await writeFile(path, withNewline, 'utf8');
  return { path, bytes: withNewline.length };
}

/** Arguments for `migrateLegacyPlan`. */
export interface MigrateLegacyPlanArgs {
  agentsDir: string;
  agentId: string;
  config: LegacyAgentConfig;
  /** Optional override for the H1; falls back to identity.name or agentId. */
  name?: string;
  /** Optional preamble override. */
  description?: string;
}

/**
 * Migrate a legacy agent config on-demand: if `plan.md` is absent and the
 * agent JSON still carries `goals` / `monthlyPlans` content, render them
 * into `plan.md` and return `{ outcome: 'migrated' }`. When the file
 * already exists or there's nothing to migrate, returns a no-op status
 * so the caller can report `skipped`.
 *
 * This is the only sanctioned path for bringing pre-markdown agents up
 * to the new layout — UI surfaces call it once at the top of `/aweek:plan`
 * (Branch A) so the user never has to remember.
 */
export async function migrateLegacyPlan({
  agentsDir,
  agentId,
  config,
  name,
  description,
}: MigrateLegacyPlanArgs = {} as MigrateLegacyPlanArgs): Promise<MigrateLegacyPlanResult> {
  const path = planPath(agentsDir, agentId);
  if (await exists(agentsDir, agentId)) {
    return { outcome: 'skipped', path, reason: 'plan.md already exists' };
  }
  const goals = Array.isArray(config?.goals) ? config.goals : [];
  const monthlyPlans = Array.isArray(config?.monthlyPlans) ? config.monthlyPlans : [];
  if (goals.length === 0 && monthlyPlans.length === 0) {
    return { outcome: 'skipped', path, reason: 'no legacy goals or monthly plans' };
  }
  const body = buildPlanFromLegacy({
    name: name ?? config?.identity?.name ?? agentId,
    description: description ?? config?.identity?.description,
    goals,
    monthlyPlans,
  });
  await writePlan(agentsDir, agentId, body);
  return { outcome: 'migrated', path };
}

/**
 * Canonical H2 section names the template emits. Consumers that want to
 * pull "just the long-term goals" or "just the strategies" can pass
 * these into `parsePlanMarkdownSections`. Unrecognized headings are
 * preserved under the `extras` bucket so a user who renames a section
 * doesn't lose content.
 */
export const CANONICAL_SECTIONS = Object.freeze([
  'Long-term goals',
  'Monthly plans',
  'Strategies',
  'Notes',
] as const);

/**
 * Parse a plan.md body into labeled sections. The parser is intentionally
 * loose — any line starting with `## ` opens a new section, and content
 * up to the next H2 (or end of file) is collected verbatim. This means
 * subsections (`### 2026-04`) live *inside* their parent section's text
 * blob, which is what the weekly-plan flow wants anyway: it passes the
 * whole blob to the model rather than trying to pick out structure.
 */
export function parsePlanMarkdownSections(markdown: string | null | undefined): ParsedPlanMarkdown {
  const empty: ParsedPlanMarkdown = { heading: null, preamble: '', sections: [], byTitle: {} };
  if (typeof markdown !== 'string' || markdown.length === 0) return empty;

  const lines = markdown.split(/\r?\n/);
  let heading: string | null = null;
  const preambleLines: string[] = [];
  const sections: PlanMarkdownSection[] = [];
  let currentTitle: string | null = null;
  let currentBody: string[] = [];
  let sawH2 = false;

  const flush = (): void => {
    if (currentTitle == null) return;
    sections.push({
      title: currentTitle,
      // Strip leading and trailing blank lines so downstream consumers
      // see clean bodies regardless of whether the author left a blank
      // line under the heading (which the canonical template does).
      body: currentBody.join('\n').replace(/^\n+|\n+$/g, ''),
    });
    currentTitle = null;
    currentBody = [];
  };

  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h1 && heading == null && !sawH2) {
      heading = h1[1]!.trim();
      continue;
    }
    if (h2) {
      sawH2 = true;
      flush();
      currentTitle = h2[1]!.trim();
      continue;
    }
    if (currentTitle != null) {
      currentBody.push(line);
    } else if (sawH2 === false) {
      preambleLines.push(line);
    }
  }
  flush();

  const byTitle: Record<string, string> = {};
  for (const s of sections) byTitle[s.title] = s.body;

  return {
    heading,
    preamble: preambleLines.join('\n').replace(/^\n+|\n+$/g, ''),
    sections,
    byTitle,
  };
}

/** Arguments for `buildPlanFromLegacy`. */
export interface BuildPlanFromLegacyArgs {
  /** Agent display name for the H1. */
  name?: string;
  /** Optional preamble (subagent description). */
  description?: string;
  goals?: LegacyGoal[];
  monthlyPlans?: LegacyMonthlyPlan[];
}

/**
 * Render legacy `config.goals` + `config.monthlyPlans` arrays into a
 * ready-to-edit markdown body. Used by the one-shot migration path so
 * agents hired before plan.md existed don't lose their structured
 * planning state when the JSON columns are retired.
 *
 * The output uses the canonical H2 headings. Each goal becomes a bullet
 * under `## Long-term goals` ("- (1mo / 3mo / 1yr) — <description>").
 * Each monthly plan becomes an `### YYYY-MM` subsection under `## Monthly
 * plans` with its objectives as bullets ("- <description>"). Status
 * suffixes (`[completed]`, `[dropped]`, ...) are appended only when not
 * the default — keeps the output tidy for the common case.
 */
export function buildPlanFromLegacy({
  name = 'Agent',
  description,
  goals = [],
  monthlyPlans = [],
}: BuildPlanFromLegacyArgs = {}): string {
  const lines: string[] = [`# ${name}`];
  if (description && typeof description === 'string' && description.trim()) {
    lines.push('', description.trim());
  }

  lines.push('', '## Long-term goals', '');
  if (Array.isArray(goals) && goals.length > 0) {
    for (const g of goals) {
      if (!g || typeof g !== 'object') continue;
      const horizon = g.horizon ? `(${g.horizon}) ` : '';
      const status =
        g.status && g.status !== 'active' ? ` [${g.status}]` : '';
      const desc = (g.description ?? '').trim() || '(no description)';
      lines.push(`- ${horizon}${desc}${status}`);
    }
  } else {
    lines.push('<!-- No long-term goals recorded. Add them here. -->');
  }

  lines.push('', '## Monthly plans', '');
  if (Array.isArray(monthlyPlans) && monthlyPlans.length > 0) {
    const sorted = [...monthlyPlans].sort((a, b) =>
      String(a?.month ?? '').localeCompare(String(b?.month ?? '')),
    );
    for (const plan of sorted) {
      if (!plan || typeof plan !== 'object') continue;
      const monthLabel = plan.month || 'undated';
      lines.push(`### ${monthLabel}`);
      if (plan.summary && typeof plan.summary === 'string' && plan.summary.trim()) {
        lines.push('', plan.summary.trim());
      }
      lines.push('');
      if (Array.isArray(plan.objectives) && plan.objectives.length > 0) {
        for (const obj of plan.objectives) {
          if (!obj || typeof obj !== 'object') continue;
          const status =
            obj.status && obj.status !== 'planned' ? ` [${obj.status}]` : '';
          const desc = (obj.description ?? '').trim() || '(no description)';
          lines.push(`- ${desc}${status}`);
        }
      } else {
        lines.push('<!-- No objectives recorded for this month. -->');
      }
      lines.push('');
    }
  } else {
    lines.push('<!-- No monthly plans yet. Add `### YYYY-MM` sections here. -->');
  }

  lines.push(
    '',
    '## Strategies',
    '',
    '<!-- Migrated automatically from legacy goals/monthlyPlans JSON. Add preferred tools, rituals, and guardrails here. -->',
    '',
    '## Notes',
    '',
    '<!-- Freeform context the weekly-plan generator should know about. -->',
    '',
  );
  return lines.join('\n');
}

/** Arguments for `buildPlanFromInterview`. */
export interface BuildPlanFromInterviewArgs {
  /** Agent display name for the H1. */
  name?: string;
  /** Optional preamble (usually the subagent description). */
  description?: string;
  /** Body for the `## Long-term goals` section. */
  longTermGoals?: string;
  /** Body for `## Monthly plans`. */
  monthlyPlans?: string;
  /** Body for `## Strategies`. */
  strategies?: string;
  /** Body for `## Notes`. */
  notes?: string;
}

/**
 * Render a plan.md body from answers collected during `/aweek:hire`'s
 * interview flow. Every section is a free-form string that the user
 * types in response to a short prompt — we stitch them into the
 * canonical H2 layout without any cleverness. Empty answers fall back
 * to a placeholder comment so the skeleton stays visible and editable.
 *
 * The caller (the hire skill) is responsible for asking the questions;
 * this helper only handles the assembly so the rendering logic stays in
 * one place and is easy to unit-test.
 */
export function buildPlanFromInterview({
  name = 'Agent',
  description,
  longTermGoals,
  monthlyPlans,
  strategies,
  notes,
}: BuildPlanFromInterviewArgs = {}): string {
  const section = (title: string, body: string | undefined, placeholder: string): string[] => {
    const trimmed = typeof body === 'string' ? body.trim() : '';
    return [
      `## ${title}`,
      '',
      trimmed.length > 0 ? trimmed : `<!-- ${placeholder} -->`,
      '',
    ];
  };

  const lines: string[] = [`# ${name}`];
  if (description && typeof description === 'string' && description.trim()) {
    lines.push('', description.trim());
  }
  lines.push('');
  lines.push(
    ...section(
      'Long-term goals',
      longTermGoals,
      'What should this agent achieve over the next year / quarter / month?',
    ),
    ...section(
      'Monthly plans',
      monthlyPlans,
      'One subsection per month, e.g. "### 2026-04" with 2–5 objectives.',
    ),
    ...section(
      'Strategies',
      strategies,
      'How does the agent prefer to work? Tone, tools, rituals, guardrails.',
    ),
    ...section(
      'Notes',
      notes,
      'Freeform context the weekly-plan generator should know about.',
    ),
  );
  return lines.join('\n');
}

/** Arguments for `buildInitialPlan`. */
export interface BuildInitialPlanArgs {
  /** Agent display name for the H1. */
  name?: string;
  /** Optional short preamble. */
  description?: string;
}

/**
 * Produce the starter template for a brand-new agent. `/aweek:hire` calls
 * this once after creating the subagent `.md` so the user has a ready-
 * to-edit shell instead of a blank file. The conventions mirror what the
 * weekly-plan generator looks for (H2 section names) but are NOT
 * enforced — the user can restructure without breaking anything.
 */
export function buildInitialPlan({ name = 'Agent', description }: BuildInitialPlanArgs = {}): string {
  const lines: string[] = [`# ${name}`];
  if (description && typeof description === 'string' && description.trim()) {
    lines.push('', description.trim());
  }
  lines.push(
    '',
    '## Long-term goals',
    '',
    '<!-- What should this agent achieve over the next year / quarter / month? -->',
    '',
    '## Monthly plans',
    '',
    '<!-- One subsection per month, e.g. "### 2026-04" with 2–5 objectives. -->',
    '',
    '## Strategies',
    '',
    '<!-- How does the agent prefer to work? Tone, tools, rituals, guardrails. -->',
    '',
    '## Notes',
    '',
    '<!-- Freeform context the weekly-plan generator should know about. -->',
    '',
  );
  return lines.join('\n');
}

/** Narrow `unknown` to a Node `ErrnoException` so we can read the `code` field. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
