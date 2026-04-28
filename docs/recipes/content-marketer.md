# Recipe: A content marketer

One agent. One budget. Five days. Sixteen scheduled tasks — the
full content marketing cycle, run on its own calendar with daily
reviews and a Friday weekly review.

The agent **never auto-publishes.** Every output is a Markdown file
the human reviews and ships.

## Calendar

|        | Mon          | Tue        | Wed          | Thu          | Fri              |
|--------|--------------|------------|--------------|--------------|------------------|
| **7am**  | Topic queue  | Audience   | Source check | Newsletter   | —                |
| **9am**  | Content scan | —          | —            | —            | Analytics        |
| **10am** | —            | Post draft | —            | —            | —                |
| **11am** | —            | —          | Atomize      | A/B subjects | Topic selection  |
| **3pm**  | —            | —          | —            | —            | Retro            |
| **5pm**  | Daily        | Daily      | Daily        | Daily        | Weekly           |

`Daily` is the end-of-day review (today's drafts, what shipped to
the human, what's stalled). `Weekly` is the end-of-week review
against the month's content goals.

## Outputs

| Task | Output |
|------|--------|
| Topic queue       | `topics/queue.md` (updates) |
| Content scan      | `briefings/content-[week].md` |
| Audience          | `audience/[week].md` |
| Post draft        | `posts/[slug].md` |
| Source check      | `sources/[slug].md` |
| Atomize           | `social/[week].md` |
| Newsletter        | `newsletter/[week].md` |
| A/B subjects      | `newsletter/subjects-[week].md` |
| Analytics         | `analytics/[week].md` |
| Topic selection   | `topics/next-week.md` |
| Retro             | `retros/content-[week].md` |
| Daily             | `daily/content-[date].md` |
| Weekly            | `reviews/content-[week].md` |

All sixteen runs share one weekly budget (~700k tokens).

## Step 1. Hire the agent

```text
/aweek:hire
```

- **Slug:** `content-marketer`
- **Name:** `content-marketer`
- **System prompt:** "You are content-marketer, a part-time content
  marketing teammate. You read the topic queue, last week's
  analytics, and source material; you draft posts, social
  atomizations, and newsletter sections. Every output is a Markdown
  file the human reviews and ships — **you never auto-publish.**
  You write in the founder's voice (see `voice-guide.md`). Cite a
  source for every claim. When in doubt, draft less. Atomization
  preserves the post's specific claims — never paraphrase into
  vague brand-speak. **Daily reviews** name what drafts moved, what
  the human shipped, and what's stuck. **The weekly review** reads
  the week's outputs against the month's content goals."

## Step 2. Set goals and strategies

`/aweek:plan` → **Edit plan.md**:

```md
# content-marketer

## Long-term goals

- Ship one polished post per week, every week.
- Maintain a topic queue that always has 4+ ready-to-go ideas with
  source material attached.
- Each post produces a coherent social atomization and one
  newsletter section without re-research.

## Monthly plans

### 2026-04

- 4 posts shipped on time.
- Friday analytics review surfaces 1+ insight that changes next
  month's topic mix.
- The weekly review names 1+ strategy adjustment per month.

## Strategies

- **Voice is fixed.** See `voice-guide.md`. Don't improvise tone.
- **Every claim cites a source.** No floating assertions.
- **Atomization preserves specifics.** A social post that
  paraphrases into "we believe in ..." has lost the post's signal.
- **Reviews are reflective, not generative.** Daily / weekly
  reviews synthesize from existing outputs; they don't draft new
  content.
- **Compression rule** (when budget runs low): preserve the post
  draft and the weekly review. Drop A/B subjects, then atomization.

## Notes

- Inputs:
  - `topics/queue.md` — topic ideas in priority order
  - `data/analytics-export.csv` — last week's performance data
  - `voice-guide.md` — voice + style rules
  - source material under `research/`
- Schedule: see calendar above.
- Budget: 700k tokens/week.
```

## Step 3. Approve the weekly plan

`/aweek:plan` drafts all sixteen tasks at the times above. Review
and approve.

## Step 4. Read and ship

By Tuesday afternoon `posts/[slug].md` is ready for human edit and
ship. By Wednesday the social atomization queues into your
scheduler. By Thursday the newsletter goes out. The weekly review
on Friday evening tells you whether the week moved the monthly
goals.

## Why one agent, not sixteen specialists?

The post, social, newsletter, and A/B subjects all draw from the
same week's research. One agent keeps that context in one
`plan.md` and one budget. Splitting means duplicating the topic
queue and balancing budgets across roles.

Split when the post and social need genuinely different voices
(e.g., long-form thoughtful vs. punchy native), or when one
channel grows large enough that its budget should be isolated.

## Multi-agent handoff

For high-volume content teams, split the post task into a research
→ draft → edit pipeline using `/aweek:delegate-task`. The
`content-marketer` becomes the editor at the end of the chain,
producing the social atomization and newsletter once the post is
locked.
