---
name: aweek:approve-plan
description: Review and approve, reject, or edit a pending weekly plan for an agent
trigger: approve plan, review plan, approve weekly plan, reject plan, edit plan, aweek approve plan
---

# aweek:approve-plan

Review a pending weekly plan for an agent and decide whether to approve, reject, or edit it. This is the human-in-the-loop gate — the first approval activates the heartbeat system.

## Instructions

You MUST follow this exact workflow when this skill is invoked. Use the project's Node.js modules in `src/skills/approve-plan.js` — never write agent JSON files directly.

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
    const pending = data.weeklyPlans?.find(p => p.approved === false);
    agents.push({
      id: data.id,
      name: data.identity?.name,
      role: data.identity?.role,
      pendingWeek: pending?.week || null,
      pendingTasks: pending?.tasks?.length || 0,
    });
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
- If no agents have pending plans, inform the user: "No agents have pending weekly plans." and stop.
- Display a numbered list showing agent name, role, and pending week (if any).
- Ask the user to select an agent by number or name using AskUserQuestion.

### Step 2: Present the Plan for Review

Load and display the pending weekly plan using `loadPlanForReview`:

```bash
node --input-type=module -e "
import { loadPlanForReview } from './src/skills/approve-plan.js';

const result = await loadPlanForReview({ agentId: '<AGENT_ID>' });
if (!result.success) {
  console.error('ERROR:', result.errors.join(', '));
  process.exit(1);
}
console.log(result.formatted);
"
```

Display the formatted plan to the user. This includes:
- Agent identity and week/month
- All tasks with priority, estimated time, and objective traceability
- Goal -> Objective -> Task chain for full traceability

### Step 3: Ask for Decision

Ask the user using AskUserQuestion: "What would you like to do with this plan?"

Present three options:
1. **Approve** — Accept the plan as-is. Heartbeat will activate after first approval.
2. **Reject** — Remove the plan. You can regenerate or create a new one.
3. **Edit** — Modify tasks (add, remove, or update) before deciding.

### Step 4a: If Approve

Run the approval:

```bash
node --input-type=module -e "
import { processApproval, formatApprovalResult } from './src/skills/approve-plan.js';

const result = await processApproval({
  agentId: '<AGENT_ID>',
  decision: 'approve',
});

console.log(formatApprovalResult(result, 'approve'));
if (!result.success) process.exit(1);
"
```

Display the result. If this is the first approval, emphasize that the heartbeat system is now active.

### Step 4b: If Reject

Ask for an optional rejection reason using AskUserQuestion, then run:

```bash
node --input-type=module -e "
import { processApproval, formatApprovalResult } from './src/skills/approve-plan.js';

const result = await processApproval({
  agentId: '<AGENT_ID>',
  decision: 'reject',
  rejectionReason: '<REASON_OR_EMPTY>',
});

console.log(formatApprovalResult(result, 'reject'));
if (!result.success) process.exit(1);
"
```

After rejection, suggest: "You can regenerate a new weekly plan or use /aweek:adjust-goal to modify objectives first."

### Step 4c: If Edit

Collect edits interactively. Display the current task list with numbers and ask the user what changes to make.

For each edit, ask:
- **Action**: add, remove, or update
- **For add**: task description, which objective it relates to (show numbered list), optional priority and estimated minutes
- **For remove**: which task number to remove
- **For update**: which task number, then what to change (description, priority, estimatedMinutes)

Keep collecting edits until the user says "done".

After collecting all edits, ask: "Would you also like to approve the plan after these edits? (yes/no)"

Then run the edits:

```bash
node --input-type=module -e "
import { processApproval, formatApprovalResult } from './src/skills/approve-plan.js';

const result = await processApproval({
  agentId: '<AGENT_ID>',
  decision: 'edit',
  edits: <EDITS_JSON_ARRAY>,
  autoApproveAfterEdit: <true_or_false>,
});

console.log(formatApprovalResult(result, 'edit'));
if (!result.success) process.exit(1);
"
```

Each edit object must match one of these shapes:
- **Add**: `{ "action": "add", "description": "...", "objectiveId": "obj-xxx", "priority": "medium", "estimatedMinutes": 60 }`
- **Remove**: `{ "action": "remove", "taskId": "task-xxx" }`
- **Update**: `{ "action": "update", "taskId": "task-xxx", "description": "...", "priority": "...", "estimatedMinutes": 60 }`

If edits were applied without auto-approve, ask: "Would you like to approve the plan now? (yes/no)"
- If yes, run Step 4a (approve)
- If no, inform the user the plan is still pending

### Step 5: Display Final Status

Show the formatted result. Highlight key outcomes:
- Whether the plan was approved, rejected, or edited
- Whether the heartbeat was activated (first approval)
- Number of tasks in the final plan
- Next steps (e.g., "Agent will start executing on next heartbeat")

## Validation Rules

- Agent must exist in `.aweek/agents/`
- Agent must have a pending (unapproved) weekly plan
- Decision must be: `approve`, `reject`, or `edit`
- Edit operations:
  - `add` requires description (non-empty) and objectiveId (must exist in monthly plans)
  - `remove` requires taskId (must exist in the plan)
  - `update` requires taskId (must exist) and at least one field: description, priority, or estimatedMinutes
  - Priority values: `critical`, `high`, `medium`, `low`
  - estimatedMinutes: integer 1-480

## Error Handling

- If the agent is not found, suggest using `/aweek:create-agent`
- If no pending plan exists, suggest generating one
- If edit validation fails, show specific errors and allow correction
- All changes are validated against JSON schemas before persisting
- Atomic: if any edit in a batch fails validation, none are applied

## Plan Traceability

The review display shows the full traceability chain:
- Weekly tasks -> Monthly objectives -> Long-term goals
- This helps the user verify that tasks align with the agent's goals

## Heartbeat Activation

The first weekly plan approval for any agent activates the heartbeat system. This is clearly communicated to the user. Subsequent approvals do not re-trigger activation messaging.

## Data Directory

Agents are stored in `.aweek/agents/<agent-id>.json` relative to the project root.
