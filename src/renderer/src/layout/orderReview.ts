// The order review's content and its Confirm arming, kept free of React so they can be tested
// (layout/Dialogs.tsx → OrderConfirmDialog draws them). The review is the only way an order,
// modify or strategy is sent (state/orderActions.ts → submitOrder): it names the account first
// (PAPER / LIVE), lists the order, and adds red rows for prices that are not live and for what the
// pre-trade checks found (features/ticket/orderRisk.ts), which the user ticks off before Confirm.

import { f0, f2 } from '@shared/format';
import { useCommon } from '../i18n/common';
import { accountRow } from '../lib/account';
import type { ConfirmRow, PendingOrder } from '../state/store';
import type { OrderRisk } from '../features/ticket/orderRisk';
import { money } from '../features/ticket/ticketModel';

/**
 * How long a confirming button stays inert after it becomes available (the review's Confirm for
 * each new order or once its warnings are ticked off, a danger confirmation's button, Cancel all's
 * once its check box is ticked), so a click or ⏎ meant for something before it does not confirm.
 */
export const CONFIRM_ARM_MS = 600;

/** "Confirm order", or "Modify order #58". */
export function reviewTitle(p: Pick<PendingOrder, 'modifyOrderId'>): string {
  const m = useCommon.now();
  return p.modifyOrderId != null ? m.modifyOrderN(p.modifyOrderId) : m.confirmOrder;
}

/** "Confirm Buy" (zh "确认买入"), or "Confirm modify #58". */
export function confirmLabel(p: Pick<PendingOrder, 'modifyOrderId' | 'label'>): string {
  const m = useCommon.now();
  return p.modifyOrderId != null ? m.confirmModify(p.modifyOrderId) : m.confirmSide(p.label);
}

/** The review's rows: the account the order goes to (paper or live, live in red), then the order's. */
export function reviewRows(p: Pick<PendingOrder, 'rows' | 'account' | 'isPaper'>, showAccountId: boolean): ConfirmRow[] {
  return [accountRow(p.isPaper, p.account, showAccountId), ...p.rows];
}

/** Signed position for the risk rows: "100", "−400". */
const qty = (n: number) => f0(n);

/** One red row per pre-trade risk (amounts in the account currency); a check that could not run, one per missing input. */
export function riskRows(risks: readonly OrderRisk[]): ConfirmRow[] {
  const m = useCommon.now();
  const r = m.risk;
  const red = (label: string, value: string): ConfirmRow => ({ label, value, color: 'var(--r)', prose: true });
  return risks.flatMap((k): ConfirmRow | ConfirmRow[] => {
    switch (k.kind) {
      case 'heldOrders':
        return red(r.held, r.heldOrders(k.count));
      case 'opensShort':
        return red(r.position, (k.before < 0 ? r.addsShort : r.opensShort)(qty(k.before), qty(k.after)));
      case 'flips':
        return red(r.position, (k.before > 0 ? r.flipsShort : r.flipsLong)(qty(k.before), qty(k.after)));
      case 'largeNotional':
        return red(r.size, r.largeNotional(money(k.amount, k.currency), `${f0((k.amount / k.netLiq) * 100)}%`));
      case 'overBuyingPower':
        return red(r.buyingPower, r.overBuyingPower(money(k.amount, k.currency), money(k.buyingPower, k.currency)));
      case 'farThroughMarket': {
        const by = `${f2(k.pct, 1)}%`;
        const limit = f2(k.limit, decimals(k.limit));
        const ref = f2(k.market, decimals(k.market));
        const text = k.ref === 'last' ? (k.side === 'BUY' ? r.aboveLast : r.belowLast) : k.side === 'BUY' ? r.aboveAsk : r.belowBid;
        return red(r.limit, text(limit, ref, by));
      }
      case 'marketOnStaleData':
        return red(m.marketData, (k.market ? r.marketStale : r.priceStale)(m.staleData[k.data]));
      case 'unchecked':
        return k.missing.map((what) =>
          red(r.unchecked, what === 'positions' ? r.noPositions : what === 'account' ? r.noAccount : r.noRate(k.currency ?? '?', k.accountCurrency ?? '?')),
        );
    }
  });
}

/** Prices under a dollar keep four decimals (an option at 0.0450). */
const decimals = (n: number) => (Math.abs(n) < 1 ? 4 : 2);

/**
 * The red rows under the order: prices that are not live (PendingOrder.marketData), then the
 * pre-trade risks. A market order (or a price from the bid / ask) on such prices is a risk of its
 * own, which needs the tick: its row then says what the prices are instead.
 */
export function warningRows(p: Pick<PendingOrder, 'marketData' | 'risks'>): ConfirmRow[] {
  const m = useCommon.now();
  const risks = p.risks ?? [];
  const rows: ConfirmRow[] = [];
  if (p.marketData && p.marketData !== 'live' && !risks.some((k) => k.kind === 'marketOnStaleData')) {
    const word = m.staleData[p.marketData];
    rows.push({ label: m.marketData, value: p.marketData === 'none' ? m.noDataNote(word) : m.staleNote(word), color: 'var(--r)', prose: true });
  }
  return [...rows, ...riskRows(risks)];
}

/** The user has to tick "I have checked these warnings" before Confirm arms. */
export const needsAcknowledgement = (p: Pick<PendingOrder, 'risks'>): boolean => (p.risks?.length ?? 0) > 0;

/**
 * Whether the review's Confirm may arm (CONFIRM_ARM_MS later): a modify that changes nothing
 * never does, an order with risks only once they are acknowledged, and none while the connection
 * cannot carry it (`held`: not connected, or TWS / IB Gateway lost IB, 1100, or does not answer; it
 * arms once that is over).
 */
export const mayArm = (p: Pick<PendingOrder, 'risks' | 'unchanged'>, acknowledged: boolean, held = false): boolean =>
  !held && !p.unchanged && (acknowledged || !needsAcknowledgement(p));

/**
 * What a keydown does while the review (or a danger confirmation) is open, in the capture phase,
 * before anything else sees it: 'pass' (not ⏎, or composing text), 'block' (preventDefault, which
 * also stops a focused button's native click), 'native' (the focused control handles ⏎ itself) or
 * 'confirm' (nothing focused handles it: the dialog confirms).
 *
 * `target`: where ⏎ goes — the dialog's Confirm (focused on open), another control that handles ⏎
 * (Cancel after Tab, a link) or none. A held ⏎ never acts: its first keystroke submitted the order
 * for review. Confirm, focused or not, acts only once armed (CONFIRM_ARM_MS after it became
 * available), so a ⏎ meant for something before the dialog never confirms; another control works
 * at once (Cancel closes).
 */
export type EnterAction = 'pass' | 'block' | 'native' | 'confirm';

export function enterAction(e: { key: string; repeat: boolean; isComposing: boolean }, armed: boolean, target: 'confirm' | 'other' | 'none'): EnterAction {
  if (e.key !== 'Enter' || e.isComposing) return 'pass';
  if (e.repeat) return 'block';
  if (target === 'other') return 'native';
  if (!armed) return 'block';
  return target === 'confirm' ? 'native' : 'confirm';
}
