---
name: aweek:plan
description: Manage an agent's goals, monthly objectives, weekly tasks, and pending plan approvals from a single entry point
trigger: aweek plan, adjust goal, change goal, update goal, modify goal, edit goal, adjust plan, change plan, update plan, approve plan, review plan, approve weekly plan, reject plan, edit plan
---

# aweek:plan

Single entry point for every planning operation on an aweek agent:

- Adjust long-term **goals** (add / update / remove).
- Adjust monthly **objectives** (add / update).
- Adjust weekly **tasks** (add / update).
- **Approve / reject / edit** a pending weekly plan (human-in-the-loop gate).

This skill replaces the old `/aweek:adjust-goal` and `/aweek:approve-plan`
skills. All logic lives in `src/skills/plan.js`, which composes the shared
services in `src/services/plan-adjustments.js` and
`src/services/plan-approval.js`. Never write agent JSON files directly —
always go through the skill module.

## Instructions

Follow this exact workflow when invoked. Use `AskUserQuestion` for every
interactive prompt. Keep the first screen focused — drill down only when
the user asks for it.

### Step 1: Select an Agent

List all agents and show which ones have pending weekly plans awaiting
approval. The pending-plan marker is what signals "this agent needs
review" so the user can pick it fast.

```bash
echo '{"dataDir":".aweek/agents"}' \
  | aweek exec agent-helpers listAllAgents --input-json -
```

The response is an array of `{ config }` records. For each entry, compute
the display row:

```js
const pending = (config.weeklyPlans || []).find((p) => p.approved === false);
const row = {
  id: config.id,
  name: config.identity?.name,
  role: config.identity?.role,
  goals: (config.goals || []).length,
  pendingWeek: pending?.week || null,
  pendingTasks: pending?.tasks?.length || 0,
};
```

- If the response array is empty, tell the user: **"No agents found. Use /aweek:hire to
  create one first."** and stop.
- Otherwise display a numbered list: agent name, role, goal count, and
  `pending: <week> (<N> tasks)` when a plan is awaiting approval.
- Ask the user to pick one using `AskUserQuestion`.

### Step 2: Choose an Operation

Ask the user, via `AskUserQuestion`, what they want to do with the
selected agent. Present these options:

1. **Adjust goals** — add, update, or remove long-term goals
2. **Adjust monthly objectives** — add or update a monthly objective
3. **Adjust weekly tasks** — add or update a weekly task
4. **Review pending plan** — approve / reject / edit the pending weekly
   plan (only offer this option when the agent actually has a pending
   plan from Step 1)
5. **Done**

Route to the matching branch below. When the user finishes a branch, ask
**"Would you like to do anything else with this agent?"** and loop back
to Step 2 until they pick **Done**.

---

## Branch A: Adjust goals / monthly / weekly

All three adjustment scopes share the same execution path via
`plan.adjustPlan(...)`. Operations are validated up front and applied
atomically — if any single operation fails validation, none are applied.

### A1: Show Current State

Before collecting edits, load the agent config and display the relevant
slice so the user sees what they are editing:

- **Goals branch** — show a numbered list of goals: `id · description ·
  horizon · status`.
- **Monthly branch** — show each monthly plan (`YYYY-MM`) with its
  objectives: `id · description · linked goal · status`. If no monthly
  plans exist, say so and return to Step 2.
- **Weekly branch** — show each weekly plan (`YYYY-Www`) with its tasks:
  `id · description · linked objective · status`. If no weekly plans
  exist, say so and return to Step 2.

### A2: Collect One Adjustment at a Time

Use `AskUserQuestion` to pick the action, then collect the required
fields. Keep looping until the user says they are done.

**Goals (`goalAdjustments`)**

- `add` → description (required, non-empty), horizon (`1mo` / `3mo` / `1yr`).
- `update` → goalId (pick from the numbered list), then at least one of:
  description, horizon, status (`active` / `completed` / `paused` /
  `dropped`).
- `remove` → goalId.
  - **Destructive:** before queuing a `remove`, ask **"Are you sure you
    want to remove goal <id>? This cannot be undone. (yes / no)"** via
    `AskUserQuestion`. If the user does not explicitly confirm, drop the
    operation and return to the menu. Dependent monthly / weekly items
    are **not** cascaded — remind the user to review them.

**Monthly (`monthlyAdjustments`)**

- `add` → month (`YYYY-MM`, must match an existing monthly plan),
  description (required), goalId (pick from the numbered goals list).
- `update` → month, objectiveId, then at least one of: description, status
  (`planned` / `in-progress` / `completed` / `dropped`).

**Weekly (`weeklyAdjustments`)**

- `add` → week (`YYYY-Www`, must match an existing weekly plan),
  description (required), objectiveId (pick from the numbered objectives
  list, flattened across all monthly plans).
- `update` → week, taskId, then at least one of: description, status
  (`pending` / `in-progress` / `completed` / `failed` / `delegated` /
  `skipped`).

