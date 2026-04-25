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

export class DispatchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const REGISTRY = Object.freeze({
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
    routeInitHireMenuChoice: (input) =>
      initHireMenu.routeInitHireMenuChoice(input ?? {}),
    formatInitHireMenuPrompt: (input) =>
      initHireMenu.formatInitHireMenuPrompt(input?.menu ?? input),
    validateInitHireMenuChoice: (input) =>
      initHireMenu.validateInitHireMenuChoice(input?.choice, input?.menu),
    validateSelectedSlugs: (input) =>
      initHireMenu.validateSelectedSlugs(input?.selected, input?.menu),
  },
  'hire-route': {
    determineHireRoute: hireRoute.determineHireRoute,
    listUnhiredSubagents: hireRoute.listUnhiredSubagents,
  },
  'hire-create-new-menu': {
    buildCreateNewLaunchInstruction: hireCreateNewMenu.buildCreateNewLaunchInstruction,
    runCreateNewHire: hireCreateNewMenu.runCreateNewHire,
    formatCreateNewResult: (input) =>
      hireCreateNewMenu.formatCreateNewResult(input?.result ?? input),
  },
  'hire-select-some': {
    buildSelectSomeChoices: (input) =>
      hireSelectSome.buildSelectSomeChoices(input?.menu, {
        projectDir: input?.projectDir,
      }),
    runSelectSomeHire: hireSelectSome.runSelectSomeHire,
    formatSelectSomeResult: (input) =>
      hireSelectSome.formatSelectSomeResult(input?.result ?? input),
  },
  'hire-all': {
    hireAllSubagents: hireAll.hireAllSubagents,
    formatHireAllSummary: (input) =>
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
    generateSkipAssumptions: (input) =>
      plan.generateSkipAssumptions(input?.triggers ?? []),
    // Format the assumptions array returned by generateSkipAssumptions into
    // a clearly-labelled markdown block for direct display in skill output.
    formatAssumptionsBlock: (input) =>
      plan.formatAssumptionsBlock(input?.assumptions ?? []),
    formatAdjustmentResult: (input) =>
      plan.formatAdjustmentResult(input?.results ?? input),
    // formatApprovalResult takes (result, action). Adapter unpacks the
    // JSON object into positional args so the CLI input stays a plain object.
    formatApprovalResult: (input) =>
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
    getPausedAgentDetails: (input) =>
      manage.getPausedAgentDetails(input?.agentId, {
        dataDir: input?.dataDir,
        weekMonday: input?.weekMonday,
      }),
    resume: manage.resume,
    topUp: manage.topUp,
    pause: manage.pause,
    deleteAgent: manage.deleteAgent,
    formatPausedAgentsList: (input) =>
      manage.formatPausedAgentsList(input?.result ?? input),
    formatPausedAgentDetails: (input) =>
      manage.formatPausedAgentDetails(input?.details ?? input),
    formatActionResult: (input) =>
      manage.formatActionResult(input?.result ?? input),
    formatPauseResult: (input) =>
      manage.formatPauseResult(input?.result ?? input),
    formatDeleteResult: (input) =>
      manage.formatDeleteResult(input?.result ?? input),
  },
  'run-once': {
    execute: runOnce.execute,
    buildAdHocTask: (input) =>
      runOnce.buildAdHocTask({ prompt: input?.prompt, title: input?.title }),
  },
  summary: {
    buildSummary: summary.buildSummary,
    getAgentDrillDownChoices: summary.getAgentDrillDownChoices,
    buildAgentDrillDown: summary.buildAgentDrillDown,
  },
  calendar: {
    // listAgentsForCalendar takes a positional dataDir string.
    listAgentsForCalendar: (input) =>
      calendar.listAgentsForCalendar(input?.dataDir),
    loadAndRenderGrid: calendar.loadAndRenderGrid,
  },
  'delegate-task': {
    delegateTask: delegateTask.delegateTask,
    formatDelegationResult: (input) =>
      delegateTask.formatDelegationResult(input?.message ?? input),
  },
  // Free-form per-agent plan.md — authored by the user, read by skills as
  // context for weekly-plan generation. Each adapter promotes the
  // positional (agentsDir, agentId, ...) signature of the underlying
  // store into the JSON-object surface `aweek exec` uses everywhere else.
  'plan-markdown': {
    read: (input) => planMarkdown.readPlan(input?.agentsDir, input?.agentId),
    write: (input) =>
      planMarkdown.writePlan(input?.agentsDir, input?.agentId, input?.body ?? ''),
    exists: (input) => planMarkdown.exists(input?.agentsDir, input?.agentId),
    path: (input) => planMarkdown.planPath(input?.agentsDir, input?.agentId),
    buildInitial: (input) => planMarkdown.buildInitialPlan(input ?? {}),
    buildFromInterview: (input) => planMarkdown.buildPlanFromInterview(input ?? {}),
    buildFromLegacy: (input) => planMarkdown.buildPlanFromLegacy(input ?? {}),
    parse: (input) => planMarkdown.parsePlanMarkdownSections(input?.body ?? ''),
    migrateLegacy: (input) => planMarkdown.migrateLegacyPlan(input ?? {}),
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
    utcToLocalDate: (input) =>
      dailyReview.utcToLocalDate(input?.isoString, input?.tz),
    weekdayName: (input) => dailyReview.weekdayName(input?.date ?? ''),
    tomorrowWeekdayName: (input) => dailyReview.tomorrowWeekdayName(input?.date ?? ''),
    dateToISOWeek: (input) => dailyReview.dateToISOWeek(input?.date ?? ''),
    isoWeekToMondayDate: (input) => dailyReview.isoWeekToMondayDate(input?.week ?? ''),
    // Path helpers
    dailyReviewDir: (input) => dailyReview.dailyReviewDir(input?.baseDir ?? '', input?.agentId ?? ''),
    dailyReviewPaths: (input) =>
      dailyReview.dailyReviewPaths(input?.baseDir ?? '', input?.agentId ?? '', input?.date ?? ''),
    // Persistence helpers
    loadDailyReview: (input) =>
      dailyReview.loadDailyReview(input?.baseDir ?? '', input?.agentId ?? '', input?.date ?? ''),
    listDailyReviews: (input) =>
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
    prune: (input) =>
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
    buildScoringPrompt: (input) =>
      planAmbiguity.buildScoringPrompt({
        initialContext: input?.initialContext,
        transcript: input?.transcript,
      }),
    parseScoreResponse: (input) => planAmbiguity.parseScoreResponse(input?.raw),
    qualifiesForCompletion: (input) =>
      planAmbiguity.qualifiesForCompletion({
        breakdown: input?.breakdown,
        streak: input?.streak,
      }),
    updateStreak: (input) =>
      planAmbiguity.updateStreak(input?.prevStreak ?? 0, input?.breakdown),
    buildAmbiguitySnapshot: (input) =>
      planAmbiguity.buildAmbiguitySnapshot({
        breakdown: input?.breakdown,
        streak: input?.streak,
      }),
    weakestDimension: (input) => planAmbiguity.weakestDimension(input?.breakdown),
    isFullBreakdown: (input) => planAmbiguity.isFullBreakdown(input?.breakdown),
    ambiguityFromBreakdown: (input) =>
      planAmbiguity.ambiguityFromBreakdown(input?.breakdown),
    milestoneFromScore: (input) => planAmbiguity.milestoneFromScore(input?.score),
  },
  'plan-interview-store': {
    createInterviewState: (input) =>
      planInterviewStore.createInterviewState({
        agentId: input?.agentId,
        initialContext: input?.initialContext,
      }),
    loadInterviewState: (input) =>
      planInterviewStore.loadInterviewState(input?.agentsDir, input?.agentId),
    saveInterviewState: (input) =>
      planInterviewStore.saveInterviewState(
        input?.agentsDir,
        input?.agentId,
        input?.state,
      ),
    clearInterviewState: (input) =>
      planInterviewStore.clearInterviewState(input?.agentsDir, input?.agentId),
    interviewExists: (input) =>
      planInterviewStore.interviewExists(input?.agentsDir, input?.agentId),
    appendTurn: (input) => planInterviewStore.appendTurn(input?.state, input?.turn),
  },
  'next-week-context': {
    // Pure helpers exposed for testing and skill inspection.
    extractRetrospectiveSummary: (input) =>
      nextWeekContextAssembler.extractRetrospectiveSummary(input?.reviewMarkdown ?? ''),
    summariseActivityLog: (input) =>
      nextWeekContextAssembler.summariseActivityLog(input?.entries ?? []),
    // Main assembler — requires agentsDir, baseDir, agentId, week, and an
    // optional activityLogStore instance. The store is not JSON-serialisable so
    // callers that need the full assembly must import and call the function
    // directly; this dispatcher entry exposes the pure helpers for skill testing.
    assembleNextWeekPlannerContext: nextWeekContextAssembler.assembleNextWeekPlannerContext,
  },
});

export function listModules() {
  return Object.keys(REGISTRY).sort();
}

export function listFunctions(moduleKey) {
  const entry = REGISTRY[moduleKey];
  if (!entry) return null;
  return Object.keys(entry).sort();
}

/**
 * Invoke a registered skill export with a JSON-serializable input.
 *
 * @param {object} params
 * @param {string} params.moduleKey - Top-level REGISTRY key, e.g. "init".
 * @param {string} params.fnName    - Function name within that module.
 * @param {object} [params.input]   - Single options object passed to the fn.
 * @returns {Promise<any>} Whatever the underlying fn returns (awaited).
 *
 * @throws {DispatchError} with `code` of:
 *   - `EUSAGE`           — missing moduleKey / fnName
 *   - `EUNKNOWN_MODULE`  — moduleKey not in REGISTRY
 *   - `EUNKNOWN_FN`      — fnName not exposed for that module
 */
export async function dispatchExec({ moduleKey, fnName, input } = {}) {
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
      `Module "${moduleKey}" does not expose "${fnName}". Available: ${listFunctions(moduleKey).join(', ')}`,
    );
  }
  return await fn(input ?? {});
}
