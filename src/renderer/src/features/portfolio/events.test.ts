import { describe, expect, it } from 'vitest';
import { contractKey, index, option, stock } from '@shared/contract';
import { createClock } from '@shared/timeFormat';
import type { ContractRef, Position } from '@shared/types';
import { positionRow, type PositionRow } from './calc';
import { EVENT_WINDOW_DAYS, earningsState, etClock, eventLabel, eventSig, holdingUnderlyings, monthDay, nextEvents, type CorporateEvent, type EventWords } from './events';
import { usePortfolioMessages } from './messages';

function row(contract: ContractRef, quantity = 1): PositionRow {
  const p: Position = { account: 'DU1', key: contractKey(contract), contract, quantity, avgPrice: 1, multiplier: contract.secType === 'OPT' ? 100 : 1, updatedAt: 0 };
  return positionRow(p, undefined, 1_000_000, 'x');
}

// Tuesday 2026-10-06, 11:00 in New York (days count on New York's calendar, whatever the machine's zone).
const NOW = new Date(Date.UTC(2026, 9, 6, 15, 0));

const rows = [row(stock('AAPL')), row(stock('TSLA')), row(option('NVDA', '20261120', 200, 'C')), row(index('SPX', 'CBOE'))];
const und = holdingUnderlyings(rows);

describe('the holdings’ underlyings', () => {
  it('lists stocks and the underlyings of options, not other instruments', () => {
    expect([...und.keys()].sort()).toEqual(['STK:AAPL', 'STK:NVDA', 'STK:TSLA']);
    // An option on an index keys its index.
    expect([...holdingUnderlyings([row(option('SPX', '20261120', 6000, 'P'))]).keys()]).toEqual(['IND:SPX']);
    // An option on a non-USD stock keys that stock, in its currency, as the stock's own row does.
    const hk = holdingUnderlyings([row({ ...option('700', '20261029', 500, 'C'), currency: 'HKD' }), row({ ...stock('700'), currency: 'HKD' })]);
    expect([...hk.keys()]).toEqual(['STK:700:HKD']);
  });
});

describe('next events', () => {
  it('keeps the soonest event per underlying, today through two weeks ahead', () => {
    expect(EVENT_WINDOW_DAYS).toBe(14);
    const events = nextEvents(
      und,
      { 'STK:AAPL': { nextDate: '20261009', nextAmount: 0.26 }, 'STK:TSLA': {}, 'STK:NVDA': { nextDate: '20261001', nextAmount: 0.01 } },
      {
        status: 'ok',
        events: [
          { key: 'STK:AAPL', date: '20261029', time: 'amc' },
          { key: 'STK:NVDA', date: '20261006' },
          { key: 'STK:MSFT', date: '20261007' },
        ],
      },
      NOW,
    );
    // AAPL: the ex-dividend date comes before its earnings; NVDA's dividend date is past; MSFT is not held.
    expect([...events.values()].map((e) => [e.symbol, e.kind, e.days, e.amount])).toEqual([
      ['NVDA', 'earnings', 0, undefined],
      ['AAPL', 'dividend', 3, 0.26],
    ]);
    expect(events.get('STK:AAPL')?.underlying).toMatchObject({ symbol: 'AAPL', secType: 'STK' });
  });

  it('counts the window inclusively', () => {
    const at = (date: string) => nextEvents(und, { 'STK:AAPL': { nextDate: date } }, undefined, NOW).size;
    expect(at('20261020')).toBe(1); // 14 days
    expect(at('20261021')).toBe(0); // 15 days
    expect(nextEvents(und, { 'STK:AAPL': { nextDate: '20261021' } }, undefined, NOW, 15).size).toBe(1);
    // On New York's calendar: Tuesday 22:00 there (Wednesday in Asia) is still 15 days before 10/21.
    expect(nextEvents(und, { 'STK:AAPL': { nextDate: '20261021' } }, undefined, new Date(Date.UTC(2026, 9, 7, 2, 0))).size).toBe(0);
  });

  it('puts earnings first on the same day', () => {
    const div = { 'STK:AAPL': { nextDate: '20261012', nextAmount: 0.26 } };
    const earn = { status: 'ok' as const, events: [{ key: 'STK:AAPL', date: '20261012', time: 'bmo' as const }] };
    expect(nextEvents(und, div, earn, NOW).get('STK:AAPL')?.kind).toBe('earnings');
  });

  it('shows only dividends without the Wall Street Horizon subscription', () => {
    const div = Object.fromEntries(['AAPL', 'TSLA', 'NVDA'].map((s, i) => [`STK:${s}`, { nextDate: `2026101${i}` }]));
    const events = nextEvents(und, div, { status: 'unsubscribed', events: [{ key: 'STK:AAPL', date: '20261007' }] }, NOW);
    expect([...events.values()].every((e) => e.kind === 'dividend')).toBe(true);
    expect(events.size).toBe(3);
  });

  it('passes the scanner’s estimates and exact times through', () => {
    const events = nextEvents(
      und,
      {},
      {
        status: 'ok',
        source: 'scanner',
        events: [
          { key: 'STK:AAPL', date: '20261016', time: 'amc', estimated: true },
          { key: 'STK:TSLA', date: '20261014', time: 'bmo', minutes: 510, estimated: true },
        ],
      },
      NOW,
    );
    expect([...events.values()].map((e) => [e.symbol, e.time, e.minutes, e.estimated])).toEqual([
      ['AAPL', 'amc', undefined, true],
      ['TSLA', 'bmo', 510, true],
    ]);
    expect('minutes' in events.get('STK:AAPL')!).toBe(false);
  });

  it('writes New York times for the clock and the date as month/day', () => {
    expect(etClock(510)).toBe('08:30');
    expect(etClock(960)).toBe('16:00');
    expect(etClock(0)).toBe('00:00');
    expect(monthDay('20261023')).toBe('10/23');
    expect(monthDay('20260105')).toBe('1/5');
  });

  it('says where earnings dates come from, or why there are none', () => {
    expect(earningsState(undefined, true)).toBe('ok');
    expect(earningsState({ status: 'ok', events: [], source: 'wsh' }, true)).toBe('ok');
    expect(earningsState({ status: 'ok', events: [], source: 'scanner' }, true)).toBe('estimated');
    expect(earningsState({ status: 'ok', events: [], source: 'scanner', pending: true }, true)).toBe('searching');
    expect(earningsState({ status: 'ok', events: [], source: 'scanner', partial: true }, true)).toBe('estimatedUs');
    expect(earningsState({ status: 'ok', events: [], source: 'scanner', retryInMs: 300_000 }, true)).toBe('estimated');
    expect(earningsState({ status: 'unsubscribed', events: [] }, true)).toBe('unsubscribed');
    expect(earningsState({ status: 'unavailable', events: [] }, true)).toBe('unavailable');
    // Not connected: the table says so itself.
    expect(earningsState({ status: 'unavailable', events: [] }, false)).toBe('ok');
  });
});

