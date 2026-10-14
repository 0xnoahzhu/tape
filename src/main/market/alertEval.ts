// Alert evaluation and notification texts (pure, unit-tested). market/alerts.ts feeds it quotes,
// price windows (alertWindow.ts) and bars (alertBars.ts):
//
//   measure(rule, quote, ctx)          the value now, whether the condition holds (met) and whether
//                                      it has gone back far enough to fire again (rearm)
//   gate(alert, measure, state, now)   whether to notify: once / daily / always, cooldowns, one fire
//                                      per indicator bar
//   alertTexts(alert, measure, quote)  the notification, in English and Chinese
//
// Re-arming (always-on alerts) needs the condition to go back by a band, so a value hovering at the
// threshold does not fire a burst: prices REARM_BAND and at least a tick, percents
// max(0.2, 10 % of the threshold) points, sizes 20 %, volume and turnover only with IB's day roll
// (they only grow within a day), RSI levels 2 and KDJ levels 5 points, line crosses the opposite
// relation. Always-on alerts also wait COOLDOWN_MS between two fires (a window's length for the
// 3 / 5-minute rules).

import { contractKey, contractLabel } from '@shared/contract';
import { compact, compactMyriad, exactCompact, f0, f2, pct } from '@shared/format';
import { crossed } from '@shared/indicators';
import type { IndicatorReading } from '@shared/indicatorSignal';
import { tradingDay, type MarketSession } from '@shared/session';
import { liveChangeRef } from '@shared/sessionQuote';
import type { AlertRule, AlertTimeframe, IndicatorSignal, LocalizedText, PriceAlert, Quote, QuoteSubscription } from '@shared/types';
import { createMessages } from '../i18n';
import { lastOrMid } from './tickMap';

/**
 * An always-on price alert re-arms once the price has moved back across the trigger by this
 * fraction (and at least a tick), so ticks bouncing on the trigger price do not fire a burst.
 */
export const REARM_BAND = 0.0005;
/** Least time between two notifications of an always-on alert (window rules: the window's length). */
export const COOLDOWN_MS = 60_000;
/** Sizes re-arm below this share of the threshold (they flicker). */
const SIZE_REARM = 0.8;

/** The session a day's change is measured in: a US stock's (overnight included), else 'regular'. */
export type ChangeSession = MarketSession | 'overnight';

export interface MeasureContext {
  session: ChangeSession;
  /** Window rules: the change over the rule's minutes; undefined while the window is not continuous. */
  windowPct?: number;
  /** Indicator rules: the reading of the rule's bars; undefined while they are missing. */
  indicator?: IndicatorReading;
  /** Halt rules: the halt code before this quote (undefined: none seen yet). */
  prevHalt?: 0 | 1 | 2;
  /** The instrument's minimum tick: price rules re-arm at least a tick away. */
  minTick?: number;
}

export interface Measure {
  /** The measured value; undefined when there is nothing to measure yet. */
  value?: number;
  met: boolean;
  /** Always-on alerts: the condition has gone back far enough to fire again. */
  rearm: boolean;
  /** Indicator alerts: the bar tested and the newest closed bar (unix s). */
  bar?: number;
  closedBar?: number;
  detail?: Record<string, number>;
  /** Day-change rules: measured against today's close (after hours). */
  afterHours?: boolean;
}

const NONE: Measure = { met: false, rearm: false };
const positive = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
/** A volume or size: 0 is a value (nothing traded yet, nobody bidding), unlike a price of 0. */
const count = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** Re-arm band of a percent threshold, in percentage points. */
const pctBand = (p: number) => Math.max(0.2, 0.1 * p);

function above(value: number | undefined, level: number, minTick?: number): Measure {
  if (!positive(value)) return NONE;
  const tick = positive(minTick) ? minTick : 0;
  return { value, met: value >= level, rearm: value < level * (1 - REARM_BAND) && value <= level - tick };
}

function below(value: number | undefined, level: number, minTick?: number): Measure {
  if (!positive(value)) return NONE;
  const tick = positive(minTick) ? minTick : 0;
  return { value, met: value <= level, rearm: value > level * (1 + REARM_BAND) && value >= level + tick };
}

function rise(change: number | undefined, p: number): Measure {
  if (change === undefined || !Number.isFinite(change)) return NONE;
  return { value: change, met: change >= p, rearm: change < p - pctBand(p) };
}

