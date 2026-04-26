/**
 * Registry-backed dispatcher for `aweek exec`.
 *
 * Skill markdown used to inline `node --input-type=module -e "import … from
 * './src/skills/*.js'"` snippets, which only works when cwd is inside this
 * repo. The dispatcher exposes a curated whitelist of skill exports through
 * a single `aweek exec <module> <fn>` CLI surface so the markdown is
 * location-independent — any installed aweek binary can serve it.
 *
 * Each registered entry is a callable with the uniform signature
 * `(input: object) => any`. Functions that naturally take a single options
 * object are registered by direct reference; functions with multi-argument
 * or nested-slice signatures get thin adapters so the CLI input shape stays
 * a plain JSON object.
 *
 * TypeScript migration note (seed-10 glue-final): mechanical rename from
 * `.js` → `.ts`. Adapter call sites stay loose (`(input: any)`) because the
 * underlying skill modules accept disparate JSON-object shapes — tightening
 * each one belongs to a follow-up typing pass.
 */
import * as init from '../skills/init.js';
import * as initHireMenu from '../skills/init-hire-menu.js';
import * as hire from '../skills/hire.js';
import * as hireAll from '../skills/hire-all.js';
import * as hireRoute from '../skills/hire-route.js';
import * as hireCreateNewMenu from '../skills/hire-create-new-menu.js';
import * as hireSelectSome from '../skills/hire-select-some.js';
import * as plan from '../skills/plan.js';
import * as manage from '../skills/manage.js';
import * as runOnce from '../skills/run-once.js';
import * as summary from '../skills/summary.js';
import * as query from '../skills/query.js';
import * as calendar from '../skills/weekly-calendar-grid.js';
import * as delegateTask from '../skills/delegate-task.js';
import * as execution from '../skills/execution.js';
import * as planAmbiguity from '../skills/plan-ambiguity.js';
import * as planInterviewStore from '../storage/plan-interview-store.js';
import * as agentHelpers from '../storage/agent-helpers.js';
import * as planMarkdown from '../storage/plan-markdown-store.js';
import * as dailyReview from '../services/daily-review-writer.js';
import * as dailyReviewAdj from '../services/daily-review-adjustments.js';
import * as nextWeekContextAssembler from '../services/next-week-context-assembler.js';

/** Codes thrown by `dispatchExec` so callers can branch on the failure mode. */
export type DispatchErrorCode = 'EUSAGE' | 'EUNKNOWN_MODULE' | 'EUNKNOWN_FN';

