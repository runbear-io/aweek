/**
 * Summary builder + HTML renderer for execution logs.
 *
 * The raw stream-json execution log is ~150 events long for a normal tick
 * and a few thousand for a verbose one. Rendering it as pretty JSON
 * drowns the signal: the first ~10% is session-bootstrap noise (hook
 * events + a giant tools registry dump from `system:init`), and the
 * actual outcome lives in the final `result` event at the bottom.
 *
 * This module processes the raw JSONL into a shape that foregrounds the
 * important bits:
 *
 *   - **headline**: status badge, duration, in/out tokens, cost, model
 *   - **finalResult**: the assistant's closing message (`result.result`
 *     or the last `assistant:text`)
 *   - **permissionDenials**: tool calls the user / hooks refused
 *   - **timeline**: one row per meaningful turn (thinking / text /
 *     tool_use / tool_result / rate_limit), hooks and the init event
 *     filtered out by default
 *   - **rawEvents**: every event in original order, for the "show
 *     everything" toggle
 *
 * The HTML renderer wraps this into a self-contained page — no SPA
 * dependency, no client-side state, just a static document with
 * `<details>` elements for progressive disclosure.
 */

/**
 * Event subtypes considered "bootstrap noise" — they're the startup
 * chatter Claude Code emits before the agent starts the actual task.
 * Still included in rawEvents so users can toggle them on.
 */
const NOISE_SYSTEM_SUBTYPES = new Set(['hook_started', 'hook_response']);

/**
 * Parse a raw JSONL blob (or already-split string[] of lines) into a
 * normalized event list. Lines that fail JSON.parse are preserved as
 * `{ kind: 'unparseable', raw }` so nothing is silently dropped.
 *
 * @param {string | string[]} input
 * @returns {Array<{ type: string, subtype?: string, parsed?: object, raw: string }>}
 */
export function parseExecutionLog(input) {
  const lines = Array.isArray(input)
    ? input
    : String(input || '').split('\n');
  const events = [];
  for (const line of lines) {
    const raw = typeof line === 'string' ? line : '';
    if (raw.length === 0) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        events.push({
          type: String(parsed.type || 'unknown'),
          subtype: parsed.subtype ? String(parsed.subtype) : undefined,
          parsed,
          raw,
        });
        continue;
      }
    } catch {
      // fall through
    }
    events.push({ type: 'unparseable', parsed: null, raw });
  }
  return events;
}

/**
 * Build a summary object from the parsed event list.
 *
 * @param {ReturnType<typeof parseExecutionLog>} events
 * @returns {{
 *   headline: object,
 *   finalResult: string | null,
 *   permissionDenials: Array<object>,
 *   timeline: Array<object>,
 *   rawEvents: Array<object>,
 *   filteredCount: number,
 * }}
 */