describe('event chips', () => {
  const words = (lang: 'en' | 'zh'): EventWords => {
    const m = usePortfolioMessages.for(lang);
    return { earnings: m.earnings, exDiv: m.exDiv, estimated: m.estimated, times: m.words.earningsTimes, atEt: m.atEt };
  };
  const ev = (over: Partial<CorporateEvent>): CorporateEvent => ({ key: 'STK:AAPL', symbol: 'AAPL', underlying: stock('AAPL'), kind: 'earnings', date: '20261023', days: 17, ...over });
  const en = createClock('12h', 'en');
  const zh = createClock('12h', 'zh');

  it('reads the earnings date, its time of day and whether it is estimated', () => {
    expect(eventLabel(ev({ time: 'amc', estimated: true }), words('en'), en.wall)).toBe('Earnings 10/23 AMC · Est.');
    expect(eventLabel(ev({ time: 'bmo' }), words('en'), en.wall)).toBe('Earnings 10/23 BMO');
    expect(eventLabel(ev({}), words('en'), en.wall)).toBe('Earnings 10/23');
    // An exact time wins over before the open.
    expect(eventLabel(ev({ date: '20261021', time: 'bmo', minutes: 510, estimated: true }), words('en'), en.wall)).toBe('Earnings 10/21 8:30 AM ET · Est.');
    expect(eventLabel(ev({ time: 'amc', estimated: true }), words('zh'), zh.wall)).toBe('财报 10/23 盘后 · 预估');
    expect(eventLabel(ev({ minutes: 510 }), words('zh'), zh.wall)).toBe('财报 10/23 美东 上午 8:30');
  });

  it('reads the ex-dividend date and the amount in the underlying’s currency', () => {
    expect(eventLabel(ev({ kind: 'dividend', date: '20261015', amount: 0.24 }), words('en'), en.wall)).toBe('Ex-div 10/15 $0.24');
    expect(eventLabel(ev({ kind: 'dividend', date: '20261015' }), words('en'), en.wall)).toBe('Ex-div 10/15');
    const sap = ev({ kind: 'dividend', date: '20261015', amount: 2.2, underlying: { ...stock('SAP'), currency: 'EUR' } });
    expect(eventLabel(sap, words('en'), en.wall)).toBe('Ex-div 10/15 2.20 EUR');
    expect(eventLabel(ev({ kind: 'dividend', date: '20261015', amount: 0.24 }), words('zh'), zh.wall)).toBe('除息 10/15 $0.24');
  });

  it('tells chips apart by what they show', () => {
    expect(eventSig(ev({ time: 'amc' }))).toBe(eventSig(ev({ time: 'amc' })));
    expect(eventSig(ev({ time: 'amc' }))).not.toBe(eventSig(ev({ time: 'bmo' })));
    expect(eventSig(undefined)).toBe('');
  });
});
