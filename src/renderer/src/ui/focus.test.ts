import { describe, expect, it, vi } from 'vitest';
import { giveKeysBack, keysHome } from './focus';

/** A stand-in element: `closest` answers for the selector keysHome asks with `home`. */
function el(home: HTMLElement | null = null) {
  return { closest: vi.fn(() => home) } as unknown as Element;
}
function homeEl(connected = true) {
  return { isConnected: connected, focus: vi.fn() } as unknown as HTMLElement & { focus: ReturnType<typeof vi.fn> };
}
const body = {} as HTMLElement;
const html = {} as HTMLElement;
const doc = (active: Element | null) => ({ activeElement: active, body, documentElement: html });

describe('giving the keys back', () => {
  it('finds the ticket or floating panel an element is in', () => {
    const ticket = homeEl();
    const inTicket = el(ticket);
    expect(keysHome(inTicket)).toBe(ticket);
    expect(inTicket.closest).toHaveBeenCalledWith('[data-ticket-keys],[data-panel-root]');
    // The page or a dialog: nowhere to give them back to.
    expect(keysHome(el(null))).toBeNull();
    expect(keysHome(null)).toBeNull();
  });

  it('focuses the ticket when a closed review or menu left the focus on the page', () => {
    const ticket = homeEl();
    expect(giveKeysBack(ticket, doc(body))).toBe(true);
    expect(ticket.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(giveKeysBack(homeEl(), doc(null))).toBe(true);
    expect(giveKeysBack(homeEl(), doc(html))).toBe(true);
  });

  it('leaves a focus that is somewhere else, and a ticket that is gone', () => {
    const ticket = homeEl();
    // The user clicked into a field (or a dialog focused its own) meanwhile.
    expect(giveKeysBack(ticket, doc({} as Element))).toBe(false);
    expect(ticket.focus).not.toHaveBeenCalled();
    // The floating ticket was docked meanwhile, or nothing was there to begin with.
    expect(giveKeysBack(homeEl(false), doc(body))).toBe(false);
    expect(giveKeysBack(null, doc(body))).toBe(false);
  });
});
