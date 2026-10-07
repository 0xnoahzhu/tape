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
import { LIVE, LIVE_ROWS, PAPER, PAPER_ROWS, USER_ROWS } from '../db/navCases';
import { serve } from '../db/server';
import type { Database } from '../db/types';
import { createAccountService } from './account';
import { createNavRecorder, NAV_SAMPLE_MS, readNavHistory } from './navHistory';

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
  it('imports nav.json once as rows without an account and retires it; the first sample within a factor of 2 claims them, old days compacted', async () => {
    const { db, replace } = sqliteLike();
    // 12 days ago: three samples on one New York day; today: one sample.
    const old = [NOW - 12 * DAY, NOW - 12 * DAY + 3_600_000, NOW - 12 * DAY + 7_200_000].map((t, i) => ({ t, netLiq: 100 + i }));
    const legacy = legacyStore([...old, { t: NOW - 60_000, netLiq: 120 }]);
    const nav = createNavRecorder(db, legacy, () => NOW);
    // Before an account sampled: no history to show, the rows are kept without an account.
    expect(await nav.history('DU1')).toEqual({ account: 'DU1', points: [] });
    expect(await nav.history()).toEqual({ account: '', points: [] });
    expect(legacy.clear).toHaveBeenCalledTimes(1);
    expect(await db.nav.all()).toHaveLength(4);
    expect(replace).not.toHaveBeenCalled();

    const points = await nav.add('DU1', { t: NOW, netLiq: 110 });
    expect(points).toEqual([{ t: old[2].t, netLiq: 102 }, { t: NOW - 60_000, netLiq: 120 }, { t: NOW, netLiq: 110 }]);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(await db.nav.get('DU1')).toEqual(points);
    expect(await nav.history('DU1')).toEqual({ account: 'DU1', points });
    // Before the first connect of a run: the account of the newest sample.
    expect(await createNavRecorder(db, legacyStore([]), () => NOW).history()).toEqual({ account: 'DU1', points });
  });

  it('keeps nav.json while the database is only in memory', async () => {
    const { db } = sqliteLike('memory');
    const legacy = legacyStore([{ t: NOW - DAY, netLiq: 1 }]);
    await createNavRecorder(db, legacy, () => NOW).history();
    expect(legacy.clear).not.toHaveBeenCalled();
  });

  it('keeps nav.json when the import did not land', async () => {
    const { db } = sqliteLike();
    db.nav.append = async () => undefined; // a write that failed (writes never reject)
    const legacy = legacyStore([{ t: NOW - DAY, netLiq: 1 }]);
    await createNavRecorder(db, legacy, () => NOW).history();
    expect(legacy.clear).not.toHaveBeenCalled();
  });

  it('retires nav.json when its points are already in the database under an account', async () => {
    const { db } = sqliteLike();
    const points = [{ t: NOW - DAY, netLiq: 100 }];
    await db.nav.append('DU1', points);
    const legacy = legacyStore([{ t: NOW - DAY, netLiq: 100 }]);
    expect(await createNavRecorder(db, legacy, () => NOW).history('DU1')).toEqual({ account: 'DU1', points });
    expect(legacy.clear).toHaveBeenCalledTimes(1);
    expect(await db.nav.all()).toEqual(points);
  });

  it("appends samples; replaces the account's rows once a day, when a day leaves the intraday window, leaving other rows alone", async () => {
    const { db, append, replace } = sqliteLike();
    // Another account's samples and a row without an account, on one old day each.
    const others = [
      { t: NOW - 20 * DAY, netLiq: 50 },
      { t: NOW - 20 * DAY + 60_000, netLiq: 51 },
    ];
    await db.nav.append('U2', others);
    await db.nav.append(null, [{ t: NOW - 19 * DAY, netLiq: 1_000 }]);
    append.mockClear();
    const nav = createNavRecorder(db, legacyStore([]), () => NOW);
    // Two samples 10 days ago (2026-09-25, New York), then today.
    const day10 = NOW - 10 * DAY;
    await nav.add('DU1', { t: day10, netLiq: 1 });
    await nav.add('DU1', { t: day10 + 60_000, netLiq: 2 });
    // Later the same day: 2026-09-25 is still inside the window, even past the same time of day.
    await nav.add('DU1', { t: NOW + 2 * 3_600_000, netLiq: 3 });
    expect(append).toHaveBeenCalledTimes(3);
    expect(replace).not.toHaveBeenCalled();
    // After New York midnight it leaves the window: reduced to its last sample.
    const midnight = Date.UTC(2026, 9, 6, 4);
    let points = await nav.add('DU1', { t: midnight + 5 * 60_000, netLiq: 4 });
    expect(points.map((p) => p.netLiq)).toEqual([2, 3, 4]);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toBe('DU1');
    points = await nav.add('DU1', { t: midnight + 10 * 60_000, netLiq: 5 });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(4);
    expect(await db.nav.get('DU1')).toEqual(points);
    expect(await db.nav.get('U2')).toEqual(others);
    expect((await db.nav.all()).filter((p) => p.netLiq === 1_000)).toHaveLength(1);
  });

  it("adds samples one at a time: an account's first sample has its claim read back before the next one", async () => {
    const { db, append } = sqliteLike();
    const nav = createNavRecorder(db, legacyStore([{ t: NOW - DAY, netLiq: 100 }]), () => NOW);
    const [first, second] = await Promise.all([nav.add('DU1', { t: NOW - 60_000, netLiq: 101 }), nav.add('DU1', { t: NOW, netLiq: 102 })]);
    expect(first.map((p) => p.netLiq)).toEqual([100, 101]);
    expect(second.map((p) => p.netLiq)).toEqual([100, 101, 102]);
    expect(append).toHaveBeenCalledTimes(3); // the import and two samples
  });

  it("keeps no list when an account's first sample cannot read its claim back: the next sample reads it, nothing claimed is lost", async () => {
    const { db, replace } = sqliteLike();
    const netLiqs = (points: NavPoint[]) => points.map((p) => p.netLiq);
    // Two legacy samples on one old day (compacted when read) and one recent one.
    const day12 = NOW - 12 * DAY;
    await db.nav.append(null, [
      { t: day12, netLiq: 100 },
      { t: day12 + 60_000, netLiq: 101 },
      { t: NOW - DAY, netLiq: 102 },
    ]);
    const get = db.nav.get.bind(db.nav);
    let reads = 0;
    db.nav.get = (account) => (++reads === 2 ? Promise.reject(new Error('read failed')) : get(account)); // the read-back
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const nav = createNavRecorder(db, legacyStore([]), () => NOW);
      expect(netLiqs(await nav.add('DU1', { t: NOW - 60_000, netLiq: 103 }))).toEqual([103]);
      const points = await nav.add('DU1', { t: NOW, netLiq: 104 });
      expect(netLiqs(points)).toEqual([101, 102, 103, 104]);
      expect(await db.nav.get('DU1')).toEqual(points);
      for (const [, list] of replace.mock.calls) expect(netLiqs(list)).toEqual([101, 102, 103]);
    } finally {
      error.mockRestore();
    }
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
      await nav.add('DU1', { t: NOW - 600_000, netLiq: 100 });
      const order: string[] = [];
      // getSnapshot reads the history; a sample lands meanwhile and its 'nav' event is emitted.
      const snapshot = readNavHistory(db, 'DU1').then((h) => order.push(`snapshot ${h.points.length}`));
      const sample = nav.add('DU1', { t: NOW, netLiq: 101 }).then((p) => order.push(`nav event ${p.length}`));
      await Promise.all([snapshot, sample]);
      // The renderer drops snapshot-type events that arrive before the snapshot reply.
      expect(order).toEqual(['snapshot 1', 'nav event 2']);
      // Before the first connect the snapshot shows the account of the newest sample.
      expect(await readNavHistory(db)).toEqual({ account: 'DU1', points: await db.nav.get('DU1') });
    } finally {
      await db.close();
      port2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('works without a database (partial test contexts)', async () => {
    const nav = createNavRecorder(undefined, legacyStore([{ t: 1, netLiq: 1 }]), () => NOW);
    expect(await nav.history()).toEqual({ account: '', points: [] });
    expect(await nav.add('DU1', { t: NOW, netLiq: 5 })).toEqual([{ t: NOW, netLiq: 5 }]);
    expect(await nav.history()).toEqual({ account: 'DU1', points: [{ t: NOW, netLiq: 5 }] });
    expect(await nav.history('U2')).toEqual({ account: 'U2', points: [] });
  });
});

