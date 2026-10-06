import { afterEach, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import type { TapeEvent } from '@shared/ipc';
import type { ContractRef, DepthBook, MarketDataCheck, OptionChainParams } from '@shared/types';
import type { ContractService, DepthService, OptionsService } from '../context';
import { createFakeContext, createFakeIb, settle, type FakeIb } from './fakeIb';
import {
  AUTO_AFTER_READY_MS,
  createMarketCheckService,
  DEPTH_FINAL_AFTER_UPDATE_MS,
  DEPTH_FINAL_MS,
  DEPTH_NOTICE_MS,
  DEPTH_TIMEOUT_MS,
  isMarketDataCheck,
  MARKET_CHECK_NS,
  nearStrikes,
  pickExpiry,
  PROBE_TIMEOUT_MS,
  SETTLE_MS,
} from './marketCheck';
import { CANCEL_CAP_MS, createDepthService } from './depth';
import { createQuoteService, LINGER_MS } from './quotes';
import { TICK } from './tickMap';

const SPY_CONID = 756733;
const OPT_CONID = 9999;
// Monday 2026-10-05, 08:50 in New York (pre-market).
const NOW = Date.UTC(2026, 9, 5, 12, 50);

const CHAIN: OptionChainParams[] = [
  { exchange: 'SMART', underlyingConId: SPY_CONID, tradingClass: 'SPY', multiplier: 100, expirations: ['20261005', '20261006', '20261007'], strikes: [669, 669.5, 670, 671] },
];

/** What the fake IB answers per line: marketDataType, errors (in order) and a price tick, or nothing. */
interface Answer {
  type?: number;
  errors?: Array<[number, string]>;
  last?: number;
  /** An error sent before the type (354, then delayed data). */
  first?: [number, string];
}

type Lines = Record<string, Answer | undefined>;

/** Identifies a reqMktData line: "SPY:SMART", "SPY:ARCA", "SPX:CBOE", "OPT". */
function lineName(c: { symbol?: string; conId?: number; secType?: string; exchange?: string }): string {
  if (c.secType === 'OPT') return 'OPT';
  const symbol = c.symbol ?? (c.conId === SPY_CONID ? 'SPY' : `#${c.conId}`);
  return `${symbol}:${c.exchange}`;
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
  vi.useRealTimers();
});

async function setup(opts: { lines?: Lines; book?: DepthBook | null; depthLine?: number; connect?: boolean; chain?: () => Promise<OptionChainParams[]> } = {}) {
  const fake = createFakeIb();
  const { ctx, events } = createFakeContext(fake.ib);
  const infos: ContractRef[] = [];
  ctx.contracts = {
    resolve: async (c: ContractRef) => ({ ...c, conId: SPY_CONID, primaryExchange: 'ARCA' }),
    getInfo: async (c: ContractRef) => {
      infos.push(c);
      return c.strike === 670 ? { contract: { ...c, conId: OPT_CONID }, longName: 'SPY', minTick: 0.01 } : null;
    },
  } as unknown as ContractService;
  let chainCalls = 0;
  ctx.options = {
    getChainParams: async () => {
      chainCalls++;
      return opts.chain ? opts.chain() : CHAIN;
    },
  } as OptionsService;
  // The real depth service (it holds the check's depth line); a test may stand in for the view's book and line.
  const depth = createDepthService(ctx);
  ctx.depth = {
    ...depth,
    current: () => (opts.book !== undefined ? opts.book : depth.current()),
    lineReqId: () => opts.depthLine ?? depth.lineReqId(),
  } as DepthService;
  ctx.quotes = createQuoteService(ctx);
  const svc = createMarketCheckService(ctx);
  ctx.marketCheck = svc;
  const lines: Lines = opts.lines ?? {};
  // Answers come 50 ms after the request, like a quick IB.
  fake.onCall = (name, args) => {
    if (name !== 'reqMktData') return;
    const [reqId, contract] = args as [number, { symbol?: string; conId?: number; secType?: string; exchange?: string }];
    const answer = lines[lineName(contract)];
    if (!answer) return;
    setTimeout(() => {
      if (answer.first) fake.error(reqId, ...answer.first);
      for (const [code, message] of answer.errors ?? []) fake.error(reqId, code, message);
      if (answer.type) fake.emit('marketDataType', reqId, answer.type);
      const delayed = !!answer.type && answer.type > 2;
      if (answer.last) {
        fake.emit('tickPrice', reqId, delayed ? TICK.DELAYED_LAST : TICK.LAST, answer.last);
        // IB sends the previous close with a line's first ticks.
        fake.emit('tickPrice', reqId, delayed ? TICK.DELAYED_CLOSE : TICK.CLOSE, answer.last - 1);
      }
    }, 50);
  };
  await settle();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: NOW });
  if (opts.connect !== false) fake.ready();
  return { fake, ctx, events, svc, infos, chainCalls: () => chainCalls };
}

const checkEvents = (events: TapeEvent[]) => events.filter((e): e is Extract<TapeEvent, { type: 'marketDataCheck' }> => e.type === 'marketDataCheck');
const mktData = (fake: FakeIb) => fake.callsOf('reqMktData').map((c) => lineName(c[1] as { symbol?: string }));

