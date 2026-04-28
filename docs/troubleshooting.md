# Troubleshooting

## Slash commands can't find `aweek`

aweek's `SessionStart` hook runs `npm install -g aweek` on first
launch. If that step failed, the slash commands won't be able to find
the CLI.

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
Re-run `/aweek:init` and confirm the heartbeat install when prompted.

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
/aweek:manage
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

## Anything else

- File an issue at
  [github.com/runbear-io/aweek/issues](https://github.com/runbear-io/aweek/issues).
- Include the output of `launchctl list | grep io.aweek.heartbeat`,
  the contents of `.aweek/config.json`, and the last few lines from
  the affected agent's activity log (visible in `aweek serve`).
