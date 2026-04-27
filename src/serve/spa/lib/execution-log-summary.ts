/**
 * Execution-log summary builder (port of the pre-SPA
 * `src/serve/execution-log-summary.js`). Pure — no DOM, no JSX.
 *
 * The raw stream-json execution log runs from ~150 events for a normal
 * tick to a few thousand for a verbose one. Rendering it as pretty JSON
 * drowns the signal: the first ~10% is session-bootstrap noise (hook
 * events + a giant tools registry dump from `system:init`), and the
 * actual outcome lives in the final `result` event at the bottom.
 *
 * This module processes the raw JSONL into a shape that foregrounds the
 * important bits — headline status, final message, permission denials,
 * a meaningful-turn timeline, and the raw event stream for escape
 * hatches. The React page then renders progressive-disclosure UI on top
 * of this shape.
 *
 * @module serve/spa/lib/execution-log-summary
 */

/**
 * System subtypes considered bootstrap noise. Still included in
 * `rawEvents` so the "show everything" section can surface them.
 */
const NOISE_SYSTEM_SUBTYPES = new Set(['hook_started', 'hook_response']);

/**
 * Parse a raw JSONL blob (or already-split array of lines) into a
 * normalized event list. Lines that fail `JSON.parse` become
 * `{ type: 'unparseable', raw }` so nothing is silently dropped.
 *
 * @param {string | string[]} input
 * @returns {Array<{ type: string, subtype?: string, parsed?: object | null, raw: string }>}
 */
export function parseExecutionLog(input: string | string[]) {
  const lines = Array.isArray(input) ? input : String(input || '').split('\n');
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
export function buildExecutionLogSummary(events: ReturnType<typeof parseExecutionLog>) {
  const resultEvent = findLast(events, (e: ReturnType<typeof parseExecutionLog>[number]) => e.type === 'result');
  const initEvent = events.find(
    (e: ReturnType<typeof parseExecutionLog>[number]) => e.type === 'system' && e.subtype === 'init',
  );

  const headline = buildHeadline({ resultEvent, initEvent });
  const permissionDenials = Array.isArray(resultEvent?.parsed?.permission_denials)
    ? resultEvent.parsed.permission_denials
    : [];

  const timeline = [];
  let filteredCount = 0;
  let lastAssistantText = null;

  for (const ev of events) {
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
        detail: safeStringify(ev.parsed),
      });
      continue;
    }

    if (ev.type === 'result') continue;

    timeline.push({
      kind: 'other',
      icon: '•',
      label: `[${ev.type}${ev.subtype ? ':' + ev.subtype : ''}]`,
      meta: '',
      detail: safeStringify(ev.parsed ?? ev.raw),
    });
  }

  const finalResult =
    typeof resultEvent?.parsed?.result === 'string' &&
    resultEvent.parsed.result.length > 0
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

type ParsedEvent = ReturnType<typeof parseExecutionLog>[number];

function buildHeadline({ resultEvent, initEvent }: { resultEvent: ParsedEvent | null; initEvent: ParsedEvent | undefined }) {
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

  const model = i?.model || firstKey(r?.modelUsage) || null;

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

function buildAssistantTimelineItem(block: unknown) {
  if (!block || typeof block !== 'object') return null;
  const b = block as Record<string, unknown>;
  if (b['type'] === 'thinking' && typeof b['thinking'] === 'string') {
    return { kind: 'thinking', icon: '💭', label: 'Thinking', meta: '', detail: b['thinking'] };
  }
  if (b['type'] === 'text' && typeof b['text'] === 'string') {
    return { kind: 'text', icon: '💬', label: 'Assistant message', meta: '', detail: b['text'] };
  }
  if (b['type'] === 'tool_use') {
    const input = b['input'] || {};
    return {
      kind: 'tool_use',
      icon: '🔧',
      label: `Tool: ${b['name'] || '?'}`,
      meta: summarizeToolInput(b['name'] as string, input),
      detail: safeStringify({ id: b['id'], name: b['name'], input }),
    };
  }
  return {
    kind: 'other',
    icon: '•',
    label: `assistant:${b['type'] || 'unknown'}`,
    meta: '',
    detail: safeStringify(b),
  };
}

function buildUserTimelineItem(block: unknown) {
  if (!block || typeof block !== 'object') return null;
  const b = block as Record<string, unknown>;
  if (b['type'] === 'tool_result') {
    const isError = b['is_error'] === true;
    const contentStr = toolResultText(b['content']);
    return {
      kind: 'tool_result',
      icon: isError ? '✗' : '↩',
      label: isError ? 'Tool error' : 'Tool result',
      meta: oneLine(contentStr, 120),
      detail: contentStr,
    };
  }
  if (b['type'] === 'text' && typeof b['text'] === 'string') {
    return { kind: 'user_text', icon: '📝', label: 'User message', meta: '', detail: b['text'] };
  }
  return null;
}

function toolResultText(content: unknown): string {
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

export function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
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
  const inp = input as Record<string, unknown>;
  for (const k of candidates) {
    if (typeof inp[k] === 'string' && (inp[k] as string).length > 0) {
      return oneLine(inp[k] as string, 120);
    }
  }
  return oneLine(safeStringify(input), 120);
}

export function oneLine(text: string, max: number): string {
  if (typeof text !== 'string') return '';
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : compact.slice(0, max - 1) + '…';
}

export function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function findLast<T>(arr: T[], predicate: (item: T) => boolean): T | null {
  for (let i = arr.length - 1; i >= 0; i--) if (predicate(arr[i]!)) return arr[i]!;
  return null;
}

function firstKey(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const keys = Object.keys(obj);
  return keys.length > 0 ? keys[0]! : null;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

export function formatInt(n: number): string {
  return Number(n).toLocaleString('en-US');
}

export function statusLabel(status: string, subtype: string | null | undefined): string {
  if (status === 'completed') return '✓ Completed';
  if (status === 'error') return `✗ ${subtype || 'Error'}`;
  if (status === 'incomplete') return '… Incomplete';
  return String(status || 'Unknown');
}
