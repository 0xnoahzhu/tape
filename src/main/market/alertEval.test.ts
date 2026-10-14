import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import type { AlertRule, PriceAlert, Quote } from '@shared/types';
import {
  alertSignature,
  alertSubscriptions,
  alertTexts,
  cooldownMs,
  COOLDOWN_MS,
  gate,
  initialGate,
  isTriggered,
  measure,
  newsTexts,
  REARM_BAND,
  type GateState,
  type Measure,
  type MeasureContext,
} from './alertEval';

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: 'a1',
  contract: stock('NVDA'),
  rule: { type: 'priceBelow', value: 120 },
  frequency: 'once',
  createdAt: 0,
  active: true,
  ...over,
});

const q = (fields: Partial<Quote>): Quote => ({ key: 'STK:NVDA', updatedAt: 0, marketDataType: 1, ...fields });
const regular: MeasureContext = { session: 'regular' };

/** Runs a path of quotes through one alert (one per second from `t0`); returns the indices it fired at. */
function run(a: PriceAlert, quotes: Array<Partial<Quote>>, opts: { state?: GateState; t0?: number; step?: number; ctx?: MeasureContext } = {}): number[] {
  const fired: number[] = [];
  let state = opts.state ?? initialGate(a, false);
  let current = a;
  quotes.forEach((fields, i) => {
    const now = (opts.t0 ?? 1_760_000_000_000) + i * (opts.step ?? 1000);
    const r = gate(current, measure(current.rule, q(fields), opts.ctx ?? regular), state, now);
    state = r.state;
    if (r.fire) {
      fired.push(i);
      if (current.frequency === 'once') current = { ...current, active: false };
    }
  });
  return fired;
}

const prices = (...xs: number[]) => xs.map((last) => ({ last }));

