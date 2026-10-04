// The typed contract between the renderer and the main process.
// The preload script exposes an object implementing `TapeApi` as `window.tape`.
// Every method maps 1:1 to an `ipcMain.handle` channel named `tape:<method>`.

import type {
  AccountSummary,
  ApiLogEntry,
  AppNotification,
  AppSnapshot,
  Bar,
  ConnectionState,
  ContractInfo,
  ContractRef,
  DeepPartial,
  DepthBook,
  Execution,
  HistoryPage,
  HistoryRequest,
  LocalizedText,
  NavPoint,
  NotificationKind,
  OptionChainParams,
  OrderRequest,
  PlaceOrderResult,
  Position,
  PriceAlert,
  Quote,
  QuoteSubscription,
  Settings,
  SymbolMatch,
  Watchlist,
  WorkingOrder,
} from './types';

/** Push events from main to renderer, all sent on the `tape:event` channel. */
export type TapeEvent =
  | { type: 'settings'; settings: Settings; dark: boolean }
  | { type: 'connection'; state: ConnectionState }
  | { type: 'account'; summary: AccountSummary | null }
  | { type: 'positions'; positions: Position[] }
  | { type: 'orders'; orders: WorkingOrder[] }
  | { type: 'executions'; executions: Execution[] }
  /** Partial quote updates, keyed by contract key. Batched (~100 ms). */
  | { type: 'quotes'; quotes: Record<string, Quote> }
  | { type: 'depth'; book: DepthBook }
  /**
   * New API log entries, batched (only while a view streams them). `reset` means the renderer
   * should drop its copy first. `logFilePath` is the current day's log file (it changes at midnight).
   */
  | { type: 'apiLog'; entries: ApiLogEntry[]; reset?: boolean; logFilePath?: string }
  | { type: 'notifications'; notifications: AppNotification[] }
  | { type: 'watchlists'; watchlists: Watchlist[] }
  | { type: 'priceAlerts'; alerts: PriceAlert[] }
  | { type: 'nav'; points: NavPoint[] }
  /** Application menu commands, so menu accelerators and in-app shortcuts share one code path. */
  | { type: 'command'; command: AppCommand }
  /** A notification (system or in-app) was clicked: open this instrument. */
  | { type: 'openContract'; contract: ContractRef; view?: 'chart' | 'opt' };

export type AppCommand =
  | 'open-settings'
  | 'toggle-theme'
  | 'page-portfolio'
  | 'page-trade'
  | 'page-orders'
  | 'focus-search'
  | 'cancel-last-order';

export interface NewNotification {
  kind: NotificationKind;
  title: LocalizedText;
  body: LocalizedText;
  contract?: ContractRef;
}

export interface TapeApi {
  getSnapshot(): Promise<AppSnapshot>;

  // Settings ---------------------------------------------------------------
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>;

  // Connection -------------------------------------------------------------
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Market data ------------------------------------------------------------
  /**
   * Declares the full set of quote subscriptions wanted by one UI owner (e.g. "watchlist",
   * "chart", "options-chain"). The main process unions all owners, subscribes to new
   * contracts and cancels the ones no owner wants any more. Pass [] to release.
   */
  setQuoteSubscriptions(owner: string, subs: QuoteSubscription[]): Promise<void>;
  getHistory(req: HistoryRequest): Promise<Bar[]>;
  /**
   * Up to `limit` bars older than `before` (unix seconds) for the same series as `req`, served from
   * the local cache when it covers the range and from IB otherwise (then cached).
   */
  getOlderBars(req: HistoryRequest, before: number, limit: number): Promise<HistoryPage>;
  searchSymbols(pattern: string): Promise<SymbolMatch[]>;
  /** Resolves and caches contract details. Returns null when IB does not know the contract. */
  getContractInfo(contract: ContractRef): Promise<ContractInfo | null>;
  /** Level 2 book for one instrument at a time; null stops it. Updates arrive as `depth` events. */
  setDepthSubscription(contract: ContractRef | null): Promise<void>;
  getOptionChainParams(underlying: ContractRef): Promise<OptionChainParams[]>;

  // Orders -----------------------------------------------------------------
  placeOrder(req: OrderRequest): Promise<PlaceOrderResult>;
  modifyOrder(orderId: number, req: OrderRequest): Promise<void>;
  cancelOrder(orderId: number): Promise<void>;
  /** reqGlobalCancel: cancels every working order in the account. */
  cancelAllOrders(): Promise<void>;
  /** Re-requests today's executions (reqExecutions). */
  refreshExecutions(): Promise<void>;

  // Watchlists and alerts --------------------------------------------------
  saveWatchlists(watchlists: Watchlist[]): Promise<void>;
  savePriceAlerts(alerts: PriceAlert[]): Promise<void>;

  // Notifications ----------------------------------------------------------
  /** For notifications raised by the renderer (e.g. option risk alerts). */
  notify(n: NewNotification): Promise<void>;
  markNotificationsRead(ids: string[] | 'all'): Promise<void>;
  testNotification(): Promise<void>;

  // API log ----------------------------------------------------------------
  getApiLog(): Promise<ApiLogEntry[]>;
  /** Live `apiLog` events are sent only while a view streams them (the API log page, the mini log). */
  setApiLogStreaming(on: boolean): Promise<void>;
  clearApiLog(): Promise<void>;
  /** Shows a save dialog and writes the full in-memory log. Returns the path or null if cancelled. */
  exportApiLog(): Promise<string | null>;
  revealLogFile(): Promise<void>;

  // Misc -------------------------------------------------------------------
  openExternal(url: string): Promise<void>;

  /** Subscribes to push events. Returns an unsubscribe function. */
  onEvent(listener: (event: TapeEvent) => void): () => void;
}

/** Methods that are invoked over ipcRenderer.invoke (everything except onEvent). */
export type TapeInvokeMethod = Exclude<keyof TapeApi, 'onEvent'>;

export const INVOKE_METHODS: readonly TapeInvokeMethod[] = [
  'getSnapshot',
  'updateSettings',
  'connect',
  'disconnect',
  'setQuoteSubscriptions',
  'getHistory',
  'getOlderBars',
  'searchSymbols',
  'getContractInfo',
  'setDepthSubscription',
  'getOptionChainParams',
  'placeOrder',
  'modifyOrder',
  'cancelOrder',
  'cancelAllOrders',
  'refreshExecutions',
  'saveWatchlists',
  'savePriceAlerts',
  'notify',
  'markNotificationsRead',
  'testNotification',
  'getApiLog',
  'setApiLogStreaming',
  'clearApiLog',
  'exportApiLog',
  'revealLogFile',
  'openExternal',
];

export const EVENT_CHANNEL = 'tape:event';

/**
 * Every invoke resolves to an envelope instead of rejecting, so expected failures (IB errors,
 * validation) do not get logged by Electron as unhandled handler errors. The preload script
 * unwraps it and throws a plain Error with the original message.
 */
export type InvokeResult<T = unknown> = { ok: true; value: T } | { ok: false; message: string };
export const invokeChannel = (method: TapeInvokeMethod): string => `tape:${method}`;

/** Handler map the main process registers; same signatures as TapeApi minus onEvent. */
export type TapeHandlers = { [M in TapeInvokeMethod]: TapeApi[M] };
