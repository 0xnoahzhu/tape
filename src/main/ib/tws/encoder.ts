// Outgoing messages: pure functions turning a request into the token array of one frame.
//
// Tokens are what the `sent` event reports: nested arrays flattened, booleans converted to
// 1 / 0, numbers and strings as given and undefined / null kept (they are sent as empty
// fields). The field order is the one of IB's EClient for server versions 176..193; branches
// for older servers are unconditional. Requests the server version cannot carry throw a
// TwsEncodeError, which the client reports as an `error` event (nothing is sent).
//
// Wire format follows the IB TWS API (EClient/EDecoder). Portions derived from @stoqey/ib (MIT, Copyright (c) the @stoqey/ib authors)

import { isPegBenchOrder, isPegBestOrder, isPegMidOrder, COMPETE_AGAINST_BEST_OFFSET_UP_TO_MID, OrderConditionType } from './enums.ts';
import { ErrorCode, TwsEncodeError } from './errors.ts';
import { MIN_SERVER_VER, OUT_MSG_ID } from './messageIds.ts';
import type { ComboLeg, Contract, ExecutionFilter, Order, OrderCancel, OrderCondition, ScannerSubscription, TagValue, WshEventData } from './types.ts';

/** One field of an outgoing frame. undefined and null are sent as empty fields. */
export type Token = string | number | undefined | null;

/** Integer.MAX_VALUE: "unset" for integer fields. */
const INT_MAX = 2147483647;

/** Number.MAX_VALUE was the "unset" marker of older @stoqey/ib versions; it is sent as empty. */
const nullifyMax = (n: number | undefined): number | undefined => (n === Number.MAX_VALUE ? undefined : n);

const isBag = (contract: Contract): boolean => contract.secType?.toUpperCase() === 'BAG';

/** "tag1=value1;tag2=value2;" (the encoding of TagValue lists in EClient). */
export function encodeTagValues(tagValues: readonly TagValue[] | undefined | null): string {
  let result = '';
  tagValues?.forEach((tv) => {
    result += `${tv.tag}=${tv.value};`;
  });
  return result;
}

/** Flattens nested arrays and converts booleans to 1 / 0 (what the socket layer sends). */
export function toTokens(values: readonly unknown[]): Token[] {
  const out: Token[] = [];
  const walk = (list: readonly unknown[]): void => {
    for (const v of list) {
      if (Array.isArray(v)) walk(v);
      else if (v === true || v === false || v instanceof Boolean) out.push(v.valueOf() ? 1 : 0);
      else out.push(v as Token);
    }
  };
  walk(values);
  return out;
}

/** The text of a frame: fields joined by NUL (undefined / null become empty fields). */
export const frameText = (tokens: readonly Token[]): string => tokens.join('\0');

/**
 * Refuses a frame with a control character in a text field: a NUL would split the field and
 * shift every field after it (the request would carry fields its caller never set).
 */
export function checkFieldText(sv: number, tokens: readonly Token[], reqId: number = ErrorCode.NO_VALID_ID): void {
  const bad = tokens.find((t) => typeof t === 'string' && /[\x00-\x1f]/.test(t));
  if (bad !== undefined) throw new TwsEncodeError(sv, `A text field contains a control character: ${JSON.stringify(bad)}`, ErrorCode.FAIL_SEND, reqId);
}

// ---------------------------------------------------------------------------
// Connection

/** START_API, sent right after the handshake. */
export function startApi(_serverVersion: number, clientId: number, optionalCapabilities = ''): Token[] {
  const VERSION = 2;
  return toTokens([OUT_MSG_ID.START_API, VERSION, clientId, optionalCapabilities]);
}

export function reqCurrentTime(_sv: number): Token[] {
  return toTokens([OUT_MSG_ID.REQ_CURRENT_TIME, 1]);
}

export function reqManagedAccts(_sv: number): Token[] {
  return toTokens([OUT_MSG_ID.REQ_MANAGED_ACCTS, 1]);
}

export function reqIds(_sv: number, numIds: number): Token[] {
  return toTokens([OUT_MSG_ID.REQ_IDS, 1, numIds]);
}

// ---------------------------------------------------------------------------
// Market data

function comboLegsShort(legs: readonly ComboLeg[]): unknown[] {
  const out: unknown[] = [legs.length];
  for (const leg of legs) out.push(leg.conId, leg.ratio, leg.action, leg.exchange);
  return out;
}

