// Alerts: the rules' vocabulary, limits and which rules fit which instrument (pure). Shared by the
// main process (storeSchema.ts validates, market/alerts.ts enforces the limits and evaluates) and the
// alert dialog, which offers only what fits and mirrors the limits with a reason.

import { contractKey } from './contract';
import type { AlertFrequency, AlertRule, AlertRuleType, AlertSession, AlertTimeframe, ContractRef, NewsProviders, PriceAlert, Quote } from './types';

export const ALERT_FREQUENCIES: readonly AlertFrequency[] = ['once', 'daily', 'always'];

/** In this order everywhere (the dialog's chips, the stored list). */
export const ALERT_SESSIONS: readonly AlertSession[] = ['pre', 'regular', 'post', 'overnight'];

/** moomoo's default: every session but the overnight one. */
export const DEFAULT_ALERT_SESSIONS: readonly AlertSession[] = ['pre', 'regular', 'post'];

/** Bar intervals of indicator alerts; their bars are the chart's (same request, same cache). */
export const ALERT_TIMEFRAMES: readonly AlertTimeframe[] = ['1m', '5m', '15m', '30m', '1h', '1D', '1W'];

/** Remarks: at most this many code points (moomoo's "no more than 20 characters"). */
export const NOTE_MAX = 20;
/** Alerts per instrument and rule type (moomoo's limit). */
export const MAX_ALERTS_PER_TYPE = 10;
export const MAX_ALERTS = 200;
/**
 * Distinct bar series (instrument + interval) active indicator alerts may watch: each is loaded and
 * refreshed from IB's historical data, whose 60 requests per 10 minutes the charts need too.
 */
export const MAX_INDICATOR_SERIES = 20;
/** Indicator periods (bars) go up to this; the interval's bars may hold fewer (main says so). */
export const MAX_INDICATOR_PERIOD = 250;
/**
 * Above this many instruments with active alerts the dialog warns: each holds one of Tape's 95
 * market data lines, and alert lines are the first to go when they run out.
 */
export const ALERT_LINES_WARNING = 40;

/** Number of code points (what NOTE_MAX counts; an emoji or a CJK character is one). */
export function noteLength(s: string): number {
  return [...s].length;
}

/** A note as stored: trimmed, at most NOTE_MAX code points; undefined when empty. */
export function clipNote(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = [...raw.trim()].slice(0, NOTE_MAX).join('').trim();
  return s || undefined;
}

/**
 * News alerts: the API news providers IB includes with every login, on by default for API use since
 * TWS 966 (Briefing.com General Market Columns, Briefing.com Analyst Actions, Dow Jones
 * Newsletters). A new news alert starts with those the login has. They are analyst actions,
 * market columns and newsletters, not company filings or press releases.
 */
export const FREE_NEWS_PROVIDERS: readonly string[] = ['BRFG', 'BRFUPDN', 'DJNL'];
/** News alerts: how often their instrument is checked for new headlines (market/news.ts). */
export const NEWS_POLL_MS = 5 * 60_000;

/**
 * The provider codes a news alert can use: those of `wanted` the login has, or all of `wanted`
 * while the login's list is not known (IB then refuses the ones it lacks), in `wanted`'s order.
 */
export function availableNewsCodes(wanted: readonly string[], news: NewsProviders): string[] {
  if (news.status !== 'ok') return [...wanted];
  const have = new Set(news.providers.map((p) => p.code));
  return wanted.filter((c) => have.has(c));
}

/** The sessions an alert is evaluated in (US stocks only, see usesAlertSessions). */
export function alertSessions(a: Pick<PriceAlert, 'sessions'>): readonly AlertSession[] {
  return a.sessions?.length ? a.sessions : DEFAULT_ALERT_SESSIONS;
}

/**
 * Whether an instrument's alerts follow the chosen sessions: US dollar stocks and ETFs, which trade
 * pre-market, after hours and on IB's overnight venue (sessionQuote.ts → usesUsEquitySession gives
 * their session).
 */
export function usesAlertSessions(c: Pick<ContractRef, 'secType' | 'currency'>): boolean {
  return c.secType === 'STK' && c.currency === 'USD';
}

/**
 * Whether an alert of this rule type follows the chosen sessions: a US stock's, except a news
 * alert (a headline is announced whenever it comes, as moomoo's announcement alerts).
 */
export function ruleUsesSessions(type: AlertRuleType, c: Pick<ContractRef, 'secType' | 'currency'>): boolean {
  return type !== 'news' && usesAlertSessions(c);
}

/**
 * Rules evaluated on live data only (IB market data type 1): a 15-minute-old window, size, bid /
 * ask, volume, bar or halt means nothing (or worse, reads as now). Price and day-change rules also
 * fire on delayed data, marked as delayed; nothing fires on frozen data.
 */
export function needsLiveData(rule: AlertRule): boolean {
  switch (rule.type) {
    case 'priceAbove':
    case 'priceBelow':
    case 'dayRise':
    case 'dayFall':
    case 'news':
      return false;
    default:
      return true;
  }
}

/**
 * How a quote's market data type lets a rule be evaluated (main's evaluation, and the dialog's note
 * about the data): live data always; delayed data (3) for the rules that do not need live data,
 * whose notifications say so; frozen data (2, 4) and a quote whose type IB has not reported yet never.
 */
export function dataAllows(rule: AlertRule, type: Quote['marketDataType']): { evaluate: boolean; delayed: boolean } {
  if (type === 1) return { evaluate: true, delayed: false };
  if (type === 3 && !needsLiveData(rule)) return { evaluate: true, delayed: true };
  return { evaluate: false, delayed: type === 3 };
}