describe('measure', () => {
  it('compares the last price (else the mid) with a level, and re-arms a band and a tick back', () => {
    expect(measure({ type: 'priceAbove', value: 100 }, q({ last: 100 }), regular)).toMatchObject({ value: 100, met: true, rearm: false });
    expect(measure({ type: 'priceAbove', value: 100 }, q({ bid: 99, ask: 99.5 }), regular)).toMatchObject({ value: 99.25, met: false, rearm: true });
    // Within the band: neither met nor re-armed.
    expect(measure({ type: 'priceAbove', value: 100 }, q({ last: 100 * (1 - REARM_BAND / 2) }), regular)).toMatchObject({ met: false, rearm: false });
    // A tick wider than the band: the price has to go back a whole tick.
    expect(measure({ type: 'priceBelow', value: 10 }, q({ last: 10.006 }), { ...regular, minTick: 0.01 })).toMatchObject({ met: false, rearm: false });
    expect(measure({ type: 'priceBelow', value: 10 }, q({ last: 10.01 }), { ...regular, minTick: 0.01 })).toMatchObject({ met: false, rearm: true });
  });

  it('reads bid and ask, and takes no ask (0 or none) as no offer', () => {
    expect(measure({ type: 'bidAbove', value: 50 }, q({ bid: 50.1, last: 49 }), regular)).toMatchObject({ value: 50.1, met: true });
    expect(measure({ type: 'askBelow', value: 50 }, q({ ask: 0, last: 10 }), regular)).toEqual({ met: false, rearm: false });
    expect(measure({ type: 'askBelow', value: 50 }, q({ last: 10 }), regular).met).toBe(false);
    expect(measure({ type: 'askBelow', value: 50 }, q({ ask: 49.9 }), regular)).toMatchObject({ value: 49.9, met: true });
  });

  it("measures the day's change against the previous close, and after the close against today's close", () => {
    const quote = q({ last: 236, close: 224, lastRthTrade: 230 });
    const pre = measure({ type: 'dayRise', pct: 5 }, quote, { session: 'pre' });
    expect(pre.value).toBeCloseTo((236 / 224 - 1) * 100);
    expect(pre).toMatchObject({ met: true, afterHours: false });
    // After hours the chart header shows +2.61% on today's close: that is what counts.
    const post = measure({ type: 'dayRise', pct: 5 }, quote, { session: 'post' });
    expect(post.value).toBeCloseTo((236 / 230 - 1) * 100);
    expect(post).toMatchObject({ met: false, afterHours: true });
    expect(measure({ type: 'dayRise', pct: 2 }, quote, { session: 'overnight' })).toMatchObject({ met: true, afterHours: true });
    const fall = measure({ type: 'dayFall', pct: 3 }, q({ last: 96, close: 100 }), regular);
    expect(fall.value).toBeCloseTo(-4);
    expect(fall).toMatchObject({ met: true, rearm: false });
    // Without a previous close nothing is measured (a new line before tick 9).
    expect(measure({ type: 'dayFall', pct: 3 }, q({ last: 96 }), regular)).toEqual({ met: false, rearm: false });
  });

  it('re-arms percent rules max(0.2, 10 %) points back', () => {
    expect(measure({ type: 'dayRise', pct: 5 }, q({ last: 104.4, close: 100 }), regular).rearm).toBe(true);
    expect(measure({ type: 'dayRise', pct: 5 }, q({ last: 104.55, close: 100 }), regular).rearm).toBe(false);
    expect(measure({ type: 'windowFall', minutes: 3, pct: 1 }, q({}), { ...regular, windowPct: -0.85 })).toMatchObject({ met: false, rearm: false });
    expect(measure({ type: 'windowFall', minutes: 3, pct: 1 }, q({}), { ...regular, windowPct: -0.79 })).toMatchObject({ met: false, rearm: true });
    expect(measure({ type: 'windowRise', minutes: 5, pct: 2 }, q({}), { ...regular, windowPct: 2.4 })).toMatchObject({ value: 2.4, met: true });
    expect(measure({ type: 'windowRise', minutes: 5, pct: 2 }, q({}), regular)).toEqual({ met: false, rearm: false });
  });

  it('reads volume, turnover (volume × VWAP) and sizes', () => {
    expect(measure({ type: 'volumeAbove', shares: 1e7 }, q({ volume: 1.02e7 }), regular)).toMatchObject({ value: 1.02e7, met: true, rearm: false });
    expect(measure({ type: 'turnoverAbove', amount: 1e9 }, q({ volume: 5e6, vwap: 210 }), regular)).toMatchObject({ value: 1.05e9, met: true });
    expect(measure({ type: 'turnoverAbove', amount: 1e9 }, q({ volume: 5e6 }), regular).value).toBeUndefined();
    expect(measure({ type: 'bidSizeAbove', shares: 5000 }, q({ bidSize: 3900 }), regular)).toMatchObject({ met: false, rearm: true });
    expect(measure({ type: 'askSizeAbove', shares: 5000 }, q({ askSize: 4500 }), regular)).toMatchObject({ met: false, rearm: false });
    // Nothing traded yet at IB's day roll, nobody bidding: values, not missing data.
    expect(measure({ type: 'volumeAbove', shares: 1e7 }, q({ volume: 0 }), regular)).toMatchObject({ value: 0, met: false, rearm: true });
    expect(measure({ type: 'bidSizeAbove', shares: 100 }, q({ bidSize: 0 }), regular)).toMatchObject({ value: 0, met: false });
    expect(measure({ type: 'bidSizeAbove', shares: 100 }, q({}), regular)).toEqual({ met: false, rearm: false });
  });

  it('sees a halt in the halt code, and a resumption only as a change from halted', () => {
    expect(measure({ type: 'halt', dir: 'halted' }, q({ haltCode: 2 }), regular)).toMatchObject({ met: true });
    expect(measure({ type: 'halt', dir: 'halted' }, q({ haltCode: 0 }), regular)).toMatchObject({ met: false, rearm: true });
    expect(measure({ type: 'halt', dir: 'resumed' }, q({ haltCode: 0 }), regular).met).toBe(false);
    expect(measure({ type: 'halt', dir: 'resumed' }, q({ haltCode: 0 }), { ...regular, prevHalt: 1 }).met).toBe(true);
    expect(measure({ type: 'halt', dir: 'resumed' }, q({}), { ...regular, prevHalt: 1 }).met).toBe(false);
  });
});

