// Renderer state. Two kinds of data live here:
// 1. Mirrors of main-process state (settings, connection, account, orders, quotes, …),
//    updated only by bridge.ts from snapshot + push events.
// 2. Cross-feature UI state (current page and instrument, the order ticket, dialogs).
// Feature-local UI state should stay in components or feature-local stores.

import { create } from 'zustand';
import { presetPrice } from '../features/alerts/model';
import { contractKey, stock } from '@shared/contract';
import { defaultSettings } from '@shared/defaults';
import type {
  AccountSummary,
  ApiLogEntry,
  AppNotification,
  ConnectionState,
  ContractRef,
  DepthBook,
  Execution,
  LocalizedName,
  NavPoint,
  OrderAction,
  OrderRequest,
  OrderType,
  Position,
  PriceAlert,
  Quote,
  Settings,
  TimeInForce,
  Watchlist,
  WorkingOrder,
} from '@shared/types';

export type Page = 'acct' | 'trade' | 'ord' | 'set';
export type TradeView = 'chart' | 'opt' | 'depth';
export type SettingsTab = 'conn' | 'data' | 'trade' | 'notif' | 'view' | 'log' | 'keys';
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
}

export type StoreState = DataState & UiState & Actions;

export function initialTicket(settings: Settings): TicketState {
  return {
    side: 'BUY',
    orderType: 'LMT',
    qty: settings.trading.defaultQty,
    limitPrice: null,
    stopPrice: null,
    tif: 'DAY',
    outsideRth: settings.trading.outsideRthDefault,
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

const settings0 = defaultSettings();

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

  // ui
  page: 'trade',
  view: 'chart',
  symbol: stock('AAPL'),
  symbolName: 'Apple',
  settingsTab: 'conn',
  bellOpen: false,
  bellTab: 'notifs',
  watchlistCollapsed: readCollapsed(),
  ticket: initialTicket(settings0),
  pendingOrder: null,
  confirm: null,
  alertForm: null,
  toast: null,
  searchFocus: 0,

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
  patchTicket: (patch) => set((s) => ({ ticket: { ...s.ticket, ...patch } })),
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
}));
