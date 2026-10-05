// Encoder regression tests. The snapshots of the server version 176 / 193 outputs were recorded
// while every request was also encoded by @stoqey/ib (token arrays identical at 176..193); they
// keep guarding the wire format now that @stoqey/ib is no longer a dependency. When it is
// installed (e.g. temporarily, to re-verify), the full differential comparison runs again.

import { describe, expect, it } from 'vitest';
import * as conditions from './conditions.ts';
import * as encoder from './encoder.ts';
import { TwsEncodeError } from './errors.ts';
import { MAX_SERVER_VERSION, MIN_SERVER_VERSION } from './messageIds.ts';
import type { Contract, Order, OrderCondition } from './types.ts';
import { loadStoqey, type StoqeyEncodeResult } from './__fixtures__/stoqeyRef.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const stoqey = loadStoqey();
const VERSIONS = Array.from({ length: MAX_SERVER_VERSION - MIN_SERVER_VERSION + 1 }, (_, i) => MIN_SERVER_VERSION + i);

// ---------------------------------------------------------------------------
// Inputs

const stk: Contract = { conId: 265598, symbol: 'AAPL', secType: 'STK', exchange: 'SMART', primaryExch: 'NASDAQ', currency: 'USD' };
const stkBare: Contract = { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' };
const opt: Contract = {
  conId: 928201828,
  symbol: 'AAPL',
  secType: 'OPT',
  lastTradeDateOrContractMonth: '20261016',
  strike: 250,
  right: 'C',
  multiplier: 100,
  exchange: 'SMART',
  currency: 'USD',
  localSymbol: 'AAPL  261016C00250000',
  tradingClass: 'AAPL',
};
const ind: Contract = { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' };
const fut: Contract = { symbol: 'ES', secType: 'FUT', lastTradeDateOrContractMonth: '202612', exchange: 'CME', currency: 'USD', includeExpired: true };
const bag: Contract = {
  symbol: 'AAPL',
  secType: 'BAG',
  exchange: 'SMART',
  currency: 'USD',
  comboLegs: [
    { conId: 928201828, ratio: 1, action: 'BUY', exchange: 'SMART' },
    { conId: 928201830, ratio: 2, action: 'SELL', exchange: 'SMART', openClose: 0, shortSaleSlot: 0, designatedLocation: '', exemptCode: -1 },
  ],
};
const bagLower = { ...bag, secType: 'bag' } as unknown as Contract;
const bagNoLegs: Contract = { symbol: 'AAPL', secType: 'BAG', exchange: 'SMART', currency: 'USD' };
const deltaNeutral: Contract = { ...stk, deltaNeutralContract: { conId: 265598, delta: 0.5, price: 227.5 } };
const bySecId: Contract = { secType: 'STK', secIdType: 'ISIN', secId: 'US0378331005', exchange: 'SMART', currency: 'USD' };
const bond: Contract = { secType: 'BOND', issuerId: 'e1432232', exchange: 'SMART', currency: 'USD' };
const contracts: Record<string, Contract> = { stk, stkBare, opt, ind, fut, bag, bagLower, bagNoLegs, deltaNeutral, bySecId, bond };

type ConditionSet = {
  PriceCondition: typeof conditions.PriceCondition;
  TimeCondition: typeof conditions.TimeCondition;
  MarginCondition: typeof conditions.MarginCondition;
  ExecutionCondition: typeof conditions.ExecutionCondition;
  VolumeCondition: typeof conditions.VolumeCondition;
  PercentChangeCondition: typeof conditions.PercentChangeCondition;
};

/** Orders built with a given condition class set (ours or @stoqey/ib's). */
function orders(c: ConditionSet): Record<string, { contract: Contract; order: Order }> {
  const price = (): OrderCondition[] => [new c.PriceCondition(260, 0, 265598, 'SMART', true, 'a')];
  const all = (): OrderCondition[] => [
    new c.PriceCondition(260.5, 2, 265598, 'SMART', false, 'o'),
    new c.TimeCondition('20261005 10:00:00 US/Eastern', true, 'a'),
    new c.MarginCondition(30, false, 'a'),
    new c.ExecutionCondition('SMART', 'STK', 'MSFT', 'o'),
    new c.VolumeCondition(100000, 265598, 'SMART', true, 'a'),
    new c.PercentChangeCondition(5.5, 265598, 'SMART', false, 'a'),
  ];
  const lmt: Order = { action: 'BUY', orderType: 'LMT', totalQuantity: 100, lmtPrice: 226.5, tif: 'DAY', transmit: true };
  return {
    LMT: { contract: stk, order: lmt },
    'LMT with account / ref / oca': { contract: stk, order: { ...lmt, account: 'DU123', orderRef: 'tape-1', ocaGroup: 'g1', ocaType: 1 } },
    MKT: { contract: stk, order: { action: 'SELL', orderType: 'MKT', totalQuantity: 10, tif: 'DAY', transmit: true } },
    STP: { contract: stk, order: { action: 'SELL', orderType: 'STP', totalQuantity: 10, auxPrice: 200, tif: 'GTC', transmit: true } },
    'STP LMT': { contract: stk, order: { action: 'SELL', orderType: 'STP LMT', totalQuantity: 10, auxPrice: 200, lmtPrice: 199.5, tif: 'DAY', transmit: true } },
    'TRAIL percent': { contract: stk, order: { action: 'SELL', orderType: 'TRAIL', totalQuantity: 10, trailingPercent: 2.5, tif: 'GTC', transmit: true } },
    'TRAIL amount + trailStopPrice': {
      contract: stk,
      order: { action: 'SELL', orderType: 'TRAIL', totalQuantity: 10, auxPrice: 1.5, trailStopPrice: 220, tif: 'GTC', transmit: true },
    },
    'TRAIL LIMIT': {
      contract: stk,
      order: { action: 'SELL', orderType: 'TRAIL LIMIT', totalQuantity: 10, trailingPercent: 1, trailStopPrice: 220, lmtPriceOffset: 0.1, tif: 'DAY', transmit: true },
    },
    outsideRth: { contract: stk, order: { ...lmt, outsideRth: true } },
    GTC: { contract: stk, order: { ...lmt, tif: 'GTC' } },
    IOC: { contract: stk, order: { ...lmt, tif: 'IOC' } },
    OPG: { contract: stk, order: { ...lmt, tif: 'OPG' } },
    'GTD goodTillDate': { contract: stk, order: { ...lmt, tif: 'GTD', goodTillDate: '20261231 16:00:00 US/Eastern' } },
    'iceberg displaySize': { contract: stk, order: { ...lmt, displaySize: 10 } },
    goodAfterTime: { contract: stk, order: { ...lmt, goodAfterTime: '20261005 09:35:00 US/Eastern' } },
    'bracket parent': { contract: stk, order: { ...lmt, transmit: false } },
    'bracket take profit': { contract: stk, order: { action: 'SELL', orderType: 'LMT', totalQuantity: 100, lmtPrice: 260, parentId: 1001, tif: 'DAY', transmit: false } },
    'bracket stop loss': { contract: stk, order: { action: 'SELL', orderType: 'STP', totalQuantity: 100, auxPrice: 200, parentId: 1001, tif: 'DAY', transmit: true } },
    'price condition': { contract: stk, order: { ...lmt, conditions: price(), conditionsIgnoreRth: true, conditionsCancelOrder: false } },
    'all condition types': { contract: stk, order: { ...lmt, conditions: all(), conditionsIgnoreRth: false, conditionsCancelOrder: true } },
    'empty conditions': { contract: stk, order: { ...lmt, conditions: [] } },
    'BAG combo': {
      contract: bag,
      order: {
        action: 'BUY',
        orderType: 'LMT',
        totalQuantity: 1,
        lmtPrice: -0.35,
        tif: 'DAY',
        transmit: true,
        orderComboLegs: [{ price: 1.2 }, { price: Number.MAX_VALUE }],
        smartComboRoutingParams: [{ tag: 'NonGuaranteed', value: '1' }],
      },
    },
    'BAG without legs': { contract: bagNoLegs, order: { action: 'BUY', orderType: 'LMT', totalQuantity: 1, lmtPrice: 1, transmit: true } },
    'bag secType lower case': { contract: bagLower, order: { action: 'SELL', orderType: 'MKT', totalQuantity: 2, transmit: true } },
    option: { contract: opt, order: { action: 'BUY', orderType: 'LMT', totalQuantity: 2, lmtPrice: 3.15, tif: 'DAY', transmit: true, openClose: 'O' } },
    'future, MAX_VALUE prices': { contract: fut, order: { action: 'BUY', orderType: 'LMT', totalQuantity: 1, lmtPrice: Number.MAX_VALUE, auxPrice: Number.MAX_VALUE, minQty: Number.MAX_VALUE } },
    'delta neutral contract': { contract: deltaNeutral, order: { ...lmt } },
    algo: { contract: stk, order: { ...lmt, algoStrategy: 'Adaptive', algoParams: [{ tag: 'adaptivePriority', value: 'Normal' }], algoId: 'a1' } },
    'algo without params': { contract: stk, order: { ...lmt, algoStrategy: 'Vwap' } },
    hedge: { contract: stk, order: { ...lmt, hedgeType: 'D', hedgeParam: '0.5' } },
    'volatility order': {
      contract: opt,
      order: {
        action: 'BUY',
        orderType: 'VOL',
        totalQuantity: 1,
        volatility: 25,
        volatilityType: 2,
        deltaNeutralOrderType: 'MKT',
        deltaNeutralAuxPrice: 1,
        deltaNeutralConId: 265598,
        deltaNeutralShortSale: true,
        continuousUpdate: 1,
        referencePriceType: 1,
        stockRangeLower: 200,
        stockRangeUpper: 250,
      },
    },
    scale: {
      contract: stk,
      order: {
        ...lmt,
        scaleInitLevelSize: 10,
        scaleSubsLevelSize: 5,
        scalePriceIncrement: 0.1,
        scalePriceAdjustValue: 0.05,
        scalePriceAdjustInterval: 60,
        scaleProfitOffset: 0.5,
        scaleAutoReset: true,
        scaleInitPosition: 0,
        scaleInitFillQty: 0,
        scaleRandomPercent: false,
        scaleTable: '',
      },
    },
    'PEG BENCH': {
      contract: stk,
      order: {
        action: 'BUY',
        orderType: 'PEG BENCH',
        totalQuantity: 1,
        referenceContractId: 756733,
        isPeggedChangeAmountDecrease: false,
        peggedChangeAmount: 0.1,
        referenceChangeAmount: 0.2,
        referenceExchangeId: 'ARCA',
      },
    },
    'PEG BEST up to mid': {
      contract: { ...stk, exchange: 'IBKRATS' },
      order: { action: 'BUY', orderType: 'PEG BEST', totalQuantity: 100, minTradeQty: 10, minCompeteSize: 100, competeAgainstBestOffset: Infinity, midOffsetAtWhole: 0.01, midOffsetAtHalf: 0.005 },
    },
    'PEG BEST offset': { contract: stk, order: { action: 'BUY', orderType: 'PEG BEST', totalQuantity: 100, minCompeteSize: 100, competeAgainstBestOffset: 0.02 } },
    'PEG MID': { contract: stk, order: { action: 'BUY', orderType: 'PEG MID', totalQuantity: 100, midOffsetAtWhole: 0.01, midOffsetAtHalf: 0.005 } },
    'misc attributes': {
      contract: stk,
      order: {
        ...lmt,
        whatIf: true,
        hidden: true,
        allOrNone: true,
        sweepToFill: true,
        blockOrder: true,
        notHeld: true,
        cashQty: 1000,
        softDollarTier: { name: 'tier', value: 'v1' },
        mifid2DecisionMaker: 'dm',
        mifid2ExecutionAlgo: 'ea',
        dontUseAutoPriceForHedge: true,
        isOmsContainer: false,
        discretionaryUpToLimitPrice: true,
        usePriceMgmtAlgo: true,
        duration: 60,
        postToAts: 1,
        autoCancelParent: true,
        advancedErrorOverride: '8229',
        manualOrderTime: '20261005-09:30:00',
        modelCode: 'm1',
        extOperator: 'op',
        triggerMethod: 2,
        discretionaryAmt: 0.5,
        rule80A: 'I',
        shortSaleSlot: 1,
        designatedLocation: '',
        exemptCode: -1,
      },
    },
    'customer account (183+)': { contract: stk, order: { ...lmt, customerAccount: 'C1' } },
    'professional customer (184+)': { contract: stk, order: { ...lmt, professionalCustomer: true } },
    'include overnight (189+)': { contract: { ...stk, exchange: 'OVERNIGHT' }, order: { ...lmt, includeOvernight: true } },
    'manual order indicator (192+)': { contract: stk, order: { ...lmt, manualOrderIndicator: 1 } },
  };
}

type Case = { name: string; method: string; args: unknown[]; mineArgs?: unknown[] };

function requestCases(): Case[] {
  const cases: Case[] = [
    { name: 'reqCurrentTime', method: 'reqCurrentTime', args: [] },
    { name: 'reqManagedAccts', method: 'reqManagedAccts', args: [] },
    { name: 'reqIds', method: 'reqIds', args: [1] },
    { name: 'reqIds 0', method: 'reqIds', args: [0] },
    { name: 'cancelMktData', method: 'cancelMktData', args: [9020] },
    ...[1, 2, 3, 4].map((t) => ({ name: `reqMarketDataType ${t}`, method: 'reqMarketDataType', args: [t] })),
    { name: 'reqMktDepth smart', method: 'reqMktDepth', args: [9024, stk, 10, true, []] },
    { name: 'reqMktDepth options', method: 'reqMktDepth', args: [9024, stkBare, 5, false, [{ tag: 'a', value: 'b' }]] },
    { name: 'reqMktDepth no options', method: 'reqMktDepth', args: [9024, stk, 5, false, undefined] },
    { name: 'cancelMktDepth smart', method: 'cancelMktDepth', args: [9024, true] },
    { name: 'cancelMktDepth', method: 'cancelMktDepth', args: [9024, false] },
    { name: 'cancelHistoricalData', method: 'cancelHistoricalData', args: [9022] },
    { name: 'cancelHeadTimestamp', method: 'cancelHeadTimestamp', args: [9023] },
    { name: 'reqMatchingSymbols', method: 'reqMatchingSymbols', args: [9014, 'AAPL'] },
    { name: 'reqMatchingSymbols unicode', method: 'reqMatchingSymbols', args: [9014, 'Café 中'] },
    { name: 'reqSecDefOptParams STK', method: 'reqSecDefOptParams', args: [9012, 'AAPL', '', 'STK', 265598] },
    { name: 'reqSecDefOptParams FUT', method: 'reqSecDefOptParams', args: [9012, 'ES', 'CME', 'FUT', 495512551] },
    { name: 'reqAccountUpdates subscribe', method: 'reqAccountUpdates', args: [true, 'DU123'] },
    { name: 'reqAccountUpdates unsubscribe', method: 'reqAccountUpdates', args: [false, ''] },
    { name: 'reqAccountSummary', method: 'reqAccountSummary', args: [9001, 'All', 'NetLiquidation,TotalCashValue,$LEDGER:USD'] },
    { name: 'cancelAccountSummary', method: 'cancelAccountSummary', args: [9001] },
    { name: 'reqPositions', method: 'reqPositions', args: [] },
    { name: 'cancelPositions', method: 'cancelPositions', args: [] },
    { name: 'reqPnL', method: 'reqPnL', args: [9002, 'DU123', ''] },
    { name: 'reqPnL model', method: 'reqPnL', args: [9002, 'DU123', 'model1'] },
    { name: 'cancelPnL', method: 'cancelPnL', args: [9002] },
    { name: 'reqPnLSingle', method: 'reqPnLSingle', args: [9003, 'DU123', '', 265598] },
    { name: 'cancelPnLSingle', method: 'cancelPnLSingle', args: [9003] },
    { name: 'reqOpenOrders', method: 'reqOpenOrders', args: [] },
    { name: 'reqAllOpenOrders', method: 'reqAllOpenOrders', args: [] },
    { name: 'reqAutoOpenOrders true', method: 'reqAutoOpenOrders', args: [true] },
    { name: 'reqAutoOpenOrders false', method: 'reqAutoOpenOrders', args: [false] },
    { name: 'reqCompletedOrders', method: 'reqCompletedOrders', args: [false] },
    { name: 'reqCompletedOrders apiOnly', method: 'reqCompletedOrders', args: [true] },
    { name: 'reqExecutions empty filter', method: 'reqExecutions', args: [9015, {}] },
    {
      name: 'reqExecutions full filter',
      method: 'reqExecutions',
      args: [9015, { clientId: '121', acctCode: 'DU123', time: '20261005-09:30:00', symbol: 'AAPL', secType: 'STK', exchange: 'SMART', side: 'BUY' }],
    },
    { name: 'cancelOrder default', method: 'cancelOrder', args: [11, { manualOrderCancelTime: undefined, extOperator: '', manualOrderIndicator: undefined }] },
    { name: 'cancelOrder manual time', method: 'cancelOrder', args: [11, { manualOrderCancelTime: '20261005-09:30:00', extOperator: '', manualOrderIndicator: undefined }] },
    { name: 'cancelOrder CME tagging', method: 'cancelOrder', args: [11, { extOperator: 'op', manualOrderIndicator: 1 }] },
    { name: 'reqGlobalCancel default', method: 'reqGlobalCancel', args: [{ manualOrderCancelTime: undefined, extOperator: '', manualOrderIndicator: undefined }] },
    { name: 'reqGlobalCancel CME tagging', method: 'reqGlobalCancel', args: [{ extOperator: 'op', manualOrderIndicator: 0 }] },
  ];
  for (const [label, c] of Object.entries(contracts)) {
    cases.push({ name: `reqMktData ${label}`, method: 'reqMktData', args: [9020, c, '', false, false] });
    cases.push({ name: `reqContractDetails ${label}`, method: 'reqContractDetails', args: [9010, c] });
    cases.push({ name: `reqHistoricalData ${label}`, method: 'reqHistoricalData', args: [9022, c, '', '2 D', '1 hour', 'TRADES', 1, 1, false, undefined] });
    cases.push({ name: `reqHeadTimestamp ${label}`, method: 'reqHeadTimestamp', args: [9023, c, 'TRADES', true, 1] });
  }
  cases.push(
    { name: 'reqMktData generic ticks + snapshot', method: 'reqMktData', args: [9020, opt, '100,101,104,106', true, false] },
    { name: 'reqMktData regulatory snapshot', method: 'reqMktData', args: [9020, stk, '', true, true] },
    { name: 'reqHistoricalData end time, RTH false, keepUpToDate', method: 'reqHistoricalData', args: [9022, stk, '20261002 16:00:00 US/Eastern', '1 W', '5 mins', 'MIDPOINT', false, 2, true, undefined] },
    { name: 'reqHistoricalData useRTH true', method: 'reqHistoricalData', args: [9022, opt, undefined, '30 D', '1 day', 'BID_ASK', true, 1, false, [{ tag: 'x', value: 'y' }]] },
    { name: 'reqHeadTimestamp RTH false', method: 'reqHeadTimestamp', args: [9023, fut, 'MIDPOINT', false, 2] },
  );
  return cases;
}

// ---------------------------------------------------------------------------

function encodeMine(sv: number, method: string, args: unknown[]): StoqeyEncodeResult {
  try {
    return { tokens: (encoder as any)[method](sv, ...args), errors: [] };
  } catch (err) {
    if (!(err instanceof TwsEncodeError)) throw err;
    return { tokens: null, errors: [{ message: err.message, code: err.code, reqId: err.reqId }] };
  }
}

describe('encoder helpers', () => {
  it('flattens nested arrays and converts booleans like the socket layer', () => {
    expect(encoder.toTokens([1, [true, [false, 'x']], undefined, null, new Boolean(true)])).toEqual([1, 1, 0, 'x', undefined, null, 1]);
  });

  it('joins fields with NUL, sending undefined / null as empty fields', () => {
    expect(encoder.frameText([3, undefined, 'AAPL', null, 1.5])).toBe('3\0\0AAPL\0\x001.5');
  });

  it('encodes tag-value lists like EClient', () => {
    expect(encoder.encodeTagValues([{ tag: 'a', value: '1' }, { tag: 'b', value: '2' }])).toBe('a=1;b=2;');
    expect(encoder.encodeTagValues(undefined)).toBe('');
  });

  it('sends START_API with the client id and empty optional capabilities', () => {
    expect(encoder.startApi(193, 121)).toEqual([71, 2, 121, '']);
  });

  it('encodes orderMiscOptions as tag=value text', () => {
    const tokens = encoder.placeOrder(193, 1, stk, { action: 'BUY', orderType: 'LMT', totalQuantity: 1, lmtPrice: 1, orderMiscOptions: [{ tag: 'k', value: 'v' }] });
    expect(tokens).toContain('k=v;');
  });

  it('sends the extended scale fields only for a real price increment, like EClient', () => {
    const base: Order = { action: 'BUY', orderType: 'LMT', totalQuantity: 1, lmtPrice: 1 };
    const len = (o: Partial<Order>) => encoder.placeOrder(193, 1, stk, { ...base, ...o }).length;
    expect(len({ scalePriceIncrement: 0 })).toBe(len({}));
    expect(len({ scalePriceIncrement: Number.MAX_VALUE })).toBe(len({}));
    expect(len({ scalePriceIncrement: 0.05 })).toBe(len({}) + 7);
  });

  it('sends unset adjusted-order prices empty', () => {
    const base: Order = { action: 'SELL', orderType: 'STP', totalQuantity: 1, auxPrice: 1 };
    const tokens = encoder.placeOrder(193, 1, stk, { ...base, triggerPrice: Number.MAX_VALUE, lmtPriceOffset: Number.MAX_VALUE, adjustedStopPrice: Number.MAX_VALUE });
    expect(tokens).toEqual(encoder.placeOrder(193, 1, stk, base));
  });

  it('refuses a control character in a text field (a NUL would split the field)', () => {
    const base: Order = { action: 'BUY', orderType: 'LMT', totalQuantity: 1, lmtPrice: 1 };
    let err: unknown;
    try {
      encoder.placeOrder(193, 9, stk, { ...base, orderRef: 'x\u0000INJECTED' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TwsEncodeError);
    expect(err).toMatchObject({ reqId: 9, message: expect.stringContaining('control character') });
    expect(() => encoder.placeOrder(193, 9, stk, { ...base, ocaGroup: 'g\u00001' })).toThrow(TwsEncodeError);
    expect(() => encoder.placeOrder(193, 9, { ...stk, symbol: 'A\nB' }, base)).toThrow(TwsEncodeError);
    expect(() => encoder.placeOrder(193, 9, stk, { ...base, orderRef: '备注 note' })).not.toThrow();
    expect(() => encoder.checkFieldText(193, [1, 'ok', undefined, 2.5])).not.toThrow();
  });

  it('rejects attributes newer than the server version', () => {
    expect(() => encoder.placeOrder(182, 7, stk, { action: 'BUY', orderType: 'MKT', customerAccount: 'C' })).toThrow(
      'Server Version 182: It does not support customer account parameter',
    );
    expect(() => encoder.cancelOrder(191, 7, { extOperator: 'x' })).toThrow(TwsEncodeError);
    expect(() => encoder.cancelOrder(192, 7, { extOperator: 'x' })).not.toThrow();
  });
});

// Test names are kept stable: the stored snapshots (server versions 176 and 193) are asserted
// on every run, while the comparison with @stoqey/ib only runs when it is installed.
describe('encoder vs @stoqey/ib (all server versions 176..193)', () => {
  const ours = orders(conditions);
  const theirs = stoqey ? orders(stoqey.lib as ConditionSet) : ours;

  for (const sv of VERSIONS) {
    const snapshot = sv === MIN_SERVER_VERSION || sv === MAX_SERVER_VERSION;
    describe(`server version ${sv}`, () => {
      for (const c of requestCases()) {
        it.skipIf(!stoqey && !snapshot)(c.name, () => {
          const actual = encodeMine(sv, c.method, c.mineArgs ?? c.args);
          if (stoqey) expect(actual).toStrictEqual(stoqey.encode(sv, (enc) => enc[c.method](...c.args)));
          if (snapshot) expect(actual).toMatchSnapshot();
        });
      }
      for (const name of Object.keys(ours)) {
        it.skipIf(!stoqey && !snapshot)(`placeOrder ${name}`, () => {
          const actual = encodeMine(sv, 'placeOrder', [1001, ours[name].contract, ours[name].order]);
          if (stoqey) expect(actual).toStrictEqual(stoqey.encode(sv, (enc) => enc.placeOrder(1001, theirs[name].contract, theirs[name].order)));
          if (snapshot) expect(actual).toMatchSnapshot();
        });
      }
    });
  }

  it.skipIf(!stoqey)('condition classes match @stoqey/ib (fields and strValue)', () => {
    const s = stoqey as NonNullable<typeof stoqey>;
    const a = orders(conditions)['all condition types'].order.conditions!;
    const b = orders(s.lib as ConditionSet)['all condition types'].order.conditions!;
    expect(a.map((x) => ({ ...x, strValue: (x as { strValue?: string }).strValue }))).toStrictEqual(
      b.map((x) => ({ ...x, strValue: (x as { strValue?: string }).strValue })),
    );
  });
});
