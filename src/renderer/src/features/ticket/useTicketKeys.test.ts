import { describe, expect, it } from 'vitest';
import { index, stock } from '@shared/contract';
import { useStore } from '../../state/store';
import { inTicket, ticketKeyAction, type TicketKey } from './useTicketKeys';

/** A key pressed with the focus on the ticket itself (its root), unless `patch` says otherwise. */
const key = (k: string, patch: Partial<TicketKey> = {}): TicketKey => ({
  key: k,
  repeat: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  defaultPrevented: false,
  editable: false,
  inTicket: true,
  onTicket: true,
  ...patch,
});

/** The focus on the page itself (after a symbol search, a click on the chart or the watchlist). */
const onPage = { inTicket: false, onTicket: false };

const trade = () => ({ ...useStore.getState(), page: 'trade' as const, symbol: stock('AAPL'), pendingOrder: null, confirm: null, bellOpen: false });

describe('the order ticket’s keys', () => {
  it('act with the focus in the ticket: B / S pick the side, ↑ / ↓ the size, ⏎ opens the review', () => {
    const s = trade();
    expect(ticketKeyAction(key('b'), s)).toBe('buy');
    expect(ticketKeyAction(key('S'), s)).toBe('sell');
    expect(ticketKeyAction(key('ArrowUp'), s)).toBe('qtyUp');
    expect(ticketKeyAction(key('ArrowDown'), s)).toBe('qtyDown');
    expect(ticketKeyAction(key('Enter'), s)).toBe('submit');
    // On a control in the ticket (the side switch, a chip): B / S still work there.
    expect(ticketKeyAction(key('s', { onTicket: false }), s)).toBe('sell');
  });

  it('never act with the focus on the page: typing “spcx” after a search flips nothing and sends nothing', () => {
    const s = trade();
    for (const k of ['s', 'p', 'c', 'x', 'b', 'ArrowUp', 'ArrowDown', 'Enter']) expect(ticketKeyAction(key(k, onPage), s)).toBeNull();
  });

  it('leave ⏎ on a control in the ticket to that control, and never act on a held ⏎', () => {
    const s = trade();
    expect(ticketKeyAction(key('Enter', { onTicket: false }), s)).toBeNull();
    expect(ticketKeyAction(key('Enter', { repeat: true }), s)).toBeNull();
  });

  it('do nothing in a text field, with a modifier, while composing, or when something handled the key', () => {
    const s = trade();
    expect(ticketKeyAction(key('b', { editable: true, onTicket: false }), s)).toBeNull();
    expect(ticketKeyAction(key('b', { metaKey: true }), s)).toBeNull();
    expect(ticketKeyAction(key('b', { altKey: true }), s)).toBeNull();
    expect(ticketKeyAction(key('b', { isComposing: true }), s)).toBeNull();
    expect(ticketKeyAction(key('Enter', { defaultPrevented: true }), s)).toBeNull();
  });

  it('wait while a dialog, the bell or the lock screen has the keys, off the Trade page and for an index', () => {
    const s = trade();
    expect(ticketKeyAction(key('Enter'), { ...s, confirm: { title: '', rows: [], label: '', run: () => undefined } })).toBeNull();
    expect(ticketKeyAction(key('b'), { ...s, bellOpen: true })).toBeNull();
    expect(ticketKeyAction(key('b'), { ...s, lock: { ...s.lock, locked: true } })).toBeNull();
    expect(ticketKeyAction(key('b'), { ...s, page: 'acct' })).toBeNull();
    expect(ticketKeyAction(key('b'), { ...s, symbol: index('SPX', 'CBOE') })).toBeNull();
  });

  it('keep a modified order’s side and size (⏎ still opens its review)', () => {
    const s = { ...trade(), ticket: { ...trade().ticket, modifyingOrderId: 31 } };
    for (const k of ['b', 's', 'ArrowUp', 'ArrowDown']) expect(ticketKeyAction(key(k), s)).toBeNull();
    expect(ticketKeyAction(key('Enter'), s)).toBe('submit');
  });

  it('know the ticket by its root: the docked ticket’s or the floating ticket’s panel', () => {
    const el = (match: string | null) => ({ closest: (sel: string) => (match && sel.includes(match) ? {} : null) }) as unknown as Element;
    expect(inTicket(el('data-ticket-keys'))).toBe(true);
    expect(inTicket(el('data-panel-root="ticket"'))).toBe(true);
    expect(inTicket(el(null))).toBe(false);
    expect(inTicket(null)).toBe(false);
  });
});
