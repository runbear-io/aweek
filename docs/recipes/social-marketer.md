# Recipe: Social marketer

A worked example for a one-agent setup that posts and replies on X
and Reddit, runs on a Mon–Fri 9–5 window, and hits weekly engagement
goals.

This is the simplest credible aweek setup: **one agent, one schedule,
one budget.** Once it's running, you can grow it into a multi-agent
pipeline — see [Going further](#going-further) at the bottom.

## What this agent does

- **Net +500 X followers / month**
- **3 viral replies / month** (50+ engagements each)
- **A weekly cadence:** ~10 X replies, ~5 Reddit replies, 2–3 X posts,
  3 Reddit posts — distributed across the week
- **Weekly token budget cap** (~500k), auto-pausing the agent if
  exceeded

## Step 1. Hire the agent

```text
/aweek:hire
```

- **Slug:** `social-marketer`
- **Name:** `social-marketer`
- **System prompt:** developer-relations agent for a developer-tools
  SaaS. Targets backend / devops / platform engineers on X and a
  curated set of subreddits. Voice is direct and technical — replies
  with substance, never sounds like a brand account.

aweek writes two files:

- `.claude/agents/social-marketer.md` — Claude Code subagent
  (identity, source of truth)
- `.aweek/agents/social-marketer.json` — scheduling state (goals,
  budget, plan pointers)

## Step 2. Set goals and strategies

```text
/aweek:plan
```

Pick **Edit plan.md** and paste this skeleton:

```md
# social-marketer

## Long-term goals

- Establish `social-marketer` as a recognized voice among backend,
  devops, and platform engineers on X.com and a curated set of
  Reddit communities.

## Monthly plans

### 2026-04

Through 2026-05-20:

- **+500 X.com followers** net.
- **3 viral replies** — reply threads with 50+ engagements each.

## Strategies

- **Growth-first, X primary.** X is the primary channel; Reddit is
  secondary and supports audience breadth.
- **Engagement > volume.** Replies drive the viral-reply goal —
  protect them during compression.
- **Compression rule** (when budget caps or holidays hit):
  `replies > posts` and `X > Reddit`. Drop original posts before
  replies; drop Reddit before X.
- **Operating window.** Mon–Fri 9am–5pm America/Los_Angeles. X posts
  stagger across the morning peak; Reddit replies cluster at lunch
  and afternoon.

## Notes

- Product context: a developer-tools SaaS targeting backend / devops
  / platform engineers.
- Budget: 500k tokens/week.
```

## Step 3. Approve the weekly plan

The same `/aweek:plan` flow drafts a weekly task list from your
`plan.md`. Review it, approve it. Until you approve, the heartbeat
is a no-op for this agent.

## Step 4. Watch the dashboard

```bash
aweek serve
```

The agent's calendar, activity log, strategy preview, and live token
usage are all in the SPA at `http://localhost:3000`.

## Going further

Once `social-marketer` is humming, hire a few more agents and use
`/aweek:delegate-task` to chain them:

```text
researcher → drafter → editor → social-marketer
   |            |         |              |
 reads      writes    polishes      posts +
sources   long-form    drafts        replies
```

Each handoff is a one-line `/aweek:delegate-task`. The sender doesn't
block — the recipient drains its inbox on its next heartbeat tick.

The pattern: each agent owns one job, has its own budget, and can be
paused or replaced independently.
