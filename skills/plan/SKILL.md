---
name: plan
description: Edit an agent's free-form planning markdown, adjust weekly tasks, and approve pending weekly plans from a single entry point
trigger: aweek plan, adjust plan, edit plan, update plan, approve plan, review plan, approve weekly plan, reject plan, plan markdown
---

# aweek:plan

Single entry point for every planning operation on an aweek agent:

- Edit the agent's free-form **planning markdown** (long-term goals, monthly plans, strategies, notes) at `.aweek/agents/<slug>/plan.md`.
- Adjust weekly **tasks** (add / update) on the in-flight week.
- **Approve / reject / edit** a pending weekly plan (human-in-the-loop gate).

The planning markdown is the source of truth for long-term intent. It is intentionally free-form — the weekly generator reads it as context rather than enforcing a schema. If you find yourself wanting a structured field that `plan.md` can't express, add it as prose; the model will pick it up.

Weekly plan logic lives in `src/skills/plan.js`, composed over the services in `src/services/plan-adjustments.js` and `src/services/plan-approval.js`. Markdown logic lives in `src/storage/plan-markdown-store.js`. Never write agent JSON or the plan file directly — always go through the skill module or the `plan-markdown` dispatcher.

## Instructions

Follow this exact workflow when invoked. Use `AskUserQuestion` for every interactive prompt.

### Step 1: Select an Agent

List all agents and flag those with pending weekly plans:

```bash
echo '{"dataDir":".aweek/agents"}' \
  | aweek exec agent-helpers listAllAgents --input-json -
```

Response is an array of `{ config }` records. For each, check the pending plan:

```bash
echo '{"agentId":"<AGENT_ID>","dataDir":".aweek/agents"}' \
  | aweek exec plan reviewPlan --input-json -
```

`plan.reviewPlan` returns `{ success, plan, formatted, errors }`. When `success === false` with `errors: ["No pending ..."]`, there is no plan awaiting approval — drop the pending marker. Render a numbered list using agent name, role, and `pending: <week> (<N> tasks)` when present, then ask the user to pick one via `AskUserQuestion`.

If the list is empty, tell the user **"No agents found. Use /aweek:hire to create one first."** and stop.

### Step 2: Choose an Operation

Ask via `AskUserQuestion`:

1. **Edit planning markdown** — open / show / replace the agent's `plan.md`.
2. **Adjust weekly plan** — create a weekly plan, add tasks, update task status, etc.
3. **Review pending plan** — approve / reject / edit a pending weekly plan (only offer when Step 1 found one).
4. **Done**

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

- **`create`** → week (`YYYY-Www`, must NOT already exist on this agent), optional `month` (`YYYY-MM`, free-form tag linking the week to a monthly section of `plan.md`), optional seed tasks. Each task: description (required), optional `objectiveId` (free-form string, typically the monthly section heading it traces to), priority (`critical` / `high` / `medium` / `low`, default `medium`), `estimatedMinutes` (1-480), `track`, `runAt`. Freshly-created weekly plans start `approved: false` and activate the heartbeat only after Branch C approval.
- **`add`** → week (must exist), description (required), optional `objectiveId`, optional `track`, optional `runAt`.
- **`update`** → week, taskId, then at least one of: description, status (`pending` / `in-progress` / `completed` / `failed` / `delegated` / `skipped`), `track` (pass `null` to fall back to objectiveId pacing), `runAt` (pass `null` to clear).

### B3: Confirm the batch

Show queued adjustments grouped by action. Ask **"Apply these N adjustments? (yes / no)"** via `AskUserQuestion`. On `yes`, call `plan.adjustPlan(...)` once and display the result. On `no`, discard and return to B2.

```bash
echo '{"agentId":"<AGENT_ID>","weeklyAdjustments":[...],"dataDir":".aweek/agents"}' \
  | aweek exec plan adjustPlan --input-json -
```

---

## Branch C: Review a pending plan

The approval gate. `plan.reviewPlan` already returned the pending plan from Step 1 — show it to the user and ask what to do.

### C1: Display the pending plan

Echo the `formatted` string from `reviewPlan`. It shows the week, status, and every task with id / description / track / priority / estimatedMinutes.

### C2: Pick an action

Ask via `AskUserQuestion`:

1. **Approve** — flips `approved: true`, unblocking the heartbeat. Run:
   ```bash
   echo '{"agentId":"<AGENT_ID>","dataDir":".aweek/agents"}' \
     | aweek exec plan approve --input-json -
   ```
2. **Reject** — *destructive*. Confirm first. Runs `plan reject`, which deletes the plan so the next generation cycle starts fresh.
3. **Edit** — collect adjustments as in Branch B (but without the `create` action — the plan already exists), then run:
   ```bash
   echo '{"agentId":"<AGENT_ID>","adjustments":[...],"dataDir":".aweek/agents"}' \
     | aweek exec plan edit --input-json -
   ```
4. **Back** — return to Step 2.

Always echo the `formatted` field from the response so the user can see what happened.

---

## Destructive-operation gate

Two actions MUST collect an explicit `AskUserQuestion` confirmation before the skill module sets `confirmed: true`:

| Operation                             | Branch |
|---------------------------------------|--------|
| Reseed plan.md from the template      | A      |
| Reject a pending weekly plan          | C      |

The underlying adapters refuse to run without `confirmed: true` — do not bypass the gate.

## Related skills

- `/aweek:hire` — create a new agent + seed its `plan.md`.
- `/aweek:calendar` — visualize the active weekly plan as a day × hour grid.
- `/aweek:summary` — cross-agent status dashboard.

## Data locations

- `.aweek/agents/<slug>.json` — agent scheduling wrapper.
- `.aweek/agents/<slug>/plan.md` — free-form planning markdown (this skill's primary authoring surface).
- `.aweek/agents/<slug>/weekly-plans/<YYYY-Www>.json` — per-week task lists.
