// Trading shortcuts of the order ticket: B buy, S sell, ↑ / ↓ quantity, Enter submit.

import { useEffect, useRef } from 'react';
import { isTradable } from '@shared/contract';
import { useStore } from '../../state/store';
import { stepQty } from './ticketModel';

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/**
 * Active only on the Trade page with no dialog or notifications panel open and focus outside text fields.
 * `submit` is read through a ref so the listener always sees the latest ticket.
 */
export function useTicketKeys(submit: () => void): void {
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Dialogs handle Enter / Escape themselves and mark the event as handled.
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (isEditable(e.target)) return;
      const s = useStore.getState();
      if (s.page !== 'trade' || s.bellOpen || s.pendingOrder || s.confirm || s.alertForm) return;
      const tradable = isTradable(s.symbol);
      switch (e.key) {
        case 'b':
        case 'B':
          if (!tradable) return;
          s.patchTicket({ side: 'BUY', limitPrice: null, stopPrice: null });
          break;
        case 's':
        case 'S':
          if (!tradable) return;
          s.patchTicket({ side: 'SELL', limitPrice: null, stopPrice: null });
          break;
        case 'ArrowUp':
          if (!tradable) return;
          s.patchTicket({ qty: stepQty(s.ticket.qty, 1) });
          break;
        case 'ArrowDown':
          if (!tradable) return;
          s.patchTicket({ qty: stepQty(s.ticket.qty, -1) });
          break;
        case 'Enter':
          // Only with nothing focused: Enter on a focused control belongs to that control.
          if (e.repeat || (e.target !== document.body && e.target !== document.documentElement)) return;
          submitRef.current();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
