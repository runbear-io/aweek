---
name: plan
description: Edit an agent's free-form planning markdown and adjust weekly tasks from a single entry point
trigger: aweek plan, adjust plan, edit plan, update plan, plan markdown, aweek add task, aweek add new task, aweek new task, aweek edit task, aweek update task, aweek change task, aweek remove task, aweek delete task, aweek drop task, aweek reschedule, aweek reschedule task, aweek reschedule everything, aweek move task, aweek change priority, aweek change prompt, aweek update prompt, aweek edit prompt, aweek tasks
---

# aweek:plan

Single entry point for every planning operation on an aweek agent:

- Edit the agent's free-form **planning markdown** (long-term goals, monthly plans, strategies, notes) at `.aweek/agents/<slug>/plan.md`.
- Adjust weekly **tasks** (create / add / update) on the in-flight week.

The planning markdown is the source of truth for long-term intent. It is intentionally free-form — the weekly generator reads it as context rather than enforcing a schema. If you find yourself wanting a structured field that `plan.md` can't express, add it as prose; the model will pick it up.

**Plans are always active.** There is no approval gate — every weekly plan is immediately eligible for the heartbeat the moment it lands on disk. Adjustments take effect on the next tick.

Weekly plan logic lives in `src/skills/plan.ts`, composed over the services in `src/services/plan-adjustments.ts`. Markdown logic lives in `src/storage/plan-markdown-store.ts`. Never write agent JSON or the plan file directly — always go through the skill module or the `plan-markdown` dispatcher.

## Instructions

Follow this exact workflow when invoked. Use `AskUserQuestion` for every interactive prompt.

### Step 1: Select an Agent

List all agents:

```bash
echo '{"dataDir":".aweek/agents"}' \
  | aweek exec agent-helpers listAllAgents --input-json -
```

Response is an array of `{ config }` records. Render a numbered list using agent name and role, then ask the user to pick one via `AskUserQuestion`.

If the list is empty, tell the user **"No agents found. Use /aweek:hire to create one first."** and stop.

### Step 2: Choose an Operation

Ask via `AskUserQuestion`:

1. **Edit planning markdown** — open / show / replace the agent's `plan.md`.
2. **Adjust weekly plan** — create a weekly plan, add tasks, update task status, etc.
3. **Done**

Route to the matching branch. After each branch finishes, loop back to Step 2 until the user picks **Done**.

---

## Branch A: Edit planning markdown

The markdown file is a free-form authoring surface. Its H2 conventions (Long-term goals / Monthly plans / Strategies / Notes) are a template, not a schema — the user can restructure freely.

### A1: Resolve the path and show what's there

```bash
echo '{"agentsDir":".aweek/agents","agentId":"<AGENT_ID>"}' \
  | aweek exec plan-markdown path --input-json -
echo '{"agentsDir":".aweek/agents","agentId":"<AGENT_ID>"}' \
  | aweek exec plan-markdown read --input-json -
```

`path` returns the absolute path; `read` returns the body (or `null` when the file is missing — in that case offer to seed it with `plan-markdown buildInitial`).

Show the user:

- The absolute path (so they can open it in their own editor).
- A condensed summary of current sections (use `plan-markdown parse` to extract titles + first 3 lines of each section).

### A2: Offer edit actions

Ask via `AskUserQuestion`:

1. **Open in editor** — echo `$EDITOR <path>` as a suggestion for the user to run themselves. Do NOT spawn an editor from the skill.
2. **Replace contents** — collect a new full-body markdown via `AskUserQuestion` (multi-line input) and write it:
   ```bash
   echo '{"agentsDir":".aweek/agents","agentId":"<AGENT_ID>","body":"<MARKDOWN>"}' \
     | aweek exec plan-markdown write --input-json -
   ```
3. **Append a section** — ask for a title + body, then read the current file, append `## <title>\n\n<body>\n`, and write back.
4. **Reseed from template** — *destructive*. Confirm via `AskUserQuestion`, then overwrite with `plan-markdown buildInitial`.
5. **Back** — return to Step 2.

Never write directly via `node -e` snippets. Always route through `aweek exec plan-markdown <fn>` so markdown edits are auditable and one-path.

---

## Branch B: Adjust the weekly plan