describe('gate', () => {
  it('fires a one-shot alert once when the price crosses, and at once when already met', () => {
    expect(run(alert({ rule: { type: 'priceAbove', value: 235 } }), prices(230, 234.99, 235, 236, 230, 240))).toEqual([2]);
    expect(run(alert({ rule: { type: 'priceBelow', value: 120 } }), prices(121, 120.5, 119.9, 125, 110))).toEqual([2]);
    expect(run(alert({ rule: { type: 'priceAbove', value: 100 } }), prices(118.62))).toEqual([0]);
  });

  it('fires an always-on alert on each crossing after it went back, at most once a minute', () => {
    const a = alert({ rule: { type: 'priceAbove', value: 100 }, frequency: 'always' });
    expect(run(a, prices(99, 101, 102, 98, 97, 100.5, 99, 101), { step: 60_000 })).toEqual([1, 5, 7]);
    // Every second: the second crossing waits for the cooldown.
    expect(run(a, prices(101, 98, 101, 101), { step: 20_000 })).toEqual([0, 3]);
    const bouncing = alert({ rule: { type: 'priceBelow', value: 100 }, frequency: 'always' });
    expect(run(bouncing, prices(99.9, ...Array(5).fill(100 * (1 + REARM_BAND / 2)), 99.9), { step: 60_000 })).toEqual([0]);
  });

  it('cools a 3 / 5-minute alert down for its window', () => {
    const a = alert({ rule: { type: 'windowRise', minutes: 3, pct: 1 }, frequency: 'always' });
    const at = (windowPct: number, now: number, s: GateState) => gate(a, measure(a.rule, q({}), { ...regular, windowPct }), s, now);
    let s = initialGate(a, false);
    let r = at(1.5, 0, s);
    expect(r.fire).toBe(true);
    s = at(0.5, 30_000, r.state).state;
    r = at(1.5, 60_000 + COOLDOWN_MS, s);
    expect(r.fire).toBe(false);
    expect(at(1.5, 180_000, r.state).fire).toBe(true);
  });

  it('fires a daily alert once per New York trading day, not at midnight in China', () => {
    const a = alert({ rule: { type: 'priceAbove', value: 100 }, frequency: 'daily' });
    const met = measure(a.rule, q({ last: 101 }), regular);
    // Tuesday 2026-10-13, 10:00 New York = 22:00 in Shanghai.
    let r = gate(a, met, initialGate(a, false), Date.parse('2026-10-13T10:00:00-04:00'));
    expect(r.fire).toBe(true);
    // Midnight in Shanghai is noon in New York, mid-session: still Tuesday's trading day.
    r = gate(a, met, r.state, Date.parse('2026-10-14T00:00:00+08:00'));
    expect(r.fire).toBe(false);
    r = gate(a, met, r.state, Date.parse('2026-10-13T19:59:00-04:00'));
    expect(r.fire).toBe(false);
    // Wednesday's trading day starts with IB's at 20:00 New York (the overnight session): from
    // then on, and at the 09:30 open, it may fire again.
    expect(gate(a, met, r.state, Date.parse('2026-10-13T20:00:00-04:00')).fire).toBe(true);
    expect(gate(a, met, r.state, Date.parse('2026-10-14T09:30:00-04:00')).fire).toBe(true);
  });

  it('keeps a daily alert quiet after a restart on the same trading day, unless the user changed it since', () => {
    const fired = Date.parse('2026-10-13T10:00:00-04:00');
    const later = Date.parse('2026-10-13T15:00:00-04:00');
    const a = alert({ rule: { type: 'priceAbove', value: 100 }, frequency: 'daily', lastTriggeredAt: fired });
    const met = measure(a.rule, q({ last: 101 }), regular);
    expect(gate(a, met, initialGate(a, true), later).fire).toBe(false);
    const resumed = { ...a, updatedAt: fired + 60_000 };
    expect(gate(resumed, met, initialGate(resumed, true), later).fire).toBe(true);
  });

  it('starts an always-on alert that fired before disarmed after a restart, until it goes back', () => {
    const a = alert({ rule: { type: 'priceAbove', value: 100 }, frequency: 'always', lastTriggeredAt: 5 });
    expect(run(a, prices(101, 98, 101), { state: initialGate(a, true), step: 60_000 })).toEqual([2]);
    // An edit or a new alert is armed: a condition already met fires at once.
    expect(run(a, prices(101), { state: initialGate(a, false) })).toEqual([0]);
    expect(run({ ...a, updatedAt: 10 }, prices(101), { state: initialGate({ ...a, updatedAt: 10 }, true) })).toEqual([0]);
  });

  it('fires nothing outside the sessions but keeps re-arming there', () => {
    const a = alert({ rule: { type: 'priceAbove', value: 100 }, frequency: 'always' });
    let r = gate(a, measure(a.rule, q({ last: 101 }), regular), initialGate(a, false), 0, false);
    expect(r.fire).toBe(false);
    r = gate(a, measure(a.rule, q({ last: 101 }), regular), r.state, 60_000);
    expect(r.fire).toBe(true);
    r = gate(a, measure(a.rule, q({ last: 98 }), regular), r.state, 120_000, false);
    expect(r.state.armed).toBe(true);
  });

  it('fires an indicator alert at most once per bar, and never on a cross from before it was armed', () => {
    const a = alert({ rule: { type: 'indicator', timeframe: '5m', on: 'live', signal: { ind: 'ma', kind: 'price', period: 3, cross: 'up' } }, frequency: 'always' });
    const m = (bar: number, closedBar: number, prev: number, cur: number): Measure => ({ value: 1, met: prev <= 0 && cur > 0, rearm: cur <= 0, bar, closedBar });
    // Armed with bar 300 closed: a cross on it (bar 300 vs 0) does not count.
    let r = gate(a, m(300, 300, -1, 1), initialGate(a, false), 0);
    expect(r.fire).toBe(false);
    r = gate(a, m(600, 300, -1, 1), r.state, 60_000);
    expect(r.fire).toBe(true);
    // Back and across again within the same bar: nothing.
    r = gate(a, m(600, 300, 1, -1), r.state, 200_000);
    r = gate(a, m(600, 300, -1, 1), r.state, 300_000);
    expect(r.fire).toBe(false);
    expect(gate(a, m(900, 600, -1, 1), r.state, 400_000).fire).toBe(true);
  });

  it('never fires a paused or unsupported alert', () => {
    expect(run(alert({ active: false, rule: { type: 'priceAbove', value: 1 } }), prices(5))).toEqual([]);
    expect(run(alert({ unsupported: true, rule: { type: 'priceAbove', value: 1 } }), prices(5))).toEqual([]);
  });
});

