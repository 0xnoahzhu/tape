// Data structures of the TWS API (contracts, orders, executions, ...). Field names follow
// @stoqey/ib (and IB's Java EClient classes) so objects can be passed between both.
//
// Wire format follows the IB TWS API (EClient/EDecoder). Portions derived from @stoqey/ib (MIT, Copyright (c) the @stoqey/ib authors)

import type {
  ConjunctionConnection,
  Liquidities,
  OptionType,
  OrderAction,
  OrderConditionType,
  OrderStatus,
  OrderType,
  SecType,
  TimeInForce,
} from './enums.ts';

/** Options of the IBApi constructor. */
export interface IBApiCreationOptions {
  /** TWS / IB Gateway host. Default 127.0.0.1. */
  host?: string;
  /** API port. Default 7496 (TWS live); IB Gateway uses 4001 (live) / 4002 (paper). */
  port?: number;
  /** Client id used when connect() is called without one. Default 0. */
  clientId?: number;
  /** Outgoing message limit per second (IB allows 50). Default 45, halved for 10 s after IB's error 100. */
  maxReqPerSec?: number;
}

export interface TagValue {
  tag: string;
  value: string;
}

export interface SoftDollarTier {
  name?: string;
  value?: string;
  displayName?: string;
}

export interface ComboLeg {
  conId?: number;
  ratio?: number;
  action?: OrderAction;
  exchange?: string;
  /** 0 = same as parent, 1 = open, 2 = close, 3 = unknown. */
  openClose?: number;
  shortSaleSlot?: number;
  designatedLocation?: string;
  exemptCode?: number;
}

export interface DeltaNeutralContract {
  conId: number;
  delta: number;
  price: number;
}

export interface Contract {
  conId?: number;
  symbol?: string;
  secType?: SecType;
  lastTradeDateOrContractMonth?: string;
  lastTradeDate?: string;
  strike?: number;
  right?: OptionType;
  multiplier?: number;
  exchange?: string;
  currency?: string;
  localSymbol?: string;
  primaryExch?: string;
  tradingClass?: string;
  includeExpired?: boolean;
  secIdType?: string;
  secId?: string;
  description?: string;
  issuerId?: string;
  comboLegsDescription?: string;
  comboLegs?: ComboLeg[];
  deltaNeutralContract?: DeltaNeutralContract;
}

export interface IneligibilityReason {
  id: string;
  description: string;
}

export interface ContractDetails {
  contract: Contract;
  marketName?: string;
  minTick?: number;
  priceMagnifier?: number;
  orderTypes?: string;
  validExchanges?: string;
  underConId?: number;
  longName?: string;
  contractMonth?: string;
  industry?: string;
  category?: string;
  subcategory?: string;
  timeZoneId?: string;
  tradingHours?: string;
  liquidHours?: string;
  evRule?: string;
  evMultiplier?: number;
  aggGroup?: number;
  secIdList?: TagValue[];
  underSymbol?: string;
  underSecType?: SecType;
  marketRuleIds?: string;
  realExpirationDate?: string;
  lastTradeTime?: string;
  stockType?: string;
  // bonds
  cusip?: string;
  ratings?: string;
  descAppend?: string;
  bondType?: string;
  couponType?: string;
  callable?: boolean;
  putable?: boolean;
  coupon?: number;
  convertible?: boolean;
  maturity?: string;
  issueDate?: string;
  nextOptionDate?: string;
  nextOptionType?: string;
  nextOptionPartial?: boolean;
  notes?: string;
  // size rules
  minSize?: number;
  sizeIncrement?: number;
  suggestedSizeIncrement?: number;
  // funds
  fundName?: string;
  fundFamily?: string;
  fundType?: string;
  fundFrontLoad?: string;
  fundBackLoad?: string;
  fundBackLoadTimeInterval?: string;
  fundManagementFee?: string;
  fundClosed?: boolean;
  fundClosedForNewInvestors?: boolean;
  fundClosedForNewMoney?: boolean;
  fundNotifyAmount?: string;
  fundMinimumInitialPurchase?: string;
  fundSubsequentMinimumPurchase?: string;
  fundBlueSkyStates?: string;
  fundBlueSkyTerritories?: string;
  fundDistributionPolicyIndicator?: string;
  fundAssetType?: string;
  ineligibilityReasonList?: IneligibilityReason[];
}

/** One result of reqMatchingSymbols. */
export interface ContractDescription {
  contract?: Contract;
  derivativeSecTypes?: SecType[];
}

/** Element of mktDepthExchanges. */
export interface DepthMktDataDescription {
  exchange: string;
  secType: string;
  listingExch: string;
  serviceDataType: string;
  aggGroup?: number;
}

