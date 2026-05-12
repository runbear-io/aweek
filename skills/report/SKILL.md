---
name: report
description: Agent → CEO report. Send a status report or question to the user (CEO) on behalf of an agent. Notifies the dashboard inbox and, when a Slack `ceoChannel` is configured, pushes a Slack message.
trigger: report to ceo, agent report, ask ceo, status report, escalate to user, aweek report
---

# aweek:report

Send a CEO report on behalf of an agent. Every report:

1. Persists a notification under the sender agent's `.aweek/agents/<slug>/notifications.json`, which surfaces immediately on the dashboard's inbox.
2. If the project's `.aweek/channels/slack/config.json` (or env) provides BOTH a `botToken` AND a `ceoChannel`, posts a formatted Slack message to that channel/DM via `chat.postMessage`.

The skill is the canonical surface agents call autonomously during a heartbeat session (`aweek exec report send …`) AND the user-facing slash command for manually composing or testing a report. Use `aweek:notify` directly only when you need the generic notification surface without the report/question framing.

## When the agent uses this autonomously

During a heartbeat session an agent decides "I should tell the CEO about this" or "I'm blocked and need a decision" — it shells out to:

```bash
echo '{
  "senderSlug": "<AGENT_SLUG>",
  "kind": "report",
  "title": "<SHORT_TITLE>",
  "body": "<DETAILED_BODY>",
  "severity": "info"
}' | aweek exec report send --input-json -
```

Replace `kind` with `"question"` when the agent needs a decision (rather than a status update). Replace `severity` with `"warning"` (action recommended) or `"error"` (blocked / urgent).

You do not invoke this on the agent's behalf — agents call it themselves through Bash during their heartbeat tick. The slash command below is for the USER to manually compose a report (testing, manual escalation, or surfacing context the agent can't articulate yet).

## Slash-command workflow (user-facing)

You MUST follow this exact workflow when invoked. Use `aweek exec report send` — never write notification JSON files directly.

### Step 1: Pick the sender agent

List available agents so the user can choose which one the report should be attributed to:

```bash
echo '{"dataDir":".aweek/agents"}' \
  | aweek exec agent-helpers listAllAgents --input-json -
```

Project each entry to `{ id, name, role }` for display. Treat zero entries as the "create an agent first" case — direct the user to `aweek hire` and stop.

### Step 2: Confirm sender

Ask the user via `AskUserQuestion`: "Which agent is sending the report?"

- Validate the selection against the list above.

### Step 3: Pick the report kind

Ask the user via `AskUserQuestion`: "What kind of message is this?"

- `report` — status update; no decision needed.
- `question` — agent is blocked / needs a decision from the CEO.

### Step 4: Collect content

1. **Title** (required, ≤ 200 chars): `AskUserQuestion`: "Title for the report (≤ 200 chars):"
2. **Body** (required, ≤ 5000 chars): `AskUserQuestion`: "Body (≤ 5000 chars). Be specific — this is what the CEO reads:"
3. **Severity** (optional): `AskUserQuestion`: "Severity? (`info` / `warning` / `error` — default `info`)"
4. **Source task** (optional): `AskUserQuestion`: "Link this report to a weekly-task ID? (press Enter to skip)"

### Step 5: Confirm and send

Display a summary in the conversation (do not rely on Bash output rendering — re-emit as direct assistant text):

```
--- Report Summary ---
From:       <AGENT_NAME> (<AGENT_ID>)
Kind:       <KIND>
Severity:   <SEVERITY>
Title:      <TITLE>
Body:       <BODY>
Task:       <SOURCE_TASK_ID or "none">
```

Ask via `AskUserQuestion`: "Send this report?"

If confirmed, execute:

```bash
echo '{
  "senderSlug": "<AGENT_ID>",
  "kind": "<KIND>",
  "title": "<TITLE>",
  "body": "<BODY>",
  "severity": "<SEVERITY>",
  "sourceTaskId": "<SOURCE_TASK_ID_OR_OMIT>"
}' | aweek exec report send --input-json -
```

Omit `severity` and `sourceTaskId` from the JSON when the user skipped them. JSON-escape every interpolation.

The response is the `{ notification, deliveredToSlack, persisted }` envelope. Re-emit the formatted summary as direct assistant output:

```bash
echo "$RESULT" | aweek exec report formatReportResult --input-json - --format text
```

Highlight:

- `notification.id` — for traceability in `.aweek/agents/<slug>/notifications.json` and on the dashboard inbox.
- `deliveredToSlack` — `true` when a Slack channel was wired; `false` when the project has no `ceoChannel` configured (instruct the user to set one — see below).

If the user declines, say "Report cancelled. No notification persisted, no Slack message sent." and stop.

## Configuring Slack delivery

The Slack push is opt-in per project. To enable it:

1. Run `aweek slack-init` (creates the Slack app and persists `botToken` / `appToken` into `.aweek/channels/slack/config.json`).
2. Add `ceoChannel` to the same file — a Slack channel ID (`C…`/`G…`), user ID (`U…`), or DM ID (`D…`). The bot must already be a member of channels (`C…`/`G…`); DMs (`D…`) and user IDs (`U…`) work without membership.

The file ends up like:

```json
{
  "botToken": "xoxb-…",
  "appToken": "xapp-…",
  "signingSecret": "…",
  "ceoChannel": "D01ABCXYZ"
}
```

Env-vars take precedence per the loader contract: `SLACK_CEO_CHANNEL` overrides the file's `ceoChannel`.

When `ceoChannel` is missing, the report still persists to the dashboard inbox — only the Slack push is skipped. The agent's `aweek exec report send` returns `deliveredToSlack: false` so the agent knows.

## Validation Rules

- `senderSlug` must match an existing agent in `.aweek/agents/`.
- `kind` must be `report` or `question` exactly.
- `title` non-empty, ≤ 200 chars.
- `body` non-empty, ≤ 5000 chars.
- `severity`, when present, must be `info` / `warning` / `error`.
- Slack push is fire-and-forget — a failed Slack call (e.g. `channel_not_found`) does NOT roll back the notification; the failure is logged to stderr by the dispatcher's per-call channel-error sink.