describe('alertSubscriptions', () => {
  it('asks one line per instrument of the active alerts, with the VWAP for a stock turnover alert', () => {
    const subs = alertSubscriptions([
      alert(),
      alert({ id: 'b', rule: { type: 'turnoverAbove', amount: 1e9 } }),
      alert({ id: 'c', contract: stock('AAPL'), active: false }),
      alert({ id: 'd', contract: stock('MSFT'), unsupported: true, active: false }),
      alert({ id: 'e', contract: option('NVDA', '20261016', 120, 'C'), rule: { type: 'volumeAbove', shares: 100 } }),
      alert({ id: 'f', contract: stock('TSLA'), rule: { type: 'news', providers: ['BRFG'] } }),
    ]);
    expect(subs.map((s) => [s.contract.symbol, s.contract.secType, s.profile])).toEqual([
      ['NVDA', 'STK', 'vwap'],
      ['NVDA', 'OPT', 'basic'],
    ]);
  });
});

describe('alertSignature and isTriggered', () => {
  it('changes with the trigger, not with the note or the last trigger', () => {
    const a = alert();
    expect(alertSignature({ ...a, note: 'x', lastTriggeredAt: 5 })).toBe(alertSignature(a));
    expect(alertSignature({ ...a, frequency: 'daily' })).not.toBe(alertSignature(a));
    expect(alertSignature({ ...a, sessions: ['regular'] })).not.toBe(alertSignature(a));
    expect(alertSignature({ ...a, active: false })).not.toBe(alertSignature(a));
  });

  it('shows a spent one-shot and a daily alert of today as triggered, until the user changes them', () => {
    const now = Date.parse('2026-10-13T15:00:00-04:00');
    const fired = Date.parse('2026-10-13T10:00:00-04:00');
    expect(isTriggered(alert({ active: false, lastTriggeredAt: fired }), now)).toBe(true);
    expect(isTriggered(alert({ active: false, lastTriggeredAt: fired, updatedAt: fired + 1 }), now)).toBe(false);
    expect(isTriggered(alert({ frequency: 'daily', lastTriggeredAt: fired }), now)).toBe(true);
    expect(isTriggered(alert({ frequency: 'daily', lastTriggeredAt: fired }), Date.parse('2026-10-14T10:00:00-04:00'))).toBe(false);
    expect(isTriggered(alert({ frequency: 'always', lastTriggeredAt: fired }), now)).toBe(false);
  });
});

