// Contracts, history, depth and option chain services against the IB test double.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { index, stock } from '@shared/contract';
import type { TapeEvent } from '@shared/ipc';
import type { ContractInfo, DepthBook, OptionChainParams } from '@shared/types';
import { CONTRACT_REFRESH_MS, createContractService, REFETCH_GAP_MS, REFETCH_MAX, SEARCH_TTL_MS } from './contracts';
import { CANCEL_CAP_MS, createDepthService } from './depth';
import { DEPTH_ROWS } from './depthBook';
import { createFakeContext, createFakeIb, settle } from './fakeIb';
import { createHistoryService } from './history';
import { NOT_CONNECTED } from './ibRequest';
import { createOptionsService, SECDEF_TTL_MS, sortChainParams } from './options';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(demo = false) {
  const fake = createFakeIb();
  const f = createFakeContext(fake.ib, demo);
  f.ctx.contracts = createContractService(f.ctx);
  f.ctx.history = createHistoryService(f.ctx);
  f.ctx.depth = createDepthService(f.ctx);
  f.ctx.options = createOptionsService(f.ctx);
  return { fake, ...f };
}

const aaplDetails = (exchange: string, currency: string, conId: number) => ({
  contract: { symbol: 'AAPL', secType: 'STK', exchange, currency, conId, primaryExch: 'NASDAQ', localSymbol: 'AAPL', tradingClass: 'NMS', multiplier: 0 },
  longName: 'APPLE INC',
  industry: 'Technology',
  category: 'Computers',
  subcategory: 'Computers',
  minTick: 0.01,
  timeZoneId: 'US/Eastern',
});

