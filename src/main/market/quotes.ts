// Market data subscriptions. UI owners declare the contracts they need; the service unions
// them per contract, keeps one reqMktData line per contract (with the union of the generic
// ticks), maps ticks into Quotes and batches changes to the renderer every 100 ms.
//
// IB traffic is kept low:
// - owner changes are reconciled once per RECONCILE_MS, so a burst of owner updates (a page
//   switch re-declares several owners) becomes one pass;
// - a contract no owner wants any more keeps its line for LINGER_MS before cancelMktData, so
//   switching back and forth reuses the live line; a line whose generic ticks already cover a
//   new profile set is kept as well, unless it carries RTVolume (233, a message per trade) that no
//   owner wants any more (subscriptions.ts → lineServes);
// - lingering lines are the first to go when the line limit is reached, and visible views get
//   lines before background owners (subscriptions.ts).
// Renderer batches carry only the fields that changed per key; a key the renderer does not hold
// (new, or released and pruned there) gets the whole quote, listed in the batch's `full`. The
// renderer holds exactly the quotes its own owners want, so only those are sent (`sent` mirrors its
// copies): a lingering line keeps its quote current in the main process without sending it, and so
// does a line only main-process owners (price alerts, the market data check) want. A renderer that
// is replaced or closed takes its owners with it (resetRenderer), and one that gets changes for a
// quote it does not hold asks for the whole quote (resend). probe() opens a line outside the
// owners, within the same line budget. In demo mode the quotes come from the simulator and IB is
// never asked for market data.
//
// Previous close. IB sends it (tick 9, or 75 delayed) with a request's first ticks and otherwise
// only when it changes; tickMap.ts never lets a "not available" close erase the close its line
// sent. A line may stream prices without a close (it started without its subscription image: seen
// live on lines opened during a competing session, and in the API log of 2026-10-29 on 395 of 594
// stock lines, mostly lines requested again right after their cancel, which were also how a
// missing close was retried: 29 of 159 such requests brought one). CLOSE_WAIT_MS after its first
// price such a quote takes, for a US stock, the close of the last session before the trading day
// (shared/session.ts → tradingDay) from IB's daily bars (a background history request, cached;
// once per contract and trading day, again CLOSE_RETRY_MS after a failure), and keeps that close
// until the trading day changes or the line sends its own; the line is not requested again. Other
// instruments that have a close, and a stock whose bars bring none, get their line requested
// again, at most once per CLOSE_RETRY_MS per contract.
//
// Dividends. IB sends its dividend summary (tick 59) once, with a line's first ticks, and not on
// every line (none of 335 requests on 2026-10-29, though every one on 2026-10-24). The last summary
// IB sent is kept per contract (in memory and in the kv namespace DIVIDENDS_NS) and stands in on a
// line asking for it (456) until the line sends its own, while its next ex-date is not past and it
// is at most DIVIDENDS_MAX_AGE_MS old.
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
//   primary --the exchange line turns delayed--> probing SMART --live--> smart
//                                                              --otherwise--> smart anyway (a delayed consolidated
//                                                                 quote beats one exchange's), no probe for PRIMARY_GIVE_UP_MS
// A handshake (reconnect, 1101) starts every line on SMART again. Side lines count against the
// line budget (they only take free lines, never a lingering one) and live at most SIDE_TIMEOUT_MS,
// so the steady state keeps one line per contract. A 10197 episode ends with a live price on an
// owner line that reported it (side lines never start one), at most once per COMPETING_END_MIN_MS.
// Two things outlive a contract's route (which goes with its line): the give-up times (no primary
// probe before then, until a new session) and the fallback findings of this account (a stock found
// SMART delayed and its exchange live, until SMART or the exchange says otherwise), which the
// market data check reports.
//
// Generic ticks. A line asks for the union of its owners' profiles (subscriptions.ts), within the ids
// IB accepts. Should IB still refuse the list (error 321), IB has dropped the request and the line is
// requested again with less, so its prices never stop: 'full' → 'core' (without the add-on profiles)
// → 'none' (no generic tick); only a 321 on a line without generic ticks ends it. A 321 naming the
// generic tick list is remembered for the run per instrument type and list (other lines of that type
// skip it), any other 321 per contract; each is logged once, and the quote's `ticksRefused` says what
// the line runs without. A line's generic values never outlive it: every new line starts without
// them and without the bond yields (tickMap.ts → clearGenericFields; only the mark stays, when the
// new line asks for it too). A line whose data type changes between live (1, 2) and delayed (3, 4)
// loses those IB sends on live lines only, and the yields (clearLiveOnlyFields); it keeps the ones IB
// sends on delayed lines too, some only once a line (the week ranges, open interest). So a field IB
// does not send there shows "—" instead of an older value (the dividends excepted, see Dividends).

