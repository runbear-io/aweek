---
name: recurring
description: Manage Google-Calendar-style recurring tasks per agent — daily/weekly/biweekly/monthly rules that expand into occurrences on the calendar and execute through the heartbeat loop
trigger: aweek recurring, recurring task, recurring tasks, repeat task, repeating task, recurrence, recurrence rule, rrule, every day task, every week task, biweekly task, monthly task, aweek add recurring, aweek list recurring, aweek remove recurring, aweek delete recurring, aweek update recurring, /aweek:recurring
---

# aweek:recurring

Per-agent recurring-task management. Users define **recurrence rules**
(daily / weekly / biweekly / monthly with `INTERVAL`, `BYDAY`,
`BYMONTHDAY`, `BYSETPOS`, `COUNT`, `UNTIL`) on an agent. Each rule lives
as a `RecurringTask` document on disk at
`.aweek/agents/<slug>/recurring-tasks.json`. Occurrences themselves are
**never** persisted in the recurring-task store — they are derived from
the rule by the expander on every read:

- **Lazily** for the SPA calendar (so any ISO week — past, current, future
  — can be navigated and rendered without an on-disk
  `weekly-plans/<YYYY-Www>.json` file).
- **Eagerly** by the heartbeat materializer at tick time (so occurrences
  are merged into the existing `WeeklyPlanStore` and execute through the
  same heartbeat loop as hand-authored weekly tasks).

This skill is the **CLI surface** for the four lifecycle operations
(list / add / update / remove). All persistence and AJV validation lives
in `src/storage/recurring-task-store.ts`; this skill wraps
`src/skills/recurring.ts`, which adds friendly pre-flight validation,
auto-derives `rec-<slug>` ids, stamps `createdAt` / `updatedAt`, and
enforces the destructive-operation confirmation gate. **Never write
`recurring-tasks.json` directly** — always route through
`aweek exec recurring <fn>`.

## v1 scope

The dispatcher / validators explicitly reject v1-out-of-scope inputs so
the failure surfaces here instead of in AJV blob errors downstream:

- `freq` is restricted to `daily | weekly | monthly`. `FREQ=YEARLY` is
  rejected up-front.
- Only **one rule per RecurringTask** — no multi-RRULE composition.
- `RDATE` / `EXDATE` are not accepted on the rule. Per-occurrence
  exceptions go through the `exceptions` array (kinds: `skip` or
  `override`).
- No iCalendar import / export.

If the user asks for any of the above, point them at the v2 backlog and
do not extend the skill.

## Destructive operation policy

Per project policy, every destructive surface requires explicit
`AskUserQuestion` confirmation before `confirmed: true` is passed to the
dispatcher. The underlying validators throw
`code: ERECURRING_NOT_CONFIRMED` otherwise — do not bypass the gate.

| Operation                                  | Destructive | Confirmation required |
|--------------------------------------------|-------------|-----------------------|
| `listRecurringTasks`                       | No          | No                    |
| `addRecurringTask`                         | No (additive — never overwrites unless caller supplies an existing `id`) | No |
| `updateRecurringTask` (template / exceptions only) | No  | No                    |
| `updateRecurringTask` (**rule overlay**)   | **Yes** — rule edits affect every future occurrence | **Yes** |
| `removeRecurringTask`                      | **Yes** — drops every future occurrence | **Yes** |

The validators check the `confirmed: true` flag at the dispatcher
boundary; the SKILL.md is the first line of defense — never hardcode
`confirmed: true` ahead of the human's response.

## Instructions

You MUST follow this exact workflow when this skill is invoked. Use
`AskUserQuestion` for every interactive prompt. Each numbered step maps
to one or more dispatcher calls — never inline `node -e` snippets.

### Step 1: Select an Agent

List all agents so the user can choose which one's recurrence rules to
operate on:

```bash
echo '{"dataDir":".aweek/agents"}' \
  | aweek exec agent-helpers listAllAgents --input-json -
```

The response is an array of `{ config }` records. Project each entry to
`{ id: config.id, name: config.identity?.name, role: config.identity?.role }`
for display. If the list is empty, tell the user **"No agents found.
Use /aweek:hire to create one first."** and stop.

- If only one agent exists, auto-select it.
- If multiple agents exist, ask the user to pick one via
  `AskUserQuestion`.

