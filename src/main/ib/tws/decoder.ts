// Incoming messages: a pure function turning the fields of one frame into the events it
// produces, with the names and argument lists @stoqey/ib emits.
//
// Field order is the one of IB's EDecoder / EOrderDecoder for server versions 176..193;
// branches for older servers are unconditional (per-message version fields still sent on the
// wire are honoured). Messages outside this client's scope are skipped: the frame length
// tells where the next message starts, so skipping never desynchronises the stream.
//
// Wire format follows the IB TWS API (EClient/EDecoder). Portions derived from @stoqey/ib (MIT, Copyright (c) the @stoqey/ib authors)

import { ExecutionCondition, MarginCondition, PercentChangeCondition, PriceCondition, TimeCondition, VolumeCondition } from './conditions.ts';
import { EventName, OptionType, OrderConditionType, OrderStatus, OrderType, SecType, isPegBenchOrder } from './enums.ts';
import { ErrorCode } from './errors.ts';
import { IN_MSG_ID, MIN_SERVER_VER } from './messageIds.ts';
import { PRICE_TICK_SIZE_TYPE, TickType } from './tickTypes.ts';
import type {
  ConjunctionConnection,
  OptionType as OptionTypeT,
  OrderStatus as OrderStatusT,
} from './enums.ts';
import type {
  CommissionReport,
  Contract,
  ContractDescription,
  ContractDetails,
  DepthMktDataDescription,
  Execution,
  Order,
  OrderCondition,
  OrderState,
  TagValue,
} from './types.ts';

/** One event to emit: the IBApi event name and its listener arguments. */
export interface DecodedEvent {
  name: string;
  args: unknown[];
}

/** Integer.MAX_VALUE, "unset" for integer fields. */
const INT_MAX = 2147483647;

class UnderrunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnderrunError';
  }
}

const OPTION_TYPES: readonly string[] = Object.values(OptionType);
const validateOptionType = (v: string): OptionTypeT | undefined => (OPTION_TYPES.includes(v) ? (v as OptionTypeT) : undefined);

/** Replaces "\uXXXX" escapes (TWS escapes non-ASCII characters in some texts). */
export function decodeUnicodeEscapedString(str: string): string {
  let v = str;
  for (;;) {
    const i = v.indexOf('\\u');
    if (i === -1 || v.length - i < 6) break;
    const code = parseInt(v.substring(i + 2, i + 6), 16);
    v = v.substring(0, i) + String.fromCharCode(code) + v.substring(i + 6);
  }
  return v;
}

/** Sequential reader over the fields of one frame. */
class Reader {
  readonly fields: readonly string[];
  readonly sv: number;
  pos = 0;

  constructor(fields: readonly string[], serverVersion: number) {
    this.fields = fields;
    this.sv = serverVersion;
  }

  get remaining(): readonly string[] {
    return this.fields.slice(this.pos);
  }

  str(): string {
    if (this.pos >= this.fields.length) throw new UnderrunError('End of message reached.');
    return this.fields[this.pos++];
  }

  /** Integer; empty -> 0. */
  int(): number {
    const s = this.str();
    return s === '' ? 0 : parseInt(s, 10);
  }

  /** Integer; empty or Integer.MAX_VALUE -> undefined. */
  intOrUndefined(): number | undefined {
    const s = this.str();
    if (s === '') return undefined;
    const v = parseInt(s, 10);
    return v === INT_MAX ? undefined : v;
  }

  /** Floating point; empty -> 0, Double.MAX_VALUE -> undefined. */
  double(): number | undefined {
    const s = this.str();
    if (s === '') return 0;
    const v = parseFloat(s);
    return v === Number.MAX_VALUE ? undefined : v;
  }

  /** Floating point; empty or Double.MAX_VALUE -> undefined. */
  doubleOrUndefined(): number | undefined {
    const s = this.str();
    if (s === '') return undefined;
    const v = parseFloat(s);
    return v === Number.MAX_VALUE ? undefined : v;
  }

  /** Decimal (sizes, quantities); empty, Double.MAX_VALUE or infinite -> undefined. */
  decimal(): number | undefined {
    const s = this.str();
    if (s === '') return undefined;
    const v = parseFloat(s.replaceAll(',', ''));
    return v === Number.MAX_VALUE || v === Infinity ? undefined : v;
  }

  bool(): boolean {
    return !!parseInt(this.str());
  }
}

type Emit = (name: string, ...args: unknown[]) => void;
type Decode = (r: Reader, emit: Emit) => void;

// ---------------------------------------------------------------------------
// Market data

const tickPrice: Decode = (r, emit) => {
  const version = r.int();
  const tickerId = r.int();
  const tickType = r.int();
  const price = r.double();
  let size: number | undefined;
  if (version >= 2) size = r.decimal();
  let canAutoExecute: boolean | undefined;
  if (version >= 3) canAutoExecute = r.bool();
  emit(EventName.tickPrice, tickerId, tickType, price, canAutoExecute);
  // The size of bid / ask / last ticks comes with the price; report it as a size tick too.
  // Like @stoqey/ib, nothing is emitted when the size tick type is 0 (BID_SIZE): its check is
  // `if (sizeTickType)`, so bid sizes only arrive through TICK_SIZE frames. (EDecoder would
  // call tickSize for BID as well.)
  const sizeTickType = version >= 2 ? PRICE_TICK_SIZE_TYPE[tickType] : undefined;
  if (sizeTickType) emit(EventName.tickSize, tickerId, sizeTickType, size);
};

const tickSize: Decode = (r, emit) => {
  r.int(); // version
  const tickerId = r.int();
  const tickType = r.int();
  const size = r.decimal();
  emit(EventName.tickSize, tickerId, tickType, size);
};

const tickGeneric: Decode = (r, emit) => {
  r.int(); // version
  const tickerId = r.int();
  const tickType = r.int();
  const value = r.double();
  emit(EventName.tickGeneric, tickerId, tickType, value);
};

const tickString: Decode = (r, emit) => {
  r.int(); // version
  const tickerId = r.int();
  const tickType = r.int();
  const value = r.str();
  emit(EventName.tickString, tickerId, tickType, value);
};

