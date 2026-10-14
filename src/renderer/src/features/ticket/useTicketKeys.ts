// Trading shortcuts of the order ticket: B buy, S sell, ↑ / ↓ quantity, Enter submit. They belong to
// the ticket, not the page: they act only while the focus is in the docked ticket (its root carries
// TICKET_KEYS_ATTR and takes the focus when pressed, OrderTicket.tsx) or in the floating ticket's
// panel, never with the focus on the page itself. Typing "spcx" after a symbol search or a click on
// the chart or the watchlist therefore never flips the side or submits.

import { useEffect, useRef } from 'react';
import { isTradable } from '@shared/contract';
import { isCovered, isDialogOpen, useStore, type StoreState } from '../../state/store';
import { stepQty } from './ticketModel';

/** The docked ticket's root: a press in it gives it the keys. */
export const TICKET_KEYS_ATTR = 'data-ticket-keys';

/** Where the ticket's keys work: the docked ticket, or the floating ticket's panel (its root or anything in it). */
const TICKET_SELECTOR = `[${TICKET_KEYS_ATTR}],[data-panel-root="ticket"]`;

/** The key goes to the order ticket (anything in it, the ticket itself included). */
export function inTicket(t: EventTarget | null): boolean {
  const el = t as Element | null;
  return !!el && typeof el.closest === 'function' && el.closest(TICKET_SELECTOR) != null;
}

/** The key goes to the ticket itself, no control in it: the docked ticket's root or the floating ticket's panel. */
function onTicket(t: EventTarget | null): boolean {
  const el = t as Element | null;
  return !!el && typeof el.matches === 'function' && el.matches(TICKET_SELECTOR);
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** A keydown as the ticket's shortcuts see it. */
export interface TicketKey {
  key: string;
  repeat: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  /** The key types in a text field. */
  editable: boolean;
  /** The focus is in the ticket (inTicket). */
  inTicket: boolean;
  /** The focus is on the ticket itself, no control in it: only then is ⏎ the ticket's. */
  onTicket: boolean;
}

export type TicketKeyAction = 'buy' | 'sell' | 'qtyUp' | 'qtyDown' | 'submit';

type TicketKeyState = Pick<
  StoreState,
  'page' | 'bellOpen' | 'symbol' | 'ticket' | 'pendingOrder' | 'confirm' | 'cancelAll' | 'alertForm' | 'pinDialog' | 'lock' | 'unlocking'
>;

/**
 * What a key does to the ticket, or null. Only with the focus in the ticket (not the page, not a
 * text field), on the Trade page with no dialog or notifications panel open and the lock screen
 * down. While an order is modified, B / S (IB keeps its side) and ↑ / ↓ do nothing: a stray ↑ would
 * resize a working order (its quantity changes in the field, where the review shows before → after).
 * ⏎ only on the ticket itself (⏎ on a control in it belongs to that control) and never held: it opens
 * the review; the review's own ⏎ confirms once it has armed (layout/Dialogs.tsx).
 */
export function ticketKeyAction(e: TicketKey, s: TicketKeyState): TicketKeyAction | null {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return null;
  if (e.editable || !e.inTicket) return null;
  if (s.page !== 'trade' || s.bellOpen || isDialogOpen(s) || isCovered(s)) return null;
  const free = isTradable(s.symbol) && s.ticket.modifyingOrderId == null;
  switch (e.key) {
    case 'b':
    case 'B':
      return free ? 'buy' : null;
    case 's':
    case 'S':
      return free ? 'sell' : null;
    case 'ArrowUp':
      return free ? 'qtyUp' : null;
    case 'ArrowDown':
      return free ? 'qtyDown' : null;
    case 'Enter':
      return e.repeat || !e.onTicket ? null : 'submit';
    default:
      return null;
  }
}

/** The keydown as ticketKeyAction sees it. */
export function ticketKey(e: Pick<KeyboardEvent, 'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing' | 'defaultPrevented' | 'target'>): TicketKey {
  return {
    key: e.key,
    repeat: e.repeat,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    isComposing: e.isComposing,
    defaultPrevented: e.defaultPrevented,
    editable: isEditable(e.target),
    inTicket: inTicket(e.target),
    onTicket: onTicket(e.target),
  };
}

/**
 * Installs the ticket's shortcuts (see ticketKeyAction). `submit` is read through a ref so the
 * listener always sees the latest ticket.
 */
export function useTicketKeys(submit: () => void): void {
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Dialogs handle Enter / Escape themselves and mark the event as handled.
      const s = useStore.getState();
      const action = ticketKeyAction(ticketKey(e), s);
      if (!action) return;
      // A side change drops the prices typed for the other side (as the side switch does).
      if (action === 'buy' || action === 'sell') s.patchTicket({ side: action === 'buy' ? 'BUY' : 'SELL', limitPrice: null, stopPrice: null, limitOffset: null });
      else if (action === 'qtyUp' || action === 'qtyDown') s.patchTicket({ qty: stepQty(s.ticket.qty, action === 'qtyUp' ? 1 : -1) });
      else submitRef.current();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
