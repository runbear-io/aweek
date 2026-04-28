import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  composeKeyValues,
  getAtPath,
  wrapUnderKey,
} from './json-helper.js';

describe('getAtPath', () => {
  it('returns a scalar field as a raw string', () => {
    assert.equal(getAtPath('{"foo":"bar"}', 'foo'), 'bar');
  });

  it('returns a numeric field as a stringified number', () => {
    assert.equal(getAtPath('{"n":42}', 'n'), '42');
  });

  it('returns a boolean field as "true"/"false"', () => {
    assert.equal(getAtPath('{"flag":true}', 'flag'), 'true');
    assert.equal(getAtPath('{"flag":false}', 'flag'), 'false');
  });

  it('returns an object field as JSON', () => {
    assert.equal(getAtPath('{"o":{"a":1}}', 'o'), '{"a":1}');
  });

  it('returns an array field as JSON', () => {
    assert.equal(getAtPath('{"xs":[1,2,3]}', 'xs'), '[1,2,3]');
  });

  it('walks dotted paths', () => {
    assert.equal(getAtPath('{"a":{"b":42}}', 'a.b'), '42');
  });

  it('returns empty string for a missing path', () => {
    assert.equal(getAtPath('{"a":1}', 'b'), '');
  });

  it('returns empty string when an intermediate is null', () => {
    assert.equal(getAtPath('{"a":null}', 'a.b'), '');
  });
});

describe('wrapUnderKey', () => {
  it('wraps an object under the given key', () => {
    assert.equal(wrapUnderKey('{"x":1}', 'data'), '{"data":{"x":1}}');
  });

  it('wraps an array under the given key', () => {
    assert.equal(wrapUnderKey('[1,2]', 'list'), '{"list":[1,2]}');
  });

  it('wraps a string under the given key', () => {
    assert.equal(wrapUnderKey('"hello"', 'msg'), '{"msg":"hello"}');
  });
});

describe('composeKeyValues', () => {
  it('builds a JSON object from numeric key=value pairs', () => {
    assert.equal(composeKeyValues(['a=1', 'b=2']), '{"a":1,"b":2}');
  });

  it('parses each value as JSON when valid', () => {
    assert.equal(
      composeKeyValues(['arr=[1,2]', 'obj={"x":1}']),
      '{"arr":[1,2],"obj":{"x":1}}',
    );
  });

  it('falls back to plain string for non-JSON values', () => {
    assert.equal(
      composeKeyValues(['choice=hire-all']),
      '{"choice":"hire-all"}',
    );
  });

  it('handles values containing equals signs', () => {
    assert.equal(
      composeKeyValues(['url=http://example.com?k=v']),
      '{"url":"http://example.com?k=v"}',
    );
  });

  it('throws on a bad arg shape', () => {
    assert.throws(() => composeKeyValues(['bad']), /key=value/);
  });

  it('returns an empty object for no args', () => {
    assert.equal(composeKeyValues([]), '{}');
  });
});
