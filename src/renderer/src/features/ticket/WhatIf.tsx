// IBKR's what-if for the order in the ticket (initial margin change and commission), shown in the
// totals of the docked and the floating ticket (parts.tsx → Totals). The review dialog
// (layout/Dialogs.tsx) asks on its own.

import { useEffect, useRef, useState } from 'react';
import { contractKey } from '@shared/contract';
import type { OrderPreview } from '@shared/types';
import { useCommon } from '../../i18n/common';
import { commissionText, marginText } from '../../layout/Dialogs';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import type { TicketCtl } from './useTicket';

type PreviewState = { status: 'loading' } | { status: 'done'; preview: OrderPreview } | { status: 'error'; message: string };

/**
 * IBKR's what-if for the order as it stands (as in the review dialog), asked again a moment after
 * the user changes the ticket; prices that follow the market do not ask again (main also answers an
 * identical request from its last answer). The previous order's answer is dropped at once.
 */
function useWhatIf(T: TicketCtl, enabled: boolean): PreviewState | null {
  const [state, setState] = useState<PreviewState | null>(null);
  const request = useRef(T.composed);
  request.current = T.composed;
  const key = enabled ? JSON.stringify([contractKey(T.symbol), T.t, T.session]) : null;
  useEffect(() => {
    if (!key) {
      setState(null);
      return;
    }
    setState({ status: 'loading' });
    let alive = true;
    const timer = setTimeout(() => {
      window.tape.previewOrder(request.current).then(
        (preview) => alive && setState({ status: 'done', preview }),
        (err: unknown) => alive && setState({ status: 'error', message: errorText(err) }),
      );
    }, 600);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key]);
  return state;
}

/**
 * The what-if rows: asking, then the initial margin change (before → after in its tooltip) and the
 * commission, or IBKR's refusal in red. None while disconnected, locked (main refuses previews then;
 * unlocking asks again), modifying, for combos, or while the order is incomplete (a value still to be
 * typed, a price waiting for the quote, a broken rule): Tape's own checks are not IBKR's answer. The
 * order turning complete (a quote arriving) asks.
 */
export function WhatIfRows({ T }: { T: TicketCtl }) {
  const c = useCommon();
  const connected = useStore((s) => s.connection.status === 'connected');
  const locked = useStore((s) => s.lock.locked);
  const enabled = connected && !locked && T.tradable && T.modifying == null && T.symbol.secType !== 'BAG' && !T.timingIssue && !T.combo && T.complete;
  const state = useWhatIf(T, enabled);
  if (!enabled || !state) return null;
  const p = state.status === 'done' ? state.preview : null;
  const margin = p ? marginText(p.initMargin) : null;
  const commission = p ? commissionText(p) : null;
  const row = (label: string, value: string, title?: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }} title={title}>
      <div>{label}</div>
      <div className="num selectable ellipsis" style={{ color: 'var(--tx)', minWidth: 0 }}>
        {value}
      </div>
    </div>
  );
  return (
    <>
      {state.status === 'loading' && row(T.m.whatIf, c.preview.loading)}
      {state.status === 'error' && (
        <div className="ellipsis" title={state.message} style={{ color: 'var(--r)' }}>
          {T.m.whatIf} · {state.message}
        </div>
      )}
      {margin && row(c.preview.initMargin, margin.value, margin.sub)}
      {commission && row(c.preview.commission, commission)}
    </>
  );
}
