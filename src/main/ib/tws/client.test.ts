// IBApi against a fake TWS server: handshake, event order, held requests, error routing,
// version checks, framing robustness, send queue (rate limit, lanes, elision, backoff), lifecycle. The last block runs the same
// API calls through @stoqey/ib's IBApi and this client and compares what reaches the server.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IBApi } from './client.ts';
import { EventName } from './enums.ts';
import { FakeTws, frame, nextEvent, type FakeTwsOptions, type FakeTwsSession } from './__fixtures__/fakeTws.ts';
import { loadStoqey } from './__fixtures__/stoqeyRef.ts';
import { BURST, DEFAULT_MAX_PER_SECOND } from './sendQueue.ts';
import type { Contract, Order } from './types.ts';

const stoqey = loadStoqey();
const servers: FakeTws[] = [];
const clients: Array<{ disconnect(): unknown; removeAllListeners(): unknown }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) {
    c.removeAllListeners();
    try {
      c.disconnect();
    } catch {
      // already closed
    }
  }
  for (const s of servers.splice(0)) await s.close();
});

async function setup(options: FakeTwsOptions = {}, clientId = 121, maxReqPerSec?: number): Promise<{ fake: FakeTws; api: IBApi; log: Array<[string, unknown[]]> }> {
  const fake = await FakeTws.start(options);
  servers.push(fake);
  const api = new IBApi({ host: '127.0.0.1', port: fake.port, maxReqPerSec });
  clients.push(api);
  const log: Array<[string, unknown[]]> = [];
  api.on(EventName.all, (name: string, args: unknown[]) => log.push([name, args]));
  api.on(EventName.error, () => undefined);
  api.connect(clientId);
  return { fake, api, log };
}

async function ready(
  options: FakeTwsOptions = {},
  maxReqPerSec?: number,
): Promise<{ fake: FakeTws; api: IBApi; session: FakeTwsSession; log: Array<[string, unknown[]]> }> {
  const s = await setup(options, 121, maxReqPerSec);
  await nextEvent(s.api, EventName.nextValidId);
  return { ...s, session: await s.fake.session() };
}

