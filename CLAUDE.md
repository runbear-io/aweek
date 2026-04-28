# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**aweek** — a Claude Code plugin for managing multiple AI agents with scheduled routines. Each aweek agent is a 1-to-1 wrapper around a Claude Code **subagent** defined in `.claude/agents/<slug>.md`. The `.md` file owns identity (name, description, system prompt); the aweek JSON at `.aweek/agents/<slug>.json` owns scheduling state (long-term goals, monthly/weekly plans, budget). An hourly heartbeat installed in the user's crontab triggers Claude Code CLI sessions that execute the next pending task per agent, tracks token usage against a weekly budget, and pauses agents that exhaust their budget.

Slash-command distribution is handled by the Claude Code plugin system (manifest at `.claude-plugin/plugin.json`, hooks at `.claude-plugin/hooks.json`). Users install via `/plugin install aweek@<marketplace>`; the `SessionStart` hook auto-installs the `aweek` CLI via `npm i -g aweek` if it isn't already on PATH.

## Development Environment

- **Runtime:** Node.js (ES modules)
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
| `/aweek:init` | `skills/init/SKILL.md` | Bootstrap a project: create `.aweek/`, optionally install the heartbeat crontab, then route into `/aweek:hire` |
| `/aweek:hire` | `skills/hire/SKILL.md` | Identity-only agent creation. Adopts an unhired `.claude/agents/<slug>.md` or writes a new one with three fields (name, description, system prompt). Goals/plans are added later via `/aweek:plan` |
| `/aweek:plan` | `skills/plan/SKILL.md` | Single entry point for goal/monthly/weekly adjustments **and** pending weekly plan approval (replaces the old `/aweek:adjust-goal` and `/aweek:approve-plan`) |
| `/aweek:manage` | `skills/manage/SKILL.md` | Lifecycle ops: resume, top-up, pause, delete (replaces `/aweek:resume-agent`). Identity edits go through the `.claude/agents/<slug>.md` file directly |
| `/aweek:summary` | `skills/summary/SKILL.md` | Compact dashboard table across all agents with optional drill-down |
| `/aweek:query` | `skills/query/SKILL.md` | Filter the roster by role / status / persona keyword / budget and return the matching slug list for downstream skills |
| `/aweek:calendar` | `skills/calendar/SKILL.md` | Interactive weekly-plan calendar grid for one agent (numbered task selection, view options, inline status edits) |
| `/aweek:delegate-task` | `skills/delegate-task/SKILL.md` | Async inter-agent task delegation through the recipient's inbox queue |

### Subagent ↔ aweek contract

- Each aweek agent has the same slug as its subagent. The slug is the filename of both `.claude/agents/<slug>.md` and `.aweek/agents/<slug>.json`.
- The `.md` is the **single source of truth** for identity. When `/aweek:hire` adopts an existing `.md`, the user's typed description and system prompt are discarded in favor of what is on disk.
- Plugin-namespaced subagents (slugs prefixed `oh-my-claudecode-`, `geo-`, etc.) are intentionally excluded from adoption.
- `/aweek:hire` and the four-option init menu (`hire-all`, `select-some`, `create-new`, `skip`) are the only sanctioned ways to create the `.md`/`.json` pair.

### Destructive operations require confirmation

Per project policy, every destructive write must collect an explicit `AskUserQuestion` confirmation before the skill module sets `confirmed: true`:

| Operation | Skill |
|-----------|-------|
| Install heartbeat crontab | `/aweek:init` |
| Overwrite an existing data dir | `/aweek:init` |
| Goal `remove` | `/aweek:plan` |
| Weekly plan `reject` | `/aweek:plan` |
| `top-up` (resets weekly usage) | `/aweek:manage` |
| `delete` (removes agent JSON, optionally `.md`) | `/aweek:manage` |

The underlying adapters refuse to run without `confirmed: true` — do not bypass the gate.

## Architecture

### Heartbeat execution loop

`/aweek:init` installs a cron entry (default `*/10 * * * *`) that invokes `aweek heartbeat` (the published `dist/bin/aweek.js`), which:

1. Acquires a heartbeat-level lock (`src/heartbeat/heartbeat-lock.ts`) to prevent overlapping ticks.
2. For each agent, acquires a per-agent lock (`src/lock/lock-manager.ts`), then drains delegated inbox tasks and the per-agent FIFO queue (`src/heartbeat/locked-session-runner.ts`, `src/queue/task-queue.ts`, `src/heartbeat/inbox-processor.ts`).
3. Selects the next pending task from the active weekly plan (`src/heartbeat/task-selector.ts`).
4. Launches a Claude Code CLI session (`src/execution/cli-session.ts`) with the task prompt + the subagent identity loaded via `--agents`. The session executor (`src/execution/session-executor.ts`) records token usage automatically.
5. Enforces the weekly budget (`src/services/budget-enforcer.ts`) and pauses the agent on exhaustion. `/aweek:manage` resume / top-up clears the pause.

### Plan model

Long-term goals, monthly plans, and strategies live in a per-agent free-form markdown at `.aweek/agents/<slug>/plan.md` (see `src/storage/plan-markdown-store.ts`). The file uses four canonical H2 sections — Long-term goals, Monthly plans, Strategies, Notes — but the structure is a convention, not a schema: the weekly-plan generator reads the whole body as context rather than enforcing shape. Legacy agents with `config.goals` / `config.monthlyPlans` JSON can be migrated to `plan.md` via `migrateLegacyPlan`; those JSON columns are now optional on the agent schema and will be removed in a follow-up.

