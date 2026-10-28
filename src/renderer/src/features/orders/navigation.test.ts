import { beforeEach, describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import { useStore } from '../../state/store';
import { usePortfolioUi } from '../portfolio/uiState';
import { openNotificationTarget, openOptionChart, openRowChart } from './navigation';

describe('opening a notification', () => {
  const initial = useStore.getState();
  const aapl = stock('AAPL');
  const call = option('AAPL', '20261016', 230, 'C');
  beforeEach(() => {
    useStore.setState({ ...initial, page: 'set', view: 'opt', symbol: stock('MSFT') }, true);
    usePortfolioUi.setState({ tab: 'pos' });
  });

  it('opens a fill in Portfolio › Trades with its instrument selected', () => {
    openNotificationTarget(aapl, 'trades');
    expect(useStore.getState()).toMatchObject({ page: 'acct', symbol: aapl });
    expect(usePortfolioUi.getState().tab).toBe('fill');
  });

  it('opens an order update in Portfolio › Orders', () => {
    openNotificationTarget(call, 'orders');
    expect(useStore.getState()).toMatchObject({ page: 'acct', symbol: call });
    expect(usePortfolioUi.getState().tab).toBe('ord');
  });

  it('opens an option alert in the option chain of the underlying', () => {
    openNotificationTarget(call, 'opt');
    expect(useStore.getState()).toMatchObject({ page: 'trade', view: 'opt', symbol: aapl });
    expect(usePortfolioUi.getState().tab).toBe('pos');
  });

  it('opens anything else in the chart, or in the view the Trade page shows', () => {
    openNotificationTarget(aapl, 'chart');
    expect(useStore.getState()).toMatchObject({ page: 'trade', view: 'chart', symbol: aapl });
    useStore.setState({ page: 'acct', view: 'opt' });
    openNotificationTarget(stock('NVDA'), undefined);
    expect(useStore.getState()).toMatchObject({ page: 'trade', view: 'opt', symbol: stock('NVDA') });
  });
});

describe('opening an option chart', () => {
  const initial = useStore.getState();
  beforeEach(() => {
    useStore.setState({ ...initial, page: 'acct', view: 'opt', symbol: stock('AAPL') }, true);
  });

  it('selects the option itself on Trade › Chart, SMART-routed, with the ticket emptied for it', () => {
    useStore.getState().patchTicket({ limitPrice: 231.5 });
    const held = { ...option('AAPL', '20261016', 230, 'C'), exchange: 'AMEX', conId: 7 };
    openOptionChart(held);
    expect(useStore.getState()).toMatchObject({ page: 'trade', view: 'chart', symbol: { ...held, exchange: 'SMART' } });
    expect(useStore.getState().ticket.limitPrice).toBeNull();
  });
});

describe('opening a list row’s chart', () => {
  const initial = useStore.getState();
  beforeEach(() => {
    useStore.setState({ ...initial, page: 'acct', view: 'opt', symbol: stock('MSFT') }, true);
  });

  it('opens an option order or trade on its own chart, SMART-routed', () => {
    const call = { ...option('AAPL', '20261016', 230, 'C'), exchange: 'CBOE', conId: 7 };
    openRowChart(call);
    expect(useStore.getState()).toMatchObject({ page: 'trade', view: 'chart', symbol: { ...call, exchange: 'SMART' } });
  });

  it('opens a stock on its chart as the stock', () => {
    openRowChart({ ...stock('NVDA'), exchange: 'NASDAQ', conId: 4815747 });
    expect(useStore.getState()).toMatchObject({ page: 'trade', view: 'chart', symbol: stock('NVDA') });
  });

  it('leaves a combo where it is: it has no chart of its own', () => {
    openRowChart({ symbol: 'AAPL', secType: 'BAG', exchange: 'SMART', currency: 'USD' });
    expect(useStore.getState()).toMatchObject({ page: 'acct', view: 'opt', symbol: stock('MSFT') });
  });
});
