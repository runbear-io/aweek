---
name: aweek:init
description: Initialize an aweek project — create the data directory, register skills, and optionally install the heartbeat crontab
trigger: aweek init, init aweek, initialize aweek, setup aweek, bootstrap aweek, aweek setup, aweek bootstrap
---

# aweek:init

Bootstrap a project for the aweek agent scheduler. This is the first skill a
user should run in a fresh repository — it prepares the filesystem layout,
registers the `/aweek:*` slash commands in `.claude/commands/`, and (optionally)
installs the hourly heartbeat crontab entry that drives agent execution.

This skill is a thin UX wrapper on top of `src/skills/init.js`. All filesystem
mutations, crontab writes, and idempotency checks live in that module — do
**not** edit `.aweek/`, `.claude/commands/`, or the user's crontab directly.

## Arguments

`/aweek:init` is interactive and takes no positional arguments. The underlying
`runInit()` function in `src/skills/init.js` accepts the following optional
options for advanced / non-interactive invocation:

| Option            | Type     | Default           | Description |
|-------------------|----------|-------------------|-------------|
| `projectDir`      | string   | `process.cwd()`   | Project root where `.aweek/` and `.claude/` will be created |
| `dataDir`         | string   | `.aweek/agents`   | Path (relative to `projectDir`) for the agent data directory |
| `installHeartbeat`| boolean  | `false`           | Whether to install the hourly heartbeat crontab entry (destructive — requires confirmation) |
| `heartbeatSchedule`| string  | `0 * * * *`       | Cron schedule used when `installHeartbeat` is true |
| `confirmed`       | boolean  | `false`           | Must be `true` to allow destructive operations (crontab install, overwriting an existing data dir) |

Never pass `confirmed: true` without collecting explicit confirmation via
`AskUserQuestion`.

## Idempotency contract

`/aweek:init` is safe to run repeatedly on an already-initialized project.
Each step reports one of three outcomes:

| Outcome      | Meaning |
|--------------|---------|
| `created`    | The resource did not exist and was created by this run |
| `skipped`    | The resource already existed with the expected shape — no action taken |
| `updated`    | The resource existed but was refreshed (e.g. skill markdown changed upstream) |

The skill MUST present these outcomes to the user so they can see exactly what
changed versus what was left alone.

### Re-run behavior

On a re-run against an already-initialized project the skill MUST:

1. Call `detectInitState()` FIRST and use the returned flags to decide which
   steps to skip silently vs. report as already-done. Do not run `ensureDataDir`,
   `registerSkills`, or `installHeartbeat` when the corresponding `needsWork.*`
   flag is `false` — just report the step as `skipped` and move on.
2. **Never re-prompt** for the heartbeat install if it is already installed.
3. On the final step (Step 6), still invoke `finalizeInit()` — it will return
   `mode: 'add-another'` so the wizard can offer the user a chance to hire
   another agent via `/aweek:hire`. Re-runs must not feel like dead-ends.

## Destructive operation policy

Per project policy, every destructive init step requires **explicit user
confirmation** *before* the change is applied.

| Step                          | Destructive | Confirmation required |
|-------------------------------|-------------|-----------------------|
| Create `.aweek/agents/` dir   | No          | No |
| Register skills in `.claude/commands/` | No   | No (idempotent copies) |
| Install heartbeat crontab     | Yes         | **Yes** |
| Overwrite existing data dir   | Yes         | **Yes** |

## Instructions

You MUST follow this exact workflow when this skill is invoked. Use the
Node.js modules in `src/skills/init.js` for every filesystem or crontab
mutation.

### Step 1: Detect current project state

Run the detection helper to figure out which steps are already complete:

```bash
node --input-type=module -e "
import { detectInitState } from './src/skills/init.js';

const state = await detectInitState({ projectDir: process.cwd() });
console.log(JSON.stringify(state, null, 2));
"
```

The returned object has this shape:

```json
{
  "dataDir": { "path": ".aweek/agents", "exists": true, "agentCount": 0 },
  "skillsRegistered": { "hire": true, "plan": true, "calendar": false, "summary": true, "manage": true, "delegateTask": true, "init": true },
  "heartbeat": { "installed": false, "schedule": null }
}
```

Present a short, readable summary of this state to the user before taking
any action. Do NOT proceed past Step 1 if the user cancels.

### Step 2: Ensure the data directory exists

If `state.dataDir.exists === false`, create it:

```bash
node --input-type=module -e "
import { ensureDataDir } from './src/skills/init.js';

const result = await ensureDataDir({
  projectDir: process.cwd(),
  dataDir: '.aweek/agents',
});
console.log(JSON.stringify(result, null, 2));
"
```

If the directory already exists, report `skipped` and move on — do NOT
overwrite or wipe an existing `.aweek/agents/` unless the user has explicitly
asked for a clean-slate reset AND confirmed via AskUserQuestion.

