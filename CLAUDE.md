# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**aweek** — a Claude Code skill system for managing multiple AI agents with scheduled routines. Each agent has an identity, long-term goals, monthly/weekly plans, and executes hourly tasks via Claude Code CLI sessions triggered by a heartbeat system.

## Development Environment

- **Runtime:** Node.js (ES modules)
- **Package manager:** pnpm (v10.7.0)
- **Entry point:** src/index.js

## Commands

```bash
pnpm install          # Install dependencies
pnpm test             # Run tests (node --test)
pnpm test:verbose     # Run tests with spec reporter
```

## Skills

Project skills are defined in the `skills/` directory and registered in `.claude/commands/`.

| Skill | File | Description |
|-------|------|-------------|
| `/aweek:create-agent` | `skills/aweek-create-agent.md` | Create a new agent with identity, goals, and initial plan via interactive prompts |
| `/aweek:adjust-goal` | `skills/aweek-adjust-goal.md` | Adjust an agent's goals, monthly objectives, or weekly tasks interactively |
| `/aweek:approve-plan` | `skills/aweek-approve-plan.md` | Review and approve, reject, or edit a pending weekly plan (human-in-the-loop gate) |
| `/aweek:delegate-task` | `skills/aweek-delegate-task.md` | Delegate a task from one agent to another via the async inbox queue |
| `/aweek:resume-agent` | `skills/aweek-resume-agent.md` | Resume a budget-paused agent by clearing the pause flag or topping up its token budget |

### Invoking Skills

- **`/aweek:create-agent`** — Interactive agent creation wizard. Collects agent name, role, system prompt, goals, monthly objectives, and weekly tasks. Validates all input against JSON schemas and persists via `src/skills/create-agent.js`.
- **`/aweek:adjust-goal`** — Interactive goal/plan adjustment wizard. Select an agent, choose adjustment level (goals/monthly/weekly), collect changes, confirm, and apply atomically via `src/skills/adjust-goal.js`.
- **`/aweek:approve-plan`** — Weekly plan approval flow. Presents a pending plan for review, accepts approve/reject/edit decisions. First approval activates the heartbeat system. Uses `src/skills/approve-plan.js`.
- **`/aweek:delegate-task`** — Inter-agent task delegation. Select sender and recipient agents, describe the task, set priority and context. The task lands in the recipient's async inbox queue and is picked up on the next heartbeat. Uses `src/skills/delegate-task.js`.
- **`/aweek:resume-agent`** — Budget override/resume flow. Lists paused agents, shows budget details, and allows the user to resume (clear pause flag) or top-up (reset usage to zero with optional new budget limit). Uses `src/skills/resume-agent.js`.

## Project Structure

```
src/
  index.js                    # Main entry point / exports
  models/agent.js             # Agent model builder
  schemas/agent.schema.js     # JSON schema for agent validation
  schemas/validator.js         # AJV-based schema validator
  skills/create-agent.js       # Agent creation skill logic
  skills/adjust-goal.js        # Goal/plan adjustment skill logic
  skills/approve-plan.js       # Weekly plan approval skill logic
  skills/delegate-task.js      # Inter-agent task delegation skill logic
  skills/resume-agent.js       # Budget override/resume skill logic
  storage/agent-store.js       # File-based agent persistence
  storage/inbox-store.js       # File-based inbox queue persistence
skills/
  aweek-create-agent.md       # Skill definition for /aweek:create-agent
  aweek-adjust-goal.md        # Skill definition for /aweek:adjust-goal
  aweek-approve-plan.md       # Skill definition for /aweek:approve-plan
  aweek-delegate-task.md      # Skill definition for /aweek:delegate-task
  aweek-resume-agent.md       # Skill definition for /aweek:resume-agent
data/
  agents/                     # Agent JSON files (created at runtime)
```
