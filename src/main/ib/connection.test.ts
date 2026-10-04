import { EventEmitter } from 'node:events';
import type { IBApi } from './tws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import type { NewNotification, TapeEvent } from '@shared/ipc';
import type { ConnectionState, Settings } from '@shared/types';
import type { MainContext } from '../context';
import { createConnection } from './connection';

/** Stand-in for IBApi: records calls; tests emit the events IB would send. */
class FakeApi extends EventEmitter {
  connects: number[] = [];
  disconnects = 0;
  currentTimeRequests = 0;
  constructor(readonly opts: { host: string; port: number }) {
    super();
  }
  connect(clientId: number) {
    this.connects.push(clientId);
    return this;
  }
  disconnect() {
    this.disconnects++;
    setTimeout(() => this.emit('disconnected'), 0);
    return this;
  }
  reqCurrentTime() {
    this.currentTimeRequests++;
    return this;
  }
  /** The handshake as IB Gateway sends it: server version, accounts, next order id. */
  handshake(orderId = 4012, accounts = 'DUP899854') {
    this.emit('connected');
    this.emit('server', 193, '20261004 11:22:58 China Standard Time');
    this.emit('managedAccounts', accounts);
    this.emit('nextValidId', orderId);
  }
}

function setup(patch: Partial<Settings['connection']> = {}) {
  let settings: Settings = defaultSettings();
  settings = { ...settings, connection: { ...settings.connection, ...patch } };
  const settingsListeners: Array<(n: Settings, p: Settings) => void> = [];
  const events: TapeEvent[] = [];
  const notes: Array<{ name: string; fields: Array<[string, string]> }> = [];
  const notices: NewNotification[] = [];
  const apis: FakeApi[] = [];
  const ctx = {
    emit: (e: TapeEvent) => events.push(e),
    store: {
      getSettings: () => settings,
      onSettingsChanged: (l: (n: Settings, p: Settings) => void) => {
        settingsListeners.push(l);
        return () => undefined;
      },
    },
    notifier: { notify: (n: NewNotification) => (notices.push(n), n) },
    apiLog: { note: (_dir: string, name: string, fields: Array<[string, string]>) => notes.push({ name, fields }) },
  } as unknown as MainContext;
  const ib = createConnection(ctx, (o) => {
    const api = new FakeApi(o);
    apis.push(api);
    return api as unknown as IBApi;
  });
  const changeSettings = (p: Partial<Settings['connection']>) => {
    const prev = settings;
    settings = { ...settings, connection: { ...settings.connection, ...p } };
    for (const l of settingsListeners) l(settings, prev);
  };
  const states = () => events.filter((e): e is Extract<TapeEvent, { type: 'connection' }> => e.type === 'connection').map((e) => e.state);
  const last = (): ConnectionState => ib.getState();
  return { ib, apis, notices, notes, states, last, changeSettings, api: () => apis[apis.length - 1] };
}

