import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { redactLine, REDACTION_MARKER } from './secret-redactor.js';

const M = REDACTION_MARKER;

describe('secret-redactor — redactLine', () => {
  it('returns non-strings unchanged', () => {
    assert.equal(redactLine(''), '');
    assert.equal(redactLine(null), null);
    assert.equal(redactLine(undefined), undefined);
  });

  it('leaves ordinary text untouched', () => {
    const input = 'this line has nothing to hide — just normal log text';
    assert.equal(redactLine(input), input);
  });

  it('redacts OpenAI-style `sk-…` keys', () => {
    const out = redactLine('using key sk-abcDEF0123456789xyz in the call');
    assert.equal(out, `using key ${M} in the call`);
  });

  it('redacts Anthropic `sk-ant-…` keys', () => {
    const out = redactLine('token=sk-ant-api03-aB3_XyZ-1234567890abcdefghij') as string;
    assert.ok(out.includes(M));
    assert.ok(!out.includes('sk-ant-api03-aB3'));
  });

  it('redacts GitHub classic PATs', () => {
    const out = redactLine('gh token ghp_1234567890abcdefghijklmnopqrstuvwxyz done');
    assert.equal(out, `gh token ${M} done`);
  });

  it('redacts GitHub fine-grained PATs', () => {
    const token = 'github_pat_11ABCDE0123456789' + 'a'.repeat(50);
    const out = redactLine(`token=${token}`) as string;
    assert.ok(out.includes(M));
    assert.ok(!out.includes(token));
  });

  it('redacts Slack tokens', () => {
    const out = redactLine('slack xoxb-1234567890-abcdef in config');
    assert.equal(out, `slack ${M} in config`);
  });

  it('redacts AWS access-key IDs', () => {
    const out = redactLine('aws_key=AKIAIOSFODNN7EXAMPLE uploaded') as string;
    assert.ok(out.includes(M));
    assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
  });

  it('redacts Google API keys', () => {
    const google = 'AIzaSy' + 'A'.repeat(33);
    const out = redactLine(`key=${google} ok`) as string;
    assert.ok(out.includes(M));
    assert.ok(!out.includes(google));
  });

  it('redacts Stripe keys', () => {
    const out = redactLine('use sk_' + 'live_51abcdefghijklmnopqrstuvwxyz for billing') as string;
    assert.ok(out.includes(M));
    assert.ok(!out.includes('sk_live_51'));
  });

  it('redacts JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIs.' +
      'eyJzdWIiOiIxMjM0NTY3ODkw.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6y';
    const out = redactLine(`Authorization: ${jwt}`) as string;
    assert.ok(out.includes(M));
    assert.ok(!out.includes(jwt));
  });

  it('redacts Bearer tokens', () => {
    const out = redactLine('Authorization: Bearer abcDEF0123456789XYZ_token-value') as string;
    assert.ok(out.includes(M));
    assert.ok(!out.includes('abcDEF0123456789XYZ_token-value'));
  });

  it('redacts NAME=value style env-var secrets, keeping the name', () => {
    const out = redactLine('OPENAI_API_KEY=sk-xyz789abcdef012345') as string;
    // Name is preserved so the reader knows what was scrubbed.
    assert.ok(out.startsWith('OPENAI_API_KEY='));
    assert.ok(out.includes(M));
    assert.ok(!out.includes('sk-xyz789abcdef012345'));
  });

  it('redacts NAME: value style secrets too', () => {
    const out = redactLine('MY_SECRET: hunter2isNotEnough') as string;
    assert.ok(out.startsWith('MY_SECRET:'));
    assert.ok(out.includes(M));
    assert.ok(!out.includes('hunter2isNotEnough'));
  });

  it('does NOT redact short values in NAME=value pattern (below length floor)', () => {
    // "TOKEN=abc" is too short to plausibly be a secret — leave it alone.
    const input = 'TOKEN=abc';
    assert.equal(redactLine(input), input);
  });

  it('redacts multiple secrets in one line', () => {
    const out = redactLine(
      'creds: sk-abcDEF0123456789xyz and ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    );
    assert.equal(out, `creds: ${M} and ${M}`);
  });

  it('is idempotent — running redaction twice does not double-mark', () => {
    const once = redactLine('sk-abcDEF0123456789xyz');
    const twice = redactLine(once);
    assert.equal(twice, once);
  });

  it('preserves surrounding JSON punctuation', () => {
    const out = redactLine('{"apiKey":"sk-abcDEF0123456789xyz","other":"value"}') as string;
    assert.ok(out.includes('"apiKey":"'));
    assert.ok(out.includes(M));
    assert.ok(out.includes('"other":"value"'));
    assert.ok(!out.includes('sk-abcDEF0123456789xyz'));
  });
});
