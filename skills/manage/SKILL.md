---
name: manage
description: Manage an agent's lifecycle — resume paused agents, pause/stop agents, edit identity, or delete/archive agents
trigger: aweek manage, manage agent, pause agent, stop agent, resume agent, unpause agent, agent paused, budget override, edit agent, rename agent, delete agent, archive agent
---

# aweek:manage

Manage the lifecycle of an existing aweek agent. This skill is the consolidated replacement for `/aweek:resume-agent` — it covers every post-hire lifecycle operation through a single interactive entry point:

1. **Resume** a budget-paused agent (clear the `budget.paused` flag)
2. **Top-up** a paused agent (reset weekly usage to 0, optionally change the budget limit) — destructive
3. **Pause / stop** an active agent (set `budget.paused` so the heartbeat skips it)
4. **Delete / archive** — permanently remove the agent config file — destructive

Identity fields (`name`, `description`, system prompt) live in
`.claude/agents/<slug>.md` and are edited directly on that file — aweek
does not own them.

The skill is a thin UX wrapper on top of `src/skills/manage.js`, which re-exports the canonical resume pipeline from `src/skills/resume-agent.js` and adds pause/delete operations. Do **not** edit agent JSON files directly — always go through the Node modules so schema validation and `updatedAt` timestamps stay correct.

## Destructive operation policy

Per project policy, every destructive lifecycle operation requires **explicit user confirmation** *before* the change is written to disk. The confirmation gate lives inside the `src/skills/manage.js` adapter, but the skill must still present a clear preview and collect an AskUserQuestion confirmation before setting `confirmed: true`.

| Operation | Destructive | Confirmation required |
|-----------|-------------|-----------------------|
| `resume` | No | No |
| `top-up` | Yes (usage counter reset, optional limit change) | Yes |
| `pause` | No (reversible) | No |
| `delete` | Yes (file removed from disk, irreversible) | Yes |

Never pass `confirmed: true` without collecting explicit confirmation via AskUserQuestion.

## Instructions

You MUST follow this exact workflow when this skill is invoked. Use the Node.js modules in `src/skills/manage.js` for every read and write.

### Step 1: Pick a lifecycle action

Ask the user which lifecycle operation they want to perform using AskUserQuestion. Offer the options:

- `resume` — Unpause a budget-paused agent
- `top-up` — Reset usage / adjust budget for a paused agent (destructive)
- `pause` — Pause an active agent so it stops running on the heartbeat
- `delete` — Permanently delete an agent (destructive)
- `cancel` — Exit without changing anything

Identity fields live in `.claude/agents/<slug>.md` — edit that file
directly to rename or re-prompt the agent.

If they choose `cancel`, stop here.

### Step 2: Pick the target agent

Run the agent-chooser to present the current roster:

```bash
echo '{"dataDir":".aweek/agents"}' \
  | aweek exec agent-helpers getAgentChoices --input-json -
```

For the `resume` and `top-up` branches, prefer the paused-only list:

```bash
RESULT=$(echo '{"dataDir":".aweek/agents"}' \
  | aweek exec manage listPausedAgents --input-json -)

echo "$RESULT" | aweek exec manage formatPausedAgentsList \
  --input-json - --format text
```

Present the list to the user and ask which agent to act on via AskUserQuestion. Pass the selected `id` forward.

### Step 3: Branch on the chosen action

#### 3a. `resume`

Show budget details:

```bash
DETAILS=$(echo '{"agentId":"AGENT_ID","dataDir":".aweek/agents"}' \
  | aweek exec manage getPausedAgentDetails --input-json -)

echo "$DETAILS" | aweek exec manage formatPausedAgentDetails \
  --input-json - --format text
```

Then run resume (no confirmation needed — non-destructive):

```bash
RESULT=$(echo '{"agentId":"AGENT_ID","dataDir":".aweek/agents"}' \
  | aweek exec manage resume --input-json -)

echo "$RESULT" | aweek exec manage formatActionResult \
  --input-json - --format text
```

#### 3b. `top-up` (destructive)

Show budget details as in 3a, then ask the user whether to set a new weekly token budget limit. Once the plan is clear, **explicitly confirm** the destructive action via AskUserQuestion. Only after a yes answer, run:

```bash
# Without new limit
RESULT=$(echo '{
  "agentId": "AGENT_ID",
  "dataDir": ".aweek/agents",
  "confirmed": true
}' | aweek exec manage topUp --input-json -)

echo "$RESULT" | aweek exec manage formatActionResult \
  --input-json - --format text
```

```bash
# With new limit
RESULT=$(echo '{
  "agentId": "AGENT_ID",
  "dataDir": ".aweek/agents",
  "confirmed": true,
  "newLimit": NEW_LIMIT
}' | aweek exec manage topUp --input-json -)

echo "$RESULT" | aweek exec manage formatActionResult \
  --input-json - --format text
```

