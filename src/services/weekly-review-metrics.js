/**
 * Metrics aggregation for the weekly review Metrics section.
 * Collects task counts, token usage, and delegation stats from the
 * existing store layer and formats them as structured data + markdown.
 *
 * Data sources:
 *   - ActivityLogStore.summary()  → task counts by status, total duration
 *   - UsageStore.weeklyTotal()    → token consumption (input/output/total/cost)
 *   - InboxStore.load()           → delegation stats (sent & received)
 *   - WeeklyPlanStore (optional)  → planned-vs-completed task ratio
 */

import { formatDuration } from './weekly-review-generator.js';

// ---------------------------------------------------------------------------
// Task metrics
// ---------------------------------------------------------------------------

/**
 * Compute task-level metrics from an activity log summary and optional plan.
 * @param {object} activitySummary - From ActivityLogStore.summary()
 * @param {object|null} [weeklyPlan] - From WeeklyPlanStore.load() (optional)
 * @returns {object} Task counts
 */
export function computeTaskMetrics(activitySummary, weeklyPlan = null) {
  const byStatus = activitySummary?.byStatus || {};

  const completed = byStatus.completed || 0;
  const failed = byStatus.failed || 0;
  const skipped = byStatus.skipped || 0;
  const started = byStatus.started || 0;
  const delegated = byStatus.delegated || 0;

  const totalExecuted = completed + failed + skipped + delegated;

  // Plan-based metrics (if plan available)
  let planned = 0;
  let pending = 0;
  let completionRate = null;

  if (weeklyPlan && Array.isArray(weeklyPlan.tasks)) {
    planned = weeklyPlan.tasks.length;
    pending = weeklyPlan.tasks.filter(
      (t) => t.status === 'pending' || t.status === 'ready'
    ).length;
    completionRate = planned > 0 ? Math.round((completed / planned) * 100) : 0;
  }

  return {
    completed,
    failed,
    skipped,
    started,
    delegated,
    totalExecuted,
    planned,
    pending,
    completionRate,
    totalDurationMs: activitySummary?.totalDuration || 0,
  };
}

// ---------------------------------------------------------------------------
// Token usage metrics
// ---------------------------------------------------------------------------

/**
 * Compute token usage metrics from a usage store weekly total.
 * @param {object} usageTotal - From UsageStore.weeklyTotal()
 * @returns {object} Token usage metrics
 */
export function computeTokenMetrics(usageTotal) {
  if (!usageTotal) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      sessionCount: 0,
    };
  }

  return {
    inputTokens: usageTotal.inputTokens || 0,
    outputTokens: usageTotal.outputTokens || 0,
    totalTokens: usageTotal.totalTokens || 0,
    costUsd: usageTotal.costUsd || 0,
    sessionCount: usageTotal.recordCount || 0,
  };
}

// ---------------------------------------------------------------------------
// Delegation metrics
// ---------------------------------------------------------------------------

/**
 * Compute delegation stats from inbox messages.
 * Looks at both received messages (this agent's inbox) and sent messages
 * (this agent as `from` in other agents' inboxes).
 *
 * @param {object[]} receivedMessages - Messages in this agent's inbox
 * @param {object[]} sentMessages - Messages sent by this agent (from other inboxes)
 * @returns {object} Delegation stats
 */