export function reqMktData(
  _sv: number,
  reqId: number,
  contract: Contract,
  genericTickList: string,
  snapshot: boolean,
  regulatorySnapshot: boolean,
): Token[] {
  const VERSION = 11;
  const t: unknown[] = [OUT_MSG_ID.REQ_MKT_DATA, VERSION, reqId];
  t.push(
    contract.conId,
    contract.symbol,
    contract.secType,
    contract.lastTradeDateOrContractMonth,
    contract.strike,
    contract.right,
    contract.multiplier,
    contract.exchange,
    contract.primaryExch,
    contract.currency,
    contract.localSymbol,
    contract.tradingClass,
  );
  if (isBag(contract)) t.push(contract.comboLegs ? comboLegsShort(contract.comboLegs) : 0);
  if (contract.deltaNeutralContract) {
    t.push(true, contract.deltaNeutralContract.conId, contract.deltaNeutralContract.delta, contract.deltaNeutralContract.price);
  } else {
    t.push(false);
  }
  t.push(genericTickList, snapshot, regulatorySnapshot);
  t.push(''); // mktDataOptions (reserved)
  return toTokens(t);
}

export function cancelMktData(_sv: number, reqId: number): Token[] {
  return toTokens([OUT_MSG_ID.CANCEL_MKT_DATA, 1, reqId]);
}

export function reqMarketDataType(_sv: number, marketDataType: number): Token[] {
  return toTokens([OUT_MSG_ID.REQ_MARKET_DATA_TYPE, 1, marketDataType]);
}

export function reqMktDepth(
  _sv: number,
  reqId: number,
  contract: Contract,
  numRows: number,
  isSmartDepth: boolean,
  mktDepthOptions?: readonly TagValue[],
): Token[] {
  const VERSION = 5;
  return toTokens([
    OUT_MSG_ID.REQ_MKT_DEPTH,
    VERSION,
    reqId,
    contract.conId,
    contract.symbol,
    contract.secType,
    contract.lastTradeDateOrContractMonth,
    contract.strike,
    contract.right,
    contract.multiplier,
    contract.exchange,
    contract.primaryExch,
    contract.currency,
    contract.localSymbol,
    contract.tradingClass,
    numRows,
    isSmartDepth,
    encodeTagValues(mktDepthOptions),
  ]);
}

export function cancelMktDepth(_sv: number, reqId: number, isSmartDepth: boolean): Token[] {
  return toTokens([OUT_MSG_ID.CANCEL_MKT_DEPTH, 1, reqId, isSmartDepth]);
}

// ---------------------------------------------------------------------------
// Historical data

export function reqHistoricalData(
  _sv: number,
  reqId: number,
  contract: Contract,
  endDateTime: string | undefined,
  durationStr: string,
  barSizeSetting: string,
  whatToShow: string,
  useRTH: number | boolean,
  formatDate: number,
  keepUpToDate: boolean,
  chartOptions?: readonly TagValue[],
): Token[] {
  const t: unknown[] = [OUT_MSG_ID.REQ_HISTORICAL_DATA, reqId];
  t.push(
    contract.conId,
    contract.symbol,
    contract.secType,
    contract.lastTradeDateOrContractMonth,
    contract.strike,
    contract.right,
    contract.multiplier,
    contract.exchange,
    contract.primaryExch,
    contract.currency,
    contract.localSymbol,
    contract.tradingClass,
    !!contract.includeExpired,
  );
  t.push(endDateTime, barSizeSetting, durationStr, useRTH, whatToShow, formatDate);
  if (isBag(contract)) t.push(contract.comboLegs ? comboLegsShort(contract.comboLegs) : 0);
  t.push(keepUpToDate, encodeTagValues(chartOptions));
  return toTokens(t);
}

export function cancelHistoricalData(_sv: number, reqId: number): Token[] {
  return toTokens([OUT_MSG_ID.CANCEL_HISTORICAL_DATA, 1, reqId]);
}

/** The contract fields of reqHeadTimestamp (EClient's short contract encoding). */
function shortContract(contract: Contract): unknown[] {
  return [
    contract.conId,
    contract.symbol,
    contract.secType,
    contract.lastTradeDateOrContractMonth,
    contract.strike,
    contract.right,
    contract.multiplier,
    contract.exchange,
    contract.primaryExch,
    contract.currency,
    contract.localSymbol,
    contract.tradingClass,
    contract.includeExpired ? 1 : 0,
  ];
}

export function reqHeadTimestamp(_sv: number, reqId: number, contract: Contract, whatToShow: string, useRTH: boolean, formatDate: number): Token[] {
  return toTokens([OUT_MSG_ID.REQ_HEAD_TIMESTAMP, reqId, shortContract(contract), useRTH ? 1 : 0, whatToShow, formatDate]);
}

export function cancelHeadTimestamp(_sv: number, reqId: number): Token[] {
  return toTokens([OUT_MSG_ID.CANCEL_HEAD_TIMESTAMP, reqId]);
}

