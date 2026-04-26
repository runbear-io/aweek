import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDayCompletionRate,
  computeDailyRates,
  computeWeeklyCompletionRate,
  buildCompletionReport,
  formatCompletionReport,
  type DayComparison,
  type DayCompletionInfo,
  type WeeklyData,
} from './completion-rate-calculator.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeDayComparison(overrides: Partial<DayComparison> = {}): DayComparison {
  return {
    date: '2026-04-13',
    day: 'mon',
    planned: { tasks: [], count: 0, statusCounts: {} },
    actual: {
      entries: [],
      count: 0,
      statusCounts: {},
      completedCount: 0,
      failedCount: 0,
      totalDurationMs: 0,
    },
    ...overrides,
  };
}

function makeWeeklyData(overrides: Partial<WeeklyData> = {}): WeeklyData {
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(
    (day, i) => {
      const date = `2026-04-${String(13 + i).padStart(2, '0')}`;
      return makeDayComparison({ date, day });
    }
  );

  return {
    agentId: 'agent-test',
    week: '2026-W16',
    weekMonday: '2026-04-13',
    planExists: true,
    planApproved: true,
    days,
    unscheduledTasks: [],
    summary: {
      planned: {
        total: 0,
        completed: 0,
        failed: 0,
        pending: 0,
        inProgress: 0,
        skipped: 0,
        delegated: 0,
        completionRate: 0,
      },
      actual: {
        totalEntries: 0,
        completed: 0,
        failed: 0,
        totalDurationMs: 0,
      },
    },
    ...overrides,
  };
}

// ─── computeDayCompletionRate ───────────────────────────────────────

describe('computeDayCompletionRate', () => {
  it('returns null rate when no activity entries exist', () => {
    const day = makeDayComparison();
    const result = computeDayCompletionRate(day);
    assert.equal(result.completionRate, null);
    assert.equal(result.date, '2026-04-13');
    assert.equal(result.day, 'mon');
  });

  it('computes 100% when all entries are completed', () => {
    const day = makeDayComparison({
      actual: {
        count: 3,
        completedCount: 3,
        failedCount: 0,
        totalDurationMs: 9000,
      },
    });
    const result = computeDayCompletionRate(day);
    assert.equal(result.completionRate, 100);
    assert.equal(result.completedCount, 3);
    assert.equal(result.actualTotal, 3);
  });

  it('computes 0% when no entries are completed', () => {
    const day = makeDayComparison({
      actual: {
        count: 2,
        completedCount: 0,
        failedCount: 2,
        totalDurationMs: 5000,
      },
    });
    const result = computeDayCompletionRate(day);
    assert.equal(result.completionRate, 0);
    assert.equal(result.failedCount, 2);
  });

  it('computes correct percentage for mixed results', () => {
    const day = makeDayComparison({
      actual: {
        count: 4,
        completedCount: 3,
        failedCount: 1,
        totalDurationMs: 12000,
      },
    });
    const result = computeDayCompletionRate(day);
    assert.equal(result.completionRate, 75); // 3/4 = 75%
  });

  it('rounds to nearest integer', () => {
    const day = makeDayComparison({
      actual: {
        count: 3,
        completedCount: 1,
        failedCount: 0,
        totalDurationMs: 3000,
      },
    });
    const result = computeDayCompletionRate(day);
    assert.equal(result.completionRate, 33); // 1/3 = 33.33 → 33
  });

  it('preserves planned count from day comparison', () => {
    const day = makeDayComparison({
      planned: { tasks: [{}, {}], count: 2, statusCounts: { completed: 2 } },
      actual: {
        count: 2,
        completedCount: 2,
        failedCount: 0,
        totalDurationMs: 6000,
      },
    });
    const result = computeDayCompletionRate(day);
    assert.equal(result.plannedCount, 2);
    assert.equal(result.completionRate, 100);
  });

  it('handles missing actual gracefully', () => {
    const day = { date: '2026-04-13', day: 'mon', planned: { count: 0 } };
    const result = computeDayCompletionRate(day);
    assert.equal(result.completionRate, null);
    assert.equal(result.actualTotal, 0);
    assert.equal(result.completedCount, 0);
  });
});

// ─── computeDailyRates ──────────────────────────────────────────────

