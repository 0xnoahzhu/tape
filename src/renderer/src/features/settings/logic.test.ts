import { describe, expect, it } from 'vitest';
import type { ApiLogEntry, DepthBook, MarketCheckItem, MarketDataCheck, Quote } from '@shared/types';
import {
  checkAge,
  checkItems,
  checkNeeded,
  checkReasons,
  STALE_CHECK_MS,
  hasSoundChoice,
  soundCategoryOff,
  soundChoices,
  soundLabel,
  soundListKey,
  soundListPlace,
  soundListReveal,
  soundListScroll,
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

describe('market data check', () => {
  const at = 1_000_000_000_000;
  const stk = (over: Partial<MarketCheckItem> = {}): MarketCheckItem => ({
    market: 'stk',
    status: 'live',
    instrument: 'SPY',
    probe: { status: 'live', exchange: 'SMART', marketDataType: 1 },
    checkedAt: at,
    ...over,
  });
  const result = (items: MarketCheckItem[], account = 'DU1'): MarketDataCheck => ({ checkedAt: at, account, trigger: 'user', items });

  it('checks when connected and the result is missing, old or of another account', () => {
    const conn = { status: 'connected' as const, account: 'DU1' };
    expect(checkNeeded({ result: null, running: false }, conn, at)).toBe(true);
    expect(checkNeeded({ result: null, running: true }, conn, at)).toBe(false);
    expect(checkNeeded({ result: null, running: false }, { ...conn, status: 'disconnected' }, at)).toBe(false);
    const r = result([stk()]);
    expect(checkNeeded({ result: r, running: false }, conn, at + STALE_CHECK_MS - 1)).toBe(false);
    expect(checkNeeded({ result: r, running: false }, conn, at + STALE_CHECK_MS)).toBe(true);
    expect(checkNeeded({ result: r, running: false }, { ...conn, account: 'DU2' }, at + 1)).toBe(true);
  });

  it('maps items to rows only for the connected account', () => {
    const r = result([stk(), { ...stk(), market: 'ind', instrument: 'SPX' }]);
    expect(Object.keys(checkItems(r, 'DU1'))).toEqual(['stk', 'ind']);
    expect(checkItems(r, 'DU2')).toEqual({});
    expect(Object.keys(checkItems(r, undefined))).toEqual(['stk', 'ind']);
    expect(checkItems(null, 'DU1')).toEqual({});
  });

  it('explains delayed and no-data markets once per reason, competing session first', () => {
    expect(checkReasons(result([stk()]))).toEqual([]);
    const r = result([
      stk({
        status: 'live',
        via: 'NASDAQ',
        probe: { status: 'delayed', exchange: 'SMART', marketDataType: 3, code: 10167 },
        primary: { status: 'live', exchange: 'NASDAQ', marketDataType: 1 },
      }),
      { market: 'opt', status: 'nodata', instrument: 'SPY 10/06 670 Call', probe: { status: 'nodata', exchange: 'SMART', code: 354, message: 'x' }, checkedAt: at },
      { market: 'ind', status: 'delayed', instrument: 'SPX', probe: { status: 'delayed', exchange: 'CBOE', marketDataType: 3 }, checkedAt: at },
      { market: 'depth', status: 'nodata', instrument: 'SPY', probe: { status: 'nodata', exchange: 'SMART', code: 10092, message: 'x' }, checkedAt: at },
    ]);
    // The SMART line's 10167 belongs to the fallback note, not to the subscription one.
    expect(checkReasons(r)).toEqual([
      {
        kind: 'notSubscribed',
        codes: [354],
        markets: [
          { market: 'opt', instrument: 'SPY 10/06 670 Call' },
          { market: 'ind', instrument: 'SPX' },
        ],
        othersLive: true,
      },
      { kind: 'fallback', smartDelayed: true, pairs: [{ symbol: 'SPY', exchange: 'NASDAQ' }] },
      { kind: 'depthPerm' },
    ]);
    // Only some stocks on their exchange while SPY is live on SMART; SPX delayed with every other market live.
    const some = result([
      stk({ fallback: [{ symbol: 'AAPL', exchange: 'NASDAQ' }] }),
      { market: 'ind', status: 'delayed', instrument: 'SPX', probe: { status: 'delayed', exchange: 'CBOE', marketDataType: 4 }, checkedAt: at },
    ]);
    expect(checkReasons(some)).toEqual([
      { kind: 'notSubscribed', codes: [], markets: [{ market: 'ind', instrument: 'SPX' }], othersLive: true },
      { kind: 'fallback', smartDelayed: false, pairs: [{ symbol: 'AAPL', exchange: 'NASDAQ' }], liveOnSmart: 'SPY' },
    ]);
    const none = result([stk({ status: 'delayed', probe: { status: 'delayed', exchange: 'SMART', marketDataType: 3, code: 10167 } })]);
    expect(checkReasons(none)).toEqual([{ kind: 'notSubscribed', codes: [10167], markets: [{ market: 'stk', instrument: 'SPY' }], othersLive: false }]);
    const competing = result([
      stk({ status: 'nodata', probe: { status: 'nodata', exchange: 'SMART', code: 10197, message: 'x' } }),
      { market: 'depth', status: 'nodata', instrument: 'SPY', probe: { status: 'nodata', exchange: 'SMART', code: 309, message: 'x' }, checkedAt: at },
      { market: 'ind', status: 'nodata', instrument: 'SPX', probe: { status: 'nodata', exchange: 'CBOE', code: -1, own: 'timeout', message: 'x' }, checkedAt: at },
      { market: 'opt', status: 'nodata', instrument: 'SPY option', probe: { status: 'nodata', exchange: 'SMART', code: -1, own: 'contract', message: 'x' }, checkedAt: at },
    ]);
    expect(checkReasons(competing).map((x) => x.kind)).toEqual(['competing', 'depthLimit', 'noAnswer', 'noOption']);
    const partial = result([
      {
        market: 'depth',
        status: 'live',
        via: 'IEX',
        instrument: 'SPY',
        probe: { status: 'live', exchange: 'SMART', code: 2152, message: 'Exchanges - Depth: IEX; Top: BYX; Need additional market data permissions - Depth: NASDAQ; NYSE; ' },
        checkedAt: at,
      },
    ]);
    expect(checkReasons(partial)).toEqual([{ kind: 'depthPartial', depth: ['IEX'], missing: ['NASDAQ', 'NYSE'] }]);
    const lines = result([stk({ status: 'nodata', probe: { status: 'nodata', exchange: 'SMART', code: -1, own: 'lines', message: 'x' } })]);
    expect(checkReasons(lines)).toEqual([{ kind: 'lines' }]);
  });

  it('says how long ago a check ran', () => {
    expect(checkAge(at, at + 59_000)).toEqual({ unit: 'now', n: 0 });
    expect(checkAge(at, at + 2 * 60_000 + 5)).toEqual({ unit: 'min', n: 2 });
    expect(checkAge(at, at + 3 * 3_600_000)).toEqual({ unit: 'h', n: 3 });
    expect(checkAge(at, at + 2 * 86_400_000)).toBeNull();
    expect(checkAge(at + 5, at)).toEqual({ unit: 'now', n: 0 });
  });
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
    // 15 choices want 9 rows: 282 px with the padding.
    expect(soundListPlace({ top: 200, bottom: 230 }, pane, 15)).toEqual({ up: false, maxH: 282 });
    // Near the bottom (the default window, the Other row): upward, full height.
    expect(soundListPlace({ top: 700, bottom: 730 }, pane, 15)).toEqual({ up: true, maxH: 282 });
    // Little room either way (258 px below, 228 above): the roomier side, capped to its whole rows.
    expect(soundListPlace({ top: 300, bottom: 330 }, { top: 60, bottom: 600 }, 15)).toEqual({ up: false, maxH: 252 });
    expect(soundListPlace({ top: 330, bottom: 360 }, { top: 60, bottom: 600 }, 15)).toEqual({ up: true, maxH: 252 });
    // Never fewer than 5 rows (the window has a minimum size).
    expect(soundListPlace({ top: 100, bottom: 130 }, { top: 60, bottom: 200 }, 15)).toEqual({ up: false, maxH: 162 });
    // A short list (Windows: 5 choices) is only as tall as its rows.
    expect(soundListPlace({ top: 600, bottom: 630 }, pane, 5)).toEqual({ up: false, maxH: 162 });
    expect(soundListPlace({ top: 730, bottom: 760 }, pane, 5)).toEqual({ up: true, maxH: 162 });
  });

  it('soundListPlace: always whole rows, so no name shows cut at the edges', () => {
    // 281 px below is 1 px short of 9 rows: 8 rows, not 8.97.
    expect(soundListPlace({ top: 200, bottom: 230 }, { top: 60, bottom: 523 }, 15)).toEqual({ up: false, maxH: 252 });
    for (let bottom = 300; bottom <= 1000; bottom += 7) {
      for (const top of [80, 240, 420]) {
        const { maxH } = soundListPlace({ top, bottom: top + 30 }, { top: 60, bottom }, 15);
        expect((maxH - 12) % 30).toBe(0);
      }
    }
  });

  it('soundListScroll opens with the current row in the middle, on a row boundary', () => {
    // 15 choices, 9 rows shown (282 px): Ping (9) in the middle, Funk (5) to Submarine (13).
    expect(soundListScroll(9, 15, 282)).toBe(150);
    // Near either end: as far as the list goes.
    expect(soundListScroll(0, 15, 282)).toBe(0);
    expect(soundListScroll(2, 15, 282)).toBe(0);
    expect(soundListScroll(12, 15, 282)).toBe(180);
    expect(soundListScroll(14, 15, 282)).toBe(180);
    // An even number of rows (8): one more row below the current one than above.
    expect(soundListScroll(9, 15, 252)).toBe(180);
    // A list that fits does not scroll.
    expect(soundListScroll(4, 5, 162)).toBe(0);
  });

  it('soundListReveal scrolls a row into view by whole rows, the padding kept around it', () => {
    // Rows 5-13 shown (scrollTop 150, 9 rows).
    expect(soundListReveal(9, 150, 282)).toBe(150);
    expect(soundListReveal(5, 150, 282)).toBe(150);
    expect(soundListReveal(13, 150, 282)).toBe(150);
    // One past either end: one row up or down.
    expect(soundListReveal(4, 150, 282)).toBe(120);
    expect(soundListReveal(14, 150, 282)).toBe(180);
    // Home / End.
    expect(soundListReveal(0, 180, 282)).toBe(0);
    expect(soundListReveal(14, 0, 282)).toBe(180);
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