// ---------------------------------------------------------------------------
// Contracts

export function reqContractDetails(_sv: number, reqId: number, contract: Contract): Token[] {
  const VERSION = 8;
  return toTokens([
    OUT_MSG_ID.REQ_CONTRACT_DATA,
    VERSION,
    reqId,
    contract.conId,
    contract.symbol,
    contract.secType,
    contract.lastTradeDateOrContractMonth,
    contract.strike,
    contract.right,
    contract.multiplier,
    contract.exchange,
    contract.primaryExch,
    contract.currency,
    contract.localSymbol,
    contract.tradingClass,
    contract.includeExpired,
    contract.secIdType,
    contract.secId,
    contract.issuerId,
  ]);
}

export function reqMatchingSymbols(_sv: number, reqId: number, pattern: string): Token[] {
  return toTokens([OUT_MSG_ID.REQ_MATCHING_SYMBOLS, reqId, pattern]);
}

export function reqSecDefOptParams(
  _sv: number,
  reqId: number,
  underlyingSymbol: string,
  futFopExchange: string,
  underlyingSecType: string,
  underlyingConId: number,
): Token[] {
  return toTokens([OUT_MSG_ID.REQ_SEC_DEF_OPT_PARAMS, reqId, underlyingSymbol, futFopExchange, underlyingSecType, underlyingConId]);
}

// ---------------------------------------------------------------------------
// Wall Street Horizon (corporate event calendar; needs the account's WSH subscription)

/** Unset integers (conId, total limit, scanner rows and volumes) are sent as empty fields. */
const intOrEmpty = (n: number | undefined): number | undefined => (n === undefined || n === INT_MAX || !Number.isFinite(n) ? undefined : n);

export function reqWshMetaData(_sv: number, reqId: number): Token[] {
  return toTokens([OUT_MSG_ID.REQ_WSH_META_DATA, reqId]);
}

export function cancelWshMetaData(_sv: number, reqId: number): Token[] {
  return toTokens([OUT_MSG_ID.CANCEL_WSH_META_DATA, reqId]);
}

/**
 * Every supported server version (176+) carries the filter fields (171+) and the date range and
 * limit (173+), so they are always sent. IB wants either a conId or a filter, not both.
 */
export function reqWshEventData(sv: number, reqId: number, data: WshEventData): Token[] {
  const conId = intOrEmpty(data.conId);
  if (conId !== undefined && data.filter) {
    throw new TwsEncodeError(sv, 'reqWshEventData: a conId and a filter cannot be combined', ErrorCode.FAIL_SEND, reqId);
  }
  return toTokens([
    OUT_MSG_ID.REQ_WSH_EVENT_DATA,
    reqId,
    conId,
    data.filter ?? '',
    !!data.fillWatchlist,
    !!data.fillPortfolio,
    !!data.fillCompetitors,
    data.startDate ?? '',
    data.endDate ?? '',
    intOrEmpty(data.totalLimit),
  ]);
}

export function cancelWshEventData(_sv: number, reqId: number): Token[] {
  return toTokens([OUT_MSG_ID.CANCEL_WSH_EVENT_DATA, reqId]);
}

// ---------------------------------------------------------------------------
// Market scanner

/**
 * Every field is always sent: Tape supports server versions 176+, and every gate of EClient is
 * older (25 for the option volume and the setting pairs, 27 for stockTypeFilter, 70 for the
 * options list, 143 for the filter list without a VERSION token). On the wire the filter
 * tag-values go before the options list.
 */
export function reqScannerSubscription(
  _sv: number,
  reqId: number,
  sub: ScannerSubscription,
  options?: readonly TagValue[],
  filterOptions?: readonly TagValue[],
): Token[] {
  return toTokens([
    OUT_MSG_ID.REQ_SCANNER_SUBSCRIPTION,
    reqId,
    intOrEmpty(sub.numberOfRows),
    sub.instrument ?? '',
    sub.locationCode ?? '',
    sub.scanCode ?? '',
    nullifyMax(sub.abovePrice),
    nullifyMax(sub.belowPrice),
    intOrEmpty(sub.aboveVolume),
    nullifyMax(sub.marketCapAbove),
    nullifyMax(sub.marketCapBelow),
    sub.moodyRatingAbove ?? '',
    sub.moodyRatingBelow ?? '',
    sub.spRatingAbove ?? '',
    sub.spRatingBelow ?? '',
    sub.maturityDateAbove ?? '',
    sub.maturityDateBelow ?? '',
    nullifyMax(sub.couponRateAbove),
    nullifyMax(sub.couponRateBelow),
    !!sub.excludeConvertible,
    intOrEmpty(sub.averageOptionVolumeAbove),
    sub.scannerSettingPairs ?? '',
    sub.stockTypeFilter ?? '',
    encodeTagValues(filterOptions),
    encodeTagValues(options),
  ]);
}

