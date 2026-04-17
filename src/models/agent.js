/**
 * Agent model — factory functions for creating valid agent data structures.
 * These produce objects that conform to the JSON schemas.
 */
import { randomBytes } from 'node:crypto';

/** Generate a short random ID suffix */
const shortId = () => randomBytes(4).toString('hex');

/**
 * Create a new agent config with sensible defaults.
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.role
 * @param {string} opts.systemPrompt
 * @param {number} [opts.weeklyTokenLimit=500000]
 * @returns {object} A valid agent config object
 */
export function createAgentConfig({ name, role, systemPrompt, weeklyTokenLimit = 500_000 }) {
  const now = new Date().toISOString();
  const id = `agent-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${shortId()}`;

  return {
    id,
    identity: { name, role, systemPrompt },
    goals: [],
    monthlyPlans: [],
    weeklyPlans: [],
    weeklyTokenBudget: weeklyTokenLimit,
    budget: {
      weeklyTokenLimit,
      currentUsage: 0,
      periodStart: getMondayISO(),
      paused: false,
      sessions: [],
    },
    inbox: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Create a goal object with time horizon.
 * @param {string} description
 * @param {'1mo' | '3mo' | '1yr'} [horizon='3mo'] - Time horizon for the goal
 * @returns {object}
 */
export function createGoal(description, horizon = '3mo') {
  return {
    id: `goal-${shortId()}`,
    description,
    horizon,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create a monthly plan objective.
 * @param {string} description
 * @param {string} goalId - The parent goal ID
 * @returns {object}
 */
export function createObjective(description, goalId) {
  return {
    id: `obj-${shortId()}`,
    description,
    goalId,
    status: 'planned',
  };
}

/**
 * Create a monthly plan.
 * @param {string} month - YYYY-MM
 * @param {object[]} objectives
 * @param {object} [opts]
 * @param {'draft' | 'active' | 'completed' | 'archived'} [opts.status='active']
 * @param {string} [opts.summary]
 * @returns {object}
 */
export function createMonthlyPlan(month, objectives, { status = 'active', summary } = {}) {
  const plan = {
    month,
    objectives,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (summary) plan.summary = summary;
  return plan;
}

/**
 * Create a weekly task.
 * @param {string} description
 * @param {string} objectiveId - The parent objective ID
 * @param {object} [opts]
 * @param {'critical' | 'high' | 'medium' | 'low'} [opts.priority='medium'] - Task priority
 * @param {number} [opts.estimatedMinutes] - Estimated time in minutes (1–480)
 * @returns {object}
 */
export function createTask(description, objectiveId, { priority = 'medium', estimatedMinutes } = {}) {
  const task = {
    id: `task-${shortId()}`,
    description,
    objectiveId,
    priority,
    status: 'pending',
  };
  if (estimatedMinutes != null) task.estimatedMinutes = estimatedMinutes;
  return task;
}

/**
 * Create a weekly plan.
 * @param {string} week - YYYY-Www
 * @param {string} month - YYYY-MM
 * @param {object[]} tasks
 * @returns {object}
 */
export function createWeeklyPlan(week, month, tasks) {
  return {
    week,
    month,
    tasks,
    approved: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Create an inbox message for inter-agent delegation.
 * @param {object} options
 * @param {string} options.from - Sender agent ID
 * @param {string} options.to - Recipient agent ID
 * @param {string} options.taskDescription - Description of the delegated task
 * @param {object} [options.opts] - Optional fields
 * @param {string} [options.opts.type] - Message type (default: 'task-delegation')
 * @param {string} [options.opts.priority] - Priority level (default: 'medium')
 * @param {string} [options.opts.context] - Additional context
 * @param {string} [options.opts.sourceTaskId] - Originating weekly task ID
 * @returns {object}
 */
export function createInboxMessage(from, to, taskDescription, opts = {}) {
  const msg = {
    id: `msg-${shortId()}`,
    from,
    to,
    type: opts.type || 'task-delegation',
    taskDescription,
    priority: opts.priority || 'medium',
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  if (opts.context) msg.context = opts.context;
  if (opts.sourceTaskId) msg.sourceTaskId = opts.sourceTaskId;
  return msg;
}

// ---------------------------------------------------------------------------
// Goal management helpers
// ---------------------------------------------------------------------------

/**
 * Add a goal to an agent config (mutates config).
 * @param {object} config - Agent config
 * @param {object} goal - Goal object (from createGoal)
 * @returns {object} The added goal
 */
export function addGoal(config, goal) {
  config.goals.push(goal);
  config.updatedAt = new Date().toISOString();
  return goal;
}

/**
 * Update a goal's status within an agent config.
 * @param {object} config - Agent config
 * @param {string} goalId - The goal ID to update
 * @param {'active' | 'completed' | 'paused' | 'dropped'} status
 * @returns {object | null} The updated goal, or null if not found
 */
export function updateGoalStatus(config, goalId, status) {
  const goal = config.goals.find((g) => g.id === goalId);
  if (!goal) return null;
  goal.status = status;
  if (status === 'completed') {
    goal.completedAt = new Date().toISOString();
  }
  config.updatedAt = new Date().toISOString();
  return goal;
}

/**
 * Remove a goal from an agent config by ID.
 * @param {object} config - Agent config
 * @param {string} goalId - The goal ID to remove
 * @returns {boolean} True if removed, false if not found
 */
export function removeGoal(config, goalId) {
  const idx = config.goals.findIndex((g) => g.id === goalId);
  if (idx === -1) return false;
  config.goals.splice(idx, 1);
  config.updatedAt = new Date().toISOString();
  return true;
}

/**
 * Get goals filtered by time horizon.
 * @param {object} config - Agent config
 * @param {'1mo' | '3mo' | '1yr'} horizon
 * @returns {object[]}
 */
export function getGoalsByHorizon(config, horizon) {
  return config.goals.filter((g) => g.horizon === horizon);
}

/**
 * Get all active goals from an agent config.
 * @param {object} config - Agent config
 * @returns {object[]}
 */
export function getActiveGoals(config) {
  return config.goals.filter((g) => g.status === 'active');
}

// ---------------------------------------------------------------------------
// Monthly plan management helpers
// ---------------------------------------------------------------------------

/**
 * Add a monthly plan to an agent config (mutates config).
 * @param {object} config - Agent config
 * @param {object} plan - Monthly plan object (from createMonthlyPlan)
 * @returns {object} The added plan
 */
export function addMonthlyPlan(config, plan) {
  config.monthlyPlans.push(plan);
  config.updatedAt = new Date().toISOString();
  return plan;
}

/**
 * Get the monthly plan for a specific month.
 * @param {object} config - Agent config
 * @param {string} month - YYYY-MM
 * @returns {object | undefined}
 */
export function getMonthlyPlan(config, month) {
  return config.monthlyPlans.find((p) => p.month === month);
}

/**
 * Get the currently active monthly plan (status === 'active').
 * @param {object} config - Agent config
 * @returns {object | undefined}
 */
export function getActiveMonthlyPlan(config) {
  return config.monthlyPlans.find((p) => p.status === 'active');
}

/**
 * Update a monthly plan's status.
 * @param {object} config - Agent config
 * @param {string} month - YYYY-MM
 * @param {'draft' | 'active' | 'completed' | 'archived'} status
 * @returns {object | null} The updated plan, or null if not found
 */
export function updateMonthlyPlanStatus(config, month, status) {
  const plan = config.monthlyPlans.find((p) => p.month === month);
  if (!plan) return null;
  plan.status = status;
  plan.updatedAt = new Date().toISOString();
  config.updatedAt = new Date().toISOString();
  return plan;
}

/**
 * Update an objective's status within monthly plans.
 * Searches all monthly plans to find the objective by ID.
 * @param {object} config - Agent config
 * @param {string} objectiveId - The objective ID
 * @param {'planned' | 'in-progress' | 'completed' | 'dropped'} status
 * @returns {object | null} The updated objective, or null if not found
 */
export function updateObjectiveStatus(config, objectiveId, status) {
  for (const plan of config.monthlyPlans) {
    const obj = plan.objectives.find((o) => o.id === objectiveId);
    if (obj) {
      obj.status = status;
      if (status === 'completed') {
        obj.completedAt = new Date().toISOString();
      }
      plan.updatedAt = new Date().toISOString();
      config.updatedAt = new Date().toISOString();
      return obj;
    }
  }
  return null;
}

/**
 * Get all objectives that trace back to a specific goal.
 * Searches across all monthly plans for plan traceability.
 * @param {object} config - Agent config
 * @param {string} goalId - The goal ID
 * @returns {object[]} Objectives referencing this goal
 */
export function getObjectivesForGoal(config, goalId) {
  const results = [];
  for (const plan of config.monthlyPlans) {
    for (const obj of plan.objectives) {
      if (obj.goalId === goalId) {
        results.push(obj);
      }
    }
  }
  return results;
}

/**
 * Add an objective to an existing monthly plan (mutates plan).
 * @param {object} config - Agent config
 * @param {string} month - YYYY-MM of the target plan
 * @param {object} objective - Objective object (from createObjective)
 * @returns {object | null} The added objective, or null if plan not found
 */
export function addObjectiveToMonthlyPlan(config, month, objective) {
  const plan = config.monthlyPlans.find((p) => p.month === month);
  if (!plan) return null;
  plan.objectives.push(objective);
  plan.updatedAt = new Date().toISOString();
  config.updatedAt = new Date().toISOString();
  return objective;
}

/**
 * Get the ISO date-time string for Monday 00:00 UTC of the current week.
 * @returns {string}
 */
export function getMondayISO() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}