const tickOptionComputation: Decode = (r, emit) => {
  const tickerId = r.int();
  const tickType = r.int();
  const tickAttrib = r.int();
  // -1 / -2 mean "not computed yet"
  const unset = (v: number | undefined, marker: number) => (v === marker ? undefined : v);
  const impliedVol = unset(r.double(), -1);
  const delta = unset(r.double(), -2);
  const optPrice = unset(r.double(), -1);
  const pvDividend = unset(r.double(), -1);
  const gamma = unset(r.double(), -2);
  const vega = unset(r.double(), -2);
  const theta = unset(r.double(), -2);
  const undPrice = unset(r.double(), -1);
  emit(EventName.tickOptionComputation, tickerId, tickType, tickAttrib, impliedVol, delta, optPrice, pvDividend, gamma, vega, theta, undPrice);
};

const tickSnapshotEnd: Decode = (r, emit) => {
  r.int(); // version
  emit(EventName.tickSnapshotEnd, r.int());
};

const tickReqParams: Decode = (r, emit) => {
  const tickerId = r.int();
  const minTick = r.double(); // @stoqey/ib reads an integer here (0 for "0.01"); EDecoder reads a double
  const bboExchange = r.str();
  const snapshotPermissions = r.int();
  emit(EventName.tickReqParams, tickerId, minTick, bboExchange, snapshotPermissions);
};

const marketDataType: Decode = (r, emit) => {
  r.int(); // version
  const reqId = r.int();
  const type = r.int();
  emit(EventName.marketDataType, reqId, type);
};

const rerouteMktData: Decode = (r, emit) => {
  const reqId = r.int();
  const conId = r.int();
  const exchange = r.str();
  emit(EventName.rerouteMktDataReq, reqId, conId, exchange);
};

const rerouteMktDepth: Decode = (r, emit) => {
  const reqId = r.int();
  const conId = r.int();
  const exchange = r.str();
  emit(EventName.rerouteMktDepthReq, reqId, conId, exchange);
};

const marketDepth: Decode = (r, emit) => {
  r.int(); // version
  const id = r.int();
  const position = r.int();
  const operation = r.int();
  const side = r.int();
  const price = r.double();
  const size = r.decimal();
  emit(EventName.updateMktDepth, id, position, operation, side, price, size);
};

const marketDepthL2: Decode = (r, emit) => {
  r.int(); // version
  const id = r.int();
  const position = r.int();
  const marketMaker = r.str();
  const operation = r.int();
  const side = r.int();
  const price = r.double();
  const size = r.decimal();
  const isSmartDepth = r.bool();
  emit(EventName.updateMktDepthL2, id, position, marketMaker, operation, side, price, size, isSmartDepth);
};

const mktDepthExchanges: Decode = (r, emit) => {
  const n = r.int();
  const list: DepthMktDataDescription[] = new Array(n);
  for (let i = 0; i < n; i++) {
    list[i] = { exchange: r.str(), secType: r.str(), listingExch: r.str(), serviceDataType: r.str(), aggGroup: r.intOrUndefined() };
  }
  emit(EventName.mktDepthExchanges, list);
};

const smartComponents: Decode = (r, emit) => {
  const reqId = r.int();
  const n = r.int();
  const map = new Map<number, [string, string]>();
  for (let i = 0; i < n; i++) {
    const bitNumber = r.int();
    const exchange = r.str();
    const exchangeLetter = r.str();
    map.set(bitNumber, [exchange, exchangeLetter]);
  }
  emit(EventName.smartComponents, reqId, map);
};

// ---------------------------------------------------------------------------
// Historical data

const historicalData: Decode = (r, emit) => {
  const reqId = r.int();
  const startDateStr = r.str();
  const endDateStr = r.str();
  // The end of the data set is reported as one more row (same as @stoqey/ib).
  const completedIndicator = `finished-${startDateStr}-${endDateStr}`;
  let itemCount = r.int();
  while (itemCount-- > 0) {
    const date = r.str();
    const open = r.double();
    const high = r.double();
    const low = r.double();
    const close = r.double();
    const volume = r.decimal();
    const WAP = r.decimal();
    const barCount = r.int();
    emit(EventName.historicalData, reqId, date, open, high, low, close, volume, barCount, WAP, undefined);
  }
  emit(EventName.historicalData, reqId, completedIndicator, -1, -1, -1, -1, -1, -1, -1, false);
};

const historicalDataUpdate: Decode = (r, emit) => {
  const reqId = r.int();
  const barCount = r.int();
  const date = r.str();
  const open = r.double();
  const close = r.double();
  const high = r.double();
  const low = r.double();
  const WAP = r.decimal();
  const volume = r.decimal();
  emit(EventName.historicalDataUpdate, reqId, date, open, high, low, close, volume, barCount, WAP);
};

const headTimestamp: Decode = (r, emit) => {
  const reqId = r.int();
  const ts = r.str();
  emit(EventName.headTimestamp, reqId, ts);
};

// ---------------------------------------------------------------------------
// Contracts

/**
 * lastTradeDateOrContractMonth of contract details, split like @stoqey/ib does: only a "-"
 * separates the date from the time, so "20261016 16:00:00 US/Eastern" is kept whole.
 */
function readLastTradeDate(r: Reader, details: ContractDetails, isBond: boolean): void {
  const value = r.str();
  if (!value.length) return;
  const split = value.indexOf('-') > 0 ? value.split('-') : [value];
  if (isBond) details.maturity = split[0];
  else details.contract.lastTradeDateOrContractMonth = split[0];
  if (split.length > 1) details.lastTradeTime = split[1];
  if (isBond && split.length > 2) details.timeZoneId = split[2];
}

function readSecIdList(r: Reader, details: ContractDetails): void {
  const n = r.int();
  if (n > 0) {
    details.secIdList = [];
    for (let i = 0; i < n; i++) {
      const tagValue: TagValue = { tag: r.str(), value: r.str() };
      details.secIdList.push(tagValue);
    }
  }
}

