// Market data subscriptions. UI owners declare the contracts they need; the service unions
// them per contract, keeps one reqMktData line per contract (with the union of the generic
// ticks), maps ticks into Quotes and batches changes to the renderer every 100 ms.
//
// IB traffic is kept low:
// - owner changes are reconciled once per RECONCILE_MS, so a burst of owner updates (a page
//   switch re-declares several owners) becomes one pass;
// - a contract no owner wants any more keeps its line for LINGER_MS before cancelMktData, so
//   switching back and forth reuses the live line; a line whose generic ticks already cover a
//   new profile set is kept as well;
// - lingering lines are the first to go when the line limit is reached, and visible views get
//   lines before background owners (subscriptions.ts).
// Renderer batches carry only the fields that changed per key; a key the renderer does not hold
// (new, or released and pruned there) gets the whole quote. A lingering line keeps its quote
// current in the main process without sending it, and so does a line only quiet owners (the
// market data check) want. probe() opens a line outside the owners, within the same line budget.
// In demo mode the quotes come from the simulator and IB is never asked for market data.
//
// Primary-exchange fallback. IB may send an account a stock's SMART (consolidated) quote delayed
// while the same stock's own exchange sends live data (seen on the paper account: AAPL on SMART
// type 3, on NASDAQ type 1, with the same subscriptions). For a SMART-routed US dollar stock whose
// line reports delayed data (marketDataType 3 / 4, or 10167 / 354 / 10168) a side line opens on its
// primary exchange (NASDAQ, NYSE, ARCA, AMEX, BATS: the codes contract details report, all served
// directly) with the same generic ticks:
//   smart --delayed--> probing primary --type 1 / 2--> primary (SMART line cancelled, quote.source set)
//                                      --delayed, error, SIDE_TIMEOUT_MS--> smart, no probe for PRIMARY_GIVE_UP_MS
//   primary --every SMART_RETRY_MS, when 10197 ends--> probing SMART --type 1 / 2--> smart (primary line cancelled)
//                                                                  --otherwise--> primary, next retry later
// A handshake (reconnect, 1101) starts every line on SMART again. Side lines count against the
// line budget and live at most SIDE_TIMEOUT_MS, so the steady state keeps one line per contract.

import { EventName } from '../ib/tws';
import type { ContractRef, MarketDataType, Quote, QuoteSubscription } from '@shared/types';
import type { MainContext, ProbeEvent, QuoteService } from '../context';
import { DEMO_TICK_MS, demoMarket } from './demo';
import { toIbContract } from './ibContract';
import { afterStartup, isIbConnected, isWarningCode } from './ibRequest';
import { allocateLines, coversTicks, genericTicksFor, LINE_LIMIT_ERROR, MAX_MARKET_DATA_LINES, SubscriptionBook, type WantedContract } from './subscriptions';
import { applyTick, type TickContext, type TickEvent } from './tickMap';

const FLUSH_MS = 100;
/** Owner changes within this window are reconciled in one pass. */
export const RECONCILE_MS = 16;
/** How long a released contract keeps its market data line. */
export const LINGER_MS = 30_000;
/** Share of simulated instruments that print on a given demo tick. */
const DEMO_ACTIVITY = 0.65;
/**
 * Errors after which IB has dropped the request: no data will arrive and cancelMktData would
 * only answer 300. (10197 is different: the line stays open and resumes when the competing
 * session ends.) With the delayed-frozen fallback IB may answer 354 and then serve delayed data
 * on the same line (10167, marketDataType, ticks; seen live on options): such a line is alive
 * again and is cancelled like any other (see revive).
 */
const DEAD_CODES = new Set([200, 321, 322, 354, 10168, 10186]);
/** "Requested market data is not subscribed. Displaying delayed market data." */
const DELAYED_FALLBACK_CODE = 10167;
/** Answers on a SMART line that mean delayed data (or none) for want of a live subscription. */
const DELAYED_SIGNALS = new Set([DELAYED_FALLBACK_CODE, 354, 10168]);
/** "No market data during competing live session". */
const COMPETING_SESSION = 10197;
/** Primary exchanges IB serves market data on directly (checked live for NASDAQ, NYSE, ARCA, AMEX, BATS). */
export const US_PRIMARY_EXCHANGES: ReadonlySet<string> = new Set(['NASDAQ', 'NYSE', 'ARCA', 'AMEX', 'BATS', 'IEX']);
/** A side line without a data type by then has failed. */
export const SIDE_TIMEOUT_MS = 10_000;
/** No new primary-exchange probe for this long after one was not live. */
export const PRIMARY_GIVE_UP_MS = 30 * 60_000;
/** How often a quote served by its primary exchange tries SMART again. */
export const SMART_RETRY_MS = 10 * 60_000;
/** Retry after a side line found no free market data line. */
const NO_LINE_RETRY_MS = 60_000;
/** Ticks a side line keeps until it becomes the quote's line. */
const SIDE_BUFFER = 64;

