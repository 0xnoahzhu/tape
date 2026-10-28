// The actions cell of an order row (Portfolio › Orders, the Trade page's activity panel): Modify /
// Cancel for an order Tape can cancel, "Cancelling…" while a cancel sent from here waits for IB,
// else who placed it ("Other app", "Client 12", "Other account") with a "Why?" that explains and
// offers the way that works (state/orderActions.ts → explainCancelBlock). lib/orders.ts →
// orderRowAction decides, from shared/orderOwnership.ts → cancelBlock (main refuses the same).

import type { WorkingOrder } from '@shared/types';
import { orderRowAction } from '../../lib/orders';
import { confirmCancel, explainCancelBlock } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { useOrdersMessages } from './messages';
import { sourceLabel } from './model';

/** `onModify`: loads the order into the ticket (left out where it cannot be modified there). */
export function OrderActions({ o, onModify }: { o: WorkingOrder; onModify?: () => void }) {
  const m = useOrdersMessages();
  const status = useStore((s) => s.connection.status);
  const clientId = useStore((s) => s.connection.clientId);
  const accounts = useStore((s) => s.connection.accounts);
  const pending = useStore((s) => s.pendingCancels);
  const a = orderRowAction(o, { status, clientId, accounts }, pending);
  switch (a.kind) {
    case 'actions':
      return (
        <>
          {onModify && (
            <div onClick={onModify} role="button" style={{ color: 'var(--ac)', cursor: 'pointer' }}>
              {m.modify}
            </div>
          )}
          <div onClick={() => confirmCancel(o)} role="button" className="hover-tx" style={{ color: 'var(--dm)', cursor: 'pointer' }}>
            {m.cancel}
          </div>
        </>
      );
    case 'cancelling':
      return <div style={{ color: 'var(--dm)' }}>{m.cancelling}</div>;
    case 'source':
      return (
        <>
          <div className="ellipsis" style={{ color: 'var(--mu)', minWidth: 0 }} title={m.otherOrder(o)}>
            {sourceLabel(o, a.block, m)}
          </div>
          <div onClick={() => explainCancelBlock(o, a.block)} role="button" style={{ color: 'var(--ac)', cursor: 'pointer' }}>
            {m.why}
          </div>
        </>
      );
    case 'none':
      return null;
  }
}
