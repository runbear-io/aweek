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

Today the editable fields are `timeZone`, `staleTaskWindowMs`, and
`heartbeatIntervalSec`. Lock directory and max lock age are intentionally
not surfaced — those are implementation details of `src/lock/lock-manager.ts`.

`heartbeatIntervalSec` is config-backed but the live schedule lives in the
launchd plist (or crontab line) written by `/aweek:init`. Editing this
field writes `.aweek/config.json` immediately; the next `/aweek:init` run
rotates the live launchd plist (or cron entry) to match. Until then the
plist keeps firing at its previously-installed cadence — surface this in
the post-write status message whenever a user changes the field.

Adding a new editable field means extending `AweekConfig` in
`src/storage/config-store.ts`, its `saveConfig` validator, and the
`listEditableFields` registry in `src/skills/config.ts` — the SKILL flow
below picks up the new entry without further changes.

## Instructions

Follow these steps in order. The user's value-picker selection in Step 3 is
the deliberate user input that satisfies project policy for destructive
writes — there is intentionally **no second "are you sure?" prompt** after
it. Always run the dry-run validation though; bad values must never reach
the write call.

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
  Stale Task Window (ms): 3600000
    key: staleTaskWindowMs · source: config
    How far in the past a task's runAt can be before the heartbeat skips it.

-- Scheduler --
  Heartbeat Interval (sec): 600 (read-only)
    key: heartbeatIntervalSec · source: hardcoded
    How often the launchd user agent (or cron fallback) fires the heartbeat.
  …

Editable fields: timeZone, staleTaskWindowMs
```

If `File status: missing`, tell the user the config file is malformed (or has
an invalid `timeZone`) and is currently being ignored — the skill is
nonetheless safe to run because `editConfig` writes a fresh, valid document.

### Step 2: Pick a field to edit (or stop)

After Step 1's render, **always** present a single interactive picker that
lists every editable field plus a "Done" escape — never ask a binary
"do you want to edit?" first. Build the options dynamically from the
`knobs` array in `$SHOW`: every entry where `editable === true` becomes one
option. Quote each knob's current value in the option's description so the
user has context while choosing.

```bash
# Inspect the editable subset programmatically (used to build the picker).
EDITABLE_JSON=$(aweek json get knobs <<<"$SHOW")
```

Then call `AskUserQuestion` with one option per editable knob, plus a
trailing `Done` option:

```json
{
  "question": "Which configuration field would you like to edit?",
  "header": "Edit",
  "options": [
    {"label": "Time Zone", "description": "Currently America/Los_Angeles. IANA name used for scheduling."},
    {"label": "Stale Task Window (ms)", "description": "Currently 3600000. How far past runAt before a task is skipped."},
    {"label": "Done — just viewing", "description": "Stop without changes"}
  ],
  "multiSelect": false
}
```

Substitute each option's "Currently …" text from the matching knob's
`value`. Use the spec's `description` (truncated if too long) as the
remainder so the picker explains what each field does.

If the user picks `Done`, stop and tell them no write was performed.

If the user named a specific field in their message (e.g. "set the time
zone to Asia/Seoul"), skip this picker and go straight to Step 3 with the
parsed `field` (and `value` if also present).

To list editable fields' validation specs programmatically — useful when
you need the spec's `description` or `defaultValue`:

```bash
echo '{}' | aweek exec config listEditableFields --input-json -
```

### Step 3: Pick the new value, validate, and write

Ask the user for the new value via `AskUserQuestion`. **The picker IS the
confirmation** — do not add a second "are you sure?" prompt afterwards.
Picker options depend on the field:

**`timeZone`** — common IANA zones plus the harness's auto-provided "Other"
escape hatch:

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

**`heartbeatIntervalSec`** — common heartbeat cadences (paste an integer
for seconds):

- `300` (5 min)
- `600` (10 min, default)
- `900` (15 min)
- `1800` (30 min)

Validation accepts integer seconds in `[60, 86400]`. After the write
completes, **always** tell the user to re-run `/aweek:init` so the live
launchd plist (or crontab line) rotates to the new value — until then
the heartbeat keeps firing at its previously-installed cadence.

Once the user has picked, run a dry-run `editConfig` (no `confirmed`) to
surface validation errors before writing:

```bash
DRY=$(echo '{
  "dataDir": ".aweek/agents",
  "field": "timeZone",
  "value": "Asia/Seoul"
}' | aweek exec config editConfig --input-json -)
echo "$DRY" | aweek exec config formatEditConfigResult --input-json - --format text
```

The dry-run result has three relevant shapes:

| Shape | Meaning | Action |
|-------|---------|--------|
| `ok: false`, reason mentions "not editable" / "not a recognised IANA" / "cannot be empty" | Validation failed | Tell the user the reason, return to Step 3 (re-prompt) |
| `ok: true`, `changed: false` | Value already matches what's on disk | Tell the user "already set"; stop |
| `ok: false`, reason mentions "confirmed=true is required" | Validation passed; ready to write | Print a one-line `before → after` status and immediately write (below) |

The "confirmed=true required" reason is the happy path — `editConfig`'s
internal gate. The skill satisfies it by re-running with `confirmed: true`
right after the dry-run validates, with **no extra `AskUserQuestion`**:

```bash
RESULT=$(echo '{
  "dataDir": ".aweek/agents",
  "field": "timeZone",
  "value": "Asia/Seoul",
  "confirmed": true
}' | aweek exec config editConfig --input-json -)
echo "$RESULT" | aweek exec config formatEditConfigResult --input-json - --format text
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

### Step 4: Don't bypass validation

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
User: /aweek:config

[renders Step 1 block — full configuration]
[Step 2 picker → user picks "Time Zone (Currently America/Los_Angeles…)"]
[Step 3 picker → user picks Asia/Seoul]

Updating timeZone: America/Los_Angeles → Asia/Seoul

=== aweek Config Edit ===
Updated Time Zone (timeZone):
  America/Los_Angeles  →  Asia/Seoul
Wrote /abs/path/to/.aweek/config.json.

The change takes effect on the next heartbeat tick.
```

### Pick "Done" to stop after viewing

```
User: /aweek:config

[renders Step 1 block]
[Step 2 picker → user picks "Done — just viewing"]

The current configuration is shown above. No changes were made.
```

### Edit with a specific value already in the prompt

```
User: /aweek:config set timezone to Asia/Seoul

[Step 1 block rendered]
[Step 2 picker skipped — field & value parsed from the prompt]
[Step 3 dry-run validates, then writes immediately]
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