Carry the chosen slug forward as `AGENT_ID`.

### Step 2: Choose an Operation

Ask via `AskUserQuestion`:

1. **List** — show every RecurringTask on this agent (read-only).
2. **Add** — append a new rule.
3. **Update** — patch an existing rule's template / rule / exceptions.
4. **Remove** — delete a rule (destructive).
5. **Done**

Route to the matching branch. After each branch finishes, loop back to
Step 2 until the user picks **Done**.

---

## Branch A: List recurring tasks

Read-only — no confirmation gate.

```bash
echo '{"agentId":"<AGENT_ID>","dataDir":".aweek/agents"}' \
  | aweek exec recurring listRecurringTasks --input-json -
```

The response shape is `{ agentId, recurringTasks: RecurringTask[] }`.
Pipe it through the formatter for a compact multi-line summary:

```bash
echo '{"result":<LIST_RESPONSE>}' \
  | aweek exec recurring formatListResult --input-json -
```

Echo the formatted string back to the user **as direct assistant
output** — Bash blocks collapse in the UI. An empty list returns
`"No recurring tasks configured for <AGENT_ID>."` and is not an error.

---

## Branch B: Add a recurring task

Collect the template + rule, preview the validated record, then call the
dispatcher. **No confirmation gate** — `add` is additive and never
overwrites unless the caller supplies an `id` matching an existing
record (idempotent re-run, mirrors `RecurringTaskStore.save()`).

### B1: Collect the template

The template is the set of task fields **every occurrence inherits**.
Collect via `AskUserQuestion`:

| Field            | Required | Notes                                                           |
|------------------|----------|-----------------------------------------------------------------|
| `title`          | **Yes**  | Short single-line label (1–80 chars).                           |
| `prompt`         | **Yes**  | Long-form instruction sent to Claude when the task fires.       |
| `objectiveId`    | Optional | Free-form tag linking back to a section heading in `plan.md`.   |
| `priority`       | Optional | `critical` / `high` / `medium` / `low` (defaults to `medium`).  |
| `estimatedMinutes` | Optional | Integer 1–480.                                                 |
| `track`          | Optional | Independent pacing lane (e.g. `"x-com"`). Falls back to `objectiveId` at selector time when omitted. |

### B2: Collect the rule

Ask via `AskUserQuestion` for the recurrence frequency first:

1. **Daily** — fires every N days.
2. **Weekly** — fires on one or more weekdays every N weeks (use `interval: 2` for biweekly).
3. **Monthly** — fires on a specific calendar day OR an nth-weekday-of-month pattern.

Then collect the remaining fields based on `freq`:

| Field      | Required               | Notes                                                                 |
|------------|------------------------|-----------------------------------------------------------------------|
| `freq`     | **Yes**                | `daily` / `weekly` / `monthly`. `yearly` is rejected (v1 out of scope). |
| `interval` | **Yes**                | Integer ≥ 1. `2` = every other / biweekly. `3` = every third.        |
| `dtStart`  | **Yes**                | Anchor instant as a UTC ISO-8601 date-time. Defines wall-clock hour/minute of every occurrence (via `timeZone` projection) AND the lower bound — no occurrence fires before `dtStart`. |
| `timeZone` | **Yes**                | IANA zone (e.g. `"America/Los_Angeles"`). DST seams handled via `localWallClockToUtc`. Default to the project's `.aweek/config.json` `timeZone`. |
| `byDay`    | Weekly: optional · Monthly + `bySetPos`: required | Array of `["MO","TU","WE","TH","FR","SA","SU"]`. Weekly: which day(s) of the week the event fires (e.g. `["MO","WE","FR"]`). Monthly + `bySetPos`: which weekday the nth-of-month rule selects. |
| `byMonthDay` | Monthly: optional    | Integer 1–31. Months with fewer days silently skip per RFC 5545.      |
| `bySetPos` | Monthly: optional      | Integer in `{-5..-1, 1..5}` (never `0`). Combined with `byDay` for "nth weekday of month" — e.g. `{byDay:["TU"], bySetPos:2}` = second Tuesday of each month. |
| `count`    | Optional (**XOR with `until`**) | Integer ≥ 1. Terminate after N occurrences. |
| `until`    | Optional (**XOR with `count`**) | UTC ISO date-time. Inclusive upper bound — no occurrence after this. |