All weekly-plan edits share one atomic execution path via `plan.adjustPlan(...)`. Operations are validated up front — if any single operation fails validation, nothing is applied.

### Task planning convention — tracks for independent pacing

The heartbeat picks **one task per distinct track per tick**. Tracks are independent lanes that each fire at the cron cadence, so you can express "publish 3 X.com posts AND 4 Reddit posts in parallel this hour" without the two chains interfering.

- Explicit `track` string on a task (e.g. `"x-com"`, `"reddit"`) opts that task into a specific lane.
- When `track` is omitted, the task's `objectiveId` — treated here as a free-form string linking back to the markdown plan — is the default lane key. Tasks sharing an `objectiveId` pace together unless you set `track` to split them.
- Prefer **one task = one atomic action**. "Publish one X.com post" is a task; "publish 10 posts" is not.

Throughput budget: at `*/15` cron (4 ticks/hour), each track fires up to **4 tasks/hour**. Per-agent throughput is roughly `active_tracks × cron_frequency`, bounded by how long each session runs (the per-agent lock is held across the full per-tick drain).

### B1: Show the current week

Load existing weekly plans and show the active week with its tasks: `id · description · track · status · runAt`. If no weekly plans exist, tell the user and route them to the `create` action below — this is the bootstrap path for a freshly-hired agent.

### B2: Collect one adjustment at a time

Use `AskUserQuestion` to pick the action, then collect required fields. Loop until done.

- **`create`** → week (`YYYY-Www`, must NOT already exist on this agent), optional `month` (`YYYY-MM`, free-form tag linking the week to a monthly section of `plan.md`), optional seed tasks. Each task: description (required), optional `objectiveId` (free-form string, typically the monthly section heading it traces to), priority (`critical` / `high` / `medium` / `low`, default `medium`), `estimatedMinutes` (1-480), `track`, `runAt`. Newly created weekly plans are immediately eligible for the heartbeat — there is no approval gate.
- **`add`** → week (must exist), description (required), optional `objectiveId`, optional `track`, optional `runAt`.
- **`update`** → week, taskId, then at least one of: description, status (`pending` / `in-progress` / `completed` / `failed` / `delegated` / `skipped`), `track` (pass `null` to fall back to objectiveId pacing), `runAt` (pass `null` to clear).

### B2a: Interview gate (create action only)

When the user picks **`create`**, run the four interview-trigger checks **before** the layout check or any task collection:

```bash
echo '{"agentId":"<AGENT_ID>","dataDir":".aweek/agents"}' \
  | aweek exec plan checkInterviewTriggers --input-json -
```

Returns `Array<{ trigger, reason, details }>`. If the array is **empty**, skip directly to B2b.

**If any triggers fire**, offer the user two paths via `AskUserQuestion`:

> {N} concern(s) found before generating this week's plan:
>
> {for each trigger: `• {trigger.reason}`}
>
> How would you like to proceed?
>
> 1. **Answer questions** — I'll ask one question per concern (recommended for the best-fit plan).
> 2. **Skip questions** — I'll apply best-guess assumptions for each concern, show them to you, and ask for your approval before continuing.

Route based on the choice:

---

#### Path 1 — Adaptive interview (default)

Run an Ouroboros-style adaptive loop: every answer is scored across four weighted clarity dimensions, and the loop keeps drilling into the weakest one until the completion gate passes (overall ambiguity ≤ 0.20, every per-dimension floor met, two consecutive qualifying turns). Trigger-tailored questions seed the loop; once triggers are exhausted, follow-up questions target the weakest dimension.

**Dimensions** (matching `src/skills/plan-ambiguity.ts`):

| Key | Weight | Floor | Focuses on |
|---|---|---|---|
| `goalClarity` | 35% | 0.75 | Specific, non-aspirational weekly outcomes |
| `taskSpecificity` | 30% | 0.70 | Tasks concrete enough to dispatch without asking back |
| `prioritySequencing` | 20% | 0.65 | Ordering / what to do first if the week compresses |
| `constraintClarity` | 15% | 0.65 | Deadlines, dependencies, budget, availability |

##### P1-0: Resume or start a fresh interview

```bash
echo '{"agentsDir":".aweek/agents","agentId":"<AGENT_ID>"}' \
  | aweek exec plan-interview-store interviewExists --input-json -
```

