import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import { ADD_ON_TICKS } from '@shared/quoteProfiles';
import { createClock } from '@shared/timeFormat';
import type { ContractInfo, ContractRef, EarningsEvent, Position, Quote, SecType } from '@shared/types';
import { positionRow, quoteContract } from './calc';
import { cellColor, cellText, formatValue, optionLineText, type CellWords } from './cells';
import {
  COLUMN_GROUPS,
  COLUMN_IDS,
  COLUMNS,
  DEFAULT_COLUMNS,
  addOnSubscriptions,
  applies,
  contractOrderKey,
  rowId,
  todaysHours,
  zonedInstant,
  type CellCtx,
  type ColumnId,
} from './columns';
import { sortBy } from './columnsState';
import { columnTip, usePortfolioMessages } from './messages';

// Tuesday 2026-10-06, 11:00 local.
const NOW = new Date(2026, 9, 6, 11, 0).getTime();
const clock = createClock('24h', 'en');
const en = usePortfolioMessages.for('en');
const words: CellWords = { ...en.words, kinds: en.kinds };

function position(contract: ContractRef, over: Partial<Position> = {}): Position {
  return { account: 'DU1', key: contract.symbol, contract, quantity: 100, multiplier: contract.secType === 'OPT' ? 100 : 1, updatedAt: 0, ...over };
}

const q = (over: Partial<Quote>): Quote => ({ key: 'k', updatedAt: 0, ...over });

/** A cell context; the row's mark comes from the quote, as usePositionRows reads it. */
function ctx(p: Position, opts: { fx?: number | null; quote?: Quote; info?: ContractInfo | null; earnings?: EarningsEvent } = {}): CellCtx {
  const fx = opts.fx === undefined ? 1 : opts.fx;
  return { row: positionRow(p, opts.quote?.mark, 'Technology', fx), q: opts.quote, info: opts.info, earnings: opts.earnings, now: NOW };
}

const value = (id: ColumnId, c: CellCtx) => COLUMNS[id].value(c);
const text = (id: ColumnId, c: CellCtx) => cellText(COLUMNS[id], c, words, clock);

const aaplStock = { ...stock('AAPL', 'NASDAQ'), conId: 265598 };
const aapl = position(aaplStock, {
  averageCost: 200,
  marketPrice: 220,
  marketValue: 22_000,
  unrealizedPnL: 2_000,
  realizedPnL: 0,
  dailyPnL: 150,
  pnlValue: 22_748,
  pnlUnrealized: 2_748,
  pnlRealized: 12.5,
  industry: 'Technology',
  stockType: 'COMMON',
});
const aaplQuote = q({ last: 227.48, bid: 227.45, ask: 227.5, mark: 227.47, bidSize: 300, askSize: 200, close: 225, volume: 41_200_000, marketDataType: 1, haltCode: 0, lastRthTrade: 227.1 });

const call = { ...option('AAPL', '20261016', 230, 'C'), conId: 7001 };
const aaplCall = position(call, { quantity: 10, averageCost: 310 });
const callQuote = q({ bid: 3.1, ask: 3.3, mark: 3.2, iv: 0.27, delta: 0.45, gamma: 0.03, theta: -0.09, vega: 0.2, undPrice: 227.48, optPrice: 3.18, pvDividend: 0.26, openInterest: 5_120 });