const contractData: Decode = (r, emit) => {
  const reqId = r.int();
  const details: ContractDetails = { contract: {} };
  const c = details.contract;
  c.symbol = r.str();
  c.secType = r.str() as SecType;
  readLastTradeDate(r, details, false);
  if (r.sv >= MIN_SERVER_VER.LAST_TRADE_DATE) c.lastTradeDate = r.str();
  c.strike = r.double();
  c.right = validateOptionType(r.str());
  c.exchange = r.str();
  c.currency = r.str();
  c.localSymbol = r.str();
  details.marketName = r.str();
  c.tradingClass = r.str();
  c.conId = r.int();
  details.minTick = r.double();
  c.multiplier = r.double();
  details.orderTypes = r.str();
  details.validExchanges = r.str();
  details.priceMagnifier = r.int();
  details.underConId = r.int();
  details.longName = r.str();
  c.primaryExch = r.str();
  details.longName = decodeUnicodeEscapedString(details.longName);
  details.contractMonth = r.str();
  details.industry = r.str();
  details.category = r.str();
  details.subcategory = r.str();
  details.timeZoneId = r.str();
  details.tradingHours = r.str();
  details.liquidHours = r.str();
  details.evRule = r.str();
  details.evMultiplier = r.double();
  readSecIdList(r, details);
  details.aggGroup = r.int();
  details.underSymbol = r.str();
  details.underSecType = r.str() as SecType;
  details.marketRuleIds = r.str();
  details.realExpirationDate = r.str();
  details.stockType = r.str();
  details.minSize = r.decimal();
  details.sizeIncrement = r.decimal();
  details.suggestedSizeIncrement = r.decimal();
  if (r.sv >= MIN_SERVER_VER.FUND_DATA_FIELDS && c.secType === SecType.FUND) {
    details.fundName = r.str();
    details.fundFamily = r.str();
    details.fundType = r.str();
    details.fundFrontLoad = r.str();
    details.fundBackLoad = r.str();
    details.fundBackLoadTimeInterval = r.str();
    details.fundManagementFee = r.str();
    details.fundClosed = r.bool();
    details.fundClosedForNewInvestors = r.bool();
    details.fundClosedForNewMoney = r.bool();
    details.fundNotifyAmount = r.str();
    details.fundMinimumInitialPurchase = r.str();
    details.fundSubsequentMinimumPurchase = r.str();
    details.fundBlueSkyStates = r.str();
    details.fundBlueSkyTerritories = r.str();
    details.fundDistributionPolicyIndicator = r.str();
    details.fundAssetType = r.str();
  }
  if (r.sv >= MIN_SERVER_VER.INELIGIBILITY_REASONS) {
    const n = r.int();
    const list = [];
    for (let i = 0; i < n; i++) {
      const id = r.str();
      const description = r.str();
      list.push({ id, description });
    }
    details.ineligibilityReasonList = list;
  }
  emit(EventName.contractDetails, reqId, details);
};

const bondContractData: Decode = (r, emit) => {
  const reqId = r.int();
  const details: ContractDetails = { contract: {} };
  const c = details.contract;
  c.symbol = r.str();
  c.secType = r.str() as SecType;
  details.cusip = r.str();
  details.coupon = r.double();
  readLastTradeDate(r, details, true);
  details.issueDate = r.str();
  details.ratings = r.str();
  details.bondType = r.str();
  details.couponType = r.str();
  details.convertible = r.bool();
  details.callable = r.bool();
  details.putable = r.bool();
  details.descAppend = r.str();
  c.exchange = r.str();
  c.currency = r.str();
  details.marketName = r.str();
  c.tradingClass = r.str();
  c.conId = r.int();
  details.minTick = r.double();
  details.orderTypes = r.str();
  details.validExchanges = r.str();
  details.nextOptionDate = r.str();
  details.nextOptionType = r.str();
  details.nextOptionPartial = r.bool();
  details.notes = r.str();
  details.longName = r.str();
  if (r.sv >= MIN_SERVER_VER.BOND_TRADING_HOURS) {
    details.timeZoneId = r.str();
    details.tradingHours = r.str();
    details.liquidHours = r.str();
  }
  details.evRule = r.str();
  details.evMultiplier = r.double();
  readSecIdList(r, details);
  details.aggGroup = r.int();
  details.marketRuleIds = r.str();
  details.minSize = r.decimal();
  details.sizeIncrement = r.decimal();
  details.suggestedSizeIncrement = r.decimal();
  emit(EventName.bondContractDetails, reqId, details);
};

const contractDataEnd: Decode = (r, emit) => {
  r.int(); // version
  emit(EventName.contractDetailsEnd, r.int());
};

const symbolSamples: Decode = (r, emit) => {
  const reqId = r.int();
  const n = r.int();
  const list: ContractDescription[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const contract: Contract = {
      conId: r.int(),
      symbol: r.str(),
      secType: r.str() as SecType,
      primaryExch: r.str(),
      currency: r.str(),
    };
    const nTypes = r.int();
    const derivativeSecTypes: SecType[] = new Array(nTypes);
    for (let j = 0; j < nTypes; j++) derivativeSecTypes[j] = r.str() as SecType;
    contract.description = r.str();
    contract.issuerId = r.str();
    list[i] = { contract, derivativeSecTypes };
  }
  emit(EventName.symbolSamples, reqId, list);
};

const secDefOptParameter: Decode = (r, emit) => {
  const reqId = r.int();
  const exchange = r.str();
  const underlyingConId = r.int();
  const tradingClass = r.str();
  const multiplier = r.double(); // a number, as @stoqey/ib reports it
  const expCount = r.int();
  const expirations: string[] = [];
  for (let i = 0; i < expCount; i++) expirations.push(r.str());
  const strikeCount = r.int();
  const strikes: number[] = [];
  for (let i = 0; i < strikeCount; i++) {
    const strike = r.double();
    if (strike !== undefined) strikes.push(strike);
  }
  emit(EventName.securityDefinitionOptionParameter, reqId, exchange, underlyingConId, tradingClass, multiplier, expirations, strikes);
};

const secDefOptParameterEnd: Decode = (r, emit) => {
  emit(EventName.securityDefinitionOptionParameterEnd, r.int());
};

// ---------------------------------------------------------------------------
// Account and portfolio

const acctValue: Decode = (r, emit) => {
  r.int(); // version
  const key = r.str();
  const value = r.str();
  const currency = r.str();
  const accountName = r.str();
  emit(EventName.updateAccountValue, key, value, currency, accountName);
};