### Step 3: Register skills in `.claude/commands/`

Invoke the skill-registration helper (this wraps `scripts/setup-skills.sh`
semantics so the workflow can call it directly without shelling out):

```bash
node --input-type=module -e "
import { registerSkills } from './src/skills/init.js';

const result = await registerSkills({ projectDir: process.cwd() });
console.log(JSON.stringify(result, null, 2));
"
```

The result lists every slash command with its outcome (`created`, `updated`,
or `skipped`) plus any old pre-refactor commands that were removed. Present
the list to the user.

### Step 4: Offer heartbeat installation (destructive — confirmation required)

Ask the user via `AskUserQuestion`:

> **Install the hourly heartbeat crontab entry?**
> This writes to your user crontab so agents can run automatically every hour.
> You can remove it later with `crontab -e`.
>
> - `yes` — install now
> - `no` — skip (you can install it later by re-running `/aweek:init`)

Only if they answer `yes`, run:

```bash
node --input-type=module -e "
import { installHeartbeat } from './src/skills/init.js';

const result = await installHeartbeat({
  projectDir: process.cwd(),
  schedule: '0 * * * *',
  confirmed: true,
});
console.log(JSON.stringify(result, null, 2));
"
```

If the user declines, report that the heartbeat was skipped and remind them
they can install it later.

If the heartbeat is already installed (detected in Step 1), skip the prompt
entirely and report `skipped` — never re-install unprompted.

### Step 5: Summarize

Print a final summary table showing each step's outcome:

```
=== aweek init ===
Project: /path/to/project

  Data directory       : created (.aweek/agents)
  Skills registered    : 6 created, 1 skipped, 0 removed
  Heartbeat crontab    : skipped (user declined)

Next steps:
  1. Run /aweek:hire to create your first agent
  2. Run /aweek:plan to approve its initial weekly plan
  3. Run /aweek:summary to see the dashboard
```

### Step 6: Offer `/aweek:hire` as the final interactive step

Infrastructure setup is just the foundation; the user's real goal is to have at
least one working agent. After the summary prints, always offer the hire flow —
whether this is a fresh project (first agent) or a re-run (add another agent).

Run the finalize helper to get the handoff decision:

```bash
node --input-type=module -e "
import { finalizeInit } from './src/skills/init.js';

const result = await finalizeInit({ projectDir: process.cwd() });
console.log(JSON.stringify(result, null, 2));
"
```

The returned object has this shape:

```json
{
  "launchHire": true,
  "nextSkill": "/aweek:hire",
  "mode": "first-agent",
  "isReRun": false,
  "promptText": "Infrastructure setup is complete. Would you like to hire your first agent now via /aweek:hire?",
  "reason": "No agents found — init should hand off to /aweek:hire as the final interactive step.",
  "projectDir": "/path/to/project",
  "instruction": {
    "skill": "/aweek:hire",
    "projectDir": "/path/to/project",
    "promptText": "...",
    "reason": "..."
  }
}
```

`finalizeInit()` always returns `launchHire: true`. Two modes:

| `result.mode`    | When it's returned              | Suggested prompt |
|------------------|----------------------------------|------------------|
| `first-agent`    | No agents exist yet              | "Would you like to hire your first agent now?" |
| `add-another`    | One or more agents already exist | "Would you like to hire another agent now?"    |

Present `result.promptText` to the user via `AskUserQuestion` with yes/no
choices:

> **{{ result.promptText }}**
>
> - `yes` — launch `/aweek:hire` immediately
> - `no` — finish here (you can run `/aweek:hire` anytime later)

Only if they answer `yes`, invoke the `/aweek:hire` skill to run its full
interactive wizard. The hire skill is non-destructive — it only creates a new
agent config — so no additional `confirmed: true` gate is required, but the
user consent above is still mandatory UX.

Never skip Step 6: the init flow exists to give the user a clear next action,
whether this is their first agent or another one.

## Error handling

- If `.aweek/agents/` exists but is not a directory, report the error and
  stop — never delete unexpected files without explicit user consent
- If `.claude/commands/` cannot be created (permission denied), report the
  underlying `EACCES` error verbatim
- If the user does not have `crontab` installed or their shell rejects
  `crontab -l` / `crontab -`, surface the error and recommend installing
  the heartbeat manually
- On partial failure (e.g. 3 skills registered, 1 failed), report which
  succeeded and which failed — never silently swallow errors

## Next steps

After a successful init, tell the user:

- Hire their first agent with `/aweek:hire`
- Approve its initial weekly plan with `/aweek:plan`
- Inspect the dashboard with `/aweek:summary`
- Manage lifecycle (pause / resume / delete) with `/aweek:manage`

## Data directory

The default data directory is `.aweek/agents/` relative to the project root.
Agent config files live directly inside as `<agent-id>.json`. Per-agent
sub-directories hold weekly plans, token usage, inbox queues, and lock files.
