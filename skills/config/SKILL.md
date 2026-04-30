---
name: config
description: Show the project's `.aweek/config.json` knobs (plus the hardcoded scheduler/lock constants the dashboard surfaces) and edit the config-backed fields with a confirmation gate
trigger: aweek config, aweek configure, configure aweek, change time zone, set timezone, edit config, update config, aweek settings cli, /aweek:config
---

# aweek:config

CLI counterpart to the dashboard's Settings page. Use this skill any time the
user wants to **inspect** or **change** values in `.aweek/config.json`. The
skill renders the same knobs the Settings page does (time zone, stale task
window, plus the hardcoded heartbeat / lock constants) and provides a
destructive-write gate around any field that's actually editable.

Today the editable fields are `timeZone` and `staleTaskWindowMs`. The lock
directory, max lock age, and heartbeat interval remain hardcoded — those
either ship with the binary (heartbeat interval is set by the launchd plist
/ cron entry) or would orphan in-flight state if rewritten mid-run.

Adding a new editable field means extending `AweekConfig` in
`src/storage/config-store.ts`, its `saveConfig` validator, and the
`listEditableFields` registry in `src/skills/config.ts` — the SKILL flow
below picks up the new entry without further changes.

## Instructions

Follow these steps in order. **Do not skip Step 4** — every config change
must surface a before → after preview and an explicit `AskUserQuestion`
confirmation before the write happens, per project policy.

### Step 1: Render the current configuration

Always start by showing the full set of knobs so the user sees what's there
before deciding whether to edit:

```bash
SHOW=$(echo '{"dataDir": ".aweek/agents"}' | aweek exec config showConfig --input-json -)
echo "$SHOW" | aweek exec config formatShowConfigResult --input-json -
```

The rendered block looks like:

```
=== aweek Configuration ===
Config file: /abs/path/to/.aweek/config.json
File status: ok

-- Configuration --
  Time Zone: America/Los_Angeles
    key: timeZone · source: config
    IANA time zone used for scheduling, week-key derivation, and calendar display.

-- Scheduler --
  Heartbeat Interval (sec): 600 (read-only)
    key: heartbeatIntervalSec · source: hardcoded
    How often the launchd user agent (or cron fallback) fires the heartbeat.
  …

Editable fields: timeZone
```

If `File status: missing`, tell the user the config file is malformed (or has
an invalid `timeZone`) and is currently being ignored — the skill is
nonetheless safe to run because `editConfig` writes a fresh, valid document.

### Step 2: Decide whether to edit

If the user invoked `/aweek:config` with no arguments or with a "show me"
intent, stop here. Otherwise, ask via `AskUserQuestion`:

```json
{
  "question": "Edit a configuration value?",
  "header": "Edit?",
  "options": [
    {"label": "Yes, edit a field", "description": "Pick from the editable fields below"},
    {"label": "No, just viewing", "description": "Stop after the table above"}
  ],
  "multiSelect": false
}
```

