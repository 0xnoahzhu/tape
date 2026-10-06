// Wall Street Horizon earnings, and the market scanner fallback, against the IB test double.
// The event JSON shapes below are assumptions (IB documents them only by example and the paper
// account has no WSH subscription); the 10276 refusal is what the paper account answered.

import { describe, expect, it, vi } from 'vitest';
import { contractKey, stock } from '@shared/contract';
import type { ContractRef, CorporateEarnings, Quote } from '@shared/types';
import { createCorporateEventsService, parseWshEarnings, wshDate, wshTimeOfDay } from './corporateEvents';
import { RETRY_MS, SCAN_TIMEOUT_MS } from './earningsScanner';
import { createFakeContext, createFakeIb, fakeScanner, settle, type FakeIb, type FakeScanner } from './fakeIb';
import { addDays, nyDay, nyWallToEpochMs, RTH_CLOSE, RTH_OPEN, yyyymmdd } from './nyTime';

const today = yyyymmdd(nyDay(Date.now()));
const inDays = (n: number) => yyyymmdd(addDays(nyDay(Date.now()), n));
const dashed = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`;
/** Epoch seconds of a New York time `n` days from today. */
const nyAt = (n: number, minutes: number) => nyWallToEpochMs(addDays(nyDay(Date.now()), n), minutes) / 1000;

const AAPL: ContractRef = { ...stock('AAPL'), conId: 265598 };
const NVDA: ContractRef = { ...stock('NVDA'), conId: 4815747 };

/** What the fake scanner lists and the quotes the scanner's price band comes from. */
const MARKET: Record<string, { conId: number; price: number; at: number }> = {
  AAPL: { conId: 265598, price: 227.48, at: nyAt(23, RTH_CLOSE) },
  NVDA: { conId: 4815747, price: 181.3, at: nyAt(42, RTH_OPEN) },
};

function setup(demo = false) {
  const fake = createFakeIb();
  const f = createFakeContext(fake.ib, demo);
  const resolved: string[] = [];
  f.ctx.contracts = {
    resolve: async (c: ContractRef) => {
      resolved.push(c.symbol);
      return { ...c, conId: c.symbol === 'META' ? 107113386 : 1 };
    },
    getInfo: async (c: ContractRef) => {
      const m = MARKET[c.symbol];
      return m ? { contract: { ...c, conId: m.conId }, longName: c.symbol, minTick: 0.01, stockType: 'COMMON' } : null;
    },
  } as unknown as typeof f.ctx.contracts;
  f.ctx.quotes = {
    getQuote: (key: string): Quote | undefined => {
      const m = MARKET[key.replace('STK:', '')];
      return m && { key, last: m.price, updatedAt: 0 };
    },
    onQuote: () => () => undefined,
  } as unknown as typeof f.ctx.quotes;
  f.ctx.account = { getPositions: () => [], getSummary: () => null };
  const scanner = fakeScanner(
    fake,
    Object.entries(MARKET).map(([symbol, m]) => ({ symbol, ...m })),
  );
  const svc = createCorporateEventsService(f.ctx);
  /** Asks until the scanner's searches are done. */
  const settled = async (underlyings: ContractRef[]): Promise<CorporateEarnings> => {
    for (let i = 0; i < 2000; i++) {
      const res = await svc.getEarnings(underlyings);
      if (!res.pending) return res;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error('searches did not end');
  };
  return { fake, svc, resolved, scanner, settled, ...f };
}

/** Answers meta data at once and event data with `json(conId)`; scans go to the fake scanner. */
function answer(fake: FakeIb, scanner: FakeScanner, json: (conId: number) => string) {
  fake.onCall = (name, args) => {
    const id = args[0] as number;
    if (name === 'reqWshMetaData') queueMicrotask(() => fake.emit('wshMetaData', id, '{"meta_data":{}}'));
    if (name === 'reqWshEventData') queueMicrotask(() => fake.emit('wshEventData', id, json((args[1] as { conId: number }).conId)));
    scanner.handle(name, args);
  };
}

/** Refuses WSH (10276) on the meta data request, or on the event request for `conId`. */
function refuse(fake: FakeIb, scanner: FakeScanner, at: 'meta' | number) {
  fake.onCall = (name, args) => {
    const id = args[0] as number;
    if (name === 'reqWshMetaData') {
      if (at === 'meta') queueMicrotask(() => fake.error(id, 10276, 'News feed is not allowed'));
      else queueMicrotask(() => fake.emit('wshMetaData', id, '{}'));
    }
    if (name === 'reqWshEventData') {
      const conId = (args[1] as { conId: number }).conId;
      if (conId === at) queueMicrotask(() => fake.error(id, 10276, 'News feed is not allowed'));
      else queueMicrotask(() => fake.emit('wshEventData', id, JSON.stringify([{ event_type: 'wshe_ed', earnings_date: inDays(30) }])));
    }
    scanner.handle(name, args);
  };
}

const estimate = (c: ContractRef, n: number, time: 'amc' | 'bmo') => ({ key: contractKey(c), date: inDays(n), time, estimated: true });

describe('parseWshEarnings', () => {
  it('reads an array of typed events (assumed schema)', () => {
    const json = JSON.stringify([
      { conid: 265598, event_type: 'wshe_ed', data: { earnings_date: dashed(inDays(20)), time_of_day: 'AFTER_MARKET' } },
      { conid: 265598, event_type: 'wshe_div', data: { ex_date: dashed(inDays(5)) } },
      { conid: 265598, event_type: 'wshe_ed', data: { earnings_date: dashed(inDays(-3)) } },
    ]);
    expect(parseWshEarnings(json, 'K', today)).toEqual([{ key: 'K', date: inDays(20), time: 'amc' }]);
  });

  it('reads { events: [...] } and objects keyed by event type', () => {
    expect(parseWshEarnings(JSON.stringify({ events: [{ type: 'Earnings', date: inDays(3), time: 'BMO' }] }), 'K', today)).toEqual([
      { key: 'K', date: inDays(3), time: 'bmo' },
    ]);
    const keyed = { wshe_ed: [{ event_date: Number(inDays(9)) }], wshe_bod: [{ event_date: inDays(2) }] };
    expect(parseWshEarnings(JSON.stringify(keyed), 'K', today)).toEqual([{ key: 'K', date: inDays(9) }]);
  });

  it('keeps one event per date and needs an earnings type or an explicit earnings date', () => {
    const json = JSON.stringify([
      { event_type: 'wshe_ed', date: inDays(10) },
      { event_type: 'wshe_ed', date: inDays(10), time_of_day: 'During market hours' },
      { date: inDays(12) },
      { earnings_date: inDays(14) },
    ]);
    expect(parseWshEarnings(json, 'K', today)).toEqual([
      { key: 'K', date: inDays(10), time: 'dmh' },
      { key: 'K', date: inDays(14) },
    ]);
  });

  it('answers null for text that is not JSON and [] for an empty answer', () => {
    expect(parseWshEarnings('not json', 'K', today)).toBeNull();
    expect(parseWshEarnings('"text"', 'K', today)).toBeNull();
    expect(parseWshEarnings('[]', 'K', today)).toEqual([]);
    expect(parseWshEarnings('{}', 'K', today)).toEqual([]);
  });

  it('normalizes dates and times of day', () => {
    expect(wshDate('2026-10-29')).toBe('20261029');
    expect(wshDate('20261029')).toBe('20261029');
    expect(wshDate('2026-10-29T20:05:00Z')).toBe('20261029');
    expect(wshDate(20261029)).toBe('20261029');
    expect(wshDate('2026-13-01')).toBeUndefined();
    expect(wshDate('10/29/2026')).toBeUndefined();
    expect(wshTimeOfDay('BEFORE_MARKET')).toBe('bmo');
    expect(wshTimeOfDay('amc')).toBe('amc');
    expect(wshTimeOfDay('unspecified')).toBeUndefined();
  });
});

describe('CorporateEventsService', () => {
  it('is unavailable while not connected', async () => {
    const { svc, fake } = setup();
    await settle();
    expect(await svc.getEarnings([AAPL])).toEqual({ status: 'unavailable', events: [] });
    expect(fake.calls).toEqual([]);
  });

  it('asks for meta data once per connection, then events per conId, one at a time', async () => {
    const { svc, fake } = setup();
    await settle();
    fake.ready();
    let inFlight = 0;
    let most = 0;
    fake.onCall = (name, args) => {
      const id = args[0] as number;
      if (name === 'reqWshMetaData') queueMicrotask(() => fake.emit('wshMetaData', id, '{}'));
      if (name === 'reqWshEventData') {
        most = Math.max(most, ++inFlight);
        const conId = (args[1] as { conId: number }).conId;
        setTimeout(() => {
          inFlight--;
          fake.emit('wshEventData', id, JSON.stringify([{ event_type: 'wshe_ed', earnings_date: conId === AAPL.conId ? inDays(30) : inDays(8) }]));
        }, 5);
      }
    };
    const res = await svc.getEarnings([AAPL, NVDA, AAPL, { ...stock('SPX'), secType: 'IND' }]);
    expect(res).toEqual({
      status: 'ok',
      events: [
        { key: contractKey(NVDA), date: inDays(8) },
        { key: contractKey(AAPL), date: inDays(30) },
      ],
      source: 'wsh',
    });
    expect(most).toBe(1);
    expect(fake.callsOf('reqWshMetaData')).toHaveLength(1);
    const [first] = fake.callsOf('reqWshEventData');
    expect(first[1]).toEqual({ conId: AAPL.conId, startDate: today, endDate: inDays(90) });

    // Cached for the day: no more requests.
    await svc.getEarnings([AAPL]);
    expect(fake.callsOf('reqWshEventData')).toHaveLength(2);
    expect(fake.callsOf('reqWshMetaData')).toHaveLength(1);
  });

  it('resolves the conId of an underlying held only through options', async () => {
    const { svc, fake, resolved, scanner } = setup();
    await settle();
    fake.ready();
    answer(fake, scanner, () => '[]');
    expect(await svc.getEarnings([stock('META')])).toEqual({ status: 'ok', events: [], source: 'wsh' });
    expect(resolved).toEqual(['META']);
    expect((fake.callsOf('reqWshEventData')[0][1] as { conId: number }).conId).toBe(107113386);
  });

  it('falls back to the scanner after 10276, and asks WSH again on a new connection or New York day', async () => {
    const { svc, fake, scanner, settled } = setup();
    await settle();
    fake.ready();
    refuse(fake, scanner, 'meta');
    // The searches run in the background: nothing known yet.
    expect(await svc.getEarnings([AAPL, NVDA])).toEqual({ status: 'ok', events: [], source: 'scanner', pending: true });
    expect(await settled([AAPL, NVDA])).toEqual({ status: 'ok', events: [estimate(AAPL, 23, 'amc'), estimate(NVDA, 42, 'bmo')], source: 'scanner' });
    expect(fake.callsOf('reqWshMetaData')).toHaveLength(1);
    expect(fake.callsOf('reqWshEventData')).toHaveLength(0);
    expect(scanner.requests.length).toBeGreaterThan(0);

    // A new connection asks WSH again.
    fake.close();
    fake.ready();
    answer(fake, scanner, () => '[]');
    expect(await svc.getEarnings([AAPL])).toEqual({ status: 'ok', events: [], source: 'wsh' });
    expect(fake.callsOf('reqWshMetaData')).toHaveLength(2);

    // So does a new New York day on the same connection.
    fake.close();
    fake.ready();
    refuse(fake, scanner, 'meta');
    await settled([AAPL]);
    expect(fake.callsOf('reqWshMetaData')).toHaveLength(3);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 86_400_000 });
    try {
      await svc.getEarnings([AAPL]);
      expect(fake.callsOf('reqWshMetaData')).toHaveLength(4);
    } finally {
      fake.close(); // ends tomorrow's searches
      vi.useRealTimers();
    }
  });

  it('keeps the events WSH gave and sends the refused stock and the rest to the scanner', async () => {
    const { svc, fake, scanner, settled } = setup();
    await settle();
    fake.ready();
    refuse(fake, scanner, NVDA.conId!);
    const first = await svc.getEarnings([AAPL, NVDA]);
    expect(first).toEqual({ status: 'ok', events: [{ key: contractKey(AAPL), date: inDays(30) }], source: 'scanner', pending: true });
    expect(await settled([AAPL, NVDA])).toEqual({
      status: 'ok',
      events: [{ key: contractKey(AAPL), date: inDays(30) }, estimate(NVDA, 42, 'bmo')],
      source: 'scanner',
    });
    expect(fake.callsOf('reqWshEventData')).toHaveLength(2);
    // AAPL keeps its WSH answer for the day; nothing of it went to the scanner.
    for (const r of scanner.requests) expect(r.sub.belowPrice!).toBeLessThan(200);
  });

  it('keeps the WSH answer of an option-only underlying after a later refusal', async () => {
    const { svc, fake, scanner, settled } = setup();
    await settle();
    fake.ready();
    refuse(fake, scanner, NVDA.conId!);
    // META comes from an option position: no conId (resolved to 107113386 for WSH).
    const META = stock('META');
    const wshMeta = { key: contractKey(META), date: inDays(30) };
    expect((await svc.getEarnings([META, NVDA])).events).toEqual([wshMeta]);
    const res = await settled([META, NVDA]);
    expect(res).toEqual({ status: 'ok', events: [wshMeta, estimate(NVDA, 42, 'bmo')], source: 'scanner' });
    expect(fake.callsOf('reqWshEventData')).toHaveLength(2);
  });

  it('marks estimates partial when some stocks are not US dollar ones, and unsubscribed with only those', async () => {
    const { svc, fake, scanner, settled } = setup();
    await settle();
    fake.ready();
    refuse(fake, scanner, 'meta');
    const TENCENT: ContractRef = { symbol: '700', secType: 'STK', exchange: 'SEHK', currency: 'HKD' };
    expect(await settled([AAPL, TENCENT])).toEqual({ status: 'ok', events: [estimate(AAPL, 23, 'amc')], source: 'scanner', partial: true });
    expect(await svc.getEarnings([TENCENT])).toEqual({ status: 'unsubscribed', events: [] });
  });

  it('says when a stock that could not be searched is tried again', async () => {
    const { svc, fake, scanner } = setup();
    await settle();
    fake.ready();
    refuse(fake, scanner, 'meta');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
    try {
      scanner.answer = () => undefined;
      expect((await svc.getEarnings([AAPL])).pending).toBe(true);
      await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS);
      expect(await svc.getEarnings([AAPL])).toEqual({ status: 'unavailable', events: [], retryInMs: RETRY_MS });
    } finally {
      fake.close();
      vi.useRealTimers();
    }
  });

  it('answers unsubscribed when IB refuses WSH and the scanner', async () => {
    const { svc, fake, scanner, settled } = setup();
    await settle();
    fake.ready();
    refuse(fake, scanner, 'meta');
    scanner.answer = (reqId) => setTimeout(() => fake.error(reqId, 162, 'Historical Market Data Service error message:Scanner filter usdMarketCapAbove is disabled.'), 1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await settled([AAPL, NVDA])).toEqual({ status: 'unsubscribed', events: [] });
    } finally {
      warn.mockRestore();
    }
  });

  it('is unavailable when IB fails otherwise (no scanner), and asks for the meta data again', async () => {
    const { svc, fake, scanner } = setup();
    await settle();
    fake.ready();
    fake.onCall = (name, args) => {
      if (name === 'reqWshMetaData') queueMicrotask(() => fake.error(args[0] as number, 10279, 'Failed request WSH metadata'));
    };
    expect(await svc.getEarnings([AAPL])).toEqual({ status: 'unavailable', events: [] });
    answer(fake, scanner, () => '[]');
    expect((await svc.getEarnings([AAPL])).status).toBe('ok');
    expect(fake.callsOf('reqWshMetaData')).toHaveLength(2);
    expect(scanner.requests).toHaveLength(0);
  });

  it('warns once and returns no events for unreadable answers', async () => {
    const { svc, fake, scanner } = setup();
    await settle();
    fake.ready();
    answer(fake, scanner, () => 'not json');
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...a: unknown[]) => void warned.push(a);
    try {
      expect(await svc.getEarnings([AAPL, NVDA])).toEqual({ status: 'ok', events: [], source: 'wsh' });
    } finally {
      console.warn = warn;
    }
    expect(warned).toHaveLength(1);
  });

  it('answers from the simulator in demo mode, as scanner estimates', async () => {
    const { svc, fake } = setup(true);
    await settle();
    const res = await svc.getEarnings([AAPL, NVDA]);
    expect(res).toMatchObject({ status: 'ok', source: 'scanner' });
    expect(res.pending).toBeUndefined();
    expect(res.events.map((e) => e.key).sort()).toEqual([contractKey(AAPL), contractKey(NVDA)].sort());
    for (const e of res.events) {
      expect(e.date >= today).toBe(true);
      expect(e.estimated).toBe(true);
    }
    expect(fake.calls).toEqual([]);
  });
});
