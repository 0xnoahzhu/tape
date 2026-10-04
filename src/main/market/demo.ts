// Market data simulator for demo mode (TAPE_DEMO=1).
//
// Quotes, bars, depth and option chains are generated from mean-reverting random walks with a
// stable seed per symbol, anchored at the design's sample prices (unknown symbols get a
// deterministic hash-based price). Options are priced with Black–Scholes on a skewed smile.
// Nothing here talks to IB.

import { contractKey } from '@shared/contract';
import { isIntraday } from '@shared/timeframes';
import type {
  Bar,
  ContractInfo,
  ContractRef,
  DepthLevel,
  OptionChainParams,
  Quote,
  QuoteProfile,
  SecType,
  SymbolMatch,
  Timeframe,
} from '@shared/types';
import { blackScholes, smileVol } from './blackScholes';
import { aggregateQuarters, aggregateYears, mergeIntraday } from './historyParams';
import {
  addDays,
  type CalendarDay,
  dayStamp,
  latestSession,
  nyDay,
  nyWallToEpochMs,
  parseYyyymmdd,
  previousWeekday,
  RTH_CLOSE,
  RTH_OPEN,
  thirdFriday,
  weekday,
  yyyymmdd,
} from './nyTime';

/**
 * Demo intraday series: the bar size each interval is built from (45 s from 15-second bars) and
 * the sessions generated (seconds bars only the latest one: 57,600 one-second bars of extended
 * hours).
 */
const DEMO_INTRADAY: Partial<Record<Timeframe, { barSec: number; sessions: number }>> = {
  '1s': { barSec: 1, sessions: 1 },
  '5s': { barSec: 5, sessions: 1 },
  '10s': { barSec: 10, sessions: 2 },
  '15s': { barSec: 15, sessions: 2 },
  '30s': { barSec: 30, sessions: 3 },
  '45s': { barSec: 15, sessions: 2 },
  '1m': { barSec: 60, sessions: 2 },
  '3m': { barSec: 180, sessions: 5 },
  '5m': { barSec: 300, sessions: 10 },
  '10m': { barSec: 600, sessions: 15 },
  '15m': { barSec: 900, sessions: 20 },
  '30m': { barSec: 1800, sessions: 30 },
  '1h': { barSec: 3600, sessions: 70 },
  '2h': { barSec: 7200, sessions: 80 },
  '3h': { barSec: 10_800, sessions: 80 },
  '4h': { barSec: 14_400, sessions: 120 },
};

/** Interval between simulated ticks. */
export const DEMO_TICK_MS = 900;

export function hashString(s: string): number {
  let h = 7;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 2147483647;
  return h || 1;
}

/** Park–Miller generator (as in the design) with a Box–Muller normal. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = Math.abs(Math.floor(seed)) % 2147483647 || 1;
  }
  next(): number {
    this.s = (this.s * 16807) % 2147483647;
    return this.s / 2147483647;
  }
  normal(): number {
    let u = this.next();
    while (u < 1e-12) u = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
}

// ---------------------------------------------------------------------------
// Built-in instruments

interface Listing {
  symbol: string;
  secType: 'STK' | 'IND';
  exchange: string;
  primaryExchange?: string;
  name: string;
  /** Design sample price and percent change; hash-based when absent. */
  price?: number;
  change?: number;
  /** Annualized volatility used for walks and option prices. */
  vol?: number;
  avgVolume?: number;
  industry?: string;
  category?: string;
}

const stk = (symbol: string, primaryExchange: string, name: string, extra: Partial<Listing> = {}): Listing => ({
  symbol,
  secType: 'STK',
  exchange: 'SMART',
  primaryExchange,
  name,
  ...extra,
});
const ind = (symbol: string, exchange: string, name: string, extra: Partial<Listing> = {}): Listing => ({
  symbol,
  secType: 'IND',
  exchange,
  name,
  industry: 'Indices',
  ...extra,
});

