// IBApi: a dependency-free client for TWS / IB Gateway with the public surface of
// @stoqey/ib's IBApi for the requests and events Tape uses (same method names, parameter
// order, event names and listener arguments).
//
// Lifecycle (same order as @stoqey/ib):
//   connect() -> TCP connect -> handshake "API\0" + "v176..193" -> server version frame
//   -> START_API -> `connected` -> `server` (version, connection time)
//   -> managedAccounts / nextValidId / farm status (`info`) ...
// Requests made before nextValidId (or while disconnected) are held and flushed right after
// the next nextValidId event; afterwards they are sent at once. Every frame goes through the
// send queue (sendQueue.ts): at most 45 messages per second, spread evenly past a burst of 10
// (halved for 10 s after IB's error 100), orders before control before market data when frames
// wait, IB's pacing of symbol searches and historical data checked at write time (pacing.ts),
// and a cancel whose request has not been sent yet removes both. Socket errors are reported as
// `error` (code 502), a closed socket as `disconnected`.
//
// Wire format follows the IB TWS API (EClient/EDecoder). Portions derived from @stoqey/ib (MIT, Copyright (c) the @stoqey/ib authors)

import { EventEmitter } from 'node:events';
import { TwsConnection } from './connection.ts';
import { decodeMessage, decodeServerVersion, type DecodedEvent } from './decoder.ts';
import * as encoder from './encoder.ts';
import type { Token } from './encoder.ts';
import { EventName } from './enums.ts';
import type { BarSizeSetting, MarketDataType, OrderStatus, WhatToShow } from './enums.ts';
import { ErrorCode, TwsEncodeError } from './errors.ts';
import { MAX_SERVER_VERSION, MIN_SERVER_VERSION } from './messageIds.ts';
import { pacesOf } from './pacing.ts';
import { BACKOFF_MS, laneOf, pairingOf, SendQueue, type QueueStats } from './sendQueue.ts';
import type { TickType } from './tickTypes.ts';
import type {
  CommissionReport,
  Contract,
  ContractDescription,
  ContractDetails,
  DepthMktDataDescription,
  Execution,
  ExecutionFilter,
  IBApiCreationOptions,
  Order,
  OrderCancel,
  OrderState,
  TagValue,
  WshEventData,
} from './types.ts';

