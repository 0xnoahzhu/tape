// Domain models shared by the main process and the renderer.
// Everything here must stay serializable (structured clone) because it crosses IPC.

export type SecType = 'STK' | 'OPT' | 'IND' | 'FUT' | 'FOP' | 'CASH' | 'BAG' | 'CFD' | 'BOND' | 'WAR' | 'CRYPTO';
export type OptionRight = 'C' | 'P';
export type Lang = 'en' | 'zh';
/** Text that is generated in the main process and shown in either language. */
export type LocalizedText = { en: string; zh: string };
/** User-defined names are plain strings; built-in names are localized. */
export type LocalizedName = string | LocalizedText;

/** Identifies an instrument. `conId` is filled in once IB has resolved the contract. */
export interface ContractRef {
  symbol: string;
  secType: SecType;
  exchange: string;
  currency: string;
  primaryExchange?: string;
  conId?: number;
  /** Derivatives: expiry as YYYYMMDD. */
  lastTradeDate?: string;
  strike?: number;
  right?: OptionRight;
  multiplier?: number;
  localSymbol?: string;
  tradingClass?: string;
  /** Combo legs, only for secType BAG. */
  comboLegs?: ComboLeg[];
}

export interface ComboLeg {
  conId: number;
  ratio: number;
  action: OrderAction;
  exchange: string;
}

/** Result of a symbol search (reqMatchingSymbols). */
export interface SymbolMatch {
  contract: ContractRef;
  description: string;
  derivativeSecTypes: string[];
}

/** Static contract information (reqContractDetails), cached in the main process. */
export interface ContractInfo {
  contract: ContractRef;
  longName: string;
  industry?: string;
  category?: string;
  subcategory?: string;
  minTick: number;
  timeZoneId?: string;
  tradingHours?: string;
  liquidHours?: string;
  validExchanges?: string[];
  orderTypes?: string[];
  /** IB's stock type for STK contracts: 'COMMON', 'ETF', 'ADR', 'REIT', 'PREFERRED', … */
  stockType?: string;
}

// ---------------------------------------------------------------------------
// Market data

/** IB market data type as reported by the marketDataType callback. */
export type MarketDataType = 1 | 2 | 3 | 4; // live, frozen, delayed, delayed-frozen

/**
 * Generic tick profiles. The main process maps each profile to a genericTickList:
 * - basic:      quotes for watchlists, positions, ticket (318 = last RTH trade on stocks)
 * - underlying: basic + option volume/OI, historical and implied volatility, 52w stats
 * - option:     option contract quotes with model greeks, volume and open interest
 */
export type QuoteProfile = 'basic' | 'underlying' | 'option';

export interface QuoteSubscription {
  contract: ContractRef;
  profile: QuoteProfile;
}

export interface Quote {
  key: string;
  bid?: number;
  ask?: number;
  last?: number;
  bidSize?: number;
  askSize?: number;
  lastSize?: number;
  /** Previous session close (tick 9). Used as the change reference. */
  close?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  /** Last regular-trading-hours trade (tick 57). */
  lastRthTrade?: number;
  /** Mark price (tick 37). */
  mark?: number;
  /** Unix ms of the last trade, when known (RTVolume / tick 45). */
  lastTime?: number;
  week52High?: number;
  week52Low?: number;
  avgVolume?: number;
  halted?: boolean;
  // Option model computation (tick 13) for option contracts.
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  undPrice?: number;
  /** Open interest of an option contract (ticks 27/28). */
  openInterest?: number;
  // Underlying statistics (profile 'underlying').
  histVol?: number; // tick 23, 30-day historical volatility
  impliedVol?: number; // tick 24, 30-day implied volatility
  callVolume?: number; // tick 29
  putVolume?: number; // tick 30
  callOpenInterest?: number; // tick 27
  putOpenInterest?: number; // tick 28
  marketDataType?: MarketDataType;
  /**
   * Last error for this subscription (e.g. 10197 competing live session, 354 not subscribed).
   * `final`: the line is dead (no data will arrive until the subscription changes), e.g. 200,
   * 354, 10168, 10186 or the line limit; otherwise the error is transient.
   */
  error?: { code: number; message: string; final?: boolean };
  updatedAt: number;
}

export type Timeframe = '1m' | '5m' | '1h' | '1D' | '1W' | '1M' | '1Y';

export interface HistoryRequest {
  contract: ContractRef;
  timeframe: Timeframe;
  /** Include extended-hours bars for intraday timeframes. */
  outsideRth?: boolean;
  /** TRADES by default; MIDPOINT for instruments without trades (indices fall back automatically). */
  whatToShow?: 'TRADES' | 'MIDPOINT' | 'OPTION_IMPLIED_VOLATILITY' | 'HISTORICAL_VOLATILITY';
  /**
   * The requesting view (e.g. "chart"): a newer request from the same slot supersedes older ones
   * that are still queued or loading (they reject with "superseded").
   */
  slot?: string;
  /** Bypass the cached result and fetch the newest bars (e.g. right after the close). */
  fresh?: boolean;
}