const LISTINGS: Listing[] = [
  stk('AAPL', 'NASDAQ', 'APPLE INC', { price: 227.48, change: 1.32, vol: 0.26, avgVolume: 52e6, industry: 'Technology', category: 'Computers' }),
  stk('NVDA', 'NASDAQ', 'NVIDIA CORP', { price: 118.62, change: -2.14, vol: 0.48, avgVolume: 245e6, industry: 'Technology', category: 'Semiconductors' }),
  stk('TSLA', 'NASDAQ', 'TESLA INC', { price: 251.03, change: 3.87, vol: 0.55, avgVolume: 88e6, industry: 'Consumer, Cyclical', category: 'Auto Manufacturers' }),
  stk('MSFT', 'NASDAQ', 'MICROSOFT CORP', { price: 417.15, change: 0.42, vol: 0.22, avgVolume: 19e6, industry: 'Technology', category: 'Software' }),
  stk('SPY', 'ARCA', 'SPDR S&P 500 ETF TRUST', { price: 571.3, change: -0.31, vol: 0.14, avgVolume: 46e6 }),
  stk('QQQ', 'NASDAQ', 'INVESCO QQQ TRUST SERIES 1', { price: 487.92, change: -0.58, vol: 0.18, avgVolume: 34e6 }),
  stk('AMD', 'NASDAQ', 'ADVANCED MICRO DEVICES', { price: 162.45, change: 1.96, vol: 0.44, avgVolume: 42e6, industry: 'Technology', category: 'Semiconductors' }),
  stk('META', 'NASDAQ', 'META PLATFORMS INC-CLASS A', { price: 582.1, change: 0.88, vol: 0.32, avgVolume: 13e6, industry: 'Communications', category: 'Internet' }),
  stk('AMZN', 'NASDAQ', 'AMAZON.COM INC', { price: 186.33, change: -0.74, vol: 0.3, avgVolume: 41e6, industry: 'Communications', category: 'Internet' }),
  stk('GOOGL', 'NASDAQ', 'ALPHABET INC-CL A', { industry: 'Communications', category: 'Internet' }),
  stk('NFLX', 'NASDAQ', 'NETFLIX INC', { industry: 'Communications', category: 'Internet' }),
  stk('AVGO', 'NASDAQ', 'BROADCOM INC', { industry: 'Technology', category: 'Semiconductors' }),
  stk('JPM', 'NYSE', 'JPMORGAN CHASE & CO', { industry: 'Financial', category: 'Banks' }),
  stk('IWM', 'ARCA', 'ISHARES RUSSELL 2000 ETF'),
  stk('DIA', 'ARCA', 'SPDR DJIA TRUST'),
  ind('SPX', 'CBOE', 'S&P 500 Stock Index', { price: 5712.3, change: -0.28, vol: 0.15, avgVolume: 3e6 }),
  ind('NDX', 'NASDAQ', 'NASDAQ 100 Stock Index', { price: 20104.55, change: -0.47, vol: 0.19, avgVolume: 4e5 }),
  ind('INDU', 'CME', 'Dow Jones Industrial Average', { price: 42011.6, change: -0.12, vol: 0.14, avgVolume: 0 }),
  ind('RUT', 'RUSSELL', 'Russell 2000 Stock Index', { price: 2196.4, change: 0.35, vol: 0.22, avgVolume: 5e5 }),
  ind('VIX', 'CBOE', 'CBOE Volatility Index', { price: 19.82, change: 4.1, vol: 0.9, avgVolume: 1e6 }),
  ind('TNX', 'CBOE', 'CBOE 10 Year Treasury Yield Index', { price: 4.012, change: 0.6, vol: 0.25, avgVolume: 0 }),
  ind('DX', 'NYBOT', 'US Dollar Index', { price: 101.42, change: 0.08, vol: 0.08, avgVolume: 0 }),
];

const BY_SYMBOL = new Map(LISTINGS.map((l) => [l.symbol, l]));

/** Offline symbol search over the built-in instruments (demo mode without IB). */
export function demoSearch(pattern: string): SymbolMatch[] {
  const p = pattern.trim().toUpperCase();
  if (!p) return [];
  const hits = LISTINGS.filter((l) => l.symbol.startsWith(p) || l.name.toUpperCase().includes(p));
  hits.sort((a, b) => Number(b.symbol === p) - Number(a.symbol === p) || Number(b.symbol.startsWith(p)) - Number(a.symbol.startsWith(p)));
  return hits.map((l) => ({
    contract: listingContract(l),
    description: l.name,
    derivativeSecTypes: l.secType === 'STK' ? ['OPT'] : ['OPT', 'FUT'],
  }));
}

function listingContract(l: Listing): ContractRef {
  return {
    symbol: l.symbol,
    secType: l.secType,
    exchange: l.exchange,
    currency: 'USD',
    ...(l.primaryExchange ? { primaryExchange: l.primaryExchange } : {}),
  };
}

/**
 * Offline contract details. Deliberately without conId: a made-up conId must never reach an
 * order or a later live session.
 */