/** Listener signatures of the events this client emits (argument order of @stoqey/ib). */
export interface IBApiEventMap {
  all: (event: string, args: unknown[]) => void;
  result: (event: string, args: unknown[]) => void;
  connected: () => void;
  disconnected: () => void;
  server: (serverVersion: number, serverConnectionTime: string) => void;
  error: (error: Error, code: number, reqId: number, advancedOrderReject?: unknown) => void;
  info: (message: string, code: number) => void;
  /** Every incoming frame (before it is decoded): its fields and its raw text. */
  received: (tokens: string[], raw: string) => void;
  /** Every outgoing frame (when written): its tokens and its text. */
  sent: (tokens: unknown[], raw: string) => void;
  /** Send queue diagnostics: at most once per second while frames wait, once more when drained. */
  queueStats: (stats: IBApiQueueStats) => void;
  accountDownloadEnd: (account: string) => void;
  accountSummary: (reqId: number, account: string, tag: string, value: string, currency: string) => void;
  accountSummaryEnd: (reqId: number) => void;
  bondContractDetails: (reqId: number, contractDetails: ContractDetails) => void;
  commissionReport: (commissionReport: CommissionReport) => void;
  completedOrder: (contract: Contract, order: Order, orderState: OrderState) => void;
  completedOrdersEnd: () => void;
  contractDetails: (reqId: number, contractDetails: ContractDetails) => void;
  contractDetailsEnd: (reqId: number) => void;
  currentTime: (time: number) => void;
  execDetails: (reqId: number, contract: Contract, execution: Execution) => void;
  execDetailsEnd: (reqId: number) => void;
  headTimestamp: (reqId: number, headTimestamp: string) => void;
  /** One bar; the data set ends with time = "finished-<start>-<end>" and -1 values. */
  historicalData: (
    reqId: number,
    time: string,
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number,
    count: number | undefined,
    WAP: number,
    hasGaps: boolean | undefined,
  ) => void;
  historicalDataUpdate: (reqId: number, time: string, open: number, high: number, low: number, close: number, volume: number, count: number, WAP: number) => void;
  managedAccounts: (accountsList: string) => void;
  marketDataType: (reqId: number, marketDataType: number) => void;
  mktDepthExchanges: (depthMktDataDescriptions: DepthMktDataDescription[]) => void;
  nextValidId: (orderId: number) => void;
  openOrder: (orderId: number, contract: Contract, order: Order, orderState: OrderState) => void;
  openOrderEnd: () => void;
  orderBound: (permId: number, clientId: number, orderId: number) => void;
  orderStatus: (
    orderId: number,
    status: OrderStatus,
    filled: number,
    remaining: number,
    avgFillPrice: number,
    permId?: number,
    parentId?: number,
    lastFillPrice?: number,
    clientId?: number,
    whyHeld?: string,
    mktCapPrice?: number,
  ) => void;
  pnl: (reqId: number, dailyPnL: number, unrealizedPnL?: number, realizedPnL?: number) => void;
  pnlSingle: (reqId: number, pos: number, dailyPnL: number, unrealizedPnL: number | undefined, realizedPnL: number | undefined, value: number) => void;
  position: (account: string, contract: Contract, pos: number, avgCost?: number) => void;
  positionEnd: () => void;
  rerouteMktDataReq: (reqId: number, conId: number, exchange: string) => void;
  rerouteMktDepthReq: (reqId: number, conId: number, exchange: string) => void;
  securityDefinitionOptionParameter: (
    reqId: number,
    exchange: string,
    underlyingConId: number,
    tradingClass: string,
    multiplier: number,
    expirations: string[],
    strikes: number[],
  ) => void;
  securityDefinitionOptionParameterEnd: (reqId: number) => void;
  smartComponents: (reqId: number, theMap: Map<number, [string, string]>) => void;
  symbolSamples: (reqId: number, contractDescriptions: ContractDescription[]) => void;
  tickGeneric: (reqId: number, field: TickType, value: number) => void;
  tickOptionComputation: (
    reqId: number,
    field: TickType,
    tickAttrib: number | undefined,
    impliedVolatility?: number,
    delta?: number,
    optPrice?: number,
    pvDividend?: number,
    gamma?: number,
    vega?: number,
    theta?: number,
    undPrice?: number,
  ) => void;
  tickPrice: (reqId: number, field: TickType, value: number, attribs?: unknown) => void;
  tickReqParams: (reqId: number, minTick: number, bboExchange: string, snapshotPermissions: number) => void;
  tickSize: (reqId: number, field?: TickType, value?: number) => void;
  tickSnapshotEnd: (reqId: number) => void;
  tickString: (reqId: number, field: TickType, value: string) => void;
  updateAccountTime: (timestamp: string) => void;
  updateAccountValue: (key: string, value: string, currency: string, accountName: string) => void;
  updatePortfolio: (
    contract: Contract,
    position: number,
    marketPrice: number,
    marketValue: number,
    averageCost?: number,
    unrealizedPNL?: number,
    realizedPNL?: number,
    accountName?: string,
  ) => void;
  updateMktDepth: (reqId: number, position: number, operation: number, side: number, price: number, size: number) => void;
  /** Wall Street Horizon: the JSON of the meta data (event types, filters). */
  wshMetaData: (reqId: number, dataJson: string) => void;
  /** Wall Street Horizon: the JSON of the events. */
  wshEventData: (reqId: number, dataJson: string) => void;
  updateMktDepthL2: (
    reqId: number,
    position: number,
    marketMaker: string,
    operation: number,
    side: number,
    price: number,
    size: number,
    isSmartDepth?: boolean,
  ) => void;
}

