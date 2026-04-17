---
name: aweek:adjust-goal
description: Adjust an agent's goals, monthly objectives, or weekly tasks interactively
trigger: adjust goal, change goal, update goal, modify goal, edit goal, adjust plan, change plan, update plan, aweek adjust goal
---

# aweek:adjust-goal

Interactively adjust an existing agent's long-term goals, monthly objectives, or weekly tasks. This skill walks the user through selecting an agent, choosing the level of adjustment, collecting new values, confirming changes, and displaying feedback.

## Instructions

You MUST follow this exact workflow when this skill is invoked. Use the project's Node.js modules in `src/skills/adjust-goal.js` — never write agent JSON files directly.

### Step 1: Select an Agent

List all available agents by reading from the `.aweek/agents/` directory, then ask the user to pick one.

```bash
node --input-type=module -e "
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = join(process.cwd(), 'data', 'agents');
try {
  const files = await readdir(dir);
  const agents = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const data = JSON.parse(await readFile(join(dir, f), 'utf-8'));
    agents.push({ id: data.id, name: data.name, role: data.role, goals: data.goals?.length || 0 });
  }
  if (agents.length === 0) {
    console.log('NO_AGENTS');
  } else {
    console.log(JSON.stringify(agents, null, 2));
  }
} catch (e) {
  console.log('NO_AGENTS');
}
"
```

- If no agents exist, inform the user: "No agents found. Use /aweek:create-agent to create one first." and stop.
- Display a numbered list of agents showing name, role, and number of goals.
- Ask the user to select an agent by number or name using AskUserQuestion.

### Step 2: Load the Selected Agent

Load the full agent config to display current state:

```bash
node --input-type=module -e "
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const config = JSON.parse(await readFile(join(process.cwd(), 'data', 'agents', '<AGENT_ID>.json'), 'utf-8'));
console.log(JSON.stringify(config, null, 2));
"
```

Replace `<AGENT_ID>` with the actual agent ID.

### Step 3: Choose Adjustment Level

Ask the user which level they want to adjust using AskUserQuestion. Present these options:

1. **Goals** — Add, update, or remove long-term goals (horizons: 1mo, 3mo, 1yr)
2. **Monthly Objectives** — Add or update objectives in a monthly plan
3. **Weekly Tasks** — Add or update tasks in a weekly plan

The user may select by number or name. Allow multiple adjustment levels in one session (ask "Would you like to adjust anything else?" after each adjustment).

### Step 4: Collect Adjustment Details

Based on the chosen level, follow the appropriate sub-flow below.

#### 4a: Goal Adjustments

Display current goals in a numbered list showing: ID, description, horizon, status.

Ask: "What would you like to do?" with options:
- **Add** a new goal
- **Update** an existing goal
- **Remove** an existing goal

**For Add:**
1. Ask for the goal description (required, non-empty string)
2. Ask for the horizon: `1mo` (1 month), `3mo` (3 months), or `1yr` (1 year)

**For Update:**
1. Ask which goal to update (by number from the displayed list)
2. Ask what to change — description, horizon, and/or status
3. Valid statuses: `active`, `completed`, `paused`, `dropped`
4. At least one field must change

**For Remove:**
1. Ask which goal to remove (by number from the displayed list)
2. Confirm removal: "Are you sure you want to remove this goal? (yes/no)"

#### 4b: Monthly Objective Adjustments

Display current monthly plans with their objectives. Show: month (YYYY-MM), objective ID, description, linked goal, status.

If no monthly plans exist, inform the user and return to Step 3.

Ask: "What would you like to do?" with options:
- **Add** a new objective
- **Update** an existing objective

**For Add:**
1. Ask which month to add to (must be an existing monthly plan in YYYY-MM format)
2. Ask for the objective description (required, non-empty)
3. Display the numbered goals list and ask which goal this objective relates to
4. Valid statuses: `planned`, `in-progress`, `completed`, `dropped`

**For Update:**
1. Ask which month's plan to update (YYYY-MM)
2. Ask which objective to update (by number from the displayed list)
3. Ask what to change — description and/or status
4. At least one field must change

#### 4c: Weekly Task Adjustments

Display current weekly plans with their tasks. Show: week (YYYY-Www), task ID, description, linked objective, status.

If no weekly plans exist, inform the user and return to Step 3.

Ask: "What would you like to do?" with options:
- **Add** a new task
- **Update** an existing task

