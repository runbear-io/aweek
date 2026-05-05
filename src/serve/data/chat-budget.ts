/**
 * Chat-side budget gate.
 *
 * Sub-AC 2 of AC 7: enforce budget exhaustion server-side in the chat
 * SSE endpoint. This module owns the *pre-flight* check that runs
 * before `handleChatStream` invokes the Anthropic Agent SDK.
 *
 * The contract:
 *   - Resolves the agent's weekly token budget from the agent config.
 *   - Reads the current week's total token usage from `UsageStore`
 *     (the same store the heartbeat budget enforcer reads). Chat usage
 *     is recorded into this store via {@link recordChatUsage}, so
 *     heartbeat- and chat-driven spend share one weekly pool per agent.
 *   - When `usage >= budget` OR `config.budget.paused === true` AND the
 *     pause is budget-driven, returns an `exhausted` verdict so the
 *     chat handler can short-circuit with a structured `budget_exhausted`
 *     SSE frame.
 *
 * Why a separate module:
 *   - `chat-usage.ts` is the *write* side (record token spend);
 *     `chat-budget.ts` is the *read* side (gate new turns). Keeping the
 *     concerns split makes the unit-test surface tractable and lets
 *     unit tests stub each side independently.
 *   - The chat handler in `server.ts` is already thick. Putting the
 *     budget arithmetic in a dedicated, pure module keeps the handler
 *     focused on transport + lifecycle concerns and makes it cheap to
 *     swap the resolver for a fake in tests.
 *
 * In-flight semantics: this gate runs **before** SDK invocation. Once
 * a turn is in flight, it is allowed to finish streaming (per the AC
 * 7 contract: "in-flight assistant turn must finish streaming before
 * budget cutoff applies"). The next chat turn submitted after that
 * one's tokens are recorded will see the budget exhausted and be
 * rejected here.
 *
 * @module serve/data/chat-budget
 */

import { join } from 'node:path';

import {
  getMondayDate,
  type UsageStore,
  type UsageWeeklyTotal,
} from '../../storage/usage-store.js';
import { AgentStore } from '../../storage/agent-store.js';
import { UsageStore as UsageStoreImpl } from '../../storage/usage-store.js';

/**
 * Loose duck-typed shape mirroring `BudgetAgentConfig` in
 * `services/budget-enforcer.ts`. Kept local so this module does not
 * depend on the heavier heartbeat-side enforcer surface — chat needs
 * only the budget read path, not the pause / alert / notification
 * write path that lives over there.
 */
export interface ChatBudgetAgentConfig {
  id?: string;
  weeklyTokenBudget?: number;
  budget?: {
    weeklyTokenLimit?: number;
    paused?: boolean;
    pausedReason?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Minimal agent-store seam — read-only, returns the per-slug agent
 * config. The chat handler injects a real `AgentStore` instance in
 * production; tests can stub this with an in-memory fake.
 */
export interface ChatBudgetAgentStoreLike {
  /**
   * Load the agent's persisted config. Returns `unknown` so the gate
   * does not depend on the strict `Agent` schema type — the gate only
   * needs the loose budget-related fields described by
   * {@link ChatBudgetAgentConfig}, which is structurally compatible
   * with the real `Agent` shape.
   */
  load: (agentId: string) => Promise<unknown>;
}

/**
 * Minimal usage-store seam — only `weeklyTotal` is needed. The chat
 * handler reuses the same `UsageStore` instance it later writes
 * through {@link recordChatUsage}, so the gate sees the freshest
 * weekly pool.
 */
export interface ChatBudgetUsageStoreLike {
  weeklyTotal: (
    agentId: string,
    weekMonday?: string,
  ) => Promise<UsageWeeklyTotal>;
}

/** Inputs accepted by {@link checkChatBudget}. */
export interface CheckChatBudgetOptions {
  /** Agent slug to check. */
  agentId: string;
  /** Read-only agent-config store. */
  agentStore: ChatBudgetAgentStoreLike;
  /** Read-only weekly-usage store. */
  usageStore: ChatBudgetUsageStoreLike;
  /**
   * Override the budget-week key. Defaults to the current Monday in
   * UTC (matching {@link getMondayDate}'s default). Production callers
   * leave unset; tests pin a deterministic week.
   */
  weekMonday?: string;
}

/**
 * Verdict returned by {@link checkChatBudget}.
 *
 * `allowed: true`  → the chat handler may invoke the Agent SDK.
 * `allowed: false` → the handler must short-circuit with a
 * `budget_exhausted` SSE frame and close the stream cleanly.
 *
 * The structured payload is identical in both cases so the SPA can
 * render a consistent budget chip whether or not the turn ran.
 */
export interface ChatBudgetVerdict {
  /** Whether the chat turn is allowed to proceed. */
  allowed: boolean;
  /** Reason code (currently only `budget_exhausted`). */
  reason: 'budget_exhausted' | null;
  /** Agent slug. */
  agentId: string;
  /** ISO week-Monday key the verdict was computed against. */
  weekMonday: string;
  /** Total tokens consumed this week. */
  used: number;
  /** Weekly token limit (0 when no limit is configured). */
  budget: number;
  /** Tokens remaining (clamped to 0). */
  remaining: number;
  /**
   * `true` when the agent's stored config flag indicates a budget
   * pause. Independent from `used >= budget` so a manually-paused
   * agent (top-up cleared but operator left it paused) can still
   * surface a paused verdict to the UI.
   */
  paused: boolean;
}

/** Returned to the SSE writer when {@link checkChatBudget} blocks a turn. */
export interface BudgetExhaustedSseFrame {
  type: 'budget-exhausted';
  reason: 'budget_exhausted';
  agentId: string;
  weekMonday: string;
  used: number;
  budget: number;
  remaining: number;
  paused: boolean;
  /**
   * Human-readable line the SPA can show inline (mirrors the alert
   * file's `message` field but is computed fresh so the SPA does not
   * have to read the alert file directly).
   */
  message: string;
}

/**
 * Compute the budget verdict for a single chat turn.
 *
 * Pure(ish) — performs two reads (`agentStore.load` + `usageStore.weeklyTotal`)
 * and no writes. Safe to call from the chat hot path; the writes
 * (pausing the agent / writing the alert flag) are owned by the
 * heartbeat-side `BudgetEnforcer`. Chat only needs to know whether to
 * accept this turn.
 *
 * Failure modes:
 *   - Agent config missing or unreadable → re-throws so the chat
 *     handler can map to a structured error frame. We never
 *     fail-open here: if we cannot read the budget, we cannot prove
 *     the turn is safe.
 *   - Usage store missing for a fresh agent → bubbles a `0` total
 *     through `weeklyTotal` (the store's own ENOENT path), which is
 *     the correct semantics for an agent that has not yet billed.
 */
export async function checkChatBudget(
  opts: CheckChatBudgetOptions,
): Promise<ChatBudgetVerdict> {
  if (!opts.agentId || typeof opts.agentId !== 'string') {
    throw new Error('checkChatBudget: agentId is required');
  }
  if (!opts.agentStore) {
    throw new Error('checkChatBudget: agentStore is required');
  }
  if (!opts.usageStore) {
    throw new Error('checkChatBudget: usageStore is required');
  }

  const monday = opts.weekMonday || getMondayDate();
  let config: ChatBudgetAgentConfig;
  try {
    config = (await opts.agentStore.load(
      opts.agentId,
    )) as ChatBudgetAgentConfig;
  } catch (err) {
    // ENOENT (agent JSON missing) → treat as "no budget configured" so
    // the budget gate falls through. The downstream SDK invocation
    // surfaces the missing-agent error in its own structured frame
    // (`turn-error` with the SDK's own message), which is the right
    // place for that diagnostic — the budget gate's job is exhaustion
    // enforcement, not agent-existence verification.
    //
    // Any other read error (permissions, JSON parse failure, schema
    // mismatch) is fail-CLOSED: we re-throw so the chat handler can
    // emit a structured `stream-error` frame rather than silently
    // letting through a turn we cannot prove is within budget.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return {
        allowed: true,
        reason: null,
        agentId: opts.agentId,
        weekMonday: monday,
        used: 0,
        budget: 0,
        remaining: 0,
        paused: false,
      };
    }
    throw err;
  }