import { EventName } from '../ib/tws';
import { contractLabel } from '@shared/contract';
import { nyClock, tradingDay } from '@shared/session';
import type { Bar, ContractRef, MarketDataType, Quote, QuoteDividends, QuoteSubscription, SecType } from '@shared/types';
import type { FallbackFinding, MainContext, ProbeEvent, QuoteService } from '../context';
import { DEMO_TICK_MS, demoMarket } from './demo';
import { toIbContract } from './ibContract';
import { afterStartup, isIbConnected, isWarningCode } from './ibRequest';
import { allocateLines, coversTicks, genericTicksFor, LINE_LIMIT_ERROR, lineServes, MAX_MARKET_DATA_LINES, SubscriptionBook, type TickLevel, type WantedContract } from './subscriptions';
import { applyTick, clearGenericFields, clearLiveOnlyFields, parseDividends, TICK, type TickContext, type TickEvent } from './tickMap';

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
/** "Error validating request": for an owner line with generic ticks, IB refused (some of) them. */
const TICKS_REFUSED = 321;
/** A side line without a data type by then has failed. */
export const SIDE_TIMEOUT_MS = 10_000;
/** No new primary-exchange probe for this long after one was not live. */
export const PRIMARY_GIVE_UP_MS = 30 * 60_000;
/** How often a quote served by its primary exchange tries SMART again. */
export const SMART_RETRY_MS = 10 * 60_000;
/** Retry after a side line found no free market data line. */
const NO_LINE_RETRY_MS = 60_000;
/** The end of a 10197 episode re-probes routes at most this often. */
export const COMPETING_END_MIN_MS = 60_000;
/** A quote with prices but no previous close this long after the first one gets one from daily bars, or its line is requested again. */
export const CLOSE_WAIT_MS = 12_000;
/** The least time between two requests of a contract's line, or two failed daily-bar loads, for its close. */
export const CLOSE_RETRY_MS = 15 * 60_000;
/** Known dividend summaries (IB's tick 59) per contract key. */
export const DIVIDENDS_NS = 'dividends';
/** A kept dividend summary older than this no longer stands in for IB's. */
export const DIVIDENDS_MAX_AGE_MS = 14 * 24 * 3_600_000;
/** Instruments that have a previous close (an option may never have traded, a combo has none of its own). */
const CLOSE_TYPES: ReadonlySet<SecType> = new Set(['STK', 'IND', 'FUT', 'CASH', 'CFD']);

interface Line {
  key: string;
  reqId: number;
  ticks: string;
  /** How much of the wanted generic tick list the line asked for (see the header). */
  level: TickLevel;
  /** The line's last marketDataType (undefined until IB sends one). */
  dataType?: MarketDataType;
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
  /** Ticks received before the switch, the latest per kind and field, applied when it happens. */
  buffer: Map<string, TickEvent>;
}

/** Fallback state of a contract (see the header). */
interface Route {
  /** The primary exchange the line uses now; undefined while on SMART. */
  primary?: string;
  primaryContract?: ContractRef;
  /** The SMART contract to go back to. */
  smart?: ContractRef;
  side?: Side;
  /** The next SMART retry (on primary) or primary probe (after a give-up, see `quietUntil`). */
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

/** Delayed data (3, 4) as opposed to live (1, 2): IB sends some generic ticks on live lines only. */
const delayedType = (t: MarketDataType): boolean => t === 3 || t === 4;

const lowerLevel = (l: TickLevel): TickLevel => (l === 'full' ? 'core' : 'none');

/** A quote that carries more than its key and timestamp. */
function hasData(q: Quote): boolean {
  for (const k in q) if (k !== 'key' && k !== 'updatedAt' && q[k as keyof Quote] !== undefined) return true;
  return false;
}

const hasPrice = (q: Quote): boolean => q.last !== undefined || q.bid !== undefined || q.ask !== undefined;

/** Instruments whose missing close comes from daily bars: US stocks, whose trading day tradingDay() tells. */
const barsCloseFor = (c: ContractRef): boolean => c.secType === 'STK' && (c.currency ?? 'USD') === 'USD';

/**
 * The previous close for trading day `day` (YYYYMMDD): the close of the newest daily bar (stamped
 * 00:00 UTC on its date) before that day, or undefined.
 */
export function previousCloseFromBars(bars: readonly Bar[], day: string): number | undefined {
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    if (new Date(b.time * 1000).toISOString().slice(0, 10).replaceAll('-', '') >= day) continue;
    return Number.isFinite(b.close) && b.close > 0 ? b.close : undefined;
  }
  return undefined;
}

