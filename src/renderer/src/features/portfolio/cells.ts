// How the Positions table writes its cells (pure): a column's raw value through its format, built
// on the shared number helpers and the user's clock. The words for IB's codes come from the
// feature's messages.

import { compact, DASH, f0, f2, pct, px, sg, signColor } from '@shared/format';
import type { Clock } from '@shared/timeFormat';
import type { ContractRef, EarningsEvent, MarketDataType, OptionRight, Quote } from '@shared/types';
import { qtyLabel, type FigureSource } from './calc';
import { applies, type CellCtx, type CellValue, type ColumnDef, type Fmt } from './columns';
import { monthDay } from './events';

/** Words for IB's codes (messages.ts → cellWords). */
export interface CellWords {
  /** Instrument types (STK → Stock). */
  kinds: Record<string, string>;
  rights: Record<OptionRight, string>;
  /** IB's halted codes 0, 1, 2. */
  halts: readonly [string, string, string];
  dataTypes: Record<MarketDataType, string>;
  /** A day without a session. */
  closed: string;
  /** IB's shortable code (tick 46): none, on locate, at least 1000 shares. */
  shortable: readonly [string, string, string];
  /** An earnings release's time of day. */
  earningsTimes: Record<NonNullable<EarningsEvent['time']>, string>;
  /** Where an earnings date comes from (the earnings cell's tooltip). */
  earningsSources: Record<'wsh' | 'scanner', string>;
  /** A bond's features; `none`: IB says it has none of them. */
  features: Record<'callable' | 'putable' | 'convertible' | 'none', string>;
  /** The Quote status cell's tooltip while IB refused the line's extra generic ticks. */
  ticksRefused: Record<NonNullable<Quote['ticksRefused']>, string>;
  /** Which of IB's sources a figure shows (the tooltip of Price, Value and the P&L cells). */
  sources: Record<FigureSource, string>;
}

/** IB's shortable code as an index into CellWords.shortable: above 2.5 easy, above 1.5 on locate, else none. */
export function shortableLevel(code: number): 0 | 1 | 2 {
  return code > 2.5 ? 2 : code > 1.5 ? 1 : 0;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

/** "20261016" → "2026-10-16"; other text as it is. */
const dateText = (v: string): string => (/^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v);

/** "0400-2000,..." → "04:00 AM–08:00 PM, ..." in the user's clock; "CLOSED" → Closed. */
function hoursText(v: string, w: CellWords, clock: Clock): string {
  if (v === 'CLOSED') return w.closed;
  const wall = (hhmm: string) => `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
  return v
    .split(',')
    .map((r) => {
      const [from, to] = r.split('-');
      return from && to ? clock.range(wall(from), wall(to)) : r;
    })
    .join(', ');
}

/**
 * A raw value in a format; "—" when there is none. `digits` fixes the decimals of prices ('px')
 * where the shared default (2, or 4 below 1) would cut IB's (forex).
 */
export function formatValue(fmt: Fmt, v: CellValue, w: CellWords, clock: Clock, now: number, digits?: number): string {
  if (v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) return DASH;
  if (typeof v === 'string') {
    switch (fmt) {
      case 'kind':
        return w.kinds[v] ?? v;
      case 'right':
        return w.rights[v as OptionRight] ?? v;
      case 'date':
        return dateText(v);
      case 'hours':
        return hoursText(v, w, clock);
      case 'month':
        return /^\d{6}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}` : v;
      case 'stamp': {
        // "YYYYMMDD HH:MM", a wall time in the instrument's zone: written in the user's format.
        const [day, time] = v.split(' ');
        return time ? `${dateText(day)} ${clock.wall(time)}` : dateText(day);
      }
      case 'earn': {
        const [day, time] = v.split('|');
        const when = time ? w.earningsTimes[time as NonNullable<EarningsEvent['time']>] : undefined;
        return when ? `${dateText(day)} ${when}` : dateText(day);
      }
      case 'features':
        return v
          .split(',')
          .map((f) => w.features[f as keyof CellWords['features']] ?? f)
          .join(' · ');
      default:
        return v;
    }
  }
  const price = digits === undefined ? px : (n: number) => f2(n, digits);
  switch (fmt) {
    case 'qty':
      return qtyLabel(v);
    case 'px':
      return price(v);
    case 'money':
      return f2(v);
    case 'num0':
      return f0(v);
    case 'num3':
      return f2(v, 3);
    case 'num4':
      return f2(v, 4);
    case 'dec':
      return f2(v, 8).replace(/\.?0+$/, '');
    case 'id':
      return String(Math.trunc(v));
    case 'pnl':
      return sg(v);
    case 'chg':
      return sg(v, price);
    case 'pct':
      return pct(v * 100);
    case 'pctU':
      return `${f2(v * 100)}%`;
    case 'num2':
      return f2(v);
    case 'vol':
      return `${f2(v * 100, 1)}%`;
    case 'big':
      return compact(v);
    case 'time':
      return clock.time(v, sameDay(v, now) ? {} : { date: 'md' });
    case 'greek3':
      return f2(v, 3);
    case 'greek4':
      return f2(v, 4);
    case 'halt':
      return w.halts[v === 1 || v === 2 ? v : 0];
    case 'dataType':
      return w.dataTypes[v as MarketDataType] ?? String(v);
    case 'shortable':
      return w.shortable[shortableLevel(v)];
    default:
      return String(v);
  }
}

/**
 * Decimals of a forex row's prices, as IB quotes the pairs (to a tenth of a pip): 5 below 10
 * (EUR.USD 1.08345), else 3 (USD.JPY 150.125). By the row's price level, so its bid, ask and
 * close have the price's decimals. Undefined for other instruments (the shared price format).
 */
export function priceDigits(c: CellCtx): number | undefined {
  if (c.row.position.contract.secType !== 'CASH') return undefined;
  const level = c.row.price ?? c.q?.bid ?? c.q?.ask;
  return finite(level) && Math.abs(level) >= 10 ? 3 : 5;
}

/**
 * A cell's text: empty when the column does not apply to the row's instrument, "—" when it applies
 * but IB has not sent the value. The data type names the exchange a quote comes from when it is
 * not SMART ("Live · ARCA").
 */
export function cellText(def: ColumnDef, c: CellCtx, w: CellWords, clock: Clock): string {
  if (!applies(def, c.row)) return '';
  const text = formatValue(def.fmt, def.value(c), w, clock, c.now, def.fmt === 'px' || def.fmt === 'chg' ? priceDigits(c) : undefined);
  if (def.fmt === 'dataType' && text !== DASH && c.q?.source) return `${text} · ${c.q.source.exchange}`;
  return text;
}

/** A cell's text color: by sign, muted, or the default (undefined). */
export function cellColor(def: ColumnDef, v: CellValue): string | undefined {
  if (def.color === 'muted') return 'var(--mu)';
  if (def.color === 'sign') return signColor(finite(v) ? v : undefined);
  return undefined;
}

/**
 * An option or futures option row's second line, as IB's contract says: the right and the expiry
 * ("Call · 10/16"); undefined for other instruments.
 */
export function optionLineText(k: ContractRef, w: Pick<CellWords, 'rights' | 'kinds'>): string | undefined {
  if (k.secType !== 'OPT' && k.secType !== 'FOP') return undefined;
  const right = (k.right && w.rights[k.right]) || (w.kinds[k.secType] ?? k.secType);
  return /^\d{8}$/.test(k.lastTradeDate ?? '') ? `${right} · ${monthDay(k.lastTradeDate!)}` : right;
}
