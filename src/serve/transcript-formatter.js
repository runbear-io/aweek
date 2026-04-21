/**
 * Pretty-printer for stream-json transcript events.
 *
 * The heartbeat persists Claude Code's stream-json output verbatim to
 * `<agentsDir>/<agent>/executions/<taskId>_<executionId>.jsonl`. The
 * dashboard's transcript endpoint streams that file through this
 * formatter so every field lands in the browser — nothing is dropped or
 * summarized — rendered as indented JSON with a blank line between
 * events for readability.
 *
 * Unparseable input falls back to the original string so we never lose
 * data.
 */

/**
 * Format a single raw JSONL line into one or more plain-text output lines.
 * Returns an array of strings — the caller joins with newlines. The last
 * element is an empty string so consecutive events are separated by a
 * blank line.
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
    return [rawLine, ''];
  }

  if (event === null || typeof event !== 'object') {
    return [rawLine, ''];
  }

  const pretty = JSON.stringify(event, null, 2);
  return [...pretty.split('\n'), ''];
}
