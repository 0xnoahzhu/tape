// Earnings dates from IB's market scanner: the windows, the search against an in-memory
// universe (IB's SCAN_nextEarningsDateTime_ASC: price band, epoch window, soonest first, at most
// 50 rows) and the service against the IB test double. The release instants are the ones the
// read-only probe of the paper account saw (AAPL 2026-10-29 16:00, VST 2026-11-06 09:30, CAT
// 08:30).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractKey, stock } from '@shared/contract';
import type { ContractRef, Position, Quote } from '@shared/types';
import {
  BudgetError,
  createEarningsScanner,
  dayWindow,
  locate,
  makeProbe,
  parseRetrieved,
  priceBand,
  RETRY_MS,
  SCAN_CODE,
  SCAN_TIMEOUT_MS,
  searchEarnings,
  slotWindow,
  type Probe,
  type ScanQuery,
  type ScanResult,
  type Window,
} from './earningsScanner';
import { createFakeContext, createFakeIb, fakeScanner, settle, type ScannerListing } from './fakeIb';
import { addDays, nyDay, nyWallToEpochMs, parseYyyymmdd, yyyymmdd, type CalendarDay } from './nyTime';

const TODAY = parseYyyymmdd('20261006');
const at = (day: CalendarDay, minutes: number) => nyWallToEpochMs(day, minutes) / 1000;
const inDays = (n: number, minutes: number, from = TODAY) => at(addDays(from, n), minutes);

const AAPL_AT = 1793304000; // 2026-10-29 16:00 EDT
const VST_AT = 1793975400; // 2026-11-06 09:30 EST
const CAT_AT = 1793277000; // 2026-10-29 08:30 EDT

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('scan windows', () => {
  it('are New York days and half-hour slots in epoch seconds, inclusive', () => {
    const oct29 = parseYyyymmdd('20261029');
    expect(dayWindow(oct29, 0, 0)).toEqual([1793246400, 1793332799]);
    expect(slotWindow(oct29, 17, 17)[0]).toBe(1793277000); // 08:30
    expect(slotWindow(oct29, 19, 19)[0]).toBe(1793280600); // 09:30
    expect(slotWindow(oct29, 32, 32)[0]).toBe(1793304000); // 16:00
    expect(slotWindow(oct29, 0, 47)).toEqual(dayWindow(oct29, 0, 0));
    // The 25-hour day DST ends on, then winter time.
    expect(dayWindow(parseYyyymmdd('20261101'), 0, 0)).toEqual([1793505600, 1793595599]);
    expect(slotWindow(parseYyyymmdd('20261106'), 19, 19)[0]).toBe(1793975400);
    expect(slotWindow(parseYyyymmdd('20261117'), 32, 32)[0]).toBe(1794949200);
    // The whole horizon: today to today + 120 (2027-02-03).
    expect(dayWindow(TODAY, 0, 120)).toEqual([1791259200, 1801717199]);
  });

  it('reads IB’s item counts', () => {
    expect(parseRetrieved('Historical Market Data Service query message:3 items retrieved')).toEqual({ count: 3 });
    expect(parseRetrieved(':3 items retrieved')).toEqual({ count: 3 });
    expect(parseRetrieved('Historical Market Data Service query message:50 out of 435 items retrieved')).toEqual({ count: 50, total: 435 });
    expect(parseRetrieved('Historical Market Data Service query message:no items retrieved')).toEqual({ count: 0 });
    expect(parseRetrieved('Historical Market Data Service error message:API scanner subscription cancelled: 600')).toBeUndefined();
  });

  it('rounds the price band outward to cents', () => {
    expect(priceBand([140, 150], 0.03)).toEqual({ minPrice: 135.8, maxPrice: 154.5 });
    expect(priceBand([227.48], 0.03)).toEqual({ minPrice: 220.65, maxPrice: 234.31 });
    expect(priceBand([227.48, 226.9], 0.0075)).toEqual({ minPrice: 225.19, maxPrice: 229.19 });
  });
});