interface Line {
  key: string;
  reqId: number;
  ticks: string;
  contract: ContractRef;
  /** Passed to applyTick for every tick of the line (built once). */
  tickContext: TickContext;
  /** IB ended the request with an error. */
  dead: boolean;
  /** Already retried with a resolved (conId) contract after error 200. */
  resolved: boolean;
  /** Epoch ms when the last owner released the contract; undefined while it is wanted. */
  releasedAt?: number;
  /** SMART, or the primary exchange (fallback). */
  route: 'smart' | 'primary';
}

/** A line testing the other route of a contract (primary exchange while on SMART, or SMART again). */
interface Side {
  key: string;
  reqId: number;
  target: 'smart' | 'primary';
  contract: ContractRef;
  dead: boolean;
  timer: ReturnType<typeof setTimeout>;
  /** Ticks received before the switch, applied when it happens. */
  buffer: TickEvent[];
}

/** Fallback state of a contract (see the header). */
interface Route {
  /** The primary exchange the line uses now; undefined while on SMART. */
  primary?: string;
  primaryContract?: ContractRef;
  /** The SMART contract to go back to. */
  smart?: ContractRef;
  side?: Side;
  /** No primary-exchange probe before this time. */
  quietUntil?: number;
  /** The next SMART retry (on primary) or primary probe (after a give-up). */
  timer?: ReturnType<typeof setTimeout>;
  resolving?: boolean;
}

/** A SMART-routed US dollar stock (the only lines the fallback applies to). */
export function fallbackEligible(c: ContractRef): boolean {
  return c.secType === 'STK' && (c.currency || 'USD') === 'USD' && (c.exchange || 'SMART') === 'SMART';
}

/** A line opened by probe(), outside the owners. */
interface Probe {
  listener: (e: ProbeEvent) => void;
  /** IB ended the request with an error (it no longer holds a line). */
  dead: boolean;
}

type QuoteError = NonNullable<Quote['error']>;

const sameError = (a: QuoteError | undefined, b: QuoteError | undefined): boolean =>
  a === b || (!!a && !!b && a.code === b.code && a.message === b.message && !!a.final === !!b.final);

const isLineLimit = (e: QuoteError | undefined): boolean => e?.code === LINE_LIMIT_ERROR.code && e.message === LINE_LIMIT_ERROR.message;

/** A quote that carries more than its key and timestamp. */
function hasData(q: Quote): boolean {
  for (const k in q) if (k !== 'key' && k !== 'updatedAt' && q[k as keyof Quote] !== undefined) return true;
  return false;
}

/**
 * What the renderer needs to bring its copy (`prev`, the last batch sent for the key) up to `q`:
 * the changed fields (cleared ones as undefined, so the renderer's merge clears them too), or
 * null when nothing but the timestamp changed. Without `prev` the whole quote is sent, with an
 * explicit `error` so an error the renderer may still show is cleared.
 */
export function quotePatch(prev: Quote | undefined, q: Quote): Quote | null {
  if (!prev) return { ...q, error: q.error };
  const patch: Record<string, unknown> = { key: q.key };
  let changed = false;
  for (const k in q) {
    if (k === 'key' || k === 'updatedAt') continue;
    const v = q[k as keyof Quote];
    if (v !== prev[k as keyof Quote]) {
      patch[k] = v;
      changed = true;
    }
  }
  for (const k in prev) {
    if (!(k in q) && prev[k as keyof Quote] !== undefined) {
      patch[k] = undefined;
      changed = true;
    }
  }
  if (!changed) return null;
  patch.updatedAt = q.updatedAt;
  return patch as unknown as Quote;
}

