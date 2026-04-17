---
name: aweek:delegate-task
description: Delegate a task from one agent to another via the async inbox queue
trigger: delegate task, send task, assign task, aweek delegate task, inter-agent task
---

# aweek:delegate-task

Delegate a task from one agent to another. The task is placed in the recipient's async inbox queue and will be picked up on the next heartbeat. This enables inter-agent collaboration without synchronous cross-agent sessions.

## Instructions

You MUST follow this exact workflow when this skill is invoked. Use the project's Node.js modules in `src/skills/delegate-task.js` — never write inbox JSON files directly.

### Step 1: List Available Agents

List all available agents so the user can choose sender and recipient:

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
    agents.push({
      id: data.id,
      name: data.identity?.name,
      role: data.identity?.role,
    });
  }
  if (agents.length < 2) {
    console.log('NEED_MORE_AGENTS');
  } else {
    console.log(JSON.stringify(agents, null, 2));
  }
} catch (e) {
  console.log('NEED_MORE_AGENTS');
}
"
```

- If fewer than 2 agents exist, inform the user: "At least 2 agents are needed for delegation. Use /aweek:create-agent to create more." and stop.
- Display a numbered list showing agent name, role, and ID.

### Step 2: Select Sender Agent

Ask the user using AskUserQuestion: "Which agent is delegating the task? (select by number or name)"

- Validate the selection matches an existing agent.

### Step 3: Select Recipient Agent

Ask the user using AskUserQuestion: "Which agent should receive the task? (select by number or name)"

- Validate the selection matches an existing agent.
- The recipient MUST be different from the sender — an agent cannot delegate to itself.

### Step 4: Collect Task Details

Ask the user for the task details:

1. **Task Description** (required): Ask using AskUserQuestion: "Describe the task to delegate (max 2000 characters):"
   - Must be a non-empty string, max 2000 characters.

2. **Priority** (optional): Ask using AskUserQuestion: "Priority level? (critical / high / medium / low) — default: medium"
   - Valid values: `critical`, `high`, `medium`, `low`
   - Default: `medium` if the user skips or enters empty.

3. **Context** (optional): Ask using AskUserQuestion: "Any additional context for the recipient? (press Enter to skip)"
   - Free text providing background information for the recipient agent.

4. **Source Task ID** (optional): Ask using AskUserQuestion: "Source task ID for traceability? (press Enter to skip)"
   - If the delegation originates from a specific weekly task, link it here.

### Step 5: Confirm and Delegate

Display a summary of the delegation before executing:

```
--- Delegation Summary ---
From:        <SENDER_NAME> (<SENDER_ID>)
To:          <RECIPIENT_NAME> (<RECIPIENT_ID>)
Task:        <TASK_DESCRIPTION>
Priority:    <PRIORITY>
Context:     <CONTEXT or "none">
Source Task:  <SOURCE_TASK_ID or "none">
```

Ask using AskUserQuestion: "Proceed with this delegation? (yes/no)"

If the user confirms, execute:

```bash
node --input-type=module -e "
import { delegateTask, formatDelegationResult } from './src/skills/delegate-task.js';

const result = await delegateTask({
  fromAgentId: '<FROM_AGENT_ID>',
  toAgentId: '<TO_AGENT_ID>',
  taskDescription: '<TASK_DESCRIPTION>',
  options: {
    priority: '<PRIORITY>',
    context: '<CONTEXT_OR_UNDEFINED>',
    sourceTaskId: '<SOURCE_TASK_ID_OR_UNDEFINED>',
  },
});

console.log(formatDelegationResult(result));
console.log('---');
console.log('MESSAGE_ID:' + result.id);
"
```

Replace placeholders with actual values, properly JSON-escaped. Omit `context` and `sourceTaskId` from the options object if the user skipped them.

If the user declines, inform them: "Delegation cancelled. No changes were made."

### Step 6: Display Result

Show the formatted delegation result. Highlight:
- The message ID for traceability
- That the task is now in the recipient's inbox queue
- The task will be picked up on the recipient's next heartbeat
- The sender can check inbox status via the agent's inbox file

## Validation Rules

- Both sender and recipient agents must exist in `.aweek/agents/`
- Sender and recipient must be different agents (no self-delegation)
- Task description: non-empty string, max 2000 characters
- Priority: one of `critical`, `high`, `medium`, `low` (default: `medium`)
- Context: optional free-text string
- Source task ID: optional string for traceability back to weekly plan tasks
- All messages validated against the inbox message JSON schema before persistence

## Error Handling

- If an agent is not found, suggest using `/aweek:create-agent`
- If fewer than 2 agents exist, stop early with guidance
- If self-delegation is attempted, explain the restriction and re-ask for recipient
- If task description is empty or too long, explain and re-ask
- If priority is invalid, show valid options and re-ask
- Schema validation errors are shown with specifics and allow correction

## Idempotency

Each delegation creates a unique message with a generated ID. Re-enqueuing the exact same message object (by ID) is a no-op — the inbox store deduplicates by message ID. This ensures heartbeat retries never produce duplicate inbox entries.

## Inter-Agent Communication Model

- Communication is **asynchronous** — the sender does not wait for completion
- Messages land in the recipient's **inbox queue** (`.aweek/agents/<agent-id>.inbox.json`)
- The recipient processes inbox messages on their **next heartbeat tick**
- Messages have a `status` field: `pending` -> `in-progress` -> `completed` / `failed`
- Full traceability: each message has `from`, `to`, `sourceTaskId`, and timestamps

## Data Directory

Agents are stored in `.aweek/agents/<agent-id>.json` relative to the project root.
Inbox queues are stored in `.aweek/agents/<agent-id>.inbox.json` relative to the project root.
