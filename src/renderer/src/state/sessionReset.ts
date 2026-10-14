// What the renderer drops when Tape moves to another account or Gateway (ConnectionState.session
// changed; bridge.ts). Main sends the new session's state before anything of that session and
// empties its own lists: the mirrors are emptied here at once too, so the previous account's
// orders, fills, positions and values never show under the new connection (the positions count as
// not listed until main says IB listed the new account's). Everything opened on the previous
// session goes with them: the order review (never sent), a cancel confirmation, the Cancel all
// dialog, the cancels waiting for IB, the ticket (it starts fresh on the same instrument: a side,
// size or "Modify" prepared on one account never carries over to another, e.g. from paper to live)
// and the floating panels' order strips. A plain reconnect keeps them all.

import { useCommon } from '../i18n/common';
import { useOrderFeedback } from './orderFeedback';
import { initialTicket, useStore } from './store';

export function resetSessionState(): void {
  const reviewOpen = useStore.getState().pendingOrder != null;
  useStore.setState((s) => ({
    orders: [],
    executions: [],
    positions: [],
    positionsLoaded: false,
    account: null,
    pendingOrder: null,
    // A dialog bound to the session (a cancel, Cancel all) closes; generic confirmations stay.
    confirm: s.confirm?.session != null ? null : s.confirm,
    cancelAll: null,
    // Their ids name the new login's orders now.
    pendingCancels: [],
    ticket: initialTicket(s.settings, s.symbol),
  }));
  useOrderFeedback.getState().clear();
  if (reviewOpen) useStore.getState().showToast(useCommon.now().sessionChanged, 'error');
}