export function buildExecutionLogSummary(events) {
  const resultEvent = findLast(events, (e) => e.type === 'result');
  const initEvent = events.find(
    (e) => e.type === 'system' && e.subtype === 'init',
  );

  const headline = buildHeadline({ resultEvent, initEvent });
  const permissionDenials = Array.isArray(resultEvent?.parsed?.permission_denials)
    ? resultEvent.parsed.permission_denials
    : [];

  const timeline = [];
  let filteredCount = 0;
  let lastAssistantText = null;

  for (const ev of events) {
    // Noise events (hooks, init) are not surfaced in the timeline.
    if (ev.type === 'system' && NOISE_SYSTEM_SUBTYPES.has(ev.subtype || '')) {
      filteredCount += 1;
      continue;
    }
    if (ev.type === 'system' && ev.subtype === 'init') {
      filteredCount += 1;
      continue;
    }

    if (ev.type === 'assistant') {
      const blocks = ev.parsed?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        const tItem = buildAssistantTimelineItem(block);
        if (tItem) {
          timeline.push(tItem);
          if (tItem.kind === 'text') lastAssistantText = tItem.detail;
        }
      }
      continue;
    }

    if (ev.type === 'user') {
      const blocks = ev.parsed?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        const tItem = buildUserTimelineItem(block);
        if (tItem) timeline.push(tItem);
      }
      continue;
    }

    if (ev.type === 'rate_limit_event') {
      timeline.push({
        kind: 'rate_limit',
        icon: '⏳',
        label: 'Rate limit event',
        meta: ev.parsed?.rate_limit_type || '',
        detail: JSON.stringify(ev.parsed, null, 2),
      });
      continue;
    }

    if (ev.type === 'result') {
      // The result event drives the headline + finalResult — don't
      // re-render it as a timeline row.
      continue;
    }

    // Anything else (unknown type) surfaces as a generic timeline row
    // so users can still see it.
    timeline.push({
      kind: 'other',
      icon: '•',
      label: `[${ev.type}${ev.subtype ? ':' + ev.subtype : ''}]`,
      meta: '',
      detail: safeStringify(ev.parsed ?? ev.raw),
    });
  }

  const finalResult =
    typeof resultEvent?.parsed?.result === 'string' && resultEvent.parsed.result.length > 0
      ? resultEvent.parsed.result
      : lastAssistantText;

  return {
    headline,
    finalResult,
    permissionDenials,
    timeline,
    rawEvents: events,
    filteredCount,
  };
}

function buildHeadline({ resultEvent, initEvent }) {
  const r = resultEvent?.parsed ?? null;
  const i = initEvent?.parsed ?? null;
  const usage = r?.usage || {};

  const costUsd =
    typeof r?.total_cost_usd === 'number'
      ? r.total_cost_usd
      : typeof r?.cost_usd === 'number'
        ? r.cost_usd
        : null;

  const subtype = r?.subtype ?? null;
  const status =
    subtype === 'success' || subtype === 'success_max_turns'
      ? 'completed'
      : subtype
        ? 'error'
        : resultEvent
          ? 'completed'
          : 'incomplete';

  const model =
    i?.model ||
    firstKey(r?.modelUsage) ||
    null;

  return {
    status,
    subtype,
    durationMs: typeof r?.duration_ms === 'number' ? r.duration_ms : null,
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
    cacheReadTokens:
      typeof usage.cache_read_input_tokens === 'number'
        ? usage.cache_read_input_tokens
        : null,
    costUsd,
    model,
    sessionId: i?.session_id || r?.session_id || null,
    cwd: i?.cwd || null,
    toolsAvailable: Array.isArray(i?.tools) ? i.tools.length : null,
    terminalReason: r?.terminal_reason || null,
  };
}

function buildAssistantTimelineItem(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    return {
      kind: 'thinking',
      icon: '💭',
      label: 'Thinking',
      meta: '',
      detail: block.thinking,
    };
  }
  if (block.type === 'text' && typeof block.text === 'string') {
    return {
      kind: 'text',
      icon: '💬',
      label: 'Assistant message',
      meta: '',
      detail: block.text,
    };
  }
  if (block.type === 'tool_use') {
    const input = block.input || {};
    return {
      kind: 'tool_use',
      icon: '🔧',
      label: `Tool: ${block.name || '?'}`,
      meta: summarizeToolInput(block.name, input),
      detail: safeStringify({ id: block.id, name: block.name, input }),
    };
  }
  // Unknown assistant block — surface minimally.
  return {
    kind: 'other',
    icon: '•',
    label: `assistant:${block.type || 'unknown'}`,
    meta: '',
    detail: safeStringify(block),
  };
}

function buildUserTimelineItem(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'tool_result') {
    const isError = block.is_error === true;
    const contentStr = toolResultText(block.content);
    return {
      kind: 'tool_result',
      icon: isError ? '✗' : '↩',
      label: isError ? 'Tool error' : 'Tool result',
      meta: oneLine(contentStr, 120),
      detail: contentStr,
    };
  }
  if (block.type === 'text' && typeof block.text === 'string') {
    return {
      kind: 'user_text',
      icon: '📝',
      label: 'User message',
      meta: '',
      detail: block.text,
    };
  }
  return null;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && typeof b.text === 'string'
          ? b.text
          : safeStringify(b),
      )
      .join('\n');
  }
  return safeStringify(content);
}

