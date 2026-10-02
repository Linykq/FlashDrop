import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BugError } from './errors';
import { checkoutFingerprint, requestFingerprint, uuidv5 } from './identity';

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('uuidv5', () => {
  it('matches the published test vectors', () => {
    // RFC 9562 appendix A.4, and Python's documented uuid5(NAMESPACE_DNS, 'python.org').
    expect(uuidv5('www.example.com', DNS_NAMESPACE)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(uuidv5('python.org', DNS_NAMESPACE.toUpperCase())).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('refuses a namespace that is not a uuid', () => {
    expect(() => uuidv5('x', 'not-a-uuid')).toThrow(BugError);
  });
});

describe('fingerprints', () => {
  const sha256 = (text: string) => createHash('sha256').update(text).digest();

  it('hash the canonical JSON of the reserve body, whatever the key order or extra fields', () => {
    const dropId = '5eed0004-0000-4000-8000-000000000001';
    const expected = sha256(`{"dropId":"${dropId}","qty":2}`);

    const withExtraField = { dropId, qty: 2, note: 'not part of the body' };

    expect(requestFingerprint({ qty: 2, dropId })).toEqual(expected);
    expect(requestFingerprint(withExtraField)).toEqual(expected);
    expect(requestFingerprint({ dropId, qty: 3 })).not.toEqual(expected);
  });

  it('hash the checkout body with the shipping address in canonical order', () => {
    const a = checkoutFingerprint({
      orderId: 'o1',
      shipping: { name: 'Ada', country: 'SE' },
      paymentMethod: 'pm_ok',
    });
    const b = checkoutFingerprint({
      paymentMethod: 'pm_ok',
      shipping: { country: 'SE', name: 'Ada' },
      orderId: 'o1',
    });

    expect(a).toEqual(b);
    expect(a).toEqual(
      sha256('{"orderId":"o1","paymentMethod":"pm_ok","shipping":{"country":"SE","name":"Ada"}}'),
    );
  });
});
