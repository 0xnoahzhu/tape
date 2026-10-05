// IB connection: one IBApi instance per (host, port, clientId), the handshake, auto-reconnect,
// a heartbeat, request / order id allocation and routing of IB errors.
//
// Lifecycle: connect() -> 'connecting' -> socket + server version -> managedAccounts and
// nextValidId -> 'connected' (onReady listeners issue their requests). With auto-reconnect on,
// an unexpected close retries every 5 s up to 10 times ('reconnecting'), and so does a failed
// first attempt of a reconnect that a settings change started (new host, port or client id); a
// failed connect() reports the failure, also one that joined an automatic attempt. disconnect()
// never reconnects, nor does a settings change after it.
//
// A close on purpose (disconnect(), a settings change) ends the session at once: `api` is null
// from then on, although the status says 'connected' until the socket's close event. Overlapping
// closes of one socket all finish on that event, and a connect() made meanwhile starts after it
// (and after the settings change), so it never reuses the instance being closed.

import { EventName, IBApi } from './tws';
import type { ConnectionState } from '@shared/types';
import type { IbConnection, IbListener, MainContext } from '../context';
import {
  connectionNotices,
  connectionParams,
  failureReason,
  isPaperAccount,
  parseAccounts,
  sameParams,
  type ConnectionParams,
  type Failure,
  type NoticeText,
} from './connectionModel';
import { cleanIbMessage, farmUpdate, isErrorCode, isInfoCode } from './errorCodes';

const RETRY_MS = 5_000;
const MAX_RETRIES = 10;
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** nextValidId may arrive before managedAccounts; wait this long for the account list. */
const ACCOUNTS_WAIT_MS = 2_000;
const HEARTBEAT_MS = 30_000;
const CLOSE_WAIT_MS = 1_000;
/**
 * Request ids start far above the order ids IB hands out (nextValidId, one more per order), so the
 * id of an error names a request or an order, never both: an error of a market data line must not
 * reject or annotate the order with the same number. Both are int32 on the wire.
 */
export const FIRST_REQ_ID = 1_000_000_000;

type RequestError = { reqId: number; code: number; message: string; advancedOrderReject?: string };

/** The parts of eventemitter3 used here (IBApi's typed overloads do not accept plain strings). */
interface Emitter {
  on(event: string, fn: IbListener): unknown;
  removeAllListeners(): unknown;
}

const emitter = (api: IBApi) => api as unknown as Emitter;

/** Runs a listener without letting its exception reach the socket's data handler. */
function safely(fn: () => void, what: string): void {
  try {
    fn();
  } catch (err) {
    console.error(`[ib] ${what} listener failed:`, err);
  }
}