const portfolioValue: Decode = (r, emit) => {
  const version = r.int();
  const contract: Contract = {};
  if (version >= 6) contract.conId = r.int();
  contract.symbol = r.str();
  contract.secType = r.str() as SecType;
  contract.lastTradeDateOrContractMonth = r.str();
  contract.strike = r.double();
  contract.right = validateOptionType(r.str());
  if (version >= 7) {
    contract.multiplier = r.double();
    contract.primaryExch = r.str();
  }
  contract.currency = r.str();
  if (version >= 2) contract.localSymbol = r.str();
  if (version >= 8) contract.tradingClass = r.str();
  const position = r.decimal();
  const marketPrice = r.double();
  const marketValue = r.double();
  let averageCost: number | undefined;
  let unrealizedPNL: number | undefined;
  let realizedPNL: number | undefined;
  if (version >= 3) {
    averageCost = r.double();
    unrealizedPNL = r.double();
    realizedPNL = r.double();
  }
  let accountName: string | undefined;
  if (version >= 4) accountName = r.str();
  emit(EventName.updatePortfolio, contract, position, marketPrice, marketValue, averageCost, unrealizedPNL, realizedPNL, accountName);
};

const acctUpdateTime: Decode = (r, emit) => {
  r.int(); // version
  emit(EventName.updateAccountTime, r.str());
};

const acctDownloadEnd: Decode = (r, emit) => {
  r.int(); // version
  emit(EventName.accountDownloadEnd, r.str());
};

const accountSummary: Decode = (r, emit) => {
  r.int(); // version
  const reqId = r.int();
  const account = r.str();
  const tag = r.str();
  const value = r.str();
  const currency = r.str();
  emit(EventName.accountSummary, reqId, account, tag, value, currency);
};

const accountSummaryEnd: Decode = (r, emit) => {
  r.int(); // version
  emit(EventName.accountSummaryEnd, r.int());
};

const position: Decode = (r, emit) => {
  const version = r.int();
  const account = r.str();
  const contract: Contract = {};
  contract.conId = r.int();
  contract.symbol = r.str();
  contract.secType = r.str() as SecType;
  contract.lastTradeDateOrContractMonth = r.str();
  contract.strike = r.double();
  contract.right = validateOptionType(r.str());
  contract.multiplier = r.double();
  contract.exchange = r.str();
  contract.currency = r.str();
  contract.localSymbol = r.str();
  if (version >= 2) contract.tradingClass = r.str();
  const pos = r.decimal();
  let avgCost: number | undefined = 0;
  if (version >= 3) avgCost = r.double();
  emit(EventName.position, account, contract, pos, avgCost);
};

const positionEnd: Decode = (r, emit) => {
  r.int(); // version
  emit(EventName.positionEnd);
};

const pnl: Decode = (r, emit) => {
  const reqId = r.int();
  const dailyPnL = r.double();
  const unrealizedPnL = r.double();
  const realizedPnL = r.double();
  emit(EventName.pnl, reqId, dailyPnL, unrealizedPnL, realizedPnL);
};

const pnlSingle: Decode = (r, emit) => {
  const reqId = r.int();
  const pos = r.decimal();
  const dailyPnL = r.double();
  const unrealizedPnL = r.double();
  const realizedPnL = r.double();
  const value = r.double();
  emit(EventName.pnlSingle, reqId, pos, dailyPnL, unrealizedPnL, realizedPnL, value);
};

// ---------------------------------------------------------------------------
// Connection

const nextValidId: Decode = (r, emit) => {
  r.int(); // version
  emit(EventName.nextValidId, r.int());
};

const managedAccts: Decode = (r, emit) => {
  r.int(); // version
  emit(EventName.managedAccounts, r.str());
};

const currentTime: Decode = (r, emit) => {
  r.int(); // version
  emit(EventName.currentTime, r.int());
};

/**
 * ERR_MSG: messages without a request id (-1) are reported as `info`, all others as `error`
 * (the routing of @stoqey/ib, e.g. 2104 "farm connection is OK" arrives as info).
 */
const errMsg: Decode = (r, emit) => {
  const version = r.int();
  if (version < 2) {
    emit(EventName.error, new Error(r.str()), ErrorCode.UNKNOWN_ID, ErrorCode.NO_VALID_ID, undefined);
    return;
  }
  const id = r.int();
  const code = r.int();
  const msg = decodeUnicodeEscapedString(r.str());
  let advancedOrderReject: unknown;
  const json = r.str();
  if (json.length > 0) {
    const text = decodeUnicodeEscapedString(json);
    try {
      advancedOrderReject = JSON.parse(text);
    } catch {
      advancedOrderReject = text; // keep malformed JSON as text instead of failing the frame
    }
  }
  if (id === ErrorCode.NO_VALID_ID) emit(EventName.info, msg, code);
  else emit(EventName.error, new Error(msg), code, id, advancedOrderReject);
};

// ---------------------------------------------------------------------------
// Orders

const orderStatus: Decode = (r, emit) => {
  const id = r.int();
  const status = r.str();
  const filled = r.decimal();
  const remaining = r.decimal();
  const avgFillPrice = r.double();
  const permId = r.int();
  const parentId = r.int();
  const lastFillPrice = r.double();
  const clientId = r.int();
  const whyHeld = r.str();
  const mktCapPrice = r.double();
  emit(EventName.orderStatus, id, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld, mktCapPrice);
};

/** Port of EOrderDecoder: fields shared by openOrder and completedOrder. */
class OrderReader {
  readonly r: Reader;
  readonly contract: Contract = {};
  readonly order: Order = { orderType: OrderType.MKT }; // overwritten by readOrderType()
  readonly state: OrderState = { status: OrderStatus.Unknown };

  constructor(r: Reader) {
    this.r = r;
  }

  contractFields(): void {
    const { r, contract: c } = this;
    c.conId = r.int();
    c.symbol = r.str();
    c.secType = r.str() as SecType;
    c.lastTradeDateOrContractMonth = r.str();
    c.strike = r.double();
    c.right = validateOptionType(r.str());
    c.multiplier = +r.str();
    c.exchange = r.str();
    c.currency = r.str();
    c.localSymbol = r.str();
    c.tradingClass = r.str();
  }

  /** action .. orderRef (common start of the order fields). */
  orderBasics(): void {
    const { r, order: o } = this;
    o.action = r.str() as Order['action'];
    o.totalQuantity = r.decimal();
    o.orderType = r.str() as OrderType;
    o.lmtPrice = r.doubleOrUndefined();
    o.auxPrice = r.doubleOrUndefined();
    o.tif = r.str() as Order['tif'];
    o.ocaGroup = r.str();
    o.account = r.str();
    o.openClose = r.str();
    o.origin = r.int();
    o.orderRef = r.str();
  }