- `true` → ask via `AskUserQuestion` whether to **resume** the prior state (`loadInterviewState`) or **discard and restart** (`clearInterviewState`, then `createInterviewState`).
- `false` → call `createInterviewState` with `initialContext` set to the user's top-level plan intent (capture this from the opening exchange when `create` was chosen).

Hold the returned state in session memory as `STATE`. After every mutation below, write it back with `saveInterviewState`.

##### P1-1: Seed with trigger-tailored questions

Emit one `AskUserQuestion` per fired trigger, in array order. Tailor each question using the trigger's `details` object:

- **`first-ever-plan`** — *This is **{agentName}**'s first weekly plan. To make it actionable rather than a placeholder, tell me: what are the 2–3 outcomes you most want {agentName} to accomplish this week? Be specific — I'll use these to anchor every task I generate.*
- **`conflicting-or-vague-goals`** (`details.vague`) — *I looked at **{agentName}**'s `plan.md` and found: **{details.vagueReason}**. Describe what you want this agent to accomplish in the next 30 days — 2–3 specific, measurable outcomes.*
- **`conflicting-or-vague-goals`** (`details.conflicting`) — *I found **{details.conflictingPairs.length}** conflicting goal pair(s) in `plan.md`: {list pairs}. Which direction should take precedence for this week's plan?*
- **`prior-week-problems`** — *Last week (**{details.priorWeekKey}**), **{details.totalFailed}** task(s) failed ({failure rate}). {failed descriptions}. What was the main cause, and should I reduce load, re-scope, or shift areas?*
- **`deadline-approaching`** — *Heads-up: {approaching deadlines summary}. Prioritise deadline-critical work this week, or maintain balance? List any specific deliverables that must land.*

**Run the scoring loop (P1-3) between every pair of trigger questions.** Do not ask multiple trigger questions back-to-back without scoring in between — the model needs to know whether a dimension is already satisfied before drilling.

##### P1-2: Adaptive drill (when triggers are exhausted)

Once every fired trigger has been asked AND the gate still says `qualifies: false`, generate the next question adaptively:

1. Get the snapshot + weakest dimension:
   ```bash
   echo '{"breakdown":<STATE.lastBreakdown>,"streak":<STATE.streak>}' \
     | aweek exec plan-ambiguity buildAmbiguitySnapshot --input-json -
   echo '{"breakdown":<STATE.lastBreakdown>}' \
     | aweek exec plan-ambiguity weakestDimension --input-json -
   ```
2. Using the snapshot + weakest dimension + the full `STATE.turns` transcript as context, **compose one follow-up question** targeting the weakest area. Rules for the question:
   - One question only. No preamble, no summary, no meta-commentary.
   - Aim to move the weakest dimension above its floor in a single round.
   - Prefer ontological questions ("What IS X?", "Root cause or symptom?", "What are we assuming?") over yes/no.
   - If the transcript already contains a known fact relevant to the question, frame the question as a decision rather than rediscovery ("Given X, should Y or Z?") — the breadth-keeper pattern from Ouroboros.
3. Emit via `AskUserQuestion` with options derived from the weakest dimension (e.g. for `constraintClarity`, offer "There is a deadline — let me specify", "No hard deadline", "Unclear / need to check").

##### P1-3: Score the transcript (runs after every answer)

After each answer lands:

1. Append the just-answered turn to the transcript and persist:
   ```bash
   echo '{"state":<STATE>,"turn":{"question":"<Q>","answer":"<A>"}}' \
     | aweek exec plan-interview-store appendTurn --input-json -
   # then:
   echo '{"agentsDir":".aweek/agents","agentId":"<AGENT_ID>","state":<STATE>}' \
     | aweek exec plan-interview-store saveInterviewState --input-json -
   ```
2. Build the scoring prompt:
   ```bash
   echo '{"initialContext":"<STATE.initialContext>","transcript":<STATE.turns>}' \
     | aweek exec plan-ambiguity buildScoringPrompt --input-json -
   ```
   Returns `{ system, user }`.
3. **Delegate scoring to a fresh subagent** (prevents self-grading bias):
   - Invoke the `Task` tool with `subagent_type: "general-purpose"`, `model: "haiku"`, and the concatenated `system` + `user` strings as the prompt. The subagent's final text response is the raw input for `parseScoreResponse`.
