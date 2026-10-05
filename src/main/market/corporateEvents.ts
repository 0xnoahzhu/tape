// Corporate events of the holdings: upcoming earnings from Wall Street Horizon (WSH), which IB
// serves only to accounts with the WSH subscription. Dividends do not come from here: they are
// IB's dividend tick on the holdings' quotes (generic tick 456, see subscriptions.ts).
//
// IB requires reqWshMetaData once per connection before reqWshEventData. Event requests go one
// at a time (one per underlying conId, today to EARNINGS_DAYS ahead) and their results are kept
// per conId for the New York day. Without the subscription IB refuses the meta data request
// (error 10276 "News feed is not allowed" on the paper account): the service then answers
// 'unsubscribed' without asking IB again until the next handshake. Demo mode answers from the
// simulator.
//
// IB did not document the event JSON beyond examples and the paper account cannot receive any,
// so parseWshEarnings reads it defensively (see there); a shape it cannot read is logged once.

import { EventName } from '../ib/tws';
import { contractKey, contractLabel } from '@shared/contract';
import type { ContractRef, CorporateEarnings, EarningsEvent } from '@shared/types';
import type { CorporateEventsService, MainContext } from '../context';
import { demoMarket } from './demo';
import { IbRequestError, ibRequest, isIbConnected, Limiter } from './ibRequest';
import { addDays, nyDay, yyyymmdd } from './nyTime';

/** How far ahead earnings are asked for. */
export const EARNINGS_DAYS = 90;
export const WSH_TIMEOUT_MS = 15_000;
/** Most underlyings asked for in one call (one request each, one at a time). */
export const MAX_UNDERLYINGS = 40;

/**
 * IB's WSH refusals that mean the account lacks the subscription or the permission: 10276 "News
 * feed is not allowed", 10277 "News feed permissions required".
 */
export const WSH_UNSUBSCRIBED_CODES: ReadonlySet<number> = new Set([10276, 10277]);
/** "Duplicate WSH meta data request": an earlier request is still answering; it counts as done. */
const DUPLICATE_META_CODE = 10278;

const todayYmd = (now: number) => yyyymmdd(nyDay(now));

// ---------------------------------------------------------------------------
// Event JSON

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** "2026-10-29", "20261029", "2026-10-29T20:05:00Z", "2026/10/29" → "20261029". */
export function wshDate(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 19_000_101 && v <= 29_991_231) return String(v);
  if (typeof v !== 'string') return undefined;
  const m = /^(\d{4})-?\/?(\d{2})-?\/?(\d{2})(?:$|[T\s])/.exec(v.trim());
  if (!m) return undefined;
  const [, y, mo, d] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return undefined;
  return `${y}${mo}${d}`;
}

/** Time of day of an earnings release: before the open, after the close or during the session. */
export function wshTimeOfDay(v: unknown): EarningsEvent['time'] {
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase();
  if (/before|bmo|pre[\s_-]?market|morning/.test(s)) return 'bmo';
  if (/after|amc|post[\s_-]?market|evening/.test(s)) return 'amc';
  if (/during|dmh|intraday|market hours/.test(s)) return 'dmh';
  return undefined;
}

const DATE_FIELDS = ['earnings_date', 'earningsDate', 'event_date', 'eventDate', 'date', 'start_date', 'startDate'];
const TIME_FIELDS = ['time_of_day', 'timeOfDay', 'earnings_time', 'earningsTime', 'announce_time', 'time'];
const TYPE_FIELDS = ['event_type', 'eventType', 'type', 'index_date_type'];

/** Earnings event types: WSH's "wshe_ed" (earnings date) and anything named earnings. */
const isEarningsType = (t: string): boolean => /wshe_ed|earn/i.test(t) || /(^|[_\s])ed$/i.test(t);

function field(rec: Json, names: readonly string[]): unknown {
  for (const n of names) if (rec[n] !== undefined && rec[n] !== null && rec[n] !== '') return rec[n];
  const data = rec.data;
  if (isObject(data)) for (const n of names) if (data[n] !== undefined && data[n] !== null && data[n] !== '') return data[n];
  return undefined;
}

/** Event records of the payload, each with the type its container names (an object keyed by type). */
function records(payload: unknown): Array<{ rec: Json; typeHint?: string }> {
  if (Array.isArray(payload)) return payload.filter(isObject).map((rec) => ({ rec }));
  if (!isObject(payload)) return [];
  for (const k of ['events', 'data', 'results']) if (Array.isArray(payload[k])) return records(payload[k]);
  const out: Array<{ rec: Json; typeHint?: string }> = [];
  for (const [k, v] of Object.entries(payload)) {
    if (Array.isArray(v)) for (const rec of v.filter(isObject)) out.push({ rec, typeHint: k });
  }
  if (!out.length && field(payload, DATE_FIELDS) !== undefined) out.push({ rec: payload });
  return out;
}

/**
 * Earnings of one underlying from a wshEventData payload, from `today` (YYYYMMDD) on, soonest
 * first, one per date. Accepts an array of events, `{ events: [...] }` or an object of arrays
 * keyed by event type; an event's type is its event_type / type field (or that key), its date the
 * first of earnings_date, event_date, date … (also inside `data`), as yyyy-mm-dd or yyyyMMdd.
 * Events of other types are skipped; an event without any type counts only when it has an
 * explicit earnings date field. Returns null when the JSON cannot be read at all.
 */
