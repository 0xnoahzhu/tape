// The latest order sent from each floating panel (features/panels): its status strip and its
// collapsed bar follow it from "Submitting…" to IB's live status. Orders sent from anywhere else
// keep their toasts. Written by orderActions.ts; the live status comes from the store's orders.

import { create } from 'zustand';
import type { PanelId } from '../features/panels/model';
import type { OrderAction } from '@shared/types';

export interface SentOrder {
  /** Increments per send: a newer order replaces the strip. */
  seq: number;
  kind: 'place' | 'modify';
  /** Waiting for IB's answer, accepted, or refused (IB's reason in `error`). */
  phase: 'sending' | 'sent' | 'failed';
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
  error?: string;
  /** When IB accepted it (ms; the new order's highlight in the Trade page's activity panel: chart/activityModel.ts). */
  acceptedAt?: number;
  /** The panel collapsed to its bar when this order was accepted. */
  autoCollapsed?: boolean;
}

interface FeedbackState {
  sent: Partial<Record<PanelId, SentOrder>>;
  begin(id: PanelId, order: Omit<SentOrder, 'seq' | 'phase'>): number;
  /** Updates the order `seq` of panel `id` (nothing when a newer one replaced it). */
  update(id: PanelId, seq: number, patch: Partial<SentOrder>): void;
  dismiss(id: PanelId): void;
}

let seq = 0;

export const useOrderFeedback = create<FeedbackState>()((set) => ({
  sent: {},
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
}));

/** Whether a floating panel waits for IB's answer to its order (its submit button is disabled). */
export const isSending = (id: PanelId) => (s: FeedbackState): boolean => s.sent[id]?.phase === 'sending';

/** Whether the order last sent from panel `id` still waits for IB (false for the docked panels: no `id`). */
export const isPanelSending = (id: PanelId | undefined): boolean => id != null && isSending(id)(useOrderFeedback.getState());