export function cancelScannerSubscription(_sv: number, reqId: number): Token[] {
  return toTokens([OUT_MSG_ID.CANCEL_SCANNER_SUBSCRIPTION, 1, reqId]);
}

// ---------------------------------------------------------------------------
// Account and portfolio

export function reqAccountUpdates(_sv: number, subscribe: boolean, acctCode: string): Token[] {
  return toTokens([OUT_MSG_ID.REQ_ACCOUNT_DATA, 2, subscribe, acctCode]);
}

export function reqAccountSummary(_sv: number, reqId: number, group: string, tags: string): Token[] {
  return toTokens([OUT_MSG_ID.REQ_ACCOUNT_SUMMARY, 1, reqId, group, tags]);
}

export function cancelAccountSummary(_sv: number, reqId: number): Token[] {
  return toTokens([OUT_MSG_ID.CANCEL_ACCOUNT_SUMMARY, 1, reqId]);
}

export function reqPositions(_sv: number): Token[] {
  return toTokens([OUT_MSG_ID.REQ_POSITIONS, 1]);
}

export function cancelPositions(_sv: number): Token[] {
  return toTokens([OUT_MSG_ID.CANCEL_POSITIONS, 1]);
}

export function reqPnL(_sv: number, reqId: number, account: string, modelCode: string): Token[] {
  return toTokens([OUT_MSG_ID.REQ_PNL, reqId, account, modelCode]);
}

export function cancelPnL(_sv: number, reqId: number): Token[] {
  return toTokens([OUT_MSG_ID.CANCEL_PNL, reqId]);
}

export function reqPnLSingle(_sv: number, reqId: number, account: string, modelCode: string, conId: number): Token[] {
  return toTokens([OUT_MSG_ID.REQ_PNL_SINGLE, reqId, account, modelCode, conId]);
}

export function cancelPnLSingle(_sv: number, reqId: number): Token[] {
  return toTokens([OUT_MSG_ID.CANCEL_PNL_SINGLE, reqId]);
}

// ---------------------------------------------------------------------------
// Orders and executions

export function reqOpenOrders(_sv: number): Token[] {
  return toTokens([OUT_MSG_ID.REQ_OPEN_ORDERS, 1]);
}

export function reqAllOpenOrders(_sv: number): Token[] {
  return toTokens([OUT_MSG_ID.REQ_ALL_OPEN_ORDERS, 1]);
}

export function reqAutoOpenOrders(_sv: number, bAutoBind: boolean): Token[] {
  return toTokens([OUT_MSG_ID.REQ_AUTO_OPEN_ORDERS, 1, bAutoBind]);
}

export function reqCompletedOrders(_sv: number, apiOnly: boolean): Token[] {
  return toTokens([OUT_MSG_ID.REQ_COMPLETED_ORDERS, apiOnly]);
}

export function reqExecutions(_sv: number, reqId: number, filter: ExecutionFilter): Token[] {
  const VERSION = 3;
  return toTokens([
    OUT_MSG_ID.REQ_EXECUTIONS,
    VERSION,
    reqId,
    filter.clientId,
    filter.acctCode,
    filter.time,
    filter.symbol,
    filter.secType,
    filter.exchange,
    filter.side,
  ]);
}

/** Rejects CME tagging attributes on servers that cannot carry them. */
function checkCmeTagging(sv: number, orderCancel: OrderCancel, reqId?: number): void {
  if (sv < MIN_SERVER_VER.CME_TAGGING_FIELDS && (orderCancel.extOperator?.length || orderCancel.manualOrderIndicator != undefined)) {
    throw new TwsEncodeError(sv, 'It does not support ext operator and manual order indicator parameters', ErrorCode.UPDATE_TWS, reqId);
  }
}

export function cancelOrder(sv: number, orderId: number, orderCancel: OrderCancel): Token[] {
  checkCmeTagging(sv, orderCancel, orderId);
  const VERSION = 1;
  const t: unknown[] = [OUT_MSG_ID.CANCEL_ORDER];
  if (sv < MIN_SERVER_VER.CME_TAGGING_FIELDS) t.push(VERSION);
  t.push(orderId, orderCancel.manualOrderCancelTime);
  if (sv >= MIN_SERVER_VER.RFQ_FIELDS && sv < MIN_SERVER_VER.UNDO_RFQ_FIELDS) t.push('', '', INT_MAX);
  if (sv >= MIN_SERVER_VER.CME_TAGGING_FIELDS) t.push(orderCancel.extOperator, orderCancel.manualOrderIndicator ?? INT_MAX);
  return toTokens(t);
}

