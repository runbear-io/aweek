# Getting started

aweek ships as a Claude Code plugin. Install the plugin, run `/aweek:init`
to set up the project, hire your first agent, then approve a weekly plan.

## Requirements

- **macOS 10.15 (Catalina) or newer.** Linux and Windows aren't
  supported yet — the heartbeat installs as a launchd user agent so
  Claude Code's OAuth tokens stay reachable through the user's
  Keychain.
- Node.js 20 or 22
- `jq` (`brew install jq`)
- An active Claude Code session

## Install

### From a Claude Code marketplace

```bash
/plugin install aweek@runbear-io
```

The plugin's `SessionStart` hook runs `npm install -g aweek` on first
launch so the `aweek` CLI is on your `$PATH`. If the install fails, run
it manually.

### From source

```bash
git clone https://github.com/runbear-io/aweek.git
cd aweek
pnpm install
pnpm link --global
claude --plugin-dir .
```

`/reload-plugins` picks up edits to skill markdown without restarting.

## Bootstrap a project

Open Claude Code in any project directory and run:

```text
/aweek:init
```

`init` is idempotent — it reports `created` / `skipped` / `updated`
per step and never re-prompts for completed work:

1. Creates `.aweek/` (agents, locks, config).
2. Detects your IANA time zone and writes it to `.aweek/config.json`.
3. Optionally installs a 10-minute heartbeat as a launchd user
   agent under `~/Library/LaunchAgents/`. The plist is per-project, so
   multiple aweek installs coexist. Heartbeat install requires explicit
   confirmation.
4. Routes you into `/aweek:hire` to add your first agent.

## Hire your first agent

```text
/aweek:hire
```

Identity-only — pick a slug, name, and write the system prompt that
defines what this agent does. aweek writes two files:

- `.claude/agents/[slug].md` — Claude Code subagent (single source of
  truth for identity).
- `.aweek/agents/[slug].json` — scheduling state (goals, plans, budget).

Goals and plans get added in the next step.

## Plan the week

```text
/aweek:plan
```

This is the single entry point for goals, monthly plans, weekly tasks,
and approval. The flow is roughly:

1. Edit the agent's free-form `plan.md` (long-term goals, monthly plans,
   strategies, notes).
2. Generate a draft weekly plan from `plan.md`.
3. Review and approve. Until approval, the heartbeat is a no-op for
   that agent.

## Walk away

The heartbeat (default: every 10 minutes) wakes every agent on the tick:

1. Drain delegated inbox tasks.
2. Pick the next due task from the active weekly plan.
3. Launch a fresh Claude Code CLI session with the agent's identity and
   the task prompt.
4. Record token usage; pause the agent if its weekly budget is exhausted.

Come back Monday morning to a status report and next week's draft plan.

## Useful commands once the agent is running

```text
/aweek:summary        # Compact dashboard across all agents
/aweek:calendar       # Weekly grid for one agent (with task drill-down)
/aweek:manage         # Pause, resume, top up budget, fire
/aweek:delegate-task  # Drop work into another agent's inbox
```

The full slash-command reference lives in [Slash commands](/skills).

## Per-agent secrets

Drop a `.env` at `.aweek/agents/[slug]/.env` to give one agent its own
environment variables. The heartbeat loads it on every tick and passes
the values into that agent's Claude Code session — other agents don't
see them.

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
with read-only JSON endpoints under `/api/*`. Use `--project-dir [path]`
to point at another project's `.aweek/` directory.

## Troubleshooting

- **Slash commands can't find `aweek`.** SessionStart's
  `npm install -g aweek` failed. Run it yourself.
- **Heartbeat isn't running.** Check
  `launchctl list | grep io.aweek.heartbeat`. If nothing matches,
  the launchd plist is gone — re-run `/aweek:init`. To inspect the
  plist on disk: `ls ~/Library/LaunchAgents/io.aweek.heartbeat.*.plist`.
- **Agent paused.** It hit its weekly budget. `/aweek:manage` →
  `resume` (resets next week) or `top-up` (resets now).
