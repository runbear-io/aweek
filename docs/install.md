# Install

aweek ships as a Claude Code plugin. Install the plugin, then run
`/aweek:init` in any project directory.

## Requirements

- **macOS 10.15 (Catalina) or newer.** Linux and Windows aren't
  supported yet — the heartbeat installs as a launchd user agent so
  Claude Code's OAuth tokens stay reachable through the user's
  Keychain.
- Node.js 20 or 22
- An active Claude Code session

## From a Claude Code marketplace

```bash
/plugin install aweek@runbear-io
```

The plugin's `SessionStart` hook runs `npm install -g aweek` on first
launch so the `aweek` CLI is on your `$PATH`. If the install fails,
run it manually:

```bash
npm install -g aweek
```

## From source

```bash
git clone https://github.com/runbear-io/aweek.git
cd aweek
pnpm install
pnpm link --global
claude --plugin-dir .
```

`/reload-plugins` picks up edits to skill markdown without restarting.

## Verify

In your Claude Code session, type `/` — the `aweek:` skills
(`/aweek:init`, `/aweek:hire`, …) should appear in the suggestion
list.

If they don't, see
[Skills don't show up in Claude Code](/troubleshooting#skills-don-t-show-up-in-claude-code).

## Next: [Quickstart](/quickstart)

Install is done. The 10-minute walkthrough bootstraps a project,
hires your first agent, and gets the heartbeat running.
