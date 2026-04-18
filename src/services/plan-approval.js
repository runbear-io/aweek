/**
 * Plan-approval service — shared weekly-plan approval / rejection / edit logic.
 *
 * This module is the single source of truth for:
 *   - Locating an agent's pending weekly plan.
 *   - Formatting it for human review.
 *   - Validating an approval decision (approve / reject / edit) and any
 *     accompanying edit operations.
 *   - Applying edit operations to a weekly plan (mutating the tasks array).
 *   - Running the full approval pipeline (`processApproval`) — load agent,
 *     mutate, persist, optionally install the heartbeat crontab.
 *   - Three ergonomic convenience wrappers (`approve`, `reject`, `edit`) that
 *     the consolidated `/aweek:plan` skill calls directly so its surface is
 *     decision-specific instead of passing a `decision` string through a
 *     single omnibus function.
 *   - Formatting the result for user-facing output.
 *
 * It is consumed by:
 *   - The consolidated `/aweek:plan` skill — imports `approve`, `reject`,
 *     `edit`, `loadPlanForReview`, and the formatters directly.
 *   - `src/skills/approve-plan.js` — the legacy skill module kept as a thin
 *     re-export shim so the existing test suite and public API keep working
 *     during the transition to the new skill surface.
 *
 * Design notes:
 *   - Validators are pure functions. They take the raw input plus the
 *     necessary context (plan / agent config) and return `{ valid, errors }`.
 *   - `applyEdits` mutates the plan's tasks array and returns the list of
 *     applied edits for later reporting.
 *   - `processApproval` is the single "do everything" entry point used by the
 *     legacy skill. The new skill uses the `approve` / `reject` / `edit`
 *     wrappers which delegate to `processApproval` with the correct decision.
 *   - Heartbeat activation is idempotent — installing an existing crontab
 *     entry simply replaces it — and failures are treated as non-fatal so
 *     approval never rolls back because `crontab` is missing.
 */
import { createTask } from '../models/agent.js';
import { validateWeeklyPlan } from '../schemas/validator.js';
import { install as installCrontab } from '../heartbeat/crontab-manager.js';
import { createAgentStore } from '../storage/agent-helpers.js';

/** Valid approval decisions */
export const APPROVAL_DECISIONS = ['approve', 'reject', 'edit'];

// ---------------------------------------------------------------------------
// Plan lookup
// ---------------------------------------------------------------------------

/**
 * Find the pending (unapproved) weekly plan for an agent.
 * Searches the agent config's weeklyPlans array for the first unapproved plan.
 *
 * @param {object} agentConfig - The agent config object
 * @returns {{ plan: object, week: string } | null} The pending plan and its week, or null
 */
export function findPendingPlan(agentConfig) {
  if (!agentConfig || !Array.isArray(agentConfig.weeklyPlans)) return null;

  const pending = agentConfig.weeklyPlans.find((p) => p.approved === false);
  if (!pending) return null;

  return { plan: pending, week: pending.week };
}

// ---------------------------------------------------------------------------
// Plan formatting
// ---------------------------------------------------------------------------

/**
 * Format a weekly plan for human review.
 * Produces a readable text summary of the plan including:
 * - Agent identity (display name + optional live .md description)
 * - Week and month
 * - Tasks with priority, objective link, and status
 *
 * Identity after the aweek ↔ Claude Code subagent 1-to-1 refactor lives in
 * the subagent .md file, NOT in aweek JSON. This formatter is a pure sync
 * function that deliberately does not read from disk, so the display name is
 * sourced from the aweek JSON's `subagentRef` (which equals the slug/id).
 * Callers that want the live human-readable name from the .md frontmatter can
 * pass it via `opts.subagentIdentity` — e.g., summary dashboard and the
 * `/aweek:plan` skill wire this through from `readSubagentIdentity`.
 *
 * @param {object} agentConfig - The agent config
 * @param {object} plan - The weekly plan to format
 * @param {object} [opts]
 * @param {{ name?: string, description?: string, missing?: boolean }} [opts.subagentIdentity] -
 *   Optional live identity from the .md frontmatter. When omitted, the slug
 *   is used as the display name.
 * @returns {string} Formatted plan text
 */
