// The orders and fills the renderer lists and acts on: those of the connected login's accounts
// (lib/orders.ts › ofConnectedAccounts). Main empties its lists when Tape moves to another
// account or Gateway; these hooks are the renderer's backstop, so an order of another account is
// never shown as this one's, priced, or offered for Modify / Cancel.

import { useMemo } from 'react';
import type { Execution, WorkingOrder } from '@shared/types';
import { ofConnectedAccounts } from '../lib/orders';
import { useStore } from './store';

/** The store's orders of the connected login (the same array while nothing is dropped). */
export function useConnectedOrders(): WorkingOrder[] {
  const orders = useStore((s) => s.orders);
  const accounts = useStore((s) => s.connection.accounts);
  return useMemo(() => ofConnectedAccounts(orders, accounts), [orders, accounts]);
}

/** The store's fills of the connected login (the same array while nothing is dropped). */
export function useConnectedExecutions(): Execution[] {
  const executions = useStore((s) => s.executions);
  const accounts = useStore((s) => s.connection.accounts);
  return useMemo(() => ofConnectedAccounts(executions, accounts), [executions, accounts]);
}
