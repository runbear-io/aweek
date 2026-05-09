# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**aweek** — a Claude Code plugin for managing multiple AI agents with scheduled routines. Each aweek agent is a 1-to-1 wrapper around a Claude Code **subagent** defined in `.claude/agents/<slug>.md`. The `.md` file owns identity (name, description, system prompt); the aweek JSON at `.aweek/agents/<slug>.json` owns scheduling state (long-term goals, monthly/weekly plans, budget). A 10-minute heartbeat installed as a per-project **launchd user agent** (cron fallback on non-macOS — see the `installHeartbeat` dispatcher at `src/skills/setup.ts`) triggers Claude Code CLI sessions that execute the next pending task per agent, tracks token usage against a weekly budget, and pauses agents that exhaust their budget. The supported user-facing platform is **macOS only for now**; the cron backend exists in code but is not promoted in README.md or the docs site.

Slash-command distribution is handled by the Claude Code plugin system (manifest at `.claude-plugin/plugin.json`, hooks at `.claude-plugin/hooks.json`). Users install via `/plugin install aweek@<marketplace>`; the `SessionStart` hook auto-installs the `aweek` CLI via `npm i -g aweek` if it isn't already on PATH.

## Development Environment

- **Runtime:** Node.js (ES modules). Supported range: **>=20.0.0** (LTS baseline) as advertised in `package.json` `engines.node`. The repo pins a recommended toolchain version in `.nvmrc` (currently `24.13.1`) so contributors using `nvm` / `fnm` / Volta land on a tested Node automatically. `engineStrict` is intentionally NOT set — `pnpm install` won't refuse to run on older Node versions, but `pnpm test` and `pnpm typecheck` are only guaranteed green on Node >=20. Older releases (Node 18 and earlier) are unsupported. Note: `pnpm test` is Node-version-agnostic via `scripts/run-tests.mts` (which resolves the test-file glob list with a Node-side glob library) — do NOT regress to argv-glob expansion, since `node --test`'s native glob support only landed in Node 22.
- **Package manager:** pnpm (v10.7.0)
- **Language:** TypeScript for `src/**` and `bin/aweek.ts`; the SPA tree under `src/serve/spa/` is a mix of `.tsx` (pages, hooks, lib) and `.jsx` (layout, theme, shadcn primitives in `components/ui/`). The `src/schemas/*.js` AJV schema files plus the four root tool configs (`vite/vitest/tailwind/postcss.config.js`) intentionally stay `.js`.
- **Entry point:** `src/index.ts` (ships compiled to `dist/src/index.js`)
- **CLI:** `bin/aweek.ts` (ships compiled + chmod +x to `dist/bin/aweek.js`)
- **Type-check vs emit:** `tsconfig.node.json` is the gate (no-emit, strict subset); `tsconfig.build.json` is what `pnpm build` runs (emit-on-error, wider scope including the five heartbeat files temporarily excluded from the gate). `tsconfig.spa.json` covers the SPA tree.

## Commands

```bash
pnpm install            # Install dependencies
pnpm test               # Run node-test suites via tsx loader (matches *.test.{js,ts})
pnpm test:verbose       # Same with the spec reporter
pnpm test:spa           # Run SPA component tests (vitest + jsdom + Testing Library)
pnpm typecheck          # tsc --noEmit -p tsconfig.node.json (backend gate)
pnpm typecheck:spa      # tsc --noEmit -p tsconfig.spa.json (SPA gate)
pnpm lint               # node --check on residual src/**/*.js (kept for the `.js` files only)
pnpm build              # tsx scripts/build.mts: tsc emit → vite build → copy SPA bundle
                        # → chmod +x bin/. Output: dist/{bin,src}/.
pnpm dev                # One command: aweek serve (via tsx) + vite dev with HMR. Accepts
                        # `-- --project-dir <path>` to point at another .aweek/
pnpm dev:spa            # Vite dev only (for when you already run aweek serve)
```

Local development: `claude --plugin-dir .` loads the plugin from this directory, and `/reload-plugins` picks up markdown edits without restarting. For dashboard work, `pnpm dev -- --project-dir ~/some/project` opens `http://localhost:5173` with HMR against that project's `.aweek/` data.