If the user declines the confirmation, report that no changes were made and stop.

#### 3c. `pause`

Pause runs immediately — no confirmation needed (reversible via `resume`). Run:

```bash
RESULT=$(echo '{"agentId":"AGENT_ID","dataDir":".aweek/agents"}' \
  | aweek exec manage pause --input-json -)

echo "$RESULT" | aweek exec manage formatPauseResult \
  --input-json - --format text
```

If the agent was already paused the output will say so — idempotent.

#### 3d. `delete` (destructive)

First, show the user exactly what will be deleted using a summary of the agent's current state:

```bash
echo '{"agentId":"AGENT_ID","dataDir":".aweek/agents"}' \
  | aweek exec agent-helpers loadAgent --input-json -
```

Project the response to `{ id, identity.name, identity.role, goals.length }`
for display. Weekly plan counts are surfaced via `manage.deleteAgent`'s
`snapshot.weeklyPlanCount` field — compute them by listing the per-agent
`weekly-plans/` directory directly if you need them before delete.

Then ask the user to **explicitly confirm** via AskUserQuestion (phrase it as "This will permanently delete agent X. This cannot be undone. Proceed?"). If they decline, report that no changes were made and stop.

After (and only after) a yes answer to the main confirmation, ask a second AskUserQuestion:

> "Also delete `.claude/agents/NAME.md`? (the subagent identity file — defaults to keep)"
>
> Options:
> 1. **Keep** `.claude/agents/NAME.md` (default, recommended)
> 2. Delete `.claude/agents/NAME.md` too

Replace `NAME` with the target agent id (which equals the subagent slug). The aweek agent JSON owns scheduling state only — the subagent `.md` file is the identity source of truth and may be shared with other tooling, so the safe default is to keep it. Only set `deleteSubagentMd: true` when the user explicitly picks "Delete" in this second question.

Only delete project-level subagent files. Never touch `~/.claude/agents/`.

Then run:

```bash
# Default — keep the .md file (deleteSubagentMd defaults to false)
RESULT=$(echo '{
  "agentId": "AGENT_ID",
  "dataDir": ".aweek/agents",
  "confirmed": true
}' | aweek exec manage deleteAgent --input-json -)

echo "$RESULT" | aweek exec manage formatDeleteResult \
  --input-json - --format text
```

```bash
# When the user also chose to delete the subagent .md file
RESULT=$(echo '{
  "agentId": "AGENT_ID",
  "dataDir": ".aweek/agents",
  "confirmed": true,
  "deleteSubagentMd": true
}' | aweek exec manage deleteAgent --input-json -)

echo "$RESULT" | aweek exec manage formatDeleteResult \
  --input-json - --format text
```

If the user declines the main confirmation, report that no changes were made and stop.

### Step 4: Confirm Result

Display the formatted result to the user. For state-changing actions, suggest `/aweek:summary` to verify the new state.

## Actions Explained

| Action | Effect | Destructive | Reversible |
|--------|--------|-------------|------------|
| `resume` | Clears `budget.paused` flag | No | Yes (re-pauses on next check if still over budget) |
| `top-up` | Resets `currentUsage` to 0, optionally sets new budget limit, clears pause | Yes | No (previous usage / limit lost) |
| `pause` | Sets `budget.paused = true` | No | Yes (via `resume`) |
| `delete` | Removes the agent config file from `.aweek/agents/` | Yes | No |

## Idempotency

- Resuming an already-active agent is a safe no-op
- Pausing an already-paused agent is a safe no-op
- Topping up an already-active agent resets usage to 0 (safe but unnecessary)
- Deleting a non-existent agent surfaces a descriptive "Agent not found" error

## Example Session — Delete

```
User: /aweek:manage
... → delete → pick agent "ContentWriter"

About to delete:
{
  "id": "contentwriter",
  "name": "ContentWriter",
  "role": "writes articles",
  "goals": 2,
  "weeklyPlanCount": 4
}

This will permanently delete agent ContentWriter. This cannot be undone. Proceed? (yes / no)

User: yes

Also delete `.claude/agents/contentwriter.md`? (defaults to keep)
  1. Keep .claude/agents/contentwriter.md (default, recommended)
  2. Delete .claude/agents/contentwriter.md too

User: 1 (keep)

=== Agent Deleted ===
Agent "ContentWriter" (contentwriter) has been deleted.

Removed: ContentWriter — role: writes articles
Lost: 2 goal(s), 4 weekly plan(s).

Subagent file kept: .claude/agents/contentwriter.md

This action cannot be undone.
```
