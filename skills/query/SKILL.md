---
name: query
description: Filter the aweek agent roster by role, status, persona keyword, or budget and return a slug list that other skills can act on
trigger: aweek query, aweek find, aweek filter, aweek select agents, aweek list by, which agents, find agents, find marketers, find engineers, find writers, find researchers, active marketers, paused agents, missing subagents, over budget agents, show agents with
---

# aweek:query

Slug-returning filter over the aweek agent roster. Use this skill any time a
request names a *subset* of agents rather than a single one — e.g. "the active
marketers", "every paused researcher", "agents whose persona mentions X.com".
Reads identity (name, description, system prompt) live from
`.claude/agents/<slug>.md`, and lifecycle state from the existing stores; never
mutates anything.

Downstream skills (`/aweek:plan`, `/aweek:manage`, future `/aweek:bulk-plan`)
are expected to consume the `agents[].id` list from this skill's JSON result
instead of hand-rolling `grep` over `.claude/agents/*.md`.

## Filters

All filters are optional. Omitting every one returns the full roster.

| Filter | Semantics |
|--------|-----------|
| `role` | Case-insensitive substring match against the subagent `.md` **description**. "marketer" → matches "Content marketer", "Senior Brand Marketer", etc. |
| `keyword` | Case-insensitive substring search across **name + description + system-prompt body**. Use this when the distinguishing trait isn't in the one-line description — e.g. `keyword: "x.com"` to find every persona that publishes to X.com. Result carries `matchedOn` so the skill can show *where* it hit. |
| `status` | One (or comma-separated many) of `active`, `paused`, `idle`, `running`, `missing-subagent`. Matches the lifecycle states used by `/aweek:summary`, plus the synthetic `missing-subagent` for orphaned aweek JSON. |
| `budget` | `no-limit` (weekly limit is 0), `under` (utilization < 100%), or `over` (utilization ≥ 100%). |

### Notes on interaction

- `role` and `keyword` require a readable `.md` file. Rows whose `.md` is
  missing drop out of those filters automatically; use `status=missing-subagent`
  (without role/keyword) to find orphans.
- `status=active` means "has an approved plan with pending/in-progress work".
  Paused agents never match `status=active`.
- Filters combine with AND. "Active marketers" = `role=marketer status=active`.

## Instructions

Follow this exact workflow when invoked. This skill is **read-only** — never
ask a destructive confirmation gate; there is nothing to confirm.

### Step 1: Collect the filters

Parse the user's intent into the four optional inputs above. When the request
is ambiguous, prefer asking ONE `AskUserQuestion` that presents the most
likely interpretations as choices rather than playing 20 questions. Examples:

| User said | Inferred filters |
|-----------|------------------|
| "active marketers" | `role: "marketer", status: "active"` |
| "paused researchers" | `role: "researcher", status: "paused"` |
| "which agents publish to X.com" | `keyword: "x.com"` |
| "over-budget agents" | `budget: "over"` |
| "agents with no subagent file" | `status: "missing-subagent"` |
| "all agents" / no qualifier | (no filters) |

If the user names a role like "marketer", **do not** also set it as the keyword
— role already searches the description, and adding keyword on top would
silently exclude any agent whose persona doesn't repeat the word in the
system-prompt body.

### Step 2: Run the query

```bash
echo '{
  "dataDir": ".aweek/agents",
  "role": "marketer",
  "status": "active"
}' | aweek exec query queryAgents --input-json -
```

All four filter keys (`role`, `keyword`, `status`, `budget`) are optional. The
`dataDir` is the only required field. `status` also accepts an array:
`"status": ["active", "paused"]`.

The response is:

