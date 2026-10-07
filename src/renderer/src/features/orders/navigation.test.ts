import { beforeEach, describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import { useStore } from '../../state/store';
import { usePortfolioUi } from '../portfolio/uiState';
import { openNotificationTarget } from './navigation';

describe('opening a notification', () => {
  const initial = useStore.getState();
  const aapl = stock('AAPL');
  const call = option('AAPL', '20261016', 230, 'C');
  beforeEach(() => {
    useStore.setState({ ...initial, page: 'set', view: 'depth', symbol: stock('MSFT') }, true);
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
    useStore.setState({ page: 'acct', view: 'depth' });
    openNotificationTarget(stock('NVDA'), undefined);
    expect(useStore.getState()).toMatchObject({ page: 'trade', view: 'depth', symbol: stock('NVDA') });
  });
});
