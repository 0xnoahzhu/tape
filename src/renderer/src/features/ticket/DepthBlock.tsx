// The order ticket's Book: five levels a side of the Level 2 book (colored as the bid / ask boxes),
// in the docked ticket between the bid / ask and the entry fields and in the floating ticket's market
// column. Shown while Level 2 is on (Settings › Market Data) for a tradable instrument, the same in
// every layout; one depth line, shared through state/depthSubscription.ts.

import { useEffect, useMemo } from 'react';
import { contractKey, isTradable } from '@shared/contract';
import { DEPTH_PARTIAL } from '@shared/depthPermissions';
import { f0 } from '@shared/format';
import { useMarketDataAvailable } from '../../hooks/useQuotes';
import { setDepthOwner } from '../../state/depthSubscription';
import { useStore } from '../../state/store';
import { BOOK_LEVELS, buildLadder, levelPatch, levelTarget, type LadderRow } from './depthModel';
import type { TicketScale } from './parts';
import { priceText } from './ticketModel';
import type { TicketCtl } from './useTicket';

/** The Book's share of the Level 2 subscription: the docked and the floating ticket are never both mounted. */
const DEPTH_OWNER = 'ticket-book';

/** One level's row height. */
const ROW = 22;

/**
 * A click on a level loads a limit order at it, or moves the price of the order being modified
 * (depthModel.ts → levelPatch). While wanted the Book keeps a fixed height, BOOK_LEVELS rows a side
 * (blank where IB sends fewer, a line while there are none), so the entry fields under it never move.
 */
export function DepthBlock({ T, S }: { T: TicketCtl; S: TicketScale }) {
  const enabled = useStore((s) => s.settings.features.depth);
  const connected = useMarketDataAvailable();
  const key = contractKey(T.symbol);
  const wanted = enabled && connected && T.tradable && isTradable(T.symbol);
  const book = useStore((s) => (s.depth && s.depth.key === key ? s.depth : null));
  useEffect(() => {
    if (!wanted) return;
    void setDepthOwner(DEPTH_OWNER, T.symbol, true).catch(() => undefined);
    return () => void setDepthOwner(DEPTH_OWNER, null).catch(() => undefined);
    // The key identifies the contract; resubscribe after a reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wanted]);
  const ladder = useMemo(() => buildLadder(book, BOOK_LEVELS), [book]);
  if (!wanted) return null;
  // IB's 2152 (the books of some exchanges only) leaves the levels it sends valid; any other error
  // ends the line. Only its code here: Settings › Market Data's Level 2 note covers subscriptions and lines.
  const error = book?.error && book.error.code !== DEPTH_PARTIAL ? book.error : null;
  const rows = error ? [] : ladder.rows;
  const message = error ? T.m.noBook(error.code) : rows.length ? null : T.m.bookWaiting;
  const ticket = { type: T.type, mainKey: T.main.key, modifying: T.modifying != null };
  const target = levelTarget(ticket);
  const asks = rows.filter((r) => r.side === 'ask').length;
  const blank = (n: number, side: string) => Array.from({ length: Math.max(0, n) }, (_, i) => <div key={`${side}-blank-${i}`} style={{ height: ROW, flexShrink: 0 }} />);
  const pick = (r: LadderRow) => {
    const patch = levelPatch(r, ticket);
    if (patch) T.patch(patch);
  };
  return (
    <div data-ticket="book" title={message ? undefined : T.m.bookHint[target ?? 'none']} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={S.label}>{T.m.book}</div>
      <div style={{ height: 2 * BOOK_LEVELS * ROW, display: 'flex', flexDirection: 'column', font: '12px/1 var(--num)', fontVariantNumeric: 'tabular-nums' }}>
        {message ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '12px/1.4 var(--sans)', color: 'var(--dm)', boxShadow: 'inset 0 0 0 1px var(--ln2)' }}>
            {message}
          </div>
        ) : (
          <>
            {blank(BOOK_LEVELS - asks, 'ask')}
            {rows.map((r) => {
              const ask = r.side === 'ask';
              return (
                <div
                  key={`${r.side}${r.price}`}
                  data-book-side={r.side}
                  data-book-price={r.price}
                  onClick={target ? () => pick(r) : undefined}
                  className={target ? 'hover-p2' : undefined}
                  style={{
                    position: 'relative',
                    height: ROW,
                    flexShrink: 0,
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    alignItems: 'center',
                    padding: '0 8px',
                    cursor: target ? 'pointer' : 'default',
                    boxShadow: r.best ? 'inset 0 1px 0 var(--ln)' : undefined,
                  }}
                >
                  <div style={{ position: 'absolute', top: 3, bottom: 3, right: 0, width: `${(r.width * 50).toFixed(0)}%`, background: ask ? 'var(--up)' : 'var(--dn)', opacity: 0.14 }} />
                  <div style={{ position: 'relative', color: ask ? 'var(--up)' : 'var(--dn)' }}>{priceText(r.price, T.minTick)}</div>
                  <div style={{ position: 'relative', textAlign: 'right', color: 'var(--mu)' }}>{f0(r.size)}</div>
                </div>
              );
            })}
            {blank(BOOK_LEVELS - (rows.length - asks), 'bid')}
          </>
        )}
      </div>
    </div>
  );
}
