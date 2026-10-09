import type { KafkaJS } from '@confluentinc/kafka-javascript';

/** Headers the relay puts on every `orders.v1` record (design §5.4, §12). */
export const EVENT_HEADERS = {
  eventId: 'event-id',
  eventType: 'event-type',
  schemaVersion: 'schema-version',
  traceId: 'trace-id',
} as const;

/** Headers a dead-lettered record carries next to its original ones (design §6.1). */
export const DLQ_HEADERS = {
  /** The consumer (`x-consumer`) whose handler `dlq:replay` runs. */
  consumer: 'x-consumer',
  error: 'x-error',
  /** Deliveries that failed before the record was dead-lettered (1 for a poison message). */
  attempts: 'x-attempts',
  origPartition: 'x-orig-partition',
  origOffset: 'x-orig-offset',
} as const;

/** Header values as a consumer receives them. */
export type ReceivedHeaders = KafkaJS.IHeaders | undefined;

/** One header as text; the first value when a header was sent more than once. */
export function headerText(headers: ReceivedHeaders, name: string): string | undefined {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value.toString('utf8');
}

/** Every header as text, e.g. to copy a record's headers onto its dead-letter copy. */
export function headersAsText(headers: ReceivedHeaders): Record<string, string> {
  const text: Record<string, string> = {};
  for (const name of Object.keys(headers ?? {})) {
    const value = headerText(headers, name);
    if (value !== undefined) text[name] = value;
  }
  return text;
}
