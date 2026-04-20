/**
 * Daily-review adjustment enqueuer.
 *
 * After `generateDailyReview` writes the daily review file, this module:
 *   1. Converts the structured "Adjustments for Tomorrow" records from the
 *      daily review into `weeklyAdjustment` operations — the same format that
 *      `adjustGoals` (and `/aweek:plan` Branch B) accepts.
 *   2. Validates the entire batch up front; if any operation fails, none are
 *      persisted (atomic: all-or-nothing).
 *   3. Persists the validated batch as a JSON file under:
 *
 *        .aweek/agents/<agentId>/pending-daily-adjustments/<date>.json
 *
 * The batch is NOT applied automatically. It waits for the user to run
 * `/aweek:plan` where Branch B picks it up, presents it in the same
 * "confirm the batch" gate (B3) used for all weekly task adjustments, and
 * applies it via `adjustGoals` only after explicit approval.
 *
 * Adjustment type → weekly operation mapping
 * ------------------------------------------
 *   'carry-over' → update task runAt to tomorrow at 09:00 UTC
 *   'continue'   → no plan mutation (task is already in-progress); skipped
 *   'retry'      → update task status back to 'pending' AND runAt to tomorrow 09:00
 *   'reschedule' → update task runAt to tomorrow at 09:00 UTC
 *   'follow-up'  → add a new follow-up task (same objectiveId, same week)
 *
 * Why no 'continue' op?
 *   An in-progress task already has the heartbeat pointed at it; updating its
 *   runAt would reschedule it past its current "pick me up now" eligibility
 *   window and potentially cause it to be skipped. The advisor-voice text in
 *   the daily review document already captures the context for the agent — no
 *   plan mutation is needed or safe.
 */

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { validateWeeklyAdjustment } from './plan-adjustments.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Wall-clock hour (UTC) at which carry-over / retry / reschedule tasks are
 * placed on the next day. 09:00 UTC is early enough to be picked up on the
 * first heartbeat of a typical working day in most time zones.
 */
const CARRY_OVER_HOUR_UTC = 9;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Directory where pending daily-review adjustment batches are stored.
 * @param {string} baseDir - Root data directory (e.g. `.aweek/agents`)
 * @param {string} agentId
 * @returns {string}
 */
export function pendingAdjustmentsDir(baseDir, agentId) {
  return join(baseDir, agentId, 'pending-daily-adjustments');
}

/**
 * File path for a specific pending adjustment batch.
 * @param {string} baseDir
 * @param {string} agentId
 * @param {string} date - YYYY-MM-DD (the review date that produced this batch)
 * @returns {string}
 */
export function pendingAdjustmentsPath(baseDir, agentId, date) {
  return join(pendingAdjustmentsDir(baseDir, agentId), `${date}.json`);
}

// ---------------------------------------------------------------------------
// Date arithmetic helpers (internal)
// ---------------------------------------------------------------------------

/**
 * Return the ISO date string (YYYY-MM-DD) for the day after `dateStr`.
 * Arithmetic is done in UTC so the result is timezone-independent.
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string} YYYY-MM-DD
 */
