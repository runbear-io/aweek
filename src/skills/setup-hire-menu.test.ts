/**
 * Tests for `init-hire-menu.js` — the four-option menu wired into
 * `/aweek:init` after infrastructure setup finishes.
 *
 * These tests lock in:
 *   - the four canonical choice identifiers and their metadata,
 *   - menu filtering based on whether unhired subagents are available
 *     (`hire-all` and `select-some` only appear when there is something to
 *     adopt),
 *   - prompt rendering for both hasUnhired and no-unhired states,
 *   - validation for unknown / disallowed choices and bad `selected` inputs,
 *   - routing from each choice back to a `{ nextSkill, route, slugs, bulk }`
 *     descriptor the skill markdown can dispatch on.
 *
 * Discovery is stubbed via the injectable `listUnhiredFn` option so no
 * filesystem access is needed; a round-trip test exercises the real
 * `listUnhiredSubagents` helper against a tmp project to prove the two
 * interoperate as expected.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_MENU_PROMPT_TEXT,
  DEFAULT_MENU_PROMPT_TEXT_NO_UNHIRED,
  DEFAULT_FALL_THROUGH_REASON,
  INIT_HIRE_MENU_CHOICE,
  INIT_HIRE_MENU_OPTIONS,
  buildInitHireMenu,
  resolveInitHireMenu,
  formatInitHireMenuPrompt,
  routeInitHireMenuChoice,
  validateInitHireMenuChoice,
  validateSelectedSlugs,
} from './setup-hire-menu.js';
import { writeSubagentFile } from '../subagents/subagent-file.js';
import { AgentStore } from '../storage/agent-store.js';
import { createAgentConfig } from '../models/agent.js';

describe('init-hire-menu — constants', () => {
  it('enumerates exactly the four canonical choices', () => {
    assert.deepEqual(
      Object.values(INIT_HIRE_MENU_CHOICE).sort(),
      ['create-new', 'hire-all', 'select-some', 'skip'].sort(),
    );
  });

  it('INIT_HIRE_MENU_CHOICE is frozen so callers can dot-access safely', () => {
    assert.ok(Object.isFrozen(INIT_HIRE_MENU_CHOICE));
  });

  it('INIT_HIRE_MENU_OPTIONS enumerates all four in canonical display order', () => {
    const values = INIT_HIRE_MENU_OPTIONS.map((o) => o.value);
    assert.deepEqual(values, ['hire-all', 'select-some', 'create-new', 'skip']);
  });

  it('every option entry is frozen with the documented shape', () => {
    assert.ok(Object.isFrozen(INIT_HIRE_MENU_OPTIONS));
    for (const opt of INIT_HIRE_MENU_OPTIONS) {
      assert.ok(Object.isFrozen(opt));
      assert.equal(typeof opt.value, 'string');
      assert.equal(typeof opt.label, 'string');
      assert.equal(typeof opt.description, 'string');
      assert.equal(typeof opt.requiresUnhired, 'boolean');
    }
  });

  it('flags hire-all and select-some as requiring unhired subagents; create-new and skip do not', () => {
    const byValue = Object.fromEntries(
      INIT_HIRE_MENU_OPTIONS.map((o) => [o.value, o]),
    );
    assert.equal(byValue['hire-all'].requiresUnhired, true);
    assert.equal(byValue['select-some'].requiresUnhired, true);
    assert.equal(byValue['create-new'].requiresUnhired, false);
    assert.equal(byValue['skip'].requiresUnhired, false);
  });

  it('DEFAULT_MENU_PROMPT_TEXT is non-empty and mentions "hire"', () => {
    assert.equal(typeof DEFAULT_MENU_PROMPT_TEXT, 'string');
    assert.ok(DEFAULT_MENU_PROMPT_TEXT.length > 0);
    assert.match(DEFAULT_MENU_PROMPT_TEXT, /hire/i);
  });

  it('DEFAULT_MENU_PROMPT_TEXT_NO_UNHIRED nudges toward create-new/skip', () => {
    assert.match(DEFAULT_MENU_PROMPT_TEXT_NO_UNHIRED, /no unhired/i);
    assert.match(DEFAULT_MENU_PROMPT_TEXT_NO_UNHIRED, /create|skip/i);
  });
});

describe('init-hire-menu — buildInitHireMenu (injected discovery)', () => {
  it('returns all four options when unhired subagents exist', async () => {
    const menu = await buildInitHireMenu({
      projectDir: '/tmp/fake',
      listUnhiredFn: async () => ['analyst', 'writer'],
    });

    assert.equal(menu.hasUnhired, true);
    assert.deepEqual(menu.unhired, ['analyst', 'writer']);
    assert.equal(menu.options.length, 4);
    assert.deepEqual(
      menu.options.map((o) => o.value),
      ['hire-all', 'select-some', 'create-new', 'skip'],
    );
    assert.equal(menu.promptText, DEFAULT_MENU_PROMPT_TEXT);
    assert.equal(menu.projectDir, '/tmp/fake');
    // Sub-AC 3: fall-through is NEVER set when something is available to adopt.
    assert.equal(menu.fallThrough, false);
  });

  it('filters out hire-all and select-some when no unhired subagents exist', async () => {
    const menu = await buildInitHireMenu({
      projectDir: '/tmp/fake',
      listUnhiredFn: async () => [],
    });

    assert.equal(menu.hasUnhired, false);
    assert.deepEqual(menu.unhired, []);
    assert.equal(menu.options.length, 2);
    assert.deepEqual(
      menu.options.map((o) => o.value),
      ['create-new', 'skip'],
    );
    assert.equal(menu.promptText, DEFAULT_MENU_PROMPT_TEXT_NO_UNHIRED);
    // Sub-AC 3: fall-through flag flips on so callers know to skip the prompt
    // and auto-delegate to /aweek:hire instead.
    assert.equal(menu.fallThrough, true);
  });

  it('honors custom promptText + promptTextNoUnhired overrides', async () => {
    const withUnhired = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
      promptText: 'CUSTOM-WITH',
      promptTextNoUnhired: 'CUSTOM-WITHOUT',
    });
    assert.equal(withUnhired.promptText, 'CUSTOM-WITH');

    const withoutUnhired = await buildInitHireMenu({
      listUnhiredFn: async () => [],
      promptText: 'CUSTOM-WITH',
      promptTextNoUnhired: 'CUSTOM-WITHOUT',
    });
    assert.equal(withoutUnhired.promptText, 'CUSTOM-WITHOUT');
  });

  it('defensively copies the unhired list so callers can mutate freely', async () => {
    const source = ['writer'];
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => source,
    });
    menu.unhired.push('injected');
    assert.deepEqual(source, ['writer']);
  });

  it('tolerates a listUnhiredFn that returns undefined/null by treating it as empty', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => undefined,
    });
    assert.equal(menu.hasUnhired, false);
    assert.deepEqual(menu.unhired, []);
    assert.deepEqual(menu.options.map((o) => o.value), ['create-new', 'skip']);
  });
});

describe('init-hire-menu — buildInitHireMenu (real filesystem round-trip)', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-init-hire-menu-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(join(tmpDir, '.claude'), { recursive: true, force: true });
    await rm(join(tmpDir, '.aweek'), { recursive: true, force: true });
  });

  it('surfaces unhired slugs discovered via listUnhiredSubagents', async () => {
    // Two subagents on disk, one of which is already wrapped by aweek JSON.
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write things.',
      projectDir: tmpDir,
    });
    await writeSubagentFile({
      slug: 'analyst',
      description: 'Analyst',
      systemPrompt: 'Analyse things.',
      projectDir: tmpDir,
    });
    const dataDir = join(tmpDir, '.aweek', 'agents');
    const store = new AgentStore(dataDir);
    await store.save(
      createAgentConfig({ subagentRef: 'writer', weeklyTokenLimit: 500000 }),
    );

    const menu = await buildInitHireMenu({ projectDir: tmpDir, dataDir });
    assert.deepEqual(menu.unhired, ['analyst']);
    assert.equal(menu.hasUnhired, true);
    assert.equal(menu.options.length, 4);
  });

  it('collapses to create-new + skip when every subagent is already hired', async () => {
    await writeSubagentFile({
      slug: 'writer',
      description: 'Writer',
      systemPrompt: 'Write things.',
      projectDir: tmpDir,
    });
    const dataDir = join(tmpDir, '.aweek', 'agents');
    const store = new AgentStore(dataDir);
    await store.save(
      createAgentConfig({ subagentRef: 'writer', weeklyTokenLimit: 500000 }),
    );

    const menu = await buildInitHireMenu({ projectDir: tmpDir, dataDir });
    assert.equal(menu.hasUnhired, false);
    assert.deepEqual(menu.unhired, []);
    assert.deepEqual(menu.options.map((o) => o.value), ['create-new', 'skip']);
  });
});

describe('init-hire-menu — formatInitHireMenuPrompt', () => {
  it('renders the prompt header plus every unhired slug plus every option', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['analyst', 'writer'],
    });
    const text = formatInitHireMenuPrompt(menu);

    // Header copy is present.
    assert.ok(text.includes(DEFAULT_MENU_PROMPT_TEXT));
    // Every unhired slug is surfaced so the user knows what's on offer.
    assert.ok(text.includes('- analyst'));
    assert.ok(text.includes('- writer'));
    // Every option label + value is shown.
    for (const opt of menu.options) {
      assert.ok(text.includes(opt.label), `missing label for ${opt.value}`);
      assert.ok(text.includes(opt.value), `missing value for ${opt.value}`);
    }
  });

  it('omits the "unhired subagents available" block when there are none', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => [],
    });
    const text = formatInitHireMenuPrompt(menu);
    assert.ok(!text.includes('Unhired subagents available'));
    assert.ok(text.includes(DEFAULT_MENU_PROMPT_TEXT_NO_UNHIRED));
    // Only create-new + skip labels are mentioned in the options block.
    assert.ok(text.includes('Create new'));
    assert.ok(text.includes('Skip'));
    assert.ok(!text.includes('Hire all'));
    assert.ok(!text.includes('Select some'));
  });

  it('returns an empty string when given no menu (defensive)', () => {
    assert.equal(formatInitHireMenuPrompt(null), '');
    assert.equal(formatInitHireMenuPrompt(undefined), '');
  });
});

describe('init-hire-menu — validateInitHireMenuChoice', () => {
  it('accepts any of the four canonical choices', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    for (const value of Object.values(INIT_HIRE_MENU_CHOICE)) {
      const result = validateInitHireMenuChoice(value, menu);
      assert.equal(result.valid, true, `expected ${value} to be valid`);
      assert.deepEqual(result.errors, []);
    }
  });

  it('rejects unknown choice strings', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    const result = validateInitHireMenuChoice('yolo', menu);
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /unknown menu choice "yolo"/i);
  });

  it('rejects empty / non-string choices', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    for (const bad of ['', null, undefined, 42, {}]) {
      const result = validateInitHireMenuChoice(bad, menu);
      assert.equal(result.valid, false, `expected ${bad} to be invalid`);
    }
  });

  it('rejects hire-all / select-some when no unhired subagents exist', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => [],
    });
    for (const blocked of [
      INIT_HIRE_MENU_CHOICE.HIRE_ALL,
      INIT_HIRE_MENU_CHOICE.SELECT_SOME,
    ]) {
      const result = validateInitHireMenuChoice(blocked, menu);
      assert.equal(result.valid, false);
      assert.match(
        result.errors.join(' '),
        /not available: no unhired subagents/i,
      );
    }
  });

  it('still accepts create-new / skip when no unhired subagents exist', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => [],
    });
    for (const ok of [
      INIT_HIRE_MENU_CHOICE.CREATE_NEW,
      INIT_HIRE_MENU_CHOICE.SKIP,
    ]) {
      const result = validateInitHireMenuChoice(ok, menu);
      assert.equal(result.valid, true);
    }
  });
});

describe('init-hire-menu — validateSelectedSlugs', () => {
  it('requires at least one slug in the selection', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    const result = validateSelectedSlugs([], menu);
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /at least one subagent slug/i);
  });

  it('rejects non-array input', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    for (const bad of [null, undefined, 'writer', { 0: 'writer' }]) {
      const result = validateSelectedSlugs(bad, menu);
      assert.equal(result.valid, false, `expected ${bad} to be invalid`);
    }
  });

  it('rejects slugs not present in the unhired list', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer', 'analyst'],
    });
    const result = validateSelectedSlugs(['writer', 'ghost'], menu);
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /"ghost" is not in the unhired list/i);
  });

  it('rejects duplicate slugs', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    const result = validateSelectedSlugs(['writer', 'writer'], menu);
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /duplicate slug "writer"/i);
  });

  it('rejects empty / non-string slug entries', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    const result = validateSelectedSlugs(['writer', ''], menu);
    assert.equal(result.valid, false);
    assert.match(
      result.errors.join(' '),
      /must be a non-empty slug string/i,
    );
  });

  it('accepts a fully-valid selection of available slugs', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer', 'analyst', 'researcher'],
    });
    const result = validateSelectedSlugs(['writer', 'researcher'], menu);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });
});

describe('init-hire-menu — routeInitHireMenuChoice', () => {
  it('routes hire-all to /aweek:hire pick-existing with every unhired slug', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['analyst', 'writer'],
    });
    const route = routeInitHireMenuChoice({
      choice: INIT_HIRE_MENU_CHOICE.HIRE_ALL,
      menu,
    });
    assert.equal(route.action, 'hire-all');
    assert.equal(route.nextSkill, '/aweek:hire');
    assert.equal(route.route, 'pick-existing');
    assert.deepEqual(route.slugs, ['analyst', 'writer']);
    assert.equal(route.bulk, true);
    assert.match(route.reason, /hire every unhired subagent/i);
  });

  it('defensively copies the slug list in hire-all so mutating the route does not leak', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['analyst', 'writer'],
    });
    const route = routeInitHireMenuChoice({
      choice: INIT_HIRE_MENU_CHOICE.HIRE_ALL,
      menu,
    });
    route.slugs.push('injected');
    assert.deepEqual(menu.unhired, ['analyst', 'writer']);
  });

  it('routes select-some to /aweek:hire pick-existing with only the picked slugs', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['analyst', 'researcher', 'writer'],
    });
    const route = routeInitHireMenuChoice({
      choice: INIT_HIRE_MENU_CHOICE.SELECT_SOME,
      menu,
      selected: ['writer', 'researcher'],
    });
    assert.equal(route.action, 'select-some');
    assert.equal(route.nextSkill, '/aweek:hire');
    assert.equal(route.route, 'pick-existing');
    assert.deepEqual(route.slugs, ['writer', 'researcher']);
    assert.equal(route.bulk, true);
  });

  it('throws EINIT_HIRE_MENU_BAD_SELECTION when select-some omits `selected`', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    assert.throws(
      () =>
        routeInitHireMenuChoice({
          choice: INIT_HIRE_MENU_CHOICE.SELECT_SOME,
          menu,
        }),
      (err) => {
        assert.equal(err.code, 'EINIT_HIRE_MENU_BAD_SELECTION');
        assert.ok(Array.isArray(err.errors));
        return true;
      },
    );
  });

  it('throws EINIT_HIRE_MENU_BAD_SELECTION when select-some includes unknown slugs', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    assert.throws(
      () =>
        routeInitHireMenuChoice({
          choice: INIT_HIRE_MENU_CHOICE.SELECT_SOME,
          menu,
          selected: ['ghost'],
        }),
      (err) => err.code === 'EINIT_HIRE_MENU_BAD_SELECTION',
    );
  });

  it('routes create-new to /aweek:hire create-new regardless of unhired state', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    const route = routeInitHireMenuChoice({
      choice: INIT_HIRE_MENU_CHOICE.CREATE_NEW,
      menu,
    });
    assert.equal(route.action, 'create-new');
    assert.equal(route.nextSkill, '/aweek:hire');
    assert.equal(route.route, 'create-new');
    assert.deepEqual(route.slugs, []);
    assert.equal(route.bulk, false);
  });

  it('routes skip to a no-op with nextSkill=null', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    const route = routeInitHireMenuChoice({
      choice: INIT_HIRE_MENU_CHOICE.SKIP,
      menu,
    });
    assert.equal(route.action, 'skip');
    assert.equal(route.nextSkill, null);
    assert.equal(route.route, null);
    assert.deepEqual(route.slugs, []);
    assert.equal(route.bulk, false);
  });

  it('throws EINIT_HIRE_MENU_BAD_CHOICE on an unknown choice', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => ['writer'],
    });
    assert.throws(
      () => routeInitHireMenuChoice({ choice: 'yolo', menu }),
      (err) => {
        assert.equal(err.code, 'EINIT_HIRE_MENU_BAD_CHOICE');
        assert.ok(Array.isArray(err.errors));
        return true;
      },
    );
  });

  it('throws EINIT_HIRE_MENU_BAD_CHOICE when hire-all is picked with no unhired subagents', async () => {
    const menu = await buildInitHireMenu({
      listUnhiredFn: async () => [],
    });
    assert.throws(
      () =>
        routeInitHireMenuChoice({
          choice: INIT_HIRE_MENU_CHOICE.HIRE_ALL,
          menu,
        }),
      (err) => err.code === 'EINIT_HIRE_MENU_BAD_CHOICE',
    );
  });
});

/**
 * Tests for `resolveInitHireMenu` — the Sub-AC 3 of AC 6 fall-through helper.
 *
 * The /aweek:init skill uses this as the canonical post-infrastructure entry
 * point. When no unhired subagents exist the menu is bypassed entirely and the
 * wizard auto-delegates to /aweek:hire (create-new). When at least one unhired
 * subagent exists the helper falls back to the four-option choose menu so the
 * user can adopt or create a new one.
 */