```json
{
  "total": 7,
  "matched": 3,
  "filters": { "role": "marketer", "keyword": null, "status": ["active"], "budget": null },
  "week": "2026-W17",
  "weekMonday": "2026-04-20",
  "agents": [
    {
      "id": "sam",
      "name": "Sam",
      "description": "Content marketer",
      "state": "active",
      "paused": false,
      "missing": false,
      "matchedOn": ["description"],
      "weeklyPlan": { "week": "2026-W17", "approved": true, "tasks": { ... } },
      "budget": { "weeklyTokenLimit": 100000, "utilizationPct": 25 }
    }
  ]
}
```

### Step 3: Render the result

Pipe the JSON through `formatQueryResult` and echo the output verbatim — the
rendered table is intentionally compact:

```bash
echo "$RESULT" | aweek exec query formatQueryResult --input-json -
```

The rendered output looks like:

```
=== aweek Query ===
Week: 2026-W17 (Monday: 2026-04-20)
Filters: role~"marketer"  status=active
Matched: 2 / 7 agent(s)

| Agent | Role             | Status | Tasks | Matched on  |
|-------|------------------|--------|-------|-------------|
| sam   | Content marketer | ACTIVE | 2/5   | description |
| ivy   | Growth marketer  | ACTIVE | —     | description |

Slugs:
  - sam
  - ivy
```

### Step 4: Offer a follow-up action (optional)

When `matched > 0`, ask via `AskUserQuestion` whether the user wants to act on
the result:

1. **Done** — stop here.
2. **Drill into one agent** — route into `/aweek:summary`'s drill-down, or run
   the per-agent report via `aweek exec summary buildAgentDrillDown`.
3. **Operate on all matched** — hand the slug list to `/aweek:plan`,
   `/aweek:manage`, or `/aweek:delegate-task`. Today this means invoking the
   target skill once per slug and telling the user that bulk operation is
   still one-at-a-time. A future `/aweek:bulk-plan` will consume this list
   directly.

Use `buildQueryChoices` when you need a ready-made `AskUserQuestion` list:

```bash
echo "$RESULT" | aweek exec query buildQueryChoices --input-json -
```

Each entry is `{ id, name, label }` with a trailing `{ id: null, label: "No thanks — done" }` sentinel so the choice list is homogeneous.

## Example sessions

### "Active marketers"

```
User: /aweek:query active marketers

=== aweek Query ===
Week: 2026-W17 (Monday: 2026-04-20)
Filters: role~"marketer"  status=active
Matched: 2 / 7 agent(s)

| Agent | Role             | Status | Tasks | Matched on  |
|-------|------------------|--------|-------|-------------|
| sam   | Content marketer | ACTIVE | 2/5   | description |
| ivy   | Growth marketer  | ACTIVE | —     | description |

Slugs:
  - sam
  - ivy

Follow-up? [Done / Drill into one / Run /aweek:plan on all]
```

### "Which agents mention X.com"

```
User: /aweek:query which agents publish to x.com?

=== aweek Query ===
Filters: keyword~"x.com"
Matched: 1 / 7 agent(s)

| Agent | Role             | Status | Tasks | Matched on   |
|-------|------------------|--------|-------|--------------|
| sam   | Content marketer | ACTIVE | 2/5   | systemPrompt |
```

### Missing subagents

```
User: /aweek:query agents with no subagent file

=== aweek Query ===
Filters: status=missing-subagent
Matched: 1 / 7 agent(s)

| Agent                      | Role | Status  | Tasks | Matched on |
|----------------------------|------|---------|-------|------------|
| ghost [subagent missing]   | —    | MISSING | —     | —          |
```

## Data sources

- Identity (`name`, `description`, system-prompt `body`) — read live from
  `.claude/agents/<slug>.md` via `readSubagentIdentity`.
- Lifecycle state, weekly plan, budget — `gatherAllAgentStatuses` from
  `src/skills/status.js` (same source `/aweek:summary` uses).
- No writes. Nothing in this skill mutates state.

## Related skills

- `/aweek:summary` — full roster dashboard without filters.
- `/aweek:plan` — per-agent plan adjustments. Feed it a slug from the query.
- `/aweek:manage` — per-agent lifecycle ops (pause / resume / top-up / delete).