describe('ContractService', () => {
  it('resolves details once, prefers SMART/USD and caches by key and conId', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    fake.onCall = (name, args) => {
      if (name !== 'reqContractDetails') return;
      const id = args[0];
      queueMicrotask(() => {
        fake.emit('contractDetails', id, aaplDetails('SMART', 'CHF', 2));
        fake.emit('contractDetails', id, aaplDetails('SMART', 'USD', 265598));
        fake.emit('contractDetailsEnd', id);
      });
    };
    const [a, b] = await Promise.all([ctx.contracts.getInfo(stock('AAPL')), ctx.contracts.getInfo(stock('AAPL'))]);
    expect(fake.callsOf('reqContractDetails')).toHaveLength(1);
    expect(a).toBe(b);
    expect(a).toMatchObject({ longName: 'APPLE INC', industry: 'Technology', contract: { conId: 265598, primaryExchange: 'NASDAQ', exchange: 'SMART' } });
    expect(await ctx.contracts.getInfo({ ...stock('AAPL'), conId: 265598 })).toBe(a);
    expect(await ctx.contracts.resolve(stock('AAPL'))).toMatchObject({ symbol: 'AAPL', conId: 265598 });
    expect(fake.callsOf('reqContractDetails')).toHaveLength(1);
  });

  it('persists details by key and conId and answers from them after a restart, even offline', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    fake.onCall = (name, args) => {
      if (name !== 'reqContractDetails') return;
      const id = args[0];
      queueMicrotask(() => {
        fake.emit('contractDetails', id, { ...aaplDetails('SMART', 'USD', 265598), stockType: 'COMMON' });
        fake.emit('contractDetailsEnd', id);
      });
    };
    expect(await ctx.contracts.getInfo(stock('AAPL'))).toMatchObject({ stockType: 'COMMON', contract: { conId: 265598 } });
    expect((await ctx.db.kv.get<ContractInfo>('contract', 'STK:AAPL'))?.value.longName).toBe('APPLE INC');
    expect((await ctx.db.kv.get<ContractInfo>('contract', 'conId:265598'))?.value.longName).toBe('APPLE INC');
    // A new service (restart) without a connection resolves from the kv cache.
    fake.close();
    const restarted = createContractService(ctx);
    expect(await restarted.resolve(stock('AAPL'))).toMatchObject({ conId: 265598, primaryExchange: 'NASDAQ' });
    expect((await restarted.getInfo({ ...stock('AAPL'), symbol: '', conId: 265598 }))?.longName).toBe('APPLE INC');
    expect(fake.callsOf('reqContractDetails')).toHaveLength(1);
  });

  it('refreshes persisted details older than a week in the background', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    const old = { contract: { ...stock('AAPL'), conId: 265598 }, longName: 'OLD NAME', minTick: 0.01 };
    const realNow = Date.now;
    Date.now = () => realNow() - CONTRACT_REFRESH_MS - 1000;
    await ctx.db.kv.set('contract', 'STK:AAPL', old);
    Date.now = realNow;
    fake.onCall = (name, args) => {
      if (name !== 'reqContractDetails') return;
      const id = args[0];
      queueMicrotask(() => {
        fake.emit('contractDetails', id, aaplDetails('SMART', 'USD', 265598));
        fake.emit('contractDetailsEnd', id);
      });
    };
    expect((await ctx.contracts.getInfo(stock('AAPL')))?.longName).toBe('OLD NAME');
    await settle();
    expect(fake.callsOf('reqContractDetails')).toHaveLength(1);
    expect((await ctx.db.kv.get<ContractInfo>('contract', 'STK:AAPL'))?.value.longName).toBe('APPLE INC');
    expect((await ctx.contracts.getInfo(stock('AAPL')))?.longName).toBe('APPLE INC');
  });

  it('answers from details of an older version at once and upgrades them through a paced queue', async () => {
    const { fake, ctx } = setup();
    // Five held stocks Tape 0.8 stored (no version: 1).
    const syms = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'META'];
    const conIdOf = (sym: string) => 1000 + syms.indexOf(sym);
    for (const sym of syms) await ctx.db.kv.set('contract', `STK:${sym}`, { contract: { ...stock(sym), conId: conIdOf(sym) }, longName: `${sym} OLD`, minTick: 0.01 });
    // Offline: the stored details at once, nothing asked.
    const before = await Promise.all(syms.map((sym) => ctx.contracts.getInfo(stock(sym))));
    expect(before.map((i) => [i?.longName, i?.v])).toEqual(syms.map((sym) => [`${sym} OLD`, undefined]));
    expect(fake.callsOf('reqContractDetails')).toEqual([]);
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const open = new Map<number, number>(); // reqId -> conId
      const sentAt: number[] = [];
      fake.onCall = (name, args) => {
        if (name !== 'reqContractDetails') return;
        const c = args[1] as { conId?: number; symbol?: string };
        open.set(args[0] as number, c.conId ?? conIdOf(c.symbol!));
        sentAt.push(Date.now());
      };
      const answer = (reqId: number) => {
        const conId = open.get(reqId)!;
        open.delete(reqId);
        const sym = syms[conId - 1000];
        fake.emit('contractDetails', reqId, { ...aaplDetails('SMART', 'USD', conId), contract: { ...aaplDetails('SMART', 'USD', conId).contract, symbol: sym }, longName: `${sym} NEW`, secIdList: [{ tag: 'ISIN', value: `US-${sym}` }] });
        fake.emit('contractDetailsEnd', reqId);
      };
      const step = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
      fake.ready();
      await step();
      expect(fake.callsOf('reqContractDetails')).toHaveLength(1);
      await step(REFETCH_GAP_MS - 1);
      expect(fake.callsOf('reqContractDetails')).toHaveLength(1);
      await step(1);
      expect(fake.callsOf('reqContractDetails')).toHaveLength(2);
      // At most two at a time.
      await step(5000);
      expect(open.size).toBe(REFETCH_MAX);
      expect(fake.callsOf('reqContractDetails')).toHaveLength(2);
      answer([...open.keys()][0]);
      await step();
      expect(fake.callsOf('reqContractDetails')).toHaveLength(3);
      // The connection goes: nothing is sent meanwhile, and what was in flight is asked for again later.
      fake.close();
      await step(10_000);
      expect(fake.callsOf('reqContractDetails')).toHaveLength(3);
      fake.ready();
      for (let i = 0; i < 20 && (open.size || fake.callsOf('reqContractDetails').length < 7); i++) {
        for (const id of [...open.keys()]) answer(id);
        await step(REFETCH_GAP_MS);
      }
      expect(fake.callsOf('reqContractDetails')).toHaveLength(7);
      // One request per instrument (the two cut off by the disconnect twice), always REFETCH_GAP_MS apart.
      const asked = fake.callsOf('reqContractDetails').map((c) => (c[1] as { symbol: string }).symbol);
      expect(new Set(asked).size).toBe(5);
      for (let i = 1; i < sentAt.length; i++) expect(sentAt[i] - sentAt[i - 1]).toBeGreaterThanOrEqual(REFETCH_GAP_MS);
      // Upgraded: by key and by conId, in memory and stored.
      for (const sym of syms) {
        expect(await ctx.contracts.getInfo(stock(sym))).toMatchObject({ v: 2, longName: `${sym} NEW`, isin: `US-${sym}` });
        expect(await ctx.contracts.getInfo({ ...stock(sym), conId: conIdOf(sym) })).toMatchObject({ v: 2, longName: `${sym} NEW` });
        expect((await ctx.db.kv.get<ContractInfo>('contract', `STK:${sym}`))?.value.v).toBe(2);
      }
      expect(fake.callsOf('reqContractDetails')).toHaveLength(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a bond’s details whole (bondContractDetails)', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    fake.onCall = (name, args) => {
      if (name !== 'reqContractDetails') return;
      const id = args[0];
      queueMicrotask(() => {
        fake.emit('bondContractDetails', id, {
          contract: { symbol: 'US-T', secType: 'BOND', exchange: 'SMART', currency: 'USD', conId: 742000123, tradingClass: 'US-T' },
          longName: 'United States Treasury',
          minTick: 0.0001,
          cusip: '91282CLW9',
          coupon: 4.25,
          maturity: '20341115',
          callable: false,
          putable: false,
          convertible: false,
          descAppend: 'T 4 1/4 11/15/34',
        });
        fake.emit('contractDetailsEnd', id);
      });
    };
    const info = await ctx.contracts.getInfo({ symbol: 'US-T', secType: 'BOND', exchange: 'SMART', currency: 'USD', conId: 742000123 });
    expect(info).toMatchObject({
      contract: { symbol: 'US-T', secType: 'BOND', conId: 742000123 },
      longName: 'United States Treasury',
      minTick: 0.0001,
      bond: { cusip: '91282CLW9', coupon: 4.25, maturity: '20341115', callable: false, descAppend: 'T 4 1/4 11/15/34' },
    });
    expect((info?.contract as unknown as { contract?: unknown }).contract).toBeUndefined();
  });

  it('answers null for error 200 and throws on resolve', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    fake.onCall = (name, args) => {
      if (name === 'reqContractDetails') queueMicrotask(() => fake.error(args[0] as number, 200, 'No security definition has been found for the request'));
    };
    expect(await ctx.contracts.getInfo(stock('ZZZZQX'))).toBeNull();
    await expect(ctx.contracts.resolve(stock('ZZZZQX'))).rejects.toThrow('Unknown contract: ZZZZQX');
  });

  it('runs one symbol search at a time and supersedes queued ones', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    const answer = (id: number, symbol: string) =>
      fake.emit('symbolSamples', id, [
        { contract: { conId: 1, symbol, secType: 'STK', primaryExch: 'MEXI', currency: 'MXN', description: 'X' }, derivativeSecTypes: [] },
        { contract: { conId: 2, symbol, secType: 'STK', primaryExch: 'NASDAQ', currency: 'USD', description: 'X' }, derivativeSecTypes: [] },
      ]);
    const first = ctx.contracts.search('M');
    const second = ctx.contracts.search('MS');
    const third = ctx.contracts.search('MSFT');
    expect(fake.callsOf('reqMatchingSymbols').map((c) => c[1])).toEqual(['M']);
    answer(fake.callsOf('reqMatchingSymbols')[0][0] as number, 'M');
    expect((await first).map((m) => m.contract.currency)).toEqual(['USD', 'MXN']);
    expect(await second).toEqual([]);
    await settle();
    expect(fake.callsOf('reqMatchingSymbols').map((c) => c[1])).toEqual(['M', 'MSFT']);
    answer(fake.callsOf('reqMatchingSymbols')[1][0] as number, 'MSFT');
    expect((await third)[0].contract).toMatchObject({ symbol: 'MSFT', exchange: 'SMART', primaryExchange: 'NASDAQ', conId: 2 });
    // Patterns are cached for 5 minutes.
    expect((await ctx.contracts.search('msft '))[0].contract.symbol).toBe('MSFT');
    expect(fake.callsOf('reqMatchingSymbols')).toHaveLength(2);
    const realNow = Date.now;
    Date.now = () => realNow() + SEARCH_TTL_MS - 1000;
    try {
      await ctx.contracts.search('MSFT');
    } finally {
      Date.now = realNow;
    }
    expect(fake.callsOf('reqMatchingSymbols')).toHaveLength(2);
  });

  it('routes found stocks through SMART only where IB reaches their listing that way', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    const pending = ctx.contracts.search('AAPL');
    const sample = (conId: number, primaryExch: string, currency: string, secType = 'STK') => ({
      contract: { conId, symbol: 'AAPL', secType, primaryExch, currency, description: 'APPLE INC' },
      derivativeSecTypes: [],
    });
    // What IB returned for "AAPL" (paper account, October 2026), plus an exchange Tape does not know.
    fake.emit('symbolSamples', fake.callsOf('reqMatchingSymbols')[0][0], [
      sample(265598, 'NASDAQ', 'USD'),
      sample(38708077, 'MEXI', 'MXN'),
      sample(273982664, 'EBS', 'CHF'),
      sample(532640894, 'TSE', 'CAD'),
      sample(55279376, 'PINK', 'USD'),
      sample(1, 'NEWEXCH', 'EUR'),
      sample(86792725, 'NASDAQ', 'USD', 'IND'),
    ]);
    const routes = Object.fromEntries((await pending).map((m) => [m.contract.conId, m.contract.exchange]));
    // IB answers {conId: 38708077, exchange: 'SMART'} with error 200; on MEXI it quotes the listing.
    expect(routes).toEqual({ 265598: 'SMART', 38708077: 'MEXI', 273982664: 'SMART', 532640894: 'SMART', 55279376: 'SMART', 1: 'NEWEXCH', 86792725: 'NASDAQ' });
    const mexi = (await pending).find((m) => m.contract.conId === 38708077)!.contract;
    expect(mexi).toMatchObject({ exchange: 'MEXI', primaryExchange: 'MEXI', currency: 'MXN' });

    // Its details are asked for on MEXI, and carry IB's price magnifier.
    fake.onCall = (name, args) => {
      if (name !== 'reqContractDetails') return;
      const id = args[0];
      queueMicrotask(() => {
        fake.emit('contractDetails', id, { ...aaplDetails('MEXI', 'MXN', 38708077), priceMagnifier: 1 });
        fake.emit('contractDetailsEnd', id);
      });
    };
    expect(await ctx.contracts.getInfo(mexi)).toMatchObject({ contract: { exchange: 'MEXI', conId: 38708077 }, priceMagnifier: 1 });
    expect(fake.callsOf('reqContractDetails')[0][1]).toMatchObject({ conId: 38708077, exchange: 'MEXI' });
  });

  it('keeps the price magnifier of LSE stocks (quoted in pence)', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    fake.onCall = (name, args) => {
      if (name !== 'reqContractDetails') return;
      const id = args[0];
      queueMicrotask(() => {
        fake.emit('contractDetails', id, {
          contract: { symbol: 'VOD', secType: 'STK', exchange: 'SMART', currency: 'GBP', conId: 140148322, primaryExch: 'LSE' },
          longName: 'VODAFONE GROUP PLC',
          minTick: 0.02,
          priceMagnifier: 100,
        });
        fake.emit('contractDetailsEnd', id);
      });
    };
    const vod = { symbol: 'VOD', secType: 'STK' as const, exchange: 'SMART', primaryExchange: 'LSE', currency: 'GBP', conId: 140148322 };
    expect((await ctx.contracts.getInfo(vod))?.priceMagnifier).toBe(100);
  });

  it('works offline in demo mode and refuses otherwise', async () => {
    expect((await setup(true).ctx.contracts.search('nvda'))[0].description).toBe('NVIDIA CORP');
    expect((await setup(true).ctx.contracts.getInfo(stock('AAPL')))?.longName).toBe('APPLE INC');
    await expect(setup().ctx.contracts.search('nvda')).rejects.toThrow(NOT_CONNECTED);
    await expect(setup().ctx.contracts.getInfo(stock('AAPL'))).rejects.toThrow(NOT_CONNECTED);
  });
});

