/**
 * aweek — Claude Code skill system for managing multiple AI agents.
 */
export { AgentStore } from './storage/agent-store.js';
// Shared agent-selection / storage helpers reused by every new /aweek:* skill.
// See src/storage/agent-helpers.js for the rationale behind the extraction.
export {
  DEFAULT_DATA_DIR,
  getDefaultDataDir,
  resolveDataDir,
  createAgentStore,
  listAllAgents,
  loadAgent,
  getAgentChoices,
  findAgentByQuery,
  formatAgentChoice,
} from './storage/agent-helpers.js';
export { GoalStore } from './storage/goal-store.js';
export { MonthlyPlanStore } from './storage/monthly-plan-store.js';
export { WeeklyPlanStore } from './storage/weekly-plan-store.js';
export {
  createAgentConfig,
  createGoal,
  createObjective,
  createMonthlyPlan,
  createTask,
  createWeeklyPlan,
  createInboxMessage,
  getMondayISO,
  // Goal management helpers
  addGoal,
  updateGoalStatus,
  removeGoal,
  getGoalsByHorizon,
  getActiveGoals,
  // Monthly plan management helpers
  addMonthlyPlan,
  getMonthlyPlan,
  getActiveMonthlyPlan,
  updateMonthlyPlanStatus,
  updateObjectiveStatus,
  getObjectivesForGoal,
  addObjectiveToMonthlyPlan,
} from './models/agent.js';
export {
  validate,
  assertValid,
  validateAgentConfig,
  validateGoal,
  validateMonthlyPlan,
  validateMonthlyObjective,
  validateWeeklyPlan,
  validateBudget,
  validateInboxMessage,
  validateInboxQueue,
  validateActivityLogEntry,
  validateActivityLog,
  validateUsageRecord,
  validateUsageLog,
  validateArtifactRecord,
  validateArtifactManifest,
  validateExecutionRecord,
  validateExecutionLog,
} from './schemas/validator.js';
export {
  GOAL_HORIZONS,
  goalSchema,
  goalsArraySchema,
} from './schemas/goals.schema.js';
export {
  OBJECTIVE_STATUSES,
  MONTHLY_PLAN_STATUSES,
  monthlyObjectiveSchema,
  monthlyPlanSchema as monthlyPlanSchemaDefinition,
} from './schemas/monthly-plan.schema.js';
export {
  TASK_STATUSES,
  TASK_PRIORITIES,
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
  REVIEW_OBJECTIVE_IDS,
  isReviewObjectiveId,
  weeklyTaskSchema,
  weeklyPlanSchema as weeklyPlanSchemaDefinition,
} from './schemas/weekly-plan.schema.js';
// Inbox queue schema — inter-agent task delegation
export {
  MESSAGE_STATUSES,
  MESSAGE_PRIORITIES,
  MESSAGE_TYPES,
  inboxMessageSchema as inboxMessageSchemaDefinition,
  inboxQueueSchema,
} from './schemas/inbox.schema.js';
// Hire skill — the /aweek:hire flow is routed through hire-route.js and
// handled by the new wizard pieces (hire-create-new, hire-all, hire-select-some,
// init-hire-menu). The old create-agent pipeline has been removed: identity
// lives in .claude/agents/<slug>.md, not in the aweek JSON.
export {
  createNewSubagent,
  validateCreateNewInput,
} from './skills/hire.js';
// Hire wizard routing — decides whether /aweek:hire offers a two-option
// prompt (Pick existing vs Create new) or forces the create-new path when
// no unhired subagents are available. See src/skills/hire-route.js.
export {
  PLUGIN_SUBAGENT_PREFIXES,
  isPluginSubagent,
  listProjectSubagentSlugs,
  listUnhiredSubagents,
  determineHireRoute,
} from './skills/hire-route.js';
// Hire-all handler (Sub-AC 1 of AC 50301) — bulk wrapper that iterates
// over a list of pre-existing subagent slugs and creates minimal aweek
// JSON shells for each one. Used by the /aweek:init four-option menu's
// `hire-all` and `select-some` branches. See src/skills/hire-all.js.
export {
  DEFAULT_HIRE_ALL_WEEKLY_TOKEN_LIMIT,
  hireAllSubagents,
  formatHireAllSummary,
} from './skills/hire-all.js';
// Select-some handler (Sub-AC 2 of AC 50302) — multi-select UX layer on
// top of hireAllSubagents. Builds the AskUserQuestion choice payload from
// the unhired subagent list (enriched with live .md frontmatter) and
// wraps the user's picks into aweek JSON shells. See
// src/skills/hire-select-some.js.
export {
  DEFAULT_SELECT_SOME_PROMPT_TEXT,
  defaultChoiceDescription as defaultSelectSomeChoiceDescription,
  buildSelectSomeChoices,
  runSelectSomeHire,
  formatSelectSomeResult,
} from './skills/hire-select-some.js';
// Create-new handler (Sub-AC 3 of AC 50303) — the init menu's Create new
// branch delegates to /aweek:hire's three-field create-new wizard. This
// module exposes both the handoff descriptor (for markdown that launches
// the interactive skill) and an in-process handler that runs the same
// two-step flow (write/adopt .md then create the aweek JSON shell) from
// pre-collected parameters. See src/skills/hire-create-new-menu.js.
export {
  CREATE_NEW_SKILL_NAME,
  CREATE_NEW_ROUTE_NAME,
  DEFAULT_CREATE_NEW_PROMPT_TEXT,
  buildCreateNewLaunchInstruction,
  runCreateNewHire,
  formatCreateNewResult,
} from './skills/hire-create-new-menu.js';
// Subagent file primitives — single source of truth for the on-disk
// `.claude/agents/<slug>.md` contract (path resolution, slug validation,
// markdown rendering, collision-safe writes).
export {
  SUBAGENTS_DIR_RELATIVE,
  resolveSubagentsDir,
  subagentFilePath,
  validateSubagentSlug,
  slugifyName,
  validateDescription,
  validateSystemPrompt,
  buildSubagentMarkdown,
  subagentFileExists,
  readSubagentFile,
  writeSubagentFile,
} from './subagents/subagent-file.js';
// Subagent discovery — combined project + user scope scanner used by the
// hire wizard's pick-existing branch. Merges `.claude/agents/` and
// `~/.claude/agents/`, filters out already-hired and plugin-namespaced
// slugs, and returns `{ slug, scope, path, hired }` entries.
export {
  USER_SUBAGENT_SCOPE,
  PROJECT_SUBAGENT_SCOPE,
  resolveUserSubagentsDir,
  userSubagentFilePath,
  listUserSubagentSlugs,
  discoverSubagents,
} from './subagents/subagent-discovery.js';
export {
  adjustGoals,
  formatAdjustmentSummary,
  validateGoalAdjustment,
  validateMonthlyAdjustment,
  validateWeeklyAdjustment,
  applyGoalAdjustment,
  applyMonthlyAdjustment,
  applyWeeklyAdjustment,
} from './services/plan-adjustments.js';
export {
  generateWeeklyPlan,
  generateAndSaveWeeklyPlan,
  filterEligibleObjectives,
  filterActiveGoals,
  defaultPriorityForObjective,
  generateTasksForObjective,
  buildReviewTasks,
} from './services/weekly-plan-generator.js';
// Plan-ready system-event emitter — fires a `plan-ready` notification when a
// pending weekly plan (`approved: false`) is persisted, so the user is
// surfaced the approval prompt in the dashboard inbox without polling. The
// sender slug is the agent whose plan needs approval. See AC 6.
export {
  emitPlanReadyNotification,
  planReadyDedupKey,
  planReadyTitle,
  planReadyBody,
} from './services/plan-ready-notifier.js';
export type {
  EmitPlanReadyOptions,
  EmitPlanReadyResult,
  PlanReadyPlanShape,
} from './services/plan-ready-notifier.js';
// Next-week context assembler — reads plan.md, the just-written retrospective
// file, and the activity log for the completed week, then returns a context
// object ready to spread into generateWeeklyPlan's options parameter.
// Used exclusively by the autonomous next-week planner path that fires from
// the weekly-review chain; user-invoked /aweek:plan does not call it.
export {
  extractRetrospectiveSummary,
  summariseActivityLog,
  assembleNextWeekPlannerContext,
} from './services/next-week-context-assembler.js';
// Day-layout detector — classifies an agent's plan.md into one of three layout
// modes ('theme-days', 'priority-waterfall', 'mixed') and maps the mode to a
// distributeTasks spread strategy ('spread' or 'pack'). Used by the weekly plan
// generator (via options.planMarkdown) and any caller that renders a calendar.
export {
  detectDayLayout,
  layoutModeLabel,
  LAYOUT_MODES,
  scoreThemeDays,
  scorePriorityWaterfall,
} from './services/day-layout-detector.js';
export {
  APPROVAL_DECISIONS,
  findPendingPlan,
  formatPlanForReview,
  validateDecision,
  validateEdits,
  applyEdits,
  processApproval,
  formatApprovalResult,
  loadPlanForReview,
} from './services/plan-approval.js';
// Heartbeat scheduler — runtime execution with lock-based isolation
export {
  createScheduler,
  lockPathFor,
  isLockStale,
  acquireLock,
  releaseLock,
  isLocked,
  runHeartbeat,
  runHeartbeatAll,
} from './heartbeat/scheduler.js';
// Task selector — picks next pending task from weekly plans
export {
  priorityWeight,
  filterPendingTasks,
  sortByPriority,
  selectNextTaskFromPlan,
  getTaskStatusSummary,
  isAllTasksFinished,
  selectNextTask,
  selectNextTaskForWeek,
} from './heartbeat/task-selector.js';
// Heartbeat–task-selector integration — each tick selects and starts next task
export {
  createTaskTickCallback,
  tickAgent,
  runHeartbeatTick,
  runHeartbeatTickAll,
} from './heartbeat/heartbeat-task-runner.js';
// Lock manager — file-based locks with PID tracking and stale lock detection
export {
  isPidAlive,
  lockPathFor as lockManagerLockPathFor,
  readLockFile,
  isLockStale as isLockStaleDetailed,
  isLockOrphaned,
  lockStatus,
  acquireLock as acquireLockManaged,
  releaseLock as releaseLockManaged,
  queryLock,
  breakLock,
  createLockManager,
} from './lock/lock-manager.js';
// Inbox store — file-based inter-agent task delegation queue
export { InboxStore } from './storage/inbox-store.js';
// Notification store — file-based one-way agent → user notification feed.
// The store also exposes a delivery-channel subscription API so future
// external push channels (Slack, email, OS push, webhooks) can hook into
// `append()` writes without re-architecting the store. v1 ships with the
// dashboard inbox as the only surface, but the seam is in place. See AC 17.
export {
  NotificationStore,
  createNotification,
} from './storage/notification-store.js';
export type {
  Notification,
  NotificationSource,
  NotificationSystemEvent,
  NotificationSummary,
  NotificationWithAgent,
  NotificationQueryFilters,
  CreateNotificationOptions,
  SendNotificationOptions,
  NotificationDeliveryChannel,
  NotificationChannelErrorHandler,
  NotificationStoreOptions,
  NotificationLink,
  NotificationLinkObject,
} from './storage/notification-store.js';
export {
  NOTIFICATION_SOURCES,
  NOTIFICATION_SYSTEM_EVENTS,
  notificationSchema,
  notificationFeedSchema,
  notificationLinkSchema,
} from './schemas/notification.schema.js';
// Typed wrapper for the notification schema — sibling-types-file pattern
// (notification.schema.js owns the runtime AJV schema; notification.ts
// owns the canonical TypeScript types for the link union plus the typed
// validator entry points). See AC 1 sub-AC 1.
export {
  validateNotification,
  validateNotificationFeed,
  validateNotificationLink,
} from './schemas/notification.js';
// Activity log — structured JSON entries for agent activity tracking
export {
  ActivityLogStore,
  createLogEntry,
  getMondayDate as getActivityMondayDate,
} from './storage/activity-log-store.js';
export {
  ACTIVITY_STATUSES,
  activityLogEntrySchema,
  activityLogSchema,
} from './schemas/activity-log.schema.js';
// Token usage tracking — per-session token consumption records for budget tracking
export {
  UsageStore,
  createUsageRecord,
  getMondayDate as getUsageMondayDate,
} from './storage/usage-store.js';
export {
  usageRecordSchema,
  usageLogSchema,
} from './schemas/usage.schema.js';
// CLI session launcher — spawns Claude Code CLI for agent task execution.
// Note: `buildSystemPrompt` was removed in the subagent refactor — identity
// now lives in `.claude/agents/<slug>.md` and is injected by Claude Code via
// the `--agents` flag, not by aweek. `buildRuntimeContext` replaces it as
// the per-task runtime prompt builder.
export {
  buildRuntimeContext,
  buildTaskPrompt,
  buildCliArgs,
  launchSession,
  buildSessionConfig,
  parseTokenUsage,
} from './execution/cli-session.js';
// Inter-agent task delegation skill
export {
  validateDelegationParams,
  delegateTask,
  formatDelegationResult,
} from './skills/delegate-task.js';
// Notify skill — `aweek exec notify send` entry point. Validates a free-form
// agent-authored notification payload, verifies the sender agent exists, and
// hands off to NotificationStore.send() which auto-populates id, agentId,
// createdAt, and read=false. v1 is dashboard-only; future external push
// channels register through NotificationStore.subscribe(). See AC 1.
export {
  validateSendParams as validateNotifySendParams,
  sendNotification,
  formatNotificationResult,
} from './skills/notify.js';
export type {
  SendNotificationParams,
  ValidatedSendParams,
  SendNotificationDeps,
} from './skills/notify.js';
// Run-once skill — manually dispatch an ad-hoc debug task through the same
// execution path the heartbeat uses (per-agent lock, .env, session executor
// with dangerouslySkipPermissions, activity log). See src/skills/run-once.js.
export {
  buildAdHocTask,
  execute as runOnceExecute,
} from './skills/run-once.js';
// Session executor — CLI session + automatic token usage tracking integration
export {
  executeSessionWithTracking,
  weekFromPlanWeek,
  createTrackedExecutor,
} from './execution/session-executor.js';
// Task queue — per-agent FIFO queue with priority support
export {
  queuePathFor,
  readQueue,
  createQueueEntry,
  enqueue,
  dequeue,
  dequeueAll,
  peek,
  queueLength,
  removeTask,
  clearQueue,
  createTaskQueue,
} from './queue/task-queue.js';
// Artifact store — deliverable file/document tracking and persistence
export {
  ArtifactStore,
  createArtifactRecord,
  getFileSize,
  artifactFileExists,
} from './storage/artifact-store.js';
export {
  ARTIFACT_TYPES,
  artifactRecordSchema,
  artifactManifestSchema,
} from './schemas/artifact.schema.js';
// Execution store — idempotency tracking for heartbeat executions
export {
  ExecutionStore,
  createExecutionRecord,
  generateIdempotencyKey,
  computeTimeWindow,
  getMondayDate as getExecutionMondayDate,
} from './storage/execution-store.js';
export {
  EXECUTION_STATUSES,
  executionRecordSchema,
  executionLogSchema,
} from './schemas/execution.schema.js';
// Inbox processor — picks up delegated tasks from inbox during heartbeat
export {
  sortInboxByPriority,
  inboxMessageToTask,
  pickupInboxTasks,
  completeInboxTask,
  failInboxTask,
  extractInboxMessageId,
  isInboxTask,
  processInboxOnHeartbeat,
} from './heartbeat/inbox-processor.js';
// Weekly review generator — completed tasks collection and formatting,
// plus the four-section CollectedWeekData → markdown generator
export {
  collectCompletedTasksFromPlan,
  collectCompletedFromActivityLog,
  mergeCompletedTasks,
  formatDuration,
  formatCompletedTaskItem,
  formatCompletedTasksSection,
  generateCompletedTasksReview,
  // Four-section content generator (AC 4a-ii)
  formatTaskStatusSection,
  formatCarryOverSection,
  formatWhatWorkedSection,
  formatBudgetSummarySection,
  generateWeeklyReviewContent,
} from './services/weekly-review-generator.js';
// Weekly review metrics — task counts, token usage, and delegation stats
export {
  computeTaskMetrics,
  computeTokenMetrics,
  computeDelegationMetrics,
  formatNumber,
  formatCost,
  formatPercent,
  formatMetricsSection,
  aggregateWeeklyMetrics,
} from './services/weekly-review-metrics.js';
// Locked session runner — lock + queue integration for heartbeat execution
export {
  runWithLockAndQueue,
  drainQueuedTasks,
  runAllWithLockAndQueue,
  createLockedSessionRunner,
} from './heartbeat/locked-session-runner.js';
// Heartbeat lock — PID-tracked lock isolation for heartbeat invocations
export {
  generateHeartbeatId,
  runWithHeartbeatLock,
  runAllWithHeartbeatLock,
  queryHeartbeatLock,
  breakHeartbeatLock,
  createHeartbeatLock,
} from './heartbeat/heartbeat-lock.js';
// Blockers extractor — failed/blocked task identification and formatting
export {
  BLOCKER_CATEGORIES,
  classifyBlocker,
  extractBlockersFromPlan,
  extractBlockersFromActivityLog,
  mergeBlockers,
  categoryLabel,
  formatBlockerItem,
  formatBlockersSection,
  generateBlockersReview,
} from './services/blockers-extractor.js';
// Weekly data aggregator — planned vs actual day-by-day comparison
export {
  mondayFromISOWeek,
  dayOfWeek,
  weekDates,
  bucketLogEntriesByDay,
  bucketTasksByDay,
  countByStatus,
  countLogByStatus,
  buildDayComparison,
  aggregateWeeklyData,
} from './services/weekly-data-aggregator.js';
// Next week plan section generator — carry-over tasks, planned tasks, and pending inbox
export {
  collectNextWeekPlannedTasks,
  collectCarryOverTasks,
  collectPendingInboxItems,
  mergeNextWeekItems,
  sourceLabel,
  formatNextWeekItem,
  formatNextWeekSection,
  generateNextWeekPlanSection,
} from './services/next-week-plan-generator.js';
// Completion rate calculator — per-day and weekly completion percentages
export {
  computeDayCompletionRate,
  computeDailyRates,
  computeWeeklyCompletionRate,
  buildCompletionReport,
  formatCompletionReport,
} from './services/completion-rate-calculator.js';
// Weekly review data collector — I/O layer that snapshots plan tasks, activity
// log, and budget data for a given agent/week, ready for report generation
export {
  splitTasksByType,
  groupLogEntriesByStatus,
  computeBudgetUtilization,
  collectWeeklyReviewData,
} from './services/weekly-review-collector.js';
// Weekly review orchestrator — assembles all sections and persists final document
export {
  nextISOWeek,
  isoWeeksInYear,
  mondayFromISOWeek as reviewMondayFromISOWeek,
  buildReviewHeader,
  assembleReviewDocument,
  buildReviewMetadata,
  reviewsDir,
  reviewPaths,
  persistReview,
  loadReview,
  listReviews,
  generateWeeklyReview,
} from './services/weekly-review-orchestrator.js';
// Daily review writer — generates reviews/daily-YYYY-MM-DD.md with exactly three
// H2 sections (Task Status, Adjustments for Tomorrow, Notes) populated from the
// agent's current weekly plan execution state. Review tasks are always excluded
// via isReviewObjectiveId() so only user work items appear in the report.
export {
  utcToLocalDate,
  weekdayName,
  tomorrowWeekdayName,
  dateToISOWeek,
  isoWeekToMondayDate,
  collectDayTasks,
  collectDayLogEntries,
  taskStatusIcon,
  formatDayTaskItem,
  formatTaskStatusSection as formatDailyTaskStatusSection,
  buildAdjustmentsForTomorrow,
  formatAdjustmentsSection,
  formatNotesSection,
  buildDailyReviewHeader,
  assembleDailyReview,
  dailyReviewDir,
  dailyReviewPaths,
  persistDailyReview,
  loadDailyReview,
  listDailyReviews,
  buildDailyReviewMetadata,
  generateDailyReview,
} from './services/daily-review-writer.js';
// Token tracker — high-level token usage recording and budget checking
export {
  recordTokenUsage,
  getWeeklyUsage,
  checkBudget,
  createTokenTracker,
} from './services/token-tracker.js';
// Budget enforcer — compares usage against budget, pauses agent and writes alert on exhaustion
export {
  enforceBudget,
  enforceAllBudgets,
  isAgentPaused,
  resumeAgent,
  topUpResume,
  loadAlert,
  alertFilePath,
  alertsDir,
  createBudgetEnforcer,
} from './services/budget-enforcer.js';
// Repeated-task-failure system-event emitter — fires a `repeated-task-failure`
// notification after a weekly task has hit `consecutiveFailures >= 2`. Wired
// into the heartbeat's `executeOneSelection` failure path; safe to call from
// any caller that runs after `weeklyPlanStore.updateTaskStatus(..., 'failed')`.
export {
  REPEATED_FAILURE_THRESHOLD,
  buildDedupKey as buildRepeatedFailureDedupKey,
  maybeEmitRepeatedFailureNotification,
} from './services/repeated-failure-notifier.js';
export type {
  MaybeEmitRepeatedFailureOptions,
  RepeatedFailureEmitOutcome,
} from './services/repeated-failure-notifier.js';
// Weekly calendar renderer — visual text-based calendar display
export {
  statusIcon,
  truncate,
  padTo,
  formatRateBar,
  formatDurationShort,
  renderDayCell,
  horizontalRule,
  renderCalendarHeader,
  renderWeeklySummary,
  renderWeeklyCalendar,
  renderCompactCalendar,
} from './services/weekly-calendar-renderer.js';
// Resume-agent skill — override/resume paused agents via CLI interaction
export {
  RESUME_ACTIONS,
  listPausedAgents,
  getPausedAgentDetails,
  validateResumeAction,
  executeResume,
  formatPausedAgentsList,
  formatPausedAgentDetails,
  formatResumeResult,
} from './skills/resume-agent.js';
// Status skill — agent status summary aggregation
export {
  getCurrentWeekString,
  getMondayDate as getStatusMondayDate,
  computeTaskCounts,
  buildAgentStatus,
  gatherAllAgentStatuses,
  formatNumber as formatStatusNumber,
  formatAgentStatus,
  formatStatusReport,
} from './skills/status.js';
// Query skill — filter the agent roster by role, status, keyword, or budget
// so downstream skills can operate on subsets like "active marketers".
export {
  normalizeStatusFilter,
  matchesRole,
  matchesKeyword,
  matchesStatus,
  matchesBudget,
  queryAgents,
  formatQueryResult,
  buildQueryRow,
  buildQueryChoices,
} from './skills/query.js';
// Init skill (Sub-AC 2, 3, 4) — bootstrap primitives (`pnpm install`,
// `.aweek/` tree), heartbeat crontab scaffolding, and the /aweek:hire
// handoff wiring that runs as init's final interactive step.
export {
  AWEEK_SUBDIRS,
  DEFAULT_DATA_DIR as INIT_DEFAULT_DATA_DIR,
  DEFAULT_HEARTBEAT_SCHEDULE,
  DEFAULT_HIRE_PROMPT_TEXT,
  DEFAULT_PACKAGE_MANAGER,
  HIRE_SKILL_NAME,
  PROJECT_HEARTBEAT_MARKER_PREFIX,
  buildHeartbeatCommand,
  buildHeartbeatEntry,
  buildHireLaunchInstruction,
  ensureDataDir,
  finalizeInit,
  formatHireLaunchPrompt,
  hasExistingAgents,
  installCronHeartbeat,
  installDependencies,
  installHeartbeat,
  parseProjectHeartbeat,
  projectHeartbeatMarker,
  queryCronHeartbeat,
  queryHeartbeat,
  removeProjectHeartbeat,
  resolveHeartbeatBackend,
  resolveProjectDir as resolveInitProjectDir,
  shouldLaunchHire,
  uninstallHeartbeat,
} from './skills/setup.js';
export {
  LAUNCHD_LABEL_PREFIX,
  DEFAULT_LAUNCHD_INTERVAL_SECONDS,
  buildLaunchdPlist,
  cronScheduleToSeconds,
  installLaunchdHeartbeat,
  launchdLabel,
  launchdPlistPath,
  parseLaunchdPlist,
  queryLaunchdHeartbeat,
  uninstallLaunchdHeartbeat,
} from './skills/launchd.js';
// Setup hire menu — four-option interactive menu
// (Hire all / Select some / Create new / Skip) that displays unhired
// subagents and routes the user's choice to the appropriate /aweek:hire
// branch, plus the fall-through that auto-delegates to /aweek:hire
// when no unhired subagents exist (so the user is never asked to choose
// between create-new and skip on an empty roster). See
// src/skills/setup-hire-menu.ts.
export {
  DEFAULT_MENU_PROMPT_TEXT as INIT_HIRE_MENU_DEFAULT_PROMPT_TEXT,
  DEFAULT_MENU_PROMPT_TEXT_NO_UNHIRED as INIT_HIRE_MENU_DEFAULT_PROMPT_TEXT_NO_UNHIRED,
  DEFAULT_FALL_THROUGH_REASON as INIT_HIRE_MENU_DEFAULT_FALL_THROUGH_REASON,
  INIT_HIRE_MENU_CHOICE,
  INIT_HIRE_MENU_OPTIONS,
  buildInitHireMenu,
  resolveInitHireMenu,
  formatInitHireMenuPrompt,
  routeInitHireMenuChoice,
  validateInitHireMenuChoice,
  validateSelectedSlugs as validateInitHireMenuSelectedSlugs,
} from './skills/setup-hire-menu.js';

// Time-zone utilities and the tiny .aweek/config.json store. Skill modules
// import from here rather than from the submodules directly so the public
// surface stays flat.
export {
  DEFAULT_TZ,
  currentWeekKey,
  detectSystemTimeZone,
  isValidTimeZone,
  localDayOffset,
  localHour,
  localParts,
  localWallClockToUtc,
  mondayOfWeek,
  parseLocalWallClock,
} from './time/zone.js';
export {
  configPath,
  loadConfig,
  saveConfig,
} from './storage/config-store.js';
// Free-form per-agent planning markdown (replaces config.goals /
// config.monthlyPlans). See src/storage/plan-markdown-store.js.
export {
  CANONICAL_SECTIONS as PLAN_CANONICAL_SECTIONS,
  PLAN_FILENAME,
  buildInitialPlan,
  buildPlanFromInterview,
  buildPlanFromLegacy,
  exists as planExists,
  migrateLegacyPlan,
  parsePlanMarkdownSections,
  planPath,
  readPlan,
  writePlan,
} from './storage/plan-markdown-store.js';