  permIdToGoodAfterTime(): void {
    const { r, order: o } = this;
    o.permId = r.int();
    o.outsideRth = r.bool();
    o.hidden = r.int() === 1;
    o.discretionaryAmt = r.double();
    o.goodAfterTime = r.str();
  }

  faParams(): void {
    const { r, order: o } = this;
    o.faGroup = r.str();
    o.faMethod = r.str();
    o.faPercentage = r.str();
    // EOrderDecoder tests the server version here (for openOrder and completedOrder alike).
    if (r.sv < MIN_SERVER_VER.FA_PROFILE_DESUPPORT) o.faProfile = r.str();
  }

  /** modelCode .. stockRangeUpper. */
  modelCodeToStockRange(auctionStrategy: boolean): void {
    const { r, order: o } = this;
    o.modelCode = r.str();
    o.goodTillDate = r.str();
    o.rule80A = r.str();
    o.percentOffset = r.doubleOrUndefined();
    o.settlingFirm = r.str();
    o.shortSaleSlot = r.int();
    o.designatedLocation = r.str();
    o.exemptCode = r.int();
    if (auctionStrategy) o.auctionStrategy = r.int();
    o.startingPrice = r.doubleOrUndefined();
    o.stockRefPrice = r.doubleOrUndefined();
    o.delta = r.doubleOrUndefined();
    o.stockRangeLower = r.doubleOrUndefined();
    o.stockRangeUpper = r.doubleOrUndefined();
  }

  volOrderParams(readOpenOrderAttribs: boolean): void {
    const { r, order: o } = this;
    o.volatility = r.doubleOrUndefined();
    o.volatilityType = r.int();
    o.deltaNeutralOrderType = r.str();
    o.deltaNeutralAuxPrice = r.doubleOrUndefined();
    if (o.deltaNeutralOrderType) {
      o.deltaNeutralConId = r.int();
      if (readOpenOrderAttribs) {
        o.deltaNeutralSettlingFirm = r.str();
        o.deltaNeutralClearingAccount = r.str();
        o.deltaNeutralClearingIntent = r.str();
      }
    }
    if (o.deltaNeutralOrderType) {
      if (readOpenOrderAttribs) o.deltaNeutralOpenClose = r.str();
      o.deltaNeutralShortSale = r.bool();
      o.deltaNeutralShortSaleSlot = r.int();
      o.deltaNeutralDesignatedLocation = r.str();
    }
    o.continuousUpdate = r.int();
    o.referencePriceType = r.int();
  }

  trailParams(): void {
    this.order.trailStopPrice = this.r.doubleOrUndefined();
    this.order.trailingPercent = this.r.doubleOrUndefined();
  }

  comboLegs(): void {
    const { r, contract: c, order: o } = this;
    c.comboLegsDescription = r.str();
    const n = r.int();
    if (n > 0) {
      c.comboLegs = [];
      for (let i = 0; i < n; i++) {
        const conId = r.int();
        const ratio = r.int();
        const action = r.str() as Order['action'];
        const exchange = r.str();
        const openClose = r.int();
        const shortSaleSlot = r.int();
        const designatedLocation = r.str();
        const exemptCode = r.int();
        c.comboLegs.push({ conId, ratio, action, exchange, openClose, shortSaleSlot, designatedLocation, exemptCode });
      }
    }
    const nOrderLegs = r.int();
    if (nOrderLegs > 0) {
      o.orderComboLegs = [];
      for (let i = 0; i < nOrderLegs; i++) o.orderComboLegs.push({ price: r.doubleOrUndefined() });
    }
  }

  smartComboRoutingParams(): void {
    const { r, order: o } = this;
    const n = r.int();
    if (n > 0) {
      o.smartComboRoutingParams = [];
      for (let i = 0; i < n; i++) {
        const tag = r.str();
        const value = r.str();
        o.smartComboRoutingParams.push({ tag, value });
      }
    }
  }

  scaleOrderParams(): void {
    const { r, order: o } = this;
    o.scaleInitLevelSize = r.intOrUndefined();
    o.scaleSubsLevelSize = r.intOrUndefined();
    o.scalePriceIncrement = r.doubleOrUndefined();
    if (o.scalePriceIncrement && o.scalePriceIncrement > 0) {
      o.scalePriceAdjustValue = r.doubleOrUndefined();
      o.scalePriceAdjustInterval = r.intOrUndefined();
      o.scaleProfitOffset = r.doubleOrUndefined();
      o.scaleAutoReset = r.bool();
      o.scaleInitPosition = r.intOrUndefined();
      o.scaleInitFillQty = r.intOrUndefined();
      o.scaleRandomPercent = r.bool();
    }
  }

  hedgeParams(): void {
    const { r, order: o } = this;
    o.hedgeType = r.str();
    if (o.hedgeType) o.hedgeParam = r.str();
  }

  clearingParams(): void {
    this.order.clearingAccount = this.r.str();
    this.order.clearingIntent = this.r.str();
  }

  deltaNeutral(): void {
    const r = this.r;
    if (r.bool()) {
      const conId = r.int();
      const delta = r.double() as number;
      const price = r.double() as number;
      this.contract.deltaNeutralContract = { conId, delta, price };
    }
  }

  algoParams(): void {
    const { r, order: o } = this;
    o.algoStrategy = r.str();
    if (o.algoStrategy) {
      const n = r.int();
      if (n > 0) {
        o.algoParams = [];
        for (let i = 0; i < n; i++) {
          const tag = r.str();
          const value = r.str();
          o.algoParams.push({ tag, value });
        }
      }
    }
  }

  orderStatus(): void {
    this.state.status = this.r.str() as OrderStatusT;
  }

