// Renderer state. Two kinds of data live here:
// 1. Mirrors of main-process state (settings, connection, account, orders, quotes, …),
//    updated only by bridge.ts from snapshot + push events.
// 2. Cross-feature UI state (current page and instrument, the order ticket, dialogs).
// Feature-local UI state should stay in components or feature-local stores.

import { create } from 'zustand';
import { presetPrice } from '../features/alerts/model';
import { ticketTimingFor } from '../features/orders/model';
import { newCondition } from '../features/ticket/ticketConditions';
import { contractKey, stock } from '@shared/contract';
import { defaultSettings } from '@shared/defaults';
import { sessionOutsideRth } from '@shared/orderTiming';
import type { PanelId } from '../features/panels/model';
import type {
  AccountSummary,
  AlgoStrategy,
  ApiLogEntry,
  AppNotification,
  ConnectionState,
  ContractRef,
  DepthBook,
  Execution,
  LocalizedName,
  LockState,
  NavPoint,
  OcaType,
  OrderAction,
  OrderRequest,
  OrderType,
  Position,
  PriceAlert,
  Quote,
  SecType,
  Settings,
  StopOrderType,
  TimeInForce,
  TradingSession,
  TriggerMethod,
  Watchlist,
  WorkingOrder,
} from '@shared/types';

export type Page = 'acct' | 'trade' | 'ord' | 'set';
export type TradeView = 'chart' | 'opt' | 'depth';
/** 'view' is General (language, theme, colors); 'sec' is Privacy & Security. */
export type SettingsTab = 'view' | 'conn' | 'data' | 'trade' | 'notif' | 'sec' | 'keys' | 'log';
export type BellTab = 'alerts' | 'notifs';

/** Kinds of order condition the ticket offers (IB's six). */
export type TicketConditionKind = 'price' | 'time' | 'percentChange' | 'volume' | 'margin' | 'execution';

/** One row of the ticket's conditions editor; values are the raw input strings. */
export interface TicketCondition {
  /** Stable key of the row (React). */
  id: number;
  kind: TicketConditionKind;
  op: '>=' | '<=';
  /**
   * Price, percent change, volume or margin cushion as typed. For a price row watching the
   * ticket's reference instrument, null follows the market (±3%).
   */
  value: string | null;
  /** Watched instrument (price, % change, volume); null = the ticket's reference (the underlying for options). */
  contract: ContractRef | null;
  /** Price rows: IB's trigger method. */
  trigger: TriggerMethod;
  /** Time rows: a New York wall time, "2026-10-09T10:00"; null = the default (in an hour). */
  time: string | null;
  /** Execution rows: the symbol and security type whose trade triggers; '' = the ticket's instrument. */
  symbol: string;
  secType: SecType | null;
  /** How this row combines with the next one. */
  join: 'and' | 'or';
}

/** Collapsible sections of the ticket's Advanced panel. */
export type AdvancedSection = 'exits' | 'conditions' | 'fill' | 'trigger' | 'algo' | 'routing' | 'other';

