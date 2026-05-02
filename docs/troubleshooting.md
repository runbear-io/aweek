# Troubleshooting

## Skills don't show up in Claude Code

aweek's `SessionStart` hook runs `npm install -g aweek` on first
launch. If that step failed, the skills won't be able to invoke the
`aweek` CLI and `aweek [name]` will silently no-op.

```bash
npm install -g aweek
which aweek
```

If `which aweek` prints nothing, the global npm `bin` directory may
not be on `$PATH`. Add it:

```bash
echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Restart Claude Code so it re-reads `$PATH`.

## Heartbeat isn't running

The launchd user agent is the heartbeat's only execution path on
macOS. Check whether it's loaded:

```bash
launchctl list | grep io.aweek.heartbeat
```

If nothing matches, the plist was never installed (or was removed).
Run `aweek setup` (or invoke any other skill — it will auto-prompt)
and confirm the heartbeat install when asked.

To inspect the plist on disk:

```bash
ls ~/Library/LaunchAgents/io.aweek.heartbeat.*.plist
```

The label includes a hash of the project directory, so multiple aweek
installs coexist on one machine without collision.

## Agent paused

aweek pauses an agent when its weekly token budget is exhausted.
Clear the pause via:

```text
aweek manage
```

- `resume` — clears the pause. The agent picks up at the next Monday
  budget reset.
- `top-up` — resets weekly usage to 0 immediately. Destructive —
  confirms first.

## OAuth / Keychain errors in heartbeat logs

The reason aweek uses launchd (not cron) on macOS is that
cron-spawned processes can't reach the user's Keychain, so Claude
Code's OAuth subscription tokens are invisible to a cron-launched
`claude`. If you see auth errors in the heartbeat log, confirm the
agent is running under launchd, not from a cron entry:

```bash
launchctl list | grep io.aweek.heartbeat
crontab -l | grep aweek    # should be empty on macOS
```

If a stale crontab entry exists from an older install, remove it.

## Time-zone drift warnings

launchd fires in the system local zone. aweek logs a one-line warning
each tick if the configured `.aweek/config.json#timeZone` diverges
from the detected system zone. Either:

- Edit `.aweek/config.json#timeZone` to match the host, or
- Change the system time zone.

## Stale lock files

The heartbeat takes a project-level lock plus per-agent locks under
`.aweek/.locks/`. On a clean shutdown they're removed; on a crash
they may linger. The locks are PID-tracked, so a stale lock from a
crashed previous tick auto-clears on the next tick — manual cleanup
is only necessary if a lock points at a still-living unrelated
process.

```bash
ls .aweek/.locks/
```

## Removing aweek from a project

Use `/aweek:teardown` to cleanly uninstall. It offers two options:

- **Remove heartbeat only** — unloads and deletes the launchd plist (macOS)
  or removes the crontab entry. Agent data stays on disk.
- **Full uninstall** — removes the heartbeat AND deletes `.aweek/`
  permanently.

Both require explicit confirmation before any change is made.

```text
aweek teardown
```

## Anything else

- File an issue at
  [github.com/runbear-io/aweek/issues](https://github.com/runbear-io/aweek/issues).
- Include the output of `launchctl list | grep io.aweek.heartbeat`,
  the contents of `.aweek/config.json`, and the last few lines from
  the affected agent's activity log (visible in `aweek serve`).
