import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import { index, option, stock } from '@shared/contract';
import { initialTicket, type TicketState } from '../../state/store';
import { buyingPowerAfter, conditionContract, money, priceInput, resolveTicket, stepQty, tickDecimals, trailStop, type TicketMarket } from './ticketModel';

const ticket = (patch: Partial<TicketState> = {}): TicketState => ({ ...initialTicket(defaultSettings()), ...patch });
const mkt: TicketMarket = { bid: 227.48, ask: 227.49, last: 227.5, refLast: 227.5, minTick: 0.01, multiplier: 1 };

describe('stepQty', () => {
  it('follows the design steps and mirrors them going down', () => {
    expect(stepQty(100, 1)).toBe(200);
    expect(stepQty(200, -1)).toBe(100);
    expect(stepQty(100, -1)).toBe(90);
    expect(stepQty(90, 1)).toBe(100);
    expect(stepQty(10, 1)).toBe(20);
    expect(stepQty(10, -1)).toBe(9);
    expect(stepQty(9, 1)).toBe(10);
    expect(stepQty(1, -1)).toBe(1);
    expect(stepQty(0, 1)).toBe(1);
  });
});

describe('tick helpers', () => {
  it('derives decimals from the minimum tick', () => {
    expect(tickDecimals(0.01)).toBe(2);
    expect(tickDecimals(0.05)).toBe(2);
    expect(tickDecimals(0.25)).toBe(2);
    expect(tickDecimals(0.0001)).toBe(4);
    expect(tickDecimals(0.005)).toBe(3);
    expect(tickDecimals(0)).toBe(2);
  });

  it('formats input prices without separators', () => {
    expect(priceInput(1234.5, 0.01)).toBe('1234.50');
    expect(priceInput(undefined, 0.01)).toBe('');
    expect(priceInput(0.12345, 0.0001)).toBe('0.1235');
  });
});

describe('resolveTicket', () => {
  it('LMT defaults to the ask for buys and the bid for sells', () => {
    expect(resolveTicket(ticket(), mkt).limit).toBe(227.49);
    expect(resolveTicket(ticket({ side: 'SELL' }), mkt).limit).toBe(227.48);
  });

  it('LMT falls back to the last price and honours an override', () => {
    expect(resolveTicket(ticket(), { ...mkt, ask: undefined }).limit).toBe(227.5);
    expect(resolveTicket(ticket({ limitPrice: 225 }), mkt).limit).toBe(225);
  });

  it('leaves prices undefined without market data', () => {
    const m = resolveTicket(ticket(), { minTick: 0.01, multiplier: 1 });
    expect(m.limit).toBeUndefined();
    expect(m.est).toBeUndefined();
    expect(m.takeProfitText).toBe('');
  });

  it('MKT uses the touch for the estimate', () => {
    const m = resolveTicket(ticket({ orderType: 'MKT', qty: 100 }), mkt);
    expect(m.limit).toBeUndefined();
    expect(m.entry).toBe(227.49);
    expect(m.est).toBeCloseTo(22749);
  });

  it('STP defaults to last ±1% rounded to the tick', () => {
    expect(resolveTicket(ticket({ orderType: 'STP' }), mkt).stop).toBe(229.78);
    expect(resolveTicket(ticket({ orderType: 'STP', side: 'SELL' }), mkt).stop).toBe(225.23);
    expect(resolveTicket(ticket({ orderType: 'STP' }), { ...mkt, minTick: 0.05 }).stop).toBe(229.8);
  });

  it('STP LMT derives the limit from the trigger', () => {
    const m = resolveTicket(ticket({ orderType: 'STP LMT', stopPrice: 230 }), mkt);
    expect(m.stop).toBe(230);
    expect(m.limit).toBe(230.46);
    expect(m.entry).toBe(230.46);
  });

  it('TRAIL computes the initial stop from percent or amount', () => {
    expect(resolveTicket(ticket({ orderType: 'TRAIL', side: 'SELL', trailMode: 'pct', trailAmt: '3' }), mkt).stop).toBe(220.67);
    expect(resolveTicket(ticket({ orderType: 'TRAIL', trailMode: 'amt', trailAmt: '2' }), mkt).stop).toBe(229.5);
    expect(resolveTicket(ticket({ orderType: 'TRAIL', trailAmt: 'x' }), mkt).stop).toBeUndefined();
    expect(trailStop(100, false, 'amt', 150)).toBeUndefined();
  });

  it('estimates with the multiplier', () => {
    const m = resolveTicket(ticket({ qty: 2, limitPrice: 4.25 }), { ...mkt, multiplier: 100 });
    expect(m.est).toBe(850);
  });

  it('bracket defaults are +3% / −2% from the entry for buys, mirrored for sells', () => {
    const b = resolveTicket(ticket({ limitPrice: 100 }), mkt);
    expect(b.takeProfitText).toBe('103.00');
    expect(b.stopLossText).toBe('98.00');
    expect(b.takeProfitPct).toBeCloseTo(3);
    expect(b.stopLossPct).toBeCloseTo(-2);
    const s = resolveTicket(ticket({ side: 'SELL', limitPrice: 100 }), mkt);
    expect(s.takeProfitText).toBe('97.00');
    expect(s.stopLossText).toBe('102.00');
  });

  it('typed bracket and condition values win over defaults', () => {
    const m = resolveTicket(ticket({ limitPrice: 100, takeProfit: '110', stopLoss: '', condPx: '240' }), mkt);
    expect(m.takeProfit).toBe(110);
    expect(m.takeProfitPct).toBeCloseTo(10);
    expect(m.stopLoss).toBeUndefined();
    expect(m.condPrice).toBe(240);
  });

  it('condition defaults to ±3% of the reference price', () => {
    expect(resolveTicket(ticket(), mkt).condText).toBe('234.33');
    expect(resolveTicket(ticket({ condOp: '<=' }), mkt).condText).toBe('220.67');
  });
});

describe('conditionContract', () => {
  it('watches the underlying for options', () => {
    expect(conditionContract(option('AAPL', '20261016', 230, 'C'))).toEqual(stock('AAPL'));
    expect(conditionContract(stock('TSLA'))).toEqual(stock('TSLA'));
    expect(conditionContract(index('SPX', 'CBOE')).secType).toBe('IND');
  });
});

describe('money and buying power', () => {
  it('formats amounts in the instrument currency', () => {
    expect(money(46393, 'USD')).toBe('$46,393.00');
    expect(money(46393, 'EUR')).toBe('46,393.00 EUR');
    expect(money(undefined, 'EUR')).toBe('—');
    expect(money(12.5, '')).toBe('$12.50');
  });

  it('subtracts a buy only when it is in the account currency', () => {
    const acct = { buyingPower: 1_000_000, currency: 'USD' };
    expect(buyingPowerAfter(acct, 46393, 'USD', true)).toBe(953_607);
    expect(buyingPowerAfter(acct, 46393, 'EUR', true)).toBeUndefined();
    expect(buyingPowerAfter({ buyingPower: 500_000, currency: 'EUR' }, 46393, 'EUR', true)).toBe(453_607);
    expect(buyingPowerAfter(acct, undefined, 'USD', true)).toBeUndefined();
  });

  it('leaves buying power unchanged for sells and unknown without an account', () => {
    expect(buyingPowerAfter({ buyingPower: 1000, currency: 'USD' }, 46393, 'EUR', false)).toBe(1000);
    expect(buyingPowerAfter(null, 100, 'USD', true)).toBeUndefined();
    expect(buyingPowerAfter({ currency: 'USD' }, 100, 'USD', false)).toBeUndefined();
  });
});