describe('HistoryService', () => {
  it('requests bars with the timeframe parameters and parses them', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    fake.onCall = (name, args) => {
      if (name !== 'reqHistoricalData') return;
      const id = args[0];
      queueMicrotask(() => {
        fake.emit('historicalData', id, '20261001', 225, 228, 224, 227, 5_000_000, 100, 226);
        fake.emit('historicalData', id, '20261002', 227, 229, 226, 227.48, -1, 100, 226);
        fake.emit('historicalData', id, 'finished-20241002-20261002', -1, -1, -1, -1, -1, -1, -1, false);
      });
    };
    const bars = await ctx.history.get({ contract: stock('AAPL'), timeframe: '1D' });
    const call = fake.callsOf('reqHistoricalData')[0];
    expect(call.slice(2)).toEqual(['', '2 Y', '1 day', 'TRADES', 1, 2, false]);
    expect(bars).toEqual([
      { time: Date.UTC(2026, 9, 1) / 1000, open: 225, high: 228, low: 224, close: 227, volume: 5_000_000 },
      { time: Date.UTC(2026, 9, 2) / 1000, open: 227, high: 229, low: 226, close: 227.48, volume: 0 },
    ]);
    // Cached: no second request.
    await ctx.history.get({ contract: stock('AAPL'), timeframe: '1D' });
    expect(fake.callsOf('reqHistoricalData')).toHaveLength(1);
  });

  it("rejects with IB's message and treats 'no data' as empty", async () => {
    const { fake, ctx } = setup();
    fake.ready();
    let message = 'Historical Market Data Service error message:Trading TWS session is connected from a different IP address';
    fake.onCall = (name, args) => {
      if (name === 'reqHistoricalData') queueMicrotask(() => fake.error(args[0] as number, 162, message));
    };
    await expect(ctx.history.get({ contract: stock('AAPL'), timeframe: '5m' })).rejects.toThrow(`${message} (IB 162)`);
    message = 'Historical Market Data Service error message:HMDS query returned no data: AAPL@SMART Trades';
    expect(await ctx.history.get({ contract: stock('AAPL'), timeframe: '1m' })).toEqual([]);
  });

  it('keeps at most five requests in flight', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    const tfs = ['1m', '5m', '1h', '1D', '1W', '1M', '1Y'] as const;
    const pending = tfs.map((timeframe) => ctx.history.get({ contract: stock('AAPL'), timeframe }));
    await settle();
    expect(fake.callsOf('reqHistoricalData')).toHaveLength(5);
    const finish = (id: number) => fake.emit('historicalData', id, 'finished', -1, -1, -1, -1, -1, -1, -1, false);
    finish(fake.callsOf('reqHistoricalData')[0][0] as number);
    await settle();
    expect(fake.callsOf('reqHistoricalData')).toHaveLength(6);
    for (const c of fake.callsOf('reqHistoricalData').slice(1)) finish(c[0] as number);
    await settle();
    for (const c of fake.callsOf('reqHistoricalData').slice(6)) finish(c[0] as number);
    expect((await Promise.all(pending)).every((b) => Array.isArray(b))).toBe(true);
  });

  it('aggregates yearly bars from monthly data', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    fake.onCall = (name, args) => {
      if (name !== 'reqHistoricalData') return;
      const id = args[0];
      queueMicrotask(() => {
        fake.emit('historicalData', id, '20251101', 10, 12, 9, 11, 1);
        fake.emit('historicalData', id, '20251201', 11, 15, 10, 14, 1);
        fake.emit('historicalData', id, '20260102', 14, 16, 13, 15, 1);
        fake.emit('historicalData', id, 'finished', -1, -1, -1, -1, -1);
      });
    };
    const bars = await ctx.history.get({ contract: stock('AAPL'), timeframe: '1Y' });
    expect(bars.map((b) => [new Date(b.time * 1000).getUTCFullYear(), b.open, b.high, b.close, b.volume])).toEqual([
      [2025, 10, 15, 14, 2],
      [2026, 14, 16, 15, 1],
    ]);
  });

  it('synthesizes bars in demo mode without IB', async () => {
    const { fake, ctx } = setup(true);
    fake.ready();
    const bars = await ctx.history.get({ contract: stock('AAPL'), timeframe: '1D' });
    expect(bars.length).toBeGreaterThan(400);
    expect(fake.calls).toEqual([]);
  });
});