function fall(change: number | undefined, p: number): Measure {
  if (change === undefined || !Number.isFinite(change)) return NONE;
  return { value: change, met: change <= -p, rearm: change > -(p - pctBand(p)) };
}

/** The day's change of the live price in percent, against the session's reference (shared/sessionQuote.ts). */
export function dayChange(q: Quote, session: ChangeSession): { value: number; afterHours: boolean } | undefined {
  const price = lastOrMid(q);
  const ref = liveChangeRef(q, session);
  if (!positive(price) || !ref) return undefined;
  return { value: (price / ref.ref - 1) * 100, afterHours: ref.afterHours };
}

/** Approximate turnover: IB's day volume × the day's VWAP (RTVolume, stocks only). */
export function turnover(q: Quote): number | undefined {
  return positive(q.volume) && positive(q.vwap) ? q.volume * q.vwap : undefined;
}

/** Measures one rule on a quote. Data-type and session gating are the caller's (alerts.ts). */
export function measure(rule: AlertRule, q: Quote, ctx: MeasureContext): Measure {
  switch (rule.type) {
    case 'priceAbove':
      return above(lastOrMid(q), rule.value, ctx.minTick);
    case 'priceBelow':
      return below(lastOrMid(q), rule.value, ctx.minTick);
    case 'bidAbove':
      return above(q.bid, rule.value, ctx.minTick);
    case 'askBelow':
      // An ask of 0 or none is no offer, not a low ask.
      return below(q.ask, rule.value, ctx.minTick);
    case 'dayRise':
    case 'dayFall': {
      const c = dayChange(q, ctx.session);
      if (!c) return NONE;
      const m = rule.type === 'dayRise' ? rise(c.value, rule.pct) : fall(c.value, rule.pct);
      return { ...m, afterHours: c.afterHours };
    }
    case 'windowRise':
      return rise(ctx.windowPct, rule.pct);
    case 'windowFall':
      return fall(ctx.windowPct, rule.pct);
    case 'volumeAbove':
      return count(q.volume) ? { value: q.volume, met: q.volume >= rule.shares, rearm: q.volume < rule.shares } : NONE;
    case 'turnoverAbove': {
      const t = turnover(q);
      return t === undefined ? NONE : { value: t, met: t >= rule.amount, rearm: t < rule.amount };
    }
    case 'bidSizeAbove':
    case 'askSizeAbove': {
      const size = rule.type === 'bidSizeAbove' ? q.bidSize : q.askSize;
      return count(size) ? { value: size, met: size >= rule.shares, rearm: size < SIZE_REARM * rule.shares } : NONE;
    }
    case 'indicator': {
      const r = ctx.indicator;
      if (!r) return NONE;
      const up = rule.signal.cross === 'up';
      return {
        value: r.value,
        met: crossed(rule.signal.cross, r.prev, r.cur),
        rearm: up ? r.cur <= -r.band : r.cur >= r.band,
        bar: r.bar,
        closedBar: r.closedBar,
        detail: r.detail,
      };
    }
    case 'halt': {
      const code = q.haltCode;
      if (code === undefined) return NONE;
      const halted = code === 1 || code === 2;
      if (rule.dir === 'halted') return { value: code, met: halted, rearm: !halted };
      return { value: code, met: !halted && (ctx.prevHalt === 1 || ctx.prevHalt === 2), rearm: halted };
    }
    default:
      // Rules this version does not know are never evaluated.
      return NONE;
  }
}

// ---------------------------------------------------------------------------
// Frequency

/** What gate() remembers of an alert between quotes (not persisted). */
export interface GateState {
  /** May fire: 'once' until it fired, 'always' re-armed since the last fire. */
  armed: boolean;
  /** Last fire of the current setup, for the cooldown and the daily limit (seeded with lastTriggeredAt). */
  lastFireAt?: number;
  /** Indicator alerts: the newest bar a cross may not fire on (fired, or already closed when the alert was armed). */
  lastBar?: number;
}

export function cooldownMs(rule: AlertRule): number {
  return rule.type === 'windowRise' || rule.type === 'windowFall' ? rule.minutes * 60_000 : COOLDOWN_MS;
}

/**
 * The alert's last trigger when it belongs to its current setup: not followed by an edit of the
 * trigger, a pause or a resume (PriceAlert.updatedAt).
 */
export function lastFireOfSetup(alert: Pick<PriceAlert, 'lastTriggeredAt' | 'updatedAt'>): number | undefined {
  const t = alert.lastTriggeredAt;
  return t != null && t >= (alert.updatedAt ?? -Infinity) ? t : undefined;
}

