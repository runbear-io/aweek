# Quickstart

This walkthrough hires one agent, gives it goals, approves a weekly
plan, and lets the heartbeat take over. Should take about 10 minutes.

Not installed yet? Start with [Install](/install).

## 1. Bootstrap a project

Open Claude Code in any project directory and run:

```text
aweek init
```

`init` is idempotent — it reports `created` / `skipped` / `updated`
per step and never re-prompts for completed work:

1. Creates `.aweek/` (agents, locks, config).
2. Detects your IANA time zone and writes it to `.aweek/config.json`.
3. Optionally installs a 10-minute heartbeat as a launchd user agent
   under `~/Library/LaunchAgents/`. The plist is per-project, so
   multiple aweek installs coexist. Heartbeat install requires
   explicit confirmation.
4. Routes you into `aweek hire` to add your first agent.

## 2. Hire your first agent

```text
aweek hire
```

Identity-only — pick a slug, name, and write the system prompt that
defines what this agent does. aweek writes two files:

- `.claude/agents/[slug].md` — the Claude Code subagent (single
  source of truth for identity).
- `.aweek/agents/[slug].json` — scheduling state (goals, plans,
  budget).

Goals and plans are added in the next step.

## 3. Plan the week

```text
aweek plan
```

The single entry point for goals, monthly plans, weekly tasks, and
approval. The flow is roughly:

1. Edit the agent's free-form `plan.md` (long-term goals, monthly
   plans, strategies, notes).
2. Generate a draft weekly plan from `plan.md`.
3. Review and approve. Until approval, the heartbeat is a no-op for
   that agent.

## 4. Walk away

The heartbeat (default: every 10 minutes) wakes every agent on the
tick:

1. Drain delegated inbox tasks.
2. Pick the next due task from the active weekly plan.
3. Launch a fresh Claude Code CLI session with the agent's identity
   and the task prompt.
4. Record token usage; pause the agent if its weekly budget is
   exhausted.

Come back Monday morning to a status report and next week's draft
plan.

## Useful commands once the agent is running

```text
aweek summary        # Compact dashboard across all agents
aweek calendar       # Weekly grid for one agent (with task drill-down)
aweek manage         # Pause, resume, top up budget, fire
aweek delegate-task  # Drop work into another agent's inbox
```

The full reference lives in [Skills](/skills).

## Per-agent secrets

Drop a `.env` at `.aweek/agents/[slug]/.env` to give one agent its
own environment variables. The heartbeat loads it on every tick and
passes the values into that agent's Claude Code session — other
agents don't see them.

```bash
# .aweek/agents/writer/.env
OPENAI_API_KEY=sk-...
NOTION_TOKEN=secret_...
```

`.aweek/` is gitignored, so secrets stay out of the repo by default.

## Dashboard

Want a browser view? Run:

```bash
aweek serve
```

Single Node process, default port `3000`. Serves a React SPA at `/`
with read-only JSON endpoints under `/api/*`. Use `--project-dir
[path]` to point at another project's `.aweek/` directory.

## Next steps

- [Build a weekly operator](/recipes/weekly-ops) — the marquee
  recipe. One agent, seven routine tasks across Mon–Fri, one
  cumulative `plan.md`.
- [Skills reference](/skills) — every `aweek [name]` skill
  documented.
- Hit a snag? See [Troubleshooting](/troubleshooting).