> **RFC 5545 XOR.** `count` and `until` are **mutually exclusive** — the
> AJV `oneOf` rejects a rule that declares both. The skill validator
> surfaces a clearer error before AJV runs. A rule with neither
> terminator recurs indefinitely (open-ended).

### B3: Preview the validated record

Validate the collected payload without writing — the pre-flight surfaces
shape errors as a friendly message before AJV would:

```bash
echo '{
  "agentId": "<AGENT_ID>",
  "template": {
    "title": "<TITLE>",
    "prompt": "<PROMPT>"
    /* optional: objectiveId, priority, estimatedMinutes, track */
  },
  "rule": {
    "freq": "<FREQ>",
    "interval": <INTERVAL>,
    "dtStart": "<DTSTART_UTC_ISO>",
    "timeZone": "<IANA_ZONE>"
    /* optional: byDay, byMonthDay, bySetPos, count XOR until */
  }
}' | aweek exec recurring validateAddParams --input-json -
```

Echo the validated payload back to the user inline so they can spot
typos before the write lands. If the pre-flight throws, surface the
error message verbatim and loop back to B1 / B2.

### B4: Persist

Call the dispatcher with the same payload (no `confirmed` flag — `add`
is not destructive):

```bash
echo '{
  "agentId": "<AGENT_ID>",
  "dataDir": ".aweek/agents",
  "template": { /* … */ },
  "rule": { /* … */ }
}' | aweek exec recurring addRecurringTask --input-json -
```

The response is the persisted `RecurringTask` record — the handler
auto-derives a `rec-<slug>` id from `template.title` and stamps
`createdAt` to `now()`. Pipe back through the formatter for the
summary line:

```bash
echo '{"record":<ADD_RESPONSE>}' \
  | aweek exec recurring formatAddResult --input-json -
```

Echo the formatted summary back inline.

#### B4a: Optional — supply an explicit id

When the user wants idempotent re-runs (e.g. re-applying a rule from a
fixture file), pass `id` explicitly. The id must match the
`^rec-[a-z0-9-]+$` pattern. A second `add` with the same id **replaces**
the prior record verbatim — this is the documented re-run path.

---

## Branch C: Update a recurring task

Patch an existing record's `template`, `rule`, and/or `exceptions`. A
`rule` overlay is **destructive** (it affects every future occurrence)
and requires the confirmation gate; `template`-only or `exceptions`-only
updates do not.

### C1: Pick the record

Run Branch A first to show the user the list, then ask via
`AskUserQuestion` which `rec-<slug>` id to update.

### C2: Collect the overlay

Ask via `AskUserQuestion` which surface the user wants to edit:

1. **Template** — re-collect any subset of the template fields. Omitted
   fields keep their prior values.
2. **Rule** — re-collect any subset of the rule fields. Same overlay
   semantics. **Setting `count` clears `until`** (and vice-versa) at
   merge time so the RFC 5545 XOR stays satisfied even on a half-edit.
3. **Exceptions** — replace the exceptions array wholesale. Each entry
   needs `originalRunAt` (UTC ISO of the occurrence the expander would
   have produced) and `kind`:
   - `skip` — drops the occurrence outright.
   - `override` — replaces template fields per the overlay body. The
     overlay may also carry an optional `runAt` to **move this
     occurrence in time** (Google-Calendar "move this occurrence" UX).
   - Pass `[]` to clear all exceptions.
   - Omit the field entirely to keep existing exceptions intact.

At least one of `template`, `rule`, `exceptions` is required — the
validator throws otherwise.

### C3: Confirmation gate — required ONLY when a rule overlay is present

> **Confirmation gate (required for rule overlays).** `confirmed: true`
> MUST NOT be set on the dispatcher payload until **after** the user has
> explicitly answered `confirm` to the `AskUserQuestion` in this step.
> The dispatcher throws `ERECURRING_NOT_CONFIRMED` otherwise — but the
> markdown is the first line of defense.

Skip this step entirely when the user is only editing `template` or
`exceptions`. When a `rule` overlay is present, render a preview block
inline as direct assistant output:

```
This update will replace the recurrence rule for <rec-id>:

  Before : <describeRule(current)>
  After  : <describeRule(merged)>

Every future occurrence will use the new rule. Past occurrences that
have already materialized into weekly-plans/<YYYY-Www>.json are NOT
rewritten (the materializer is additive and idempotent by occurrence id).
```

Then collect the confirmation:

```
AskUserQuestion:
  "Apply this rule change to <rec-id>? This affects every future
   occurrence."
  options:
    - value: confirm
      label: "Yes — update the rule"
      description: "Patch the recurrence rule. Future occurrences fire on the new schedule."
    - value: cancel
      label: "Cancel"
      description: "Discard the overlay. No disk writes."
```

If the answer is anything other than `confirm`, **stop here** and do
**not** issue any dispatcher call with `confirmed: true`.

### C4: Persist

```bash
echo '{
  "agentId": "<AGENT_ID>",
  "dataDir": ".aweek/agents",
  "id": "<REC_ID>",
  "template": { /* optional partial overlay */ },
  "rule":     { /* optional partial overlay */ },
  "exceptions": [ /* optional — replaces wholesale */ ],
  "confirmed": true /* required ONLY when rule is present */
}' | aweek exec recurring updateRecurringTask --input-json -
```

Pipe the response through the formatter:

```bash
echo '{"record":<UPDATE_RESPONSE>}' \
  | aweek exec recurring formatUpdateResult --input-json -
```

The handler auto-stamps `updatedAt` inside `RecurringTaskStore.update()`.

---

## Branch D: Remove a recurring task

Unconditionally destructive — `confirmed: true` is **always required**.
Deleting a recurring task drops every future occurrence; past
materialized occurrences in `weekly-plans/<YYYY-Www>.json` are NOT
rolled back (the materializer is additive by design).

### D1: Pick the record

Run Branch A first to show the list, then ask via `AskUserQuestion`
which `rec-<slug>` id to remove.

### D2: Confirmation gate (required)

> **Confirmation gate (required).** `confirmed: true` MUST NOT be set
> on the dispatcher payload until **after** the user has explicitly
> answered `confirm`. The dispatcher throws `ERECURRING_NOT_CONFIRMED`
> otherwise.

Render a preview inline:

```
This will delete recurring task <rec-id> from <AGENT_ID>:

  Title  : <template.title>
  Rule   : <describeRule(rule)>

Every future occurrence will stop firing. Past occurrences that have
already materialized into weekly-plans/<YYYY-Www>.json are NOT rolled
back. This action cannot be undone — re-add the rule from scratch if
you change your mind.
```

Then collect the confirmation:

```
AskUserQuestion:
  "Delete recurring task <rec-id>? This drops every future occurrence."
  options:
    - value: confirm
      label: "Yes — delete the rule"
      description: "Remove the record from recurring-tasks.json. Future occurrences stop firing."
    - value: cancel
      label: "Cancel"
      description: "Keep the rule. No disk writes."
```

If the answer is anything other than `confirm`, **stop here**.

### D3: Persist

```bash
echo '{
  "agentId": "<AGENT_ID>",
  "dataDir": ".aweek/agents",
  "id": "<REC_ID>",
  "confirmed": true
}' | aweek exec recurring removeRecurringTask --input-json -
```

The response shape is `{ agentId, id, removed: boolean }`. `removed:
false` is **not an error** — it means the id wasn't on disk (stale UI,
already-deleted, typo). Pipe through the formatter:

```bash
echo '{"result":<REMOVE_RESPONSE>}' \
  | aweek exec recurring formatRemoveResult --input-json -
```

---

## Example invocations

End-to-end examples of common rule shapes. Plug the JSON into
`aweek exec recurring addRecurringTask --input-json -` after filling in
`<AGENT_ID>`, `<DTSTART_UTC_ISO>`, and `<IANA_ZONE>`.

### Daily standup at 09:00 PT, weekdays only

`FREQ=DAILY` doesn't carry a `byDay` filter — weekday-only patterns
should use weekly + `byDay`:

```json
{
  "agentId": "<AGENT_ID>",
  "template": {
    "title": "Daily standup",
    "prompt": "Post today's standup update to #team.",
    "priority": "medium",
    "estimatedMinutes": 15
  },
  "rule": {
    "freq": "weekly",
    "interval": 1,
    "byDay": ["MO", "TU", "WE", "TH", "FR"],
    "dtStart": "2026-05-11T16:00:00.000Z",
    "timeZone": "America/Los_Angeles"
  }
}
```