/**
 * Gate state when an alert is loaded or its trigger changes (alertSignature). At startup an
 * always-on alert that fired before waits for its condition to go back, so restarting Tape does not
 * repeat a notification, and a daily one that fired on this trading day stays quiet; an edit, a
 * resume or a new alert is armed (a condition already met fires at once).
 */
export function initialGate(alert: PriceAlert, startup: boolean): GateState {
  const last = lastFireOfSetup(alert);
  const armed = !(startup && alert.frequency === 'always' && last != null);
  return last != null ? { armed, lastFireAt: last } : { armed };
}

/**
 * Whether to notify. `canFire` is false outside the alert's sessions: always-on alerts still re-arm
 * there, but nothing fires.
 * - once: when armed and met (the caller then turns the alert off);
 * - daily: when met and the alert has not fired on this New York trading day (tradingDay: it does not
 *   change at the user's local midnight);
 * - always: when armed, met and past the cooldown; it then waits for `rearm`.
 * Indicator alerts fire at most once per bar, and never on the bar that was the newest closed one
 * when they were armed (a cross from before the alert existed).
 */
export function gate(alert: PriceAlert, m: Measure, state: GateState, now: number, canFire = true): { fire: boolean; state: GateState } {
  const s: GateState = { ...state };
  if (!alert.active || alert.unsupported) return { fire: false, state: s };
  if (s.lastBar === undefined && m.closedBar !== undefined) s.lastBar = m.closedBar;
  if (alert.frequency === 'always' && !s.armed && m.rearm) s.armed = true;
  if (!canFire || !m.met) return { fire: false, state: s };
  if (m.bar !== undefined && s.lastBar !== undefined && m.bar <= s.lastBar) return { fire: false, state: s };
  switch (alert.frequency) {
    case 'once':
      if (!s.armed) return { fire: false, state: s };
      break;
    case 'daily':
      if (s.lastFireAt !== undefined && tradingDay(s.lastFireAt) === tradingDay(now)) return { fire: false, state: s };
      break;
    case 'always':
      if (!s.armed || (s.lastFireAt !== undefined && now - s.lastFireAt < cooldownMs(alert.rule))) return { fire: false, state: s };
      break;
  }
  s.armed = false;
  s.lastFireAt = now;
  if (m.bar !== undefined) s.lastBar = m.bar;
  return { fire: true, state: s };
}

/**
 * Whether the alert shows as triggered: a 'once' alert that fired and is off since, or a 'daily'
 * one that fired on this New York trading day (both since the user's last change).
 */
export function isTriggered(alert: PriceAlert, now: number): boolean {
  const last = lastFireOfSetup(alert);
  if (last == null || alert.unsupported) return false;
  if (alert.frequency === 'once') return !alert.active;
  return alert.frequency === 'daily' && alert.active && tradingDay(last) === tradingDay(now);
}

/** Identity of an alert's trigger; changing any of these re-arms it. */
export function alertSignature(alert: PriceAlert): string {
  return JSON.stringify([contractKey(alert.contract), alert.rule, alert.frequency, alert.sessions ?? null, alert.active]);
}

/**
 * The quote lines the active alerts need, one per instrument: 'vwap' (RTVolume's VWAP) for a stock
 * with a turnover alert, else 'basic'. Paused, spent and unsupported alerts hold no line.
 */
