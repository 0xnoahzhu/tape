// How the Positions table writes its cells (pure): a column's raw value through its format, built
// on the shared number helpers and the user's clock. The words for IB's codes come from the
// feature's messages.

import { compact, DASH, f0, f2, pct, px, sg, signColor } from '@shared/format';
import type { Clock } from '@shared/timeFormat';
import type { MarketDataType, OptionRight } from '@shared/types';
import { qtyLabel, weightLabel } from './calc';
import { applies, type CellCtx, type CellValue, type ColumnDef, type Fmt } from './columns';

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
  /** Calendar days: "12d". */
  days(n: number): string;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

/** "0400-2000,..." → "4:00 AM–8:00 PM, ..." in the user's clock; "CLOSED" → Closed. */
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
 * A raw value in a format; "—" when there is none. `digits` fixes the decimals of prices and price
 * changes ('px', 'chg') where the shared default (2, or 4 below 1) would cut IB's (forex).
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
        return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
      case 'hours':
        return hoursText(v, w, clock);
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
    case 'num0':
      return f0(v);
    case 'num2':
      return f2(v);
    case 'num4':
      return f2(v, 4);
    case 'dec':
      return f2(v, 8).replace(/\.?0+$/, '');
    case 'id':
      return String(Math.trunc(v));
    case 'pnl':
      return sg(v, f0);
    case 'chg':
      return sg(v, price);
    case 'pctS':
      return pct(v);
    case 'pctU':
      return weightLabel(v);
    case 'pctFine':
      return `${f2(v, Math.abs(v) < 1 ? 3 : 2)}%`;
    case 'vol':
      return `${f2(v * 100, 1)}%`;
    case 'big':
      return compact(v);
    case 'days':
      return w.days(v);
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
    default:
      return String(v);
  }
}

/**
 * Decimals of a forex row's prices, as IB quotes the pairs (to a tenth of a pip): 5 below 10
 * (EUR.USD 1.08345), else 3 (USD.JPY 150.125). By the row's price level, so a spread or a change
 * has its price's decimals. Undefined for other instruments (the shared price format).
 */
export function priceDigits(c: CellCtx): number | undefined {
  if (c.row.position.contract.secType !== 'CASH') return undefined;
  const level = c.row.last ?? c.q?.bid ?? c.q?.ask;
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
