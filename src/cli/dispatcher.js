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
import * as summary from '../skills/summary.js';
import * as calendar from '../skills/weekly-calendar-grid.js';
import * as delegateTask from '../skills/delegate-task.js';
import * as agentHelpers from '../storage/agent-helpers.js';

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
    registerSkills: init.registerSkills,
    installHeartbeat: init.installHeartbeat,
    queryHeartbeat: init.queryHeartbeat,
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
    formatAdjustmentResult: (input) =>
      plan.formatAdjustmentResult(input?.results ?? input),
    // formatApprovalResult takes (result, action). Adapter unpacks the
    // JSON object into positional args so the CLI input stays a plain object.
    formatApprovalResult: (input) =>
      plan.formatApprovalResult(input?.result, input?.action),
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
  'agent-helpers': {
    listAllAgents: agentHelpers.listAllAgents,
    loadAgent: agentHelpers.loadAgent,
    getAgentChoices: agentHelpers.getAgentChoices,
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