// ---------------------------------------------------------------------------
// Orders

/** Base of all order conditions (see conditions.ts for the concrete classes). */
export interface OrderCondition {
  type: OrderConditionType;
  conjunctionConnection: ConjunctionConnection;
}

/** A condition comparing a value against a threshold. */
export interface OperatorCondition extends OrderCondition {
  isMore: boolean;
  /** The threshold as sent on the wire. */
  readonly strValue: string;
}

/** An operator condition that watches a contract. */
export interface ContractCondition extends OperatorCondition {
  conId?: number;
  exchange?: string;
}

export interface OrderComboLeg {
  price?: number;
}

export interface Order {
  orderId?: number;
  solicited?: boolean;
  clientId?: number;
  permId?: number;
  action?: OrderAction;
  totalQuantity?: number;
  orderType: OrderType;
  lmtPrice?: number;
  auxPrice?: number;
  tif?: TimeInForce;
  ocaGroup?: string;
  ocaType?: number;
  orderRef?: string;
  transmit?: boolean;
  parentId?: number;
  blockOrder?: boolean;
  sweepToFill?: boolean;
  displaySize?: number;
  triggerMethod?: number;
  outsideRth?: boolean;
  hidden?: boolean;
  goodAfterTime?: string;
  goodTillDate?: string;
  overridePercentageConstraints?: boolean;
  rule80A?: string;
  allOrNone?: boolean;
  minQty?: number;
  percentOffset?: number;
  trailStopPrice?: number;
  trailingPercent?: number;
  faGroup?: string;
  faProfile?: string;
  faMethod?: string;
  faPercentage?: string;
  openClose?: string;
  origin?: number;
  shortSaleSlot?: number;
  designatedLocation?: string;
  exemptCode?: number;
  discretionaryAmt?: number;
  eTradeOnly?: boolean;
  firmQuoteOnly?: boolean;
  nbboPriceCap?: number;
  optOutSmartRouting?: boolean;
  auctionStrategy?: number;
  startingPrice?: number;
  stockRefPrice?: number;
  delta?: number;
  stockRangeLower?: number;
  stockRangeUpper?: number;
  volatility?: number;
  volatilityType?: number;
  continuousUpdate?: number;
  referencePriceType?: number;
  deltaNeutralOrderType?: string;
  deltaNeutralAuxPrice?: number;
  deltaNeutralConId?: number;
  deltaNeutralSettlingFirm?: string;
  deltaNeutralClearingAccount?: string;
  deltaNeutralClearingIntent?: string;
  deltaNeutralOpenClose?: string;
  deltaNeutralShortSale?: boolean;
  deltaNeutralShortSaleSlot?: number;
  deltaNeutralDesignatedLocation?: string;
  basisPoints?: number;
  basisPointsType?: number;
  scaleInitLevelSize?: number;
  scaleSubsLevelSize?: number;
  scalePriceIncrement?: number;
  scalePriceAdjustValue?: number;
  scalePriceAdjustInterval?: number;
  scaleProfitOffset?: number;
  scaleAutoReset?: boolean;
  scaleInitPosition?: number;
  scaleInitFillQty?: number;
  scaleRandomPercent?: boolean;
  hedgeType?: string;
  hedgeParam?: string;
  account?: string;
  settlingFirm?: string;
  clearingAccount?: string;
  clearingIntent?: string;
  algoStrategy?: string;
  algoParams?: TagValue[];
  whatIf?: boolean;
  algoId?: string;
  notHeld?: boolean;
  smartComboRoutingParams?: TagValue[];
  orderComboLegs?: OrderComboLeg[];
  orderMiscOptions?: TagValue[];
  activeStartTime?: string;
  activeStopTime?: string;
  scaleTable?: string;
  modelCode?: string;
  extOperator?: string;
  softDollarTier?: SoftDollarTier;
  cashQty?: number;
  mifid2DecisionMaker?: string;
  mifid2DecisionAlgo?: string;
  mifid2ExecutionTrader?: string;
  mifid2ExecutionAlgo?: string;
  dontUseAutoPriceForHedge?: boolean;
  autoCancelDate?: string;
  filledQuantity?: number;
  refFuturesConId?: number;
  autoCancelParent?: boolean;
  shareholder?: string;
  imbalanceOnly?: boolean;
  routeMarketableToBbo?: boolean;
  parentPermId?: number;
  randomizeSize?: boolean;
  randomizePrice?: boolean;
  referenceContractId?: number;
  isPeggedChangeAmountDecrease?: boolean;
  peggedChangeAmount?: number;
  referenceChangeAmount?: number;
  referenceExchangeId?: string;
  adjustedOrderType?: string;
  triggerPrice?: number;
  lmtPriceOffset?: number;
  adjustedStopPrice?: number;
  adjustedStopLimitPrice?: number;
  adjustedTrailingAmount?: number;
  adjustableTrailingUnit?: number;
  conditions?: OrderCondition[];
  conditionsIgnoreRth?: boolean;
  conditionsCancelOrder?: boolean;
  tier?: SoftDollarTier;
  isOmsContainer?: boolean;
  discretionaryUpToLimitPrice?: boolean;
  usePriceMgmtAlgo?: boolean;
  duration?: number;
  postToAts?: number;
  advancedErrorOverride?: string;
  manualOrderTime?: string;
  minTradeQty?: number;
  minCompeteSize?: number;
  competeAgainstBestOffset?: number;
  midOffsetAtWhole?: number;
  midOffsetAtHalf?: number;
  customerAccount?: string;
  professionalCustomer?: boolean;
  bondAccruedInterest?: string;
  includeOvernight?: boolean;
  manualOrderIndicator?: number;
}

