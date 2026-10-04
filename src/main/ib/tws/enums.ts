// Enumerations of the TWS API: event names, security types, order attributes, market data
// settings. Values (and names) match @stoqey/ib so code written against it keeps working.
//
// Wire format follows the IB TWS API (EClient/EDecoder). Portions derived from @stoqey/ib (MIT, Copyright (c) the @stoqey/ib authors)
//
// TypeScript `enum` is avoided on purpose: these files must also run under Node's type
// stripping (`node scripts/x.ts`), which only accepts erasable syntax. Each enum is a frozen
// object plus a type alias of its values; numeric enums also carry the reverse mapping
// (value -> name) that TypeScript enums provide.

/** A frozen NAME -> number table that also maps each number back to its NAME (like a TS enum). */
export type NumericEnum<T extends Record<string, number>> = Readonly<T> & { readonly [value: number]: string | undefined };

export function numericEnum<const T extends Record<string, number>>(def: T): NumericEnum<T> {
  const table: Record<string | number, string | number> = { ...def };
  for (const [name, value] of Object.entries(def)) table[value] = name;
  return Object.freeze(table) as unknown as NumericEnum<T>;
}

type ValueOf<T> = T[keyof T];

// ---------------------------------------------------------------------------
// Events

/** Names of the events emitted by IBApi (identical to @stoqey/ib's EventName). */
export const EventName = Object.freeze({
  all: 'all',
  connected: 'connected',
  disconnected: 'disconnected',
  server: 'server',
  error: 'error',
  info: 'info',
  received: 'received',
  sent: 'sent',
  result: 'result',
  accountDownloadEnd: 'accountDownloadEnd',
  accountSummary: 'accountSummary',
  accountSummaryEnd: 'accountSummaryEnd',
  accountUpdateMulti: 'accountUpdateMulti',
  accountUpdateMultiEnd: 'accountUpdateMultiEnd',
  bondContractDetails: 'bondContractDetails',
  commissionReport: 'commissionReport',
  completedOrder: 'completedOrder',
  completedOrdersEnd: 'completedOrdersEnd',
  connectionClosed: 'connectionClosed',
  contractDetails: 'contractDetails',
  contractDetailsEnd: 'contractDetailsEnd',
  currentTime: 'currentTime',
  deltaNeutralValidation: 'deltaNeutralValidation',
  tickSnapshotEnd: 'tickSnapshotEnd',
  marketDataType: 'marketDataType',
  displayGroupList: 'displayGroupList',
  displayGroupUpdated: 'displayGroupUpdated',
  execDetails: 'execDetails',
  execDetailsEnd: 'execDetailsEnd',
  familyCodes: 'familyCodes',
  contractDescriptions: 'contractDescriptions',
  fundamentalData: 'fundamentalData',
  headTimestamp: 'headTimestamp',
  histogramData: 'histogramData',
  historicalDataUpdate: 'historicalDataUpdate',
  historicalNews: 'historicalNews',
  historicalNewsEnd: 'historicalNewsEnd',
  historicalTicks: 'historicalTicks',
  historicalTicksBidAsk: 'historicalTicksBidAsk',
  historicalTicksLast: 'historicalTicksLast',
  managedAccounts: 'managedAccounts',
  marketRule: 'marketRule',
  mktDepthExchanges: 'mktDepthExchanges',
  newsArticle: 'newsArticle',
  newsProviders: 'newsProviders',
  nextValidId: 'nextValidId',
  openOrder: 'openOrder',
  openOrderEnd: 'openOrderEnd',
  orderBound: 'orderBound',
  orderStatus: 'orderStatus',
  pnl: 'pnl',
  pnlSingle: 'pnlSingle',
  position: 'position',
  positionEnd: 'positionEnd',
  positionMulti: 'positionMulti',
  positionMultiEnd: 'positionMultiEnd',
  realtimeBar: 'realtimeBar',
  receiveFA: 'receiveFA',
  replaceFAEnd: 'replaceFAEnd',
  rerouteMktDataReq: 'rerouteMktDataReq',
  rerouteMktDepthReq: 'rerouteMktDepthReq',
  scannerData: 'scannerData',
  scannerDataEnd: 'scannerDataEnd',
  scannerParameters: 'scannerParameters',
  securityDefinitionOptionParameter: 'securityDefinitionOptionParameter',
  securityDefinitionOptionParameterEnd: 'securityDefinitionOptionParameterEnd',
  smartComponents: 'smartComponents',
  softDollarTiers: 'softDollarTiers',
  symbolSamples: 'symbolSamples',
  tickByTickAllLast: 'tickByTickAllLast',
  tickByTickBidAsk: 'tickByTickBidAsk',
  tickByTickMidPoint: 'tickByTickMidPoint',
  tickEFP: 'tickEFP',
  tickGeneric: 'tickGeneric',
  tickNews: 'tickNews',
  tickOptionComputation: 'tickOptionComputation',
  tickPrice: 'tickPrice',
  tickReqParams: 'tickReqParams',
  tickSize: 'tickSize',
  tickString: 'tickString',
  updateAccountTime: 'updateAccountTime',
  updateAccountValue: 'updateAccountValue',
  updatePortfolio: 'updatePortfolio',
  updateMktDepth: 'updateMktDepth',
  updateMktDepthL2: 'updateMktDepthL2',
  updateNewsBulletin: 'updateNewsBulletin',
  historicalData: 'historicalData',
  wshMetaData: 'wshMetaData',
  wshEventData: 'wshEventData',
  historicalSchedule: 'historicalSchedule',
  userInfo: 'userInfo',
} as const);
export type EventName = ValueOf<typeof EventName>;

