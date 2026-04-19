---
name: calendar
description: Display an agent's weekly plan as an interactive calendar grid with day columns and hour rows
trigger: aweek calendar, weekly calendar, plan calendar, show calendar, agent calendar
---

# aweek:calendar

Display an agent's weekly plan as an interactive calendar grid with day columns and hour rows. Tasks are numbered for selection.

## Instructions

You MUST follow this exact workflow when this skill is invoked.

### Step 1: Select an Agent

List all available agents:

```bash
aweek exec calendar listAgentsForCalendar
```

The call returns a JSON array of `{ id, name, role }` records. Treat an
empty array as the no-agents case.

- If no agents exist, inform the user: "No agents found. Use /aweek:hire to create one first." and stop.
- If only one agent exists, auto-select it.
- If multiple agents exist, ask the user to pick one using AskUserQuestion.

### Step 2: Render the Calendar Grid

Run the grid renderer to get the calendar text and task index:

```bash
echo '{
  "agentId": "<AGENT_ID>",
  "opts": {
    "startHour": 9,
    "endHour": 18,
    "cellWidth": 24,
    "showWeekend": false,
    "spread": "spread"
  }
}' | aweek exec calendar loadAndRenderGrid --input-json -
```

The response JSON contains `success`, `output` (the rendered grid text),
`taskIndex` (the task list for interactive selection), and `errors` when
`success === false`.

**IMPORTANT — Not collapsed display:** After running the command, you MUST
output the calendar grid text as direct text in your response (inside a
markdown code block). Do NOT just show the bash output — copy `result.output`
and display it yourself so it appears expanded, not collapsed inside a bash
result.

Also parse `result.taskIndex` to get the task list for interactive selection.

### Step 3: Interactive Navigation

After displaying the calendar, use AskUserQuestion to offer interaction. Combine task selection and navigation into a **single question** so users can type a task number directly:

Present options in this exact order:
1. **Select a task** — "Type a task number (1-N) to see details" — This MUST be the first option. When the user selects this, they type the task number directly in the text input field.
2. **Adjust view** — Change hours, show weekends, change cell width, toggle spread/pack
3. **Done** — Exit

The question text should say: "What would you like to do?"
When the user selects "Select a task" and types a number, parse it and show the task details. No second question needed.

#### When user selects a task number:

Display the full task details:

```
Task #3: Research keywords & outline for Blog Post 2
  ID:        task-abc12345
  Status:    pending
  Priority:  medium
  Estimated: 120 minutes (2h)
  Objective: obj-14be9eb8
```

Then ask what they'd like to do with it:
1. **Back to calendar** — Return to the grid view
2. **Change status** — Mark as in-progress, completed, failed, etc.
3. **Change priority** — Set to critical, high, medium, or low
4. **Edit description** — Update the task description

If they change a task, apply the update via the WeeklyPlanStore:

```bash
node --input-type=module -e "
import { WeeklyPlanStore } from './src/storage/weekly-plan-store.js';

const store = new WeeklyPlanStore('.aweek/agents');
const plan = await store.load('<AGENT_ID>', '<WEEK>');
const task = plan.tasks.find(t => t.id === '<TASK_ID>');

// Apply the change
<APPLY_CHANGE>

plan.updatedAt = new Date().toISOString();
await store.save('<AGENT_ID>', plan);
console.log('Updated successfully');
"
```

Then re-render and display the updated calendar.

#### When user adjusts the view:

Ask which options to change using AskUserQuestion, then re-render with the new options.

### Step 4: Loop

Keep the interaction loop going (Step 3) until the user selects "Done".

## Render Options

| Option | Default | Description |
|--------|---------|-------------|
| `startHour` | 9 | First hour row (0-23) |
| `endHour` | 18 | Last hour row exclusive (1-24) |
| `cellWidth` | 24 | Width of each day column in characters |
| `showWeekend` | false | Include Saturday and Sunday columns |
| `spread` | `pack` | Distribution: `pack` (fill days) or `spread` (round-robin) |

## How It Works

- Tasks are numbered in grid order (top-to-bottom, left-to-right) for selection
- Each task occupies rows based on its `estimatedMinutes` (default: 60 min = 1 row)
- Status icons show progress: ○ pending, ► in-progress, ✓ completed, ✗ failed
- Multi-hour tasks show a continuation marker in subsequent rows
- The calendar is displayed as direct text (not bash output) so it's always visible

## Related Skills

- `/aweek:plan` — Edit weekly plans (add/remove tasks, adjust goals, approve/reject)
- `/aweek:summary` — Dashboard view across all agents
- `/aweek:hire` — Create a new agent with identity, goals, and initial plan

## Data Directory

Agents are stored in `.aweek/agents/<agent-id>.json` relative to the project root.