function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  // Hand-pick the most informative field per tool.
  const candidates = [
    'file_path',
    'path',
    'pattern',
    'command',
    'url',
    'query',
    'prompt',
    'description',
  ];
  for (const k of candidates) {
    if (typeof input[k] === 'string' && input[k].length > 0) {
      return oneLine(input[k], 120);
    }
  }
  // Fall back to a compact JSON digest.
  const s = safeStringify(input);
  return oneLine(s, 120);
}

function oneLine(text, max) {
  if (typeof text !== 'string') return '';
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : compact.slice(0, max - 1) + '…';
}

function safeStringify(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function findLast(arr, predicate) {
  for (let i = arr.length - 1; i >= 0; i--) if (predicate(arr[i])) return arr[i];
  return null;
}

function firstKey(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = Object.keys(obj);
  return keys.length > 0 ? keys[0] : null;
}

/* ------------------------------------------------------------------ *
 * HTML rendering
 * ------------------------------------------------------------------ */

/**
 * Render the summary as a self-contained HTML document.
 *
 * @param {ReturnType<typeof buildExecutionLogSummary>} summary
 * @param {object} meta
 * @param {string} meta.agentId
 * @param {string} meta.basename - `<taskId>_<sessionId>` stem.
 * @param {string} [meta.rawHref] - Link back to the raw JSONL endpoint.
 * @returns {string}
 */
export function renderExecutionLogSummaryHtml(summary, meta = {}) {
  const { agentId = '', basename = '' } = meta;
  const rawHref = meta.rawHref || buildRawHref(agentId, basename);
  const h = summary.headline;
  const title = `Execution — ${agentId} / ${basename}`;

  const statusClass = `status-${h.status || 'unknown'}`;
  const statusLabel =
    h.status === 'completed'
      ? '✓ Completed'
      : h.status === 'error'
        ? `✗ ${h.subtype || 'Error'}`
        : h.status === 'incomplete'
          ? '… Incomplete'
          : h.status;

  const metrics = [
    h.durationMs != null ? formatDuration(h.durationMs) : null,
    h.inputTokens != null ? `${formatInt(h.inputTokens)} in` : null,
    h.outputTokens != null ? `${formatInt(h.outputTokens)} out` : null,
    h.cacheReadTokens != null && h.cacheReadTokens > 0
      ? `${formatInt(h.cacheReadTokens)} cache`
      : null,
    h.costUsd != null ? `$${h.costUsd.toFixed(4)}` : null,
    h.model || null,
  ].filter(Boolean);

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${esc(title)}</title>`,
    `<style>${SUMMARY_CSS}</style>`,
    '</head>',
    '<body>',
    renderBreadcrumb({ agentId, basename, rawHref }),
    `<h1>${esc(agentId)} <span class="basename">${esc(basename)}</span></h1>`,
    `<div class="metrics">`,
    `  <span class="status ${statusClass}">${esc(statusLabel)}</span>`,
    metrics.map((m) => `  <span>${esc(m)}</span>`).join('\n'),
    `</div>`,
    renderMetaExtra(h),
    renderFinalResult(summary.finalResult),
    renderDenials(summary.permissionDenials),
    renderTimeline(summary.timeline),
    renderRawSection(summary),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function renderBreadcrumb({ agentId, basename, rawHref }) {
  const agentHref = esc(`/?agent=${encodeURIComponent(agentId)}&tab=activity`);
  return [
    '<nav class="breadcrumb">',
    '  <a href="/">aweek</a>',
    `  <span>/</span>`,
    `  <a href="${agentHref}">${esc(agentId)}</a>`,
    `  <span>/</span>`,
    `  <span>${esc(basename)}</span>`,
    `  <a class="raw-link" href="${esc(rawHref)}">raw JSONL →</a>`,
    '</nav>',
  ].join('\n');
}

function renderMetaExtra(h) {
  const parts = [];
  if (h.sessionId) parts.push(`session: <code>${esc(h.sessionId)}</code>`);
  if (h.cwd) parts.push(`cwd: <code>${esc(h.cwd)}</code>`);
  if (h.toolsAvailable != null) parts.push(`${h.toolsAvailable} tools available`);
  if (h.terminalReason) parts.push(`terminal: ${esc(h.terminalReason)}`);
  if (parts.length === 0) return '';
  return `<div class="meta-extra">${parts.join(' · ')}</div>`;
}

function renderFinalResult(finalResult) {
  if (!finalResult) return '';
  return [
    '<section class="section final">',
    '  <h2>Final output</h2>',
    `  <pre class="prose">${esc(finalResult)}</pre>`,
    '</section>',
  ].join('\n');
}

function renderDenials(denials) {
  if (!Array.isArray(denials) || denials.length === 0) return '';
  const rows = denials
    .map((d) => {
      const tool = d.tool_name || '?';
      const input = summarizeToolInput(tool, d.tool_input || {});
      const full = safeStringify(d.tool_input || {});
      return [
        '<li>',
        '  <details>',
        `    <summary><strong>${esc(tool)}</strong> — <code>${esc(input)}</code></summary>`,
        `    <pre>${esc(full)}</pre>`,
        '  </details>',
        '</li>',
      ].join('\n');
    })
    .join('\n');
  return [
    '<section class="section denials">',
    `  <h2>⚠ Permission denials <span class="count">(${denials.length})</span></h2>`,
    `  <ul>${rows}</ul>`,
    '</section>',
  ].join('\n');
}

function renderTimeline(timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return '<section class="section timeline"><h2>Timeline</h2><p class="empty">No events.</p></section>';
  }
  const rows = timeline
    .map((item, i) => {
      const labelBits = [
        `<span class="tl-icon">${esc(item.icon || '•')}</span>`,
        `<span class="tl-num">${i + 1}.</span>`,
        `<span class="tl-label">${esc(item.label || '')}</span>`,
        item.meta ? `<span class="tl-meta">${esc(item.meta)}</span>` : '',
      ].join(' ');
      return [
        `<li class="tl-item tl-${esc(item.kind || 'other')}">`,
        '  <details>',
        `    <summary>${labelBits}</summary>`,
        `    <pre>${esc(item.detail || '')}</pre>`,
        '  </details>',
        '</li>',
      ].join('\n');
    })
    .join('\n');
  return [
    '<section class="section timeline">',
    `  <h2>Timeline <span class="count">(${timeline.length} events)</span></h2>`,
    `  <ol>${rows}</ol>`,
    '</section>',
  ].join('\n');
}

function renderRawSection(summary) {
  const allPretty = summary.rawEvents
    .map((ev) => {
      try {
        return JSON.stringify(JSON.parse(ev.raw), null, 2);
      } catch {
        return ev.raw;
      }
    })
    .join('\n\n');
  return [
    '<section class="section raw">',
    '  <details>',
    `    <summary>Full raw execution log <span class="count">(${summary.rawEvents.length} events, ${summary.filteredCount} filtered from timeline)</span></summary>`,
    `    <pre>${esc(allPretty)}</pre>`,
    '  </details>',
    '</section>',
  ].join('\n');
}

function buildRawHref(agentId, basename) {
  return `/api/executions/${encodeURIComponent(agentId)}/${encodeURIComponent(basename)}`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

function formatInt(n) {
  return Number(n).toLocaleString('en-US');
}

/**
 * HTML-escape a string for safe inclusion inside text nodes or quoted
 * attribute values. Covers `<`, `>`, `&`, `"`, `'`.
 */
function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const SUMMARY_CSS = `
  :root {
    --bg: #0b0d10;
    --panel: #15181c;
    --panel-2: #1d2126;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --ok: #3fb950;
    --err: #f85149;
    --warn: #d29922;
    --border: #30363d;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px 32px 64px;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    max-width: 1000px;
    margin-inline: auto;
  }
  h1 { font-size: 22px; margin: 8px 0 4px; font-weight: 600; }
  h1 .basename { color: var(--muted); font-weight: 400; font-size: 15px; margin-left: 8px; font-family: var(--mono); }
  h2 { font-size: 15px; margin: 24px 0 10px; color: var(--text); font-weight: 600; }
  h2 .count { color: var(--muted); font-weight: 400; }
  .breadcrumb {
    display: flex; align-items: center; gap: 8px;
    color: var(--muted); font-size: 13px; margin-bottom: 8px;
  }
  .breadcrumb a { color: var(--accent); text-decoration: none; }
  .breadcrumb a:hover { text-decoration: underline; }
  .breadcrumb .raw-link { margin-left: auto; color: var(--muted); }
  .metrics {
    display: flex; flex-wrap: wrap; gap: 8px 14px;
    font-size: 13px; color: var(--muted);
    padding: 10px 14px; background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; margin: 8px 0 4px;
  }
  .status {
    font-weight: 600; font-size: 12px;
    padding: 2px 8px; border-radius: 4px; text-transform: uppercase;
  }
  .status-completed { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .status-error { background: color-mix(in srgb, var(--err) 20%, transparent); color: var(--err); }
  .status-incomplete, .status-unknown { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  .meta-extra {
    font-size: 12px; color: var(--muted); margin: 4px 0 8px;
  }
  .meta-extra code { background: var(--panel); padding: 1px 6px; border-radius: 3px; font-family: var(--mono); color: var(--text); }
  .section {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px 18px; margin: 14px 0;
  }
  .section.final pre.prose {
    white-space: pre-wrap; word-break: break-word;
    background: var(--panel-2); padding: 12px 14px; border-radius: 6px;
    font-family: var(--mono); font-size: 13px; line-height: 1.55;
    max-height: 400px; overflow: auto;
  }
  .section.denials h2 { color: var(--warn); }
  .section.denials ul { list-style: none; padding: 0; margin: 0; }
  .section.denials li { margin: 6px 0; }
  .section.denials code { font-family: var(--mono); color: var(--muted); }
  .timeline ol { list-style: none; padding: 0; margin: 0; counter-reset: none; }
  .tl-item {
    border-left: 2px solid var(--border); padding: 6px 0 6px 14px; margin: 4px 0;
  }
  .tl-item.tl-thinking { border-left-color: #a5a5a5; }
  .tl-item.tl-text { border-left-color: var(--accent); }
  .tl-item.tl-tool_use { border-left-color: var(--warn); }
  .tl-item.tl-tool_result { border-left-color: var(--ok); }
  .tl-item.tl-other, .tl-item.tl-rate_limit { border-left-color: var(--muted); }
  .tl-item summary {
    cursor: pointer; list-style: none; display: flex; gap: 8px; align-items: baseline;
  }
  .tl-item summary::-webkit-details-marker { display: none; }
  .tl-icon { font-size: 13px; width: 18px; display: inline-block; }
  .tl-num { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 28px; font-family: var(--mono); font-size: 12px; }
  .tl-label { font-weight: 500; }
  .tl-meta { color: var(--muted); font-family: var(--mono); font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  details[open] > summary .tl-meta { white-space: normal; overflow: visible; }
  .tl-item pre {
    white-space: pre-wrap; word-break: break-word; margin: 8px 0 4px;
    background: var(--panel-2); padding: 10px 12px; border-radius: 6px;
    font-family: var(--mono); font-size: 12px; line-height: 1.5;
    max-height: 500px; overflow: auto; color: var(--text);
  }
  .section.raw details { margin: 0; }
  .section.raw pre {
    white-space: pre-wrap; word-break: break-word; margin-top: 12px;
    background: var(--panel-2); padding: 12px 14px; border-radius: 6px;
    font-family: var(--mono); font-size: 11px; line-height: 1.5;
    max-height: 600px; overflow: auto; color: var(--muted);
  }
  .empty { color: var(--muted); font-style: italic; }
`;