export function computeDelegationMetrics(
  receivedMessages = [],
  sentMessages = []
) {
  const received = {
    total: receivedMessages.length,
    pending: 0,
    accepted: 0,
    completed: 0,
    rejected: 0,
  };

  for (const msg of receivedMessages) {
    if (received[msg.status] !== undefined) {
      received[msg.status]++;
    }
  }

  const sent = {
    total: sentMessages.length,
    pending: 0,
    accepted: 0,
    completed: 0,
    rejected: 0,
  };

  for (const msg of sentMessages) {
    if (sent[msg.status] !== undefined) {
      sent[msg.status]++;
    }
  }

  return { received, sent };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a number with thousands separators.
 * @param {number} n
 * @returns {string}
 */
export function formatNumber(n) {
  if (n == null) return '0';
  return n.toLocaleString('en-US');
}

/**
 * Format USD cost with appropriate precision.
 * @param {number} usd
 * @returns {string}
 */
export function formatCost(usd) {
  if (!usd || usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Format a percentage with optional suffix.
 * @param {number|null} pct
 * @returns {string}
 */
export function formatPercent(pct) {
  if (pct == null) return 'N/A';
  return `${pct}%`;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * Format the Metrics section of a weekly review as markdown.
 *
 * @param {object} metrics - Combined metrics object
 * @param {object} metrics.tasks - From computeTaskMetrics
 * @param {object} metrics.tokens - From computeTokenMetrics
 * @param {object} metrics.delegation - From computeDelegationMetrics
 * @returns {string} Markdown content for the Metrics section
 */
export function formatMetricsSection(metrics) {
  const { tasks, tokens, delegation } = metrics;
  const lines = [];

  lines.push('## Metrics');
  lines.push('');

  // --- Task Metrics ---
  lines.push('### Task Execution');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Completed | ${tasks.completed} |`);
  lines.push(`| Failed | ${tasks.failed} |`);
  lines.push(`| Skipped | ${tasks.skipped} |`);
  lines.push(`| Delegated | ${tasks.delegated} |`);
  lines.push(`| Total executed | ${tasks.totalExecuted} |`);

  if (tasks.planned > 0) {
    lines.push(`| Planned | ${tasks.planned} |`);
    lines.push(`| Pending | ${tasks.pending} |`);
    lines.push(`| Completion rate | ${formatPercent(tasks.completionRate)} |`);
  }

  if (tasks.totalDurationMs > 0) {
    lines.push(
      `| Total execution time | ${formatDuration(tasks.totalDurationMs)} |`
    );
  }

  lines.push('');

  // --- Token Usage ---
  lines.push('### Token Usage');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Input tokens | ${formatNumber(tokens.inputTokens)} |`);
  lines.push(`| Output tokens | ${formatNumber(tokens.outputTokens)} |`);
  lines.push(`| Total tokens | ${formatNumber(tokens.totalTokens)} |`);
  lines.push(`| Estimated cost | ${formatCost(tokens.costUsd)} |`);
  lines.push(`| Sessions | ${tokens.sessionCount} |`);
  lines.push('');

  // --- Delegation ---
  const hasReceived = delegation.received.total > 0;
  const hasSent = delegation.sent.total > 0;

  if (hasReceived || hasSent) {
    lines.push('### Delegation');
    lines.push('');

    if (hasReceived) {
      lines.push('**Received tasks:**');
      lines.push('');
      lines.push(`| Status | Count |`);
      lines.push(`| --- | --- |`);
      lines.push(`| Total | ${delegation.received.total} |`);
      lines.push(`| Completed | ${delegation.received.completed} |`);
      lines.push(`| Accepted | ${delegation.received.accepted} |`);
      lines.push(`| Pending | ${delegation.received.pending} |`);
      lines.push(`| Rejected | ${delegation.received.rejected} |`);
      lines.push('');
    }

    if (hasSent) {
      lines.push('**Sent tasks:**');
      lines.push('');
      lines.push(`| Status | Count |`);
      lines.push(`| --- | --- |`);
      lines.push(`| Total | ${delegation.sent.total} |`);
      lines.push(`| Completed | ${delegation.sent.completed} |`);
      lines.push(`| Accepted | ${delegation.sent.accepted} |`);
      lines.push(`| Pending | ${delegation.sent.pending} |`);
      lines.push(`| Rejected | ${delegation.sent.rejected} |`);
      lines.push('');
    }
  } else {
    lines.push('### Delegation');
    lines.push('');
    lines.push('_No delegation activity this week._');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Aggregation orchestrator
// ---------------------------------------------------------------------------

/**
 * Aggregate all metrics for a weekly review.
 * Orchestrates data collection from stores and returns both structured
 * metrics data and rendered markdown.
 *
 * @param {object} deps - Injected store dependencies
 * @param {object} deps.activityLogStore - ActivityLogStore instance
 * @param {object} deps.usageStore - UsageStore instance
 * @param {object} deps.inboxStore - InboxStore instance
 * @param {object} [deps.weeklyPlanStore] - WeeklyPlanStore instance (optional)
 * @param {object} [deps.agentStore] - AgentStore instance (optional, for sent-delegation lookup)
 * @param {string} agentId - Agent to aggregate metrics for
 * @param {string} weekMonday - Monday date string (YYYY-MM-DD) for the review period
 * @param {object} [opts]
 * @param {string} [opts.week] - ISO week string (YYYY-Www) for plan lookup
 * @returns {Promise<{ metrics: object, markdown: string }>}
 */
export async function aggregateWeeklyMetrics(
  { activityLogStore, usageStore, inboxStore, weeklyPlanStore, agentStore },
  agentId,
  weekMonday,
  opts = {}
) {
  // 1. Task metrics — from activity log + optional plan
  const activitySummary = await activityLogStore.summary(agentId, weekMonday);

  let weeklyPlan = null;
  if (weeklyPlanStore && opts.week) {
    try {
      weeklyPlan = await weeklyPlanStore.load(agentId, opts.week);
    } catch {
      // Plan may not exist — that's OK
    }
  }

  const taskMetrics = computeTaskMetrics(activitySummary, weeklyPlan);

  // 2. Token usage — from usage store
  let usageTotal = null;
  try {
    usageTotal = await usageStore.weeklyTotal(agentId, weekMonday);
  } catch {
    // Usage data may not exist — that's OK
  }

  const tokenMetrics = computeTokenMetrics(usageTotal);

  // 3. Delegation — from inbox store
  let receivedMessages = [];
  try {
    receivedMessages = await inboxStore.load(agentId);
  } catch {
    // Inbox may not exist — that's OK
  }

  // Sent messages: scan other agents' inboxes for messages from this agent
  let sentMessages = [];
  if (agentStore) {
    try {
      const allAgents = await agentStore.list();
      for (const otherAgentId of allAgents) {
        if (otherAgentId === agentId) continue;
        try {
          const otherInbox = await inboxStore.load(otherAgentId);
          const fromThisAgent = otherInbox.filter(
            (msg) => msg.from === agentId
          );
          sentMessages.push(...fromThisAgent);
        } catch {
          // Other agent's inbox may not exist
        }
      }
    } catch {
      // Agent listing may fail
    }
  }

  const delegationMetrics = computeDelegationMetrics(
    receivedMessages,
    sentMessages
  );

  // Combine
  const metrics = {
    weekMonday,
    agentId,
    tasks: taskMetrics,
    tokens: tokenMetrics,
    delegation: delegationMetrics,
  };

  const markdown = formatMetricsSection(metrics);

  return { metrics, markdown };
}
