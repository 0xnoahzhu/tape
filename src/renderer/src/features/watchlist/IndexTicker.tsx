// The top bar's index ticker: the indices of the ticker list (shared/defaults.ts → TICKER_LIST_ID),
// each its symbol, last value and change. Indices cannot be traded, so they are shown here rather
// than in a watchlist tab. A click opens an index's chart on Trade (without the order ticket, as
// for any index); the chart star of an index puts it on the ticker or takes it off. The row takes
// the top bar's free space and scrolls sideways when it does not fit (the wheel scrolls it).

import { memo, useEffect, useMemo, useRef } from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import { pct, px, signColor } from '@shared/format';
import type { WatchItem } from '@shared/types';
import { changePct, lastPrice, useQuoteSubscriptions } from '../../hooks/useQuotes';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { useWatchlistMessages } from './messages';
import { tickerItems, tickerListOf } from './model';

export function IndexTicker() {
  const m = useWatchlistMessages();
  const list = useStore((s) => tickerListOf(s.watchlists));
  const items = useMemo(() => tickerItems(list), [list]);
  const contracts = useMemo(() => items.map((i) => i.contract), [items]);
  useQuoteSubscriptions('ticker', contracts, 'basic');
  const rowRef = useRef<HTMLDivElement>(null);

  // The wheel scrolls the row sideways (a mouse wheel only turns up / down).
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += d;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // The row is rendered once there are indices.
  }, [items.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!items.length) return <div style={{ marginLeft: 'auto' }} />;
  return (
    <div
      ref={rowRef}
      role="list"
      aria-label={m.ticker}
      className="no-drag"
      style={{
        // Half the search box's share of the free space, then whatever is left once it is at its widest.
        flex: '0.5 1 0',
        minWidth: 0,
        alignSelf: 'stretch',
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'none',
        // The row fades out at its right end where it is cut.
        maskImage: 'linear-gradient(to right, #000 calc(100% - 24px), transparent)',
        paddingRight: 24,
      }}
    >
      {items.map((item) => (
        <TickerItem key={contractKey(item.contract)} item={item} />
      ))}
    </div>
  );
}

const TickerItem = memo(function TickerItem({ item }: { item: WatchItem }) {
  const lang = useLang();
  const q = useStore((s) => s.quotes[contractKey(item.contract)]);
  const last = lastPrice(q);
  const chg = changePct(q);
  const label = contractLabel(item.contract);
  const name = nameOf(item.name, lang);
  return (
    <div
      role="listitem"
      title={name ? `${name} · ${label}` : label}
      onClick={() => useStore.getState().openSymbol(item.contract, 'chart', item.name)}
      className="hover-p2"
      style={{ flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: 6, padding: '4px 6px', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 12 }}
    >
      <span style={{ fontWeight: 600, color: 'var(--mu)' }}>{label}</span>
      <span className="num" style={{ color: 'var(--tx)' }}>
        {px(last)}
      </span>
      <span className="num" style={{ color: signColor(chg) }}>
        {pct(chg)}
      </span>
    </div>
  );
});
