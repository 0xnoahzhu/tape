import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../state/store';
import { showPortfolio, usePortfolioUi } from './uiState';

describe('Portfolio tabs', () => {
  const initial = useStore.getState();
  beforeEach(() => useStore.setState({ ...initial, page: 'trade' }, true));

  it('opens on Positions', () => {
    expect(usePortfolioUi.getState().tab).toBe('pos');
  });

  it('opens the page on a tab, or on the tab it last showed', () => {
    showPortfolio('ord');
    expect(useStore.getState().page).toBe('acct');
    expect(usePortfolioUi.getState().tab).toBe('ord');
    useStore.setState({ page: 'trade', bellOpen: true });
    showPortfolio();
    expect(useStore.getState()).toMatchObject({ page: 'acct', bellOpen: false });
    expect(usePortfolioUi.getState().tab).toBe('ord');
    showPortfolio('fill');
    expect(usePortfolioUi.getState().tab).toBe('fill');
    showPortfolio('pos');
    expect(usePortfolioUi.getState().tab).toBe('pos');
  });
});
