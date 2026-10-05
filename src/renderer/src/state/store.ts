// Renderer state. Two kinds of data live here:
// 1. Mirrors of main-process state (settings, connection, account, orders, quotes, …),
//    updated only by bridge.ts from snapshot + push events.
// 2. Cross-feature UI state (current page and instrument, the order ticket, dialogs).
// Feature-local UI state should stay in components or feature-local stores.

import { create } from 'zustand';
import { presetPrice } from '../features/alerts/model';
import { ticketTimingFor } from '../features/orders/model';
import { contractKey, stock } from '@shared/contract';
import { defaultSettings } from '@shared/defaults';
import { sessionOutsideRth } from '@shared/orderTiming';
import type {
  AccountSummary,
  ApiLogEntry,
  AppNotification,
  ConnectionState,
  ContractRef,
  DepthBook,
  Execution,
  LocalizedName,
  LockState,
  NavPoint,
  OrderAction,
  OrderRequest,
  OrderType,
  Position,
  PriceAlert,
  Quote,
  Settings,
  TimeInForce,
  TradingSession,
  Watchlist,
  WorkingOrder,
} from '@shared/types';

export type Page = 'acct' | 'trade' | 'ord' | 'set';
export type TradeView = 'chart' | 'opt' | 'depth';
/** 'view' is General (language, theme, colors); 'sec' is Privacy & Security. */
export type SettingsTab = 'view' | 'conn' | 'data' | 'trade' | 'notif' | 'sec' | 'keys' | 'log';
export type BellTab = 'alerts' | 'notifs';

/** Order ticket state shared by the ticket, depth view, command bar and "Modify". */
export interface TicketState {
  side: OrderAction;
  orderType: OrderType;
  qty: number;
  /** null = follow the market (ask for buys, bid for sells). */
  limitPrice: number | null;
  /** null = default offset from last (±1%). */
  stopPrice: number | null;
  tif: TimeInForce;
  /** GTD expiry as a New York wall time, "2026-10-09T16:00"; null = the next session close. */
  goodTill: string | null;
  session: TradingSession;
  /**
   * Mirror of `session` for callers that predate it: true for sessions with pre-market and
   * after-hours. patchTicket keeps it in sync; patching only it picks 'extended' or 'regular'.
   */
  outsideRth: boolean;
  advancedOpen: boolean;
  bracket: boolean;
  /** Raw input strings; null = default (+3% / −2%). */
  takeProfit: string | null;
  stopLoss: string | null;
  trailMode: 'pct' | 'amt';
  trailAmt: string;
  condition: boolean;
  condOp: '>=' | '<=';
  condPx: string | null;
  condRth: boolean;
  iceberg: boolean;
  iceQty: string;
  goodAfter: boolean;
  goodAfterTime: string;
  /** When set, submitting modifies this order instead of placing a new one. */
  modifyingOrderId: number | null;
}

export interface ConfirmRow {
  label: string;
  value: string;
  color?: string;
}

/** Generic confirmation dialog ("act" in the design). */
export interface ConfirmRequest {
  title: string;
  rows: ConfirmRow[];
  note?: string;
  label: string;
  danger?: boolean;
  run: () => void | Promise<void>;
}

/** Order review dialog shown before sending when Settings › Trade › Confirm is on. */
export interface PendingOrder {
  request: OrderRequest;
  rows: ConfirmRow[];
  /** Button label after "Confirm", e.g. "Buy" / "Sell". */
  label: string;
  /** Modify an existing order instead of placing a new one. */
  modifyOrderId?: number;
  /** Description used in the success toast, e.g. "Buy 100 AAPL". */
  summary: string;
}

export interface AlertFormState {
  contract: ContractRef;
  condition: 'above' | 'below';
  price: string;
  repeat: boolean;
}

