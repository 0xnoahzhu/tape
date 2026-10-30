// The alerts engine: keeps the alert list (alerts.json), keeps the instruments of active alerts
// subscribed (owner "alerts"), evaluates them and posts 'price' notifications.
//
// Main is the only writer of `active`, `lastTriggeredAt` and `lastValue`. The renderer changes one
// alert at a time (upsert, turn on or off, delete; IPC upsertPriceAlert / setPriceAlertsActive /
// deletePriceAlerts), applied here to main's own list, so a stale copy in the renderer can never
// turn a spent alert back on or undo a trigger.
//
// Evaluation (alertEval.ts has the rules, re-arming and texts):
// - price, day-change, volume, turnover, bid / ask, size and halt rules on every quote of their
//   instrument;
// - 3 / 5-minute rules on every quote and every second (their reference slides without ticks),
//   from a rolling window of live prices (alertWindow.ts);
// - indicator rules every second, from bars loaded like the chart's and extended by live quotes
//   (alertBars.ts);
// - news rules on each answered headline check of their stock (news.ts, about every 5 minutes):
//   the headlines no earlier check listed, from the alert's providers. The first check answered
//   after an alert was armed (created, edited, resumed, loaded) only marks where it starts, so a
//   headline from before is never announced; arming asks for that check at once.
// The 1 s timer runs only while window or indicator alerts are on.
//
// What may fire (the statuses say why not, AlertStatus):
// - only while Tape is connected (or the demo feed runs), on a quote IB sent since: after a
//   (re)connect or a line error a quote counts once its line has had SETTLE_MS to send its current
//   values, so the values from before a disconnect never fire anything;
// - by market data type: window, volume, turnover, bid / ask, size, indicator and halt rules on live
//   data only; price and day-change rules on delayed data too, their notifications marked "Delayed
//   15 min"; nothing on frozen data;
// - US stocks only within the alert's sessions (pre, regular, post, overnight; re-arming goes on
//   outside them), an on-close indicator cross in the session of the bar it closes; news alerts at
//   any time.
// An alert whose condition is already met fires when it is created or resumed.
//
// Notifications: at most STORM_MAX alert notifications a minute; the rest are folded into one. An
// alert that cannot be watched because no market data line is free gets one 'sys' notice per app
// run (Tape's 95 lines; alert lines are background and the first to go).

import {
  ALERT_FIT_MESSAGES,
  ALERT_LIMIT_MESSAGES,
  alertLimitProblem,
  alertSessions,
  availableNewsCodes,
  dataAllows,
  indicatorSeries,
  INVALID_ALERT_MESSAGE,
  isWindowRule,
  MAX_INDICATOR_SERIES,
  needsLiveData,
  ruleFitProblem,
  UNSUPPORTED_EDIT_MESSAGE,
  usesAlertSessions,
} from '@shared/alerts';
import { contractKey, contractLabel } from '@shared/contract';
import { barsNeeded, readIndicator, type IndicatorReading, type IndicatorRule } from '@shared/indicatorSignal';
import { usStockSession } from '@shared/session';
import { usesUsEquitySession } from '@shared/sessionQuote';
import { barEndSec, barSeconds } from '@shared/timeframes';
import type { AlertSession, AlertState, AlertStatus, AlertTimeframe, ContractRef, LocalizedText, PriceAlert, Quote } from '@shared/types';
import type { AlertService, MainContext, NewsHeadline, NewsPoll, NewsWatch } from '../context';
import { createMessages } from '../i18n';
import { sanitizeAlertInput } from '../storeSchema';
import { createAlertBars, feedKey, type FeedView } from './alertBars';
import {
  alertSignature,
  alertSubscriptions,
  alertTexts,
  gate,
  initialGate,
  isTriggered,
  measure,
  newsTexts,
  type ChangeSession,
  type GateState,
  type Measure,
  type MeasureContext,
} from './alertEval';
import { addSample, createWindow, resetWindow, windowChange, windowWait, type PriceWindow } from './alertWindow';
import { afterStartup, isIbConnected } from './ibRequest';
import { LINE_LIMIT_ERROR, MAX_MARKET_DATA_LINES } from './subscriptions';
import { lastOrMid } from './tickMap';

