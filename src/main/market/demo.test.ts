import { describe, expect, it } from 'vitest';
import { index, option, stock } from '@shared/contract';
import { TIMEFRAMES } from '@shared/timeframes';
import type { Timeframe } from '@shared/types';
import { DemoMarket, demoContractInfo, demoExpirations, demoSearch, demoStrikes, hashString } from './demo';
import { parseYyyymmdd, weekday } from './nyTime';

// Tuesday 2026-10-06 11:00 ET (market open) and Sunday 2026-10-04 (closed).
const OPEN = Date.UTC(2026, 9, 6, 15, 0);
const SUNDAY = Date.UTC(2026, 9, 4, 15, 0);

describe('demo quotes', () => {
  it('starts at the design prices with the design change', () => {
    const m = new DemoMarket(() => OPEN);
    const q = m.quote(stock('AAPL'))!;
    expect(q.last).toBe(227.48);
    expect(((q.last! / q.close!) - 1) * 100).toBeCloseTo(1.32, 1);
    expect(q.bid!).toBeLessThan(q.ask!);
    expect(q.marketDataType).toBe(1);
    expect(q.lastRthTrade).toBe(227.48);
    const spx = m.quote(index('SPX', 'CBOE'))!;
    expect(spx.last).toBe(5712.3);
    expect(spx.bid).toBeUndefined();
    expect(spx.volume).toBeUndefined();
  });

  it('adds an IB-style dividend summary to stocks for the dividends profile', () => {
    const m = new DemoMarket(() => OPEN);
    expect(m.quote(stock('AAPL'), ['basic'])!.dividends).toBeUndefined();
    expect(m.quote(index('SPX', 'CBOE'), ['dividends'])!.dividends).toBeUndefined();
    const syms = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'META', 'KO', 'JPM', 'XOM', 'AMZN', 'GOOGL'];
    const all = syms.map((s) => m.quote(stock(s), ['dividends'])!.dividends!);
    // The same object every time, so republished quotes do not resend it.
    expect(m.quote(stock('AAPL'), ['dividends'])!.dividends).toBe(all[0]);
    const paying = all.filter((d) => d.nextDate);
    expect(paying.length).toBeGreaterThan(0);
    expect(all.some((d) => Object.keys(d).length === 0)).toBe(true);
    for (const d of paying) {
      expect(d.nextDate! > '20261006').toBe(true);
      expect(d.nextAmount).toBeGreaterThan(0);
    }
  });

  it('adds underlying statistics only for that profile', () => {
    const m = new DemoMarket(() => OPEN);
    expect(m.quote(stock('NVDA'), ['basic'])!.impliedVol).toBeUndefined();
    const u = m.quote(stock('NVDA'), ['underlying'])!;
    expect(u.impliedVol).toBeCloseTo(0.48, 2);
    expect(u.week52High!).toBeGreaterThan(u.week52Low!);
    expect(u.callVolume).toBeGreaterThan(0);
    expect(u.putOpenInterest).toBeGreaterThan(0);
  });

  it('returns the same quote until the next tick', () => {
    const m = new DemoMarket(() => OPEN);
    m.advance(['AAPL']);
    expect(m.quote(stock('AAPL'))).toEqual(m.quote(stock('AAPL')));
    expect(m.quote(option('AAPL', '20261016', 230, 'C'))).toEqual(m.quote(option('AAPL', '20261016', 230, 'C')));
  });

  it('gives unknown symbols a stable hash-based price', () => {
    const a = new DemoMarket(() => OPEN).quote(stock('ZZZQ'))!.last;
    const b = new DemoMarket(() => OPEN).quote(stock('ZZZQ'))!.last;
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(10);
    expect(a).toBeLessThanOrEqual(500);
  });

  it('walks reproducibly and stays near the anchor', () => {
    const a = new DemoMarket(() => OPEN);
    const b = new DemoMarket(() => OPEN);
    for (let i = 0; i < 500; i++) {
      a.advance(['TSLA']);
      b.advance(['TSLA']);
      b.quote(stock('TSLA')); // reading quotes must not change the path
    }
    expect(a.price('TSLA')).toBe(b.price('TSLA'));
    expect(Math.abs(a.price('TSLA') / 251.03 - 1)).toBeLessThan(0.1);
  });

  it('prices options with Black–Scholes greeks', () => {
    const m = new DemoMarket(() => OPEN);
    const call = m.quote(option('AAPL', '20261016', 230, 'C'))!;
    const put = m.quote(option('AAPL', '20261016', 230, 'P'))!;
    expect(call.undPrice).toBe(227.48);
    expect(call.delta!).toBeGreaterThan(0.3);
    expect(call.delta!).toBeLessThan(0.6);
    expect(put.delta!).toBeLessThan(0);
    expect(call.gamma!).toBeGreaterThan(0);
    expect(call.theta!).toBeLessThan(0);
    expect(call.iv!).toBeGreaterThan(0.2);
    expect(put.iv!).toBeGreaterThan(call.iv!); // puts carry the skew premium
    expect(call.bid!).toBeLessThan(call.ask!);
    expect(call.openInterest!).toBeGreaterThan(0);
    // Roughly at the money: call − put ≈ S − K·e^(−rT).
    expect(call.mark! - put.mark!).toBeCloseTo(227.48 - 230, 0);
  });

  it('does not simulate combos', () => {
    expect(new DemoMarket(() => OPEN).quote({ symbol: 'X', secType: 'BAG', exchange: 'SMART', currency: 'USD' })).toBeNull();
  });
});

