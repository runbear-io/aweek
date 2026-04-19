# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**aweek** — a Claude Code plugin for managing multiple AI agents with scheduled routines. Each aweek agent is a 1-to-1 wrapper around a Claude Code **subagent** defined in `.claude/agents/<slug>.md`. The `.md` file owns identity (name, description, system prompt); the aweek JSON at `.aweek/agents/<slug>.json` owns scheduling state (long-term goals, monthly/weekly plans, budget). An hourly heartbeat installed in the user's crontab triggers Claude Code CLI sessions that execute the next pending task per agent, tracks token usage against a weekly budget, and pauses agents that exhaust their budget.

Slash-command distribution is handled by the Claude Code plugin system (manifest at `.claude-plugin/plugin.json`, hooks at `.claude-plugin/hooks.json`). Users install via `/plugin install aweek@<marketplace>`; the `SessionStart` hook auto-installs the `aweek` CLI via `npm i -g aweek` if it isn't already on PATH.

## Development Environment

- **Runtime:** Node.js (ES modules)
- **Package manager:** pnpm (v10.7.0)
- **Entry point:** `src/index.js`
- **CLI:** `bin/aweek.js`

## Commands

```bash
pnpm install            # Install dependencies
pnpm test               # Run tests (node --test src/**/*.test.js)
pnpm test:verbose       # Run tests with the spec reporter
pnpm lint               # Syntax-check every src file
pnpm build              # Syntax-check src/index.js
```

Local development: `claude --plugin-dir .` loads the plugin from this directory, and `/reload-plugins` picks up markdown edits without restarting.

## Skills

Skill markdown lives in `skills/<name>/SKILL.md`. Each step shells out to `aweek exec <module> <fn>` via the registry in `src/cli/dispatcher.js`. All persistence and validation lives in `src/skills/*.js` — never write `.aweek/` JSON or `.claude/agents/<slug>.md` files directly.

| Skill | File | Purpose |
|-------|------|---------|
| `/aweek:init` | `skills/init/SKILL.md` | Bootstrap a project: create `.aweek/`, optionally install the heartbeat crontab, then route into `/aweek:hire` |
| `/aweek:hire` | `skills/hire/SKILL.md` | Identity-only agent creation. Adopts an unhired `.claude/agents/<slug>.md` or writes a new one with three fields (name, description, system prompt). Goals/plans are added later via `/aweek:plan` |
| `/aweek:plan` | `skills/plan/SKILL.md` | Single entry point for goal/monthly/weekly adjustments **and** pending weekly plan approval (replaces the old `/aweek:adjust-goal` and `/aweek:approve-plan`) |
| `/aweek:manage` | `skills/manage/SKILL.md` | Lifecycle ops: resume, top-up, pause, delete (replaces `/aweek:resume-agent`). Identity edits go through the `.claude/agents/<slug>.md` file directly |
| `/aweek:summary` | `skills/summary/SKILL.md` | Compact dashboard table across all agents with optional drill-down |
| `/aweek:calendar` | `skills/calendar/SKILL.md` | Interactive weekly-plan calendar grid for one agent (numbered task selection, view options, inline status edits) |
| `/aweek:delegate-task` | `skills/delegate-task/SKILL.md` | Async inter-agent task delegation through the recipient's inbox queue |

### Subagent ↔ aweek contract

- Each aweek agent has the same slug as its subagent. The slug is the filename of both `.claude/agents/<slug>.md` and `.aweek/agents/<slug>.json`.
- The `.md` is the **single source of truth** for identity. When `/aweek:hire` adopts an existing `.md`, the user's typed description and system prompt are discarded in favor of what is on disk.
- Plugin-namespaced subagents (slugs prefixed `oh-my-claudecode-`, `geo-`, etc.) are intentionally excluded from adoption.
- `/aweek:hire` and the four-option init menu (`hire-all`, `select-some`, `create-new`, `skip`) are the only sanctioned ways to create the `.md`/`.json` pair.

### Destructive operations require confirmation

Per project policy, every destructive write must collect an explicit `AskUserQuestion` confirmation before the skill module sets `confirmed: true`:

| Operation | Skill |
|-----------|-------|
| Install heartbeat crontab | `/aweek:init` |
| Overwrite an existing data dir | `/aweek:init` |
| Goal `remove` | `/aweek:plan` |
| Weekly plan `reject` | `/aweek:plan` |
| `top-up` (resets weekly usage) | `/aweek:manage` |
| `delete` (removes agent JSON, optionally `.md`) | `/aweek:manage` |

The underlying adapters refuse to run without `confirmed: true` — do not bypass the gate.

## Architecture

### Heartbeat execution loop

