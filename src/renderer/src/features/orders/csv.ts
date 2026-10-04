// CSV export of working orders and today's trades (Orders page › Export CSV).
// Values stay machine-readable: plain numbers, ISO-like local times, IB's own codes.

import { contractLabel } from '@shared/contract';
import { hms, ymd } from '@shared/format';
import { sessionOf } from '@shared/orderTiming';
import type { Execution, TradingSession, WorkingOrder } from '@shared/types';
import { priceOrUndefined, tradeAmount } from './model';

type Cell = string | number | null | undefined;

const HEADER = [
  'Record',
  'Time',
  'Account',
  'Order ID',
  'Client ID',
  'Contract',
  'Symbol',
  'Security type',
  'Side',
  'Order type',
  'Quantity',
  'Price',
  'Aux price',
  'Filled',
  'Status',
  'TIF',
  'Session',
  'Good till',
  'Amount',
  'Commission',
  'Realized P&L',
  'Exchange',
  'Exec ID',
];

/** Rounds away binary noise (e.g. 22695.000000000004) and drops missing values. */
function num(n: number | null | undefined): string {
  const v = priceOrUndefined(n);
  return v == null ? '' : String(Number(v.toFixed(8)));
}

/** Quotes a cell when needed (RFC 4180) and defuses spreadsheet formulas in text cells. */
export function csvCell(value: Cell): string {
  if (value == null) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@]/.test(s) && !/^[+-]?\d/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Cell[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const localTime = (t: number) => `${ymd(t)} ${hms(t)}`;

/** Trading sessions in IBKR's own words. */
const SESSION_NAMES: Record<TradingSession, string> = {
  regular: 'Regular',
  extended: 'Outside RTH',
  overnight: 'Overnight',
  overnightDay: 'Overnight + Day',
};

export function ordersCsv(orders: WorkingOrder[], executions: Execution[]): string {
  const rows: Cell[][] = [HEADER];
  for (const o of orders) {
    const session = sessionOf(o);
    rows.push([
      'Open order',
      localTime(o.createdAt),
      o.account,
      o.orderId,
      o.clientId,
      contractLabel(o.contract),
      o.contract.symbol,
      o.contract.secType,
      o.action,
      o.orderType,
      num(o.totalQuantity),
      num(o.limitPrice),
      num(o.auxPrice),
      num(o.filled),
      o.status,
      o.tif,
      SESSION_NAMES[session],
      o.goodTillDate,
      '',
      '',
      '',
      // Overnight-only orders are routed to IB's OVERNIGHT venue.
      session === 'overnight' ? 'OVERNIGHT' : o.contract.exchange,
      '',
    ]);
  }
  for (const e of executions) {
    rows.push([
      'Trade',
      localTime(e.time),
      e.account,
      e.orderId,
      '',
      contractLabel(e.contract),
      e.contract.symbol,
      e.contract.secType,
      e.side,
      '',
      num(e.shares),
      num(e.price),
      '',
      num(e.shares),
      'Filled',
      '',
      '',
      '',
      num(tradeAmount(e)),
      num(e.commission),
      num(e.realizedPnL),
      e.exchange,
      e.execId,
    ]);
  }
  return toCsv(rows);
}

/** "tape-orders-2026-10-04.csv" */
export function csvFileName(now: number = Date.now()): string {
  return `tape-orders-${ymd(now)}.csv`;
}

/** Saves text through a temporary Blob link (Electron shows the save dialog). */
export function downloadCsv(fileName: string, csv: string): void {
  // The BOM makes Excel read the file as UTF-8.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