/** Order ticket state shared by the ticket, depth view, command bar and "Modify". */
export interface TicketState {
  side: OrderAction;
  orderType: OrderType;
  qty: number;
  /**
   * null = follow the market (ask for buys, bid for sells). For MIDPRICE, REL and PEG MID this is
   * the optional price cap and null means no cap.
   */
  limitPrice: number | null;
  /** Stop / trigger price, or the initial stop of trailing orders; null = default offset from last (±1%). */
  stopPrice: number | null;
  /** TRAIL LIMIT / TRAIL LIT limit offset; null = default (0.2% of the stop). */
  limitOffset: number | null;
  /** REL, SNAP and PEG MID offset from the reference price; null = 0. */
  offset: number | null;
  /** REL: the offset is an amount or a percentage of the reference price. */
  offsetMode: 'amt' | 'pct';
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
  /** Open sections of the Advanced panel. */
  advSections: AdvancedSection[];
  bracket: boolean;
  /** Raw input strings; null = default (+3% / −2%). */
  takeProfit: string | null;
  stopLoss: string | null;
  /** Stop-loss order type of the bracket and its extra values (raw strings; null = default). */
  slType: StopOrderType;
  slLimit: string | null;
  slTrailMode: 'pct' | 'amt';
  slTrail: string;
  slOffset: string | null;
  /** Adjustable stop (of the bracket's stop-loss, or of the order itself when it is a stop). */
  adjust: boolean;
  adjTrigger: string | null;
  adjType: 'STP' | 'STP LMT' | 'TRAIL';
  adjStop: string | null;
  adjLimit: string | null;
  adjTrail: string;
  adjTrailUnit: 'amount' | 'percent';
  trailMode: 'pct' | 'amt';
  trailAmt: string;
  /** Conditions are on (the rows are in `conds`). */
  condition: boolean;
  conds: TicketCondition[];
  /** Cancel the order when the conditions are met instead of submitting it. */
  condCancel: boolean;
  condRth: boolean;
  iceberg: boolean;
  iceQty: string;
  /** Fill attributes. */
  allOrNone: boolean;
  minQtyOn: boolean;
  minQty: string;
  hidden: boolean;
  sweep: boolean;
  disc: boolean;
  discAmt: string;
  /** Forex: size the order by an amount of the quote currency. */
  cashQtyOn: boolean;
  cashQty: string;
  triggerMethod: TriggerMethod;
  /** IB algo and its parameters as typed (fractions as percentages, times as "HH:MM" New York). */
  algo: AlgoStrategy | null;
  algoParams: Record<string, string | boolean>;
  oca: boolean;
  ocaGroup: string;
  ocaType: OcaType;
  /** Destination: 'SMART' or a directed exchange. */
  route: string;
  /** Free-text note (IB's order reference). */
  orderRef: string;
  goodAfter: boolean;
  goodAfterTime: string;
  /** When set, submitting modifies this order instead of placing a new one. */
  modifyingOrderId: number | null;
}

export interface ConfirmRow {
  label: string;
  value: string;
  color?: string;
  /** The value is " · "-separated parts that wrap between parts only ("Start 9:45 AM ET" stays whole). */
  parts?: boolean;
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
  /**
   * The floating panel the order is sent from (features/panels): its status strip and bar report
   * it instead of toasts. Undefined from anywhere else (the docked ticket too).
   */
  origin?: PanelId;
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
    limitOffset: null,
    offset: null,
    offsetMode: 'amt',
    advancedOpen: false,
    advSections: [],
    bracket: false,
    takeProfit: null,
    stopLoss: null,
    slType: 'STP',
    slLimit: null,
    slTrailMode: 'pct',
    slTrail: '2',
    slOffset: null,
    adjust: false,
    adjTrigger: null,
    adjType: 'STP',
    adjStop: null,
    adjLimit: null,
    adjTrail: '1',
    adjTrailUnit: 'percent',
    trailMode: 'pct',
    trailAmt: '3',
    condition: false,
    conds: [newCondition()],
    condCancel: false,
    condRth: false,
    iceberg: false,
    iceQty: '100',
    allOrNone: false,
    minQtyOn: false,
    minQty: '1',
    hidden: false,
    sweep: false,
    disc: false,
    discAmt: '0.05',
    cashQtyOn: false,
    cashQty: '10000',
    triggerMethod: 0,
    algo: null,
    algoParams: {},
    oca: false,
    ocaGroup: '',
    ocaType: 1,
    route: 'SMART',
    orderRef: '',
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
      ticket: {
        ...s.ticket,
        limitPrice: null,
        stopPrice: null,
        limitOffset: null,
        takeProfit: null,
        stopLoss: null,
        slLimit: null,
        slOffset: null,
        adjTrigger: null,
        adjStop: null,
        adjLimit: null,
        // Price rows that follow the reference instrument follow the new one; a directed route
        // may not exist for it.
        conds: s.ticket.conds.map((c) => (c.kind === 'price' && c.contract == null ? { ...c, value: null } : c)),
        route: 'SMART',
        modifyingOrderId: null,
      },
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