/** Runs the timers until the check settles. */
async function finish<T>(p: Promise<T>, ms = PROBE_TIMEOUT_MS * 3): Promise<T> {
  let done = false;
  let value: T | undefined;
  let error: unknown;
  p.then(
    (v) => ((done = true), (value = v)),
    (e: unknown) => ((done = true), (error = e)),
  );
  for (let t = 0; t < ms && !done; t += 50) await vi.advanceTimersByTimeAsync(50);
  if (!done) throw new Error('check did not finish');
  if (error) throw error;
  return value as T;
}

const item = (r: MarketDataCheck, market: string) => r.items.find((i) => i.market === market);

describe('market data check', () => {
  it('reads every market from streaming lines, picks a near-the-money option and releases the lines', async () => {
    const { fake, ctx, svc, events, infos } = await setup({
      lines: { 'SPY:SMART': { type: 1, last: 670.2 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 2 }, OPT: { type: 1 } },
    });
    const r = await finish(svc.run({ trigger: 'user' }));
    expect(r.items.map((i) => [i.market, i.status, i.instrument])).toEqual([
      ['stk', 'live', 'SPY'],
      ['opt', 'live', 'SPY 10/06 670 Call'],
      ['ind', 'frozen', 'SPX'],
    ]);
    expect(item(r, 'stk')).toMatchObject({ probe: { status: 'live', exchange: 'SMART', marketDataType: 1 }, primary: { status: 'live', exchange: 'ARCA' } });
    expect(item(r, 'stk')!.via).toBeUndefined();
    // Streaming lines only (snapshot and regulatory snapshot false), one each; the option's strike is the one nearest SPY's price.
    expect(fake.callsOf('reqMktData').every((c) => c[3] === false && c[4] === false)).toBe(true);
    expect(mktData(fake).sort()).toEqual(['OPT', 'SPX:CBOE', 'SPY:ARCA', 'SPY:SMART']);
    expect(infos[0]).toMatchObject({ lastTradeDate: '20261006', strike: 670, right: 'C', tradingClass: 'SPY' });
    expect(fake.callsOf('reqMktDepth')).toEqual([]);
    // The primary-exchange probe is cancelled at once, the owner lines after lingering.
    const probeId = fake.callsOf('reqMktData').find((c) => lineName(c[1] as object) === 'SPY:ARCA')![0];
    expect(fake.callsOf('cancelMktData')).toEqual([[probeId]]);
    await vi.advanceTimersByTimeAsync(LINGER_MS + 100);
    expect(fake.callsOf('cancelMktData')).toHaveLength(4);
    // Kept, pushed (running, then the result) and persisted.
    expect(svc.getState()).toEqual({ result: r, running: false });
    expect(checkEvents(events).map((e) => e.state.running)).toEqual([true, false]);
    expect((await ctx.db.kv.get(MARKET_CHECK_NS, 'last'))?.value).toEqual(r);
    // Quotes only the check wanted never reach the renderer.
    expect(events.some((e) => e.type === 'quotes')).toBe(false);
  });

  it('reports SMART delayed with the primary exchange live as live via that exchange', async () => {
    const { svc } = await setup({
      lines: {
        'SPY:SMART': { type: 3, errors: [[10167, 'Requested market data is not subscribed. Displaying delayed market data.']], last: 670 },
        'SPY:ARCA': { type: 1 },
        'SPX:CBOE': { type: 1 },
        OPT: { type: 1 },
      },
    });
    const r = await finish(svc.run({ trigger: 'user' }));
    expect(item(r, 'stk')).toMatchObject({
      status: 'live',
      via: 'ARCA',
      probe: { status: 'delayed', marketDataType: 3, code: 10167 },
      primary: { status: 'live', exchange: 'ARCA', marketDataType: 1 },
    });
    // The quotes service moved SPY to ARCA meanwhile (its fallback): SMART still reads delayed, and the item names it.
    expect(item(r, 'stk')!.fallback).toEqual([{ symbol: 'SPY', exchange: 'ARCA' }]);
  });

  it('reuses lines other owners hold and answers from them at once', async () => {
    const { fake, svc, ctx } = await setup({ lines: { 'SPY:SMART': { type: 1, last: 670 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } } });
    ctx.quotes.setRendererSubscriptions('watchlist', [{ contract: stock('SPY'), profile: 'underlying' }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(mktData(fake)).toEqual(['SPY:SMART']);
    const r = await finish(svc.run({ trigger: 'user' }));
    expect(item(r, 'stk')!.probe).toMatchObject({ status: 'live', reused: true });
    // SPY was not requested again.
    expect(mktData(fake).filter((n) => n === 'SPY:SMART')).toHaveLength(1);
    // The watchlist keeps its line.
    await vi.advanceTimersByTimeAsync(LINGER_MS + 100);
    const spy = fake.callsOf('reqMktData')[0][0];
    expect(fake.callsOf('cancelMktData').some((c) => c[0] === spy)).toBe(false);
  });

  it('uses an option line a view already holds instead of looking one up', async () => {
    const { fake, svc, ctx, chainCalls } = await setup({ lines: { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 4 } } });
    const held: ContractRef = { symbol: 'QQQ', secType: 'OPT', exchange: 'SMART', currency: 'USD', lastTradeDate: '20261016', strike: 600, right: 'P', multiplier: 100 };
    ctx.quotes.setRendererSubscriptions('options-chain', [{ contract: held, profile: 'option' }]);
    await vi.advanceTimersByTimeAsync(100);
    const r = await finish(svc.run({ trigger: 'user' }));
    expect(item(r, 'opt')).toMatchObject({ status: 'delayed', instrument: 'QQQ 10/16 600 Put', probe: { marketDataType: 4, reused: true } });
    expect(chainCalls()).toBe(0);
    expect(mktData(fake).filter((n) => n === 'OPT')).toHaveLength(1);
  });

  it('turns errors, a competing session and silence into no data with the code', async () => {
    const { svc } = await setup({
      lines: {
        'SPY:SMART': { errors: [[10197, 'No market data during competing live session']] },
        'SPY:ARCA': { errors: [[10197, 'No market data during competing live session']] },
        OPT: { first: [354, 'Requested market data is not subscribed.'] },
        // SPX: no answer at all.
      },
    });
    const r = await finish(svc.run({ trigger: 'user' }));
    expect(item(r, 'stk')).toMatchObject({ status: 'nodata', probe: { code: 10197 }, primary: { code: 10197 } });
    expect(item(r, 'stk')!.via).toBeUndefined();
    expect(item(r, 'opt')).toMatchObject({ status: 'nodata', probe: { code: 354 } });
    expect(item(r, 'ind')).toMatchObject({ status: 'nodata', probe: { code: -1, own: 'timeout' } });
  });

  it('waits longer after 354 for the delayed data IB may still send', async () => {
    const { fake, svc } = await setup({
      lines: { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, OPT: { type: 1 }, 'SPX:CBOE': { first: [354, 'Requested market data is not subscribed.'] } },
    });
    // SPX's delayed data comes 3 s after its 354 (longer than SETTLE_MS).
    fake.onCall = ((prev) => (name: string, args: unknown[]) => {
      prev?.(name, args);
      const c = args[1] as { symbol?: string };
      if (name === 'reqMktData' && c.symbol === 'SPX') setTimeout(() => fake.emit('marketDataType', args[0], 3), 3_050);
    })(fake.onCall);
    const r = await finish(svc.run({ trigger: 'user' }));
    expect(item(r, 'ind')).toMatchObject({ status: 'delayed', probe: { marketDataType: 3, code: 354 } });
  });

  it('keeps the data type when IB sends delayed data after 354', async () => {
    const { svc } = await setup({
      lines: {
        'SPY:SMART': { type: 1 },
        'SPY:ARCA': { type: 1 },
        'SPX:CBOE': { type: 1 },
        OPT: { first: [354, 'Requested market data is not subscribed.'], errors: [[10167, 'Displaying delayed market data.']], type: 3 },
      },
    });
    const r = await finish(svc.run({ trigger: 'user' }));
    expect(item(r, 'opt')).toMatchObject({ status: 'delayed', probe: { marketDataType: 3, code: 354 } });
  });

  it('waits SETTLE_MS after the first answer, then PROBE_TIMEOUT_MS at most', async () => {
    const { svc } = await setup({ lines: { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } } });
    const p = svc.run({ trigger: 'user' });
    let done = false;
    void p.then(() => (done = true));
    // SPY answers after 50 ms and settles SETTLE_MS later; then the option is looked up and answers.
    await vi.advanceTimersByTimeAsync(50 + SETTLE_MS - 10);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(50 + SETTLE_MS + 100);
    expect(done).toBe(true);
  });

  it('checks Level 2 only on request, with one depth line that it cancels', async () => {
    const { fake, svc } = await setup({ lines: { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } } });
    const quiet = await finish(svc.run({ trigger: 'auto' }));
    expect(item(quiet, 'depth')).toBeUndefined();
    expect(fake.callsOf('reqMktDepth')).toEqual([]);
    fake.onCall = (name, args) => {
      if (name === 'reqMktDepth') setTimeout(() => fake.emit('updateMktDepthL2', args[0], 0, 'NSDQ', 0, 1, 670.1, 100), 50);
    };
    const r = await finish(svc.run({ depth: true, trigger: 'user' }));
    expect(item(r, 'depth')).toMatchObject({ status: 'live', instrument: 'SPY', probe: { status: 'live' } });
    expect(item(r, 'depth')!.via).toBeUndefined();
    const [[reqId, contract, rows, smart]] = fake.callsOf('reqMktDepth') as Array<[number, { symbol: string }, number, boolean]>;
    expect([contract.symbol, rows, smart]).toEqual(['SPY', 5, true]);
    expect(fake.callsOf('cancelMktDepth')).toEqual([[reqId, true]]);
    // A later quiet check keeps the Level 2 answer (confirmed by then) with its own time.
    const { unconfirmed, ...confirmed } = item(r, 'depth')!;
    expect(unconfirmed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    const later = await finish(svc.run({ trigger: 'auto' }));
    expect(item(later, 'depth')).toEqual(confirmed);
    expect(fake.callsOf('reqMktDepth')).toHaveLength(1);
  });

  it('marks Level 2 from some exchanges only (2152) as live via those exchanges', async () => {
    const { fake, svc } = await setup({ lines: { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } } });
    const notice = 'Exchanges - Depth: IEX; Top: BYX; AMEX; Need additional market data permissions - Depth: NASDAQ; ARCA; NYSE; ';
    fake.onCall = ((prev) => (name: string, args: unknown[]) => {
      prev?.(name, args);
      if (name !== 'reqMktDepth') return;
      setTimeout(() => {
        fake.error(args[0] as number, 2152, notice);
        fake.emit('updateMktDepthL2', args[0], 0, 'IEX', 0, 1, 670.1, 100);
      }, 50);
    })(fake.onCall);
    const r = await finish(svc.run({ depth: true, trigger: 'user' }));
    expect(item(r, 'depth')).toMatchObject({ status: 'live', via: 'IEX', probe: { code: 2152, message: notice } });
  });

  it('is not ended by the session the connection replays to a ready listener added while connected', async () => {
    const { fake, svc } = await setup({ lines: { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } } });
    // As connection.ts does: a listener added while connected also gets the running session.
    const add = fake.ib.onReady;
    fake.ib.onReady = (l, o) => {
      const off = add(l, o);
      const api = fake.ib.api;
      if (o?.current !== false && api) queueMicrotask(() => l(api));
      return off;
    };
    fake.onCall = ((prev) => (name: string, args: unknown[]) => {
      prev?.(name, args);
      if (name === 'reqMktDepth') setTimeout(() => fake.emit('updateMktDepthL2', args[0], 0, 'NSDQ', 0, 1, 670.1, 100), 50);
    })(fake.onCall);
    const r = await finish(svc.run({ depth: true, trigger: 'user' }));
    expect(item(r, 'depth')).toMatchObject({ status: 'live', probe: { status: 'live' } });
  });

  it('patches Level 2 with a 2152 that comes after the first book update, and keeps it for later checks', async () => {
    const all = { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } };
    const { fake, svc, events } = await setup({ lines: all });
    const notice = 'Exchanges - Depth: IEX; Top: BYX; Need additional market data permissions - Depth: NASDAQ; ARCA; NYSE; ';
    let late = true;
    fake.onCall = ((prev) => (name: string, args: unknown[]) => {
      prev?.(name, args);
      if (name !== 'reqMktDepth') return;
      setTimeout(() => fake.emit('updateMktDepthL2', args[0], 0, 'IEX', 0, 1, 670.1, 100), 50);
      if (late) setTimeout(() => fake.error(args[0] as number, 2152, notice), 9_000);
    })(fake.onCall);
    const r = await finish(svc.run({ depth: true, trigger: 'user' }));
    expect(item(r, 'depth')).toMatchObject({ status: 'live' });
    expect(item(r, 'depth')!.via).toBeUndefined();
    await vi.advanceTimersByTimeAsync(DEPTH_NOTICE_MS);
    const patched = svc.getState().result!;
    expect(item(patched, 'depth')).toMatchObject({ status: 'live', via: 'IEX', probe: { code: 2152 } });
    expect(checkEvents(events).at(-1)!.state.result).toEqual(patched);
    // The next Level 2 check starts from that 2152; when none comes it is dropped.
    late = false;
    const again = await finish(svc.run({ depth: true, trigger: 'user' }));
    expect(item(again, 'depth')).toMatchObject({ via: 'IEX', probe: { code: 2152 } });
    await vi.advanceTimersByTimeAsync(DEPTH_NOTICE_MS);
    expect(item(svc.getState().result!, 'depth')!.via).toBeUndefined();
    expect(item(svc.getState().result!, 'depth')!.probe.code).toBeUndefined();
  });

  it('waits for the depth view’s open line instead of opening a second depth line', async () => {
    const { fake, svc } = await setup({
      depthLine: 77,
      book: { key: 'STK:NVDA', bids: [], asks: [], updatedAt: NOW },
      lines: { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } },
    });
    setTimeout(() => fake.emit('updateMktDepth', 77, 0, 0, 1, 180, 10), 500);
    const r = await finish(svc.run({ depth: true, trigger: 'user' }));
    expect(item(r, 'depth')).toMatchObject({ status: 'live', instrument: 'NVDA', probe: { reused: true } });
    expect(fake.callsOf('reqMktDepth')).toEqual([]);
    expect(fake.callsOf('cancelMktDepth')).toEqual([]);
  });

  it('never cancels a depth line IB has not started: no book in time is no data, a late book cancels it and patches the result', async () => {
    const all = { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } };
    const { fake, svc } = await setup({ lines: all });
    const r = await finish(svc.run({ depth: true, trigger: 'user' }));
    expect(item(r, 'depth')).toMatchObject({ status: 'nodata', probe: { own: 'timeout', message: `No book from IB within ${DEPTH_TIMEOUT_MS / 1000} s` } });
    // A cancel now would be ignored by IB and leave the stream running: none is sent.
    const [[reqId]] = fake.callsOf('reqMktDepth') as Array<[number]>;
    expect(fake.callsOf('cancelMktDepth')).toEqual([]);
    // IB starts the stream after all: cancelled once, and Level 2 reads live.
    fake.emit('updateMktDepthL2', reqId, 0, 'IEX', 0, 1, 670.1, 100);
    fake.emit('updateMktDepthL2', reqId, 1, 'IEX', 0, 1, 670.0, 100);
    expect(fake.callsOf('cancelMktDepth')).toEqual([[reqId, true]]);
    expect(item(svc.getState().result!, 'depth')).toMatchObject({ status: 'live', probe: { status: 'live' } });
    // A 2152 that follows still counts.
    const notice = 'Exchanges - Depth: IEX; Top: BYX; Need additional market data permissions - Depth: NASDAQ; ARCA; NYSE; ';
    fake.error(reqId, 2152, notice);
    expect(item(svc.getState().result!, 'depth')).toMatchObject({ status: 'live', via: 'IEX' });
    await vi.advanceTimersByTimeAsync(CANCEL_CAP_MS);
    expect(fake.callsOf('cancelMktDepth')).toHaveLength(1);
  });

  it('cancels a depth line that never starts at the cap, and none that IB ended', async () => {
    const all = { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } };
    const { fake, svc } = await setup({ lines: all });
    await finish(svc.run({ depth: true, trigger: 'user' }));
    const [[reqId]] = fake.callsOf('reqMktDepth') as Array<[number]>;
    await vi.advanceTimersByTimeAsync(CANCEL_CAP_MS - DEPTH_TIMEOUT_MS - 2_000);
    expect(fake.callsOf('cancelMktDepth')).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.callsOf('cancelMktDepth')).toEqual([[reqId, true]]);
    expect(item(svc.getState().result!, 'depth')).toMatchObject({ status: 'nodata', probe: { own: 'timeout' } });

    await vi.advanceTimersByTimeAsync(60_000);
    const next = finish(svc.run({ depth: true, trigger: 'user' }));
    await vi.advanceTimersByTimeAsync(DEPTH_TIMEOUT_MS + 1_000);
    const second = fake.callsOf('reqMktDepth')[1][0] as number;
    // A late error that ended the line: the result says so, and nothing is cancelled.
    fake.error(second, 10092, 'Deep market data is not supported for this combination of security/exchange');
    await next;
    expect(item(svc.getState().result!, 'depth')).toMatchObject({ status: 'nodata', probe: { code: 10092 } });
    await vi.advanceTimersByTimeAsync(CANCEL_CAP_MS);
    expect(fake.callsOf('cancelMktDepth')).toHaveLength(1);
  });

  it('lists the stocks the fallback served from their exchange even after their line went', async () => {
    const lines: Record<string, Answer> = {
      'SPY:SMART': { type: 1 },
      'SPY:ARCA': { type: 1 },
      'SPX:CBOE': { type: 1 },
      OPT: { type: 1 },
      'AAPL:SMART': { type: 3 },
      '#265598:NASDAQ': { type: 1 }, // by conId once resolved
    };
    const { fake, ctx, svc } = await setup({ lines });
    ctx.contracts.resolve = async (c: ContractRef) => ({ ...c, conId: c.symbol === 'AAPL' ? 265598 : SPY_CONID, primaryExchange: c.symbol === 'AAPL' ? 'NASDAQ' : 'ARCA' });
    ctx.quotes.setRendererSubscriptions('watchlist', [{ contract: stock('AAPL'), profile: 'basic' }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(ctx.quotes.getQuote('STK:AAPL')?.source).toEqual({ kind: 'primary', exchange: 'NASDAQ' });
    // The user leaves the trade page for Settings: AAPL's exchange line goes after lingering.
    ctx.quotes.setRendererSubscriptions('watchlist', []);
    await vi.advanceTimersByTimeAsync(LINGER_MS + 1_000);
    expect(fake.callsOf('cancelMktData').map((c) => c[0])).toContain(fake.callsOf('reqMktData').find((c) => lineName(c[1] as { conId: number }) === '#265598:NASDAQ')![0]);
    expect(ctx.quotes.wanted().filter((w) => w.contract.symbol === 'AAPL')).toEqual([]);
    const r = await finish(svc.run({ trigger: 'user' }));
    expect(item(r, 'stk')).toMatchObject({ status: 'live', fallback: [{ symbol: 'AAPL', exchange: 'NASDAQ' }] });
    // Once AAPL is live on SMART the check no longer lists it.
    lines['AAPL:SMART'] = { type: 1 };
    ctx.quotes.setRendererSubscriptions('watchlist', [{ contract: stock('AAPL'), profile: 'basic' }]);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(60_000);
    const later = await finish(svc.run({ trigger: 'user' }));
    expect(item(later, 'stk')!.fallback).toBeUndefined();
  });

  it('says whether the running check tests Level 2', async () => {
    const { svc } = await setup({ lines: { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } } });
    const p = svc.run({ trigger: 'auto' });
    expect(svc.getState()).toMatchObject({ running: true, depth: false });
    await finish(p);
    expect(svc.getState().depth).toBeUndefined();
  });

  it('reports a full depth allowance (309) without cancelling, and reuses the depth view’s book', async () => {
    const book: DepthBook = { key: 'STK:NVDA', bids: [{ price: 1, size: 1 }], asks: [], updatedAt: NOW };
    const { fake, svc } = await setup({ lines: { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } } });
    fake.onCall = (name, args) => {
      if (name === 'reqMktDepth') setTimeout(() => fake.error(args[0] as number, 309, 'Max number (3) of market depth requests has been reached'), 50);
    };
    const r = await finish(svc.run({ depth: true, trigger: 'user' }));
    expect(item(r, 'depth')).toMatchObject({ status: 'nodata', probe: { code: 309 } });
    expect(fake.callsOf('cancelMktDepth')).toEqual([]);

    const withBook = await setup({ book, lines: { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } } });
    const r2 = await finish(withBook.svc.run({ depth: true, trigger: 'user' }));
    expect(item(r2, 'depth')).toMatchObject({ status: 'live', instrument: 'NVDA', probe: { reused: true } });
    expect(withBook.fake.callsOf('reqMktDepth')).toEqual([]);
  });

  it('joins a running check, and runs Level 2 after a quiet one', async () => {
    const { fake, svc } = await setup({ lines: { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } } });
    fake.onCall = ((prev) => (name: string, args: unknown[]) => {
      prev?.(name, args);
      if (name === 'reqMktDepth') setTimeout(() => fake.emit('updateMktDepth', args[0], 0, 0, 1, 670, 10), 50);
    })(fake.onCall);
    const a = svc.run({ trigger: 'auto' });
    const b = svc.run({ trigger: 'auto' });
    expect(b).toBe(a);
    const c = svc.run({ depth: true, trigger: 'user' });
    const [ra, rc] = await finish(Promise.all([a, c]));
    expect(item(ra, 'depth')).toBeUndefined();
    expect(item(rc, 'depth')?.status).toBe('live');
    expect(fake.callsOf('reqMktDepth')).toHaveLength(1);
  });

  it('refuses without a connection and keeps the last result when the session closes midway', async () => {
    const { svc } = await setup({ connect: false });
    await expect(svc.run({ trigger: 'user' })).rejects.toThrow(/Not connected/);
    const s = await setup({ lines: { 'SPY:SMART': { type: 1 } } });
    const p = s.svc.run({ trigger: 'user' });
    const failed = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200);
    s.fake.close();
    expect(String(await finish(failed))).toMatch(/Not connected/);
    expect(s.svc.getState()).toEqual({ result: null, running: false });
  });

  it('answers no free line when the primary-exchange probe finds the line budget full', async () => {
    const { fake, svc, ctx } = await setup({ lines: { 'SPY:SMART': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } } });
    ctx.quotes.setRendererSubscriptions(
      'watchlist',
      Array.from({ length: 95 }, (_, i) => ({ contract: stock(`S${i}`), profile: 'basic' as const })),
    );
    await vi.advanceTimersByTimeAsync(100);
    const before = fake.callsOf('reqMktData').length;
    const r = await finish(svc.run({ trigger: 'user' }));
    expect(item(r, 'stk')!.primary).toMatchObject({ status: 'nodata', own: 'lines' });
    // The check's own owner lines are background: no visible line was given up for them.
    expect(item(r, 'stk')!.probe).toMatchObject({ status: 'nodata', own: 'lines' });
    expect(fake.callsOf('reqMktData').length - before).toBe(0);
    expect(fake.callsOf('cancelMktData')).toEqual([]);
  });

  it('loads the persisted result on startup and checks quietly after a handshake', async () => {
    const first = await setup({ lines: { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } } });
    const r = await finish(first.svc.run({ trigger: 'user' }));
    vi.useRealTimers();
    // A new process with the same database.
    const fake = createFakeIb();
    const { ctx, events } = createFakeContext(fake.ib);
    ctx.db = first.ctx.db;
    ctx.quotes = createQuoteService(ctx);
    const svc = createMarketCheckService(ctx);
    await settle();
    expect(svc.getState().result).toEqual(r);
    expect(checkEvents(events).at(-1)?.state.result).toEqual(r);

    // The quiet check after the handshake (the persisted result is recent, so only a later one runs).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: r.checkedAt + 10 * 60_000 });
    ctx.contracts = first.ctx.contracts;
    ctx.options = first.ctx.options;
    ctx.depth = first.ctx.depth;
    fake.ready();
    await vi.advanceTimersByTimeAsync(AUTO_AFTER_READY_MS - 100);
    expect(fake.callsOf('reqMktData')).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.callsOf('reqMktData').length).toBeGreaterThan(0);
    expect(svc.getState().running).toBe(true);
  });
});

