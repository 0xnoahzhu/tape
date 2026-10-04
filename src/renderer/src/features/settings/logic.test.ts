import { describe, expect, it } from 'vitest';
import type { ApiLogEntry, DepthBook, Quote } from '@shared/types';
import {
  countNewSince,
  farmList,
  filterLog,
  formatBytes,
  hostAppName,
  isInfo,
  logBody,
  logCounts,
  logDetail,
  MAX_CLIENT_ID,
  newestFirst,
  observeMarkets,
  parseClientId,
  parseHost,
  parsePort,
  portForMode,
  shortcutKeys,
  statusDotColor,
  tildify,
} from './logic';
import { useSettingsMessages } from './messages';

describe('connection inputs', () => {
  it('validates hosts', () => {
    expect(parseHost(' 127.0.0.1 ')).toBe('127.0.0.1');
    expect(parseHost('localhost')).toBe('localhost');
    expect(parseHost('::1')).toBe('::1');
    expect(parseHost('[::1]')).toBe('[::1]');
    expect(parseHost('gw.example.com')).toBe('gw.example.com');
    expect(parseHost('')).toBeNull();
    expect(parseHost('my host')).toBeNull();
    expect(parseHost('http://x')).toBeNull();
  });

  it('validates ports', () => {
    expect(parsePort('4002')).toBe(4002);
    expect(parsePort(' 7497 ')).toBe(7497);
    expect(parsePort('0')).toBeNull();
    expect(parsePort('65536')).toBeNull();
    expect(parsePort('40.2')).toBeNull();
    expect(parsePort('')).toBeNull();
  });

  it('validates client ids', () => {
    expect(parseClientId('0')).toBe(0);
    expect(parseClientId('151')).toBe(151);
    expect(parseClientId('999999999')).toBe(MAX_CLIENT_ID);
    // Above what the settings store keeps (it would clamp), so rejected here.
    expect(parseClientId('1000000000')).toBeNull();
    expect(parseClientId('1500000000')).toBeNull();
    expect(parseClientId('-1')).toBeNull();
    expect(parseClientId('1.5')).toBeNull();
    expect(parseClientId('')).toBeNull();
  });

  it('switches to the paper port of the new mode, keeping live when on a live port', () => {
    expect(portForMode('tws', 4002)).toBe(7497);
    expect(portForMode('gateway', 7497)).toBe(4002);
    expect(portForMode('tws', 4001)).toBe(7496);
    expect(portForMode('gateway', 7496)).toBe(4001);
    expect(portForMode('gateway', 9999)).toBe(4002);
  });

  it('names the host application from the port', () => {
    expect(hostAppName(4002, 'tws')).toBe('IB Gateway');
    expect(hostAppName(7496, 'gateway')).toBe('TWS');
    expect(hostAppName(5000, 'tws')).toBe('TWS');
    expect(hostAppName(5000, 'gateway')).toBe('IB Gateway');
  });

  it('colors the status dot green only while connected', () => {
    expect(statusDotColor('connected')).toBe('var(--g)');
    expect(statusDotColor('connecting')).toBe('var(--mu)');
    expect(statusDotColor('reconnecting')).toBe('var(--r)');
    expect(statusDotColor('disconnected')).toBe('var(--r)');
  });

  it('sorts farms', () => {
    expect(farmList({ ushmds: 'ok', secdefil: 'inactive', usfarm: 'broken' }).map((f) => f.name)).toEqual(['secdefil', 'usfarm', 'ushmds']);
    expect(farmList({})).toEqual([]);
  });
});

const q = (key: string, extra: Partial<Quote>): Quote => ({ key, updatedAt: 1, ...extra });