export function demoContractInfo(c: ContractRef): ContractInfo | null {
  if (!c.symbol) return null;
  const l = BY_SYMBOL.get(c.symbol.toUpperCase());
  if (c.secType === 'OPT' || c.secType === 'FOP') {
    return { contract: { ...c, multiplier: c.multiplier ?? 100 }, longName: l?.name ?? c.symbol, minTick: 0.01, timeZoneId: 'US/Eastern' };
  }
  if (l && l.secType === c.secType) {
    const info: ContractInfo = { contract: { ...c, ...listingContract(l) }, longName: l.name, minTick: 0.01, timeZoneId: l.secType === 'STK' ? 'US/Eastern' : 'US/Central' };
    if (l.industry) info.industry = l.industry;
    if (l.category) info.category = l.category;
    return info;
  }
  if (c.secType === 'STK' && /^[A-Z.]{1,6}$/i.test(c.symbol)) {
    return { contract: { ...c, symbol: c.symbol.toUpperCase() }, longName: c.symbol.toUpperCase(), minTick: 0.01, timeZoneId: 'US/Eastern' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Instruments and their walks

interface Instrument {
  symbol: string;
  secType: SecType;
  anchor: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  price: number;
  /** Log deviation from the anchor (Ornstein–Uhlenbeck). */
  x: number;
  vol: number;
  avgVolume: number;
  volume: number;
  lastSize: number;
  /** Quote state drawn once per tick, so the quote and the book agree. */
  spreadTicks: number;
  bidSize: number;
  askSize: number;
  /** Number of ticks so far (seeds per-tick option noise). */
  step: number;
  decimals: number;
  week52High: number;
  week52Low: number;
  histVol: number;
  callVolume: number;
  putVolume: number;
  callOpenInterest: number;
  putOpenInterest: number;
  /** Drives the price walk only, so the path is the same however often quotes are read. */
  walk: Rng;
  /** Sizes, spreads and other noise. */
  rng: Rng;
}

const round = (v: number, decimals: number) => Number(v.toFixed(decimals));
const roundTick = (v: number, tick: number) => Number((Math.round(v / tick) * tick).toFixed(4));

function baseParams(symbol: string): { price: number; change: number; vol: number; avgVolume: number; secType: SecType } {
  const l = BY_SYMBOL.get(symbol);
  const h = hashString(symbol);
  return {
    price: l?.price ?? 10 + (h % 49000) / 100,
    change: l?.change ?? ((Math.floor(h / 7) % 601) - 300) / 100,
    vol: l?.vol ?? 0.2 + (Math.floor(h / 13) % 45) / 100,
    avgVolume: l?.avgVolume ?? 2e6 + (Math.floor(h / 17) % 300) * 1e5,
    secType: l?.secType ?? 'STK',
  };
}

const EXCHANGES = ['NSDQ', 'ARCA', 'BATS', 'EDGX', 'IEX', 'NYSE', 'MEMX', 'BYX', 'PEARL', 'DRCTEDGE'];

export interface DemoBook {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export class DemoMarket {
  private readonly instruments = new Map<string, Instrument>();

  constructor(private readonly clock: () => number = Date.now) {}

  private instrument(symbol: string): Instrument {
    const sym = symbol.toUpperCase();
    let inst = this.instruments.get(sym);
    if (inst) return inst;
    const p = baseParams(sym);
    const r = new Rng(hashString(sym + ':day'));
    const decimals = p.price < 10 && p.secType === 'IND' ? 3 : p.price < 1 ? 4 : 2;
    const prevClose = round(p.price / (1 + p.change / 100), decimals);
    const open = round(prevClose + (p.price - prevClose) * (0.25 + 0.2 * r.next()), decimals);
    const high = round(Math.max(open, p.price) * (1 + 0.002 + 0.004 * r.next()), decimals);
    const low = round(Math.min(open, p.price) * (1 - 0.002 - 0.004 * r.next()), decimals);
    const session = latestSession(this.clock());
    const dayFraction = session.elapsed / (RTH_CLOSE - RTH_OPEN);
    inst = {
      symbol: sym,
      secType: p.secType,
      anchor: p.price,
      prevClose,
      open,
      high,
      low,
      price: p.price,
      x: 0,
      vol: p.vol,
      avgVolume: p.avgVolume,
      volume: Math.round(p.avgVolume * dayFraction * (0.8 + 0.4 * r.next())),
      lastSize: 100,
      spreadTicks: 1,
      bidSize: 100 * (1 + Math.floor(r.next() * 12)),
      askSize: 100 * (1 + Math.floor(r.next() * 12)),
      step: 0,
      decimals,
      week52High: round(Math.max(high, p.price * (1.06 + 0.3 * r.next())), decimals),
      week52Low: round(Math.min(low, p.price * (0.58 + 0.3 * r.next())), decimals),
      histVol: round(p.vol * (0.78 + 0.3 * r.next()), 4),
      callVolume: Math.round(p.avgVolume * 0.012 * (0.7 + 0.6 * r.next())),
      putVolume: 0,
      callOpenInterest: Math.round(p.avgVolume * 0.09 * (0.7 + 0.6 * r.next())),
      putOpenInterest: 0,
      walk: new Rng(hashString(sym + ':walk')),
      rng: new Rng(hashString(sym + ':noise')),
    };
    inst.putVolume = Math.round(inst.callVolume * (0.5 + 0.5 * r.next()));
    inst.putOpenInterest = Math.round(inst.callOpenInterest * (0.6 + 0.5 * r.next()));
    this.instruments.set(sym, inst);
    return inst;
  }

  /** Advances the walks of the given underlying symbols by one tick. */
  advance(symbols: Iterable<string>): void {
    for (const s of new Set(symbols)) {
      const inst = this.instrument(s);
      const sigma = inst.vol * 0.0012;
      inst.x += -0.002 * inst.x + sigma * inst.walk.normal();
      inst.price = round(inst.anchor * Math.exp(inst.x), inst.decimals);
      inst.high = Math.max(inst.high, inst.price);
      inst.low = Math.min(inst.low, inst.price);
      inst.step++;
      inst.spreadTicks = inst.price < 50 ? 1 : 1 + Math.floor(inst.rng.next() * (inst.price > 300 ? 4 : 2));
      inst.bidSize = 100 * (1 + Math.floor(inst.rng.next() * 12));
      inst.askSize = 100 * (1 + Math.floor(inst.rng.next() * 12));
      if (inst.secType !== 'IND') {
        inst.lastSize = 100 * (1 + Math.floor(inst.rng.next() * 5));
        inst.volume += Math.round((inst.avgVolume / 26_000) * (0.4 + 1.6 * inst.rng.next()));
        if (inst.rng.next() < 0.03) {
          inst.callVolume += 1 + Math.floor(inst.rng.next() * 40);
          inst.putVolume += 1 + Math.floor(inst.rng.next() * 30);
        }
      }
    }
  }

  /** Current price of a symbol (advances nothing). */
  price(symbol: string): number {
    return this.instrument(symbol).price;
  }

  /** A full quote snapshot, or null for instruments the simulator does not model (combos). */
  quote(c: ContractRef, profiles: QuoteProfile[] = ['basic']): Omit<Quote, 'key' | 'updatedAt'> | null {
    if (c.secType === 'OPT' || c.secType === 'FOP') return this.optionQuote(c);
    if (c.secType === 'BAG') return null;
    const inst = this.instrument(c.symbol);
    const now = this.clock();
    const q: Omit<Quote, 'key' | 'updatedAt'> = {
      last: inst.price,
      open: inst.open,
      high: inst.high,
      low: inst.low,
      close: inst.prevClose,
      lastTime: now,
      marketDataType: 1,
    };
    if (c.secType !== 'IND') {
      const tick = 0.01;
      const spreadTicks = inst.spreadTicks;
      const bid = roundTick(inst.price - (spreadTicks * tick) / 2, tick);
      Object.assign(q, {
        bid,
        ask: roundTick(bid + spreadTicks * tick, tick),
        bidSize: inst.bidSize,
        askSize: inst.askSize,
        lastSize: inst.lastSize,
        volume: inst.volume,
      });
      if (c.secType === 'STK') q.lastRthTrade = inst.price;
    }
    if (profiles.includes('underlying')) {
      Object.assign(q, {
        week52High: inst.week52High,
        week52Low: inst.week52Low,
        histVol: inst.histVol,
        impliedVol: round(smileVol(inst.vol, 1, 1, 30), 4),
        callVolume: inst.callVolume,
        putVolume: inst.putVolume,
        callOpenInterest: inst.callOpenInterest,
        putOpenInterest: inst.putOpenInterest,
      });
      if (c.secType !== 'IND') q.avgVolume = inst.avgVolume;
    }
    return q;
  }

  private optionModel(c: ContractRef, underlyingPrice?: number, extraDays = 0) {
    const und = this.instrument(c.symbol);
    const S = underlyingPrice ?? und.price;
    const K = c.strike ?? S;
    const right = c.right === 'P' ? 'P' : 'C';
    const exp = parseYyyymmdd(c.lastTradeDate ?? yyyymmdd(addDays(nyDay(this.clock()), 30)));
    const expiresAt = nyWallToEpochMs(exp, RTH_CLOSE);
    const years = Math.max(0, (expiresAt - this.clock()) / (365 * 86_400_000)) + extraDays / 365;
    const dte = years * 365;
    const iv = smileVol(und.vol, S, K, dte) + (right === 'P' ? 0.004 : 0);
    return { und, S, K, right, years, iv, model: blackScholes(S, K, years, iv, right) } as const;
  }

  private optionQuote(c: ContractRef): Omit<Quote, 'key' | 'updatedAt'> {
    const { und, S, K, iv, model } = this.optionModel(c);
    const prev = this.optionModel(c, und.prevClose, 1).model.price;
    // Per contract and session: where the last trade sits in the spread, the day's range,
    // volume and open interest. Sizes change with every tick of the underlying.
    const r = new Rng(hashString(contractKey(c) + ':' + yyyymmdd(latestSession(this.clock()).day)));
    const sizes = new Rng(hashString(contractKey(c) + ':' + und.step));
    const dist = Math.abs(K / S - 1);
    const mark = Math.max(0.01, model.price);
    const spread = Math.max(0.01, mark * 0.015 + 0.01);
    const bid = Math.max(0, round(mark - spread / 2, 2));
    const ask = Math.max(bid + 0.01, round(mark + spread / 2, 2));
    const last = Math.max(0.01, round(mark + (r.next() - 0.5) * spread, 2));
    const close = Math.max(0.01, round(prev, 2));
    const open = Math.max(0.01, round(close + (last - close) * (0.2 + 0.3 * r.next()), 2));
    return {
      bid,
      ask,
      last,
      mark: round(mark, 2),
      bidSize: 1 + Math.round(sizes.next() * 180),
      askSize: 1 + Math.round(sizes.next() * 180),
      lastSize: 1 + Math.floor(sizes.next() * 10),
      open,
      high: round(Math.max(open, last, close) * (1 + 0.04 * r.next()), 2),
      low: Math.max(0.01, round(Math.min(open, last, close) * (1 - 0.04 * r.next()), 2)),
      close,
      volume: Math.round(r.next() * r.next() * 12_000 * Math.exp(-dist * 12)),
      openInterest: Math.round(r.next() * 30_000 * Math.exp(-dist * 8) + 200),
      iv: round(iv, 4),
      delta: round(model.delta, 4),
      gamma: round(model.gamma, 5),
      vega: round(model.vega, 4),
      theta: round(model.theta, 4),
      undPrice: S,
      lastTime: this.clock(),
      marketDataType: 1,
    };
  }

  /** A 10-level book around the current quote; null where IB has no depth (indices). */
  book(c: ContractRef, rows = 10): DemoBook | null {
    if (c.secType === 'IND' || c.secType === 'BAG') return null;
    const q = this.quote(c);
    if (!q || q.bid == null || q.ask == null) return null;
    const option = c.secType === 'OPT' || c.secType === 'FOP';
    const tick = 0.01;
    const rng = this.instrument(c.symbol).rng;
    const size = (i: number) => (option ? 1 + Math.round(rng.next() * 60 * (1 + i / 3)) : 100 * (1 + Math.floor(rng.next() * 18 * (1 + i / 4))));
    const bids: DepthLevel[] = [];
    const asks: DepthLevel[] = [];
    for (let i = 0; i < rows; i++) {
      const b = roundTick(q.bid - i * tick, tick);
      const bidSize = i === 0 && q.bidSize ? q.bidSize : size(i);
      const askSize = i === 0 && q.askSize ? q.askSize : size(i);
      if (b > 0) bids.push({ price: b, size: bidSize, marketMaker: EXCHANGES[(i * 3 + Math.floor(rng.next() * 4)) % EXCHANGES.length] });
      asks.push({ price: roundTick(q.ask + i * tick, tick), size: askSize, marketMaker: EXCHANGES[(i * 7 + Math.floor(rng.next() * 4)) % EXCHANGES.length] });
    }
    return { bids, asks };
  }

  /** Option chain definition: weeklies, monthlies, quarterlies and LEAPS; strikes around the price. */
  chainParams(underlying: ContractRef): OptionChainParams[] {
    const inst = this.instrument(underlying.symbol);
    return [
      {
        exchange: 'SMART',
        underlyingConId: underlying.conId ?? 0,
        tradingClass: underlying.symbol.toUpperCase(),
        multiplier: 100,
        expirations: demoExpirations(this.clock()),
        strikes: demoStrikes(inst.anchor),
      },
    ];
  }

  /** Bars ending at the current simulated price, deterministic per symbol and timeframe. */
  bars(c: ContractRef, timeframe: Timeframe, opts: { outsideRth?: boolean; whatToShow?: string } = {}): Bar[] {
    const now = this.clock();
    const series = this.seriesFor(c);
    if (opts.whatToShow === 'OPTION_IMPLIED_VOLATILITY' || opts.whatToShow === 'HISTORICAL_VOLATILITY') {
      const inst = this.instrument(c.symbol);
      const target = opts.whatToShow === 'HISTORICAL_VOLATILITY' ? inst.histVol : smileVol(inst.vol, 1, 1, 30);
      const days = isIntraday(timeframe) ? 252 : 504;
      return volatilityBars(c.symbol + opts.whatToShow, target, days, now);
    }
    const intraday = DEMO_INTRADAY[timeframe];
    if (intraday) {
      const bars = intradayBars(series, intraday.barSec, intraday.sessions, now, !!opts.outsideRth);
      return timeframe === '45s' ? mergeIntraday(bars, 45) : bars;
    }
    switch (timeframe) {
      case '1W':
        return periodBars(series, 'week', 522, now);
      case '1M':
        return periodBars(series, 'month', 240, now);
      case '1Q':
        return aggregateQuarters(periodBars(series, 'month', 240, now));
      case '1Y':
        return aggregateYears(periodBars(series, 'month', 240, now));
      default:
        return dailyBars(series, 504, now);
    }
  }

  private seriesFor(c: ContractRef): Series {
    if (c.secType === 'OPT' || c.secType === 'FOP') {
      const q = this.optionQuote(c);
      const { S, model } = this.optionModel(c);
      const leverage = q.last ? Math.abs(model.delta) * (S / q.last) : 1;
      return {
        seed: contractKey(c),
        price: q.last ?? 0.01,
        prevClose: q.close ?? q.last ?? 0.01,
        open: q.open ?? q.last ?? 0.01,
        high: q.high ?? q.last ?? 0.01,
        low: q.low ?? q.last ?? 0.01,
        volume: q.volume ?? 0,
        avgVolume: Math.max(q.volume ?? 0, 100),
        vol: Math.min(3, Math.max(0.6, (q.iv ?? 0.4) * leverage)),
        decimals: 2,
        hasVolume: true,
      };
    }
    const inst = this.instrument(c.symbol);
    return {
      seed: inst.symbol,
      price: inst.price,
      prevClose: inst.prevClose,
      open: inst.open,
      high: inst.high,
      low: inst.low,
      volume: c.secType === 'IND' ? 0 : inst.volume,
      avgVolume: c.secType === 'IND' ? 0 : inst.avgVolume,
      vol: inst.vol,
      decimals: inst.decimals,
      hasVolume: c.secType !== 'IND',
    };
  }
}

// ---------------------------------------------------------------------------
// Option chain shape

export function demoExpirations(now: number): string[] {
  const today = nyDay(now);
  const start: CalendarDay = { y: today.y, m: today.m, d: today.d };
  const out = new Set<string>();
  // Weekly Fridays for 8 weeks (today counts until the close).
  let d = start;
  if (weekday(d) === 5 && today.minutes >= RTH_CLOSE) d = addDays(d, 1);
  while (weekday(d) !== 5) d = addDays(d, 1);
  for (let i = 0; i < 8; i++) out.add(yyyymmdd(addDays(d, i * 7)));
  // Monthly third Fridays for 9 months, quarterlies (Mar/Jun/Sep/Dec) for 2 years, LEAPS in January.
  const todayKey = yyyymmdd(start);
  for (let i = 0; i <= 36; i++) {
    const m0 = start.m - 1 + i;
    const y = start.y + Math.floor(m0 / 12);
    const m = (m0 % 12) + 1;
    const key = yyyymmdd(thirdFriday(y, m));
    if (key < todayKey) continue;
    if (i <= 9 || (i <= 24 && m % 3 === 0) || m === 1) out.add(key);
  }
  return [...out].sort();
}

function strikeStep(price: number): number {
  if (price > 10_000) return 25;
  if (price > 1_000) return 5;
  if (price > 400) return 5;
  if (price > 150) return 2.5;
  if (price > 25) return 1;
  return 0.5;
}

export function demoStrikes(price: number): number[] {
  const step = strikeStep(price);
  const lo = Math.max(step, Math.floor((price * 0.5) / step) * step);
  const hi = Math.ceil((price * 1.6) / step) * step;
  const out: number[] = [];
  for (let k = lo; k <= hi + 1e-9; k += step) out.push(Number(k.toFixed(2)));
  return out;
}

// ---------------------------------------------------------------------------
// Bars

interface Series {
  seed: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  avgVolume: number;
  vol: number;
  decimals: number;
  hasVolume: boolean;
}

function makeBar(time: number, open: number, close: number, wick: number, volume: number, decimals: number, rng: Rng): Bar {
  const high = Math.max(open, close) * (1 + Math.abs(rng.normal()) * wick);
  const low = Math.min(open, close) * (1 - Math.abs(rng.normal()) * wick);
  return { time, open: round(open, decimals), high: round(high, decimals), low: round(low, decimals), close: round(close, decimals), volume: Math.max(0, Math.round(volume)) };
}

/**
 * Starts (unix s) of the bars of `barSec` in one session: the open, then the epoch grid up to the
 * close, as IB stamps them (the regular-hours 1-hour bars start with a 09:30 stub, 2 to 4-hour
 * bars on the UTC grid with a partial bar at the open).
 */
export function sessionBarStarts(day: CalendarDay, barSec: number, outsideRth: boolean): number[] {
  const open = nyWallToEpochMs(day, outsideRth ? EXT_OPEN : RTH_OPEN) / 1000;
  const close = nyWallToEpochMs(day, outsideRth ? EXT_CLOSE : RTH_CLOSE) / 1000;
  const out = [open];
  for (let t = Math.floor(open / barSec) * barSec + barSec; t < close; t += barSec) out.push(t);
  return out;
}

const EXT_OPEN = 240;
const EXT_CLOSE = 1200;

/** Relative intraday volume: higher at the open and the close. */
const volumeShape = (m: number) => {
  if (m < RTH_OPEN || m >= RTH_CLOSE) return 0.12;
  const x = (m - RTH_OPEN) / (RTH_CLOSE - RTH_OPEN);
  return 0.6 + 2.2 * (x - 0.5) ** 2 * 4;
};

/**
 * Trades per second (regular / extended hours) for bars below a minute: like IB's, a bucket
 * without trades is a flat bar at the previous close with no volume.
 */
const TRADES_PER_SEC = { rth: 0.9, ext: 0.03 };

/** Intraday bars of `barSec` over the last `sessions` sessions, ending at the current price. */
function intradayBars(s: Series, barSec: number, sessions: number, now: number, outsideRth: boolean): Bar[] {
  const latest = latestSession(now);
  const nowSec = now / 1000;
  const days: CalendarDay[] = [latest.day];
  while (days.length < sessions) days.push(previousWeekday(days[days.length - 1]));
  days.reverse();
  const minutes = barSec / 60;
  const sigma = s.vol * Math.sqrt(minutes / (252 * 390));
  const wick = sigma * 0.6;
  const volPerMinute = s.avgVolume / 390;
  const rng = new Rng(hashString(`${s.seed}:${barSec}:${outsideRth ? 1 : 0}:${yyyymmdd(latest.day)}`));
  // New York midnight once per day (a 1-second series has 57,600 bars a session; the time zone
  // lookup per bar took about half a second).
  const midnights = new Map<CalendarDay, number>();
  const midnightOf = (day: CalendarDay) => {
    let t = midnights.get(day);
    if (t === undefined) midnights.set(day, (t = nyWallToEpochMs(day, 0) / 1000));
    return t;
  };
  const minuteOf = (day: CalendarDay, t: number) => (t - midnightOf(day)) / 60;
  const regular = (m: number) => m >= RTH_OPEN && m < RTH_CLOSE;
  /** Whether a bucket below a minute had trades (always for minute and longer bars). */
  const traded = (m: number) => barSec >= 60 || rng.next() < 1 - Math.exp(-barSec * (regular(m) ? TRADES_PER_SEC.rth : TRADES_PER_SEC.ext));
  const volume = (m: number) => (s.hasVolume ? volPerMinute * minutes * volumeShape(m) * Math.exp(0.35 * rng.normal()) : 0);

  // Today's bars (up to now) bridge from the session open to the current price.
  const todayStarts = sessionBarStarts(latest.day, barSec, outsideRth).filter((t) => t <= nowSec);
  const todayRegular = todayStarts.filter((t) => regular(minuteOf(latest.day, t)));
  const steps = todayRegular.map(() => rng.normal() * sigma);
  const walk: number[] = [];
  steps.reduce((acc, z, i) => (walk[i] = acc + z), 0);
  const target = Math.log(s.price / s.open);
  const n = walk.length;
  const todayCloses = new Map<number, number>();
  todayRegular.forEach((t, i) => todayCloses.set(t, s.open * Math.exp(walk[i] + ((i + 1) / n) * (target - walk[n - 1]))));

  // Earlier sessions walk backwards from the previous close.
  const earlier: Array<{ day: CalendarDay; t: number; m: number; first: boolean; trades: boolean }> = [];
  for (const day of days.slice(0, -1)) {
    sessionBarStarts(day, barSec, outsideRth).forEach((t, i) => {
      const m = minuteOf(day, t);
      earlier.push({ day, t, m, first: i === 0, trades: traded(m) });
    });
  }
  const closes: number[] = new Array(earlier.length);
  let c = s.prevClose;
  for (let i = earlier.length - 1; i >= 0; i--) {
    closes[i] = c;
    if (earlier[i].trades) c = c / Math.exp(rng.normal() * sigma * (regular(earlier[i].m) ? 1 : 0.5));
  }

  const bars: Bar[] = [];
  const flat = (time: number, price: number): Bar => ({ time, open: round(price, s.decimals), high: round(price, s.decimals), low: round(price, s.decimals), close: round(price, s.decimals), volume: 0 });
  let prev = c;
  earlier.forEach(({ t, m, first, trades }, i) => {
    if (!trades) bars.push(flat(t, prev));
    else bars.push(makeBar(t, first ? prev * Math.exp(rng.normal() * sigma * 2) : prev, closes[i], wick, volume(m), s.decimals, rng));
    prev = closes[i];
  });
  // Extended-hours bars of the current day before the open drift from the previous close to the open.
  let last = s.prevClose;
  for (const t of todayStarts) {
    const m = minuteOf(latest.day, t);
    if (!traded(m)) {
      bars.push(flat(t, last));
      continue;
    }
    let close: number;
    if (m < RTH_OPEN) close = s.prevClose + ((s.open - s.prevClose) * (m - EXT_OPEN + minutes)) / (RTH_OPEN - EXT_OPEN);
    else if (m >= RTH_CLOSE) close = s.price * Math.exp(rng.normal() * sigma * 0.3);
    else close = todayCloses.get(t) ?? s.price;
    const open = m === RTH_OPEN ? s.open : last;
    bars.push(makeBar(t, open, close, wick, volume(m), s.decimals, rng));
    last = close;
  }
  // The live bar closes at the current price.
  if (bars.length && latest.live) {
    const b = bars[bars.length - 1];
    b.close = round(s.price, s.decimals);
    b.high = Math.max(b.high, b.close);
    b.low = Math.min(b.low, b.close);
  }
  return bars;
}

const DRIFT = 0.08; // annual drift of the backward walks

function dailyBars(s: Series, count: number, now: number): Bar[] {
  const latest = latestSession(now);
  const days: CalendarDay[] = [latest.day];
  while (days.length < count) days.push(previousWeekday(days[days.length - 1]));
  days.reverse();
  const sigma = s.vol / Math.sqrt(252);
  const rng = new Rng(hashString(`${s.seed}:1D:${yyyymmdd(latest.day)}`));
  const closes: number[] = new Array(days.length);
  closes[days.length - 1] = s.price;
  let c = s.prevClose;
  for (let i = days.length - 2; i >= 0; i--) {
    closes[i] = c;
    c = c / Math.exp(DRIFT / 252 + rng.normal() * sigma);
  }
  const bars: Bar[] = [];
  let prev = c;
  days.forEach((day, i) => {
    if (i === days.length - 1) {
      bars.push({
        time: dayStamp(day),
        open: s.open,
        high: round(Math.max(s.high, s.open, s.price), s.decimals),
        low: round(Math.min(s.low, s.open, s.price), s.decimals),
        close: round(s.price, s.decimals),
        volume: s.hasVolume ? s.volume : 0,
      });
      return;
    }
    const open = prev * Math.exp(rng.normal() * sigma * 0.3);
    const vol = s.hasVolume ? s.avgVolume * Math.exp(0.35 * rng.normal()) : 0;
    bars.push(makeBar(dayStamp(day), open, closes[i], sigma * 0.5, vol, s.decimals, rng));
    prev = closes[i];
  });
  return bars;
}

function periodBars(s: Series, period: 'week' | 'month', count: number, now: number): Bar[] {
  const latest = latestSession(now).day;
  const starts: CalendarDay[] = [];
  let d: CalendarDay = period === 'week' ? addDays(latest, -((weekday(latest) + 6) % 7)) : { y: latest.y, m: latest.m, d: 1 };
  for (let i = 0; i < count; i++) {
    starts.push(d);
    d = period === 'week' ? addDays(d, -7) : d.m === 1 ? { y: d.y - 1, m: 12, d: 1 } : { y: d.y, m: d.m - 1, d: 1 };
  }
  starts.reverse();
  const perYear = period === 'week' ? 52 : 12;
  const sigma = s.vol / Math.sqrt(perYear);
  const rng = new Rng(hashString(`${s.seed}:${period}:${yyyymmdd(latest)}`));
  const closes: number[] = new Array(starts.length);
  let c = s.price;
  for (let i = starts.length - 1; i >= 0; i--) {
    closes[i] = c;
    c = c / Math.exp(DRIFT / perYear + rng.normal() * sigma);
  }
  const days = period === 'week' ? 5 : 21;
  let prev = c;
  return starts.map((start, i) => {
    const vol = s.hasVolume ? s.avgVolume * days * Math.exp(0.3 * rng.normal()) : 0;
    const bar = makeBar(dayStamp(start), prev, closes[i], sigma * 0.5, vol, s.decimals, rng);
    prev = closes[i];
    return bar;
  });
}

/** Daily implied / historical volatility series (fractions) ending at `target`. */
function volatilityBars(seed: string, target: number, count: number, now: number): Bar[] {
  const latest = latestSession(now).day;
  const days: CalendarDay[] = [latest];
  while (days.length < count) days.push(previousWeekday(days[days.length - 1]));
  days.reverse();
  const rng = new Rng(hashString(`${seed}:${yyyymmdd(latest)}`));
  const xs: number[] = [];
  let x = rng.normal() * 0.25;
  for (let i = 0; i < days.length; i++) {
    x += -0.04 * x + 0.07 * rng.normal();
    xs.push(x);
  }
  const end = xs[xs.length - 1];
  let prev = target * Math.exp(xs[0] - end);
  return days.map((day, i) => {
    const close = target * Math.exp(xs[i] - end);
    const bar = makeBar(dayStamp(day), prev, close, 0.02, 0, 4, rng);
    prev = close;
    return bar;
  });
}

let shared: DemoMarket | null = null;

/** The process-wide simulator, so quotes, bars, depth and chains agree on prices. */
export function demoMarket(): DemoMarket {
  shared ??= new DemoMarket();
  return shared;
}