Only weekly tasks remain structured:

- `weekly-plan.schema.js` — weekly tasks keyed by `YYYY-Www`. `objectiveId` is a free-form string (typically the H3 heading a task traces to in `plan.md`, e.g. `"2026-04"`). Plans start `approved: false` and only activate the heartbeat after the first `/aweek:plan` approval. (The AJV schema definitions in `src/schemas/*.js` stay raw `.js`; their typed wrappers re-export `JSONSchemaType<T>` bindings to TS consumers.)

Persistence is split across stores in `src/storage/` (agent, weekly-plan, monthly-plan, goal, inbox, usage, activity-log, artifact, execution).

### Time zone

`.aweek/config.json` carries a single `timeZone` field (IANA name, e.g. `"America/Los_Angeles"`). `/aweek:init` seeds it with the host's detected zone.

Storage stays UTC — `runAt`, `createdAt`, week keys on disk, and all millisecond comparisons (`task-selector.isRunAtReady`, etc.) are absolute. The configured zone is applied at every *date-field extraction*: calendar day/hour placement, ISO-week key derivation, Monday boundary for budget/usage/activity stores. The primitives live in `src/time/zone.ts` (`currentWeekKey`, `mondayOfWeek`, `localParts`, `localDayOffset`, `localHour`, `localWallClockToUtc`, `parseLocalWallClock`) and are re-exported from `src/index.ts`.

Every helper that touches date fields (`getMondayISO`, `getMondayDate` in the usage/activity/execution stores, `getCurrentWeekString`, calendar `mondayFromISOWeek`, `distributeTasks`, `renderGrid`) accepts an optional `tz` argument and stays UTC-default for backward compatibility. Runtime callers resolve the zone via `loadConfig(dataDir)` and pass it through; unit tests without a zone continue to see UTC behavior.

Cron fires in the system local zone. `runHeartbeatForAll` compares the configured zone against the detected system zone on each tick and prints a one-line warning when they diverge (so mismatches show up in heartbeat logs instead of silently drifting).

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
src/
  cli/dispatcher.ts             # Registry-backed `aweek exec <module> <fn>` surface
  index.ts                      # Public API surface (re-exports for skill markdown)
  models/agent.ts               # Agent / goal / plan builders + helpers
  schemas/                      # AJV schema definitions (.js by design) + typed wrappers (.ts)
  storage/                      # File-based stores (agent, plan, inbox, usage, ...) — all .ts
  subagents/                    # .claude/agents/<slug>.md primitives + discovery — .ts
  skills/                       # Skill business logic — .ts
    init.ts, init-hire-menu.ts
    hire.ts, hire-route.ts, hire-create-new.ts, hire-create-new-menu.ts,
    hire-all.ts, hire-select-some.ts
    plan.ts
    manage.ts, resume-agent.ts
    summary.ts, status.ts, weekly-calendar-grid.ts
    delegate-task.ts
  services/                     # Cross-cutting services (planning, review, budget) — .ts
  heartbeat/                    # Crontab + scheduler + lock + tick runner — .ts
  execution/                    # Claude Code CLI session launcher + tracker — .ts
  lock/                         # PID-tracked file locks — .ts
  queue/                        # Per-agent task queue — .ts
  serve/                        # Dashboard HTTP server (`aweek serve`)
    server.ts                   # Handler — SPA shell + /api/* + static assets
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
.aweek/                         # Runtime data (created by /aweek:init)
  agents/<slug>.json            # Per-agent scheduling state
  agents/<slug>/                # Per-agent subdirs (plans, usage, logs, inbox)
  .locks/                       # Heartbeat + per-agent lock files
```

`src/skills/status.ts` has no dedicated slash command — it backs the per-agent drill-down inside `/aweek:summary`.

## Conventions

- **Use the skill modules.** Every `/aweek:*` markdown calls into `src/skills/*.ts`. Do not duplicate their logic in ad-hoc node `-e` snippets — extend the module instead.
- **Atomic batches.** `/aweek:plan` adjustments are validated up front; if any operation fails schema validation, none are written.
- **Idempotent re-runs.** `/aweek:init` reports `created` / `skipped` / `updated` per step and never re-prompts for completed steps. `/aweek:hire` adopts on `.md` collision rather than overwriting. Bulk hires skip slugs that already have an aweek JSON.
- **Tests are colocated** as `<module>.test.ts` next to each source file (`.test.js` for the residual `src/schemas/*.js` files). Run `pnpm test` before committing.
- **Run typecheck after touching TS/TSX.** `pnpm typecheck` (backend) and `pnpm typecheck:spa` (SPA) are the syntax/type gates and are mandatory after: editing any `.ts`/`.tsx` file, resolving merge or rebase conflicts in TS files, or refactoring across module boundaries. The test runner can pass with cached compilations even when a barrel re-export has been broken — the typecheck catches that, the tests do not.
- **Don't widen TS strict flags** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) without coordinating — they're intentionally off until the residual `.js` schemas are migrated.
- **Don't hand-edit `src/serve/spa/components/ui/*.jsx`** — those are shadcn primitives. Reinstall via `pnpm dlx shadcn@latest add` instead.