  whatIfInfoAndCommission(): void {
    const { r, state: s } = this;
    this.order.whatIf = r.bool();
    this.orderStatus();
    s.initMarginBefore = r.doubleOrUndefined();
    s.maintMarginBefore = r.doubleOrUndefined();
    s.equityWithLoanBefore = r.doubleOrUndefined();
    s.initMarginChange = r.doubleOrUndefined();
    s.maintMarginChange = r.doubleOrUndefined();
    s.equityWithLoanChange = r.doubleOrUndefined();
    s.initMarginAfter = r.doubleOrUndefined();
    s.maintMarginAfter = r.doubleOrUndefined();
    s.equityWithLoanAfter = r.doubleOrUndefined();
    s.commission = r.doubleOrUndefined();
    s.minCommission = r.doubleOrUndefined();
    s.maxCommission = r.doubleOrUndefined();
    s.commissionCurrency = r.str();
    s.warningText = r.str();
  }

  volRandomizeFlags(): void {
    this.order.randomizeSize = this.r.bool();
    this.order.randomizePrice = this.r.bool();
  }

  pegToBenchParams(): void {
    const { r, order: o } = this;
    if (isPegBenchOrder(o.orderType)) {
      o.referenceContractId = r.int();
      o.isPeggedChangeAmountDecrease = r.bool();
      o.peggedChangeAmount = r.double();
      o.referenceChangeAmount = r.double();
      o.referenceExchangeId = r.str();
    }
  }

  conditions(): void {
    const { r, order: o } = this;
    const n = r.int();
    if (n <= 0) return;
    const conditions: OrderCondition[] = new Array(n);
    o.conditions = conditions;
    for (let i = 0; i < n; i++) {
      const type = r.int();
      const conjunction = r.str()?.toLocaleLowerCase() as ConjunctionConnection;
      switch (type) {
        case OrderConditionType.Execution: {
          const secType = r.str();
          const exchange = r.str();
          const symbol = r.str();
          conditions[i] = new ExecutionCondition(exchange, secType, symbol, conjunction);
          break;
        }
        case OrderConditionType.Margin: {
          const isMore = r.bool();
          const value = r.int();
          conditions[i] = new MarginCondition(value, isMore, conjunction);
          break;
        }
        case OrderConditionType.PercentChange: {
          const isMore = r.bool();
          const value = r.double() as number;
          const conId = r.int();
          const exchange = r.str();
          conditions[i] = new PercentChangeCondition(value, conId, exchange, isMore, conjunction);
          break;
        }
        case OrderConditionType.Price: {
          const isMore = r.bool();
          const value = r.double() as number;
          const conId = r.int();
          const exchange = r.str();
          const triggerMethod = r.int() as PriceCondition['triggerMethod'];
          conditions[i] = new PriceCondition(value, triggerMethod, conId, exchange, isMore, conjunction);
          break;
        }
        case OrderConditionType.Time: {
          const isMore = r.bool();
          const value = r.str();
          conditions[i] = new TimeCondition(value, isMore, conjunction);
          break;
        }
        case OrderConditionType.Volume: {
          const isMore = r.bool();
          const value = r.int();
          const conId = r.int();
          const exchange = r.str();
          conditions[i] = new VolumeCondition(value, conId, exchange, isMore, conjunction);
          break;
        }
      }
    }
    o.conditionsIgnoreRth = r.bool();
    o.conditionsCancelOrder = r.bool();
  }

  stopPriceAndLmtPriceOffset(): void {
    this.order.trailStopPrice = this.r.doubleOrUndefined();
    this.order.lmtPriceOffset = this.r.doubleOrUndefined();
  }

  pegBestPegMidOrderAttributes(): void {
    const { r, order: o } = this;
    o.minTradeQty = r.intOrUndefined();
    o.minCompeteSize = r.intOrUndefined();
    o.competeAgainstBestOffset = r.doubleOrUndefined();
    o.midOffsetAtWhole = r.doubleOrUndefined();
    o.midOffsetAtHalf = r.doubleOrUndefined();
  }

  customerAccountAndProfessional(): void {
    const { r, order: o } = this;
    if (r.sv >= MIN_SERVER_VER.CUSTOMER_ACCOUNT) o.customerAccount = r.str();
    if (r.sv >= MIN_SERVER_VER.PROFESSIONAL_CUSTOMER) o.professionalCustomer = r.bool();
  }
}

const openOrder: Decode = (r, emit) => {
  const d = new OrderReader(r);
  const { order: o } = d;
  o.orderId = r.int();
  d.contractFields();
  d.orderBasics();
  o.clientId = r.int();
  d.permIdToGoodAfterTime();
  r.str(); // deprecated sharesAllocation
  d.faParams();
  d.modelCodeToStockRange(true);
  o.displaySize = r.intOrUndefined();
  o.blockOrder = r.bool();
  o.sweepToFill = r.bool();
  o.allOrNone = r.bool();
  o.minQty = r.intOrUndefined();
  o.ocaType = r.int();
  o.eTradeOnly = r.bool();
  o.firmQuoteOnly = r.bool();
  o.nbboPriceCap = r.doubleOrUndefined();
  o.parentId = r.int();
  o.triggerMethod = r.int();
  d.volOrderParams(true);
  d.trailParams();
  o.basisPoints = r.doubleOrUndefined();
  o.basisPointsType = r.intOrUndefined();
  d.comboLegs();
  d.smartComboRoutingParams();
  d.scaleOrderParams();
  d.hedgeParams();
  o.optOutSmartRouting = r.bool();
  d.clearingParams();
  o.notHeld = r.bool();
  d.deltaNeutral();
  d.algoParams();
  o.solicited = r.bool();
  d.whatIfInfoAndCommission();
  d.volRandomizeFlags();
  d.pegToBenchParams();
  d.conditions();
  // adjusted order params
  o.adjustedOrderType = r.str();
  o.triggerPrice = r.doubleOrUndefined();
  d.stopPriceAndLmtPriceOffset();
  o.adjustedStopPrice = r.doubleOrUndefined();
  o.adjustedStopLimitPrice = r.doubleOrUndefined();
  o.adjustedTrailingAmount = r.doubleOrUndefined();
  o.adjustableTrailingUnit = r.int();
  // soft dollar tier
  const name = r.str();
  const value = r.str();
  const displayName = r.str();
  o.softDollarTier = { name, value, displayName };
  o.cashQty = r.doubleOrUndefined();
  o.dontUseAutoPriceForHedge = r.bool();
  o.isOmsContainer = r.bool();
  o.discretionaryUpToLimitPrice = r.bool();
  o.usePriceMgmtAlgo = r.bool();
  o.duration = r.int();
  o.postToAts = r.intOrUndefined();
  o.autoCancelParent = r.bool();
  d.pegBestPegMidOrderAttributes();
  d.customerAccountAndProfessional();
  if (r.sv >= MIN_SERVER_VER.BOND_ACCRUED_INTEREST) o.bondAccruedInterest = r.str();
  if (r.sv >= MIN_SERVER_VER.INCLUDE_OVERNIGHT) o.includeOvernight = r.bool();
  if (r.sv >= MIN_SERVER_VER.CME_TAGGING_FIELDS_IN_OPEN_ORDER) {
    o.extOperator = r.str();
    o.manualOrderIndicator = r.intOrUndefined();
  }
  emit(EventName.openOrder, o.orderId, d.contract, o, d.state);
};