The SPA build output (`src/serve/spa/dist/` in source, copied to `dist/src/serve/spa/dist/` for the published tarball) is **gitignored** — `aweek serve` reads from it at runtime via `resolveDefaultBuildDir()` in `server.ts`, which resolves `./spa/dist/` relative to the running `server.{ts,js}`. Contributors should run `pnpm build` once after clone before invoking the published CLI. `pnpm dev` doesn't need it (Vite serves from source). The npm publish flow rebuilds via `prepublishOnly`, so released tarballs always carry a fresh bundle.

## Skills

Skill markdown lives in `skills/<name>/SKILL.md`. Each step shells out to `aweek exec <module> <fn>` via the registry in `src/cli/dispatcher.ts`. All persistence and validation lives in `src/skills/*.ts` — never write `.aweek/` JSON or `.claude/agents/<slug>.md` files directly.

| Skill | File | Purpose |
|-------|------|---------|
| `aweek setup` | `skills/setup/SKILL.md` | Explicitly bootstrap a project: create `.aweek/`, optionally install the launchd heartbeat (cron fallback off-macOS), then route into `aweek hire`. Auto-called by every other skill on first run — users rarely need this directly |
| `aweek teardown` | `skills/teardown/SKILL.md` | Remove the heartbeat and/or `.aweek/` data from a project. Both operations are destructive and confirmation-gated |
| `aweek hire` | `skills/hire/SKILL.md` | Identity-only agent creation. Adopts an unhired `.claude/agents/<slug>.md` or writes a new one with three fields (name, description, system prompt). Goals/plans are added later via `aweek plan`. Auto-bootstraps on first run |
| `aweek plan` | `skills/plan/SKILL.md` | Single entry point for goal/monthly/weekly adjustments **and** pending weekly plan approval. Auto-bootstraps on first run |
| `aweek manage` | `skills/manage/SKILL.md` | Lifecycle ops: resume, top-up, pause, delete. Identity edits go through the `.claude/agents/<slug>.md` file directly. Auto-bootstraps on first run |
| `aweek summary` | `skills/summary/SKILL.md` | Compact dashboard table across all agents with optional drill-down |
| `aweek query` | `skills/query/SKILL.md` | Filter the roster by role / status / persona keyword / budget and return the matching slug list for downstream skills |
| `aweek calendar` | `skills/calendar/SKILL.md` | Interactive weekly-plan calendar grid for one agent (numbered task selection, view options, inline status edits). Auto-bootstraps on first run |
| `aweek delegate-task` | `skills/delegate-task/SKILL.md` | Async inter-agent task delegation through the recipient's inbox queue. Auto-bootstraps on first run |
| `aweek config` | `skills/config/SKILL.md` | CLI counterpart to the dashboard Settings page. Renders every knob `.aweek/config.json` exposes (`timeZone`, `staleTaskWindowMs`, `heartbeatIntervalSec`) and edits any of them via an interactive picker that doubles as the confirmation gate. Editing `heartbeatIntervalSec` additionally calls `installHeartbeat` to rotate the live launchd plist's `StartInterval` in the same flow |
| `aweek slack-init` | `skills/slack-init/SKILL.md` | Bootstrap an aweek-branded Slack app and persist its credentials to `.aweek/channels/slack/config.json` so the embedded `SlackAdapter` inside `aweek serve` can chat with the project's Claude through Slack. Two flows — provision-and-persist (uses a Slack Refresh Token to call `apps.manifest.create` + `apps.token.create`) or persist-only (user already has tokens). Both stages are confirmation-gated; the dispatcher refuses to run without `confirmed: true` |

### Subagent ↔ aweek contract

- Each aweek agent has the same slug as its subagent. The slug is the filename of both `.claude/agents/<slug>.md` and `.aweek/agents/<slug>.json`.
- The `.md` is the **single source of truth** for identity. When `aweek hire` adopts an existing `.md`, the user's typed description and system prompt are discarded in favor of what is on disk.
- Plugin-namespaced subagents (slugs prefixed `oh-my-claudecode-`, `geo-`, etc.) are intentionally excluded from adoption.
- `aweek hire` and the four-option init menu (`hire-all`, `select-some`, `create-new`, `skip`) are the only sanctioned ways to create the `.md`/`.json` pair.

### Destructive operations require confirmation

Per project policy, every destructive write must collect an explicit `AskUserQuestion` confirmation before the skill module sets `confirmed: true`:

| Operation | Skill |
|-----------|-------|
| Install / rotate heartbeat (launchd plist on macOS, crontab elsewhere) | `aweek setup`, `aweek config` (auto-rotates when `heartbeatIntervalSec` changes). Every other skill auto-prompts on first run via `ensureProjectReady` |
| Remove heartbeat | `aweek teardown` |
| Delete `.aweek/` data dir | `aweek teardown` |
| Overwrite an existing data dir | `aweek setup` |
| Goal `remove` | `aweek plan` |
| Weekly plan `reject` | `aweek plan` |
| `top-up` (resets weekly usage) | `aweek manage` |
| `delete` (removes agent JSON, optionally `.md`) | `aweek manage` |
| `editConfig` (writes `.aweek/config.json`) | `aweek config` |
| `provisionSlackApp` (creates a real Slack app + Socket-Mode token via `apps.manifest.create` / `apps.token.create`; rotates and invalidates the user's Slack Refresh Token) | `aweek slack-init` |
| `persistSlackCredentials` / `slackInit` (writes `.aweek/channels/slack/config.json`) | `aweek slack-init` |

The underlying adapters refuse to run without `confirmed: true` — do not bypass the gate. The Slack-init dispatcher additionally throws `ESLACK_INIT_NOT_CONFIRMED` so a misbehaving caller surfaces an actionable error instead of silently writing.

## Architecture

### Heartbeat execution loop

``aweek setup` installs (auto-called by every skill on first run) a 10-minute heartbeat that invokes `aweek heartbeat` (the published `dist/bin/aweek.js`). The install path is platform-routed (`installHeartbeat` in `src/skills/setup.ts`):

- **macOS (`process.platform === 'darwin'`)** — writes a launchd user agent plist at `~/Library/LaunchAgents/io.aweek.heartbeat.<hash>.plist` (label prefix `LAUNCHD_LABEL_PREFIX`, hash derived from the absolute project dir so multiple aweek installs coexist) and bootstraps it with `launchctl bootstrap gui/<uid> <plist>`. Tick rate is `StartInterval = 600` seconds. Implementation: `src/skills/launchd.ts`. **Why launchd over cron on macOS:** cron-invoked processes run outside the aqua session and can't reach the user's Keychain, so Claude Code's OAuth subscription tokens are invisible to a cron-launched `claude`. launchd user agents inherit Keychain access exactly like Terminal.
- **Other platforms** — appends a `*/10 * * * *` line to the user crontab, fenced by a `# aweek:project-heartbeat:<projectDir>` marker. Implementation: `defaultReadCrontab` / `defaultWriteCrontab` inside `src/skills/setup.ts`. The legacy `src/heartbeat/crontab-manager.ts` per-agent path was removed; the project-level entry is now the only automated crontab interaction in aweek.

Both paths converge on the same heartbeat tick:

1. Acquires a heartbeat-level lock (`src/heartbeat/heartbeat-lock.ts`) to prevent overlapping ticks.
2. For each agent, acquires a per-agent lock (`src/lock/lock-manager.ts`), then drains delegated inbox tasks and the per-agent FIFO queue (`src/heartbeat/locked-session-runner.ts`, `src/queue/task-queue.ts`, `src/heartbeat/inbox-processor.ts`).
3. Selects the next pending task from the active weekly plan (`src/heartbeat/task-selector.ts`).
4. Launches a Claude Code CLI session (`src/execution/cli-session.ts`) with the task prompt + the subagent identity loaded via `--agents`. The session executor (`src/execution/session-executor.ts`) records token usage automatically.
5. Enforces the weekly budget (`src/services/budget-enforcer.ts`) and pauses the agent on exhaustion. `aweek manage` resume / top-up clears the pause.

### Plan model

Long-term goals, monthly plans, and strategies live in a per-agent free-form markdown at `.aweek/agents/<slug>/plan.md` (see `src/storage/plan-markdown-store.ts`). The file uses four canonical H2 sections — Long-term goals, Monthly plans, Strategies, Notes — but the structure is a convention, not a schema: the weekly-plan generator reads the whole body as context rather than enforcing shape. Legacy agents with `config.goals` / `config.monthlyPlans` JSON can be migrated to `plan.md` via `migrateLegacyPlan`; those JSON columns are now optional on the agent schema and will be removed in a follow-up.

Only weekly tasks remain structured:

- `weekly-plan.schema.js` — weekly tasks keyed by `YYYY-Www`. `objectiveId` is a free-form string (typically the H3 heading a task traces to in `plan.md`, e.g. `"2026-04"`). Plans start `approved: false` and only activate the heartbeat after the first `aweek plan` approval. (The AJV schema definitions in `src/schemas/*.js` stay raw `.js`; their typed wrappers re-export `JSONSchemaType<T>` bindings to TS consumers.)

Persistence is split across stores in `src/storage/` (agent, weekly-plan, monthly-plan, goal, inbox, usage, activity-log, artifact, execution).

### Time zone

`.aweek/config.json` carries a single `timeZone` field (IANA name, e.g. `"America/Los_Angeles"`). `aweek init` seeds it with the host's detected zone.

Storage stays UTC — `runAt`, `createdAt`, week keys on disk, and all millisecond comparisons (`task-selector.isRunAtReady`, etc.) are absolute. The configured zone is applied at every *date-field extraction*: calendar day/hour placement, ISO-week key derivation, Monday boundary for budget/usage/activity stores. The primitives live in `src/time/zone.ts` (`currentWeekKey`, `mondayOfWeek`, `localParts`, `localDayOffset`, `localHour`, `localWallClockToUtc`, `parseLocalWallClock`) and are re-exported from `src/index.ts`.

Every helper that touches date fields (`getMondayISO`, `getMondayDate` in the usage/activity/execution stores, `getCurrentWeekString`, calendar `mondayFromISOWeek`, `distributeTasks`, `renderGrid`) accepts an optional `tz` argument and stays UTC-default for backward compatibility. Runtime callers resolve the zone via `loadConfig(dataDir)` and pass it through; unit tests without a zone continue to see UTC behavior.

Both launchd and cron fire in the system local zone. `runHeartbeatForAll` compares the configured zone against the detected system zone on each tick and prints a one-line warning when they diverge (so mismatches show up in heartbeat logs instead of silently drifting).

DST seams are handled explicitly: `localWallClockToUtc` returns the first instant past a spring-forward gap and the earlier of two candidates for a fall-back ambiguous wall clock. See `src/time/zone.test.ts`.

### Dashboard (`aweek serve`)

`aweek serve` is a single-process Node HTTP server (`src/serve/server.ts`) that serves a React SPA plus a read-only JSON API on the same port (default 3000). It replaced the older hand-rolled SSR section-module pile — none of those modules remain.

- **Frontend:** React 19 + Vite 6 + Tailwind 3 + shadcn/ui primitives, all under `src/serve/spa/` (components, pages, hooks, lib, styles). The entry is `src/serve/spa/main.tsx` and the HTML shell is `src/serve/spa/index.html`. Routes: `/` redirects to `/agents`; `/agents` lists agents; `/agents/:slug` and `/agents/:slug/:tab` (calendar/activity/strategy/profile) render the detail shell. Row-click on the list navigates into the detail page; a breadcrumb (`Agents › slug › tab`) provides back-nav. Clicking a task chip on the calendar opens a shadcn Sheet with the task's fields.
- **API layer:** thin JSON endpoint handlers in `src/serve/data/` (`agents.ts`, `plan.ts`, `calendar.ts`, `activity.ts`, `budget.ts`, `logs.ts`, `execution-log.ts`) — each one reads from the existing `src/storage/*` stores. No new persistence, strictly read-only. Per-agent gatherers use `listAllAgentsPartial` so a single drifted/invalid agent JSON doesn't 404 every endpoint; the offending file surfaces in the agents-list `issues` banner instead.
- **Route whitelist:** the server treats `/`, `/agents`, `/agents/:slug`, `/agents/:slug/*`, `/calendar`, `/activity`, `/strategy`, `/profile` as SPA client routes and serves `index.html` for them. Everything else (including `/api` with no resource, `/xyz`) returns 404 JSON. Static asset paths under `/assets/*` hit the build directory directly.
- **Build output:** `vite build` writes to `src/serve/spa/dist/` (configured in `vite.config.js`). `pnpm build` then copies that bundle to `dist/src/serve/spa/dist/` so the compiled `dist/src/serve/server.js` finds it via the same relative `./spa/dist/` path it uses in dev. `resolveDefaultBuildDir()` in `server.ts` is the single source of truth — keep it in sync if either path moves.
- **Theme:** `components/theme-provider.jsx` + `components/theme-toggle.jsx` provide light/dark with a sidebar-footer toggle, localStorage-persisted. Every primitive is written in canonical shadcn markup (`bg-card`, `text-muted-foreground`, `border-border`, …); no hardcoded `slate-*` classes should be reintroduced.
- **Development:** `pnpm dev` (see Commands) runs the Express backend on `:3000` and Vite HMR on `:5173`. Vite proxies `/api/*` to the backend. In production (`aweek serve`) there is **one** server process and one port — Vite is a devDependency only.
- **CLI flags:** `aweek serve [--port <n>] [--host <addr>] [--no-open] [--project-dir <path>] [--build-dir <path>]`. `--project-dir` is the same flag used by `pnpm dev` to point the backend at another project's `.aweek/`.

### Subagent discovery

`src/subagents/subagent-discovery.ts` scans both `.claude/agents/` (project) and `~/.claude/agents/` (user) and returns `{ slug, scope, path, hired }` records. The hire wizard's pick-existing branch and the init four-option menu both consume this list, filtering out plugin-namespaced and already-hired slugs.

### Slack channel (`aweek serve` embedded)

`aweek serve` embeds a Slack Socket-Mode listener in the SAME Node process — no second daemon, no second port, Socket Mode WebSocket only. Slack is OPTIONAL: missing credentials never brick the boot, the dashboard stays up, and the user can run `aweek slack-init` to provision the bot without restarting.

**v1 scope.** Project-level proxy only. Every Slack message reaching the bot (DM or `@`-mention per Slack defaults) becomes a project-level chat turn against the project's Claude. **Subagent identities are NOT directly addressable** from Slack in v1 — project Claude reaches them transitively via `Task()` / `aweek exec` under `bypassPermissions`. Out of scope (v2+): direct subagent addressing (`@researcher`), per-subagent Slack apps, slash commands, file uploads, channel-per-agent routing, content-classification routing.

**Library dep.** Slack adapter and streaming bridge come from `agentchannels` — currently the LOCAL workspace package at `/Users/ssowonny/Workspace/agentchannels/agentchannels` (branch `aweek-integration`), wired in via `file:../../agentchannels/agentchannels`. Do NOT swap to the released npm package; the public exports `SlackAdapter`, `StreamingBridge`, and `SlackManifestAPI` live on that branch.

**Per-thread Backend.** `src/channels/slack/project-claude-backend.ts` (`ProjectClaudeBackend`) implements agentchannels' `Backend` contract by spawning `claude --print --output-format stream-json --verbose --dangerously-skip-permissions [--resume <id>] [--append-system-prompt <banner>]` via `spawnProjectClaudeSession` in `src/execution/cli-session.ts`. The `--dangerously-skip-permissions` flag mirrors `permissionMode='bypassPermissions'` + `allowDangerouslySkipPermissions=true` (see `src/serve/data/chat.ts` after commit `bfd1e14`) and is scoped to Slack runs only — heartbeat runs do NOT use it. `backend_kind` is the literal `'project-claude'`; reserved as a string union for future per-subagent backends.

**Stream-event adapter.** `src/serve/slack-stream-event-parser.ts` translates the CLI's stream-json NDJSON lines into agentchannels `AgentStreamEvent`s (`text_delta`, `tool_use`, `tool_result`, `done`, `error`). Out-of-band metadata — the leading `system init` line's `session_id` and the terminal `result` line's token usage — surface via `onSessionInit` / `onResult` callbacks rather than the event union. The `StreamEventQueue` is a backpressure-safe push/pull bridge between the synchronous `onStdoutLine` callback and the agentchannels async iterator.

**System prompt.** Slack-driven runs use the project-level Claude system prompt (NO `--agents` flag in v1) plus a Slack-mode banner injected via `--append-system-prompt` (`SLACK_SYSTEM_PROMPT_BANNER` in `src/serve/slack-bridge.ts` — "conversational human chat, not task reports") so Slack replies don't read like heartbeat task summaries.

**Persistence (per-thread session continuity).** `src/storage/slack-thread-store.ts` writes one file per Slack thread at `.aweek/channels/slack/threads/<safeThreadKey>.json` with `{ threadKey, claudeSessionId, lastUsedAt }`. The first message in a thread spawns Claude with NO `--resume`; the CLI mints a fresh session id on its leading `system init` line, the backend's `onSessionInit` hook fires, and `saveSlackThread` mirrors it to disk. Subsequent messages in the same thread pass `--resume <persisted-sessionId>`. Survives `aweek serve` restarts. **24h idle TTL with lazy GC on read** — `loadSlackThread` deletes records whose `lastUsedAt` is older than `SLACK_THREAD_TTL_MS` (24h) and returns `null`, so a stale thread starts a fresh session naturally; nothing proactively scans the directory. Thread keys are agentchannels-supplied `${adapterName}:${channelId}:${threadId}` — `encodeThreadKey` sanitises them to filesystem-safe slugs (the encoder is lossy; the persisted `threadKey` field is canonical). `src/channels/slack/backend-factory.ts` (`createPersistedSlackBackend`) is the SINGLE place that knows about the on-disk thread shape; the listener / bridge / backend stay oblivious.

**Credential loader (env-first, file-fallback).** `src/storage/slack-config-store.ts` (`loadSlackCredentials`) reads `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, optional `SLACK_SIGNING_SECRET` from `process.env` first and falls back to `<projectRoot>/.aweek/channels/slack/config.json`. Both sources are gitignored (the file lives under the repo-wide `.aweek/` rule). Returns `null` when either required token is missing, which the listener treats as "Slack disabled" (NOT an error). Both snake_case keys (Slack manifest convention) and SCREAMING_SNAKE env-name keys are accepted in the file. Malformed JSON warns to stderr and falls through to env-only.

**Listener bootstrap.** `src/serve/slack-listener.ts` (`startSlackListener`) is called from `startServer` in `src/serve/server.ts` immediately after the HTTP listener is bound. It resolves credentials via the loader, instantiates `SlackAdapter` from agentchannels, and calls `connect()`. Returns `{ adapter: null, disconnect: noop }` whenever credentials are absent or initialisation throws — `aweek serve` keeps running with the dashboard only.

**Run-path bridge.** `src/serve/slack-bridge.ts` (`startSlackBridge`) wires a connected `ChannelAdapter` to the project-Claude backend factory via agentchannels' `StreamingBridge` and a `resolveBackend` hook backed by a per-`threadKey` cache. Inbound `adapter.onMessage` events flow into `bridge.handleMessage`. **Isolation contract** (see the slack-bridge module docstring for the static asserts):

- **No per-agent heartbeat lock.** This module MUST NOT import `acquireLock` / `releaseLock` from `src/lock/lock-manager.ts`. Per-Slack-thread serialisation is owned by the `StreamingBridge.activeThreads` guard.
- **No per-agent usage tree.** This module MUST NOT import `UsageStore` or the budget enforcer. Per-turn token accounting goes to `<projectRoot>/.aweek/channels/slack/usage.json` via `appendSlackUsageRecord` in `src/storage/slack-usage-store.ts`. The slack-bridge test suite asserts the per-agent tree (`.aweek/agents/`) is byte-identical before and after a Slack turn.
- **No interaction with the weekly-budget pause flag.** Slack turns never pause an agent.

**On-disk layout** (gitignored under the repo-wide `.aweek/` rule):

```
.aweek/channels/slack/
  config.json              # bot/app/signing tokens — written by `aweek slack-init`,
                           # read by `loadSlackCredentials` (env wins on conflict)
  usage.json               # JSON array of slack-usage-<hex> records (one per Slack turn);
                           # idempotent on `id`, last-writer-wins on the rename swap
  threads/
    <encodedThreadKey>.json # { threadKey, claudeSessionId, lastUsedAt } per thread;
                           # 24h idle TTL, lazy GC on read
```

**Testing.** Module tests are colocated as `<module>.test.ts`. The replay-driven integration test at `src/channels/slack/replay-integration.test.ts` drives a fake inbound Slack message through `startSlackBridge` → real `createPersistedSlackBackend` → real `ProjectClaudeBackend` → real stream-json parser → fake CLI sink, asserting both the streamed reply text and the on-disk `.aweek/channels/slack/threads/<encodedThreadKey>.json` mutation in a single cycle. The shared scaffold lives at `src/serve/slack-replay-harness.ts` (`ReplayBackend` mirroring agentchannels' `replay-agent-client`, `makeFakeSlackAdapterSource` capturing `startStream` / `append` / `finish` / `setStatus`, plus the fake CLI spawn helper); the same harness is reused by `src/serve/slack-replay-harness.test.ts` and is the seam any future end-to-end Slack test should import rather than re-rolling its own doubles.

## Project Structure

```
.claude-plugin/
  plugin.json                   # Plugin manifest (name, version, keywords)
  hooks.json                    # SessionStart hook that auto-installs the CLI
bin/
  aweek.ts                      # CLI entry (heartbeat + serve + `aweek exec` dispatcher).
                                # Compiled to dist/bin/aweek.js + chmod +x at publish time.
scripts/
  dev.mts                       # `pnpm dev` — aweek serve (via tsx) + vite dev with `--project-dir`
  build.mts                     # `pnpm build` — tsc emit → vite → copy SPA bundle → chmod +x
skills/                         # Slash-command markdown (source of truth)
  init/SKILL.md
  hire/SKILL.md
  plan/SKILL.md
  manage/SKILL.md
  summary/SKILL.md
  calendar/SKILL.md
  delegate-task/SKILL.md
  slack-init/SKILL.md           # Provision-and-persist (or persist-only) the Slack bot wired into `aweek serve`
src/
  cli/dispatcher.ts             # Registry-backed `aweek exec <module> <fn>` surface
  index.ts                      # Public API surface (re-exports for skill markdown)
  models/agent.ts               # Agent / goal / plan builders + helpers
  schemas/                      # AJV schema definitions (.js by design) + typed wrappers (.ts)
  storage/                      # File-based stores (agent, plan, inbox, usage, ...) — all .ts
                                # Slack-channel stores: slack-config-store.ts (env+file credential loader),
                                # slack-thread-store.ts (per-thread sessionId + 24h lazy-GC TTL),
                                # slack-usage-store.ts (Slack-only `.aweek/channels/slack/usage.json` bucket)
  channels/slack/               # Slack-channel Backend implementation (NOT shared with the heartbeat)
    project-claude-backend.ts   #   `Backend` impl that spawns `claude --print` per Slack turn
    backend-factory.ts          #   Wires `ProjectClaudeBackend` to slack-thread-store persistence
    replay-integration.test.ts  #   End-to-end replay-driven test: fake Slack message →
                                #   real bridge / backend / parser → fake CLI; asserts streamed
                                #   reply text + `.aweek/channels/slack/threads/*.json` mutation
  subagents/                    # .claude/agents/<slug>.md primitives + discovery — .ts
  skills/                       # Skill business logic — .ts
    setup.ts, setup-hire-menu.ts
    hire.ts, hire-route.ts, hire-create-new.ts, hire-create-new-menu.ts,
    hire-all.ts, hire-select-some.ts
    plan.ts
    manage.ts, resume-agent.ts
    summary.ts, status.ts, weekly-calendar-grid.ts
    delegate-task.ts
    slack-init.ts               # Provisioning + persistence primitives + composite `slackInit`
  services/                     # Cross-cutting services (planning, review, budget) — .ts
  heartbeat/                    # Scheduler + lock + per-agent tick runner — .ts.
                                # The launchd-vs-cron install side lives in
                                # src/skills/setup.ts + src/skills/launchd.ts;
                                # this directory has no scheduler-install code.
  execution/                    # Claude Code CLI session launcher + tracker — .ts
                                # cli-session.ts also exports `spawnProjectClaudeSession`,
                                # the Slack-mode entry that emits `--dangerously-skip-permissions`
                                # and optional `--resume <id>` / `--append-system-prompt <banner>`
  lock/                         # PID-tracked file locks (heartbeat-only — Slack runs do NOT use this)
  queue/                        # Per-agent task queue — .ts
  serve/                        # Dashboard HTTP server (`aweek serve`)
    server.ts                   # Handler — SPA shell + /api/* + static assets +
                                # embedded Slack listener+bridge bootstrap
    slack-listener.ts           # Resolves credentials → instantiates SlackAdapter → connect()
    slack-bridge.ts             # Wires connected adapter to ProjectClaudeBackend via StreamingBridge;
                                # owns the per-thread backend cache; isolation contract enforced here
    slack-stream-event-parser.ts# CLI stream-json NDJSON → agentchannels AgentStreamEvent translator +
                                # backpressure-safe StreamEventQueue
    slack-replay-harness.ts     # Shared scaffold for replay-driven Slack integration tests:
                                # ReplayBackend (mirrors agentchannels' replay-agent-client),
                                # makeFakeSlackAdapterSource, fake CLI spawn helper.
                                # Consumed by slack-replay-harness.test.ts and the end-to-end
                                # src/channels/slack/replay-integration.test.ts
    data/*.ts                   # Thin JSON endpoint handlers over src/storage/*
    spa/                        # React + Vite + Tailwind + shadcn SPA source
      index.html                # Vite HTML entry (#root mount point)
      main.tsx                  # Router + ThemeProvider + Layout wiring
      pages/*.tsx               # Agents list + Agent detail tabs; calendar/activity drawer hosts
      components/*.jsx          # Layout, sidebar, header, footer, theme-toggle, calendar grid, activity timeline
      components/ui/*.jsx       # Canonical shadcn primitives — reinstall via shadcn CLI, do not hand-edit
      hooks/*.ts                # use-agents, use-agent-calendar, use-agent-plan, use-agent-logs, …
      lib/*.ts                  # api-client, cn, utils
      styles/globals.css        # Tailwind directives + shadcn HSL tokens (light + dark)
      dist/                     # Vite build output (gitignored; rebuilt by `pnpm build` and the `prepublishOnly` hook)
tsconfig.node.json              # Backend type-check gate (no-emit, strict subset)
tsconfig.build.json             # Emit pipeline used by scripts/build.mts (wider scope, emit-on-error)
tsconfig.spa.json               # SPA type-check gate (allowJs for .jsx primitives)
vite.config.js                  # Vite root = src/serve/spa/, outDir = src/serve/spa/dist/
tailwind.config.js              # Dark class mode, shadcn color tokens
postcss.config.js               # Tailwind + autoprefixer
vitest.config.js                # SPA test runner config (jsdom)
vitest.setup.js                 # Testing Library setup
dist/                           # `pnpm build` output (gitignored; published in the npm tarball)
  bin/aweek.js                  # Compiled CLI (chmod +x)
  src/...                       # Compiled backend
  src/serve/spa/dist/           # SPA bundle copied from src/serve/spa/dist/
.aweek/                         # Runtime data (created by aweek init)
  agents/<slug>.json            # Per-agent scheduling state
  agents/<slug>/                # Per-agent subdirs (plans, usage, logs, inbox)
  .locks/                       # Heartbeat + per-agent lock files (NOT used by Slack runs)
  channels/slack/               # Slack execution surface — isolated from the heartbeat
    config.json                 # Slack tokens (gitignored). Written by `aweek slack-init`,
                                # read by loadSlackCredentials (env wins on conflict)
    usage.json                  # Slack-only token-usage log (one record per Slack turn)
    threads/<encodedKey>.json   # Per-thread Claude session id + lastUsedAt (24h lazy-GC TTL)
```

`src/skills/status.ts` has no dedicated skill — it backs the per-agent drill-down inside `aweek summary`.

## Conventions

- **Use the skill modules.** Every `aweek *` markdown calls into `src/skills/*.ts`. Do not duplicate their logic in ad-hoc node `-e` snippets — extend the module instead.
- **Atomic batches.** `aweek plan` adjustments are validated up front; if any operation fails schema validation, none are written.
- **Idempotent re-runs.** `aweek init` reports `created` / `skipped` / `updated` per step and never re-prompts for completed steps. `aweek hire` adopts on `.md` collision rather than overwriting. Bulk hires skip slugs that already have an aweek JSON.
- **Tests are colocated** as `<module>.test.ts` next to each source file (`.test.js` for the residual `src/schemas/*.js` files). Run `pnpm test` before committing.
- **Run typecheck after touching TS/TSX.** `pnpm typecheck` (backend) and `pnpm typecheck:spa` (SPA) are the syntax/type gates and are mandatory after: editing any `.ts`/`.tsx` file, resolving merge or rebase conflicts in TS files, or refactoring across module boundaries. The test runner can pass with cached compilations even when a barrel re-export has been broken — the typecheck catches that, the tests do not.
- **Don't widen TS strict flags** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) without coordinating — they're intentionally off until the residual `.js` schemas are migrated.
- **Don't hand-edit `src/serve/spa/components/ui/*.jsx`** — those are shadcn primitives. Reinstall via `pnpm dlx shadcn@latest add` instead.