export interface OrderState {
  status: OrderStatus;
  initMarginBefore?: number;
  maintMarginBefore?: number;
  equityWithLoanBefore?: number;
  initMarginChange?: number;
  maintMarginChange?: number;
  equityWithLoanChange?: number;
  initMarginAfter?: number;
  maintMarginAfter?: number;
  equityWithLoanAfter?: number;
  commission?: number;
  minCommission?: number;
  maxCommission?: number;
  commissionCurrency?: string;
  warningText?: string;
  completedTime?: string;
  completedStatus?: string;
}

/** Optional attributes of cancelOrder / reqGlobalCancel. */
export interface OrderCancel {
  manualOrderCancelTime?: string;
  extOperator?: string;
  manualOrderIndicator?: number;
}

// ---------------------------------------------------------------------------
// Executions and reports

export interface Execution {
  orderId?: number;
  clientId?: number;
  execId?: string;
  time?: string;
  acctNumber?: string;
  exchange?: string;
  side?: string;
  shares?: number;
  price?: number;
  permId?: number;
  liquidation?: number;
  cumQty?: number;
  avgPrice?: number;
  orderRef?: string;
  evRule?: string;
  evMultiplier?: number;
  modelCode?: string;
  lastLiquidity?: Liquidities;
  pendingPriceRevision?: boolean;
}

/** Filter of reqExecutions (time format "yyyymmdd-hh:mm:ss"). */
export interface ExecutionFilter {
  clientId?: string | number;
  acctCode?: string;
  time?: string;
  symbol?: string;
  secType?: SecType;
  exchange?: string;
  side?: string;
}

/**
 * Wall Street Horizon event request (reqWshEventData; EClient's WshEventData). Either `conId`
 * (one instrument) or `filter` (IB's JSON filter, e.g. {"watchlist":["8314"],"wshe_ed":"true"})
 * selects the events; the fill flags add the account's watchlist, portfolio or competitors.
 * Dates are "yyyyMMdd"; `totalLimit` caps the number of events.
 */
export interface WshEventData {
  conId?: number;
  filter?: string;
  fillWatchlist?: boolean;
  fillPortfolio?: boolean;
  fillCompetitors?: boolean;
  startDate?: string;
  endDate?: string;
  totalLimit?: number;
}

/**
 * Market scanner request (reqScannerSubscription; EClient's ScannerSubscription). Unset fields
 * are sent as empty ones; `instrument`, `locationCode` and `scanCode` are names from IB's scanner
 * parameters (e.g. 'STK', 'STK.US.MAJOR', 'TOP_PERC_GAIN'). Market caps are in millions of USD.
 */
export interface ScannerSubscription {
  numberOfRows?: number;
  instrument?: string;
  locationCode?: string;
  scanCode?: string;
  abovePrice?: number;
  belowPrice?: number;
  aboveVolume?: number;
  marketCapAbove?: number;
  marketCapBelow?: number;
  moodyRatingAbove?: string;
  moodyRatingBelow?: string;
  spRatingAbove?: string;
  spRatingBelow?: string;
  maturityDateAbove?: string;
  maturityDateBelow?: string;
  couponRateAbove?: number;
  couponRateBelow?: number;
  excludeConvertible?: boolean;
  averageOptionVolumeAbove?: number;
  scannerSettingPairs?: string;
  stockTypeFilter?: string;
}

export interface CommissionReport {
  execId?: string;
  commission?: number;
  currency?: string;
  realizedPNL?: number;
  yield?: number;
  yieldRedemptionDate?: number;
}

/** A historical bar (the historicalData event passes the fields as separate arguments). */
export interface Bar {
  time?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  WAP?: number;
  count?: number;
}
