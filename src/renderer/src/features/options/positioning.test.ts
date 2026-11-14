import { describe, expect, it } from 'vitest';
import type { PositioningRow, PositioningSnapshot } from '@shared/types';
import type { ChainExpiry } from './chain';
import { blackScholes } from './math';
import {
  dayLevels,
  exposureByStrike,
  gexProfile,
  greeksAt,
  maxPain,
  oiMap,
  prepare,
  scanContracts,
  scopeExpiries,
  totals,
  unusualVolume,
  walls,
  zeroGamma,
  type Prepared,
} from './positioning';

const row = (strike: number, right: 'C' | 'P', oi: number, extra: Partial<Prepared> = {}): Prepared => ({ expiry: '20991218', strike, right, multiplier: 100, oi, t: 0.1, sigma: 0.25, ...extra });

describe('greeksAt', () => {
  it('matches finite differences of Black–Scholes delta for vanna and charm', () => {
    const [s, k, t, v] = [100, 105, 0.2, 0.3];
    const g = greeksAt(s, k, t, v, 'C')!;
    const h = 1e-4;
    const vanna = (blackScholes(s, k, t, v + h, 'C').delta - blackScholes(s, k, t, v - h, 'C').delta) / (2 * h);
    expect(g.vanna).toBeCloseTo(vanna, 4);
    const day = 1 / 365;
    expect(g.charm).toBeCloseTo(blackScholes(s, k, t - day, v, 'C').delta - blackScholes(s, k, t, v, 'C').delta, 4);
    // A put's vanna and charm equal the call's (put delta = call delta − 1).
    const p = greeksAt(s, k, t, v, 'P')!;
    expect(p.vanna).toBeCloseTo(g.vanna, 10);
    expect(p.charm).toBeCloseTo(g.charm, 10);
    expect(p.delta).toBeCloseTo(g.delta - 1, 10);
  });

  it('has none without an IV or once expired', () => {
    expect(greeksAt(100, 100, 0.1, undefined, 'C')).toBeUndefined();
    expect(greeksAt(100, 100, 0, 0.2, 'C')).toBeUndefined();
  });
});

describe('exposureByStrike', () => {
  it('signs calls long and puts short for the dealers, in dollars per 1% move', () => {
    const [e] = exposureByStrike([row(100, 'C', 10)], 100, 1);
    const gamma = blackScholes(100, 100, 0.1, 0.25, 'C').gamma;
    expect(e.callGex).toBeCloseTo(10 * 100 * gamma * 100 * 100 * 0.01, 6);
    expect(e.gex).toBe(e.callGex);
    const [p] = exposureByStrike([row(100, 'P', 10)], 100, 1);
    expect(p.putGex).toBeCloseTo(-e.callGex, 6);
    // Short puts are long delta.
    expect(p.dex).toBeGreaterThan(0);
    // Flipped: dealers short the calls.
    expect(exposureByStrike([row(100, 'C', 10)], 100, -1)[0].callGex).toBeCloseTo(-e.callGex, 6);
  });

  it('falls back to IB gamma without an IV, sums per strike and counts the open interest change', () => {
    const rows = [row(100, 'C', 10, { sigma: undefined, gamma: 0.05, delta: 0.5, volume: 7 }), row(100, 'P', 5, { volume: 3 }), row(105, 'C', 4)];
    const prev = oiMap([
      { expiry: '20991218', strike: 100, right: 'C', multiplier: 100, oi: 6 },
      { expiry: '20991218', strike: 105, right: 'C', multiplier: 100, oi: 9 },
    ]);
    const by = exposureByStrike(rows, 100, 1, prev);
    expect(by.map((e) => e.strike)).toEqual([100, 105]);
    expect(by[0].callGex).toBeCloseTo(10 * 100 * 0.05 * 100, 6);
    expect(by[0]).toMatchObject({ callOi: 10, putOi: 5, callVol: 7, putVol: 3, callOiChg: 4 });
    expect(by[0].putOiChg).toBeUndefined();
    expect(by[1].callOiChg).toBe(-5);
    expect(totals(by)).toMatchObject({ callOi: 14, putOi: 5, callOiChg: -1 });
  });
});

describe('gamma profile and levels', () => {
  it('finds the zero-gamma crossing nearest the price', () => {
    expect(
      zeroGamma(
        [
          { x: 90, gex: -2 },
          { x: 100, gex: 2 },
          { x: 110, gex: 4 },
        ],
        105,
      ),
    ).toBeCloseTo(95, 10);
    expect(zeroGamma([{ x: 90, gex: 1 }, { x: 100, gex: 2 }], 95)).toBeUndefined();
  });

  it('turns from negative below the puts to positive above them toward the calls', () => {
    const rows = [row(90, 'P', 500), row(110, 'C', 500)];
    const prof = gexProfile(rows, 1, 70, 130, 61);
    expect(prof[0].gex).toBeLessThan(0);
    expect(prof[prof.length - 1].gex).toBeGreaterThan(0);
    const z = zeroGamma(prof, 100)!;
    expect(z).toBeGreaterThan(90);
    expect(z).toBeLessThan(110);
  });

  it('picks the call and put walls by size', () => {
    const by = exposureByStrike([row(95, 'P', 100), row(90, 'P', 900), row(105, 'C', 800), row(110, 'C', 50)], 100, 1);
    expect(walls(by)).toEqual({ call: 105, put: 90 });
    expect(walls([])).toEqual({ call: undefined, put: undefined });
  });

  it('puts max pain where holders are paid least', () => {
    const rows: PositioningRow[] = [
      { expiry: 'x', strike: 90, right: 'P', multiplier: 100, oi: 100 },
      { expiry: 'x', strike: 100, right: 'C', multiplier: 100, oi: 10 },
      { expiry: 'x', strike: 100, right: 'P', multiplier: 100, oi: 10 },
      { expiry: 'x', strike: 110, right: 'C', multiplier: 100, oi: 100 },
    ];
    expect(maxPain(rows)?.strike).toBe(100);
    expect(maxPain([])).toBeUndefined();
  });
});

