import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import type { Execution, WorkingOrder } from '@shared/types';
import { csvCell, csvFileName, ordersCsv, toCsv } from './csv';

describe('csvCell', () => {
  it('quotes separators, quotes and newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');
  });

  it('defuses formulas but keeps signed numbers', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-12.5')).toBe('-12.5');
  });
});

describe('ordersCsv', () => {
  const o: WorkingOrder = {
    orderId: 4012,
    clientId: 7,
    account: 'DU1',
    key: 'STK:AAPL',
    contract: stock('AAPL'),
    action: 'SELL',
    orderType: 'STP LMT',
    totalQuantity: 50,
    limitPrice: 244.5,
    auxPrice: 245,
    tif: 'GTC',
    outsideRth: false,
    status: 'PreSubmitted',
    filled: 0,
    remaining: 50,
    avgFillPrice: 0,
    createdAt: new Date(2026, 9, 4, 9, 41, 5).getTime(),
    updatedAt: 0,
  };
  const e: Execution = {
    execId: '0001f4e8.1',
    orderId: 4008,
    account: 'DU1',
    key: 'OPT:AAPL:20261016:230:C',
    contract: option('AAPL', '20261016', 230, 'C'),
    side: 'BUY',
    shares: 10,
    price: 3.1,
    time: new Date(2026, 9, 4, 10, 12, 9).getTime(),
    exchange: 'CBOE',
    commission: 6.5,
    realizedPnL: Number.MAX_VALUE,
  };

  it('writes one header and one row per order and trade', () => {
    const lines = ordersCsv([o], [e]).trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith('Record,Time,Account,Order ID')).toBe(true);
    expect(lines[1]).toBe('Open order,2026-10-04 09:41:05,DU1,4012,7,AAPL,AAPL,STK,SELL,STP LMT,50,244.5,245,0,PreSubmitted,GTC,,,,SMART,');
    expect(lines[2]).toBe('Trade,2026-10-04 10:12:09,DU1,4008,,AAPL 10/16 230 Call,AAPL,OPT,BUY,,10,3.1,,10,Filled,,3100,6.5,,CBOE,0001f4e8.1');
  });

  it('ends rows with CRLF', () => {
    expect(toCsv([['a', 1]])).toBe('a,1\r\n');
  });

  it('names the file by date', () => {
    expect(csvFileName(new Date(2026, 9, 4).getTime())).toBe('tape-orders-2026-10-04.csv');
  });
});
