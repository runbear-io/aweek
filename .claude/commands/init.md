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

### Step 6: Offer the four-option hire menu as the final interactive step (or auto-delegate)

Infrastructure setup is just the foundation; the user's real goal is to have at
least one working agent. After the summary prints, always run the post-init
hire decision. The flow adapts to the project's current state:

- When **at least one unhired subagent** exists under `.claude/agents/<slug>.md`
  (i.e. the subagent `.md` is on disk but there is no matching
  `.aweek/agents/<slug>.json`), show the full **four-option** menu.
- When **no unhired subagents** exist, **skip the menu entirely and
  automatically delegate to `/aweek:hire`** (create-new branch). Asking the
  user to pick between "Create new" and "Skip" on an empty roster is noise —
  there is nothing to adopt and the only useful next action is to launch the
  create-new wizard. (Sub-AC 3 of AC 6.)

Resolve the decision via `resolveInitHireMenu` from `src/skills/init-hire-menu.js`.
This helper composes `buildInitHireMenu` (which calls `listUnhiredSubagents`
under the hood and filters plugin-namespaced slugs) with the fall-through rule
so the markdown gets one of two stable shapes back.

```bash
node --input-type=module -e "
import { resolveInitHireMenu, formatInitHireMenuPrompt } from './src/skills/init-hire-menu.js';

const decision = await resolveInitHireMenu({ projectDir: process.cwd() });
console.log(JSON.stringify({
  fallThrough: decision.fallThrough,
  reason: decision.reason,
  route: decision.route,
  menu: {
    hasUnhired: decision.menu.hasUnhired,
    unhired: decision.menu.unhired,
    options: decision.menu.options.map((o) => ({ value: o.value, label: o.label, description: o.description })),
    promptText: decision.menu.promptText,
  },
}, null, 2));
if (!decision.fallThrough) {
  console.log('---');
  console.log(formatInitHireMenuPrompt(decision.menu));
}
"
```

The returned object has one of two shapes:

**Choose path** (one or more unhired subagents):

```json
{
  "fallThrough": false,
  "menu": {
    "hasUnhired": true,
    "unhired": ["analyst", "writer"],
    "options": [
      { "value": "hire-all", "label": "Hire all", "description": "...", "requiresUnhired": true },
      { "value": "select-some", "label": "Select some", "description": "...", "requiresUnhired": true },
      { "value": "create-new", "label": "Create new", "description": "...", "requiresUnhired": false },
      { "value": "skip", "label": "Skip", "description": "...", "requiresUnhired": false }
    ],
    "promptText": "Infrastructure setup is complete. How would you like to hire subagents into aweek?"
  },
  "route": null,
  "reason": null
}
```

**Fall-through path** (no unhired subagents — auto-delegation to `/aweek:hire`):

```json
{
  "fallThrough": true,
  "menu": { "hasUnhired": false, "unhired": [], "options": [...], "promptText": "..." },
  "route": {
    "action": "create-new",
    "nextSkill": "/aweek:hire",
    "route": "create-new",
    "slugs": [],
    "bulk": false,
    "reason": "No unhired subagents were found under .claude/agents/. Auto-delegating to /aweek:hire (create-new) — there is nothing to adopt and the only useful next action is to create a new agent.",
    "fallThrough": true
  },
  "reason": "No unhired subagents were found under .claude/agents/. Auto-delegating to /aweek:hire (create-new) — there is nothing to adopt and the only useful next action is to create a new agent."
}
```

#### 6.0 Honor the fall-through before showing the menu

If `decision.fallThrough` is `true`:

1. Echo the `decision.reason` to the user (one short line — they should see
   *why* the menu was skipped, not be left guessing).
2. **Do NOT call `AskUserQuestion`.** Skip Step 6.1 entirely.
3. Invoke `/aweek:hire` immediately. Honor the `decision.route` descriptor —
   `route: 'create-new'` means launch the three-field create-new wizard with
   no pre-filled fields.

This auto-delegation is non-destructive (the hire wizard creates new state,
never overwrites). No additional `confirmed: true` gate is required.

If `decision.fallThrough` is `false`, proceed to Step 6.1 to present the menu
as documented below. The remainder of Step 6 only applies on the choose path.

