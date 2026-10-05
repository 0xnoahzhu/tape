import { afterEach, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import type { TapeEvent } from '@shared/ipc';
import type { ContractRef, DepthBook, MarketDataCheck, OptionChainParams } from '@shared/types';
import type { ContractService, DepthService, OptionsService } from '../context';
import { createFakeContext, createFakeIb, settle, type FakeIb } from './fakeIb';
import {
  AUTO_AFTER_READY_MS,
  createMarketCheckService,
  isMarketDataCheck,
  MARKET_CHECK_NS,
  nearStrikes,
  pickExpiry,
  PROBE_TIMEOUT_MS,
  SETTLE_MS,
} from './marketCheck';
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

async function setup(opts: { lines?: Lines; book?: DepthBook | null; connect?: boolean; chain?: () => Promise<OptionChainParams[]> } = {}) {
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
  ctx.depth = { set: async () => undefined, current: () => opts.book ?? null } as DepthService;
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
      if (answer.last) fake.emit('tickPrice', reqId, answer.type && answer.type > 2 ? TICK.DELAYED_LAST : TICK.LAST, answer.last);
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
  });

  it('reuses lines other owners hold and answers from them at once', async () => {
    const { fake, svc, ctx } = await setup({ lines: { 'SPY:SMART': { type: 1, last: 670 }, 'SPY:ARCA': { type: 1 }, 'SPX:CBOE': { type: 1 }, OPT: { type: 1 } } });
    ctx.quotes.setSubscriptions('watchlist', [{ contract: stock('SPY'), profile: 'underlying' }]);
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
    ctx.quotes.setSubscriptions('options-chain', [{ contract: held, profile: 'option' }]);
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
    // A later quiet check keeps the Level 2 answer with its own time.
    await vi.advanceTimersByTimeAsync(60_000);
    const later = await finish(svc.run({ trigger: 'auto' }));
    expect(item(later, 'depth')).toEqual(item(r, 'depth'));
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
    ctx.quotes.setSubscriptions(
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
