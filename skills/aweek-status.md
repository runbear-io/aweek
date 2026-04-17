---
name: aweek:status
description: View a summary of all agent statuses including tasks, budget, inbox, and activity
trigger: aweek status, agent status, show agents, list agents, agent summary
---

# aweek:status

Display a comprehensive status summary for all aweek agents. Shows each agent's current state, weekly plan progress, token budget utilization, inbox queue, and activity log.

## Instructions

You MUST follow this exact workflow when this skill is invoked. Use the project's Node.js modules in `src/skills/status.js` — never read agent files directly.

### Step 1: Gather Agent Statuses

Run the following to collect status data from all agents:

```bash
node --input-type=module -e "
import { gatherAllAgentStatuses, formatStatusReport } from './src/skills/status.js';

const result = await gatherAllAgentStatuses({
  dataDir: '.aweek/agents',
});

console.log(formatStatusReport(result));
"
```

### Step 2: Display Results

Present the formatted output directly to the user. The report includes:

- **Header**: Current week, Monday date, total agent count
- **Overview**: Counts of agents by state (running, active, paused, idle)
- **Total tokens**: Aggregate token usage across all agents this week
- **Per-agent details**:
  - State indicator: `[RUNNING]`, `[ACTIVE]`, `[PAUSED]`, or `[IDLE]`
  - Weekly plan status: task counts by status (completed, pending, in-progress, failed)
  - Budget: token usage vs limit with utilization percentage
  - Activity: log entry count for the week
  - Inbox: pending/accepted message counts
  - Lock: whether a session is currently running

### Agent States

| State | Meaning |
|-------|---------|
| `[RUNNING]` | Agent has an active lock — a CLI session is currently executing |
| `[ACTIVE]` | Agent has an approved plan with pending or in-progress tasks |
| `[PAUSED]` | Agent's budget is exhausted — paused until budget reset |
| `[IDLE]` | Agent has no pending work or no approved plan |

### No Agents

If no agents exist, the output will suggest using `/aweek:create-agent` to create one.

## Data Sources

All data is read from the file-based stores — files are the source of truth:

| Source | Path Pattern |
|--------|-------------|
| Agent config | `.aweek/agents/<agent-id>.json` |
| Weekly plans | `.aweek/agents/<agent-id>/weekly-plans/<week>.json` |
| Activity logs | `.aweek/agents/<agent-id>/logs/<monday>.json` |
| Token usage | `.aweek/agents/<agent-id>/usage/<monday>.json` |
| Inbox queue | `.aweek/agents/<agent-id>/inbox.json` |
| Lock files | `.aweek/.locks/<agent-id>.lock` |

## Example Output

```
=== aweek Agent Status ===
Week: 2026-W16 (Monday: 2026-04-13)
Agents: 2

Overview: 1 active, 1 idle
Total tokens this week: 40,000

---

[ACTIVE] Alice (developer)
  ID: agent-alice-a1b2c3d4
  Plan: 2026-W16 (approved) — 5 tasks: 2 completed, 2 pending, 1 in-progress
  Budget: 25,000 / 100,000 tokens (25%)
  Activity: 3 log entries this week
  Inbox: 1 messages (1 pending)

[IDLE] Bob (reviewer)
  ID: agent-bob-e5f6g7h8
  Plan: 2026-W16 (approved) — 3 tasks: 3 completed
  Budget: 15,000 / 100,000 tokens (15%)
  Activity: 3 log entries this week
```
