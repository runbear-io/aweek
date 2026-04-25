---
name: calendar
description: Display an agent's weekly plan as a calendar grid with day columns and hour rows
trigger: aweek calendar, weekly calendar, plan calendar, show calendar, agent calendar
---

# aweek:calendar

Display an agent's weekly plan as a calendar grid with day columns and hour rows. Tasks are numbered so users can ask about any task by number.

## Instructions

You MUST follow this exact workflow when this skill is invoked.

### Step 1: Select an Agent

List all available agents:

```bash
aweek exec calendar listAgentsForCalendar
```

The call returns a JSON array of `{ id, name, role }` records. Treat an
empty array as the no-agents case.

- If no agents exist, inform the user: "No agents found. Use /aweek:hire to create one first." and stop.
- If only one agent exists, auto-select it.
- If multiple agents exist, ask the user to pick one using AskUserQuestion.

### Step 2: Render the Calendar Grid

The default output is a **GitHub-flavored markdown table** (`format: "markdown"`).
Claude Code's terminal UI re-flows pipe tables to the available width, so the
calendar expands / contracts with the window instead of sitting in a fixed
120-column box. Pass `format: "box"` only when the host cannot render markdown
tables (e.g. raw log tails) — the Unicode box-drawing grid still works but its
columns are fixed.

Run the grid renderer to get the calendar text and task index:

```bash
echo '{
  "agentId": "<AGENT_ID>",
  "opts": {
    "format": "markdown",
    "startHour": 9,
    "endHour": 18,
    "showWeekend": false,
    "spread": "spread"
  }
}' | aweek exec calendar loadAndRenderGrid --input-json -
```

The response JSON contains `success`, `output` (the rendered grid text),
`taskIndex` (the numbered task list), and `errors` when `success === false`.

**IMPORTANT — Not collapsed display:** After running the command, you MUST
output the calendar text as direct text in your response — for `format: "markdown"`,
paste the markdown table itself (no surrounding code block, so the UI renders
it as a table); for `format: "box"`, wrap `result.output` in a fenced code
block so the Unicode borders don't reflow. Do NOT just reference the bash
output — copy `result.output` and display it yourself so it appears expanded,
not collapsed inside a bash result.

### Step 3: Stop (no follow-up question)

The rendered grid already ends with `Select a task number (1-N) to see details.`
— that is the only prompt the user needs. Do **not** emit an `AskUserQuestion`,
a "What would you like to do?" menu, an adjust-view picker, or any other
interactive step after displaying the calendar. Just end your turn.

Keep `result.taskIndex` in mind for the follow-up turn: if the user later
types a task number (or asks about a specific task), look it up there and
respond with its details. Do not volunteer that lookup until asked.

## Render Options

| Option | Default | Description |
|--------|---------|-------------|
| `format` | `markdown` | `markdown` (responsive pipe table — default) or `box` (fixed-width Unicode grid) |
| `startHour` | 9 | First hour row (0-23) |
| `endHour` | 18 | Last hour row exclusive (1-24) |
| `terminalWidth` | — | **Box format only.** Available terminal columns; auto-fits `cellWidth` when set |
| `cellWidth` | auto | **Box format only.** Explicit per-day column width. Overrides `terminalWidth` |
| `showWeekend` | false | Include Saturday and Sunday columns |
| `spread` | `pack` | Distribution: `pack` (fill days) or `spread` (round-robin) |

## How It Works

- Tasks are numbered in column-major order (top-to-bottom per day, then the next day) for selection
- **Review slots** (daily-review and weekly-review) receive selection numbers identical to regular work tasks — you can select them by number and apply status transitions (`pending`, `in-progress`, `completed`, `failed`, `skipped`) exactly the same way
- Each hour row is as tall as its fullest cell. Every task gets its own block of wrapped lines inside the cell; empty cells pad with blanks to line up.
- Each task displays up to **30 visible characters** (`<icon> <num>. <description>`). Anything beyond collapses with a trailing `…`. Those 30 chars wrap across cell lines based on column width — narrow columns just use more rows.
- Half-hour tasks (e.g. `runAt` at `HH:30`) bucket into the same `HH:00` cell as `HH:00` tasks, so they don't disappear from the view.
- Status icons show progress: ○ pending, ► in-progress, ✓ completed, ✗ failed; ◆ marks review slots (also selectable by number)
- The calendar is displayed as direct text (not bash output) so it's always visible
- **Time zone:** day columns and hour rows reflect the user's configured time zone in `.aweek/config.json` (`timeZone`). `runAt` is stored as an absolute UTC ISO string, projected into that zone for display. Update the config file to switch zones; no per-agent override yet.

## Related Skills

- `/aweek:plan` — Edit weekly plans (add/remove tasks, adjust goals, approve/reject)
- `/aweek:summary` — Dashboard view across all agents
- `/aweek:hire` — Create a new agent with identity, goals, and initial plan

## Data Directory

Agents are stored in `.aweek/agents/<agent-id>.json` relative to the project root.
