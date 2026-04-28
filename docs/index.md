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
      link: /getting-started
    - theme: alt
      text: Slash commands
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
    details: Slash commands for hire, plan, calendar, summary, manage. No new UI — your terminal is the dashboard.
---

## Who it's for

- Founders running their own ops who can't keep up with weekly cadence
- Marketers and creators publishing on a schedule (blog → social → newsletter)
- Analysts and researchers running weekly digests, briefs, or memos
- Anyone whose week looks a lot like last week's

## What you can build

| Team | Cadence | What it does |
|------|---------|--------------|
| **Content team** | Publish weekly, distribute daily | 2 blog posts a week, atomized into ~10 social posts, a thread, and a newsletter. Multi-agent handoff: research → draft → editor → distributor. |
| **Competitive intel team** | Brief every Monday | Agents scan ~10 competitors' releases, blogs, pricing, changelogs. Hand back a Monday brief — diffs vs. last week visible at a glance. |
| **Customer feedback team** | Synthesis weekly | Agents read the week's tickets, NPS comments, and call notes. Draft a Friday memo — themes, regressions, top requests, suggested experiments. |