// ---------------------------------------------------------------------------
// Contracts

export const SecType = Object.freeze({
  STK: 'STK',
  OPT: 'OPT',
  FUT: 'FUT',
  CONTFUT: 'CONTFUT',
  CASH: 'CASH',
  BOND: 'BOND',
  CFD: 'CFD',
  FOP: 'FOP',
  WAR: 'WAR',
  IOPT: 'IOPT',
  FWD: 'FWD',
  BAG: 'BAG',
  IND: 'IND',
  BILL: 'BILL',
  FUND: 'FUND',
  FIXED: 'FIXED',
  SLB: 'SLB',
  NEWS: 'NEWS',
  CMDTY: 'CMDTY',
  BSK: 'BSK',
  ICU: 'ICU',
  ICS: 'ICS',
  CRYPTO: 'CRYPTO',
} as const);
export type SecType = ValueOf<typeof SecType>;

export const OptionType = Object.freeze({ Put: 'P', Call: 'C' } as const);
export type OptionType = ValueOf<typeof OptionType>;

// ---------------------------------------------------------------------------
// Orders

export const OrderAction = Object.freeze({ BUY: 'BUY', SELL: 'SELL', SSHORT: 'SSHORT', SLONG: 'SLONG' } as const);
export type OrderAction = ValueOf<typeof OrderAction>;

export const OrderType = Object.freeze({
  None: '',
  MKT: 'MKT',
  LMT: 'LMT',
  STP: 'STP',
  STP_LMT: 'STP LMT',
  REL: 'REL',
  TRAIL: 'TRAIL',
  BOX_TOP: 'BOX TOP',
  FIX_PEGGED: 'FIX PEGGED',
  LIT: 'LIT',
  LMT_PLUS_MKT: 'LMT + MKT',
  LOC: 'LOC',
  MIDPRICE: 'MIDPRICE',
  MIT: 'MIT',
  MKT_PRT: 'MKT PRT',
  MOC: 'MOC',
  MTL: 'MTL',
  PASSV_REL: 'PASSV REL',
  PEG_BENCH: 'PEG BENCH',
  PEG_BEST: 'PEG BEST',
  PEG_MID: 'PEG MID',
  PEG_MKT: 'PEG MKT',
  PEG_PRIM: 'PEG PRIM',
  PEG_STK: 'PEG STK',
  REL_PLUS_LMT: 'REL + LMT',
  REL_PLUS_MKT: 'REL + MKT',
  SNAP_MID: 'SNAP MID',
  SNAP_MKT: 'SNAP MKT',
  SNAP_PRIM: 'SNAP PRIM',
  STP_PRT: 'STP PRT',
  TRAIL_LIMIT: 'TRAIL LIMIT',
  TRAIL_LIT: 'TRAIL LIT',
  TRAIL_LMT_PLUS_MKT: 'TRAIL LMT + MKT',
  TRAIL_MIT: 'TRAIL MIT',
  TRAIL_REL_PLUS_MKT: 'TRAIL REL + MKT',
  VOL: 'VOL',
  VWAP: 'VWAP',
  QUOTE: 'QUOTE',
  PEG_PRIM_VOL: 'PPV',
  PEG_MID_VOL: 'PDV',
  PEG_MKT_VOL: 'PMV',
  PEG_SRF_VOL: 'PSV',
} as const);
export type OrderType = ValueOf<typeof OrderType>;

export const isVolOrder = (orderType: string | undefined): boolean => orderType === OrderType.VOL;
export const isPegBenchOrder = (orderType: string | undefined): boolean => orderType === OrderType.PEG_BENCH || orderType === 'PEGBENCH';
export const isPegBestOrder = (orderType: string | undefined): boolean => orderType === OrderType.PEG_BEST || orderType === 'PEGBEST';
export const isPegMidOrder = (orderType: string | undefined): boolean => orderType === OrderType.PEG_MID || orderType === 'PEGMID';