describe('column catalog', () => {
  it('lists every column once, each with a definition in its group', () => {
    expect(new Set(COLUMN_IDS).size).toBe(COLUMN_IDS.length);
    expect(Object.keys(COLUMNS).sort()).toEqual([...COLUMN_IDS].sort());
    for (const id of COLUMN_IDS) {
      expect(COLUMNS[id].id).toBe(id);
      expect(COLUMN_GROUPS).toContain(COLUMNS[id].group);
    }
    // The editor lists the groups in catalog order, each contiguous.
    const groups = COLUMN_IDS.map((id) => COLUMNS[id].group);
    expect(groups.filter((g, i) => g !== groups[i - 1])).toEqual([...COLUMN_GROUPS]);
    expect(COLUMN_GROUPS).toEqual(['position', 'contract', 'quote', 'stats', 'short', 'income', 'options', 'other', 'calc']);
    expect(COLUMN_IDS).toHaveLength(126);
  });

  it('keeps one column per datum: IB’s figures merged, Tape’s calculations in their own group', () => {
    const ids: readonly string[] = COLUMN_IDS;
    for (const gone of ['marketPriceIb', 'marketValueIb', 'unrealizedIb', 'realizedIb', 'dailyPnlIb', 'unrealizedPnlIb', 'realizedPnlIb', 'valuePnlIb', 'mark']) expect(ids, gone).not.toContain(gone);
    for (const calc of ['avgPrice', 'weight', 'valueBase', 'pctGross', 'totalPnl', 'daysToExpiry', 'moneyness', 'positionDelta', 'navPremium', 'nextEarningsEst'])
      expect(ids, calc).not.toContain(calc);
    // Every calculated column is in the Calculated group, and only they are.
    for (const id of COLUMN_IDS) expect(COLUMNS[id].group === 'calc', id).toBe(!!COLUMNS[id].calc);
    expect(COLUMN_IDS.filter((id) => COLUMNS[id].group === 'position')).toEqual([
      'symbol',
      'name',
      'secType',
      'quantity',
      'averageCost',
      'price',
      'value',
      'unrealized',
      'realized',
      'dayPnl',
      'currency',
      'fxRate',
      'account',
    ]);
  });

  it('defaults to IB’s figures: Symbol, Qty, Avg cost, Price, Value, Unrl. P&L, Day P&L', () => {
    expect(DEFAULT_COLUMNS).toEqual(['symbol', 'quantity', 'averageCost', 'price', 'value', 'unrealized', 'dayPnl']);
  });

  it('names every column and says where IB sends its value, in both languages', () => {
    for (const lang of ['en', 'zh'] as const) {
      const m = usePortfolioMessages.for(lang);
      for (const id of COLUMN_IDS) {
        expect(m.columns[id][0], `${lang} ${id}`).toBeTruthy();
        expect(m.columns[id][1], `${lang} ${id}`).toBeTruthy();
        expect(m.sources[id], `${lang} source ${id}`).toBeTruthy();
      }
      // No "(IB)" or "(IB live)" in a header: every column is IB's.
      for (const id of COLUMN_IDS) expect(m.columns[id][0], `${lang} ${id}`).not.toMatch(/\(IB/);
    }
  });

  it('starts every tooltip with IB’s source, or Tape’s formula for a calculated column', () => {
    expect(columnTip(en, 'bid').startsWith('IB · tick 1 Bid')).toBe(true);
    expect(columnTip(en, 'value').split('\n')).toEqual(['IB · reqPnLSingle value (real time), else updatePortfolio marketValue (every 3 min). The cell’s tooltip says which', 'Market value']);
    for (const id of COLUMN_IDS) expect(columnTip(en, id).startsWith(COLUMNS[id].calc ? 'Tape · ' : 'IB · '), id).toBe(true);
    expect(columnTip(en, 'mid').split('\n')).toEqual(['Tape · (Bid + Ask) ÷ 2', 'Midpoint of the bid and ask']);
  });

  it('says why an unverified column is not verified yet, in both languages', () => {
    for (const lang of ['en', 'zh'] as const) {
      const m = usePortfolioMessages.for(lang);
      for (const id of COLUMN_IDS) {
        if (COLUMNS[id].unverified) expect(m.unverified[id], `${lang} ${id}`).toBeTruthy();
        else expect(m.unverified[id], `${lang} ${id}`).toBeUndefined();
      }
    }
    expect(columnTip(en, 'borrowFee').split('\n')).toEqual([
      'IB · tick 111 SLB rate – fee (generic tick 499), as sent',
      'Borrow fee rate',
      'Not yet verified: the unit: read as an annual rate (0.0025 = 0.25 %), not yet compared with TWS',
    ]);
    expect(columnTip(usePortfolioMessages.for('zh'), 'vwap').split('\n').at(-1)).toBe('尚未核实： 常规时段以外 IB 未发送 RTVolume');
    expect(columnTip(en, 'shortable').split('\n')).toHaveLength(2);
  });

  it('asks for extra ticks only on types the profile has ticks for, and never for a default column', () => {
    for (const id of COLUMN_IDS) {
      const { profile, types, needs } = COLUMNS[id];
      if (!profile) continue;
      expect(needs, id).toBe('quote');
      const allowed = profile === 'dividends' ? ['STK'] : Object.keys(ADD_ON_TICKS[profile]);
      expect(types, id).toBeDefined();
      for (const t of types!) expect(allowed, `${id} ${t}`).toContain(t);
    }
    // Price's mark (tick 37) is on the positions' lines already (usePositionRows: the `mark` profile).
    expect(DEFAULT_COLUMNS.filter((id) => COLUMNS[id].profile)).toEqual([]);
  });
});

describe('the sources of IB’s figures', () => {
  // AAPL with both of IB's sources: the P&L engine (real time) and the portfolio update (every 3 minutes).
  const both = position(aaplStock, {
    averageCost: 200,
    marketPrice: 220,
    marketValue: 22_000,
    unrealizedPnL: 2_000,
    realizedPnL: 0,
    dailyPnL: 150,
    pnlValue: 22_748,
    pnlUnrealized: 2_748,
    pnlRealized: 12.5,
  });
  const tip = (id: ColumnId, c: CellCtx) => COLUMNS[id].title?.(c, words);

  it('shows the real-time source first and says so in the cell’s tooltip', () => {
    const c = ctx(both, { quote: q({ mark: 227.48 }) });
    expect([value('price', c), value('value', c), value('unrealized', c), value('realized', c), value('dayPnl', c)]).toEqual([227.48, 22_748, 2_748, 12.5, 150]);
    expect(tip('price', c)).toBe('IB mark price (real time)');
    for (const id of ['value', 'unrealized', 'realized', 'dayPnl'] as const) expect(tip(id, c), id).toBe('IB P&L (real time)');
  });

  it('falls back to the portfolio update in the same column, and says so', () => {
    const late = ctx({ ...both, pnlValue: undefined, pnlUnrealized: undefined, pnlRealized: undefined, dailyPnL: undefined }, { quote: q({ last: 227.48 }) });
    expect([value('price', late), value('value', late), value('unrealized', late), value('realized', late)]).toEqual([220, 22_000, 2_000, 0]);
    for (const id of ['price', 'value', 'unrealized', 'realized'] as const) expect(tip(id, late), id).toBe('IB portfolio update (every 3 min)');
    // The day's P&L has only IB's P&L engine: "—" with no source.
    expect(text('dayPnl', late)).toBe('—');
    expect(tip('dayPnl', late)).toBeUndefined();
    // Neither source: "—" and no tooltip.
    const none = ctx(position(aaplStock));
    for (const id of ['price', 'value', 'unrealized', 'realized'] as const) {
      expect(text(id, none), id).toBe('—');
      expect(tip(id, none), id).toBeUndefined();
    }
    const zh = usePortfolioMessages.for('zh');
    expect(COLUMNS.value.title!(late, { ...zh.words, kinds: zh.kinds })).toBe('IB 持仓更新（每 3 分钟）');
  });

  it('takes Price from the mark (tick 37), whatever the last trade or the midpoint', () => {
    // The last trade and the bid / ask say other things: Price is IB's mark.
    const c = ctx(both, { quote: q({ last: 230, bid: 226, ask: 226.2, mark: 226.1 }) });
    expect(value('price', c)).toBe(226.1);
    // An option the same way: its mark, never the midpoint.
    expect(value('price', ctx(aaplCall, { quote: q({ bid: 3.1, ask: 3.3, mark: 3.25 }) }))).toBe(3.25);
    expect(value('price', ctx({ ...aaplCall, marketPrice: 4.25 }, { quote: q({ bid: 3.1, ask: 3.3 }) }))).toBe(4.25);
  });

  it('shows Avg cost exactly as IB sends it: per contract, never divided by the multiplier', () => {
    expect(value('averageCost', ctx(both))).toBe(200);
    expect(value('averageCost', ctx(aaplCall))).toBe(310);
    expect(text('averageCost', ctx(aaplCall))).toBe('310.00');
    expect(text('averageCost', ctx(position(aaplStock)))).toBe('—');
  });
});

describe('column applicability', () => {
  const fut = position({ symbol: 'MES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218', multiplier: 5, conId: 9 }, { quantity: 2, multiplier: 5 });
  const cash = position({ symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' });
  const rows = { stk: ctx(aapl).row, opt: ctx(aaplCall).row, fut: ctx(fut).row, cash: ctx(cash).row };
  const on = (id: ColumnId) => Object.entries(rows).flatMap(([k, r]) => (applies(COLUMNS[id], r) ? [k] : []));

  it('limits type-specific columns to their instruments', () => {
    expect(on('quantity')).toEqual(['stk', 'opt', 'fut', 'cash']);
    expect(on('strike')).toEqual(['opt']);
    expect(on('expiry')).toEqual(['opt', 'fut']);
    expect(on('delta')).toEqual(['opt']);
    expect(on('stockType')).toEqual(['stk']);
    expect(on('lastRthTrade')).toEqual(['stk']);
    // IB's figures of every position.
    for (const id of ['averageCost', 'price', 'value', 'unrealized', 'realized', 'dayPnl'] as const) expect(on(id), id).toEqual(['stk', 'opt', 'fut', 'cash']);
    // Forex quotes carry no trades.
    expect(on('last')).toEqual(['stk', 'opt', 'fut']);
    expect(on('bid')).toEqual(['stk', 'opt', 'fut', 'cash']);
    // A bond's details arrive whole: IB's name and minimum tick.
    const bond = ctx(position({ symbol: 'US912810TM08', secType: 'BOND', exchange: 'SMART', currency: 'USD', conId: 11 })).row;
    expect(applies(COLUMNS.name, bond)).toBe(true);
    expect(applies(COLUMNS.minTick, bond)).toBe(true);
    expect(applies(COLUMNS.cusip, bond)).toBe(true);
    expect(on('name')).toEqual(['stk', 'opt', 'fut', 'cash']);
    expect(on('underlying')).toEqual(['opt', 'fut']);
    expect(on('contractMonth')).toEqual(['opt', 'fut']);
    expect(on('high52w')).toEqual(['stk']);
    expect(on('impliedVol30')).toEqual(['stk', 'fut']);
    expect(on('futuresOpenInterest')).toEqual(['fut']);
    expect(on('nextEarnings')).toEqual(['stk', 'opt']);
    expect(on('cusip')).toEqual([]);
    // ETF columns: stocks IB types as exchange-traded only.
    expect(on('etfNav')).toEqual([]);
    const spy = ctx(position({ ...stock('SPY', 'ARCA'), conId: 756733 }, { stockType: 'ETF' })).row;
    expect(applies(COLUMNS.etfNav, spy)).toBe(true);
  });

  it('shows IB’s own contract fields, never Tape’s stand-ins', () => {
    // updatePortfolio names no exchange; SMART is Tape's placeholder until the position message.
    expect(text('exchange', ctx({ ...fut, contract: { ...fut.contract, exchange: 'SMART' } }))).toBe('—');
    expect(value('exchange', ctx(fut))).toBe('CME');
    // The multiplier as IB sent it: a stock's is 1, an option without IB's is unknown (not 100).
    expect(value('multiplier', ctx(fut))).toBe(5);
    expect(value('multiplier', ctx(aapl))).toBe(1);
    const bare = { ...call, multiplier: undefined };
    expect(text('multiplier', ctx(position(bare)))).toBe('—');
    expect(value('multiplier', ctx(aaplCall))).toBe(100);
  });

  it('writes forex prices to IB’s precision', () => {
    const c = ctx(cash, { quote: q({ bid: 1.0834, ask: 1.0835, close: 1.0821, mark: 1.08345 }) });
    expect(text('bid', c)).toBe('1.08340');
    expect(text('close', c)).toBe('1.08210');
    expect(text('price', c)).toBe('1.08345');
    const jpy = position({ symbol: 'USD', secType: 'CASH', exchange: 'IDEALPRO', currency: 'JPY' });
    expect(text('ask', ctx(jpy, { quote: q({ bid: 150.12, ask: 150.125, mark: 150.125 }) }))).toBe('150.125');
    // Others keep the shared price format.
    expect(text('bid', ctx(aapl, { quote: aaplQuote }))).toBe('227.45');
  });

  it('leaves a cell empty when the column does not apply and shows — when IB has not sent the value', () => {
    const c = ctx(aapl);
    expect(text('strike', c)).toBe('');
    expect(text('bid', c)).toBe('—');
    expect(text('name', c)).toBe('—');
    expect(text('bid', { ...c, q: aaplQuote })).toBe('227.45');
  });
});

describe('column values', () => {
  it('reads a stock with a live quote', () => {
    const c = ctx(aapl, { quote: aaplQuote });
    expect(value('quantity', c)).toBe(100);
    expect(value('averageCost', c)).toBe(200);
    expect(value('price', c)).toBe(227.47);
    expect(value('value', c)).toBe(22_748);
    expect(value('unrealized', c)).toBe(2_748);
    expect(value('realized', c)).toBe(12.5);
    expect(value('dayPnl', c)).toBe(150);
    expect(text('unrealized', c)).toBe('+2,748');
    expect(cellColor(COLUMNS.unrealized, value('unrealized', c))).toBe('var(--up)');
    // Quote and contract.
    expect(value('last', c)).toBe(227.48);
    expect(value('close', c)).toBe(225);
    expect(value('exchange', c)).toBe('NASDAQ');
    expect(value('conId', c)).toBe(265598);
    expect(text('conId', c)).toBe('265598');
    expect(text('halted', c)).toBe('Trading');
    expect(text('dataType', c)).toBe('Live');
    expect(text('dataType', { ...c, q: { ...aaplQuote, marketDataType: 3, source: { kind: 'primary', exchange: 'ARCA' } } })).toBe('Delayed · ARCA');
    expect(text('volume', c)).toBe('41.2M');
  });

  it('reads an option with IB’s model greeks', () => {
    const c = ctx(aaplCall, { quote: callQuote });
    expect(value('price', c)).toBe(3.2);
    expect(value('averageCost', c)).toBe(310);
    expect(text('expiry', c)).toBe('2026-10-16');
    expect(text('right', c)).toBe('Call');
    expect(value('underlying', c)).toBe('AAPL');
    expect(text('optIv', c)).toBe('27.0%');
    expect(value('delta', c)).toBe(0.45);
    expect(text('gamma', c)).toBe('0.0300');
    expect(value('undPrice', c)).toBe(227.48);
    expect(value('optModelPrice', c)).toBe(3.18);
    expect(value('pvDividend', c)).toBe(0.26);
    expect(text('openInterest', c)).toBe('5,120');
  });

  it('writes an option row’s second line from IB’s contract: the right and the expiry', () => {
    expect(optionLineText(call, words)).toBe('Call · 10/16');
    expect(optionLineText({ ...option('SPY', '20261120', 560, 'P') }, words)).toBe('Put · 11/20');
    const zh = usePortfolioMessages.for('zh');
    expect(optionLineText(call, { ...zh.words, kinds: zh.kinds })).toBe('看涨 · 10/16');
    // A futures option; one without an expiry date; not an option.
    expect(optionLineText({ symbol: 'ES', secType: 'FOP', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218', strike: 6000, right: 'C' }, words)).toBe('Call · 12/18');
    expect(optionLineText({ ...call, lastTradeDate: undefined }, words)).toBe('Call');
    expect(optionLineText(aaplStock, words)).toBeUndefined();
  });

  it('shows a foreign-currency position in its currency, with IB’s exchange rate', () => {
    const sap = position({ symbol: 'SAP', secType: 'STK', exchange: 'SMART', primaryExchange: 'IBIS', currency: 'EUR', conId: 14204 }, { quantity: 50, pnlValue: 11_000 });
    const c = ctx(sap, { fx: 1.08 });
    expect(value('currency', c)).toBe('EUR');
    expect(value('fxRate', c)).toBe(1.08);
    expect(value('value', c)).toBe(11_000);
    // Without the rate: "—", never 1.
    expect(text('fxRate', ctx(sap, { fx: null }))).toBe('—');
  });

  it('reads contract details', () => {
    const info: ContractInfo = {
      contract: aaplStock,
      longName: 'APPLE INC',
      industry: 'Technology',
      subcategory: 'Computers',
      minTick: 0.01,
      timeZoneId: 'US/Eastern',
      liquidHours: '20261006:0930-20261006:1600;20261007:0930-20261007:1600',
    };
    // 11:00 in New York (the hours are the instrument's).
    const c = { ...ctx(aapl, { info }), now: Date.UTC(2026, 9, 6, 15, 0) };
    expect(value('name', c)).toBe('APPLE INC');
    expect(value('subcategory', c)).toBe('Computers');
    expect(text('minTick', c)).toBe('0.01');
    expect(value('liquidHours', c)).toBe('0930-1600');
    expect(text('liquidHours', c)).toBe('09:30–16:00');
    expect(COLUMNS.liquidHours.title!(c, words)).toBe('US/Eastern');
    expect(text('tradingHours', c)).toBe('—');
  });
});

describe('calculated columns', () => {
  it('works out the change, mid, spread and the position figures from IB’s fields', () => {
    const c = { ...ctx(aapl, { quote: { ...aaplQuote, open: 226 } }), netLiq: 100_000 };
    expect(value('change', c)).toBeCloseTo(2.48, 10);
    expect(text('change', c)).toBe('+2.48');
    expect(value('changePct', c)).toBeCloseTo(2.48 / 225, 10);
    expect(text('changePct', c)).toBe('+1.10%');
    expect(value('changeOpen', c)).toBeCloseTo(1.48, 10);
    expect(value('mid', c)).toBeCloseTo(227.475, 10);
    expect(value('spread', c)).toBeCloseTo(0.05, 10);
    expect(value('costBasis', c)).toBe(20_000);
    // reqPnLSingle's unrealized P&L against the cost basis.
    expect(value('unrealizedPct', c)).toBeCloseTo(2_748 / 20_000, 10);
    expect(text('unrealizedPct', c)).toBe('+13.74%');
    expect(value('pctNetLiq', c)).toBeCloseTo(0.22748, 10);
    // Without a net liquidation, or a last trade, there is nothing to show.
    expect(value('pctNetLiq', { ...c, netLiq: undefined })).toBeUndefined();
    expect(value('change', ctx(aapl, { quote: { ...aaplQuote, last: undefined } }))).toBeUndefined();
  });

  it('compares a short’s unrealized P&L with what it was sold for, and converts its value at IB’s rate', () => {
    const short = position(aaplStock, { quantity: -100, averageCost: 250, pnlUnrealized: 2_252, pnlValue: -22_748 });
    const c = { ...ctx(short, { quote: aaplQuote, fx: 0.5 }), netLiq: 100_000 };
    expect(value('costBasis', c)).toBe(-25_000);
    expect(value('unrealizedPct', c)).toBeCloseTo(2_252 / 25_000, 10);
    expect(value('pctNetLiq', c)).toBeCloseTo(-0.11374, 10);
  });

  it('takes an option’s 0 bid in the mid, and no crossed quote', () => {
    expect(value('mid', ctx(aaplCall, { quote: { ...callQuote, bid: 0, ask: 0.1 } }))).toBeCloseTo(0.05, 10);
    expect(value('spread', ctx(aaplCall, { quote: { ...callQuote, bid: 3.4, ask: 3.3 } }))).toBeUndefined();
  });

  it('works out the yield and the ratios of the underlying statistics', () => {
    const c = ctx(aapl, { quote: { ...aaplQuote, dividends: { next12m: 1.04 }, putVolume: 300, callVolume: 600, putOpenInterest: 900, callOpenInterest: 0, impliedVol: 0.3, rtHistVol: 0.25 } });
    expect(value('divYield', c)).toBeCloseTo(1.04 / 227.47, 10);
    expect(text('divYield', c)).toBe('0.46%');
    expect(value('putCallVolume', c)).toBe(0.5);
    expect(text('putCallVolume', c)).toBe('0.50');
    // No call open interest: no ratio.
    expect(value('putCallInterest', c)).toBeUndefined();
    expect(value('ivHv', c)).toBeCloseTo(1.2, 10);
    expect(text('ivHv', c)).toBe('120.00%');
    // Their generic ticks are asked for only while the columns are shown.
    expect(COLUMNS.divYield.profile).toBe('dividends');
    expect(COLUMNS.putCallVolume.profile).toBe('optionFlow');
    expect(COLUMNS.ivHv.profile).toBe('volatility');
  });

  it('counts the calendar days to the last trading day in New York', () => {
    // NOW is 10/06; the call's last trading day 10/16.
    expect(value('daysToLastTrade', ctx(aaplCall))).toBe(10);
    expect(text('daysToLastTrade', ctx(aapl))).toBe('');
  });
});

describe("today's trading hours", () => {
  // 11:00 in New York.
  const at = Date.UTC(2026, 9, 6, 15, 0);
  it('takes the sessions ending today in the instrument’s zone', () => {
    expect(todaysHours('20261006:0400-20261006:2000;20261007:0400-20261007:2000', 'US/Eastern', at)).toBe('0400-2000');
    expect(todaysHours('20261006:CLOSED;20261007:0930-20261007:1600', 'US/Eastern', at)).toBe('CLOSED');
    // A futures session from the evening before counts for the day it ends.
    expect(todaysHours('20261005:1700-20261006:1600;20261006:1700-20261007:1600', 'US/Central', at)).toBe('1700-1600');
    // Older servers leave out the end date.
    expect(todaysHours('20261006:0930-1200,1300-1600', 'US/Eastern', at)).toBe('0930-1200,1300-1600');
    expect(todaysHours('20261007:0930-20261007:1600', 'US/Eastern', at)).toBeUndefined();
    expect(todaysHours(undefined, 'US/Eastern', at)).toBeUndefined();
    // An unknown zone falls back to the local date.
    expect(() => todaysHours('20261006:0930-1600', 'Nowhere/Else', at)).not.toThrow();
  });
});

describe('cell formats', () => {
  it('writes IB codes as words', () => {
    expect(formatValue('kind', 'FOP', words, clock, NOW)).toBe('Future option');
    expect(formatValue('halt', 2, words, clock, NOW)).toBe('Volatility halt');
    expect(formatValue('dataType', 4, words, clock, NOW)).toBe('Delayed frozen');
    expect(formatValue('hours', 'CLOSED', words, clock, NOW)).toBe('Closed');
    expect(formatValue('hours', '0930-1200,1300-1600', words, clock, NOW)).toBe('09:30–12:00, 13:00–16:00');
    const zh = usePortfolioMessages.for('zh');
    expect(formatValue('right', 'P', { ...zh.words, kinds: zh.kinds }, clock, NOW)).toBe('看跌');
  });

  it('writes numbers with the shared helpers', () => {
    expect(formatValue('pnl', 2_748.4, words, clock, NOW)).toBe('+2,748');
    expect(formatValue('pnl', -1_234.4, words, clock, NOW)).toBe('−1,234');
    expect(formatValue('big', 5_120, words, clock, NOW)).toBe('5,120');
    expect(formatValue('dec', 5, words, clock, NOW)).toBe('5');
    expect(formatValue('num4', 1.08, words, clock, NOW)).toBe('1.0800');
    expect(formatValue('greek4', 0.0012, words, clock, NOW)).toBe('0.0012');
    expect(formatValue('px', undefined, words, clock, NOW)).toBe('—');
    expect(formatValue('px', Number.NaN, words, clock, NOW)).toBe('—');
  });

  it('writes the time of day, with the date when it is not today', () => {
    expect(formatValue('time', new Date(2026, 9, 6, 9, 41).getTime(), words, clock, NOW)).toBe('09:41');
    expect(formatValue('time', new Date(2026, 9, 5, 16, 0).getTime(), words, clock, NOW)).toBe('10/05 16:00');
  });
});

describe('symbol order', () => {
  it('puts a stock’s options right after it, by expiry, strike and right', () => {
    const contracts: ContractRef[] = [
      stock('AMZN'),
      option('AAPL', '20261120', 200, 'C'),
      option('AAPL', '20261016', 230, 'P'),
      stock('AAPL'),
      option('AAPL', '20261016', 230, 'C'),
      option('AAPL', '20261016', 95, 'C'),
    ];
    const sorted = sortBy(contracts, contractOrderKey, 'text', 'asc');
    expect(sorted.map((c) => (c.secType === 'STK' ? c.symbol : `${c.symbol} ${c.lastTradeDate} ${c.strike}${c.right}`))).toEqual([
      'AAPL',
      'AAPL 20261016 95C',
      'AAPL 20261016 230C',
      'AAPL 20261016 230P',
      'AAPL 20261120 200C',
      'AMZN',
    ]);
  });

  it('identifies rows by conId, else by key', () => {
    expect(rowId(ctx(aapl).row)).toBe('265598');
    expect(rowId(ctx(position(stock('MSFT'))).row)).toBe('MSFT');
  });
});

describe('the extra ticks of the shown columns', () => {
  const spy = position({ ...stock('SPY'), exchange: 'ARCA', conId: 756733 }, { stockType: 'ETF', key: 'SPY' });
  const fut = position({ symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218', multiplier: 50, conId: 515416632 }, { quantity: 1, multiplier: 50 });
  const cash = position({ symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD', conId: 12087792 });
  const rows = [aapl, aaplCall, spy, fut, cash].map((p) => ctx(p).row);
  const subsOf = (...ids: ColumnId[]) => addOnSubscriptions(rows, ids.map((id) => COLUMNS[id])).map((s) => `${contractKey(s.contract)}|${s.profile}`);

  it('asks for nothing with the default columns (the mark is on the portfolio’s lines)', () => {
    expect(addOnSubscriptions(rows, DEFAULT_COLUMNS.map((id) => COLUMNS[id]))).toEqual([]);
    expect(addOnSubscriptions(rows, COLUMN_IDS.filter((id) => !COLUMNS[id].profile).map((id) => COLUMNS[id]))).toEqual([]);
  });

  it('asks per position and profile, only where the column applies and the profile has ticks', () => {
    // One entry for the range columns; the ETF is a stock too.
    expect(subsOf('high52w', 'low52w', 'avgVolume')).toEqual(['STK:AAPL|range', 'STK:SPY|range']);
    // NAV for the ETF only.
    expect(subsOf('etfNav', 'etfNavHigh')).toEqual(['STK:SPY|etfNav']);
    expect(subsOf('impliedVol30', 'futuresOpenInterest')).toEqual(['FUT:ES:20261218|futuresOi', 'FUT:ES:20261218|volatility', 'STK:AAPL|volatility', 'STK:SPY|volatility']);
    expect(subsOf('divNext12m', 'divNextDate')).toEqual(['STK:AAPL|dividends', 'STK:SPY|dividends']);
    expect(subsOf('bidYield', 'cusip', 'nextEarnings')).toEqual([]);
  });

  it('asks for the portfolio’s own quote contracts, so no new line opens', () => {
    const subs = addOnSubscriptions(rows, [COLUMNS.shortable, COLUMNS.futuresOpenInterest]);
    expect(subs.map((s) => s.contract)).toEqual([quoteContract(fut.contract), quoteContract(aapl.contract), quoteContract(spy.contract)]);
    // SPY's position names its listing; the quote is SMART-routed, as the portfolio's.
    expect(subs[2].contract).toMatchObject({ exchange: 'SMART', primaryExchange: 'ARCA' });
  });

  it('is the same list for the same columns in any order', () => {
    const a = addOnSubscriptions(rows, [COLUMNS.vwap, COLUMNS.high52w, COLUMNS.low52w]);
    const b = addOnSubscriptions([...rows].reverse(), [COLUMNS.low52w, COLUMNS.vwap, COLUMNS.high52w]);
    expect(b).toEqual(a);
  });
});

describe('the columns of extra market data, earnings and contract details', () => {
  it('reads a stock’s statistics, short-sale data and dividends', () => {
    const quote = q({
      ...aaplQuote,
      volume: 22_794_339,
      week52High: 260,
      week52Low: 169.21,
      week26High: 250,
      week13Low: 201.5,
      avgVolume: 45_588_678,
      impliedVol: 0.2636,
      rtHistVol: 0.231,
      callVolume: 462_487,
      callOpenInterest: 2_275_669,
      avgOptionVolume: 1_339_031,
      tradeRate: 12,
      volume10m: 320,
      vwap: 226.91,
      auctionImbalance: -25_000,
      shortable: 3,
      shortableShares: 191_230_895,
      borrowFee: 0.0025,
      dividends: { past12m: 1.06, next12m: 1.1, nextDate: '20261109', nextAmount: 0.27 },
    });
    const c = ctx(aapl, { quote });
    expect(text('high52w', c)).toBe('260.00');
    expect(text('low52w', c)).toBe('169.21');
    expect(text('high26w', c)).toBe('250.00');
    expect(text('low13w', c)).toBe('201.50');
    expect(text('avgVolume', c)).toBe('45.6M');
    expect(text('impliedVol30', c)).toBe('26.4%');
    expect(text('rtHistVol', c)).toBe('23.1%');
    expect(text('callVolume', c)).toBe('462.5K');
    expect(text('callOpenInterest', c)).toBe('2.3M');
    expect(text('avgOptionVolume', c)).toBe('1.3M');
    expect(text('tradeRate', c)).toBe('12');
    expect(text('volume10m', c)).toBe('320');
    expect(text('vwap', c)).toBe('226.91');
    expect(text('auctionImbalance', c)).toBe('−25.0K');
    expect(text('shortable', c)).toBe('Easy');
    expect(COLUMNS.shortable.title!(c, words)).toBe('IB 3');
    expect(text('shortableShares', c)).toBe('191.2M');
    expect(text('borrowFee', c)).toBe('0.0025');
    expect(text('divPast12m', c)).toBe('1.06');
    expect(text('divNext12m', c)).toBe('1.10');
    expect(text('divNextDate', c)).toBe('2026-11-09');
    expect(text('divNextAmount', c)).toBe('0.27');
    // A delayed line has none of them: "—", never an older value.
    const bare = ctx(aapl, { quote: aaplQuote });
    for (const id of ['high52w', 'avgVolume', 'shortable', 'divNext12m', 'divNextDate', 'vwap'] as const) expect(text(id, bare), id).toBe('—');
  });

  it('shows no dividend as 0 when IB says the stock pays none, and "—" while IB has sent nothing', () => {
    // IB's ",,," (tickMap.ts → parseDividends): the summary came, without amounts or a date.
    const none = ctx(aapl, { quote: q({ ...aaplQuote, dividends: {} }) });
    expect([text('divPast12m', none), text('divNext12m', none)]).toEqual(['0.00', '0.00']);
    // No next dividend to date or size.
    expect([text('divNextDate', none), text('divNextAmount', none)]).toEqual(['—', '—']);
    const bare = ctx(aapl, { quote: aaplQuote });
    for (const id of ['divPast12m', 'divNext12m'] as const) expect(text(id, bare), id).toBe('—');
  });

  it('writes IB’s shortable code as words, by its thresholds', () => {
    const at = (shortable: number) => text('shortable', ctx(aapl, { quote: q({ shortable }) }));
    expect([at(3), at(2.6), at(2.5), at(2), at(1.5), at(0)]).toEqual(['Easy', 'Easy', 'Locate', 'Locate', 'No', 'No']);
    const zh = usePortfolioMessages.for('zh');
    expect(cellText(COLUMNS.shortable, ctx(aapl, { quote: q({ shortable: 2 }) }), { ...zh.words, kinds: zh.kinds }, clock)).toBe('需借券');
  });

  it('reads an ETF’s NAV', () => {
    const spy = position({ ...stock('SPY', 'ARCA'), conId: 756733 }, { stockType: 'ETF', key: 'SPY' });
    const c = ctx(spy, { quote: q({ last: 571.3, etfNav: 571.0, etfNavHigh: 572.4, etfNavLow: 569.9 }) });
    expect(text('etfNav', c)).toBe('571.00');
    expect(text('etfNavHigh', c)).toBe('572.40');
    expect(text('etfNavLow', c)).toBe('569.90');
    // Not an ETF: the cell is empty.
    expect(text('etfNav', ctx(aapl, { quote: q({ etfNav: 1 }) }))).toBe('');
  });

  it('reads a future’s open interest, IV, mark (Price, also on a delayed line) and volume rate', () => {
    const fut = position({ symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218', multiplier: 50, conId: 515416632 }, { quantity: 1, multiplier: 50 });
    const c = ctx(fut, { quote: q({ marketDataType: 3, futuresOpenInterest: 1_921_143, mark: 7877.65, impliedVol: 0.12183, volumeRate: 154 }) });
    expect(text('futuresOpenInterest', c)).toBe('1.9M');
    expect(text('price', c)).toBe('7,877.65');
    expect(text('impliedVol30', c)).toBe('12.2%');
    expect(text('volumeRate', c)).toBe('154');
    // Stock-only columns stay empty.
    expect(text('divNext12m', c)).toBe('');
  });

  it('shows 321 in Quote status while IB refused the line’s extra ticks', () => {
    const c = ctx(aapl, { quote: q({ last: 227.48, ticksRefused: 'addOns' }) });
    expect(text('quoteStatus', c)).toBe('321');
    expect(COLUMNS.quoteStatus.title!(c, words)).toBe(en.words.ticksRefused.addOns);
    // IB's own error comes first.
    const err = ctx(aapl, { quote: q({ ticksRefused: 'all', error: { code: 10197, message: 'No market data during competing live session' } }) });
    expect(text('quoteStatus', err)).toBe('10197');
    expect(COLUMNS.quoteStatus.title!(err, words)).toBe('No market data during competing live session');
    expect(text('quoteStatus', ctx(aapl, { quote: q({ last: 1 }) }))).toBe('—');
  });

  it('shows the earnings from Wall Street Horizon; options their underlying’s', () => {
    const wsh: EarningsEvent = { key: 'STK:AAPL', date: '20261030', time: 'amc' };
    expect(text('nextEarnings', ctx(aapl, { earnings: wsh }))).toBe('2026-10-30 AMC');
    expect(text('nextEarnings', ctx(aapl, { earnings: { key: 'STK:AAPL', date: '20261030' } }))).toBe('2026-10-30');
    expect(text('nextEarnings', ctx(aaplCall, { earnings: { ...wsh, time: 'bmo' } }))).toBe('2026-10-30 BMO');
    expect(text('nextEarnings', ctx(aapl))).toBe('—');
    const zh = usePortfolioMessages.for('zh');
    expect(cellText(COLUMNS.nextEarnings, ctx(aapl, { earnings: { ...wsh, time: 'dmh' } }), { ...zh.words, kinds: zh.kinds }, clock)).toBe('2026-10-30 盘中');
  });

  it('reads the contract details of version 2', () => {
    const optInfo: ContractInfo = {
      contract: { ...call, lastTradeDate: '20261016' },
      longName: 'APPLE INC',
      minTick: 0.01,
      v: 2,
      marketName: 'AAPL',
      contractMonth: '202610',
      realExpirationDate: '20261016',
      lastTradeTime: '16:00:00',
      lastTradeZone: 'US/Eastern',
      underSymbol: 'AAPL',
      underConId: 265598,
      underSecType: 'STK',
    };
    const c = ctx(aaplCall, { info: optInfo });
    expect(text('contractMonth', c)).toBe('2026-10');
    expect(value('lastTradeTime', c)).toBe('20261016 16:00');
    expect(text('lastTradeTime', c)).toBe('2026-10-16 16:00');
    expect(cellText(COLUMNS.lastTradeTime, c, words, createClock('12h', 'en'))).toBe('2026-10-16 04:00 PM');
    expect(COLUMNS.lastTradeTime.title!(c, words)).toBe('US/Eastern');
    expect(text('realExpiration', c)).toBe('2026-10-16');
    expect(text('marketName', c)).toBe('AAPL');
    expect(text('underlying', c)).toBe('AAPL');
    expect(COLUMNS.underlying.title!(c, words)).toBe('STK · conId 265598');
    // Before the details come: an option's own symbol; a future's underlying waits for them.
    expect(text('underlying', ctx(aaplCall))).toBe('AAPL');
    const fop = position({ symbol: 'ES', secType: 'FOP', exchange: 'CME', currency: 'USD', lastTradeDate: '20261016', strike: 7880, right: 'C', multiplier: 50, conId: 919511013 }, { quantity: 1, multiplier: 50 });
    expect(text('underlying', ctx(fop))).toBe('—');
    expect(text('underlying', ctx(fop, { info: { ...optInfo, underSymbol: 'ESZ6', underSecType: 'FUT', underConId: 515416632 } }))).toBe('ESZ6');
    // A stock's ISIN and market.
    const stkInfo: ContractInfo = { contract: aaplStock, longName: 'APPLE INC', minTick: 0.01, v: 2, isin: 'US0378331005', marketName: 'NMS' };
    expect(text('isin', ctx(aapl, { info: stkInfo }))).toBe('US0378331005');
    expect(text('marketName', ctx(aapl, { info: stkInfo }))).toBe('NMS');
    // Details of version 1 lack them: "—".
    expect(text('isin', ctx(aapl, { info: { contract: aaplStock, longName: 'APPLE INC', minTick: 0.01 } }))).toBe('—');
  });

  it('sorts the last trade by its instant, across the instruments’ zones', () => {
    // 2026-12-18: ES stops at 08:30 Chicago (14:30 UTC), an equity option at 09:00 New York (14:00 UTC).
    expect(zonedInstant('20261218', '08:30', 'US/Central')).toBe(Date.UTC(2026, 11, 18, 14, 30));
    expect(zonedInstant('20261218', '09:00', 'US/Eastern')).toBe(Date.UTC(2026, 11, 18, 14, 0));
    // Summer time, and an unknown or missing zone (the wall time as UTC).
    expect(zonedInstant('20261016', '16:00:00', 'US/Eastern')).toBe(Date.UTC(2026, 9, 16, 20, 0));
    expect(zonedInstant('20261016', '16:00', 'Mars/Olympus')).toBe(Date.UTC(2026, 9, 16, 16, 0));
    expect(zonedInstant('20261016', '16:00', undefined)).toBe(Date.UTC(2026, 9, 16, 16, 0));
    const fut = position({ symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218', multiplier: 50, conId: 515416632 }, { quantity: 1, multiplier: 50 });
    const opt = position({ ...option('SPY', '20261218', 600, 'C'), conId: 7002 }, { quantity: 1 });
    const es = ctx(fut, { info: { contract: fut.contract, longName: 'E-mini S&P 500', minTick: 0.25, v: 2, lastTradeTime: '08:30:00', lastTradeZone: 'US/Central' } });
    const spy = ctx(opt, { info: { contract: opt.contract, longName: 'SPY', minTick: 0.01, v: 2, lastTradeTime: '09:00:00', lastTradeZone: 'US/Eastern' } });
    expect([value('lastTradeTime', es), value('lastTradeTime', spy)]).toEqual(['20261218 08:30', '20261218 09:00']);
    const sorted = sortBy([es, spy], (c) => COLUMNS.lastTradeTime.sortValue!(c), COLUMNS.lastTradeTime.sort, 'asc');
    expect(sorted.map((c) => c.row.position.contract.symbol)).toEqual(['SPY', 'ES']);
  });

  it('sorts the earnings of one day by the time of day: before the open, during, after the close, unknown', () => {
    const at = (time: EarningsEvent['time']) => ctx(aapl, { earnings: { key: 'STK:AAPL', date: '20261030', ...(time ? { time } : {}) } });
    const days = [at('amc'), at(undefined), at('dmh'), at('bmo')];
    const order = sortBy(days, (c) => COLUMNS.nextEarnings.sortValue!(c), COLUMNS.nextEarnings.sort, 'asc').map((c) => c.earnings!.time ?? '?');
    expect(order).toEqual(['bmo', 'dmh', 'amc', '?']);
    // A later date comes after, whatever its time.
    const next = ctx(aapl, { earnings: { key: 'STK:AAPL', date: '20261031', time: 'bmo' } });
    expect(COLUMNS.nextEarnings.sortValue!(next)! > COLUMNS.nextEarnings.sortValue!(at(undefined))!).toBe(true);
  });

  it('reads a bond’s details and yields', () => {
    const bond = position({ symbol: 'US-T', secType: 'BOND', exchange: 'SMART', currency: 'USD', conId: 742000123 }, { quantity: 10_000, averageCost: 0.98 });
    const info: ContractInfo = {
      contract: bond.contract,
      longName: 'United States Treasury',
      minTick: 0.0001,
      v: 2,
      isin: 'US91282CLW90',
      bond: { cusip: '91282CLW9', coupon: 4.25, maturity: '20341115', bondType: 'US-T', callable: true, putable: false, convertible: true, descAppend: 'T 4 1/4 11/15/34', notes: 'Reopening' },
    };
    const c = ctx(bond, { info, quote: q({ bidYield: 4.2125, askYield: -0.1, lastYield: 0, bondFactor: 0.98765 }) });
    expect(text('name', c)).toBe('United States Treasury');
    expect(text('minTick', c)).toBe('0.0001');
    expect(text('isin', c)).toBe('US91282CLW90');
    expect(text('cusip', c)).toBe('91282CLW9');
    expect(text('coupon', c)).toBe('4.25');
    expect(text('maturity', c)).toBe('2034-11-15');
    expect(text('bondType', c)).toBe('US-T');
    expect(text('bondFeatures', c)).toBe('Callable · Convertible');
    expect(text('bondDesc', c)).toBe('T 4 1/4 11/15/34');
    expect(COLUMNS.bondDesc.title!(c, words)).toBe('Reopening');
    expect(text('bidYield', c)).toBe('4.213');
    expect(text('askYield', c)).toBe('−0.100');
    expect(text('lastYield', c)).toBe('0.000');
    expect(text('bondFactor', c)).toBe('0.98765');
    const plain = { ...info, bond: { ...info.bond, callable: false, putable: false, convertible: false } };
    expect(text('bondFeatures', ctx(bond, { info: plain }))).toBe('None');
    expect(text('bondFeatures', ctx(bond, { info: { ...info, bond: {} } }))).toBe('—');
  });
});

describe('new cell formats', () => {
  it('writes months, stamps, earnings, 3 decimals and features', () => {
    expect(formatValue('month', '202612', words, clock, NOW)).toBe('2026-12');
    expect(formatValue('stamp', '20261218 08:30', words, clock, NOW)).toBe('2026-12-18 08:30');
    expect(formatValue('stamp', '20261218 08:30', words, createClock('12h', 'zh'), NOW)).toBe('2026-12-18 上午 08:30');
    expect(formatValue('earn', '20261030|bmo', words, clock, NOW)).toBe('2026-10-30 BMO');
    expect(formatValue('earn', '20261030|', words, clock, NOW)).toBe('2026-10-30');
    expect(formatValue('num3', 4.2125, words, clock, NOW)).toBe('4.213');
    expect(formatValue('features', 'putable', words, clock, NOW)).toBe('Putable');
    expect(formatValue('shortable', 1, words, clock, NOW)).toBe('No');
    for (const fmt of ['month', 'stamp', 'earn', 'num3', 'features', 'shortable'] as const) expect(formatValue(fmt, undefined, words, clock, NOW)).toBe('—');
  });

  it('sorts the shortable column by IB’s code, not its word', () => {
    expect(COLUMNS.shortable.sort).toBe('num');
    const types: SecType[] = ['STK'];
    expect(COLUMNS.shortable.types).toEqual(types);
  });
});
