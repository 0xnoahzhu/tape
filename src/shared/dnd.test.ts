import { describe, expect, it } from 'vitest';
import { DND_MAX_MS, dndActive, dndEnd } from './dnd';

/** New York wall time as Unix ms (EDT is UTC−4 until Nov 1, 2026; EST UTC−5 after). */
const edt = (d: number, h: number, mi = 0) => Date.UTC(2026, 9, d, h + 4, mi);
const est = (mo: number, d: number, h: number, mi = 0) => Date.UTC(2026, mo - 1, d, h + 5, mi);

describe('dndEnd', () => {
  it('one hour from now', () => {
    expect(dndEnd('hour', edt(14, 10, 30))).toBe(edt(14, 11, 30));
  });

  it('the next 09:00 in New York: today before it, tomorrow after it', () => {
    expect(dndEnd('morning', edt(14, 1, 15))).toBe(edt(14, 9));
    expect(dndEnd('morning', edt(14, 8, 59))).toBe(edt(14, 9));
    expect(dndEnd('morning', edt(14, 9))).toBe(edt(15, 9));
    expect(dndEnd('morning', edt(14, 22))).toBe(edt(15, 9));
    // Friday evening: Saturday morning (the choice does not skip weekends).
    expect(dndEnd('morning', edt(16, 18))).toBe(edt(17, 9));
  });

  it('follows New York across a daylight saving change', () => {
    // Clocks go back on Sunday Nov 1, 2026: Saturday evening EDT → Sunday 09:00 EST.
    expect(dndEnd('morning', edt(31, 20))).toBe(est(11, 1, 9));
    expect(dndEnd('morning', edt(31, 20)) - edt(31, 20)).toBeLessThanOrEqual(DND_MAX_MS);
  });

  it('is never further away than DND_MAX_MS', () => {
    for (let h = 0; h < 24; h++) expect(dndEnd('morning', edt(14, h, 1)) - edt(14, h, 1)).toBeLessThanOrEqual(DND_MAX_MS);
  });
});

describe('dndActive', () => {
  it('is on until its end, and off without one', () => {
    const now = edt(14, 10);
    expect(dndActive({ dndUntil: now + 1 }, now)).toBe(true);
    expect(dndActive({ dndUntil: now }, now)).toBe(false);
    expect(dndActive({ dndUntil: null }, now)).toBe(false);
  });
});
