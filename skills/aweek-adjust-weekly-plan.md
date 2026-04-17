# aweek:adjust-weekly-plan

Adjust an agent's weekly plan based on natural language feedback. Interprets the feedback, clarifies ambiguities, and applies minimal changes to preserve the original plan.

## Instructions

You MUST follow this exact workflow when this skill is invoked.

### Step 1: Select an Agent

List all available agents:

```bash
node --input-type=module -e "
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = join(process.cwd(), '.aweek', 'agents');
try {
  const files = await readdir(dir);
  const agents = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const data = JSON.parse(await readFile(join(dir, f), 'utf-8'));
    const plans = data.weeklyPlans || [];
    const latest = plans[plans.length - 1];
    agents.push({
      id: data.id,
      name: data.identity?.name,
      latestWeek: latest?.week || null,
      taskCount: latest?.tasks?.length || 0,
      approved: latest?.approved || false,
    });
  }
  if (agents.length === 0) console.log('NO_AGENTS');
  else console.log(JSON.stringify(agents, null, 2));
} catch { console.log('NO_AGENTS'); }
"
```

- If no agents exist, inform the user and stop.
- If only one agent exists, auto-select it.
- If multiple agents, ask the user to pick one.

### Step 2: Load the Current Plan

Load the latest weekly plan for the selected agent:

```bash
node --input-type=module -e "
import { loadPlanForReview } from './src/skills/approve-plan.js';

const result = await loadPlanForReview({ agentId: '<AGENT_ID>' });
if (!result.success) {
  console.error('ERROR:', result.errors.join(', '));
  process.exit(1);
}
console.log(result.formatted);
console.log('---PLAN_JSON---');
console.log(JSON.stringify(result.plan, null, 2));
"
```

Display the formatted plan to the user.

### Step 3: Collect Feedback

Ask the user: **"What changes would you like to make to this plan?"**

Use AskUserQuestion with free-text input (select "Other"). The user can provide natural language feedback such as:
- "Remove weekend posts"
- "Change evening posts (8pm, 10pm) to high priority"
- "Add a morning recap post at 7am on weekdays"
- "Skip Tuesday entirely"
- "Reduce posting to every 3 hours instead of 2"

### Step 4: Interpret and Clarify

Analyze the feedback and determine the concrete edit operations needed. Follow these principles:

**Preservation principle:** Keep the original plan intact unless the feedback explicitly targets specific tasks. Do NOT rewrite or clean up tasks that aren't mentioned.

**Interpretation rules:**
1. Map natural language to specific `add`, `remove`, or `update` operations
2. Match tasks by description patterns (day names, times, keywords)
3. If the feedback is ambiguous, ask the user to clarify using AskUserQuestion BEFORE proceeding
4. If a change could affect many tasks, confirm the scope with the user first

**Examples of interpretation:**
- "Remove weekend posts" → remove all tasks with "Sat" or "Sun" in description
- "Change priority of evening posts to high" → update tasks with "8:00 PM" or "10:00 PM" to priority: high
- "Add a 7am post on weekdays" → add 5 new tasks (Mon-Fri 7:00 AM)
- "Skip Tuesday" → remove all tasks with "Tue" in description

### Step 5: Present Proposed Changes

Before applying, show the user a summary of proposed changes:

```
Proposed changes to Week 2026-W16:

  REMOVE (14 tasks):
    - Publish X.com post (Sat 8:00 AM)
    - Publish X.com post (Sat 10:00 AM)
    - ... (12 more)

  UPDATE (4 tasks):
    - task-abc123: priority medium → high

  ADD (2 tasks):
    - Publish X.com post (Mon 7:00 AM)
    - Publish X.com post (Tue 7:00 AM)

  UNCHANGED: 40 tasks preserved
```

Ask the user to confirm: **"Apply these changes?"** (Yes / No / Edit)

If the user says "Edit", go back to Step 3 for additional feedback.

### Step 6: Apply Changes

Apply the confirmed edits using the approve-plan edit functions:

```bash
node --input-type=module -e "
import { AgentStore } from './src/storage/agent-store.js';
import { WeeklyPlanStore } from './src/storage/weekly-plan-store.js';
import { applyEdits, validateEdits } from './src/skills/approve-plan.js';

const dataDir = '.aweek/agents';
const agentStore = new AgentStore(dataDir);
const weeklyPlanStore = new WeeklyPlanStore(dataDir);

const plan = await weeklyPlanStore.load('<AGENT_ID>', '<WEEK>');

const edits = <EDITS_JSON_ARRAY>;

// Validate first
const validation = validateEdits(edits, plan);
if (!validation.valid) {
  console.error('Validation errors:', JSON.stringify(validation.errors));
  process.exit(1);
}

// Apply edits
const result = applyEdits(plan, edits);

// Save
await weeklyPlanStore.update('<AGENT_ID>', '<WEEK>', () => result.plan);

console.log('SUCCESS');
console.log('Applied:', result.applied.length, 'edits');
console.log('Remaining tasks:', result.plan.tasks.length);
result.applied.forEach(a => {
  if (a.action === 'add') console.log('  + Added:', a.description);
  if (a.action === 'remove') console.log('  - Removed:', a.description);
  if (a.action === 'update') console.log('  ~ Updated:', a.taskId, JSON.stringify(a.changes));
});
"
```

Each edit object must match one of these shapes:
- **Add**: `{ "action": "add", "description": "...", "objectiveId": "obj-xxx", "priority": "medium", "estimatedMinutes": 60 }`
- **Remove**: `{ "action": "remove", "taskId": "task-xxx" }`
- **Update**: `{ "action": "update", "taskId": "task-xxx", "description": "...", "priority": "...", "estimatedMinutes": 60 }`

### Step 7: Show Result

After applying, display:
1. Number of changes applied
2. Final task count
3. Offer to render the updated calendar grid: "Would you like to see the updated calendar?"

If yes, render using the weekly-calendar-grid renderer with appropriate options.

## Key Principles

1. **Minimal changes**: Only modify what the feedback explicitly targets. Never restructure, rename, or reorganize untouched tasks.
2. **Clarify before acting**: If feedback could be interpreted multiple ways, ask. It's better to ask once than to undo a wrong batch edit.
3. **Atomic application**: Validate all edits before applying any. If validation fails, report errors and let the user correct.
4. **Transparency**: Always show the full list of proposed changes before applying. No surprises.

## Validation Rules

- All edit operations validated against JSON schemas before persisting
- Priority values: `critical`, `high`, `medium`, `low`
- estimatedMinutes: integer 1-480
- objectiveId must exist in the agent's monthly plans (for add operations)
- taskId must exist in the plan (for remove/update operations)

## Data Directory

Agents are stored in `.aweek/agents/<agent-id>.json` relative to the project root.
