// A floating panel collapsed to its bar (about 40px high): the drag handle with the symbol or
// strategy, the latest order's live status (a click expands the panel), the panel's own small
// actions and the expand chevron.

import type { ReactNode } from 'react';
import { useOrderFeedback } from '../../state/orderFeedback';
import { setCollapsed } from './actions';
import { useFloatFrame } from './chrome';
import { ChevronIcon } from './icons';
import type { PanelId } from './model';
import { useStripView } from './OrderStrip';

export function CollapsedBar({ id, handle, actions, expandTitle }: { id: PanelId; handle: ReactNode; actions?: ReactNode; expandTitle: string }) {
  const frame = useFloatFrame();
  const sent = useOrderFeedback((s) => s.sent[id]);
  const view = useStripView(id);
  const expand = () => setCollapsed(id, false);
  const tone = view?.tone === 'error' ? 'var(--r)' : view?.tone === 'busy' || view?.tone === 'muted' ? 'var(--mu)' : 'var(--ac)';
  return (
    <div data-testid={`bar-${id}`} style={{ height: '100%', display: 'flex', alignItems: 'center', background: 'var(--p)', fontSize: 13, userSelect: 'none' }}>
      <div onPointerDown={frame?.startDrag} style={{ height: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px 0 12px', flexShrink: 0, cursor: 'grab' }}>
        <span aria-hidden style={{ color: 'var(--dm)', letterSpacing: -2, fontSize: 12 }}>
          ⋮⋮
        </span>
        {handle}
      </div>
      <div
        role="button"
        onClick={expand}
        className="ellipsis"
        title={expandTitle}
        style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'center', padding: '0 8px', cursor: 'pointer' }}
      >
        {sent && view && (
          // The side in its colour (buy / sell as everywhere), the status in the tone's.
          <span className="ellipsis num" title={view.short}>
            <span style={{ color: sent.side === 'BUY' ? 'var(--up)' : 'var(--dn)' }}>{view.lead}</span>
            <span style={{ color: 'var(--dm)' }}> · </span>
            <span style={{ color: tone }}>{view.state}</span>
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingRight: 4 }}>
        {actions}
        <button
          type="button"
          title={expandTitle}
          aria-label={expandTitle}
          onClick={expand}
          className="hover-tx"
          style={{ width: 28, height: 28, padding: 0, border: 'none', background: 'transparent', color: 'var(--dm)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          <ChevronIcon up />
        </button>
      </div>
    </div>
  );
}
