// Renderer state. Two kinds of data live here:
// 1. Mirrors of main-process state (settings, connection, account, orders, quotes, …),
//    updated only by bridge.ts from snapshot + push events.
// 2. Cross-feature UI state (current page and instrument, the order ticket, dialogs).
// Feature-local UI state should stay in components or feature-local stores.

import { create } from 'zustand';
import { presetPrice } from '../features/alerts/model';
import { ticketTimingFor } from '../features/orders/model';
import { newCondition } from '../features/ticket/ticketConditions';
import { ofConnectedAccounts } from '../lib/orders';
import { contractKey, sameContract, stock } from '@shared/contract';
import { defaultSettings } from '@shared/defaults';
import { sessionOutsideRth } from '@shared/orderTiming';
import type { PanelId } from '../features/panels/model';
import type { MarketDataQuality, OrderRisk } from '../features/ticket/orderRisk';
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
  MarketDataCheckState,
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

/** Portfolio (with its Positions, Orders and Trades tabs: features/portfolio/uiState.ts), Trade, Settings. */
export type Page = 'acct' | 'trade' | 'set';
/** The Trade page's views (pages/tradeViews.ts); Level 2 is the order ticket's Book. */
export type TradeView = 'chart' | 'opt';
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

/** Order ticket state shared by the ticket, its Book, the command bar and "Modify". */
export interface TicketState {
  side: OrderAction;
  orderType: OrderType;
  qty: number;
  /**
   * null = follow the market (ask for buys, bid for sells). For MIDPRICE, REL and PEG MID this is
   * the optional price cap and null means no cap.
   */
  limitPrice: number | null;
  /**
   * The limit price was taken from the quote (a bid / ask box or chip, a Book level), not typed: on
   * prices that are not live the review treats it like one that follows the bid / ask. Any other
   * change of the limit price clears it (normalizeTicketPatch).
   */
  limitFromQuote: boolean;
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
  /** The value is " · "-separated parts that wrap between parts only ("Start 09:45 AM ET" stays whole). */
  parts?: boolean;
  /** A modify's review: the value changes ("100 → 200"); the row is highlighted. */
  changed?: boolean;
  /** The value is a sentence (a warning), set in the text font rather than the figures'. */
  prose?: boolean;
}

/** Generic confirmation dialog ("act" in the design). */
export interface ConfirmRequest {
  title: string;
  rows: ConfirmRow[];
  note?: string;
  /** Red lines under the rows: what the action costs or why it may fail (a stop-loss left unprotected, Read-Only API on). */
  warnings?: string[];
  label: string;
  danger?: boolean;
  /**
   * The connection session (ConnectionState.session) the dialog acts on, for one that sends to IB
   * (a cancel): it closes when Tape moves to another account or Gateway. Generic confirmations
   * (watchlists, settings) leave it out and stay.
   */
  session?: number;
  /** The action. Without it the dialog only informs: its one button (`label`) closes it. */
  run?: () => void | Promise<void>;
}

/** The Cancel all dialog (layout/Dialogs.tsx → CancelAllDialog), bound to the session it was opened on. */
export interface CancelAllRequest {
  session: number;
}

/**
 * The order review (layout/Dialogs.tsx → OrderConfirmDialog). Every order, modify and strategy goes
 * through it: only its Confirm sends (state/orderActions.ts).
 */
