# Skills

aweek ships eight Claude Code skills — capabilities the plugin
runtime exposes via `/aweek:[name]` invocation. Each skill's
markdown lives in `skills/[name]/SKILL.md` and shells out to
`aweek exec [module] [fn]`. No skill writes `.aweek/` JSON or
`.claude/agents/[slug].md` directly; all persistence and
validation lives in `src/skills/*.ts`.

## Reference table

| Skill | Purpose |
|-------|---------|
| [`/aweek:setup`](#aweek-setup) | Explicitly bootstrap a project: create `.aweek/`, optionally install the heartbeat, route into `/aweek:hire`. Usually auto-called by the first skill you run. |
| [`/aweek:teardown`](#aweek-teardown) | Remove the heartbeat and/or `.aweek/` data from a project. |
| [`/aweek:hire`](#aweek-hire) | Identity-only agent creation. Adopts an unhired `.claude/agents/[slug].md` or writes a new one. |
| [`/aweek:plan`](#aweek-plan) | Single entry point for goal / monthly / weekly adjustments **and** pending weekly plan approval. |
| [`/aweek:manage`](#aweek-manage) | Lifecycle ops: resume, top up, pause, delete. |
| [`/aweek:summary`](#aweek-summary) | Compact dashboard table across all agents with optional drill-down. |
| [`/aweek:query`](#aweek-query) | Filter the roster by role / status / persona keyword / budget. |
| [`/aweek:calendar`](#aweek-calendar) | Interactive weekly-plan calendar grid for one agent. |
| [`/aweek:delegate-task`](#aweek-delegate-task) | Async inter-agent task delegation through the recipient's inbox queue. |

## /aweek:setup

Per-project setup. Idempotent — re-runs report
`created` / `skipped` / `updated` per step.

Most users never invoke this directly — every other skill auto-bootstraps
the project on first run. Use `/aweek:setup` when you want explicit control
over the heartbeat installation, or to reset a sticky heartbeat decision so
the next skill call re-prompts.

Steps, in order:

1. Create the `.aweek/` data directory and seed `.aweek/config.json`
   with the host's detected IANA time zone.
2. Optionally install a 10-minute heartbeat as a launchd user agent
   under `~/Library/LaunchAgents/`. The plist label is
   `io.aweek.heartbeat.[hash]`, with the hash derived from the
   project directory so multiple aweek installs coexist. Heartbeat
   install requires explicit confirmation via `AskUserQuestion`.
3. Route into a four-option hire menu:
   - `hire-all` — adopt every unhired subagent under `.claude/agents/`.
   - `select-some` — multi-select adoption.
   - `create-new` — go straight to `/aweek:hire`.
   - `skip` — exit without hiring.
4. Clear the sticky heartbeat decision so the next skill call re-prompts.

## /aweek:teardown

Remove aweek from a project. Two operations available:

- **Remove heartbeat only** — uninstalls the launchd user agent (macOS)
  or crontab line (Linux) without touching agent data.
- **Full uninstall** — removes the heartbeat AND deletes `.aweek/`
  permanently.

Both require explicit `AskUserQuestion` confirmation.

## /aweek:hire

Identity-only agent creation. Two paths:

- **Adopt** an existing `.claude/agents/[slug].md` (project or user
  scope). The on-disk markdown is the single source of truth — typed
  description and system prompt are discarded in favor of what's there.
- **Create new** — collect three fields (name, description, system
  prompt) and write both the `.md` and the `.json`.

Plugin-namespaced subagents (`oh-my-claudecode-*`, `geo-*`, etc.) are
intentionally excluded from adoption.

Goals and plans are not collected here — add them via `/aweek:plan`.

## /aweek:plan

The only sanctioned way to mutate goals, monthly plans, weekly tasks,
and approval state. Atomic batches: if any operation fails schema
validation, none are written.

Operations:

- Edit the agent's free-form `plan.md` (long-term goals, monthly
  plans, strategies, notes).
- Adjust weekly tasks (add / update / remove).
- Approve a pending weekly plan. Until approval, the heartbeat is a
  no-op for that agent.

Goal `remove` and weekly plan `reject` are destructive — both require
explicit `AskUserQuestion` confirmation before the underlying adapter
will run.

## /aweek:manage

Lifecycle ops on a single agent:

| Operation | Effect |
|-----------|--------|
| `resume` | Clear the paused state. Fresh budget on the next Monday. |
| `top-up` | Reset weekly usage to 0 immediately (destructive — confirms first). |
| `pause` | Halt the agent at the next heartbeat tick. |
| `delete` | Remove `.aweek/agents/[slug].json`. Optionally delete the `.md` too (destructive — confirms first). |

Identity edits go through `.claude/agents/[slug].md` directly — there
is no `/aweek:edit-identity`.

## /aweek:summary

Compact dashboard across all agents — one row per agent with goal,
next task, weekly budget, status. Drill into any row for
`src/skills/status.ts` detail (per-agent recent activity, paused
reason, last execution log).

## /aweek:query

Filter the roster and return a slug list other skills can consume.
Filters: role, status, persona keyword, weekly budget range.

Useful for chaining — `/aweek:query` → pipe slugs into
`/aweek:delegate-task` or `/aweek:manage`.

## /aweek:calendar

Render one agent's active weekly plan as a calendar grid (day columns,
hour rows). Numbered task selection, view options, inline status edits.
Click a task chip to open a Sheet with all task fields.

The same grid backs the `/agents/[slug]/calendar` route in the
`aweek serve` dashboard.

## /aweek:delegate-task

Async inter-agent delegation. The sender drops a task into the
recipient's inbox; the recipient picks it up at the next heartbeat tick
in priority order (inbox before scheduled tasks).

Useful for multi-agent pipelines:

```text
researcher → drafter → editor → distributor
```

Each handoff is a `/aweek:delegate-task` call — the sender doesn't
block, the recipient drains its inbox on its own schedule.