describe('observeMarkets', () => {
  it('reports nothing without quotes', () => {
    const o = observeMarkets({}, null);
    expect(o.stk.tag).toBe('none');
    expect(o.opt.tag).toBe('none');
    expect(o.ind.tag).toBe('none');
    expect(o.depth.tag).toBe('none');
  });

  it('classifies by secType and picks the best observed type', () => {
    const o = observeMarkets(
      {
        'STK:AAPL': q('STK:AAPL', { marketDataType: 1 }),
        'STK:MSFT': q('STK:MSFT', { marketDataType: 3 }),
        'OPT:AAPL:20261016:230:C': q('OPT:AAPL:20261016:230:C', { marketDataType: 4 }),
        'IND:SPX': q('IND:SPX', { marketDataType: 2 }),
        'FUT:ES:202612': q('FUT:ES:202612', { marketDataType: 1 }),
      },
      null,
    );
    expect(o.stk).toMatchObject({ tag: 'live', live: 1, delayed: 1 });
    expect(o.opt).toMatchObject({ tag: 'delayed', delayed: 1 });
    expect(o.ind).toMatchObject({ tag: 'frozen', frozen: 1 });
  });

  it('marks errors without data as no data and keeps the latest code', () => {
    const o = observeMarkets(
      {
        'STK:AAPL': q('STK:AAPL', { error: { code: 354, message: 'not subscribed' }, updatedAt: 1 }),
        'STK:NVDA': q('STK:NVDA', { error: { code: 10197, message: 'competing session' }, updatedAt: 5 }),
      },
      null,
    );
    expect(o.stk).toMatchObject({ tag: 'nodata', errors: 2, errorCode: 10197 });
  });

  it('counts a quote with a current error as an error, whatever type it delivered before', () => {
    const o = observeMarkets(
      {
        'STK:AAPL': q('STK:AAPL', { marketDataType: 3, error: { code: 10197, message: 'competing session' }, updatedAt: 4 }),
        'STK:MSFT': q('STK:MSFT', { marketDataType: 3, error: { code: 10197, message: 'competing session' }, updatedAt: 6 }),
        'OPT:AAPL:20261016:230:C': q('OPT:AAPL:20261016:230:C', { marketDataType: 1, error: { code: 354, message: 'not subscribed' } }),
        'IND:SPX': q('IND:SPX', { marketDataType: 4, error: { code: 354, message: 'not subscribed' } }),
        'IND:VIX': q('IND:VIX', { marketDataType: 4 }),
      },
      null,
      { code: 10197 },
    );
    expect(o.stk).toMatchObject({ tag: 'nodata', live: 0, delayed: 0, errors: 2, errorCode: 10197 });
    expect(o.opt).toMatchObject({ tag: 'nodata', live: 0, errors: 1, errorCode: 354 });
    // A quote that still delivers data keeps the market's tag.
    expect(o.ind).toMatchObject({ tag: 'delayed', delayed: 1, errors: 1 });
  });

  it('applies a market-wide issue only where nothing was observed', () => {
    const o = observeMarkets({ 'STK:AAPL': q('STK:AAPL', { marketDataType: 1 }) }, null, { code: 10197 });
    expect(o.stk.tag).toBe('live');
    expect(o.opt).toMatchObject({ tag: 'nodata', errorCode: 10197 });
    expect(o.depth).toMatchObject({ tag: 'nodata', errorCode: 10197 });
  });

  it('derives depth from the current book', () => {
    const book: DepthBook = {
      key: 'STK:AAPL',
      bids: [{ price: 1, size: 1 }],
      asks: [
        { price: 2, size: 1 },
        { price: 3, size: 1 },
      ],
      updatedAt: 1,
    };
    expect(observeMarkets({}, book).depth).toMatchObject({ tag: 'live', depthSymbol: 'AAPL', depthLevels: 2 });
    const failed: DepthBook = { key: 'STK:AAPL', bids: [], asks: [], updatedAt: 1, error: { code: 10092, message: 'no L2' } };
    expect(observeMarkets({}, failed).depth).toMatchObject({ tag: 'nodata', errorCode: 10092 });
    const waiting: DepthBook = { key: 'STK:AAPL', bids: [], asks: [], updatedAt: 1 };
    expect(observeMarkets({}, waiting).depth.tag).toBe('none');
  });
});

let seq = 0;
const entry = (dir: 'out' | 'in', name: string, fields: Array<[string, string]>, extra: Partial<ApiLogEntry> = {}): ApiLogEntry => ({
  seq: ++seq,
  t: new Date(2026, 9, 3, 10, 2, 11, 204).getTime(),
  dir,
  msgId: '1',
  name,
  fields,
  bytes: 42,
  err: false,
  raw: '[38] 1␀11',
  ...extra,
});

