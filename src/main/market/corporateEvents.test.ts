// Wall Street Horizon earnings against the IB test double. The event JSON shapes below are
// assumptions (IB documents them only by example and the paper account has no WSH
// subscription); the 10276 refusal is what the paper account answered.

import { describe, expect, it } from 'vitest';
import { contractKey, stock } from '@shared/contract';
import type { ContractRef } from '@shared/types';
import { createCorporateEventsService, parseWshEarnings, wshDate, wshTimeOfDay } from './corporateEvents';
import { createFakeContext, createFakeIb, settle } from './fakeIb';
import { addDays, nyDay, yyyymmdd } from './nyTime';

const today = yyyymmdd(nyDay(Date.now()));
const inDays = (n: number) => yyyymmdd(addDays(nyDay(Date.now()), n));
const dashed = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`;

const AAPL: ContractRef = { ...stock('AAPL'), conId: 265598 };
const NVDA: ContractRef = { ...stock('NVDA'), conId: 4815747 };

function setup(demo = false) {
  const fake = createFakeIb();
  const f = createFakeContext(fake.ib, demo);
  const resolved: string[] = [];
  f.ctx.contracts = {
    resolve: async (c: ContractRef) => {
      resolved.push(c.symbol);
      return { ...c, conId: c.symbol === 'META' ? 107113386 : 1 };
    },
  } as unknown as typeof f.ctx.contracts;
  const svc = createCorporateEventsService(f.ctx);
  return { fake, svc, resolved, ...f };
}

/** Answers meta data at once and event data with `json(conId)`. */
function answer(fake: ReturnType<typeof createFakeIb>, json: (conId: number) => string) {
  fake.onCall = (name, args) => {
    const id = args[0] as number;
    if (name === 'reqWshMetaData') queueMicrotask(() => fake.emit('wshMetaData', id, '{"meta_data":{}}'));
    if (name === 'reqWshEventData') queueMicrotask(() => fake.emit('wshEventData', id, json((args[1] as { conId: number }).conId)));
  };
}

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
    const { svc, fake, resolved } = setup();
    await settle();
    fake.ready();
    answer(fake, () => '[]');
    expect(await svc.getEarnings([stock('META')])).toEqual({ status: 'ok', events: [] });
    expect(resolved).toEqual(['META']);
    expect((fake.callsOf('reqWshEventData')[0][1] as { conId: number }).conId).toBe(107113386);
  });

  it('answers unsubscribed after 10276 without asking again until the next handshake', async () => {
    const { svc, fake } = setup();
    await settle();
    fake.ready();
    fake.onCall = (name, args) => {
      if (name === 'reqWshMetaData') queueMicrotask(() => fake.error(args[0] as number, 10276, 'News feed is not allowed'));
    };
    expect(await svc.getEarnings([AAPL, NVDA])).toEqual({ status: 'unsubscribed', events: [] });
    expect(await svc.getEarnings([AAPL])).toEqual({ status: 'unsubscribed', events: [] });
    expect(fake.callsOf('reqWshMetaData')).toHaveLength(1);
    expect(fake.callsOf('reqWshEventData')).toHaveLength(0);

    // A new session asks again.
    fake.close();
    fake.ready();
    answer(fake, () => '[]');
    expect((await svc.getEarnings([AAPL])).status).toBe('ok');
    expect(fake.callsOf('reqWshMetaData')).toHaveLength(2);
  });

  it('answers unsubscribed when an event request is refused', async () => {
    const { svc, fake } = setup();
    await settle();
    fake.ready();
    fake.onCall = (name, args) => {
      const id = args[0] as number;
      if (name === 'reqWshMetaData') queueMicrotask(() => fake.emit('wshMetaData', id, '{}'));
      if (name === 'reqWshEventData') queueMicrotask(() => fake.error(id, 10276, 'News feed is not allowed'));
    };
    expect(await svc.getEarnings([AAPL, NVDA])).toEqual({ status: 'unsubscribed', events: [] });
    expect(fake.callsOf('reqWshEventData')).toHaveLength(1);
  });

  it('is unavailable when IB fails otherwise, and asks for the meta data again', async () => {
    const { svc, fake } = setup();
    await settle();
    fake.ready();
    fake.onCall = (name, args) => {
      if (name === 'reqWshMetaData') queueMicrotask(() => fake.error(args[0] as number, 10279, 'Failed request WSH metadata'));
    };
    expect(await svc.getEarnings([AAPL])).toEqual({ status: 'unavailable', events: [] });
    answer(fake, () => '[]');
    expect((await svc.getEarnings([AAPL])).status).toBe('ok');
    expect(fake.callsOf('reqWshMetaData')).toHaveLength(2);
  });

  it('warns once and returns no events for unreadable answers', async () => {
    const { svc, fake } = setup();
    await settle();
    fake.ready();
    answer(fake, () => 'not json');
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...a: unknown[]) => void warned.push(a);
    try {
      expect(await svc.getEarnings([AAPL, NVDA])).toEqual({ status: 'ok', events: [] });
    } finally {
      console.warn = warn;
    }
    expect(warned).toHaveLength(1);
  });

  it('answers from the simulator in demo mode', async () => {
    const { svc, fake } = setup(true);
    await settle();
    const res = await svc.getEarnings([AAPL, NVDA]);
    expect(res.status).toBe('ok');
    expect(res.events.map((e) => e.key).sort()).toEqual([contractKey(AAPL), contractKey(NVDA)].sort());
    for (const e of res.events) expect(e.date >= today).toBe(true);
    expect(fake.calls).toEqual([]);
  });
});