#### 6.1 Present the menu

Display `menu.promptText` and, when `menu.hasUnhired` is true, the list of
unhired subagent slugs. Then invoke `AskUserQuestion` with the options from
`menu.options` — pass them verbatim so the labels, descriptions, and `value`
identifiers stay in sync with the backing module.

| Choice          | Available when        | Meaning |
|-----------------|-----------------------|---------|
| **Hire all**    | `hasUnhired === true` | Wrap every slug in `menu.unhired` into an aweek scheduling JSON in one pass. |
| **Select some** | `hasUnhired === true` | Prompt the user a second time with a multi-select over `menu.unhired` and hire only the picked slugs. See Step 6.2b for the helper pipeline (`buildSelectSomeChoices` → `AskUserQuestion` multi-select → `runSelectSomeHire`). |
| **Create new**  | Always                | Skip adoption and launch the `/aweek:hire` wizard's create-new path (three-field identity capture). |
| **Skip**        | Always                | Finish init without hiring. The user can always run `/aweek:hire` later. |

#### 6.2 Route the user's choice

Call `routeInitHireMenuChoice` to convert the user's selection into a stable
handler descriptor:

```bash
node --input-type=module -e "
import { buildInitHireMenu, routeInitHireMenuChoice } from './src/skills/init-hire-menu.js';

const menu = await buildInitHireMenu({ projectDir: process.cwd() });
const route = routeInitHireMenuChoice({
  choice: '<USER_CHOICE>',           // one of: hire-all, select-some, create-new, skip
  menu,
  selected: [<SELECTED_SLUGS>],     // required ONLY when choice === 'select-some'
});
console.log(JSON.stringify(route, null, 2));
"
```

The returned `route` descriptor tells the markdown exactly what to do next:

| `route.action`   | `route.nextSkill` | `route.route`    | `route.slugs`     | `route.bulk` |
|------------------|-------------------|------------------|-------------------|--------------|
| `hire-all`       | `/aweek:hire`     | `pick-existing`  | *every unhired*   | `true`       |
| `select-some`    | `/aweek:hire`     | `pick-existing`  | *user's picks*    | `true`       |
| `create-new`     | `/aweek:hire`     | `create-new`     | `[]`              | `false`      |
| `skip`           | `null`            | `null`           | `[]`              | `false`      |

Dispatch based on the descriptor:

- **`hire-all`** (`bulk: true`): hand `route.slugs` to the non-interactive
  `hireAllSubagents` handler (`src/skills/hire-all.js`). The handler iterates
  internally, wrapping every slug with a minimal aweek scheduling JSON shell
  (empty goals / plans, default budget — identity already lives in
  `.claude/agents/<slug>.md`). Per-slug outcomes land under `created` /
  `skipped` / `failed` so you can echo the summary verbatim:

  ```bash
  node --input-type=module -e "
  import { hireAllSubagents, formatHireAllSummary } from './src/skills/hire-all.js';

  const result = await hireAllSubagents({
    slugs: [<SLUGS>],                 // route.slugs from routeInitHireMenuChoice
    projectDir: process.cwd(),
  });
  console.log(formatHireAllSummary(result));
  if (!result.success) process.exit(1);
  "
  ```

  The handler is idempotent (re-running on an already-hired slug is a skip,
  not an error) and defensive (plugin-namespaced slugs, missing `.md`
  files, and invalid slug shapes surface as structured `skipped` / `failed`
  entries instead of throwing). Users who want per-agent goals / objectives /
  tasks should run `/aweek:plan` against each newly-hired slug afterwards —
  bulk hires intentionally leave plans empty so the user can tailor each
  roadmap rather than inheriting a generic template.
- **`select-some`** (`bulk: true`): see **Step 6.2b** below — it requires a
  second `AskUserQuestion` (a multi-select) before the wrapper pass.
