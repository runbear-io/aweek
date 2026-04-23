/**
 * Contract tests for SPA page components.
 *
 * Sub-AC 3.3 replaced server-rendered data injection in SPA page/view
 * components with the new hooks. This test file is deliberately
 * JSX-free: it asserts textual contracts against the page source so we
 * can run under `node --test` without a JSX transform or a React
 * runtime. Those runtime tests are added alongside the Vite/Vitest
 * wiring in a later sub-AC.
 *
 * Invariants enforced per page:
 *   1. Imports its matching data hook (useAgents, useAgentProfile, …).
 *   2. Calls that hook at least once inside the file.
 *   3. Never reads SSR-injected globals (window.__INITIAL_DATA__,
 *      window.__aweek, __INITIAL_STATE__, etc.).
 *   4. Never accepts pre-resolved domain payloads as props
 *      (e.g. `props.agents`, `props.profile`, `props.plan`,
 *      `props.usage`, `props.logs`). Orchestration props like
 *      `slug`, `dateRange`, `onSelectAgent`, `baseUrl`, `fetch` are
 *      fine — those don't encode server-rendered data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read a page source file relative to this directory. */
function readPage(name) {
  return readFileSync(join(HERE, name), 'utf8');
}

/**
 * Strip JS/JSX block and line comments from a source string so that
 * doc-comment mentions of banned patterns (used to *describe* what's
 * forbidden) don't trip the banned-patterns check. Strings are left
 * intact — we want to catch e.g. `JSON.parse(document.getElementById(...))`
 * even when wrapped in a template literal.
 */
function stripComments(src) {
  // Block comments (non-greedy, flag s).
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Line comments — we only scrub from `//` to end-of-line when not
  // inside a string. A perfect scrub requires a tokenizer, but the
  // pages are all comment-then-code (no inline URLs in code), so a
  // naive pass is sufficient for the contract check.
  return noBlock.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Banned read paths for server-injected data. */
const BANNED_GLOBALS = [
  /\bwindow\s*\.\s*__INITIAL_DATA__\b/,
  /\bwindow\s*\.\s*__INITIAL_STATE__\b/,
  /\bwindow\s*\.\s*__aweek\b/i,
  /\bwindow\s*\.\s*__SSR_DATA__\b/,
  // Server-rendered JSON blob hydration patterns.
  /JSON\.parse\s*\(\s*document\.getElementById/,
  /document\.getElementById\s*\(\s*['"]__INITIAL/,
];

/**
 * Props that would mean "server handed us the domain payload up front"
 * rather than "we fetched via a hook". Orchestration props (slug,
 * dateRange, onSelectAgent, baseUrl, fetch) are explicitly allowed and
 * are how the parent router drives the page.
 */
const BANNED_INLINE_DATA_PROPS = [
  'agents',
  'profile',
  'plan',
  'usage',
  'logs',
  'initialData',
  'initialAgents',
  'initialProfile',
  'initialPlan',
  'initialUsage',
  'initialLogs',
];

/**
 * Cases under test — one row per page, each bound to its expected hook.
 */
const CASES = [
  {
    name: 'AgentsPage',
    file: 'agents-page.jsx',
    hook: 'useAgents',
    // slug/dateRange/onSelectAgent/baseUrl/fetch are the orchestration
    // props this page is allowed to receive.
    allowedProps: ['onSelectAgent', 'baseUrl', 'fetch'],
  },
  {
    name: 'AgentProfilePage',
    file: 'agent-profile-page.jsx',
    hook: 'useAgentProfile',
    allowedProps: ['slug', 'baseUrl', 'fetch'],
  },
  {
    name: 'AgentPlanPage',
    file: 'agent-plan-page.jsx',
    hook: 'useAgentPlan',
    allowedProps: ['slug', 'baseUrl', 'fetch'],
  },
  {
    name: 'AgentCalendarPage',
    file: 'agent-calendar-page.jsx',
    hook: 'useAgentCalendar',
    // `week` is an orchestration prop that narrows the API query, not a
    // pre-resolved domain payload — the hook still fetches via `fetch`.
    allowedProps: ['slug', 'week', 'baseUrl', 'fetch'],
  },
  {
    name: 'AgentUsagePage',
    file: 'agent-usage-page.jsx',
    hook: 'useAgentUsage',
    allowedProps: ['slug', 'baseUrl', 'fetch'],
  },
  {
    name: 'AgentActivityPage',
    file: 'agent-activity-page.jsx',
    hook: 'useAgentLogs',
    allowedProps: ['slug', 'initialDateRange', 'baseUrl', 'fetch'],
  },
];

describe('SPA pages — Sub-AC 3.3 data contract', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      const src = readPage(c.file);

      it(`imports ${c.hook} from the hooks module`, () => {
        // Match both named import styles and tolerate whitespace.
        const importRe = new RegExp(
          `import\\s*\\{[^}]*\\b${c.hook}\\b[^}]*\\}\\s*from\\s*['"][^'"]*hooks/${kebab(c.hook)}\\.js['"]`,
          's',
        );
        assert.match(
          src,
          importRe,
          `expected ${c.file} to import { ${c.hook} } from '../hooks/${kebab(c.hook)}.js'`,
        );
      });

      it(`calls ${c.hook}(...) at least once`, () => {
        const callRe = new RegExp(`\\b${c.hook}\\s*\\(`);
        assert.match(
          src,
          callRe,
          `expected ${c.file} to actually invoke ${c.hook}(...)`,
        );
      });

      it('does not read SSR-injected globals', () => {
        const code = stripComments(src);
        for (const re of BANNED_GLOBALS) {
          assert.doesNotMatch(
            code,
            re,
            `${c.file} must not read SSR-injected data via ${re}`,
          );
        }
      });

      it('does not accept pre-resolved domain payloads as props', () => {
        // Extract the destructured top-level prop list: the parenthesised
        // argument of the exported page component declaration. If we
        // can't find it (e.g. component uses `(props)` rather than
        // destructuring), skip — this check only applies to the
        // destructuring style we use.
        const declRe = new RegExp(
          `export\\s+function\\s+${c.name}\\s*\\(\\s*\\{([^}]*)\\}`,
        );
        const m = declRe.exec(src);
        assert.ok(m, `expected ${c.file} to export function ${c.name}({...})`);
        const propNames = m[1]
          .split(',')
          .map((p) => p.trim().split(/[:=]/)[0].trim())
          .filter(Boolean);
        for (const prop of propNames) {
          assert.ok(
            !BANNED_INLINE_DATA_PROPS.includes(prop),
            `${c.file}: prop "${prop}" is a server-rendered domain payload; data must come from ${c.hook}(), not a prop`,
          );
        }
        // And every prop we actually declare must be in the allow-list.
        for (const prop of propNames) {
          assert.ok(
            c.allowedProps.includes(prop),
            `${c.file}: prop "${prop}" is not in the allow-list ${JSON.stringify(c.allowedProps)}. ` +
              `Add it explicitly if it is an orchestration-only prop.`,
          );
        }
      });
    });
  }

  it('barrel re-exports every page', () => {
    const src = readFileSync(join(HERE, 'index.js'), 'utf8');
    for (const c of CASES) {
      assert.match(
        src,
        new RegExp(`\\b${c.name}\\b`),
        `pages/index.js must re-export ${c.name}`,
      );
    }
  });
});

/**
 * Convert a camelCase hook name (`useAgentProfile`) into its kebab-case
 * file name (`use-agent-profile`). Matches the convention in
 * `../hooks/`.
 */
function kebab(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