/** Order.competeAgainstBestOffset value meaning "up to mid". */
export const COMPETE_AGAINST_BEST_OFFSET_UP_TO_MID = Infinity;

export const TimeInForce = Object.freeze({
  DAY: 'DAY',
  GTC: 'GTC',
  OPG: 'OPG',
  IOC: 'IOC',
  GTD: 'GTD',
  GTT: 'GTT',
  AUC: 'AUC',
  FOK: 'FOK',
  GTX: 'GTX',
  DTC: 'DTC',
  Minutes: 'Minutes',
} as const);
export type TimeInForce = ValueOf<typeof TimeInForce>;

export const OrderStatus = Object.freeze({
  ApiPending: 'ApiPending',
  ApiCancelled: 'ApiCancelled',
  PreSubmitted: 'PreSubmitted',
  PendingCancel: 'PendingCancel',
  Cancelled: 'Cancelled',
  Submitted: 'Submitted',
  Filled: 'Filled',
  Inactive: 'Inactive',
  PendingSubmit: 'PendingSubmit',
  Unknown: 'Unknown',
} as const);
export type OrderStatus = ValueOf<typeof OrderStatus>;

const ORDER_CONDITION_TYPE = { Price: 1, Time: 3, Margin: 4, Execution: 5, Volume: 6, PercentChange: 7 } as const;
export const OrderConditionType = numericEnum(ORDER_CONDITION_TYPE);
export type OrderConditionType = ValueOf<typeof ORDER_CONDITION_TYPE>;

export const ConjunctionConnection = Object.freeze({ AND: 'a', OR: 'o' } as const);
export type ConjunctionConnection = ValueOf<typeof ConjunctionConnection>;

const TRIGGER_METHOD = { Default: 0, DoubleBidAsk: 1, Last: 2, DoubleLast: 3, BidAsk: 4, LastOfBidAsk: 7, MidPoint: 8 } as const;
export const TriggerMethod = numericEnum(TRIGGER_METHOD);
export type TriggerMethod = ValueOf<typeof TRIGGER_METHOD>;

const LIQUIDITIES = { None: 0, Added: 1, Removed: 2, RoudedOut: 3 } as const;
export const Liquidities = numericEnum(LIQUIDITIES);
export type Liquidities = ValueOf<typeof LIQUIDITIES>;

// ---------------------------------------------------------------------------
// Market data and history

const MARKET_DATA_TYPE = { REALTIME: 1, FROZEN: 2, DELAYED: 3, DELAYED_FROZEN: 4 } as const;
export const MarketDataType = numericEnum(MARKET_DATA_TYPE);
export type MarketDataType = ValueOf<typeof MARKET_DATA_TYPE>;

export const BarSizeSetting = Object.freeze({
  SECONDS_ONE: '1 secs',
  SECONDS_FIVE: '5 secs',
  SECONDS_TEN: '10 secs',
  SECONDS_FIFTEEN: '15 secs',
  SECONDS_THIRTY: '30 secs',
  MINUTES_ONE: '1 min',
  MINUTES_TWO: '2 mins',
  MINUTES_THREE: '3 mins',
  MINUTES_FIVE: '5 mins',
  MINUTES_TEN: '10 mins',
  MINUTES_FIFTEEN: '15 mins',
  MINUTES_TWENTY: '20 mins',
  MINUTES_THIRTY: '30 mins',
  HOURS_ONE: '1 hour',
  HOURS_TWO: '2 hours',
  HOURS_THREE: '3 hours',
  HOURS_FOUR: '4 hours',
  HOURS_EIGHT: '8 hours',
  DAYS_ONE: '1 day',
  WEEKS_ONE: '1 week',
  MONTHS_ONE: '1 month',
} as const);
export type BarSizeSetting = ValueOf<typeof BarSizeSetting>;

export const WhatToShow = Object.freeze({
  None: '',
  TRADES: 'TRADES',
  MIDPOINT: 'MIDPOINT',
  BID: 'BID',
  ASK: 'ASK',
  BID_ASK: 'BID_ASK',
  HISTORICAL_VOLATILITY: 'HISTORICAL_VOLATILITY',
  OPTION_IMPLIED_VOLATILITY: 'OPTION_IMPLIED_VOLATILITY',
  YIELD_ASK: 'YIELD_ASK',
  YIELD_BID: 'YIELD_BID',
  YIELD_BID_ASK: 'YIELD_BID_ASK',
  YIELD_LAST: 'YIELD_LAST',
  ADJUSTED_LAST: 'ADJUSTED_LAST',
  SCHEDULE: 'SCHEDULE',
  AGGTRADES: 'AGGTRADES',
} as const);
export type WhatToShow = ValueOf<typeof WhatToShow>;
