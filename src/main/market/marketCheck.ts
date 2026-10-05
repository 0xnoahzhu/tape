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
// - Level 2 (only on the user's request, "Check now"): one reqMktDepth for SPY, or the book the
//   depth view already has.
// Owners reuse open lines (an instrument already subscribed is not requested again, and its answer
// is known at once); everything is released afterwards (owner lines linger 30 s like any other).
// The answer of a line is its marketDataType (1 live, 2 frozen, 3 / 4 delayed) or its error; after
// the first answer the line is watched SETTLE_MS longer, since IB may send a type and then an error
// (10197); after 354 it waits up to AFTER_NOT_SUBSCRIBED_MS, since IB then often serves delayed data
// on the same line (seen live for SPX: 354, half a second later type 3 and 10167). No answer within
// PROBE_TIMEOUT_MS counts as no data. Level 2 from only some exchanges (IB's 2152 lists them) is
// live "via" those exchanges.
//
// The last result is kept here, persisted in the kv table (namespace MARKET_CHECK_NS) and pushed as
// `marketDataCheck` events. A quiet check (without depth) runs AUTO_AFTER_READY_MS after each
// handshake unless one ran within AUTO_MIN_INTERVAL_MS for the same account.

import { EventName } from '../ib/tws';
import { contractKey, contractLabel, index, option, stock } from '@shared/contract';
import { depthPermissions } from '@shared/depthPermissions';
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
} from '@shared/types';
import type { MainContext, MarketCheckService, Unsubscribe } from '../context';
import { toIbContract } from './ibContract';
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

  const getState = (): MarketDataCheckState => ({ result, running: inflight != null });
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

  /** One reqMktDepth for a few seconds (or the depth view's book when it already shows one). */
  const checkDepth = (onClose: (fn: () => void) => void): Promise<{ probe: MarketCheckProbe; instrument: string }> => {
    const book = ctx.depth.current();
    if (book && !book.error && (book.bids.length || book.asks.length)) {
      return Promise.resolve({ probe: { status: 'live', exchange: 'SMART', reused: true }, instrument: book.key.split(':')[1] ?? book.key });
    }
    const instrument = contractLabel(CHECK_STOCK);
    if (ctx.demo) return Promise.resolve({ probe: { status: 'live', exchange: 'SMART' }, instrument });
    const api = ctx.ib.api;
    if (!api) return Promise.resolve({ probe: { status: 'nodata', exchange: 'SMART', code: OWN_CODE, message: NOT_CONNECTED }, instrument });
    return new Promise((resolve) => {
      const reqId = ctx.ib.nextReqId();
      let dead = false;
      let notice: { code: number; message: string } | undefined;
      let finished = false;
      const offs: Unsubscribe[] = [];
      const finish = (probe: MarketCheckProbe) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        offs.forEach((off) => off());
        if (!dead && ctx.ib.api) {
          try {
            ctx.ib.api.cancelMktDepth(reqId, true);
          } catch (err) {
            console.error('[md-check] cancelMktDepth failed:', err);
          }
        }
        resolve({ probe, instrument });
      };
      const timer = setTimeout(
        () =>
          finish({
            status: 'nodata',
            exchange: 'SMART',
            ...(notice ?? competing() ?? { code: OWN_CODE, message: `No book from IB within ${PROBE_TIMEOUT_MS / 1000} s`, own: 'timeout' as const }),
          }),
        PROBE_TIMEOUT_MS,
      );
      const onUpdate = (id: number) => id === reqId && finish({ status: 'live', exchange: 'SMART', ...(notice ?? {}) });
      offs.push(ctx.ib.on(EventName.updateMktDepth, onUpdate));
      offs.push(ctx.ib.on(EventName.updateMktDepthL2, onUpdate));
      offs.push(
        ctx.ib.onRequestError((e) => {
          if (e.reqId !== reqId || e.code === DEPTH_RESET) return;
          // 2152: the account lacks depth permissions on some exchanges; the others may still answer.
          if (e.code >= 2100 && e.code < 2200) {
            notice ??= { code: e.code, message: e.message };
            return;
          }
          dead = DEPTH_DEAD_CODES.has(e.code);
          finish({ status: 'nodata', exchange: 'SMART', code: e.code, message: e.message });
        }),
      );
      onClose(() => {
        dead = true;
        finish({ status: 'nodata', exchange: 'SMART', code: OWN_CODE, message: 'Connection closed', own: 'closed' });
      });
      try {
        api.reqMktDepth(reqId, toIbContract(CHECK_STOCK), DEPTH_ROWS, true, []);
      } catch (err) {
        dead = true;
        finish({ status: 'nodata', exchange: 'SMART', code: OWN_CODE, message: err instanceof Error ? err.message : String(err) });
      }
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

  const check = async (depth: boolean, trigger: MarketDataCheck['trigger']): Promise<MarketDataCheck> => {
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
      const depthP = depth ? checkDepth(onClose) : Promise.resolve(null);

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
      const fallback = ctx.quotes
        .wanted()
        .filter((w) => w.quote?.source?.kind === 'primary')
        .map((w) => ({ symbol: contractLabel(w.contract), exchange: w.quote!.source!.exchange }));
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
      if (book) {
        const depthItem: MarketCheckItem = { market: 'depth', status: book.probe.status, instrument: book.instrument, probe: book.probe, checkedAt: now };
        // Live from some exchanges only (2152 names them): "Live · IEX only".
        const perms = book.probe.status === 'live' && book.probe.code === 2152 ? depthPermissions(book.probe.message) : null;
        if (perms?.depth.length && perms.missing.length) depthItem.via = perms.depth.join(', ');
        items.push(depthItem);
      }
      else {
        // Level 2 is only checked on request: keep the last answer of this account.
        const prev = result?.account === accountNow() ? result?.items.find((i) => i.market === 'depth') : undefined;
        if (prev) items.push(prev);
      }
      items.push({ market: 'ind', status: ind.status, instrument: contractLabel(CHECK_INDEX), probe: ind, checkedAt: now });
      const state = ctx.ib.getState();
      return { checkedAt: now, account: accountNow(), clientId: state.clientId, trigger, items };
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
    const promise = check(depth, opts.trigger).then(
      (r) => {
        result = r;
        fresh = true;
        inflight = null;
        void ctx.db?.kv.set(MARKET_CHECK_NS, MARKET_CHECK_KEY, r);
        emit();
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
