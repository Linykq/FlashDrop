import { describe, expect, it } from 'vitest';
import { consumerConnections } from './index';

describe('consumerConnections', () => {
  it('gives each consumer role one connection per order in flight, and the other roles none', () => {
    expect(consumerConnections(['relay', 'sweeper', 'reconciler'])).toBe(0);
    expect(consumerConnections(['payment'])).toBe(32);
    expect(consumerConnections(['payment', 'settlement'])).toBe(48);
  });
});