/** Rules that are a price level, drawn as a line on the chart. */
export function priceLevel(rule: AlertRule): { value: number; side: 'above' | 'below'; quote: 'last' | 'bid' | 'ask' } | null {
  switch (rule.type) {
    case 'priceAbove':
      return { value: rule.value, side: 'above', quote: 'last' };
    case 'priceBelow':
      return { value: rule.value, side: 'below', quote: 'last' };
    case 'bidAbove':
      return { value: rule.value, side: 'above', quote: 'bid' };
    case 'askBelow':
      return { value: rule.value, side: 'below', quote: 'ask' };
    default:
      return null;
  }
}

/**
 * Why a rule type does not fit an instrument (null: it fits):
 * - noVolume: FX pairs, indices and combos have no volume IB reports;
 * - stocksOnly: turnover (needs the stock's VWAP, generic tick 233), news (IB's API news is
 *   about companies);
 * - noHalts: halts are reported for stocks, options and warrants;
 * - noBidAsk: indices have no bid or ask;
 * - noSizes: indices and combos have no bid / ask sizes;
 * - noBars: combos have no historical bars.
 */
export type AlertFitProblem = 'noVolume' | 'stocksOnly' | 'noHalts' | 'noBidAsk' | 'noSizes' | 'noBars';

export function ruleFitProblem(type: AlertRuleType, c: Pick<ContractRef, 'secType'>): AlertFitProblem | null {
  const t = c.secType;
  switch (type) {
    case 'volumeAbove':
      return t === 'CASH' || t === 'IND' || t === 'BAG' ? 'noVolume' : null;
    case 'turnoverAbove':
    case 'news':
      return t === 'STK' ? null : 'stocksOnly';
    case 'halt':
      return t === 'STK' || t === 'OPT' || t === 'WAR' ? null : 'noHalts';
    case 'bidAbove':
    case 'askBelow':
      return t === 'IND' ? 'noBidAsk' : null;
    case 'bidSizeAbove':
    case 'askSizeAbove':
      return t === 'IND' || t === 'BAG' ? 'noSizes' : null;
    case 'indicator':
      return t === 'BAG' ? 'noBars' : null;
    default:
      return null;
  }
}

/** The bar series an indicator alert watches: instrument + interval (the chart's bars store key). */
export function indicatorSeries(a: Pick<PriceAlert, 'contract' | 'rule'>): string | null {
  return a.rule.type === 'indicator' ? `${contractKey(a.contract)}|${a.rule.timeframe}` : null;
}

/**
 * Why `next` cannot be stored (created, edited or turned on) beside `alerts`, the stored list
 * (null: it can):
 * - perType: MAX_ALERTS_PER_TYPE alerts of its rule type on its instrument exist already;
 * - total: MAX_ALERTS alerts exist already;
 * - series: turning it on would make active indicator alerts watch more than MAX_INDICATOR_SERIES series.
 * An edit of an alert does not count the alert itself.
 */
export type AlertLimitProblem = 'perType' | 'total' | 'series';

export function alertLimitProblem(alerts: readonly PriceAlert[], next: PriceAlert): AlertLimitProblem | null {
  const others = alerts.filter((a) => a.id !== next.id);
  if (others.length >= MAX_ALERTS && others.length === alerts.length) return 'total';
  const key = contractKey(next.contract);
  if (others.filter((a) => a.rule.type === next.rule.type && contractKey(a.contract) === key).length >= MAX_ALERTS_PER_TYPE) return 'perType';
  const series = next.active ? indicatorSeries(next) : null;
  if (series) {
    const active = new Set(others.filter((a) => a.active && !a.unsupported).map(indicatorSeries));
    active.delete(null);
    if (!active.has(series) && active.size >= MAX_INDICATOR_SERIES) return 'series';
  }
  return null;
}

/** What main answers when a rule does not fit the instrument (the dialog does not offer it). */
export const ALERT_FIT_MESSAGES: Record<AlertFitProblem, string> = {
  noVolume: 'IB reports no volume for this instrument',
  stocksOnly: 'This alert is for stocks only',
  noHalts: 'IB reports trading halts for stocks, options and warrants only',
  noBidAsk: 'This instrument has no bid or ask',
  noSizes: 'This instrument has no bid or ask sizes',
  noBars: 'This instrument has no bars for indicators',
};

/** The 3 / 5-minute change rules (a rolling price window, re-evaluated every second). */
export const isWindowRule = (rule: AlertRule): rule is Extract<AlertRule, { type: 'windowRise' | 'windowFall' }> =>
  rule.type === 'windowRise' || rule.type === 'windowFall';

/**
 * What main answers when the renderer sends an alert it cannot store (English; the dialog checks
 * first and translates these when they come anyway, features/alerts/model.ts → refusalKey).
 */
export const INVALID_ALERT_MESSAGE = 'The alert is not valid';
export const UNSUPPORTED_EDIT_MESSAGE = 'This alert was made by a newer version of Tape; here it can only be deleted';

/** What main answers when a limit refuses a change (the dialog shows its own text before that). */
export const ALERT_LIMIT_MESSAGES: Record<AlertLimitProblem, string> = {
  perType: `At most ${MAX_ALERTS_PER_TYPE} alerts of one type per instrument`,
  total: `At most ${MAX_ALERTS} alerts`,
  series: `Indicator alerts can watch at most ${MAX_INDICATOR_SERIES} instrument and interval pairs`,
};
