---
name: hire
description: Hire (create) a new aweek agent — collect identity, then interview the user to author plan.md (long-term goals, monthly plans, strategies, notes) so the agent is plan-ready immediately.
trigger: aweek hire, hire agent, new agent, add agent, create agent, aweek create agent
---

# aweek:hire

Hire a new aweek agent interactively. Each aweek agent is a **1-to-1 wrapper
around a Claude Code subagent** defined in `.claude/agents/<slug>.md`. This
skill captures identity (name, description, system prompt) AND conducts a
short interview to populate the agent's planning markdown. It writes three
things:

1. The subagent `.md` at `.claude/agents/<slug>.md`.
2. The aweek scheduling JSON shell at `.aweek/agents/<slug>.json`.
3. A fully-written `plan.md` at `.aweek/agents/<slug>/plan.md`, built from
   the interview answers (not the blank template).

After the hire finishes, the user can move straight to `/aweek:plan`
Branch B to schedule their first week — no editor round-trip required.

The skill is a thin UX wrapper on top of `src/skills/hire-create-new-menu.js`
(for the create-new branch) and `src/skills/hire-all.js` (when adopting an
existing unhired subagent). All persistence and validation live in those
modules — do not write agent JSON or `.claude/agents/<slug>.md` files
directly.

## Instructions

You MUST follow this exact workflow when this skill is invoked.

### Step 0: Route Between Pick-Existing and Create-New

Before asking for any identity input, decide which branch of the wizard to
run. The rule is simple: if there are one or more **unhired** Claude Code
subagents already on disk under `.claude/agents/<slug>.md` (i.e. a file
exists but there is no matching `.aweek/agents/<slug>.json`), offer the
user a choice between adopting one of them or creating a brand-new
subagent. When none are available, skip the branching question and go
straight to the create-new path.

```bash
aweek exec hire-route determineHireRoute
```

The JSON result has the shape
`{ route: 'create-new' | 'choose', unhired: string[], forcedCreateNew: boolean }`.

- **`route === 'create-new'`** (also `forcedCreateNew: true`): Tell the
  user no unhired subagents were found under `.claude/agents/` and jump
  straight to Step 1 (create-new). Do NOT ask "Pick existing or Create
  new?" in this case.
- **`route === 'choose'`**: Use `AskUserQuestion` to offer exactly two
  options:
  1. **Pick existing** — adopt one of the slugs listed in `unhired`.
  2. **Create new** — write a fresh `.claude/agents/<slug>.md` via the
     Step 1 flow below.

If the user picks **Create new**, proceed to Step 1. If the user picks
**Pick existing**, pick a slug via `AskUserQuestion` and jump to Step 2
(adopt-existing).

Plugin-namespaced subagents (slugs prefixed `oh-my-claudecode-` or `geo-`)
are deliberately excluded from the `unhired` list per the v1 refactor
constraint and must never be offered as adoption targets.

### Step 1: Collect Agent Identity (Create-New Path)

The create-new path writes a brand-new subagent file with **minimal**
frontmatter (`name` + `description` only) and the user-supplied system
prompt as the body. Collect **exactly three** identity fields using
`AskUserQuestion` — do not prompt for model, tools, skills, or MCP
servers. Users who want to override any of those edit the generated
`.md` file by hand.

Do NOT proceed until all three fields are provided and non-empty.

1. **Name** (required, 1-100 chars): Ask for the agent's name. It will be
   slugified into a filesystem-safe slug and used as the filename of
   `.claude/agents/<slug>.md`, the aweek agent id, and the `subagentRef`.
   - Example: "Content Writer" → slug `content-writer`
   - Must contain at least one alphanumeric character.

2. **Description** (required, single line): Written verbatim to the
   `description:` frontmatter field on the new `.md`.
   - Example: "Writes weekly research briefs and summaries."

3. **System Prompt** (required): The prompt body Claude Code will use
   when this subagent runs. Written verbatim as the body of the new
   `.md`.
   - Example: "You are a meticulous research assistant who produces
     well-cited summaries."

4. **Weekly Token Budget** (optional, default 500000): Ask for the
   weekly token limit for this agent's aweek scheduling budget. Must be
   a positive integer. Not written to the `.md`; stored on the aweek
   JSON.

After collecting the three identity fields, show the user a short
summary and ask for explicit `AskUserQuestion` confirmation before
persisting. If the user declines, return to the relevant field to
correct input — do not silently discard the collected data.

On confirmation, persist both artifacts in one call via
`runCreateNewHire` (which writes or adopts the subagent `.md`, then
wraps it with the aweek scheduling JSON shell):

```bash
echo '{
  "name": "<NAME>",
  "description": "<DESCRIPTION>",
  "systemPrompt": "<SYSTEM_PROMPT>",
  "weeklyTokenLimit": <LIMIT>
}' | aweek exec hire-create-new-menu runCreateNewHire --input-json -
```

The result has this shape:

```json
{
  "success": true,
  "validation": { "valid": true, "errors": [], "slug": "content-writer" },
  "subagent": { "success": true, "adopted": false, "slug": "content-writer", "path": "…", "content": "…" },
  "hire":     { "success": true, "created": ["content-writer"], "skipped": [], "failed": [] }
}
```

To render the formatted summary the user sees:

```bash
# $RESULT is the JSON payload from the previous call
echo "$RESULT" | aweek exec hire-create-new-menu formatCreateNewResult \
  --input-json - --format text
```

