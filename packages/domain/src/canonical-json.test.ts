import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json';

describe('canonicalJson', () => {
  it('ignores key order at every level', () => {
    expect(canonicalJson({ qty: 2, dropId: 'd' })).toBe(canonicalJson({ dropId: 'd', qty: 2 }));
    expect(canonicalJson({ b: { y: 1, x: [{ q: 1, p: 2 }] }, a: null })).toBe(
      '{"a":null,"b":{"x":[{"p":2,"q":1}],"y":1}}',
    );
  });

  it('keeps array order and JSON semantics', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ a: undefined, d: new Date(0) })).toBe('{"d":"1970-01-01T00:00:00.000Z"}');
    expect(canonicalJson('x')).toBe('"x"');
  });
});
