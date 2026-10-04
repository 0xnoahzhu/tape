import { describe, expect, it } from 'vitest';
import { expiredLogFiles, logFileDay, logFileName } from './apiLogFiles';
import { connectionNotices, connectionParams, failureReason, isPaperAccount, parseAccounts } from './connectionModel';
import { cleanIbMessage, farmUpdate, isErrorCode, isInfoCode } from './errorCodes';
import { fromIbContract, num, parseIbTime, toIbContract } from './ibContract';
import { addNavPoint, compactNav } from './navHistory';
import type { Settings } from '@shared/types';
import { defaultSettings } from '@shared/defaults';

describe('api log files', () => {
  it('names files by local day', () => {
    expect(logFileName(new Date(2026, 9, 3, 23, 59))).toBe('api-20261003.log');
    expect(logFileDay('api-20261003.log')?.getDate()).toBe(3);
    expect(logFileDay('tape-api-20261003.log')).toBeNull();
  });

  it('selects files older than the retention period', () => {
    const names = ['api-20261003.log', 'api-20260927.log', 'api-20260926.log', 'api-20250101.log', 'notes.txt', 'api-x.log'];
    const now = new Date(2026, 9, 3, 12);
    // 7 days = today and the six days before (Sep 27 – Oct 3)
    expect(expiredLogFiles(names, 7, now)).toEqual(['api-20260926.log', 'api-20250101.log']);
    expect(expiredLogFiles(names, 1, now)).toEqual(['api-20260927.log', 'api-20260926.log', 'api-20250101.log']);
    expect(expiredLogFiles(names, 90, now)).toEqual(['api-20250101.log']);
  });
});

describe('error codes', () => {
  it('parses farm status messages', () => {
    expect(farmUpdate(2104, 'Market data farm connection is OK:usfarm.nj')).toEqual({ farm: 'usfarm.nj', status: 'ok' });
    expect(farmUpdate(2107, 'HMDS data farm connection is inactive but should be available upon demand.ushmds')).toEqual({ farm: 'ushmds', status: 'inactive' });
    expect(farmUpdate(2103, 'Market data farm connection is broken:usfarm')).toEqual({ farm: 'usfarm', status: 'broken' });
    expect(farmUpdate(2158, 'Sec-def data farm connection is OK:secdefhk')).toEqual({ farm: 'secdefhk', status: 'ok' });
    expect(farmUpdate(2100, 'x')).toBeNull();
  });

  it('separates errors from notices', () => {
    expect(isErrorCode(10197)).toBe(true);
    expect(isErrorCode(201)).toBe(true);
    expect(isErrorCode(2104)).toBe(false);
    expect(isErrorCode(2109)).toBe(false);
    expect(isErrorCode(202)).toBe(false);
    expect(isErrorCode(399)).toBe(false);
    expect(isInfoCode(2158)).toBe(true);
    expect(isInfoCode(1100)).toBe(false);
  });

  it('strips the validation prefix', () => {
    expect(cleanIbMessage("Error validating request.-'bC' : cause - The API interface is currently in Read-Only mode.")).toBe(
      'The API interface is currently in Read-Only mode.',
    );
    expect(cleanIbMessage('Order rejected - reason: margin')).toBe('Order rejected - reason: margin');
  });
});

describe('connection model', () => {
  const s: Settings['connection'] = defaultSettings().connection;

  it('lets TAPE_CLIENT_ID override the client id', () => {
    expect(connectionParams(s, undefined)).toEqual({ host: '127.0.0.1', port: 4002, clientId: 7 });
    expect(connectionParams(s, '101').clientId).toBe(101);
    expect(connectionParams(s, 'abc').clientId).toBe(7);
    expect(connectionParams(s, '').clientId).toBe(7);
  });

  it('parses managed accounts', () => {
    expect(parseAccounts('DUP899854')).toEqual(['DUP899854']);
    expect(parseAccounts('DU1,DU2,')).toEqual(['DU1', 'DU2']);
    expect(parseAccounts('')).toEqual([]);
    expect(isPaperAccount('DUP899854')).toBe(true);
    expect(isPaperAccount('U1234567')).toBe(false);
  });

  it('describes failures', () => {
    const p = { host: '127.0.0.1', port: 4002, clientId: 7 };
    expect(failureReason({ code: 502, message: 'connect ECONNREFUSED 127.0.0.1:4002' }, p)).toEqual({
      en: 'Connection refused at 127.0.0.1:4002',
      zh: '127.0.0.1:4002 拒绝连接',
    });
    expect(failureReason({ code: 326, message: 'Unable to connect as the client id is already in use.' }, p).en).toBe('Client ID 7 is already in use');
    expect(failureReason({ code: 0, message: '' }, p).en).toBe('No response from 127.0.0.1:4002');
  });

  it('builds connection notices in both languages', () => {
    const n = connectionNotices.reconnected('gateway', 3 * 60_000);
    expect(n.title).toEqual({ en: 'Reconnected to IB Gateway', zh: '已重新连接 IB Gateway' });
    expect(n.body.en).toBe('Reconnected after 3 min offline. All subscriptions restored.');
    expect(n.body.zh).toBe('断开 3 分钟 后自动重连成功，所有订阅已恢复。');
    expect(connectionNotices.disconnected('tws', { host: 'h', port: 7497, clientId: 1 }, true).title.en).toBe('Disconnected from TWS');
    const f = connectionNotices.failed('gateway', { en: 'Connection refused at h:1', zh: 'h:1 拒绝连接' });
    expect(f.body.en).toBe('Connection refused at h:1. Make sure IB Gateway is running with the API port open.');
    expect(f.body.zh).toBe('h:1 拒绝连接。确认 IB Gateway 已启动并开放 API 端口。');
  });
});