export function alertSubscriptions(alerts: readonly PriceAlert[]): QuoteSubscription[] {
  const out = new Map<string, QuoteSubscription>();
  for (const a of alerts) {
    if (!a.active || a.unsupported) continue;
    const key = contractKey(a.contract);
    const vwap = a.rule.type === 'turnoverAbove' && a.contract.secType === 'STK';
    const prev = out.get(key);
    if (!prev || (vwap && prev.profile !== 'vwap')) out.set(key, { contract: a.contract, profile: vwap ? 'vwap' : 'basic' });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Texts

/** compact() without trailing zeros: 10M, 10.2M, 1.5B. */
const shortCompact = (n: number) => compact(n).replace(/(\.\d*?)0+(?=[KMB]$)/, '$1').replace(/\.(?=[KMB]$)/, '');
const MYRIAD = { wan: '万', yi: '亿' };

const m = createMessages({
  en: {
    priceAbove: (s: string, v: string) => `${s} rose above ${v}`,
    priceBelow: (s: string, v: string) => `${s} fell below ${v}`,
    dayRise: (s: string, p: string, c: string) => `${s} is up more than ${p}% today (${c})`,
    dayFall: (s: string, p: string, c: string) => `${s} is down more than ${p}% today (${c})`,
    dayRiseAfter: (s: string, p: string, c: string) => `${s} is up more than ${p}% after hours (${c})`,
    dayFallAfter: (s: string, p: string, c: string) => `${s} is down more than ${p}% after hours (${c})`,
    windowRise: (s: string, p: string, n: number, c: string) => `${s} rose more than ${p}% in ${n} min (${c})`,
    windowFall: (s: string, p: string, n: number, c: string) => `${s} fell more than ${p}% in ${n} min (${c})`,
    volumeAbove: (s: string, v: string, now: string) => `${s} volume above ${v} (${now})`,
    turnoverAbove: (s: string, v: string) => `${s} turnover above ≈${v}`,
    bidAbove: (s: string, v: string) => `${s} bid rose above ${v}`,
    askBelow: (s: string, v: string) => `${s} ask fell below ${v}`,
    bidSizeAbove: (s: string, v: string) => `${s} bid size above ${v}`,
    askSizeAbove: (s: string, v: string) => `${s} ask size above ${v}`,
    halted: (s: string) => `${s} trading halted`,
    volatilityHalt: (s: string) => `${s} trading halted (volatility pause)`,
    resumed: (s: string) => `${s} trading resumed`,
    indicator: (s: string, what: string, tf: string) => `${s} ${what} · ${tf}`,
    golden: (name: string) => `${name} golden cross`,
    dead: (name: string) => `${name} dead cross`,
    linesUp: (a: string, b: string) => `${a} crossed above ${b} (golden cross)`,
    linesDown: (a: string, b: string) => `${a} crossed below ${b} (dead cross)`,
    priceUp: (line: string) => `crossed above ${line}`,
    priceDown: (line: string) => `crossed below ${line}`,
    zeroUp: 'MACD DIF crossed above 0',
    zeroDown: 'MACD DIF crossed below 0',
    levelUp: (line: string, level: string) => `${line} rose above ${level}`,
    levelDown: (line: string, level: string) => `${line} fell below ${level}`,
    crossUp: (a: string, b: string) => `${a} crossed above ${b}`,
    crossDown: (a: string, b: string) => `${a} crossed below ${b}`,
    bollUpperUp: 'broke above the upper Bollinger band',
    bollUpperDown: 'fell back below the upper Bollinger band',
    bollMiddleUp: 'crossed above the Bollinger middle band',
    bollMiddleDown: 'crossed below the Bollinger middle band',
    bollLowerUp: 'rose back above the lower Bollinger band',
    bollLowerDown: 'broke below the lower Bollinger band',
    timeframe: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1D': 'D', '1W': 'W' } as Record<AlertTimeframe, string>,
    last: (p: string) => `Last ${p}`,
    lastChange: (p: string, c: string) => `Last ${p} (${c})`,
    lastAfterHours: (p: string, c: string) => `Last ${p} (after hours ${c})`,
    delayed: 'Delayed 15 min',
    note: (n: string) => `Note: ${n}`,
    sep: ' · ',
    /** The day's volume now (rounded). */
    volume: (n: number) => shortCompact(n),
    /** Thresholds the user set, exactly (1.25M, never 1.3M). */
    shares: (n: number) => exactCompact(n),
    size: (n: number) => f0(n),
    money: (n: number, currency: string) => (currency === 'USD' || !currency ? `$${exactCompact(n)}` : `${exactCompact(n)} ${currency}`),
  },
  zh: {
    priceAbove: (s: string, v: string) => `${s} 涨破 ${v}`,
    priceBelow: (s: string, v: string) => `${s} 跌破 ${v}`,
    dayRise: (s: string, p: string, c: string) => `${s} 日内涨幅超过 ${p}%（${c}）`,
    dayFall: (s: string, p: string, c: string) => `${s} 日内跌幅超过 ${p}%（${c}）`,
    dayRiseAfter: (s: string, p: string, c: string) => `${s} 盘后涨幅超过 ${p}%（${c}）`,
    dayFallAfter: (s: string, p: string, c: string) => `${s} 盘后跌幅超过 ${p}%（${c}）`,
    windowRise: (s: string, p: string, n: number, c: string) => `${s} ${n} 分钟涨幅超过 ${p}%（${c}）`,
    windowFall: (s: string, p: string, n: number, c: string) => `${s} ${n} 分钟跌幅超过 ${p}%（${c}）`,
    volumeAbove: (s: string, v: string, now: string) => `${s} 成交量超过 ${v}（${now}）`,
    turnoverAbove: (s: string, v: string) => `${s} 成交额超过约 ${v}`,
    bidAbove: (s: string, v: string) => `${s} 买一价高于 ${v}`,
    askBelow: (s: string, v: string) => `${s} 卖一价低于 ${v}`,
    bidSizeAbove: (s: string, v: string) => `${s} 买一量超过 ${v}`,
    askSizeAbove: (s: string, v: string) => `${s} 卖一量超过 ${v}`,
    halted: (s: string) => `${s} 停牌`,
    volatilityHalt: (s: string) => `${s} 波动性停牌`,
    resumed: (s: string) => `${s} 复牌`,
    indicator: (s: string, what: string, tf: string) => `${s} ${what} · ${tf}`,
    golden: (name: string) => `${name} 金叉`,
    dead: (name: string) => `${name} 死叉`,
    linesUp: (a: string, b: string) => `${a} 上穿 ${b}（金叉）`,
    linesDown: (a: string, b: string) => `${a} 下穿 ${b}（死叉）`,
    priceUp: (line: string) => `上穿 ${line}`,
    priceDown: (line: string) => `下穿 ${line}`,
    zeroUp: 'MACD DIF 上穿零轴',
    zeroDown: 'MACD DIF 下穿零轴',
    levelUp: (line: string, level: string) => `${line} 升破 ${level}`,
    levelDown: (line: string, level: string) => `${line} 跌破 ${level}`,
    crossUp: (a: string, b: string) => `${a} 上穿 ${b}`,
    crossDown: (a: string, b: string) => `${a} 下穿 ${b}`,
    bollUpperUp: '突破布林上轨',
    bollUpperDown: '跌回布林上轨下方',
    bollMiddleUp: '上穿布林中轨',
    bollMiddleDown: '下穿布林中轨',
    bollLowerUp: '回升至布林下轨上方',
    bollLowerDown: '跌破布林下轨',
    timeframe: { '1m': '1分钟', '5m': '5分钟', '15m': '15分钟', '30m': '30分钟', '1h': '1小时', '1D': '日K', '1W': '周K' } as Record<AlertTimeframe, string>,
    last: (p: string) => `现价 ${p}`,
    lastChange: (p: string, c: string) => `现价 ${p}（${c}）`,
    lastAfterHours: (p: string, c: string) => `现价 ${p}（盘后 ${c}）`,
    delayed: '延时 15 分钟',
    note: (n: string) => `备注：${n}`,
    sep: ' · ',
    volume: (n: number) => compactMyriad(n, MYRIAD),
    shares: (n: number) => exactCompact(n, MYRIAD),
    size: (n: number) => exactCompact(n, MYRIAD),
    money: (n: number, currency: string) => {
      const s = exactCompact(n, MYRIAD);
      // Dollars with $ as everywhere in Tape (usd()): a bare amount reads as yuan.
      return currency === 'USD' || !currency ? `$${s}` : `${s} ${currency}`;
    },
  },
});

type AlertMessages = ReturnType<typeof m>;

/** Digits needed to show a trigger price faithfully: 2 to 4. */
function priceDigits(n: number): number {
  if (Math.abs(n) < 1) return 4;
  for (let d = 2; d < 4; d++) if (Math.abs(n * 10 ** d - Math.round(n * 10 ** d)) < 1e-6) return d;
  return 4;
}

/** A threshold as typed: at most two decimals, without trailing zeros ("5", "2.5"). */
const plain = (n: number) => String(Number(n.toFixed(2)));

function indicatorText(t: AlertMessages, signal: IndicatorSignal): string {
  const up = signal.cross === 'up';
  switch (signal.ind) {
    case 'ma':
    case 'ema': {
      const name = (p: number) => `${signal.ind.toUpperCase()}${p}`;
      if (signal.kind === 'price') return up ? t.priceUp(name(signal.period)) : t.priceDown(name(signal.period));
      return up ? t.linesUp(name(signal.fast), name(signal.slow)) : t.linesDown(name(signal.fast), name(signal.slow));
    }
    case 'macd':
      if (signal.kind === 'zero') return up ? t.zeroUp : t.zeroDown;
      return up ? t.golden('MACD') : t.dead('MACD');
    case 'kdj':
      if (signal.kind === 'cross') return up ? t.golden('KDJ') : t.dead('KDJ');
      return up ? t.levelUp(`KDJ ${signal.line.toUpperCase()}`, plain(signal.level)) : t.levelDown(`KDJ ${signal.line.toUpperCase()}`, plain(signal.level));
    case 'rsi':
      if (signal.kind === 'level') return up ? t.levelUp(`RSI(${signal.period})`, plain(signal.level)) : t.levelDown(`RSI(${signal.period})`, plain(signal.level));
      return up ? t.crossUp(`RSI(${signal.fast})`, `RSI(${signal.slow})`) : t.crossDown(`RSI(${signal.fast})`, `RSI(${signal.slow})`);
    case 'boll':
      if (signal.band === 'upper') return up ? t.bollUpperUp : t.bollUpperDown;
      if (signal.band === 'middle') return up ? t.bollMiddleUp : t.bollMiddleDown;
      return up ? t.bollLowerUp : t.bollLowerDown;
  }
}

function titleText(t: AlertMessages, alert: PriceAlert, measured: Measure, q: Quote): string {
  const s = contractLabel(alert.contract);
  const r = alert.rule;
  const v = measured.value;
  const change = v === undefined ? '' : pct(v);
  switch (r.type) {
    case 'priceAbove':
      return t.priceAbove(s, f2(r.value, priceDigits(r.value)));
    case 'priceBelow':
      return t.priceBelow(s, f2(r.value, priceDigits(r.value)));
    case 'bidAbove':
      return t.bidAbove(s, f2(r.value, priceDigits(r.value)));
    case 'askBelow':
      return t.askBelow(s, f2(r.value, priceDigits(r.value)));
    case 'dayRise':
      return (measured.afterHours ? t.dayRiseAfter : t.dayRise)(s, plain(r.pct), change);
    case 'dayFall':
      return (measured.afterHours ? t.dayFallAfter : t.dayFall)(s, plain(r.pct), change);
    case 'windowRise':
      return t.windowRise(s, plain(r.pct), r.minutes, change);
    case 'windowFall':
      return t.windowFall(s, plain(r.pct), r.minutes, change);
    case 'volumeAbove':
      return t.volumeAbove(s, t.shares(r.shares), t.volume(v ?? 0));
    case 'turnoverAbove':
      return t.turnoverAbove(s, t.money(r.amount, alert.contract.currency));
    case 'bidSizeAbove':
      return t.bidSizeAbove(s, t.size(r.shares));
    case 'askSizeAbove':
      return t.askSizeAbove(s, t.size(r.shares));
    case 'indicator':
      return t.indicator(s, indicatorText(t, r.signal), t.timeframe[r.timeframe]);
    case 'halt':
      if (r.dir === 'resumed') return t.resumed(s);
      return q.haltCode === 2 ? t.volatilityHalt(s) : t.halted(s);
    default:
      return s;
  }
}

function bodyText(t: AlertMessages, alert: PriceAlert, q: Quote, opts: { delayed?: boolean; session: ChangeSession }): string {
  const price = lastOrMid(q);
  const parts: string[] = [];
  if (positive(price)) {
    const shown = f2(price, Math.max(2, Math.min(4, priceDigits(price))));
    const c = dayChange(q, opts.session);
    parts.push(!c ? t.last(shown) : c.afterHours ? t.lastAfterHours(shown, pct(c.value)) : t.lastChange(shown, pct(c.value)));
  }
  if (opts.delayed) parts.push(t.delayed);
  if (alert.note) parts.push(t.note(alert.note));
  return parts.join(t.sep);
}

/**
 * The notification of a fired alert, in both languages. Title: what happened ("NVDA rose above
 * 120.00", "NVDA MACD golden cross · 15m"); body: the price and its change on the day ("Last 118.62
 * (−2.14%)"; after the close against today's close, "after hours"), "Delayed 15 min" when the quote
 * was delayed, and the alert's note.
 */
export function alertTexts(alert: PriceAlert, measured: Measure, q: Quote, opts: { delayed?: boolean; session: ChangeSession }): { title: LocalizedText; body: LocalizedText } {
  return {
    title: { en: titleText(m('en'), alert, measured, q), zh: titleText(m('zh'), alert, measured, q) },
    body: { en: bodyText(m('en'), alert, q, opts), zh: bodyText(m('zh'), alert, q, opts) },
  };
}
