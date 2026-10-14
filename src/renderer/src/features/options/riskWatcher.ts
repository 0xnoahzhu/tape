// Background evaluation of option risk alerts while connected: keeps greeks subscribed for
// option positions and raises an in-app / OS notification (kind "opt") the first time an
// alert appears — once per account and contract for expiries, once per day for the other rules.
// The notification names the account (paper or live, and its id unless account ids are hidden).
// Informational alerts (underlying moves, long-option losses) stay in the bell panel only.

import { contractKey, contractLabel } from '@shared/contract';
import { ymd } from '@shared/format';
import type { QuoteSubscription } from '@shared/types';
import { setQuoteSubscriptions } from '../../state/quoteSubscriptions';
import { useStore } from '../../state/store';
import { useM, type DeskMessages } from './messages';
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

/** The notification title: the contract and the account the position is in. */
export function riskNotifTitle(a: RiskAlert, m: DeskMessages, paper: boolean, showAccountId: boolean): string {
  const account = m.notifAccount(paper, showAccountId ? a.position.account : '');
  return m.notifTitle(`${contractLabel(a.position.contract)} · ${account}`);
}

/**
 * The alerts to notify now, recorded in `notified` (alert id → the stamp it was notified under: 'once'
 * for an expiry, the day for the other rules); `changed` when `notified` changed. A notice stored
 * under the id it had before ids named the account (`rule:contractKey`) counts as given: its stamp
 * moves to the new id, and the old key goes (after all alerts, so every account holding the contract
 * is covered, as the old per-contract id was) so it cannot silence another account's notice later.
 */
export function dueRiskNotices(due: RiskAlert[], notified: Record<string, string>, today: string): { notify: RiskAlert[]; changed: boolean } {
  const notify: RiskAlert[] = [];
  const legacyUsed = new Set<string>();
  let changed = false;
  for (const a of due) {
    const stamp = a.rule === 'exp' ? 'once' : today;
    if (notified[a.id] === stamp) continue;
    notified[a.id] = stamp;
    changed = true;
    const legacy = `${a.rule}:${contractKey(a.position.contract)}`;
    if (notified[legacy] === stamp) legacyUsed.add(legacy);
    else notify.push(a);
  }
  for (const k of legacyUsed) delete notified[k];
  return { notify, changed };
}

function notifyNew(alerts: RiskAlert[]): void {
  const due = alerts.filter((a) => a.severity !== 'info');
  if (!due.length) return;
  const map = remembered();
  const { notify, changed } = dueRiskNotices(due, map, ymd(Date.now()));
  const s = useStore.getState();
  // The positions are the connected login's: paper or live is the login's.
  const paper = s.connection.isPaper;
  const showId = s.settings.appearance.showAccountId;
  for (const a of notify) {
    const en = useM.for('en');
    const zh = useM.for('zh');
    void window.tape
      .notify({
        kind: 'opt',
        title: { en: riskNotifTitle(a, en, paper, showId), zh: riskNotifTitle(a, zh, paper, showId) },
        body: { en: riskMessage(a, en), zh: riskMessage(a, zh) },
        contract: underlyingFor(a.position.contract.symbol, s.watchlists),
        // Risk (assignment, a short option's loss), not the expiry reminder: comes through do-not-disturb.
        ...(a.rule !== 'exp' && { critical: true as const }),
        ...(a.position.account ? { account: a.position.account } : {}),
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
