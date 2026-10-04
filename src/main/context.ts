// Service interfaces of the main process and the shared context that wires them.
//
// Each service lives in its own module and exposes a `createXxx(ctx)` factory. Services
// must not call other services from inside their factory: the context is filled in
// sequence by index.ts, so cross-service access happens lazily (at call/event time).

import type { BrowserWindow } from 'electron';
import type { IBApi } from './ib/tws';
import type { NewNotification, TapeEvent } from '@shared/ipc';
import type {
  AccountSummary,
  ApiLogEntry,
  AppNotification,
  Bar,
  ConnectionState,
  ContractInfo,
  ContractRef,
  DeepPartial,
  Execution,
  HistoryRequest,
  NavPoint,
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
} from '@shared/types';

import type { Database } from './db/types';

export type Unsubscribe = () => void;
// IB callbacks have heterogeneous signatures; listeners annotate their own parameters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IbListener = (...args: any[]) => void;

/** Persistent application data (JSON files in userData). */
export interface AppStore {
  getSettings(): Settings;
  /** Deep-merges, validates, persists and notifies listeners. Returns the new settings. */
  updateSettings(patch: DeepPartial<Settings>): Settings;
  onSettingsChanged(listener: (next: Settings, prev: Settings) => void): Unsubscribe;
  getWatchlists(): Watchlist[];
  setWatchlists(lists: Watchlist[]): void;
  getPriceAlerts(): PriceAlert[];
  setPriceAlerts(alerts: PriceAlert[]): void;
  getNotifications(): AppNotification[];
  setNotifications(list: AppNotification[]): void;
  getNav(): NavPoint[];
  setNav(points: NavPoint[]): void;
  getWindowBounds(): { x?: number; y?: number; width: number; height: number; maximized?: boolean } | null;
  setWindowBounds(b: { x?: number; y?: number; width: number; height: number; maximized?: boolean }): void;
  /** Writes pending changes synchronously (called on quit). */
  flush(): void;
}

/** Owns the IBApi instance, the handshake, reconnects and request id allocation. */
export interface IbConnection {
  /** The live IBApi instance, or null when not connected. */
  readonly api: IBApi | null;
  getState(): ConnectionState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /** Unique id for reqMktData / reqHistoricalData / reqContractDetails etc. */
  nextReqId(): number;
  /** Next order id (seeded by nextValidId and incremented locally). */
  nextOrderId(): number;
  /**
   * Listens to an IBApi event. Listeners survive reconnects and IBApi instance swaps
   * (a new instance is created when host/port/clientId change).
   */
  on(event: string, listener: IbListener): Unsubscribe;
  /** Called after every successful handshake (nextValidId received). Re-issue subscriptions here. */
  onReady(listener: (api: IBApi) => void): Unsubscribe;
  /** Called when the socket closes for any reason. */
  onClosed(listener: () => void): Unsubscribe;
  /** Errors that carry a request/order id (reqId >= 0). Info codes (2104 etc.) are not routed here. */
  onRequestError(listener: (e: { reqId: number; code: number; message: string; advancedOrderReject?: string }) => void): Unsubscribe;
}

export interface ApiLog {
  getEntries(): ApiLogEntry[];
  /** Live entries are pushed to renderers only while at least one view streams them (API log page). */
  setStreaming(on: boolean): void;
  clear(): void;
  /** Writes the in-memory log as text. */
  exportTo(path: string): Promise<void>;
  /** Today's log file path (may not exist yet). */
  filePath(): string;
  /** Records a synthetic entry (e.g. "socket close" from the client side). */
  note(dir: 'out' | 'in', name: string, fields: Array<[string, string]>, err?: boolean): void;
}

export interface Notifier {
  /** Adds to the in-app list and, depending on settings, shows an OS notification. */
  notify(n: NewNotification): AppNotification;
  markRead(ids: string[] | 'all'): void;
  test(): void;
}

export interface ContractService {
  /** Cached contract details; null when IB returns no definition. */
  getInfo(c: ContractRef): Promise<ContractInfo | null>;
  /** Returns the contract with conId (and primary exchange etc.) filled in. Throws if unknown. */
  resolve(c: ContractRef): Promise<ContractRef>;
  search(pattern: string): Promise<SymbolMatch[]>;
}

export interface QuoteService {
  setSubscriptions(owner: string, subs: QuoteSubscription[]): void;
  getQuote(key: string): Quote | undefined;
  /** Fires for every applied quote change (after merging), before batching to the renderer. */
  onQuote(listener: (q: Quote) => void): Unsubscribe;
}

export interface HistoryService {
  get(req: HistoryRequest): Promise<Bar[]>;
}

export interface DepthService {
  set(contract: ContractRef | null): Promise<void>;
}

export interface OptionsService {
  getChainParams(underlying: ContractRef): Promise<OptionChainParams[]>;
}

/** Evaluates price alerts against live quotes and keeps their instruments subscribed. */
export interface AlertService {
  save(alerts: PriceAlert[]): void;
}

export interface AccountService {
  getSummary(): AccountSummary | null;
  getPositions(): Position[];
}

export interface OrderService {
  getOrders(): WorkingOrder[];
  getExecutions(): Execution[];
  place(req: OrderRequest): Promise<PlaceOrderResult>;
  modify(orderId: number, req: OrderRequest): Promise<void>;
  cancel(orderId: number): Promise<void>;
  cancelAll(): Promise<void>;
  refreshExecutions(): Promise<void>;
}

/** Theme, dock/window icon and native theme handling. */
export interface Appearance {
  /** True when the resolved theme is dark. */
  isDark(): boolean;
  /** Applies the theme to a window (background color, icon on Windows/Linux). */
  attach(win: BrowserWindow): void;
}

export interface MainContext {
  /** Market data comes from the built-in simulator (TAPE_DEMO=1). */
  readonly demo: boolean;
  readonly isDev: boolean;
  /** Sends an event to every renderer. */
  emit(event: TapeEvent): void;
  getMainWindow(): BrowserWindow | null;
  /** Focuses (and restores) the main window. */
  showMainWindow(): void;

  store: AppStore;
  /** Persistent caches (SQLite in a worker thread; memory fallback). */
  db: Database;
  apiLog: ApiLog;
  ib: IbConnection;
  notifier: Notifier;
  contracts: ContractService;
  quotes: QuoteService;
  history: HistoryService;
  depth: DepthService;
  options: OptionsService;
  alerts: AlertService;
  account: AccountService;
  orders: OrderService;
  appearance: Appearance;
}
