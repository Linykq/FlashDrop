import { describe, expect, it } from 'vitest';
import { createLogger, REDACTED } from './logger';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = { write: (line: string) => void lines.push(JSON.parse(line)) };
  return { lines, stream };
}

describe('createLogger', () => {
  it('writes JSON lines with a level label, name and ISO timestamp', () => {
    const { lines, stream } = capture();

    createLogger({ name: 'api' }, stream).child({ orderId: 'o-1' }).info('order placed');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', name: 'api', orderId: 'o-1', msg: 'order placed' });
    expect(lines[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('honours the level', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ name: 'worker', level: 'warn' }, stream);

    logger.info('dropped');
    logger.warn('kept');

    expect(lines.map((line) => line.msg)).toEqual(['kept']);
  });

  it('redacts secrets in the shapes FlashDrop logs', () => {
    const { lines, stream } = capture();

    createLogger({ name: 'api' }, stream).info(
      {
        password: 'p',
        REDIS_URL: 'redis://:pw@h:6379',
        env: {
          SESSION_SECRET: 's',
          ANTHROPIC_API_KEY: 'k',
          DATABASE_URL: 'postgres://u:p@h/db',
          LOG_LEVEL: 'info',
        },
        headers: { authorization: 'Bearer t' },
        req: {
          headers: { authorization: 'Bearer t', cookie: 'fd_session=c', 'x-test-secret': 'x', accept: '*/*' },
        },
        res: { headers: { 'set-cookie': 'fd_session=c' } },
        orderId: 'o-1',
      },
      'request',
    );

    expect(lines[0]).toMatchObject({
      password: REDACTED,
      REDIS_URL: REDACTED,
      env: {
        SESSION_SECRET: REDACTED,
        ANTHROPIC_API_KEY: REDACTED,
        DATABASE_URL: REDACTED,
        LOG_LEVEL: 'info',
      },
      headers: { authorization: REDACTED },
      req: {
        headers: { authorization: REDACTED, cookie: REDACTED, 'x-test-secret': REDACTED, accept: '*/*' },
      },
      res: { headers: { 'set-cookie': REDACTED } },
      orderId: 'o-1',
    });
  });
});
