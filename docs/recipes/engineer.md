# Recipe: An engineer

One agent. One budget. Five days. Sixteen scheduled tasks — the
routine engineering periphery the team never has time for, run on
its own calendar with daily reviews and a Friday weekly review.

This agent **does not ship features.** Autonomous coding is risky;
that's the human team's job. The agent reads, surfaces, and
proposes work items.

## Calendar

|        | Mon          | Tue          | Wed          | Thu          | Fri          |
|--------|--------------|--------------|--------------|--------------|--------------|
| **7am**  | PR triage    | Dep scan     | Flaky tests  | Doc drift    | —            |
| **9am**  | Issue triage | —            | —            | —            | Tech debt    |
| **10am** | —            | Coverage     | —            | —            | —            |
| **11am** | —            | —            | Perf scan    | Sec scan     | Sprint draft |
| **3pm**  | —            | —            | —            | —            | Retro        |
| **5pm**  | Daily        | Daily        | Daily        | Daily        | Weekly       |

`Daily` is the end-of-day review (today's merged PRs, deploys,
incidents, blocked items). `Weekly` is the end-of-week review
against the month's engineering goals.

## Outputs

| Task | Output |
|------|--------|
| PR triage     | `triage/prs-[week].md` |
| Issue triage  | `triage/issues-[week].md` |
| Dep scan      | `deps/[week].md` |
| Coverage      | `coverage/[week].md` |
| Flaky tests   | `tests/flaky-[week].md` |
| Perf scan     | `perf/[week].md` |
| Doc drift     | `docs-drift/[week].md` |
| Sec scan      | `security/[week].md` |
| Tech debt     | `debt/[week].md` |
| Sprint draft  | `sprints/next-week.md` |
| Retro         | `retros/eng-[week].md` |
| Daily         | `daily/eng-[date].md` |
| Weekly        | `reviews/eng-[week].md` |

All sixteen runs share one weekly budget (~700k tokens).

## Step 1. Hire the agent

```text
aweek hire
```

- **Slug:** `engineer`
- **Name:** `engineer`
- **System prompt:** "You are engineer, a part-time engineering
  teammate. You handle the routine periphery: PR review queue
  health, dependency drift, flaky-test surfacing, performance
  regressions, doc drift, security advisories, and weekly retros.
  You read git history, `gh` issues and PRs, CI logs, and the
  codebase. You write factual one-line summaries with PR / commit
  / issue links. **You never propose or write code changes** — you
  propose lists of work items the human team should consider,
  ranked by priority. **Daily reviews** name what merged, what
  broke, and what's stuck. **The weekly review** reads daily
  reviews + outputs against the month's engineering goals."

## Step 2. Set goals and strategies

`aweek plan` → **Edit plan.md**:

```md
# engineer

## Long-term goals

- Keep the open-PR queue at ≤ N at the start of every week.
- Flag every dependency with a new security advisory within one
  week of disclosure.
- Catch 3+ doc-drift items per month before users hit them.

## Monthly plans

### 2026-04

- All sixteen tasks land on time, every week.
- The Friday sprint draft averages ≥ 5 actionable items the team
  commits to in standup.
- The weekly review names 1+ strategy adjustment per month.

## Strategies

- **Cite the artifact.** Every claim links to a PR, commit, issue,
  or CI run.
- **No code, only work items.** The output is always a list of
  things the team should consider — never a patch or proposed diff.
- **Group by area, not author.** Backend / SPA / infra / docs.
- **Reviews are reflective, not generative.** Daily / weekly
  reviews synthesize from existing outputs; they don't propose
  new work.
- **Compression rule** (when budget runs low): preserve PR triage,
  the Friday sprint draft, and the weekly review. Drop coverage,
  perf scan, and doc drift first.

## Notes

- Repo: <org/repo>
- CI logs: <link or local path>
- Output dirs: see Outputs table above.
- Schedule: see calendar above.
- Budget: 700k tokens/week.
```

## Step 3. Approve the weekly plan

`aweek plan` drafts all sixteen tasks at the times above. Review
and approve.

## Step 4. Read on Monday

The team reads `triage/prs-[week].md`, `triage/issues-[week].md`,
and `sprints/next-week.md` before Monday standup. The weekly review
informs the team's monthly retrospective.

## Why one agent, not sixteen specialists?

The tasks share the repo, the team, and the recent commits. One
agent reads `git log` and the codebase once per tick (cached) and
Friday's reviews can read across all of the week's outputs without
delegation overhead.

Split when one area's signal-to-noise is so different that it
needs its own system prompt (security advisories often qualify),
or when two repos have separate budgets that shouldn't cross.

## Multi-agent handoff

For organizations with multiple repos, hire one `engineer-[repo]`
per repo and use `aweek delegate-task` to roll their outputs up to
a single `engineer-rollup` agent that drafts a fleet-wide retro
every Friday.