/** Send queue diagnostics of the client. */
export interface IBApiQueueStats extends QueueStats {
  /** Requests waiting for nextValidId (not encoded yet). */
  held: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListener = (...args: any[]) => void;

/** Encodes a request for the connected server version. */
type Encode = (serverVersion: number) => Token[];

interface PendingRequest {
  encode: Encode;
  /** Request id that pairs a subscription with its cancel (elision of unsent pairs). */
  reqId: number | undefined;
}

const Status = { Disconnected: 0, Disconnecting: 1, Connecting: 2, Connected: 3 } as const;
type Status = (typeof Status)[keyof typeof Status];

/** Events not repeated as `result` (same list as @stoqey/ib). */
const NO_RESULT_EVENTS: ReadonlySet<string> = new Set([
  EventName.connected,
  EventName.disconnected,
  EventName.error,
  EventName.received,
  EventName.sent,
  EventName.server,
]);

const DEFAULT_ORDER_CANCEL: OrderCancel = { manualOrderCancelTime: undefined, extOperator: '', manualOrderIndicator: undefined };

/** IB's "Max rate of messages per second has been exceeded". */
const MAX_RATE_EXCEEDED = 100;

const isRateExceeded = (event: DecodedEvent): boolean =>
  (event.name === EventName.error || event.name === EventName.info) && event.args[1] === MAX_RATE_EXCEEDED;

/** Rethrows outside the current call stack (the stream keeps being processed). */
const rethrowLater = (err: unknown): void =>
  queueMicrotask(() => {
    throw err;
  });

export class IBApi extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private clientId: number;
  private conn: TwsConnection | null = null;
  private status: Status = Status.Disconnected;
  private awaitingServerVersion = false;
  private _serverVersion = 0;
  private _serverConnectionTime = '';
  /** Requests flow (set by nextValidId, cleared by connect / disconnect / close). */
  private ready = false;
  /** Requests waiting for the next nextValidId, encoded when sent. */
  private readonly held: PendingRequest[] = [];
  /** Outgoing frames of every connection (window, backoff and counters span reconnects). */
  private readonly queue: SendQueue<Token[]>;

  constructor(options: IBApiCreationOptions = {}) {
    super();
    this.setMaxListeners(0);
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 7496;
    this.clientId = options.clientId !== undefined ? Math.floor(options.clientId) : 0;
    this.queue = new SendQueue<Token[]>({
      maxPerSecond: options.maxReqPerSec,
      write: (tokens) => this.conn?.write(tokens) ?? false,
      onStats: (stats) => this.emit('queueStats', { ...stats, held: this.held.length }),
    });
  }

  /** Server version of the current (or last) connection, 0 before the first handshake. */
  get serverVersion(): number {
    return this._serverVersion;
  }

  /** Connection time reported by the server in the handshake. */
  get serverConnectionTime(): string {
    return this._serverConnectionTime;
  }

  /** True once the server version is known, until the socket closes. */
  get isConnected(): boolean {
    return this.status === Status.Connected;
  }

  /** Send queue diagnostics (frames waiting per lane, rate, elided pairs, backoff). */
  getQueueStats(): IBApiQueueStats {
    return { ...this.queue.stats(), held: this.held.length };
  }

  // ---------------------------------------------------------------------------
  // Events

  override on<E extends keyof IBApiEventMap>(event: E, listener: IBApiEventMap[E]): this;
  override on(event: string | symbol, listener: AnyListener): this;
  override on(event: string | symbol, listener: AnyListener): this {
    return super.on(event, listener);
  }

  override once<E extends keyof IBApiEventMap>(event: E, listener: IBApiEventMap[E]): this;
  override once(event: string | symbol, listener: AnyListener): this;
  override once(event: string | symbol, listener: AnyListener): this {
    return super.once(event, listener);
  }

  override off<E extends keyof IBApiEventMap>(event: E, listener: IBApiEventMap[E]): this;
  override off(event: string | symbol, listener: AnyListener): this;
  override off(event: string | symbol, listener: AnyListener): this {
    return super.off(event, listener);
  }

