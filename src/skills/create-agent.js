/**
 * Create-agent skill logic.
 * Assembles agent config from user-provided data, validates, and saves.
 * Used by the /aweek:create-agent Claude Code skill.
 */
import { join } from 'node:path';
import { AgentStore } from '../storage/agent-store.js';
import {
  createAgentConfig,
  createGoal,
  createObjective,
  createMonthlyPlan,
  createTask,
  createWeeklyPlan,
} from '../models/agent.js';
import { validateAgentConfig } from '../schemas/validator.js';

/** Default data directory (relative to project root) */
const DEFAULT_DATA_DIR = join(process.cwd(), 'data', 'agents');

/**
 * Get the current month in YYYY-MM format.
 * @returns {string}
 */
export function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Get the current ISO week in YYYY-Www format.
 * @returns {string}
 */
export function getCurrentWeek() {
  const now = new Date();
  // ISO week calculation
  const target = new Date(now.valueOf());
  const dayNr = (now.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
  }
  const weekNum = 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
  return `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Validate identity fields before agent creation.
 * @param {object} identity
 * @param {string} identity.name
 * @param {string} identity.role
 * @param {string} identity.systemPrompt
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateIdentityInput({ name, role, systemPrompt }) {
  const errors = [];

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    errors.push('Name is required and must be a non-empty string');
  } else if (name.length > 100) {
    errors.push('Name must be 100 characters or fewer');
  }

  if (!role || typeof role !== 'string' || role.trim().length === 0) {
    errors.push('Role is required and must be a non-empty string');
  } else if (role.length > 200) {
    errors.push('Role must be 200 characters or fewer');
  }

  if (!systemPrompt || typeof systemPrompt !== 'string' || systemPrompt.trim().length === 0) {
    errors.push('System prompt is required and must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate goal descriptions.
 * @param {string[]} goalDescriptions
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateGoalsInput(goalDescriptions) {
  const errors = [];

  if (!Array.isArray(goalDescriptions) || goalDescriptions.length === 0) {
    errors.push('At least 1 goal is required');
  } else if (goalDescriptions.length > 5) {
    errors.push('Maximum 5 goals allowed');
  }

  if (Array.isArray(goalDescriptions)) {
    goalDescriptions.forEach((desc, i) => {
      if (!desc || typeof desc !== 'string' || desc.trim().length < 10) {
        errors.push(`Goal ${i + 1}: must be at least 10 characters`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate objective inputs.
 * @param {{ description: string, goalIndex: number }[]} objectiveInputs
 * @param {number} goalCount
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateObjectivesInput(objectiveInputs, goalCount) {
  const errors = [];

  if (!Array.isArray(objectiveInputs) || objectiveInputs.length === 0) {
    errors.push('At least 1 objective is required');
  } else if (objectiveInputs.length > 5) {
    errors.push('Maximum 5 objectives allowed');
  }

  if (Array.isArray(objectiveInputs)) {
    objectiveInputs.forEach((obj, i) => {
      if (!obj.description || typeof obj.description !== 'string' || obj.description.trim().length === 0) {
        errors.push(`Objective ${i + 1}: description is required`);
      }
      if (typeof obj.goalIndex !== 'number' || obj.goalIndex < 0 || obj.goalIndex >= goalCount) {
        errors.push(`Objective ${i + 1}: must reference a valid goal (0-${goalCount - 1})`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate task inputs.
 * @param {{ description: string, objectiveIndex: number }[]} taskInputs
 * @param {number} objectiveCount
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateTasksInput(taskInputs, objectiveCount) {
  const errors = [];

  if (!Array.isArray(taskInputs) || taskInputs.length === 0) {
    errors.push('At least 1 task is required');
  } else if (taskInputs.length > 10) {
    errors.push('Maximum 10 tasks allowed');
  }

  if (Array.isArray(taskInputs)) {
    taskInputs.forEach((task, i) => {
      if (!task.description || typeof task.description !== 'string' || task.description.trim().length === 0) {
        errors.push(`Task ${i + 1}: description is required`);
      }
      if (typeof task.objectiveIndex !== 'number' || task.objectiveIndex < 0 || task.objectiveIndex >= objectiveCount) {
        errors.push(`Task ${i + 1}: must reference a valid objective (0-${objectiveCount - 1})`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate weekly token limit.
 * @param {number} limit
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateTokenLimit(limit) {
  const errors = [];
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    errors.push('Weekly token limit must be a positive integer');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Assemble and save a new agent from collected user inputs.
 *
 * @param {object} params
 * @param {string} params.name - Agent name
 * @param {string} params.role - Agent role description
 * @param {string} params.systemPrompt - System prompt for Claude sessions
 * @param {number} [params.weeklyTokenLimit=500000] - Weekly token budget
 * @param {string[]} params.goalDescriptions - Array of goal description strings
 * @param {{ description: string, goalIndex: number }[]} params.objectives - Objectives with goal references
 * @param {{ description: string, objectiveIndex: number }[]} params.tasks - Tasks with objective references
 * @param {string} [params.dataDir] - Override data directory path
 * @returns {Promise<{ success: boolean, config?: object, errors?: string[] }>}
 */
export async function assembleAndSaveAgent({
  name,
  role,
  systemPrompt,
  weeklyTokenLimit = 500_000,
  goalDescriptions,
  objectives,
  tasks,
  dataDir,
}) {
  // Validate all inputs
  const allErrors = [];

  const identityResult = validateIdentityInput({ name, role, systemPrompt });
  if (!identityResult.valid) allErrors.push(...identityResult.errors);

  const tokenResult = validateTokenLimit(weeklyTokenLimit);
  if (!tokenResult.valid) allErrors.push(...tokenResult.errors);

  const goalsResult = validateGoalsInput(goalDescriptions);
  if (!goalsResult.valid) allErrors.push(...goalsResult.errors);

  // Only validate objectives/tasks if goals are valid (need goalCount)
  if (goalsResult.valid) {
    const objResult = validateObjectivesInput(objectives, goalDescriptions.length);
    if (!objResult.valid) allErrors.push(...objResult.errors);

    if (objResult.valid) {
      const taskResult = validateTasksInput(tasks, objectives.length);
      if (!taskResult.valid) allErrors.push(...taskResult.errors);
    }
  }

  if (allErrors.length > 0) {
    return { success: false, errors: allErrors };
  }

  // Assemble the agent config
  const config = createAgentConfig({ name, role, systemPrompt, weeklyTokenLimit });

  // Add goals
  const goalObjects = goalDescriptions.map((desc) => {
    const g = createGoal(desc);
    config.goals.push(g);
    return g;
  });

  // Create monthly plan with objectives
  const month = getCurrentMonth();
  const objectiveObjects = objectives.map(({ description, goalIndex }) => {
    return createObjective(description, goalObjects[goalIndex].id);
  });
  const monthlyPlan = createMonthlyPlan(month, objectiveObjects);
  config.monthlyPlans.push(monthlyPlan);

  // Create weekly plan with tasks
  const week = getCurrentWeek();
  const taskObjects = tasks.map(({ description, objectiveIndex }) => {
    return createTask(description, objectiveObjects[objectiveIndex].id);
  });
  const weeklyPlan = createWeeklyPlan(week, month, taskObjects);
  config.weeklyPlans.push(weeklyPlan);

  // Schema validation
  const schemaResult = validateAgentConfig(config);
  if (!schemaResult.valid) {
    const messages = schemaResult.errors.map(
      (e) => `${e.instancePath || '/'}: ${e.message}`
    );
    return { success: false, errors: messages };
  }

  // Save
  const store = new AgentStore(dataDir || DEFAULT_DATA_DIR);
  await store.save(config);

  return { success: true, config };
}

/**
 * Format a summary of the created agent for display.
 * @param {object} config - The saved agent config
 * @returns {string}
 */
export function formatAgentSummary(config) {
  const goalCount = config.goals.length;
  const objCount = config.monthlyPlans[0]?.objectives.length || 0;
  const taskCount = config.weeklyPlans[0]?.tasks.length || 0;
  const month = config.monthlyPlans[0]?.month || 'N/A';
  const week = config.weeklyPlans[0]?.week || 'N/A';

  return [
    'Agent created successfully!',
    '',
    `  ID:     ${config.id}`,
    `  Name:   ${config.identity.name}`,
    `  Role:   ${config.identity.role}`,
    `  Goals:  ${goalCount} goal${goalCount !== 1 ? 's' : ''}`,
    `  Monthly objectives: ${objCount} objective${objCount !== 1 ? 's' : ''} for ${month}`,
    `  Weekly tasks: ${taskCount} task${taskCount !== 1 ? 's' : ''} for ${week}`,
    `  Token budget: ${config.budget.weeklyTokenLimit.toLocaleString()} tokens/week`,
    `  Status: Weekly plan pending approval`,
    '',
    'Next steps:',
    '  - Review the weekly plan with /aweek:approve-plan',
    '  - Heartbeat will activate after first weekly plan approval',
  ].join('\n');
}
