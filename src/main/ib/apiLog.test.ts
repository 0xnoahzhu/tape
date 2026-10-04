import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import type { TapeEvent } from '@shared/ipc';
import type { ApiLogEntry, Settings } from '@shared/types';
import type { IbListener, MainContext } from '../context';
import { FLUSH_MS } from './apiLogFiles';
import { decodeFrame, decodeFrameText, formatLogLine } from './messageSchema';

const electron = vi.hoisted(() => ({ dir: '', quit: [] as Array<() => void> }));

// Counts decodes: frames nobody reads must stay raw.
vi.mock('./messageSchema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./messageSchema')>();
  return { ...actual, decodeFrameText: vi.fn(actual.decodeFrameText) };
});

vi.mock('electron', () => ({
  app: {
    getPath: () => electron.dir,
    whenReady: () => new Promise(() => undefined),
    on: (event: string, fn: () => void) => event === 'will-quit' && electron.quit.push(fn),
  },
}));

const { FrameRing, RING_SIZE, STREAM_BY_DEFAULT, createApiLog, createLogViewers } = await import('./apiLog');

const T0 = new Date(2026, 9, 4, 10, 0, 0, 0).getTime();
const HANDSHAKE = ['API\0', 0, 0, 0, 9, 'v176..193'];
const tickPrice = (reqId: number, price = '227.48') => ['1', '6', String(reqId), '1', price, '300', '0'];
const OPEN_ORDER = ['5', '4012', '265598', 'AAPL', 'STK', '', '0', '', '', 'SMART', 'USD', 'AAPL', 'NMS', 'BUY', '1', 'LMT', '1.0', '0.0', 'GTC'];

async function setup(opts: { writeFile?: boolean; streamByDefault?: boolean } = {}) {
  const base = defaultSettings('en');
  let settings: Settings = { ...base, apiLog: { ...base.apiLog, writeFile: opts.writeFile ?? false } };
  const settingsListeners: Array<(next: Settings, prev: Settings) => void> = [];
  const listeners = new Map<string, IbListener>();
  const events: TapeEvent[] = [];
  const ctx = {
    emit: (e: TapeEvent) => events.push(e),
    store: {
      getSettings: () => settings,
      onSettingsChanged: (l: (next: Settings, prev: Settings) => void) => settingsListeners.push(l),
    },
    ib: { on: (event: string, l: IbListener) => listeners.set(event, l) },
  } as unknown as MainContext;
  const log = createApiLog(ctx, { streamByDefault: opts.streamByDefault ?? false });
  await vi.advanceTimersByTimeAsync(0); // deferred subscriptions
  const fire = (event: string, ...args: unknown[]) => listeners.get(event)!(...args);
  return {
    log,
    events,
    /** Like the TWS client: the tokens and their text. */
    send: (tokens: unknown[]) => fire('sent', tokens, tokens.join('\0')),
    receive: (fields: string[]) => fire('received', fields.slice(), fields.join('\0') + '\0'),
    fire,
    batches: () => events.flatMap((e) => (e.type === 'apiLog' ? [e.entries.map((x) => x.seq)] : [])),
    setSettings(patch: Partial<Settings['apiLog']>) {
      const prev = settings;
      settings = { ...settings, apiLog: { ...settings.apiLog, ...patch } };
      for (const l of settingsListeners) l(settings, prev);
    },
  };
}

/** The entry the log showed before the ring: decodeFrame plus seq, time and direction. */
const expected = (seq: number, t: number, dir: 'in' | 'out', tokens: unknown[], opts = {}): ApiLogEntry => ({ seq, t, dir, ...decodeFrame(dir, tokens, opts) });

