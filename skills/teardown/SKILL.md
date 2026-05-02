---
name: teardown
description: Remove the aweek heartbeat and/or the .aweek/ data directory from a project
trigger: aweek teardown, teardown aweek, uninstall aweek, remove heartbeat, remove aweek, aweek uninstall
---

# aweek:teardown

Remove aweek from a project. Two operations are available:

1. **Remove heartbeat only** — uninstalls the launchd user agent (macOS) or
   crontab line (Linux) without touching agent data. Agents pause until the
   heartbeat is re-installed via `/aweek:setup`.

2. **Full uninstall (heartbeat + data)** — removes the heartbeat AND deletes
   the `.aweek/` data directory. This is irreversible — all agent configs,
   weekly plans, activity logs, and budget history are deleted permanently.

Both operations are destructive and require explicit `AskUserQuestion`
confirmation before the dispatcher will run them.

This skill is a thin UX wrapper on top of `src/skills/teardown.ts`. Never
remove `.aweek/` or the heartbeat directly — always go through this skill so
the confirmation gate is enforced.

## Destructive operation policy

Per project policy, every destructive operation requires explicit user
confirmation before `confirmed: true` is passed to the adapter.

| Operation | Destructive | Confirmation required |
|-----------|-------------|-----------------------|
| Remove heartbeat | Yes — stops automated agent execution | **Yes** |
| Remove `.aweek/` data dir | Yes — permanent data loss | **Yes** |

## Instructions

You MUST follow this exact workflow. Use `AskUserQuestion` for every
interactive prompt.

### Step 1: Ask what to remove

Ask the user which teardown operation to perform:

```
AskUserQuestion:
  "What would you like to remove?"
  options:
    - value: heartbeat
      label: "Remove heartbeat only"
      description: "Uninstall the launchd user agent (macOS) or crontab line. Agent data stays on disk."
    - value: full
      label: "Full uninstall (heartbeat + .aweek/ data)"
      description: "Remove the heartbeat AND delete .aweek/. All agent configs, plans, and logs are permanently deleted."
    - value: cancel
      label: "Cancel"
      description: "Do nothing."
```

If the user picks `cancel`, stop here.

### Step 2: Confirm the destructive action

Show the user a clear preview of what will be deleted, then ask for
explicit confirmation via `AskUserQuestion`:

**Heartbeat-only path:**

```
This will uninstall the 10-minute heartbeat for this project.
Agents will stop auto-executing until the heartbeat is re-installed
via /aweek:setup.

Confirm?
  - yes  — remove the heartbeat
  - no   — cancel
```

**Full uninstall path:**

```
This will:
  1. Uninstall the 10-minute heartbeat.
  2. Delete .aweek/ and all its contents — agent configs, weekly plans,
     activity logs, budget history — permanently.

This CANNOT be undone.

Confirm?
  - yes  — full uninstall
  - no   — cancel
```

Only proceed when the user explicitly answers `yes`.

### Step 3: Execute the operation

**Heartbeat only:**

```bash
echo '{"confirmed":true}' \
  | aweek exec teardown removeHeartbeat --input-json -
```

**Full uninstall:**

```bash
echo '{"confirmed":true}' \
  | aweek exec teardown teardown --input-json -
```

The response has this shape:

```json
{
  "ok": true,
  "backend": "launchd",
  "outcome": "removed",
  "projectDir": "/path/to/project"
}
```

For the full teardown the response includes both `heartbeat` and `project`
sub-objects:

```json
{
  "ok": true,
  "heartbeat": { "ok": true, "backend": "launchd", "outcome": "removed", "projectDir": "..." },
  "project":   { "ok": true, "removed": "/path/to/.aweek", "existed": true }
}
```

### Step 4: Summarize

Print a final summary:

**Heartbeat only:**

```
=== aweek teardown ===
  Heartbeat  : removed (launchd)

Agents will no longer run automatically. To re-install the heartbeat,
run /aweek:setup.
```

**Full uninstall:**

```
=== aweek teardown ===
  Heartbeat  : removed (launchd)
  Data dir   : deleted (.aweek/)

aweek has been removed from this project. Run /aweek:setup to start
fresh.
```

## Error handling

- If the heartbeat was never installed, the command returns `outcome: "absent"`
  — this is not an error. Report "Heartbeat was not installed" and continue.
- If `.aweek/` does not exist, `removeProject` returns `existed: false` —
  report "Data directory was not present" and continue.
- Never silently swallow errors from the underlying commands.