- **`create-new`** (`bulk: false`): delegate to `/aweek:hire`'s create-new
  wizard so the user collects the three-field identity (name, description,
  system prompt) and both the `.claude/agents/<slug>.md` AND the aweek JSON
  wrapper land together. Do not pre-fill any of the three fields; the wizard
  collects them interactively.

  The canonical dispatch is the `buildCreateNewLaunchInstruction` descriptor
  from `src/skills/hire-create-new-menu.js` — it returns a stable
  `{ skill, route, projectDir, promptText, reason }` shape the markdown can
  render before invoking the interactive skill:

  ```bash
  node --input-type=module -e "
  import { buildCreateNewLaunchInstruction } from './src/skills/hire-create-new-menu.js';

  const instr = buildCreateNewLaunchInstruction({ projectDir: process.cwd() });
  console.log(JSON.stringify(instr, null, 2));
  "
  ```

  After rendering the prompt, invoke `/aweek:hire` and let the interactive
  wizard walk the user through Steps 1-6 of that skill.

  Alternatively, when the three identity fields have already been collected
  (e.g. from a non-interactive test harness), call `runCreateNewHire` to run
  the same two-step flow the wizard's Step 6a + 6b would run — it writes or
  adopts `.claude/agents/<slug>.md` via `createNewSubagent`, then delegates
  to `hireAllSubagents` so the aweek JSON shell shape matches every other
  menu branch:

  ```bash
  node --input-type=module -e "
  import { runCreateNewHire, formatCreateNewResult } from './src/skills/hire-create-new-menu.js';

  const result = await runCreateNewHire({
    name: '<NAME>',
    description: '<DESCRIPTION>',
    systemPrompt: '<SYSTEM_PROMPT>',
    weeklyTokenLimit: <LIMIT>, // optional — defaults to DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT
    projectDir: process.cwd(),
  });
  console.log(formatCreateNewResult(result));
  if (!result.success) process.exit(1);
  "
  ```

  The returned `result` shape is:

  ```json
  {
    "success": true,
    "validation": { "valid": true, "errors": [], "slug": "content-writer" },
    "subagent": { "success": true, "adopted": false, "slug": "content-writer", "path": "...", "content": "..." },
    "hire":     { "success": true, "created": ["content-writer"], "skipped": [], "failed": [] }
  }
  ```

  Three failure modes, each with its own remediation:

  - **Validation failure** (`result.validation.valid === false`): the three
    fields were invalid (empty, name slugifies to nothing, etc.). Nothing
    was written. Surface `formatCreateNewResult(result)` (starts with
    "Input rejected — …") and re-prompt the user.
  - **Subagent write failure** (`result.subagent.success === false`): the
    `.md` write failed and — critically — the aweek JSON wrapper was
    **never attempted**. Surface the "Subagent file error" block and
    resolve the underlying filesystem issue before retrying.
  - **Wrapper failure** (`result.hire.success === false`): the `.md` landed
    but the aweek JSON shell failed (schema error, filesystem issue).
    Surface the nested `formatHireAllSummary` block so the user sees which
    slug failed and why.

  Adoption is a first-class outcome, not a failure: when `.claude/agents/<slug>.md`
  already exists, the helper returns `subagent.adopted: true` and keeps the
  on-disk `.md` verbatim. The typed description + system prompt are
  discarded per the "single source of truth" constraint. Tell the user
  adoption happened and display `subagent.content` so they can confirm what
  they are wiring into aweek scheduling.
- **`skip`**: finish here. Remind the user they can run `/aweek:hire` at any
  time to add an agent later.

#### 6.2b Select-some branch (multi-select + wrap)

When `route.action === 'select-some'` the markdown must run a **second**
interactive prompt — a multi-select over `menu.unhired` — before touching the
filesystem. The helpers in `src/skills/hire-select-some.js` own this flow so
the markdown does not have to hand-roll the choice payload or the
validation-and-dispatch glue.

**Step 6.2b-1 — Build the multi-select payload.** Use `buildSelectSomeChoices`
to turn `menu.unhired` into a ready-to-show `AskUserQuestion` payload. Each
choice is enriched with the live `name` + `description` from
`.claude/agents/<slug>.md` so users see what they are picking:

```bash
node --input-type=module -e "
import { buildInitHireMenu } from './src/skills/init-hire-menu.js';
import { buildSelectSomeChoices } from './src/skills/hire-select-some.js';

const menu = await buildInitHireMenu({ projectDir: process.cwd() });
const payload = await buildSelectSomeChoices(menu, { projectDir: process.cwd() });
console.log(JSON.stringify(payload, null, 2));
"
```

