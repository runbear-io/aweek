/**
 * Hire skill entry point — re-exports the new hire wizard pieces so the
 * /aweek:hire skill markdown has a single import surface.
 *
 * The /aweek:hire flow is now routed by ./hire-route.js and handled by
 * ./hire-create-new.js, ./hire-all.js, ./hire-select-some.js, and
 * ./init-hire-menu.js. Identity data (name, role, system prompt) lives in
 * .claude/agents/<slug>.md — the aweek JSON only stores scheduling fields.
 */

export {
  createNewSubagent,
  validateCreateNewInput,
} from './hire-create-new.js';