export function reqGlobalCancel(sv: number, orderCancel: OrderCancel): Token[] {
  checkCmeTagging(sv, orderCancel);
  const VERSION = 1;
  const t: unknown[] = [OUT_MSG_ID.REQ_GLOBAL_CANCEL];
  if (sv < MIN_SERVER_VER.CME_TAGGING_FIELDS) t.push(VERSION);
  else t.push(orderCancel.extOperator, orderCancel.manualOrderIndicator ?? INT_MAX);
  return toTokens(t);
}

/** Fields of one order condition (type, conjunction, then the type-specific fields). */
function conditionFields(cond: OrderCondition): unknown[] {
  // The concrete classes (conditions.ts) carry these fields; plain objects work as well.
  const c = cond as OrderCondition & {
    isMore?: boolean;
    strValue?: string;
    conId?: number;
    exchange?: string;
    triggerMethod?: number;
    secType?: string;
    symbol?: string;
  };
  const out: unknown[] = [c.type, c.conjunctionConnection];
  switch (c.type) {
    case OrderConditionType.Execution:
      out.push(c.secType, c.exchange, c.symbol);
      break;
    case OrderConditionType.Margin:
    case OrderConditionType.Time:
      out.push(c.isMore, c.strValue);
      break;
    case OrderConditionType.PercentChange:
    case OrderConditionType.Volume:
      out.push(c.isMore, c.strValue, c.conId, c.exchange);
      break;
    case OrderConditionType.Price:
      out.push(c.isMore, c.strValue, c.conId, c.exchange, c.triggerMethod);
      break;
  }
  return out;
}

/** Rejects order attributes newer than the server (only versions 176..193 can be connected). */
function checkOrder(sv: number, id: number, order: Order): void {
  const fail = (message: string) => {
    throw new TwsEncodeError(sv, message, ErrorCode.UPDATE_TWS, id);
  };
  if (sv < MIN_SERVER_VER.CUSTOMER_ACCOUNT && order.customerAccount) fail('It does not support customer account parameter');
  if (sv < MIN_SERVER_VER.PROFESSIONAL_CUSTOMER && order.professionalCustomer) fail('It does not support professional customer parameter');
  if (sv < MIN_SERVER_VER.INCLUDE_OVERNIGHT && order.includeOvernight) fail('It does not support include overnight parameter');
  if (sv < MIN_SERVER_VER.CME_TAGGING_FIELDS && order.manualOrderIndicator) fail('It does not support manual order indicator parameter');
}