The returned payload has this shape:

```json
{
  "promptText": "Select the subagents to wrap into aweek scheduling JSONs (pick one or more):",
  "multiSelect": true,
  "slugs": ["analyst", "writer"],
  "choices": [
    { "value": "analyst", "label": "Analyst", "description": "Analyse things.", "missing": false, "path": ".../analyst.md" },
    { "value": "writer",  "label": "Writer",  "description": "Write things.",   "missing": false, "path": ".../writer.md"  }
  ]
}
```

**Step 6.2b-2 — Render the multi-select.** Display `payload.promptText` and
invoke `AskUserQuestion` with `payload.choices`, enabling checkbox / multi-pick
semantics (`multiSelect: true`). Users MUST be able to pick more than one slug
— a single-select would defeat the purpose of this branch. Collect the user's
picks as a `string[]` — call it `selectedSlugs`.

**Step 6.2b-3 — Validate + wrap.** Pass `selectedSlugs` to `runSelectSomeHire`
which re-validates the selection against the menu's unhired list (defense in
depth against stale menus or slugs hired concurrently) and then delegates to
`hireAllSubagents` to wrap every picked slug:

```bash
node --input-type=module -e "
import { buildInitHireMenu } from './src/skills/init-hire-menu.js';
import { runSelectSomeHire, formatSelectSomeResult } from './src/skills/hire-select-some.js';

const menu = await buildInitHireMenu({ projectDir: process.cwd() });
const result = await runSelectSomeHire({
  menu,
  selected: [<SELECTED_SLUGS>], // string[] from AskUserQuestion multi-select
  projectDir: process.cwd(),
});
console.log(formatSelectSomeResult(result));
if (!result.success) process.exit(1);
"
```

The returned shape is:

```json
{
  "success": true,
  "validation": { "valid": true, "errors": [] },
  "hire": {
    "success": true,
    "created": ["writer", "analyst"],
    "skipped": [],
    "failed": []
  }
}
```

Two failure modes, each with its own remediation:

- **Validation failure** (`result.validation.valid === false`): the user's
  selection itself was malformed (empty, contained a slug not in
  `menu.unhired`, duplicate slug, non-string entry). `result.hire` is `null`
  — **no wrapper was written**. Surface
  `formatSelectSomeResult(result)` (starts with "Selection rejected — …") and
  re-render the multi-select so the user can pick a valid subset.
- **Per-slug failure** (`result.hire.success === false`): the selection was
  structurally valid but one or more slugs failed to wrap at the hire-all
  layer (the `.md` vanished between discovery and dispatch, a filesystem
  error, etc.). The nested `result.hire.failed` list has per-slug error
  details. Echo `formatSelectSomeResult(result)` so the user sees exactly
  which slugs wrapped and which did not.

The handler is intentionally idempotent — re-selecting an already-hired slug
produces a `skipped` entry (not a failure) and re-selecting never overwrites
a pre-existing aweek JSON. No `confirmed: true` gate is required because the
only filesystem writes are new `.aweek/agents/<slug>.json` files; no
`.md` or crontab entries are touched.

Never skip Step 6 — the init flow exists to give the user a clear next action,
whether this is their first agent or a re-run after adding more subagents.

#### 6.3 Error handling

- If `routeInitHireMenuChoice` throws `EINIT_HIRE_MENU_BAD_CHOICE`, re-present
  the menu (the user's selection did not match any available option, usually
  because they tried to pick `hire-all` / `select-some` on an empty menu).
- If `routeInitHireMenuChoice` throws `EINIT_HIRE_MENU_BAD_SELECTION` during
  `select-some`, surface the error and re-prompt for a valid subset of
  `menu.unhired`.
- If the user aborts the menu entirely, treat it as `skip` — never fall
  through silently to `create-new` without explicit consent.

The menu is **non-destructive**: it only reads the filesystem. Launching
`/aweek:hire` afterwards creates new state but is itself non-destructive (no
`.md` overwrites — adopt-on-collision is enforced inside `createNewSubagent`).
No additional `confirmed: true` gate is required for Step 6.

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
