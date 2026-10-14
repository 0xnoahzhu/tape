// Bars for indicator alerts: one feed per instrument and interval, shared by every alert on it and
// dropped when none is active (at most MAX_INDICATOR_SERIES).
//
// A feed loads its bars with the chart's request (contract, interval, extended hours for intraday
// intervals), so a series the chart has shown comes from the same cache and costs no IB request,
// and the chart's indicators and the alert's agree. Its loads are `background` history requests:
// they wait behind every view's request and use their own small share of IB's 60 historical
// requests per 10 minutes (market/history.ts). Between loads, live quotes extend the bars as on the
// chart (shared/liveBars.ts → advanceLiveBars; delayed quotes never touch intraday bars), and the
// bars roll over to a new bar on the interval's grid each second even without trades.
//
// Reloads: when the connection is ready again (staggered), every one to two INTRADAY_REFRESH_MS
// per intraday feed (spread out, which corrects highs and lows built from quotes), an intraday feed
// as soon as live quotes come back after delayed or frozen ones (those dropped its live bars, and
// the stored ones may be too old for live prices to bridge), daily and weekly feeds after the open
// (09:31 New York) and after the close (16:05, `fresh`, so the day's bar is IB's final one). A
// failed load is retried after a minute, doubling up to INTRADAY_REFRESH_MS.
//
// The newest bar counts as forming while its period is open (alertBarForming): as on the chart,
// except that a US stock's weekly bar stays open until the regular close of its week's last trading
// day (not just until each day's close).

import { MAX_INDICATOR_SERIES } from '@shared/alerts';
import { contractKey } from '@shared/contract';
import { advanceLiveBars, alertBarForming, cleanBars, sessionOpenSec, withLiveBars } from '@shared/liveBars';
import { usEquitySession, usWeekClosed, type MarketSession } from '@shared/session';
import { usesUsEquitySession } from '@shared/sessionQuote';
import { isIntraday } from '@shared/timeframes';
import type { AlertTimeframe, Bar, ContractInfo, ContractRef, HistoryRequest, Quote } from '@shared/types';
import { addDays, isWeekday, nyDay, nyWallToEpochMs } from './nyTime';

export const INTRADAY_REFRESH_MS = 30 * 60_000;
/** Spacing of the staggered reloads after a reconnect. */
const RECONNECT_STAGGER_MS = 3_000;
const RETRY_START_MS = 60_000;
/** New York minutes of the daily and weekly reloads: after the open, and after the close (fresh). */
const DAILY_RELOADS = [9 * 60 + 31, 16 * 60 + 5];
const AFTER_CLOSE = DAILY_RELOADS[1];

export interface AlertBarsDeps {
  history(req: HistoryRequest): Promise<Bar[]>;
  /** Contract details (the liquid hours, for holidays and half days). */
  info(c: ContractRef): Promise<ContractInfo | null>;
  connected(): boolean;
  now(): number;
}

export interface FeedView {
  state: 'loading' | 'ready' | 'error';
  /** Stored and live bars, oldest first. */
  bars: Bar[];
  /** The newest bar's period is still open (shared/liveBars.ts → alertBarForming). */
  forming: boolean;
  /** The load's error while there are no bars. */
  error?: string;
  /**
   * Changes with every change of the bars, unique across feeds (a feed dropped and wanted again
   * starts with a new one): the alert service re-reads its indicators then.
   */
  version: number;
}

export interface AlertBars {
  /**
   * Declares the series the active indicator alerts watch (in priority order): new ones load,
   * dropped ones go. Returns the keys over MAX_INDICATOR_SERIES, which get no feed.
   */
  want(series: ReadonlyArray<{ contract: ContractRef; timeframe: AlertTimeframe }>): string[];
  get(key: string): FeedView | undefined;
  /** A quote of an instrument: extends the bars of its feeds. */
  quote(q: Quote): void;
  /** Called every second: rolls the bars over on time and runs the reloads that are due. */
  tick(): void;
  /** The IB connection is ready again: every feed reloads (staggered). */
  reconnected(): void;
}

