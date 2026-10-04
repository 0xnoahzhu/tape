// Price alert evaluation and notification texts (pure, unit-tested).

import { contractKey, contractLabel } from '@shared/contract';
import { f2, pct } from '@shared/format';
import type { ContractRef, LocalizedText, PriceAlert } from '@shared/types';

/**
 * A repeating alert re-arms once the price has moved back across the trigger by this
 * fraction, so ticks bouncing on the trigger price do not fire a burst of notifications.
 */
export const REARM_BAND = 0.0005;

export function conditionMet(alert: Pick<PriceAlert, 'condition' | 'price'>, price: number): boolean {
  return alert.condition === 'above' ? price >= alert.price : price <= alert.price;
}

function movedBack(alert: Pick<PriceAlert, 'condition' | 'price'>, price: number): boolean {
  return alert.condition === 'above' ? price < alert.price * (1 - REARM_BAND) : price > alert.price * (1 + REARM_BAND);
}

/**
 * Evaluates one alert against a price.
 * - An armed alert fires when its condition is met (also when it was already met at creation).
 * - After firing it is disarmed; one-shot alerts are then deactivated by the caller.
 * - A repeating alert re-arms when the price moves back across the trigger price.
 */
export function evaluateAlert(alert: PriceAlert, price: number, armed: boolean): { fire: boolean; armed: boolean } {
  if (!alert.active || !Number.isFinite(price) || price <= 0) return { fire: false, armed };
  if (armed && conditionMet(alert, price)) return { fire: true, armed: false };
  if (!armed && alert.repeat && movedBack(alert, price)) return { fire: false, armed: true };
  return { fire: false, armed };
}

/**
 * Initial armed state when alerts are loaded at startup: a repeating alert that already fired
 * waits for the price to cross back first, so restarting the app does not repeat a notification.
 */
export function initiallyArmed(alert: PriceAlert): boolean {
  return !(alert.repeat && alert.lastTriggeredAt != null);
}

/** Identity of an alert's trigger; editing any of these re-arms it. */
export function alertSignature(alert: PriceAlert): string {
  return [contractKey(alert.contract), alert.condition, alert.price, alert.repeat ? 1 : 0, alert.active ? 1 : 0].join('|');
}

/** Unique contracts of the active alerts (to keep their quotes subscribed). */
export function alertContracts(alerts: PriceAlert[]): ContractRef[] {
  const out = new Map<string, ContractRef>();
  for (const a of alerts) {
    if (!a.active) continue;
    const key = contractKey(a.contract);
    if (!out.has(key)) out.set(key, a.contract);
  }
  return [...out.values()];
}

/** Digits needed to show a trigger price faithfully: 2 to 4. */
function priceDigits(n: number): number {
  if (Math.abs(n) < 1) return 4;
  for (let d = 2; d < 4; d++) if (Math.abs(n * 10 ** d - Math.round(n * 10 ** d)) < 1e-6) return d;
  return 4;
}

export function alertTexts(alert: PriceAlert, last: number, prevClose?: number): { title: LocalizedText; body: LocalizedText } {
  const label = contractLabel(alert.contract);
  const digits = priceDigits(alert.price);
  const target = f2(alert.price, digits);
  const lastS = f2(last, Math.max(2, Math.min(digits, priceDigits(last))));
  const change = prevClose && prevClose > 0 ? pct((last / prevClose - 1) * 100) : null;
  const above = alert.condition === 'above';
  return {
    title: {
      en: `${label} ${above ? 'rose above' : 'fell below'} ${target}`,
      zh: `${label} ${above ? '涨破' : '跌破'} ${target}`,
    },
    body: {
      en: `Last ${lastS}${change ? ` (${change})` : ''}. Your price alert was triggered.`,
      zh: `现价 ${lastS}${change ? `（${change}）` : ''}，触发你设置的价格提醒。`,
    },
  };
}
