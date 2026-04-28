# Recipe: A weekly operator

One agent. One budget. Five days. Sixteen scheduled tasks — the
real ops cycle of a solo founder, with a daily review that closes
each day and a weekly review that ties the week to the month's
goals.

This is the marquee aweek recipe. Build it first.

## Calendar

|        | Mon            | Tue        | Wed          | Thu       | Fri        |
|--------|----------------|------------|--------------|-----------|------------|
| **7am**  | Brief          | Outreach   | Interviews   | Roadmap   | —          |
| **9am**  | Inbox          | —          | —            | —         | Feedback   |
| **10am** | —              | Metrics    | —            | —         | —          |
| **11am** | —              | —          | Content      | Issues    | Numbers    |
| **3pm**  | —              | —          | —            | —         | Retro      |
| **5pm**  | Daily          | Daily      | Daily        | Daily     | Weekly     |

`Daily` is the end-of-day review (reads what shipped today, writes
what to revisit tomorrow). `Weekly` is the end-of-week review (reads
the week's daily reviews and outputs against monthly goals).

## Outputs

| Task | Output |
|------|--------|
| Brief        | `briefings/[week].md` |
| Inbox        | `inbox/[date].md` |
| Outreach     | `outreach/[date].md` |
| Metrics      | `metrics/[week].md` |
| Interviews   | `interviews/[date].md` |
| Content      | `posts/[slug].md` |
| Roadmap      | `roadmap/[week].md` |
| Issues       | `triage/[week].md` |
| Feedback     | `feedback/[week].md` |
| Numbers      | `metrics/cross-check-[week].md` |
| Retro        | `retros/[week].md` |
| Daily        | `daily/[date].md` |
| Weekly       | `reviews/[week].md` |

All sixteen runs share one weekly budget (~800k tokens). When
exhausted the agent pauses — clear via `/aweek:manage top-up`.

## Step 1. Hire the agent

```text
/aweek:hire
```

- **Slug:** `weekly-ops`
- **Name:** `weekly-ops`
- **System prompt:** "You are weekly-ops, a part-time operator for
  a solo founder. You handle the routine work that recurs every
  week so the founder can focus on the non-routine work. You read
  source artifacts in the repo, run `gh` for issues, and write
  Markdown files at the paths your weekly plan specifies. You write
  in a terse factual voice — no filler. Cite the source artifact
  for every claim. Never invent output paths. **Daily reviews** read
  today's outputs and produce tomorrow's punch list. **The weekly
  review** reads daily reviews + outputs against the monthly plan
  and flags strategy adjustments."

## Step 2. Set goals and strategies

`/aweek:plan` → **Edit plan.md**:

```md
# weekly-ops

## Long-term goals

- Ship the full weekly ops cycle every week without the founder
  having to remember any of the sixteen tasks.
- Each output is good enough to act on, not "good enough that I
  have to redo it."

## Monthly plans

### 2026-04

- All sixteen tasks land on time, every week.
- Friday's weekly review names 1+ strategy adjustment per month
  that the founder agrees with.

## Strategies

- **One source per claim.** Every line cites the source artifact.
- **Concision is the contract.** When in doubt, output less.
- **No improvised filenames.** Output paths are exactly what the
  plan specifies.
- **Reviews are reflective, not generative.** Daily / weekly
  reviews never invent new claims — they synthesize from the day's
  / week's existing outputs.
- **Compression rule** (when budget runs low): preserve the
  weekly review and Monday's brief. Drop content draft and the
  Tuesday metrics review first.

## Notes

- Inputs:
  - `inbox/` — manual mbox / copy-paste of the founder's email
  - `data/*.csv` — Stripe, Plausible, Posthog exports
  - `topics/queue.md` — content topics in priority order
  - `support/`, `nps/`, `calls/notes/`
- Schedule: see calendar above.
- Budget: 800k tokens/week.
```

## Step 3. Approve the weekly plan

`/aweek:plan` drafts all sixteen tasks at the times above. Review
and approve.

## Step 4. Watch the calendar

```bash
aweek serve
```

The dashboard shows the same grid you saw above, updating live as
the heartbeat ticks. Click any task to see its prompt, latest
output, status, and token spend.

## Why one agent, not sixteen specialists?

The tasks share a lot of context: the same week, the same business,
the same `plan.md`. One agent reads the source material once
(cached across tasks within a tick) and Friday's weekly review can
read across all of the week's outputs without delegation overhead.

Split when one task starts dominating the budget, when two tasks
need different voices, or when you want to pause one task while
the rest run.

## Multi-agent handoff

For tasks where one agent's output is another's input — say, a
researcher feeding a drafter who feeds an editor — use
`/aweek:delegate-task`. The sender doesn't block; the recipient
drains its inbox at the next heartbeat tick. Start with one
`weekly-ops`. Split when you need to.