interface Feed {
  key: string;
  contractKey: string;
  contract: ContractRef;
  timeframe: AlertTimeframe;
  stored: Bar[];
  live: Bar[];
  state: FeedView['state'];
  error?: string;
  loading: boolean;
  dueAt: number;
  /** The next reload asks for the newest bars even when cached (after the close). */
  fresh: boolean;
  failures: number;
  version: number;
  /** The last live price and whether it was live data (type 1), to roll bars over without trades. */
  last?: number;
  liveData: boolean;
  /**
   * A delayed or frozen quote came since live data was last seen: it dropped the live bars of an
   * intraday feed, so live data coming back reloads it (quote()).
   */
  missedLive: boolean;
  liquidHours?: string;
  usSession: boolean;
  /** Stored and live bars as of `viewVersion` (get() is called every second per alert). */
  view?: Bar[];
  viewVersion?: number;
}

export const feedKey = (contract: ContractRef, timeframe: AlertTimeframe): string => `${contractKey(contract)}|${timeframe}`;

const sameBars = (a: readonly Bar[], b: readonly Bar[]) =>
  a.length === b.length &&
  a.every((x, i) => x.time === b[i].time && x.open === b[i].open && x.high === b[i].high && x.low === b[i].low && x.close === b[i].close && x.volume === b[i].volume);

/** The next daily reload time (New York weekdays 09:31 and 16:05) after `now`, and whether it is the after-close one. */
export function nextDailyReload(now: number): { at: number; fresh: boolean } {
  const today = nyDay(now);
  for (let d = 0; d < 8; d++) {
    const day = addDays({ y: today.y, m: today.m, d: today.d }, d);
    if (!isWeekday(day)) continue;
    for (const minutes of DAILY_RELOADS) {
      const at = nyWallToEpochMs(day, minutes);
      if (at > now) return { at, fresh: minutes === AFTER_CLOSE };
    }
  }
  return { at: now + INTRADAY_REFRESH_MS, fresh: false };
}

