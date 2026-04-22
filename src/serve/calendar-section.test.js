/**
 * Tests for `src/serve/calendar-section.js` and the `/api/agents/:slug/calendar`
 * HTTP endpoint it backs.
 *
 * Scope (AC 3, sub-AC 1): given an agent slug and an on-disk weekly plan,
 * the backend must return each task's status + runAt-derived time slot
 * (day key, hour, minute) as JSON. The endpoint must also gracefully
 * handle missing agents (404), missing plans (`noPlan: true`), and live
 * filesystem changes between requests.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';

import {
  calendarSectionStyles,
  computeTaskSlot,
  gatherCalendar,
  gatherCalendarView,
  gatherTaskActivity,
  renderCalendarSection,
} from './calendar-section.js';
import { ActivityLogStore, createLogEntry } from '../storage/activity-log-store.js';
import { startServer } from './server.js';

// ───────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────

async function makeProject(prefix = 'aweek-calendar-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, '.aweek', 'agents'), { recursive: true });
  return dir;
}

async function writeConfig(projectDir, config) {
  await writeFile(
    join(projectDir, '.aweek', 'config.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Minimal agent JSON matching `aweek://schemas/agent-config`. Bare-bones —
 * we only need it to exist so the agent-existence check in
 * `gatherCalendar` passes.
 */
