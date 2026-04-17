---
name: aweek:resume-agent
description: Resume a budget-paused agent by clearing the pause flag or topping up its token budget
trigger: aweek resume, resume agent, unpause agent, unblock agent, agent paused, budget override
---

# aweek:resume-agent

Resume an agent that has been paused due to budget exhaustion. Supports simple resume (clear pause flag) or top-up (reset usage to zero with optional new budget limit).

## Instructions

You MUST follow this exact workflow when this skill is invoked. Use the project's Node.js modules in `src/skills/resume-agent.js` — never modify agent files directly.

### Step 1: List Paused Agents

Run the following to discover which agents are paused:

```bash
node --input-type=module -e "
import { listPausedAgents, formatPausedAgentsList } from './src/skills/resume-agent.js';

const result = await listPausedAgents({ dataDir: 'data/agents' });
console.log(formatPausedAgentsList(result));
"
```

If no agents are paused, inform the user and stop. Otherwise, present the list and ask which agent they want to resume.

### Step 2: Show Budget Details

Once the user selects an agent, show detailed budget status:

```bash
node --input-type=module -e "
import { getPausedAgentDetails, formatPausedAgentDetails } from './src/skills/resume-agent.js';

const details = await getPausedAgentDetails('AGENT_ID', { dataDir: 'data/agents' });
console.log(formatPausedAgentDetails(details));
"
```

Replace `AGENT_ID` with the selected agent's ID.

Present the three available actions to the user:
1. **resume** — Clear the pause flag. The agent resumes but may re-pause on the next budget check if usage still exceeds the limit.
2. **top-up** — Reset token usage to zero and optionally set a new weekly budget limit. The agent starts fresh.
3. **cancel** — Do nothing, keep the agent paused.

### Step 3: Collect User Decision

Ask the user which action they want (resume, top-up, or cancel).

If they choose **top-up**, ask if they want to set a new weekly token budget limit:
- If yes, collect the new limit (must be a positive number)
- If no, keep the current limit

If they choose **cancel**, confirm and stop.

### Step 4: Execute Resume

Run the chosen action:

**For resume:**
```bash
node --input-type=module -e "
import { executeResume, formatResumeResult } from './src/skills/resume-agent.js';

const result = await executeResume('AGENT_ID', 'resume', { dataDir: 'data/agents' });
console.log(formatResumeResult(result));
"
```

**For top-up (without new limit):**
```bash
node --input-type=module -e "
import { executeResume, formatResumeResult } from './src/skills/resume-agent.js';

const result = await executeResume('AGENT_ID', 'top-up', { dataDir: 'data/agents' });
console.log(formatResumeResult(result));
"
```

**For top-up (with new limit):**
```bash
node --input-type=module -e "
import { executeResume, formatResumeResult } from './src/skills/resume-agent.js';

const result = await executeResume('AGENT_ID', 'top-up', { dataDir: 'data/agents', newLimit: NEW_LIMIT });
console.log(formatResumeResult(result));
"
```

Replace `AGENT_ID` and `NEW_LIMIT` with actual values.

### Step 5: Confirm Result

Display the formatted result to the user. Mention that the agent will execute tasks on its next heartbeat tick.

Suggest running `/aweek:status` to verify the agent's state changed from `[PAUSED]` to `[ACTIVE]` or `[IDLE]`.

## Actions Explained

| Action | Effect | When to use |
|--------|--------|-------------|
| `resume` | Clears `budget.paused` flag only | Quick unblock — the agent may re-pause if the budget is still exceeded on the next enforcement check |
| `top-up` | Resets `currentUsage` to 0, optionally sets new budget limit, clears pause | Full budget reset — the agent gets a fresh budget for the rest of the week |
| `cancel` | No changes | User decides not to resume |

## Idempotency

- Resuming an already-active agent is a safe no-op
- Topping up an already-active agent resets usage to 0 (safe but unnecessary)
- Repeated calls produce the same end state

## Example Session

```
User: /aweek:resume-agent

=== Paused Agents ===
Total agents: 3 (1 paused, 2 active)

1. [PAUSED] Alice (developer)
   ID: agent-alice-a1b2c3d4
   Budget: 120,000 / 100,000 tokens

Which agent would you like to resume?

User: Alice

=== Budget Details: Alice (developer) ===
Agent ID: agent-alice-a1b2c3d4
Status: PAUSED

Weekly token limit: 100,000
Current usage: 120,000 tokens
Exceeded by: 20,000 tokens

Alert: Agent "agent-alice-a1b2c3d4" has exhausted its weekly token budget.
Alert time: 2026-04-15T10:00:00.000Z

Available actions:
  1. resume   — Clear pause flag (agent may re-pause on next budget check if still over limit)
  2. top-up   — Reset usage to 0 and optionally set a new budget limit
  3. cancel   — Do nothing

User: top-up with 200000

=== Resume Result ===
Agent "agent-alice-a1b2c3d4" has been topped up and resumed. Previous usage: 120,000 tokens (reset to 0). Budget limit changed: 100,000 → 200,000 tokens/week.

The agent will execute tasks on its next heartbeat tick.
```