### Biweekly retrospective on Friday at 14:00 PT

`interval: 2` is the biweekly knob:

```json
{
  "agentId": "<AGENT_ID>",
  "template": {
    "title": "Sprint retrospective",
    "prompt": "Run the sprint retrospective and post action items to #retro.",
    "estimatedMinutes": 60
  },
  "rule": {
    "freq": "weekly",
    "interval": 2,
    "byDay": ["FR"],
    "dtStart": "2026-05-15T21:00:00.000Z",
    "timeZone": "America/Los_Angeles"
  }
}
```

### Monthly billing review on the 1st at 10:00 PT

`byMonthDay` pins the calendar day. Months with fewer days than
`byMonthDay` silently skip per RFC 5545 (so `byMonthDay: 31` fires only
in months that have a 31st).

```json
{
  "agentId": "<AGENT_ID>",
  "template": {
    "title": "Monthly billing review",
    "prompt": "Review last month's billing, file the invoice."
  },
  "rule": {
    "freq": "monthly",
    "interval": 1,
    "byMonthDay": 1,
    "dtStart": "2026-06-01T17:00:00.000Z",
    "timeZone": "America/Los_Angeles"
  }
}
```

### Second Tuesday of every month at 11:00 PT

`bySetPos` + `byDay` is the "nth weekday of the month" pattern.

```json
{
  "agentId": "<AGENT_ID>",
  "template": {
    "title": "Team townhall",
    "prompt": "Prep and chair the monthly town hall."
  },
  "rule": {
    "freq": "monthly",
    "interval": 1,
    "byDay": ["TU"],
    "bySetPos": 2,
    "dtStart": "2026-06-09T18:00:00.000Z",
    "timeZone": "America/Los_Angeles"
  }
}
```

### Last Friday of every month at 16:00 PT

Negative `bySetPos` counts from the end of the recurrence set
(`-1` = last, `-2` = second-to-last):

```json
{
  "agentId": "<AGENT_ID>",
  "template": {
    "title": "Month-end wrap",
    "prompt": "Close out the month — file reports, archive Slack threads."
  },
  "rule": {
    "freq": "monthly",
    "interval": 1,
    "byDay": ["FR"],
    "bySetPos": -1,
    "dtStart": "2026-05-29T23:00:00.000Z",
    "timeZone": "America/Los_Angeles"
  }
}
```

### Bounded recurrence — 12 weekly fires then stop

`count` and `until` are mutually exclusive (RFC 5545 XOR). Use `count`
when the user knows how many occurrences they want:

```json
{
  "agentId": "<AGENT_ID>",
  "template": {
    "title": "12-week course check-in",
    "prompt": "Post this week's course check-in thread."
  },
  "rule": {
    "freq": "weekly",
    "interval": 1,
    "byDay": ["WE"],
    "count": 12,
    "dtStart": "2026-05-13T17:00:00.000Z",
    "timeZone": "America/Los_Angeles"
  }
}
```

### Bounded recurrence — stop after a fixed date

`until` is the alternate terminator. The date is inclusive:

```json
{
  "agentId": "<AGENT_ID>",
  "template": {
    "title": "Election day reminder",
    "prompt": "Remind the team to vote."
  },
  "rule": {
    "freq": "daily",
    "interval": 1,
    "until": "2026-11-03T23:59:59.000Z",
    "dtStart": "2026-10-01T16:00:00.000Z",
    "timeZone": "America/Los_Angeles"
  }
}
```

### Skip a single occurrence (vacation week)

`update` with an `exceptions` overlay. The `originalRunAt` field is the
UTC ISO instant the expander would have produced **before** the
exception applied — copy it from the calendar's task chip / occurrence
id, NOT a fresh ISO timestamp:

```json
{
  "agentId": "<AGENT_ID>",
  "id": "<REC_ID>",
  "exceptions": [
    {
      "originalRunAt": "2026-07-06T16:00:00.000Z",
      "kind": "skip"
    }
  ]
}
```

