// Corporate events of the holdings: upcoming earnings from Wall Street Horizon (WSH), which IB
// serves only to accounts with the WSH subscription, and when IB refuses WSH, estimated from IB's
// market scanner (see earningsScanner.ts). Dividends do not come from here: they are IB's
// dividend tick on the holdings' quotes (generic tick 456, see subscriptions.ts).
//
// IB requires reqWshMetaData once per connection before reqWshEventData. Event requests go one
// at a time (one per underlying conId, today to EARNINGS_DAYS ahead) and their results are kept
// per conId for the New York day and the connection. Without the subscription IB refuses the
// meta data request (error 10276 "News feed is not allowed" on the paper account): the refusal is
// remembered for the connection and the New York day, and those stocks go to the scanner, whose
// searches run in the background (the answer says `pending` while they do, and `retryInMs` when a
// stock waits to be searched again). The scanner covers US dollar stocks only: with others left
// over the answer is `partial`, and with nothing else `unsubscribed`. A refusal of one event
// request keeps the events WSH already gave and sends the rest to the scanner. Demo mode answers
// from the simulator, as scanner estimates.
//
// IB did not document the event JSON beyond examples and the paper account cannot receive any,
// so parseWshEarnings reads it defensively (see there); a shape it cannot read is logged once.

import { EventName } from '../ib/tws';
import { contractKey, contractLabel } from '@shared/contract';
import type { ContractRef, CorporateEarnings, EarningsEvent } from '@shared/types';
import type { CorporateEventsService, MainContext } from '../context';
import { demoMarket } from './demo';
import { createEarningsScanner } from './earningsScanner';
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
/** Soonest first, then by contract key (in place). */
const sortEvents = (events: EarningsEvent[]): EarningsEvent[] => events.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));

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
  /** The New York day IB refused WSH on this connection (no subscription). */
  let wshRefusedDay: string | null = null;
  /** Earnings per conId, for one New York day and connection. */
  const cache = new Map<number, { day: string; events: Omit<EarningsEvent, 'key'>[] }>();
  /** The conId each contract key was asked by (option underlyings carry none), for cachedWsh. */
  const conIds = new Map<string, number>();
  const queue = new Limiter(1);
  const scanner = createEarningsScanner(ctx);
  let warnedShape = false;

  const reset = () => {
    meta = null;
    wshRefusedDay = null;
  };

  setImmediate(() => {
    ctx.ib.onReady(reset);
    // A 1101 (ready again) keeps the cached events; a new connection asks again.
    ctx.ib.onClosed(() => {
      reset();
      cache.clear();
      conIds.clear();
    });
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
      // A refusal holds for the New York day; a timeout or a dropped connection is asked again next time.
      if (refusal(err)) wshRefusedDay = todayYmd(Date.now());
      meta = null;
      throw err;
    });
    return meta;
  }

  async function eventsOf(und: ContractRef, today: string): Promise<EarningsEvent[]> {
    const key = contractKey(und);
    const conId = und.conId ?? (await ctx.contracts.resolve(und)).conId;
    if (!conId) throw new Error(`Unknown contract: ${contractLabel(und)}`);
    conIds.set(key, conId);
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

  /** The events WSH gave today for stocks with a known conId; the others are returned as `rest`. */
  function cachedWsh(stocks: ContractRef[], today: string): { events: EarningsEvent[]; answered: number; rest: ContractRef[] } {
    const events: EarningsEvent[] = [];
    const rest: ContractRef[] = [];
    let answered = 0;
    for (const und of stocks) {
      // As eventsOf found it: an option underlying's conId was resolved there.
      const conId = und.conId ?? conIds.get(contractKey(und));
      const hit = conId !== undefined ? cache.get(conId) : undefined;
      if (hit?.day !== today) {
        rest.push(und);
        continue;
      }
      events.push(...hit.events.map((e) => ({ ...e, key: contractKey(und) })));
      answered++;
    }
    return { events, answered, rest };
  }

  function demoEarnings(underlyings: ContractRef[]): CorporateEarnings {
    const events = underlyings.map((u) => ({ key: contractKey(u), ...demoMarket().earnings(u.symbol), estimated: true }));
    return { status: 'ok', events: sortEvents(events), source: 'scanner' };
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
      if (!stocks.length) return { status: 'ok', events: [] };
      const today = todayYmd(Date.now());
      const wshEvents: EarningsEvent[] = [];
      let wshAnswered = 0;
      let rest = stocks;
      if (wshRefusedDay !== today) {
        try {
          await requestMeta();
        } catch (err) {
          if (!refusal(err)) return { status: 'unavailable', events: [] };
          wshRefusedDay = today;
        }
      }
      if (wshRefusedDay !== today) {
        let refusedAt = -1;
        for (let i = 0; i < stocks.length; i++) {
          try {
            wshEvents.push(...(await queue.run(() => eventsOf(stocks[i], today))));
            wshAnswered++;
          } catch (err) {
            if (refusal(err)) {
              wshRefusedDay = today;
              refusedAt = i;
              break;
            }
          }
        }
        if (refusedAt < 0) {
          if (!wshAnswered) return { status: 'unavailable', events: [] };
          return { status: 'ok', events: sortEvents(wshEvents), source: 'wsh' };
        }
        // The events WSH gave are kept; the refused stock and those after it go to the scanner.
        rest = stocks.slice(refusedAt);
      } else {
        // WSH refused earlier today: stocks it answered before keep that answer.
        const cached = cachedWsh(stocks, today);
        wshEvents.push(...cached.events);
        wshAnswered = cached.answered;
        rest = cached.rest;
      }
      const s = scanner.lookup(rest, today);
      /** Stocks that went to the scanner and that it can look up (US dollar ones). */
      const scanned = rest.length - s.uncovered;
      const retry = s.retryInMs !== undefined ? { retryInMs: s.retryInMs } : {};
      if (!wshAnswered && !s.answered && !s.pending) {
        // Nothing else than stocks the scanner does not cover: they need WSH.
        if (s.refused || !scanned) return { status: 'unsubscribed', events: [] };
        return { status: 'unavailable', events: [], ...retry };
      }
      const events = sortEvents([...wshEvents, ...s.events]);
      return {
        status: 'ok',
        events,
        source: scanned ? 'scanner' : 'wsh',
        ...(s.uncovered ? { partial: true } : {}),
        ...(s.pending ? { pending: true } : {}),
        ...retry,
      };
    },
  };
}
