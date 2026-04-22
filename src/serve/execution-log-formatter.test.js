import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatExecutionLogLine } from './execution-log-formatter.js';

describe('execution-log-formatter — formatExecutionLogLine', () => {
  it('returns [] for empty / non-string input', () => {
    assert.deepEqual(formatExecutionLogLine(''), []);
    assert.deepEqual(formatExecutionLogLine(null), []);
    assert.deepEqual(formatExecutionLogLine(undefined), []);
  });

  it('returns the raw line for invalid JSON, with a trailing blank', () => {
    assert.deepEqual(formatExecutionLogLine('not json'), ['not json', '']);
  });

  it('returns the raw line for non-object JSON (string, number, null)', () => {
    assert.deepEqual(formatExecutionLogLine('"just a string"'), ['"just a string"', '']);
    assert.deepEqual(formatExecutionLogLine('42'), ['42', '']);
    assert.deepEqual(formatExecutionLogLine('null'), ['null', '']);
  });

  it('pretty-prints a system:init event with every field preserved', () => {
    const event = {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-4-7',
      session_id: 'abc',
      cwd: '/tmp/proj',
      tools: ['Read', 'Grep'],
      permissionMode: 'bypassPermissions',
    };
    const out = formatExecutionLogLine(JSON.stringify(event));
    // Last line is a blank-line separator.
    assert.equal(out[out.length - 1], '');
    const joined = out.slice(0, -1).join('\n');
    assert.deepEqual(JSON.parse(joined), event);
    // Confirm 2-space indentation is applied.
    assert.ok(joined.includes('  "type": "system"'));
    assert.ok(joined.includes('  "permissionMode": "bypassPermissions"'));
  });

  it('pretty-prints an assistant tool_use turn with every nested field', () => {
    const event = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll read the file." },
          {
            type: 'tool_use',
            id: 'toolu_9',
            name: 'Read',
            input: { file_path: '/tmp/x.js', offset: 10 },
          },
        ],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    };
    const out = formatExecutionLogLine(JSON.stringify(event));
    assert.equal(out[out.length - 1], '');
    const joined = out.slice(0, -1).join('\n');
    assert.deepEqual(JSON.parse(joined), event);
    assert.ok(joined.includes('"file_path": "/tmp/x.js"'));
    assert.ok(joined.includes('"offset": 10'));
    assert.ok(joined.includes('"usage"'));
  });

  it('pretty-prints a tool_result user turn without dropping error flags', () => {
    const event = {
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
    };
    const out = formatExecutionLogLine(JSON.stringify(event));
    const joined = out.slice(0, -1).join('\n');
    assert.deepEqual(JSON.parse(joined), event);
    assert.ok(joined.includes('"is_error": true'));
    assert.ok(joined.includes('"tool_use_id": "toolu_2"'));
  });

  it('preserves unknown event types byte-for-byte', () => {
    const event = { type: 'custom_new_event_type', foo: 1, bar: { nested: true } };
    const out = formatExecutionLogLine(JSON.stringify(event));
    const joined = out.slice(0, -1).join('\n');
    assert.deepEqual(JSON.parse(joined), event);
  });

  it('does not truncate long text fields', () => {
    const big = 'x'.repeat(10000);
    const event = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: big }] },
    };
    const out = formatExecutionLogLine(JSON.stringify(event));
    const joined = out.slice(0, -1).join('\n');
    assert.deepEqual(JSON.parse(joined), event);
    assert.ok(joined.includes(big));
  });

  it('emits a trailing blank line so consecutive events are separated', () => {
    const a = formatExecutionLogLine(JSON.stringify({ type: 'system', subtype: 'init' }));
    const b = formatExecutionLogLine(JSON.stringify({ type: 'result', subtype: 'success' }));
    assert.equal(a[a.length - 1], '');
    assert.equal(b[b.length - 1], '');
    // Joining the way the server does — `formatted.join('\n') + '\n'` —
    // yields a blank line between the two JSON blocks.
    const stream = a.join('\n') + '\n' + b.join('\n') + '\n';
    assert.ok(stream.includes('}\n\n{'));
  });
});