describe('demo bars', () => {
  const m = new DemoMarket(() => OPEN);

  it('ends daily bars at the quote and the previous close', () => {
    const bars = m.bars(stock('AAPL'), '1D');
    const q = m.quote(stock('AAPL'))!;
    expect(bars.length).toBe(504);
    expect(bars[bars.length - 1].close).toBe(q.last);
    expect(bars[bars.length - 1].open).toBe(q.open);
    expect(bars[bars.length - 2].close).toBe(q.close);
    expect(bars[bars.length - 1].time).toBe(Date.UTC(2026, 9, 6) / 1000);
  });

  it('produces consistent, ordered OHLC for every timeframe', () => {
    const counts: Partial<Record<Timeframe, number>> = { '1m': 390 + 91, '5m': 9 * 78 + 19, '1h': 69 * 7 + 3, '1W': 522, '1M': 240, '1Y': 21 };
    for (const tf of TIMEFRAMES) {
      const bars = m.bars(stock('NVDA'), tf);
      if (counts[tf]) expect(bars.length, tf).toBe(counts[tf]);
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        expect(b.high, tf).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
        expect(b.low, tf).toBeLessThanOrEqual(Math.min(b.open, b.close));
        expect(b.low, tf).toBeGreaterThan(0);
        if (i) expect(b.time, tf).toBeGreaterThan(bars[i - 1].time);
      }
      expect(bars[bars.length - 1].close, tf).toBe(m.price('NVDA'));
    }
  });

  it('stamps intraday bars at New York session times', () => {
    const bars = m.bars(stock('AAPL'), '5m');
    // First bar of the earliest session at 09:30 ET.
    const first = new Date(bars[0].time * 1000);
    expect([first.getUTCHours(), first.getUTCMinutes()]).toEqual([13, 30]);
    const ext = m.bars(stock('AAPL'), '5m', { outsideRth: true });
    expect(ext.length).toBeGreaterThan(bars.length);
  });

  it('generates every interval on IB\'s grid, seconds with flat bars where nothing traded', () => {
    const ny = (hhmm: string, date = '2026-10-06', offset = '-04:00') => Date.parse(`${date}T${hhmm}:00${offset}`) / 1000;
    // 1 s: today's session from 04:00 (extended hours) to now, one bar per second.
    const s1 = m.bars(stock('AAPL'), '1s', { outsideRth: true });
    expect(s1[0].time).toBe(ny('04:00'));
    expect(s1.at(-1)!.time).toBe(ny('11:00'));
    expect(s1).toHaveLength(7 * 3600 + 1);
    const flat = s1.filter((b) => b.volume === 0);
    expect(flat.length).toBeGreaterThan(s1.length / 3); // sparse pre-market trading
    expect(flat.every((b) => b.open === b.close && b.high === b.low)).toBe(true);
    // 45 s: 15-second bars merged on the grid, the open on a bucket line.
    const s45 = m.bars(stock('AAPL'), '45s', { outsideRth: true });
    expect(s45.every((b) => b.time % 45 === 0)).toBe(true);
    expect(s45.some((b) => b.time === ny('09:30'))).toBe(true);
    // 2 h on the UTC grid: 04:00 and every even UTC hour in summer.
    const h2 = m.bars(stock('AAPL'), '2h', { outsideRth: true }).filter((b) => b.time >= ny('00:00', '2026-10-05') && b.time < ny('00:00'));
    expect(h2.map((b) => (b.time - ny('00:00', '2026-10-05')) / 3600)).toEqual([4, 6, 8, 10, 12, 14, 16, 18]);
    // In winter the open is a partial bar before the grid (04:00, 05:00, 07:00 … New York).
    const winter = new DemoMarket(() => Date.UTC(2026, 0, 17, 15, 0)).bars(stock('AAPL'), '2h', { outsideRth: true });
    const jan16 = ny('00:00', '2026-01-16', '-05:00');
    expect(winter.filter((b) => b.time >= jan16).map((b) => (b.time - jan16) / 3600)).toEqual([4, 5, 7, 9, 11, 13, 15, 17, 19]);
    // Quarters stamped with their first day.
    const q = m.bars(stock('AAPL'), '1Q');
    expect(q.at(-1)!.time).toBe(Date.UTC(2026, 9, 1) / 1000);
    expect(q.at(-2)!.time).toBe(Date.UTC(2026, 6, 1) / 1000);
  });

  it('is deterministic across instances', () => {
    const a = new DemoMarket(() => SUNDAY).bars(stock('MSFT'), '1W');
    const b = new DemoMarket(() => SUNDAY).bars(stock('MSFT'), '1W');
    expect(a).toEqual(b);
    expect(new Date(a[a.length - 1].time * 1000).getUTCDay()).toBe(1); // Monday
  });

  it('serves volatility series as fractions', () => {
    const iv = m.bars(stock('AAPL'), '1D', { whatToShow: 'OPTION_IMPLIED_VOLATILITY' });
    expect(iv[iv.length - 1].close).toBeCloseTo(0.26, 3);
    expect(Math.max(...iv.map((b) => b.high))).toBeLessThan(1);
  });

  it('charts options too', () => {
    const bars = m.bars(option('AAPL', '20261016', 230, 'C'), '1D');
    expect(bars[bars.length - 1].close).toBe(m.quote(option('AAPL', '20261016', 230, 'C'))!.last);
  });
});