describe('init-hire-menu — resolveInitHireMenu (Sub-AC 3 fall-through)', () => {
  it('exports a non-empty default fall-through reason', () => {
    assert.equal(typeof DEFAULT_FALL_THROUGH_REASON, 'string');
    assert.ok(DEFAULT_FALL_THROUGH_REASON.length > 0);
    // The copy MUST mention /aweek:hire so the user understands what they
    // are being delegated to when the menu is skipped.
    assert.match(DEFAULT_FALL_THROUGH_REASON, /\/aweek:hire/);
    // And mention "create-new" so they know which branch is being launched.
    assert.match(DEFAULT_FALL_THROUGH_REASON, /create-new/i);
  });

  it('returns fallThrough=true with a /aweek:hire create-new route when no unhired subagents exist', async () => {
    const decision = await resolveInitHireMenu({
      listUnhiredFn: async () => [],
    });

    // Top-level shape — fall-through path.
    assert.equal(decision.fallThrough, true);
    assert.equal(decision.reason, DEFAULT_FALL_THROUGH_REASON);

    // The auto-delegation descriptor mirrors the routeInitHireMenuChoice shape
    // so the markdown can dispatch off a single descriptor type. The extra
    // `fallThrough: true` flag distinguishes "auto-delegated" from "user
    // picked create-new" on the choose path.
    assert.ok(decision.route, 'expected an auto-delegation route descriptor');
    assert.equal(decision.route.action, INIT_HIRE_MENU_CHOICE.CREATE_NEW);
    assert.equal(decision.route.nextSkill, '/aweek:hire');
    assert.equal(decision.route.route, 'create-new');
    assert.deepEqual(decision.route.slugs, []);
    assert.equal(decision.route.bulk, false);
    assert.equal(decision.route.fallThrough, true);
    assert.equal(decision.route.reason, DEFAULT_FALL_THROUGH_REASON);

    // The underlying menu is still surfaced so callers can introspect (e.g.
    // log "0 unhired subagents detected") even though they shouldn't render
    // the prompt.
    assert.equal(decision.menu.hasUnhired, false);
    assert.equal(decision.menu.fallThrough, true);
    assert.deepEqual(decision.menu.unhired, []);
  });

  it('returns fallThrough=false with a populated menu and null route when unhired subagents exist', async () => {
    const decision = await resolveInitHireMenu({
      listUnhiredFn: async () => ['analyst', 'writer'],
    });

    assert.equal(decision.fallThrough, false);
    assert.equal(decision.reason, null);
    assert.equal(decision.route, null);
    assert.equal(decision.menu.hasUnhired, true);
    assert.equal(decision.menu.fallThrough, false);
    assert.deepEqual(decision.menu.unhired, ['analyst', 'writer']);
    // The choose path must offer all four options so the user can hire-all,
    // select-some, create-new, or skip.
    assert.equal(decision.menu.options.length, 4);
    assert.deepEqual(
      decision.menu.options.map((o) => o.value),
      ['hire-all', 'select-some', 'create-new', 'skip'],
    );
  });

  it('honors a custom fallThroughReason override on the auto-delegation path', async () => {
    const customReason = 'CUSTOM-FALL-THROUGH-REASON';
    const decision = await resolveInitHireMenu({
      listUnhiredFn: async () => [],
      fallThroughReason: customReason,
    });
    assert.equal(decision.fallThrough, true);
    assert.equal(decision.reason, customReason);
    assert.equal(decision.route.reason, customReason);
  });

  it('treats undefined / null / non-array discovery results as empty (fall-through)', async () => {
    for (const empty of [undefined, null]) {
      const decision = await resolveInitHireMenu({
        listUnhiredFn: async () => empty,
      });
      assert.equal(decision.fallThrough, true);
      assert.equal(decision.route.action, INIT_HIRE_MENU_CHOICE.CREATE_NEW);
      assert.deepEqual(decision.menu.unhired, []);
    }
  });

  it('forwards menu prompt overrides through to the underlying buildInitHireMenu', async () => {
    // Choose path: the user-supplied promptText should land on menu.promptText
    // so the markdown can render the override verbatim.
    const decision = await resolveInitHireMenu({
      listUnhiredFn: async () => ['writer'],
      promptText: 'CUSTOM-CHOOSE-PROMPT',
    });
    assert.equal(decision.fallThrough, false);
    assert.equal(decision.menu.promptText, 'CUSTOM-CHOOSE-PROMPT');
  });

  it('still surfaces the no-unhired prompt copy on the menu so diagnostics callers can read it', async () => {
    const decision = await resolveInitHireMenu({
      listUnhiredFn: async () => [],
      promptTextNoUnhired: 'CUSTOM-NO-UNHIRED',
    });
    assert.equal(decision.fallThrough, true);
    // The menu is still populated for diagnostics — the markdown must NOT
    // render this prompt, but log/audit consumers can still inspect it.
    assert.equal(decision.menu.promptText, 'CUSTOM-NO-UNHIRED');
  });

  it('integrates with the real listUnhiredSubagents — no unhired ⇒ fall-through', async () => {
    // Round-trip against an empty tmp project (no .claude/agents/) to prove
    // resolveInitHireMenu wires through to the production discovery helper.
    const tmpProject = await mkdtemp(
      join(tmpdir(), 'aweek-init-hire-fallthrough-'),
    );
    try {
      const decision = await resolveInitHireMenu({
        projectDir: tmpProject,
        dataDir: join(tmpProject, '.aweek', 'agents'),
      });
      assert.equal(decision.fallThrough, true);
      assert.equal(decision.route.nextSkill, '/aweek:hire');
      assert.equal(decision.route.route, 'create-new');
    } finally {
      await rm(tmpProject, { recursive: true, force: true });
    }
  });

  it('integrates with the real listUnhiredSubagents — unhired present ⇒ choose path', async () => {
    const tmpProject = await mkdtemp(
      join(tmpdir(), 'aweek-init-hire-choose-'),
    );
    try {
      await writeSubagentFile({
        slug: 'analyst',
        description: 'Analyst',
        systemPrompt: 'Analyse things.',
        projectDir: tmpProject,
      });

      const decision = await resolveInitHireMenu({
        projectDir: tmpProject,
        dataDir: join(tmpProject, '.aweek', 'agents'),
      });
      assert.equal(decision.fallThrough, false);
      assert.equal(decision.route, null);
      assert.deepEqual(decision.menu.unhired, ['analyst']);
      assert.equal(decision.menu.options.length, 4);
    } finally {
      await rm(tmpProject, { recursive: true, force: true });
    }
  });

  it('falls through when every project subagent is plugin-namespaced (filtered out per v1)', async () => {
    const tmpProject = await mkdtemp(
      join(tmpdir(), 'aweek-init-hire-plugin-only-'),
    );
    try {
      // Plugin-namespaced subagents are excluded from the unhired list per
      // the v1 constraint. The fall-through helper must therefore treat
      // "only plugin subagents on disk" as "nothing to adopt" and route
      // straight to /aweek:hire create-new.
      await writeSubagentFile({
        slug: 'oh-my-claudecode-explore',
        description: 'Plugin subagent',
        systemPrompt: 'Hi.',
        projectDir: tmpProject,
      });
      await writeSubagentFile({
        slug: 'geo-audit',
        description: 'Plugin subagent',
        systemPrompt: 'Hi.',
        projectDir: tmpProject,
      });

      const decision = await resolveInitHireMenu({
        projectDir: tmpProject,
        dataDir: join(tmpProject, '.aweek', 'agents'),
      });
      assert.equal(decision.fallThrough, true);
      assert.equal(decision.route.action, INIT_HIRE_MENU_CHOICE.CREATE_NEW);
      assert.deepEqual(decision.menu.unhired, []);
    } finally {
      await rm(tmpProject, { recursive: true, force: true });
    }
  });
});
