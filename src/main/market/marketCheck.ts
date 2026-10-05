// Active market data check: what IB delivers to this account per market, asked rather than
// guessed from the quotes that happen to be on screen.
//
// A check holds streaming lines (reqMktData with snapshot = false; regulatory snapshots cost money)
// for a few seconds and records IB's answer on each:
// - US stocks: SPY on SMART (a quote owner, MARKET_CHECK_OWNER) and SPY on its primary exchange (a
//   probe line, QuoteService.probe), so a SMART-delayed / exchange-live split shows;
// - US options: a near-the-money SPY call of the next expiration (option chain + contract details),
//   or an option line some view already holds;
// - indices: SPX on CBOE;
// - Level 2 (only on the user's request, "Check now"): one depth line for SPY (DepthService.openLine),
//   or the line the depth view already holds;
// - the stocks the quotes service found SMART delayed and live on their exchange this session.
// Owners reuse open lines (an instrument already subscribed is not requested again, and its answer
// is known at once); everything is released afterwards (owner lines linger 30 s like any other).
// The answer of a line is its marketDataType (1 live, 2 frozen, 3 / 4 delayed) or its error; after
// the first answer the line is watched SETTLE_MS longer, since IB may send a type and then an error
// (10197); after 354 it waits up to AFTER_NOT_SUBSCRIBED_MS, since IB then often serves delayed data
// on the same line (seen live for SPX: 354, half a second later type 3 and 10167). No answer within
// PROBE_TIMEOUT_MS counts as no data. Level 2 answers with its first book update, which IB may send
// only after 10 s and more (no update within DEPTH_TIMEOUT_MS is no data); the line is released
// then, and the depth service cancels it only once IB has started it (an earlier cancel is ignored
// and leaves the stream running). Level 2 from only some exchanges (IB's 2152 lists them) is live
// "via" those exchanges. IB may send 2152 seconds after the first book update (seen live: 12 s
// after the request), so the depth line is watched on (DEPTH_NOTICE_MS, DEPTH_LATE_NOTICE_MS; a
// book after the timeout up to CANCEL_CAP_MS) and a later answer patches the stored result; until
// then the last 2152 of the account (the previous result) stands, and it is dropped when none comes.
// A book without a 2152 stays `unconfirmed` while the line is watched on for one (DEPTH_FINAL_MS,
// DEPTH_FINAL_AFTER_UPDATE_MS): once that watch is over it is IB's final answer, and a full book
// turns the Level 2 switch on unless the user has set it (settings.features.depthSetByUser). The
// switch stays on, so only the latest Level 2 check decides, and nothing does when the session
// closes or IB drops the market data (1101) first.
//
// The last result is kept here, persisted in the kv table (namespace MARKET_CHECK_NS) and pushed as
// `marketDataCheck` events. A quiet check (without depth) runs AUTO_AFTER_READY_MS after each
// handshake unless one ran within AUTO_MIN_INTERVAL_MS for the same account.

import { EventName } from '../ib/tws';
import { contractKey, contractLabel, index, option, stock } from '@shared/contract';
import { DEPTH_PARTIAL, depthPermissions, isFullBook } from '@shared/depthPermissions';
import type {
  ContractRef,
  MarketCheckItem,
  MarketCheckProbe,
  MarketCheckStatus,
  MarketDataCheck,
  MarketDataCheckState,
  MarketDataType,
  OptionChainParams,
  Quote,
  Settings,
} from '@shared/types';
import type { MainContext, MarketCheckService, Unsubscribe } from '../context';
import { CANCEL_CAP_MS } from './depth';
import { afterStartup, isIbConnected, NOT_CONNECTED } from './ibRequest';
import { nyDay, yyyymmdd } from './nyTime';
import { LINE_LIMIT_ERROR, MARKET_CHECK_OWNER } from './subscriptions';

export const MARKET_CHECK_NS = 'mdcheck';
const MARKET_CHECK_KEY = 'last';
/** A line without an answer by then counts as no data. */
export const PROBE_TIMEOUT_MS = 8_000;
/** How long a line is watched after its first answer (a later error or data type may change it). */
export const SETTLE_MS = 1_500;
/** How long a line is watched after 354 for the delayed data IB may still send on it. */
export const AFTER_NOT_SUBSCRIBED_MS = 4_000;
/** The quiet check after a handshake waits for the startup requests first. */
export const AUTO_AFTER_READY_MS = 8_000;
/** No quiet check when one ran this recently for the same account. */
export const AUTO_MIN_INTERVAL_MS = 5 * 60_000;
/** Levels asked of the depth line (any level proves the subscription). */
const DEPTH_ROWS = 5;
/**
 * A depth line without a book update by then counts as no data. IB often takes 10 s and more to
 * start SPY's SMART depth (seen live: first updates after 6, 8, 10.6, 10.8 and 13 s).
 */
