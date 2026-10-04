// Price alerts: persists them, keeps the instruments of active alerts subscribed (owner
// "alerts") and evaluates every quote against them. Triggers become 'price' notifications.

import { contractKey } from '@shared/contract';
import type { PriceAlert, Quote } from '@shared/types';
import type { AlertService, MainContext } from '../context';
import { alertContracts, alertSignature, alertTexts, evaluateAlert, initiallyArmed } from './alertEval';
import { afterStartup } from './ibRequest';
import { lastOrMid } from './tickMap';

const OWNER = 'alerts';

export function createAlertService(ctx: MainContext): AlertService {
  let alerts: PriceAlert[] = [];
  /** Active alerts per contract key, for fast lookup on every quote. */
  let byKey = new Map<string, PriceAlert[]>();
  /** Armed state per alert id, reset whenever the alert's trigger changes. */
  const armed = new Map<string, { sig: string; armed: boolean }>();
  let started = false;

  const isArmed = (a: PriceAlert): boolean => {
    const sig = alertSignature(a);
    const entry = armed.get(a.id);
    if (entry && entry.sig === sig) return entry.armed;
    // At startup a repeating alert that fired before waits for a crossing; edits re-arm.
    const value = started ? true : initiallyArmed(a);
    armed.set(a.id, { sig, armed: value });
    return value;
  };

  const index = () => {
    byKey = new Map();
    for (const a of alerts) {
      if (!a.active) continue;
      const key = contractKey(a.contract);
      const list = byKey.get(key);
      if (list) list.push(a);
      else byKey.set(key, [a]);
      isArmed(a);
    }
    const ids = new Set(alerts.map((a) => a.id));
    for (const id of [...armed.keys()]) if (!ids.has(id)) armed.delete(id);
  };

  const subscribe = () => {
    ctx.quotes.setSubscriptions(
      OWNER,
      alertContracts(alerts).map((contract) => ({ contract, profile: 'basic' as const })),
    );
  };

  /** Persists through the store (which validates) and broadcasts what was actually stored. */
  const persist = (next: PriceAlert[]) => {
    ctx.store.setPriceAlerts(next);
    const stored = ctx.store.getPriceAlerts();
    alerts = Array.isArray(stored) ? stored : next;
    ctx.emit({ type: 'priceAlerts', alerts });
  };

  const onQuote = (q: Quote) => {
    const list = byKey.get(q.key);
    if (!list?.length) return;
    const price = lastOrMid(q);
    if (price == null) return;
    const fired: PriceAlert[] = [];
    for (const a of list) {
      const r = evaluateAlert(a, price, isArmed(a));
      armed.set(a.id, { sig: alertSignature(a), armed: r.armed });
      if (r.fire) fired.push(a);
    }
    if (!fired.length) return;

    const now = Date.now();
    const firedIds = new Set(fired.map((a) => a.id));
    const next = alerts.map((a) => (firedIds.has(a.id) ? { ...a, lastTriggeredAt: now, active: a.repeat ? a.active : false } : a));
    for (const a of next) if (firedIds.has(a.id)) armed.set(a.id, { sig: alertSignature(a), armed: false });
    persist(next);
    index();
    if (fired.some((a) => !a.repeat)) subscribe();
    for (const a of fired) {
      const { title, body } = alertTexts(a, price, q.close);
      try {
        ctx.notifier.notify({ kind: 'price', title, body, contract: a.contract });
      } catch (err) {
        console.error('[alerts] notify failed:', err);
      }
    }
  };

  afterStartup(() => {
    const stored = ctx.store.getPriceAlerts();
    alerts = Array.isArray(stored) ? stored : [];
    index();
    started = true;
    subscribe();
    ctx.quotes.onQuote(onQuote);
  });

  return {
    save(next: PriceAlert[]) {
      const list = Array.isArray(next) ? next.filter((a) => a && a.id && a.contract?.symbol) : [];
      persist(list);
      index();
      subscribe();
      // Alerts whose condition is already met fire right away (the dialog says so).
      for (const key of byKey.keys()) {
        const q = ctx.quotes.getQuote(key);
        if (q) onQuote(q);
      }
    },
  };
}