  /** Like eventemitter3 (used by @stoqey/ib), an `error` without listeners is ignored instead of thrown. */
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === EventName.error && this.listenerCount(EventName.error) === 0) return false;
    return super.emit(event, ...args);
  }

  /** Emits an event plus `result` / `all` (as @stoqey/ib's controller does). */
  private dispatch(name: string, args: unknown[]): void {
    this.emit(name, ...args);
    if (!NO_RESULT_EVENTS.has(name)) this.emit(EventName.result, name, args);
    this.emit(EventName.all, name, args);
    if (name === EventName.nextValidId) this.resume();
  }

  /** Dispatches without letting a listener exception break frame processing. */
  private safeDispatch(name: string, args: unknown[]): void {
    try {
      this.dispatch(name, args);
    } catch (err) {
      rethrowLater(err);
    }
  }

  private emitError(message: string, code: number, reqId: number = ErrorCode.NO_VALID_ID, advancedOrderReject?: unknown): void {
    this.dispatch(EventName.error, [new Error(message), code, reqId, advancedOrderReject]);
  }

  private emitInfo(message: string, code: number): void {
    this.dispatch(EventName.info, [message, code]);
  }

  // ---------------------------------------------------------------------------
  // Connection

  /**
   * Connects to TWS / IB Gateway. `clientId` defaults to the constructor option (or 0).
   * Ignored while connecting; reports info 501 when already connected.
   */
  connect(clientId?: number): this {
    if (this.status === Status.Connected) {
      this.emitInfo('Cannot connect if already connected.', ErrorCode.ALREADY_CONNECTED);
      return this;
    }
    if (this.status === Status.Connecting) return this;
    // A previous socket still closing: finish it first so its close cannot hit the new one.
    if (this.conn) this.conn.closeNow();

    if (clientId !== undefined) this.clientId = Math.floor(clientId);
    this.status = Status.Connecting;
    this.ready = false;
    this.awaitingServerVersion = true;

    const conn: TwsConnection = new TwsConnection({
      host: this.host,
      port: this.port,
      events: {
        open: () => {
          if (this.conn === conn && conn.sendHandshake(`v${MIN_SERVER_VERSION}..${MAX_SERVER_VERSION}`)) this.queue.record();
        },
        frame: (fields, text) => this.conn === conn && this.onFrame(conn, fields, text),
        sent: (tokens, text) => this.conn === conn && this.dispatch(EventName.sent, [tokens, text]),
        error: (err) => this.conn === conn && this.emitError(err.message, ErrorCode.CONNECT_FAIL),
        close: () => this.conn === conn && this.onClose(),
      },
    });
    this.conn = conn;
    try {
      conn.open();
    } catch (err) {
      // e.g. an invalid port: no socket was created, so no close event will follow
      this.conn = null;
      this.status = Status.Disconnected;
      throw err;
    }
    return this;
  }

  /** Closes the connection; `disconnected` follows. Reports info 504 when not connected. */
  disconnect(): this {
    if (this.status >= Status.Connecting && this.conn) {
      this.status = Status.Disconnecting;
      this.ready = false;
      this.queue.clear();
      this.conn.close();
    } else {
      this.emitInfo('Cannot disconnect if already disconnected.', ErrorCode.NOT_CONNECTED);
    }
    return this;
  }

  private onClose(): void {
    this.conn = null;
    this.ready = false;
    this.queue.clear();
    this.awaitingServerVersion = false;
    const was = this.status;
    this.status = Status.Disconnected;
    if (was !== Status.Disconnected) this.safeDispatch(EventName.disconnected, []);
  }

  private onFrame(conn: TwsConnection, fields: string[], text: string): void {
    this.safeDispatch(EventName.received, [fields.slice(), text]);
    if (this.conn !== conn) return; // a listener disconnected
    if (this.awaitingServerVersion) {
      this.onServerVersion(conn, fields);
      return;
    }
    for (const event of decodeMessage(fields, this._serverVersion)) {
      if (isRateExceeded(event)) this.onRateExceeded();
      this.safeDispatch(event.name, event.args);
    }
  }

  /** IB rejected a message for exceeding its rate: send at half the rate for a while. */
  private onRateExceeded(): void {
    if (!this.queue.backoff()) return;
    const { maxPerSecond } = this.queue.stats();
    console.warn(`[tws] error ${MAX_RATE_EXCEEDED} (message rate exceeded): sending at most ${maxPerSecond} messages/s for ${BACKOFF_MS / 1000} s`);
  }

  private onServerVersion(conn: TwsConnection, fields: string[]): void {
    this.awaitingServerVersion = false;
    const { serverVersion, connTime } = decodeServerVersion(fields);
    this.status = Status.Connected;
    this._serverVersion = serverVersion;
    this._serverConnectionTime = connTime;
    if (!Number.isFinite(serverVersion) || serverVersion > MAX_SERVER_VERSION) {
      this.disconnect();
      this.safe(() => this.emitError(`Unsupported Version ${fields[0] ?? ''}`, ErrorCode.UNSUPPORTED_VERSION));
      return;
    }
    if (serverVersion < MIN_SERVER_VERSION) {
      this.disconnect();
      this.safe(() =>
        this.emitError(
          `The TWS is out of date and must be upgraded: server version ${serverVersion} is older than the minimum supported version ${MIN_SERVER_VERSION}.`,
          ErrorCode.UPDATE_TWS,
        ),
      );
      return;
    }
    // START_API goes ahead of everything (the queue is empty until nextValidId) and counts.
    if (conn.write(encoder.startApi(serverVersion, this.clientId, ''))) this.queue.record();
    this.safeDispatch(EventName.connected, []);
    this.safeDispatch(EventName.server, [serverVersion, connTime]);
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      rethrowLater(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Request queue

  /**
   * Queues a request when the session is ready, otherwise holds it until the next
   * nextValidId. `reqId` pairs a subscription with its cancel. Encoding problems become
   * `error` events.
   */
  private request(encode: Encode, reqId?: number): this {
    const req: PendingRequest = { encode, reqId };
    if (this.ready && this.held.length === 0) this.run(req, true);
    else this.held.push(req);
    return this;
  }

  private run(req: PendingRequest, immediate: boolean): void {
    let tokens: Token[];
    try {
      tokens = req.encode(this._serverVersion);
      encoder.checkFieldText(this._serverVersion, tokens, req.reqId);
    } catch (err) {
      if (err instanceof TwsEncodeError) {
        this.safe(() => this.emitError(err.message, err.code, err.reqId));
        return;
      }
      // Invalid arguments: thrown to the caller, or reported when the request was held.
      if (immediate) throw err;
      this.safe(() => this.emitError(`Could not encode a request: ${err instanceof Error ? err.message : String(err)}`, ErrorCode.FAIL_SEND));
      return;
    }
    const msgId = Number(tokens[0]);
    this.queue.push(tokens, laneOf(msgId), pairingOf(msgId, req.reqId), pacesOf(tokens));
  }

  /** Sends the held requests (after nextValidId) as one batch: by lane, unsent pairs elided. */
  private resume(): void {
    this.ready = true;
    this.queue.cork();
    try {
      while (this.ready && this.held.length > 0) {
        const req = this.held.shift() as PendingRequest;
        this.safe(() => this.run(req, false));
      }
    } finally {
      this.queue.uncork();
    }
  }

  // ---------------------------------------------------------------------------
  // Market data

  reqMktData(reqId: number, contract: Contract, genericTickList: string | null, snapshot: boolean, regulatorySnapshot: boolean): this {
    return this.request((sv) => encoder.reqMktData(sv, reqId, contract, genericTickList ?? '', snapshot, regulatorySnapshot), reqId);
  }

  cancelMktData(reqId: number): this {
    return this.request((sv) => encoder.cancelMktData(sv, reqId), reqId);
  }

  /** 1 = live, 2 = frozen, 3 = delayed, 4 = delayed frozen. */
  reqMarketDataType(marketDataType: MarketDataType): this {
    return this.request((sv) => encoder.reqMarketDataType(sv, marketDataType));
  }

  reqMktDepth(reqId: number, contract: Contract, numRows: number, isSmartDepth: boolean, mktDepthOptions?: TagValue[]): this {
    return this.request((sv) => encoder.reqMktDepth(sv, reqId, contract, numRows, isSmartDepth, mktDepthOptions), reqId);
  }

  cancelMktDepth(reqId: number, isSmartDepth: boolean): this {
    return this.request((sv) => encoder.cancelMktDepth(sv, reqId, isSmartDepth), reqId);
  }

  // ---------------------------------------------------------------------------
  // Historical data

  reqHistoricalData(
    reqId: number,
    contract: Contract,
    endDateTime: string | undefined,
    durationStr: string,
    barSizeSetting: BarSizeSetting,
    whatToShow: WhatToShow,
    useRTH: number | boolean,
    formatDate: number,
    keepUpToDate: boolean,
  ): this {
    return this.request(
      (sv) => encoder.reqHistoricalData(sv, reqId, contract, endDateTime, durationStr, barSizeSetting, whatToShow, useRTH, formatDate, keepUpToDate),
      reqId,
    );
  }

  cancelHistoricalData(reqId: number): this {
    return this.request((sv) => encoder.cancelHistoricalData(sv, reqId), reqId);
  }

  reqHeadTimestamp(reqId: number, contract: Contract, whatToShow: WhatToShow, useRTH: boolean, formatDate: number): this {
    return this.request((sv) => encoder.reqHeadTimestamp(sv, reqId, contract, whatToShow, useRTH, formatDate), reqId);
  }

  cancelHeadTimestamp(reqId: number): this {
    return this.request((sv) => encoder.cancelHeadTimestamp(sv, reqId), reqId);
  }

  // ---------------------------------------------------------------------------
  // Contracts

  reqContractDetails(reqId: number, contract: Contract): this {
    return this.request((sv) => encoder.reqContractDetails(sv, reqId, contract));
  }

  reqMatchingSymbols(reqId: number, pattern: string): this {
    return this.request((sv) => encoder.reqMatchingSymbols(sv, reqId, pattern));
  }

  reqSecDefOptParams(reqId: number, underlyingSymbol: string, futFopExchange: string, underlyingSecType: string, underlyingConId: number): this {
    return this.request((sv) => encoder.reqSecDefOptParams(sv, reqId, underlyingSymbol, futFopExchange, underlyingSecType, underlyingConId));
  }

  // ---------------------------------------------------------------------------
  // Wall Street Horizon

  /** The event types and filters IB offers (wshMetaData); IB wants it before event data. */
  reqWshMetaData(reqId: number): this {
    return this.request((sv) => encoder.reqWshMetaData(sv, reqId), reqId);
  }

  cancelWshMetaData(reqId: number): this {
    return this.request((sv) => encoder.cancelWshMetaData(sv, reqId), reqId);
  }

  reqWshEventData(reqId: number, data: WshEventData): this {
    return this.request((sv) => encoder.reqWshEventData(sv, reqId, data), reqId);
  }

  cancelWshEventData(reqId: number): this {
    return this.request((sv) => encoder.cancelWshEventData(sv, reqId), reqId);
  }

  // ---------------------------------------------------------------------------
  // Orders

  placeOrder(id: number, contract: Contract, order: Order): this {
    return this.request((sv) => encoder.placeOrder(sv, id, contract, order));
  }

  /** `orderCancelParam`: manual order cancel time, or the full set of cancel attributes. */
  cancelOrder(orderId: number, orderCancelParam?: string | OrderCancel): this {
    const orderCancel: OrderCancel =
      orderCancelParam == undefined
        ? { ...DEFAULT_ORDER_CANCEL }
        : typeof orderCancelParam === 'string'
          ? { ...DEFAULT_ORDER_CANCEL, manualOrderCancelTime: orderCancelParam }
          : orderCancelParam;
    return this.request((sv) => encoder.cancelOrder(sv, orderId, orderCancel));
  }

  reqGlobalCancel(orderCancel?: OrderCancel): this {
    const cancel = orderCancel || { ...DEFAULT_ORDER_CANCEL };
    return this.request((sv) => encoder.reqGlobalCancel(sv, cancel));
  }

  reqOpenOrders(): this {
    return this.request((sv) => encoder.reqOpenOrders(sv));
  }

  reqAllOpenOrders(): this {
    return this.request((sv) => encoder.reqAllOpenOrders(sv));
  }

  reqAutoOpenOrders(bAutoBind: boolean): this {
    return this.request((sv) => encoder.reqAutoOpenOrders(sv, bAutoBind));
  }

  reqCompletedOrders(apiOnly: boolean): this {
    return this.request((sv) => encoder.reqCompletedOrders(sv, apiOnly));
  }

  reqIds(numIds = 0): this {
    return this.request((sv) => encoder.reqIds(sv, numIds));
  }

  reqExecutions(reqId: number, filter: ExecutionFilter): this {
    return this.request((sv) => encoder.reqExecutions(sv, reqId, filter));
  }

  // ---------------------------------------------------------------------------
  // Account and portfolio

  reqManagedAccts(): this {
    return this.request((sv) => encoder.reqManagedAccts(sv));
  }

  reqAccountUpdates(subscribe: boolean, acctCode?: string): this {
    return this.request((sv) => encoder.reqAccountUpdates(sv, subscribe, acctCode ?? ''));
  }

  reqAccountSummary(reqId: number, group: string, tags: string): this {
    return this.request((sv) => encoder.reqAccountSummary(sv, reqId, group, tags), reqId);
  }

  cancelAccountSummary(reqId: number): this {
    return this.request((sv) => encoder.cancelAccountSummary(sv, reqId), reqId);
  }

  reqPositions(): this {
    return this.request((sv) => encoder.reqPositions(sv));
  }

  cancelPositions(): this {
    return this.request((sv) => encoder.cancelPositions(sv));
  }

  reqPnL(reqId: number, account: string, modelCode?: string | null): this {
    return this.request((sv) => encoder.reqPnL(sv, reqId, account, modelCode ?? ''), reqId);
  }

  cancelPnL(reqId: number): this {
    return this.request((sv) => encoder.cancelPnL(sv, reqId), reqId);
  }

  reqPnLSingle(reqId: number, account: string, modelCode: string | undefined | null, conId: number): this {
    return this.request((sv) => encoder.reqPnLSingle(sv, reqId, account, modelCode ?? '', conId), reqId);
  }

  cancelPnLSingle(reqId: number): this {
    return this.request((sv) => encoder.cancelPnLSingle(sv, reqId), reqId);
  }

  // ---------------------------------------------------------------------------
  // Misc

  reqCurrentTime(): this {
    return this.request((sv) => encoder.reqCurrentTime(sv));
  }
}