describe('IbConnection', () => {
  const env = process.env.TAPE_CLIENT_ID;
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.TAPE_CLIENT_ID;
  });
  afterEach(() => {
    vi.useRealTimers();
    if (env === undefined) delete process.env.TAPE_CLIENT_ID;
    else process.env.TAPE_CLIENT_ID = env;
  });

  it('connects, tracks the handshake and fires ready listeners', async () => {
    const t = setup();
    const ready = vi.fn();
    t.ib.onReady(ready);
    const p = t.ib.connect();
    expect(t.last().status).toBe('connecting');
    expect(t.api().connects).toEqual([7]);
    expect(t.ib.api).toBeNull();
    t.api().handshake();
    await p;
    expect(t.last()).toMatchObject({ status: 'connected', serverVersion: 193, accounts: ['DUP899854'], account: 'DUP899854', isPaper: true });
    expect(t.last().connTime).toBe('20261004 11:22:58 China Standard Time');
    expect(ready).toHaveBeenCalledTimes(1);
    expect(t.ib.api).toBe(t.api());
    expect(t.ib.isConnected()).toBe(true);
    expect(t.ib.nextOrderId()).toBe(4012);
    expect(t.ib.nextOrderId()).toBe(4013);
    expect(t.ib.nextReqId()).toBe(1000);
    expect(t.ib.nextReqId()).toBe(1001);
  });

  it('waits for the account list when nextValidId comes first', async () => {
    const t = setup();
    const ready = vi.fn();
    t.ib.onReady(ready);
    const p = t.ib.connect();
    t.api().emit('nextValidId', 1);
    expect(ready).not.toHaveBeenCalled();
    t.api().emit('managedAccounts', 'U1234567');
    await p;
    expect(ready).toHaveBeenCalledTimes(1);
    expect(t.last()).toMatchObject({ account: 'U1234567', isPaper: false });
  });

  it('uses TAPE_CLIENT_ID', () => {
    process.env.TAPE_CLIENT_ID = '101';
    const t = setup();
    void t.ib.connect();
    expect(t.api().connects).toEqual([101]);
    expect(t.last().clientId).toBe(101);
  });

  it('forwards registered listeners and routes errors', async () => {
    const t = setup();
    const ticks = vi.fn();
    const reqErrors = vi.fn();
    t.ib.on('tickPrice', ticks);
    t.ib.onRequestError(reqErrors);
    const p = t.ib.connect();
    t.api().handshake();
    await p;
    t.api().emit('info', 'Market data farm connection is OK:usfarm', 2104);
    t.api().emit('info', 'HMDS data farm connection is inactive but should be available upon demand.ushmds', 2107);
    expect(t.last().farms).toEqual({ usfarm: 'ok', ushmds: 'inactive' });
    expect(t.last().lastError).toBeUndefined();

    t.api().emit('error', new Error('No market data during competing live session'), 10197, 1001);
    expect(reqErrors).toHaveBeenCalledWith({ reqId: 1001, code: 10197, message: 'No market data during competing live session' });
    expect(t.last().marketDataIssue).toEqual({ code: 10197, message: 'No market data during competing live session' });
    t.api().emit('tickPrice', 1001, 4, 227.5);
    expect(ticks).toHaveBeenCalledWith(1001, 4, 227.5);
    expect(t.last().marketDataIssue).toBeUndefined();

    t.api().emit('info', "Error validating request.-'bZ' : cause - The API interface is currently in Read-Only mode.", 321);
    expect(t.last().lastError).toMatchObject({ code: 321, message: 'The API interface is currently in Read-Only mode.' });

    // A throwing listener must not break the others.
    t.ib.on('tickPrice', () => {
      throw new Error('boom');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => t.api().emit('tickPrice', 1, 1, 1)).not.toThrow();
    spy.mockRestore();
  });

  it('measures latency with the heartbeat', async () => {
    const t = setup();
    const p = t.ib.connect();
    t.api().handshake();
    await p;
    expect(t.api().currentTimeRequests).toBe(1);
    vi.advanceTimersByTime(12);
    t.api().emit('currentTime', 1791084178);
    expect(t.last().latencyMs).toBe(12);
    vi.advanceTimersByTime(30_000);
    expect(t.api().currentTimeRequests).toBe(2);
  });

  it('reports a refused connection without retrying', async () => {
    const t = setup();
    const p = t.ib.connect();
    t.api().emit('error', new Error('connect ECONNREFUSED 127.0.0.1:4002'), 502, -1);
    t.api().emit('disconnected');
    await expect(p).rejects.toThrow('Connection refused at 127.0.0.1:4002');
    expect(t.last()).toMatchObject({ status: 'disconnected', lastError: { code: 502 } });
    expect(t.notices.map((n) => n.title.en)).toEqual(['Could not connect to IB Gateway']);
    vi.advanceTimersByTime(60_000);
    expect(t.api().connects).toHaveLength(1);
  });

  it('reports a client id conflict', async () => {
    const t = setup();
    const p = t.ib.connect();
    t.api().emit('info', 'Unable to connect as the client id is already in use. Retry with a unique client id.', 326);
    await expect(p).rejects.toThrow('Client ID 7 is already in use');
    await vi.advanceTimersByTimeAsync(10);
    expect(t.last().status).toBe('disconnected');
  });

  it('reconnects every 5 s after an unexpected close and restores subscriptions', async () => {
    const t = setup();
    const ready = vi.fn();
    const closed = vi.fn();
    t.ib.onReady(ready);
    t.ib.onClosed(closed);
    const p = t.ib.connect();
    t.api().handshake();
    await p;

    t.api().emit('disconnected');
    expect(closed).toHaveBeenCalledTimes(1);
    expect(t.last()).toMatchObject({ status: 'reconnecting', reconnectAttempt: 1 });
    expect(t.ib.api).toBeNull();
    expect(t.notices.map((n) => n.title.en)).toEqual(['Disconnected from IB Gateway']);
    expect(t.notes.map((n) => n.name)).toEqual(['socket close']);

    vi.advanceTimersByTime(4_999);
    expect(t.api().connects).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.api().connects).toHaveLength(2);
    // second attempt fails
    t.api().emit('error', new Error('connect ECONNREFUSED 127.0.0.1:4002'), 502, -1);
    t.api().emit('disconnected');
    expect(t.last()).toMatchObject({ status: 'reconnecting', reconnectAttempt: 2 });

    vi.advanceTimersByTime(5_000);
    t.api().handshake(4100);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.last()).toMatchObject({ status: 'connected' });
    expect(t.last().reconnectAttempt).toBeUndefined();
    expect(ready).toHaveBeenCalledTimes(2);
    expect(t.notices.map((n) => n.title.en)).toEqual(['Disconnected from IB Gateway', 'Reconnected to IB Gateway']);
    expect(t.notices[1].body.en).toBe('Reconnected after 10 s offline. All subscriptions restored.');
  });

  it('gives up after 10 attempts', async () => {
    const t = setup();
    const p = t.ib.connect();
    t.api().handshake();
    await p;
    t.api().emit('disconnected');
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(5_000);
      t.api().emit('error', new Error('connect ECONNREFUSED 127.0.0.1:4002'), 502, -1);
      t.api().emit('disconnected');
    }
    expect(t.api().connects).toHaveLength(11);
    expect(t.last()).toMatchObject({ status: 'disconnected' });
    expect(t.notices.map((n) => n.title.en)).toEqual(['Disconnected from IB Gateway', 'Could not reconnect to IB Gateway']);
    expect(t.notices[1].body.en).toBe('Gave up after 10 attempts. Connection refused at 127.0.0.1:4002.');
    vi.advanceTimersByTime(60_000);
    expect(t.api().connects).toHaveLength(11);
  });

  it('does not reconnect when auto-reconnect is off', async () => {
    const t = setup({ autoReconnect: false });
    const p = t.ib.connect();
    t.api().handshake();
    await p;
    t.api().emit('disconnected');
    expect(t.last().status).toBe('disconnected');
    vi.advanceTimersByTime(60_000);
    expect(t.api().connects).toHaveLength(1);
  });

  it('never reconnects after a manual disconnect', async () => {
    const t = setup();
    const p = t.ib.connect();
    t.api().handshake();
    await p;
    const done = t.ib.disconnect();
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(t.last().status).toBe('disconnected');
    expect(t.notes).toEqual([{ name: 'socket close', fields: [['reason', 'user disconnect']] }]);
    expect(t.notices).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(t.api().connects).toHaveLength(1);
  });

  it('recreates the instance when host, port or client id change, keeping listeners', async () => {
    const t = setup();
    const ticks = vi.fn();
    t.ib.on('tickPrice', ticks);
    const p = t.ib.connect();
    t.api().handshake();
    await p;
    await vi.advanceTimersByTimeAsync(0); // settings subscription is deferred
    t.changeSettings({ port: 7497 });
    await vi.advanceTimersByTimeAsync(10);
    expect(t.apis).toHaveLength(2);
    expect(t.api().opts).toEqual({ host: '127.0.0.1', port: 7497 });
    expect(t.last()).toMatchObject({ status: 'connecting', port: 7497 });
    t.api().handshake();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.last().status).toBe('connected');
    t.api().emit('tickPrice', 5, 1, 10);
    expect(ticks).toHaveBeenCalledWith(5, 1, 10);
    t.apis[0].emit('tickPrice', 6, 1, 10);
    expect(ticks).toHaveBeenCalledTimes(1);
  });

  describe('after a settings change', () => {
    async function connected(patch: Partial<Settings['connection']> = {}) {
      const t = setup(patch);
      const p = t.ib.connect();
      t.api().handshake();
      await p;
      await vi.advanceTimersByTimeAsync(0); // settings subscription is deferred
      return t;
    }
    const refuse = (api: FakeApi) => {
      api.emit('error', new Error(`connect ECONNREFUSED 127.0.0.1:${api.opts.port}`), 502, -1);
      api.emit('disconnected');
    };

    it('retries a failed first attempt with auto-reconnect', async () => {
      const t = await connected();
      t.changeSettings({ port: 7497 });
      await vi.advanceTimersByTimeAsync(10);
      expect(t.apis).toHaveLength(2);
      refuse(t.api());
      expect(t.last()).toMatchObject({ status: 'reconnecting', reconnectAttempt: 1, port: 7497, lastError: { code: 502 } });
      expect(t.notices).toEqual([]);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(t.apis).toHaveLength(2); // same parameters, same instance
      expect(t.api().connects).toEqual([7, 7]);
      t.api().handshake();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.last()).toMatchObject({ status: 'connected', port: 7497 });
      expect(t.last().reconnectAttempt).toBeUndefined();

      // The next drop starts a fresh count; a later failed manual connect is reported, not retried.
      const done = t.ib.disconnect();
      await vi.advanceTimersByTimeAsync(10);
      await done;
      const manual = t.ib.connect();
      refuse(t.api());
      await expect(manual).rejects.toThrow('Connection refused at 127.0.0.1:7497');
      expect(t.last().status).toBe('disconnected');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.api().connects).toHaveLength(3);
    });

    it('gives up after 10 retries', async () => {
      const t = await connected();
      t.changeSettings({ clientId: 165 });
      await vi.advanceTimersByTimeAsync(10);
      refuse(t.api());
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(5_000);
        refuse(t.api());
      }
      expect(t.api().connects).toEqual(Array(11).fill(165));
      expect(t.last()).toMatchObject({ status: 'disconnected', clientId: 165 });
      expect(t.notices.map((n) => n.title.en)).toEqual(['Could not reconnect to IB Gateway']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.api().connects).toHaveLength(11);
    });

    it('reports the failure without auto-reconnect', async () => {
      const t = await connected({ autoReconnect: false });
      t.changeSettings({ port: 7497 });
      await vi.advanceTimersByTimeAsync(10);
      refuse(t.api());
      expect(t.last().status).toBe('disconnected');
      expect(t.notices.map((n) => n.title.en)).toEqual(['Could not connect to IB Gateway']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.api().connects).toHaveLength(1);
    });

    it('replaces a pending retry with an attempt on the new parameters', async () => {
      const t = await connected();
      t.api().emit('disconnected');
      expect(t.last()).toMatchObject({ status: 'reconnecting', reconnectAttempt: 1 });
      t.changeSettings({ port: 7497 });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.last()).toMatchObject({ status: 'connecting', port: 7497 });
      refuse(t.api());
      expect(t.last()).toMatchObject({ status: 'reconnecting', reconnectAttempt: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
      t.api().handshake();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.last().status).toBe('connected');
      expect(t.apis.map((a) => [a.opts.port, a.connects.length])).toEqual([
        [4002, 1],
        [7497, 2],
      ]);
    });

    it('connects once, with the newest parameters, after quick successive changes', async () => {
      const t = await connected();
      t.changeSettings({ port: 7497 });
      t.changeSettings({ port: 7496 });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(t.apis.slice(1).map((a) => [a.opts.port, a.connects.length])).toEqual([[7496, 1]]);
      expect(t.last()).toMatchObject({ status: 'connecting', port: 7496 });
    });

    it('does not reconnect when the user disconnects meanwhile', async () => {
      const t = await connected();
      t.changeSettings({ port: 7497 });
      const done = t.ib.disconnect();
      await vi.advanceTimersByTimeAsync(1_500);
      await done;
      expect(t.apis).toHaveLength(1);
      expect(t.last()).toMatchObject({ status: 'disconnected', port: 7497 });
    });
  });

  it('handles IB connectivity loss and restore', async () => {
    const t = setup();
    const ready = vi.fn();
    t.ib.onReady(ready);
    const p = t.ib.connect();
    t.api().handshake();
    await p;
    t.api().emit('info', 'Connectivity between IB and Trader Workstation has been lost.', 1100);
    expect(t.last().lastError?.code).toBe(1100);
    t.api().emit('info', 'Connectivity between IB and Trader Workstation has been restored - data lost.', 1101);
    expect(t.last().lastError).toBeUndefined();
    expect(ready).toHaveBeenCalledTimes(2);
    expect(t.notices.map((n) => n.title.en)).toEqual(['IB Gateway lost its connection to IB', 'IB Gateway reconnected to IB']);
  });
});
