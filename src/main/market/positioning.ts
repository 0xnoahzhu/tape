// Open-interest scans for the options desk's Positioning tab. IB has no request for a chain's open
// interest: each option's comes on its own market data line (generic tick 101, ticks 27 / 28), with
// its volume and IB's model computation (IV and greeks). A scan opens probe lines (quotes.ts →
// probe, outside the owners and within the line budget) SCAN_LINES at a time, reads each option
// until its open interest and model have come (or CONTRACT_TIMEOUT_MS), closes the line and opens
// the next. An option IB does not list (200) is left out. A probe refused for want of a free line
// is tried again; when none frees up for NO_LINE_GIVE_UP_MS the scan ends with an error.
//
// Snapshots. A trading day's scans of an underlying merge into one snapshot (a later read of an
// option replaces its row), stored in the kv namespace POSITIONING_NS under
// "<underlying key>|<YYYYMMDD>", with "<underlying key>|days" listing the days stored (at most
// MAX_DAYS). These are the history the open-interest change and the levels over time are read
// from, which IB does not keep: they are not market data caches (clearMarketData keeps them), and
// the kv retention deletes a day not rewritten for 180 days.
//
// One scan runs at a time: a new one ends the one running. Demo mode answers from the simulator at
// once, keeps its snapshot in memory and makes up the earlier days from it.

import { contractKey, contractLabel } from '@shared/contract';
import { tradingDay } from '@shared/session';
import type { ContractRef, PositioningProgress, PositioningRow, PositioningSnapshot, Quote } from '@shared/types';
import type { MainContext } from '../context';
import { demoMarket, Rng, hashString } from './demo';
import { isIbConnected, NOT_CONNECTED } from './ibRequest';
import { applyTick, type TickContext } from './tickMap';

export const POSITIONING_NS = 'positioning';
/** Probe lines a scan holds at once (of the 95; the views keep the rest). */
export const SCAN_LINES = 40;
/** At most this many options per scan. */
export const MAX_SCAN_OPTIONS = 1500;
/** An option's line is closed this long after it opened, whatever it has sent. */
export const CONTRACT_TIMEOUT_MS = 6_000;
/** After its open interest and model, a line waits this long for the volume. */
const VOLUME_GRACE_MS = 700;
const NO_LINE_RETRY_MS = 300;
const NO_LINE_GIVE_UP_MS = 20_000;
/** Days of snapshots kept in the list per underlying. */
export const MAX_DAYS = 250;
const PROGRESS_EVERY_MS = 250;
/** Generic ticks of a scan line: option volume (100), open interest (101), IV (106). */
const SCAN_TICKS = '100,101,106';
/**
 * IB ended the line or will send it nothing: the session ended (-1), not listed (200), not
 * subscribed (354, 10168, 10186), a competing session (10197), refused (162, 321). Notices (10167
 * delayed data, 10089–10091 some ticks not subscribed) do not end it.
 */
const END_CODES = new Set([-1, 162, 200, 321, 354, 10168, 10186, 10197]);

export interface PositioningService {
  scan(underlying: ContractRef, options: ContractRef[]): Promise<PositioningSnapshot>;
  cancel(): void;
  get(underlying: ContractRef, days: number): Promise<PositioningSnapshot[]>;
}

const rowKey = (r: Pick<PositioningRow, 'expiry' | 'strike' | 'right'>) => `${r.expiry}|${r.strike}|${r.right}`;
const daysKey = (u: string) => `${u}|days`;
const dayKey = (u: string, day: string) => `${u}|${day}`;

/** The scanned row of an option from what its line sent; null without open interest or model. */
export function rowOf(c: ContractRef, q: Quote): PositioningRow | null {
  if (q.openInterest == null && q.iv == null && q.gamma == null) return null;
  const row: PositioningRow = { expiry: c.lastTradeDate ?? '', strike: c.strike ?? 0, right: c.right === 'P' ? 'P' : 'C', multiplier: c.multiplier ?? 100 };
  if (q.openInterest != null) row.oi = q.openInterest;
  if (q.volume != null) row.volume = q.volume;
  if (q.iv != null) row.iv = q.iv;
  if (q.delta != null) row.delta = q.delta;
  if (q.gamma != null) row.gamma = q.gamma;
  return row;
}

/** `prev`'s rows with `rows` merged in (a row of the same option replaces the older one), sorted. */
export function mergeRows(prev: readonly PositioningRow[], rows: readonly PositioningRow[]): PositioningRow[] {
  const map = new Map(prev.map((r) => [rowKey(r), r]));
  for (const r of rows) map.set(rowKey(r), r);
  return [...map.values()].sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike || a.right.localeCompare(b.right));
}