describe('API log', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    electron.dir = mkdtempSync(join(tmpdir(), 'tape-apilog-'));
    electron.quit.length = 0;
    vi.stubEnv('TAPE_USER_DATA', '');
    vi.mocked(decodeFrameText).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('records frames raw and decodes them into the same entries as before', async () => {
    const { log, send, receive } = await setup();
    send(HANDSHAKE);
    receive(['176', '20261004 10:00:00 EST']);
    await vi.advanceTimersByTimeAsync(5);
    send([71, 2, 139, '']);
    send([4, 1, 4012, '']); // cancelOrder: its layout depends on the server version
    receive(tickPrice(1001));
    receive(['4', '2', '1009', '10090', 'Part of requested market data is not subscribed.', '']);
    expect(log.getEntries()).toEqual([
      expected(1, T0, 'out', HANDSHAKE),
      expected(2, T0, 'in', ['176', '20261004 10:00:00 EST'], { firstReceived: true }),
      expected(3, T0 + 5, 'out', [71, 2, 139, '']),
      expected(4, T0 + 5, 'out', [4, 1, 4012, ''], { serverVersion: 176 }),
      expected(5, T0 + 5, 'in', tickPrice(1001)),
      expected(6, T0 + 5, 'in', ['4', '2', '1009', '10090', 'Part of requested market data is not subscribed.', '']),
    ]);
    expect(log.getEntries()[3].fields.map(([k]) => k)).toEqual(['version', 'orderId', 'manualOrderCancelTime']);
    expect(log.getEntries()[5].err).toBe(true);
  });

  it('accepts frames without text (tokens only)', async () => {
    const { log, fire } = await setup();
    fire('sent', [1, 11, 1001, undefined, 'AAPL']);
    fire('received', tickPrice(7));
    expect(log.getEntries()).toEqual([expected(1, T0, 'out', [1, 11, 1001, undefined, 'AAPL']), expected(2, T0, 'in', tickPrice(7))]);
  });

  it('caches decoded entries in their slots', async () => {
    const { log, receive } = await setup();
    receive(tickPrice(1));
    receive(tickPrice(2));
    const [a, b] = log.getEntries();
    expect(log.getEntries()[0]).toBe(a);
    expect(log.getEntries()[1]).toBe(b);
  });

  it(`keeps the newest ${RING_SIZE.toLocaleString('en-US')} frames; seq goes on after clear`, async () => {
    const { log, receive, send } = await setup();
    for (let i = 1; i <= RING_SIZE + 5; i++) receive(tickPrice(i));
    const entries = log.getEntries();
    expect(entries).toHaveLength(RING_SIZE);
    expect(entries[0]).toMatchObject({ seq: 6, reqId: '6' });
    expect(entries.at(-1)).toMatchObject({ seq: RING_SIZE + 5, reqId: String(RING_SIZE + 5) });
    log.clear();
    expect(log.getEntries()).toEqual([]);
    send([49, 1]);
    expect(log.getEntries()).toEqual([expected(RING_SIZE + 6, T0, 'out', [49, 1])]);
  });

  it('records notes and annotates openOrder entries with the order state', async () => {
    const { log, receive, fire } = await setup();
    log.note('out', 'socket close', [['reason', 'user disconnect']]);
    receive(OPEN_ORDER);
    fire('openOrder', 4012, {}, {}, { status: 'Submitted', warningText: 'far from market' });
    receive(tickPrice(1));
    fire('openOrder', 4012, {}, {}, { status: 'Cancelled' }); // not for the last frame: ignored
    const [note, order, tick] = log.getEntries();
    expect(note).toEqual({ seq: 1, t: T0, dir: 'out', msgId: '—', name: 'socket close', fields: [['reason', 'user disconnect']], bytes: 0, err: false, raw: '' });
    expect(order.fields.slice(-2)).toEqual([
      ['status', 'Submitted'],
      ['warningText', 'far from market'],
    ]);
    expect(tick.fields.map(([k]) => k)).not.toContain('status');
  });

  it('adds the order state without decoding the frame on the socket path', async () => {
    const { log, receive, fire } = await setup();
    receive(OPEN_ORDER);
    fire('openOrder', 4012, {}, {}, { status: 'PreSubmitted' });
    receive(['101', '265598', 'AAPL', 'STK']);
    fire('completedOrder', {}, {}, { status: 'Cancelled', completedStatus: 'Cancelled by Trader' });
    expect(decodeFrameText).not.toHaveBeenCalled();
    const [order, completed] = log.getEntries();
    expect(order.fields.at(-1)).toEqual(['status', 'PreSubmitted']);
    expect(completed.fields.slice(-2)).toEqual([
      ['status', 'Cancelled'],
      ['completedStatus', 'Cancelled by Trader'],
    ]);
    // An entry already decoded gets the fields directly.
    receive(OPEN_ORDER);
    log.getEntries();
    fire('openOrder', 4012, {}, {}, { status: 'Submitted' });
    expect(log.getEntries()[2].fields.at(-1)).toEqual(['status', 'Submitted']);
  });

  it('keeps one copy of a frame once its entry is cached', () => {
    const ring = new FrameRing(4);
    const raw = (ring as unknown as { raw: unknown[] }).raw;
    const text = tickPrice(1).join('\0') + '\0';
    const seq = ring.push(T0, 'in', 0, 193, 1, text);
    const line = ring.line(seq, false);
    expect(ring.entry(seq, false)).not.toBe(ring.entry(seq, false)); // not cached: text kept
    expect(raw[0]).toBe(text);
    const entry = ring.entry(seq, true);
    expect(raw[0]).toBe(''); // the entry holds the frame (as `raw`)
    expect(ring.entry(seq, false)).toBe(entry);
    expect(ring.line(seq, false)).toBe(line);
    expect(entry).toEqual(expected(seq, T0, 'in', tickPrice(1)));
  });

  it('stamps the frames of one task with one time', async () => {
    const { log, receive } = await setup();
    receive(tickPrice(1));
    vi.setSystemTime(T0 + 3); // the clock moves inside the same task
    receive(tickPrice(2));
    await vi.advanceTimersByTimeAsync(1);
    receive(tickPrice(3));
    expect(log.getEntries().map((e) => e.t)).toEqual([T0, T0, T0 + 4]);
  });

  describe('streaming', () => {
    it('neither decodes nor schedules anything while nobody streams', async () => {
      const { log, receive, events } = await setup();
      for (let i = 0; i < 100; i++) receive(tickPrice(i));
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(events).toEqual([]);
      expect(decodeFrameText).not.toHaveBeenCalled();
      // Entries are still there when a view asks.
      expect(log.getEntries()).toHaveLength(100);
      expect(decodeFrameText).toHaveBeenCalledTimes(100);
    });

    it('sends 250 ms batches of new frames while a view streams', async () => {
      const { log, receive, batches } = await setup();
      receive(tickPrice(1)); // before streaming: loaded with getEntries()
      log.setStreaming(true);
      receive(tickPrice(2));
      receive(tickPrice(3));
      await vi.advanceTimersByTimeAsync(249);
      expect(batches()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(batches()).toEqual([[2, 3]]);
      receive(tickPrice(4));
      await vi.advanceTimersByTimeAsync(250);
      expect(batches()).toEqual([[2, 3], [4]]);
    });

    it('counts views: the last one to stop ends the batches', async () => {
      const { log, receive, batches } = await setup();
      log.setStreaming(true);
      log.setStreaming(true);
      log.setStreaming(false);
      receive(tickPrice(1));
      await vi.advanceTimersByTimeAsync(250);
      expect(batches()).toEqual([[1]]);
      receive(tickPrice(2));
      log.setStreaming(false); // a pending batch is dropped
      await vi.advanceTimersByTimeAsync(250);
      log.setStreaming(false); // an extra stop does not go below zero
      log.setStreaming(true);
      receive(tickPrice(3));
      await vi.advanceTimersByTimeAsync(250);
      expect(batches()).toEqual([[1], [3]]);
    });

    it('streams without views when streaming by default', async () => {
      const { log, receive, batches } = await setup({ streamByDefault: true });
      receive(tickPrice(1));
      log.setStreaming(true);
      log.setStreaming(false);
      receive(tickPrice(2));
      await vi.advanceTimersByTimeAsync(250);
      expect(batches()).toEqual([[1, 2]]);
    });

    it('does not resend cleared frames', async () => {
      const { log, receive, batches } = await setup({ streamByDefault: true });
      receive(tickPrice(1));
      log.clear();
      receive(tickPrice(2));
      await vi.advanceTimersByTimeAsync(250);
      expect(batches()).toEqual([[2]]);
    });

    it('does not stream by default', () => {
      expect(STREAM_BY_DEFAULT).toBe(false);
    });

    it('lets a view load what was recorded before its first batch, which may overlap it', async () => {
      const { log, receive, batches } = await setup();
      receive(tickPrice(1));
      log.setStreaming(true);
      receive(tickPrice(2)); // between the start and the load: in both
      expect(log.getEntries().map((e) => e.seq)).toEqual([1, 2]);
      receive(tickPrice(3));
      await vi.advanceTimersByTimeAsync(250);
      expect(batches()).toEqual([[2, 3]]);
    });

    it("sends the current day's log file path with the batches", async () => {
      const { log, receive, events } = await setup();
      const paths = () => events.flatMap((e) => (e.type === 'apiLog' ? [[e.entries.length, e.logFilePath]] : []));
      const day = (d: string) => join(electron.dir, `api-${d}.log`);
      log.setStreaming(true);
      // A view that starts streaming gets the path without waiting for a frame.
      await vi.advanceTimersByTimeAsync(250);
      expect(paths()).toEqual([[0, day('20261004')]]);
      await vi.advanceTimersByTimeAsync(10_000);
      receive(tickPrice(1));
      await vi.advanceTimersByTimeAsync(250);
      expect(paths()).toEqual([
        [0, day('20261004')],
        [1, day('20261004')],
      ]);
      vi.setSystemTime(new Date(2026, 9, 5, 0, 0, 1).getTime());
      receive(tickPrice(2));
      await vi.advanceTimersByTimeAsync(250);
      expect(paths().at(-1)).toEqual([1, day('20261005')]);
      expect(log.filePath()).toBe(day('20261005'));
    });
  });

  describe('viewers', () => {
    class FakeContents extends EventEmitter {
      destroyed = false;
      constructor(readonly id: number) {
        super();
      }
      isDestroyed() {
        return this.destroyed;
      }
    }

    function viewers() {
      const calls: boolean[] = [];
      const v = createLogViewers({ setStreaming: (on) => void calls.push(on) });
      return { v, calls };
    }

    it('counts each renderer once', () => {
      const { v, calls } = viewers();
      const a = new FakeContents(1);
      const b = new FakeContents(2);
      v.set(a, true);
      v.set(a, true);
      v.set(b, true);
      expect(calls).toEqual([true, true]);
      expect(v.count).toBe(2);
      v.set(a, false);
      v.set(a, false);
      expect(calls).toEqual([true, true, false]);
      v.set(b, false);
      expect(calls).toEqual([true, true, false, false]);
      expect(v.count).toBe(0);
      expect(a.listenerCount('did-start-loading') + a.listenerCount('destroyed')).toBe(0);
    });

    it('ends the stream of a renderer that reloads or is destroyed', () => {
      const { v, calls } = viewers();
      const a = new FakeContents(1);
      v.set(a, true);
      a.emit('did-start-loading'); // reload: the page never sent "off"
      expect(calls).toEqual([true, false]);
      expect(a.listenerCount('destroyed')).toBe(0);
      v.set(a, false); // a late "off" of the old page changes nothing
      v.set(a, true); // the reloaded page streams again
      a.destroyed = true;
      a.emit('destroyed');
      expect(calls).toEqual([true, false, true, false]);
      v.set(a, true); // ignored once destroyed
      expect(calls).toEqual([true, false, true, false]);
      expect(v.count).toBe(0);
    });

    it('stops the batches when the only streaming renderer reloads', async () => {
      const { log, receive, batches } = await setup();
      const v = createLogViewers(log);
      const page = new FakeContents(1);
      v.set(page, true);
      receive(tickPrice(1));
      await vi.advanceTimersByTimeAsync(250);
      page.emit('did-start-loading');
      receive(tickPrice(2));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(batches()).toEqual([[1]]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('log file', () => {
    const file = () => join(electron.dir, `api-20261004.log`);
    const lines = () => readFileSync(file(), 'utf8').split('\n').slice(0, -1);
    const expectedLines = (entries: ApiLogEntry[]) => entries.map((e) => formatLogLine(e));

    it('appends every frame in 500 ms batches, formatted like the export', async () => {
      const { log, send, receive } = await setup({ writeFile: true });
      send(HANDSHAKE);
      receive(['176', '20261004 10:00:00 EST']);
      receive(tickPrice(1001));
      log.note('in', 'error', [['code', '502'], ['msg', "Couldn't connect"]], true);
      await vi.advanceTimersByTimeAsync(FLUSH_MS - 1);
      expect(existsSync(file())).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(existsSync(file())).toBe(true));
      await vi.waitFor(() => expect(lines()).toEqual(expectedLines(log.getEntries())));
      // Cleared frames stay in the file; later frames follow.
      log.clear();
      receive(tickPrice(1002));
      await vi.advanceTimersByTimeAsync(FLUSH_MS);
      await vi.waitFor(() => expect(lines()).toHaveLength(5));
      expect(lines()[4]).toBe(formatLogLine(log.getEntries()[0]));
    });

    it('writes the last frames synchronously on quit', async () => {
      const { log, receive } = await setup({ writeFile: true });
      receive(tickPrice(1));
      receive(tickPrice(2));
      for (const quit of electron.quit) quit();
      expect(lines()).toEqual(expectedLines(log.getEntries()));
    });

    it('writes only while enabled', async () => {
      const { log, receive, setSettings } = await setup({ writeFile: true });
      receive(tickPrice(1));
      setSettings({ writeFile: false });
      expect(vi.getTimerCount()).toBe(0); // the pending batch is dropped
      receive(tickPrice(2));
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(FLUSH_MS);
      setSettings({ writeFile: true });
      receive(tickPrice(3));
      for (const quit of electron.quit) quit();
      expect(lines()).toEqual([formatLogLine(log.getEntries()[2])]);
    });

    it('formats file lines without decoding entries while nobody streams', async () => {
      const { log, receive, fire } = await setup({ writeFile: true });
      receive(tickPrice(1));
      receive(['999', 'unknown', 'message']);
      receive(OPEN_ORDER);
      fire('openOrder', 4012, {}, {}, { status: 'PreSubmitted' });
      await vi.advanceTimersByTimeAsync(FLUSH_MS);
      await vi.waitFor(() => expect(lines()).toHaveLength(3));
      expect(decodeFrameText).toHaveBeenCalledTimes(1); // only the annotated openOrder
      expect(lines()[2]).toMatch(/ status=PreSubmitted$/);
      expect(lines()).toEqual(expectedLines(log.getEntries()));
    });

    it.each([false, true])('writes the frame that fills a batch complete (streaming %s)', async (streamByDefault) => {
      const { log, receive, fire } = await setup({ writeFile: true, streamByDefault });
      // The batch is taken at RING_SIZE / 2 pending lines, after the current task.
      for (let i = 1; i < RING_SIZE / 2; i++) receive(tickPrice(i));
      log.note('out', 'socket close', [['reason', 'user disconnect']]);
      await vi.waitFor(() => expect(lines()).toHaveLength(RING_SIZE / 2));
      for (let i = 1; i < RING_SIZE / 2; i++) receive(tickPrice(i));
      receive(OPEN_ORDER);
      fire('openOrder', 4012, {}, {}, { status: 'PreSubmitted' });
      await vi.waitFor(() => expect(lines()).toHaveLength(RING_SIZE));
      const entries = log.getEntries();
      expect(lines()[RING_SIZE / 2 - 1]).toMatch(/SEND {2}socket close {7}- {6}reason=user disconnect$/);
      expect(lines()[RING_SIZE - 1]).toMatch(/ status=PreSubmitted$/);
      expect(lines()).toEqual(expectedLines(entries));
    });

    it('decodes once for both the live batch and the file while streaming', async () => {
      const { log, receive } = await setup({ writeFile: true, streamByDefault: true });
      receive(tickPrice(1));
      receive(tickPrice(2));
      await vi.advanceTimersByTimeAsync(FLUSH_MS);
      await vi.waitFor(() => expect(lines()).toHaveLength(2));
      log.getEntries();
      expect(decodeFrameText).toHaveBeenCalledTimes(2);
    });
  });
});