export function placeOrder(sv: number, id: number, contract: Contract, order: Order): Token[] {
  checkOrder(sv, id, order);
  const bag = isBag(contract);
  const t: unknown[] = [OUT_MSG_ID.PLACE_ORDER, id];

  // contract
  t.push(
    contract.conId,
    contract.symbol,
    contract.secType,
    contract.lastTradeDateOrContractMonth,
    contract.strike,
    contract.right,
    contract.multiplier,
    contract.exchange,
    contract.primaryExch,
    contract.currency,
    contract.localSymbol,
    contract.tradingClass,
    contract.secIdType,
    contract.secId,
  );

  // main order fields
  t.push(order.action, order.totalQuantity, order.orderType, nullifyMax(order.lmtPrice), nullifyMax(order.auxPrice));

  // extended order fields
  t.push(
    order.tif,
    order.ocaGroup,
    order.account,
    order.openClose,
    order.origin,
    order.orderRef,
    order.transmit,
    order.parentId,
    order.blockOrder,
    order.sweepToFill,
    order.displaySize,
    order.triggerMethod,
    order.outsideRth,
    order.hidden,
  );

  if (bag) {
    // combo legs
    const legs = contract.comboLegs ?? [];
    t.push(legs.length);
    for (const leg of legs) {
      t.push(leg.conId, leg.ratio, leg.action, leg.exchange, leg.openClose, leg.shortSaleSlot, leg.designatedLocation, leg.exemptCode);
    }
    // order combo legs (per-leg prices)
    const orderLegs = order.orderComboLegs ?? [];
    t.push(orderLegs.length);
    for (const leg of orderLegs) t.push(nullifyMax(leg.price));
    // smart combo routing params
    const params = order.smartComboRoutingParams ?? [];
    t.push(params.length);
    for (const p of params) t.push(p.tag, p.value);
  }

  t.push(''); // deprecated sharesAllocation
  t.push(order.discretionaryAmt, order.goodAfterTime, order.goodTillDate);
  t.push(order.faGroup, order.faMethod, order.faPercentage);
  if (sv < MIN_SERVER_VER.FA_PROFILE_DESUPPORT) t.push(''); // deprecated faProfile
  t.push(order.modelCode);

  // institutional short sale slot fields
  t.push(order.shortSaleSlot, order.designatedLocation, order.exemptCode);

  t.push(
    order.ocaType,
    order.rule80A,
    order.settlingFirm,
    order.allOrNone,
    nullifyMax(order.minQty),
    nullifyMax(order.percentOffset),
    order.eTradeOnly,
    order.firmQuoteOnly,
    nullifyMax(order.nbboPriceCap),
    nullifyMax(order.auctionStrategy),
    nullifyMax(order.startingPrice),
    nullifyMax(order.stockRefPrice),
    nullifyMax(order.delta),
    order.stockRangeLower,
    order.stockRangeUpper,
  );
  t.push(order.overridePercentageConstraints);

  // volatility orders
  t.push(nullifyMax(order.volatility), nullifyMax(order.volatilityType), order.deltaNeutralOrderType, nullifyMax(order.deltaNeutralAuxPrice));
  if (order.deltaNeutralOrderType) {
    t.push(order.deltaNeutralConId, order.deltaNeutralSettlingFirm, order.deltaNeutralClearingAccount, order.deltaNeutralClearingIntent);
    t.push(order.deltaNeutralOpenClose, order.deltaNeutralShortSale, order.deltaNeutralShortSaleSlot, order.deltaNeutralDesignatedLocation);
  }
  t.push(order.continuousUpdate, nullifyMax(order.referencePriceType));

  // trailing stops
  t.push(nullifyMax(order.trailStopPrice), nullifyMax(order.trailingPercent));

  // scale orders
  t.push(nullifyMax(order.scaleInitLevelSize), nullifyMax(order.scaleSubsLevelSize), nullifyMax(order.scalePriceIncrement));
  // EClient sends the extended scale fields only for a real increment (> 0 and not Double.MAX_VALUE).
  if (order.scalePriceIncrement != null && order.scalePriceIncrement > 0 && order.scalePriceIncrement !== Number.MAX_VALUE) {
    t.push(
      nullifyMax(order.scalePriceAdjustValue),
      nullifyMax(order.scalePriceAdjustInterval),
      nullifyMax(order.scaleProfitOffset),
      order.scaleAutoReset,
      nullifyMax(order.scaleInitPosition),
      nullifyMax(order.scaleInitFillQty),
      order.scaleRandomPercent,
    );
  }
  t.push(order.scaleTable, order.activeStartTime, order.activeStopTime);

  // hedge orders
  t.push(order.hedgeType);
  if (order.hedgeType) t.push(order.hedgeParam);

  t.push(order.optOutSmartRouting);
  t.push(order.clearingAccount, order.clearingIntent);
  t.push(order.notHeld);

  // delta neutral
  const dn = contract.deltaNeutralContract;
  if (dn) t.push(true, dn.conId, dn.delta, dn.price);
  else t.push(false);

  // algo orders
  t.push(order.algoStrategy);
  if (order.algoStrategy) {
    const algoParams = order.algoParams ?? [];
    t.push(algoParams.length);
    for (const p of algoParams) t.push(p.tag, p.value);
  }
  t.push(order.algoId);
  t.push(order.whatIf);
  // orderMiscOptions is a TagValue list, sent in EClient's "tag=value;" encoding
  t.push(Array.isArray(order.orderMiscOptions) ? encodeTagValues(order.orderMiscOptions) : order.orderMiscOptions);
  t.push(order.solicited);
  t.push(order.randomizeSize, order.randomizePrice);

  // pegged to benchmark
  if (isPegBenchOrder(order.orderType)) {
    t.push(order.referenceContractId, order.isPeggedChangeAmountDecrease, order.peggedChangeAmount, order.referenceChangeAmount, order.referenceExchangeId);
  }

  // conditions
  const conditions = order.conditions ?? [];
  t.push(conditions.length);
  if (conditions.length > 0) {
    for (const cond of conditions) t.push(conditionFields(cond));
    t.push(order.conditionsIgnoreRth, order.conditionsCancelOrder);
  }

  // adjusted orders
  t.push(
    order.adjustedOrderType,
    nullifyMax(order.triggerPrice),
    nullifyMax(order.lmtPriceOffset),
    nullifyMax(order.adjustedStopPrice),
    nullifyMax(order.adjustedStopLimitPrice),
    nullifyMax(order.adjustedTrailingAmount),
    order.adjustableTrailingUnit,
  );

  t.push(order.extOperator);
  t.push(order.softDollarTier?.name ? order.softDollarTier.name : '', order.softDollarTier?.value ? order.softDollarTier.value : '');
  t.push(nullifyMax(order.cashQty));
  t.push(order.mifid2DecisionMaker, order.mifid2DecisionAlgo);
  t.push(order.mifid2ExecutionTrader, order.mifid2ExecutionAlgo);
  t.push(order.dontUseAutoPriceForHedge);
  t.push(order.isOmsContainer);
  t.push(order.discretionaryUpToLimitPrice);
  t.push(order.usePriceMgmtAlgo);
  t.push(order.duration);
  t.push(order.postToAts);
  t.push(order.autoCancelParent);
  t.push(order.advancedErrorOverride);
  t.push(order.manualOrderTime);

  // PEG BEST / PEG MID offsets
  let sendMidOffsets = false;
  if (contract.exchange === 'IBKRATS') t.push(order.minTradeQty);
  if (isPegBestOrder(order.orderType)) {
    t.push(order.minCompeteSize, order.competeAgainstBestOffset);
    if (order.competeAgainstBestOffset === COMPETE_AGAINST_BEST_OFFSET_UP_TO_MID) sendMidOffsets = true;
  } else if (isPegMidOrder(order.orderType)) {
    sendMidOffsets = true;
  }
  if (sendMidOffsets) t.push(order.midOffsetAtWhole, order.midOffsetAtHalf);

  if (sv >= MIN_SERVER_VER.CUSTOMER_ACCOUNT) t.push(order.customerAccount);
  if (sv >= MIN_SERVER_VER.PROFESSIONAL_CUSTOMER) t.push(order.professionalCustomer);
  if (sv >= MIN_SERVER_VER.RFQ_FIELDS && sv < MIN_SERVER_VER.UNDO_RFQ_FIELDS) t.push('', INT_MAX);
  if (sv >= MIN_SERVER_VER.INCLUDE_OVERNIGHT) t.push(order.includeOvernight);
  if (sv >= MIN_SERVER_VER.CME_TAGGING_FIELDS) t.push(order.manualOrderIndicator);
  const tokens = toTokens(t);
  checkFieldText(sv, tokens, id);
  return tokens;
}