export function formatPlanForReview(agentConfig, plan, opts = {}) {
  const subagentRef = agentConfig.subagentRef || agentConfig.id;
  const identity = opts.subagentIdentity || null;
  const displayName =
    identity && !identity.missing && identity.name ? identity.name : subagentRef;
  const descriptor = identity && !identity.missing && identity.description
    ? `${displayName} (${identity.description})`
    : displayName;

  const lines = [
    `Weekly Plan Review: ${displayName}`,
    `${'='.repeat(50)}`,
    `  Agent:  ${descriptor}`,
    `  Slug:   ${subagentRef}`,
    `  Week:   ${plan.week}`,
    `  Month:  ${plan.month}`,
    `  Status: ${plan.approved ? 'Approved' : 'Pending Approval'}`,
    '',
    `Tasks (${plan.tasks.length}):`,
  ];

  if (plan.tasks.length === 0) {
    lines.push('  (no tasks)');
  } else {
    for (const [i, task] of plan.tasks.entries()) {
      const priority = task.priority ? `[${task.priority.toUpperCase()}]` : '[MEDIUM]';
      const est = task.estimatedMinutes ? ` (~${task.estimatedMinutes}min)` : '';
      lines.push(`  ${i + 1}. ${priority} ${task.description}${est}`);
      lines.push(`     ID: ${task.id} | Objective: ${task.objectiveId} | Status: ${task.status}`);
    }
  }

  // Show objective mapping for traceability
  const objectiveIds = [...new Set(plan.tasks.map((t) => t.objectiveId))];
  if (objectiveIds.length > 0) {
    lines.push('');
    lines.push('Traceability:');
    for (const objId of objectiveIds) {
      // Find the objective in monthly plans
      let objDesc = objId;
      let goalDesc = '';
      for (const mp of agentConfig.monthlyPlans || []) {
        const obj = mp.objectives.find((o) => o.id === objId);
        if (obj) {
          objDesc = `${objId}: ${obj.description}`;
          // Find the goal
          const goal = agentConfig.goals.find((g) => g.id === obj.goalId);
          if (goal) {
            goalDesc = ` -> Goal: ${goal.description}`;
          }
          break;
        }
      }
      lines.push(`  ${objDesc}${goalDesc}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Validate a plan approval decision.
 * @param {string} decision - 'approve', 'reject', or 'edit'
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDecision(decision) {
  const errors = [];
  if (!decision || typeof decision !== 'string') {
    errors.push('Decision is required');
  } else if (!APPROVAL_DECISIONS.includes(decision)) {
    errors.push(`Decision must be one of: ${APPROVAL_DECISIONS.join(', ')}`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate edit operations for a weekly plan.
 * Each edit can add, remove, or update a task.
 *
 * @param {object[]} edits - Array of edit operations
 * @param {object} plan - The current weekly plan
 * @param {object} agentConfig - The agent config (for objective validation)
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateEdits(edits, plan, agentConfig) {
  const errors = [];

  if (!Array.isArray(edits) || edits.length === 0) {
    errors.push('At least one edit is required');
    return { valid: false, errors };
  }

  const validActions = ['add', 'remove', 'update'];

  for (const [i, edit] of edits.entries()) {
    if (!edit || typeof edit !== 'object') {
      errors.push(`edit[${i}]: must be an object`);
      continue;
    }

    if (!validActions.includes(edit.action)) {
      errors.push(`edit[${i}]: action must be one of: ${validActions.join(', ')}`);
      continue;
    }

    if (edit.action === 'add') {
      if (!edit.description || typeof edit.description !== 'string' || edit.description.trim().length === 0) {
        errors.push(`edit[${i}]: description is required for adding a task`);
      }
      if (!edit.objectiveId || typeof edit.objectiveId !== 'string') {
        errors.push(`edit[${i}]: objectiveId is required for adding a task`);
      } else {
        // Verify the objective exists
        let found = false;
        for (const mp of agentConfig.monthlyPlans || []) {
          if (mp.objectives.find((o) => o.id === edit.objectiveId)) {
            found = true;
            break;
          }
        }
        if (!found) {
          errors.push(`edit[${i}]: objective not found: ${edit.objectiveId}`);
        }
      }
    }

    if (edit.action === 'remove') {
      if (!edit.taskId || typeof edit.taskId !== 'string') {
        errors.push(`edit[${i}]: taskId is required for removing a task`);
      } else if (!plan.tasks.find((t) => t.id === edit.taskId)) {
        errors.push(`edit[${i}]: task not found: ${edit.taskId}`);
      }
    }

    if (edit.action === 'update') {
      if (!edit.taskId || typeof edit.taskId !== 'string') {
        errors.push(`edit[${i}]: taskId is required for updating a task`);
      } else if (!plan.tasks.find((t) => t.id === edit.taskId)) {
        errors.push(`edit[${i}]: task not found: ${edit.taskId}`);
      }
      if (edit.description !== undefined && (typeof edit.description !== 'string' || edit.description.trim().length === 0)) {
        errors.push(`edit[${i}]: description must be a non-empty string`);
      }
      if (edit.priority !== undefined) {
        const validPriorities = ['critical', 'high', 'medium', 'low'];
        if (!validPriorities.includes(edit.priority)) {
          errors.push(`edit[${i}]: priority must be one of: ${validPriorities.join(', ')}`);
        }
      }
      if (edit.estimatedMinutes !== undefined) {
        if (!Number.isInteger(edit.estimatedMinutes) || edit.estimatedMinutes < 1 || edit.estimatedMinutes > 480) {
          errors.push(`edit[${i}]: estimatedMinutes must be an integer between 1 and 480`);
        }
      }
      // Must provide at least one field to update
      if (edit.description === undefined && edit.priority === undefined && edit.estimatedMinutes === undefined) {
        errors.push(`edit[${i}]: at least one field to update is required (description, priority, or estimatedMinutes)`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Edit application
// ---------------------------------------------------------------------------

/**
 * Apply edits to a weekly plan (mutates the plan's tasks array).
 * Operations: add, remove, update tasks.
 *
 * @param {object} plan - The weekly plan to edit
 * @param {object[]} edits - Array of edit operations
 * @returns {{ applied: object[], plan: object }} The applied edits and modified plan
 */
export function applyEdits(plan, edits) {
  const applied = [];

  for (const edit of edits) {
    if (edit.action === 'add') {
      const task = createTask(edit.description, edit.objectiveId, {
        priority: edit.priority || 'medium',
        estimatedMinutes: edit.estimatedMinutes,
      });
      plan.tasks.push(task);
      applied.push({ action: 'add', taskId: task.id, description: task.description });
    }

    if (edit.action === 'remove') {
      const idx = plan.tasks.findIndex((t) => t.id === edit.taskId);
      if (idx !== -1) {
        const removed = plan.tasks.splice(idx, 1)[0];
        applied.push({ action: 'remove', taskId: edit.taskId, description: removed.description });
      }
    }

    if (edit.action === 'update') {
      const task = plan.tasks.find((t) => t.id === edit.taskId);
      if (task) {
        const changes = {};
        if (edit.description !== undefined) {
          changes.description = { from: task.description, to: edit.description };
          task.description = edit.description;
        }
        if (edit.priority !== undefined) {
          changes.priority = { from: task.priority, to: edit.priority };
          task.priority = edit.priority;
        }
        if (edit.estimatedMinutes !== undefined) {
          changes.estimatedMinutes = { from: task.estimatedMinutes, to: edit.estimatedMinutes };
          task.estimatedMinutes = edit.estimatedMinutes;
        }
        applied.push({ action: 'update', taskId: edit.taskId, changes });
      }
    }
  }

  plan.updatedAt = new Date().toISOString();
  return { applied, plan };
}

// ---------------------------------------------------------------------------
// Heartbeat activation
// ---------------------------------------------------------------------------

/**
 * Build the default heartbeat command for an agent.
 * This is the shell command that crontab will execute on each heartbeat cycle.
 *
 * @param {string} agentId - The agent identifier
 * @param {string} [projectDir] - Project root directory (defaults to cwd)
 * @returns {string} The shell command to run
 */
export function buildHeartbeatCommand(agentId, projectDir) {
  const dir = projectDir || process.cwd();
  return `npx aweek heartbeat ${agentId} --project-dir ${dir}`;
}

/**
 * Activate the heartbeat schedule for an agent by installing a crontab entry.
 * Idempotent: safe to call multiple times (existing entry is replaced).
 *
 * @param {object} params
 * @param {string} params.agentId - Agent identifier
 * @param {string} [params.schedule='0 * * * *'] - Cron schedule (default: every hour)
 * @param {string} [params.command] - Override heartbeat command (default: auto-built)
 * @param {string} [params.projectDir] - Project root directory
 * @param {Function} [params.installFn] - Override install function (for testing)
 * @returns {Promise<{activated: boolean, entry: string, schedule: string}>}
 */
export async function activateHeartbeat({
  agentId,
  schedule = '0 * * * *',
  command,
  projectDir,
  installFn,
}) {
  if (!agentId) throw new Error('agentId is required');

  const heartbeatCommand = command || buildHeartbeatCommand(agentId, projectDir);
  const installer = installFn || installCrontab;

  const result = await installer({ agentId, command: heartbeatCommand, schedule });

  return {
    activated: result.installed,
    entry: result.entry,
    schedule,
  };
}

// ---------------------------------------------------------------------------
// Core approval flow
// ---------------------------------------------------------------------------

/**
 * Process a weekly plan approval decision.
 *
 * - **approve**: Marks the plan as approved with timestamp. First approval triggers heartbeat.
 * - **reject**: Deletes the plan from the agent's weeklyPlans array. Agent can regenerate.
 * - **edit**: Applies edits, then optionally auto-approves if autoApprove is set.
 *
 * @param {object} params
 * @param {string} params.agentId - The agent whose plan to process
 * @param {string} params.decision - 'approve', 'reject', or 'edit'
 * @param {object[]} [params.edits] - Required if decision is 'edit'
 * @param {boolean} [params.autoApproveAfterEdit=false] - If true, auto-approve after editing
 * @param {string} [params.rejectionReason] - Optional reason for rejection
 * @param {string} [params.dataDir] - Override data directory path
 * @param {string} [params.heartbeatSchedule='0 * * * *'] - Cron schedule for heartbeat
 * @param {string} [params.heartbeatCommand] - Override heartbeat command
 * @param {string} [params.projectDir] - Project root for heartbeat command
 * @param {Function} [params.installFn] - Override crontab install (for testing)
 * @returns {Promise<{ success: boolean, plan?: object, isFirstApproval?: boolean, heartbeatActivated?: boolean, editResults?: object[], errors?: string[] }>}
 */
export async function processApproval({
  agentId,
  decision,
  edits,
  autoApproveAfterEdit = false,
  rejectionReason,
  dataDir,
  heartbeatSchedule,
  heartbeatCommand,
  projectDir,
  installFn,
}) {
  // Validate decision
  const decisionResult = validateDecision(decision);
  if (!decisionResult.valid) {
    return { success: false, errors: decisionResult.errors };
  }

  // Load agent
  const store = createAgentStore(dataDir);
  let config;
  try {
    config = await store.load(agentId);
  } catch {
    return { success: false, errors: [`Agent not found: ${agentId}`] };
  }

  // Find pending plan
  const pending = findPendingPlan(config);
  if (!pending) {
    return { success: false, errors: ['No pending weekly plan found for this agent'] };
  }

  const { plan } = pending;

  // Check if this is the first-ever approval for this agent
  const hasAnyApproved = config.weeklyPlans.some((p) => p.approved === true);

  // --- APPROVE ---
  if (decision === 'approve') {
    plan.approved = true;
    plan.approvedAt = new Date().toISOString();
    plan.updatedAt = new Date().toISOString();
    config.updatedAt = new Date().toISOString();
    await store.save(config);

    // Activate heartbeat on approval (idempotent — safe for first and subsequent)
    let heartbeatActivated = false;
    try {
      const hbResult = await activateHeartbeat({
        agentId,
        schedule: heartbeatSchedule,
        command: heartbeatCommand,
        projectDir,
        installFn,
      });
      heartbeatActivated = hbResult.activated;
    } catch {
      // Heartbeat activation failure is non-fatal — plan is already approved
      // The user can manually install via crontab manager
      heartbeatActivated = false;
    }

    return {
      success: true,
      plan,
      isFirstApproval: !hasAnyApproved,
      heartbeatActivated,
    };
  }

  // --- REJECT ---
  if (decision === 'reject') {
    const idx = config.weeklyPlans.indexOf(plan);
    if (idx !== -1) {
      config.weeklyPlans.splice(idx, 1);
    }
    config.updatedAt = new Date().toISOString();
    await store.save(config);

    return {
      success: true,
      plan: { ...plan, _rejected: true, _rejectionReason: rejectionReason || null },
      isFirstApproval: false,
    };
  }

  // --- EDIT ---
  if (decision === 'edit') {
    // Validate edits
    const editResult = validateEdits(edits, plan, config);
    if (!editResult.valid) {
      return { success: false, errors: editResult.errors };
    }

    // Apply edits
    const { applied } = applyEdits(plan, edits);

    // Validate the modified plan against schema
    const schemaResult = validateWeeklyPlan(plan);
    if (!schemaResult.valid) {
      const messages = schemaResult.errors.map(
        (e) => `${e.instancePath || '/'}: ${e.message}`,
      );
      return { success: false, errors: messages };
    }

    // Optionally auto-approve after edit
    let heartbeatActivated = false;
    if (autoApproveAfterEdit) {
      plan.approved = true;
      plan.approvedAt = new Date().toISOString();

      // Activate heartbeat on auto-approve (idempotent)
      try {
        const hbResult = await activateHeartbeat({
          agentId,
          schedule: heartbeatSchedule,
          command: heartbeatCommand,
          projectDir,
          installFn,
        });
        heartbeatActivated = hbResult.activated;
      } catch {
        heartbeatActivated = false;
      }
    }

    config.updatedAt = new Date().toISOString();
    await store.save(config);

    return {
      success: true,
      plan,
      editResults: applied,
      isFirstApproval: autoApproveAfterEdit && !hasAnyApproved,
      heartbeatActivated,
    };
  }

  return { success: false, errors: [`Unhandled decision: ${decision}`] };
}

// ---------------------------------------------------------------------------
// Decision-specific convenience wrappers
//
// These are the preferred entry points for the consolidated `/aweek:plan`
// skill: each wrapper is decision-specific, so the skill code reads as
// `await approve({ agentId })` / `await reject(...)` / `await edit(...)`
// instead of passing a stringly-typed `decision` field.
// ---------------------------------------------------------------------------

/**
 * Approve an agent's pending weekly plan.
 *
 * Thin wrapper over {@link processApproval} that hard-codes
 * `decision: 'approve'` and forwards the rest of the params. Triggers
 * heartbeat installation on success.
 *
 * @param {object} params
 * @param {string} params.agentId - Agent whose plan to approve
 * @param {string} [params.dataDir] - Override data directory path
 * @param {string} [params.heartbeatSchedule='0 * * * *'] - Cron schedule
 * @param {string} [params.heartbeatCommand] - Override heartbeat command
 * @param {string} [params.projectDir] - Project root for heartbeat command
 * @param {Function} [params.installFn] - Override crontab install (for testing)
 * @returns {Promise<ReturnType<typeof processApproval>>}
 */
export function approve(params = {}) {
  return processApproval({ ...params, decision: 'approve' });
}

/**
 * Reject an agent's pending weekly plan.
 *
 * Thin wrapper over {@link processApproval} that hard-codes
 * `decision: 'reject'`. Removes the plan so the agent can regenerate a new
 * one. Does NOT activate the heartbeat.
 *
 * @param {object} params
 * @param {string} params.agentId - Agent whose plan to reject
 * @param {string} [params.rejectionReason] - Optional human-readable reason
 * @param {string} [params.dataDir] - Override data directory path
 * @returns {Promise<ReturnType<typeof processApproval>>}
 */
export function reject(params = {}) {
  return processApproval({ ...params, decision: 'reject' });
}

/**
 * Edit an agent's pending weekly plan (add/remove/update tasks).
 *
 * Thin wrapper over {@link processApproval} that hard-codes
 * `decision: 'edit'`. By default leaves the plan in pending state so the
 * user can review again — pass `autoApproveAfterEdit: true` to approve and
 * activate the heartbeat in a single call.
 *
 * @param {object} params
 * @param {string} params.agentId - Agent whose plan to edit
 * @param {object[]} params.edits - Array of edit operations
 * @param {boolean} [params.autoApproveAfterEdit=false] - Approve after edits
 * @param {string} [params.dataDir] - Override data directory path
 * @param {string} [params.heartbeatSchedule='0 * * * *'] - Cron schedule
 * @param {string} [params.heartbeatCommand] - Override heartbeat command
 * @param {string} [params.projectDir] - Project root for heartbeat command
 * @param {Function} [params.installFn] - Override crontab install (for testing)
 * @returns {Promise<ReturnType<typeof processApproval>>}
 */
export function edit(params = {}) {
  return processApproval({ ...params, decision: 'edit' });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format the result of an approval action for display.
 * @param {object} result - The result from processApproval
 * @param {string} decision - The decision that was made
 * @returns {string}
 */
export function formatApprovalResult(result, decision) {
  if (!result.success) {
    return `Approval failed:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`;
  }

  const lines = [];

  if (decision === 'approve') {
    lines.push('Weekly plan approved!');
    if (result.isFirstApproval) {
      lines.push('');
      lines.push('*** FIRST APPROVAL — Heartbeat system is now active! ***');
      lines.push('The agent will begin executing tasks on the next heartbeat cycle.');
    }
    if (result.heartbeatActivated) {
      lines.push('Heartbeat crontab installed successfully.');
    } else if (result.heartbeatActivated === false && result.success) {
      lines.push('Note: Heartbeat crontab could not be installed automatically. Install manually if needed.');
    }
    lines.push('');
    lines.push(`  Week: ${result.plan.week}`);
    lines.push(`  Tasks: ${result.plan.tasks.length}`);
    lines.push(`  Approved at: ${result.plan.approvedAt}`);
  }

  if (decision === 'reject') {
    lines.push('Weekly plan rejected.');
    if (result.plan._rejectionReason) {
      lines.push(`  Reason: ${result.plan._rejectionReason}`);
    }
    lines.push('');
    lines.push('The plan has been removed. You can regenerate a new plan or create one manually.');
  }

  if (decision === 'edit') {
    lines.push(`Weekly plan edited (${result.editResults.length} change(s) applied).`);
    lines.push('');
    for (const edit of result.editResults) {
      if (edit.action === 'add') {
        lines.push(`  + Added: ${edit.description} (${edit.taskId})`);
      } else if (edit.action === 'remove') {
        lines.push(`  - Removed: ${edit.description} (${edit.taskId})`);
      } else if (edit.action === 'update') {
        const changes = Object.entries(edit.changes)
          .map(([k, v]) => `${k}: "${v.from}" -> "${v.to}"`)
          .join(', ');
        lines.push(`  ~ Updated ${edit.taskId}: ${changes}`);
      }
    }

    if (result.plan.approved) {
      lines.push('');
      lines.push('Plan auto-approved after edits.');
      if (result.isFirstApproval) {
        lines.push('');
        lines.push('*** FIRST APPROVAL — Heartbeat system is now active! ***');
      }
      if (result.heartbeatActivated) {
        lines.push('Heartbeat crontab installed successfully.');
      }
    } else {
      lines.push('');
      lines.push('Plan is still pending approval. Use /aweek:approve-plan to approve.');
    }
  }

  return lines.join('\n');
}

/**
 * Load an agent and get its pending plan for review.
 * Convenience function for the skill to present the plan before asking for a decision.
 *
 * @param {object} params
 * @param {string} params.agentId - The agent ID
 * @param {string} [params.dataDir] - Override data directory path
 * @returns {Promise<{ success: boolean, config?: object, plan?: object, formatted?: string, errors?: string[] }>}
 */
export async function loadPlanForReview({ agentId, dataDir }) {
  const store = createAgentStore(dataDir);
  let config;
  try {
    config = await store.load(agentId);
  } catch {
    return { success: false, errors: [`Agent not found: ${agentId}`] };
  }

  const pending = findPendingPlan(config);
  if (!pending) {
    return { success: false, errors: ['No pending weekly plan found for this agent'] };
  }

  const formatted = formatPlanForReview(config, pending.plan);

  return {
    success: true,
    config,
    plan: pending.plan,
    formatted,
  };
}
