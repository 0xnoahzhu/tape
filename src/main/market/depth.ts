// Level 2 order book for one instrument at a time (reqMktDepth with SMART depth).
// Book changes are emitted as `depth` events at most every 100 ms.
//
// IB allows 3 depth lines per account (TWS and other clients included), so this client never
// holds more than one: every subscribe goes through request(), which first cancels the line that
// is open. Both frames travel in the send queue's market data lane, FIFO, so the cancel reaches
// IB before the new request (an unsent request and its cancel are dropped together). IB may
// still answer 309 (too many depth lines) when it had not processed the cancel yet; a 309 right
// after a cancel is retried once.

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

  const emitNow = () => {
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = null;
    if (book) ctx.emit({ type: 'depth', book: { ...book, bids: book.bids.map((l) => ({ ...l })), asks: book.asks.map((l) => ({ ...l })) } });
  };

  const scheduleEmit = () => {
    if (book) book.updatedAt = Date.now();
    emitTimer ??= setTimeout(emitNow, EMIT_MS);
  };

  /** Cancels the open depth line, if any (a dead request holds no line at IB). */
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
    if (dead || !ready || !ctx.ib.api) return;
    try {
      ctx.ib.api.cancelMktDepth(id, true);
      cancelledAt = Date.now();
    } catch (err) {
      console.error('[depth] cancelMktDepth failed:', err);
    }
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
      api.reqMktDepth(reqId, toIbContract(contract), DEPTH_ROWS, true, []);
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

  const onUpdate = (id: number, u: DepthUpdate) => {
    if (id !== reqId || !book) return;
    let changed = applyDepthUpdate(book, u);
    if (book.error) {
      book.error = undefined;
      changed = true;
    }
    if (changed) scheduleEmit();
  };

  const onError = (e: { reqId: number; code: number; message: string }) => {
    if (e.reqId !== reqId || !book) return;
    if (e.code === RESET_CODE) {
      clearBook(book);
      scheduleEmit();
      return;
    }
    if (DEAD_CODES.has(e.code)) dead = true;
    if (e.code === DEPTH_LIMIT_CODE && !limitRetried && Date.now() - cancelledAt < CANCEL_RACE_MS) {
      limitRetried = true;
      const failed = reqId;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (reqId === failed && dead) request();
      }, LIMIT_RETRY_MS);
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
      // A new session (or market data lost, 1101): the old request id is gone; subscribe again.
      reqId = null;
      limitRetried = false;
      if (book) clearBook(book);
      request();
      if (book) scheduleEmit();
    });
    ctx.ib.onClosed(() => {
      ready = false;
      reqId = null;
    });
    if (!ctx.demo && isIbConnected(ctx)) ready = true;
  });

  return {
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