### A3: Confirm the Batch

Show the full queued batch grouped by scope, e.g.:

```
Planned adjustments for agent "<AGENT_NAME>":

  Goals:
    - Add: "New goal description" (horizon: 1yr)
    - Remove: goal-abc123  (user confirmed)

  Monthly Objectives:
    - Update: 2026-04 / obj-abc123 → status: in-progress

  Weekly Tasks:
    - Add: "New task description" (objective: obj-xyz789)
```

Ask `AskUserQuestion`: **"Apply these changes? (yes / no / edit)"**.
- `yes` → Step A4
- `no` → discard the batch and return to Step 2
- `edit` → return to Step A2 so the user can revise or add operations

### A4: Apply

Execute the batch through `plan.adjustPlan`:

```bash
echo '{
  "agentId": "<AGENT_ID>",
  "goalAdjustments":   [<GOAL_OPS>],
  "monthlyAdjustments": [<MONTHLY_OPS>],
  "weeklyAdjustments":  [<WEEKLY_OPS>]
}' | aweek exec plan adjustPlan --input-json -
```

If `result.success === false`, surface `result.errors` and stop. On
success, format the batch via:

```bash
# $RESULT is the JSON payload from adjustPlan
echo "$RESULT" | aweek exec plan formatAdjustmentResult \
  --input-json - --format text
```

`formatAdjustmentResult` accepts either the full `result` object (it
unwraps `result.results` automatically) or a raw `results` slice.

Substitute the collected operation objects, properly JSON-escaped. Each
operation object must match one of these shapes:

- **Goal add:** `{ "action": "add", "description": "...", "horizon": "1mo|3mo|1yr" }`
- **Goal update:** `{ "action": "update", "goalId": "goal-xxx", "description": "...", "status": "...", "horizon": "..." }`
- **Goal remove:** `{ "action": "remove", "goalId": "goal-xxx" }`
- **Monthly add:** `{ "action": "add", "month": "YYYY-MM", "description": "...", "goalId": "goal-xxx" }`
- **Monthly update:** `{ "action": "update", "month": "YYYY-MM", "objectiveId": "obj-xxx", "description": "...", "status": "..." }`
- **Weekly add:** `{ "action": "add", "week": "YYYY-Www", "description": "...", "objectiveId": "obj-xxx" }`
- **Weekly update:** `{ "action": "update", "week": "YYYY-Www", "taskId": "task-xxx", "description": "...", "status": "..." }`

Print the `formatAdjustmentResult` output verbatim to the user.

---

## Branch B: Review pending weekly plan

Only offered when the agent has at least one plan with `approved: false`.

### B1: Display the Plan

Load and display the formatted pending plan via `plan.reviewPlan`:

```bash
echo '{"agentId":"<AGENT_ID>"}' \
  | aweek exec plan reviewPlan --input-json -
```

The response JSON exposes `success`, `errors`, and `formatted`. Print
`result.formatted` verbatim.

The formatter includes agent identity, the week / month, every task with
priority and estimated minutes, and the full Goal → Objective → Task
traceability chain. Print `result.formatted` verbatim.

### B2: Ask for a Decision

Use `AskUserQuestion`:

> **What would you like to do with this plan?**
>
> 1. **Approve** — accept as-is. The first approval activates the
>    heartbeat system.
> 2. **Reject** — **destructive:** removes the pending plan.
> 3. **Edit** — add / remove / update tasks, then decide again.
> 4. **Cancel** — leave the plan pending and return to Step 2.

### B3a: Approve

```bash
RESULT=$(echo '{"agentId":"<AGENT_ID>"}' \
  | aweek exec plan approve --input-json -)

# Wrap the approve response + decision tag and stream through the formatter.
jq -n --argjson r "$RESULT" '{result: $r, action: "approve"}' \
  | aweek exec plan formatApprovalResult --input-json - --format text
```

`formatApprovalResult` takes a `{ result, action }` input. If `RESULT`'s
`success` field is `false`, surface the errors and stop.

Print the formatted result. If this was the **first** approval for the
agent (the result will say so), emphasize that **the heartbeat system is
now active** — a cron entry has been installed and the agent will start
executing tasks on the next tick.

### B3b: Reject (destructive — requires explicit confirmation)

Rejecting **permanently removes** the pending plan from the agent's
`weeklyPlans` array. Per project policy this requires explicit user
confirmation at the skill layer.

1. Ask `AskUserQuestion`: **"Are you sure you want to reject this plan?
   This deletes it. (yes / no)"**. If the user does not answer `yes`,
   return to Step B2 without touching the plan.
2. Ask `AskUserQuestion` for an optional rejection reason (free-text).
   Allow empty.
3. Only after the explicit `yes`, call `plan.reject` with
   `confirmed: true`. Without that flag the adapter refuses to run:

