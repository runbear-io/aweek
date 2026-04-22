import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExecutionLogSummary,
  parseExecutionLog,
  renderExecutionLogSummaryHtml,
} from './execution-log-summary.js';

function jsonl(events) {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

describe('execution-log-summary — parseExecutionLog', () => {
  it('returns an empty list for empty input', () => {
    assert.deepEqual(parseExecutionLog(''), []);
    assert.deepEqual(parseExecutionLog([]), []);
    assert.deepEqual(parseExecutionLog(null), []);
  });

  it('parses each JSONL line and preserves its raw form', () => {
    const raw = jsonl([
      { type: 'system', subtype: 'init', model: 'm' },
      { type: 'result', subtype: 'success' },
    ]);
    const events = parseExecutionLog(raw);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'system');
    assert.equal(events[0].subtype, 'init');
    assert.equal(events[0].parsed.model, 'm');
    assert.equal(events[1].type, 'result');
  });

  it('surfaces unparseable lines rather than dropping them', () => {
    const events = parseExecutionLog('not valid json\n' + JSON.stringify({ type: 'result' }));
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'unparseable');
    assert.equal(events[0].raw, 'not valid json');
    assert.equal(events[1].type, 'result');
  });
});

describe('execution-log-summary — buildExecutionLogSummary', () => {
  it('fills the headline from the `result` event and the `system:init` event', () => {
    const events = parseExecutionLog(
      jsonl([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude-opus-4-7',
          session_id: 'sess-xyz',
          cwd: '/tmp/proj',
          tools: ['Read', 'Grep', 'Bash'],
        },
        {
          type: 'result',
          subtype: 'success',
          duration_ms: 1234,
          usage: { input_tokens: 42, output_tokens: 7, cache_read_input_tokens: 100 },
          total_cost_usd: 0.0034,
          result: 'done!',
          terminal_reason: 'completed',
        },
      ]),
    );
    const s = buildExecutionLogSummary(events);
    assert.equal(s.headline.status, 'completed');
    assert.equal(s.headline.subtype, 'success');
    assert.equal(s.headline.durationMs, 1234);
    assert.equal(s.headline.inputTokens, 42);
    assert.equal(s.headline.outputTokens, 7);
    assert.equal(s.headline.cacheReadTokens, 100);
    assert.equal(s.headline.costUsd, 0.0034);
    assert.equal(s.headline.model, 'claude-opus-4-7');
    assert.equal(s.headline.sessionId, 'sess-xyz');
    assert.equal(s.headline.cwd, '/tmp/proj');
    assert.equal(s.headline.toolsAvailable, 3);
    assert.equal(s.headline.terminalReason, 'completed');
  });

  it('uses `result.result` as the finalResult when present', () => {
    const events = parseExecutionLog(
      jsonl([{ type: 'result', subtype: 'success', result: 'the final answer' }]),
    );
    assert.equal(buildExecutionLogSummary(events).finalResult, 'the final answer');
  });

  it('falls back to the last assistant:text when `result.result` is absent', () => {
    const events = parseExecutionLog(
      jsonl([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hello from the agent' }] },
        },
        { type: 'result', subtype: 'success' },
      ]),
    );
    assert.equal(buildExecutionLogSummary(events).finalResult, 'hello from the agent');
  });

  it('surfaces permission_denials from the result event', () => {
    const events = parseExecutionLog(
      jsonl([
        {
          type: 'result',
          subtype: 'success',
          permission_denials: [
            { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
          ],
        },
      ]),
    );
    const s = buildExecutionLogSummary(events);
    assert.equal(s.permissionDenials.length, 1);
    assert.equal(s.permissionDenials[0].tool_name, 'Bash');
  });

  it('filters hook_started / hook_response / init out of the timeline but counts them', () => {
    const events = parseExecutionLog(
      jsonl([
        { type: 'system', subtype: 'hook_started', hook_id: 'a' },
        { type: 'system', subtype: 'hook_response', hook_id: 'a', exit_code: 0 },
        { type: 'system', subtype: 'init', model: 'm' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hi' }] },
        },
      ]),
    );
    const s = buildExecutionLogSummary(events);
    assert.equal(s.timeline.length, 1, 'only the assistant turn should appear');
    assert.equal(s.timeline[0].kind, 'text');
    assert.equal(s.filteredCount, 3);
    assert.equal(s.rawEvents.length, 4, 'rawEvents keeps everything');
  });

  it('builds tool_use timeline rows with a summarized input line', () => {
    const events = parseExecutionLog(
      jsonl([
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu_1',
                name: 'Read',
                input: { file_path: '/tmp/x.js' },
              },
            ],
          },
        },
      ]),
    );
    const s = buildExecutionLogSummary(events);
    assert.equal(s.timeline.length, 1);
    assert.equal(s.timeline[0].kind, 'tool_use');
    assert.equal(s.timeline[0].label, 'Tool: Read');
    assert.equal(s.timeline[0].meta, '/tmp/x.js');
  });

  it('marks tool_result error blocks with the ✗ icon', () => {
    const events = parseExecutionLog(
      jsonl([
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                is_error: true,
                content: 'permission denied',
              },
            ],
          },
        },
      ]),
    );
    const s = buildExecutionLogSummary(events);
    assert.equal(s.timeline.length, 1);
    assert.equal(s.timeline[0].kind, 'tool_result');
    assert.equal(s.timeline[0].icon, '✗');
    assert.equal(s.timeline[0].label, 'Tool error');
  });

  it('surfaces rate_limit_event rows', () => {
    const events = parseExecutionLog(
      jsonl([{ type: 'rate_limit_event', rate_limit_type: 'input_tokens' }]),
    );
    const s = buildExecutionLogSummary(events);
    assert.equal(s.timeline.length, 1);
    assert.equal(s.timeline[0].kind, 'rate_limit');
    assert.equal(s.timeline[0].meta, 'input_tokens');
  });

  it('falls back gracefully when there is no result event', () => {
    const events = parseExecutionLog(
      jsonl([{ type: 'system', subtype: 'init', model: 'm' }]),
    );
    const s = buildExecutionLogSummary(events);
    assert.equal(s.headline.status, 'incomplete');
    assert.equal(s.finalResult, null);
    assert.equal(s.permissionDenials.length, 0);
  });
});