describe('alertTexts', () => {
  const texts = (a: PriceAlert, quote: Quote, opts: { delayed?: boolean; session?: 'regular' | 'post'; ctx?: Partial<MeasureContext> } = {}) => {
    const session = opts.session ?? 'regular';
    return alertTexts(a, measure(a.rule, quote, { session, ...opts.ctx }), quote, { delayed: opts.delayed, session });
  };

  it('says what happened, with the price and its change on the day', () => {
    expect(texts(alert(), q({ last: 118.62, close: 118.62 / (1 - 0.0214) }))).toEqual({
      title: { en: 'NVDA fell below 120.00', zh: 'NVDA 跌破 120.00' },
      body: { en: 'Last 118.62 (−2.14%)', zh: '现价 118.62（−2.14%）' },
    });
    expect(texts(alert({ rule: { type: 'priceAbove', value: 120 } }), q({ last: 121 })).title).toEqual({ en: 'NVDA rose above 120.00', zh: 'NVDA 涨破 120.00' });
  });

  it('marks delayed data and adds the note', () => {
    const t = texts(alert({ note: '5 月止盈线' }), q({ last: 118.62, close: 121.21, marketDataType: 3 }), { delayed: true });
    expect(t.body.en).toBe('Last 118.62 (−2.14%) · Delayed 15 min · Note: 5 月止盈线');
    expect(t.body.zh).toBe('现价 118.62（−2.14%） · 延时 15 分钟 · 备注：5 月止盈线');
  });

  it('words the change rules, after hours against today\'s close', () => {
    const quote = q({ last: 105.32, close: 100 });
    expect(texts(alert({ rule: { type: 'dayRise', pct: 5 } }), quote).title).toEqual({ en: 'NVDA is up more than 5% today (+5.32%)', zh: 'NVDA 日内涨幅超过 5%（+5.32%）' });
    const after = texts(alert({ rule: { type: 'dayRise', pct: 1 } }), q({ last: 103, close: 100, lastRthTrade: 101 }), { session: 'post' });
    expect(after.title.en).toBe('NVDA is up more than 1% after hours (+1.98%)');
    expect(after.body.en).toBe('Last 103.00 (after hours +1.98%)');
    expect(after.title.zh).toBe('NVDA 盘后涨幅超过 1%（+1.98%）');
    expect(texts(alert({ rule: { type: 'windowFall', minutes: 5, pct: 2 } }), quote, { ctx: { windowPct: -2.41 } }).title).toEqual({
      en: 'NVDA fell more than 2% in 5 min (−2.41%)',
      zh: 'NVDA 5 分钟跌幅超过 2%（−2.41%）',
    });
  });

  it('words the market data rules in each language’s units', () => {
    expect(texts(alert({ rule: { type: 'volumeAbove', shares: 1e7 } }), q({ last: 1, volume: 1.02e7 })).title).toEqual({ en: 'NVDA volume above 10M (10.2M)', zh: 'NVDA 成交量超过 1000万（1020万）' });
    // Thresholds exactly as set (1.25M, not 1.3M); the volume now rounded.
    expect(texts(alert({ rule: { type: 'volumeAbove', shares: 1_250_000 } }), q({ last: 1, volume: 1_312_345 })).title).toEqual({ en: 'NVDA volume above 1.25M (1.3M)', zh: 'NVDA 成交量超过 125万（131.23万）' });
    // Dollars carry $ in zh too.
    expect(texts(alert({ rule: { type: 'turnoverAbove', amount: 1e9 } }), q({ last: 1, volume: 1e7, vwap: 101 })).title).toEqual({ en: 'NVDA turnover above ≈$1B', zh: 'NVDA 成交额超过约 $10亿' });
    expect(texts(alert({ rule: { type: 'turnoverAbove', amount: 1_250_000 } }), q({ last: 1, volume: 1e7, vwap: 101 })).title.en).toBe('NVDA turnover above ≈$1.25M');
    expect(texts(alert({ rule: { type: 'turnoverAbove', amount: 1.5e9 } }), q({ last: 1, volume: 1e7, vwap: 200 })).title.en).toBe('NVDA turnover above ≈$1.5B');
    expect(texts(alert({ rule: { type: 'bidAbove', value: 120 } }), q({ bid: 120.1 })).title).toEqual({ en: 'NVDA bid rose above 120.00', zh: 'NVDA 买一价高于 120.00' });
    expect(texts(alert({ rule: { type: 'bidSizeAbove', shares: 5000 } }), q({ bidSize: 6000 })).title).toEqual({ en: 'NVDA bid size above 5,000', zh: 'NVDA 买一量超过 5000' });
    expect(texts(alert({ rule: { type: 'halt', dir: 'halted' } }), q({ haltCode: 1 })).title).toEqual({ en: 'NVDA trading halted', zh: 'NVDA 停牌' });
    expect(texts(alert({ rule: { type: 'halt', dir: 'resumed' } }), q({ haltCode: 0 }), { ctx: { prevHalt: 1 } }).title).toEqual({ en: 'NVDA trading resumed', zh: 'NVDA 复牌' });
  });

  it('names the indicator signal and the interval', () => {
    const ind = (signal: Extract<AlertRule, { type: 'indicator' }>['signal'], timeframe: '15m' | '1D' | '1h') => {
      const a = alert({ rule: { type: 'indicator', timeframe, on: 'close', signal } });
      return texts(a, q({ last: 1 }), { ctx: { indicator: { prev: -1, cur: 1, bar: 0, closedBar: 0, value: 1, detail: {}, band: 0 } } }).title;
    };
    expect(ind({ ind: 'macd', kind: 'signal', fast: 12, slow: 26, signal: 9, cross: 'up' }, '15m')).toEqual({ en: 'NVDA MACD golden cross · 15m', zh: 'NVDA MACD 金叉 · 15分钟' });
    expect(ind({ ind: 'ma', kind: 'price', period: 20, cross: 'up' }, '1D')).toEqual({ en: 'NVDA crossed above MA20 · D', zh: 'NVDA 上穿 MA20 · 日K' });
    expect(ind({ ind: 'rsi', kind: 'level', period: 6, level: 80, cross: 'up' }, '1h')).toEqual({ en: 'NVDA RSI(6) rose above 80 · 1h', zh: 'NVDA RSI(6) 升破 80 · 1小时' });
    expect(ind({ ind: 'boll', kind: 'band', period: 20, k: 2, band: 'upper', cross: 'up' }, '1D')).toEqual({ en: 'NVDA broke above the upper Bollinger band · D', zh: 'NVDA 突破布林上轨 · 日K' });
    expect(ind({ ind: 'kdj', kind: 'cross', n: 9, m1: 3, m2: 3, cross: 'down' }, '1h').en).toBe('NVDA KDJ dead cross · 1h');
  });
});

