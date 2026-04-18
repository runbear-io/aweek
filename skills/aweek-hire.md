---
name: aweek:hire
description: Hire (create) a new aweek agent with identity, goals, and initial plan via interactive prompts
trigger: aweek hire, hire agent, new agent, add agent, create agent, aweek create agent
---

# aweek:hire

Hire a new aweek agent interactively. This skill is the consolidated replacement for the old `/aweek:create-agent` skill — it collects agent identity, long-term goals, and an initial monthly/weekly plan, validates all input against schemas, and persists the agent using the storage layer.

The skill is a thin UX wrapper on top of `src/skills/hire.js`, which re-exports the shared creation pipeline in `src/skills/create-agent.js`. All persistence and validation logic is reused — do not write agent JSON files directly.

## Instructions

You MUST follow this exact workflow when this skill is invoked. Use the Node.js modules in `src/skills/hire.js` for every validation and save call.

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
  2. **Create new** — write a fresh `.claude/agents/<slug>.md` via the Step 1–6 flow below.

  If the user picks **Create new**, proceed to Step 1. If the user picks **Pick existing**, use the adopt-existing flow (wrap one of the listed slugs with aweek scheduling JSON) instead of Step 1.

Plugin-namespaced subagents (slugs prefixed `oh-my-claudecode-` or `geo-`) are deliberately excluded from the `unhired` list per the v1 refactor constraint and must never be offered as adoption targets.

### Step 1: Collect Agent Identity (Create-New Path)

Each aweek agent is a 1-to-1 wrapper around a Claude Code subagent defined in `.claude/agents/<slug>.md`. The create-new path writes a brand-new subagent file with **minimal** frontmatter (`name` + `description` only) and the user-supplied system prompt as the body. Collect **exactly three** identity fields using AskUserQuestion — do not prompt for model, tools, skills, or MCP servers. Users who want to override any of those edit the generated `.md` file by hand.

Do NOT proceed until all three fields are provided and non-empty.

1. **Name** (required, 1-100 chars): Ask for the agent's name. It will be slugified into a filesystem-safe slug and used as the filename of `.claude/agents/<slug>.md`, the aweek agent id, and the `subagentRef` — identity data lives in the `.md` file, not the aweek JSON.
   - Example: "Content Writer" → slug `content-writer`
   - Must contain at least one alphanumeric character.

2. **Description** (required, single line): Ask for a one-sentence description. Written verbatim to the `description:` frontmatter field on the new `.md`.
   - Example: "Writes weekly research briefs and summaries."

3. **System Prompt** (required): Ask for the prompt body that Claude Code will use when this subagent runs. Written verbatim as the body of the new `.md`.
   - Example: "You are a meticulous research assistant who produces well-cited summaries."

4. **Weekly Token Budget** (optional, default 500000): Ask for the weekly token limit for this agent's aweek scheduling budget. Not written to the `.md`; stored on the aweek JSON.
   - Must be a positive integer. Default: 500,000 tokens.

Before proceeding, call `validateCreateNewInput` from `src/skills/hire.js` and, if any errors are reported, re-prompt only for the invalid fields. When valid, the returned `slug` is what gets used as the aweek agent id. If `.claude/agents/<slug>.md` already exists, the create-new helper **adopts** the existing file instead of overwriting it — the user's typed description and system prompt are discarded in favour of what is already on disk (the `.md` is the single source of truth for identity). Inform the user that adoption happened and surface the on-disk content so they know what they are wiring into aweek scheduling.

### Step 2: Collect Long-Term Goals

Ask the user for 1-5 long-term goals for this agent.

- Ask: "What are the long-term goals for this agent? Enter one per message, type 'done' when finished (minimum 1, maximum 5)."
- Each goal must be at least 10 characters
- Keep asking until user says "done" or 5 goals reached

### Step 3: Collect Initial Monthly Plan

Ask the user for objectives for the current month. Each objective must reference a goal from Step 2.

1. Display the numbered list of goals collected
2. For each objective ask:
   - The objective description
   - Which goal number it relates to
3. Collect 1-5 objectives (ask until "done" or 5 reached)

### Step 4: Collect Initial Weekly Plan