const openOrderEnd: Decode = (r, emit) => {
  r.int(); // version
  emit(EventName.openOrderEnd);
};

const completedOrder: Decode = (r, emit) => {
  const d = new OrderReader(r);
  const { order: o, state: s } = d;
  d.contractFields();
  d.orderBasics();
  d.permIdToGoodAfterTime();
  d.faParams();
  d.modelCodeToStockRange(false);
  o.displaySize = r.intOrUndefined();
  o.sweepToFill = r.bool();
  o.allOrNone = r.bool();
  o.minQty = r.intOrUndefined();
  o.ocaType = r.int();
  o.triggerMethod = r.int();
  d.volOrderParams(false);
  d.trailParams();
  d.comboLegs();
  d.smartComboRoutingParams();
  d.scaleOrderParams();
  d.hedgeParams();
  d.clearingParams();
  o.notHeld = r.bool();
  d.deltaNeutral();
  d.algoParams();
  o.solicited = r.bool();
  d.orderStatus();
  d.volRandomizeFlags();
  d.pegToBenchParams();
  d.conditions();
  d.stopPriceAndLmtPriceOffset();
  o.cashQty = r.doubleOrUndefined();
  o.dontUseAutoPriceForHedge = r.bool();
  o.isOmsContainer = r.bool();
  o.autoCancelDate = r.str();
  o.filledQuantity = r.decimal();
  o.refFuturesConId = r.int();
  o.autoCancelParent = r.bool();
  o.shareholder = r.str();
  o.imbalanceOnly = r.bool();
  o.routeMarketableToBbo = r.bool();
  o.parentPermId = r.int();
  s.completedTime = r.str();
  s.completedStatus = r.str();
  d.pegBestPegMidOrderAttributes();
  d.customerAccountAndProfessional();
  emit(EventName.completedOrder, d.contract, o, s);
};

const completedOrdersEnd: Decode = (_r, emit) => {
  emit(EventName.completedOrdersEnd);
};

const orderBound: Decode = (r, emit) => {
  const permId = r.int();
  const clientId = r.double();
  const orderId = r.int();
  emit(EventName.orderBound, permId, clientId, orderId);
};

const executionData: Decode = (r, emit) => {
  const reqId = r.int();
  const orderId = r.int();
  const contract: Contract = {};
  contract.conId = r.int();
  contract.symbol = r.str();
  contract.secType = r.str() as SecType;
  contract.lastTradeDateOrContractMonth = r.str();
  contract.strike = r.double();
  contract.right = validateOptionType(r.str());
  contract.multiplier = r.double();
  contract.exchange = r.str();
  contract.currency = r.str();
  contract.localSymbol = r.str();
  contract.tradingClass = r.str();
  const exec: Execution = {};
  exec.orderId = orderId;
  exec.execId = r.str();
  exec.time = r.str();
  exec.acctNumber = r.str();
  exec.exchange = r.str();
  exec.side = r.str();
  exec.shares = r.decimal();
  exec.price = r.double();
  exec.permId = r.int();
  exec.clientId = r.int();
  exec.liquidation = r.int();
  exec.cumQty = r.decimal();
  exec.avgPrice = r.double();
  exec.orderRef = r.str();
  exec.evRule = r.str();
  exec.evMultiplier = r.double();
  exec.modelCode = r.str();
  exec.lastLiquidity = r.int() as Execution['lastLiquidity'];
  if (r.sv >= MIN_SERVER_VER.PENDING_PRICE_REVISION) exec.pendingPriceRevision = r.bool();
  emit(EventName.execDetails, reqId, contract, exec);
};

const executionDataEnd: Decode = (r, emit) => {
  r.int(); // version
  emit(EventName.execDetailsEnd, r.int());
};

const commissionReport: Decode = (r, emit) => {
  r.int(); // version
  const report: CommissionReport = {};
  report.execId = r.str();
  report.commission = r.double();
  report.currency = r.str();
  report.realizedPNL = r.double();
  report.yield = r.double();
  report.yieldRedemptionDate = r.int();
  emit(EventName.commissionReport, report);
};

// ---------------------------------------------------------------------------
// Wall Street Horizon

const wshMetaData: Decode = (r, emit) => {
  const reqId = r.int();
  const dataJson = r.str();
  emit(EventName.wshMetaData, reqId, dataJson);
};

const wshEventData: Decode = (r, emit) => {
  const reqId = r.int();
  const dataJson = r.str();
  emit(EventName.wshEventData, reqId, dataJson);
};

// ---------------------------------------------------------------------------
// Market scanner

/**
 * One snapshot of a scan: a scannerData event per row (rank order), then scannerDataEnd. IB sends
 * no separate end message; an empty snapshot is a count of 0. Version 3 (every server Tape
 * supports) carries the conId and the legs: 16 fields per row.
 */
const scannerData: Decode = (r, emit) => {
  const version = r.int();
  const reqId = r.int();
  const n = r.int();
  for (let i = 0; i < n; i++) {
    const rank = r.int();
    const contract: Contract = {};
    if (version >= 3) contract.conId = r.int();
    contract.symbol = r.str();
    contract.secType = r.str() as SecType;
    contract.lastTradeDateOrContractMonth = r.str();
    contract.strike = r.double();
    contract.right = validateOptionType(r.str());
    contract.exchange = r.str();
    contract.currency = r.str();
    contract.localSymbol = r.str();
    const marketName = r.str();
    contract.tradingClass = r.str();
    const distance = r.str();
    const benchmark = r.str();
    const projection = r.str();
    const legsStr = version >= 2 ? r.str() : undefined;
    const details: ContractDetails = { contract, marketName };
    emit(EventName.scannerData, reqId, rank, details, distance, benchmark, projection, legsStr);
  }
  emit(EventName.scannerDataEnd, reqId);
};

