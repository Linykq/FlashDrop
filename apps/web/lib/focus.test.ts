import { describe, expect, it } from 'vitest';
import { userHasFocus } from './focus';

const element = (visible: boolean) => ({ checkVisibility: () => visible });

describe('userHasFocus', () => {
  const body = element(true);

  it('leaves focus where a buyer put it before hydration', () => {
    // Typing in Full name on a slow phone when the page's load focus finally runs.
    expect(userHasFocus(element(true), body)).toBe(true);
  });

  it('lets the page take focus while nothing has it', () => {
    expect(userHasFocus(null, body)).toBe(false);
    expect(userHasFocus(body, body)).toBe(false);
  });

  it('ignores a control left focused on the page navigated away from, now hidden', () => {
    expect(userHasFocus(element(false), body)).toBe(false);
  });

  it('counts any focused element where the browser cannot tell visibility', () => {
    expect(userHasFocus({} as Pick<Element, 'checkVisibility'>, body)).toBe(true);
  });
});
