import { beforeEach, describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import { defaultSettings } from '@shared/defaults';
import type { ContractRef, Settings, WorkingOrder } from '@shared/types';
import { ticketPatchFromOrder } from '../features/orders/model';
import { defaultQtyFor, initialTicket, tradeDefaultsPatch, useStore, type TicketState } from './store';

const settings = defaultSettings();
const aapl = stock('AAPL');
const call: ContractRef = option('AAPL', '20261016', 230, 'C');

/** A ticket without its condition rows' React keys (each fresh ticket numbers its own). */
const unkeyed = (t: TicketState) => ({ ...t, conds: t.conds.map(({ id: _id, ...c }) => c) });

/** The Trade page on AAPL with a fresh ticket. */
function onAapl(): void {
  useStore.setState({ settings, symbol: aapl, symbolName: 'Apple', ticket: initialTicket(settings, aapl) });
}

describe('the ticket’s size for an instrument', () => {
  it('starts options, futures, warrants and combos at 1 contract, everything else at the default size', () => {
    expect(defaultQtyFor(aapl, settings)).toBe(100);
    expect(defaultQtyFor(call, settings)).toBe(1);
    for (const secType of ['FOP', 'FUT', 'WAR', 'BAG'] as const) expect(defaultQtyFor({ secType }, settings)).toBe(1);
    expect(defaultQtyFor(aapl, { trading: { ...settings.trading, defaultQty: 10 } })).toBe(10);
    expect(initialTicket(settings, call).qty).toBe(1);
    expect(initialTicket(settings).qty).toBe(100);
  });
});

describe('selecting an instrument', () => {
  beforeEach(onAapl);

  it('starts another instrument at its default size and Buy, so a stock’s size never becomes option contracts', () => {
    useStore.getState().patchTicket({ qty: 300, side: 'SELL', limitPrice: 230 });
    useStore.getState().selectSymbol(call);
    expect(useStore.getState().ticket).toMatchObject({ qty: 1, side: 'BUY', limitPrice: null });
    useStore.getState().patchTicket({ qty: 5 });
    useStore.getState().selectSymbol(stock('MSFT'));
    expect(useStore.getState().ticket).toMatchObject({ qty: 100, side: 'BUY' });
  });

  it('keeps what the user set up when the same instrument is selected again (only typed prices go)', () => {
    useStore.getState().patchTicket({ qty: 300, side: 'SELL', limitPrice: 230, tif: 'GTC' });
    useStore.getState().selectSymbol(stock('AAPL'));
    expect(useStore.getState().ticket).toMatchObject({ qty: 300, side: 'SELL', tif: 'GTC', limitPrice: null });
  });

  it('ends a modify with a fresh ticket: nothing loaded from the working order carries over', () => {
    useStore.getState().patchTicket({ ...ticketPatchFromOrder(working()), modifyingOrderId: 31 });
    expect(useStore.getState().ticket).toMatchObject({ oca: true, ocaGroup: 'tp-sl', orderRef: 'scale out' });
    useStore.getState().selectSymbol(stock('AAPL'));
    expect(unkeyed(useStore.getState().ticket)).toEqual(unkeyed(initialTicket(settings, aapl)));
  });
});

describe('ending a modify', () => {
  beforeEach(onAapl);

  it('after the modify or “Cancel modify”, starts a fresh ticket for the instrument', () => {
    useStore.getState().patchTicket({ ...ticketPatchFromOrder(working()), modifyingOrderId: 31 });
    useStore.getState().endModify();
    const t = useStore.getState().ticket;
    expect(unkeyed(t)).toEqual(unkeyed(initialTicket(settings, aapl)));
    expect(t).toMatchObject({ modifyingOrderId: null, oca: false, ocaGroup: '', condition: false, orderRef: '', algo: null, side: 'BUY', qty: 100 });
    expect(useStore.getState().symbol).toEqual(aapl);
  });

  it('only for the order it was sent for: a Modify started meanwhile stays', () => {
    useStore.getState().patchTicket({ ...ticketPatchFromOrder(working()), modifyingOrderId: 32 });
    useStore.getState().endModify(31);
    expect(useStore.getState().ticket).toMatchObject({ modifyingOrderId: 32, ocaGroup: 'tp-sl' });
  });

  it('leaves a ticket that modifies nothing alone', () => {
    useStore.getState().patchTicket({ qty: 300 });
    useStore.getState().endModify();
    expect(useStore.getState().ticket.qty).toBe(300);
  });
});

describe('Settings › Trade defaults on the open ticket', () => {
  const trading = (patch: Partial<Settings['trading']>): Pick<Settings, 'trading'> => ({ trading: { ...settings.trading, ...patch } });
  const ticket = (patch: Partial<ReturnType<typeof initialTicket>> = {}) => ({ ...initialTicket(settings, aapl), ...patch });

  it('apply where the ticket still has the previous default', () => {
    expect(tradeDefaultsPatch({ symbol: aapl, ticket: ticket() }, trading({}), trading({ defaultQty: 500 }))).toEqual({ qty: 500 });
    expect(tradeDefaultsPatch({ symbol: aapl, ticket: ticket() }, trading({}), trading({ outsideRthDefault: true }))).toEqual({ session: 'extended' });
  });

  it('leave a size typed or a session chosen on the ticket, an option’s size and a modify alone', () => {
    expect(tradeDefaultsPatch({ symbol: aapl, ticket: ticket({ qty: 10 }) }, trading({}), trading({ defaultQty: 500 }))).toEqual({});
    expect(tradeDefaultsPatch({ symbol: aapl, ticket: ticket({ session: 'overnight' }) }, trading({}), trading({ outsideRthDefault: true }))).toEqual({});
    expect(tradeDefaultsPatch({ symbol: call, ticket: { ...initialTicket(settings, call) } }, trading({}), trading({ defaultQty: 500 }))).toEqual({});
    expect(tradeDefaultsPatch({ symbol: aapl, ticket: ticket({ modifyingOrderId: 31 }) }, trading({}), trading({ defaultQty: 500 }))).toEqual({});
  });
});

/** A working AAPL order in an OCA group, with a note: what Modify loads into the ticket. */
function working(): WorkingOrder {
  return {
    orderId: 31,
    clientId: 7,
    key: '7:31',
    contract: aapl,
    action: 'SELL',
    orderType: 'LMT',
    totalQuantity: 40,
    limitPrice: 240,
    tif: 'GTC',
    outsideRth: false,
    status: 'Submitted',
    filled: 0,
    remaining: 40,
    avgFillPrice: 0,
    createdAt: 0,
    updatedAt: 0,
    oca: { group: 'tp-sl', type: 1 },
    orderRef: 'scale out',
  };
}
