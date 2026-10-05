// Popping panels out of their column and back, collapsing them, and the actions that load a
// floating panel (B / S, Modify, a depth level, a chain quote): they expand it from its bar first.
// Docked panels are always shown, so for them these behave exactly as before.

import { isTradable, sameContract } from '@shared/contract';
import type { OrderAction, WorkingOrder } from '@shared/types';
import { ticketPatchFromOrder } from '../orders/model';
import { useStore, type StoreState, type TicketState } from '../../state/store';
import { useDesk } from '../options/deskStore';
import type { PanelId } from './model';
import { usePanels } from './panelStore';

/**
 * Whether panel `id` is on screen with the page as it is (docked or floating): the ticket in
 * Trade › Chart and Depth, the strategy builder in Trade › Options.
 */
export function panelShown(id: PanelId, s: Pick<StoreState, 'page' | 'view'>): boolean {
  if (s.page !== 'trade') return false;
  const options = s.view === 'opt';
  return id === 'strategy' ? options : !options;
}

/** Pops a panel out: it floats over the page and its column goes. */
export function popOut(id: PanelId): void {
  usePanels.getState().setFloating(id, true);
}

/** Puts a floating panel back in its column (its state lives in the stores, so nothing is lost). */
export function dockBack(id: PanelId): void {
  usePanels.getState().setFloating(id, false);
  // The docked builder has no net price control: it sends at the legs' price again.
  if (id === 'strategy') useDesk.getState().patch({ netPrice: null });
}

export function setCollapsed(id: PanelId, collapsed: boolean): void {
  usePanels.getState().setCollapsed(id, collapsed);
}

/**
 * The floating panel the user works in now, for Esc with nothing focused (shortcuts.ts →
 * escapePanel): the one pressed in or expanded last, until a press elsewhere on the page.
 */
let keysOwner: PanelId | null = null;

export const panelKeysOwner = (): PanelId | null => keysOwner;

export function claimPanelKeys(id: PanelId | null): void {
  keysOwner = id;
}

/** A floating panel expands from its bar (nothing when docked or already expanded) and takes Esc. */
export function revealPanel(id: PanelId): void {
  const panels = usePanels.getState();
  if (!panels.panels[id].floating) return;
  panels.setCollapsed(id, false);
  claimPanelKeys(id);
}

/** Loads `patch` into the order ticket; a floating ticket expands to show it. */
export function openTicket(patch: Partial<TicketState>): void {
  useStore.getState().patchTicket(patch);
  revealPanel('ticket');
}

/**
 * Modify of a working order in the ticket (the activity panel, a floating ticket's working orders and
 * its status strip): the ticket trades the selected instrument, so the order's own contract is
 * selected first when it is another one (a stock order keeps the underlying's name; an option order
 * selects the option), then the order loads and a floating ticket expands with it.
 */
export function modifyOrderInTicket(o: WorkingOrder): void {
  const s = useStore.getState();
  if (!sameContract(o.contract, s.symbol)) {
    const sameUnderlying = o.contract.secType === s.symbol.secType && o.contract.symbol === s.symbol.symbol;
    s.selectSymbol(o.contract, sameUnderlying ? s.symbolName : undefined);
  }
  openTicket(ticketPatchFromOrder(o));
}

/** B / S on the ticket's bar (its buttons or the keys): that side, and the panel expands. */
export function barSide(side: OrderAction): void {
  const s = useStore.getState();
  if (!isTradable(s.symbol) || s.ticket.modifyingOrderId != null) return;
  s.patchTicket({ side, limitPrice: null, stopPrice: null });
  revealPanel('ticket');
}

/** The strategy panel's "+ Add from the chain": the chain shows, and the panel shrinks to its bar until a quote is picked. */
export function addFromChain(): void {
  const s = useStore.getState();
  s.setPage('trade');
  s.setView('opt');
  useDesk.getState().patch({ tab: 'chain' });
  setCollapsed('strategy', true);
}