export const DEPTH_TIMEOUT_MS = 20_000;
/** How long after the depth request a 2152 (partial depth permissions) may still arrive. */
export const DEPTH_NOTICE_MS = 15_000;
/** ... and at least this long after the first book update (seen live: 9 s after it). */
export const DEPTH_LATE_NOTICE_MS = 10_000;
/**
 * A full book turns the Level 2 switch on, which then stays on: before that the line is watched
 * for a 2152 well past the window above, up to this long after the request ...
 */
export const DEPTH_FINAL_MS = 60_000;
/** ... and at least this long after the first book update. */
export const DEPTH_FINAL_AFTER_UPDATE_MS = 30_000;

export const CHECK_STOCK: ContractRef = stock('SPY');
export const CHECK_INDEX: ContractRef = index('SPX', 'CBOE');
/** Code of Tape's own outcomes (no answer, no free line). */
export const OWN_CODE = -1;

/** 10197: no market data during a competing live session (the line stays open, nothing flows). */
const COMPETING_SESSION = 10197;
/** 354: not subscribed; with market data type 4 IB may still serve delayed data on the line. */
const NOT_SUBSCRIBED = 354;
/** Depth errors after which IB has dropped the request (no cancel needed). */
const DEPTH_DEAD_CODES = new Set([200, 309, 321, 354, 10092]);
/** "Market depth data has been RESET": not an answer. */
const DEPTH_RESET = 317;

/** Level 2's first answer (later ones go to checkDepth's `late`). */
interface DepthAnswer {
  probe: MarketCheckProbe;
  instrument: string;
  /** The line is still watched: IB may still change the answer (a 2152). */
  open: boolean;
  /**
   * The final answer once the check's own or the depth view's line is no longer watched; null for
   * the others (the view's book, whose 2152 its next update clears; demo; no line) and when the
   * session closed or IB dropped the market data (1101) first.
   */
  settled: Promise<MarketCheckProbe | null>;
}

/**
 * Whether Level 2's final answer turns the Level 2 switch on: a full book from IB while the switch
 * is off and the user has not set it.
 */
export function turnsDepthOn(probe: MarketCheckProbe, features: Settings['features']): boolean {
  return isFullBook(probe) && !features.depth && !features.depthSetByUser;
}

/**
 * The Level 2 item: live from some exchanges only when IB's 2152 says so ("Live · IEX only");
 * `open`: the line is still watched, so a full book is not confirmed yet.
 */
export function depthItem(probe: MarketCheckProbe, instrument: string, checkedAt: number, open = false): MarketCheckItem {
  const item: MarketCheckItem = { market: 'depth', status: probe.status, instrument, probe, checkedAt };
  const perms = probe.status === 'live' && probe.code === DEPTH_PARTIAL ? depthPermissions(probe.message) : null;
  if (perms?.depth.length && perms.missing.length) item.via = perms.depth.join(', ');
  if (open && isFullBook(probe)) item.unconfirmed = true;
  return item;
}

/** Receives Level 2's later answers; `open`: the line is still watched (see DepthAnswer). */
type DepthSink = (probe: MarketCheckProbe, open: boolean) => void;

const statusOfType = (t: MarketDataType): MarketCheckStatus => (t === 1 ? 'live' : t === 2 ? 'frozen' : 'delayed');
const isLive = (s: MarketCheckStatus | undefined) => s === 'live' || s === 'frozen';

/**
 * Collects what IB says about one line and decides its status: an answer is final SETTLE_MS after
 * the first one (or at once for a known line), no answer by PROBE_TIMEOUT_MS is "no data".
 */
class LineAnswer {
  private type?: MarketDataType;
  private error?: { code: number; message: string };
  private notice?: { code: number; message: string };
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private done = false;
  private closed = false;
  readonly result: Promise<MarketCheckProbe>;
  private resolve!: (p: MarketCheckProbe) => void;