/** Median of the underlying prices the models used; undefined without any. */
export function medianOf(values: number[]): number | undefined {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const isSnapshot = (v: unknown): v is PositioningSnapshot => !!v && typeof v === 'object' && Array.isArray((v as PositioningSnapshot).rows) && typeof (v as PositioningSnapshot).day === 'string';

/** The weekdays before `day` (YYYYMMDD), most recent first. */
function weekdaysBefore(day: string, n: number): string[] {
  const d = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8))));
  const out: string[] = [];
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return out;
}

/** Demo: earlier days made up from today's snapshot (open interest and price drifting back). */
export function demoHistory(today: PositioningSnapshot, days: number): PositioningSnapshot[] {
  const rng = new Rng(hashString(today.underlying + today.day));
  const out: PositioningSnapshot[] = [today];
  let rows = today.rows;
  let spot = today.spot;
  for (const day of weekdaysBefore(today.day, Math.max(0, days - 1))) {
    rows = rows.filter((r) => r.expiry >= day).map((r) => (r.oi == null ? r : { ...r, oi: Math.max(0, Math.round(r.oi * (0.86 + 0.2 * rng.next()))), volume: r.volume != null ? Math.round(r.volume * (0.5 + rng.next())) : undefined }));
    spot = spot != null ? spot * (1 + rng.normal() * 0.012) : undefined;
    out.unshift({ ...today, day, updatedAt: today.updatedAt - out.length * 86_400_000, spot, rows });
  }
  return out;
}