> **No confirmation needed** — `exceptions`-only updates are not
> destructive (they're additive metadata on the same record).

### Move a single occurrence — Tuesday's task slips to Wednesday

`kind: 'override'` with a `runAt` in the overlay body:

```json
{
  "agentId": "<AGENT_ID>",
  "id": "<REC_ID>",
  "exceptions": [
    {
      "originalRunAt": "2026-07-07T17:00:00.000Z",
      "kind": "override",
      "override": {
        "runAt": "2026-07-08T17:00:00.000Z",
        "title": "Standup (rescheduled from Tue)"
      }
    }
  ]
}
```

### Bump priority on a rule without changing its schedule (no gate)

A `template`-only overlay does NOT require `confirmed: true`:

```json
{
  "agentId": "<AGENT_ID>",
  "id": "<REC_ID>",
  "template": {
    "priority": "high"
  }
}
```

### Change the schedule (gate required)

A `rule` overlay does:

```json
{
  "agentId": "<AGENT_ID>",
  "id": "<REC_ID>",
  "rule": {
    "interval": 2
  },
  "confirmed": true
}
```

---

## Dispatcher reference

Every interaction with `recurring-tasks.json` goes through one of these
dispatcher entries. The skill markdown MUST NOT inline `node -e`
snippets or hand-write the on-disk file.

| Entry                              | Confirmation gated | Purpose                                                                 |
|------------------------------------|--------------------|-------------------------------------------------------------------------|
| `recurring listRecurringTasks`     | No                 | Read every rule for one agent. Returns `[]` when no file exists.        |
| `recurring addRecurringTask`       | No                 | Append a new rule. Auto-derives `rec-<slug>` id from `template.title`; idempotent re-run when caller supplies an existing `id`. |
| `recurring updateRecurringTask`    | **Yes** (when `rule` overlay is present) | Patch template / rule / exceptions on an existing record. Auto-stamps `updatedAt`. |
| `recurring removeRecurringTask`    | **Yes**            | Delete a rule by id. No-op (returns `removed: false`) when id missing. |
| `recurring validateListParams`     | No                 | Pre-flight validator for the list call.                                |
| `recurring validateAddParams`      | No                 | Pre-flight validator — surfaces shape errors before AJV runs in `save()`. |
| `recurring validateUpdateParams`   | No                 | Pre-flight validator — enforces `confirmed: true` when a `rule` overlay is present. |
| `recurring validateRemoveParams`   | No                 | Pre-flight validator — enforces `confirmed: true`.                    |
| `recurring formatListResult`       | No                 | Format the list response as a compact multi-line summary.              |
| `recurring formatAddResult`        | No                 | Format the persisted record as a human-readable add summary.           |
| `recurring formatUpdateResult`     | No                 | Format the persisted record as a human-readable update summary.        |
| `recurring formatRemoveResult`     | No                 | Format the remove response (`removed: true|false`).                    |

## Validation rules

- **`agentId`** — non-empty string, must reference an existing agent on
  disk (the handlers fail fast with `Agent not found: <slug>` when the
  agent JSON is absent).
- **`id`** — when supplied, must match `^rec-[a-z0-9-]+$`. The validator
  surfaces a friendlier error than AJV's pattern message.
- **`template.title`** — non-empty string, 1–80 chars.
- **`template.prompt`** — non-empty string.
- **`template.priority`** — `critical` / `high` / `medium` / `low`.
- **`template.estimatedMinutes`** — integer 1–480.
- **`template.track`** — non-empty string, ≤ 64 chars.
- **`rule.freq`** — `daily` / `weekly` / `monthly`. `yearly` is
  rejected up-front (v1 out of scope).
- **`rule.interval`** — integer ≥ 1.
- **`rule.byDay`** — non-empty array of unique `["MO","TU","WE","TH","FR","SA","SU"]` codes.
- **`rule.byMonthDay`** — integer 1–31.
- **`rule.bySetPos`** — non-zero integer in `[-5, 5]`.
- **`rule.dtStart` / `rule.until` / `exceptions[].originalRunAt`** — UTC
  ISO-8601 date-time strings (parsed via `Date.parse`).
- **`rule.timeZone`** — non-empty IANA zone string.
- **`rule.count` XOR `rule.until`** — never both. The skill validator
  surfaces a clearer error than AJV's `oneOf`.
- **`exceptions[].kind`** — `skip` or `override`. `override` requires
  a non-empty `override` body.
- **`exceptions[].override`** — partial template overlay with an extra
  optional `runAt` (UTC ISO) for the "move this occurrence" UX. Unknown
  keys are rejected.
- **`confirmed`** — must be the literal boolean `true` for any
  destructive call. Truthy-but-non-true values (`"true"`, `1`, …) are
  treated as missing and the dispatcher throws
  `ERECURRING_NOT_CONFIRMED`.

## Error handling

- **Missing confirmation** — surface "Recurring-task <op> aborted:
  explicit confirmation required" and re-run the gate step (do not
  silently retry).
