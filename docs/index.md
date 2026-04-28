---
layout: home

hero:
  name: aweek
  text: A team that runs the week.
  tagline: Claude Code is the doer. aweek is the planner. Hire AI agents, give them weekly plans and a token budget, then walk away.
  image:
    src: /aweek.png
    alt: aweek weekly calendar rendered in Claude Code
  actions:
    - theme: brand
      text: Get started
      link: /install
    - theme: alt
      text: Skills
      link: /skills
    - theme: alt
      text: View on GitHub
      link: https://github.com/runbear-io/aweek

features:
  - title: Weekly cadence, not one-off prompts
    details: Long-term goals, monthly plans, weekly tasks. Plans evolve every Monday based on what shipped last week.
  - title: Per-agent token budgets
    details: A weekly cap per agent. When it runs out, the agent pauses until you resume or top up — no surprise spend.
  - title: Plain files, no database
    details: Identity in .claude/agents/[slug].md, scheduling in .aweek/agents/[slug].json. Schema-validated, atomic, 2,000+ tests.
  - title: One heartbeat, many agents
    details: A 10-minute launchd tick wakes each agent in turn, drains their inbox, picks the next due task, and records token usage.
  - title: Agents hand off to each other
    details: /aweek:delegate-task drops work into another agent's inbox. Build research → draft → editor → distributor pipelines.
  - title: Lives inside Claude Code
    details: Skills for hire, plan, calendar, summary, manage — invoked via /aweek:[name]. No new UI; your terminal is the dashboard.
---

## Who it's for

- Founders running their own ops who can't keep up with weekly cadence
- Marketers and creators publishing on a schedule (blog → social → newsletter)
- Analysts and researchers running weekly digests, briefs, or memos
- Anyone whose week looks a lot like last week's

## What you can build

A single agent on a calendar — sixteen scheduled tasks across five
days, a daily review that closes each day, and a weekly review
that ties the week to the month's goals. One budget, one
cumulative `plan.md`, fresh Markdown in your repo every week.

|        | Mon            | Tue        | Wed          | Thu       | Fri        |
|--------|----------------|------------|--------------|-----------|------------|
| **7am**  | Brief          | Outreach   | Interviews   | Roadmap   | —          |
| **9am**  | Inbox          | —          | —            | —         | Feedback   |
| **10am** | —              | Metrics    | —            | —         | —          |
| **11am** | —              | —          | Content      | Issues    | Numbers    |
| **3pm**  | —              | —          | —            | —         | Retro      |
| **5pm**  | Daily          | Daily      | Daily        | Daily     | Weekly     |

[**Full recipe → A weekly operator**](/recipes/weekly-ops)

### Other agent templates

- [**An engineer**](/recipes/engineer) — handles the engineering
  periphery: PR triage, dep drift, flaky tests, doc drift, retros.
  Never ships features.
- [**A content marketer**](/recipes/content-marketer) — grooms the
  topic queue, drafts the post, atomizes it for social, writes the
  newsletter, reviews analytics.