export class DispatchError extends Error {
  code: DispatchErrorCode;
  constructor(code: DispatchErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Loose callable shape for every registry entry. The CLI surface always
 * passes a single JSON-object input, so adapters and direct references
 * normalize to a `(input?: any) => any` callable at the type level —
 * underlying skills have wildly different parameter shapes (some require
 * a destructured `{baseDir, agentId, …}`, others accept a free-form
 * options bag), so the registry index signature is intentionally
 * permissive. Tightening per-entry typing is tracked as a follow-up.
 */
export type DispatchFn = (input?: any) => any;

/** Registry shape: module key → fn name → callable. */
export type DispatchRegistry = Readonly<Record<string, Readonly<Record<string, DispatchFn>>>>;

// Build the literal registry first (so editor go-to-def still resolves to
// the underlying skill exports), then publish it through the loose
// `DispatchRegistry` index signature. The cast is necessary because some
// direct references (e.g. `dailyReview.applyDailyReviewAdjustments`)
// declare required destructured parameters that don't structurally match
// `(input?: any) => any` even though the runtime call site always passes
// a JSON object.
const REGISTRY_LITERAL = Object.freeze({
  init: {
    detectInitState: init.detectInitState,
    ensureDataDir: init.ensureDataDir,
    installHeartbeat: init.installHeartbeat,
    queryHeartbeat: init.queryHeartbeat,
    uninstallHeartbeat: init.uninstallHeartbeat,
    finalizeInit: init.finalizeInit,
    hasExistingAgents: init.hasExistingAgents,
    shouldLaunchHire: init.shouldLaunchHire,
  },
  'init-hire-menu': {
    buildInitHireMenu: initHireMenu.buildInitHireMenu,
    resolveInitHireMenu: initHireMenu.resolveInitHireMenu,
    routeInitHireMenuChoice: (input: any) =>
      initHireMenu.routeInitHireMenuChoice(input ?? {}),
    formatInitHireMenuPrompt: (input: any) =>
      initHireMenu.formatInitHireMenuPrompt(input?.menu ?? input),
    validateInitHireMenuChoice: (input: any) =>
      initHireMenu.validateInitHireMenuChoice(input?.choice, input?.menu),
    validateSelectedSlugs: (input: any) =>
      initHireMenu.validateSelectedSlugs(input?.selected, input?.menu),
  },
  'hire-route': {
    determineHireRoute: hireRoute.determineHireRoute,
    listUnhiredSubagents: hireRoute.listUnhiredSubagents,
  },
  'hire-create-new-menu': {
    buildCreateNewLaunchInstruction: hireCreateNewMenu.buildCreateNewLaunchInstruction,
    runCreateNewHire: hireCreateNewMenu.runCreateNewHire,
    formatCreateNewResult: (input: any) =>
      hireCreateNewMenu.formatCreateNewResult(input?.result ?? input),
  },
  'hire-select-some': {
    buildSelectSomeChoices: (input: any) =>
      hireSelectSome.buildSelectSomeChoices(input?.menu, {
        projectDir: input?.projectDir,
      }),
    runSelectSomeHire: hireSelectSome.runSelectSomeHire,
    formatSelectSomeResult: (input: any) =>
      hireSelectSome.formatSelectSomeResult(input?.result ?? input),
  },
  'hire-all': {
    hireAllSubagents: hireAll.hireAllSubagents,
    formatHireAllSummary: (input: any) =>
      hireAll.formatHireAllSummary(input?.result ?? input),
  },
  hire: {
    createNewSubagent: hire.createNewSubagent,
    validateCreateNewInput: hire.validateCreateNewInput,
  },
  plan: {
    adjustPlan: plan.adjustPlan,
    reviewPlan: plan.reviewPlan,
    approve: plan.approve,
    reject: plan.reject,
    edit: plan.edit,
    // Returns { mode, confident, ambiguityReason, themeScore, priorityScore,
    // modeLabel }. When confident===false the skill triggers an
    // AskUserQuestion interview to resolve the layout preference.
    detectLayoutAmbiguity: plan.detectLayoutAmbiguity,
    // Runs all four interview triggers concurrently and returns the array of
    // fired reasons. Empty array → no interview needed; non-empty → skill
    // enters inline-blocking interview mode with one AskUserQuestion per
    // fired trigger before plan generation proceeds.
    checkInterviewTriggers: plan.checkInterviewTriggers,
    // Skip-questions escape hatch: given the fired triggers array from
    // checkInterviewTriggers, produces a best-guess assumption for each one
    // so the skill can surface them to the user instead of running the
    // full inline interview. The user then approves or declines the block.
    generateSkipAssumptions: (input: any) =>
      plan.generateSkipAssumptions(input?.triggers ?? []),
    // Format the assumptions array returned by generateSkipAssumptions into
    // a clearly-labelled markdown block for direct display in skill output.
    formatAssumptionsBlock: (input: any) =>
      plan.formatAssumptionsBlock(input?.assumptions ?? []),
    formatAdjustmentResult: (input: any) =>
      plan.formatAdjustmentResult(input?.results ?? input),
    // formatApprovalResult takes (result, action). Adapter unpacks the
    // JSON object into positional args so the CLI input stays a plain object.
    formatApprovalResult: (input: any) =>
      plan.formatApprovalResult(input?.result, input?.action),
    // Autonomous approval — used exclusively by the weekly-review → next-week
    // planner chain. Immediately sets approved:true, skips AskUserQuestion, and
    // returns noPendingPlanRemains:true when the write was persisted correctly.
    autoApprovePlan: plan.autoApprovePlan,
  },
  manage: {
    listPausedAgents: manage.listPausedAgents,
    // getPausedAgentDetails takes (agentId, opts). Adapter promotes agentId
    // to a top-level key in the input object.
    getPausedAgentDetails: (input: any) =>
      manage.getPausedAgentDetails(input?.agentId, {
        dataDir: input?.dataDir,
        weekMonday: input?.weekMonday,
      }),
    resume: manage.resume,
    topUp: manage.topUp,
    pause: manage.pause,
    deleteAgent: manage.deleteAgent,
    formatPausedAgentsList: (input: any) =>
      manage.formatPausedAgentsList(input?.result ?? input),
    formatPausedAgentDetails: (input: any) =>
      manage.formatPausedAgentDetails(input?.details ?? input),
    formatActionResult: (input: any) =>
      manage.formatActionResult(input?.result ?? input),
    formatPauseResult: (input: any) =>
      manage.formatPauseResult(input?.result ?? input),
    formatDeleteResult: (input: any) =>
      manage.formatDeleteResult(input?.result ?? input),
  },
  'run-once': {
    execute: runOnce.execute,
    buildAdHocTask: (input: any) =>
      runOnce.buildAdHocTask({ prompt: input?.prompt, title: input?.title }),
  },
  summary: {
    buildSummary: summary.buildSummary,
    getAgentDrillDownChoices: summary.getAgentDrillDownChoices,
    buildAgentDrillDown: summary.buildAgentDrillDown,
  },
  // Agent filter/selection surface. Takes optional role / keyword / status /
  // budget filters and returns the matching slugs + a rendered table. Used
  // directly by the /aweek:query skill and intended as the entry point for
  // future multi-agent skills that need an "active marketers"-style slug list.
  query: {
    queryAgents: query.queryAgents,
    formatQueryResult: (input: any) =>
      query.formatQueryResult(input?.result ?? input),
    buildQueryChoices: (input: any) =>
      query.buildQueryChoices(input?.result ?? input),
  },
  calendar: {
    // listAgentsForCalendar takes a positional dataDir string.
    listAgentsForCalendar: (input: any) =>
      calendar.listAgentsForCalendar(input?.dataDir),
    loadAndRenderGrid: calendar.loadAndRenderGrid,
    // Normalize a free-form week reference (ISO week, date, bare number, or
    // alias) into the canonical YYYY-Www key. Useful for the skill markdown
    // to surface a friendly error before invoking loadAndRenderGrid.
    resolveWeekKey: (input: any) =>
      calendar.resolveWeekKey(input?.input, input?.tz),
  },
  'delegate-task': {
    delegateTask: delegateTask.delegateTask,
    formatDelegationResult: (input: any) =>
      delegateTask.formatDelegationResult(input?.message ?? input),
  },
  // Free-form per-agent plan.md — authored by the user, read by skills as
  // context for weekly-plan generation. Each adapter promotes the
  // positional (agentsDir, agentId, ...) signature of the underlying
  // store into the JSON-object surface `aweek exec` uses everywhere else.
  'plan-markdown': {
    read: (input: any) => planMarkdown.readPlan(input?.agentsDir, input?.agentId),
    write: (input: any) =>
      planMarkdown.writePlan(input?.agentsDir, input?.agentId, input?.body ?? ''),
    exists: (input: any) => planMarkdown.exists(input?.agentsDir, input?.agentId),
    path: (input: any) => planMarkdown.planPath(input?.agentsDir, input?.agentId),
    buildInitial: (input: any) => planMarkdown.buildInitialPlan(input ?? {}),
    buildFromInterview: (input: any) => planMarkdown.buildPlanFromInterview(input ?? {}),
    buildFromLegacy: (input: any) => planMarkdown.buildPlanFromLegacy(input ?? {}),
    parse: (input: any) => planMarkdown.parsePlanMarkdownSections(input?.body ?? ''),
    migrateLegacy: (input: any) => planMarkdown.migrateLegacyPlan(input ?? {}),
  },
  'agent-helpers': {
    listAllAgents: agentHelpers.listAllAgents,
    loadAgent: agentHelpers.loadAgent,
    getAgentChoices: agentHelpers.getAgentChoices,
  },
  // Daily review writer — generates reviews/daily-YYYY-MM-DD.md for an agent.
  // All functions accept a single JSON-object input so the CLI surface stays flat.
  'daily-review': {
    // Pure helpers exposed for skill-markdown inspection / testing
    utcToLocalDate: (input: any) =>
      dailyReview.utcToLocalDate(input?.isoString, input?.tz),
    weekdayName: (input: any) => dailyReview.weekdayName(input?.date ?? ''),
    tomorrowWeekdayName: (input: any) => dailyReview.tomorrowWeekdayName(input?.date ?? ''),
    dateToISOWeek: (input: any) => dailyReview.dateToISOWeek(input?.date ?? ''),
    isoWeekToMondayDate: (input: any) => dailyReview.isoWeekToMondayDate(input?.week ?? ''),
    // Path helpers
    dailyReviewDir: (input: any) => dailyReview.dailyReviewDir(input?.baseDir ?? '', input?.agentId ?? ''),
    dailyReviewPaths: (input: any) =>
      dailyReview.dailyReviewPaths(input?.baseDir ?? '', input?.agentId ?? '', input?.date ?? ''),
    // Persistence helpers
    loadDailyReview: (input: any) =>
      dailyReview.loadDailyReview(input?.baseDir ?? '', input?.agentId ?? '', input?.date ?? ''),
    listDailyReviews: (input: any) =>
      dailyReview.listDailyReviews(input?.baseDir ?? '', input?.agentId ?? ''),
    // Main orchestrator — generates and optionally persists the daily review.
    // When persist=true and adjustments exist, also applies the proposed
    // weeklyAdjustment ops directly to the live plan via `adjustGoals`.
    generateDailyReview: dailyReview.generateDailyReview,
    // Apply daily-review adjustment records to the weekly plan. New /
    // rescheduled / retried tasks land as `pending` and are immediately
    // eligible for the heartbeat — there is no pending-approval queue.
    applyDailyReviewAdjustments: dailyReviewAdj.applyDailyReviewAdjustments,
  },
  // Context assembler for the autonomous next-week planner.
  // Reads plan.md, the just-written weekly retrospective, and the activity log
  // for the completed week, returning a context object ready to spread into
  // generateWeeklyPlan's options parameter. Only called from the weekly-review
  // → next-week-planner autonomous chain, not from user-invoked /aweek:plan.
  // Maintenance ops for per-execution CLI execution logs. `prune` walks
  // `.aweek/agents/*/executions/*.jsonl` and deletes entries older than
  // `olderThanWeeks` (default 4). Invoked directly by users via
  // `aweek exec execution prune --input-json -`.
  execution: {
    prune: (input: any) =>
      execution.pruneExecutionLogs({
        projectDir: input?.projectDir,
        olderThanWeeks: input?.olderThanWeeks,
      }),
  },
  // Ouroboros-style adaptive-interview helpers for `/aweek:plan`. The
  // SKILL.md orchestrates the LLM calls; this registry exposes the pure
  // math (scoring gate, streak, snapshot rendering) plus the prompt
  // builder / response parser / state store so the markdown can drive
  // the whole loop via `aweek exec`.
  'plan-ambiguity': {
    buildScoringPrompt: (input: any) =>
      planAmbiguity.buildScoringPrompt({
        initialContext: input?.initialContext,
        transcript: input?.transcript,
      }),
    parseScoreResponse: (input: any) => planAmbiguity.parseScoreResponse(input?.raw),
    qualifiesForCompletion: (input: any) =>
      planAmbiguity.qualifiesForCompletion({
        breakdown: input?.breakdown,
        streak: input?.streak,
      }),
    updateStreak: (input: any) =>
      planAmbiguity.updateStreak(input?.prevStreak ?? 0, input?.breakdown),
    buildAmbiguitySnapshot: (input: any) =>
      planAmbiguity.buildAmbiguitySnapshot({
        breakdown: input?.breakdown,
        streak: input?.streak,
      }),
    weakestDimension: (input: any) => planAmbiguity.weakestDimension(input?.breakdown),
    isFullBreakdown: (input: any) => planAmbiguity.isFullBreakdown(input?.breakdown),
    ambiguityFromBreakdown: (input: any) =>
      planAmbiguity.ambiguityFromBreakdown(input?.breakdown),
    milestoneFromScore: (input: any) => planAmbiguity.milestoneFromScore(input?.score),
  },
  'plan-interview-store': {
    createInterviewState: (input: any) =>
      planInterviewStore.createInterviewState({
        agentId: input?.agentId,
        initialContext: input?.initialContext,
      }),
    loadInterviewState: (input: any) =>
      planInterviewStore.loadInterviewState(input?.agentsDir, input?.agentId),
    saveInterviewState: (input: any) =>
      planInterviewStore.saveInterviewState(
        input?.agentsDir,
        input?.agentId,
        input?.state,
      ),
    clearInterviewState: (input: any) =>
      planInterviewStore.clearInterviewState(input?.agentsDir, input?.agentId),
    interviewExists: (input: any) =>
      planInterviewStore.interviewExists(input?.agentsDir, input?.agentId),
    appendTurn: (input: any) => planInterviewStore.appendTurn(input?.state, input?.turn),
  },
  'next-week-context': {
    // Pure helpers exposed for testing and skill inspection.
    extractRetrospectiveSummary: (input: any) =>
      nextWeekContextAssembler.extractRetrospectiveSummary(input?.reviewMarkdown ?? ''),
    summariseActivityLog: (input: any) =>
      nextWeekContextAssembler.summariseActivityLog(input?.entries ?? []),
    // Main assembler — requires agentsDir, baseDir, agentId, week, and an
    // optional activityLogStore instance. The store is not JSON-serialisable so
    // callers that need the full assembly must import and call the function
    // directly; this dispatcher entry exposes the pure helpers for skill testing.
    assembleNextWeekPlannerContext: nextWeekContextAssembler.assembleNextWeekPlannerContext,
  },
});

export const REGISTRY: DispatchRegistry = REGISTRY_LITERAL as unknown as DispatchRegistry;

export function listModules(): string[] {
  return Object.keys(REGISTRY).sort();
}

export function listFunctions(moduleKey: string): string[] | null {
  const entry = REGISTRY[moduleKey];
  if (!entry) return null;
  return Object.keys(entry).sort();
}

/** Parameter shape for `dispatchExec`. */
export interface DispatchExecParams {
  moduleKey?: string;
  fnName?: string;
  input?: unknown;
}

/**
 * Invoke a registered skill export with a JSON-serializable input.
 *
 * @throws {DispatchError} with `code` of:
 *   - `EUSAGE`           — missing moduleKey / fnName
 *   - `EUNKNOWN_MODULE`  — moduleKey not in REGISTRY
 *   - `EUNKNOWN_FN`      — fnName not exposed for that module
 */
export async function dispatchExec(
  { moduleKey, fnName, input }: DispatchExecParams = {},
): Promise<unknown> {
  if (!moduleKey) {
    throw new DispatchError('EUSAGE', 'module name is required');
  }
  if (!fnName) {
    throw new DispatchError('EUSAGE', 'function name is required');
  }
  const entry = REGISTRY[moduleKey];
  if (!entry) {
    throw new DispatchError(
      'EUNKNOWN_MODULE',
      `Unknown module "${moduleKey}". Available: ${listModules().join(', ')}`,
    );
  }
  const fn = entry[fnName];
  if (typeof fn !== 'function') {
    throw new DispatchError(
      'EUNKNOWN_FN',
      `Module "${moduleKey}" does not expose "${fnName}". Available: ${listFunctions(moduleKey)!.join(', ')}`,
    );
  }
  return await fn(input ?? {});
}
