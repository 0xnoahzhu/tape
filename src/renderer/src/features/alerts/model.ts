// Pure price alert helpers shared by the alert dialog and the bell panel.

import { contractLabel } from '@shared/contract';
import { parseNum, px } from '@shared/format';
import type { ContractRef, PriceAlert } from '@shared/types';

export type AlertCondition = PriceAlert['condition'];

/** Preset distances from the last price (design: −5% −2% +2% +5%). */
export const ALERT_PRESETS = [-5, -2, 2, 5] as const;

/** A positive trigger price, or null for empty / invalid input. */
export function parseAlertPrice(s: string): number | null {
  const v = parseNum(s);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Distance of the trigger from the last price, in percent. */
export function distancePct(price: number, last: number): number {
  return (price / last - 1) * 100;
}

/** True when the condition already holds, so the alert would fire immediately. */
export function isAlreadyMet(condition: AlertCondition, price: number, last: number): boolean {
  return condition === 'above' ? price <= last : price >= last;
}

/** Trigger price for a preset, as the input string (more decimals below $1). */
export function presetPrice(last: number, pct: number): string {
  const v = last * (1 + pct / 100);
  return v.toFixed(v < 1 ? 4 : 2);
}

export function conditionFor(pct: number): AlertCondition {
  return pct > 0 ? 'above' : 'below';
}

export const operatorOf = (c: AlertCondition): string => (c === 'above' ? '≥' : '≤');

/** "AAPL ≥ 235.00" */
export function alertSummary(contract: ContractRef, condition: AlertCondition, price: number): string {
  return `${contractLabel(contract)} ${operatorOf(condition)} ${px(price)}`;
}

export function newAlert(contract: ContractRef, condition: AlertCondition, price: number, repeat: boolean, id: string, now: number): PriceAlert {
  return { id, contract, condition, price, repeat, createdAt: now, active: true };
}
