import { createLogger } from '@flashdrop/config';
import { ORDER_EVENT_TYPES, type OrderEventType } from '@flashdrop/contracts';
import { describe, expect, it } from 'vitest';
import { decodeOrderEvent, dispatchOrderEvent, type OrderEventHandlers } from './handlers';
import { testEvent } from './test/support';

const context = { logger: createLogger({ name: 'test', level: 'silent' }) };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('decodeOrderEvent', () => {
  it('accepts every valid envelope', () => {
    for (const type of ORDER_EVENT_TYPES) {
      const event = testEvent(type);
      expect(decodeOrderEvent(encode(event))).toEqual({ ok: true, event });
    }
  });

  it.each([
    ['an empty value', null],
    ['a value that is not JSON', Buffer.from('{"eventId":')],
    ['an unknown type', encode({ ...testEvent('order.paid'), type: 'order.shipped' })],
    ['another schema version', encode({ ...testEvent('order.paid'), schemaVersion: 2 })],
    ['a missing field', encode({ ...testEvent('order.paid'), orderId: undefined })],
  ])('rejects %s', (_case, value) => {
    const decoded = decodeOrderEvent(value);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.length).toBeGreaterThan(0);
  });
});

describe('dispatchOrderEvent', () => {
  it('runs the handler of the event type with the event, and only that one', async () => {
    const calls: OrderEventType[] = [];
    const handlers: OrderEventHandlers = {
      'order.placed': async (event) => {
        calls.push(event.type);
        expect(event.data.paymentMethod).toBe('pm_ok');
      },
      'order.expired': async (event) => {
        calls.push(event.type);
      },
    };

    expect(await dispatchOrderEvent(handlers, testEvent('order.placed'), context)).toBe(true);
    expect(await dispatchOrderEvent(handlers, testEvent('order.expired'), context)).toBe(true);
    expect(calls).toEqual(['order.placed', 'order.expired']);
  });

  it('does nothing for a type the consumer ignores', async () => {
    expect(await dispatchOrderEvent({}, testEvent('order.reserved'), context)).toBe(false);
  });

  it('propagates the handler error', async () => {
    const handlers: OrderEventHandlers = {
      'order.paid': () => Promise.reject(new Error('psp down')),
    };
    await expect(dispatchOrderEvent(handlers, testEvent('order.paid'), context)).rejects.toThrow('psp down');
  });
});
