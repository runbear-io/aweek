---
name: aweek:hire
description: Hire (create) a new aweek agent — captures identity (name, description, system prompt, weekly budget) and writes the subagent .md plus a minimal aweek scheduling shell. Goals and plans are populated separately via /aweek:plan.
trigger: aweek hire, hire agent, new agent, add agent, create agent, aweek create agent
---

# aweek:hire

Hire a new aweek agent interactively. The wizard is **identity-only** — it captures the four identity fields (name, description, system prompt, weekly token budget), writes `.claude/agents/<slug>.md`, and saves a minimal aweek scheduling JSON shell with empty goals / monthly plans / weekly plans. Goals, monthly objectives, and weekly tasks are added separately via `/aweek:plan` after hire.

The skill is a thin UX wrapper on top of `runCreateNewHire` from `src/skills/hire-create-new-menu.js`, which orchestrates `createNewSubagent` (writes the `.md` or adopts an existing one) plus `hireAllSubagents` (writes the aweek JSON shell). All persistence and validation logic lives in those modules — do not write agent JSON files or `.md` files directly.

## Instructions

You MUST follow this exact workflow when this skill is invoked.

**Interactive contract (mandatory).** Every prompt for user input MUST go through `AskUserQuestion` — never ask in plain text and wait for the next message. Each `AskUserQuestion` call MUST present a **marketer-agent placeholder** as **Option 1 (Recommended)** so the user can accept the suggested value with one click. The built-in `Other` choice handles custom input — combine the placeholder selection and the custom-input fallback in the same question (never split selection and free-text input across two sequential prompts). The marketer placeholders below are calibrated so the user can compose a complete agent identity in ~5 clicks if they accept every default.

### Step 0: Route Between Pick-Existing and Create-New

Before asking for any identity input, decide which branch of the wizard to run. The rule is simple: if there are one or more **unhired** Claude Code subagents already on disk under `.claude/agents/<slug>.md` (i.e. a file exists but there is no matching `.aweek/agents/<slug>.json`), offer the user a choice between adopting one of them or creating a brand-new subagent. When none are available, skip the branching question and go straight to the create-new path — prompting the user to pick between two options where one is impossible would just be noise.

Call `determineHireRoute` from `src/skills/hire-route.js` to get the decision object:

```bash
node --input-type=module -e "
import { determineHireRoute } from './src/skills/hire-route.js';
const r = await determineHireRoute();
console.log(JSON.stringify(r));
"
```

The result has the shape `{ route: 'create-new' | 'choose', unhired: string[], forcedCreateNew: boolean }`.

- **`route === 'create-new'`** (also `forcedCreateNew: true`): Tell the user no unhired subagents were found under `.claude/agents/` and jump straight to Step 1 (create-new). Do NOT ask "Pick existing or Create new?" in this case.
- **`route === 'choose'`**: Use `AskUserQuestion` to offer exactly two options:
  1. **Pick existing** — adopt one of the slugs listed in `unhired`.
  2. **Create new** — write a fresh `.claude/agents/<slug>.md` via the Step 1–3 flow below.

  If the user picks **Create new**, proceed to Step 1. If the user picks **Pick existing**, use the adopt-existing flow (wrap one of the listed slugs with aweek scheduling JSON via `hireAllSubagents`) instead of Step 1.

Plugin-namespaced subagents (slugs prefixed `oh-my-claudecode-` or `geo-`) are deliberately excluded from the `unhired` list per the v1 refactor constraint and must never be offered as adoption targets.

### Step 1: Collect Agent Identity (Create-New Path)

Each aweek agent is a 1-to-1 wrapper around a Claude Code subagent defined in `.claude/agents/<slug>.md`. The create-new path writes a brand-new subagent file with **minimal** frontmatter (`name` + `description` only) and the user-supplied system prompt as the body. Collect **exactly four** identity fields, each via its own `AskUserQuestion` call — do not prompt for model, tools, skills, or MCP servers. Users who want to override any of those edit the generated `.md` file by hand.

Per the interactive contract above, every question MUST present the **marketer placeholder** as **Option 1 (Recommended)** and a second contrasting option, with `Other` reserved for free-form custom input. Do NOT proceed until all four fields are provided and non-empty.

1. **Name** — `AskUserQuestion` (header: `Agent name`):
   - Option 1 (Recommended): `Marketer` — runs marketing campaigns, drafts content, tracks growth
   - Option 2: `Growth Marketer` — emphasizes experiments and analytics
   - `Other` → user types a custom name (1–100 chars, must contain ≥1 alphanumeric)
   - The chosen value is slugified into the filename of `.claude/agents/<slug>.md`, the aweek agent id, and the `subagentRef`. Example: `Marketer` → slug `marketer`.

