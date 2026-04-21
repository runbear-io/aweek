import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PLAN_INTERVIEW_FILENAME,
  planInterviewPath,
  createInterviewState,
  interviewExists,
  loadInterviewState,
  saveInterviewState,
  clearInterviewState,
  appendTurn,
} from './plan-interview-store.js';

async function makeAgentsDir() {
  const root = await mkdtemp(join(tmpdir(), 'aweek-plan-interview-'));
  const agentsDir = join(root, 'agents');
  await mkdir(agentsDir, { recursive: true });
  return agentsDir;
}

describe('plan-interview-store — planInterviewPath', () => {
  it('joins agentsDir/<agent>/plan-interview.json', () => {
    assert.equal(
      planInterviewPath('/a/b/agents', 'writer'),
      join('/a/b/agents', 'writer', PLAN_INTERVIEW_FILENAME),
    );
  });

  it('rejects missing args', () => {
    assert.throws(() => planInterviewPath('', 'a'), /agentsDir is required/);
    assert.throws(() => planInterviewPath('/a', ''), /agentId is required/);
  });
});

describe('plan-interview-store — createInterviewState', () => {
  it('returns a blank state primed with the initial context', () => {
    const now = new Date('2026-04-21T00:00:00Z');
    const state = createInterviewState({
      agentId: 'writer',
      initialContext: 'Publish 2 posts/week',
      now,
    });
    assert.equal(state.agentId, 'writer');
    assert.equal(state.initialContext, 'Publish 2 posts/week');
    assert.deepEqual(state.turns, []);
    assert.equal(state.streak, 0);
    assert.equal(state.lastBreakdown, null);
    assert.equal(state.startedAt, '2026-04-21T00:00:00.000Z');
    assert.equal(state.updatedAt, '2026-04-21T00:00:00.000Z');
  });

  it('throws when agentId is missing', () => {
    assert.throws(() => createInterviewState({ initialContext: 'x' }), /agentId is required/);
  });
});

describe('plan-interview-store — save/load/exists/clear', () => {
  it('interviewExists returns false when no file', async () => {
    const agentsDir = await makeAgentsDir();
    assert.equal(await interviewExists(agentsDir, 'writer'), false);
  });

  it('loadInterviewState returns null when no file', async () => {
    const agentsDir = await makeAgentsDir();
    assert.equal(await loadInterviewState(agentsDir, 'writer'), null);
  });

  it('saveInterviewState creates the parent agent directory and writes JSON', async () => {
    const agentsDir = await makeAgentsDir();
    const state = createInterviewState({ agentId: 'writer', initialContext: 'ctx' });
    await saveInterviewState(agentsDir, 'writer', state);

    assert.equal(await interviewExists(agentsDir, 'writer'), true);
    const raw = await readFile(planInterviewPath(agentsDir, 'writer'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.agentId, 'writer');
    assert.equal(parsed.initialContext, 'ctx');
  });

  it('saveInterviewState refreshes updatedAt', async () => {
    const agentsDir = await makeAgentsDir();
    const state = createInterviewState({
      agentId: 'writer',
      initialContext: '',
      now: new Date('2026-04-20T00:00:00Z'),
    });
    const saved = await saveInterviewState(
      agentsDir,
      'writer',
      state,
      new Date('2026-04-21T06:30:00Z'),
    );
    assert.equal(saved.updatedAt, '2026-04-21T06:30:00.000Z');
    assert.equal(saved.startedAt, '2026-04-20T00:00:00.000Z');
  });

  it('loadInterviewState round-trips what was saved', async () => {
    const agentsDir = await makeAgentsDir();
    const state = appendTurn(
      createInterviewState({ agentId: 'writer', initialContext: 'ctx' }),
      {
        question: 'What outcomes?',
        answer: 'More signups',
        breakdownAfter: { goalClarity: { score: 0.6, justification: 'vague' } },
        ambiguityAfter: 0.4,
        streakAfter: 0,
      },
    );
    await saveInterviewState(agentsDir, 'writer', state);

    const loaded = await loadInterviewState(agentsDir, 'writer');
    assert.equal(loaded.turns.length, 1);
    assert.equal(loaded.turns[0].question, 'What outcomes?');
    assert.equal(loaded.turns[0].breakdownAfter.goalClarity.score, 0.6);
    assert.equal(loaded.lastBreakdown.goalClarity.score, 0.6);
  });

  it('clearInterviewState removes the file (idempotent)', async () => {
    const agentsDir = await makeAgentsDir();
    const state = createInterviewState({ agentId: 'writer', initialContext: 'x' });
    await saveInterviewState(agentsDir, 'writer', state);

    const first = await clearInterviewState(agentsDir, 'writer');
    assert.equal(first.deleted, true);
    assert.equal(await interviewExists(agentsDir, 'writer'), false);

    const second = await clearInterviewState(agentsDir, 'writer');
    assert.equal(second.deleted, false);
  });
});

describe('plan-interview-store — appendTurn', () => {
  it('appends a turn and does not mutate input', () => {
    const state = createInterviewState({ agentId: 'writer', initialContext: 'x' });
    const next = appendTurn(state, {
      question: 'q1',
      answer: 'a1',
      askedAt: '2026-04-21T00:00:00Z',
      answeredAt: '2026-04-21T00:00:10Z',
    });

    assert.equal(state.turns.length, 0, 'input must not be mutated');
    assert.equal(next.turns.length, 1);
    assert.equal(next.turns[0].question, 'q1');
    assert.equal(next.turns[0].answer, 'a1');
    assert.equal(next.turns[0].askedAt, '2026-04-21T00:00:00Z');
  });

  it('updates lastBreakdown + streak when provided on the turn', () => {
    const state = createInterviewState({ agentId: 'writer', initialContext: 'x' });
    const next = appendTurn(state, {
      question: 'q',
      answer: 'a',
      breakdownAfter: { goalClarity: { score: 0.8, justification: 'ok' } },
      streakAfter: 1,
    });
    assert.equal(next.streak, 1);
    assert.equal(next.lastBreakdown.goalClarity.score, 0.8);
  });

  it('throws on invalid input', () => {
    const state = createInterviewState({ agentId: 'writer' });
    assert.throws(() => appendTurn(null, { question: 'q', answer: 'a' }), /state is required/);
    assert.throws(() => appendTurn(state, null), /turn is required/);
    assert.throws(
      () => appendTurn(state, { question: 1, answer: 'a' }),
      /question and turn\.answer must be strings/,
    );
  });
});