`/aweek:init` installs a cron entry (default `0 * * * *`) that invokes `bin/aweek.js heartbeat`, which:

1. Acquires a heartbeat-level lock (`src/heartbeat/heartbeat-lock.js`) to prevent overlapping ticks.
2. For each agent, acquires a per-agent lock (`src/lock/lock-manager.js`), then drains delegated inbox tasks and the per-agent FIFO queue (`src/heartbeat/locked-session-runner.js`, `src/queue/task-queue.js`, `src/heartbeat/inbox-processor.js`).
3. Selects the next pending task from the active weekly plan (`src/heartbeat/task-selector.js`).
4. Launches a Claude Code CLI session (`src/execution/cli-session.js`) with the task prompt + the subagent identity loaded via `--agents`. The session executor (`src/execution/session-executor.js`) records token usage automatically.
5. Enforces the weekly budget (`src/services/budget-enforcer.js`) and pauses the agent on exhaustion. `/aweek:manage` resume / top-up clears the pause.

### Plan model

Goals → Monthly Objectives → Weekly Tasks form a strict traceability chain enforced by JSON schemas in `src/schemas/`:

- `goals.schema.js` — long-term goals (`1mo` / `3mo` / `1yr` horizons).
- `monthly-plan.schema.js` — monthly objectives keyed by `YYYY-MM`, each linked to a `goalId`.
- `weekly-plan.schema.js` — weekly tasks keyed by `YYYY-Www`, each linked to an `objectiveId`. Plans start `approved: false` and only activate the heartbeat after the first `/aweek:plan` approval.

Persistence is split across stores in `src/storage/` (agent, weekly-plan, monthly-plan, goal, inbox, usage, activity-log, artifact, execution).

### Subagent discovery

`src/subagents/subagent-discovery.js` scans both `.claude/agents/` (project) and `~/.claude/agents/` (user) and returns `{ slug, scope, path, hired }` records. The hire wizard's pick-existing branch and the init four-option menu both consume this list, filtering out plugin-namespaced and already-hired slugs.

## Project Structure

```
.claude-plugin/
  plugin.json                   # Plugin manifest (name, version, keywords)
  hooks.json                    # SessionStart hook that auto-installs the CLI
bin/
  aweek.js                      # CLI entry (heartbeat + `aweek exec` dispatcher)
skills/                         # Slash-command markdown (source of truth)
  init/SKILL.md
  hire/SKILL.md
  plan/SKILL.md
  manage/SKILL.md
  summary/SKILL.md
  calendar/SKILL.md
  delegate-task/SKILL.md
src/
  cli/dispatcher.js             # Registry-backed `aweek exec <module> <fn>` surface
  index.js                      # Public API surface (re-exports for skill markdown)
  models/agent.js               # Agent / goal / plan builders + helpers
  schemas/                      # JSON schemas + AJV validator
  storage/                      # File-based stores (agent, plan, inbox, usage, ...)
  subagents/                    # .claude/agents/<slug>.md primitives + discovery
  skills/                       # Skill business logic
    init.js, init-hire-menu.js
    hire.js, hire-route.js, hire-create-new.js, hire-create-new-menu.js,
    hire-all.js, hire-select-some.js
    plan.js
    manage.js, resume-agent.js
    summary.js, status.js, weekly-calendar-grid.js
    delegate-task.js
  services/                     # Cross-cutting services (planning, review, budget)
  heartbeat/                    # Crontab + scheduler + lock + tick runner
  execution/                    # Claude Code CLI session launcher + tracker
  lock/                         # PID-tracked file locks
  queue/                        # Per-agent task queue
.aweek/                         # Runtime data (created by /aweek:init)
  agents/<slug>.json            # Per-agent scheduling state
  agents/<slug>/                # Per-agent subdirs (plans, usage, logs, inbox)
  .locks/                       # Heartbeat + per-agent lock files
```

`src/skills/status.js` has no dedicated slash command — it backs the per-agent drill-down inside `/aweek:summary`.

## Conventions

- **Use the skill modules.** Every `/aweek:*` markdown calls into `src/skills/*.js`. Do not duplicate their logic in ad-hoc node `-e` snippets — extend the module instead.
- **Atomic batches.** `/aweek:plan` adjustments are validated up front; if any operation fails schema validation, none are written.
- **Idempotent re-runs.** `/aweek:init` reports `created` / `skipped` / `updated` per step and never re-prompts for completed steps. `/aweek:hire` adopts on `.md` collision rather than overwriting. Bulk hires skip slugs that already have an aweek JSON.
- **Tests are colocated** as `<module>.test.js` next to each source file. Run `pnpm test` before committing.