  constructor(
    private readonly exchange: string,
    private readonly reused = false,
    private readonly issue: () => { code: number; message: string } | undefined = () => undefined,
  ) {
    this.result = new Promise((r) => (this.resolve = r));
    this.timeoutTimer = setTimeout(() => this.finish(), PROBE_TIMEOUT_MS);
  }

  onType(t: MarketDataType): void {
    const waitingForDelayed = !this.type && this.error?.code === NOT_SUBSCRIBED;
    this.type = t;
    if (waitingForDelayed && this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.answered();
  }

  onError(code: number, message: string): void {
    // A competing session overrides whatever else the line said; otherwise keep the first error.
    if (!this.error || code === COMPETING_SESSION) this.error = { code, message };
    this.answered();
  }

  /**
   * The quotes service moved the quote to its primary exchange (the SMART line was delayed): the
   * SMART answer stays the type seen before, or delayed.
   */
  onFallback(): void {
    if (!this.type) this.type = 3;
    this.answered();
  }

  /** A notice that does not end the line (10167 delayed data shown, 10090 part of the ticks). */
  onNotice(code: number, message: string): void {
    this.notice ??= { code, message };
  }

  /** Ends the wait now (known line, closed session). */
  finish(closed = false): void {
    if (this.done) return;
    this.closed = closed;
    this.done = true;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.resolve(this.decide());
  }

  private answered(): void {
    if (this.done || this.settleTimer) return;
    const wait = !this.type && this.error?.code === NOT_SUBSCRIBED ? AFTER_NOT_SUBSCRIBED_MS : SETTLE_MS;
    this.settleTimer = setTimeout(() => this.finish(), wait);
  }

  private decide(): MarketCheckProbe {
    const base = { exchange: this.exchange, ...(this.reused ? { reused: true } : {}) };
    if (this.error?.code === COMPETING_SESSION) return { ...base, status: 'nodata', ...this.error };
    if (this.type) {
      const why = this.error ?? this.notice;
      return { ...base, status: statusOfType(this.type), marketDataType: this.type, ...(why ? { code: why.code, message: why.message } : {}) };
    }
    if (this.error) {
      const lines = this.error.code === LINE_LIMIT_ERROR.code && this.error.message === LINE_LIMIT_ERROR.message;
      return { ...base, status: 'nodata', ...this.error, ...(lines ? { own: 'lines' as const } : {}) };
    }
    if (this.closed) return { ...base, status: 'nodata', code: OWN_CODE, message: 'Connection closed', own: 'closed' };
    const issue = this.issue();
    if (issue) return { ...base, status: 'nodata', code: issue.code, message: issue.message };
    return { ...base, status: 'nodata', code: OWN_CODE, message: `No answer from IB within ${PROBE_TIMEOUT_MS / 1000} s`, own: 'timeout' };
  }
}

/** The SPY price the option strike is picked around. */
function priceOf(q: Quote | undefined): number | undefined {
  if (!q) return undefined;
  if (q.last && q.last > 0) return q.last;
  if (q.bid && q.ask && q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  if (q.close && q.close > 0) return q.close;
  return undefined;
}

/**
 * Strikes to try for a near-the-money option: whole-number strikes nearest to `price` (the middle
 * of the chain without a price), at most `n`.
 */
export function nearStrikes(strikes: number[], price: number | undefined, n = 3): number[] {
  if (!strikes.length) return [];
  const ref = price ?? strikes[Math.floor(strikes.length / 2)];
  const whole = strikes.filter((k) => Number.isInteger(k));
  const pool = whole.length ? whole : strikes;
  return [...pool].sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref) || a - b).slice(0, n);
}

/** The chain row and expiration of the check's option: SPY's own class on SMART, the first expiration after today. */
export function pickExpiry(rows: OptionChainParams[], symbol: string, nowMs: number): { row: OptionChainParams; expiry: string } | null {
  const row = rows.find((r) => r.exchange === 'SMART' && r.tradingClass === symbol) ?? rows.find((r) => r.exchange === 'SMART') ?? rows[0];
  if (!row) return null;
  const today = yyyymmdd(nyDay(nowMs));
  // An option expiring today stops trading at the close: the next expiration is quoted all day.
  const expiry = row.expirations.find((e) => e > today) ?? row.expirations.find((e) => e >= today);
  return expiry ? { row, expiry } : null;
}

const isProbe = (v: unknown): v is MarketCheckProbe => {
  const p = v as MarketCheckProbe;
  return !!p && typeof p === 'object' && typeof p.status === 'string' && typeof p.exchange === 'string';
};