export interface PendingOrder {
  request: OrderRequest;
  rows: ConfirmRow[];
  /** Button label after "Confirm", e.g. "Buy" / "Sell". */
  label: string;
  /** Modify an existing order instead of placing a new one. */
  modifyOrderId?: number;
  /** A modify that changes nothing: the review says so, and its Confirm never arms. */
  unchanged?: boolean;
  /** Description used in the success toast, e.g. "Buy 100 AAPL". */
  summary: string;
  /**
   * The connection session (ConnectionState.session) the order was built and reviewed on
   * (submitOrder fills it in): sendOrder and main refuse it once Tape has moved to another
   * account or Gateway, and the review closes then.
   */
  session: number;
  /**
   * The account the order goes to and whether it is a paper account, as connected when it was
   * submitted (submitOrder fills them in): the review's first row and its PAPER / LIVE tag.
   */
  account?: string;
  isPaper: boolean;
  /**
   * How current the prices behind the order are (features/ticket/orderRisk.ts): anything but live
   * is a red row of the review. Undefined when the sender does not know.
   */
  marketData?: MarketDataQuality;
  /** The pre-trade checks' findings: red rows, which the user acknowledges before Confirm arms. */
  risks?: OrderRisk[];
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
  /** 'warning': not a failure, but not the success either (sent, IB has not confirmed it yet). */
  tone: 'info' | 'warning' | 'error';
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
  /**
   * IB has listed the account's positions since the last handshake (positionEnd): until then an
   * instrument missing from `positions` may still be held (the order review's checks say so).
   */
  positionsLoaded: boolean;
  orders: WorkingOrder[];
  executions: Execution[];
  quotes: Record<string, Quote>;
  depth: DepthBook | null;
  /** The last market data check (main keeps and persists it) and whether one runs now. */
  marketDataCheck: MarketDataCheckState;
  apiLog: ApiLogEntry[];
  notifications: AppNotification[];
  watchlists: Watchlist[];
  priceAlerts: PriceAlert[];
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
  cancelAll: CancelAllRequest | null;
  /**
   * Cancels sent from here that IB has not confirmed yet (lib/orders.ts → cancelKey): their rows show
   * "Cancelling…" instead of Cancel, so a second click sends nothing (state/orderActions.ts).
   */
  pendingCancels: string[];
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
  /**
   * Selects an instrument for the Trade page. The ticket drops its price overrides; another
   * instrument also starts at its default size and Buy (a stock's 100 must not become 100 option
   * contracts, a sell must not open a short), and a modify in progress ends with a fresh ticket.
   */
  selectSymbol(contract: ContractRef, name?: LocalizedName): void;
  /** Selects an instrument and switches to the Trade page (optionally a view). */
  openSymbol(contract: ContractRef, view?: TradeView, name?: LocalizedName): void;
  openSettings(tab?: SettingsTab): void;
  setBell(open: boolean, tab?: BellTab): void;
  setWatchlistCollapsed(collapsed: boolean): void;
  patchTicket(patch: Partial<TicketState>): void;
  resetTicket(): void;
  /**
   * Ends modifying an order (it was sent, or "Cancel modify"): the ticket starts fresh for the
   * instrument, so nothing loaded from that order (side, size, OCA group, conditions, algo, note…)
   * carries over to a new order. `orderId`: only while that order is still the one being modified
   * (another Modify started meanwhile stays).
   */
  endModify(orderId?: number): void;
  ask(req: ConfirmRequest): void;
  closeConfirm(): void;
  setCancelAll(req: CancelAllRequest | null): void;
  setCancelPending(key: string, pending: boolean): void;
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
  // A limit price set without saying it came from the quote was typed (or cleared).
  if ('limitPrice' in patch && patch.limitFromQuote == null) patch = { ...patch, limitFromQuote: false };
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
  const o = ofConnectedAccounts(s.orders, s.connection.accounts).find((x) => x.orderId === patch.modifyingOrderId && x.clientId === s.connection.clientId);
  return o ? { ...patch, ...ticketTimingFor(o) } : patch;
}

/** Instruments traded by the contract (options, futures, warrants, combos): their orders start at 1. */
const CONTRACT_SIZED: readonly SecType[] = ['OPT', 'FOP', 'FUT', 'WAR', 'BAG'];

/**
 * The size a new order on `contract` starts at: 1 contract for options, futures, warrants and
 * combos (each is a multiple of the underlying), else Settings › Trade's default order size.
 */
export function defaultQtyFor(contract: Pick<ContractRef, 'secType'>, settings: Pick<Settings, 'trading'>): number {
  return CONTRACT_SIZED.includes(contract.secType) ? 1 : settings.trading.defaultQty;
}

/**
 * Settings › Trade's new defaults (size, extended hours) for the open ticket: only what the user
 * has left at the previous default changes, never a size or session typed or chosen on the ticket,
 * nor an order being modified.
 */