**For Add:**
1. Ask which week to add to (must be an existing weekly plan in YYYY-Www format)
2. Ask for the task description (required, non-empty)
3. Display the numbered objectives list (from all monthly plans) and ask which objective this task relates to

**For Update:**
1. Ask which week's plan to update (YYYY-Www)
2. Ask which task to update (by number from the displayed list)
3. Ask what to change — description and/or status
4. Valid task statuses: `pending`, `in-progress`, `completed`, `failed`, `delegated`, `skipped`
5. At least one field must change

### Step 5: Confirm Changes

Before applying, display a summary of all planned adjustments:

```
Planned adjustments for agent "<AGENT_NAME>":

  Goals:
    - Add: "New goal description" (horizon: 1yr)

  Monthly Objectives:
    - Update: obj-abc123 → status: in-progress

  Weekly Tasks:
    - Add: "New task description" (objective: obj-xyz789)
```

Ask: "Apply these changes? (yes/no)" using AskUserQuestion.

If the user says no, ask if they want to modify the adjustments or cancel entirely.

### Step 6: Apply and Save

Execute the adjustments using the `adjustGoals` function from `src/skills/adjust-goal.js`:

```bash
node --input-type=module -e "
import { adjustGoals, formatAdjustmentSummary } from './src/skills/adjust-goal.js';

const result = await adjustGoals({
  agentId: '<AGENT_ID>',
  goalAdjustments: [<GOAL_OPS>],
  monthlyAdjustments: [<MONTHLY_OPS>],
  weeklyAdjustments: [<WEEKLY_OPS>],
});

if (!result.success) {
  console.error('ERRORS:', JSON.stringify(result.errors));
  process.exit(1);
}

console.log(formatAdjustmentSummary(result.results));
"
```

Replace placeholders with actual collected values, properly JSON-escaped. Each operation object must match the expected shape:

- **Goal add:** `{ "action": "add", "description": "...", "horizon": "1mo|3mo|1yr" }`
- **Goal update:** `{ "action": "update", "goalId": "goal-xxx", "description": "...", "status": "...", "horizon": "..." }`
- **Goal remove:** `{ "action": "remove", "goalId": "goal-xxx" }`
- **Monthly add:** `{ "action": "add", "month": "YYYY-MM", "description": "...", "goalId": "goal-xxx" }`
- **Monthly update:** `{ "action": "update", "month": "YYYY-MM", "objectiveId": "obj-xxx", "description": "...", "status": "..." }`
- **Weekly add:** `{ "action": "add", "week": "YYYY-Www", "description": "...", "objectiveId": "obj-xxx" }`
- **Weekly update:** `{ "action": "update", "week": "YYYY-Www", "taskId": "task-xxx", "description": "...", "status": "..." }`

### Step 7: Display Feedback

If the operation succeeds, display the formatted summary returned by `formatAdjustmentSummary`.

Then ask: "Would you like to make more adjustments to this agent? (yes/no)"
- If yes, return to Step 3
- If no, display a final confirmation message and end

## Validation Rules

- Agent must exist in `.aweek/agents/`
- Goal horizons: `1mo`, `3mo`, `1yr`
- Goal statuses: `active`, `completed`, `paused`, `dropped`
- Objective statuses: `planned`, `in-progress`, `completed`, `dropped`
- Task statuses: `pending`, `in-progress`, `completed`, `failed`, `delegated`, `skipped`
- Monthly plan month format: `YYYY-MM`
- Weekly plan week format: `YYYY-Www` (e.g., `2026-W16`)
- At least one adjustment required per invocation
- All adjustments validated before any are applied (atomic — all succeed or all fail)
- Descriptions must be non-empty strings
- Referenced goals/objectives/tasks must exist

## Error Handling

- If the user provides empty or invalid input, explain what's wrong and re-ask
- If validation fails after collecting all adjustments, show the specific errors and allow correction
- If the agent file cannot be read, suggest checking the agent ID or running `/aweek:create-agent`
- Atomic validation: if any single adjustment in a batch fails validation, none are applied — show all errors and let the user fix them

## Plan Traceability

This skill enforces traceability at every level:
- Monthly objectives must reference an existing goal
- Weekly tasks must reference an existing objective
- Removing a goal does NOT automatically cascade — the user should review dependent objectives

## Data Directory

Agents are stored in `.aweek/agents/<agent-id>.json` relative to the project root.