/** A persisted result as written by this version (anything else is ignored). */
export function isMarketDataCheck(v: unknown): v is MarketDataCheck {
  const c = v as MarketDataCheck;
  return (
    !!c &&
    typeof c === 'object' &&
    typeof c.checkedAt === 'number' &&
    Array.isArray(c.items) &&
    c.items.every((i) => i && typeof i.market === 'string' && typeof i.status === 'string' && typeof i.checkedAt === 'number' && isProbe(i.probe))
  );
}

export function createMarketCheckService(ctx: MainContext): MarketCheckService {
  let result: MarketDataCheck | null = null;
  let inflight: { promise: Promise<MarketDataCheck>; depth: boolean } | null = null;
  let autoTimer: ReturnType<typeof setTimeout> | null = null;
  /** A result arrived (a check finished) before the persisted one was read: that one is older. */
  let fresh = false;
  /** Level 2 checks started so far (only the latest one's final answer turns the switch on). */
  let depthChecks = 0;

  const getState = (): MarketDataCheckState => ({ result, running: inflight != null, ...(inflight ? { depth: inflight.depth } : {}) });
  const emit = () => ctx.emit({ type: 'marketDataCheck', state: getState() });

  const accountNow = (): string | undefined => {
    const s = ctx.ib.getState();
    return s.account ?? s.accounts?.[0];
  };
  const competing = () => {
    const issue = ctx.ib.getState().marketDataIssue;
    return issue?.code === COMPETING_SESSION ? issue : undefined;
  };

  // ---------------------------------------------------------------------------
  // Lines

  /** Waits for IB's answer on an owner line (set up by the caller's setSubscriptions). */
  const watchOwned = (contract: ContractRef, reused: boolean, onClose: (fn: () => void) => void): Promise<MarketCheckProbe> => {
    const key = contractKey(contract);
    const answer = new LineAnswer(contract.exchange || 'SMART', reused, competing);
    const offs: Unsubscribe[] = [];
    const look = (q: Quote | undefined) => {
      if (!q) return;
      if (q.error) answer.onError(q.error.code, q.error.message);
      if (q.source?.kind === 'primary') answer.onFallback();
      else if (q.marketDataType) answer.onType(q.marketDataType);
    };
    offs.push(ctx.quotes.onQuote((q) => q.key === key && look(q)));
    offs.push(ctx.quotes.onNotice((k, code, message) => k === key && answer.onNotice(code, message)));
    onClose(() => answer.finish(true));
    if (reused) {
      // Nothing flows while another session holds the account's market data (10197), whatever the line said before.
      const issue = competing();
      if (issue) answer.onError(issue.code, issue.message);
      look(ctx.quotes.getQuote(key));
      answer.finish();
    }
    return answer.result.finally(() => offs.forEach((off) => off()));
  };

  /** Opens a probe line (outside the owners) and waits for its answer; closes it afterwards. */
  const watchProbe = (contract: ContractRef, onClose: (fn: () => void) => void): Promise<MarketCheckProbe> => {
    const answer = new LineAnswer(contract.exchange, false, competing);
    const handle = ctx.quotes.probe(contract, '', (e) => {
      if (e.kind === 'type') answer.onType(e.type);
      else if (e.kind === 'error') {
        if (e.code === OWN_CODE) answer.finish(true);
        else if (e.code === 10167 || e.code === 10090 || e.code === 10091 || (e.code >= 2100 && e.code < 2200)) answer.onNotice(e.code, e.message);
        else answer.onError(e.code, e.message);
      }
    });
    if (!handle) {
      answer.finish();
      return Promise.resolve({ status: 'nodata', exchange: contract.exchange, code: OWN_CODE, message: 'No free market data line', own: 'lines' });
    }
    onClose(() => answer.finish(true));
    return answer.result.finally(() => handle.close());
  };

  /** The last 2152 of this account (from the previous result): Level 2 from some exchanges only. */
  const lastDepthNotice = (): { code: number; message: string } | undefined => {
    if (!result || result.account !== accountNow()) return undefined;
    const p = result.items.find((i) => i.market === 'depth')?.probe;
    return p?.status === 'live' && p.code === DEPTH_PARTIAL && p.message ? { code: p.code, message: p.message } : undefined;
  };

  /**
   * Level 2: the depth view's book, the view's open line (its first answer), else one depth line
   * of the check's own (SPY, SMART depth), released as soon as it answers. The answer is the first
   * book update (live), an error, or no data after DEPTH_TIMEOUT_MS. The line is watched longer:
   * a 2152 up to DEPTH_NOTICE_MS after the request (and DEPTH_LATE_NOTICE_MS after the first
   * update), and after a timeout a first update or an error up to CANCEL_CAP_MS after the request;
   * a book without one until DEPTH_FINAL_MS (and DEPTH_FINAL_AFTER_UPDATE_MS after its first update).
   * `late` gets each later answer, and the last one again with `open` false once the watch is over
   * (the stored result follows it, see patchDepth); `settled` that last one.
   */
  const checkDepth = (onClose: (fn: () => void) => void, late: DepthSink): Promise<DepthAnswer> => {
    const remembered = lastDepthNotice();
    const live = (extra: Partial<MarketCheckProbe>, notice?: { code: number; message: string }): MarketCheckProbe => ({
      status: 'live',
      exchange: 'SMART',
      ...extra,
      ...(notice ? { code: notice.code, message: notice.message } : {}),
    });
    const book = ctx.depth.current();
    const viewInstrument = book ? (book.key.split(':')[1] ?? book.key) : undefined;
    const unsettled = Promise.resolve(null);
    if (book && (!book.error || book.error.code === DEPTH_PARTIAL) && (book.bids.length || book.asks.length || book.error)) {
      return Promise.resolve({ probe: live({ reused: true }, book.error ?? remembered), instrument: viewInstrument!, open: false, settled: unsettled });
    }
    const instrument = contractLabel(CHECK_STOCK);
    if (ctx.demo) return Promise.resolve({ probe: live({}), instrument, open: false, settled: unsettled });
    if (!ctx.ib.api) {
      return Promise.resolve({ probe: { status: 'nodata', exchange: 'SMART', code: OWN_CODE, message: NOT_CONNECTED }, instrument, open: false, settled: unsettled });
    }
    // The depth view holds a line already: wait for its answer instead of opening a second one.
    const view = ctx.depth.lineReqId();
    const own = view == null;
    let reqId: number;
    if (own) {
      try {
        reqId = ctx.depth.openLine(CHECK_STOCK, DEPTH_ROWS);
      } catch (err) {
        return Promise.resolve({
          probe: { status: 'nodata', exchange: 'SMART', code: OWN_CODE, message: err instanceof Error ? err.message : String(err) },
          instrument,
          open: false,
          settled: unsettled,
        });
      }
    } else reqId = view;
    const label = own ? instrument : viewInstrument!;
    const reused = own ? {} : { reused: true as const };
    const startedAt = Date.now();
    let settle!: (probe: MarketCheckProbe | null) => void;
    const settled = new Promise<MarketCheckProbe | null>((r) => (settle = r));
    return new Promise((resolve) => {
      /** IB's 2152 on the line: Level 2 from some exchanges only (other notices change nothing). */
      let notice: { code: number; message: string } | undefined;
      /** The answer given so far (null until the first one). */
      let answer: MarketCheckProbe | null = null;
      let ended = false;
      let answerTimer: ReturnType<typeof setTimeout> | undefined;
      let watchTimer: ReturnType<typeof setTimeout> | null = null;
      const offs: Unsubscribe[] = [];
      /**
       * Stops watching; `final`: the watch ran its course, so the last answer is IB's final one (and
       * no longer open). Otherwise (the session closed, 1101) a book stays unconfirmed.
       */
      const end = (final = true) => {
        if (ended) return;
        ended = true;
        clearTimeout(answerTimer);
        if (watchTimer) clearTimeout(watchTimer);
        offs.splice(0).forEach((off) => off());
        if (final && answer) late(answer, false);
        settle(final ? answer : null);
      };
      /** Watches the line until `at` (epoch ms), then calls `then`. */
      const watchUntil = (at: number, then: () => void) => {
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          watchTimer = null;
          then();
        }, Math.max(0, at - Date.now()));
      };
      const report = (probe: MarketCheckProbe) => {
        const first = !answer;
        answer = probe;
        if (first) {
          clearTimeout(answerTimer);
          // Released at once: the depth service cancels it once IB has started it.
          if (own) ctx.depth.closeLine(reqId);
          resolve({ probe, instrument: label, open: true, settled });
        } else late(probe, true);
      };
      /**
       * Live: a 2152 may still follow; without one the account's last one no longer applies, and
       * the line is watched on before the book counts as full.
       */
      const goLive = () => {
        report(live(reused, notice ?? remembered));
        if (notice) return end();
        const firstUpdate = Date.now();
        watchUntil(Math.max(startedAt + DEPTH_NOTICE_MS, firstUpdate + DEPTH_LATE_NOTICE_MS), () => {
          if (remembered) report(live(reused));
          watchUntil(Math.max(startedAt + DEPTH_FINAL_MS, firstUpdate + DEPTH_FINAL_AFTER_UPDATE_MS), end);
        });
      };
      answerTimer = setTimeout(() => {
        report({
          status: 'nodata',
          exchange: 'SMART',
          ...(notice ?? competing() ?? { code: OWN_CODE, message: `No book from IB within ${DEPTH_TIMEOUT_MS / 1000} s`, own: 'timeout' as const }),
          ...reused,
        });
        // IB may still start the stream: a late first update makes it live.
        watchUntil(startedAt + CANCEL_CAP_MS, end);
      }, DEPTH_TIMEOUT_MS);
      const onUpdate = (id: number) => {
        if (id !== reqId || ended || answer?.status === 'live') return;
        goLive();
      };
      offs.push(ctx.ib.on(EventName.updateMktDepth, onUpdate));
      offs.push(ctx.ib.on(EventName.updateMktDepthL2, onUpdate));
      offs.push(
        ctx.ib.onRequestError((e) => {
          if (e.reqId !== reqId || ended || e.code === DEPTH_RESET) return;
          // 2152: the account lacks depth permissions on some exchanges; the others may still answer.
          // Other notices (2100–2199) say nothing about the book.
          if (e.code >= 2100 && e.code < 2200) {
            if (e.code !== DEPTH_PARTIAL || notice) return;
            notice = { code: e.code, message: e.message };
            if (answer?.status === 'live') {
              report(live(reused, notice));
              end();
            }
            return;
          }
          if (answer?.status === 'live') return;
          const dead = DEPTH_DEAD_CODES.has(e.code);
          if (answer && !dead) return;
          report({ status: 'nodata', exchange: 'SMART', code: e.code, message: e.message, ...reused });
          if (dead) end();
          else watchUntil(startedAt + CANCEL_CAP_MS, end); // the line may still start
        }),
      );
      // The session may also close after the check has returned, while the line is still watched,
      // or IB drop its market data requests (1101: the connection fires ready again): a 2152 can no
      // longer come, so the last answer is not final.
      const closed = () => {
        if (!answer) report({ status: 'nodata', exchange: 'SMART', code: OWN_CODE, message: 'Connection closed', own: 'closed' });
        end(false);
      };
      offs.push(ctx.ib.onClosed(closed), ctx.ib.onReady(closed));
      onClose(closed);
    });
  };

  /** The check's option: one a view already holds (with an answer), else a near-the-money SPY call. */
  const findOption = async (price: () => number | undefined, chain: Promise<OptionChainParams[]>): Promise<ContractRef | null> => {
    const rows = await chain;
    const pick = pickExpiry(rows, CHECK_STOCK.symbol, Date.now());
    if (!pick) return null;
    for (const strike of nearStrikes(pick.row.strikes, price())) {
      const c = option(CHECK_STOCK.symbol, pick.expiry, strike, 'C', { tradingClass: pick.row.tradingClass, multiplier: pick.row.multiplier });
      const info = await ctx.contracts.getInfo(c).catch(() => null);
      if (info) return { ...c, ...info.contract };
    }
    return null;
  };

  const heldOption = (): ContractRef | null => {
    for (const { contract, quote } of ctx.quotes.wanted()) {
      if (contract.secType === 'OPT' && (contract.currency || 'USD') === 'USD' && quote?.marketDataType && !quote.error) return contract;
    }
    return null;
  };

  // ---------------------------------------------------------------------------
  // The check

  /**
   * `late`: attaches the receiver of Level 2's later answers (those that came before are replayed,
   * the last one); `settled`: Level 2's final answer (DepthAnswer).
   */
  const check = async (
    depth: boolean,
    trigger: MarketDataCheck['trigger'],
  ): Promise<{ result: MarketDataCheck; late?: (fn: DepthSink) => void; settled?: Promise<MarketCheckProbe | null> }> => {
    if (!ctx.demo && !isIbConnected(ctx)) throw new Error(NOT_CONNECTED);
    // The session's end answers every line still waiting (and those set up afterwards) at once.
    const closers: Array<() => void> = [];
    let closed = false;
    const onClose = (fn: () => void) => (closed ? fn() : void closers.push(fn));
    const offClosed = ctx.ib.onClosed(() => {
      closed = true;
      closers.splice(0).forEach((fn) => fn());
    });
    /**
     * Open lines answer at once: the quote of a contract another owner holds, or whose line still
     * lingers, already has its data type or error (IB does not send the type again).
     */
    const known = (c: ContractRef) => {
      const q = ctx.quotes.getQuote(contractKey(c));
      return !!q && (q.marketDataType != null || !!q.error);
    };
    const owned: ContractRef[] = [CHECK_STOCK, CHECK_INDEX];
    const own = () => ctx.quotes.setSubscriptions(MARKET_CHECK_OWNER, owned.map((contract) => ({ contract, profile: 'basic' as const })));
    try {
      const stockKnown = known(CHECK_STOCK);
      const indexKnown = known(CHECK_INDEX);
      own();
      const smartP = watchOwned(CHECK_STOCK, stockKnown, onClose);
      const indexP = watchOwned(CHECK_INDEX, indexKnown, onClose);
      const primaryP = ctx.demo
        ? Promise.resolve(undefined)
        : ctx.contracts
            .resolve(CHECK_STOCK)
            .then((resolved) => (resolved.primaryExchange ? watchProbe({ ...resolved, exchange: resolved.primaryExchange }, onClose) : undefined))
            .catch(() => undefined);
      let lateSink: DepthSink | null = null;
      let lateBefore: [MarketCheckProbe, boolean] | null = null;
      const depthP = depth ? checkDepth(onClose, (p, open) => (lateSink ? lateSink(p, open) : (lateBefore = [p, open]))) : Promise.resolve(null);

      // The option: a line a view holds, else SPY's chain (fetched while the stock line answers).
      let optionP: Promise<{ probe: MarketCheckProbe; instrument: string } | null>;
      const held = heldOption();
      if (held) {
        optionP = watchOwned(held, true, onClose).then((probe) => ({ probe, instrument: contractLabel(held) }));
      } else {
        const chain = ctx.options.getChainParams(CHECK_STOCK);
        chain.catch(() => undefined);
        optionP = smartP
          .then(() => findOption(() => priceOf(ctx.quotes.getQuote(contractKey(CHECK_STOCK))), chain))
          .then((contract) => {
            if (!contract) return null;
            const wasKnown = known(contract);
            owned.push(contract);
            own();
            return watchOwned(contract, wasKnown, onClose).then((probe) => ({ probe, instrument: contractLabel(contract) }));
          })
          .catch((err: unknown) => ({
            probe: { status: 'nodata' as const, exchange: 'SMART', code: OWN_CODE, message: err instanceof Error ? err.message : String(err), own: 'contract' as const },
            instrument: `${CHECK_STOCK.symbol} option`,
          }));
      }

      const [smart, primary, ind, opt, book] = await Promise.all([smartP, primaryP, indexP, optionP, depthP]);
      if (!ctx.demo && !isIbConnected(ctx)) throw new Error(NOT_CONNECTED);
      const now = Date.now();
      const items: MarketCheckItem[] = [];
      const stockItem: MarketCheckItem = { market: 'stk', status: smart.status, instrument: contractLabel(CHECK_STOCK), probe: smart, checkedAt: now };
      if (primary) {
        stockItem.primary = primary;
        if (!isLive(smart.status) && isLive(primary.status)) {
          stockItem.status = primary.status;
          stockItem.via = primary.exchange;
        }
      }
      // The fallback's findings of this session, not just the quotes on their exchange right now: a
      // stock whose line went (the user left its page) still tells what the account gets.
      const fallback = ctx.quotes.fallbacks().map((f) => ({ symbol: f.symbol, exchange: f.exchange }));
      if (fallback.length) stockItem.fallback = fallback;
      items.push(stockItem);
      items.push(
        opt
          ? { market: 'opt', status: opt.probe.status, instrument: opt.instrument, probe: opt.probe, checkedAt: now }
          : {
              market: 'opt',
              status: 'nodata',
              instrument: `${CHECK_STOCK.symbol} option`,
              probe: { status: 'nodata', exchange: 'SMART', code: OWN_CODE, message: 'No option contract found', own: 'contract' },
              checkedAt: now,
            },
      );
      if (book) items.push(depthItem(book.probe, book.instrument, now, book.open));
      else {
        // Level 2 is only checked on request: keep the last answer of this account.
        const prev = result?.account === accountNow() ? result?.items.find((i) => i.market === 'depth') : undefined;
        if (prev) items.push(prev);
      }
      items.push({ market: 'ind', status: ind.status, instrument: contractLabel(CHECK_INDEX), probe: ind, checkedAt: now });
      const state = ctx.ib.getState();
      const late = (fn: DepthSink) => {
        lateSink = fn;
        if (lateBefore) fn(...lateBefore);
      };
      return { result: { checkedAt: now, account: accountNow(), clientId: state.clientId, trigger, items }, ...(book ? { late, settled: book.settled } : {}) };
    } finally {
      offClosed();
      ctx.quotes.setSubscriptions(MARKET_CHECK_OWNER, []);
    }
  };

  const run = (opts: { depth?: boolean; trigger: MarketDataCheck['trigger'] }): Promise<MarketDataCheck> => {
    const depth = !!opts.depth;
    if (inflight) {
      // A check without depth is running: Level 2 is checked right after it.
      if (depth && !inflight.depth) return inflight.promise.catch(() => undefined).then(() => run(opts));
      return inflight.promise;
    }
    const gen = depth ? ++depthChecks : depthChecks;
    const promise = check(depth, opts.trigger).then(
      ({ result: r, late, settled }) => {
        result = r;
        fresh = true;
        inflight = null;
        void ctx.db?.kv.set(MARKET_CHECK_NS, MARKET_CHECK_KEY, r);
        emit();
        let shown = r.items.find((i) => i.market === 'depth');
        if (late) late((probe, open) => (shown = shown && patchDepth(shown, probe, open)));
        // Only the latest Level 2 check decides, while its answer is still the one shown.
        void settled?.then((probe) => probe && gen === depthChecks && shown && result?.items.includes(shown) && switchDepthOn(probe));
        return r;
      },
      (err: unknown) => {
        inflight = null;
        emit();
        throw err;
      },
    );
    inflight = { promise, depth };
    emit();
    return promise;
  };

  /**
   * Level 2 answered again (a 2152 after the first book update, none after all, a book after the
   * timeout, the watch is over): the stored result follows while it still shows `prev`, this
   * check's Level 2 item (a check without Level 2 keeps it; a newer Level 2 check replaces it).
   * Returns the item to patch next time.
   */
  const patchDepth = (prev: MarketCheckItem, probe: MarketCheckProbe, open: boolean): MarketCheckItem => {
    const i = result ? result.items.indexOf(prev) : -1;
    if (!result || i < 0) return prev;
    const next = depthItem(probe, prev.instrument, prev.checkedAt, open);
    const a = prev.probe;
    if (a.status === probe.status && a.code === probe.code && a.message === probe.message && a.own === probe.own && !prev.unconfirmed === !next.unconfirmed) return prev;
    const items = [...result.items];
    items[i] = next;
    result = { ...result, items };
    void ctx.db?.kv.set(MARKET_CHECK_NS, MARKET_CHECK_KEY, result);
    emit();
    return next;
  };

  /** Level 2's final answer: a full book turns the switch on (turnsDepthOn); the settings event tells the renderer. */
  const switchDepthOn = (probe: MarketCheckProbe) => {
    if (turnsDepthOn(probe, ctx.store.getSettings().features)) ctx.store.updateSettings({ features: { depth: true } });
  };

  const scheduleAuto = () => {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = null;
      if (!isIbConnected(ctx) || inflight) return;
      if (result && result.account === accountNow() && Date.now() - result.checkedAt < AUTO_MIN_INTERVAL_MS) return;
      run({ trigger: 'auto' }).catch(() => undefined);
    }, AUTO_AFTER_READY_MS);
  };

  afterStartup(() => {
    ctx.db?.kv
      .get<MarketDataCheck>(MARKET_CHECK_NS, MARKET_CHECK_KEY)
      .then((row) => {
        if (fresh || !row || !isMarketDataCheck(row.value)) return;
        result = row.value;
        emit();
      })
      .catch(() => undefined);
    if (ctx.demo) return;
    ctx.ib.onReady(scheduleAuto);
    ctx.ib.onClosed(() => {
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = null;
    });
    if (isIbConnected(ctx)) scheduleAuto();
  });

  return { getState, run };
}
