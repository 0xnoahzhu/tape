// Level 2 depth view (design 3a "Depth" tab): 10 asks above 10 bids with size bars.
// Clicking a level loads it into the order ticket as a limit price.

import { useMarketDataAvailable } from '../../hooks/useQuotes';
import { useEffect, useState } from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import { f0, f2 } from '@shared/format';
import { useCommon } from '../../i18n/common';
import { useStore } from '../../state/store';
import { useContractInfo } from './contractInfo';
import { buildLadder, type LadderRow } from './depthModel';
import { priceDecimals } from './chartMath';
import { ipcErrorMessage } from './errors';
import { useChartMessages } from './messages';

/** IB codes that mean "no Level 2 permission": 354 / 10186 not subscribed, 2152 needs depth permissions, 10092 no deep book. */
const NO_L2_CODES = new Set([354, 2152, 10092, 10186]);

function Row({ row, fmt, onPick }: { row: LadderRow; fmt: (p: number) => string; onPick: (r: LadderRow) => void }) {
  const ask = row.side === 'ask';
  const bar = `${(row.width * 100).toFixed(0)}%`;
  return (
    <div
      onClick={() => onPick(row)}
      className="hover-p2"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 120px 1fr',
        height: 28,
        flexShrink: 0,
        alignItems: 'stretch',
        padding: '0 28px',
        cursor: 'pointer',
        boxShadow: row.best ? 'inset 0 1px 0 var(--ln)' : 'none',
      }}
    >
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 12 }}>
        {!ask && <div style={{ position: 'absolute', right: 0, top: 4, bottom: 4, width: bar, background: 'var(--up)', opacity: 0.14 }} />}
        <div style={{ position: 'relative', color: 'var(--up)' }}>{ask ? '' : f0(row.size)}</div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: row.best ? 600 : 400,
          color: row.best ? 'var(--ac)' : 'var(--tx)',
          background: row.best ? 'var(--sel)' : 'transparent',
        }}
      >
        {fmt(row.price)}
      </div>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', paddingLeft: 12 }}>
        {ask && <div style={{ position: 'absolute', left: 0, top: 4, bottom: 4, width: bar, background: 'var(--dn)', opacity: 0.14 }} />}
        <div style={{ position: 'relative', color: 'var(--dn)' }}>{ask ? f0(row.size) : ''}</div>
      </div>
    </div>
  );
}

export function DepthView() {
  const m = useChartMessages();
  const common = useCommon();
  const symbol = useStore((s) => s.symbol);
  const connected = useMarketDataAvailable();
  const patchTicket = useStore((s) => s.patchTicket);
  const key = contractKey(symbol);
  const book = useStore((s) => (s.depth && s.depth.key === key ? s.depth : null));
  const info = useContractInfo(symbol);
  const [requestError, setRequestError] = useState<string | null>(null);
  const isIndex = symbol.secType === 'IND';

  useEffect(() => {
    setRequestError(null);
    if (!connected) return;
    // Indices have no book: release the previous instrument's depth request (IB limits them).
    if (isIndex) {
      void window.tape.setDepthSubscription(null).catch(() => undefined);
      return;
    }
    window.tape.setDepthSubscription(symbol).catch((err: unknown) => setRequestError(ipcErrorMessage(err)));
    // The key identifies the contract; resubscribe after a reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected, isIndex]);
  useEffect(() => () => void window.tape.setDepthSubscription(null).catch(() => undefined), []);

  const ladder = buildLadder(book);
  const decimals = priceDecimals(info?.minTick, ladder.bestBid ?? ladder.bestAsk);
  const fmt = (p: number) => f2(p, decimals);
  const label = contractLabel(symbol);

  // A working order being modified keeps its side and type (IB refuses to change them): only its price follows.
  const pick = (r: LadderRow) =>
    patchTicket(useStore.getState().ticket.modifyingOrderId != null ? { limitPrice: r.price } : { orderType: 'LMT', limitPrice: r.price, side: r.side === 'ask' ? 'BUY' : 'SELL' });

  const bookError = book?.error ? `${book.error.message} (${book.error.code})` : requestError;
  const needsL2 = !!book?.error && NO_L2_CODES.has(book.error.code);
  const message = isIndex
    ? m.depthIndex
    : !connected
      ? common.notConnected
      : bookError && !ladder.rows.length
        ? m.depthError(bookError)
        : !book
          ? m.depthWaiting
          : !ladder.rows.length
            ? m.depthEmpty
            : null;

  return (
    <div style={{ background: 'var(--p)', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '18px 28px 10px' }}>
        <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{m.depthTitle(label)}</div>
        <div style={{ fontSize: 12, color: 'var(--dm)', whiteSpace: 'nowrap' }}>
          {ladder.rows.length ? m.depthSub(ladder.levels, ladder.spread != null ? f2(ladder.spread, decimals) : '—') : ''}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: 'var(--dm)', whiteSpace: 'nowrap' }}>{m.depthHint}</div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 120px 1fr',
          padding: '6px 28px',
          fontSize: 11,
          color: 'var(--dm)',
          boxShadow: 'inset 0 -1px 0 var(--ln2)',
        }}
      >
        <div style={{ textAlign: 'right' }}>{m.bidSize}</div>
        <div style={{ textAlign: 'center' }}>{m.price}</div>
        <div>{m.askSize}</div>
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          font: '13px/1 var(--num)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {/* margin:auto centers the ladder without clipping its top when it overflows. */}
        <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column' }}>
          {message ? (
            <div style={{ padding: '0 28px', textAlign: 'center', font: '13px/1.6 var(--sans)', color: 'var(--dm)' }}>
              <div>{message}</div>
              {needsL2 && <div style={{ marginTop: 6 }}>{m.depthNeedsL2}</div>}
            </div>
          ) : (
            ladder.rows.map((r) => <Row key={`${r.side}:${r.price}`} row={r} fmt={fmt} onPick={pick} />)
          )}
        </div>
      </div>
    </div>
  );
}