// ---------------------------------------------------------------------------
// @stoqey/ib-style encoder object

/** Callbacks of the Encoder class (the shape @stoqey/ib's Encoder takes). */
export interface EncoderCallbacks {
  readonly serverVersion: number;
  /** Receives the frame's tokens (one array). */
  sendMsg(...tokens: unknown[]): void;
  emitError(message: string, code: number, reqId: number): void;
}

/**
 * The request encoders as methods over a callback object, matching @stoqey/ib's Encoder
 * (`new Encoder({ serverVersion, sendMsg, emitError }).placeOrder(id, contract, order)`).
 * Version problems go to emitError; nothing is sent then.
 */
export class Encoder {
  private readonly callback: EncoderCallbacks;

  constructor(callback: EncoderCallbacks) {
    this.callback = callback;
  }

  get serverVersion(): number {
    return this.callback.serverVersion;
  }

  private send(encode: (sv: number) => Token[]): void {
    let tokens: Token[];
    try {
      tokens = encode(this.serverVersion);
      checkFieldText(this.serverVersion, tokens);
    } catch (err) {
      if (!(err instanceof TwsEncodeError)) throw err;
      this.callback.emitError(err.message, err.code, err.reqId);
      return;
    }
    this.callback.sendMsg(tokens);
  }

