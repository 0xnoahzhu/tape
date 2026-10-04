// Connects the store to the main process: loads the snapshot and applies push events.

import type { TapeEvent } from '@shared/ipc';
import type { ApiLogEntry, Quote } from '@shared/types';
import { applyLockState } from './lockActions';
import { initialTicket, isCovered, useStore } from './store';

const MAX_LOG = 5000;

/** Events whose payload replaces state the snapshot contains. */
const SNAPSHOT_EVENTS: ReadonlySet<TapeEvent['type']> = new Set([
  'settings',
  'connection',
  'account',
  'positions',
  'orders',
  'executions',
  'watchlists',
  'priceAlerts',
  'notifications',
  'nav',
  'lock',
]);

let started = false;

export async function startBridge(): Promise<void> {
  if (started) return;
  started = true;
  const tape = window.tape;

  // Subscribe before loading so no event is lost; events received meanwhile are replayed
  // afterwards. IPC keeps message order, so events that arrived before the snapshot reply are
  // older than it and their state is already in the snapshot. The API log is loaded by the views
  // that show it (useApiLogStream).
  const early: TapeEvent[] = [];
  let loaded = false;
  tape.onEvent((e) => (loaded ? apply(e) : early.push(e)));

  const snap = await tape.getSnapshot();
  const beforeSnapshot = early.length;
  useStore.setState((s) => ({
    ready: true,
    demo: snap.demo,
    platform: snap.platform,
    appVersion: snap.appVersion,
    logFilePath: snap.logFilePath,
    settings: snap.settings,
    connection: snap.connection,
    account: snap.account,
    positions: snap.positions,
    orders: snap.orders,
    executions: snap.executions,
    watchlists: snap.watchlists,
    priceAlerts: snap.priceAlerts,
    notifications: snap.notifications,
    nav: snap.nav,
    lock: snap.lock,
    biometricsSeen: s.biometricsSeen || snap.lock.biometrics.available,
    ticket: { ...initialTicket(snap.settings), side: s.ticket.side },
    // After a Forgot-PIN reset Tape opens on Settings › Connection, as on a fresh install.
    ...(snap.afterReset ? { page: 'set' as const, settingsTab: 'conn' as const } : {}),
  }));
  loaded = true;
  early.forEach((e, i) => {
    if (i < beforeSnapshot && SNAPSHOT_EVENTS.has(e.type)) return;
    apply(e);
  });
}

function mergeQuotes(prev: Record<string, Quote>, patch: Record<string, Quote>): Record<string, Quote> {
  const next = { ...prev };
  for (const [k, q] of Object.entries(patch)) next[k] = prev[k] ? { ...prev[k], ...q } : q;
  return next;
}

const lastSeq = (log: ApiLogEntry[]) => (log.length ? log[log.length - 1].seq : 0);
const capped = (log: ApiLogEntry[], max: number) => (log.length > max ? log.slice(log.length - max) : log);

/** Appends entries newer than the last one held: a batch can overlap what getApiLog returned. */
export function appendLog(prev: ApiLogEntry[], entries: ApiLogEntry[], max = MAX_LOG): ApiLogEntry[] {
  const last = lastSeq(prev);
  const fresh = entries.filter((e) => e.seq > last);
  if (!fresh.length) return prev;
  return capped(prev.concat(fresh), max);
}

/**
 * The log once getApiLog() answered a view that has just started streaming: the loaded entries
 * plus those of batches that arrived in the meantime and are newer (batches carry every frame
 * recorded after streaming started, so they may overlap the loaded entries). Held entries up to
 * the loaded ones' last seq are older copies and are replaced.
 */
export function withLoadedLog(held: ApiLogEntry[], loaded: ApiLogEntry[], max = MAX_LOG): ApiLogEntry[] {
  return appendLog(capped(loaded, max), held, max);
}

function apply(e: TapeEvent): void {
  const set = useStore.setState;
  switch (e.type) {
    case 'settings':
      set({ settings: e.settings });
      break;
    case 'connection':
      set({ connection: e.state });
      break;
    case 'account':
      set({ account: e.summary });
      break;
    case 'positions':
      set({ positions: e.positions });
      break;
    case 'orders':
      set({ orders: e.orders });
      break;
    case 'executions':
      set({ executions: e.executions });
      break;
    case 'quotes':
      set((s) => ({ quotes: mergeQuotes(s.quotes, e.quotes) }));
      break;
    case 'depth':
      set({ depth: e.book });
      break;
    case 'apiLog':
      set((s) => ({ apiLog: e.reset ? e.entries : appendLog(s.apiLog, e.entries), logFilePath: e.logFilePath || s.logFilePath }));
      break;
    case 'notifications':
      set({ notifications: e.notifications });
      break;
    case 'watchlists':
      set({ watchlists: e.watchlists });
      break;
    case 'priceAlerts':
      set({ priceAlerts: e.alerts });
      break;
    case 'nav':
      set({ nav: e.points });
      break;
    case 'lock':
      applyLockState(e.state);
      break;
    // Nothing behind the lock screen changes while it is up (main does not send these then either).
    case 'openContract':
      if (!isCovered(useStore.getState())) useStore.getState().openSymbol(e.contract, e.view);
      break;
    case 'command':
      if (!isCovered(useStore.getState())) commandListeners.forEach((l) => l(e.command));
      break;
  }
}

type CommandListener = (c: Extract<TapeEvent, { type: 'command' }>['command']) => void;
const commandListeners = new Set<CommandListener>();

/** Menu accelerators arrive as commands; App registers the handler. */
export function onCommand(listener: CommandListener): () => void {
  commandListeners.add(listener);
  return () => commandListeners.delete(listener);
}