describe('scan list and scope', () => {
  const exp = (expiry: string, strikes: number[]): ChainExpiry => ({ expiry, tradingClass: 'X', multiplier: 100, exchange: 'SMART', strikes });

  it('keeps whole expiries within the cap and trims the rest', () => {
    const list = [exp('20991201', [90, 95, 100, 105, 110, 200]), exp('20991208', [95, 100, 105]), exp('20991215', [100])];
    const r = scanContracts('X', list, 100, 90, 110, 14);
    // 10 + 6 is over 14: the second expiry is left out, the third (2) still fits.
    expect(r.contracts).toHaveLength(12);
    expect(r.trimmed).toBe(1);
    expect(r.contracts[0]).toMatchObject({ symbol: 'X', secType: 'OPT', lastTradeDate: '20991201', strike: 90, right: 'C', tradingClass: 'X', multiplier: 100 });
    expect(r.contracts.slice(-2).map((c) => c.lastTradeDate)).toEqual(['20991215', '20991215']);
    // A first expiry over the cap keeps its strikes nearest the price.
    const small = scanContracts('X', list, 100, 90, 110, 4);
    expect(small.contracts.map((c) => `${c.strike}${c.right}`)).toEqual(['95C', '95P', '100C', '100P']);
    expect(small.trimmed).toBe(2);
  });

  it('chooses the selected expiry or those within the days', () => {
    const now = new Date(Date.UTC(2099, 11, 1, 15));
    const all = [{ expiry: '20991203' }, { expiry: '20991210' }, { expiry: '20991231' }];
    expect(scopeExpiries(all, 'sel', '20991210', now).map((e) => e.expiry)).toEqual(['20991210']);
    expect(scopeExpiries(all, 7, undefined, now).map((e) => e.expiry)).toEqual(['20991203']);
    expect(scopeExpiries(all, 30, undefined, now).map((e) => e.expiry)).toEqual(['20991203', '20991210', '20991231']);
    expect(scopeExpiries([{ expiry: '20991231' }], 7, undefined, now).map((e) => e.expiry)).toEqual(['20991231']);
  });
});

describe('prepare, unusual volume and day levels', () => {
  it('fills a missing IV from its expiry smile and filters by expiry and strike', () => {
    const rows: PositioningRow[] = [
      { expiry: '20991218', strike: 90, right: 'P', multiplier: 100, oi: 1, iv: 0.3 },
      { expiry: '20991218', strike: 100, right: 'C', multiplier: 100, oi: 1 },
      { expiry: '20991218', strike: 110, right: 'C', multiplier: 100, oi: 1, iv: 0.2 },
      { expiry: '20991225', strike: 100, right: 'C', multiplier: 100, oi: 1, iv: 0.5 },
    ];
    const p = prepare(rows, Date.UTC(2099, 11, 1), { expiries: new Set(['20991218']), lo: 85, hi: 115 });
    expect(p).toHaveLength(3);
    expect(p[1].sigma).toBeCloseTo(0.25, 10);
    expect(p[0].t).toBeGreaterThan(0);
  });

  it('lists options traded beyond their open interest', () => {
    const rows: PositioningRow[] = [
      { expiry: 'a', strike: 1, right: 'C', multiplier: 100, oi: 100, volume: 500 },
      { expiry: 'a', strike: 2, right: 'P', multiplier: 100, oi: 0, volume: 150 },
      { expiry: 'a', strike: 3, right: 'C', multiplier: 100, oi: 1000, volume: 500 },
      { expiry: 'a', strike: 4, right: 'C', multiplier: 100, oi: 10, volume: 50 },
    ];
    expect(unusualVolume(rows).map((u) => u.strike)).toEqual([2, 1]);
  });

  it('reads a stored day with the same rules', () => {
    const snap: PositioningSnapshot = {
      underlying: 'STK:X',
      day: '20991201',
      updatedAt: Date.UTC(2099, 11, 1, 18),
      spot: 100,
      rows: [
        { expiry: '20991218', strike: 90, right: 'P', multiplier: 100, oi: 900, iv: 0.3 },
        { expiry: '20991218', strike: 100, right: 'P', multiplier: 100, oi: 100, iv: 0.25 },
        { expiry: '20991218', strike: 100, right: 'C', multiplier: 100, oi: 100, iv: 0.25 },
        { expiry: '20991218', strike: 110, right: 'C', multiplier: 100, oi: 700, iv: 0.22 },
      ],
    };
    const l = dayLevels(snap, 30, 0.2, 1);
    expect(l).toMatchObject({ day: '20991201', spot: 100, callWall: 110, putWall: 90, maxPain: 100 });
    expect(l.zeroGamma).toBeDefined();
    expect(dayLevels({ ...snap, spot: undefined }, 30, 0.2, 1)).toEqual({ day: '20991201', gex: 0 });
  });
});