If the user named a specific field/value in their message (e.g. "set the time
zone to Asia/Seoul"), skip the picker question and go straight to Step 4 with
the parsed `field` + `value`.

### Step 3: Pick a field

When more than one editable field exists, present them via
`AskUserQuestion`. Today there is only `timeZone`, so this step auto-resolves
without a prompt.

To list editable fields programmatically:

```bash
echo '{}' | aweek exec config listEditableFields --input-json -
```

Each entry includes `key`, `label`, `description`, and `defaultValue`. Use
the `description` text as the option's help string in the picker.

### Step 4: Collect, validate, and confirm the new value (REQUIRED gate)

Ask the user for the new value via `AskUserQuestion`. The picker options
depend on the field:

**`timeZone`** — common IANA zones plus an "Other" escape hatch:

- `America/Los_Angeles`
- `America/New_York`
- `Europe/Berlin`
- `Asia/Seoul`

**`staleTaskWindowMs`** — common windows (paste an integer for ms):

- `1200000` (20 min)
- `1800000` (30 min)
- `3600000` (60 min, default)
- `7200000` (2 h)

Validation accepts integer milliseconds in `[60000, 86400000]`. Decimals
are truncated; values below 1 minute or above 24 hours are rejected.

After collecting `value`, **always** run a dry-run `editConfig` to surface
validation errors and produce the before → after preview WITHOUT writing:

```bash
DRY=$(echo '{
  "dataDir": ".aweek/agents",
  "field": "timeZone",
  "value": "Asia/Seoul"
}' | aweek exec config editConfig --input-json -)
echo "$DRY" | aweek exec config formatEditConfigResult --input-json -
```

The dry-run result has three relevant shapes:

| Shape | Meaning | Action |
|-------|---------|--------|
| `ok: false`, reason mentions "not editable" / "not a recognised IANA" / "cannot be empty" | Validation failed | Tell the user, return to Step 4 |
| `ok: true`, `changed: false` | Value already matches what's on disk | Tell the user "already set"; stop without confirmation |
| `ok: false`, reason mentions "confirmed=true is required" | Validation passed; awaiting confirmation | Show before → after, ask the user, then go to Step 5 |

The "awaiting confirmation" reason is the **happy path** — `editConfig`
deliberately refuses to write until the SKILL markdown has gathered an
explicit `AskUserQuestion` confirmation. Quote the `before` and `after`
fields back to the user so they see exactly what will land in the file:

```json
{
  "question": "Update the project's time zone from <before> to <after>? This rewrites .aweek/config.json and immediately changes scheduling, week-key derivation, and the calendar grid for every agent.",
  "header": "Confirm",
  "options": [
    {"label": "Yes, write the change", "description": "Persist <after> to .aweek/config.json"},
    {"label": "Cancel", "description": "Leave the config untouched"}
  ],
  "multiSelect": false
}
```

If the user picks Cancel, stop and tell them no write was performed.

### Step 5: Write

Once confirmed, re-run `editConfig` with `confirmed: true`:

```bash
RESULT=$(echo '{
  "dataDir": ".aweek/agents",
  "field": "timeZone",
  "value": "Asia/Seoul",
  "confirmed": true
}' | aweek exec config editConfig --input-json -)
echo "$RESULT" | aweek exec config formatEditConfigResult --input-json -
```

A successful write returns `ok: true` with `changed: true`. The formatter
prints:

```
=== aweek Config Edit ===
Updated Time Zone (timeZone):
  America/Los_Angeles  →  Asia/Seoul
Wrote /abs/path/to/.aweek/config.json.
```

Mention to the user that the change takes effect on the next heartbeat tick
(no restart required) and that the dashboard's Settings page will reflect
the new value the next time it's loaded.

### Step 6: Don't bypass validation

Never write `.aweek/config.json` directly from this skill (no `cat >`, no
`echo`, no `aweek exec` against a different module). Every persistence path
must go through `aweek exec config editConfig --confirmed=true` so validation
+ atomic merge happen via `saveConfig`.

## Examples

### Show only

```
User: /aweek:config

[renders the block from Step 1]

The current configuration is shown above. No changes were made.
```

### Edit time zone interactively

```
User: /aweek:config change my time zone

[renders Step 1 block]
[Step 2 → user picks "Yes, edit a field"]
[Step 3 → auto-skipped, only timeZone editable]
[Step 4 → user picks Asia/Seoul]

I'm about to update timeZone:
  America/Los_Angeles  →  Asia/Seoul

[Step 4 confirm → user picks "Yes, write the change"]

=== aweek Config Edit ===
Updated Time Zone (timeZone):
  America/Los_Angeles  →  Asia/Seoul
Wrote /abs/path/to/.aweek/config.json.

The change takes effect on the next heartbeat tick.
```

### Edit with a specific value already in the prompt

```
User: /aweek:config set timezone to Asia/Seoul

[Step 1 block rendered]
[Steps 2 + 3 skipped — field & value parsed from the prompt]
[Step 4 confirmation prompted]
[Step 5 write]
```

### Invalid value

```
User: /aweek:config set timezone to Mars/Olympus

=== aweek Config Edit (failed) ===
Reason: "Mars/Olympus" is not a recognised IANA time zone. Try names like America/Los_Angeles or Asia/Seoul.
Field: timeZone

Try again with a valid IANA zone name. /aweek:config will list editable fields.
```

## Data sources

- Editable fields registry — `src/skills/config.ts` (`listEditableFields`)
- Read path — `loadConfigWithStatus` in `src/storage/config-store.ts`
- Write path — `saveConfig` in `src/storage/config-store.ts`
- Hardcoded constants surfaced for parity with the Settings page — mirrored
  in `src/skills/config.ts` and `src/serve/data/config.ts`. When you change
  one, change the other so the CLI and dashboard stay aligned.

## Related skills

- `/aweek:summary` — agent-level dashboard. Doesn't touch config.
- `/aweek:init` — one-time bootstrap that seeds `.aweek/config.json` with
  the detected system time zone.
- Settings page (`/settings` in `aweek serve`) — read-only browser view of
  the same knobs.