const OWNER = 'alerts';
const TICK_MS = 1000;
/**
 * A line's quote counts this long after its first tick since Tape (re)connected or the line's last
 * error: IB sends the line's current values right after the request, and until then the quote may
 * still hold the values from before the disconnect or the error.
 */
export const SETTLE_MS = 1000;
/** Alert notifications per minute; more are folded into one. */
export const STORM_MAX = 20;
const STORM_WINDOW_MS = 60_000;
/** Titles a folded notification lists. */
const FOLD_TITLES = 5;
/** Status changes are batched this long before the `alertStatuses` event. */
const STATUS_EMIT_MS = 200;
/** Indicators are read over the last max(3 × the bars a rule needs, this) bars (the EMAs have converged by then). */
const INDICATOR_BARS = 250;

const m = createMessages({
  en: {
    notWatchedTitle: (s: string, n: number) => (n === 1 ? `Alert on ${s} is not being watched` : `${n} alerts on ${s} are not being watched`),
    notWatchedBody: (lines: number) =>
      `All ${lines} of Tape's market data lines are in use, so it gets no quotes for this instrument. Close a chart, a watchlist or another view that holds a line; the alert is watched again as soon as one is free.`,
    moreTitle: (n: number) => (n === 1 ? '1 more alert triggered' : `${n} more alerts triggered`),
    moreBody: (titles: string, rest: number) => (rest ? `${titles}; and ${rest} more` : titles),
    sep: '; ',
  },
  zh: {
    notWatchedTitle: (s: string, n: number) => (n === 1 ? `${s} 的提醒未在监控` : `${s} 的 ${n} 个提醒未在监控`),
    notWatchedBody: (lines: number) => `Tape 的 ${lines} 条行情线路已全部占用，收不到该标的的行情。关闭占用线路的图表、自选列表或其他视图后，一有空闲线路便恢复监控。`,
    moreTitle: (n: number) => `另有 ${n} 个提醒触发`,
    moreBody: (titles: string, rest: number) => (rest ? `${titles}；另有 ${rest} 个` : titles),
    sep: '；',
  },
});

/** An instrument with active alerts. */
interface Watched {
  key: string;
  contract: ContractRef;
  alerts: PriceAlert[];
  /** The rolling window of live prices, while a 3 / 5-minute alert is on the instrument. */
  window?: PriceWindow;
  /** Indicator alerts are on it: its quotes extend their bars. */
  bars: boolean;
  /** IB's halt code before the newest quote (halt alerts fire on its changes); unknown after a disconnect. */
  prevHalt?: 0 | 1 | 2;
  /** From the contract details: holidays and half days (US stocks), and the tick price rules re-arm by. */
  liquidHours?: string;
  minTick?: number;
  info: 'none' | 'loading' | 'loaded';
}

/** One alert looked at now: its status and, when it may be evaluated, what was measured. */
interface Assessment {
  status: AlertStatus;
  measured?: Measure;
  quote?: Quote;
  /**
   * Within the alert's sessions (US stocks): the session now, or for an on-close indicator cross the
   * session of the bar it closes.
   */
  canFire?: boolean;
  delayed?: boolean;
  session?: ChangeSession;
}

type Fired =
  | { alert: PriceAlert; measured: Measure; quote: Quote; delayed: boolean; session: ChangeSession }
  /** A news alert: the new headlines of its providers, oldest first. */
  | { alert: PriceAlert; measured: Measure; news: NewsHeadline[] };

const isLineLimit = (e: Quote['error']) => !!e && e.code === LINE_LIMIT_ERROR.code && e.message === LINE_LIMIT_ERROR.message;

/** The parts of a status that say what the list shows (not the moving values, which the views poll). */
const shapeOf = (s: AlertStatus | undefined) => (s ? `${s.id}|${s.state}|${s.reason ?? ''}|${s.message ?? ''}|${s.needsLive ? 1 : 0}|${s.afterHours ? 1 : 0}` : '');