- **Agent not found** — re-prompt the user to pick a valid agent or
  point them at `/aweek:hire`.
- **Record not found on `update`** — the handler throws `RecurringTask
  not found: <rec-id> (agent <slug>)`. Re-list (Branch A) and have the
  user pick a real id.
- **Record not found on `remove`** — `removed: false` is **not an
  error** — the no-op response means the id wasn't on disk (stale UI,
  already-deleted, typo).
- **AJV validation failure (post pre-flight)** — should not normally
  happen because the skill's pre-flight validator runs first. If it
  does, surface the AJV error verbatim and re-collect the offending
  field.
- **`count` and `until` both set** — the pre-flight rejects with "rule.count
  and rule.until are mutually exclusive (RFC 5545 XOR)". On `update`,
  the merger automatically clears the OTHER terminator when one is
  supplied, so the AJV `oneOf` stays satisfied.

## How it works (subsystem map)

- **Source of truth** — `.aweek/agents/<slug>/recurring-tasks.json`. One
  file per agent, an array of `RecurringTask` documents.
- **Expander** — `src/services/recurrence-expander.ts` produces an
  `Occurrence[]` for a given ISO week and time-zone projection. Pure
  function — no I/O, no shared state, deterministic for a given
  `(rule, weekMondayUtc, tz)` triple.
- **Materializer** — `src/services/recurring-materializer.ts` merges the
  expander's output into the existing `WeeklyPlanStore`. Idempotent by
  occurrence id (`task-rec-<ruleId>-<yyyymmddThhmm>`) — re-running a
  tick blits the same record without duplication.
- **SPA calendar** — `src/serve/data/calendar.ts`'s
  `gatherAgentCalendar` merges expansion with on-disk plan tasks at
  read time, so every week navigates and renders even when there's no
  `weekly-plans/<YYYY-Www>.json` file.
- **Heartbeat** — the materializer runs eagerly at tick time so
  occurrences become real `WeeklyTask` records and execute through the
  same heartbeat loop as hand-authored tasks.

## Related skills

- `/aweek:plan` — hand-author / edit `weekly-plans/<YYYY-Www>.json`
  tasks for a single week. Use `/aweek:recurring` instead when the
  task should repeat across many weeks.
- `/aweek:calendar` — visualize the active weekly plan as a day × hour
  grid. Recurring occurrences appear inline alongside hand-authored
  tasks; the SPA calendar at `aweek serve` does the same with prev /
  next / today navigation across every ISO week.
- `/aweek:hire` — create a new agent. An agent with no
  `recurring-tasks.json` behaves byte-identically to one created before
  this skill existed.
- `/aweek:config` — edit `.aweek/config.json` (`timeZone`,
  `heartbeatIntervalSec`, …). The project's `timeZone` is the default
  for `rule.timeZone` when the user hasn't supplied an override.

## Data locations

- `.aweek/agents/<slug>/recurring-tasks.json` — per-agent
  `RecurringTask[]` document (this skill's primary write surface).
- `.aweek/agents/<slug>/weekly-plans/<YYYY-Www>.json` — per-week task
  lists (the materializer writes here at heartbeat tick time).
- `.aweek/config.json` — project config (`timeZone` default).

## Out of scope (v1 ceiling)

Explicitly **not implemented** by this skill — point users at the v2
backlog instead:

- `FREQ=YEARLY` recurrence.
- Multiple RRULEs per `RecurringTask` (multi-rule composition).
- `RDATE` (extra one-off dates added to the rule).
- `EXDATE` (one-off exclusion dates — use the `exceptions` array with
  `kind: 'skip'` instead).
- iCalendar import / export.
- Cross-agent recurring tasks (each rule belongs to exactly one agent).

If the user asks for any of these, point them at the v2 backlog and do
not extend the skill.