Three failure modes, each with its own remediation:

- **Validation failure** (`result.validation.valid === false`): the three
  fields were invalid. Nothing was written. Surface the formatted output
  (it starts with "Input rejected — …") and re-prompt the user.
- **Subagent write failure** (`result.subagent.success === false`): the
  `.md` write failed and the aweek JSON wrapper was **never attempted**.
  Surface the "Subagent file error" block and resolve the underlying
  filesystem issue before retrying.
- **Wrapper failure** (`result.hire.success === false`): the `.md`
  landed but the aweek JSON shell failed. Surface the nested hire-all
  summary so the user sees which slug failed and why.

Adoption is a first-class outcome, not a failure: when
`.claude/agents/<slug>.md` already exists, the helper returns
`subagent.adopted: true` and keeps the on-disk `.md` verbatim. The typed
description + system prompt are discarded per the "single source of
truth" constraint. Tell the user adoption happened and display
`subagent.content` so they can confirm what they are wiring into aweek
scheduling.

### Step 2: Adopt an Existing Subagent (Pick-Existing Path)

When the user picked **Pick existing** in Step 0, wrap the chosen slug
with a minimal aweek scheduling JSON shell via `hireAllSubagents`. The
handler iterates internally, so pass the single slug as an array:

```bash
echo '{
  "slugs": ["<SLUG>"]
}' | aweek exec hire-all hireAllSubagents --input-json -
```

To render the summary:

```bash
echo "$RESULT" | aweek exec hire-all formatHireAllSummary \
  --input-json - --format text
```

The handler is idempotent (re-wrapping an already-hired slug reports
`skipped`, not an error) and defensive (plugin-namespaced slugs, missing
`.md` files, and invalid slug shapes surface as structured `skipped` /
`failed` entries instead of throwing).

### Step 3: Interview the User to Build plan.md

After the hire completes (either branch), the subagent directory contains
a blank-template `plan.md` (the `hireAllSubagents` handler seeds it
automatically). Replace that template with a plan derived from a short
interview — this is the whole point of the hire flow feeling "complete":
the user walks away with an agent that already has direction.

Collect four free-form answers via `AskUserQuestion`, **one at a time**.
Each prompt should be short and concrete; the answer field accepts
multi-line input. Skip-to-next is allowed — an empty answer falls back
to a placeholder comment in the rendered plan.

1. **Long-term goals** — "What should <agent name> achieve over the
   next 1 month / 3 months / 1 year? Bullet points are fine."
2. **Monthly plans** — "What's the focus for the current month? Add
   more `### YYYY-MM` sections below if you're already thinking ahead."
3. **Strategies** — "How should <agent name> work? Preferred tone,
   tools, rituals, guardrails — anything the weekly planner should
   respect."
4. **Notes** — "Anything else the agent should know?" (Optional.)

After collecting the answers, render the plan body and write it —
overwriting the template seeded by the hire handler:

```bash
echo '{
  "name": "<AGENT_NAME>",
  "description": "<DESCRIPTION>",
  "longTermGoals": "<ANSWER_1>",
  "monthlyPlans":  "<ANSWER_2>",
  "strategies":    "<ANSWER_3>",
  "notes":         "<ANSWER_4>"
}' | aweek exec plan-markdown buildFromInterview --input-json -
```

The response is a markdown string. Pipe it straight into a write:

```bash
echo '{
  "agentsDir": ".aweek/agents",
  "agentId":   "<SLUG>",
  "body":      "<BODY_FROM_buildFromInterview>"
}' | aweek exec plan-markdown write --input-json -
```

Always echo a short confirmation to the user: the absolute path of the
written plan (so they know where to edit later) plus a one-line summary
of what the four sections now contain.

Do **not** spawn an editor and do **not** ask the user to open the file
— the whole point of the interview is to skip the editor round-trip.
If the user wants to polish prose, point them at `/aweek:plan` Branch A
as a follow-up.

## Validation Rules

- **Name** — 1-100 chars, non-empty, must contain at least one alphanumeric
  character so it slugifies to a non-empty filename.
- **Description** — 1-200 chars, single line, non-empty.
- **System prompt** — non-empty string.
- **Weekly token limit** — positive integer, default 500000.

All artifacts are validated against JSON schemas before save.

## Error Handling

- If the user provides empty or invalid input, explain what's wrong and
  re-ask only the invalid field.
- If schema validation fails on persist, show the specific errors and
  allow correction.
- The storage layer auto-creates the data directory if needed.
- Slug collisions trigger the **adopt-existing** path automatically — the
  on-disk `.md` is kept verbatim and the typed description / system
  prompt are discarded.

## Next Steps

After a successful hire + interview, tell the user:

- Goals, monthly plans, and strategies are already in
  `.aweek/agents/<slug>/plan.md`. Revisit them anytime with
  `/aweek:plan` Branch A.
- Create the first **weekly plan** with `/aweek:plan` Branch B. That's
  the only remaining step before the heartbeat can start firing tasks.
- The heartbeat system activates after the first weekly plan approval.
- View the full agent roster with `/aweek:summary`.

## Data Directory

Agents are stored in `.aweek/agents/<agent-id>.json` relative to the
project root. Identity data (name, description, system prompt) lives in
`.claude/agents/<agent-id>.md` and is the single source of truth — edit
that file directly to rename or re-prompt the agent.
