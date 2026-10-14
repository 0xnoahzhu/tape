// What the renderer drops when Tape moves to another account or Gateway (ConnectionState.session
// changed; bridge.ts). Main sends the new session's state before anything of that session and
// empties its own lists: the mirrors are emptied here at once too, so the previous account's
// orders, fills, positions and values never show under the new connection. Everything opened on
// the previous session goes with them: the order review (never sent), a cancel confirmation, the
// ticket's "Modify" and the floating panels' order strips. A plain reconnect keeps them all.

import { useCommon } from '../i18n/common';
import { useOrderFeedback } from './orderFeedback';
import { useStore } from './store';

export function resetSessionState(): void {
  const reviewOpen = useStore.getState().pendingOrder != null;
  useStore.setState((s) => ({
    orders: [],
    executions: [],
    positions: [],
    account: null,
    pendingOrder: null,
    // A dialog bound to the session (a cancel) closes; generic confirmations stay.
    confirm: s.confirm?.session != null ? null : s.confirm,
    ticket: s.ticket.modifyingOrderId == null ? s.ticket : { ...s.ticket, modifyingOrderId: null },
  }));
  useOrderFeedback.getState().clear();
  if (reviewOpen) useStore.getState().showToast(useCommon.now().sessionChanged, 'error');
}
