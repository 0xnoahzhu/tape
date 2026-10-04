// Conversions between IB's Contract and the app's ContractRef, plus IB time strings.

import type { Contract } from './tws';
import type { ComboLeg, ContractRef, SecType } from '@shared/types';

const SEC_TYPES: ReadonlySet<string> = new Set<SecType>(['STK', 'OPT', 'IND', 'FUT', 'FOP', 'CASH', 'BAG', 'CFD', 'BOND', 'WAR', 'CRYPTO']);
const HAS_EXPIRY: ReadonlySet<string> = new Set(['OPT', 'FOP', 'FUT', 'WAR']);
const HAS_STRIKE: ReadonlySet<string> = new Set(['OPT', 'FOP', 'WAR']);

/** A finite number, or undefined for empty / "not set" values (IB uses Double.MAX_VALUE). */
export function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && Math.abs(n) < 1e300 ? n : undefined;
}

/** IB contract (from positions, orders, executions) -> ContractRef. */
export function fromIbContract(c: Contract): ContractRef {
  const secType = (SEC_TYPES.has(String(c.secType)) ? c.secType : 'STK') as SecType;
  const ref: ContractRef = {
    symbol: c.symbol ?? '',
    secType,
    exchange: c.exchange || 'SMART',
    currency: c.currency || 'USD',
  };
  if (c.primaryExch) ref.primaryExchange = c.primaryExch;
  if (c.conId) ref.conId = c.conId;
  const expiry = (c.lastTradeDateOrContractMonth ?? '').trim().slice(0, 8);
  if (expiry && HAS_EXPIRY.has(secType)) ref.lastTradeDate = expiry;
  const strike = num(c.strike);
  if (strike && HAS_STRIKE.has(secType)) ref.strike = strike;
  const right = String(c.right ?? '').toUpperCase();
  if (right === 'C' || right === 'CALL') ref.right = 'C';
  else if (right === 'P' || right === 'PUT') ref.right = 'P';
  const multiplier = num(c.multiplier);
  if (multiplier && multiplier > 0 && (multiplier !== 1 || secType !== 'STK')) ref.multiplier = multiplier;
  if (c.localSymbol) ref.localSymbol = c.localSymbol;
  if (c.tradingClass) ref.tradingClass = c.tradingClass;
  if (secType === 'BAG' && c.comboLegs?.length) {
    ref.comboLegs = c.comboLegs.map(
      (l): ComboLeg => ({ conId: l.conId ?? 0, ratio: l.ratio ?? 1, action: l.action === 'SELL' ? 'SELL' : 'BUY', exchange: l.exchange || 'SMART' }),
    );
  }
  return ref;
}

/** ContractRef -> IB contract for requests and orders. */
export function toIbContract(ref: ContractRef): Contract {
  const c: Contract = {
    symbol: ref.symbol,
    secType: ref.secType as Contract['secType'],
    exchange: ref.exchange || 'SMART',
    currency: ref.currency || 'USD',
  };
  if (ref.conId) c.conId = ref.conId;
  if (ref.primaryExchange) c.primaryExch = ref.primaryExchange;
  if (ref.lastTradeDate) c.lastTradeDateOrContractMonth = ref.lastTradeDate;
  if (ref.strike != null) c.strike = ref.strike;
  if (ref.right) c.right = ref.right as Contract['right'];
  if (ref.multiplier && ref.secType !== 'STK') c.multiplier = ref.multiplier;
  if (ref.localSymbol) c.localSymbol = ref.localSymbol;
  if (ref.tradingClass) c.tradingClass = ref.tradingClass;
  if (ref.secType === 'BAG') {
    c.exchange = 'SMART';
    c.comboLegs = (ref.comboLegs ?? []).map((l) => ({
      conId: l.conId,
      ratio: l.ratio,
      action: l.action as NonNullable<Contract['comboLegs']>[number]['action'],
      exchange: l.exchange || 'SMART',
    }));
  }
  return c;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** How far `timeZone` is ahead of UTC at instant `t`, in ms. Throws for unknown zones. */
function zoneOffset(t: number, timeZone: string): number {
  let f = offsetFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/**
 * Parses IB time strings: "20261004 10:31:44 US/Eastern", "20261004  10:31:44" (TWS local time),
 * "20261004-14:31:44" (UTC) or epoch seconds. Unknown zone names fall back to local time.
 */
export function parseIbTime(s: string | undefined): number | undefined {
  const text = (s ?? '').trim();
  if (/^\d{9,10}$/.test(text)) return Number(text) * 1000;
  const m = /^(\d{4})(\d{2})(\d{2})([\s-]+)(\d{2}):(\d{2})(?::(\d{2}))?\s*(.*)$/.exec(text);
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[5], m[6], m[7] ?? '0'].map(Number);
  const zone = m[8].trim();
  const wall = Date.UTC(y, mo - 1, d, h, mi, se);
  if (zone) {
    try {
      let t = wall - zoneOffset(wall, zone);
      const second = zoneOffset(t, zone); // DST edge: the offset at the result may differ
      t = wall - second;
      return t;
    } catch {
      // not an IANA zone (e.g. "China Standard Time"): TWS reports its own local time
    }
  }
  if (m[4].trim() === '-') return wall;
  return new Date(y, mo - 1, d, h, mi, se).getTime();
}