```bash
RESULT=$(echo '{
  "agentId": "<AGENT_ID>",
  "rejectionReason": "<REASON_OR_EMPTY>",
  "confirmed": true
}' | aweek exec plan reject --input-json -)

jq -n --argjson r "$RESULT" '{result: $r, action: "reject"}' \
  | aweek exec plan formatApprovalResult --input-json - --format text
```

After rejection, suggest: **"You can regenerate a fresh weekly plan, or
use the Adjust-goals branch first to tweak objectives before the next
plan is generated."**

### B3c: Edit

Collect edits interactively. Show the numbered task list and loop until
the user says `done`:

- **add** → description (non-empty), objectiveId (pick from numbered list
  of objectives across all monthly plans), optional priority
  (`critical` / `high` / `medium` / `low`, default `medium`), optional
  estimatedMinutes (integer 1-480).
- **remove** → taskId (pick from the numbered list).
- **update** → taskId, then at least one of description, priority,
  estimatedMinutes.

After the last edit, ask `AskUserQuestion`:
**"Approve the plan after applying these edits? (yes / no)"**
— `yes` sets `autoApproveAfterEdit: true`, `no` leaves the plan pending.

```bash
RESULT=$(echo '{
  "agentId": "<AGENT_ID>",
  "edits": <EDITS_JSON_ARRAY>,
  "autoApproveAfterEdit": <true_or_false>
}' | aweek exec plan edit --input-json -)

jq -n --argjson r "$RESULT" '{result: $r, action: "edit"}' \
  | aweek exec plan formatApprovalResult --input-json - --format text
```

Each edit object must match one of these shapes:

- **Add:** `{ "action": "add", "description": "...", "objectiveId": "obj-xxx", "priority": "medium", "estimatedMinutes": 60 }`
- **Remove:** `{ "action": "remove", "taskId": "task-xxx" }`
- **Update:** `{ "action": "update", "taskId": "task-xxx", "description": "...", "priority": "...", "estimatedMinutes": 60 }`

If the user did **not** auto-approve, ask afterwards: **"Approve the plan
now? (yes / no)"**. If `yes`, re-enter Step B3a. If `no`, confirm that
the plan is still pending and return to Step 2.

### B4: Final Status

Print the formatted approval result. Call out:

- Whether the plan was approved / rejected / edited.
- Whether the heartbeat was just activated (first approval only).
- Number of tasks in the final plan.
- Next steps (e.g., "Agent will start executing on the next heartbeat").

---

## Validation Rules

- Agent must exist in `.aweek/agents/`.
- **Goal horizons:** `1mo`, `3mo`, `1yr`.
- **Goal statuses:** `active`, `completed`, `paused`, `dropped`.
- **Objective statuses:** `planned`, `in-progress`, `completed`, `dropped`.
- **Task statuses:** `pending`, `in-progress`, `completed`, `failed`,
  `delegated`, `skipped`.
- **Priorities:** `critical`, `high`, `medium`, `low`.
- **estimatedMinutes:** integer 1-480.
- **Monthly format:** `YYYY-MM`.
- **Weekly format:** `YYYY-Www` (e.g., `2026-W16`).
- At least one adjustment required per apply in Branch A.
- Descriptions are non-empty strings.
- Referenced goals / objectives / tasks must exist.
- All operations validated against JSON schemas before persisting;
  batches are atomic — all succeed or all fail.

## Destructive Operations (mandatory confirmation)

Every destructive action in this skill must ask the user to confirm
before execution. The user must explicitly answer `yes`; anything else
aborts without touching data.

| Action                    | Confirmation                                                     |
|---------------------------|------------------------------------------------------------------|
| Goal `remove`             | Inline `AskUserQuestion` before queuing the operation            |
| Weekly plan `reject`      | `AskUserQuestion` **and** `confirmed: true` flag on `plan.reject`|

The `plan.reject` wrapper refuses to run without `confirmed: true` — do
not bypass it.

## Error Handling

- Invalid / empty input → explain the issue and re-ask.
- Validation failure after collecting a batch → show every error and let
  the user fix them. Nothing is persisted.
- Agent not found → suggest `/aweek:hire`.
- Agent has no pending plan when Branch B was requested → tell the user
  and return to Step 2.
- Agent file unreadable → suggest checking the agent id.

## Plan Traceability

The review display and the apply summary both surface the full
`Goal → Monthly Objective → Weekly Task` chain so the user can verify
that every task still ladders up to a live goal. Removing a goal does
**not** cascade to dependent objectives / tasks — the user is prompted
to review them.

## Heartbeat Activation

The **first** weekly plan approval for any agent activates the heartbeat
system. `formatApprovalResult(result, 'approve')` surfaces this; repeat
the activation message prominently. Subsequent approvals do not
re-trigger activation messaging.

## Data Directory

Agents are stored in `.aweek/agents/<agent-id>.json` relative to the
project root.