async function writeAgent(projectDir, slug) {
  const now = '2026-04-13T00:00:00.000Z';
  const config = {
    id: slug,
    subagentRef: slug,
    goals: [],
    monthlyPlans: [],
    weeklyTokenBudget: 100_000,
    budget: {
      weeklyTokenLimit: 100_000,
      currentUsage: 0,
      periodStart: now,
      paused: false,
      sessions: [],
    },
    inbox: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(
    join(projectDir, '.aweek', 'agents', `${slug}.json`),
    JSON.stringify(config, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Write a minimal valid weekly plan for an agent. The caller supplies the
 * `week` (e.g. `'2026-W16'`) and `tasks`; everything else uses sane
 * defaults so the plan validates against the schema.
 */
async function writeWeeklyPlan(projectDir, slug, { week, month, approved = true, tasks = [] }) {
  const dir = join(projectDir, '.aweek', 'agents', slug, 'weekly-plans');
  await mkdir(dir, { recursive: true });
  const plan = {
    week,
    month: month || week.slice(0, 4) + '-' + '01',
    approved,
    tasks,
    createdAt: '2026-04-13T00:00:00.000Z',
    updatedAt: '2026-04-13T00:00:00.000Z',
  };
  if (approved) plan.approvedAt = '2026-04-13T00:00:00.000Z';
  await writeFile(
    join(dir, `${week}.json`),
    JSON.stringify(plan, null, 2) + '\n',
    'utf8',
  );
  return plan;
}

function httpGet(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url);
    const req = httpRequest(
      {
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolvePromise({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

// ───────────────────────────────────────────────────────────────────────
// computeTaskSlot — pure slot derivation
// ───────────────────────────────────────────────────────────────────────

describe('computeTaskSlot()', () => {
  it('returns null when runAt is missing or unparseable', () => {
    const monday = new Date('2026-04-13T00:00:00.000Z');
    assert.equal(computeTaskSlot({}, monday, 'UTC'), null);
    assert.equal(computeTaskSlot({ runAt: '' }, monday, 'UTC'), null);
    assert.equal(computeTaskSlot({ runAt: 'not-a-date' }, monday, 'UTC'), null);
  });

  it('returns null when runAt falls outside the week window', () => {
    const monday = new Date('2026-04-13T00:00:00.000Z');
    // Prior Sunday
    const slot = computeTaskSlot(
      { runAt: '2026-04-12T10:00:00.000Z' },
      monday,
      'UTC',
    );
    assert.equal(slot, null);
    // Next Monday
    const slot2 = computeTaskSlot(
      { runAt: '2026-04-20T10:00:00.000Z' },
      monday,
      'UTC',
    );
    assert.equal(slot2, null);
  });

  it('projects runAt onto day/hour (UTC path)', () => {
    const monday = new Date('2026-04-13T00:00:00.000Z');
    // Monday 09:00 UTC → mon, hour 9, minute 0
    const mon = computeTaskSlot(
      { runAt: '2026-04-13T09:00:00.000Z' },
      monday,
      'UTC',
    );
    assert.deepEqual(mon, {
      dayKey: 'mon',
      dayOffset: 0,
      hour: 9,
      minute: 0,
      iso: '2026-04-13T09:00:00.000Z',
    });

    // Wednesday 14:30 UTC → wed, hour 14, minute 30
    const wed = computeTaskSlot(
      { runAt: '2026-04-15T14:30:00.000Z' },
      monday,
      'UTC',
    );
    assert.equal(wed.dayKey, 'wed');
    assert.equal(wed.dayOffset, 2);
    assert.equal(wed.hour, 14);
    assert.equal(wed.minute, 30);

    // Sunday 23:00 UTC → sun, hour 23
    const sun = computeTaskSlot(
      { runAt: '2026-04-19T23:00:00.000Z' },
      monday,
      'UTC',
    );
    assert.equal(sun.dayKey, 'sun');
    assert.equal(sun.dayOffset, 6);
    assert.equal(sun.hour, 23);
  });
});

// ───────────────────────────────────────────────────────────────────────
// gatherCalendar — end-to-end filesystem read
// ───────────────────────────────────────────────────────────────────────

describe('gatherCalendar()', () => {
  let projectDir;

  beforeEach(async () => {
    projectDir = await makeProject();
  });
  afterEach(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('returns { notFound } for an unknown agent slug', async () => {
    const res = await gatherCalendar({ projectDir, agentId: 'nobody' });
    assert.deepEqual(res, { notFound: true, agentId: 'nobody' });
  });

  it('returns noPlan=true when the agent exists but has no weekly plan', async () => {
    await writeAgent(projectDir, 'writer');
    const res = await gatherCalendar({ projectDir, agentId: 'writer' });
    assert.equal(res.noPlan, true);
    assert.equal(res.agentId, 'writer');
    assert.deepEqual(res.tasks, []);
    assert.equal(res.week, null);
    assert.equal(res.approved, false);
    assert.equal(res.counts.total, 0);
  });

  it('returns tasks with status + computed slot for the resolved week', async () => {
    await writeAgent(projectDir, 'writer');
    await writeConfig(projectDir, { timeZone: 'UTC' });
    // Explicit week override — avoids relying on "today is in W16" at test time.
    await writeWeeklyPlan(projectDir, 'writer', {
      week: '2026-W16',
      month: '2026-04',
      approved: true,
      tasks: [
        {
          id: 'task-aaaa',
          title: 'Monday morning draft', prompt: 'Monday morning draft',
          status: 'pending',
          priority: 'high',
          estimatedMinutes: 60,
          objectiveId: '2026-04',
          runAt: '2026-04-13T09:00:00.000Z',
        },
        {
          id: 'task-bbbb',
          title: 'Wednesday polish', prompt: 'Wednesday polish',
          status: 'in-progress',
          priority: 'medium',
          estimatedMinutes: 90,
          objectiveId: '2026-04',
          runAt: '2026-04-15T14:30:00.000Z',
        },
        {
          id: 'task-cccc',
          title: 'Unscheduled follow-up', prompt: 'Unscheduled follow-up',
          status: 'completed',
          priority: 'low',
          objectiveId: '2026-04',
          // no runAt → should have slot: null
        },
      ],
    });

    const res = await gatherCalendar({
      projectDir,
      agentId: 'writer',
      week: '2026-W16',
    });

    assert.equal(res.agentId, 'writer');
    assert.equal(res.week, '2026-W16');
    assert.equal(res.month, '2026-04');
    assert.equal(res.approved, true);
    assert.equal(res.noPlan, false);
    assert.equal(res.timeZone, 'UTC');
    assert.equal(typeof res.weekMonday, 'string');

    assert.equal(res.tasks.length, 3);
    const [t0, t1, t2] = res.tasks;

    assert.equal(t0.id, 'task-aaaa');
    assert.equal(t0.status, 'pending');
    assert.equal(t0.priority, 'high');
    assert.equal(t0.estimatedMinutes, 60);
    assert.equal(t0.runAt, '2026-04-13T09:00:00.000Z');
    assert.equal(t0.slot.dayKey, 'mon');
    assert.equal(t0.slot.hour, 9);
    assert.equal(t0.slot.minute, 0);

    assert.equal(t1.id, 'task-bbbb');
    assert.equal(t1.status, 'in-progress');
    assert.equal(t1.slot.dayKey, 'wed');
    assert.equal(t1.slot.hour, 14);
    assert.equal(t1.slot.minute, 30);

    assert.equal(t2.id, 'task-cccc');
    assert.equal(t2.runAt, null);
    assert.equal(t2.slot, null);

    assert.equal(res.counts.total, 3);
    assert.equal(res.counts.pending, 1);
    assert.equal(res.counts.inProgress, 1);
    assert.equal(res.counts.completed, 1);
  });

  it('falls back to the latest approved plan when the current week has none', async () => {
    await writeAgent(projectDir, 'writer');
    await writeConfig(projectDir, { timeZone: 'UTC' });
    await writeWeeklyPlan(projectDir, 'writer', {
      week: '2024-W01',
      month: '2024-01',
      approved: true,
      tasks: [
        {
          id: 'task-legacy',
          title: 'Legacy task', prompt: 'Legacy task',
          status: 'completed',
        },
      ],
    });

    // No `week` override — the current week almost certainly isn't W01 of
    // 2024, so gatherCalendar must fall back to the latest approved plan.
    const res = await gatherCalendar({ projectDir, agentId: 'writer' });
    assert.equal(res.noPlan, false);
    assert.equal(res.week, '2024-W01');
    assert.equal(res.tasks.length, 1);
    assert.equal(res.tasks[0].id, 'task-legacy');
  });

  it('tolerates a missing config.json (falls through to a valid IANA zone)', async () => {
    // No config.json written — loadConfig defaults to the system IANA
    // zone. We just assert that the gather call still succeeds and
    // surfaces *some* non-empty string, since the exact system zone
    // varies by host.
    await writeAgent(projectDir, 'writer');
    await writeWeeklyPlan(projectDir, 'writer', {
      week: '2026-W16',
      tasks: [],
    });
    const res = await gatherCalendar({
      projectDir,
      agentId: 'writer',
      week: '2026-W16',
    });
    assert.equal(typeof res.timeZone, 'string');
    assert.ok(res.timeZone.length > 0);
    assert.equal(res.noPlan, false);
  });
});

// ───────────────────────────────────────────────────────────────────────
// HTTP endpoint: GET /api/agents/:slug/calendar
// ───────────────────────────────────────────────────────────────────────

describe('GET /api/agents/:slug/calendar', () => {
  let projectDir;
  let handle;

  beforeEach(async () => {
    projectDir = await makeProject();
    handle = null;
  });
  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('returns 404 for an unknown agent slug', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/agents/ghost/calendar`);
    assert.equal(res.statusCode, 404);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'Agent not found');
    assert.equal(parsed.agentId, 'ghost');
  });

  it('returns JSON with tasks, status, and slots for a known agent', async () => {
    await writeAgent(projectDir, 'writer');
    await writeConfig(projectDir, { timeZone: 'UTC' });
    await writeWeeklyPlan(projectDir, 'writer', {
      week: '2026-W16',
      month: '2026-04',
      approved: true,
      tasks: [
        {
          id: 'task-aaaa',
          title: 'Monday morning draft', prompt: 'Monday morning draft',
          status: 'pending',
          estimatedMinutes: 60,
          runAt: '2026-04-13T09:00:00.000Z',
        },
        {
          id: 'task-bbbb',
          title: 'Unscheduled', prompt: 'Unscheduled',
          status: 'completed',
        },
      ],
    });

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(
      `${handle.url}api/agents/writer/calendar?week=2026-W16`,
    );

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.match(res.headers['cache-control'] || '', /no-store/);

    const payload = JSON.parse(res.body);
    assert.equal(payload.agentId, 'writer');
    assert.equal(payload.week, '2026-W16');
    assert.equal(payload.approved, true);
    assert.equal(payload.noPlan, false);
    assert.equal(payload.tasks.length, 2);
    assert.equal(payload.tasks[0].id, 'task-aaaa');
    assert.equal(payload.tasks[0].status, 'pending');
    assert.equal(payload.tasks[0].slot.dayKey, 'mon');
    assert.equal(payload.tasks[1].slot, null);
    assert.equal(payload.counts.total, 2);
    assert.equal(payload.counts.pending, 1);
    assert.equal(payload.counts.completed, 1);
  });

  it('returns noPlan=true with 200 when the agent has no weekly plan yet', async () => {
    await writeAgent(projectDir, 'writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/agents/writer/calendar`);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.noPlan, true);
    assert.deepEqual(payload.tasks, []);
  });

  it('re-reads .aweek/ on every request (live data)', async () => {
    await writeAgent(projectDir, 'writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });

    // First request: no plan yet
    let res = await httpGet(`${handle.url}api/agents/writer/calendar`);
    assert.equal(JSON.parse(res.body).noPlan, true);

    // Add a plan on disk with no restart
    await writeWeeklyPlan(projectDir, 'writer', {
      week: '2026-W16',
      month: '2026-04',
      approved: true,
      tasks: [
        {
          id: 'task-new',
          title: 'Freshly added', prompt: 'Freshly added',
          status: 'pending',
        },
      ],
    });

    res = await httpGet(
      `${handle.url}api/agents/writer/calendar?week=2026-W16`,
    );
    const payload = JSON.parse(res.body);
    assert.equal(payload.noPlan, false);
    assert.equal(payload.tasks.length, 1);
    assert.equal(payload.tasks[0].id, 'task-new');
  });

  it('URL-decodes the agent slug (e.g. plugin-prefixed ids)', async () => {
    await writeAgent(projectDir, 'oh-my-claudecode-writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(
      `${handle.url}api/agents/oh-my-claudecode-writer/calendar`,
    );
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.agentId, 'oh-my-claudecode-writer');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Helper: write a minimal subagent .md so the picker label can render
// ───────────────────────────────────────────────────────────────────────

async function writeSubagentMd(projectDir, slug, { name, description }) {
  const dir = join(projectDir, '.claude', 'agents');
  await mkdir(dir, { recursive: true });
  const body = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    'System prompt body.',
    '',
  ].join('\n');
  await writeFile(join(dir, `${slug}.md`), body, 'utf8');
}

// ───────────────────────────────────────────────────────────────────────
// gatherCalendarView — composes picker + selected calendar
// ───────────────────────────────────────────────────────────────────────

describe('gatherCalendarView()', () => {
  let projectDir;
  beforeEach(async () => {
    projectDir = await makeProject();
  });
  afterEach(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('returns empty picker when no agents exist', async () => {
    const view = await gatherCalendarView({ projectDir });
    assert.deepEqual(view, { agents: [], selected: null });
  });

  it('lists all agents and falls back to the first when no slug is given', async () => {
    await writeAgent(projectDir, 'writer');
    await writeAgent(projectDir, 'analyst');
    await writeSubagentMd(projectDir, 'writer', {
      name: 'Writer',
      description: 'Writes things.',
    });
    await writeSubagentMd(projectDir, 'analyst', {
      name: 'Analyst',
      description: 'Analyses things.',
    });
    await writeConfig(projectDir, { timeZone: 'UTC' });

    const view = await gatherCalendarView({ projectDir });
    assert.equal(view.agents.length, 2);
    // Sort order is by name — Analyst before Writer.
    assert.equal(view.agents[0].slug, 'analyst');
    assert.equal(view.agents[1].slug, 'writer');
    assert.ok(view.selected);
    assert.equal(view.selected.slug, 'analyst');
    assert.equal(view.selected.calendar.agentId, 'analyst');
  });

  it('honours a matching selectedSlug', async () => {
    await writeAgent(projectDir, 'writer');
    await writeAgent(projectDir, 'analyst');
    await writeSubagentMd(projectDir, 'writer', {
      name: 'Writer',
      description: 'Writes things.',
    });
    await writeSubagentMd(projectDir, 'analyst', {
      name: 'Analyst',
      description: 'Analyses things.',
    });
    await writeConfig(projectDir, { timeZone: 'UTC' });

    const view = await gatherCalendarView({
      projectDir,
      selectedSlug: 'writer',
    });
    assert.equal(view.selected.slug, 'writer');
  });

  it('falls back to the first agent when selectedSlug does not match', async () => {
    await writeAgent(projectDir, 'writer');
    await writeSubagentMd(projectDir, 'writer', {
      name: 'Writer',
      description: 'Writes things.',
    });

    const view = await gatherCalendarView({
      projectDir,
      selectedSlug: 'does-not-exist',
    });
    assert.equal(view.selected.slug, 'writer');
  });

  it('exposes the selected agent calendar payload with tasks and counts', async () => {
    await writeAgent(projectDir, 'writer');
    await writeSubagentMd(projectDir, 'writer', {
      name: 'Writer',
      description: 'Writes things.',
    });
    await writeConfig(projectDir, { timeZone: 'UTC' });
    await writeWeeklyPlan(projectDir, 'writer', {
      week: '2026-W16',
      month: '2026-04',
      approved: true,
      tasks: [
        {
          id: 'task-aaaa',
          title: 'Mon', prompt: 'Mon',
          status: 'pending',
          runAt: '2026-04-13T09:00:00.000Z',
        },
        {
          id: 'task-bbbb',
          title: 'Loose', prompt: 'Loose',
          status: 'completed',
        },
      ],
    });
    const view = await gatherCalendarView({
      projectDir,
      selectedSlug: 'writer',
      week: '2026-W16',
    });
    assert.equal(view.selected.slug, 'writer');
    assert.equal(view.selected.calendar.week, '2026-W16');
    assert.equal(view.selected.calendar.tasks.length, 2);
    assert.equal(view.selected.calendar.counts.total, 2);
  });
});

// ───────────────────────────────────────────────────────────────────────
// renderCalendarSection — pure HTML rendering
// ───────────────────────────────────────────────────────────────────────

describe('renderCalendarSection()', () => {
  it('renders an empty state when no agents are present', () => {
    const html = renderCalendarSection({ agents: [], selected: null });
    assert.match(html, /calendar-empty/);
    assert.match(html, /\/aweek:hire/);
  });

  it('renders a no-plan message for the selected agent within tab scope', () => {
    // In the sidebar + tab layout the agent picker lives in the sidebar;
    // renderCalendarSection renders only the calendar content for the agent
    // that was already selected via the ?agent= query param.
    const html = renderCalendarSection({
      agents: [{ slug: 'writer', name: 'Writer' }],
      selected: {
        slug: 'writer',
        name: 'Writer',
        calendar: {
          agentId: 'writer',
          week: null,
          month: null,
          approved: false,
          timeZone: 'UTC',
          weekMonday: null,
          noPlan: true,
          tasks: [],
          counts: { total: 0 },
        },
      },
    });
    // No per-section agent picker — agent selection is handled by the sidebar.
    assert.ok(!html.includes('calendar-picker'), 'calendar section must not render its own agent picker');
    assert.ok(!html.includes('calendar-pill'), 'calendar section must not render agent pills');
    assert.match(html, /Writer/);
    assert.match(html, /No weekly plan yet/);
    assert.match(html, /\/aweek:plan/);
  });

  it('renders the grid, status chips, and task cards when tasks exist', () => {
    const html = renderCalendarSection({
      agents: [
        { slug: 'writer', name: 'Writer' },
        { slug: 'analyst', name: 'Analyst' },
      ],
      selected: {
        slug: 'writer',
        name: 'Writer',
        calendar: {
          agentId: 'writer',
          week: '2026-W16',
          month: '2026-04',
          approved: true,
          timeZone: 'UTC',
          weekMonday: '2026-04-13T00:00:00.000Z',
          noPlan: false,
          tasks: [
            {
              id: 'task-aaaa',
              title: 'Monday 9am draft',
              prompt: 'Monday 9am draft',
              status: 'pending',
              priority: 'high',
              runAt: '2026-04-13T09:00:00.000Z',
              slot: {
                dayKey: 'mon',
                dayOffset: 0,
                hour: 9,
                minute: 0,
                iso: '2026-04-13T09:00:00.000Z',
              },
            },
            {
              id: 'task-bbbb',
              title: 'Wed 2:30pm',
              prompt: 'Wed 2:30pm',
              status: 'in-progress',
              priority: 'critical',
              runAt: '2026-04-15T14:30:00.000Z',
              slot: {
                dayKey: 'wed',
                dayOffset: 2,
                hour: 14,
                minute: 30,
                iso: '2026-04-15T14:30:00.000Z',
              },
            },
            {
              id: 'task-cccc',
              title: 'Loose thread', prompt: 'Loose thread',
              status: 'completed',
              priority: 'low',
              runAt: null,
              slot: null,
            },
          ],
          counts: {
            total: 3,
            pending: 1,
            inProgress: 1,
            completed: 1,
            failed: 0,
            delegated: 0,
            skipped: 0,
          },
        },
      },
    });

    // No per-section agent picker in the sidebar + tab layout.
    assert.ok(!html.includes('calendar-picker'), 'calendar section must not render its own agent picker');
    assert.ok(!html.includes('calendar-pill'), 'calendar section must not render agent pills');

    // Header: week + approval + tz
    assert.match(html, /2026-W16/);
    assert.match(html, /APPROVED/);
    assert.match(html, /UTC/);

    // Counts chips
    assert.match(html, /calendar-chip total/);
    assert.match(html, /status-pending/);
    assert.match(html, /status-in-progress/);

    // Grid structure
    assert.match(html, /class="calendar-grid"/);
    assert.match(html, /calendar-dayhead/);

    // Task cards with time labels and status icons
    assert.match(html, /Monday 9am draft/);
    assert.match(html, /Wed 2:30pm/);
    assert.match(html, /calendar-task-time/);
    assert.match(html, /status-in-progress/);
    assert.match(html, /priority-critical/);

    // Task cards are buttons (clickable) with drawer-ready data attributes
    assert.match(html, /<button type="button" class="calendar-task/);
    assert.match(html, /data-task-title=/);
    assert.match(html, /data-task-priority="critical"/);
    assert.match(html, /data-task-run-at=/);

    // Unscheduled section
    assert.match(html, /calendar-unscheduled/);
    assert.match(html, /Loose thread/);
  });

  it('escapes task descriptions so HTML injection is not possible', () => {
    const html = renderCalendarSection({
      agents: [{ slug: 'writer', name: 'Writer' }],
      selected: {
        slug: 'writer',
        name: 'Writer',
        calendar: {
          agentId: 'writer',
          week: '2026-W16',
          month: null,
          approved: false,
          timeZone: 'UTC',
          weekMonday: '2026-04-13T00:00:00.000Z',
          noPlan: false,
          tasks: [
            {
              id: 'task-evil',
              title: '<script>alert(1)</script>',
              prompt: '<script>alert(1)</script>',
              status: 'pending',
              runAt: '2026-04-13T09:00:00.000Z',
              slot: {
                dayKey: 'mon',
                dayOffset: 0,
                hour: 9,
                minute: 0,
                iso: '2026-04-13T09:00:00.000Z',
              },
            },
          ],
          counts: { total: 1, pending: 1 },
        },
      },
    });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('emits a non-empty style bundle that references the shell tokens', () => {
    const css = calendarSectionStyles();
    assert.ok(css.includes('.calendar-grid'));
    assert.ok(css.includes('.calendar-task'));
    assert.ok(css.includes('var(--border)'));
    assert.ok(css.includes('status-in-progress'));
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC 12: Empty weekly plan shows analogous message plus CTA
// ───────────────────────────────────────────────────────────────────────

describe('empty state — no weekly plan (AC 12)', () => {
  it('shows agent name in strong and /aweek:plan CTA in code when noPlan is true', () => {
    const html = renderCalendarSection({
      agents: [{ slug: 'writer', name: 'The Writer' }],
      selected: {
        slug: 'writer',
        name: 'The Writer',
        calendar: {
          agentId: 'writer',
          week: null,
          month: null,
          approved: false,
          timeZone: 'UTC',
          weekMonday: null,
          noPlan: true,
          tasks: [],
          counts: { total: 0 },
        },
      },
    });
    assert.match(html, /calendar-empty/);
    // Agent name is highlighted so the operator sees which agent has no plan
    assert.match(html, /<strong>The Writer<\/strong>/);
    // Plain-language description of what is missing
    assert.match(html, /No weekly plan yet/);
    // CTA is in a <code> element so the user knows the exact command to run
    assert.match(html, /<code>\/aweek:plan<\/code>/);
  });

  it('HTML-escapes the agent name in the no-plan empty state', () => {
    const html = renderCalendarSection({
      agents: [{ slug: 'evil', name: '<script>xss</script>' }],
      selected: {
        slug: 'evil',
        name: '<script>xss</script>',
        calendar: {
          agentId: 'evil',
          week: null,
          month: null,
          approved: false,
          timeZone: 'UTC',
          weekMonday: null,
          noPlan: true,
          tasks: [],
          counts: { total: 0 },
        },
      },
    });
    assert.ok(!html.includes('<script>xss</script>'), 'raw script tag must not appear');
    assert.match(html, /&lt;script&gt;xss&lt;\/script&gt;/);
  });

  it('no-plan message is structurally analogous to the strategy empty state', () => {
    // Both empty states follow the pattern:
    //   "No [X] yet for <strong>Name</strong>. Run <code>/aweek:plan</code> to [action]."
    // This test verifies the calendar half of that contract.
    const html = renderCalendarSection({
      agents: [{ slug: 'coder', name: 'Coder' }],
      selected: {
        slug: 'coder',
        name: 'Coder',
        calendar: {
          agentId: 'coder',
          week: null,
          month: null,
          approved: false,
          timeZone: 'UTC',
          weekMonday: null,
          noPlan: true,
          tasks: [],
          counts: { total: 0 },
        },
      },
    });
    // Pattern: "No ... yet for <strong>..."
    assert.match(html, /No .+ yet for <strong>/);
    // Pattern: "Run <code>/aweek:plan</code> to ..."
    assert.match(html, /Run <code>\/aweek:plan<\/code> to /);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Full-page integration — calendar tab renders within sidebar + tab layout
// ───────────────────────────────────────────────────────────────────────

describe('GET / → calendar tab renders within agent scope', () => {
  let projectDir;
  let handle;

  beforeEach(async () => {
    projectDir = await makeProject();
    handle = null;
  });
  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  async function seedWriter() {
    await writeAgent(projectDir, 'writer');
    await writeSubagentMd(projectDir, 'writer', {
      name: 'Writer',
      description: 'Writes things.',
    });
    await writeConfig(projectDir, { timeZone: 'UTC' });
    await writeWeeklyPlan(projectDir, 'writer', {
      week: '2026-W16',
      month: '2026-04',
      approved: true,
      tasks: [
        {
          id: 'task-visible',
          title: 'Mon 9am draft', prompt: 'Mon 9am draft',
          status: 'pending',
          runAt: '2026-04-13T09:00:00.000Z',
        },
      ],
    });
  }

  it('renders task cards and grid markup when ?tab=calendar (explicit)', async () => {
    await seedWriter();
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(
      `${handle.url}?agent=writer&tab=calendar&week=2026-W16`,
    );
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-section="calendar"/);
    assert.match(res.body, /class="calendar-grid"/);
    assert.match(res.body, /Mon 9am draft/);
    // The shell's extraStyles must include calendar styles for first-paint.
    assert.match(res.body, /\.calendar-grid/);
  });

  it('renders calendar section for the default tab (no ?tab param)', async () => {
    await seedWriter();
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    // When ?tab is absent the server defaults to the calendar tab.
    const res = await httpGet(
      `${handle.url}?agent=writer&week=2026-W16`,
    );
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-section="calendar"/);
    assert.match(res.body, /Mon 9am draft/);
  });

  it('renders sidebar with the selected agent highlighted', async () => {
    await seedWriter();
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer`);
    assert.equal(res.statusCode, 200);
    // Sidebar section is always present — it lists agents for navigation.
    assert.match(res.body, /data-section="agents"/);
    // The selected agent link should carry data-agent-slug for JS routing.
    assert.match(res.body, /data-agent-slug="writer"/);
    // Agent display name appears in the sidebar.
    assert.match(res.body, /Writer/);
  });

  it('renders tab bar with Calendar tab active when agent is selected', async () => {
    await seedWriter();
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=calendar`);
    assert.equal(res.statusCode, 200);
    // Tab bar container keyed to the selected agent.
    assert.match(res.body, /data-agent-tabs="writer"/);
    // Calendar tab is the active item (rendered as a span with aria-current).
    assert.match(res.body, /aria-current="page"[^>]*>Calendar</);
    // Other tabs are present as links.
    assert.match(res.body, /tab=activity/);
    assert.match(res.body, /tab=strategy/);
    assert.match(res.body, /tab=profile/);
  });

  it('shows activity section and hides calendar section when ?tab=activity', async () => {
    await seedWriter();
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=activity`);
    assert.equal(res.statusCode, 200);
    // Activity card must be present.
    assert.match(res.body, /data-section="activity"/);
    // Calendar card must NOT be rendered for this tab.
    assert.ok(
      !res.body.includes('data-section="calendar"'),
      'calendar section must not render when ?tab=activity',
    );
  });

  it('shows strategy section and hides calendar section when ?tab=strategy', async () => {
    await seedWriter();
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=strategy`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-section="strategy"/);
    assert.ok(
      !res.body.includes('data-section="calendar"'),
      'calendar section must not render when ?tab=strategy',
    );
  });

  it('shows profile section and hides calendar section when ?tab=profile', async () => {
    await seedWriter();
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=profile`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-section="profile"/);
    assert.ok(
      !res.body.includes('data-section="calendar"'),
      'calendar section must not render when ?tab=profile',
    );
  });

  it('renders the no-plan state within the calendar tab without a per-section picker', async () => {
    // Agent exists but has no weekly plan — calendar tab should show the
    // no-plan CTA without rendering an agent picker inside the section.
    await writeAgent(projectDir, 'writer');
    await writeSubagentMd(projectDir, 'writer', {
      name: 'Writer',
      description: 'Writes things.',
    });
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=calendar`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-section="calendar"/);
    assert.match(res.body, /aweek:plan/);
    // No per-section picker — agent selection lives in the sidebar.
    assert.ok(
      !res.body.includes('class="calendar-picker"'),
      'calendar section must not contain an agent picker in the new tab layout',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
// Task-activity embed — the calendar section ships per-task activity
// entries in a JSON <script> tag so the drawer can render them client-side
// without an extra HTTP round-trip.
// ───────────────────────────────────────────────────────────────────────

describe('gatherTaskActivity()', () => {
  let projectDir;

  beforeEach(async () => {
    projectDir = await makeProject('aweek-taskact-');
  });
  afterEach(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('groups activity-log entries by taskId with only drawer-ready fields', async () => {
    await writeAgent(projectDir, 'writer');
    const store = new ActivityLogStore(join(projectDir, '.aweek', 'agents'));
    await store.append('writer', createLogEntry({
      agentId: 'writer',
      taskId: 'task-alpha',
      status: 'completed',
      title: 'Ran task alpha',
      duration: 4200,
      metadata: {
        resources: { urls: ['https://example.com/post'], filePaths: ['/tmp/out.md'] },
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        execution: { exitCode: 0, timedOut: false },
      },
    }));
    await store.append('writer', createLogEntry({
      agentId: 'writer',
      taskId: 'task-beta',
      status: 'failed',
      title: 'Other task',
      duration: 500,
      metadata: { error: { message: 'explode' } },
    }));

    const byTask = await gatherTaskActivity({ projectDir, agentId: 'writer' });

    assert.ok(byTask['task-alpha']);
    assert.equal(byTask['task-alpha'].length, 1);
    const alpha = byTask['task-alpha'][0];
    assert.equal(alpha.status, 'completed');
    assert.equal(alpha.duration, 4200);
    assert.deepEqual(alpha.urls, ['https://example.com/post']);
    assert.deepEqual(alpha.files, ['/tmp/out.md']);
    assert.equal(alpha.tokens, 150);
    // Drawer-only projection — raw stdout / stderr should not leak through.
    assert.ok(!('metadata' in alpha));

    assert.ok(byTask['task-beta']);
    assert.equal(byTask['task-beta'][0].errorMessage, 'explode');
  });

  it('returns an empty object when the agent has no activity', async () => {
    await writeAgent(projectDir, 'writer');
    const byTask = await gatherTaskActivity({ projectDir, agentId: 'writer' });
    assert.deepEqual(byTask, {});
  });

  it('drops entries without a taskId (they are not task-scoped)', async () => {
    await writeAgent(projectDir, 'writer');
    const store = new ActivityLogStore(join(projectDir, '.aweek', 'agents'));
    await store.append('writer', createLogEntry({
      agentId: 'writer',
      status: 'skipped',
      title: 'Heartbeat tick with nothing to do',
    }));
    const byTask = await gatherTaskActivity({ projectDir, agentId: 'writer' });
    assert.deepEqual(byTask, {});
  });
});

describe('renderCalendarSection() — task activity embed', () => {
  it('emits a JSON <script> tag with the per-task activity map', () => {
    const html = renderCalendarSection({
      agents: [{ slug: 'writer', name: 'Writer' }],
      selected: {
        slug: 'writer',
        name: 'Writer',
        calendar: {
          agentId: 'writer',
          week: '2026-W16',
          month: '2026-04',
          approved: true,
          timeZone: 'UTC',
          weekMonday: '2026-04-13T00:00:00.000Z',
          noPlan: false,
          tasks: [],
          counts: { total: 0, pending: 0 },
        },
        taskActivity: {
          'task-alpha': [
            {
              id: 'log-1',
              timestamp: '2026-04-20T10:00:00.000Z',
              status: 'completed',
              duration: 1200,
              urls: ['https://example.com/p'],
            },
          ],
        },
      },
    });

    assert.match(html, /<script type="application\/json" id="aweek-task-activity"/);
    // Payload actually contains the task we seeded.
    const match = html.match(/id="aweek-task-activity"[^>]*>([^<]*)<\/script>/);
    assert.ok(match, 'embed script should be present');
    const parsed = JSON.parse(match[1]);
    assert.ok(parsed['task-alpha']);
    assert.equal(parsed['task-alpha'][0].urls[0], 'https://example.com/p');
  });

  it('emits an empty-object embed when the view carries no taskActivity', () => {
    const html = renderCalendarSection({
      agents: [{ slug: 'writer', name: 'Writer' }],
      selected: {
        slug: 'writer',
        name: 'Writer',
        calendar: {
          agentId: 'writer',
          week: '2026-W16',
          month: '2026-04',
          approved: true,
          timeZone: 'UTC',
          weekMonday: '2026-04-13T00:00:00.000Z',
          noPlan: false,
          tasks: [],
          counts: { total: 0, pending: 0 },
        },
      },
    });
    const match = html.match(/id="aweek-task-activity"[^>]*>([^<]*)<\/script>/);
    assert.ok(match);
    assert.equal(match[1], '{}');
  });

  it('escapes </script> sequences inside the embedded JSON to prevent tag breakout', () => {
    // A description containing a literal "</script" must not close the embed.
    const html = renderCalendarSection({
      agents: [{ slug: 'writer', name: 'Writer' }],
      selected: {
        slug: 'writer',
        name: 'Writer',
        calendar: {
          agentId: 'writer',
          week: '2026-W16',
          month: '2026-04',
          approved: true,
          timeZone: 'UTC',
          weekMonday: '2026-04-13T00:00:00.000Z',
          noPlan: false,
          tasks: [],
          counts: { total: 0, pending: 0 },
        },
        taskActivity: {
          'task-evil': [
            {
              id: 'log-evil',
              timestamp: '2026-04-20T10:00:00.000Z',
              status: 'completed',
              title: '</script><script>alert(1)</script>',
            },
          ],
        },
      },
    });
    // Only the server-emitted <script> should appear, and it must still be
    // followed by the closing </script>. The embedded payload should have
    // the evil sequence rewritten.
    assert.ok(!html.includes('</script><script>alert(1)</script>'));
    assert.match(html, /<\\\/script/);
  });
});