describe('execution-log-summary — renderExecutionLogSummaryHtml', () => {
  function makeSummary() {
    const events = parseExecutionLog(
      jsonl([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude-opus-4-7',
          session_id: 'sess-1',
          cwd: '/tmp/proj',
          tools: ['Read'],
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'I will read the file.' },
              {
                type: 'tool_use',
                id: 'tu_1',
                name: 'Read',
                input: { file_path: '/tmp/x.js' },
              },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          duration_ms: 5000,
          usage: { input_tokens: 100, output_tokens: 50 },
          total_cost_usd: 0.01,
          result: 'the final result text',
          permission_denials: [
            { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
          ],
          terminal_reason: 'completed',
        },
      ]),
    );
    return buildExecutionLogSummary(events);
  }

  it('renders a full HTML document with the headline, final output, denials, timeline, and raw section', () => {
    const html = renderExecutionLogSummaryHtml(makeSummary(), {
      agentId: 'writer',
      basename: 'task-abc_session-1',
    });
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<title>.*writer.*task-abc_session-1<\/title>/);
    // Headline metrics
    assert.match(html, /✓ Completed/);
    assert.match(html, /100 in/);
    assert.match(html, /50 out/);
    assert.match(html, /\$0\.0100/);
    assert.match(html, /claude-opus-4-7/);
    // Final output section
    assert.match(html, /<h2>Final output<\/h2>/);
    assert.match(html, /the final result text/);
    // Denials section
    assert.match(html, /Permission denials/);
    assert.match(html, /rm -rf \//);
    // Timeline
    assert.match(html, /<h2>Timeline/);
    assert.match(html, /Tool: Read/);
    // Raw section
    assert.match(html, /Full raw execution log/);
    // Breadcrumb link back to dashboard
    assert.match(html, /href="\/\?agent=writer&amp;tab=activity"/);
    // Raw JSONL link
    assert.match(html, /\/api\/executions\/writer\/task-abc_session-1/);
  });

  it('escapes HTML-dangerous characters in agent, basename, and execution-log bodies', () => {
    const events = parseExecutionLog(
      jsonl([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'inject <script>alert(1)</script>' }],
          },
        },
        { type: 'result', subtype: 'success', result: 'done' },
      ]),
    );
    const html = renderExecutionLogSummaryHtml(buildExecutionLogSummary(events), {
      agentId: '<bad>',
      basename: '"evil"_1',
    });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;bad&gt;/);
    assert.match(html, /&quot;evil&quot;_1/);
  });

  it('omits the Final output section when there is nothing to show', () => {
    const events = parseExecutionLog(jsonl([{ type: 'result', subtype: 'success' }]));
    const html = renderExecutionLogSummaryHtml(buildExecutionLogSummary(events), {
      agentId: 'w',
      basename: 't_1',
    });
    assert.ok(!html.includes('<h2>Final output</h2>'));
  });

  it('omits the denials section when there are none', () => {
    const events = parseExecutionLog(jsonl([{ type: 'result', subtype: 'success' }]));
    const html = renderExecutionLogSummaryHtml(buildExecutionLogSummary(events), {
      agentId: 'w',
      basename: 't_1',
    });
    assert.ok(!html.includes('Permission denials'));
  });
});