export function parseWshEarnings(json: string, key: string, today: string): EarningsEvent[] | null {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  const recs = records(payload);
  if (!recs.length && !(Array.isArray(payload) || isObject(payload))) return null;
  const byDate = new Map<string, EarningsEvent>();
  for (const { rec, typeHint } of recs) {
    const type = field(rec, TYPE_FIELDS) ?? typeHint;
    const explicit = field(rec, ['earnings_date', 'earningsDate']);
    if (typeof type === 'string' ? !isEarningsType(type) : explicit === undefined) continue;
    const date = wshDate(explicit ?? field(rec, DATE_FIELDS));
    if (!date || date < today) continue;
    const time = wshTimeOfDay(field(rec, TIME_FIELDS));
    const prev = byDate.get(date);
    if (!prev || (!prev.time && time)) byDate.set(date, time ? { key, date, time } : { key, date });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Service

export function createCorporateEventsService(ctx: MainContext): CorporateEventsService {
  /** Meta data requested on this connection (IB wants it before event data). */
  let meta: Promise<void> | null = null;
  /** IB refused WSH on this connection (no subscription). */
  let unsubscribed = false;
  /** Earnings per conId, for one New York day. */
  const cache = new Map<number, { day: string; events: Omit<EarningsEvent, 'key'>[] }>();
  const queue = new Limiter(1);
  let warnedShape = false;

  const reset = () => {
    meta = null;
    unsubscribed = false;
  };

  setImmediate(() => {
    ctx.ib.onReady(reset);
    ctx.ib.onClosed(reset);
  });

  const refusal = (err: unknown): boolean => err instanceof IbRequestError && WSH_UNSUBSCRIBED_CODES.has(err.code);

  function requestMeta(): Promise<void> {
    meta ??= ibRequest<void>(ctx, {
      label: 'Wall Street Horizon meta data',
      timeoutMs: WSH_TIMEOUT_MS,
      send: (api, reqId) => api.reqWshMetaData(reqId),
      cancel: (api, reqId) => api.cancelWshMetaData(reqId),
      events: { [EventName.wshMetaData]: (_args, ctl) => ctl.resolve() },
      onError: (e, ctl) => {
        if (e.code !== DUPLICATE_META_CODE) return false;
        ctl.resolve();
        return true;
      },
    }).catch((err: unknown) => {
      if (refusal(err)) unsubscribed = true;
      else meta = null; // a timeout or a dropped connection is asked again next time
      throw err;
    });
    return meta;
  }

  async function eventsOf(und: ContractRef, today: string): Promise<EarningsEvent[]> {
    const key = contractKey(und);
    const conId = und.conId ?? (await ctx.contracts.resolve(und)).conId;
    if (!conId) throw new Error(`Unknown contract: ${contractLabel(und)}`);
    const hit = cache.get(conId);
    if (hit && hit.day === today) return hit.events.map((e) => ({ ...e, key }));
    const endDate = yyyymmdd(addDays(nyDay(Date.now()), EARNINGS_DAYS));
    const json = await ibRequest<string>(ctx, {
      label: `Wall Street Horizon events for ${contractLabel(und)}`,
      timeoutMs: WSH_TIMEOUT_MS,
      send: (api, reqId) => api.reqWshEventData(reqId, { conId, startDate: today, endDate }),
      cancel: (api, reqId) => api.cancelWshEventData(reqId),
      events: { [EventName.wshEventData]: (args, ctl) => ctl.resolve(String(args[0] ?? '')) },
    });
    let events = parseWshEarnings(json, key, today);
    if (!events) {
      if (!warnedShape) console.warn('[wsh] unreadable event data:', json.slice(0, 500));
      warnedShape = true;
      events = [];
    }
    cache.set(conId, { day: today, events: events.map(({ key: _k, ...e }) => e) });
    return events;
  }

  function demoEarnings(underlyings: ContractRef[]): CorporateEarnings {
    const events = underlyings.map((u) => ({ key: contractKey(u), ...demoMarket().earnings(u.symbol) }));
    return { status: 'ok', events: events.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key)) };
  }

  return {
    async getEarnings(underlyings) {
      const seen = new Set<string>();
      const stocks = (Array.isArray(underlyings) ? underlyings : [])
        .filter((u) => u && typeof u.symbol === 'string' && u.symbol && u.secType === 'STK')
        .filter((u) => {
          const k = contractKey(u);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, MAX_UNDERLYINGS);
      if (ctx.demo) return demoEarnings(stocks);
      if (!isIbConnected(ctx)) return { status: 'unavailable', events: [] };
      if (unsubscribed) return { status: 'unsubscribed', events: [] };
      if (!stocks.length) return { status: 'ok', events: [] };
      try {
        await requestMeta();
      } catch (err) {
        return { status: refusal(err) ? 'unsubscribed' : 'unavailable', events: [] };
      }
      const today = todayYmd(Date.now());
      let answered = 0;
      let refused = false;
      const events: EarningsEvent[] = [];
      for (const und of stocks) {
        try {
          events.push(...(await queue.run(() => eventsOf(und, today))));
          answered++;
        } catch (err) {
          if (refusal(err)) {
            unsubscribed = refused = true;
            break;
          }
        }
      }
      if (refused) return { status: 'unsubscribed', events: [] };
      if (!answered) return { status: 'unavailable', events: [] };
      events.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
      return { status: 'ok', events };
    },
  };
}