export function createConnection(ctx: MainContext, createApi: (o: { host: string; port: number }) => IBApi = (o) => new IBApi(o)): IbConnection {
  const registry = new Map<string, Set<IbListener>>();
  const readyListeners = new Set<(api: IBApi) => void>();
  const closedListeners = new Set<() => void>();
  const requestErrorListeners = new Set<(e: RequestError) => void>();

  const settings = () => ctx.store.getSettings().connection;
  let params: ConnectionParams = connectionParams(settings());
  let inst: IBApi | null = null;
  let instParams: ConnectionParams | null = null;

  let state: ConnectionState = {
    status: 'disconnected',
    host: params.host,
    port: params.port,
    clientId: params.clientId,
    accounts: [],
    isPaper: false,
    farms: {},
  };

  /** The user wants to be connected (set by connect(), cleared by disconnect() or giving up). */
  let wanted = false;
  let ready = false;
  let socketOpen = false;
  let gotValidId = false;
  let accountsKnown = false;
  let pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let connecting: Promise<void> | null = null;
  let lastFailure: Failure | null = null;
  let reconnectAttempt = 0;
  /**
   * The current attempt replaces a wanted connection (settings change): when it fails it goes
   * through the retry loop like a dropped connection instead of giving up.
   */
  let retryFirstAttempt = false;
  /** When a ready connection dropped (for the "reconnected after …" notice). */
  let droppedAt = 0;

  let reqId = FIRST_REQ_ID;
  let orderId = 0;

  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let accountsTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatSentAt = 0;
  /** The socket being closed on purpose, until its close event (every close of it waits for that). */
  let closing: { api: IBApi; done: Promise<void>; resolve: () => void } | null = null;

  // ---------------------------------------------------------------------------
  // State

  function setState(patch: Partial<ConnectionState>): void {
    state = { ...state, ...patch };
    ctx.emit({ type: 'connection', state });
  }

  function notify(n: NoticeText): void {
    try {
      ctx.notifier.notify({ kind: 'conn', title: n.title, body: n.body });
    } catch (err) {
      console.error('[ib] notification failed:', err);
    }
  }

  const mode = () => settings().mode;

  function clearTimer(t: ReturnType<typeof setTimeout> | null): null {
    if (t) clearTimeout(t);
    return null;
  }

  // ---------------------------------------------------------------------------
  // IBApi instance

  function ensureApi(): IBApi {
    if (inst && instParams && sameParams(instParams, params)) return inst;
    if (inst) dropInstance();
    const api = createApi({ host: params.host, port: params.port });
    inst = api;
    instParams = { ...params };
    orderId = 0;
    const e = emitter(api);
    e.on(EventName.server, (version: number, connTime: string) => setState({ serverVersion: version, connTime }));
    e.on(EventName.managedAccounts, (list: string) => onManagedAccounts(api, list));
    e.on(EventName.nextValidId, (id: number) => onNextValidId(api, id));
    e.on(EventName.error, (err: unknown, code: number, id: number, adv?: unknown) => onError(api, err, code, id, adv));
    e.on(EventName.info, (message: string, code: number) => onGlobal(api, code, message));
    e.on(EventName.disconnected, () => onSocketClosed(api));
    e.on(EventName.currentTime, onCurrentTime);
    e.on(EventName.tickPrice, onTickPrice);
    for (const event of registry.keys()) forward(api, event);
    return api;
  }

  /** Forwards one event of the instance to the registered listeners. */
  function forward(api: IBApi, event: string): void {
    emitter(api).on(event, (...args: unknown[]) => {
      const set = registry.get(event);
      if (!set) return;
      for (const l of [...set]) safely(() => l(...args), event);
    });
  }

  function dropInstance(): void {
    const old = inst;
    inst = null;
    instParams = null;
    if (!old) return;
    emitter(old).removeAllListeners();
    try {
      old.disconnect();
    } catch {
      // already closed
    }
  }

  // ---------------------------------------------------------------------------
  // Connecting

  function start(isRetry: boolean): Promise<void> {
    const api = ensureApi();
    ready = false;
    gotValidId = false;
    accountsKnown = false;
    lastFailure = null;
    socketOpen = true;
    setState({
      status: isRetry ? 'reconnecting' : 'connecting',
      host: params.host,
      port: params.port,
      clientId: params.clientId,
      reconnectAttempt: isRetry ? reconnectAttempt : undefined,
      serverVersion: undefined,
      connTime: undefined,
      latencyMs: undefined,
      farms: {},
      ...(isRetry ? {} : { lastError: undefined }),
    });
    const promise = new Promise<void>((resolve, reject) => {
      pending = { resolve, reject };
    });
    connecting = promise;
    const done = () => {
      if (connecting === promise) connecting = null;
    };
    promise.then(done, done);
    handshakeTimer = clearTimer(handshakeTimer);
    handshakeTimer = setTimeout(() => fail(api, { code: 0, message: `No response from ${params.host}:${params.port}` }, true), HANDSHAKE_TIMEOUT_MS);
    try {
      api.connect(params.clientId);
    } catch (err) {
      // e.g. an invalid port: the socket never opened, so no close event will follow and the
      // instance is left in a "connecting" state; finish the attempt and start fresh next time.
      fail(api, { code: 502, message: err instanceof Error ? err.message : String(err) }, false);
      onSocketClosed(api);
      dropInstance();
    }
    return promise;
  }

  /** A connection attempt failed: record why, reject connect() and close the socket if asked. */
  function fail(api: IBApi, f: Failure, close: boolean): void {
    if (api !== inst) return;
    lastFailure = f;
    setState({ lastError: { code: f.code, message: cleanIbMessage(f.message), time: Date.now() } });
    if (pending) {
      const p = pending;
      pending = null;
      p.reject(new Error(failureReason(f, params).en));
    }
    if (close && socketOpen) {
      try {
        api.disconnect();
      } catch {
        onSocketClosed(api);
      }
    }
  }

  function onManagedAccounts(api: IBApi, list: string): void {
    const accounts = parseAccounts(list);
    const account = state.account && accounts.includes(state.account) ? state.account : accounts[0];
    accountsKnown = true;
    setState({ accounts, account, isPaper: isPaperAccount(account) });
    if (gotValidId && !ready) becomeReady(api);
  }

  function onNextValidId(api: IBApi, id: number): void {
    if (typeof id === 'number' && id > orderId) orderId = id;
    if (ready || api !== inst) return;
    gotValidId = true;
    if (accountsKnown) becomeReady(api);
    else if (!accountsTimer) accountsTimer = setTimeout(() => becomeReady(api), ACCOUNTS_WAIT_MS);
  }

  function becomeReady(api: IBApi): void {
    if (ready || api !== inst || !socketOpen || closing?.api === api) return;
    ready = true;
    handshakeTimer = clearTimer(handshakeTimer);
    accountsTimer = clearTimer(accountsTimer);
    const wasRetry = reconnectAttempt > 0 && droppedAt > 0;
    const downtime = droppedAt ? Date.now() - droppedAt : 0;
    reconnectAttempt = 0;
    retryFirstAttempt = false;
    droppedAt = 0;
    setState({ status: 'connected', reconnectAttempt: undefined, marketDataIssue: undefined, lastError: undefined });
    if (pending) {
      const p = pending;
      pending = null;
      p.resolve();
    }
    startHeartbeat(api);
    fireReady(api);
    if (wasRetry) notify(connectionNotices.reconnected(mode(), downtime));
  }

  function fireReady(api: IBApi): void {
    for (const l of [...readyListeners]) safely(() => l(api), 'ready');
  }

  // ---------------------------------------------------------------------------
  // Closing and reconnecting

  function onSocketClosed(api: IBApi): void {
    if (closing?.api === api) {
      // Its waiters continue after this handler, with the state below.
      const c = closing;
      closing = null;
      c.resolve();
    }
    if (api !== inst || !socketOpen) return;
    socketOpen = false;
    const wasReady = ready;
    ready = false;
    gotValidId = false;
    handshakeTimer = clearTimer(handshakeTimer);
    accountsTimer = clearTimer(accountsTimer);
    stopHeartbeat();
    for (const l of [...closedListeners]) safely(l, 'closed');
    if (pending) {
      const p = pending;
      pending = null;
      p.reject(new Error(lastFailure ? failureReason(lastFailure, params).en : `${params.host}:${params.port} closed the connection`));
    }

    if (!wanted) {
      setState({ status: 'disconnected', reconnectAttempt: undefined, latencyMs: undefined });
      return;
    }

    const retry = settings().autoReconnect;
    if (wasReady) {
      droppedAt = Date.now();
      ctx.apiLog.note('in', 'socket close', [['reason', 'closed by TWS / IB Gateway']], true);
      notify(connectionNotices.disconnected(mode(), params, retry));
    }
    if (retry && (wasReady || reconnectAttempt > 0 || retryFirstAttempt)) {
      scheduleRetry();
      return;
    }
    wanted = false;
    retryFirstAttempt = false;
    setState({ status: 'disconnected', reconnectAttempt: undefined, latencyMs: undefined });
    if (!wasReady) notify(connectionNotices.failed(mode(), failureReason(lastFailure ?? { code: 0, message: '' }, params)));
  }

  function scheduleRetry(): void {
    if (reconnectAttempt >= MAX_RETRIES) {
      const attempts = reconnectAttempt;
      wanted = false;
      reconnectAttempt = 0;
      retryFirstAttempt = false;
      droppedAt = 0;
      setState({ status: 'disconnected', reconnectAttempt: undefined, latencyMs: undefined });
      notify(connectionNotices.gaveUp(mode(), failureReason(lastFailure ?? { code: 0, message: '' }, params), attempts));
      return;
    }
    reconnectAttempt++;
    setState({ status: 'reconnecting', reconnectAttempt, latencyMs: undefined });
    retryTimer = clearTimer(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (wanted) start(true).catch(() => undefined);
    }, RETRY_MS);
  }

  /** Closes the socket on purpose (user disconnect, settings change). Never reconnects. */
  async function closeSocket(reason: string): Promise<void> {
    wanted = false;
    retryTimer = clearTimer(retryTimer);
    reconnectAttempt = 0;
    retryFirstAttempt = false;
    droppedAt = 0;
    if (pending) {
      const p = pending;
      pending = null;
      p.reject(new Error('Connection cancelled'));
    }
    const api = inst;
    // A close already under way (a settings change, then a disconnect) is waited for, not repeated.
    if (api && socketOpen) await (closing?.api === api ? closing.done : beginClose(api, reason));
    // While the socket was closing, a newer attempt may have started (wanted again).
    if (!wanted && state.status !== 'disconnected') setState({ status: 'disconnected', reconnectAttempt: undefined, latencyMs: undefined });
  }

  /** Closes the socket of `api`; settles on its close event, or after CLOSE_WAIT_MS without one. */
  function beginClose(api: IBApi, reason: string): Promise<void> {
    ctx.apiLog.note('out', 'socket close', [['reason', reason]]);
    // The session ends now, not at the close event: the TWS client holds what is sent from here on
    // and sends it in the next session of this instance (an order whose place() failed, a market
    // data line its service has already forgotten).
    ready = false;
    stopHeartbeat();
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const timer = setTimeout(() => {
      // The library reports nothing when the socket was never opened; finish the close here.
      onSocketClosed(api);
      resolve();
    }, CLOSE_WAIT_MS);
    void done.then(() => clearTimeout(timer));
    closing = { api, done, resolve };
    try {
      api.disconnect();
    } catch {
      // the timer finishes the close
    }
    return done;
  }

  // ---------------------------------------------------------------------------
  // Errors and notices

  function onError(api: IBApi, err: unknown, code: number, id: number, adv?: unknown): void {
    if (api !== inst) return;
    const message = err instanceof Error ? err.message : String(err ?? '');
    if (typeof id === 'number' && id >= 0) {
      if (code === 10197) {
        // One notice per episode: the issue clears with the next real price tick.
        if (!state.marketDataIssue) notify(connectionNotices.competingSession());
        setState({ marketDataIssue: { code, message } });
      }
      const e: RequestError = { reqId: id, code, message };
      if (adv != null) e.advancedOrderReject = typeof adv === 'string' ? adv : JSON.stringify(adv);
      for (const l of [...requestErrorListeners]) safely(() => l(e), 'request error');
      return;
    }
    // Library-side errors (socket failures, encoding problems) never appear as frames.
    if (code >= 500 && code < 600 && (code !== 504 || wanted)) {
      ctx.apiLog.note('in', 'error', [['code', String(code)], ['msg', message]], true);
    }
    onGlobal(api, code, message);
  }

  /** Messages without a request id: farm status, connectivity, client id conflicts, etc. */
  function onGlobal(api: IBApi, code: number, message: string): void {
    if (api !== inst) return;
    const farm = farmUpdate(code, message);
    if (farm) {
      setState({ farms: { ...state.farms, [farm.farm]: farm.status } });
      return;
    }
    switch (code) {
      case 1100:
        setState({ lastError: { code, message, time: Date.now() } });
        notify(connectionNotices.lost(mode()));
        return;
      case 1101:
      case 1102:
        if (state.lastError?.code === 1100) setState({ lastError: undefined });
        notify(connectionNotices.restored(mode(), code === 1101));
        // 1101: IB dropped the market data subscriptions; services re-issue them.
        if (code === 1101 && ready) fireReady(api);
        return;
      case 1300: // socket port reset: the connection is being dropped
        setState({ lastError: { code, message, time: Date.now() } });
        return;
      case 10197:
        setState({ marketDataIssue: { code, message } });
        return;
      case 326: // client id in use; TWS closes the socket
      case 502: // could not connect
      case 506: // unsupported server version
      case 503: // TWS too old
        if (!ready) {
          fail(api, { code, message }, code !== 502);
          return;
        }
        break;
      case 501: // "Already connected" / 504 "Not connected": library notices about our own calls
      case 504:
        if (!wanted || !ready) return;
        break;
    }
    if (isInfoCode(code) || !isErrorCode(code)) return;
    setState({ lastError: { code, message: cleanIbMessage(message), time: Date.now() } });
  }

  // ---------------------------------------------------------------------------
  // Heartbeat and market data health

  function startHeartbeat(api: IBApi): void {
    stopHeartbeat();
    const beat = () => {
      if (!ready || api !== inst) return;
      heartbeatSentAt = Date.now();
      try {
        api.reqCurrentTime();
      } catch (err) {
        console.error('[ib] heartbeat failed:', err);
      }
    };
    beat();
    heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    heartbeatSentAt = 0;
  }

  function onCurrentTime(): void {
    if (!heartbeatSentAt) return;
    const latencyMs = Date.now() - heartbeatSentAt;
    heartbeatSentAt = 0;
    setState({ latencyMs });
  }

  /** Any real price tick means market data flows again (clears a 10197 notice). */
  function onTickPrice(_reqId: number, _field: number, price: unknown): void {
    if (state.marketDataIssue && typeof price === 'number' && price > 0) setState({ marketDataIssue: undefined });
  }

  // ---------------------------------------------------------------------------
  // Settings

  setImmediate(() => {
    ctx.store.onSettingsChanged((next, prev) => {
      const p = connectionParams(next.connection);
      if (!sameParams(p, params)) void settle(applyParams(p));
      // Turning auto-reconnect off stops a pending retry.
      if (!next.connection.autoReconnect && prev.connection.autoReconnect && retryTimer) {
        retryTimer = clearTimer(retryTimer);
        wanted = false;
        reconnectAttempt = 0;
        retryFirstAttempt = false;
        droppedAt = 0;
        setState({ status: 'disconnected', reconnectAttempt: undefined });
      }
    });
  });

  /** Settings changes being applied (only the newest one reconnects). */
  let paramsChanges = 0;
  /**
   * A change interrupted a wanted connection (or a change still closing the socket did): the
   * newest change reconnects. A user disconnect clears it, also before its socket has closed.
   */
  let reconnectAfterChange = false;
  /** Closes on purpose and settings changes under way: connect() starts after them. */
  const settling = new Set<Promise<void>>();
  /** User disconnects so far (one cancels a connect() still waiting for `settling`). */
  let disconnects = 0;

  function settle(work: Promise<void>): Promise<void> {
    const p: Promise<void> = work.finally(() => settling.delete(p));
    settling.add(p);
    return p;
  }

  /**
   * Host, port or client id changed: drop the instance and reconnect if a connection was wanted.
   * The user did not ask to disconnect, so a failed attempt retries like a dropped connection.
   */
  async function applyParams(p: ConnectionParams): Promise<void> {
    const change = ++paramsChanges;
    reconnectAfterChange ||= wanted;
    if (reconnectAfterChange) await closeSocket('settings changed');
    // A user disconnect finishes closing the old socket (its close event, the onClosed listeners)
    // before the instance is dropped.
    else if (closing) await closing.done;
    // A newer change arrived while the socket was closing: it applies its own parameters.
    if (change !== paramsChanges) return;
    const reconnect = reconnectAfterChange;
    reconnectAfterChange = false;
    params = p;
    dropInstance();
    setState({ host: p.host, port: p.port, clientId: p.clientId });
    if (!reconnect) return;
    if (pending) {
      // A connect() made while the socket was closing went to the dropped instance.
      const stale = pending;
      pending = null;
      stale.reject(new Error('Connection cancelled'));
    }
    wanted = true;
    retryFirstAttempt = true;
    start(false).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Public interface

  const connection: IbConnection = {
    get api() {
      return ready ? inst : null;
    },
    getState: () => state,
    connect() {
      // After a close or settings change under way: the instance being closed must not be reused
      // (its close event would end the attempt), and a change brings new parameters.
      if (settling.size > 0) {
        const seen = disconnects;
        return Promise.allSettled(settling).then(() => {
          if (disconnects !== seen) throw new Error('Connection cancelled');
          return connection.connect();
        });
      }
      if (ready) return Promise.resolve();
      wanted = true;
      // A manual attempt reports its failure and is not retried (see retryFirstAttempt). It
      // replaces a pending retry right away, and an attempt in flight (a retry, or the first
      // attempt after a settings change) that it joins becomes one, so the caller's promise and
      // the status agree.
      retryTimer = clearTimer(retryTimer);
      reconnectAttempt = 0;
      retryFirstAttempt = false;
      droppedAt = 0;
      if (connecting) {
        if (state.status === 'reconnecting') setState({ status: 'connecting', reconnectAttempt: undefined });
        return connecting;
      }
      return start(false);
    },
    disconnect() {
      // The user no longer wants a connection, also not the one a settings change would make.
      disconnects++;
      reconnectAfterChange = false;
      return settle(closeSocket('user disconnect'));
    },
    isConnected: () => ready,
    nextReqId: () => reqId++,
    nextOrderId: () => orderId++,
    on(event, listener) {
      let set = registry.get(event);
      if (!set) {
        set = new Set();
        registry.set(event, set);
        if (inst) forward(inst, event);
      }
      set.add(listener);
      const s = set;
      return () => void s.delete(listener);
    },
    onReady(listener) {
      readyListeners.add(listener);
      // A service that subscribes while connected still gets this session.
      const api = inst;
      if (ready && api) queueMicrotask(() => ready && inst === api && readyListeners.has(listener) && safely(() => listener(api), 'ready'));
      return () => void readyListeners.delete(listener);
    },
    onClosed(listener) {
      closedListeners.add(listener);
      return () => void closedListeners.delete(listener);
    },
    onRequestError(listener) {
      requestErrorListeners.add(listener);
      return () => void requestErrorListeners.delete(listener);
    },
  };
  return connection;
}