describe('demo depth', () => {
  it('builds a 10-level book around the quote', () => {
    const m = new DemoMarket(() => OPEN);
    const book = m.book(stock('AAPL'))!;
    const q = m.quote(stock('AAPL'))!;
    expect(book.bids).toHaveLength(10);
    expect(book.asks).toHaveLength(10);
    expect(book.bids[0]).toMatchObject({ price: q.bid, size: q.bidSize });
    expect(book.asks[0]).toMatchObject({ price: q.ask, size: q.askSize });
    for (let i = 1; i < 10; i++) {
      expect(book.bids[i].price).toBeLessThan(book.bids[i - 1].price);
      expect(book.asks[i].price).toBeGreaterThan(book.asks[i - 1].price);
    }
    expect(m.book(index('SPX', 'CBOE'))).toBeNull();
  });
});

describe('demo option chains', () => {
  it('lists weeklies, monthlies, quarterlies and LEAPS', () => {
    const exps = demoExpirations(SUNDAY);
    expect(exps).toEqual([...exps].sort());
    expect(new Set(exps).size).toBe(exps.length);
    for (const e of exps) expect(weekday(parseYyyymmdd(e))).toBe(5);
    expect(exps.slice(0, 8)).toEqual(['20261009', '20261016', '20261023', '20261030', '20261106', '20261113', '20261120', '20261127']);
    expect(exps).toContain('20261218');
    expect(exps).toContain('20270319');
    expect(exps).toContain('20280121');
    expect(exps).toContain('20290119');
    expect(Number(exps[exps.length - 1].slice(0, 4))).toBeGreaterThanOrEqual(2028);
  });

  it('spaces strikes by price', () => {
    const aapl = demoStrikes(227.48);
    expect(aapl[1] - aapl[0]).toBe(2.5);
    expect(aapl[0]).toBeLessThanOrEqual(227.48 * 0.5 + 2.5);
    expect(aapl[aapl.length - 1]).toBeGreaterThanOrEqual(227.48 * 1.6);
    expect(demoStrikes(19.82)[1] - demoStrikes(19.82)[0]).toBe(0.5);
    expect(demoStrikes(5712.3)[1] - demoStrikes(5712.3)[0]).toBe(5);
  });

  it('returns one SMART chain', () => {
    const chains = new DemoMarket(() => SUNDAY).chainParams(stock('AAPL'));
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ exchange: 'SMART', tradingClass: 'AAPL', multiplier: 100 });
  });
});

describe('offline search and details', () => {
  it('searches symbols and names', () => {
    expect(demoSearch('aap')[0].contract.symbol).toBe('AAPL');
    expect(demoSearch('nvidia')[0].contract.symbol).toBe('NVDA');
    expect(demoSearch('SPX')[0].contract).toMatchObject({ secType: 'IND', exchange: 'CBOE' });
    expect(demoSearch('  ')).toEqual([]);
  });

  it('answers contract details without a made-up conId', () => {
    const info = demoContractInfo(stock('AAPL'))!;
    expect(info).toMatchObject({ longName: 'APPLE INC', industry: 'Technology', minTick: 0.01 });
    expect(info.contract.conId).toBeUndefined();
    expect(demoContractInfo(index('SPX', 'CBOE'))!.longName).toBe('S&P 500 Stock Index');
    expect(demoContractInfo({ symbol: 'NOPE!', secType: 'STK', exchange: 'SMART', currency: 'USD' })).toBeNull();
  });

  it('hashes strings stably', () => {
    expect(hashString('AAPL')).toBe(hashString('AAPL'));
    expect(hashString('AAPL')).not.toBe(hashString('AAPM'));
  });
});