  reqMktData(reqId: number, contract: Contract, genericTickList: string, snapshot: boolean, regulatorySnapshot: boolean): void {
    this.send((sv) => reqMktData(sv, reqId, contract, genericTickList, snapshot, regulatorySnapshot));
  }
  cancelMktData(reqId: number): void {
    this.send((sv) => cancelMktData(sv, reqId));
  }
  reqMarketDataType(marketDataType: number): void {
    this.send((sv) => reqMarketDataType(sv, marketDataType));
  }
  reqMktDepth(reqId: number, contract: Contract, numRows: number, isSmartDepth: boolean, mktDepthOptions?: readonly TagValue[]): void {
    this.send((sv) => reqMktDepth(sv, reqId, contract, numRows, isSmartDepth, mktDepthOptions));
  }
  cancelMktDepth(reqId: number, isSmartDepth: boolean): void {
    this.send((sv) => cancelMktDepth(sv, reqId, isSmartDepth));
  }
  reqHistoricalData(
    reqId: number,
    contract: Contract,
    endDateTime: string | undefined,
    durationStr: string,
    barSizeSetting: string,
    whatToShow: string,
    useRTH: number | boolean,
    formatDate: number,
    keepUpToDate: boolean,
    chartOptions?: readonly TagValue[],
  ): void {
    this.send((sv) => reqHistoricalData(sv, reqId, contract, endDateTime, durationStr, barSizeSetting, whatToShow, useRTH, formatDate, keepUpToDate, chartOptions));
  }
  cancelHistoricalData(reqId: number): void {
    this.send((sv) => cancelHistoricalData(sv, reqId));
  }
  reqHeadTimestamp(reqId: number, contract: Contract, whatToShow: string, useRTH: boolean, formatDate: number): void {
    this.send((sv) => reqHeadTimestamp(sv, reqId, contract, whatToShow, useRTH, formatDate));
  }
  cancelHeadTimestamp(reqId: number): void {
    this.send((sv) => cancelHeadTimestamp(sv, reqId));
  }
  reqContractDetails(reqId: number, contract: Contract): void {
    this.send((sv) => reqContractDetails(sv, reqId, contract));
  }
  reqMatchingSymbols(reqId: number, pattern: string): void {
    this.send((sv) => reqMatchingSymbols(sv, reqId, pattern));
  }
  reqSecDefOptParams(reqId: number, underlyingSymbol: string, futFopExchange: string, underlyingSecType: string, underlyingConId: number): void {
    this.send((sv) => reqSecDefOptParams(sv, reqId, underlyingSymbol, futFopExchange, underlyingSecType, underlyingConId));
  }
  reqWshMetaData(reqId: number): void {
    this.send((sv) => reqWshMetaData(sv, reqId));
  }
  cancelWshMetaData(reqId: number): void {
    this.send((sv) => cancelWshMetaData(sv, reqId));
  }
  reqWshEventData(reqId: number, data: WshEventData): void {
    this.send((sv) => reqWshEventData(sv, reqId, data));
  }
  cancelWshEventData(reqId: number): void {
    this.send((sv) => cancelWshEventData(sv, reqId));
  }
  reqScannerSubscription(reqId: number, subscription: ScannerSubscription, options?: readonly TagValue[], filterOptions?: readonly TagValue[]): void {
    this.send((sv) => reqScannerSubscription(sv, reqId, subscription, options, filterOptions));
  }
  cancelScannerSubscription(reqId: number): void {
    this.send((sv) => cancelScannerSubscription(sv, reqId));
  }
  reqAccountUpdates(subscribe: boolean, acctCode: string): void {
    this.send((sv) => reqAccountUpdates(sv, subscribe, acctCode));
  }
  reqAccountSummary(reqId: number, group: string, tags: string): void {
    this.send((sv) => reqAccountSummary(sv, reqId, group, tags));
  }
  cancelAccountSummary(reqId: number): void {
    this.send((sv) => cancelAccountSummary(sv, reqId));
  }
  reqPositions(): void {
    this.send((sv) => reqPositions(sv));
  }
  cancelPositions(): void {
    this.send((sv) => cancelPositions(sv));
  }
  reqPnL(reqId: number, account: string, modelCode: string): void {
    this.send((sv) => reqPnL(sv, reqId, account, modelCode));
  }
  cancelPnL(reqId: number): void {
    this.send((sv) => cancelPnL(sv, reqId));
  }
  reqPnLSingle(reqId: number, account: string, modelCode: string, conId: number): void {
    this.send((sv) => reqPnLSingle(sv, reqId, account, modelCode, conId));
  }
  cancelPnLSingle(reqId: number): void {
    this.send((sv) => cancelPnLSingle(sv, reqId));
  }
  reqOpenOrders(): void {
    this.send((sv) => reqOpenOrders(sv));
  }
  reqAllOpenOrders(): void {
    this.send((sv) => reqAllOpenOrders(sv));
  }
  reqAutoOpenOrders(bAutoBind: boolean): void {
    this.send((sv) => reqAutoOpenOrders(sv, bAutoBind));
  }
  reqCompletedOrders(apiOnly: boolean): void {
    this.send((sv) => reqCompletedOrders(sv, apiOnly));
  }
  reqExecutions(reqId: number, filter: ExecutionFilter): void {
    this.send((sv) => reqExecutions(sv, reqId, filter));
  }
  placeOrder(id: number, contract: Contract, order: Order): void {
    this.send((sv) => placeOrder(sv, id, contract, order));
  }
  cancelOrder(orderId: number, orderCancel: OrderCancel): void {
    this.send((sv) => cancelOrder(sv, orderId, orderCancel));
  }
  reqGlobalCancel(orderCancel: OrderCancel): void {
    this.send((sv) => reqGlobalCancel(sv, orderCancel));
  }
  reqIds(numIds: number): void {
    this.send((sv) => reqIds(sv, numIds));
  }
  reqManagedAccts(): void {
    this.send((sv) => reqManagedAccts(sv));
  }
  reqCurrentTime(): void {
    this.send((sv) => reqCurrentTime(sv));
  }
}