Ask the user for tasks for the current week. Each task must reference an objective from Step 3.

1. Display the numbered list of objectives collected
2. For each task ask:
   - The task description
   - Which objective number it relates to
3. Collect 1-10 tasks (ask until "done" or 10 reached)
4. Note: The weekly plan starts as `approved: false` and must be approved via `/aweek:plan` before the heartbeat activates.

### Step 5: Confirm Before Persisting

Before calling the save pipeline, show the user a short summary of what will be created (name, role, goal count, objective count, task count, weekly token budget) and ask for explicit confirmation via AskUserQuestion. If the user declines, return to the relevant step to correct input — do not silently discard the collected data.

### Step 6: Validate and Save

After confirmation, first ensure the subagent file is present on disk via `createNewSubagent` from `src/skills/hire.js`. The helper either writes a brand-new `.md` (when the slug is free) or **adopts** the existing one (when `.claude/agents/<slug>.md` already exists), surfacing which path it took on the `adopted` flag of the result. Only when that succeeds do you assemble and save the aweek scheduling JSON, so you never end up with a dangling aweek agent whose subagent `.md` failed to write.

```bash
node --input-type=module -e "
import { createNewSubagent, hireAgent, formatHireSummary } from './src/skills/hire.js';

// Step 6a — Ensure .claude/agents/<slug>.md exists. Either writes a new
// minimal-frontmatter .md, or adopts an existing file as-is (no overwrite).
const subagent = await createNewSubagent({
  name: '<NAME>',
  description: '<DESCRIPTION>',
  systemPrompt: '<SYSTEM_PROMPT>',
});

if (!subagent.success) {
  console.error('SUBAGENT_ERRORS:', JSON.stringify(subagent.errors));
  process.exit(1);
}

if (subagent.adopted) {
  console.log('Adopted existing subagent file: ' + subagent.path);
} else {
  console.log('Wrote subagent file: ' + subagent.path);
}

// Step 6b — Persist the aweek scheduling JSON. The returned slug is reused
// as both the aweek agent id and subagentRef so the two artifacts stay in
// 1-to-1 lockstep on disk.
const result = await hireAgent({
  name: '<NAME>',
  role: '<DESCRIPTION>',
  systemPrompt: '<SYSTEM_PROMPT>',
  weeklyTokenLimit: <LIMIT>,
  goalDescriptions: [<GOALS>],
  objectives: [<OBJECTIVES>],
  tasks: [<TASKS>],
});

if (!result.success) {
  console.error('ERRORS:', JSON.stringify(result.errors));
  process.exit(1);
}

console.log(formatHireSummary(result.config));
"
```

Replace the placeholders with the actual collected values, properly JSON-escaped.

If `createNewSubagent` returns `adopted: true`, tell the user the existing `.md` was kept verbatim and that their typed description / system prompt were discarded (the `.md` is the single source of truth for identity). Display the on-disk `content` so they can confirm what they are wiring into aweek scheduling before proceeding to `hireAgent`.

If validation fails, report the specific errors and re-collect only the invalid fields, then retry.

If save succeeds, display the formatted summary to the user. The summary will include a pointer to `/aweek:plan` for approving the initial weekly plan.

## Validation Rules

- Agent name: 1-100 chars, non-empty
- Agent role: 1-200 chars, non-empty
- System prompt: non-empty string
- Weekly token limit: positive integer, default 500000
- Goals: 1-5 goals, each description >= 10 chars
- Monthly objectives: 1-5, each must reference a valid goal
- Weekly tasks: 1-100 (10 collected interactively), each must reference a valid objective
- All artifacts validated against JSON schemas before save

## Error Handling

- If the user provides empty or invalid input, explain what's wrong and re-ask that field only
- If schema validation fails after assembly, show the specific errors and allow correction
- The storage layer auto-creates the data directory if needed
- The agent ID includes a random suffix so collisions are extremely unlikely

## Next Steps

After a successful hire, tell the user:

- Review and approve the initial weekly plan with `/aweek:plan`
- View the full agent roster with `/aweek:summary`
- The heartbeat system activates after the first weekly plan approval

## Data Directory

Agents are stored in `.aweek/agents/<agent-id>.json` relative to the project root.
