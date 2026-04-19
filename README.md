# aweek

Claude Code plugin for running multiple AI agents on scheduled weekly plans.
Each aweek agent is a 1-to-1 wrapper around a Claude Code **subagent**
(`.claude/agents/<slug>.md`) with its own long-term goals, monthly
objectives, weekly tasks, and token budget. An hourly heartbeat triggers
Claude Code CLI sessions that execute the next pending task per agent,
tracks token usage against a weekly budget, and pauses agents that
exhaust their budget.

## Install

aweek ships as a Claude Code plugin. Two pieces land on your machine:

1. The seven `/aweek:*` slash commands (via the plugin).
2. The `aweek` CLI binary that those commands shell out to (via npm).

The plugin's `SessionStart` hook auto-installs the CLI on first run, so
for most users step 1 is the whole story.

### From a Claude Code marketplace (once published)

```bash
/plugin install aweek@<marketplace-name>
```

### From a local clone (development)

```bash
git clone https://github.com/ssowonny/aweek.git
cd aweek
pnpm install
pnpm link --global     # puts `aweek` on PATH
claude --plugin-dir .  # loads the plugin from this directory
```

`/reload-plugins` inside the session picks up edits without restarting.

### Prerequisites

- Node.js 20+ (ESM support)
- `crontab` for the optional heartbeat (standard on macOS / Linux)
- `jq` for a few slash-command snippets that stream JSON between steps

## What you get

| Command | What it does |
|---------|--------------|
| `/aweek:init` | Bootstrap a project — create the `.aweek/` data dir and (optionally) install the hourly heartbeat crontab entry |
| `/aweek:hire` | Create an aweek agent — identity only (name, description, system prompt); goals and plans come later |
| `/aweek:plan` | Manage an agent's long-term goals, monthly objectives, weekly tasks, and approve pending weekly plans |
| `/aweek:manage` | Lifecycle ops — resume a budget-paused agent, top up its budget, pause, or delete |
| `/aweek:summary` | Dashboard of every agent with goal count, task progress, budget usage, and status |
| `/aweek:calendar` | Render an agent's weekly plan as a calendar grid for interactive task edits |
| `/aweek:delegate-task` | Place a task in another agent's async inbox queue |

## Typical first-run

```text
User: /aweek:init
…creates .aweek/, prompts to install the heartbeat, offers to launch /aweek:hire

User: /aweek:hire
…collects name/description/system prompt, writes .claude/agents/<slug>.md and the aweek scheduling JSON

User: /aweek:plan
…walks you through goals → monthly objectives → weekly tasks, then approves the plan.
The first approved plan activates the heartbeat.
```

After that, the cron entry wakes up hourly and runs the next pending task
per agent inside a fresh Claude Code CLI session.

## Architecture

- **Slash commands** live in `skills/<name>/SKILL.md`. They shell out to
  `aweek exec <module> <fn>` for every stateful operation, so the
  markdown is location-independent.
- **`aweek exec`** is a registry-backed dispatcher (`src/cli/dispatcher.js`)
  that exposes a whitelist of skill exports through a `JSON in → JSON out`
  CLI surface.
- **Heartbeat** (`bin/aweek heartbeat`) is a per-project cron entry that
  drains each agent's inbox + weekly task queue, runs the selected task in
  a Claude Code CLI session, and records token usage against the agent's
  weekly budget.
- **Storage** is file-based: `.aweek/agents/<slug>.json` for scheduling
  state, `.claude/agents/<slug>.md` for identity (the single source of
  truth — edit it directly to rename or re-prompt an agent).
- **Validation** runs every mutation through AJV schemas in `src/schemas/`;
  batches are atomic.

## Troubleshooting

**`/aweek:*` commands can't find `aweek`.** The SessionStart hook tried
`npm install -g aweek` and it failed. Options:

- Install it yourself: `npm install -g aweek` (or `pnpm add -g aweek`).
- From source: `cd <aweek-repo> && pnpm install && pnpm link --global`.
- Verify it's on PATH: `which aweek`.

**Heartbeat isn't running.** Check `crontab -l` for an entry starting
with `# aweek:project-heartbeat:`. If missing, re-run `/aweek:init` and
answer `yes` to the heartbeat prompt.

**Agent paused unexpectedly.** It hit its weekly token budget. Use
`/aweek:manage` → `resume` to clear the pause (budget resets on the
next weekly boundary), or `top-up` to reset usage to 0 and optionally
raise the limit.

## Development

```bash
pnpm test            # full suite (2000+ tests)
pnpm test:verbose    # spec reporter
pnpm lint            # syntax-check every src file
```

Every `/aweek:*` markdown calls into `src/skills/*.js` via the
dispatcher. Do not duplicate logic in ad-hoc `node -e` snippets — extend
the module and register the new export in `src/cli/dispatcher.js`.

## License

ISC
