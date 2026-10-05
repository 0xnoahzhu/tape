import { describe, expect, it } from 'vitest';
import type { ApiLogEntry, DepthBook, Quote } from '@shared/types';
import {
  hasSoundChoice,
  soundCategoryOff,
  soundChoices,
  soundLabel,
  soundListKey,
  soundListPlace,
  comboLabel,
  countNewSince,
  customMinutesInput,
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
  const labels = (platform: string) =>
    shortcutKeys(platform).map((k) => k.combos.map((c) => comboLabel(c, platform === 'darwin')).join(` ${k.sep} `));

  it('uses ⌘ glyphs on macOS', () => {
    expect(labels('darwin')).toEqual(['⌘K', 'B', 'S', '↑ / ↓', '⏎', '⌘⌫', '⌘1 – ⌘3', '⌘,', '⌘⇧L', '⌘L']);
    expect(shortcutKeys('darwin').find((k) => k.id === 'theme')?.combos).toEqual([['⌘', '⇧', 'L']]);
  });

  it('spells out Ctrl, Shift, Enter and Backspace elsewhere', () => {
    expect(labels('win32')).toEqual(['Ctrl+K', 'B', 'S', '↑ / ↓', 'Enter', 'Ctrl+Backspace', 'Ctrl+1 – Ctrl+3', 'Ctrl+,', 'Ctrl+Shift+L', 'Ctrl+L']);
    expect(labels('linux')).toEqual(labels('win32'));
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


describe('custom auto-lock duration', () => {
  it('keeps digits and caps the minutes at 1440', () => {
    expect(customMinutesInput('90')).toEqual({ text: '90', minutes: 90 });
    expect(customMinutesInput('1a5')).toEqual({ text: '15', minutes: 15 });
    expect(customMinutesInput('5000')).toEqual({ text: '1440', minutes: 1440 });
    expect(customMinutesInput('99999')).toEqual({ text: '1440', minutes: 1440 });
  });

  it('saves nothing while empty or zero', () => {
    expect(customMinutesInput('')).toEqual({ text: '', minutes: null });
    expect(customMinutesInput('0')).toEqual({ text: '0', minutes: null });
    expect(customMinutesInput('007')).toEqual({ text: '007', minutes: 7 });
  });
});

describe('notification sound helpers', () => {
  it('soundChoices lists None first, then the platform sounds', () => {
    expect(soundChoices('darwin')).toEqual(['none', 'Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero', 'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink']);
    expect(soundChoices('win32')).toEqual(['none', 'Notification.Default', 'Notification.IM', 'Notification.Mail', 'Notification.Reminder']);
    expect(soundChoices('linux')).toEqual(['none', 'default']);
  });

  it('soundCategoryOff when every kind of the category stays out of the OS', () => {
    const system = { fill: true, order: false, price: false, opt: false, conn: false, sys: true };
    expect(soundCategoryOff(system, 'order')).toBe(true);
    expect(soundCategoryOff(system, 'fill')).toBe(false);
    expect(soundCategoryOff(system, 'other')).toBe(false);
    expect(soundCategoryOff({ ...system, sys: false }, 'other')).toBe(true);
  });

  it('soundLabel translates known ids and shows system names as they are', () => {
    const names = { none: 'None', 'Notification.IM': 'Instant message' };
    expect(soundLabel('none', names)).toBe('None');
    expect(soundLabel('Notification.IM', names)).toBe('Instant message');
    expect(soundLabel('Glass', names)).toBe('Glass');
    expect(soundLabel('constructor', names)).toBe('constructor');
  });

  it('hasSoundChoice: not on Linux, where the notification server decides', () => {
    expect(hasSoundChoice('darwin')).toBe(true);
    expect(hasSoundChoice('win32')).toBe(true);
    expect(hasSoundChoice('linux')).toBe(false);
    expect(hasSoundChoice('freebsd')).toBe(false);
  });

  it('soundListPlace opens below when it fits, else on the roomier side, capped to the room', () => {
    const pane = { top: 60, bottom: 900 };
    // 15 choices want 296 px.
    expect(soundListPlace({ top: 200, bottom: 230 }, pane, 15)).toEqual({ up: false, maxH: 296 });
    // Near the bottom (the default window, the Other row): upward, full height.
    expect(soundListPlace({ top: 700, bottom: 730 }, pane, 15)).toEqual({ up: true, maxH: 296 });
    // Little room either way: the roomier side, capped to it.
    expect(soundListPlace({ top: 300, bottom: 330 }, { top: 60, bottom: 600 }, 15)).toEqual({ up: false, maxH: 258 });
    expect(soundListPlace({ top: 330, bottom: 360 }, { top: 60, bottom: 600 }, 15)).toEqual({ up: true, maxH: 258 });
    // Never smaller than the minimum (the window has a minimum size).
    expect(soundListPlace({ top: 100, bottom: 130 }, { top: 60, bottom: 200 }, 15)).toEqual({ up: false, maxH: 180 });
    // A short list (Windows: 5 choices) is only as tall as its rows.
    expect(soundListPlace({ top: 600, bottom: 630 }, pane, 5)).toEqual({ up: false, maxH: 162 });
    expect(soundListPlace({ top: 730, bottom: 760 }, pane, 5)).toEqual({ up: true, maxH: 162 });
  });

  it('soundListKey: arrows, Home / End, Enter / Space, Escape / Tab', () => {
    expect(soundListKey('ArrowDown', 3, 15)).toEqual({ kind: 'focus', index: 4 });
    expect(soundListKey('ArrowDown', 14, 15)).toEqual({ kind: 'focus', index: 14 });
    expect(soundListKey('ArrowUp', 0, 15)).toEqual({ kind: 'focus', index: 0 });
    expect(soundListKey('Home', 7, 15)).toEqual({ kind: 'focus', index: 0 });
    expect(soundListKey('End', 7, 15)).toEqual({ kind: 'focus', index: 14 });
    expect(soundListKey('Enter', 7, 15)).toEqual({ kind: 'select' });
    expect(soundListKey(' ', 7, 15)).toEqual({ kind: 'select' });
    expect(soundListKey('Escape', 7, 15)).toEqual({ kind: 'close' });
    expect(soundListKey('Tab', 7, 15)).toEqual({ kind: 'close' });
    expect(soundListKey('a', 7, 15)).toBeUndefined();
  });
});