export function createPositioningService(ctx: MainContext): PositioningService {
  let running: { id: number; cancel: () => void } | null = null;
  /** The open lines' finish functions, so a cancel closes them at once. */
  const open = new Set<() => void>();
  let seq = 0;
  /** Demo snapshots, per underlying key (never stored). */
  const demoDays = new Map<string, PositioningSnapshot>();

  const emit = (progress: PositioningProgress) => ctx.emit({ type: 'positioningScan', progress });

  const load = async (u: string, day: string): Promise<PositioningSnapshot | undefined> => {
    const row = await ctx.db?.kv.get<PositioningSnapshot>(POSITIONING_NS, dayKey(u, day)).catch(() => undefined);
    return row && isSnapshot(row.value) ? row.value : undefined;
  };
  const loadDays = async (u: string): Promise<string[]> => {
    const row = await ctx.db?.kv.get<string[]>(POSITIONING_NS, daysKey(u)).catch(() => undefined);
    return row && Array.isArray(row.value) ? row.value.filter((d) => typeof d === 'string') : [];
  };

  const store = async (snap: PositioningSnapshot) => {
    if (!ctx.db) return;
    await ctx.db.kv.set(POSITIONING_NS, dayKey(snap.underlying, snap.day), snap);
    const days = await loadDays(snap.underlying);
    if (!days.includes(snap.day)) {
      const next = [...days, snap.day].sort();
      const drop = next.splice(0, Math.max(0, next.length - MAX_DAYS));
      await ctx.db.kv.set(POSITIONING_NS, daysKey(snap.underlying), next);
      for (const d of drop) await ctx.db.kv.delete(POSITIONING_NS, dayKey(snap.underlying, d)).catch(() => undefined);
    }
  };

  const demoScan = (u: string, underlying: ContractRef, options: ContractRef[]): PositioningSnapshot => {
    const demo = demoMarket();
    const rows = options.flatMap((c) => {
      const q = demo.quote(c, ['option']);
      return q ? [rowOf(c, { key: contractKey(c), updatedAt: Date.now(), ...q } as Quote)].filter((r): r is PositioningRow => !!r) : [];
    });
    const now = Date.now();
    const day = tradingDay(now);
    const prev = demoDays.get(u);
    const snap: PositioningSnapshot = { underlying: u, day, updatedAt: now, spot: demo.price(underlying.symbol), rows: mergeRows(prev?.day === day ? prev.rows : [], rows) };
    demoDays.set(u, snap);
    emit({ underlying: u, done: options.length, total: options.length, running: false });
    return snap;
  };

  /** Reads one option on a probe line; resolves with what it sent (null: nothing usable). */
  const readOne = (c: ContractRef, alive: () => boolean): Promise<{ row: PositioningRow | null; und?: number } | 'no-line'> =>
    new Promise((resolve) => {
      const q = { key: contractKey(c), updatedAt: 0 } as Quote;
      const tickCtx: TickContext = { isOption: true, right: c.right === 'P' ? 'P' : 'C' };
      let und: number | undefined;
      let finished = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        open.delete(finish);
        clearTimeout(timer);
        clearTimeout(grace);
        handle?.close();
        resolve({ row: rowOf(c, q), und });
      };
      const handle = ctx.quotes.probe(c, SCAN_TICKS, (e) => {
        if (finished) return;
        if (!alive()) return finish();
        if (e.kind === 'error') {
          if (END_CODES.has(e.code)) finish();
          return;
        }
        if (e.kind !== 'tick') return;
        applyTick(q, e.tick, tickCtx);
        if (e.tick.kind === 'option' && e.tick.undPrice != null && e.tick.undPrice > 0 && Number.isFinite(e.tick.undPrice)) und = e.tick.undPrice;
        if (q.openInterest != null && (q.gamma != null || q.iv != null)) {
          if (q.volume != null) finish();
          else grace ??= setTimeout(finish, VOLUME_GRACE_MS);
        }
      });
      if (!handle) {
        finished = true;
        resolve('no-line');
        return;
      }
      open.add(finish);
      const timer = setTimeout(finish, CONTRACT_TIMEOUT_MS);
    });

  const liveScan = async (u: string, options: ContractRef[], id: number, alive: () => boolean): Promise<PositioningSnapshot> => {
    const total = options.length;
    const rows: PositioningRow[] = [];
    const unds: number[] = [];
    let done = 0;
    let next = 0;
    let lastEmit = 0;
    let failure: string | undefined;
    const progress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < PROGRESS_EVERY_MS) return;
      lastEmit = now;
      emit({ underlying: u, done, total, running: true });
    };
    const worker = async () => {
      let waitingSince: number | undefined;
      while (alive() && !failure && next < total) {
        if (!isIbConnected(ctx)) {
          failure = NOT_CONNECTED;
          break;
        }
        const c = options[next++];
        const res = await readOne(c, alive);
        if (res === 'no-line') {
          next--; // nobody took it: try again
          waitingSince ??= Date.now();
          if (Date.now() - waitingSince > NO_LINE_GIVE_UP_MS) {
            failure = 'No free market data line for the scan';
            break;
          }
          await new Promise((r) => setTimeout(r, NO_LINE_RETRY_MS));
          continue;
        }
        waitingSince = undefined;
        if (res.row) rows.push(res.row);
        if (res.und != null) unds.push(res.und);
        done++;
        progress();
      }
    };
    progress(true);
    // Workers start staggered, so the first requests do not go out in one burst.
    await Promise.all(Array.from({ length: Math.min(SCAN_LINES, total) }, (_, i) => new Promise((r) => setTimeout(r, i * 25)).then(worker)));
    const now = Date.now();
    const day = tradingDay(now);
    const prev = await load(u, day);
    const snap: PositioningSnapshot = { underlying: u, day, updatedAt: now, spot: medianOf(unds) ?? prev?.spot, rows: mergeRows(prev?.rows ?? [], rows) };
    if (rows.length) await store(snap).catch((err) => console.error('[positioning] store failed:', err));
    if (running?.id === id) running = null;
    const error = failure ?? (alive() ? undefined : 'Cancelled');
    emit({ underlying: u, done, total, running: false, ...(error ? { error } : {}) });
    if (failure && !rows.length) throw new Error(failure);
    return snap;
  };

  return {
    async scan(underlying, options) {
      if (!underlying?.symbol) throw new Error('Invalid underlying');
      const list = (Array.isArray(options) ? options : []).filter((c) => c && (c.secType === 'OPT' || c.secType === 'FOP') && c.lastTradeDate && c.strike && (c.right === 'C' || c.right === 'P')).slice(0, MAX_SCAN_OPTIONS);
      const u = contractKey(underlying);
      running?.cancel();
      running = null;
      if (ctx.demo) return demoScan(u, underlying, list);
      if (!isIbConnected(ctx)) throw new Error(NOT_CONNECTED);
      if (!list.length) throw new Error(`No options to scan for ${contractLabel(underlying)}`);
      const id = ++seq;
      let cancelled = false;
      running = {
        id,
        cancel: () => {
          cancelled = true;
          for (const f of [...open]) f();
        },
      };
      return liveScan(u, list, id, () => !cancelled);
    },
    cancel() {
      running?.cancel();
      running = null;
    },
    async get(underlying, days) {
      if (!underlying?.symbol) throw new Error('Invalid underlying');
      const n = Math.max(1, Math.min(MAX_DAYS, Math.floor(Number(days)) || 1));
      const u = contractKey(underlying);
      if (ctx.demo) {
        const today = demoDays.get(u);
        return today ? demoHistory(today, n) : [];
      }
      const list = (await loadDays(u)).sort().slice(-n);
      const snaps = await Promise.all(list.map((d) => load(u, d)));
      return snaps.filter((s): s is PositioningSnapshot => !!s);
    },
  };
}
