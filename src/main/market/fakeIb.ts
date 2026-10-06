// Test double for the IB connection and the main context (used by the *.test.ts files only).

import { OUT_MSG_ID, type IBApi, type ScannerSubscription, type TagValue } from '../ib/tws';
import type { TapeEvent } from '@shared/ipc';
import { defaultSettings } from '@shared/defaults';
import type { DeepPartial, PriceAlert, Settings } from '@shared/types';
import type { IbConnection, IbListener, MainContext } from '../context';
import { createMemoryDatabase } from '../db/memory';
import { applySettingsPatch } from '../storeSchema';

export interface FakeIb {
  ib: IbConnection;
  /** Every IBApi method call as [name, ...args]. */
  calls: Array<[string, ...unknown[]]>;
  callsOf(name: string): unknown[][];
  /** Emits an IBApi event to the listeners registered through ib.on(). */
  emit(event: string, ...args: unknown[]): void;
  /** Simulates a completed handshake. */
  ready(): void;
  close(): void;
  error(reqId: number, code: number, message: string): void;
  /** Called synchronously for every IBApi call; lets tests answer requests. */
  onCall?: (name: string, args: unknown[]) => void;
  /**
   * Requests whose 'sent' event the fake emits right after the call, as the client does when it
   * writes a frame at once (default on). Off: a test emits it with written() (frames held by pacing).
   */
  autoSent: boolean;
  /** Emits the client's 'sent' event for a request written to the wire. */
  written(name: string, reqId: number): void;
}

/** Outgoing message ids of the calls whose 'sent' event services wait for. */
const SENT_IDS: Record<string, number> = {
  reqHistoricalData: OUT_MSG_ID.REQ_HISTORICAL_DATA,
  reqScannerSubscription: OUT_MSG_ID.REQ_SCANNER_SUBSCRIPTION,
};

export function createFakeIb(): FakeIb {
  const events = new Map<string, Set<IbListener>>();
  const readyListeners = new Set<(api: IBApi) => void>();
  const closedListeners = new Set<() => void>();
  const errorListeners = new Set<(e: { reqId: number; code: number; message: string }) => void>();
  let connected = false;
  let reqId = 1000;
  const fake: FakeIb = {
    calls: [],
    callsOf: (name) => fake.calls.filter((c) => c[0] === name).map((c) => c.slice(1)),
    emit(event, ...args) {
      for (const l of [...(events.get(event) ?? [])]) l(...args);
    },
    ready() {
      connected = true;
      for (const l of [...readyListeners]) l(api);
    },
    close() {
      connected = false;
      for (const l of [...closedListeners]) l();
    },
    error(id, code, message) {
      for (const l of [...errorListeners]) l({ reqId: id, code, message });
    },
    autoSent: true,
    written(name, id) {
      const msgId = SENT_IDS[name];
      if (msgId !== undefined) fake.emit('sent', [msgId, id], `${msgId}\0${id}`);
    },
    ib: undefined as unknown as IbConnection,
  };
  const api = new Proxy({} as IBApi, {
    get: (_t, name) => {
      if (name === 'then') return undefined;
      return (...args: unknown[]) => {
        fake.calls.push([String(name), ...args]);
        if (fake.autoSent) fake.written(String(name), args[0] as number);
        fake.onCall?.(String(name), args);
        return api;
      };
    },
  });
  const add = <T>(set: Set<T>, l: T) => {
    set.add(l);
    return () => void set.delete(l);
  };
  fake.ib = {
    get api() {
      return connected ? api : null;
    },
    getState: () => ({ status: connected ? 'connected' : 'disconnected', host: '127.0.0.1', port: 4002, clientId: 111, accounts: [], isPaper: true, farms: {} }),
    connect: async () => fake.ready(),
    disconnect: async () => fake.close(),
    isConnected: () => connected,
    nextReqId: () => ++reqId,
    nextOrderId: () => 1,
    on(event, listener) {
      let set = events.get(event);
      if (!set) events.set(event, (set = new Set()));
      return add(set, listener);
    },
    onReady: (l) => add(readyListeners, l),
    onClosed: (l) => add(closedListeners, l),
    onRequestError: (l) => add(errorListeners, l),
  };
  return fake;
}

/** A stock the fake market scanner lists: its next earnings (epoch seconds) and its price. */
export interface ScannerListing {
  conId: number;
  symbol: string;
  at: number;
  price: number;
}

