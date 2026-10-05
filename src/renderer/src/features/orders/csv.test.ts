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
    expect(lines[0]).toContain(',Status,TIF,Session,Good till,Amount,');
    expect(lines[0].endsWith(',Exec ID,Attributes,Algo,Conditions,OCA group,Route,Note')).toBe(true);
    expect(lines[1]).toBe('Open order,2026-10-04 09:41:05,DU1,4012,7,AAPL,AAPL,STK,SELL,STP LMT,50,244.5,245,0,PreSubmitted,GTC,Regular,,,,,SMART,,,,,,,');
    expect(lines[2]).toBe('Trade,2026-10-04 10:12:09,DU1,4008,,AAPL 10/16 230 Call,AAPL,OPT,BUY,,10,3.1,,10,Filled,,,,3100,6.5,,CBOE,0001f4e8.1,,,,,,');
  });

  it('writes the attributes, algo, conditions, OCA group, route and note in IB terms', () => {
    const rich: WorkingOrder = {
      ...o,
      orderType: 'LMT',
      allOrNone: true,
      hidden: true,
      discretionaryAmt: 0.05,
      displaySize: 10,
      triggerMethod: 8,
      algo: { strategy: 'Vwap', params: { maxPctVol: 0.1, startTime: '09:45' } },
      conditions: {
        items: [
          { kind: 'price', contract: { ...stock('SPY'), conId: 756733 }, operator: '>=', price: 600, triggerMethod: 2, join: 'or' },
          { kind: 'time', time: '20261009 10:00:00 US/Eastern' },
        ],
        cancel: true,
        outsideRth: true,
      },
      oca: { group: 'exit', type: 3 },
      route: 'NASDAQ',
      orderRef: 'swing, part 1',
    };
    const line = ordersCsv([rich], []).trimEnd().split('\r\n')[1];
    expect(line.endsWith(
      ',NASDAQ,,AON;Hidden;Disc=0.05;Display=10;Trigger=8,Vwap maxPctVol=0.1 startTime=09:45,price SPY >= 600 trigger=2 or time 20261009 10:00:00 US/Eastern cancel outsideRth,exit (type 3),NASDAQ,"swing, part 1"',
    )).toBe(true);
  });

  it('writes the session, the GTD expiry and the OVERNIGHT venue', () => {
    const rows = ordersCsv(
      [
        { ...o, tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern', outsideRth: true, session: 'extended' },
        { ...o, orderType: 'LMT', tif: 'DAY', session: 'overnight' },
        { ...o, orderType: 'LMT', tif: 'DAY', session: 'overnightDay', outsideRth: true },
      ],
      [],
    )
      .trimEnd()
      .split('\r\n')
      .slice(1)
      .map((l) => l.split(','));
    expect(rows.map((r) => [r[15], r[16], r[17], r[21]])).toEqual([
      ['GTD', 'Outside RTH', '20261009 16:00:00 US/Eastern', 'SMART'],
      ['DAY', 'Overnight', '', 'OVERNIGHT'],
      ['DAY', 'Overnight + Day', '', 'SMART'],
    ]);
  });

  it('ends rows with CRLF', () => {
    expect(toCsv([['a', 1]])).toBe('a,1\r\n');
  });

  it('names the file by date', () => {
    expect(csvFileName(new Date(2026, 9, 4).getTime())).toBe('tape-orders-2026-10-04.csv');
  });
});
