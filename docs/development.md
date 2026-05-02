# Develop aweek

For contributors who want to run aweek from a local checkout —
edits to `src/` should apply to the heartbeat and the
`/aweek:*` skills without re-publishing to npm.

## Setup

```bash
git clone https://github.com/runbear-io/aweek.git
cd aweek
pnpm install
pnpm build
pnpm link --global
```

`pnpm link --global` symlinks this checkout's `dist/bin/aweek.js`
to the global `aweek` command, replacing any npm-installed copy.
The Claude Code plugin's `SessionStart` hook sees `aweek` already
on `$PATH` and skips the npm install.

## Load the plugin from source

```bash
claude --plugin-dir .
```

`/reload-plugins` picks up edits to `skills/*/SKILL.md` without
restarting Claude Code.

## Inner loop

After every edit under `src/`:

```bash
pnpm build
```

The linked binary points at `dist/bin/aweek.js`, so the next
heartbeat tick and the next `/aweek:*` invocation pick up the
change.

## Useful commands

```bash
pnpm test            # backend tests (node:test via tsx)
pnpm test:spa        # SPA component tests (vitest + jsdom)
pnpm typecheck       # backend type-check gate
pnpm typecheck:spa   # SPA type-check gate
pnpm dev             # aweek serve + Vite HMR for the dashboard
```

## Unlink

```bash
pnpm uninstall -g aweek
npm install -g aweek   # restore the published version
```