describe('the Level 2 switch', () => {
  const all = { 'SPY:SMART': { type: 1 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } };
  const IEX_ONLY = 'Exchanges - Depth: IEX; Top: BYX; Need additional market data permissions - Depth: NASDAQ; ARCA; NYSE; ';

  /**
   * The check's depth line gets its first book update `book` ms after the request and each notice
   * of `notices` ([ms, code]; `notice`: a 2152 then) after it. Tests may change `plan` between checks.
   */
  async function depthSetup(opts: { book?: number; notice?: number; notices?: Array<[number, number]>; features?: { depth: boolean; depthSetByUser: boolean } } = {}) {
    const s = await setup({ lines: all });
    if (opts.features) s.ctx.store.updateSettings({ features: opts.features });
    const plan = { book: opts.book ?? 50, notices: opts.notices ?? (opts.notice !== undefined ? [[opts.notice, 2152]] : []) };
    s.fake.onCall = ((prev) => (name: string, args: unknown[]) => {
      prev?.(name, args);
      if (name !== 'reqMktDepth') return;
      const id = args[0] as number;
      setTimeout(() => s.fake.emit('updateMktDepthL2', id, 0, 'IEX', 0, 1, 670.1, 100), plan.book);
      for (const [at, code] of plan.notices) setTimeout(() => s.fake.error(id, code, code === 2152 ? IEX_ONLY : 'Market data farm is connecting:usfarm'), at);
    })(s.fake.onCall);
    return { ...s, plan, features: () => s.ctx.store.getSettings().features, depthNow: () => item(s.svc.getState().result!, 'depth') };
  }

  it('turns on with a full book from IB, once no 2152 can come any more', async () => {
    const { svc, features, depthNow } = await depthSetup();
    const startedAt = Date.now();
    const r = await finish(svc.run({ depth: true, trigger: 'user' }));
    // The first answer is live, but a 2152 may still follow: not confirmed, and nothing changes yet.
    expect(item(r, 'depth')).toMatchObject({ status: 'live', unconfirmed: true });
    expect(features()).toEqual({ depth: false, depthSetByUser: false });
    await vi.advanceTimersByTimeAsync(startedAt + DEPTH_FINAL_MS - 100 - Date.now());
    expect(features().depth).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(features()).toEqual({ depth: true, depthSetByUser: false });
    expect(depthNow()).toMatchObject({ status: 'live' });
    expect(depthNow()!.unconfirmed).toBeUndefined();
  });

  it('stays off when IB sends some exchanges only (2152), also when the 2152 comes after the first book update', async () => {
    const early = await depthSetup({ notice: 40 });
    const r = await finish(early.svc.run({ depth: true, trigger: 'user' }));
    expect(item(r, 'depth')).toMatchObject({ status: 'live', via: 'IEX' });
    expect(item(r, 'depth')!.unconfirmed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(DEPTH_FINAL_MS);
    expect(early.features()).toEqual({ depth: false, depthSetByUser: false });

    // First reported live without a 2152, which arrives 9 s later: never switched on in between.
    const late = await depthSetup({ notice: 9_000 });
    const first = await finish(late.svc.run({ depth: true, trigger: 'user' }));
    expect(item(first, 'depth')!.via).toBeUndefined();
    for (let t = 0; t < DEPTH_FINAL_MS; t += 500) {
      await vi.advanceTimersByTimeAsync(500);
      expect(late.features().depth).toBe(false);
    }
    expect(late.depthNow()).toMatchObject({ via: 'IEX' });
    expect(late.depthNow()!.unconfirmed).toBeUndefined();
  });

  it('watches for a 2152 well past the window of the shown result before it turns on', async () => {
    // Just past the shown result's window (15 s after the request): the result follows, the switch stays off.
    const past = await depthSetup({ notice: DEPTH_NOTICE_MS + 500 });
    await finish(past.svc.run({ depth: true, trigger: 'user' }));
    await vi.advanceTimersByTimeAsync(DEPTH_NOTICE_MS);
    expect(past.depthNow()).toMatchObject({ via: 'IEX' });
    await vi.advanceTimersByTimeAsync(DEPTH_FINAL_MS);
    expect(past.features().depth).toBe(false);

    // Just before the end of the long watch.
    const last = await depthSetup({ notice: DEPTH_FINAL_MS - 100 });
    await finish(last.svc.run({ depth: true, trigger: 'user' }));
    await vi.advanceTimersByTimeAsync(DEPTH_FINAL_MS);
    expect(last.depthNow()).toMatchObject({ via: 'IEX' });
    expect(last.features().depth).toBe(false);

    // A late first update (after the 20 s timeout) is watched DEPTH_FINAL_AFTER_UPDATE_MS on.
    const slow = await depthSetup({ book: 40_000, notice: 40_000 + DEPTH_FINAL_AFTER_UPDATE_MS - 500 });
    await finish(slow.svc.run({ depth: true, trigger: 'user' }));
    await vi.advanceTimersByTimeAsync(40_000 + DEPTH_FINAL_AFTER_UPDATE_MS);
    expect(slow.depthNow()).toMatchObject({ via: 'IEX' });
    expect(slow.features().depth).toBe(false);
    const quiet = await depthSetup({ book: 40_000 });
    const startedAt = Date.now();
    await finish(quiet.svc.run({ depth: true, trigger: 'user' }));
    await vi.advanceTimersByTimeAsync(startedAt + 40_000 + DEPTH_FINAL_AFTER_UPDATE_MS - 100 - Date.now());
    expect(quiet.features().depth).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(quiet.features().depth).toBe(true);
  });

  it('counts only a 2152 as a partial book: another notice neither ends the watch nor stands for a full book', async () => {
    const s = await depthSetup({ notices: [[10, 2119], [5_000, 2152]] });
    const r = await finish(s.svc.run({ depth: true, trigger: 'user' }));
    expect(item(r, 'depth')!.probe.code).toBeUndefined();
    expect(s.features().depth).toBe(false);
    await vi.advanceTimersByTimeAsync(DEPTH_FINAL_MS);
    expect(s.depthNow()).toMatchObject({ via: 'IEX', probe: { code: 2152 } });
    expect(s.features().depth).toBe(false);

    const other = await depthSetup({ notices: [[10, 2119]] });
    await finish(other.svc.run({ depth: true, trigger: 'user' }));
    await vi.advanceTimersByTimeAsync(DEPTH_FINAL_MS);
    expect(other.depthNow()!.probe.code).toBeUndefined();
    expect(other.features().depth).toBe(true);
  });

  it('leaves the switch alone once the user has set it, and never turns it off', async () => {
    const off = await depthSetup({ features: { depth: false, depthSetByUser: true } });
    await finish(off.svc.run({ depth: true, trigger: 'user' }));
    await vi.advanceTimersByTimeAsync(DEPTH_FINAL_MS);
    expect(off.features()).toEqual({ depth: false, depthSetByUser: true });

    // Turned on by an earlier check, and now IB sends IEX only: it stays on.
    const auto = await depthSetup({ notice: 40, features: { depth: true, depthSetByUser: false } });
    await finish(auto.svc.run({ depth: true, trigger: 'user' }));
    await vi.advanceTimersByTimeAsync(DEPTH_FINAL_MS);
    expect(auto.features()).toEqual({ depth: true, depthSetByUser: false });
  });

  it('lets only the latest Level 2 check decide', async () => {
    // A newer check (IEX only) is running when the first one's watch ends: the first one no longer counts.
    const s = await depthSetup();
    const startedAt = Date.now();
    await finish(s.svc.run({ depth: true, trigger: 'user' }));
    await vi.advanceTimersByTimeAsync(startedAt + DEPTH_FINAL_MS - 1_000 - Date.now());
    s.plan.notices = [[40, 2152]];
    const newer = await finish(s.svc.run({ depth: true, trigger: 'user' }));
    expect(item(newer, 'depth')).toMatchObject({ via: 'IEX' });
    await vi.advanceTimersByTimeAsync(DEPTH_FINAL_MS);
    expect(s.features().depth).toBe(false);
    expect(s.depthNow()).toMatchObject({ via: 'IEX' });

    // A check without Level 2 in between keeps the answer, which still decides (and is still patched).
    const kept = await depthSetup();
    await finish(kept.svc.run({ depth: true, trigger: 'user' }));
    await vi.advanceTimersByTimeAsync(5_000);
    const quiet = await finish(kept.svc.run({ trigger: 'user' }));
    expect(item(quiet, 'depth')).toMatchObject({ status: 'live', unconfirmed: true });
    await vi.advanceTimersByTimeAsync(DEPTH_FINAL_MS);
    expect(kept.features().depth).toBe(true);
    expect(kept.depthNow()!.unconfirmed).toBeUndefined();
  });

  it('does not decide when the session closes or IB drops the market data (1101) before the watch ends', async () => {
    const closed = await depthSetup();
    await finish(closed.svc.run({ depth: true, trigger: 'user' }));
    closed.fake.close();
    await vi.advanceTimersByTimeAsync(DEPTH_FINAL_MS);
    expect(closed.features()).toEqual({ depth: false, depthSetByUser: false });
    // Never confirmed: the result keeps saying so.
    expect(closed.depthNow()).toMatchObject({ status: 'live', unconfirmed: true });

    // 1101: the session stays, IB's requests are gone (the connection fires ready again).
    const lost = await depthSetup();
    await finish(lost.svc.run({ depth: true, trigger: 'user' }));
    lost.fake.ready();
    await vi.advanceTimersByTimeAsync(DEPTH_FINAL_MS);
    expect(lost.features()).toEqual({ depth: false, depthSetByUser: false });
    expect(lost.depthNow()).toMatchObject({ status: 'live', unconfirmed: true });
  });

  it('switches nothing on from the depth view’s book (its 2152 is gone after its next update)', async () => {
    const book: DepthBook = { key: 'STK:NVDA', bids: [{ price: 1, size: 1 }], asks: [], updatedAt: NOW };
    const view = await setup({ book, lines: all });
    await finish(view.svc.run({ depth: true, trigger: 'user' }));
    await vi.advanceTimersByTimeAsync(DEPTH_FINAL_MS);
    expect(view.ctx.store.getSettings().features.depth).toBe(false);
  });
});

describe('market data check helpers', () => {
  it('picks whole strikes nearest the price', () => {
    expect(nearStrikes([669, 669.5, 670, 671, 672], 670.4)).toEqual([670, 671, 669]);
    expect(nearStrikes([1, 2, 3, 4, 5], undefined, 1)).toEqual([3]);
    expect(nearStrikes([], 5)).toEqual([]);
  });

  it('picks the class named like the underlying on SMART and the first expiration after today', () => {
    const rows: OptionChainParams[] = [
      { exchange: 'CBOE', underlyingConId: 1, tradingClass: 'SPY', multiplier: 100, expirations: ['20261006'], strikes: [1] },
      { exchange: 'SMART', underlyingConId: 1, tradingClass: '2SPY', multiplier: 100, expirations: ['20261009'], strikes: [1] },
      { exchange: 'SMART', underlyingConId: 1, tradingClass: 'SPY', multiplier: 100, expirations: ['20261005', '20261007'], strikes: [1] },
    ];
    expect(pickExpiry(rows, 'SPY', NOW)).toMatchObject({ expiry: '20261007', row: { tradingClass: 'SPY', exchange: 'SMART' } });
    // Only today's expiration left: use it.
    expect(pickExpiry([{ ...rows[2], expirations: ['20261005'] }], 'SPY', NOW)?.expiry).toBe('20261005');
    expect(pickExpiry([], 'SPY', NOW)).toBeNull();
  });

  it('accepts only well-formed persisted results', () => {
    const ok: MarketDataCheck = {
      checkedAt: 1,
      trigger: 'user',
      items: [{ market: 'stk', status: 'live', instrument: 'SPY', probe: { status: 'live', exchange: 'SMART' }, checkedAt: 1 }],
    };
    expect(isMarketDataCheck(ok)).toBe(true);
    expect(isMarketDataCheck({ ...ok, items: [{ market: 'stk' }] })).toBe(false);
    expect(isMarketDataCheck(null)).toBe(false);
    expect(isMarketDataCheck({ items: [] })).toBe(false);
  });
});
