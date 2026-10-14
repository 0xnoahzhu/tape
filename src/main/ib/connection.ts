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
//
// Moving to another Gateway, client id or account starts a new session (ConnectionState.session,
// onSessionChange): a host / port / client id change once the old socket has closed (also while
// disconnected; the account is unknown until the new login names it), or managedAccounts listing
// other accounts on unchanged parameters (the Gateway logged in to another user, e.g. its Live /
// Paper switch), before anything of that login is requested. Services forget the previous
// session's orders, fills and account values then; a plain reconnect keeps them. The connection
// is never ready before managedAccounts has named the login's accounts: orders, account updates
// and P&L requests name the account. Without it, Tape asks again (reqManagedAccts), and the
// handshake timeout ends an attempt that never gets it.
//
// The first time a session is ready on a live account (the first of the run, or one a switch
// started), a 'conn' notice says so: "Connected to LIVE account U…". A plain reconnect of the
// same session says nothing new.
//
// IB's 321 "The API interface is currently in Read-Only mode" (Read-Only API on in TWS / IB
// Gateway; at the handshake it refuses reqCompletedOrders, reqId -1) sets readOnlyApi: IB then
// refuses orders and cancels. The next handshake clears it, and so does IB accepting an order
// request of this client (the user turned the setting off meanwhile).
//
// Health of a ready connection, which the status alone does not show: 1100 (TWS / IB Gateway lost
// its own connection to IB), or 2110 (the link is broken; how TWS reports an outage already under
// way to a socket that connects during it, which never hears that outage's 1100), sets ibLinkLost
// until 1101 / 1102; a heartbeat (reqCurrentTime every
// 30 s) unanswered for 10 s sets unresponsive (a Gateway that hangs keeps its socket open), and when
// the next beat goes unanswered too, Tape closes the socket so auto-reconnect starts over. The order
// service refuses orders and modifies in either state (a cancel is still sent); the next handshake
// and a new session clear both.

import { EventName, IBApi } from './tws';
import type { ConnectionState } from '@shared/types';
import type { IbConnection, IbListener, MainContext, SessionChangeReason } from '../context';
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
/**
 * nextValidId may arrive before managedAccounts: after this long without the account list it is
 * asked for again (the connection never becomes ready without it).
 */
const ACCOUNTS_WAIT_MS = 2_000;
const HEARTBEAT_MS = 30_000;
/** A heartbeat unanswered this long marks the connection unresponsive (IB answers within a second). */
const HEARTBEAT_STALE_MS = 10_000;
/** Heartbeats in a row unanswered after HEARTBEAT_STALE_MS (about 40 s of silence) close the socket. */
const MISSED_BEATS_CLOSE = 2;
const CLOSE_WAIT_MS = 1_000;
/**
 * Request ids start far above the order ids IB hands out (nextValidId, one more per order), so the
 * id of an error names a request or an order, never both: an error of a market data line must not
 * reject or annotate the order with the same number. Both are int32 on the wire.
 */
export const FIRST_REQ_ID = 1_000_000_000;

type RequestError = { reqId: number; code: number; message: string; advancedOrderReject?: string };

