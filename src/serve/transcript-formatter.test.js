import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatTranscriptLine } from './transcript-formatter.js';

describe('transcript-formatter — formatTranscriptLine', () => {
  it('returns [] for empty / non-string input', () => {
    assert.deepEqual(formatTranscriptLine(''), []);
    assert.deepEqual(formatTranscriptLine(null), []);
    assert.deepEqual(formatTranscriptLine(undefined), []);
  });

  it('returns the raw line for invalid JSON', () => {
    assert.deepEqual(formatTranscriptLine('not json'), ['not json']);
  });

  it('formats a system:init event with model + session + cwd', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-4-7',
      session_id: 'abc',
      cwd: '/tmp/proj',
      tools: ['Read', 'Grep'],
    });
    const out = formatTranscriptLine(line);
    assert.deepEqual(out, [
      '[system:init]',
      '  model=claude-opus-4-7 session=abc cwd=/tmp/proj',
      '  tools: Read, Grep',
    ]);
  });

  it('formats a user prompt string', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello there' },
    });
    assert.deepEqual(formatTranscriptLine(line), ['[user]', '  hello there']);
  });

  it('formats a user tool_result block', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'file contents here',
          },
        ],
      },
    });
    const out = formatTranscriptLine(line);
    assert.deepEqual(out, [
      '[tool_result tool_use_id=toolu_1]',
      '  file contents here',
    ]);
  });

  it('marks tool_result errors', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            is_error: true,
            content: 'permission denied',
          },
        ],
      },
    });
    const out = formatTranscriptLine(line);
    assert.deepEqual(out, [
      '[tool_result:error tool_use_id=toolu_2]',
      '  permission denied',
    ]);
  });

  it('formats an assistant text + tool_use turn', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll read the file." },
          {
            type: 'tool_use',
            id: 'toolu_9',
            name: 'Read',
            input: { file_path: '/tmp/x.js' },
          },
        ],
      },
    });
    const out = formatTranscriptLine(line);
    assert.equal(out[0], '[assistant]');
    assert.equal(out[1], "  I'll read the file.");
    assert.equal(out[2], '[tool_use:Read id=toolu_9]');
    const inputBlock = out.slice(3).join('\n');
    assert.ok(inputBlock.includes('"file_path"'));
    assert.ok(inputBlock.includes('/tmp/x.js'));
  });

  it('formats an assistant thinking block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'pondering the request' }],
      },
    });
    const out = formatTranscriptLine(line);
    assert.deepEqual(out, ['[assistant:thinking]', '  pondering the request']);
  });

  it('formats a final result event with usage + cost', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      duration_ms: 1234,
      usage: { input_tokens: 42, output_tokens: 7 },
      total_cost_usd: 0.0034,
      result: 'all done',
    });
    const out = formatTranscriptLine(line);
    assert.ok(out[0] === '[result:success]');
    const metaLine = out[1];
    assert.ok(metaLine.includes('duration=1234ms'));
    assert.ok(metaLine.includes('in=42'));
    assert.ok(metaLine.includes('out=7'));
    assert.ok(metaLine.includes('cost=$0.0034'));
    assert.ok(out.some((l) => l.includes('all done')));
  });

  it('falls back to type label for unknown event types', () => {
    const line = JSON.stringify({ type: 'custom_new_event_type', foo: 1 });
    const out = formatTranscriptLine(line);
    assert.equal(out.length, 1);
    assert.ok(out[0].startsWith('[custom_new_event_type]'));
  });

  it('truncates very long text to keep output bounded', () => {
    const big = 'x'.repeat(10000);
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: big }] },
    });
    const out = formatTranscriptLine(line);
    const joined = out.join('\n');
    assert.ok(joined.length < big.length);
    assert.ok(joined.includes('[truncated'));
  });

  it('indents multi-line assistant text under the header', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'line 1\nline 2\nline 3' }],
      },
    });
    const out = formatTranscriptLine(line);
    assert.deepEqual(out, ['[assistant]', '  line 1', '  line 2', '  line 3']);
  });
});