describe('news alerts', () => {
  const newsAlert = (over: Partial<PriceAlert> = {}) => alert({ rule: { type: 'news', providers: ['BRFUPDN', 'DJNL'] }, frequency: 'always', ...over });
  const names: Record<string, string> = { BRFUPDN: 'Briefing.com Analyst Actions' };
  const name = (code: string) => names[code] ?? code;

  it('names the newest headline, its provider and how many more came with it', () => {
    expect(newsTexts(newsAlert(), [{ provider: 'BRFUPDN', text: 'NVIDIA target raised to $150' }], name)).toEqual({
      title: { en: 'NVDA: new headline — NVIDIA target raised to $150', zh: 'NVDA 新闻：NVIDIA target raised to $150' },
      body: { en: 'Source: Briefing.com Analyst Actions', zh: '来源：Briefing.com Analyst Actions' },
    });
    const three = newsTexts(newsAlert({ note: '财报周' }), [
      { provider: 'BRFUPDN', text: 'Older' },
      { provider: 'BRFUPDN', text: 'Old' },
      { provider: 'DJNL', text: 'Newest' },
    ], name);
    expect(three.title.en).toBe('NVDA: new headline — Newest');
    expect(three.body).toEqual({ en: 'Source: DJNL · 2 more new headlines · Note: 财报周', zh: '来源：DJNL · 另有 2 条新标题 · 备注：财报周' });
  });

  it('has no cooldown: every check with new headlines is an event of its own', () => {
    expect(cooldownMs(newsAlert().rule)).toBe(0);
    const s0 = initialGate(newsAlert(), false);
    const hit: Measure = { value: 1, met: true, rearm: true };
    const first = gate(newsAlert(), hit, s0, 1_000);
    const second = gate(newsAlert(), hit, first.state, 2_000);
    expect([first.fire, second.fire]).toEqual([true, true]);
    expect(gate(newsAlert(), { value: 0, met: false, rearm: true }, second.state, 3_000).fire).toBe(false);
  });
});