/** Set, change or remove the lock PIN. `lockAfter`: lock once a new PIN is saved (lock button, ⌘L). */
export interface PinDialogRequest {
  mode: 'set' | 'change' | 'remove';
  lockAfter?: boolean;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

interface DataState {
  ready: boolean;
  demo: boolean;
  platform: string;
  appVersion: string;
  logFilePath: string;
  settings: Settings;
  connection: ConnectionState;
  account: AccountSummary | null;
  positions: Position[];
  orders: WorkingOrder[];
  executions: Execution[];
  quotes: Record<string, Quote>;
  depth: DepthBook | null;
  apiLog: ApiLogEntry[];
  notifications: AppNotification[];
  watchlists: Watchlist[];
  priceAlerts: PriceAlert[];
  nav: NavPoint[];
  /** Mirror of main's lock state (main is the only authority). */
  lock: LockState;
}

interface UiState {
  page: Page;
  view: TradeView;
  /** The instrument shown on the Trade page and in the ticket. */
  symbol: ContractRef;
  /** Display name of the current instrument (company name), when known. */
  symbolName: LocalizedName | undefined;
  settingsTab: SettingsTab;
  bellOpen: boolean;
  bellTab: BellTab;
  watchlistCollapsed: boolean;
  ticket: TicketState;
  pendingOrder: PendingOrder | null;
  confirm: ConfirmRequest | null;
  alertForm: AlertFormState | null;
  toast: Toast | null;
  /** Incremented to ask the symbol search to take focus (⌘K). */
  searchFocus: number;
  pinDialog: PinDialogRequest | null;
  /**
   * The lock screen is playing its unlock animation (or waiting for main's answer): it stays up,
   * and the app stays inert, although main may already report unlocked.
   */
  unlocking: boolean;
  /** Incremented each time Tape locks: a lock that arrives during the unlock animation starts a fresh lock screen. */
  lockSeq: number;
  /**
   * Touch ID / Windows Hello was available at some point this session. Only then does the lock screen
   * say it is unavailable (a Mac without Touch ID shows the PIN entry alone).
   */
  biometricsSeen: boolean;
}

interface Actions {
  setPage(page: Page): void;
  setView(view: TradeView): void;
  /** Selects an instrument for the Trade page; resets price overrides in the ticket. */
  selectSymbol(contract: ContractRef, name?: LocalizedName): void;
  /** Selects an instrument and switches to the Trade page (optionally a view). */
  openSymbol(contract: ContractRef, view?: TradeView, name?: LocalizedName): void;
  openSettings(tab?: SettingsTab): void;
  setBell(open: boolean, tab?: BellTab): void;
  setWatchlistCollapsed(collapsed: boolean): void;
  patchTicket(patch: Partial<TicketState>): void;
  resetTicket(): void;
  ask(req: ConfirmRequest): void;
  closeConfirm(): void;
  setPendingOrder(p: PendingOrder | null): void;
  openAlertForm(contract: ContractRef): void;
  setAlertForm(form: AlertFormState | null): void;
  showToast(text: string, tone?: Toast['tone']): void;
  focusSearch(): void;
  setPinDialog(req: PinDialogRequest | null): void;
  setUnlocking(unlocking: boolean): void;
}

export type StoreState = DataState & UiState & Actions;

/** The session new orders start in (Settings › Trade › outside RTH by default). */
export const defaultSession = (settings: Pick<Settings, 'trading'>): TradingSession => (settings.trading.outsideRthDefault ? 'extended' : 'regular');

/** Keeps `session` and its `outsideRth` mirror consistent (see TicketState.outsideRth). */
export function normalizeTicketPatch(patch: Partial<TicketState>): Partial<TicketState> {
  if (patch.session) return { ...patch, outsideRth: sessionOutsideRth(patch.session) };
  if (patch.outsideRth != null) return { ...patch, session: patch.outsideRth ? 'extended' : 'regular' };
  return patch;
}

/**
 * A patch that starts modifying an order (sets modifyingOrderId) takes that order's TIF, GTD
 * expiry and session, whatever its caller filled in: IB refuses to change most of them (462).
 */
export function withModifiedTiming(patch: Partial<TicketState>, s: Pick<StoreState, 'orders' | 'connection'>): Partial<TicketState> {
  if (patch.modifyingOrderId == null) return patch;
  const o = s.orders.find((x) => x.orderId === patch.modifyingOrderId && x.clientId === s.connection.clientId);
  return o ? { ...patch, ...ticketTimingFor(o) } : patch;
}

export function initialTicket(settings: Settings): TicketState {
  const session = defaultSession(settings);
  return {
    side: 'BUY',
    orderType: 'LMT',
    qty: settings.trading.defaultQty,
    limitPrice: null,
    stopPrice: null,
    tif: 'DAY',
    goodTill: null,
    session,
    outsideRth: sessionOutsideRth(session),
    advancedOpen: false,
    bracket: false,
    takeProfit: null,
    stopLoss: null,
    trailMode: 'pct',
    trailAmt: '3',
    condition: false,
    condOp: '>=',
    condPx: null,
    condRth: false,
    iceberg: false,
    iceQty: '100',
    goodAfter: false,
    goodAfterTime: '09:35',
    modifyingOrderId: null,
  };
}

const settings0 = defaultSettings('en', typeof window !== 'undefined' ? (window.tapePlatform ?? 'darwin') : 'darwin');

let toastSeq = 1;

const COLLAPSED_KEY = 'tape.watchlistCollapsed';
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export const useStore = create<StoreState>()((set, get) => ({
  // data
  ready: false,
  demo: false,
  platform: typeof window !== 'undefined' ? (window.tapePlatform ?? 'darwin') : 'darwin',
  appVersion: '',
  logFilePath: '',
  settings: settings0,
  connection: { status: 'disconnected', host: '127.0.0.1', port: 4002, clientId: 7, accounts: [], isPaper: false, farms: {} },
  account: null,
  positions: [],
  orders: [],
  executions: [],
  quotes: {},
  depth: null,
  apiLog: [],
  notifications: [],
  watchlists: [],
  priceAlerts: [],
  nav: [],
  lock: { hasPin: false, locked: false, biometrics: { kind: null, available: false }, failures: 0, retryAt: null },

  // ui
  page: 'trade',
  view: 'chart',
  symbol: stock('AAPL'),
  symbolName: 'Apple',
  settingsTab: 'view',
  bellOpen: false,
  bellTab: 'notifs',
  watchlistCollapsed: readCollapsed(),
  ticket: initialTicket(settings0),
  pendingOrder: null,
  confirm: null,
  alertForm: null,
  toast: null,
  searchFocus: 0,
  pinDialog: null,
  unlocking: false,
  lockSeq: 0,
  biometricsSeen: false,

  // actions
  setPage: (page) => set({ page, bellOpen: false }),
  setView: (view) => set({ view }),
  selectSymbol: (contract, name) =>
    set((s) => ({
      symbol: contract,
      symbolName: name,
      ticket: { ...s.ticket, limitPrice: null, stopPrice: null, takeProfit: null, stopLoss: null, condPx: null, modifyingOrderId: null },
    })),
  openSymbol: (contract, view, name) => {
    // Keep the known name only when the same instrument is reopened.
    const same = contractKey(contract) === contractKey(get().symbol);
    get().selectSymbol(contract, name ?? (same ? get().symbolName : undefined));
    set({ page: 'trade', bellOpen: false, ...(view ? { view } : {}) });
  },
  openSettings: (tab) => set((s) => ({ page: 'set', bellOpen: false, settingsTab: tab ?? s.settingsTab })),
  setBell: (open, tab) => set((s) => ({ bellOpen: open, bellTab: tab ?? s.bellTab })),
  setWatchlistCollapsed: (watchlistCollapsed) => {
    try {
      localStorage.setItem(COLLAPSED_KEY, watchlistCollapsed ? '1' : '0');
    } catch {
      // Storage unavailable: the preference just does not persist.
    }
    set({ watchlistCollapsed });
  },
  patchTicket: (patch) => set((s) => ({ ticket: { ...s.ticket, ...normalizeTicketPatch(withModifiedTiming(patch, s)) } })),
  resetTicket: () => set((s) => ({ ticket: initialTicket(s.settings) })),
  ask: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),
  setPendingOrder: (pendingOrder) => set({ pendingOrder }),
  openAlertForm: (contract) => {
    const q = get().quotes[contractKey(contract)];
    const last = q ? (q.last ?? q.close) : undefined;
    set({
      alertForm: { contract, condition: 'above', price: last ? presetPrice(last, 2) : '', repeat: false },
      bellOpen: false,
    });
  },
  setAlertForm: (alertForm) => set({ alertForm }),
  showToast: (text, tone = 'info') => set({ toast: { id: toastSeq++, text, tone } }),
  focusSearch: () => set((s) => ({ searchFocus: s.searchFocus + 1 })),
  setPinDialog: (pinDialog) => set({ pinDialog }),
  setUnlocking: (unlocking) => set({ unlocking }),
}));

/** Whether the lock screen covers the app (locked, or still animating the unlock). */
export const isCovered = (s: Pick<StoreState, 'lock' | 'unlocking'>): boolean => s.lock.locked || s.unlocking;