describe('locate', () => {
  /** A probe over cells: the window (i, j) is [i, j]. */
  const cells = (present: (a: number, b: number) => boolean, truncated: (a: number, b: number) => boolean = () => false) => {
    const asked: Window[] = [];
    const probe: Probe = async (a, b) => {
      asked.push([a, b]);
      const p = present(a, b);
      return { present: p, truncated: !p && truncated(a, b) };
    };
    return { probe, asked };
  };
  const win = (i: number, j: number): Window => [i, j];
  const holds = (t: number) => (a: number, b: number) => a <= t && t <= b;

  it('finds the cell by bisection, a half known from the other costing nothing', async () => {
    const { probe, asked } = cells(holds(5));
    expect(await locate(8, win, probe, false)).toBe(5);
    expect(asked).toEqual([
      [0, 7],
      [0, 3],
      [4, 5],
      [4, 4],
    ]);
  });

  it('answers none after one scan, and does not ask a range already known', async () => {
    const none = cells(() => false);
    expect(await locate(121, win, none.probe, false)).toBe('none');
    expect(none.asked).toHaveLength(1);
    const known = cells(holds(2));
    expect(await locate(4, win, known.probe, true)).toBe(2);
    expect(known.asked).toEqual([
      [0, 1],
      [2, 2],
    ]);
  });

  it('splits a cut answer into both halves', async () => {
    // Windows wider than 2 cells are cut without the target; narrower ones are complete.
    const { probe, asked } = cells(
      (a, b) => b - a < 2 && holds(6)(a, b),
      (a, b) => b - a >= 2,
    );
    expect(await locate(8, win, probe, false)).toBe(6);
    expect(asked[0]).toEqual([0, 7]);
  });

  it('answers unknown for a cut single cell, never a wrong one', async () => {
    const { probe } = cells(
      () => false,
      (a, b) => a <= 3 && 3 <= b,
    );
    expect(await locate(8, win, probe, false)).toBe('unknown');
    const known = cells(() => false, (a, b) => a <= 3 && 3 <= b);
    expect(await locate(8, win, known.probe, true)).toBe('unknown');
  });
});