describe('DepthService', () => {
  afterEach(() => void vi.useRealTimers());
  const books = (events: TapeEvent[]): DepthBook[] => events.flatMap((e) => (e.type === 'depth' ? [e.book] : []));

  it('keeps one SMART depth request and maintains the book', async () => {
    const { fake, ctx, events } = setup();
    await settle();
    fake.ready();
    await ctx.depth.set(stock('AAPL'));
    const [id, contract, rows, smart, opts] = fake.callsOf('reqMktDepth')[0];
    // The order ticket's Book shows 5 levels a side; IB streams that many.
    expect(DEPTH_ROWS).toBe(5);
    expect([contract, rows, smart, opts]).toEqual([{ symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' }, DEPTH_ROWS, true, []]);
    expect(books(events).at(-1)).toMatchObject({ key: 'STK:AAPL', bids: [], asks: [] });
    fake.emit('updateMktDepthL2', id, 0, 'NSDQ', 0, 1, 227.47, 300, true);
    fake.emit('updateMktDepthL2', id, 0, 'ARCA', 0, 0, 227.49, 200, true);
    fake.emit('updateMktDepth', id, 1, 0, 1, 227.46, 100);
    await wait(130);
    expect(books(events).at(-1)).toMatchObject({
      bids: [
        { price: 227.47, size: 300, marketMaker: 'NSDQ' },
        { price: 227.46, size: 100 },
      ],
      asks: [{ price: 227.49, size: 200, marketMaker: 'ARCA' }],
    });
    // Same instrument again: nothing to do.
    await ctx.depth.set(stock('AAPL'));
    expect(fake.callsOf('reqMktDepth')).toHaveLength(1);
    // Switching cancels the previous book.
    await ctx.depth.set(stock('NVDA'));
    expect(fake.callsOf('cancelMktDepth')).toEqual([[id, true]]);
    expect(books(events).at(-1)).toMatchObject({ key: 'STK:NVDA', bids: [], asks: [] });
    const nvda = fake.callsOf('reqMktDepth')[1][0] as number;
    fake.emit('updateMktDepth', nvda, 0, 0, 1, 180, 10);
    await ctx.depth.set(null);
    expect(fake.callsOf('cancelMktDepth')).toEqual([
      [id, true],
      [nvda, true],
    ]);
  });

  it('always cancels the open line before subscribing the next one', async () => {
    const { fake, ctx } = setup();
    await settle();
    fake.ready();
    for (const s of ['AAPL', 'NVDA', 'MSFT', 'AAPL']) {
      // Each line has answered before the switch (see below for one that has not).
      const last = fake.callsOf('reqMktDepth').at(-1);
      if (last) fake.emit('updateMktDepth', last[0], 0, 0, 1, 100, 1);
      await ctx.depth.set(stock(s));
    }
    const names = fake.calls.filter((c) => c[0] === 'reqMktDepth' || c[0] === 'cancelMktDepth').map((c) => `${c[0]}:${c[1]}`);
    const ids = fake.callsOf('reqMktDepth').map((c) => c[0]);
    expect(names).toEqual([
      `reqMktDepth:${ids[0]}`,
      `cancelMktDepth:${ids[0]}`,
      `reqMktDepth:${ids[1]}`,
      `cancelMktDepth:${ids[1]}`,
      `reqMktDepth:${ids[2]}`,
      `cancelMktDepth:${ids[2]}`,
      `reqMktDepth:${ids[3]}`,
    ]);
  });

  it('cancels a line that has not answered yet on its first update, or at the cap', async () => {
    const { fake, ctx } = setup();
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    fake.ready();
    // IB ignores a cancel that comes before it has started the stream: none is sent yet.
    await ctx.depth.set(stock('AAPL'));
    await ctx.depth.set(stock('NVDA'));
    const [aapl, nvda] = fake.callsOf('reqMktDepth').map((c) => c[0] as number);
    expect(fake.callsOf('cancelMktDepth')).toEqual([]);
    // AAPL starts 10 s later: cancelled then, once; its trailing updates change nothing.
    vi.advanceTimersByTime(10_000);
    fake.emit('updateMktDepth', aapl, 0, 0, 1, 227, 10);
    fake.emit('updateMktDepth', aapl, 1, 0, 1, 226, 10);
    expect(fake.callsOf('cancelMktDepth')).toEqual([[aapl, true]]);
    expect(ctx.depth.current()).toMatchObject({ key: 'STK:NVDA', bids: [] });
    // NVDA never answers: cancelled anyway at the cap; an error that ended a line needs none.
    await ctx.depth.set(stock('MSFT'));
    const msft = fake.callsOf('reqMktDepth')[2][0] as number;
    await ctx.depth.set(null);
    fake.error(msft, 10092, 'Deep market data is not supported for this combination of security/exchange');
    vi.advanceTimersByTime(CANCEL_CAP_MS);
    expect(fake.callsOf('cancelMktDepth')).toEqual([
      [aapl, true],
      [nvda, true],
    ]);
    // Updates after the cap are ignored (nothing left to cancel).
    fake.emit('updateMktDepth', nvda, 0, 0, 1, 180, 10);
    expect(fake.callsOf('cancelMktDepth')).toHaveLength(2);
  });

  it('retries a 309 once this client’s other depth lines are gone', async () => {
    const { fake, ctx, events } = setup();
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    fake.ready();
    // The market data check holds a line that has not started yet when the view subscribes.
    const check = ctx.depth.openLine(stock('SPY'), 5);
    await ctx.depth.set(stock('NVDA'));
    const nvda = fake.callsOf('reqMktDepth')[1][0] as number;
    fake.error(nvda, 309, 'Max number (3) of market depth requests has been reached');
    ctx.depth.closeLine(check);
    vi.advanceTimersByTime(5_000);
    expect(fake.callsOf('reqMktDepth')).toHaveLength(2);
    expect(books(events).at(-1)?.error).toBeUndefined();
    // The check's line starts and is cancelled; the view asks again a second later.
    fake.emit('updateMktDepth', check, 0, 0, 1, 670, 10);
    expect(fake.callsOf('cancelMktDepth')).toEqual([[check, true]]);
    vi.advanceTimersByTime(2_000);
    expect(fake.callsOf('reqMktDepth')).toHaveLength(3);
    expect((fake.callsOf('reqMktDepth')[2][1] as { symbol: string }).symbol).toBe('NVDA');
  });

  it('retries once when IB reports the depth limit right after a switch', async () => {
    const { fake, ctx, events } = setup();
    await settle();
    fake.ready();
    await ctx.depth.set(stock('AAPL'));
    fake.emit('updateMktDepth', fake.callsOf('reqMktDepth')[0][0], 0, 0, 1, 227, 10);
    await ctx.depth.set(stock('NVDA'));
    const nvda = fake.callsOf('reqMktDepth')[1][0] as number;
    fake.error(nvda, 309, 'Max number (3) of market depth requests has been reached');
    await wait(1100);
    expect(fake.callsOf('reqMktDepth')).toHaveLength(3);
    // The retry was not cancelled: the failed request holds no line at IB.
    expect(fake.callsOf('cancelMktDepth')).toHaveLength(1);
    const retry = fake.callsOf('reqMktDepth')[2][0] as number;
    fake.error(retry, 309, 'Max number (3) of market depth requests has been reached');
    await wait(1100);
    expect(fake.callsOf('reqMktDepth')).toHaveLength(3);
    expect(books(events).at(-1)?.error?.code).toBe(309);
  });

  it('reports errors on the book and does not cancel dead requests', async () => {
    const { fake, ctx, events } = setup();
    await settle();
    fake.ready();
    await ctx.depth.set(index('SPX', 'CBOE'));
    const id = fake.callsOf('reqMktDepth')[0][0] as number;
    fake.error(id, 10092, 'Deep market data is not supported for this combination of security/exchange');
    await wait(130);
    expect(books(events).at(-1)?.error?.code).toBe(10092);
    await ctx.depth.set(null);
    expect(fake.callsOf('cancelMktDepth')).toEqual([]);
  });

  it('subscribes the current book again after a reconnect', async () => {
    const { fake, ctx } = setup();
    await settle();
    await ctx.depth.set(stock('AAPL'));
    expect(fake.callsOf('reqMktDepth')).toHaveLength(0);
    fake.ready();
    expect(fake.callsOf('reqMktDepth')).toHaveLength(1);
    fake.close();
    fake.ready();
    expect(fake.callsOf('reqMktDepth')).toHaveLength(2);
    fake.ready(); // 1101 "data lost"
    expect(fake.callsOf('reqMktDepth')).toHaveLength(3);
    expect(fake.callsOf('cancelMktDepth')).toEqual([]);
  });

  it('simulates a book in demo mode', async () => {
    const { fake, ctx, events } = setup(true);
    await settle();
    await ctx.depth.set(stock('AAPL'));
    const book = books(events).at(-1)!;
    expect(book.bids).toHaveLength(DEPTH_ROWS);
    expect(book.asks).toHaveLength(DEPTH_ROWS);
    await ctx.depth.set(null);
    expect(fake.calls).toEqual([]);
  });
});

describe('OptionsService', () => {
  it('resolves the conId and loads chain definitions, SMART first', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    fake.onCall = (name, args) => {
      const id = args[0];
      if (name === 'reqContractDetails') {
        queueMicrotask(() => {
          fake.emit('contractDetails', id, aaplDetails('SMART', 'USD', 265598));
          fake.emit('contractDetailsEnd', id);
        });
      }
      if (name === 'reqSecDefOptParams') {
        queueMicrotask(() => {
          fake.emit('securityDefinitionOptionParameter', id, 'CBOE', 265598, 'AAPL', '100', ['20261016', '20261009'], [230, 225]);
          fake.emit('securityDefinitionOptionParameter', id, 'SMART', 265598, '2AAPL', '100', ['20261016'], [291]);
          fake.emit('securityDefinitionOptionParameter', id, 'SMART', 265598, 'AAPL', '100', ['20261016', '20261009', '20261009'], [230, 225, 227.5]);
          fake.emit('securityDefinitionOptionParameterEnd', id);
        });
      }
    };
    const chains = await ctx.options.getChainParams(stock('AAPL'));
    expect(fake.callsOf('reqSecDefOptParams')[0].slice(1)).toEqual(['AAPL', '', 'STK', 265598]);
    expect(chains.map((c) => `${c.exchange}/${c.tradingClass}`)).toEqual(['SMART/AAPL', 'SMART/2AAPL', 'CBOE/AAPL']);
    expect(chains[0]).toEqual({ exchange: 'SMART', underlyingConId: 265598, tradingClass: 'AAPL', multiplier: 100, expirations: ['20261009', '20261016'], strikes: [225, 227.5, 230] });
    await ctx.options.getChainParams(stock('AAPL'));
    expect(fake.callsOf('reqSecDefOptParams')).toHaveLength(1);
  });

  it('persists chains for a day and serves older ones while refreshing them', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    let strikes = [230];
    fake.onCall = (name, args) => {
      const id = args[0];
      if (name === 'reqContractDetails') {
        queueMicrotask(() => {
          fake.emit('contractDetails', id, aaplDetails('SMART', 'USD', 265598));
          fake.emit('contractDetailsEnd', id);
        });
      }
      if (name === 'reqSecDefOptParams') {
        queueMicrotask(() => {
          fake.emit('securityDefinitionOptionParameter', id, 'SMART', 265598, 'AAPL', '100', ['20991016', '20000101'], strikes);
          fake.emit('securityDefinitionOptionParameterEnd', id);
        });
      }
    };
    expect((await ctx.options.getChainParams(stock('AAPL')))[0].strikes).toEqual([230]);
    expect((await ctx.db.kv.get<OptionChainParams[]>('secdef', 'STK:AAPL'))?.value[0].strikes).toEqual([230]);
    // A restart within the day: from the kv cache, without IB (and without expired expirations).
    const restarted = createOptionsService(ctx);
    expect((await restarted.getChainParams(stock('AAPL')))[0].expirations).toEqual(['20991016']);
    expect(fake.callsOf('reqSecDefOptParams')).toHaveLength(1);
    // A day later: the stored chain answers at once and is refreshed in the background.
    const realNow = Date.now;
    Date.now = () => realNow() + SECDEF_TTL_MS + 1000;
    try {
      strikes = [230, 235];
      const later = createOptionsService(ctx);
      expect((await later.getChainParams(stock('AAPL')))[0].strikes).toEqual([230]);
      await settle();
      expect(fake.callsOf('reqSecDefOptParams')).toHaveLength(2);
      expect((await later.getChainParams(stock('AAPL')))[0].strikes).toEqual([230, 235]);
    } finally {
      Date.now = realNow;
    }
  });

  it('sorts trading classes named like the underlying first', () => {
    const row = (exchange: string, tradingClass: string) => ({ exchange, tradingClass, underlyingConId: 1, multiplier: 100, expirations: [], strikes: [] });
    expect(sortChainParams([row('SMART', 'SPXW'), row('CBOE', 'SPX'), row('SMART', 'SPX')], 'SPX').map((r) => `${r.exchange}/${r.tradingClass}`)).toEqual([
      'SMART/SPX',
      'SMART/SPXW',
      'CBOE/SPX',
    ]);
  });

  it('serves a synthesized chain in demo mode', async () => {
    const { fake, ctx } = setup(true);
    const chains = await ctx.options.getChainParams(stock('AAPL'));
    expect(chains[0].expirations.length).toBeGreaterThan(15);
    expect(fake.calls).toEqual([]);
  });
});