  const budget =
    (typeof config.weeklyTokenBudget === 'number' && config.weeklyTokenBudget) ||
    (typeof config.budget?.weeklyTokenLimit === 'number' &&
      config.budget.weeklyTokenLimit) ||
    0;

  const totals = await opts.usageStore.weeklyTotal(opts.agentId, monday);
  const used = totals.totalTokens;
  const remaining = Math.max(0, budget - used);
  const paused = config.budget?.paused === true;

  // Two equivalent gating paths:
  //   1. Hard exhaustion: usage already met or exceeded the limit.
  //   2. Operator pause: the heartbeat-side enforcer flipped
  //      `budget.paused = true` (or the operator did so manually). The
  //      chat surface treats both as `budget_exhausted` so the SPA's
  //      verdict-to-banner mapping can stay flat.
  // When `budget <= 0` we cannot enforce a numeric exhaustion check
  // (an unbounded agent), so only the explicit pause flag gates here.
  const numericExhaustion = budget > 0 && used >= budget;
  const exhausted = numericExhaustion || paused;

  return {
    allowed: !exhausted,
    reason: exhausted ? 'budget_exhausted' : null,
    agentId: opts.agentId,
    weekMonday: monday,
    used,
    budget,
    remaining,
    paused,
  };
}

/**
 * Build the `budget-exhausted` SSE frame payload.
 *
 * Centralises the on-wire shape so the chat handler and any future
 * batch-style API can emit byte-identical frames.
 */
export function buildBudgetExhaustedFrame(
  verdict: ChatBudgetVerdict,
): BudgetExhaustedSseFrame {
  const exceededBy = Math.max(0, verdict.used - verdict.budget);
  const message =
    verdict.budget > 0
      ? `Agent "${verdict.agentId}" has exhausted its weekly token budget. ` +
        `Used ${verdict.used} of ${verdict.budget} tokens (week ${verdict.weekMonday}` +
        (exceededBy > 0 ? `, over by ${exceededBy}` : '') +
        `). Top up the budget or wait until next Monday to continue chatting.`
      : `Agent "${verdict.agentId}" is paused (week ${verdict.weekMonday}). ` +
        `Resume the agent before chatting.`;

  return {
    type: 'budget-exhausted',
    reason: 'budget_exhausted',
    agentId: verdict.agentId,
    weekMonday: verdict.weekMonday,
    used: verdict.used,
    budget: verdict.budget,
    remaining: verdict.remaining,
    paused: verdict.paused,
    message,
  };
}

/**
 * Convenience: build a real `AgentStore` + `UsageStore` rooted at the
 * canonical `<dataDir>/agents` directory. The chat handler uses this
 * to construct stores in production while still keeping a test seam
 * via the optional store overrides.
 */
export function createChatBudgetStores(dataDir: string): {
  agentStore: AgentStore;
  usageStore: UsageStore;
} {
  const baseDir = join(dataDir, 'agents');
  return {
    agentStore: new AgentStore(baseDir),
    usageStore: new UsageStoreImpl(baseDir),
  };
}