const stk: Contract = { conId: 265598, symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' };

describe('IBApi handshake and lifecycle', () => {
  it('negotiates v176..193, sends START_API and emits connected / server before nextValidId', async () => {
    const { fake, api, log } = await setup();
    await nextEvent(api, EventName.nextValidId);
    const session = await fake.session();
    expect(session.versionRange).toBe('v176..193');
    expect(session.frames[0]).toEqual(['71', '2', '121', '']);
    expect(api.isConnected).toBe(true);
    expect(api.serverVersion).toBe(193);
    expect(log.map(([n]) => n)).toEqual(['sent', 'received', 'sent', 'connected', 'server', 'received', 'managedAccounts', 'received', 'nextValidId']);
    expect(log[0][1]).toEqual([['API\0', 0, 0, 0, 9, 'v176..193'], 'v176..193']);
    expect(log[1][1]).toEqual([['193', '20261004 12:00:00 China Standard Time'], '193\x0020261004 12:00:00 China Standard Time\0']);
    expect(log[2][1]).toEqual([[71, 2, 121, ''], '71\x002\x00121\0']);
    expect(log[4][1]).toEqual([193, '20261004 12:00:00 China Standard Time']);
    expect(log[6][1]).toEqual(['DU123']);
  });

  it('uses the constructor clientId (or 0) when connect() has none', async () => {
    const fake = await FakeTws.start();
    servers.push(fake);
    const api = new IBApi({ host: '127.0.0.1', port: fake.port, clientId: 7.9 });
    clients.push(api);
    api.connect();
    expect((await (await fake.session()).waitFrames(1))[0]).toEqual(['71', '2', '7', '']);
  });

  it('holds requests until nextValidId, then sends them by lane, in order within a lane', async () => {
    const { fake, api } = await setup({ autoReady: false });
    api.reqCurrentTime();
    api.reqManagedAccts();
    api.reqContractDetails(9010, stk);
    const session = await fake.session();
    await session.waitFrames(1); // START_API only
    await new Promise((r) => setTimeout(r, 100));
    expect(session.frames).toHaveLength(1);
    expect(api.getQueueStats().held).toBe(3);
    // requests made from a nextValidId listener go after the held ones of their lane;
    // reqIds is order traffic and goes first
    api.once(EventName.nextValidId, () => api.reqIds(1).reqOpenOrders());
    session.send([9, 1, 100]);
    const frames = await session.waitFrames(6);
    expect(frames.slice(1).map((f) => f[0])).toEqual(['8', '49', '17', '9', '5']);
    expect(api.getQueueStats().held).toBe(0);
  });

  it('sends requests at once after nextValidId (sent is emitted synchronously)', async () => {
    const { api, session } = await ready();
    const sent: unknown[][] = [];
    api.on(EventName.sent, (tokens: unknown[]) => sent.push(tokens));
    api.reqAccountSummary(9001, 'All', 'NetLiquidation');
    expect(sent).toEqual([[62, 1, 9001, 'All', 'NetLiquidation']]);
    expect((await session.waitFrames(2))[1]).toEqual(['62', '1', '9001', 'All', 'NetLiquidation']);
  });

  it('routes error frames: no request id -> info, request id -> error', async () => {
    const { api, session } = await ready();
    const info = nextEvent(api, EventName.info);
    const error = nextEvent(api, EventName.error);
    session.send([4, 2, -1, 2104, 'Market data farm connection is OK:usfarm', '']);
    session.send([4, 2, 9022, 162, 'Historical Market Data Service error message', '']);
    expect(await info).toEqual(['Market data farm connection is OK:usfarm', 2104]);
    const [err, code, reqId, adv] = await error;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Historical Market Data Service error message');
    expect([code, reqId, adv]).toEqual([162, 9022, undefined]);
  });

  it('emits result and all like @stoqey/ib', async () => {
    const { api, session } = await ready();
    const result = nextEvent(api, EventName.result);
    session.send([49, 1, 1791086344]);
    expect(await result).toEqual(['currentTime', [1791086344]]);
  });

  it('does not throw when an error has no listener', async () => {
    const fake = await FakeTws.start();
    servers.push(fake);
    const api = new IBApi({ host: '127.0.0.1', port: fake.port });
    clients.push(api);
    api.connect(121);
    await nextEvent(api, EventName.nextValidId);
    (await fake.session()).send([4, 2, 5, 200, 'No security definition', '']);
    await new Promise((r) => setTimeout(r, 50));
    expect(api.isConnected).toBe(true);
  });

  it('rejects servers older than 176 with error 503 and disconnects', async () => {
    const { fake, api, log } = await setup({ serverVersion: 175 });
    const [err, code] = await nextEvent(api, EventName.error);
    expect(code).toBe(503);
    expect((err as Error).message).toMatch(/out of date.*175.*176/);
    await nextEvent(api, EventName.disconnected);
    expect((await fake.session()).frames).toEqual([]); // no START_API
    expect(log.map(([n]) => n)).not.toContain('connected');
  });

  it('rejects servers newer than 193 with error 506', async () => {
    const { api } = await setup({ serverVersion: 201 });
    const [err, code] = await nextEvent(api, EventName.error);
    expect([code, (err as Error).message]).toEqual([506, 'Unsupported Version 201']);
    await nextEvent(api, EventName.disconnected);
  });

  it('reports a refused connection as error 502 followed by disconnected', async () => {
    const fake = await FakeTws.start();
    const port = fake.port;
    await fake.close();
    const api = new IBApi({ host: '127.0.0.1', port });
    clients.push(api);
    const events: string[] = [];
    api.on(EventName.error, (_e: Error, code: number) => events.push(`error ${code}`));
    api.on(EventName.disconnected, () => events.push('disconnected'));
    const done = nextEvent(api, EventName.disconnected);
    api.connect(121);
    await done;
    expect(events).toEqual(['error 502', 'disconnected']);
    expect(api.isConnected).toBe(false);
  });

  it('throws synchronously for an invalid port and stays reusable', () => {
    const api = new IBApi({ host: '127.0.0.1', port: 70000 });
    expect(() => api.connect(121)).toThrow();
    expect(api.isConnected).toBe(false);
    expect(() => api.connect(121)).toThrow(); // not stuck in "connecting"
  });

  it('disconnect(): one disconnected event, then info 504; connect() twice: info 501', async () => {
    const { api } = await ready();
    const infos: number[] = [];
    api.on(EventName.info, (_m: string, code: number) => infos.push(code));
    api.connect(121);
    expect(infos).toEqual([501]);
    let count = 0;
    api.on(EventName.disconnected, () => count++);
    api.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    expect(count).toBe(1);
    expect(api.isConnected).toBe(false);
    api.disconnect();
    expect(infos).toEqual([501, 504]);
  });

  it('emits disconnected when the server closes the socket and can reconnect', async () => {
    const { fake, api, session } = await ready();
    const gone = nextEvent(api, EventName.disconnected);
    session.end();
    await gone;
    expect(api.isConnected).toBe(false);
    api.reqCurrentTime(); // held until the next session is ready
    api.connect(121);
    await nextEvent(api, EventName.nextValidId);
    const second = await fake.session(2);
    expect((await second.waitFrames(2))[1]).toEqual(['49', '1']);
  });

  it('reconnecting while the previous socket is still closing reports its close first', async () => {
    const { fake, api } = await ready();
    const events: string[] = [];
    api.on(EventName.disconnected, () => events.push('disconnected'));
    api.on(EventName.connected, () => events.push('connected'));
    api.disconnect();
    api.connect(121);
    await nextEvent(api, EventName.nextValidId);
    expect(events).toEqual(['disconnected', 'connected']);
    expect(api.isConnected).toBe(true);
    expect(fake.sessions).toHaveLength(2);
  });
});

describe('IBApi framing', () => {
  it('handles frames split byte by byte and many frames per chunk', async () => {
    const { api, session } = await ready();
    const times: number[] = [];
    api.on(EventName.currentTime, (t: number) => times.push(t));
    const data = Buffer.concat([frame([49, 1, 1]), frame([49, 1, 2]), frame([49, 1, 3])]);
    for (const byte of data) {
      session.sendRaw(Buffer.from([byte]));
      await new Promise((r) => setImmediate(r));
    }
    session.sendRaw(Buffer.concat([frame([49, 1, 4]), frame([49, 1, 5]), frame([49, 1, 6]).subarray(0, 5)]));
    session.sendRaw(frame([49, 1, 6]).subarray(5));
    await vi.waitFor(() => expect(times).toEqual([1, 2, 3, 4, 5, 6]));
  });

  it('decodes a multi-megabyte historical data response delivered in odd chunks', async () => {
    const { api, session } = await ready();
    const bars = 60_000;
    const fields: Array<string | number> = [17, 9022, '20250101 09:30:00', '20261003 16:00:00', bars];
    for (let i = 0; i < bars; i++) fields.push(`2025${String(i).padStart(8, '0')}`, 100 + i / 1000, 101, 99, 100.5, 12345, 100.25, 42);
    const big = frame(fields);
    expect(big.length).toBeGreaterThan(3_000_000);
    let count = 0;
    let last: unknown[] = [];
    api.on(EventName.historicalData, (...args: unknown[]) => {
      count++;
      last = args;
    });
    const done = new Promise<void>((resolve) => api.on(EventName.historicalData, (_id: number, time: string) => time.startsWith('finished') && resolve()));
    for (let pos = 0; pos < big.length; ) {
      const n = 1 + ((pos * 7919) % 70_000);
      session.sendRaw(big.subarray(pos, pos + n));
      pos += n;
    }
    session.send([49, 1, 77]); // a frame right behind it
    const time = nextEvent(api, EventName.currentTime);
    await done;
    expect(count).toBe(bars + 1);
    expect(last).toEqual([9022, 'finished-20250101 09:30:00-20261003 16:00:00', -1, -1, -1, -1, -1, -1, -1, false]);
    expect(await time).toEqual([77]);
  });

  it('frames non-ASCII text by its UTF-8 byte length in both directions', async () => {
    const { api, session } = await ready();
    api.reqMatchingSymbols(9014, 'Café 中文');
    expect((await session.waitFrames(2))[1]).toEqual(['81', '9014', 'Café 中文']);
    const accounts = nextEvent(api, EventName.managedAccounts);
    session.send([15, 1, 'DU1,Δ2,账户']);
    expect(await accounts).toEqual(['DU1,Δ2,账户']);
  });

  it('skips unknown messages without losing the following ones', async () => {
    const { api, session, log } = await ready();
    const n = log.length;
    session.sendRaw(Buffer.concat([frame([999, 1, 'x', 'y']), frame([14, 1, 1, 1, 'bulletin', 'NYSE']), frame([49, 1, 5])]));
    await nextEvent(api, EventName.currentTime);
    expect(log.slice(n).map(([name]) => name)).toEqual(['received', 'received', 'received', 'currentTime']);
  });

  it('closes the connection on an impossible frame length', async () => {
    const { api, session } = await ready();
    const err = nextEvent(api, EventName.error);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(0x1000000, 0);
    session.sendRaw(head);
    const [e, code] = await err;
    expect(code).toBe(502);
    expect((e as Error).message).toMatch(/exceeded max message length/);
    await nextEvent(api, EventName.disconnected);
  });

  it('keeps processing when a listener throws (the error is rethrown asynchronously)', async () => {
    const { api, session } = await ready();
    const thrown: unknown[] = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb: () => void) => {
      try {
        cb();
      } catch (err) {
        thrown.push(err);
      }
    });
    api.once(EventName.currentTime, () => {
      throw new Error('listener failed');
    });
    const second = new Promise<unknown[]>((resolve) => api.on(EventName.managedAccounts, (...a: unknown[]) => resolve(a)));
    session.sendRaw(Buffer.concat([frame([49, 1, 1]), frame([15, 1, 'DU999'])]));
    expect(await second).toEqual(['DU999']);
    expect(thrown.map((e) => (e as Error).message)).toEqual(['listener failed']);
  });
});

