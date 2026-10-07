// Level 2 order book for one instrument at a time (reqMktDepth with SMART depth).
// Book changes are emitted as `depth` events at most every 100 ms.
//
// IB allows 3 depth lines per account (TWS and other clients included), so the order ticket's book
// holds one at a time (DEPTH_ROWS a side): every subscribe goes through request(), which first
// releases the line that is open.
// The market data check may open one more for a few seconds (openLine / closeLine).
//
// IB can take 10 s and more to start a depth stream (seen live for SPY SMART depth), and a
// cancelMktDepth that reaches it before the stream has started is ignored: the stream starts
// anyway, cannot be cancelled afterwards (310) and holds one of the account's depth lines until
// the session ends. So a line is cancelled only once it has answered (a book update or a reset);
// one released before that is cancelled on its first update, dropped on an error that ended it,
// and cancelled anyway after CANCEL_CAP_MS. IB may answer 309 (too many depth lines) while
// another line of this client is still open or being cancelled, or right after a cancel; such a
// 309 is retried once, when those lines are gone.

import { EventName } from '../ib/tws';
import { contractKey, sameContract } from '@shared/contract';
import type { ContractRef, DepthBook } from '@shared/types';
import type { DepthService, MainContext } from '../context';
import { demoMarket } from './demo';
import { applyDepthUpdate, clearBook, DEPTH_ROWS, type DepthUpdate } from './depthBook';
import { toIbContract } from './ibContract';
import { afterStartup, isIbConnected, NOT_CONNECTED } from './ibRequest';

const EMIT_MS = 100;
const DEMO_BOOK_MS = 500;
/** 317 = "Market depth data has been RESET": empty the book before applying new entries. */
const RESET_CODE = 317;
/** Errors after which IB has dropped the depth request. */
const DEAD_CODES = new Set([200, 309, 321, 354, 10092]);
/** "Max number (3) of market depth requests has been reached". */
const DEPTH_LIMIT_CODE = 309;
/** A 309 this soon after our own cancel may be IB not having processed the cancel yet. */
const CANCEL_RACE_MS = 2_000;
const LIMIT_RETRY_MS = 1_000;
/** A released line that never answered is cancelled anyway this long after its request. */
export const CANCEL_CAP_MS = 60_000;

/** A depth line this client holds at IB (the order ticket's book's, or the market data check's). */
interface HeldLine {
  /** IB has started the stream (a book update or a reset came): a cancel now takes effect. */
  started: boolean;
  /** Released: cancelled on its first update, or at the cap. */
  released: boolean;
  openedAt: number;
  capTimer?: ReturnType<typeof setTimeout>;
}

