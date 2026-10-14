import { describe, expect, it } from 'vitest';
import { addSample, createWindow, resetWindow, WINDOW_KEEP_MS, windowChange, windowWait } from './alertWindow';

const T0 = 1_760_000_000_000;
const sec = (s: number) => T0 + s * 1000;

describe('price windows', () => {
  it('keeps one sample per second, the last price of that second', () => {
    const w = createWindow();
    addSample(w, sec(0), 100);
    addSample(w, sec(0.4), 101);
    addSample(w, sec(0.9), 102);
    addSample(w, sec(1.2), 103);
    expect(w.samples.map((s) => s.price)).toEqual([102, 103]);
    expect(w.since).toBe(sec(0));
  });

  it('measures against the price N minutes ago once the window has been continuous that long', () => {
    const w = createWindow();
    addSample(w, sec(0), 100);
    addSample(w, sec(100), 101);
    expect(windowChange(w, 3, sec(100))).toBeUndefined();
    expect(windowWait(w, 3, sec(100))).toBe(80_000);
    addSample(w, sec(185), 103);
    // At 185 s the price 3 minutes ago (5 s) is the sample at 0 s: 100.
    expect(windowChange(w, 3, sec(185))).toBeCloseTo(3);
    // The reference slides without new ticks: at 290 s it is the sample at 100 s.
    expect(windowChange(w, 3, sec(290))).toBeCloseTo((103 / 101 - 1) * 100);
    expect(windowChange(w, 5, sec(290))).toBeUndefined();
    expect(windowChange(w, 5, sec(300))).toBeCloseTo(3);
  });

  it('starts over after a reset, so a gap never counts as continuous data', () => {
    const w = createWindow();
    addSample(w, sec(0), 100);
    addSample(w, sec(200), 110);
    expect(windowChange(w, 3, sec(200))).toBeCloseTo(10);
    resetWindow(w);
    addSample(w, sec(210), 120);
    expect(windowChange(w, 3, sec(210))).toBeUndefined();
    expect(windowChange(w, 3, sec(390))).toBeCloseTo(0);
  });

  it('drops samples older than it needs, but keeps the one a 5-minute window starts from', () => {
    const w = createWindow();
    for (let s = 0; s <= 900; s += 30) addSample(w, sec(s), 100 + s / 30);
    expect(w.samples[0].t).toBeLessThanOrEqual(sec(900) - WINDOW_KEEP_MS);
    expect(w.samples[1].t).toBeGreaterThan(sec(900) - WINDOW_KEEP_MS);
    expect(windowChange(w, 5, sec(900))).toBeCloseTo((130 / 120 - 1) * 100);
  });

  it('ignores prices that are not positive and samples older than the newest', () => {
    const w = createWindow();
    addSample(w, sec(10), 0);
    addSample(w, sec(10), Number.NaN);
    expect(w.since).toBeUndefined();
    addSample(w, sec(10), 5);
    addSample(w, sec(5), 6);
    expect(w.samples).toEqual([{ t: sec(10), price: 5 }]);
  });
});