/** Whether a kept dividend summary (stored at `at`) may stand in at `now`: recent, and its next ex-date not past. */
export function keptDividendsUsable(d: QuoteDividends, at: number, now: number): boolean {
  return now - at <= DIVIDENDS_MAX_AGE_MS && (!d.nextDate || d.nextDate >= nyClock(new Date(now)).ymd);
}

const sameDividends = (a: QuoteDividends, b: QuoteDividends): boolean =>
  a.past12m === b.past12m && a.next12m === b.next12m && a.nextDate === b.nextDate && a.nextAmount === b.nextAmount;

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
  /** Pending checks for a priced quote without a previous close (checkClose). */
  const closeChecks = new Map<string, ReturnType<typeof setTimeout>>();
  /** Lines requested again for their close, per contract, since its last close: the last time. */
  const closeRetries = new Map<string, number>();
  /** Previous closes read from daily bars, per contract, with the trading day they are the reference of. */
  const barCloses = new Map<string, { day: string; close: number }>();
  /** The latest daily-bar load for a close per contract: in flight (no `done`), or how it ended. */
  const barLoads = new Map<string, { at: number; done?: 'ok' | 'failed' }>();
  /** Quotes whose close came from daily bars, with its trading day (dropped when the line sends its own). */
  const closeFromBars = new Map<string, string>();
  /** The last dividend summary IB sent per contract (DIVIDENDS_NS), and the contracts read from disk already. */
  const keptDividends = new Map<string, { value: QuoteDividends; at: number }>();
  const dividendsRead = new Set<string>();
  let dayCache = { at: -Infinity, day: '' };
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;

  // IB lines, valid only while `ready` (between onReady and onClosed).
  const lines = new Map<string, Line>();
  const byReqId = new Map<number, Line>();
  const probes = new Map<number, Probe>();
  const routes = new Map<string, Route>();
  const sides = new Map<number, Side>();
  /**
   * No primary-exchange probe for a contract before this time (Infinity: not a US listing IB serves
   * directly). Kept when the contract's line and route go, so a stock wanted again after lingering
   * does not probe again; cleared by its expiry or a new session.
   */
  const quietUntil = new Map<string, number>();
  /** Stocks found SMART delayed and live on their exchange, for this account (QuoteService.fallbacks). */
  const fallbacks = new Map<string, FallbackFinding>();
  let fallbacksAccount: string | undefined;
  /** A 10197 was seen; the next live price on a line that reported it ends it (then SMART is tried again). */
  let competing = false;
  /** Owner lines that reported 10197 in this episode. */
  const competingIds = new Set<number>();
  let competingEndedAt = -Infinity;
  let ready = false;
  /**
   * Generic tick lists IB refused (321 naming the list), as `${secType}|${ticks}`, and contracts IB
   * refused a line of for another reason, with the level they are requested at now. Kept for the
   * app's run (not cleared on reconnect), so IB's refusal is not repeated after every 1101.
   */
  const refusedLists = new Set<string>();
  const keyLevels = new Map<string, TickLevel>();
  /** Refusals already logged. */
  const warned = new Set<string>();

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
    clearCloseCheck(key);
    closeFromBars.delete(key);
    quotes.delete(key);
    sent.delete(key);
    dirty.delete(key);
  };

  const flush = () => {
    flushTimer = null;
    if (!dirty.size) return;
    const out: Record<string, Quote> = {};
    const full: string[] = [];
    let count = 0;
    for (const key of dirty) {
      const q = quotes.get(key);
      if (!q || !book.published(key)) continue;
      const prev = sent.get(key);
      const patch = quotePatch(prev, q);
      sent.set(key, { ...q });
      if (!patch) continue;
      out[key] = patch;
      if (!prev) full.push(key);
      count++;
    }
    dirty.clear();
    if (count) ctx.emit(full.length ? { type: 'quotes', quotes: out, full } : { type: 'quotes', quotes: out });
  };

  const markDirty = (key: string) => {
    dirty.add(key);
    flushTimer ??= setTimeout(flush, FLUSH_MS);
  };

  /**
   * A quote changed. Lingering lines (no owner) keep their quote current without publishing it;
   * a quote only main-process owners want reaches the main-process listeners but not the renderer.
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

  const accountNow = (): string | undefined => {
    const s = ctx.ib.getState();
    return s.account ?? s.accounts?.[0];
  };

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

  /**
   * The generic tick list a line of `key` asks for: the wanted profiles at the contract's level, one
   * level lower while IB refused the list (see the header); `refused` says what it runs without.
   */
  const lineTicks = (key: string, contract: ContractRef, profiles: WantedContract['profiles']): { level: TickLevel; ticks: string; refused?: Quote['ticksRefused'] } => {
    let level = keyLevels.get(key) ?? 'full';
    let ticks = genericTicksFor(contract, profiles, level);
    while (ticks && refusedLists.has(`${contract.secType}|${ticks}`)) {
      level = lowerLevel(level);
      ticks = genericTicksFor(contract, profiles, level);
    }
    if (ticks === genericTicksFor(contract, profiles, 'full')) return { level, ticks };
    return { level, ticks, refused: ticks === genericTicksFor(contract, profiles, 'core') ? 'addOns' : 'all' };
  };

  /** Requests a line (on the primary exchange while the contract's fallback is active); false when there is no session. */
  const requestLine = (w: WantedContract, wantedContract: ContractRef = w.contract, resolved = false): boolean => {
    const api = liveApi();
    if (!api) return false;
    const r = routes.get(w.key);
    const onPrimary = !!r?.primary && !!r.primaryContract && wantedContract === w.contract;
    const contract = onPrimary ? r!.primaryContract! : wantedContract;
    const isOption = contract.secType === 'OPT' || contract.secType === 'FOP';
    const { level, ticks, refused } = lineTicks(w.key, contract, w.profiles);
    const line: Line = {
      key: w.key,
      reqId: ctx.ib.nextReqId(),
      ticks,
      level,
      contract,
      tickContext: { isOption, right: contract.right, isCombo: contract.secType === 'BAG' },
      dead: false,
      resolved,
      route: onPrimary ? 'primary' : 'smart',
    };
    lines.set(line.key, line);
    byReqId.set(line.reqId, line);
    // Its first ticks bring the close; a check starts again with its first price if they do not.
    clearCloseCheck(w.key);
    // A fresh request starts without the previous line's error; IB repeats it if it still applies.
    if (quotes.get(w.key)?.error) setError(w.key, undefined);
    const q = ensureQuote(w.key);
    // Nor with its generic values: the new line sends again what it still gets (the kept dividends stand in).
    let changed = clearGenericFields(q, line.ticks);
    changed = restoreDividends(q, line) || changed;
    if (q.ticksRefused !== refused) {
      q.ticksRefused = refused;
      changed = true;
    }
    if (!onPrimary && q.source) {
      q.source = undefined; // back on SMART (a new session, or the fallback was dropped)
      changed = true;
    }
    if (changed) publish(q);
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
    // A contract may wait for the line this side line held.
    if (ready) scheduleReconcile();
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

  /**
   * Opens a side line with the line's generic ticks; false when no line is free or there is no
   * session. A background probe never takes a lingering line (the user may come back to it).
   */
  const openSide = (line: Line, target: Side['target'], contract: ContractRef): boolean => {
    const api = liveApi();
    if (!api) return false;
    if (openLineCount() >= MAX_MARKET_DATA_LINES) return false;
    const side: Side = { key: line.key, reqId: ctx.ib.nextReqId(), target, contract, dead: false, buffer: new Map(), timer: undefined! };
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
    if (r.side || r.resolving || r.primary) return;
    const until = quietUntil.get(line.key);
    if (until !== undefined) {
      if (until > Date.now()) {
        // Given up before the line went: probe at the end of it (if still delayed then).
        if (!r.timer && until !== Infinity) armQuiet(line.key, until - Date.now());
        return;
      }
      quietUntil.delete(line.key);
    }
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
      quietUntil.set(line.key, Infinity); // not a US listing IB serves directly
      return;
    }
    r.smart = line.contract;
    if (!openSide(line, 'primary', { ...c, exchange })) quiet(line.key, NO_LINE_RETRY_MS);
  };

  /** No primary probe for `ms`; then one, if the SMART line is still delayed. */
  const quiet = (key: string, ms: number) => {
    quietUntil.set(key, Date.now() + ms);
    armQuiet(key, ms);
  };

  /** The route's timer for the end of a give-up. */
  const armQuiet = (key: string, ms: number) => {
    const r = routeOf(key);
    clearRouteTimer(r);
    r.timer = setTimeout(() => {
      r.timer = undefined;
      if ((quietUntil.get(key) ?? 0) <= Date.now()) quietUntil.delete(key);
      const line = lines.get(key);
      if (line && isDelayed(quotes.get(key))) void probePrimary(line);
    }, ms);
  };

  /** The fallback no longer holds for this stock (SMART live, or its exchange not live). */
  const dropFinding = (key: string) => void fallbacks.delete(key);

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
    // The exchange line turned delayed and SMART is not live either: back to the consolidated quote.
    if (line && side.target === 'smart' && line.route === 'primary' && isDelayed(quotes.get(side.key))) {
      dropFinding(side.key);
      if (!side.dead && (type === 3 || type === 4)) switchTo(line, side, type);
      else backToSmart(line, side);
      if (lines.has(side.key)) quiet(side.key, PRIMARY_GIVE_UP_MS);
      return;
    }
    closeSide(side);
    if (!line) return;
    if (side.target === 'primary') {
      // A delayed exchange answer says the exchange is not live (a silent or failed probe says nothing).
      if (type === 3 || type === 4) dropFinding(side.key);
      quiet(side.key, PRIMARY_GIVE_UP_MS);
    } else scheduleSmartRetry(side.key, SMART_RETRY_MS);
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
    // The tick context goes along: a close the old line sent stays the reference for the same
    // session's data (its NAV does not: the side line's own comes with its buffer).
    const next: Line = {
      ...line,
      reqId: side.reqId,
      contract: side.contract,
      dead: false,
      resolved: true,
      route: side.target,
      dataType: type,
      tickContext: { ...line.tickContext, hasNav: false },
    };
    lines.set(next.key, next);
    byReqId.set(next.reqId, next);
    const q = ensureQuote(next.key);
    if (side.target === 'primary') {
      r.primary = side.contract.exchange;
      r.primaryContract = side.contract;
      q.source = { kind: 'primary', exchange: side.contract.exchange };
      fallbacks.set(next.key, { symbol: contractLabel(r.smart ?? line.contract), exchange: side.contract.exchange, at: Date.now() });
      fallbacksAccount ??= accountNow();
      scheduleSmartRetry(next.key, SMART_RETRY_MS);
    } else {
      r.primary = undefined;
      quietUntil.delete(next.key);
      clearRouteTimer(r);
      q.source = undefined;
      if (type === 1 || type === 2) dropFinding(next.key);
    }
    q.marketDataType = type;
    q.error = undefined;
    // The old line's generic values go with it; the side line brings its own.
    clearGenericFields(q, next.ticks);
    for (const t of side.buffer.values()) applyTick(q, t, next.tickContext);
    restoreDividends(q, next);
    publish(q);
  };

  /** Leaves the primary exchange without a usable side line: the exchange line is replaced by a new SMART one. */
  const backToSmart = (line: Line, side: Side) => {
    closeSide(side);
    const r = routeOf(line.key);
    r.primary = undefined;
    r.primaryContract = undefined;
    clearRouteTimer(r);
    const w = line.releasedAt === undefined ? book.wanted().find((x) => x.key === line.key) : undefined;
    if (!w) {
      dropLine(line);
      return;
    }
    cancelLine(line);
    requestLine(w); // on SMART: clears quote.source
  };

  /** 10197 ended (a live price arrived on a line that reported it): SMART gets another chance everywhere. */
  const competingEnded = () => {
    const now = Date.now();
    if (now - competingEndedAt < COMPETING_END_MIN_MS) return;
    competingEndedAt = now;
    competing = false;
    competingIds.clear();
    for (const [key, r] of routes) if (r.primary) scheduleSmartRetry(key, 0);
    for (const [key, until] of [...quietUntil]) {
      if (until === Infinity || routes.get(key)?.primary) continue;
      if (lines.has(key)) quiet(key, 0);
      else quietUntil.delete(key);
    }
  };

  const reconcileLive = (wanted: WantedContract[]) => {
    const { active, overflow } = allocateLines(wanted, MAX_MARKET_DATA_LINES);
    const activeByKey = new Map(active.map((w) => [w.key, w]));
    const now = Date.now();
    for (const line of [...lines.values()]) {
      const w = activeByKey.get(line.key);
      if (w) {
        // Reused as long as its ticks cover the profiles now wanted and it carries no heavy tick they
        // no longer need (RTVolume once VWAP is hidden); otherwise requested again below.
        const want = lineTicks(line.key, line.contract, w.profiles);
        if (lineServes(line.ticks, want.ticks)) {
          line.releasedAt = undefined;
          // A line that runs without refused ticks may hold every one wanted now (their columns went).
          const refused = coversTicks(line.ticks, genericTicksFor(line.contract, w.profiles)) ? undefined : want.refused;
          const q = quotes.get(line.key);
          if (q && q.ticksRefused !== refused) {
            q.ticksRefused = refused;
            publish(q);
          }
        } else cancelLine(line);
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
  // Previous close (see the header)

  const clearCloseCheck = (key: string) => {
    const timer = closeChecks.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    closeChecks.delete(key);
  };

  const armCloseCheck = (key: string, ms: number) => {
    clearCloseCheck(key);
    closeChecks.set(
      key,
      setTimeout(() => {
        closeChecks.delete(key);
        checkClose(key);
      }, ms),
    );
  };

  /**
   * A tick left a line's quote with prices but no previous close: it is checked CLOSE_WAIT_MS later.
   * Only quotes the renderer shows (not a lingering line, nor one only main-process owners want).
   */
  const watchClose = (line: Line, q: Quote) => {
    if (closeChecks.has(line.key) || !hasPrice(q) || !CLOSE_TYPES.has(line.contract.secType) || !book.published(line.key)) return;
    armCloseCheck(line.key, CLOSE_WAIT_MS);
  };

  /** The trading day now (shared/session.ts → tradingDay), worked out at most once a second. */
  const today = (): string => {
    const now = Date.now();
    if (now - dayCache.at >= 1_000 || now < dayCache.at) dayCache = { at: now, day: tradingDay(now) };
    return dayCache.day;
  };

  /** Gives a quote without a close the one daily bars brought for today's trading day; true when it did. */
  const applyBarClose = (q: Quote): boolean => {
    const b = barCloses.get(q.key);
    if (q.close !== undefined || !b || b.day !== today()) return false;
    q.close = b.close;
    closeFromBars.set(q.key, b.day);
    return true;
  };

  /** Reads a stock's previous close from its daily bars; the quote then takes it, or is checked again. */
  const loadBarClose = (key: string, contract: ContractRef) => {
    const day = today();
    const load: { at: number; done?: 'ok' | 'failed' } = { at: Date.now() };
    barLoads.set(key, load);
    void ctx.history
      .get({ contract, timeframe: '1D', background: true })
      .then(
        (bars) => previousCloseFromBars(bars, day),
        () => undefined,
      )
      .then((close) => {
        if (barLoads.get(key) !== load) return;
        load.done = close === undefined ? 'failed' : 'ok';
        if (close !== undefined) barCloses.set(key, { day, close });
        const q = quotes.get(key);
        if (!q || q.close !== undefined) return;
        if (applyBarClose(q)) publish(q);
        else if (lines.has(key)) armCloseCheck(key, 0); // the line is requested again
      });
  };

  /**
   * A quote that still streams prices without a previous close (see the header): a US stock takes
   * the close from its daily bars, other instruments (and a stock whose bars brought none within
   * CLOSE_RETRY_MS) get their line requested again.
   */
  const checkClose = (key: string) => {
    const line = lines.get(key);
    const q = quotes.get(key);
    if (!line || line.dead || !q || q.close !== undefined || !hasPrice(q) || !book.published(key)) return;
    if (applyBarClose(q)) {
      publish(q);
      return;
    }
    const w = book.wanted().find((x) => x.key === key);
    if (!w) return;
    const now = Date.now();
    if (barsCloseFor(w.contract) && ctx.history) {
      const load = barLoads.get(key);
      if (load && !load.done) return; // in flight: its answer checks again
      // 'ok' without a close for today: the trading day changed since.
      if (!load || load.done === 'ok' || now - load.at >= CLOSE_RETRY_MS) {
        loadBarClose(key, w.contract);
        return;
      }
    }
    const last = closeRetries.get(key);
    const due = last !== undefined ? last + CLOSE_RETRY_MS : now;
    // Not before CLOSE_RETRY_MS has passed, nor while the fallback resolves the contract or tests
    // another route (a switch brings a new line).
    const r = routes.get(key);
    if (due > now || r?.side || r?.resolving) {
      armCloseCheck(key, Math.max(due - now, CLOSE_WAIT_MS));
      return;
    }
    if (!liveApi()) return;
    closeRetries.set(key, now);
    cancelLine(line);
    // The same contract: one resolved after error 200 keeps its conId (requestLine keeps the primary route).
    requestLine(w, line.route === 'smart' && line.resolved ? line.contract : w.contract, line.resolved);
  };

  // ---------------------------------------------------------------------------
  // Dividends (see the header)

  /** A line asks for IB's dividend summary. */
  const asksDividends = (line: Line): boolean => line.ticks.split(',').includes('456');

  /**
   * Gives a quote without dividends the kept summary, when its line asks for them; reads the
   * contract's from disk first if it has not yet. True when the quote changed now.
   */
  const restoreDividends = (q: Quote, line: Line): boolean => {
    if (q.dividends !== undefined || !asksDividends(line)) return false;
    const kept = keptDividends.get(q.key);
    if (kept) {
      if (!keptDividendsUsable(kept.value, kept.at, Date.now())) return false;
      q.dividends = kept.value;
      return true;
    }
    if (dividendsRead.has(q.key) || !ctx.db) return false;
    dividendsRead.add(q.key);
    const key = q.key;
    void ctx.db.kv.get<QuoteDividends>(DIVIDENDS_NS, key).then(
      (row) => {
        if (!row || keptDividends.has(key)) return;
        keptDividends.set(key, { value: row.value, at: row.updatedAt });
        const now = quotes.get(key);
        const l = lines.get(key);
        if (now && l && restoreDividends(now, l)) publish(now);
      },
      () => undefined,
    );
    return false;
  };

  /** IB sent a line's dividend summary: it is kept (memory and disk) when it differs from the kept one. */
  const keepDividends = (key: string, d: QuoteDividends) => {
    const kept = keptDividends.get(key);
    const now = Date.now();
    // Rewritten once a day even when unchanged, so its age says when IB last confirmed it.
    if (kept && sameDividends(kept.value, d) && now - kept.at < 24 * 3_600_000) return;
    keptDividends.set(key, { value: d, at: now });
    dividendsRead.add(key);
    void ctx.db?.kv.set(DIVIDENDS_NS, key, d).catch(() => undefined);
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
    // The snapshot has what the wanted profiles bring: values of a profile no longer wanted go.
    clearGenericFields(q, genericTicksFor(w.contract, w.profiles));
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
      // The latest per kind and field, in the order they last changed (a NAV after a frozen one).
      const k = `${tick.kind}:${tick.field}`;
      side.buffer.delete(k);
      side.buffer.set(k, tick);
      return;
    }
    const line = byReqId.get(reqId);
    if (!line) return;
    if (line.dead) revive(line);
    const q = quotes.get(line.key) ?? ensureQuote(line.key);
    if (competing && competingIds.has(reqId) && tick.kind === 'price' && (tick.value ?? 0) > 0 && q.marketDataType !== 3 && q.marketDataType !== 4) competingEnded();
    let changed = applyTick(q, tick, line.tickContext);
    if (q.error) {
      q.error = undefined; // data is flowing again
      changed = true;
    }
    if (closeFromBars.size) {
      const barDay = closeFromBars.get(line.key);
      // The line's own close replaces the bars'; a new trading day makes theirs a session old.
      if (line.tickContext.hasClose) closeFromBars.delete(line.key);
      else if (barDay !== undefined && barDay !== today()) {
        closeFromBars.delete(line.key);
        q.close = undefined;
        changed = true;
      }
    }
    // IB's "not available" on a line that sent no close, or a new day: the bars' close for today, if known.
    if (q.close === undefined && applyBarClose(q)) changed = true;
    if (tick.kind === 'string' && tick.field === TICK.IB_DIVIDENDS && q.dividends && parseDividends(tick.value)) keepDividends(line.key, q.dividends);
    if (q.close === undefined) watchClose(line, q);
    else if (closeRetries.size) closeRetries.delete(line.key); // a close came: a later missing one is retried at once
    if (changed) publish(q);
  };

  /**
   * IB refused a line's generic ticks (321) and dropped the request: the line is requested again one
   * level lower (see the header), so its prices keep coming.
   */
  const refuseTicks = (line: Line, message: string) => {
    const w = line.releasedAt === undefined ? book.wanted().find((x) => x.key === line.key) : undefined;
    const named = /generic tick/i.test(message);
    const refusal = named ? `${line.contract.secType}|${line.ticks}` : line.key;
    if (named) refusedLists.add(refusal);
    else {
      // The next level that asks for less than the refused list.
      let level = lowerLevel(line.level);
      while (w && level !== 'none' && genericTicksFor(line.contract, w.profiles, level) === line.ticks) level = lowerLevel(level);
      keyLevels.set(line.key, level);
    }
    if (!warned.has(refusal)) {
      warned.add(refusal);
      console.warn(`[quotes] IB refused the generic ticks ${line.ticks} of ${contractLabel(line.contract)}; requested again with fewer: ${message}`);
    }
    line.dead = true; // nothing to cancel: a cancel would only answer 300
    if (!w) {
      dropLine(line);
      return;
    }
    cancelLine(line);
    // The same contract: one resolved after error 200 keeps its conId (requestLine keeps the primary route).
    requestLine(w, line.route === 'smart' && line.resolved ? line.contract : w.contract, line.resolved);
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
    // A line without generic ticks takes the dead path below.
    if (e.code === TICKS_REFUSED && line.ticks) {
      refuseTicks(line, e.message);
      return;
    }
    if (e.code === COMPETING_SESSION) {
      competing = true;
      competingIds.add(line.reqId);
    }
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
    // Every line is requested again, with its close.
    for (const timer of closeChecks.values()) clearTimeout(timer);
    closeChecks.clear();
    // Every line starts on SMART again (a reconnect is a reason to try it).
    for (const r of routes.values()) clearRouteTimer(r);
    for (const side of sides.values()) clearTimeout(side.timer);
    routes.clear();
    sides.clear();
    // Give-ups end with the session; the fallback findings stay (the market data check reports them).
    quietUntil.clear();
    competing = false;
    competingIds.clear();
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
    // Findings belong to the account they were made for.
    const account = accountNow();
    if (account && fallbacksAccount && account !== fallbacksAccount) fallbacks.clear();
    if (account) fallbacksAccount = account;
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
      (reqId: number, field: number, _attrib: unknown, iv?: number, delta?: number, optPrice?: number, pvDividend?: number, gamma?: number, vega?: number, theta?: number, undPrice?: number) =>
        onTick(reqId, { kind: 'option', field, iv, delta, optPrice, pvDividend, gamma, vega, theta, undPrice }),
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
      } else if (line.route === 'smart') dropFinding(line.key);
      const q = ensureQuote(line.key);
      // Between live and delayed data the values IB sends on live lines only go (see the header).
      const prev = line.dataType;
      line.dataType = type as MarketDataType;
      let cleared = false;
      if (prev !== undefined && delayedType(prev) !== delayedType(type as MarketDataType)) {
        line.tickContext.hasNav = false;
        cleared = clearLiveOnlyFields(q);
        restoreDividends(q, line);
      }
      if (q.marketDataType === type && !cleared) return;
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
      if (book.set(String(owner), Array.isArray(subs) ? subs : [], 'main')) scheduleReconcile();
    },
    setRendererSubscriptions(owner: string, subs: QuoteSubscription[]) {
      if (book.set(String(owner), Array.isArray(subs) ? subs : [], 'renderer')) scheduleReconcile();
    },
    resetRenderer() {
      // A new renderer holds no quote: everything it wants next is sent whole.
      sent.clear();
      if (book.clearRenderer()) scheduleReconcile();
    },
    resend(keys: string[]) {
      if (!Array.isArray(keys)) return;
      for (const key of keys) {
        if (typeof key !== 'string' || !book.published(key)) continue;
        sent.delete(key);
        const q = quotes.get(key);
        if (q && hasData(q)) markDirty(key);
      }
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
    fallbacks() {
      return [...fallbacks].map(([key, f]) => ({ ...f, active: routes.get(key)?.primary != null }));
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
