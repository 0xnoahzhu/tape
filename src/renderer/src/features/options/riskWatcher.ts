// Background evaluation of option risk alerts while connected: keeps greeks subscribed for
// option positions and raises an in-app / OS notification (kind "opt") the first time an
// alert appears — once per contract for expiries, once per day for the other rules.
// Informational alerts (underlying moves, long-option losses) stay in the bell panel only.

import { contractKey, contractLabel } from '@shared/contract';
import { ymd } from '@shared/format';
import type { QuoteSubscription } from '@shared/types';
import { setQuoteSubscriptions } from '../../state/quoteSubscriptions';
import { useStore } from '../../state/store';
import { useM } from './messages';
import { computeRiskAlerts, isOptionPosition, quotableContract, underlyingFor, type RiskAlert } from './risk';
import { riskMessage } from './RiskAlerts';

const OWNER = 'options-risk';
const STORAGE_KEY = 'tape.options.riskNotified';
const MAX_REMEMBERED = 300;
const EVALUATE_MS = 2_000;

let started = false;

function remembered(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function remember(map: Record<string, string>): void {
  try {
    const entries = Object.entries(map).slice(-MAX_REMEMBERED);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage unavailable: notifications may repeat after a restart.
  }
}

function notifyNew(alerts: RiskAlert[]): void {
  const due = alerts.filter((a) => a.severity !== 'info');
  if (!due.length) return;
  const map = remembered();
  const today = ymd(Date.now());
  let changed = false;
  for (const a of due) {
    const stamp = a.rule === 'exp' ? 'once' : today;
    if (map[a.id] === stamp) continue;
    map[a.id] = stamp;
    changed = true;
    const label = contractLabel(a.position.contract);
    const en = useM.for('en');
    const zh = useM.for('zh');
    void window.tape
      .notify({
        kind: 'opt',
        title: { en: en.notifTitle(label), zh: zh.notifTitle(label) },
        body: { en: riskMessage(a, en), zh: riskMessage(a, zh) },
        contract: underlyingFor(a.position.contract.symbol, useStore.getState().watchlists),
      })
      .catch(() => undefined);
  }
  if (changed) remember(map);
}

export function startRiskWatcher(): void {
  if (started || typeof window === 'undefined' || !window.tape) return;
  started = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let signature = '';

  const evaluate = () => {
    timer = null;
    const s = useStore.getState();
    if (!s.ready || s.connection.status !== 'connected') {
      signature = '';
      return;
    }
    const options = s.positions.filter(isOptionPosition);
    const underlyings = [...new Set(options.map((p) => p.contract.symbol))].map((sym) => underlyingFor(sym, s.watchlists));
    const subs: QuoteSubscription[] = [
      ...options.map((p) => ({ contract: quotableContract(p.contract), profile: 'option' as const })),
      ...underlyings.map((c) => ({ contract: c, profile: 'basic' as const })),
    ];
    const sig = subs.map((x) => contractKey(x.contract) + '|' + x.profile).join(',');
    if (sig !== signature) {
      signature = sig;
      // Through the renderer's owner list, so the quotes it reads are kept while it wants them.
      void setQuoteSubscriptions(OWNER, subs).catch(() => undefined);
    }
    if (!options.length) return;
    notifyNew(computeRiskAlerts(options, s.quotes, (p) => s.quotes[contractKey(underlyingFor(p.contract.symbol, s.watchlists))]));
  };

  useStore.subscribe((st, prev) => {
    if (st.positions === prev.positions && st.quotes === prev.quotes && st.connection === prev.connection && st.ready === prev.ready) return;
    timer ??= setTimeout(evaluate, EVALUATE_MS);
  });
}