export function createAlertBars(deps: AlertBarsDeps): AlertBars {
  const feeds = new Map<string, Feed>();
  let staggerSeq = 0;
  let versionSeq = 0;

  const sessionOf = (f: Feed, now: Date): MarketSession => (f.usSession ? usEquitySession(now, f.liquidHours) : 'regular');

  const bump = (f: Feed) => {
    f.version = ++versionSeq;
  };

  /** When a feed that just loaded reloads next. */
  const schedule = (f: Feed, now: number) => {
    if (isIntraday(f.timeframe)) {
      // Spread the intraday reloads over the interval so they do not come in bursts.
      f.dueAt = now + INTRADAY_REFRESH_MS + ((staggerSeq++ * 97_000) % INTRADAY_REFRESH_MS);
      f.fresh = false;
    } else {
      const next = nextDailyReload(now);
      f.dueAt = next.at;
      f.fresh = next.fresh;
    }
  };

  const load = (f: Feed) => {
    if (f.loading || !deps.connected()) return;
    f.loading = true;
    const req: HistoryRequest = {
      contract: f.contract,
      timeframe: f.timeframe,
      outsideRth: isIntraday(f.timeframe),
      slot: `alerts:${f.key}`,
      background: true,
      ...(f.fresh ? { fresh: true } : {}),
    };
    deps.history(req).then(
      (bars) => {
        f.loading = false;
        if (feeds.get(f.key) !== f) return;
        f.stored = cleanBars(bars);
        f.state = 'ready';
        f.error = undefined;
        f.failures = 0;
        // The live bars the new ones reach are dropped; the rest stay (advanceLiveBars reconciles).
        f.live = advance(f, deps.now());
        schedule(f, deps.now());
        bump(f);
      },
      (err: unknown) => {
        f.loading = false;
        if (feeds.get(f.key) !== f) return;
        f.failures++;
        f.dueAt = deps.now() + Math.min(INTRADAY_REFRESH_MS, RETRY_START_MS * 2 ** (f.failures - 1));
        if (f.state !== 'ready') {
          f.state = 'error';
          f.error = err instanceof Error ? err.message : String(err);
          bump(f);
        }
      },
    );
  };

  /** The feed's live bars with its last price at `now` (advanceLiveBars; the live bars a reload reached go). */
  const advance = (f: Feed, now: number): Bar[] => {
    if (!f.stored.length) return [];
    const at = new Date(now);
    const sessionOpen = f.usSession ? sessionOpenSec(at) : undefined;
    return advanceLiveBars(f.stored, f.live, f.last, f.timeframe, at, sessionOf(f, at), { live: f.liveData, sessionOpen });
  };

  /** Moves the live bars on; true when they changed. */
  const roll = (f: Feed, now: number): boolean => {
    const next = advance(f, now);
    if (sameBars(next, f.live)) return false;
    f.live = next;
    return true;
  };

  const create = (contract: ContractRef, timeframe: AlertTimeframe): Feed => {
    const f: Feed = {
      key: feedKey(contract, timeframe),
      contractKey: contractKey(contract),
      contract,
      timeframe,
      stored: [],
      live: [],
      state: 'loading',
      loading: false,
      dueAt: deps.now(),
      fresh: false,
      failures: 0,
      version: ++versionSeq,
      liveData: false,
      missedLive: false,
      usSession: usesUsEquitySession(contract),
    };
    if (f.usSession) {
      deps.info(contract).then(
        (info) => {
          if (info?.liquidHours) f.liquidHours = info.liquidHours;
        },
        () => undefined,
      );
    }
    return f;
  };

  return {
    want(series) {
      const keep = new Map<string, { contract: ContractRef; timeframe: AlertTimeframe }>();
      const refused: string[] = [];
      for (const s of series) {
        const key = feedKey(s.contract, s.timeframe);
        if (keep.has(key)) continue;
        if (keep.size >= MAX_INDICATOR_SERIES) {
          if (!refused.includes(key)) refused.push(key);
          continue;
        }
        keep.set(key, s);
      }
      for (const key of [...feeds.keys()]) if (!keep.has(key)) feeds.delete(key);
      for (const [key, s] of keep) {
        if (feeds.has(key)) continue;
        const f = create(s.contract, s.timeframe);
        feeds.set(key, f);
        load(f);
      }
      return refused;
    },

    get(key) {
      const f = feeds.get(key);
      if (!f) return undefined;
      if (f.viewVersion !== f.version || !f.view) {
        f.view = withLiveBars(f.stored, f.live);
        f.viewVersion = f.version;
      }
      const bars = f.view;
      const lastBar = bars[bars.length - 1];
      const now = new Date(deps.now());
      // A US stock's week ends at the regular close of its last trading day; other weeks with the calendar week.
      const weekDone = f.timeframe === '1W' && f.usSession && usWeekClosed(now, f.liquidHours);
      return {
        state: f.state,
        bars,
        forming: !!lastBar && alertBarForming(lastBar, f.timeframe, now, sessionOf(f, now), weekDone),
        ...(f.error ? { error: f.error } : {}),
        version: f.version,
      };
    },

    quote(q) {
      const now = deps.now();
      for (const f of feeds.values()) {
        if (f.contractKey !== q.key) continue;
        const live = q.marketDataType === 1;
        if (isIntraday(f.timeframe)) {
          // Delayed or frozen quotes drop an intraday feed's live bars (advanceLiveBars). Once live data
          // is back the stored bars may be further behind than live prices bridge (rollMaxGap, a few
          // bars): reload now rather than at the next scheduled reload.
          if (!live) f.missedLive = true;
          else if (f.missedLive) {
            f.missedLive = false;
            f.dueAt = Math.min(f.dueAt, now);
          }
        }
        f.liveData = live;
        if (q.last !== undefined && q.last > 0) f.last = q.last;
        if (roll(f, now)) bump(f);
      }
    },

    tick() {
      const now = deps.now();
      for (const f of feeds.values()) {
        if (roll(f, now)) bump(f);
        if (now >= f.dueAt) load(f);
      }
    },

    reconnected() {
      const now = deps.now();
      let i = 0;
      for (const f of feeds.values()) f.dueAt = now + RECONNECT_STAGGER_MS * i++;
    },
  };
}
