// The latest order sent from each floating panel (features/panels): its status strip and its
// collapsed bar follow it from "Submitting…" to IB's live status. Orders sent from anywhere else
// (the docked ticket and strategy builder) keep their toasts; while one of them waits for IB,
// `dockedSending` holds their buttons and ⏎ back, as a panel's own order does for that panel.
// Written by orderActions.ts; the live status comes from the store's orders.
// The strips belong to the connection session they were sent on: they go when Tape moves to
// another account or Gateway (state/sessionReset.ts).

import { create } from 'zustand';
import type { PanelId } from '../features/panels/model';
import type { OrderAction } from '@shared/types';

export interface SentOrder {
  /** Increments per send: a newer order replaces the strip. */
  seq: number;
  kind: 'place' | 'modify';
  /**
   * Waiting for IB's answer, accepted (or sent and not confirmed yet), refused (IB's reason in
   * `error`), or unconfirmed: the socket closed after the order was written, so IB may have it
   * (`error` says to check Orders before sending it again).
   */
  phase: 'sending' | 'sent' | 'failed' | 'unconfirmed';
  /** "Buy 100 AAPL · LMT 227.56 · DAY". */
  summary: string;
  side: OrderAction;
  quantity: number;
  /** contractKey of the instrument (the position line). */
  contractKey: string;
  /** Position in that instrument when the order was sent ("200 → 300" once filled). */
  positionBefore: number;
  orderId?: number;
  clientId?: number;
  /** The account the order was sent to (the connected one then): an order of another account with the same ids is not this one. */
  account?: string;
  error?: string;
  /** When IB accepted it (ms; the new order's highlight in the Trade page's activity panel: chart/activityModel.ts). */
  acceptedAt?: number;
  /** The panel collapsed to its bar when this order was accepted. */
  autoCollapsed?: boolean;
}

interface FeedbackState {
  sent: Partial<Record<PanelId, SentOrder>>;
  /** An order or modify sent from no floating panel (the docked ticket or builder) waits for IB's answer. */
  dockedSending: boolean;
  setDockedSending(sending: boolean): void;
  begin(id: PanelId, order: Omit<SentOrder, 'seq' | 'phase'>): number;
  /** Updates the order `seq` of panel `id` (nothing when a newer one replaced it). */
  update(id: PanelId, seq: number, patch: Partial<SentOrder>): void;
  dismiss(id: PanelId): void;
  /** Drops every panel's strip (Tape moved to another account or Gateway). */
  clear(): void;
}

let seq = 0;

export const useOrderFeedback = create<FeedbackState>()((set) => ({
  sent: {},
  dockedSending: false,
  setDockedSending: (dockedSending) => set({ dockedSending }),
  begin: (id, order) => {
    seq += 1;
    const next: SentOrder = { ...order, seq, phase: 'sending' };
    set((s) => ({ sent: { ...s.sent, [id]: next } }));
    return seq;
  },
  update: (id, n, patch) =>
    set((s) => {
      const cur = s.sent[id];
      return cur && cur.seq === n ? { sent: { ...s.sent, [id]: { ...cur, ...patch } } } : s;
    }),
  dismiss: (id) =>
    set((s) => {
      if (!s.sent[id]) return s;
      const sent = { ...s.sent };
      delete sent[id];
      return { sent };
    }),
  clear: () => set((s) => (Object.keys(s.sent).length ? { sent: {} } : s)),
}));

/** Whether a floating panel waits for IB's answer to its order (its submit button is disabled). */
export const isSending = (id: PanelId) => (s: FeedbackState): boolean => s.sent[id]?.phase === 'sending';

/** Whether an order sent from the docked ticket or strategy builder waits for IB (their buttons are disabled). */
export const isDockedSending = (s: FeedbackState): boolean => s.dockedSending;

/**
 * Whether the order last sent from panel `id` still waits for IB; without `id` (the docked ticket
 * and builder), whether theirs does: a second ⏎ or click then sends nothing.
 */
export const isPanelSending = (id: PanelId | undefined): boolean => {
  const s = useOrderFeedback.getState();
  return id != null ? isSending(id)(s) : isDockedSending(s);
};
