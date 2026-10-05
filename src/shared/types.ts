// Domain models shared by the main process and the renderer.
// Everything here must stay serializable (structured clone) because it crosses IPC.

import type { TimeFormat } from './timeFormat';

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
  /** IB's price magnifier: 100 when prices are in the currency's minor unit (pence on the LSE). */
  priceMagnifier?: number;
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

/**
 * Chart intervals (bar sizes). Daily and longer keys keep their original names ('1D' … '1Y'),
 * which persisted preferences and cached series use; the UI labels them D, W, M, Q, Y.
 * See shared/timeframes.ts for their bar lengths and the picker groups.
 */
export type Timeframe =
  | '1s'
  | '5s'
  | '10s'
  | '15s'
  | '30s'
  | '45s'
  | '1m'
  | '3m'
  | '5m'
  | '10m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '3h'
  | '4h'
  | '1D'
  | '1W'
  | '1M'
  | '1Q'
  | '1Y';

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

/** A page of older bars, for scrolling a chart back in time. */
export interface HistoryPage {
  /** Ascending, all strictly older than the requested `before` time. */
  bars: Bar[];
  /** True when nothing older exists (the earliest data IB has was reached), or `limited`. */
  done: boolean;
  /**
   * Paging stopped at IB's limit for the bar size, not at the start of the data: bars of 30
   * seconds or less go back six months (shared/timeframes.ts → SECONDS_HISTORY_DAYS).
   */
  limited?: boolean;
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

/** What the local database (tape.db) holds, for Settings › Market data. */
export interface CacheStats {
  /** Size on disk: the database file plus its write-ahead log. */
  bytes: number;
  /** Stored bar series (contract + bar size + whatToShow + useRTH). */
  series: number;
  bars: number;
  /** Journaled executions (never removed by the cache cleanup). */
  executions: number;
  /** Unix ms of the least recently used series, when there is one. */
  oldestAccess?: number;
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
  /**
   * From reqPnLSingle. IB's P&L engine values the position at its own mark (`pnlValue`), which outside
   * regular hours can differ from the portfolio update's `marketPrice`; the portfolio view re-marks it.
   */
  dailyPnL?: number;
  /** reqPnLSingle's market value: the mark `dailyPnL` was computed at. */
  pnlValue?: number;
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
/**
 * Order types Tape sends (shared/orderRules.ts says which instruments and sessions take which).
 * The first five are the ticket's main row; the others are IB's touched, auction, midpoint /
 * pegged and trailing variants.
 */
export type OrderType =
  | 'LMT'
  | 'MKT'
  | 'STP'
  | 'STP LMT'
  | 'TRAIL'
  | 'TRAIL LIMIT'
  | 'MIT'
  | 'LIT'
  | 'MOC'
  | 'LOC'
  | 'MTL'
  | 'MIDPRICE'
  | 'REL'
  | 'SNAP MID'
  | 'SNAP MKT'
  | 'PEG MID'
  | 'TRAIL MIT'
  | 'TRAIL LIT';
export type TimeInForce = 'DAY' | 'GTC' | 'IOC' | 'FOK' | 'OPG' | 'GTD';
/**
 * When an order may work (see shared/orderTiming.ts for what combines with what):
 * 'regular' regular trading hours; 'extended' also pre-market and after-hours (IB's outsideRth);
 * 'overnight' only IB's overnight session of US stocks / ETFs (20:00–03:50 ET, exchange
 * OVERNIGHT); 'overnightDay' the overnight session and then the next trading day, pre-market and
 * after-hours included (SMART with includeOvernight; IB reports its TIF as "OVERNIGHT + DAY").
 */
export type TradingSession = 'regular' | 'extended' | 'overnight' | 'overnightDay';

/**
 * IB's trigger methods of simulated stops, touched orders and price conditions: 0 default (double
 * bid/ask for US options, last otherwise), 1 double bid/ask, 2 last, 3 double last, 4 bid/ask,
 * 7 last or bid/ask, 8 midpoint.
 */
export type TriggerMethod = 0 | 1 | 2 | 3 | 4 | 7 | 8;

export interface PriceConditionSpec {
  /** The instrument whose price is monitored (usually the order's underlying). */
  contract: ContractRef;
  operator: '>=' | '<=';
  price: number;
  /** Also trigger outside regular trading hours. */
  outsideRth: boolean;
}

/** One condition of an order (IB's order conditions). */
export type OrderConditionSpec =
  /** Price of an instrument (an index too) at or above / below a value. */
  | { kind: 'price'; contract: ContractRef; operator: '>=' | '<='; price: number; triggerMethod?: TriggerMethod }
  /** After a time, "yyyyMMdd HH:mm:ss US/Eastern" (IB takes "after" only). */
  | { kind: 'time'; time: string }
  /** Change of an instrument since the last close, in percent (-5 = down 5 %). */
  | { kind: 'percentChange'; contract: ContractRef; operator: '>=' | '<='; percent: number }
  /** Today's traded volume of an instrument (a whole number, at most 2^31 - 1). */
  | { kind: 'volume'; contract: ContractRef; operator: '>=' | '<='; volume: number }
  /** The account's margin cushion, in whole percent. */
  | { kind: 'margin'; operator: '>=' | '<='; percent: number }
  /** A trade of this symbol / security type in the account. */
  | { kind: 'execution'; symbol: string; secType: SecType };

export type OrderConditionItem = OrderConditionSpec & {
  /** How this condition combines with the next one (default 'and'; the last one's is not used). */
  join?: 'and' | 'or';
};

export interface OrderConditions {
  items: OrderConditionItem[];
  /** Cancel the order when the conditions are met, instead of submitting it (LMT and MIDPRICE only). */
  cancel?: boolean;
  /** The conditions are also evaluated outside regular trading hours. */
  outsideRth: boolean;
}

/** IB algos Tape offers (shared/orderRules.ts › ALGOS lists their parameters). */
export type AlgoStrategy =
  | 'Adaptive'
  | 'Vwap'
  | 'Twap'
  | 'ArrivalPx'
  | 'ClosePx'
  | 'PctVol'
  | 'PctVolPx'
  | 'PctVolSz'
  | 'PctVolTm'
  | 'DarkIce'
  | 'AD'
  | 'MinImpact'
  | 'BalanceImpactRisk';

/** Algo parameter values: numbers, switches, choices and times ("HH:MM" New York time). */
export type AlgoParamValue = string | number | boolean;

export interface AlgoSpec {
  strategy: AlgoStrategy;
  params: Record<string, AlgoParamValue>;
}

/** Stop types of a bracket's stop-loss and of an adjusted stop. */
export type StopOrderType = 'STP' | 'STP LMT' | 'TRAIL' | 'TRAIL LIMIT';

/**
 * Adjustable stop: once the order's instrument trades at `trigger`, IB turns the stop into another
 * stop (e.g. moves it to break-even, or makes it trail).
 */
export interface AdjustedStop {
  trigger: number;
  type: 'STP' | 'STP LMT' | 'TRAIL';
  /** New stop price (STP, STP LMT; the initial stop of TRAIL). */
  stopPrice?: number;
  /** New limit price (STP LMT). */
  limitPrice?: number;
  /** New trailing amount (TRAIL), in price or percent per `trailUnit`. */
  trailAmount?: number;
  trailUnit?: 'amount' | 'percent';
}

/** Take-profit and stop-loss children attached to an order. */
export interface BracketSpec {
  /** Take-profit limit price. */
  takeProfit?: number;
  /** Stop-loss stop price; for trailing stop-losses the initial stop. */
  stopLoss?: number;
  /** The stop-loss order type (default STP). */
  stopType?: StopOrderType;
  /** STP LMT stop-loss: limit price. */
  stopLimit?: number;
  /** TRAIL / TRAIL LIMIT stop-loss: trailing amount or percent (one of them). */
  stopTrailAmount?: number;
  stopTrailPercent?: number;
  /** TRAIL LIMIT stop-loss: limit offset from the stop. */
  stopLimitOffset?: number;
  /** Adjustable stop-loss. */
  adjust?: AdjustedStop;
}

/** OCA type: 1 cancel the others (with block), 2 reduce the others (with block), 3 reduce (no block). */
export type OcaType = 1 | 2 | 3;

export interface OrderRequest {
  contract: ContractRef;
  action: OrderAction;
  orderType: OrderType;
  /** Shares / contracts; 0 for a forex order sized by `cashQty`. */
  quantity: number;
  /**
   * Limit price: LMT, STP LMT, LIT, LOC; the optional price cap of MIDPRICE, REL and PEG MID.
   */
  limitPrice?: number;
  /** STP and STP LMT stop price; MIT and LIT trigger price. */
  stopPrice?: number;
  /** TRAIL, TRAIL LIMIT, TRAIL MIT, TRAIL LIT: either a percentage or an amount, plus the initial stop. */
  trailingPercent?: number;
  trailingAmount?: number;
  trailStopPrice?: number;
  /** TRAIL LIMIT and TRAIL LIT: limit offset from the trailing stop (IB's lmtPriceOffset). */
  limitOffset?: number;
  /** REL, SNAP MID, SNAP MKT, PEG MID: offset from the reference price (IB's auxPrice). */
  offset?: number;
  /** REL: offset in percent of the reference price instead of `offset` (0.5 = 0.5 %). */
  percentOffset?: number;
  tif: TimeInForce;
  /** Pre-market and after-hours (IB's outsideRth); `session`, when set, decides it instead. */
  outsideRth: boolean;
  /** Trading session; absent: 'extended' with outsideRth, otherwise 'regular'. */
  session?: TradingSession;
  /** GTD expiry, "yyyyMMdd HH:mm:ss US/Eastern" (required with tif GTD). */
  goodTillDate?: string;
  /** Attach take-profit and stop-loss children. */
  bracket?: BracketSpec;
  /** One price condition (the ticket's simple form); `conditions` is the general one. Not both. */
  condition?: PriceConditionSpec;
  conditions?: OrderConditions;
  /** Iceberg display size. */
  displaySize?: number;
  /** Good-after time, "HH:MM" in US/Eastern on the next valid day. */
  goodAfterTime?: string;
  /** Fill attributes. */
  allOrNone?: boolean;
  /** Minimum quantity per fill (options). */
  minQty?: number;
  /** Not shown in the order book (US stocks). */
  hidden?: boolean;
  /** Takes all displayed liquidity up to the limit at once (US stocks via SMART). */
  sweepToFill?: boolean;
  /** Limit orders: hidden discretion beyond the limit price (US stocks). */
  discretionaryAmt?: number;
  /** Trigger method of stops and touched orders (0 / absent: IB's default). */
  triggerMethod?: TriggerMethod;
  /** Adjustable stop of a stop order (STP, STP LMT, TRAIL). */
  adjustStop?: AdjustedStop;
  algo?: AlgoSpec;
  /** One-cancels-all group: orders with the same group name cancel / reduce each other. */
  oca?: { group: string; type: OcaType };
  /** Directed routing: an exchange from the contract's valid exchanges instead of SMART (stocks). */
  route?: string;
  /** Combos: SMART routes the legs separately (leg risk) instead of as a guaranteed combo. */
  nonGuaranteed?: boolean;
  /** Forex: order size in the quote currency instead of `quantity` (IB computes the quantity). */
  cashQty?: number;
  /** Free-text note (IB's orderRef), shown in TWS and on executions. */
  orderRef?: string;
}

/** IB's margin and commission estimate of an order (whatIf), before it is placed. */
export interface OrderPreview {
  /** Commission; IB may give a range instead (minCommission..maxCommission). */
  commission?: number;
  minCommission?: number;
  maxCommission?: number;
  commissionCurrency?: string;
  /** Margin before / change / after; absent when IB returned none (e.g. for some limit orders). */
  initMargin?: { before?: number; change?: number; after?: number };
  maintMargin?: { before?: number; change?: number; after?: number };
  equityWithLoan?: { before?: number; change?: number; after?: number };
  /** IB's notice about the order (price bands, odd lots, …). */
  warningText?: string;
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
  /** IB's TIF, except "OVERNIGHT + DAY", which is DAY with session 'overnightDay'. */
  tif: string;
  /** IB's outsideRth flag as reported (IB also sets it for overnight + day, IOC and FOK orders). */
  outsideRth: boolean;
  /** Trading session (absent in orders recorded before sessions existed: see sessionOf). */
  session?: TradingSession;
  /** GTD expiry as IB reports it, e.g. "20261009 16:00:00 US/Eastern". */
  goodTillDate?: string;
  goodAfterTime?: string;
  displaySize?: number;
  /** Human-readable price condition, e.g. { symbol: 'AAPL', operator: '>=', price: 235 } (the first one). */
  condition?: { symbol: string; operator: '>=' | '<='; price: number; outsideRth: boolean };
  /**
   * Every condition, as a request carries them (watched contracts as { conId, symbol } refs; the
   * symbol is the conId until IB has named it).
   */
  conditions?: OrderConditions;
  /** TRAIL LIMIT / TRAIL LIT limit offset. */
  limitOffset?: number;
  /** REL percent offset. */
  percentOffset?: number;
  allOrNone?: boolean;
  minQty?: number;
  hidden?: boolean;
  sweepToFill?: boolean;
  discretionaryAmt?: number;
  /** Absent for IB's default (0). */
  triggerMethod?: TriggerMethod;
  /** The adjustable-stop rule of a stop order (a bracket's stop-loss child included). */
  adjustStop?: AdjustedStop;
  algo?: AlgoSpec;
  oca?: { group: string; type: OcaType };
  /** Directed exchange (not SMART / OVERNIGHT). */
  route?: string;
  nonGuaranteed?: boolean;
  cashQty?: number;
  orderRef?: string;
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
/** Auto-lock after this many idle minutes; 'custom' uses `lock.customMinutes`. */
export type AutoLock = '15' | '30' | '60' | 'custom' | 'never';

export interface Settings {
  connection: {
    mode: 'tws' | 'gateway';
    host: string;
    port: number;
    clientId: number;
    autoConnect: boolean;
    autoReconnect: boolean;
  };
  trading: {
    confirmOrders: boolean;
    defaultQty: number;
    outsideRthDefault: boolean;
  };
  appearance: {
    theme: ThemeSetting;
    language: Lang;
    /** Clock times: '12h' "9:41 AM" (the default) or '24h' "09:41" (shared/timeFormat.ts). */
    timeFormat: TimeFormat;
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
    /** Play a sound with system notifications. */
    sound: boolean;
    /** Sound id per category (shared/notificationSounds.ts): orders, fills, everything else. */
    sounds: Record<'order' | 'fill' | 'other', string>;
    dnd: boolean;
  };
  apiLog: {
    writeFile: boolean;
    keepDays: number;
  };
  /** Lock screen preferences. The PIN itself is not a setting (main keeps its hash in lock.json). */
  lock: {
    autoLock: AutoLock;
    /** 1–1440, used when autoLock is 'custom'. */
    customMinutes: number;
    /** 'biometric' = Touch ID / Windows Hello when available, PIN otherwise. */
    unlockWith: 'biometric' | 'pin';
    sound: boolean;
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
  lock: LockState;
  /** This launch follows a Forgot-PIN reset (Settings › Connection opens, no auto-connect). */
  afterReset: boolean;
}

// ---------------------------------------------------------------------------
// Lock screen

export type BiometricKind = 'touchId' | 'windowsHello';

/** Whether Touch ID / Windows Hello can be used right now (`kind` null: no provider on this platform). */
export interface LockBiometrics {
  kind: BiometricKind | null;
  available: boolean;
  /**
   * Why it is unavailable (see src/main/lock/types.ts → BiometricUnavailableReason). 'checking':
   * not known yet (the first check after launch is still running); not a reason to warn about.
   */
  reason?: 'unsupported' | 'noHardware' | 'notEnrolled' | 'disabledByPolicy' | 'error' | 'checking';
}

/** What the renderer needs to draw the lock; never the PIN hash. Main is the only authority. */
export interface LockState {
  hasPin: boolean;
  locked: boolean;
  biometrics: LockBiometrics;
  /** Consecutive wrong PINs. */
  failures: number;
  /** Unix ms before which PIN attempts are refused; null when not throttled. */
  retryAt: number | null;
}

/** Why a biometric check did not verify the user (never shown as "Incorrect PIN"). */
export type BiometricFailure = 'canceled' | 'failed' | 'busy' | 'unavailable' | 'timeout' | 'error';

export type PinCheckFailure =
  | { ok: false; reason: 'wrongPin'; failures: number; retryAt: number | null }
  | { ok: false; reason: 'throttled'; retryAt: number }
  | { ok: false; reason: 'noPin' }
  /** lock.json exists but cannot be read: Tape stays locked; Forgot PIN is the way out. */
  | { ok: false; reason: 'pinUnreadable' };

/** Result of an unlock attempt. */
export type UnlockResult = { ok: true } | PinCheckFailure | { ok: false; reason: 'biometric'; failure: BiometricFailure };

/**
 * Result of re-verifying the user before a PIN change or removal. `token` is single-use and
 * expires after a few minutes; pass it to setLockPin / removeLockPin.
 */
export type VerifyResult = { ok: true; token: string } | PinCheckFailure | { ok: false; reason: 'biometric'; failure: BiometricFailure };
