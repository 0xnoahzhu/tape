// Opening an instrument from a list row (orders, notifications) on the Trade page, and where a
// notification's click leads.

import { contractKey, sameContract, stock } from '@shared/contract';
import type { NotificationView } from '@shared/ipc';
import type { ContractRef, LocalizedName } from '@shared/types';
import { useStore, type TradeView } from '../../state/store';
import { showPortfolio } from '../portfolio/uiState';

function watchedContracts(): Array<{ contract: ContractRef; name?: LocalizedName }> {
  return useStore.getState().watchlists.flatMap((l) => l.groups.flatMap((g) => g.items));
}

/** The display name cached in a watchlist, or '' so the previous instrument's name is not kept. */
export function knownName(contract: ContractRef): LocalizedName {
  const s = useStore.getState();
  if (sameContract(s.symbol, contract) && s.symbolName) return s.symbolName;
  const key = contractKey(contract);
  return watchedContracts().find((i) => contractKey(i.contract) === key)?.name ?? '';
}

/**
 * The underlying of an option: a watched stock or index with the same symbol, else the stock.
 * Other instruments are returned unchanged.
 */
export function underlyingOf(contract: ContractRef): ContractRef {
  if (contract.secType !== 'OPT') return contract;
  const watched = watchedContracts().find((i) => i.contract.symbol === contract.symbol && (i.contract.secType === 'STK' || i.contract.secType === 'IND'));
  return watched?.contract ?? stock(contract.symbol);
}

/** Opens an instrument on the Trade page; the options view opens on the option's underlying. */
export function openInstrument(contract: ContractRef, view?: TradeView): void {
  const target = view === 'opt' ? underlyingOf(contract) : contract;
  useStore.getState().openSymbol(target, view, knownName(target));
}

/**
 * Follows a notification's click (the bell's list: notifications/model.ts → notificationTarget; a
 * system notification: main's viewForKind). A fill selects its instrument and opens Portfolio ›
 * Trades, an order update Portfolio › Orders; otherwise the instrument opens on the Trade page, in
 * the chart or, for an option alert, the option chain (without a view, in the view it shows).
 */
export function openNotificationTarget(contract: ContractRef, view: NotificationView | undefined): void {
  if (view === 'orders' || view === 'trades') {
    useStore.getState().selectSymbol(contract, knownName(contract));
    showPortfolio(view === 'trades' ? 'fill' : 'ord');
    return;
  }
  openInstrument(contract, view);
}