describe('api log', () => {
  const log = [
    entry(
      'out',
      'reqMktData',
      [
        ['reqId', '1001'],
        ['symbol', 'AAPL'],
      ],
      { reqId: '1001' },
    ),
    entry(
      'in',
      'tickPrice',
      [
        ['reqId', '1001'],
        ['price', '227.48'],
      ],
      { reqId: '1001' },
    ),
    entry('in', 'error', [
      ['code', '2104'],
      ['msg', 'Market data farm connection is OK:usfarm'],
    ]),
    entry(
      'in',
      'error',
      [
        ['code', '10197'],
        ['msg', 'No market data during competing live session'],
      ],
      { err: true, reqId: '1002' },
    ),
  ];

  it('formats the body as k=v pairs', () => {
    expect(logBody(log[0])).toBe('reqId=1001  symbol=AAPL');
  });

  it('counts by direction and errors', () => {
    expect(logCounts(log)).toEqual({ all: 4, out: 1, in: 3, err: 1 });
  });

  it('filters by direction, errors and search text', () => {
    expect(filterLog(log, 'out', '')).toHaveLength(1);
    expect(filterLog(log, 'in', '')).toHaveLength(3);
    expect(filterLog(log, 'err', '')).toEqual([log[3]]);
    expect(filterLog(log, 'all', 'aapl')).toEqual([log[0]]);
    expect(filterLog(log, 'all', ' 1002 ')).toEqual([log[3]]);
    expect(filterLog(log, 'all', 'TICKPRICE')).toEqual([log[1]]);
    expect(filterLog(log, 'in', '1001')).toEqual([log[1]]);
  });

  it('treats non-error error callbacks as info', () => {
    expect(isInfo(log[2])).toBe(true);
    expect(isInfo(log[3])).toBe(false);
    expect(isInfo(log[0])).toBe(false);
  });

  it('returns the newest entries first, capped', () => {
    const many = Array.from({ length: 450 }, (_, i) => i);
    const out = newestFirst(many, 300);
    expect(out).toHaveLength(300);
    expect(out[0]).toBe(449);
    expect(out[299]).toBe(150);
    expect(newestFirst([1, 2], 300)).toEqual([2, 1]);
  });

  it('counts entries recorded since a pause', () => {
    const frozen = log.slice(0, 2);
    expect(countNewSince(log, frozen)).toBe(2);
    expect(countNewSince(log, log)).toBe(0);
    expect(countNewSince(log, [])).toBe(4);
  });

  it('builds the detail text', () => {
    const d = logDetail(log[0]);
    expect(d.split('\n')[0]).toBe('SEND  client → TWS   msgId 1   42 bytes   10:02:11.204');
    expect(d).toContain('reqId             1001');
    expect(d.endsWith('raw  [38] 1␀11')).toBe(true);
    expect(logDetail(log[1]).startsWith('RECV  TWS → client')).toBe(true);
  });

  it('shortens home paths', () => {
    expect(tildify('/Users/noah/Library/Logs/Tape/api-20261004.log')).toBe('~/Library/Logs/Tape/api-20261004.log');
    expect(tildify('/home/me/.config/Tape/logs/x.log')).toBe('~/.config/Tape/logs/x.log');
    expect(tildify('C:\\Users\\me\\x.log')).toBe('C:\\Users\\me\\x.log');
  });
});

describe('shortcuts', () => {
  it('uses ⌘ on macOS and Ctrl elsewhere', () => {
    const mac = shortcutKeys('darwin');
    const win = shortcutKeys('win32');
    expect(mac.map((k) => k.keys)).toEqual(['⌘K', 'B', 'S', '↑ / ↓', '⏎', '⌘⌫', '⌘1 – ⌘3', '⌘ ,', '⌘⇧L']);
    expect(win.find((k) => k.id === 'command')?.keys).toBe('Ctrl+K');
    expect(win.find((k) => k.id === 'theme')?.keys).toBe('Ctrl+Shift+L');
    expect(win.every((k) => !k.keys.includes('⌘'))).toBe(true);
  });
});

describe('local cache stats', () => {
  it('formats sizes in binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(88_290_000)).toBe('84.2 MB');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512.0 MB');
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB'); // not "1024.0 KB"
    expect(formatBytes(3.5 * 1024 ** 3)).toBe('3.5 GB');
    expect(formatBytes(NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('summarizes size, series and bars in both languages', () => {
    const en = useSettingsMessages.for('en');
    const zh = useSettingsMessages.for('zh');
    expect(en.cacheLine(formatBytes(88_290_000), 312, 1_234_567)).toBe('84.2 MB · 312 series · 1.2M bars');
    expect(en.cacheLine('0 B', 0, 0)).toBe('0 B · 0 series · 0 bars');
    expect(en.cacheLine('8.0 KB', 1, 1)).toBe('8.0 KB · 1 series · 1 bar');
    expect(en.cacheLine('1.0 GB', 1_200, 12_400)).toBe('1.0 GB · 1,200 series · 12.4K bars');
    expect(zh.cacheLine(formatBytes(88_290_000), 312, 1_234_567)).toBe('84.2 MB · 312 个序列 · 1.2M 根K线');
  });
});