export function createDepthService(ctx: MainContext): DepthService {
  let contract: ContractRef | null = null;
  let book: DepthBook | null = null;
  /** The current request (cleared when it is cancelled or the session ends). */
  let reqId: number | null = null;
  let dead = false;
  let ready = false;
  /** When this client last cancelled a depth line (Date.now()). */
  let cancelledAt = -Infinity;
  /** The current contract was already retried after a 309. */
  let limitRetried = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let demoTimer: ReturnType<typeof setInterval> | null = null;
  /** Every depth line this client holds at IB, by request id (dead requests are dropped). */
  const held = new Map<number, HeldLine>();

  const sendCancel = (id: number) => {
    const line = held.get(id);
    if (line?.capTimer) clearTimeout(line.capTimer);
    held.delete(id);
    if (!ready || !ctx.ib.api) return;
    try {
      ctx.ib.api.cancelMktDepth(id, true);
      cancelledAt = Date.now();
    } catch (err) {
      console.error('[depth] cancelMktDepth failed:', err);
    }
  };

  /** Releases a line: cancelled now when IB has started it, else on its first update or at the cap. */
  const release = (id: number) => {
    const line = held.get(id);
    if (!line || line.released) return;
    line.released = true;
    if (line.started) {
      sendCancel(id);
      return;
    }
    line.capTimer = setTimeout(() => sendCancel(id), Math.max(0, line.openedAt + CANCEL_CAP_MS - Date.now()));
  };

  /** Sends reqMktDepth and records the line (throws when the request cannot be written). */
  const openHeld = (id: number, c: ContractRef, rows: number) => {
    const api = ready ? ctx.ib.api : null;
    if (!api) throw new Error(NOT_CONNECTED);
    held.set(id, { started: false, released: false, openedAt: Date.now() });
    try {
      api.reqMktDepth(id, toIbContract(c), rows, true, []);
    } catch (err) {
      held.delete(id);
      throw err;
    }
  };

  /** A line other than `id` is open or being cancelled. */
  const othersHeld = (id: number | null) => [...held.keys()].some((k) => k !== id);

  const forgetHeld = () => {
    for (const line of held.values()) if (line.capTimer) clearTimeout(line.capTimer);
    held.clear();
  };

  const emitNow = () => {
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = null;
    if (book) ctx.emit({ type: 'depth', book: { ...book, bids: book.bids.map((l) => ({ ...l })), asks: book.asks.map((l) => ({ ...l })) } });
  };

  const scheduleEmit = () => {
    if (book) book.updatedAt = Date.now();
    emitTimer ??= setTimeout(emitNow, EMIT_MS);
  };

  /** Releases the order ticket's book's depth line, if any (see release; a dead request holds no line at IB). */
  const cancel = () => {
    if (demoTimer) {
      clearInterval(demoTimer);
      demoTimer = null;
    }
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (reqId == null) return;
    const id = reqId;
    reqId = null;
    release(id);
  };

  /** Subscribes the current contract; the line open before is always cancelled first. */
  const request = () => {
    if (!contract || !book || ctx.demo) return;
    const api = ready ? ctx.ib.api : null;
    if (!api) return;
    cancel();
    reqId = ctx.ib.nextReqId();
    dead = false;
    book.error = undefined;
    try {
      openHeld(reqId, contract, DEPTH_ROWS);
    } catch (err) {
      dead = true;
      book.error = { code: -1, message: err instanceof Error ? err.message : String(err) };
      scheduleEmit();
    }
  };

  const demoRefresh = () => {
    if (!contract || !book) return;
    const sim = demoMarket().book(contract, DEPTH_ROWS);
    if (!sim) {
      book.error = { code: 10092, message: 'Deep market data is not supported for this combination of security/exchange' };
      clearBook(book);
    } else {
      book.bids = sim.bids;
      book.asks = sim.asks;
      book.error = undefined;
    }
    scheduleEmit();
  };

  /** IB started the stream of a line: a released one is cancelled now. */
  const started = (id: number) => {
    const line = held.get(id);
    if (!line || line.started) return;
    line.started = true;
    if (line.released) sendCancel(id);
  };

  const onUpdate = (id: number, u: DepthUpdate) => {
    started(id);
    if (id !== reqId || !book) return;
    let changed = applyDepthUpdate(book, u);
    if (book.error) {
      book.error = undefined;
      changed = true;
    }
    if (changed) scheduleEmit();
  };

  /** Retries the book's line after a 309 once this client's other lines are gone. */
  const retryWhenFree = (failed: number) => {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (reqId !== failed || !dead) return;
      if (othersHeld(failed) || Date.now() - cancelledAt < LIMIT_RETRY_MS) retryWhenFree(failed);
      else request();
    }, LIMIT_RETRY_MS);
  };

  const onError = (e: { reqId: number; code: number; message: string }) => {
    const line = held.get(e.reqId);
    if (line) {
      if (e.code === RESET_CODE) started(e.reqId);
      else if (DEAD_CODES.has(e.code)) {
        if (line.capTimer) clearTimeout(line.capTimer);
        held.delete(e.reqId); // IB dropped it: nothing to cancel
      }
    }
    if (e.reqId !== reqId || !book) return;
    if (e.code === RESET_CODE) {
      clearBook(book);
      scheduleEmit();
      return;
    }
    if (DEAD_CODES.has(e.code)) dead = true;
    // Our own lines may fill the allowance for a moment (a cancel IB has not processed, a line
    // waiting for its first update to be cancelled, the market data check's line).
    if (e.code === DEPTH_LIMIT_CODE && !limitRetried && (othersHeld(e.reqId) || Date.now() - cancelledAt < CANCEL_RACE_MS)) {
      limitRetried = true;
      retryWhenFree(e.reqId);
      return;
    }
    book.error = { code: e.code, message: e.message };
    scheduleEmit();
  };

  afterStartup(() => {
    ctx.ib.on(EventName.updateMktDepth, (id: number, position: number, operation: number, side: number, price: number, size: number) =>
      onUpdate(id, { position, operation, side, price, size }),
    );
    ctx.ib.on(
      EventName.updateMktDepthL2,
      (id: number, position: number, marketMaker: string, operation: number, side: number, price: number, size: number) =>
        onUpdate(id, { position, operation, side, price, size, marketMaker }),
    );
    ctx.ib.onRequestError(onError);
    ctx.ib.onReady(() => {
      if (ctx.demo) return;
      ready = true;
      // A new session (or market data lost, 1101): the old request ids are gone; subscribe again.
      forgetHeld();
      reqId = null;
      limitRetried = false;
      if (book) clearBook(book);
      request();
      if (book) scheduleEmit();
    });
    ctx.ib.onClosed(() => {
      ready = false;
      reqId = null;
      forgetHeld();
    });
    if (!ctx.demo && isIbConnected(ctx)) ready = true;
  });

  return {
    current: () => book,
    lineReqId: () => (ready && !ctx.demo && reqId != null && !dead ? reqId : null),
    openLine(c: ContractRef, rows: number): number {
      if (ctx.demo) throw new Error('No depth lines in demo mode');
      const id = ctx.ib.nextReqId();
      openHeld(id, c, rows);
      return id;
    },
    closeLine: (id: number) => release(id),
    async set(next: ContractRef | null): Promise<void> {
      if (next && contract && sameContract(next, contract) && !dead) return;
      cancel();
      limitRetried = false;
      contract = next && next.symbol ? next : null;
      if (!contract) {
        book = null;
        return;
      }
      book = { key: contractKey(contract), bids: [], asks: [], updatedAt: Date.now() };
      dead = false;
      if (ctx.demo) {
        demoRefresh();
        demoTimer = setInterval(demoRefresh, DEMO_BOOK_MS);
      } else if (!ready || !ctx.ib.api) {
        book.error = { code: -1, message: NOT_CONNECTED };
      } else {
        request();
      }
      emitNow();
    },
  };
}