export function tomorrowDateStr(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a `runAt` ISO 8601 datetime string for a given date at a specific
 * UTC hour. Used to schedule carried-over tasks to tomorrow morning.
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @param {number} [hourUtc=CARRY_OVER_HOUR_UTC] - 0–23
 * @returns {string} ISO 8601 datetime (UTC)
 */
export function runAtForDate(dateStr, hourUtc = CARRY_OVER_HOUR_UTC) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Core converter: adjustment records → weeklyAdjustment ops
// ---------------------------------------------------------------------------

/**
 * Convert daily-review adjustment records into `weeklyAdjustment` operations.
 *
 * Each record from `buildAdjustmentsForTomorrow` carries `{ type, taskId,
 * description, text }`. This function translates those into operations that
 * `adjustGoals` / `applyWeeklyAdjustment` can apply to the live weekly plan.
 *
 * Records whose `taskId` cannot be found in `weeklyPlan.tasks` are silently
 * skipped — the human-readable daily review already captures every suggestion,
 * so no information is lost.
 *
 * @param {Array<{ type: string, taskId: string, description: string, text: string }>} adjustmentRecords
 *   Adjustment records produced by `buildAdjustmentsForTomorrow`.
 * @param {object|null} weeklyPlan - The current approved weekly plan.
 * @param {string} date - The review date (YYYY-MM-DD).
 * @param {string} week - ISO week string for the plan to mutate (YYYY-Www).
 * @returns {Array<object>} `weeklyAdjustment` operations ready for `adjustGoals`.
 */
export function extractWeeklyAdjustmentOps(adjustmentRecords, weeklyPlan, date, week) {
  if (!Array.isArray(adjustmentRecords) || adjustmentRecords.length === 0) return [];
  if (!weeklyPlan || !Array.isArray(weeklyPlan.tasks)) return [];

  const tomorrow = tomorrowDateStr(date);
  const tomorrowRunAt = runAtForDate(tomorrow);
  const ops = [];

  for (const record of adjustmentRecords) {
    const { type, taskId, description } = record;

    // Look up the task so we can read objectiveId and verify existence.
    const task = weeklyPlan.tasks.find((t) => t.id === taskId);
    if (!task) continue; // Task not found — no op, no error

    switch (type) {
      case 'carry-over':
        // Pending task not started today: reschedule for tomorrow 09:00 UTC.
        ops.push({ action: 'update', week, taskId, runAt: tomorrowRunAt });
        break;

      case 'continue':
        // In-progress task: no mutation needed — the task is already open and
        // the heartbeat picks it up on the next tick. Generating a runAt update
        // would push the task past its current eligibility window.
        break;

      case 'retry':
        // Failed task: reset to pending so the heartbeat re-queues it, and
        // pin it to tomorrow morning so the agent addresses it early.
        ops.push({ action: 'update', week, taskId, status: 'pending', runAt: tomorrowRunAt });
        break;

      case 'reschedule':
        // Skipped task: push to tomorrow — the agent can decide during the
        // next daily review whether to continue deferring.
        ops.push({ action: 'update', week, taskId, runAt: tomorrowRunAt });
        break;

      case 'follow-up': {
        // Delegated task: add a lightweight follow-up check task tomorrow.
        // Reuse the original task's objectiveId so the follow-up traces to the
        // same planning section. Skip if no objectiveId is available.
        const objectiveId = task.objectiveId || null;
        if (objectiveId) {
          ops.push({
            action: 'add',
            week,
            description: `Follow up on delegated task: ${description}`,
            objectiveId,
            runAt: tomorrowRunAt,
          });
        }
        break;
      }

      default:
        // Unknown adjustment type — skip silently
        break;
    }
  }

  return ops;
}

// ---------------------------------------------------------------------------
// Batch record builder
// ---------------------------------------------------------------------------

/**
 * Build a pending adjustment batch record.
 *
 * The batch is the unit of persistence. It carries the generated ops plus
 * enough provenance (source date, week, creation time) for the plan skill to
 * display context to the user before they confirm.
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {string} opts.date - Review date that produced this batch (YYYY-MM-DD)
 * @param {string} opts.week - ISO week the ops target (YYYY-Www)
 * @param {string} [opts.createdAt] - ISO datetime; defaults to now
 * @param {object[]} opts.weeklyAdjustments - Array of weeklyAdjustment ops
 * @returns {object} Batch record suitable for JSON serialization
 */
export function buildPendingAdjustmentBatch({
  agentId,
  date,
  week,
  createdAt,
  weeklyAdjustments,
}) {
  return {
    agentId,
    date,
    week,
    source: 'daily-review',
    createdAt: createdAt || new Date().toISOString(),
    weeklyAdjustments,
  };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Write a pending adjustment batch to disk.
 * Creates the directory if it does not exist.
 * Idempotent: re-running for the same date overwrites the previous batch.
 *
 * @param {string} baseDir
 * @param {string} agentId
 * @param {string} date - Review date (YYYY-MM-DD)
 * @param {object} batch - Batch record from `buildPendingAdjustmentBatch`
 * @returns {Promise<string>} Absolute path of the written file
 */
export async function persistPendingAdjustmentBatch(baseDir, agentId, date, batch) {
  const dir = pendingAdjustmentsDir(baseDir, agentId);
  await mkdir(dir, { recursive: true });
  const path = pendingAdjustmentsPath(baseDir, agentId, date);
  await writeFile(path, JSON.stringify(batch, null, 2) + '\n', 'utf-8');
  return path;
}

/**
 * Load a pending adjustment batch from disk.
 *
 * @param {string} baseDir
 * @param {string} agentId
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<object|null>} The batch record, or null if not found
 */
export async function loadPendingAdjustmentBatch(baseDir, agentId, date) {
  const path = pendingAdjustmentsPath(baseDir, agentId, date);
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * List all pending adjustment batch dates for an agent, sorted chronologically.
 *
 * @param {string} baseDir
 * @param {string} agentId
 * @returns {Promise<string[]>} Sorted array of YYYY-MM-DD date strings
 */
export async function listPendingAdjustmentDates(baseDir, agentId) {
  const dir = pendingAdjustmentsDir(baseDir, agentId);
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Delete a pending adjustment batch after it has been applied or dismissed.
 *
 * @param {string} baseDir
 * @param {string} agentId
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<boolean>} true if the file was deleted, false if not found
 */
export async function clearPendingAdjustmentBatch(baseDir, agentId, date) {
  const path = pendingAdjustmentsPath(baseDir, agentId, date);
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Extract daily-review adjustment proposals and enqueue them as a pending
 * `weeklyAdjustment` batch that requires human approval before taking effect.
 *
 * This is the primary integration point called by `generateDailyReview` after
 * the review file has been persisted. The batch is stored under:
 *
 *   .aweek/agents/<agentId>/pending-daily-adjustments/<date>.json
 *
 * and is consumed by `/aweek:plan` Branch B, which presents it in the
 * same "confirm the batch" gate (B3) used for all weekly task adjustments.
 *
 * **Atomic guarantee** — if any generated operation fails `validateWeeklyAdjustment`,
 * the entire batch is discarded and nothing is written to disk.
 *
 * **Non-error no-ops** — the function returns `{ enqueued: false }` (not an
 * error) in the following situations:
 *   - No adjustment records (all tasks completed — nothing to carry over).
 *   - No weekly plan provided (tasks cannot be looked up).
 *   - All generated ops were skipped (e.g. every record was 'continue' type).
 * Callers should treat these as benign no-ops rather than failures.
 *
 * @param {object} opts
 * @param {string} opts.baseDir - Root data directory (e.g. `.aweek/agents`)
 * @param {string} opts.agentId
 * @param {string} opts.date - Review date (YYYY-MM-DD)
 * @param {string} opts.week - ISO week string for the target plan (YYYY-Www)
 * @param {Array<{ type: string, taskId: string, description: string, text: string }>} opts.adjustmentRecords
 *   Adjustment records from `buildAdjustmentsForTomorrow` (stored in daily-review metadata).
 * @param {object|null} opts.weeklyPlan - The weekly plan loaded by `generateDailyReview`.
 * @param {string} [opts.createdAt] - Override creation timestamp (ISO datetime).
 * @returns {Promise<{
 *   enqueued: boolean,
 *   batchPath?: string,
 *   opsCount?: number,
 *   skippedCount: number,
 *   errors?: string[],
 * }>}
 */
export async function enqueueDailyReviewAdjustments({
  baseDir,
  agentId,
  date,
  week,
  adjustmentRecords,
  weeklyPlan,
  createdAt,
}) {
  // ── No adjustments at all ────────────────────────────────────────────────
  if (!Array.isArray(adjustmentRecords) || adjustmentRecords.length === 0) {
    return { enqueued: false, skippedCount: 0 };
  }

  // ── No weekly plan → cannot look up task IDs ─────────────────────────────
  if (!weeklyPlan || !Array.isArray(weeklyPlan.tasks)) {
    return { enqueued: false, skippedCount: adjustmentRecords.length };
  }

  // ── 1. Convert adjustment records to weeklyAdjustment ops ────────────────
  const ops = extractWeeklyAdjustmentOps(adjustmentRecords, weeklyPlan, date, week);

  const skippedCount = adjustmentRecords.length - ops.filter((op) => op.action === 'add' ? true : true).length;
  // More precisely: records that didn't produce ops (continue + not-found + no-objectiveId)
  // are skipped. ops.length is the count that actually made it through.

  if (ops.length === 0) {
    return { enqueued: false, skippedCount: adjustmentRecords.length };
  }

  // ── 2. Validate ALL ops before persisting (atomic all-or-nothing) ─────────
  // Pass a minimal dummy agentConfig — weeklyAdjustment validation no longer
  // requires agentConfig for free-form objectiveId ops. Only the weeklyPlans
  // array is meaningful for `update`/`add` lookups.
  const dummyConfig = { goals: [], monthlyPlans: [] };
  const allErrors = [];

  for (const [i, op] of ops.entries()) {
    const result = validateWeeklyAdjustment(op, dummyConfig, [weeklyPlan]);
    if (!result.valid) {
      allErrors.push(...result.errors.map((e) => `ops[${i}]: ${e}`));
    }
  }

  if (allErrors.length > 0) {
    // Atomic: don't write anything if any op is invalid
    return {
      enqueued: false,
      skippedCount: adjustmentRecords.length,
      errors: allErrors,
    };
  }

  // ── 3. Build and persist the batch ────────────────────────────────────────
  const batch = buildPendingAdjustmentBatch({
    agentId,
    date,
    week,
    createdAt: createdAt || new Date().toISOString(),
    weeklyAdjustments: ops,
  });

  const batchPath = await persistPendingAdjustmentBatch(baseDir, agentId, date, batch);

  return {
    enqueued: true,
    batchPath,
    opsCount: ops.length,
    skippedCount: adjustmentRecords.length - ops.length,
  };
}
