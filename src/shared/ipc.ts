// The typed contract between the renderer and the main process.
// The preload script exposes an object implementing `TapeApi` as `window.tape`.
// Every method maps 1:1 to an `ipcMain.handle` channel named `tape:<method>`.

import type { SoundCategory } from './notificationSounds';
import type {
  AccountSummary,
  ApiLogEntry,
  AppNotification,
  AppSnapshot,
  Bar,
  CacheStats,
  ConnectionState,
  ContractInfo,
  ContractRef,
  DeepPartial,
  DepthBook,
  Execution,
  HistoryPage,
  HistoryRequest,
  LocalizedText,
  LockState,
  NavPoint,
  NotificationKind,
  OptionChainParams,
  OrderPreview,
  OrderRequest,
  PlaceOrderResult,
  Position,
  PriceAlert,
  Quote,
  QuoteSubscription,
  Settings,
  SymbolMatch,
  UnlockResult,
  VerifyResult,
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
  /** The lock state changed (main is the only authority; the renderer just draws it). */
  | { type: 'lock'; state: LockState }
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
  | 'cancel-last-order'
  /** Sent by the menu's Lock item when no PIN exists yet: the renderer asks for one first. */
  | 'set-pin-and-lock';

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

  // Local cache ------------------------------------------------------------
  /** Size and contents of tape.db (bars, series, journaled executions). */
  getCacheStats(): Promise<CacheStats>;
  /**
   * Deletes the cached market data (bars, series, coverage, head timestamps, contract details,
   * option chain parameters) and returns the space to the file system. Executions and the NAV
   * history are kept.
   */
  clearMarketDataCache(): Promise<void>;

  // Orders -----------------------------------------------------------------
  placeOrder(req: OrderRequest): Promise<PlaceOrderResult>;
  modifyOrder(orderId: number, req: OrderRequest): Promise<void>;
  /**
   * IB's margin and commission estimate of an order (whatIf, the order without its bracket);
   * nothing is placed. IB asks for few of these: an identical request within 10 s gets the
   * previous answer.
   */
  previewOrder(req: OrderRequest): Promise<OrderPreview>;
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
  /** The test notification, or with a category a sample of that category's sound (Settings › Notifications). */
  testNotification(category?: SoundCategory): Promise<void>;

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

  // Lock screen ------------------------------------------------------------
  getLockState(): Promise<LockState>;
  /** Locks now. Refused when no PIN is set. */
  lock(): Promise<void>;
  unlockWithPin(pin: string): Promise<UnlockResult>;
  /** Shows the Touch ID / Windows Hello prompt (main decides the wording). */
  unlockWithBiometrics(): Promise<UnlockResult>;
  /** Checks the current PIN before a change or removal; failures count like unlock attempts. */
  verifyLockPin(pin: string): Promise<VerifyResult>;
  /** Checks the user with Touch ID / Windows Hello before a PIN change. */
  verifyLockBiometrics(): Promise<VerifyResult>;
  /** Sets the PIN (any 6 characters, see @shared/lock). A token from verifyLockPin / verifyLockBiometrics is required once a PIN exists. */
  setLockPin(pin: string, token: string | null): Promise<LockState>;
  /** Removes the PIN (turns the lock off). Needs a token from verifyLockPin. */
  removeLockPin(token: string): Promise<LockState>;
  /**
   * Forgot PIN: deletes all of Tape's local data except language and theme and restarts the app.
   * `confirmation` must be the word the user typed (RESET / 重置).
   */
  resetApp(confirmation: string): Promise<void>;

  /** Subscribes to push events. Returns an unsubscribe function. */
  onEvent(listener: (event: TapeEvent) => void): () => void;
}

/** Methods that are invoked over ipcRenderer.invoke (everything except onEvent). */
export type TapeInvokeMethod = Exclude<keyof TapeApi, 'onEvent'>;

/**
 * Which methods still work while Tape is locked. Every method must be listed, so a new one has to
 * be classified. Allowed: data feeds that mounted views keep using (and release on unmount),
 * read-only polls such as the cache size, the risk watcher's notifications and the lock itself. Everything a user would do (orders, settings,
 * watchlists, alerts, cache, logs, connecting) is refused by main with LOCKED_MESSAGE.
 */
export const LOCK_POLICY: Readonly<Record<TapeInvokeMethod, 'allow' | 'deny'>> = {
  getSnapshot: 'allow',
  updateSettings: 'deny',
  connect: 'deny',
  disconnect: 'deny',
  setQuoteSubscriptions: 'allow',
  getHistory: 'allow',
  getOlderBars: 'allow',
  searchSymbols: 'deny',
  getContractInfo: 'allow',
  setDepthSubscription: 'allow',
  getOptionChainParams: 'allow',
  getCacheStats: 'allow',
  clearMarketDataCache: 'deny',
  placeOrder: 'deny',
  modifyOrder: 'deny',
  // Sends a (what-if) order to IB like the other order calls, so it is refused while locked.
  previewOrder: 'deny',
  cancelOrder: 'deny',
  cancelAllOrders: 'deny',
  refreshExecutions: 'allow',
  saveWatchlists: 'deny',
  savePriceAlerts: 'deny',
  notify: 'allow',
  markNotificationsRead: 'deny',
  testNotification: 'deny',
  getApiLog: 'deny',
  setApiLogStreaming: 'allow',
  clearApiLog: 'deny',
  exportApiLog: 'deny',
  revealLogFile: 'deny',
  openExternal: 'deny',
  getLockState: 'allow',
  lock: 'allow',
  unlockWithPin: 'allow',
  unlockWithBiometrics: 'allow',
  verifyLockPin: 'deny',
  verifyLockBiometrics: 'deny',
  setLockPin: 'deny',
  removeLockPin: 'deny',
  resetApp: 'allow',
};

export const INVOKE_METHODS: readonly TapeInvokeMethod[] = Object.keys(LOCK_POLICY) as TapeInvokeMethod[];

/** Error message of every method refused while locked. */
export const LOCKED_MESSAGE = 'Tape is locked';

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