2. **Description** — `AskUserQuestion` (header: `Description`):
   - Option 1 (Recommended): `Plans and executes weekly marketing campaigns, content, and growth experiments.`
   - Option 2: `Drives newsletter growth, SEO traffic, and content distribution across owned channels.`
   - `Other` → user types a custom one-sentence description.
   - Written verbatim to the `description:` frontmatter field on the new `.md`.

3. **System Prompt** — `AskUserQuestion` (header: `System prompt`):
   - Option 1 (Recommended) — full marketer placeholder body:
     ```
     You are a strategic marketing assistant focused on growth.
     For every task, default to data-driven recommendations and concise,
     actionable deliverables. Plan campaigns, write copy, analyze
     performance against the agent's monthly objectives, and surface
     opportunities to improve newsletter, SEO, and content metrics.
     Cite sources for any external claims and prefer measurable outcomes
     over generic advice.
     ```
   - Option 2 — terser marketer placeholder: `You are a focused marketing assistant. Default to short, data-driven recommendations and concrete next actions.`
   - `Other` → user types a custom system prompt.
   - Written verbatim as the body of the new `.md`.

4. **Weekly Token Budget** — `AskUserQuestion` (header: `Token budget`):
   - Option 1 (Recommended): `500000` — fits a typical marketer cadence
   - Option 2: `1000000` — heavier weekly research / drafting workloads
   - `Other` → user types a custom positive integer.
   - Not written to the `.md`; stored on the aweek JSON.

Before proceeding, call `validateCreateNewInput` from `src/skills/hire.js` and, if any errors are reported, re-render only the invalid `AskUserQuestion`(s). When valid, the returned `slug` is what gets used as the aweek agent id. If `.claude/agents/<slug>.md` already exists, `runCreateNewHire` will **adopt** the existing file instead of overwriting it — the user's typed description and system prompt are discarded in favour of what is already on disk (the `.md` is the single source of truth for identity). Inform the user that adoption happened and surface the on-disk content so they know what they are wiring into aweek scheduling.

### Step 2: Confirm Before Persisting

Render a one-block summary of the identity fields collected — name (and the resulting slug), description, system prompt (truncated to the first ~120 chars with an ellipsis if longer), and weekly token budget — then ask for explicit confirmation via `AskUserQuestion` (header: `Confirm hire`):

- Option 1 (Recommended): `Looks good — hire the marketer agent`
- Option 2: `Edit something first`
- `Other` → user types a free-form note (treated as `Edit something first` plus the note as a hint for which field to revisit)

If the user picks `Edit something first` (or supplies a custom note), follow up with a second `AskUserQuestion` (header: `What to edit?`) listing the editable fields (`Name`, `Description`, `System prompt`, `Token budget`) and jump back to that field in Step 1. Never silently discard the collected data.

### Step 3: Validate and Save

After confirmation, call `runCreateNewHire` from `src/skills/hire-create-new-menu.js`. It runs the three-step pipeline atomically: validate input → write or adopt `.claude/agents/<slug>.md` → write the minimal aweek JSON wrapper via `hireAllSubagents`. The wrapper has empty `goals`, `monthlyPlans`, and `weeklyPlans` by design — populate them separately via `/aweek:plan` after hire.

The example below uses the **marketer placeholder values** so the wizard can be dry-run end-to-end with no manual edits. If the user accepted every Recommended option in Step 1, the marketer values shown here ARE the collected values.

```bash
node --input-type=module -e "
import { runCreateNewHire, formatCreateNewResult } from './src/skills/hire-create-new-menu.js';

const result = await runCreateNewHire({
  name: 'Marketer',
  description: 'Plans and executes weekly marketing campaigns, content, and growth experiments.',
  systemPrompt: 'You are a strategic marketing assistant focused on growth. For every task, default to data-driven recommendations and concise, actionable deliverables. Plan campaigns, write copy, analyze performance against the agent\\'s monthly objectives, and surface opportunities to improve newsletter, SEO, and content metrics. Cite sources for any external claims and prefer measurable outcomes over generic advice.',
  weeklyTokenLimit: 500000,
  projectDir: process.cwd(),
});

console.log(formatCreateNewResult(result));
if (!result.success) process.exit(1);
"
```

Replace the four field values above with whatever the user actually picked (use the `Other` text if they did not accept Option 1) and JSON-escape any embedded quotes / newlines.