export function createQuoteService(ctx: MainContext): QuoteService {
  const book = new SubscriptionBook();
  const quotes = new Map<string, Quote>();
  /** The renderer's copy per key (the quote as of the last batch); absent: send the whole quote. */
  const sent = new Map<string, Quote>();
  const listeners = new Set<(q: Quote) => void>();
  const noticeListeners = new Set<(key: string, code: number, message: string) => void>();
  const dirty = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;

  // IB lines, valid only while `ready` (between onReady and onClosed).
  const lines = new Map<string, Line>();
  const byReqId = new Map<number, Line>();
  const probes = new Map<number, Probe>();
  const routes = new Map<string, Route>();
  const sides = new Map<number, Side>();
  /** A 10197 was seen; the next real price ends it (then SMART is tried again). */
  let competing = false;
  let ready = false;

  // Demo feed.
  const demoWanted = new Map<string, WantedContract>();
  let demoTimer: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------------------
  // Quote store and batching

  const ensureQuote = (key: string): Quote => {
    let q = quotes.get(key);
    if (!q) {
      q = { key, updatedAt: Date.now() };
      quotes.set(key, q);
    }
    return q;
  };

  const deleteQuote = (key: string) => {
    forgetRoute(key);
    quotes.delete(key);
    sent.delete(key);
    dirty.delete(key);
  };

  const flush = () => {
    flushTimer = null;
    if (!dirty.size) return;
    const out: Record<string, Quote> = {};
    let count = 0;
    for (const key of dirty) {
      const q = quotes.get(key);
      if (!q || !book.published(key)) continue;
      const patch = quotePatch(sent.get(key), q);
      sent.set(key, { ...q });
      if (!patch) continue;
      out[key] = patch;
      count++;
    }
    dirty.clear();
    if (count) ctx.emit({ type: 'quotes', quotes: out });
  };

  const markDirty = (key: string) => {
    dirty.add(key);
    flushTimer ??= setTimeout(flush, FLUSH_MS);
  };

  /**
   * A quote changed. Lingering lines (no owner) keep their quote current without publishing it;
   * a quote only quiet owners want reaches the main-process listeners but not the renderer.
   */
  const publish = (q: Quote) => {
    q.updatedAt = Date.now();
    if (!book.has(q.key)) return;
    for (const listener of listeners) {
      try {
        listener(q);
      } catch (err) {
        console.error('[quotes] listener failed:', err);
      }
    }
    if (book.published(q.key)) markDirty(q.key);
  };

  /** Sets or clears (undefined) a quote's error. The key is kept so the renderer's merge clears it too. */
  const setError = (key: string, error: QuoteError | undefined) => {
    const q = ensureQuote(key);
    if (sameError(q.error, error)) return;
    q.error = error;
    publish(q);
  };

  // ---------------------------------------------------------------------------
  // IB lines

  const liveApi = () => (ready && !ctx.demo ? ctx.ib.api : null);

  const cancelLine = (line: Line) => {
    const side = routes.get(line.key)?.side;
    if (side) closeSide(side);
    lines.delete(line.key);
    byReqId.delete(line.reqId);
    const api = liveApi();
    if (line.dead || !api) return;
    try {
      api.cancelMktData(line.reqId);
    } catch (err) {
      console.error('[quotes] cancelMktData failed:', err);
    }
  };

  /** Cancels a line for good; its quote goes too unless an owner wants the contract again. */
  const dropLine = (line: Line) => {
    cancelLine(line);
    if (!book.has(line.key)) deleteQuote(line.key);
    else forgetRoute(line.key);
  };

  /** Requests a line (on the primary exchange while the contract's fallback is active); false when there is no session. */
  const requestLine = (w: WantedContract, wantedContract: ContractRef = w.contract, resolved = false): boolean => {
    const api = liveApi();
    if (!api) return false;
    const r = routes.get(w.key);
    const onPrimary = !!r?.primary && !!r.primaryContract && wantedContract === w.contract;
    const contract = onPrimary ? r!.primaryContract! : wantedContract;
    const isOption = contract.secType === 'OPT' || contract.secType === 'FOP';
    const line: Line = {
      key: w.key,
      reqId: ctx.ib.nextReqId(),
      ticks: genericTicksFor(contract, w.profiles),
      contract,
      tickContext: { isOption, right: contract.right, isCombo: contract.secType === 'BAG' },
      dead: false,
      resolved,
      route: onPrimary ? 'primary' : 'smart',
    };
    lines.set(line.key, line);
    byReqId.set(line.reqId, line);
    // A fresh request starts without the previous line's error; IB repeats it if it still applies.
    if (quotes.get(w.key)?.error) setError(w.key, undefined);
    else ensureQuote(w.key);
    const q = quotes.get(w.key)!;
    if (!onPrimary && q.source) {
      q.source = undefined; // back on SMART (a new session, or the fallback was dropped)
      publish(q);
    }
    try {
      api.reqMktData(line.reqId, toIbContract(contract), line.ticks, false, false);
    } catch (err) {
      line.dead = true;
      setError(w.key, { code: -1, message: err instanceof Error ? err.message : String(err), final: true });
    }
    return true;
  };

  /** Retries a contract IB could not identify (error 200) with its resolved conId, once. */
  const retryResolved = async (line: Line) => {
    try {
      const resolved = await ctx.contracts.resolve(line.contract);
      if (lines.get(line.key) !== line || line.releasedAt !== undefined || !resolved.conId) return;
      const w = book.wanted().find((x) => x.key === line.key);
      if (!w) return;
      cancelLine(line);
      requestLine(w, resolved, true);
    } catch {
      // The 200 error stays on the quote.
    }
  };

  /** Lines that hold one of IB's market data lines (dead requests do not), probes and side lines included. */
  const openLineCount = (): number => {
    let n = 0;
    for (const line of lines.values()) if (!line.dead) n++;
    for (const p of probes.values()) if (!p.dead) n++;
    for (const side of sides.values()) if (!side.dead) n++;
    return n;
  };

  /** Frees the line of the contract released longest ago; false when no line lingers. */
  const reclaimLingering = (): boolean => {
    let oldest: Line | undefined;
    for (const line of lines.values()) {
      if (line.releasedAt === undefined || line.dead) continue;
      if (!oldest || line.releasedAt < oldest.releasedAt!) oldest = line;
    }
    if (!oldest) return false;
    dropLine(oldest);
    return true;
  };

  const sweep = () => {
    sweepTimer = null;
    const now = Date.now();
    for (const line of [...lines.values()]) {
      if (line.releasedAt !== undefined && now - line.releasedAt >= LINGER_MS) dropLine(line);
    }
    scheduleSweep();
  };

  /** Wakes up when the next lingering line is due. */
  const scheduleSweep = () => {
    let due = Infinity;
    for (const line of lines.values()) if (line.releasedAt !== undefined) due = Math.min(due, line.releasedAt + LINGER_MS);
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = Number.isFinite(due) ? setTimeout(sweep, Math.max(0, due - Date.now())) : null;
  };

  // ---------------------------------------------------------------------------
  // Primary-exchange fallback (see the header)

  const routeOf = (key: string): Route => {
    let r = routes.get(key);
    if (!r) routes.set(key, (r = {}));
    return r;
  };

  const clearRouteTimer = (r: Route) => {
    if (r.timer) clearTimeout(r.timer);
    r.timer = undefined;
  };

  /** Cancels a side line (at IB too, unless IB ended it). */
  const closeSide = (side: Side) => {
    clearTimeout(side.timer);
    sides.delete(side.reqId);
    const r = routes.get(side.key);
    if (r?.side === side) r.side = undefined;
    const api = liveApi();
    if (side.dead || !api) return;
    try {
      api.cancelMktData(side.reqId);
    } catch (err) {
      console.error('[quotes] cancelMktData failed:', err);
    }
  };

  /** Drops a contract's fallback state (its line went for good). */
  const forgetRoute = (key: string) => {
    const r = routes.get(key);
    if (!r) return;
    if (r.side) closeSide(r.side);
    clearRouteTimer(r);
    routes.delete(key);
  };

  /** Opens a side line with the line's generic ticks; false when no line is free or there is no session. */
  const openSide = (line: Line, target: Side['target'], contract: ContractRef): boolean => {
    const api = liveApi();
    if (!api) return false;
    if (openLineCount() >= MAX_MARKET_DATA_LINES && !reclaimLingering()) return false;
    const side: Side = { key: line.key, reqId: ctx.ib.nextReqId(), target, contract, dead: false, buffer: [], timer: undefined! };
    side.timer = setTimeout(() => sideAnswered(side), SIDE_TIMEOUT_MS);
    sides.set(side.reqId, side);
    routeOf(line.key).side = side;
    try {
      api.reqMktData(side.reqId, toIbContract(contract), line.ticks, false, false);
    } catch (err) {
      console.error('[quotes] side reqMktData failed:', err);
      side.dead = true;
      closeSide(side);
      return false;
    }
    return true;
  };

  /** A SMART line answered delayed: probes its primary exchange unless one was tried lately. */
  const probePrimary = async (line: Line) => {
    if (line.route !== 'smart' || !fallbackEligible(line.contract) || line.releasedAt !== undefined) return;
    const r = routeOf(line.key);
    if (r.side || r.resolving || r.primary || (r.quietUntil ?? 0) > Date.now()) return;
    let c = line.contract;
    if (!c.primaryExchange || !c.conId) {
      r.resolving = true;
      try {
        c = { ...c, ...(await ctx.contracts.resolve(c)) };
      } catch {
        r.resolving = false;
        quiet(line.key, PRIMARY_GIVE_UP_MS);
        return;
      }
      r.resolving = false;
      if (lines.get(line.key) !== line || routes.get(line.key) !== r || r.side || r.primary) return;
    }
    const exchange = c.primaryExchange?.toUpperCase();
    if (!exchange || !US_PRIMARY_EXCHANGES.has(exchange)) {
      r.quietUntil = Infinity; // not a US listing IB serves directly
      return;
    }
    r.smart = line.contract;
    if (!openSide(line, 'primary', { ...c, exchange })) quiet(line.key, NO_LINE_RETRY_MS);
  };

  /** No primary probe for `ms`; then one, if the SMART line is still delayed. */
  const quiet = (key: string, ms: number) => {
    const r = routeOf(key);
    r.quietUntil = Date.now() + ms;
    clearRouteTimer(r);
    r.timer = setTimeout(() => {
      r.timer = undefined;
      r.quietUntil = undefined;
      const line = lines.get(key);
      if (line && isDelayed(quotes.get(key))) void probePrimary(line);
    }, ms);
  };

  const isDelayed = (q: Quote | undefined): boolean =>
    !!q && (q.marketDataType === 3 || q.marketDataType === 4 || (q.error != null && DELAYED_SIGNALS.has(q.error.code)));

  /** Tries SMART again for a quote served by its primary exchange (now, or after `ms`). */
  const scheduleSmartRetry = (key: string, ms: number) => {
    const r = routeOf(key);
    clearRouteTimer(r);
    r.timer = setTimeout(() => {
      r.timer = undefined;
      const line = lines.get(key);
      if (!line || line.route !== 'primary' || !r.smart || r.side) return;
      // A lingering line is not worth a second line; it tries again if it is wanted by then.
      if (line.releasedAt !== undefined || !openSide(line, 'smart', r.smart)) scheduleSmartRetry(key, NO_LINE_RETRY_MS);
    }, ms);
  };

  /** A side line answered (type 1 / 2: switch to it), failed or timed out. */
  const sideAnswered = (side: Side, type?: MarketDataType) => {
    if (sides.get(side.reqId) !== side) return;
    const line = lines.get(side.key);
    if (line && (type === 1 || type === 2)) {
      switchTo(line, side, type);
      return;
    }
    closeSide(side);
    if (!line) return;
    if (side.target === 'primary') quiet(side.key, PRIMARY_GIVE_UP_MS);
    else scheduleSmartRetry(side.key, SMART_RETRY_MS);
  };

  /** The side line becomes the contract's line; the old one is cancelled. */
  const switchTo = (line: Line, side: Side, type: MarketDataType) => {
    clearTimeout(side.timer);
    sides.delete(side.reqId);
    const r = routeOf(line.key);
    r.side = undefined;
    byReqId.delete(line.reqId);
    const api = liveApi();
    if (!line.dead && api) {
      try {
        api.cancelMktData(line.reqId);
      } catch (err) {
        console.error('[quotes] cancelMktData failed:', err);
      }
    }
    const next: Line = { ...line, reqId: side.reqId, contract: side.contract, dead: false, resolved: true, route: side.target };
    lines.set(next.key, next);
    byReqId.set(next.reqId, next);
    const q = ensureQuote(next.key);
    if (side.target === 'primary') {
      r.primary = side.contract.exchange;
      r.primaryContract = side.contract;
      q.source = { kind: 'primary', exchange: side.contract.exchange };
      scheduleSmartRetry(next.key, SMART_RETRY_MS);
    } else {
      r.primary = undefined;
      r.quietUntil = undefined;
      clearRouteTimer(r);
      q.source = undefined;
    }
    q.marketDataType = type;
    q.error = undefined;
    for (const t of side.buffer) applyTick(q, t, next.tickContext);
    publish(q);
  };

  /** 10197 ended (a real price arrived): SMART gets another chance everywhere. */
  const competingEnded = () => {
    competing = false;
    for (const [key, r] of routes) {
      if (r.primary) scheduleSmartRetry(key, 0);
      else if (r.quietUntil !== undefined && r.quietUntil !== Infinity) quiet(key, 0);
    }
  };

  const reconcileLive = (wanted: WantedContract[]) => {
    const { active, overflow } = allocateLines(wanted, MAX_MARKET_DATA_LINES);
    const activeByKey = new Map(active.map((w) => [w.key, w]));
    const now = Date.now();
    for (const line of [...lines.values()]) {
      const w = activeByKey.get(line.key);
      if (w) {
        // Reused as long as its ticks cover the profiles now wanted; otherwise requested again below.
        if (coversTicks(line.ticks, genericTicksFor(line.contract, w.profiles))) line.releasedAt = undefined;
        else cancelLine(line);
      } else if (book.has(line.key)) {
        cancelLine(line); // still wanted, but a contract with a higher priority gets the line
      } else {
        line.releasedAt ??= now;
      }
    }
    let open = openLineCount();
    for (const w of active) {
      const limited = isLineLimit(quotes.get(w.key)?.error);
      if (lines.has(w.key)) {
        if (limited) setError(w.key, undefined);
        continue;
      }
      if (open >= MAX_MARKET_DATA_LINES) {
        // Probe lines hold the rest for a few seconds; closing them reconciles again.
        if (!reclaimLingering()) {
          if (!limited) setError(w.key, { ...LINE_LIMIT_ERROR, final: true });
          continue;
        }
        open--;
      }
      if (requestLine(w)) open++;
      else if (limited) setError(w.key, undefined);
    }
    for (const w of overflow) setError(w.key, { ...LINE_LIMIT_ERROR, final: true });
    scheduleSweep();
  };

  // ---------------------------------------------------------------------------
  // Demo feed

  const demoPublish = (w: WantedContract) => {
    const snapshot = demoMarket().quote(w.contract, w.profiles);
    if (!snapshot) {
      setError(w.key, { code: -1, message: 'No simulated data for this instrument', final: true });
      return;
    }
    const q = ensureQuote(w.key);
    Object.assign(q, snapshot);
    if (q.error) q.error = undefined;
    publish(q);
  };

  /** Moves the instruments that print on this tick and publishes everything priced off them. */
  const demoTick = () => {
    const symbols = new Set([...demoWanted.values()].filter((w) => w.contract.secType !== 'BAG').map((w) => w.contract.symbol.toUpperCase()));
    const moving = [...symbols].filter(() => Math.random() < DEMO_ACTIVITY);
    demoMarket().advance(moving);
    const moved = new Set(moving);
    for (const w of demoWanted.values()) if (moved.has(w.contract.symbol.toUpperCase())) demoPublish(w);
  };

  const reconcileDemo = (wanted: WantedContract[]) => {
    const before = new Set(demoWanted.keys());
    demoWanted.clear();
    for (const w of wanted) demoWanted.set(w.key, w);
    for (const w of wanted) if (!before.has(w.key)) demoPublish(w);
    if (demoWanted.size && !demoTimer) demoTimer = setInterval(demoTick, DEMO_TICK_MS);
    if (!demoWanted.size && demoTimer) {
      clearInterval(demoTimer);
      demoTimer = null;
    }
  };

  // ---------------------------------------------------------------------------

  /** Drops quotes nobody wants that have no line either. */
  const pruneQuotes = () => {
    for (const key of [...quotes.keys()]) if (!book.has(key) && !lines.has(key)) deleteQuote(key);
  };

  const reconcile = () => {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = null;
    // The renderer drops quotes no owner wants: a key wanted again later gets the whole quote.
    for (const key of sent.keys()) if (!book.published(key)) sent.delete(key);
    pruneQuotes();
    const wanted = book.wanted();
    if (ctx.demo) reconcileDemo(wanted);
    else reconcileLive(wanted);
    // A reused line already has data the renderer lacks: send it now rather than at the next tick.
    for (const w of wanted) {
      const q = quotes.get(w.key);
      if (q && book.published(w.key) && !sent.has(w.key) && hasData(q)) markDirty(w.key);
    }
  };

  const scheduleReconcile = () => {
    reconcileTimer ??= setTimeout(reconcile, RECONCILE_MS);
  };

  /** A line reported dead serves data after all (delayed fallback): IB holds it, so it must be cancelled later. */
  const revive = (line: Line) => {
    line.dead = false;
    if (quotes.get(line.key)?.error?.final) setError(line.key, undefined);
  };

  /** Calls a probe's listener; false when the request id is not a probe. */
  const toProbe = (reqId: number, e: ProbeEvent): boolean => {
    const p = probes.get(reqId);
    if (!p) return false;
    try {
      p.listener(e);
    } catch (err) {
      console.error('[quotes] probe listener failed:', err);
    }
    return true;
  };

  const onTick = (reqId: number, tick: TickEvent) => {
    if (probes.has(reqId)) {
      if (tick.kind !== 'option' && tick.value !== undefined) toProbe(reqId, { kind: 'tick', field: tick.field, value: tick.value });
      return;
    }
    const side = sides.get(reqId);
    if (side) {
      if (side.buffer.length < SIDE_BUFFER) side.buffer.push(tick);
      return;
    }
    const line = byReqId.get(reqId);
    if (!line) return;
    if (line.dead) revive(line);
    if (competing && tick.kind === 'price' && (tick.value ?? 0) > 0) competingEnded();
    const q = quotes.get(line.key) ?? ensureQuote(line.key);
    let changed = applyTick(q, tick, line.tickContext);
    if (q.error) {
      q.error = undefined; // data is flowing again
      changed = true;
    }
    if (changed) publish(q);
  };

  const onLineError = (e: { reqId: number; code: number; message: string }) => {
    const probe = probes.get(e.reqId);
    if (probe) {
      if (DEAD_CODES.has(e.code) && !probe.dead) {
        probe.dead = true;
        scheduleReconcile(); // its line is free again
      } else if (e.code === DELAYED_FALLBACK_CODE) probe.dead = false;
      toProbe(e.reqId, { kind: 'error', code: e.code, message: e.message });
      return;
    }
    if (e.code === COMPETING_SESSION) competing = true;
    const side = sides.get(e.reqId);
    if (side) {
      // 10167: delayed on this route too. Other notices do not end the line; errors do.
      if (isWarningCode(e.code) && e.code !== DELAYED_FALLBACK_CODE) return;
      if (DEAD_CODES.has(e.code)) side.dead = true;
      sideAnswered(side);
      return;
    }
    const line = byReqId.get(e.reqId);
    if (!line) return;
    if (DELAYED_SIGNALS.has(e.code) && line.route === 'smart') void probePrimary(line);
    // 21xx are notices (farm status, fractional size rules); 10167 (delayed data shown) and
    // 10090 / 10091 (some ticks not subscribed) still deliver data, and marketDataType reports the kind.
    if (isWarningCode(e.code)) {
      if (e.code === DELAYED_FALLBACK_CODE && line.dead) revive(line);
      if (book.has(line.key)) {
        for (const l of noticeListeners) {
          try {
            l(line.key, e.code, e.message);
          } catch (err) {
            console.error('[quotes] notice listener failed:', err);
          }
        }
      }
      return;
    }
    const retry = e.code === 200 && !line.resolved && !line.contract.conId && line.contract.secType !== 'BAG';
    if (DEAD_CODES.has(e.code)) line.dead = true;
    setError(line.key, { code: e.code, message: e.message, ...(line.dead && !retry ? { final: true } : {}) });
    if (retry) void retryResolved(line);
  };

  const forgetLines = () => {
    lines.clear();
    byReqId.clear();
    // Every line starts on SMART again (a reconnect is a reason to try it).
    for (const r of routes.values()) clearRouteTimer(r);
    for (const side of sides.values()) clearTimeout(side.timer);
    routes.clear();
    sides.clear();
    competing = false;
    // The session is gone and its probes with it.
    const open = [...probes.keys()];
    for (const id of open) toProbe(id, { kind: 'error', code: -1, message: 'Connection closed' });
    probes.clear();
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = null;
    pruneQuotes();
  };

  /**
   * After every handshake, and when IB reports that market data was lost (1101), the old
   * request ids are gone: everything is requested again.
   */
  const onReady = () => {
    if (ctx.demo) return;
    forgetLines();
    ready = true;
    try {
      // Delayed-frozen fallback: live where subscribed, delayed otherwise, last values when closed.
      ctx.ib.api?.reqMarketDataType(4);
    } catch (err) {
      console.error('[quotes] reqMarketDataType failed:', err);
    }
    reconcile();
  };

  const onClosed = () => {
    ready = false;
    forgetLines();
  };

  afterStartup(() => {
    const ib = ctx.ib;
    ib.on(EventName.tickPrice, (reqId: number, field: number, value: number) => onTick(reqId, { kind: 'price', field, value }));
    ib.on(EventName.tickSize, (reqId: number, field: number, value: number) => onTick(reqId, { kind: 'size', field, value }));
    ib.on(EventName.tickGeneric, (reqId: number, field: number, value: number) => onTick(reqId, { kind: 'generic', field, value }));
    ib.on(EventName.tickString, (reqId: number, field: number, value: string) => onTick(reqId, { kind: 'string', field, value }));
    ib.on(
      EventName.tickOptionComputation,
      (reqId: number, field: number, _attrib: unknown, iv?: number, delta?: number, _optPrice?: number, _pvDividend?: number, gamma?: number, vega?: number, theta?: number, undPrice?: number) =>
        onTick(reqId, { kind: 'option', field, iv, delta, gamma, vega, theta, undPrice }),
    );
    ib.on(EventName.marketDataType, (reqId: number, type: number) => {
      if (type < 1 || type > 4) return;
      if (probes.has(reqId)) {
        probes.get(reqId)!.dead = false;
        toProbe(reqId, { kind: 'type', type: type as MarketDataType });
        return;
      }
      const side = sides.get(reqId);
      if (side) {
        sideAnswered(side, type as MarketDataType);
        return;
      }
      const line = byReqId.get(reqId);
      if (!line) return;
      if (line.dead) revive(line);
      if (type === 3 || type === 4) {
        if (line.route === 'smart') void probePrimary(line);
        else scheduleSmartRetry(line.key, 0); // the exchange went delayed: back to SMART if it is live
      }
      const q = ensureQuote(line.key);
      if (q.marketDataType === type) return;
      q.marketDataType = type as MarketDataType;
      publish(q);
    });
    ib.onRequestError(onLineError);
    ib.onReady(onReady);
    ib.onClosed(onClosed);
    if (!ctx.demo && isIbConnected(ctx)) onReady();
  });

  return {
    setSubscriptions(owner: string, subs: QuoteSubscription[]) {
      if (book.set(String(owner), Array.isArray(subs) ? subs : [])) scheduleReconcile();
    },
    getQuote: (key) => quotes.get(key),
    onQuote(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onNotice(listener) {
      noticeListeners.add(listener);
      return () => void noticeListeners.delete(listener);
    },
    wanted() {
      const out = book.wanted().map((w) => ({ contract: w.contract, quote: quotes.get(w.key) }));
      for (const line of lines.values()) if (line.releasedAt !== undefined && !line.dead) out.push({ contract: line.contract, quote: quotes.get(line.key) });
      return out;
    },
    probe(contract, genericTicks, listener) {
      const api = liveApi();
      if (!api) return null;
      if (openLineCount() >= MAX_MARKET_DATA_LINES && !reclaimLingering()) return null;
      const reqId = ctx.ib.nextReqId();
      const probe: Probe = { listener, dead: false };
      probes.set(reqId, probe);
      try {
        api.reqMktData(reqId, toIbContract(contract), genericTicks, false, false);
      } catch (err) {
        probes.delete(reqId);
        console.error('[quotes] probe reqMktData failed:', err);
        return null;
      }
      return {
        close() {
          if (probes.get(reqId) !== probe) return;
          probes.delete(reqId);
          const live = liveApi();
          if (probe.dead || !live) return;
          scheduleReconcile(); // a contract may wait for this line
          try {
            live.cancelMktData(reqId);
          } catch (err) {
            console.error('[quotes] cancelMktData failed:', err);
          }
        },
      };
    },
  };
}
