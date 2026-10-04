import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import type { IBApi } from './tws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TapeEvent } from '@shared/ipc';
import type { NavPoint } from '@shared/types';
import type { IbConnection, IbListener, MainContext } from '../context';
import { createSqliteClient } from '../db/client';
import { createMemoryDatabase } from '../db/memory';
import { serve } from '../db/server';
import type { Database } from '../db/types';
import { createAccountService } from './account';
import { createNavRecorder, NAV_SAMPLE_MS } from './navHistory';

const DAY = 86_400_000;
/** 2026-10-05 11:00 New York. */
const NOW = Date.UTC(2026, 9, 5, 15, 0);

/** A memory database that reports itself as persistent, with spies on the NAV log. */
function sqliteLike(kind: Database['kind'] = 'sqlite') {
  const db = { ...createMemoryDatabase(), kind } as Database;
  return { db, append: vi.spyOn(db.nav, 'append'), replace: vi.spyOn(db.nav, 'replace') };
}

function legacyStore(points: NavPoint[]) {
  let file = points;
  return { get: () => file, clear: vi.fn(() => void (file = [])), file: () => file };
}

describe('NAV recorder', () => {
  it('imports nav.json once, retires it, and compacts old days', async () => {
    const { db, replace } = sqliteLike();
    // 12 days ago: three samples on one New York day; today: one sample.
    const old = [NOW - 12 * DAY, NOW - 12 * DAY + 3_600_000, NOW - 12 * DAY + 7_200_000].map((t, i) => ({ t, netLiq: 100 + i }));
    const legacy = legacyStore([...old, { t: NOW - 60_000, netLiq: 200 }]);
    const nav = createNavRecorder(db, legacy, () => NOW);
    const loaded = await nav.load();
    expect(loaded).toEqual([{ t: old[2].t, netLiq: 102 }, { t: NOW - 60_000, netLiq: 200 }]);
    expect(legacy.clear).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(await db.nav.all()).toEqual(loaded);
    expect(await nav.load()).toBe(loaded);
  });

  it('keeps nav.json while the database is only in memory', async () => {
    const { db } = sqliteLike('memory');
    const legacy = legacyStore([{ t: NOW - DAY, netLiq: 1 }]);
    await createNavRecorder(db, legacy, () => NOW).load();
    expect(legacy.clear).not.toHaveBeenCalled();
  });

  it('keeps nav.json when the import did not land', async () => {
    const { db } = sqliteLike();
    db.nav.append = async () => undefined; // a write that failed (writes never reject)
    const legacy = legacyStore([{ t: NOW - DAY, netLiq: 1 }]);
    await createNavRecorder(db, legacy, () => NOW).load();
    expect(legacy.clear).not.toHaveBeenCalled();
  });

  it('appends samples; replaces the log once a day, when a day leaves the intraday window', async () => {
    const { db, append, replace } = sqliteLike();
    const nav = createNavRecorder(db, legacyStore([]), () => NOW);
    // Two samples 10 days ago (2026-09-25, New York), then today.
    const day10 = NOW - 10 * DAY;
    await nav.add({ t: day10, netLiq: 1 });
    await nav.add({ t: day10 + 60_000, netLiq: 2 });
    // Later the same day: 2026-09-25 is still inside the window, even past the same time of day.
    await nav.add({ t: NOW + 2 * 3_600_000, netLiq: 3 });
    expect(append).toHaveBeenCalledTimes(3);
    expect(replace).not.toHaveBeenCalled();
    // After New York midnight it leaves the window: reduced to its last sample.
    const midnight = Date.UTC(2026, 9, 6, 4);
    let points = await nav.add({ t: midnight + 5 * 60_000, netLiq: 4 });
    expect(points.map((p) => p.netLiq)).toEqual([2, 3, 4]);
    expect(replace).toHaveBeenCalledTimes(1);
    points = await nav.add({ t: midnight + 10 * 60_000, netLiq: 5 });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(4);
    expect(await db.nav.all()).toEqual(points);
  });

  it("resolves a sample after the replies to reads sent before it (snapshot vs 'nav' event)", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tape-nav-'));
    const { port1, port2 } = new MessageChannel();
    serve(port2, { file: join(dir, 'tape.db'), log: () => undefined });
    const db = createSqliteClient({
      post: (req, transfer) => (transfer ? port1.postMessage(req, transfer) : port1.postMessage(req)),
      listen: (onMessage) => void port1.on('message', onMessage),
      terminate: async () => port1.close(),
    });
    try {
      const nav = createNavRecorder(db, legacyStore([]), () => NOW);
      await nav.add({ t: NOW - 600_000, netLiq: 100 });
      const order: string[] = [];
      // getSnapshot reads the log; a sample lands meanwhile and its 'nav' event is emitted.
      const snapshot = db.nav.all().then((p) => order.push(`snapshot ${p.length}`));
      const sample = nav.add({ t: NOW, netLiq: 101 }).then((p) => order.push(`nav event ${p.length}`));
      await Promise.all([snapshot, sample]);
      // The renderer drops snapshot-type events that arrive before the snapshot reply.
      expect(order).toEqual(['snapshot 1', 'nav event 2']);
    } finally {
      await db.close();
      port2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('works without a database (partial test contexts)', async () => {
    const nav = createNavRecorder(undefined, legacyStore([{ t: 1, netLiq: 1 }]), () => NOW);
    expect(await nav.load()).toEqual([]);
    expect(await nav.add({ t: NOW, netLiq: 5 })).toEqual([{ t: NOW, netLiq: 5 }]);
  });
});

describe('account service NAV sampling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  function setup(db: Database, legacy: NavPoint[]) {
    const listeners = new Map<string, Set<IbListener>>();
    const ready = new Set<(api: IBApi) => void>();
    const api = new Proxy({}, { get: () => () => undefined }) as unknown as IBApi;
    let reqId = 1;
    const ib = {
      api,
      getState: () => ({ status: 'connected', host: 'h', port: 1, clientId: 141, accounts: ['DU1'], account: 'DU1', isPaper: true, farms: {} }),
      isConnected: () => true,
      nextReqId: () => reqId++,
      on(event: string, l: IbListener) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(l);
        return () => undefined;
      },
      onReady: (l: (api: IBApi) => void) => (ready.add(l), () => undefined),
      onClosed: () => () => undefined,
    } as unknown as IbConnection;
    const events: TapeEvent[] = [];
    let file = legacy;
    const ctx = {
      emit: (e: TapeEvent) => events.push(e),
      store: { getNav: () => file, setNav: (p: NavPoint[]) => void (file = p) },
      contracts: { getInfo: async () => null },
      ib,
      db,
    } as unknown as MainContext;
    createAccountService(ctx);
    return {
      events,
      file: () => file,
      ready: () => ready.forEach((l) => l(api)),
      netLiq: (value: number) => listeners.get('accountSummary')?.forEach((l) => l(1, 'DU1', 'NetLiquidation', String(value), 'USD')),
    };
  }

  const navEvents = (events: TapeEvent[]) => events.flatMap((e) => (e.type === 'nav' ? [e.points.map((p) => p.netLiq)] : []));

  it('loads the history on start, samples on the first NetLiquidation and every 5 minutes', async () => {
    const { db, append } = sqliteLike();
    const t = setup(db, [{ t: NOW - DAY, netLiq: 90 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(navEvents(t.events)).toEqual([[90]]);
    expect(t.file()).toEqual([]); // nav.json retired

    t.ready();
    t.netLiq(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(navEvents(t.events).at(-1)).toEqual([90, 100]);
    t.netLiq(101); // later updates wait for the timer
    await vi.advanceTimersByTimeAsync(NAV_SAMPLE_MS);
    expect(navEvents(t.events).at(-1)).toEqual([90, 100, 101]);
    expect((await db.nav.all()).map((p) => p.netLiq)).toEqual([90, 100, 101]);
    expect(append).toHaveBeenCalledTimes(3); // import + two samples
  });

  it('12 days of 5-minute samples: every sample appends, the log is replaced at most once a day', async () => {
    const { db, append, replace } = sqliteLike();
    const t = setup(db, []);
    await vi.advanceTimersByTimeAsync(0);
    t.ready();
    t.netLiq(100);
    const replacesPerDay: number[] = [];
    for (let d = 0; d < 12; d++) {
      const before = replace.mock.calls.length;
      await vi.advanceTimersByTimeAsync(DAY); // 11:00 to 11:00 New York: one midnight
      replacesPerDay.push(replace.mock.calls.length - before);
      t.events.length = 0;
    }
    // 2026-10-05 leaves the 10-day window at midnight on 10-16, 10-06 on 10-17.
    expect(replacesPerDay).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    const samples = 1 + 12 * (DAY / NAV_SAMPLE_MS);
    expect(append).toHaveBeenCalledTimes(samples - 2);
    // 10-05 (from 11:00) and 10-06 are reduced to their last sample.
    expect((await db.nav.all()).length).toBe(samples - (13 * 12 - 1) - (24 * 12 - 1));
  });
});
