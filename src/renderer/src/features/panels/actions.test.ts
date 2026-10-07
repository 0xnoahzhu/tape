import { beforeEach, describe, expect, it } from 'vitest';
import { index, option, sameContract, stock } from '@shared/contract';
import type { WorkingOrder } from '@shared/types';
import { useStore } from '../../state/store';
import { useDesk } from '../options/deskStore';
import { addFromChain, barSide, dockBack, modifyOrderInTicket, openTicket, panelShown, popOut, revealPanel, setCollapsed } from './actions';
import { usePanels } from './panelStore';

const initial = useStore.getState();
const panel = (id: 'ticket' | 'strategy') => usePanels.getState().panels[id];

beforeEach(() => {
  useStore.setState(initial, true);
  useStore.setState({ page: 'trade', view: 'chart', symbol: stock('AAPL') });
  for (const id of ['ticket', 'strategy'] as const) dockBack(id);
});

describe('where the panels show', () => {
  it('the ticket in Trade › Chart, the strategy builder in Trade › Options', () => {
    const s = useStore.getState();
    expect(panelShown('ticket', s)).toBe(true);
    expect(panelShown('ticket', { ...s, view: 'opt' })).toBe(false);
    expect(panelShown('strategy', { ...s, view: 'opt' })).toBe(true);
    expect(panelShown('strategy', s)).toBe(false);
    expect(panelShown('ticket', { ...s, page: 'acct' })).toBe(false);
  });
});

describe('triggers while floating', () => {
  it('Modify loads the ticket and expands it from its bar', () => {
    popOut('ticket');
    setCollapsed('ticket', true);
    openTicket({ modifyingOrderId: 12, qty: 300, limitPrice: 101.5 });
    expect(useStore.getState().ticket).toMatchObject({ modifyingOrderId: 12, qty: 300, limitPrice: 101.5 });
    expect(panel('ticket').collapsed).toBe(false);
  });

  it('docked, the same actions only load the ticket', () => {
    openTicket({ qty: 300 });
    expect(useStore.getState().ticket.qty).toBe(300);
    expect(panel('ticket')).toMatchObject({ floating: false, collapsed: false });
  });

  it('B / S on the bar pick the side and expand it', () => {
    popOut('ticket');
    setCollapsed('ticket', true);
    useStore.getState().patchTicket({ side: 'BUY', limitPrice: 100 });
    barSide('SELL');
    expect(useStore.getState().ticket).toMatchObject({ side: 'SELL', limitPrice: null });
    expect(panel('ticket').collapsed).toBe(false);
  });

  it('B / S on the bar do nothing for an index or while modifying', () => {
    popOut('ticket');
    setCollapsed('ticket', true);
    useStore.setState({ symbol: index('SPX', 'CBOE') });
    barSide('SELL');
    expect(panel('ticket').collapsed).toBe(true);
    useStore.setState({ symbol: stock('AAPL') });
    useStore.getState().patchTicket({ modifyingOrderId: 4 });
    barSide('SELL');
    expect(panel('ticket').collapsed).toBe(true);
  });

  it('a chain quote expands the strategy builder; "add from the chain" shows the chain and steps aside', () => {
    popOut('strategy');
    useDesk.getState().patch({ tab: 'vol' });
    useStore.setState({ view: 'chart' });
    addFromChain();
    expect(useStore.getState().view).toBe('opt');
    expect(useDesk.getState().tab).toBe('chain');
    expect(panel('strategy').collapsed).toBe(true);
    revealPanel('strategy');
    expect(panel('strategy').collapsed).toBe(false);
  });

  it('dock back puts the panel in its column, expanded', () => {
    popOut('ticket');
    setCollapsed('ticket', true);
    dockBack('ticket');
    expect(panel('ticket')).toMatchObject({ floating: false, collapsed: false });
  });

  it('docking the strategy builder back drops the net price set with its − / + (the docked builder has no such control)', () => {
    popOut('strategy');
    useDesk.getState().patch({ netPrice: 1.23 });
    dockBack('strategy');
    expect(useDesk.getState().netPrice).toBeNull();
  });
});

describe('Modify loads the order’s own contract', () => {
  const order = (contract: WorkingOrder['contract'], orderId = 41): WorkingOrder => ({
    orderId,
    clientId: 7,
    key: `7:${orderId}`,
    contract,
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 2,
    limitPrice: 3.1,
    tif: 'DAY',
    outsideRth: false,
    status: 'Submitted',
    filled: 0,
    remaining: 2,
    avgFillPrice: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  it('an option order shown under the stock selects the option first', () => {
    popOut('ticket');
    setCollapsed('ticket', true);
    const opt = option('AAPL', '20261009', 230, 'C');
    modifyOrderInTicket(order(opt));
    expect(sameContract(useStore.getState().symbol, opt)).toBe(true);
    expect(useStore.getState().ticket).toMatchObject({ modifyingOrderId: 41, qty: 2 });
    expect(panel('ticket').collapsed).toBe(false);
  });

  it('a strip’s order after switching to another symbol selects its symbol again', () => {
    useStore.setState({ symbol: stock('MSFT') });
    modifyOrderInTicket(order(stock('AAPL'), 42));
    expect(useStore.getState().symbol.symbol).toBe('AAPL');
    expect(useStore.getState().ticket.modifyingOrderId).toBe(42);
  });

  it('the selected contract stays selected', () => {
    const before = useStore.getState().symbol;
    modifyOrderInTicket(order(stock('AAPL'), 43));
    expect(useStore.getState().symbol).toBe(before);
    expect(useStore.getState().ticket.modifyingOrderId).toBe(43);
  });

  it('Modify from the options view switches to the chart and loads the order', () => {
    useStore.setState({ view: 'opt' });
    const opt = option('AAPL', '20261009', 230, 'C');
    modifyOrderInTicket(order(opt, 44));
    expect(useStore.getState().view).toBe('chart');
    expect(panelShown('ticket', useStore.getState())).toBe(true);
    expect(sameContract(useStore.getState().symbol, opt)).toBe(true);
    expect(useStore.getState().ticket).toMatchObject({ modifyingOrderId: 44, qty: 2 });
  });
});