/** IB's refusal while Read-Only API is on: "…The API interface is currently in Read-Only mode." (321, any request id). */
const isReadOnlyRefusal = (code: number, message: string) => code === 321 && /read-only/i.test(message);

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
  const sessionListeners = new Set<(reason: SessionChangeReason) => void>();
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
    session: 0,
    accounts: [],
    isPaper: false,
    farms: {},
  };
  /**
   * The current session's accounts as managedAccounts listed them (sorted, comma-joined); null
   * until the login of a session is known. Other accounts on the same parameters start a new session.
   */
  let sessionAccounts: string | null = null;

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
  /** The last session that has been ready (its live account announced); -1 before the first. */
  let announcedSession = -1;

  let reqId = FIRST_REQ_ID;
  let orderId = 0;

  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let accountsTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** HEARTBEAT_STALE_MS after a beat: whether it has been answered. */
  let heartbeatCheck: ReturnType<typeof setTimeout> | null = null;
  /** When the oldest unanswered heartbeat was sent; 0 while none waits. */
  let heartbeatSentAt = 0;
  /** Heartbeat checks in a row that found no answer. */
  let missedBeats = 0;
  /** Tape is closing the socket of a TWS / IB Gateway that stopped answering (it reconnects). */
  let silentClose = false;
  /** The socket being closed on purpose, until its close event (every close of it waits for that). */
  let closing: { api: IBApi; done: Promise<void>; resolve: () => void } | null = null;

  // ---------------------------------------------------------------------------
  // State

  function setState(patch: Partial<ConnectionState>): void {
    state = { ...state, ...patch };
    ctx.emit({ type: 'connection', state });
  }

  /**
   * Tape moves to another Gateway, client id or account: a new session. Its state (with `patch`)
   * reaches the renderer before anything the services send for it, and the services forget the
   * previous session's orders, fills and account values (onSessionChange) before the new one is
   * ready. On new parameters the account is unknown until the new login lists its accounts.
   */
  function beginSession(reason: SessionChangeReason, patch: Partial<ConnectionState>): void {
    const session = state.session + 1;
    if (reason === 'params') sessionAccounts = null;
    setState({
      ...patch,
      session,
      readOnlyApi: undefined,
      ibLinkLost: undefined,
      unresponsive: undefined,
      ...(reason === 'params' ? { accounts: [], account: undefined, isPaper: false } : {}),
    });
    ctx.apiLog.note('out', 'new session', [
      ['reason', reason === 'params' ? 'host, port or client id changed' : 'other accounts'],
      ['session', String(session)],
    ]);
    for (const l of [...sessionListeners]) safely(() => l(reason), 'session');
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
    silentClose = false;
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
      // Learnt again from this handshake (IB refuses its reqCompletedOrders with 321).
      readOnlyApi: undefined,
      // Learnt again from this handshake (2110) or a later 1100: the IB link a 1100 reported lost may
      // have come back while no socket was there to hear its 1101 / 1102.
      ibLinkLost: undefined,
      unresponsive: undefined,
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
    // A late answer on a socket being closed belongs to the session that ends.
    if (api !== inst || closing?.api === api) return;
    const accounts = parseAccounts(list);
    // Other accounts than the session's on unchanged parameters: the Gateway is logged in to
    // another user now. A new session starts here, before nextValidId makes it ready.
    const key = [...accounts].sort().join(',');
    const other = key !== '' && sessionAccounts !== null && key !== sessionAccounts;
    if (key) sessionAccounts = key;
    const account = !other && state.account && accounts.includes(state.account) ? state.account : accounts[0];
    accountsKnown = true;
    const patch = { accounts, account, isPaper: isPaperAccount(account) };
    if (other) beginSession('accounts', patch);
    else setState(patch);
    if (gotValidId && !ready) becomeReady(api);
  }

  function onNextValidId(api: IBApi, id: number): void {
    if (typeof id === 'number' && id > orderId) orderId = id;
    if (ready || api !== inst) return;
    gotValidId = true;
    if (accountsKnown) becomeReady(api);
    // Never ready without the login's accounts (see the header): ask for them again.
    else if (!accountsTimer) accountsTimer = setTimeout(() => askAccounts(api), ACCOUNTS_WAIT_MS);
  }

  function askAccounts(api: IBApi): void {
    accountsTimer = null;
    if (ready || accountsKnown || api !== inst || !socketOpen || closing?.api === api) return;
    try {
      api.reqManagedAccts();
    } catch (err) {
      console.error('[ib] reqManagedAccts failed:', err);
    }
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
    if (state.session !== announcedSession) {
      announcedSession = state.session;
      // The id is left out while Settings › Privacy hides account IDs; LIVE never is.
      if (!state.isPaper && state.account) notify(connectionNotices.liveAccount(mode(), ctx.store.getSettings().appearance.showAccountId ? state.account : ''));
    }
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
    // Tape closed it because TWS / IB Gateway stopped answering (logged then): it reconnects.
    const silent = silentClose;
    silentClose = false;
    // A heartbeat close ended the session before the socket closed (checkHeartbeat): it was ready.
    const wasReady = ready || silent;
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
      if (!silent) ctx.apiLog.note('in', 'socket close', [['reason', 'closed by TWS / IB Gateway']], true);
      notify(silent ? connectionNotices.silent(mode(), params, retry) : connectionNotices.disconnected(mode(), params, retry));
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
      noteReadOnly(code, message);
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

  /** A 321 Read-Only refusal: IB refuses orders and cancels from now on (see the header). */
  function noteReadOnly(code: number, message: string): void {
    if (isReadOnlyRefusal(code, message) && !state.readOnlyApi) setState({ readOnlyApi: true });
  }

  /** Messages without a request id: farm status, connectivity, client id conflicts, etc. */
  function onGlobal(api: IBApi, code: number, message: string): void {
    if (api !== inst) return;
    noteReadOnly(code, message);
    const farm = farmUpdate(code, message);
    if (farm) {
      setState({ farms: { ...state.farms, [farm.farm]: farm.status } });
      return;
    }
    switch (code) {
      case 1100:
      case 2110: // the link is (still) broken, e.g. said to a socket that connects during the outage
        // Orders and modifies are refused until 1101 / 1102 (orders.ts); a cancel is still sent.
        // One notice per outage: a 2110 after its 1100 says nothing new.
        if (!state.ibLinkLost) notify(connectionNotices.lost(mode()));
        setState({ lastError: { code, message: cleanIbMessage(message), time: Date.now() }, ibLinkLost: true });
        return;
      case 1101:
      case 1102:
        setState({ ibLinkLost: undefined, ...(state.lastError?.code === 1100 || state.lastError?.code === 2110 ? { lastError: undefined } : {}) });
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

  /**
   * reqCurrentTime every HEARTBEAT_MS: the latency, and a TWS / IB Gateway that hangs (its socket
   * stays open, nothing is answered; see the header). A beat while the previous one is unanswered
   * asks again but keeps the first one's time, so the silence is measured from there.
   */
  function startHeartbeat(api: IBApi): void {
    stopHeartbeat();
    const beat = () => {
      if (!ready || api !== inst) return;
      if (!heartbeatSentAt) heartbeatSentAt = Date.now();
      try {
        api.reqCurrentTime();
      } catch (err) {
        console.error('[ib] heartbeat failed:', err);
      }
      heartbeatCheck = clearTimer(heartbeatCheck);
      heartbeatCheck = setTimeout(() => checkHeartbeat(api), HEARTBEAT_STALE_MS);
    };
    beat();
    heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  }

  /** HEARTBEAT_STALE_MS after a beat, still no answer: unresponsive, and the second time closed. */
  function checkHeartbeat(api: IBApi): void {
    heartbeatCheck = null;
    if (!heartbeatSentAt || !ready || api !== inst) return;
    missedBeats++;
    const silence = `${Math.round((Date.now() - heartbeatSentAt) / 1000)} s`;
    if (missedBeats >= MISSED_BEATS_CLOSE) {
      ctx.apiLog.note('out', 'socket close', [['reason', `no heartbeat answer for ${silence}`]], true);
      // Not closeSocket(): the connection is still wanted, so onSocketClosed reconnects.
      silentClose = true;
      // The session ends now, as in beginClose: a cancel sent before the close event would be held
      // by the TWS client, and the user told it never left Tape.
      ready = false;
      stopHeartbeat();
      try {
        api.disconnect();
      } catch {
        onSocketClosed(api);
      }
      return;
    }
    if (state.unresponsive) return;
    ctx.apiLog.note('in', 'no heartbeat answer', [['after', silence]], true);
    setState({ unresponsive: true });
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    heartbeatCheck = clearTimer(heartbeatCheck);
    heartbeatSentAt = 0;
    missedBeats = 0;
    if (state.unresponsive) setState({ unresponsive: undefined });
  }

  function onCurrentTime(): void {
    if (!heartbeatSentAt) return;
    const latencyMs = Date.now() - heartbeatSentAt;
    heartbeatSentAt = 0;
    missedBeats = 0;
    heartbeatCheck = clearTimer(heartbeatCheck);
    setState({ latencyMs, unresponsive: undefined });
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
    // Another Gateway or client id, maybe another login: a new session, also while disconnected
    // (the old socket has closed and its onClosed listeners have run; no frame of it arrives now).
    beginSession('params', { host: p.host, port: p.port, clientId: p.clientId });
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
    onReady(listener, opts) {
      readyListeners.add(listener);
      // A service that subscribes while connected still gets this session (unless it only wants the next ones).
      const api = inst;
      if (opts?.current !== false && ready && api) queueMicrotask(() => ready && inst === api && readyListeners.has(listener) && safely(() => listener(api), 'ready'));
      return () => void readyListeners.delete(listener);
    },
    onClosed(listener) {
      closedListeners.add(listener);
      return () => void closedListeners.delete(listener);
    },
    onSessionChange(listener) {
      sessionListeners.add(listener);
      return () => void sessionListeners.delete(listener);
    },
    onRequestError(listener) {
      requestErrorListeners.add(listener);
      return () => void requestErrorListeners.delete(listener);
    },
    noteOrderAccepted() {
      if (state.readOnlyApi) setState({ readOnlyApi: undefined });
    },
  };
  return connection;
}