describe('IBApi send queue', () => {
  const max = DEFAULT_MAX_PER_SECOND;

  it(`never writes more than ${max} messages in any 1000 ms window and never drops one`, async () => {
    const { api, session } = await ready();
    const times: number[] = [];
    api.on(EventName.sent, () => times.push(Date.now()));
    const start = Date.now();
    for (let i = 0; i < 120; i++) api.reqIds(i);
    expect(times).toHaveLength(BURST - 2); // the handshake and START_API count; the rest is spread
    const frames = await session.waitFrames(121, 10_000);
    expect(frames.slice(1).map((f) => f[2])).toEqual(Array.from({ length: 120 }, (_, i) => String(i)));
    for (let i = 0; i + max < times.length; i++) expect(times[i + max] - times[i]).toBeGreaterThanOrEqual(1000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(2000);
  }, 15_000);

  it('flushes held requests by lane and drops unsent request / cancel pairs', async () => {
    const { fake, api } = await setup({ autoReady: false });
    const sent: unknown[] = [];
    api.on(EventName.sent, (tokens: unknown[]) => sent.push(tokens[0]));
    api.reqMktData(9020, stk, null, false, false);
    api.reqCurrentTime();
    api.reqHistoricalData(9022, stk, '', '2 D', '1 hour', 'TRADES', 1, 2, false);
    api.placeOrder(11, stk, { action: 'BUY', orderType: 'LMT', totalQuantity: 1, lmtPrice: 1, tif: 'GTC', transmit: true });
    api.cancelMktData(9020);
    api.reqPnL(9002, 'DU123');
    api.reqIds(1);
    api.cancelPnL(9002);
    const session = await fake.session();
    await session.waitFrames(1);
    session.send([9, 1, 100]);
    const frames = await session.waitFrames(5);
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.slice(1).map((f) => f[0])).toEqual(['3', '8', '49', '20']);
    expect(sent.slice(2)).toEqual([3, 8, 49, 20]);
    expect(api.getQueueStats().elidedPairs).toBe(2);
  });

  it('when the limit is reached: orders first, a cancel removes its unsent request', async () => {
    const { api, session } = await ready({}, 3); // handshake + START_API leave room for one
    api.reqCurrentTime();
    api.reqMktData(9020, stk, null, false, false);
    api.reqHistoricalData(9022, stk, '', '2 D', '1 hour', 'TRADES', 1, 2, false);
    api.reqAccountSummary(9001, 'All', 'NetLiquidation');
    api.placeOrder(11, stk, { action: 'BUY', orderType: 'LMT', totalQuantity: 1, lmtPrice: 1, tif: 'GTC', transmit: true });
    api.cancelMktData(9020);
    api.cancelAccountSummary(9001);
    expect(api.getQueueStats()).toMatchObject({ queued: { order: 1, control: 0, marketData: 1 }, sentLastSecond: 3, elidedPairs: 2, maxPerSecond: 3 });
    const frames = await session.waitFrames(4);
    expect(frames.map((f) => f[0])).toEqual(['71', '49', '3', '20']);
  });

  it('emits queueStats at most once per second while frames wait, and once drained', async () => {
    const { api, session } = await ready({}, 3);
    const stats: Array<{ at: number; queued: number; held: number }> = [];
    const drained = new Promise<void>((resolve) =>
      api.on('queueStats', (s) => {
        stats.push({ at: performance.now(), queued: s.queued.order + s.queued.control + s.queued.marketData, held: s.held });
        if (stats.at(-1)?.queued === 0) resolve();
      }),
    );
    for (let i = 0; i < 4; i++) api.reqCurrentTime();
    await drained;
    await session.waitFrames(5);
    expect(stats.map((s) => [s.queued, s.held])).toEqual([
      [3, 0],
      [0, 0],
    ]);
    expect(stats[1].at - stats[0].at).toBeGreaterThanOrEqual(999);
  });

  it('backs off on error 100: half the rate for 10 s, logged once per burst', async () => {
    const { api, session } = await ready();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = nextEvent(api, EventName.info);
    const error = nextEvent(api, EventName.error);
    const msg = 'Max rate of messages per second has been exceeded:max=50 rec=56 (1)';
    session.send([4, 2, -1, 100, msg, '']);
    session.send([4, 2, -1, 100, msg, '']);
    session.send([4, 2, 9020, 100, msg, '']);
    expect((await info).slice(1)).toEqual([100]); // still reported to the application
    expect((await error).slice(1, 3)).toEqual([100, 9020]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/error 100.*at most 22 messages\/s for 10 s/);
    const stats = api.getQueueStats();
    expect(stats.maxPerSecond).toBe(22);
    expect(stats.backoffUntil - Date.now()).toBeGreaterThan(9000);
    const sent: unknown[] = [];
    api.on(EventName.sent, (tokens: unknown[]) => sent.push(tokens));
    const room = Math.min(BURST, 22) - api.getQueueStats().sentLastSecond;
    for (let i = 0; i < 30; i++) api.reqCurrentTime();
    expect(sent).toHaveLength(room);
    expect(api.getQueueStats().queued.control).toBe(30 - room);
  });

  it('applies IB’s pacing to symbol searches and historical data when they are written', async () => {
    const { api, session } = await ready();
    const sent: number[] = [];
    api.on(EventName.sent, (tokens: unknown[]) => sent.push(Number(tokens[0])));
    api.reqMatchingSymbols(9014, 'AA');
    api.reqMatchingSymbols(9015, 'AAP'); // within 1 s: held
    api.reqHistoricalData(9022, stk, '', '2 D', '1 hour', 'TRADES', 1, 2, false);
    api.reqHistoricalData(9023, stk, '', '2 D', '1 hour', 'TRADES', 1, 2, false); // identical within 15 s: held
    api.reqMktData(9020, stk, null, false, false); // passes the held frames
    api.cancelHistoricalData(9023); // removes the held request
    expect(sent).toEqual([81, 20, 1]);
    expect(api.getQueueStats()).toMatchObject({ queued: { order: 0, control: 0, marketData: 1 }, elidedPairs: 1 });
    const frames = await session.waitFrames(5, 3000);
    expect(frames.slice(1).map((f) => [f[0], f[1]])).toEqual([
      ['81', '9014'],
      ['20', '9022'],
      ['1', '11'],
      ['81', '9015'],
    ]);
  });

  it('getQueueStats() without a connection', () => {
    const api = new IBApi({ host: '127.0.0.1', port: 1 });
    api.reqCurrentTime();
    expect(api.getQueueStats()).toEqual({
      queued: { order: 0, control: 0, marketData: 0 },
      held: 1,
      sentLastSecond: 0,
      elidedPairs: 0,
      backoffUntil: 0,
      maxPerSecond: DEFAULT_MAX_PER_SECOND,
    });
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(!stoqey)('IBApi vs @stoqey/ib IBApi on the wire', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const lib = stoqey?.lib;

  const scenario = (api: any, cond: (c: any) => unknown): void => {
    const opt: Contract = { symbol: 'AAPL', secType: 'OPT', lastTradeDateOrContractMonth: '20261016', strike: 250, right: 'C', multiplier: 100, exchange: 'SMART', currency: 'USD' };
    const lmt: Order = { action: 'BUY', orderType: 'LMT', totalQuantity: 1, lmtPrice: 1, tif: 'DAY', transmit: true, account: 'DU123' };
    api.reqMarketDataType(4);
    api.reqMktData(9020, stk, null, false, false);
    api.reqMktData(9021, opt, '100,101,106', true, false);
    api.cancelMktData(9020);
    api.reqMktDepth(9024, stk, 5, true, []);
    api.cancelMktDepth(9024, true);
    api.reqHistoricalData(9022, stk, '', '2 D', '1 hour', 'TRADES', 1, 2, false);
    api.cancelHistoricalData(9022);
    api.reqHeadTimestamp(9023, stk, 'TRADES', true, 1);
    api.reqContractDetails(9010, { conId: 265598 });
    api.reqMatchingSymbols(9014, 'AAPL');
    api.reqSecDefOptParams(9012, 'AAPL', '', 'STK', 265598);
    api.reqAccountSummary(9001, 'All', 'NetLiquidation,BuyingPower');
    api.cancelAccountSummary(9001);
    api.reqAccountUpdates(true, 'DU123');
    api.reqAccountUpdates(false, undefined);
    api.reqPositions();
    api.cancelPositions();
    api.reqPnL(9002, 'DU123');
    api.reqPnL(9004, 'DU123', null);
    api.cancelPnL(9002);
    api.reqPnLSingle(9003, 'DU123', null, 265598);
    api.cancelPnLSingle(9003);
    api.reqIds();
    api.reqManagedAccts();
    api.reqCurrentTime();
    api.reqOpenOrders();
    api.reqAllOpenOrders();
    api.reqAutoOpenOrders(true);
    api.reqCompletedOrders(false);
    api.reqExecutions(9015, {});
    api.placeOrder(11, stk, lmt);
    api.placeOrder(12, stk, { ...lmt, tif: 'GTC', conditions: [cond(lib)], conditionsIgnoreRth: true, conditionsCancelOrder: false });
    api.placeOrder(13, stk, { ...lmt, transmit: false });
    api.placeOrder(14, stk, { ...lmt, action: 'SELL', lmtPrice: 2000, parentId: 13, transmit: false });
    api.placeOrder(15, stk, { action: 'SELL', orderType: 'STP', totalQuantity: 1, auxPrice: 0.5, parentId: 13, tif: 'DAY', transmit: true });
    api.cancelOrder(11);
    api.cancelOrder(12, '20261005-09:30:00');
    api.cancelOrder(13, { manualOrderCancelTime: '', extOperator: 'op', manualOrderIndicator: 1 });
    api.reqGlobalCancel();
  };

  for (const serverVersion of [176, 193]) {
    it(`sends identical frames at server version ${serverVersion}`, async () => {
      const run = async (make: (port: number) => any, priceCondition: () => unknown) => {
        const fake = await FakeTws.start({ serverVersion });
        servers.push(fake);
        const api = make(fake.port);
        clients.push(api);
        const sent: unknown[][] = [];
        api.on('sent', (tokens: unknown[]) => sent.push(tokens));
        api.on('error', () => undefined);
        const readyP = new Promise((r) => api.once('nextValidId', r));
        api.connect(121);
        await readyP;
        scenario(api, priceCondition);
        await new Promise((r) => setTimeout(r, 300));
        const session = await fake.session();
        return { sent: sent.slice(2), frames: session.frames }; // skip handshake + START_API in `sent`
      };
      const theirs = await run(
        (port) => new lib.IBApi({ host: '127.0.0.1', port, maxReqPerSec: 10_000 }),
        () => new lib.PriceCondition(10000, 0, 265598, 'SMART', true, 'a'),
      );
      const { PriceCondition } = await import('./conditions.ts');
      const ours = await run(
        (port) => new IBApi({ host: '127.0.0.1', port, maxReqPerSec: 10_000 }),
        () => new PriceCondition(10000, 0, 265598, 'SMART', true, 'a'),
      );
      expect(ours.frames.length).toBeGreaterThan(35);
      expect(ours.frames).toStrictEqual(theirs.frames);
      expect(ours.sent).toStrictEqual(theirs.sent);
    });
  }
});