describe('ib contracts', () => {
  it('converts option positions', () => {
    const ref = fromIbContract({
      conId: 7123,
      symbol: 'AAPL',
      secType: 'OPT' as never,
      lastTradeDateOrContractMonth: '20261016',
      strike: 230,
      right: 'C' as never,
      multiplier: 100,
      exchange: '',
      currency: 'USD',
      localSymbol: 'AAPL  261016C00230000',
      tradingClass: 'AAPL',
    });
    expect(ref).toEqual({
      symbol: 'AAPL',
      secType: 'OPT',
      exchange: 'SMART',
      currency: 'USD',
      conId: 7123,
      lastTradeDate: '20261016',
      strike: 230,
      right: 'C',
      multiplier: 100,
      localSymbol: 'AAPL  261016C00230000',
      tradingClass: 'AAPL',
    });
    expect(toIbContract(ref)).toMatchObject({ conId: 7123, secType: 'OPT', lastTradeDateOrContractMonth: '20261016', strike: 230, right: 'C', multiplier: 100 });
  });

  it('drops stock multipliers and empty strikes', () => {
    const ref = fromIbContract({ conId: 1, symbol: 'MSFT', secType: 'STK' as never, strike: 0, multiplier: 0, exchange: 'NASDAQ', currency: 'USD' });
    expect(ref).toEqual({ symbol: 'MSFT', secType: 'STK', exchange: 'NASDAQ', currency: 'USD', conId: 1 });
  });

  it('builds combo contracts on SMART', () => {
    const c = toIbContract({
      symbol: 'AAPL',
      secType: 'BAG',
      exchange: 'CBOE',
      currency: 'USD',
      comboLegs: [
        { conId: 11, ratio: 1, action: 'BUY', exchange: '' },
        { conId: 12, ratio: 2, action: 'SELL', exchange: 'SMART' },
      ],
    });
    expect(c.exchange).toBe('SMART');
    expect(c.comboLegs).toEqual([
      { conId: 11, ratio: 1, action: 'BUY', exchange: 'SMART' },
      { conId: 12, ratio: 2, action: 'SELL', exchange: 'SMART' },
    ]);
  });

  it('treats IB "not set" values as missing', () => {
    expect(num(1.7976931348623157e308)).toBeUndefined();
    expect(num('')).toBeUndefined();
    expect(num('12.5')).toBe(12.5);
    expect(num(0)).toBe(0);
  });

  it('parses IB times', () => {
    // 10:31:44 New York in October (EDT, UTC-4)
    expect(parseIbTime('20261005 10:31:44 US/Eastern')).toBe(Date.UTC(2026, 9, 5, 14, 31, 44));
    // January: EST, UTC-5
    expect(parseIbTime('20260105 09:30:00 America/New_York')).toBe(Date.UTC(2026, 0, 5, 14, 30, 0));
    expect(parseIbTime('20261005-14:31:44')).toBe(Date.UTC(2026, 9, 5, 14, 31, 44));
    expect(parseIbTime('20261005  10:31:44')).toBe(new Date(2026, 9, 5, 10, 31, 44).getTime());
    expect(parseIbTime('20261005 10:31:44 China Standard Time')).toBe(new Date(2026, 9, 5, 10, 31, 44).getTime());
    expect(parseIbTime('1791084178')).toBe(1791084178000);
    expect(parseIbTime('')).toBeUndefined();
  });
});

describe('nav history', () => {
  const day = 86_400_000;
  // 20:00 UTC = 16:00 New York (EDT): late in the NY trading day.
  const at = (d: number, h: number) => Date.UTC(2026, 8, d, h);

  it('keeps every sample of the last ten days', () => {
    let pts = addNavPoint([], { t: at(20, 14), netLiq: 100 });
    pts = addNavPoint(pts, { t: at(20, 15), netLiq: 101 });
    pts = addNavPoint(pts, { t: at(21, 14), netLiq: 102 });
    expect(pts.map((p) => p.netLiq)).toEqual([100, 101, 102]);
  });

  it('reduces older days to their last sample', () => {
    const pts = [
      { t: at(1, 14), netLiq: 1 },
      { t: at(1, 19), netLiq: 2 },
      { t: at(2, 14), netLiq: 3 },
      { t: at(20, 14), netLiq: 4 },
      { t: at(20, 15), netLiq: 5 },
    ];
    expect(compactNav(pts, at(21, 0)).map((p) => p.netLiq)).toEqual([2, 3, 4, 5]);
    expect(compactNav(pts, at(21, 0) + 30 * day).map((p) => p.netLiq)).toEqual([2, 3, 5]);
  });

  it('ignores invalid samples and replaces duplicates', () => {
    const pts = addNavPoint([{ t: 1, netLiq: 10 }], { t: 1, netLiq: 11 });
    expect(pts).toEqual([{ t: 1, netLiq: 11 }]);
    expect(addNavPoint(pts, { t: 2, netLiq: 0 })).toEqual(pts);
    expect(addNavPoint(pts, { t: 2, netLiq: NaN })).toEqual(pts);
  });
});