describe('account service NAV sampling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  /** `initialAccount` null: managedAccounts has not named one yet (how the app starts). */
  function setup(db: Database, legacy: readonly NavPoint[], initialAccount: string | null = 'DU1') {
    const listeners = new Map<string, Set<IbListener>>();
    const ready = new Set<(api: IBApi) => void>();
    let account = initialAccount ?? undefined;
    let summaryReqId = -1;
    const api = new Proxy(
      {},
      {
        get: (_, name) =>
          (...args: unknown[]) => {
            if (name === 'reqAccountSummary') summaryReqId = args[0] as number;
          },
      },
    ) as unknown as IBApi;
    let reqId = 1;
    const ib = {
      api,
      getState: () => ({ status: 'connected', host: 'h', port: 1, clientId: 141, accounts: [PAPER, LIVE, 'DU1', 'U2'], account, isPaper: true, farms: {} }),
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
    let file = [...legacy];
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
      /** managedAccounts named another account (a connection to another login). */
      setAccount: (a: string | undefined) => void (account = a),
      /** managedAccounts arrives (the connection's state names `a` before the event is forwarded). */
      managedAccounts: (a: string) => {
        account = a;
        listeners.get('managedAccounts')?.forEach((l) => l(a));
      },
      ready: () => ready.forEach((l) => l(api)),
      /** An accountSummary NetLiquidation row of `of` (default: the active account). */
      netLiq: (value: number, of = account ?? '') => listeners.get('accountSummary')?.forEach((l) => l(summaryReqId, of, 'NetLiquidation', String(value), 'USD')),
    };
  }

  /** The 'nav' events as [account, values]. */
  const navEvents = (events: TapeEvent[]) => events.flatMap((e) => (e.type === 'nav' ? [[e.account, e.points.map((p) => p.netLiq)] as const] : []));
  const values = (points: NavPoint[]) => points.map((p) => p.netLiq);

  it('samples the first NetLiquidation and every 5 minutes; the first sample claims the imported nav.json', async () => {
    const { db, append } = sqliteLike();
    const t = setup(db, [{ t: NOW - DAY, netLiq: 90 }], null);
    await vi.advanceTimersByTimeAsync(0);
    // nav.json is imported without an account: nothing to show before an account samples.
    expect(navEvents(t.events)).toEqual([]);
    expect(t.file()).toEqual([]); // nav.json retired

    t.setAccount('DU1');
    t.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(navEvents(t.events)).toEqual([['DU1', []]]);
    t.netLiq(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(navEvents(t.events).at(-1)).toEqual(['DU1', [90, 100]]);
    t.netLiq(101); // later updates wait for the timer
    await vi.advanceTimersByTimeAsync(NAV_SAMPLE_MS);
    expect(navEvents(t.events).at(-1)).toEqual(['DU1', [90, 100, 101]]);
    expect(values(await db.nav.get('DU1'))).toEqual([90, 100, 101]);
    expect(append).toHaveBeenCalledTimes(3); // import + two samples

    // The next start shows the account of the newest sample before connecting.
    const next = setup(db, [], null);
    await vi.advanceTimersByTimeAsync(0);
    expect(navEvents(next.events)).toEqual([['DU1', [90, 100, 101]]]);
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
    expect((await db.nav.get('DU1')).length).toBe(samples - (13 * 12 - 1) - (24 * 12 - 1));
  });

  it('records nothing while the account is unknown (every managed account passes then), and under the account once it is known', async () => {
    const { db } = sqliteLike();
    const t = setup(db, [], null);
    await vi.advanceTimersByTimeAsync(0);
    t.ready(); // connected without managedAccounts
    t.netLiq(100, 'DU1');
    t.netLiq(31_000, 'U2');
    await vi.advanceTimersByTimeAsync(NAV_SAMPLE_MS);
    expect(await db.nav.all()).toEqual([]);
    expect(navEvents(t.events)).toEqual([]);

    t.managedAccounts('DU1'); // more than 2 s late: after the handshake, no new ready
    t.netLiq(31_000, 'U2'); // another account's row
    t.netLiq(100, 'DU1');
    await vi.advanceTimersByTimeAsync(0);
    expect(values(await db.nav.get('DU1'))).toEqual([100]);
    expect(await db.nav.get('U2')).toEqual([]);
    expect(navEvents(t.events)).toEqual([
      ['DU1', []],
      ['DU1', [100]],
    ]);
  });

  it('an account named only after the handshake gets its stored history then, without waiting for a sample', async () => {
    const { db } = sqliteLike();
    await db.nav.append('DU1', [{ t: NOW - 2 * DAY, netLiq: 100 }]);
    await db.nav.append('U2', [{ t: NOW - DAY, netLiq: 31_000 }]);
    const t = setup(db, [], null);
    await vi.advanceTimersByTimeAsync(0);
    expect(navEvents(t.events)).toEqual([['U2', [31_000]]]); // before connecting: the newest sample's account
    t.ready(); // connected without managedAccounts
    await vi.advanceTimersByTimeAsync(0);
    t.managedAccounts('DU1');
    await vi.advanceTimersByTimeAsync(0);
    expect(navEvents(t.events)).toEqual([
      ['U2', [31_000]],
      ['DU1', [100]],
    ]);
    // The same account named again sends nothing more.
    t.managedAccounts('DU1');
    await vi.advanceTimersByTimeAsync(0);
    expect(navEvents(t.events)).toHaveLength(2);
  });

  it("the user's case: paper and live samples imported mixed are split by each account's first sample; a switch sends the other account's history", async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 7, 14));
    const { db } = sqliteLike();
    await db.nav.append(null, [...USER_ROWS]); // the table as the previous version left it
    const t = setup(db, [], null);
    await vi.advanceTimersByTimeAsync(0);
    expect(navEvents(t.events)).toEqual([]);

    t.setAccount(PAPER);
    t.ready();
    t.netLiq(1_051_800);
    await vi.advanceTimersByTimeAsync(0);
    expect(navEvents(t.events)).toEqual([
      [PAPER, []],
      [PAPER, [...values([...PAPER_ROWS]), 1_051_800]],
    ]);

    // Connected to the live account: its history, without the paper rows nor its own unclaimed ones.
    await vi.advanceTimersByTimeAsync(60_000);
    t.events.length = 0;
    t.setAccount(LIVE);
    t.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(navEvents(t.events)).toEqual([[LIVE, []]]);
    t.netLiq(31_040);
    await vi.advanceTimersByTimeAsync(0);
    expect(navEvents(t.events).at(-1)).toEqual([LIVE, [...values([...LIVE_ROWS]), 31_040]]);
    expect(values(await db.nav.get(PAPER))).toEqual([...values([...PAPER_ROWS]), 1_051_800]);
    expect((await db.nav.all()).length).toBe(USER_ROWS.length + 2); // every row has an account now
    expect(await readNavHistory(db)).toEqual({ account: LIVE, points: await db.nav.get(LIVE) });
  });

  it('a sample still being written when the account changes sends no event', async () => {
    const { db } = sqliteLike();
    const t = setup(db, []);
    await vi.advanceTimersByTimeAsync(0);
    t.ready();
    await vi.advanceTimersByTimeAsync(0);
    t.events.length = 0;
    t.netLiq(100);
    t.setAccount('U2');
    await vi.advanceTimersByTimeAsync(0);
    expect(navEvents(t.events)).toEqual([]);
    expect(values(await db.nav.get('DU1'))).toEqual([100]);
  });
});
