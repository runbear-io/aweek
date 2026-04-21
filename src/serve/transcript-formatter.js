/**
 * Human-readable formatter for stream-json transcript events.
 *
 * The heartbeat persists Claude Code's stream-json output verbatim to
 * `<agentsDir>/<agent>/executions/<taskId>-<executionId>.jsonl`. The
 * dashboard's transcript endpoint streams that file through this
 * formatter so users see a flat, greppable plain-text view rather than
 * raw JSON.
 *
 * Each event maps to one or more output lines. Unknown event shapes fall
 * back to the raw line so no signal is hidden; unparseable input falls
 * back to the original string so we never lose data.
 */

const MAX_TEXT_LEN = 4000;
const MAX_TOOL_OUTPUT_LEN = 2000;

/**
 * Format a single raw JSONL line into one or more plain-text output lines.
 * Returns an array of strings — the caller joins with newlines. Empty
 * arrays are possible for no-op events.
 *
 * @param {string} rawLine
 * @returns {string[]}
 */
export function formatTranscriptLine(rawLine) {
  if (typeof rawLine !== 'string' || rawLine.length === 0) return [];

  let event;
  try {
    event = JSON.parse(rawLine);
  } catch {
    return [rawLine];
  }

  if (!event || typeof event !== 'object') return [rawLine];

  const type = String(event.type || 'unknown');
  switch (type) {
    case 'system':
      return formatSystem(event);
    case 'user':
      return formatUser(event);
    case 'assistant':
      return formatAssistant(event);
    case 'result':
      return formatResult(event);
    default:
      return [`[${type}] ${compact(event)}`];
  }
}

function formatSystem(event) {
  const subtype = event.subtype || 'init';
  const lines = [`[system:${subtype}]`];

  if (subtype === 'init') {
    const parts = [];
    if (event.model) parts.push(`model=${event.model}`);
    if (event.session_id) parts.push(`session=${event.session_id}`);
    if (event.cwd) parts.push(`cwd=${event.cwd}`);
    if (parts.length > 0) lines.push(`  ${parts.join(' ')}`);
    if (Array.isArray(event.tools) && event.tools.length > 0) {
      lines.push(`  tools: ${event.tools.join(', ')}`);
    }
  }
  return lines;
}

function formatUser(event) {
  const message = event.message || {};
  const content = message.content;

  // Plain string user prompt.
  if (typeof content === 'string') {
    return [`[user]`, ...indent(truncate(content, MAX_TEXT_LEN))];
  }

  // Content blocks — can include tool_result blocks from the model's
  // tool-calling protocol; those deserve their own header.
  if (Array.isArray(content)) {
    const lines = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result') {
        const header = block.is_error
          ? `[tool_result:error tool_use_id=${block.tool_use_id || '?'}]`
          : `[tool_result tool_use_id=${block.tool_use_id || '?'}]`;
        lines.push(header);
        lines.push(...indent(renderToolResultContent(block.content)));
      } else if (block.type === 'text' && typeof block.text === 'string') {
        lines.push(`[user]`);
        lines.push(...indent(truncate(block.text, MAX_TEXT_LEN)));
      } else {
        lines.push(`[user:${block.type || 'unknown'}] ${compact(block)}`);
      }
    }
    return lines;
  }

  return [`[user] ${compact(event)}`];
}

function formatAssistant(event) {
  const message = event.message || {};
  const content = message.content;
  const lines = [];

  if (!Array.isArray(content)) {
    return [`[assistant] ${compact(event)}`];
  }

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      lines.push(`[assistant]`);
      lines.push(...indent(truncate(block.text, MAX_TEXT_LEN)));
    } else if (block.type === 'tool_use') {
      const name = block.name || '?';
      const id = block.id || '?';
      lines.push(`[tool_use:${name} id=${id}]`);
      lines.push(...indent(truncate(stringifyInput(block.input), MAX_TOOL_OUTPUT_LEN)));
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      lines.push(`[assistant:thinking]`);
      lines.push(...indent(truncate(block.thinking, MAX_TEXT_LEN)));
    } else {
      lines.push(`[assistant:${block.type || 'unknown'}] ${compact(block)}`);
    }
  }
  return lines;
}

function formatResult(event) {
  const subtype = event.subtype || 'success';
  const lines = [`[result:${subtype}]`];
  const usage = event.usage || {};
  const parts = [];
  if (typeof event.duration_ms === 'number') parts.push(`duration=${event.duration_ms}ms`);
  if (typeof usage.input_tokens === 'number') parts.push(`in=${usage.input_tokens}`);
  if (typeof usage.output_tokens === 'number') parts.push(`out=${usage.output_tokens}`);
  if (typeof event.total_cost_usd === 'number') {
    parts.push(`cost=$${event.total_cost_usd.toFixed(4)}`);
  } else if (typeof event.cost_usd === 'number') {
    parts.push(`cost=$${event.cost_usd.toFixed(4)}`);
  }
  if (parts.length > 0) lines.push(`  ${parts.join(' ')}`);
  if (typeof event.result === 'string' && event.result.length > 0) {
    lines.push(`  final:`);
    lines.push(...indent(truncate(event.result, MAX_TEXT_LEN), '    '));
  }
  return lines;
}

function renderToolResultContent(content) {
  if (typeof content === 'string') return truncate(content, MAX_TOOL_OUTPUT_LEN);
  if (Array.isArray(content)) {
    // Newer tool_result shape — blocks array, usually text.
    const text = content
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : compact(b)))
      .join('\n');
    return truncate(text, MAX_TOOL_OUTPUT_LEN);
  }
  return compact(content);
}

function stringifyInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}

function indent(text, prefix = '  ') {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text.split('\n').map((line) => prefix + line);
}

function compact(obj) {
  try {
    const json = JSON.stringify(obj);
    return truncate(json || '', 200);
  } catch {
    return String(obj);
  }
}