export interface Bar {
  /** Bar start, unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DepthLevel {
  price: number;
  size: number;
  marketMaker?: string;
}

export interface DepthBook {
  key: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
  updatedAt: number;
  error?: { code: number; message: string };
}

/** Option chain definition from reqSecDefOptParams. */
export interface OptionChainParams {
  exchange: string;
  underlyingConId: number;
  tradingClass: string;
  multiplier: number;
  /** YYYYMMDD, ascending. */
  expirations: string[];
  /** Ascending. */
  strikes: number[];
}

// ---------------------------------------------------------------------------
// Account

export interface AccountSummary {
  account: string;
  currency: string;
  netLiquidation?: number;
  totalCashValue?: number;
  buyingPower?: number;
  availableFunds?: number;
  excessLiquidity?: number;
  initMarginReq?: number;
  maintMarginReq?: number;
  grossPositionValue?: number;
  accruedDividend?: number;
  stockMarketValue?: number;
  optionMarketValue?: number;
  /** Account-level P&L from reqPnL. */
  dailyPnL?: number;
  unrealizedPnL?: number;
  realizedPnL?: number;
  updatedAt: number;
}

export interface Position {
  account: string;
  key: string;
  contract: ContractRef;
  /** Signed quantity (negative = short). */
  quantity: number;
  /** Average price per unit (IB avgCost divided by the multiplier). */
  avgPrice: number;
  multiplier: number;
  marketPrice?: number;
  marketValue?: number;
  unrealizedPnL?: number;
  realizedPnL?: number;
  /** From reqPnLSingle. */
  dailyPnL?: number;
  /** Industry from contract details; used for the sector allocation chart. */
  industry?: string;
  category?: string;
  /** Stock type from contract details ('COMMON', 'ETF', …); ETFs get their own sector. */
  stockType?: string;
  updatedAt: number;
}

/** A sampled net liquidation value, persisted to build the equity curve. */
export interface NavPoint {
  /** Unix ms. */
  t: number;
  netLiq: number;
}

// ---------------------------------------------------------------------------
// Orders

export type OrderAction = 'BUY' | 'SELL';
export type OrderType = 'LMT' | 'MKT' | 'STP' | 'STP LMT' | 'TRAIL';
export type TimeInForce = 'DAY' | 'GTC' | 'IOC' | 'OPG';

export interface PriceConditionSpec {
  /** The instrument whose price is monitored (usually the order's underlying). */
  contract: ContractRef;
  operator: '>=' | '<=';
  price: number;
  /** Also trigger outside regular trading hours. */
  outsideRth: boolean;
}

export interface OrderRequest {
  contract: ContractRef;
  action: OrderAction;
  orderType: OrderType;
  quantity: number;
  /** LMT and STP LMT limit price. */
  limitPrice?: number;
  /** STP and STP LMT trigger price. */
  stopPrice?: number;
  /** TRAIL: either a percentage or an amount, plus the initial stop. */
  trailingPercent?: number;
  trailingAmount?: number;
  trailStopPrice?: number;
  tif: TimeInForce;
  outsideRth: boolean;
  /** Attach take-profit (LMT) and stop-loss (STP) children. */
  bracket?: { takeProfit?: number; stopLoss?: number };
  condition?: PriceConditionSpec;
  /** Iceberg display size. */
  displaySize?: number;
  /** Good-after time, "HH:MM" in US/Eastern on the next valid day. */
  goodAfterTime?: string;
}

export interface PlaceOrderResult {
  orderId: number;
  childOrderIds: number[];
}

/** Order states as reported by IB. */
export type OrderStatus =
  | 'ApiPending'
  | 'PendingSubmit'
  | 'PendingCancel'
  | 'PreSubmitted'
  | 'Submitted'
  | 'ApiCancelled'
  | 'Cancelled'
  | 'Filled'
  | 'Inactive'
  | 'Unknown';

export interface WorkingOrder {
  orderId: number;
  permId?: number;
  clientId: number;
  parentId?: number;
  account?: string;
  key: string;
  contract: ContractRef;
  action: OrderAction;
  orderType: string;
  totalQuantity: number;
  limitPrice?: number;
  auxPrice?: number;
  trailingPercent?: number;
  trailStopPrice?: number;
  tif: string;
  outsideRth: boolean;
  goodAfterTime?: string;
  displaySize?: number;
  /** Human-readable price condition, e.g. { symbol: 'AAPL', operator: '>=', price: 235 }. */
  condition?: { symbol: string; operator: '>=' | '<='; price: number; outsideRth: boolean };
  status: OrderStatus;
  filled: number;
  remaining: number;
  avgFillPrice: number;
  /** Rejection or warning text from IB (error callback or orderState.warningText). */
  message?: string;
  whyHeld?: string;
  /** Unix ms when this client first saw the order. */
  createdAt: number;
  updatedAt: number;
}

export interface Execution {
  execId: string;
  orderId: number;
  permId?: number;
  account?: string;
  key: string;
  contract: ContractRef;
  side: OrderAction;
  shares: number;
  price: number;
  /** Unix ms. */
  time: number;
  exchange?: string;
  commission?: number;
  realizedPnL?: number;
}

export function isOrderActive(status: OrderStatus): boolean {
  return status !== 'Cancelled' && status !== 'ApiCancelled' && status !== 'Filled' && status !== 'Inactive';
}

// ---------------------------------------------------------------------------
// Connection

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface ConnectionState {
  status: ConnectionStatus;
  host: string;
  port: number;
  clientId: number;
  serverVersion?: number;
  /** Server connection time string as sent by TWS. */
  connTime?: string;
  accounts: string[];
  account?: string;
  /** Paper accounts start with "D" (DU…, DF…). */
  isPaper: boolean;
  reconnectAttempt?: number;
  /** Farm status from info codes 2103/2104/2105/2106/2107/2108/2158. */
  farms: Record<string, 'ok' | 'inactive' | 'broken'>;
  /** Market-wide data problem, e.g. 10197 "No market data during competing live session". */
  marketDataIssue?: { code: number; message: string };
  lastError?: { code: number; message: string; time: number };
  /** Round-trip time of the last reqCurrentTime heartbeat, in ms. */
  latencyMs?: number;
}

// ---------------------------------------------------------------------------
// API log

export interface ApiLogEntry {
  seq: number;
  /** Unix ms. */
  t: number;
  dir: 'out' | 'in';
  /** Protocol message id, or a label such as "API" for the handshake. */
  msgId: string;
  name: string;
  /** reqId / orderId / tickerId when the message has one. */
  reqId?: string;
  fields: Array<[string, string]>;
  bytes: number;
  err: boolean;
  /** Raw frame with NUL separators shown as ␀. */
  raw: string;
}

// ---------------------------------------------------------------------------
// Watchlists, alerts, notifications

export interface WatchItem {
  contract: ContractRef;
  /** Company or index name, cached for display. Built-in index names are localized. */
  name?: LocalizedName;
}

export interface WatchGroup {
  id: string;
  name: LocalizedName;
  items: WatchItem[];
}

export interface Watchlist {
  id: string;
  name: LocalizedName;
  /** Built-in lists cannot be renamed or deleted. */
  builtin?: boolean;
  groups: WatchGroup[];
}

export interface PriceAlert {
  id: string;
  contract: ContractRef;
  condition: 'above' | 'below';
  price: number;
  repeat: boolean;
  createdAt: number;
  lastTriggeredAt?: number;
  /** One-shot alerts are disabled after firing; repeating alerts re-arm after the price crosses back. */
  active: boolean;
}

export type NotificationKind = 'fill' | 'order' | 'price' | 'opt' | 'conn' | 'sys';

export interface AppNotification {
  id: string;
  /** Unix ms. */
  t: number;
  kind: NotificationKind;
  title: LocalizedText;
  body: LocalizedText;
  /** Instrument to open when the notification is clicked. */
  contract?: ContractRef;
  read: boolean;
}

// ---------------------------------------------------------------------------
// Settings

export type ThemeSetting = 'system' | 'dark' | 'light';
/** cn = red up / green down, us = green up / red down. */
export type UpColor = 'cn' | 'us';

export interface Settings {
  connection: {
    mode: 'tws' | 'gateway';
    host: string;
    port: number;
    clientId: number;
    autoConnect: boolean;
    autoReconnect: boolean;
    readOnly: boolean;
  };
  trading: {
    confirmOrders: boolean;
    defaultQty: number;
    outsideRthDefault: boolean;
  };
  appearance: {
    theme: ThemeSetting;
    language: Lang;
    upColor: UpColor;
    showAccountId: boolean;
  };
  /** Features that depend on extra market data subscriptions. */
  features: {
    depth: boolean;
    options: boolean;
    flow: boolean;
  };
  notifications: {
    /** Whether each kind is also pushed to the OS notification center. */
    system: Record<NotificationKind, boolean>;
    sound: boolean;
    dnd: boolean;
  };
  apiLog: {
    writeFile: boolean;
    keepDays: number;
  };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Everything the renderer needs on startup. */
export interface AppSnapshot {
  platform: string;
  appVersion: string;
  /** True when market data comes from the built-in simulator (TAPE_DEMO=1). */
  demo: boolean;
  settings: Settings;
  /** Resolved theme ('system' resolved via nativeTheme). */
  dark: boolean;
  connection: ConnectionState;
  account: AccountSummary | null;
  positions: Position[];
  orders: WorkingOrder[];
  executions: Execution[];
  watchlists: Watchlist[];
  priceAlerts: PriceAlert[];
  notifications: AppNotification[];
  nav: NavPoint[];
  logFilePath: string;
}