export function createAlertService(ctx: MainContext): AlertService {
  let alerts: PriceAlert[] = [];
  let started = false;
  /**
   * Gate state per evaluated alert, kept while its trigger (alertSignature) is unchanged. `newsFrom`:
   * the number of the first headline check sent after it was armed (NewsService.sequence), the check
   * a news alert starts from.
   */
  const gates = new Map<string, { sig: string; state: GateState; newsFrom: number }>();
  const watched = new Map<string, Watched>();
  /** First quote per contract key since Tape last (re)connected (SETTLE_MS). */
  const firstQuoteAt = new Map<string, number>();
  const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const statuses = new Map<string, AlertStatus>();
  /** What the list shows changed since the last `alertStatuses` event was scheduled. */
  let changedShape = false;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Alerts whose "not being watched" notice was posted in this run. */
  const lineNoticed = new Set<string>();
  /** Indicator readings per alert, kept while its bars and rule are unchanged. */
  const readings = new Map<string, { version: number; forming: boolean; sig: string; reading: IndicatorReading | null }>();
  /** Bar series over MAX_INDICATOR_SERIES (only an edited alerts file can have them). */
  let refusedSeries = new Set<string>();
  /** Alert notifications sent in the last minute, and the titles folded since. */
  const sentAt: number[] = [];
  let folded: LocalizedText[] = [];
  let foldTimer: ReturnType<typeof setTimeout> | null = null;

  const online = () => ctx.demo || isIbConnected(ctx);

  const bars = createAlertBars({
    history: (req) => ctx.history.get(req),
    info: (c) => ctx.contracts.getInfo(c),
    connected: online,
    now: () => Date.now(),
  });

  // ---------------------------------------------------------------------------
  // Assessment

  /** The quote of an instrument when it may be evaluated: IB sent it since the last (re)connect, and it has settled. */
  const usableQuote = (key: string, now: number): Quote | undefined => {
    const first = firstQuoteAt.get(key);
    return first !== undefined && now - first >= SETTLE_MS ? ctx.quotes.getQuote(key) : undefined;
  };

  /** The session a US stock (or a US option, index) is in, overnight included; other instruments 'regular'. */
  const sessionOf = (w: Watched, now: number): ChangeSession => (usesUsEquitySession(w.contract) ? usStockSession(new Date(now), w.liquidHours) : 'regular');

  /** The session of a bar starting at `start` (unix s): daily and weekly bars are regular-session bars, an intraday bar's is its last second's. */
  const barSession = (w: Watched, tf: AlertTimeframe, start: number): ChangeSession => {
    const dur = barSeconds(tf);
    return dur == null ? 'regular' : sessionOf(w, (barEndSec(start, dur) - 1) * 1000);
  };

  const readingOf = (a: PriceAlert, rule: IndicatorRule, feed: FeedView): IndicatorReading | null => {
    const sig = JSON.stringify(rule);
    const cached = readings.get(a.id);
    if (cached && cached.version === feed.version && cached.forming === feed.forming && cached.sig === sig) return cached.reading;
    const n = Math.max(3 * barsNeeded(rule), INDICATOR_BARS);
    const reading = readIndicator(rule, feed.bars.length > n ? feed.bars.slice(-n) : feed.bars, feed.forming);
    readings.set(a.id, { version: feed.version, forming: feed.forming, sig, reading });
    return reading;
  };

  /**
   * A news alert's status: offline, the providers loading, none of its providers on this login, IB's
   * refusal of the last check, waiting for the check that marks where it starts, then ok (or
   * triggered), with when IB last answered and the newest headline of its providers.
   */
  const assessNews = (a: PriceAlert & { rule: { type: 'news' } }, now: number): Assessment => {
    const idle = (state: AlertState, extra: Partial<AlertStatus> = {}): Assessment => ({ status: { id: a.id, state, ...extra } });
    if (!online()) return idle('offline');
    const providers = ctx.news.providers();
    if (providers.status === 'loading') return idle('waiting', { reason: 'newsProviders' });
    if (!availableNewsCodes(a.rule.providers, providers).length) return idle('noData', { reason: 'noProviders' });
    const check = ctx.news.check(contractKey(a.contract));
    if (check?.error) return idle('noData', { reason: 'newsError', message: check.error });
    const latest = check?.listed.find((h) => a.rule.providers.includes(h.provider));
    const seen: Partial<AlertStatus> = { ...(check?.checkedAt !== undefined ? { checkedAt: check.checkedAt } : {}), ...(latest ? { headline: latest.text } : {}) };
    if (isTriggered(a, now)) return idle('triggered', seen);
    const from = gates.get(a.id)?.newsFrom;
    if (from === undefined || check?.seq === undefined || check.seq < from) return idle('waiting', { reason: 'news', ...seen });
    return idle('ok', seen);
  };

  /** Looks at one alert now (no side effects): its status and, when it can be evaluated, the measure. */
  const assess = (a: PriceAlert, now: number): Assessment => {
    const idle = (state: AlertState, extra: Partial<AlertStatus> = {}): Assessment => ({ status: { id: a.id, state, ...extra } });
    if (a.unsupported) return idle('unsupported', { reason: 'newerVersion' });
    if (!a.active) return idle(isTriggered(a, now) ? 'triggered' : 'paused');
    if (a.rule.type === 'news') return assessNews(a as PriceAlert & { rule: { type: 'news' } }, now);
    const live: Partial<AlertStatus> = needsLiveData(a.rule) ? { needsLive: true } : {};
    if (!online()) return idle('offline', live);
    const w = watched.get(contractKey(a.contract));
    // IB's error on the line holds until data flows again (market/quotes.ts clears it then).
    const error = w && ctx.quotes.getQuote(w.key)?.error;
    if (error) {
      if (isLineLimit(error)) return idle('noLine', { message: error.message, ...live });
      return idle('noData', { reason: 'lineError', message: error.message, ...live });
    }
    const q = w && usableQuote(w.key, now);
    if (!w || !q || q.marketDataType === undefined) return idle('waiting', { reason: 'noQuote', ...live });
    const allowed = dataAllows(a.rule, q.marketDataType);
    if (!allowed.evaluate) return idle(allowed.delayed ? 'delayed' : 'frozen', live);

    const session = sessionOf(w, now);
    const sessionAllows = (x: ChangeSession) => !usesAlertSessions(a.contract) || (x !== 'closed' && alertSessions(a).includes(x as AlertSession));
    const inSession = sessionAllows(session);
    const mctx: MeasureContext = { session };
    if (w.minTick) mctx.minTick = w.minTick;
    if (w.prevHalt !== undefined) mctx.prevHalt = w.prevHalt;
    let wait: Partial<AlertStatus> | undefined;
    const rule = a.rule;
    if (isWindowRule(rule)) {
      mctx.windowPct = w.window ? windowChange(w.window, rule.minutes, now) : undefined;
      if (mctx.windowPct === undefined) wait = { reason: 'window', readyIn: w.window ? windowWait(w.window, rule.minutes, now) : rule.minutes * 60_000 };
    } else if (rule.type === 'indicator') {
      const key = feedKey(a.contract, rule.timeframe);
      if (refusedSeries.has(key)) return idle('noData', { reason: 'seriesLimit', ...live });
      const feed = bars.get(key);
      if (!feed || feed.state === 'loading') wait = { reason: 'bars' };
      else if (feed.state === 'error') return idle('noData', { reason: 'barsError', ...(feed.error ? { message: feed.error } : {}), ...live });
      else {
        const reading = readingOf(a, rule, feed);
        if (!reading) return idle('noData', { reason: 'tooFewBars', ...live });
        mctx.indicator = reading;
      }
    }
    const measured = measure(rule, q, mctx);
    // An on-close cross counts in the session of the bar it closes, not the time it is read (a bar
    // ending at 16:00 is read in the post-market, and a pre-market bar ending at 09:30 in the regular
    // session).
    const canFire = rule.type === 'indicator' && rule.on === 'close' && measured.bar !== undefined ? sessionAllows(barSession(w, rule.timeframe, measured.bar)) : inSession;
    // A halt rule without IB's halt status yet is watched all the same (it has nothing to compare).
    if (!wait && measured.value === undefined && rule.type !== 'halt') wait = { reason: 'noValue' };
    const state: AlertState = isTriggered(a, now) ? 'triggered' : !inSession ? 'outOfSession' : wait ? 'waiting' : allowed.delayed ? 'delayed' : 'ok';
    const status: AlertStatus = { id: a.id, state, ...(state === 'waiting' ? wait : {}), ...live };
    if (measured.value !== undefined) status.value = measured.value;
    if (measured.detail) status.detail = measured.detail;
    if (measured.afterHours) status.afterHours = true;
    return { status, measured, quote: q, canFire, delayed: allowed.delayed, session };
  };

  const record = (status: AlertStatus) => {
    if (shapeOf(statuses.get(status.id)) !== shapeOf(status)) changedShape = true;
    statuses.set(status.id, status);
  };

  /** Assesses an alert, records its status and runs its gate; a fire is collected in `fired`. */
  const check = (a: PriceAlert, now: number, fired: Fired[]) => {
    const r = assess(a, now);
    record(r.status);
    const g = gates.get(a.id);
    if (!r.measured || !r.quote || !g) return;
    const out = gate(a, r.measured, g.state, now, r.canFire);
    g.state = out.state;
    if (out.fire) fired.push({ alert: a, measured: r.measured, quote: r.quote, delayed: !!r.delayed, session: r.session ?? 'regular' });
  };

  /** Records the fires in the list (a 'once' alert turns itself off) and notifies. */
  const apply = (fired: Fired[], now: number) => {
    if (!fired.length) return;
    const byId = new Map(fired.map((f) => [f.alert.id, f]));
    persist(
      alerts.map((a) => {
        const f = byId.get(a.id);
        if (!f) return a;
        const next: PriceAlert = { ...a, lastTriggeredAt: now, active: a.frequency === 'once' ? false : a.active };
        if (f.measured.value !== undefined) next.lastValue = f.measured.value;
        return next;
      }),
    );
    reindex();
    for (const f of fired) {
      const { title, body } = 'news' in f ? newsTexts(f.alert, f.news, providerName) : alertTexts(f.alert, f.measured, f.quote, { delayed: f.delayed, session: f.session });
      deliver(title, body, f.alert.contract, now);
    }
  };

  /** IB's name of a news provider (the login's list), else its code. */
  const providerName = (code: string) => ctx.news.providers().providers.find((p) => p.code === code)?.name || code;

  /** Evaluates the alerts of one instrument that `pick` selects. */
  const evaluate = (w: Watched, now: number, pick: (a: PriceAlert) => boolean) => {
    const fired: Fired[] = [];
    for (const a of w.alerts) if (pick(a)) check(a, now, fired);
    apply(fired, now);
  };

  const quoteRule = (a: PriceAlert) => a.rule.type !== 'indicator' && a.rule.type !== 'news';
  const tickRule = (a: PriceAlert) => isWindowRule(a.rule) || a.rule.type === 'indicator';

  // ---------------------------------------------------------------------------
  // Notifications

  const notify = (n: Parameters<MainContext['notifier']['notify']>[0]) => {
    try {
      ctx.notifier.notify(n);
    } catch (err) {
      console.error('[alerts] notify failed:', err);
    }
  };

  /** Sends an alert notification, or folds it once STORM_MAX went out within a minute. */
  const deliver = (title: LocalizedText, body: LocalizedText, contract: ContractRef, now: number) => {
    while (sentAt.length && now - sentAt[0] >= STORM_WINDOW_MS) sentAt.shift();
    if (sentAt.length < STORM_MAX && !folded.length) {
      sentAt.push(now);
      notify({ kind: 'price', title, body, contract });
      return;
    }
    folded.push(title);
    foldTimer ??= setTimeout(flushFolded, Math.max(0, sentAt[0] + STORM_WINDOW_MS - now));
  };

  /** One notification for the alerts folded during a storm: how many, and the first few titles. */
  const flushFolded = () => {
    foldTimer = null;
    const list = folded;
    folded = [];
    if (!list.length) return;
    sentAt.push(Date.now());
    const titles = list.slice(0, FOLD_TITLES);
    const rest = list.length - titles.length;
    notify({
      kind: 'price',
      title: m.both((t) => t.moreTitle(list.length)),
      body: { en: m('en').moreBody(titles.map((x) => x.en).join(m('en').sep), rest), zh: m('zh').moreBody(titles.map((x) => x.zh).join(m('zh').sep), rest) },
    });
  };

  /** Posts the line-limit notices due, and schedules the `alertStatuses` event when what the list shows changed. */
  const noteStatuses = () => {
    if (!changedShape) return;
    changedShape = false;
    const unwatched = new Map<string, { contract: ContractRef; n: number }>();
    for (const a of alerts) {
      if (statuses.get(a.id)?.state !== 'noLine' || lineNoticed.has(a.id)) continue;
      lineNoticed.add(a.id);
      const key = contractKey(a.contract);
      const entry = unwatched.get(key);
      if (entry) entry.n++;
      else unwatched.set(key, { contract: a.contract, n: 1 });
    }
    for (const { contract, n } of unwatched.values()) {
      const label = contractLabel(contract);
      notify({ kind: 'sys', title: m.both((t) => t.notWatchedTitle(label, n)), body: m.both((t) => t.notWatchedBody(MAX_MARKET_DATA_LINES)), contract });
    }
    emitTimer ??= setTimeout(() => {
      emitTimer = null;
      ctx.emit({ type: 'alertStatuses', statuses: currentStatuses() });
    }, STATUS_EMIT_MS);
  };

  const currentStatuses = (): AlertStatus[] => alerts.map((a) => statuses.get(a.id) ?? assess(a, Date.now()).status);

  /** Every alert's status now (no evaluation). */
  const refreshAll = () => {
    const now = Date.now();
    for (const a of alerts) record(assess(a, now).status);
    noteStatuses();
  };

  // ---------------------------------------------------------------------------
  // The list

  /** Persists through the store (which validates) and broadcasts what was actually stored. */
  const persist = (next: PriceAlert[]) => {
    ctx.store.setPriceAlerts(next);
    const stored = ctx.store.getPriceAlerts();
    alerts = Array.isArray(stored) ? stored : next;
    ctx.emit({ type: 'priceAlerts', alerts });
    // The statuses follow the list (order, alerts gone).
    changedShape = true;
  };

  const loadInfo = (w: Watched) => {
    if (w.info !== 'none') return;
    w.info = 'loading';
    ctx.contracts.getInfo(w.contract).then(
      (info) => {
        w.info = info ? 'loaded' : 'none';
        if (info?.liquidHours) w.liquidHours = info.liquidHours;
        if (info && info.minTick > 0) w.minTick = info.minTick;
      },
      () => {
        w.info = 'none';
      },
    );
  };

  /** Evaluates an instrument's alerts once its first quote since the (re)connect has settled. */
  const settleLater = (key: string, now: number) => {
    const first = firstQuoteAt.get(key);
    if (first === undefined || now - first >= SETTLE_MS || settleTimers.has(key)) return;
    settleTimers.set(
      key,
      setTimeout(
        () => {
          settleTimers.delete(key);
          const w = watched.get(key);
          if (!w) return;
          evaluate(w, Date.now(), quoteRule);
          noteStatuses();
        },
        first + SETTLE_MS - now,
      ),
    );
  };

  /**
   * Rebuilds what the list implies: the watched instruments, gate states (kept while a trigger is
   * unchanged), indicator feeds, the quote subscriptions and the 1 s timer.
   */
  /** `loaded`: the alerts come from the file (startup, another account), not from a change. */
  const reindex = (loaded = !started) => {
    const now = Date.now();
    const evaluated = alerts.filter((a) => a.active && !a.unsupported);
    const groups = new Map<string, PriceAlert[]>();
    for (const a of evaluated) {
      // News alerts need no quotes: their stock is checked for headlines (news.ts).
      if (a.rule.type === 'news') continue;
      const key = contractKey(a.contract);
      const list = groups.get(key);
      if (list) list.push(a);
      else groups.set(key, [a]);
    }
    for (const key of [...watched.keys()]) {
      if (groups.has(key)) continue;
      watched.delete(key);
      clearTimeout(settleTimers.get(key));
      settleTimers.delete(key);
    }
    for (const [key, list] of groups) {
      let w = watched.get(key);
      if (!w) {
        w = { key, contract: list[0].contract, alerts: list, bars: false, info: 'none' };
        watched.set(key, w);
        loadInfo(w);
        settleLater(key, now);
      }
      w.alerts = list;
      if (list.some((a) => isWindowRule(a.rule))) w.window ??= createWindow();
      else w.window = undefined;
      w.bars = list.some((a) => a.rule.type === 'indicator');
    }

    const ids = new Set<string>();
    /** Stocks of news alerts armed now: checked at once, so their start is now. */
    const armedNews = new Set<string>();
    for (const a of evaluated) {
      ids.add(a.id);
      const sig = alertSignature(a);
      if (gates.get(a.id)?.sig === sig) continue;
      gates.set(a.id, { sig, state: initialGate(a, loaded), newsFrom: ctx.news.sequence() });
      if (a.rule.type === 'news') armedNews.add(contractKey(a.contract));
    }
    for (const id of [...gates.keys()]) if (!ids.has(id)) gates.delete(id);
    for (const id of [...readings.keys()]) if (!ids.has(id)) readings.delete(id);
    const all = new Set(alerts.map((a) => a.id));
    for (const id of [...statuses.keys()]) if (!all.has(id)) statuses.delete(id);

    // The earliest alerts keep their bars when an edited file has more series than allowed.
    const series = evaluated
      .filter((a): a is PriceAlert & { rule: IndicatorRule } => a.rule.type === 'indicator')
      .sort((x, y) => x.createdAt - y.createdAt)
      .map((a) => ({ contract: a.contract, timeframe: a.rule.timeframe }));
    refusedSeries = new Set(bars.want(series));

    ctx.quotes.setSubscriptions(OWNER, alertSubscriptions(alerts));
    const news = new Map<string, NewsWatch>();
    for (const a of evaluated) {
      if (a.rule.type !== 'news') continue;
      const key = contractKey(a.contract);
      const w = news.get(key);
      if (w) w.codes = [...new Set([...w.codes, ...a.rule.providers])];
      else news.set(key, { key, contract: a.contract, codes: [...a.rule.providers] });
    }
    ctx.news.watch([...news.values()]);
    for (const key of armedNews) ctx.news.pollSoon(key);
    const ticking = evaluated.some(tickRule);
    if (ticking && !timer) timer = setInterval(onTick, TICK_MS);
    if (!ticking && timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  // ---------------------------------------------------------------------------
  // Events

  const onQuote = (q: Quote) => {
    const now = Date.now();
    // After an error (the line limit, a competing session) the quote holds the values from before
    // it: it counts again SETTLE_MS after data flows.
    if (q.error) firstQuoteAt.delete(q.key);
    else if (!firstQuoteAt.has(q.key)) firstQuoteAt.set(q.key, now);
    const w = watched.get(q.key);
    if (!w) return;
    settleLater(q.key, now);
    if (w.window) {
      // Only live prices make a window; anything else starts it over (alertWindow.ts).
      const price = lastOrMid(q);
      if (q.marketDataType === 1 && !q.error && price !== undefined) addSample(w.window, now, price);
      else resetWindow(w.window);
    }
    if (w.bars) bars.quote(q);
    evaluate(w, now, quoteRule);
    if (q.haltCode !== undefined) w.prevHalt = q.haltCode;
    noteStatuses();
  };

  const onTick = () => {
    const now = Date.now();
    bars.tick();
    const fired: Fired[] = [];
    for (const w of watched.values()) for (const a of w.alerts) if (tickRule(a)) check(a, now, fired);
    apply(fired, now);
    noteStatuses();
  };

  /**
   * A headline check of a stock answered: its news alerts fire on the new headlines of their
   * providers, unless the check before it was sent before the alert was armed (then this one only
   * marks where the alert starts: what it lists may be older than the alert).
   */
  const onNewsPoll = (poll: NewsPoll) => {
    const now = Date.now();
    const fired: Fired[] = [];
    for (const a of alerts) {
      if (a.rule.type !== 'news' || !a.active || a.unsupported || contractKey(a.contract) !== poll.key) continue;
      const g = gates.get(a.id);
      if (!g || poll.prevSeq === undefined || poll.prevSeq < g.newsFrom) continue;
      const providers = new Set(a.rule.providers);
      const fresh = poll.fresh.filter((h) => providers.has(h.provider));
      // Every new headline is an event of its own: news alerts always re-arm.
      const measured: Measure = { value: fresh.length, met: fresh.length > 0, rearm: true };
      const out = gate(a, measured, g.state, now);
      g.state = out.state;
      if (out.fire) fired.push({ alert: a, measured, news: fresh });
    }
    apply(fired, now);
    refreshAll();
  };

  /** The socket closed: every quote is stale until IB sends it again, and the windows start over. */
  const onClosed = () => {
    firstQuoteAt.clear();
    for (const t of settleTimers.values()) clearTimeout(t);
    settleTimers.clear();
    for (const w of watched.values()) {
      if (w.window) resetWindow(w.window);
      w.prevHalt = undefined;
    }
    refreshAll();
  };

  const onReady = () => {
    bars.reconnected();
    for (const w of watched.values()) loadInfo(w);
    refreshAll();
  };

  /**
   * Another account's alerts (or another data folder's): they replace the list, as if loaded at
   * startup. Only the account the data folder serves is watched.
   */
  const reload = () => {
    const stored = ctx.store.getPriceAlerts();
    alerts = Array.isArray(stored) ? stored : [];
    gates.clear();
    lineNoticed.clear();
    reindex(true);
    ctx.emit({ type: 'priceAlerts', alerts });
    changedShape = true;
    refreshAll();
  };

  afterStartup(() => {
    const stored = ctx.store.getPriceAlerts();
    alerts = Array.isArray(stored) ? stored : [];
    reindex();
    started = true;
    ctx.store.onVaultChanged(reload);
    ctx.quotes.onQuote(onQuote);
    ctx.ib.onClosed(onClosed);
    ctx.ib.onReady(onReady, { current: false });
    ctx.news.onPoll(onNewsPoll);
    // The providers loaded or changed, or a check failed: the news alerts' statuses follow.
    ctx.news.onChange(refreshAll);
    refreshAll();
  });

  /** Evaluates the instruments of these alerts now: a condition already met fires at once. */
  const evaluateNow = (changed: readonly PriceAlert[]) => {
    const now = Date.now();
    const keys = new Set(changed.map((a) => contractKey(a.contract)));
    for (const key of keys) {
      const w = watched.get(key);
      if (w) evaluate(w, now, (a) => quoteRule(a) && changed.some((c) => c.id === a.id));
    }
    refreshAll();
  };

  return {
    list: () => (started ? alerts : (ctx.store.getPriceAlerts() ?? [])),

    statuses() {
      if (!started) return [];
      refreshAll();
      return currentStatuses();
    },

    upsert(raw) {
      const input = sanitizeAlertInput(raw);
      if (!input) throw new Error(INVALID_ALERT_MESSAGE);
      const fit = ruleFitProblem(input.rule.type, input.contract);
      if (fit) throw new Error(ALERT_FIT_MESSAGES[fit]);
      const now = Date.now();
      const current = alerts.find((a) => a.id === input.id);
      if (current?.unsupported) throw new Error(UNSUPPORTED_EDIT_MESSAGE);
      // Main keeps what only it writes: an edit keeps the alert on or off, its creation time and
      // its last trigger; a new alert has none of them yet.
      const { lastTriggeredAt: _t, lastValue: _v, updatedAt: _u, ...fields } = input;
      let next: PriceAlert;
      if (current) {
        next = { ...fields, active: current.active, createdAt: current.createdAt };
        const triggerChanged = alertSignature(next) !== alertSignature(current);
        const updatedAt = triggerChanged ? now : current.updatedAt;
        if (updatedAt !== undefined) next.updatedAt = updatedAt;
        if (current.lastTriggeredAt !== undefined) next.lastTriggeredAt = current.lastTriggeredAt;
        if (current.lastValue !== undefined) next.lastValue = current.lastValue;
      } else {
        next = { ...fields, createdAt: now, updatedAt: now };
      }
      const limit = alertLimitProblem(alerts, next);
      if (limit) throw new Error(ALERT_LIMIT_MESSAGES[limit]);
      persist(current ? alerts.map((a) => (a.id === next.id ? next : a)) : [next, ...alerts]);
      reindex();
      evaluateNow([next]);
    },

    setActive(ids, active) {
      const wanted = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
      const now = Date.now();
      const changed: PriceAlert[] = [];
      const next = alerts.map((a) => {
        if (!wanted.has(a.id) || a.unsupported || a.active === !!active) return a;
        const updated = { ...a, active: !!active, updatedAt: now };
        changed.push(updated);
        return updated;
      });
      if (!changed.length) return;
      if (active) {
        const series = new Set(next.filter((a) => a.active && !a.unsupported).map(indicatorSeries));
        series.delete(null);
        const before = new Set(alerts.filter((a) => a.active && !a.unsupported).map(indicatorSeries));
        before.delete(null);
        if (series.size > MAX_INDICATOR_SERIES && series.size > before.size) throw new Error(ALERT_LIMIT_MESSAGES.series);
      }
      persist(next);
      reindex();
      if (active) evaluateNow(changed);
      else refreshAll();
    },

    remove(ids) {
      const gone = new Set(Array.isArray(ids) ? ids : []);
      if (!alerts.some((a) => gone.has(a.id))) return;
      persist(alerts.filter((a) => !gone.has(a.id)));
      reindex();
      refreshAll();
    },
  };
}
