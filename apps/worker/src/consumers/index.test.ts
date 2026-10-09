import { describe, expect, it } from 'vitest';
import { consumerConnections } from './index';

describe('consumerConnections', () => {
  it('gives each consumer role one connection per order in flight, and the other roles none', () => {
    expect(consumerConnections(['relay', 'sweeper', 'reconciler'])).toBe(0);
    expect(consumerConnections(['payment'])).toBe(32);
    expect(consumerConnections(['payment', 'settlement'])).toBe(48);
  });

  it('gives the dashboard one connection: its group commit runs one transaction at a time', () => {
    expect(consumerConnections(['dashboard'])).toBe(1);
    expect(consumerConnections(['payment', 'settlement', 'dashboard'])).toBe(49);
  });
});
