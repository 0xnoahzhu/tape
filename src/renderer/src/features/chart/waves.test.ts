import { describe, expect, it } from 'vitest';
import { pathBars } from './__fixtures__/pathBars';
import { findWaves, MIN_WAVE_BARS, zigzag } from './waves';

const labels = (c: ReturnType<typeof findWaves>) => c.points.map((p) => `${p.label}@${Math.round(p.price)}`).join(' ');

describe('zigzag', () => {
  it('turns once the price comes back the threshold from its extreme', () => {
    const bars = pathBars([100, 110, 105, 120, 112, 130]);
    expect(zigzag(bars, 0, bars.length - 1, 4).map((s) => Math.round(s.price))).toEqual([100, 110, 105, 120, 112, 130]);
    // At 7 the 110 → 105 dip is too small to turn.
    expect(zigzag(bars, 0, bars.length - 1, 7).map((s) => Math.round(s.price))).toEqual([100, 120, 112, 130]);
  });
});

describe('findWaves', () => {
  it('reads a 5-wave impulse that keeps the rules, with its ratios', () => {
    const c = findWaves(pathBars([100, 120, 108, 140, 130, 150]), 0, 30);
    expect(c).toMatchObject({ waves: 5, ok: true, dir: 'up' });
    expect(labels(c)).toBe('@100 1@120 2@108 3@140 4@130 5@150');
    expect(c.ratios.w2).toBeCloseTo(0.6, 2);
    expect(c.ratios.w3).toBeCloseTo(1.6, 1);
    expect(c.ratios.w4).toBeCloseTo(10 / 32, 2);
  });

  it('reads a falling impulse too', () => {
    expect(findWaves(pathBars([150, 130, 142, 110, 120, 100]), 0, 30)).toMatchObject({ waves: 5, ok: true, dir: 'down' });
  });

  it('says which rule a 5-wave count breaks', () => {
    // Wave 4 (115) dips into wave 1 (100–120): no impulse. At a larger scale the swings are an
    // A-B-C (100 → 140 → 115 → 150), which keeps its rules; the 5-wave count says why it is not one.
    const overlap = findWaves(pathBars([100, 120, 108, 140, 115, 150]), 0, 30);
    expect(overlap).toMatchObject({ waves: 3, ok: true });
    expect(overlap.rejected).toMatchObject({ waves: 5, ok: false });
    expect(overlap.rejected!.rules).toEqual([
      { id: 'w2', ok: true },
      { id: 'w3', ok: true },
      { id: 'w4', ok: false },
    ]);
    // Wave 3 (13) shorter than both 1 (20) and 5 (29).
    const short = findWaves(pathBars([100, 120, 110, 123, 121, 150]), 0, 30);
    const five = short.waves === 5 ? short : short.rejected;
    expect(five?.rules.find((r) => r.id === 'w3')?.ok).toBe(false);
  });

  it('reads an A-B-C, a zigzag or a flat', () => {
    const zz = findWaves(pathBars([150, 130, 140, 120]), 0, 18);
    expect(zz).toMatchObject({ waves: 3, ok: true, dir: 'down', correction: 'zigzag' });
    expect(labels(zz)).toBe('@150 A@130 B@140 C@120');
    expect(zz.ratios.b).toBeCloseTo(0.5, 2);
    expect(findWaves(pathBars([150, 130, 149, 129]), 0, 18)).toMatchObject({ waves: 3, ok: true, correction: 'flat' });
    // B beyond A's start.
    expect(findWaves(pathBars([150, 130, 160, 120]), 0, 18).rules.find((r) => r.id === 'b')?.ok).toBe(false);
  });

  it('reads 8 waves: an impulse and an A-B-C against it', () => {
    const c = findWaves(pathBars([100, 120, 108, 140, 130, 150, 135, 142, 125]), 0, 48);
    expect(c).toMatchObject({ waves: 8, ok: true, dir: 'up' });
    expect(labels(c)).toBe('@100 1@120 2@108 3@140 4@130 5@150 A@135 B@142 C@125');
  });

  it('prefers 8 over 5 over 3, at the largest scale that gives each', () => {
    // The whole cycle is selected: 8 wins even though its first 5 legs alone are an impulse.
    expect(findWaves(pathBars([100, 120, 108, 140, 130, 150, 135, 142, 125]), 0, 48).waves).toBe(8);
    // Only the impulse selected.
    expect(findWaves(pathBars([100, 120, 108, 140, 130, 150, 135, 142, 125]), 0, 30).waves).toBe(5);
  });

  it('reads a count when the stretch runs a leg past it (a low-to-low stretch has an even number of legs)', () => {
    // An impulse, then the start of a pullback: six legs, read as the 5 waves without the last.
    const c = findWaves(pathBars([100, 120, 108, 140, 130, 150, 141]), 0, 36);
    expect(c).toMatchObject({ waves: 5, ok: true });
    expect(labels(c)).toBe('@100 1@120 2@108 3@140 4@130 5@150');
  });

  it('needs enough bars', () => {
    expect(findWaves(pathBars([100, 120, 108, 140, 130, 150]), 0, MIN_WAVE_BARS - 2)).toMatchObject({ waves: null, why: 'short' });
  });
});