The returned `result` shape is:

```json
{
  "success": true,
  "validation": { "valid": true, "errors": [], "slug": "marketer" },
  "subagent": { "success": true, "adopted": false, "slug": "marketer", "path": "...", "content": "..." },
  "hire":     { "success": true, "created": ["marketer"], "skipped": [], "failed": [] }
}
```

Three failure modes, each with its own remediation:

- **Validation failure** (`result.validation.valid === false`): the four fields were invalid (empty, name slugifies to nothing, etc.). Nothing was written. Surface `formatCreateNewResult(result)` (starts with "Input rejected — …") and re-render the offending Step 1 `AskUserQuestion`.
- **Subagent write failure** (`result.subagent.success === false`): the `.md` write failed and — critically — the aweek JSON wrapper was **never attempted**. Surface the "Subagent file error" block and resolve the underlying filesystem issue before retrying.
- **Wrapper failure** (`result.hire.success === false`): the `.md` landed but the aweek JSON shell failed (schema error, filesystem issue). Surface the nested `formatHireAllSummary` block so the user sees which slug failed and why.

If `result.subagent.adopted === true`, tell the user the existing `.md` was kept verbatim and that their typed description / system prompt were discarded (the `.md` is the single source of truth for identity). Display `result.subagent.content` so they can confirm what they are wiring into aweek scheduling.

On success, render `formatCreateNewResult(result)` to the user — it combines the "Wrote / Adopted subagent file" headline with the `formatHireAllSummary` block.

## Validation Rules

- Agent name: 1–100 chars, must contain at least one alphanumeric character (so it slugifies to a non-empty string)
- Description: non-empty, single-line string
- System prompt: non-empty string
- Weekly token limit: positive integer, default 500,000
- All artifacts validated against JSON schemas before save

The wizard does NOT collect goals, monthly objectives, or weekly tasks — those live on the aweek JSON wrapper as initially-empty arrays and are managed via `/aweek:plan`.

## Error Handling

- If the user provides empty or invalid input on a field, explain what's wrong and re-render only that `AskUserQuestion`.
- If schema validation fails inside `runCreateNewHire` after assembly, show `formatCreateNewResult(result)` and allow correction.
- The storage layer auto-creates the data directory if needed.
- Slug collisions on `.claude/agents/<slug>.md` are non-fatal — `runCreateNewHire` adopts the existing file rather than failing.

## Next Steps

After a successful hire, tell the user:

- Run `/aweek:plan` to add long-term goals, monthly objectives, and a weekly task list (the heartbeat does not activate until the first weekly plan is approved).
- View the full agent roster with `/aweek:summary`.
- The marketer placeholder roadmap below is a ready-to-use starting point — surface it so the user can paste it straight into `/aweek:plan` if they accepted the marketer identity.

**Marketer placeholder roadmap (ready for `/aweek:plan`):**

Goals (1–5):
1. `Grow the newsletter from 1,000 to 5,000 subscribers in 6 months`
2. `Increase organic search traffic to product landing pages by 50%`
3. `Launch a weekly content series and publish on schedule for 13 weeks`
4. `Drive 200 qualified demo requests via marketing channels`
5. `Establish a measurable brand-awareness baseline with monthly reporting`

Monthly objectives (linked to goal #):
1. `Ship 4 newsletter issues this month, each with a measurable subscriber CTA` → goal 1
2. `Publish 4 long-form SEO posts targeting bottom-funnel keywords` → goal 2
3. `Run an A/B test on the pricing page hero copy and ship the winner` → goal 2
4. `Stand up a weekly metrics digest and share with stakeholders by Monday EOD` → goal 5
5. `Outline next month's content calendar end-to-end with owners and dates` → goal 3

Weekly tasks (linked to objective #):
1. `Draft and schedule this week's newsletter (subject + 3 sections + CTA)` → objective 1
2. `Write a 1,500-word SEO post on the top-traffic blog topic for the segment` → objective 2
3. `Set up an A/B test variant for the pricing page hero copy` → objective 3
4. `Pull last week's traffic + signup metrics into a Monday digest brief` → objective 4
5. `Refresh on-page meta titles + descriptions for the top 5 organic landing pages` → objective 2
6. `Source 3 testimonial quotes for the homepage social-proof block` → objective 1

## Data Directory

Subagent identity files: `.claude/agents/<slug>.md`
Aweek scheduling JSON: `.aweek/agents/<slug>.json` (relative to the project root; the slug equals the agent id and the `subagentRef`)