// ---------------------------------------------------------------------------

const DECODERS: ReadonlyMap<number, Decode> = new Map<number, Decode>([
  [IN_MSG_ID.TICK_PRICE, tickPrice],
  [IN_MSG_ID.TICK_SIZE, tickSize],
  [IN_MSG_ID.ORDER_STATUS, orderStatus],
  [IN_MSG_ID.ERR_MSG, errMsg],
  [IN_MSG_ID.OPEN_ORDER, openOrder],
  [IN_MSG_ID.ACCT_VALUE, acctValue],
  [IN_MSG_ID.PORTFOLIO_VALUE, portfolioValue],
  [IN_MSG_ID.ACCT_UPDATE_TIME, acctUpdateTime],
  [IN_MSG_ID.NEXT_VALID_ID, nextValidId],
  [IN_MSG_ID.CONTRACT_DATA, contractData],
  [IN_MSG_ID.EXECUTION_DATA, executionData],
  [IN_MSG_ID.MARKET_DEPTH, marketDepth],
  [IN_MSG_ID.MARKET_DEPTH_L2, marketDepthL2],
  [IN_MSG_ID.MANAGED_ACCTS, managedAccts],
  [IN_MSG_ID.HISTORICAL_DATA, historicalData],
  [IN_MSG_ID.BOND_CONTRACT_DATA, bondContractData],
  [IN_MSG_ID.TICK_OPTION_COMPUTATION, tickOptionComputation],
  [IN_MSG_ID.TICK_GENERIC, tickGeneric],
  [IN_MSG_ID.TICK_STRING, tickString],
  [IN_MSG_ID.CURRENT_TIME, currentTime],
  [IN_MSG_ID.CONTRACT_DATA_END, contractDataEnd],
  [IN_MSG_ID.OPEN_ORDER_END, openOrderEnd],
  [IN_MSG_ID.ACCT_DOWNLOAD_END, acctDownloadEnd],
  [IN_MSG_ID.EXECUTION_DATA_END, executionDataEnd],
  [IN_MSG_ID.TICK_SNAPSHOT_END, tickSnapshotEnd],
  [IN_MSG_ID.MARKET_DATA_TYPE, marketDataType],
  [IN_MSG_ID.COMMISSION_REPORT, commissionReport],
  [IN_MSG_ID.POSITION, position],
  [IN_MSG_ID.POSITION_END, positionEnd],
  [IN_MSG_ID.ACCOUNT_SUMMARY, accountSummary],
  [IN_MSG_ID.ACCOUNT_SUMMARY_END, accountSummaryEnd],
  [IN_MSG_ID.SECURITY_DEFINITION_OPTION_PARAMETER, secDefOptParameter],
  [IN_MSG_ID.SECURITY_DEFINITION_OPTION_PARAMETER_END, secDefOptParameterEnd],
  [IN_MSG_ID.SYMBOL_SAMPLES, symbolSamples],
  [IN_MSG_ID.MKT_DEPTH_EXCHANGES, mktDepthExchanges],
  [IN_MSG_ID.TICK_REQ_PARAMS, tickReqParams],
  [IN_MSG_ID.SMART_COMPONENTS, smartComponents],
  [IN_MSG_ID.HEAD_TIMESTAMP, headTimestamp],
  [IN_MSG_ID.HISTORICAL_DATA_UPDATE, historicalDataUpdate],
  [IN_MSG_ID.REROUTE_MKT_DATA, rerouteMktData],
  [IN_MSG_ID.REROUTE_MKT_DEPTH, rerouteMktDepth],
  [IN_MSG_ID.PNL, pnl],
  [IN_MSG_ID.PNL_SINGLE, pnlSingle],
  [IN_MSG_ID.ORDER_BOUND, orderBound],
  [IN_MSG_ID.COMPLETED_ORDER, completedOrder],
  [IN_MSG_ID.COMPLETED_ORDERS_END, completedOrdersEnd],
  [IN_MSG_ID.WSH_META_DATA, wshMetaData],
  [IN_MSG_ID.WSH_EVENT_DATA, wshEventData],
  [IN_MSG_ID.SCANNER_DATA, scannerData],
]);

/** True when decodeMessage() understands the message id (others are skipped). */
export const isDecodedMessage = (msgId: number): boolean => DECODERS.has(msgId);

/**
 * Decodes the fields of one incoming frame (after the handshake) into the events to emit,
 * in order. Problems are reported as `error` events with code 505 (UNKNOWN_ID), like
 * @stoqey/ib: a truncated frame yields only that error; unexpected trailing fields yield the
 * error followed by the decoded events. Unknown message ids yield no events.
 */
export function decodeMessage(fields: readonly string[], serverVersion: number): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  const r = new Reader(fields, serverVersion);
  let msgId = IN_MSG_ID.UNDEFINED as number;
  const name = () => IN_MSG_ID[msgId] ?? String(msgId);
  try {
    msgId = r.int();
    const decode = DECODERS.get(msgId);
    if (!decode) return [];
    decode(r, (event, ...args) => void events.push({ name: event, args }));
  } catch (err) {
    if (!(err instanceof UnderrunError)) throw err;
    return [errorEvent(`Underrun error on ${name()}: ${err.message}`)];
  }
  if (r.pos < fields.length) {
    events.unshift(errorEvent(`Decoding error on ${name()}: unprocessed data left on queue (${JSON.stringify(r.remaining)}).`));
  }
  return events;
}

const errorEvent = (message: string): DecodedEvent => ({
  name: EventName.error,
  args: [new Error(message), ErrorCode.UNKNOWN_ID, ErrorCode.NO_VALID_ID, undefined],
});

/** Server version and connection time of the first frame after the handshake. */
export function decodeServerVersion(fields: readonly string[]): { serverVersion: number; connTime: string } {
  return { serverVersion: parseInt(fields[0] ?? '', 10), connTime: fields[1] ?? '' };
}

/** Tick type names, for logs. */
export const tickTypeName = (id: number): string => TickType[id] ?? String(id);
