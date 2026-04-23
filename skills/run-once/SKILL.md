---
name: run-once
description: Manually run an ad-hoc debugging task through an aweek agent — simulates a heartbeat tick with the agent's .env, per-agent lock, and full execution log
trigger: aweek run, aweek debug run, aweek test agent, aweek manual run, aweek run task, aweek one-off, aweek exec agent
---

# aweek:run-once

Manually dispatch an ad-hoc, one-shot task to an aweek agent. The task goes through the **exact same execution path** the hourly heartbeat uses — per-agent heartbeat lock, per-agent `.env`, `executeSessionWithTracking` with `dangerouslySkipPermissions`, and a full activity-log / execution-log entry — but the task itself is **ephemeral**: it is never written to the weekly plan and does not consume a weekly-plan slot.

Use this to debug a single agent without waiting for the next tick, or to probe an agent that is currently budget-paused (the skill deliberately force-runs through `config.paused`).

## What this skill does NOT do

- Does not add the task to the weekly plan.
- Does not pause, resume, or top-up the agent (use `/aweek:manage` for lifecycle ops).
- Does not bypass the per-agent heartbeat lock — a manual run will wait for, or skip, any in-flight tick.
- Does not skip the destructive-operation confirmation gate.

## Destructive operation policy

Running an ad-hoc task costs tokens (counted against the agent's weekly budget exactly like a scheduled tick) and can force-run through a pause. Per project policy, this requires an explicit `AskUserQuestion` confirmation before `confirmed: true` is set. Never pass `confirmed: true` without collecting the user's "yes".

## Instructions

You MUST follow this exact workflow when this skill is invoked. All persistence goes through `src/skills/run-once.js` via the dispatcher — never spawn Claude Code CLI sessions directly.

### Step 1: Pick the target agent

List all agents so the user can pick one:

```bash
echo '{"dataDir":".aweek/agents"}' \
  | aweek exec agent-helpers listAllAgents --input-json -
```

Project each entry to `{ id, name: identity?.name, paused: budget?.paused }` for display. If the roster is empty, tell the user to run `/aweek:hire` first and stop.

Ask the user via AskUserQuestion: "Which agent should run the ad-hoc task?" — pass the agent choices (including any `[paused]` marker so the user knows they're forcing through).

### Step 2: Collect the prompt (and optional title)

Combine the prompt and an optional short title into a single AskUserQuestion with input fields:

- **Prompt** (required) — the task prompt fed to the CLI session. Multiline allowed.
- **Title** (optional) — short label shown in the activity dashboard. Defaults to `Ad-hoc debug run`.

### Step 3: Confirm the destructive intent

Show a preview summary:

```
--- Ad-hoc Run ---
Agent:     <NAME> (<ID>)[ paused → will be force-run]
Title:     <TITLE or "Ad-hoc debug run">
Prompt:    <first 200 chars of PROMPT…>
Budget:    counts toward this week's budget
Lock:      waits for/shares the per-agent heartbeat lock
```

Ask via AskUserQuestion: "Dispatch this ad-hoc task now? (yes/no)"

If the user says no, reply "Ad-hoc run cancelled. No session was dispatched." and stop.

### Step 4: Dispatch

Only after an explicit yes, invoke the dispatcher:

```bash
echo '{
  "agentId": "<AGENT_ID>",
  "prompt": "<PROMPT>",
  "title": "<TITLE_OR_OMIT>",
  "confirmed": true
}' | aweek exec run-once execute --input-json -
```

Replace placeholders with JSON-escaped values. Omit `title` if the user didn't supply one so the default applies.

The call blocks until the Claude Code CLI session finishes. On a fresh aweek agent this may take seconds to several minutes.

### Step 5: Present the result

The response JSON has this shape:

```jsonc
{
  "agentId": "…",
  "task": { "id": "adhoc-XXXXXXXX", "title": "…", "prompt": "…", "status": "in-progress" },
  "execResult": { /* ExecutionResult from session-executor */ },
  "activityEntry": { /* appended activity log entry */ },
  "executionLogBasename": "adhoc-XXXXXXXX_session-YYY",
  "durationMs": 12345,
  "finalStatus": "completed" | "failed",
  "error": "…"   // only present when finalStatus === 'failed'
}
```

Show the user, as direct assistant output (NOT just bash output):

- `finalStatus` with a clear indicator (completed / failed).
- `durationMs` formatted as seconds/minutes.
- When `executionLogBasename` is non-null: a clickable dashboard link of the form
  `/executions/<agentId>/<executionLogBasename>` so the user can jump straight to the rendered summary page.
- When `finalStatus === 'failed'`: the `error` string verbatim, plus any stderr excerpt from `execResult.sessionResult.stderr`.
- Token usage from `execResult.tokenUsage` when present.

### Error handling

- `ERUN_NOT_CONFIRMED` — the confirmation gate rejected the call. Restart at Step 3.
- `ERUN_UNKNOWN_AGENT` — the provided `agentId` does not exist on disk. Restart at Step 1.
- `ERUN_LOCKED` — another heartbeat tick is holding the per-agent lock. Tell the user to wait for the tick to complete (typically seconds to a few minutes) and retry.

## Data directory

Agent state is read from `.aweek/agents/<agentId>.json`. The ad-hoc session reads the agent's `.env` from `.aweek/agents/<agentId>/.env` and appends an entry to `.aweek/agents/<agentId>/logs/<week-monday>.json`. The full NDJSON execution log is written to `.aweek/agents/<agentId>/executions/<taskId>_<sessionId>.jsonl` — the dashboard renders it at `/executions/<agentId>/<basename>`.