describe('searchEarnings', () => {
  /** IB's scan over listings: price band, window, soonest first (ties by conId), 50 rows. */
  const universe =
    (listings: ScannerListing[]) =>
    async (q: ScanQuery): Promise<ScanResult> => {
      const hits = listings
        .filter((l) => l.price >= q.minPrice && l.price <= q.maxPrice && l.at >= q.above && l.at <= q.below)
        .sort((a, b) => a.at - b.at || a.conId - b.conId);
      return { rows: hits.slice(0, 50).map((l) => ({ conId: l.conId, symbol: l.symbol })), truncated: hits.length > 50 };
    };
  /** Other stocks: various prices and dates (some on the target days). */
  const others: ScannerListing[] = Array.from({ length: 300 }, (_, i) => ({
    conId: 10_000 + i,
    symbol: `S${i}`,
    at: inDays(i % 121, [570, 960, 480, 720][i % 4]),
    price: 20 + ((i * 37) % 400),
  }));
  const run = async (listings: ScannerListing[], conId: number, prices: number[], budget?: number) => {
    const probe = makeProbe(universe(listings), conId, prices, budget);
    return { res: await searchEarnings(TODAY, probe), scans: probe.scans };
  };
  const listing = (at: number, price = 150, conId = 1): ScannerListing => ({ conId, symbol: 'T', at, price });

  it('finds an after-close release (16:00:00 ET) in 9 scans', async () => {
    const { res, scans } = await run([...others, listing(AAPL_AT, 227.48, 265598)], 265598, [227.48, 226.9]);
    expect(res).toEqual({ kind: 'found', date: '20261029', time: 'amc' });
    expect(scans).toBeLessThanOrEqual(9);
  });

  it('finds a pre-open release (09:30:00 ET) in 10 scans', async () => {
    const { res, scans } = await run([...others, listing(VST_AT, 151.2, 254457731)], 254457731, [151.2]);
    expect(res).toEqual({ kind: 'found', date: '20261106', time: 'bmo' });
    expect(scans).toBeLessThanOrEqual(10);
  });

  it('pins a release at the start of a half hour (08:30) in 19 scans', async () => {
    const { res, scans } = await run([...others, listing(CAT_AT, 380)], 1, [380]);
    expect(res).toEqual({ kind: 'found', date: '20261029', time: 'bmo', minutes: 510 });
    expect(scans).toBeLessThanOrEqual(19);
  });

  it('gives a date stamped midnight (no time) without a time, in 11 scans', async () => {
    const { res, scans } = await run([...others, listing(at(parseYyyymmdd('20261110'), 0))], 1, [150]);
    expect(res).toEqual({ kind: 'found', date: '20261110' });
    expect(scans).toBeLessThanOrEqual(11);
    // Shortly after midnight is a time before the open, not an exact one.
    expect((await run([listing(at(parseYyyymmdd('20261110'), 10))], 1, [150])).res).toEqual({ kind: 'found', date: '20261110', time: 'bmo' });
  });

  it('classifies other times by their slot', async () => {
    expect((await run([listing(at(parseYyyymmdd('20261029'), 660))], 1, [150])).res).toEqual({ kind: 'found', date: '20261029', time: 'dmh', minutes: 660 });
    // 17:15: the slot 17:00–17:30 is after the close; 17:00 itself is not the time.
    expect((await run([listing(at(parseYyyymmdd('20261029'), 1035))], 1, [150])).res).toEqual({ kind: 'found', date: '20261029', time: 'amc' });
    expect((await run([listing(at(parseYyyymmdd('20261029'), 425))], 1, [150])).res).toEqual({ kind: 'found', date: '20261029', time: 'bmo' });
  });

  it('answers none after one scan beyond the horizon or for a stock never listed', async () => {
    expect(await run([...others, listing(inDays(150, 960))], 1, [150])).toEqual({ res: { kind: 'none' }, scans: 1 });
    expect(await run(others, 99, [420])).toEqual({ res: { kind: 'none' }, scans: 1 });
  });

  it('narrows the band, then splits windows, when answers are cut', async () => {
    // 200 stocks at the same price, one every 0.6 days, all before the target.
    const crowd = Array.from({ length: 200 }, (_, i) => listing(inDays(Math.floor(i * 0.6), 720), 150, 100 + i));
    const { res, scans } = await run([...crowd, listing(inDays(110, 960), 150, 7)], 7, [150]);
    expect(res).toEqual({ kind: 'found', date: yyyymmdd(addDays(TODAY, 110)), time: 'amc' });
    expect(scans).toBeLessThanOrEqual(24);
  });

  it('answers unknown, never a wrong date, when the target’s own instant is crowded', async () => {
    const crowd = Array.from({ length: 60 }, (_, i) => listing(AAPL_AT, 150, 100 + i));
    expect((await run([...crowd, listing(AAPL_AT, 150, 999)], 999, [150])).res).toEqual({ kind: 'unknown' });
  });

  it('answers unknown when the price leaves the band during the search', async () => {
    const target = listing(AAPL_AT, 150, 7);
    let scans = 0;
    const scan = universe([...others, target]);
    const probe = makeProbe(
      async (q) => {
        if (++scans > 2) target.price = 190;
        return scan(q);
      },
      7,
      [150],
    );
    expect(await searchEarnings(TODAY, probe)).toEqual({ kind: 'unknown' });
  });

  it('stops at the budget: unknown before the day is confirmed, the date without a time after', async () => {
    expect((await run([listing(CAT_AT)], 1, [150], 5)).res).toEqual({ kind: 'unknown' });
    expect((await run([listing(CAT_AT)], 1, [150], 12)).res).toEqual({ kind: 'found', date: '20261029' });
    const probe = makeProbe(universe([]), 1, [150], 0);
    await expect(probe(0, 1)).rejects.toBeInstanceOf(BudgetError);
  });

  it('reads the prices again for every scan, and says when the band was narrowed', async () => {
    const asked: ScanQuery[] = [];
    let price = 150;
    const probe = makeProbe(
      async (q) => {
        asked.push(q);
        return { rows: [], truncated: asked.length === 2 };
      },
      1,
      () => [price],
    );
    await probe(0, 1);
    expect(probe.narrowed).toBe(false);
    price = 160;
    await probe(0, 1);
    expect(asked.map((q) => q.minPrice)).toEqual([145.5, 155.2, 157.6]);
    expect(probe.narrowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Service

const today = yyyymmdd(nyDay(Date.now()));
const day0 = parseYyyymmdd(today);

const AAPL: ContractRef = { ...stock('AAPL'), conId: 265598 };
const NVDA: ContractRef = { ...stock('NVDA'), conId: 4815747 };
const META: ContractRef = stock('META');
const VST: ContractRef = stock('VST');
const TSLA: ContractRef = stock('TSLA');
const MSFT: ContractRef = stock('MSFT');
const SPY: ContractRef = stock('SPY');
const SHOP: ContractRef = { ...stock('SHOP'), currency: 'CAD' };

const MARKET: Record<string, { conId: number; price: number; at: number; stockType?: string }> = {
  AAPL: { conId: 265598, price: 227.48, at: at(addDays(day0, 23), 960) },
  NVDA: { conId: 4815747, price: 181.3, at: at(addDays(day0, 42), 960) },
  META: { conId: 107113386, price: 712.5, at: at(addDays(day0, 22), 960) },
  VST: { conId: 254457731, price: 151.2, at: at(addDays(day0, 31), 570) },
  TSLA: { conId: 76792991, price: 420.1, at: at(addDays(day0, 15), 1020) },
  MSFT: { conId: 272093, price: 515.9, at: at(addDays(day0, 24), 960) },
  SPY: { conId: 756733, price: 671, at: 0, stockType: 'ETF' },
};

function setupService(opts: { quotes?: boolean } = {}) {
  const fake = createFakeIb();
  const f = createFakeContext(fake.ib);
  const listings: ScannerListing[] = Object.entries(MARKET)
    .filter(([, m]) => m.at > 0)
    .map(([symbol, m]) => ({ symbol, conId: m.conId, at: m.at, price: m.price }));
  // Neighbours: other stocks around the same prices, a few days apart.
  for (let i = 0; i < 40; i++) listings.push({ conId: 50_000 + i, symbol: `N${i}`, at: at(addDays(day0, (i * 3) % 120), 960), price: 150 + i * 15 });
  const scanner = fakeScanner(fake, listings);
  const infoCalls: string[] = [];
  f.ctx.contracts = {
    getInfo: async (c: ContractRef) => {
      infoCalls.push(c.symbol);
      const m = MARKET[c.symbol];
      return m ? { contract: { ...c, conId: m.conId }, longName: c.symbol, minTick: 0.01, stockType: m.stockType ?? 'COMMON' } : null;
    },
  } as unknown as typeof f.ctx.contracts;
  const quotes = new Map<string, Quote>();
  if (opts.quotes !== false) for (const [symbol, m] of Object.entries(MARKET)) quotes.set(`STK:${symbol}`, { key: `STK:${symbol}`, last: m.price, updatedAt: 0 });
  const quoteListeners = new Set<(q: Quote) => void>();
  f.ctx.quotes = {
    getQuote: (key: string) => quotes.get(key),
    onQuote: (l: (q: Quote) => void) => {
      quoteListeners.add(l);
      return () => void quoteListeners.delete(l);
    },
  } as unknown as typeof f.ctx.quotes;
  const positions: Position[] = [];
  f.ctx.account = { getPositions: () => positions, getSummary: () => null };
  const svc = createEarningsScanner(f.ctx);
  const publish = (q: Quote) => {
    quotes.set(q.key, q);
    for (const l of [...quoteListeners]) l(q);
  };
  /** Looks up until no search is running. */
  const settled = async (stocks: ContractRef[]) => {
    for (let i = 0; i < 2000; i++) {
      const r = svc.lookup(stocks, today);
      if (!r.pending) return r;
      await wait(2);
    }
    throw new Error('searches did not end');
  };
  return { fake, svc, scanner, listings, infoCalls, positions, publish, settled };
}

const event = (c: ContractRef, n: number, time: 'amc' | 'bmo' | 'dmh', minutes?: number) => ({
  key: contractKey(c),
  date: yyyymmdd(addDays(day0, n)),
  time,
  ...(minutes !== undefined ? { minutes } : {}),
  estimated: true,
});

describe('EarningsScanner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('looks dates up in the background, at most 3 scans at a time, each one cancelled', async () => {
    const { fake, svc, scanner, settled } = setupService();
    await settle();
    fake.ready();
    const stocks = [AAPL, NVDA, META, VST, TSLA];
    expect(svc.lookup(stocks, today)).toEqual({ events: [], pending: true, refused: false, answered: 0, uncovered: 0 });
    const res = await settled(stocks);
    expect(res).toEqual({
      events: [event(AAPL, 23, 'amc'), event(NVDA, 42, 'amc'), event(META, 22, 'amc'), event(VST, 31, 'bmo'), event(TSLA, 15, 'amc', 1020)],
      pending: false,
      refused: false,
      answered: 5,
      uncovered: 0,
    });
    expect(scanner.most).toBeLessThanOrEqual(3);
    expect(scanner.most).toBeGreaterThanOrEqual(2);
    expect(scanner.open.size).toBe(0);
    const byId = (a: number, b: number) => a - b;
    expect([...scanner.cancelled].sort(byId)).toEqual(scanner.requests.map((r) => r.reqId).sort(byId));
    for (const { sub, filter } of scanner.requests) {
      expect(sub).toMatchObject({ numberOfRows: 50, instrument: 'STK', locationCode: 'STK.US.MAJOR', scanCode: SCAN_CODE, stockTypeFilter: 'ALL' });
      expect(filter.map((t) => t.tag)).toEqual(['nextEarningsDateTimeAbove', 'nextEarningsDateTimeBelow']);
      for (const t of filter) expect(t.value).toMatch(/^\d{10}$/);
    }
  });

  it('keeps answers for the day and searches only new holdings', async () => {
    const { fake, svc, scanner, infoCalls, settled } = setupService();
    await settle();
    fake.ready();
    await settled([AAPL, NVDA]);
    const sent = scanner.requests.length;
    expect(svc.lookup([AAPL, NVDA], today).pending).toBe(false);
    expect(scanner.requests).toHaveLength(sent);
    const res = await settled([AAPL, NVDA, MSFT]);
    expect(res.events.map((e) => e.key)).toEqual([contractKey(AAPL), contractKey(NVDA), contractKey(MSFT)]);
    // The new scans are MSFT's (its price band) and its contract was the only one looked up again.
    for (const r of scanner.requests.slice(sent)) expect(r.sub.abovePrice! < 515.9 && r.sub.belowPrice! > 515.9).toBe(true);
    expect(infoCalls).toEqual(['AAPL', 'NVDA', 'MSFT']);
  });

  it('reads a cut answer from IB’s 165 and narrows the price band', async () => {
    const { fake, svc, scanner, listings, settled } = setupService();
    // 60 stocks 2 % above AAPL, all reporting before it: the first answer is cut without AAPL.
    for (let i = 0; i < 60; i++) listings.push({ conId: 60_000 + i, symbol: `C${i}`, at: at(addDays(day0, i % 20), 960), price: 232 });
    await settle();
    fake.ready();
    const res = await settled([AAPL]);
    expect(res.events).toEqual([event(AAPL, 23, 'amc')]);
    const [first, second] = scanner.requests;
    expect(second.filter).toEqual(first.filter);
    expect(second.sub.belowPrice!).toBeLessThan(first.sub.belowPrice!);
    expect(svc.lookup([AAPL], today).events).toEqual(res.events);
  });

  it('counts 50 rows as cut when IB sends no item count', async () => {
    const { fake, scanner, listings, settled } = setupService();
    for (let i = 0; i < 60; i++) listings.push({ conId: 60_000 + i, symbol: `C${i}`, at: at(addDays(day0, i % 20), 960), price: 232 });
    scanner.answer = (reqId, rows) =>
      setTimeout(() => {
        rows.forEach((l, rank) => fake.emit('scannerData', reqId, rank, { contract: { conId: l.conId, symbol: l.symbol } }, '', '', '', ''));
        fake.emit('scannerDataEnd', reqId);
      }, 1);
    await settle();
    fake.ready();
    expect((await settled([AAPL])).events).toEqual([event(AAPL, 23, 'amc')]);
    expect(scanner.requests[1].sub.belowPrice!).toBeLessThan(scanner.requests[0].sub.belowPrice!);
  });

  it('ignores rows that arrive after the cancel', async () => {
    const { fake, svc, scanner, settled } = setupService();
    await settle();
    fake.ready();
    const res = await settled([AAPL]);
    const first = scanner.requests[0].reqId;
    fake.emit('scannerData', first, 0, { contract: { conId: 1, symbol: 'X' } }, '', '', '', '');
    fake.emit('scannerDataEnd', first);
    fake.error(first, 162, 'Historical Market Data Service error message:API scanner subscription cancelled: ' + first);
    expect(svc.lookup([AAPL], today)).toEqual(res);
  });

  it('stops for the day when IB refuses the scanner, until a new connection', async () => {
    const { fake, svc, scanner, settled } = setupService();
    const answer = scanner.answer;
    scanner.answer = (reqId) => setTimeout(() => fake.error(reqId, 162, 'Historical Market Data Service error message:Scanner filter usdMarketCapAbove is disabled.'), 1);
    await settle();
    fake.ready();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await settled([AAPL, NVDA, META, VST])).toEqual({ events: [], pending: false, refused: true, answered: 0, uncovered: 0 });
      // Searches waiting for a slot did not scan; nothing is asked again today.
      expect(scanner.requests.length).toBeLessThanOrEqual(3);
      const sent = scanner.requests.length;
      expect(svc.lookup([AAPL, MSFT], today)).toEqual({ events: [], pending: false, refused: true, answered: 0, uncovered: 0 });
      expect(scanner.requests).toHaveLength(sent);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    fake.close();
    fake.ready();
    scanner.answer = answer;
    expect((await settled([AAPL])).events).toEqual([event(AAPL, 23, 'amc')]);
  });

  it('cancels a scan IB does not answer, shows nothing and says when it tries again (5 minutes)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
    const { fake, svc, scanner } = setupService();
    scanner.answer = () => undefined;
    await settle();
    fake.ready();
    expect(svc.lookup([AAPL], today).pending).toBe(true);
    await settle();
    expect(scanner.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS);
    expect(scanner.cancelled).toEqual([scanner.requests[0].reqId]);
    expect(svc.lookup([AAPL], today)).toEqual({ events: [], pending: false, refused: false, answered: 0, uncovered: 0, retryInMs: RETRY_MS });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(svc.lookup([AAPL], today).retryInMs).toBe(RETRY_MS - 60_000);
    await vi.advanceTimersByTimeAsync(RETRY_MS - 60_000);
    expect(svc.lookup([AAPL], today).pending).toBe(true);
    await settle();
    expect(scanner.requests).toHaveLength(2);
  });

  it('keeps nothing of a connection that closed', async () => {
    const { fake, svc, scanner, infoCalls, settled } = setupService();
    await settle();
    fake.ready();
    svc.lookup([AAPL, NVDA], today);
    await wait(5);
    fake.close();
    await settle();
    // Not connected: nothing runs and nothing is started.
    expect(svc.lookup([AAPL, NVDA], today)).toEqual({ events: [], pending: false, refused: false, answered: 0, uncovered: 0 });
    fake.ready();
    const res = await settled([AAPL, NVDA]);
    expect(res.events).toEqual([event(AAPL, 23, 'amc'), event(NVDA, 42, 'amc')]);
    // A new connection searches again.
    fake.close();
    fake.ready();
    expect(svc.lookup([AAPL], today).pending).toBe(true);
    await settled([AAPL]);
    expect(infoCalls.filter((s) => s === 'AAPL')).toHaveLength(3);
    expect(scanner.open.size).toBe(0);
  });

  it('answers ETFs without scanning, and counts non-USD stocks apart (not covered)', async () => {
    const { fake, svc, scanner, infoCalls, settled } = setupService();
    await settle();
    fake.ready();
    expect(svc.lookup([SHOP], today)).toEqual({ events: [], pending: false, refused: false, answered: 0, uncovered: 1 });
    expect(infoCalls).toEqual([]);
    expect(await settled([SPY, SHOP])).toEqual({ events: [], pending: false, refused: false, answered: 1, uncovered: 1 });
    expect(scanner.requests).toHaveLength(0);
  });

  it('asks a none found with a narrowed band once more, with the prices of then', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
    const { fake, svc, scanner, listings, publish } = setupService();
    // IB prices AAPL 2 % above Tape's quote, and 60 stocks 2.4 % below it report first: the first
    // answer is cut, and the narrowed band no longer reaches AAPL.
    listings.find((l) => l.symbol === 'AAPL')!.price = 232.03;
    for (let i = 0; i < 60; i++) listings.push({ conId: 60_000 + i, symbol: `C${i}`, at: at(addDays(day0, i % 20), 960), price: 222 });
    const settledFake = async (stocks: ContractRef[]) => {
      for (let i = 0; i < 1000; i++) {
        const r = svc.lookup(stocks, today);
        if (!r.pending) return r;
        await vi.advanceTimersByTimeAsync(5);
      }
      throw new Error('searches did not end');
    };
    await settle();
    fake.ready();
    const first = await settledFake([AAPL]);
    expect(first).toMatchObject({ events: [], answered: 0 });
    expect(first.retryInMs).toBeGreaterThan(RETRY_MS - 1000);
    const sent = scanner.requests.length;
    // Not asked again before then.
    expect(svc.lookup([AAPL], today).pending).toBe(false);
    expect(scanner.requests).toHaveLength(sent);
    publish({ key: contractKey(AAPL), last: 232.03, updatedAt: 1 });
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect((await settledFake([AAPL])).events).toEqual([event(AAPL, 23, 'amc')]);
    for (const r of scanner.requests.slice(sent)) expect(r.sub.belowPrice!).toBeGreaterThan(232.03);
  });

  it('keeps a none found with a narrowed band the second time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
    const { fake, svc, scanner, listings } = setupService();
    listings.find((l) => l.symbol === 'AAPL')!.price = 232.03;
    for (let i = 0; i < 60; i++) listings.push({ conId: 60_000 + i, symbol: `C${i}`, at: at(addDays(day0, i % 20), 960), price: 222 });
    const settledFake = async (stocks: ContractRef[]) => {
      for (let i = 0; i < 1000; i++) {
        const r = svc.lookup(stocks, today);
        if (!r.pending) return r;
        await vi.advanceTimersByTimeAsync(5);
      }
      throw new Error('searches did not end');
    };
    await settle();
    fake.ready();
    expect((await settledFake([AAPL])).retryInMs).toBeDefined();
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(await settledFake([AAPL])).toEqual({ events: [], pending: false, refused: false, answered: 1, uncovered: 0 });
    const sent = scanner.requests.length;
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(svc.lookup([AAPL], today)).toEqual({ events: [], pending: false, refused: false, answered: 1, uncovered: 0 });
    expect(scanner.requests).toHaveLength(sent);
  });

  it('waits for a price before scanning', async () => {
    const { fake, svc, scanner, publish, settled } = setupService({ quotes: false });
    await settle();
    fake.ready();
    expect(svc.lookup([AAPL], today).pending).toBe(true);
    await wait(5);
    expect(scanner.requests).toHaveLength(0);
    publish({ key: contractKey(AAPL), last: 227.48, updatedAt: 1 });
    expect((await settled([AAPL])).events).toEqual([event(AAPL, 23, 'amc')]);
  });

  it('takes the position’s price, and sends no scans without any price within 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
    const { fake, svc, scanner, positions } = setupService({ quotes: false });
    await settle();
    fake.ready();
    expect(svc.lookup([AAPL], today).pending).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(svc.lookup([AAPL], today)).toEqual({ events: [], pending: false, refused: false, answered: 0, uncovered: 0, retryInMs: RETRY_MS });
    expect(scanner.requests).toHaveLength(0);
    positions.push({ account: 'U1', key: contractKey(NVDA), contract: NVDA, quantity: 10, avgPrice: 100, multiplier: 1, marketPrice: 181.3, updatedAt: 0 });
    expect(svc.lookup([NVDA], today).pending).toBe(true);
    await settle();
    expect(scanner.requests.length).toBeGreaterThan(0);
  });
});