export function tradeDefaultsPatch(
  s: Pick<StoreState, 'ticket' | 'symbol'>,
  prev: Pick<Settings, 'trading'>,
  next: Pick<Settings, 'trading'>,
): Partial<TicketState> {
  if (s.ticket.modifyingOrderId != null) return {};
  const qty = defaultQtyFor(s.symbol, next);
  const session = defaultSession(next);
  return {
    ...(s.ticket.qty === defaultQtyFor(s.symbol, prev) && qty !== s.ticket.qty ? { qty } : {}),
    ...(s.ticket.session === defaultSession(prev) && session !== s.ticket.session ? { session } : {}),
  };
}

/** A fresh ticket; for `contract`, at its default size (defaultQtyFor). */
export function initialTicket(settings: Settings, contract?: Pick<ContractRef, 'secType'>): TicketState {
  const session = defaultSession(settings);
  return {
    side: 'BUY',
    orderType: 'LMT',
    qty: contract ? defaultQtyFor(contract, settings) : settings.trading.defaultQty,
    limitPrice: null,
    limitFromQuote: false,
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
  connection: { status: 'disconnected', host: '127.0.0.1', port: 4002, clientId: 7, session: 0, accounts: [], isPaper: false, farms: {} },
  account: null,
  positions: [],
  positionsLoaded: false,
  orders: [],
  executions: [],
  quotes: {},
  depth: null,
  marketDataCheck: { result: null, running: false },
  apiLog: [],
  notifications: [],
  watchlists: [],
  priceAlerts: [],
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
  cancelAll: null,
  pendingCancels: [],
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
      // A modify ends: nothing of that order carries over (Modify loads the order after this).
      ticket: s.ticket.modifyingOrderId != null ? initialTicket(s.settings, contract) : selectedTicket(s.ticket, contract, s.symbol, s.settings),
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
  resetTicket: () => set((s) => ({ ticket: initialTicket(s.settings, s.symbol) })),
  endModify: (orderId) =>
    set((s) => {
      const id = s.ticket.modifyingOrderId;
      if (id == null || (orderId != null && id !== orderId)) return s;
      return { ticket: initialTicket(s.settings, s.symbol) };
    }),
  ask: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),
  setCancelAll: (cancelAll) => set({ cancelAll }),
  setCancelPending: (key, pending) =>
    set((s) => {
      const has = s.pendingCancels.includes(key);
      if (has === pending) return s;
      return { pendingCancels: pending ? [...s.pendingCancels, key] : s.pendingCancels.filter((k) => k !== key) };
    }),
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

/**
 * The ticket for a newly selected instrument (not while modifying): the prices typed for the
 * previous one go. Another instrument also starts at its default size and Buy; reselecting the same
 * one keeps what the user set up.
 */
function selectedTicket(t: TicketState, contract: ContractRef, prev: ContractRef, settings: Settings): TicketState {
  const other = !sameContract(contract, prev);
  return {
    ...t,
    ...(other ? { qty: defaultQtyFor(contract, settings), side: 'BUY' as const } : {}),
    limitPrice: null,
    limitFromQuote: false,
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
    conds: t.conds.map((c) => (c.kind === 'price' && c.contract == null ? { ...c, value: null } : c)),
    route: 'SMART',
    modifyingOrderId: null,
  };
}

/** Whether the lock screen covers the app (locked, or still animating the unlock). */
export const isCovered = (s: Pick<StoreState, 'lock' | 'unlocking'>): boolean => s.lock.locked || s.unlocking;

/**
 * Whether a dialog holds the screen: the order review, a confirmation, Cancel all, the alert
 * dialog or the PIN dialog. App commands (App.tsx) and the trading keys (the ticket's, the floating
 * panels') wait meanwhile: the dialog has the keys.
 */
export const isDialogOpen = (s: Pick<StoreState, 'pendingOrder' | 'confirm' | 'cancelAll' | 'alertForm' | 'pinDialog'>): boolean =>
  !!(s.pendingOrder || s.confirm || s.cancelAll || s.alertForm || s.pinDialog);
