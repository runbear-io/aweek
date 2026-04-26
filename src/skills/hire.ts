/**
 * Hire skill entry point — re-exports the new hire wizard pieces so the
 * /aweek:hire skill markdown has a single import surface.
 *
 * The /aweek:hire flow is now routed by ./hire-route.ts and handled by
 * ./hire-create-new.ts, ./hire-all.ts, ./hire-select-some.ts, and
 * ./init-hire-menu.ts. Identity data (name, role, system prompt) lives in
 * .claude/agents/<slug>.md — the aweek JSON only stores scheduling fields.
 */

export {
  createNewSubagent,
  validateCreateNewInput,
} from './hire-create-new.js';
