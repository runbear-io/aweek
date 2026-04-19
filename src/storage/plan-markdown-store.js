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

/**
 * Resolve the absolute path to an agent's plan markdown.
 *
 * @param {string} agentsDir - `.aweek/agents` root.
 * @param {string} agentId
 * @returns {string}
 */
export function planPath(agentsDir, agentId) {
  if (!agentsDir) throw new TypeError('agentsDir is required');
  if (!agentId) throw new TypeError('agentId is required');
  return join(agentsDir, agentId, PLAN_FILENAME);
}

/**
 * Return true if the agent's plan.md exists.
 *
 * @param {string} agentsDir
 * @param {string} agentId
 * @returns {Promise<boolean>}
 */
export async function exists(agentsDir, agentId) {
  try {
    const s = await stat(planPath(agentsDir, agentId));
    return s.isFile();
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Read the plan markdown. Returns `null` when the file is absent so
 * callers can branch on "first-time agent" vs "existing".
 *
 * @param {string} agentsDir
 * @param {string} agentId
 * @returns {Promise<string|null>}
 */
export async function readPlan(agentsDir, agentId) {
  try {
    return await readFile(planPath(agentsDir, agentId), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write the plan markdown verbatim. Creates the parent agent directory
 * if it doesn't exist yet. Trailing newline is appended when missing so
 * editors that rely on POSIX-end-of-file semantics don't trip.
 *
 * @param {string} agentsDir
 * @param {string} agentId
 * @param {string} body
 * @returns {Promise<{path: string, bytes: number}>}
 */
export async function writePlan(agentsDir, agentId, body) {
  if (typeof body !== 'string') {
    throw new TypeError('writePlan body must be a string');
  }
  const path = planPath(agentsDir, agentId);
  await mkdir(dirname(path), { recursive: true });
  const withNewline = body.endsWith('\n') ? body : `${body}\n`;
  await writeFile(path, withNewline, 'utf8');
  return { path, bytes: withNewline.length };
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
]);

/**
 * Parse a plan.md body into labeled sections. The parser is intentionally
 * loose — any line starting with `## ` opens a new section, and content
 * up to the next H2 (or end of file) is collected verbatim. This means
 * subsections (`### 2026-04`) live *inside* their parent section's text
 * blob, which is what the weekly-plan flow wants anyway: it passes the
 * whole blob to the model rather than trying to pick out structure.
 *
 * Returned shape:
 *   {
 *     heading: string|null,        // text after `# ` on the first H1
 *     preamble: string,            // body between H1 and first H2
 *     sections: [{ title, body }], // preserves order as written
 *     byTitle: Record<string,string>, // title → body, latest-wins on dup
 *   }
 *
 * @param {string} markdown
 * @returns {{heading: string|null, preamble: string, sections: Array<{title: string, body: string}>, byTitle: Record<string, string>}}
 */
export function parsePlanMarkdownSections(markdown) {
  const empty = { heading: null, preamble: '', sections: [], byTitle: {} };
  if (typeof markdown !== 'string' || markdown.length === 0) return empty;

  const lines = markdown.split(/\r?\n/);
  let heading = null;
  const preambleLines = [];
  const sections = [];
  let currentTitle = null;
  let currentBody = [];
  let sawH2 = false;

  const flush = () => {
    if (currentTitle == null) return;
    sections.push({
      title: currentTitle,
      body: currentBody.join('\n').replace(/\n+$/, ''),
    });
    currentTitle = null;
    currentBody = [];
  };

  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h1 && heading == null && !sawH2) {
      heading = h1[1].trim();
      continue;
    }
    if (h2) {
      sawH2 = true;
      flush();
      currentTitle = h2[1].trim();
      continue;
    }
    if (currentTitle != null) {
      currentBody.push(line);
    } else if (sawH2 === false) {
      preambleLines.push(line);
    }
  }
  flush();

  const byTitle = {};
  for (const s of sections) byTitle[s.title] = s.body;

  return {
    heading,
    preamble: preambleLines.join('\n').replace(/^\n+|\n+$/g, ''),
    sections,
    byTitle,
  };
}

/**
 * Produce the starter template for a brand-new agent. `/aweek:hire` calls
 * this once after creating the subagent `.md` so the user has a ready-
 * to-edit shell instead of a blank file. The conventions mirror what the
 * weekly-plan generator looks for (H2 section names) but are NOT
 * enforced — the user can restructure without breaking anything.
 *
 * @param {object} [opts]
 * @param {string} [opts.name] - Agent display name for the H1.
 * @param {string} [opts.description] - Optional short preamble.
 * @returns {string}
 */
export function buildInitialPlan({ name = 'Agent', description } = {}) {
  const lines = [`# ${name}`];
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