4. Parse the JSON:
   ```bash
   echo '{"raw":"<LLM_JSON>"}' \
     | aweek exec plan-ambiguity parseScoreResponse --input-json -
   ```
5. Update the streak and persist:
   ```bash
   echo '{"prevStreak":<STATE.streak>,"breakdown":<BREAKDOWN>}' \
     | aweek exec plan-ambiguity updateStreak --input-json -
   ```
6. Check the gate:
   ```bash
   echo '{"breakdown":<BREAKDOWN>,"streak":<NEW_STREAK>}' \
     | aweek exec plan-ambiguity qualifiesForCompletion --input-json -
   ```
   If `qualifies: true` → announce completion (see P1-5), `clearInterviewState`, proceed to B2b.

##### P1-4: Safety rails

- **Question cap = 8 total.** If the loop reaches 8 questions without `qualifies: true`, stop and ask the user whether to answer two more questions or continue with a lower-confidence plan.
- **Dialectic rhythm check:** if the same dimension has been `weakestDimension` for 3 consecutive turns with no score improvement, rotate to the second-weakest dimension on the next turn.
- **Scorer degradation:** if self-scoring fails to return valid JSON twice in a row, disable scoring for the rest of the interview and flag the breakdown as `partial: true` when closing.

##### P1-5: Closure

When `qualifies: true` OR the cap is reached AND the user chose to continue, recap and suggest tasks before B2b. `clearInterviewState` once the plan is saved in B3.

---

#### Path 2 — Skip questions (escape hatch)

```bash
echo '{"triggers":<TRIGGERS_JSON>}' \
  | aweek exec plan generateSkipAssumptions --input-json -
echo '{"assumptions":<ASSUMPTIONS_JSON>}' \
  | aweek exec plan formatAssumptionsBlock --input-json -
```

Echo the returned markdown block verbatim, then ask the user via `AskUserQuestion` whether to apply the assumptions, run the full interview, or cancel.

---

### B2b: Resolve layout preference (create action only)

After the interview gate (B2a), run the ambiguity detector before collecting week/month/task details:

```bash
echo '{"agentsDir":".aweek/agents","agentId":"<AGENT_ID>"}' \
  | aweek exec plan detectLayoutAmbiguity --input-json -
```

**If `confident === true`** — display a one-line note about the detected mode and continue collecting week/month/tasks.

**If `confident === false`** — ask the user via `AskUserQuestion` to pick between Theme Days / Priority Waterfall / Mixed before collecting any task details.

### B2c: Space runAt for repeat actions

When an objective needs the same action done multiple times within one day+hour, emit a **separate task per repetition** with **distinct `runAt` minutes** instead of sharing a `runAt`. Pick `runAt` minutes from `{00, 10, 20, 30, 40, 50}` so the heartbeat picks them up one tick apart.

### B3: Confirm the batch

Show queued adjustments grouped by action. Ask **"Apply these N adjustments? (yes / no)"** via `AskUserQuestion`. On `yes`, call `plan.adjustPlan(...)` once and display the result. On `no`, discard and return to B2.

```bash
echo '{"agentId":"<AGENT_ID>","weeklyAdjustments":[...],"dataDir":".aweek/agents"}' \
  | aweek exec plan adjustPlan --input-json -
```

---

## Destructive-operation gate

One action MUST collect an explicit `AskUserQuestion` confirmation before the skill module proceeds:

| Operation                             | Branch |
|---------------------------------------|--------|
| Reseed plan.md from the template      | A      |

The underlying adapters refuse to run without `confirmed: true` — do not bypass the gate.

## Related skills

- `/aweek:hire` — create a new agent + seed its `plan.md`.
- `/aweek:calendar` — visualize the active weekly plan as a day × hour grid.
- `/aweek:summary` — cross-agent status dashboard.
- `/aweek:recurring` — manage per-agent recurring task rules that the heartbeat materializes into weekly plans automatically (no `create` needed even on weeks with no hand-authored plan).

## Data locations

- `.aweek/agents/<slug>.json` — agent scheduling wrapper.
- `.aweek/agents/<slug>/plan.md` — free-form planning markdown (this skill's primary authoring surface).
- `.aweek/agents/<slug>/weekly-plans/<YYYY-Www>.json` — per-week task lists.