export interface FakeScanner {
  /** Request ids of the scans not cancelled yet. */
  open: Set<number>;
  /** Most scans open at the same time. */
  most: number;
  requests: Array<{ reqId: number; sub: ScannerSubscription; filter: TagValue[] }>;
  cancelled: number[];
  /**
   * Answers one scan with the matching listings (at most 50) and their count. Default: IB's 165
   * "N items retrieved" after 1 ms, the rows and the end 1 ms later. Tests replace it.
   */
  answer: (reqId: number, rows: ScannerListing[], total: number) => void;
  /** Handles one IBApi call (installed as fake.onCall; tests that replace onCall call it themselves). */
  handle(name: string, args: unknown[]): void;
}

/**
 * IB's SCAN_nextEarningsDateTime_ASC over `listings`: the stocks within the request's price band
 * and its nextEarningsDateTimeAbove / Below window (epoch seconds, inclusive), soonest first (ties
 * by conId), at most 50. `listings` may be changed between scans. A closed connection ends the
 * open scans.
 */
export function fakeScanner(fake: FakeIb, listings: ScannerListing[]): FakeScanner {
  const sc: FakeScanner = {
    open: new Set(),
    most: 0,
    requests: [],
    cancelled: [],
    answer(reqId, rows, total) {
      const text = total > 50 ? `50 out of ${total}` : total ? String(total) : 'no';
      setTimeout(() => {
        fake.error(reqId, 165, `Historical Market Data Service query message:${text} items retrieved`);
        setTimeout(() => {
          rows.forEach((l, rank) => {
            const contract = { conId: l.conId, symbol: l.symbol, secType: 'STK', exchange: 'SMART', currency: 'USD', localSymbol: l.symbol };
            fake.emit('scannerData', reqId, rank, { contract, marketName: 'NMS' }, '', '', '', '');
          });
          fake.emit('scannerDataEnd', reqId);
        }, 1);
      }, 1);
    },
    handle(name, args) {
      const reqId = args[0] as number;
      if (name === 'cancelScannerSubscription') {
        sc.open.delete(reqId);
        sc.cancelled.push(reqId);
      }
      if (name !== 'reqScannerSubscription') return;
      const sub = args[1] as ScannerSubscription;
      const filter = (args[3] as TagValue[] | undefined) ?? [];
      sc.requests.push({ reqId, sub, filter });
      sc.open.add(reqId);
      sc.most = Math.max(sc.most, sc.open.size);
      const bound = (tag: string) => Number(filter.find((t) => t.tag === tag)?.value);
      const above = bound('nextEarningsDateTimeAbove');
      const below = bound('nextEarningsDateTimeBelow');
      const hits = listings
        .filter((l) => l.at >= above && l.at <= below && l.price >= (sub.abovePrice ?? 0) && l.price <= (sub.belowPrice ?? Infinity))
        .sort((a, b) => a.at - b.at || a.conId - b.conId);
      sc.answer(reqId, hits.slice(0, 50), hits.length);
    },
  };
  const prev = fake.onCall;
  fake.onCall = (name, args) => {
    prev?.(name, args);
    sc.handle(name, args);
  };
  // IB drops a connection's scans with it.
  fake.ib.onClosed(() => sc.open.clear());
  return sc;
}

export interface FakeContext {
  ctx: MainContext;
  events: TapeEvent[];
  notifications: Array<Parameters<MainContext['notifier']['notify']>[0]>;
  stored: { alerts: PriceAlert[]; settings: Settings };
}

/** A MainContext with an in-memory store and database, a recording notifier and the given IB double. */
export function createFakeContext(ib: IbConnection, demo = false): FakeContext {
  const events: TapeEvent[] = [];
  const notifications: FakeContext['notifications'] = [];
  const stored = { alerts: [] as PriceAlert[], settings: defaultSettings() };
  const ctx = {
    demo,
    isDev: false,
    emit: (e: TapeEvent) => void events.push(e),
    getMainWindow: () => null,
    showMainWindow: () => undefined,
    ib,
    db: createMemoryDatabase(),
    store: {
      getPriceAlerts: () => stored.alerts,
      setPriceAlerts: (a: PriceAlert[]) => void (stored.alerts = a),
      getSettings: () => stored.settings,
      updateSettings: (patch: DeepPartial<Settings>) => (stored.settings = applySettingsPatch(stored.settings, patch)),
    },
    notifier: {
      notify: (n: Parameters<MainContext['notifier']['notify']>[0]) => {
        notifications.push(n);
        return { ...n, id: String(notifications.length), t: Date.now(), read: false };
      },
      markRead: () => undefined,
      test: () => undefined,
    },
  } as unknown as MainContext;
  return { ctx, events, notifications, stored };
}

/** Waits for services' deferred startup (setImmediate) and pending promise callbacks. */
export const settle = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