describe('computeDailyRates', () => {
  it('returns 7 rate objects for a standard week', () => {
    const data = makeWeeklyData();
    const rates = computeDailyRates(data.days);
    assert.equal(rates.length, 7);
  });

  it('preserves day order mon through sun', () => {
    const data = makeWeeklyData();
    const rates = computeDailyRates(data.days);
    const dayNames = rates.map((r: DayCompletionInfo) => r.day);
    assert.deepEqual(dayNames, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });

  it('computes individual day rates correctly', () => {
    const data = makeWeeklyData();
    // Add activity to Monday and Tuesday
    data.days[0] = makeDayComparison({
      date: '2026-04-13',
      day: 'mon',
      actual: { count: 2, completedCount: 2, failedCount: 0, totalDurationMs: 4000 },
    });
    data.days[1] = makeDayComparison({
      date: '2026-04-14',
      day: 'tue',
      actual: { count: 4, completedCount: 1, failedCount: 3, totalDurationMs: 8000 },
    });

    const rates = computeDailyRates(data.days);
    assert.equal(rates[0].completionRate, 100); // Mon: 2/2
    assert.equal(rates[1].completionRate, 25);  // Tue: 1/4
    assert.equal(rates[2].completionRate, null); // Wed: no activity
  });
});

// ─── computeWeeklyCompletionRate ────────────────────────────────────

describe('computeWeeklyCompletionRate', () => {
  it('returns 0 when no tasks are planned', () => {
    const result = computeWeeklyCompletionRate({
      planned: { total: 0, completed: 0, failed: 0, pending: 0, inProgress: 0, skipped: 0, delegated: 0 },
      actual: { totalEntries: 0, completed: 0, failed: 0, totalDurationMs: 0 },
    });
    assert.equal(result.completionRate, 0);
    assert.equal(result.effectiveRate, 0);
    assert.equal(result.failureRate, 0);
    assert.equal(result.totalPlanned, 0);
  });

  it('returns 100% when all tasks completed', () => {
    const result = computeWeeklyCompletionRate({
      planned: { total: 5, completed: 5, failed: 0, pending: 0, inProgress: 0, skipped: 0, delegated: 0 },
      actual: { totalEntries: 5, completed: 5, failed: 0, totalDurationMs: 50000 },
    });
    assert.equal(result.completionRate, 100);
    assert.equal(result.effectiveRate, 100);
    assert.equal(result.failureRate, 0);
  });

  it('computes correct rate for partial completion', () => {
    const result = computeWeeklyCompletionRate({
      planned: { total: 10, completed: 4, failed: 2, pending: 2, inProgress: 1, skipped: 0, delegated: 1 },
      actual: { totalEntries: 7, completed: 4, failed: 2, totalDurationMs: 100000 },
    });
    assert.equal(result.completionRate, 40);  // 4/10
    assert.equal(result.effectiveRate, 50);   // (4+1)/10
    assert.equal(result.failureRate, 20);     // 2/10
    assert.equal(result.totalPlanned, 10);
    assert.equal(result.completed, 4);
    assert.equal(result.delegated, 1);
  });

  it('includes delegated in effective rate but not completion rate', () => {
    const result = computeWeeklyCompletionRate({
      planned: { total: 4, completed: 1, failed: 0, pending: 0, inProgress: 0, skipped: 0, delegated: 3 },
      actual: { totalEntries: 4, completed: 1, failed: 0, totalDurationMs: 20000 },
    });
    assert.equal(result.completionRate, 25);  // 1/4
    assert.equal(result.effectiveRate, 100);  // (1+3)/4
  });

  it('includes actual execution stats', () => {
    const result = computeWeeklyCompletionRate({
      planned: { total: 3, completed: 2, failed: 1, pending: 0, inProgress: 0, skipped: 0, delegated: 0 },
      actual: { totalEntries: 5, completed: 3, failed: 2, totalDurationMs: 75000 },
    });
    assert.equal(result.actualEntries, 5);
    assert.equal(result.actualCompleted, 3);
    assert.equal(result.actualFailed, 2);
    assert.equal(result.actualDurationMs, 75000);
  });

  it('handles null/undefined summary gracefully', () => {
    const result = computeWeeklyCompletionRate(null);
    assert.equal(result.completionRate, 0);
    assert.equal(result.totalPlanned, 0);
  });

  it('handles missing planned/actual sub-objects', () => {
    const result = computeWeeklyCompletionRate({});
    assert.equal(result.completionRate, 0);
    assert.equal(result.actualEntries, 0);
  });

  it('rounds percentages correctly', () => {
    const result = computeWeeklyCompletionRate({
      planned: { total: 3, completed: 1, failed: 0, pending: 2, inProgress: 0, skipped: 0, delegated: 0 },
      actual: { totalEntries: 1, completed: 1, failed: 0, totalDurationMs: 5000 },
    });
    assert.equal(result.completionRate, 33); // 1/3 = 33.33 → 33
  });
});

// ─── buildCompletionReport ──────────────────────────────────────────

describe('buildCompletionReport', () => {
  it('returns structured report with all fields', () => {
    const data = makeWeeklyData({
      summary: {
        planned: { total: 5, completed: 3, failed: 1, pending: 1, inProgress: 0, skipped: 0, delegated: 0 },
        actual: { totalEntries: 4, completed: 3, failed: 1, totalDurationMs: 40000 },
      },
    });

    const report = buildCompletionReport(data);
    assert.equal(report.agentId, 'agent-test');
    assert.equal(report.week, '2026-W16');
    assert.equal(report.weekMonday, '2026-04-13');
    assert.equal(report.planExists, true);
    assert.equal(report.planApproved, true);
    assert.equal(report.daily.length, 7);
    assert.equal(report.weekly.completionRate, 60); // 3/5
    assert.equal(report.weekly.totalPlanned, 5);
  });

  it('computes activeDayCount correctly', () => {
    const data = makeWeeklyData();
    // Add activity to 3 days
    data.days[0] = makeDayComparison({
      date: '2026-04-13', day: 'mon',
      actual: { count: 1, completedCount: 1, failedCount: 0, totalDurationMs: 1000 },
    });
    data.days[2] = makeDayComparison({
      date: '2026-04-15', day: 'wed',
      actual: { count: 2, completedCount: 1, failedCount: 1, totalDurationMs: 3000 },
    });
    data.days[4] = makeDayComparison({
      date: '2026-04-17', day: 'fri',
      actual: { count: 1, completedCount: 1, failedCount: 0, totalDurationMs: 2000 },
    });

    const report = buildCompletionReport(data);
    assert.equal(report.activeDayCount, 3);
  });

  it('computes averageDailyRate across active days', () => {
    const data = makeWeeklyData();
    // Mon: 100% (1/1), Wed: 50% (1/2)
    data.days[0] = makeDayComparison({
      date: '2026-04-13', day: 'mon',
      actual: { count: 1, completedCount: 1, failedCount: 0, totalDurationMs: 1000 },
    });
    data.days[2] = makeDayComparison({
      date: '2026-04-15', day: 'wed',
      actual: { count: 2, completedCount: 1, failedCount: 1, totalDurationMs: 3000 },
    });

    const report = buildCompletionReport(data);
    assert.equal(report.activeDayCount, 2);
    assert.equal(report.averageDailyRate, 75); // (100 + 50) / 2 = 75
  });

  it('returns null averageDailyRate when no active days', () => {
    const data = makeWeeklyData();
    const report = buildCompletionReport(data);
    assert.equal(report.activeDayCount, 0);
    assert.equal(report.averageDailyRate, null);
  });

  it('handles plan not existing', () => {
    const data = makeWeeklyData({ planExists: false, planApproved: false });
    const report = buildCompletionReport(data);
    assert.equal(report.planExists, false);
    assert.equal(report.planApproved, false);
    assert.equal(report.weekly.completionRate, 0);
  });
});

// ─── formatCompletionReport ─────────────────────────────────────────

describe('formatCompletionReport', () => {
  it('renders markdown with weekly overview table', () => {
    const data = makeWeeklyData({
      summary: {
        planned: { total: 4, completed: 2, failed: 1, pending: 1, inProgress: 0, skipped: 0, delegated: 0 },
        actual: { totalEntries: 3, completed: 2, failed: 1, totalDurationMs: 30000 },
      },
    });
    const report = buildCompletionReport(data);
    const md = formatCompletionReport(report);

    assert.ok(md.includes('## Completion Rates'));
    assert.ok(md.includes('### Weekly Overview'));
    assert.ok(md.includes('| Planned tasks | 4 |'));
    assert.ok(md.includes('| Completed | 2 |'));
    assert.ok(md.includes('| **Completion rate** | **50%** |'));
  });

  it('renders daily breakdown table with 7 rows', () => {
    const data = makeWeeklyData();
    const report = buildCompletionReport(data);
    const md = formatCompletionReport(report);

    assert.ok(md.includes('### Daily Breakdown'));
    assert.ok(md.includes('| mon |'));
    assert.ok(md.includes('| sun |'));
    // All days should show '—' for null rates
    const dashCount = (md.match(/\| — \|/g) || []).length;
    assert.equal(dashCount, 7); // all 7 days inactive
  });

  it('shows percentage for active days', () => {
    const data = makeWeeklyData();
    data.days[0] = makeDayComparison({
      date: '2026-04-13', day: 'mon',
      actual: { count: 2, completedCount: 2, failedCount: 0, totalDurationMs: 4000 },
    });
    const report = buildCompletionReport(data);
    const md = formatCompletionReport(report);

    assert.ok(md.includes('| 100% |'));
    assert.ok(md.includes('**Active days:** 1/7'));
  });

  it('shows no-activity message when week is empty', () => {
    const data = makeWeeklyData();
    const report = buildCompletionReport(data);
    const md = formatCompletionReport(report);
    assert.ok(md.includes('_No activity recorded this week._'));
  });

  it('includes effective rate and failure rate', () => {
    const data = makeWeeklyData({
      summary: {
        planned: { total: 4, completed: 1, failed: 1, pending: 0, inProgress: 0, skipped: 0, delegated: 2 },
        actual: { totalEntries: 4, completed: 1, failed: 1, totalDurationMs: 20000 },
      },
    });
    const report = buildCompletionReport(data);
    const md = formatCompletionReport(report);

    assert.ok(md.includes('Effective rate (incl. delegated) | 75%'));
    assert.ok(md.includes('Failure rate | 25%'));
  });
});
