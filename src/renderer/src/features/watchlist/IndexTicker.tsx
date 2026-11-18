// The top bar's index ticker: the indices of the ticker list (shared/defaults.ts → TICKER_LIST_ID),
// each its symbol, last value and change. Indices cannot be traded, so they are shown here rather
// than in a watchlist tab. A click opens an index's chart on Trade (without the order ticket, as
// for any index); the chart star of an index puts it on the ticker or takes it off.
//
// The ticker takes the top bar's free space. When its indices do not fit, they run from right to
// left, twice in a row so they go round without a seam (global.css → .ticker-track), and stop while
// the pointer is over them. With reduced motion asked for, they stay put and the wheel scrolls them.
//
// With Settings › General › Indices without data set to Hide (appearance.tickerHideNoData), an index
// is left out while it has no price (IB sends none: not subscribed, not connected); it is still
// subscribed, so it comes in once its data does.

import { useShallow } from 'zustand/react/shallow';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import { pct, px, signColor } from '@shared/format';
import type { WatchItem } from '@shared/types';
import { changePct, lastPrice, useQuoteSubscriptions } from '../../hooks/useQuotes';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { useWatchlistMessages } from './messages';
import { tickerItems, tickerListOf } from './model';

/** Space between two indices (px); a copy ends with it too, so the two copies loop evenly. */
const GAP = 18;
/** How fast the indices run (px a second). */
const SPEED = 32;

const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

export function IndexTicker() {
  const m = useWatchlistMessages();
  const list = useStore((s) => tickerListOf(s.watchlists));
  const all = useMemo(() => tickerItems(list), [list]);
  const contracts = useMemo(() => all.map((i) => i.contract), [all]);
  // Every index stays subscribed, so a hidden one shows up once its price comes.
  useQuoteSubscriptions('ticker', contracts, 'basic');
  const hideNoData = useStore((s) => s.settings.appearance.tickerHideNoData);
  // Whether each index has a price; a new array only when one of them changes.
  const priced = useStore(useShallow((s) => (hideNoData ? all.map((i) => lastPrice(s.quotes[contractKey(i.contract)]) != null) : null)));
  const items = useMemo(() => (priced ? all.filter((_, n) => priced[n]) : all), [all, priced]);
  const boxRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  // The width of one copy of the indices, and whether it is more than the ticker has.
  const [fit, setFit] = useState({ copy: 0, over: false });
  const [still] = useState(reducedMotion);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const copy = copyRef.current;
    if (!box || !copy) return;
    const update = () => {
      const w = copy.offsetWidth;
      // The last gap is the copies' seam, not content.
      const over = w - GAP > box.clientWidth + 1;
      setFit((f) => (f.copy === w && f.over === over ? f : { copy: w, over }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(box);
    ro.observe(copy);
    return () => ro.disconnect();
  }, [items.length]);

  // Without the motion: the wheel scrolls the indices sideways (a mouse wheel only turns up / down).
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !still) return;
    const onWheel = (e: WheelEvent) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += d;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [still, items.length]);

  if (!items.length) return null;
  const running = fit.over && !still;
  const copy = (hidden: boolean) => (
    <div ref={hidden ? undefined : copyRef} aria-hidden={hidden || undefined} style={{ display: 'flex', alignItems: 'center', gap: GAP, paddingRight: GAP, flexShrink: 0 }}>
      {items.map((item) => (
        <TickerItem key={contractKey(item.contract)} item={item} hidden={hidden} />
      ))}
    </div>
  );
  return (
    <div
      ref={boxRef}
      role="list"
      aria-label={m.ticker}
      className="no-drag ticker"
      style={{
        // Half the search box's share of the free space (SymbolSearch: 2), and all of it once the box is at its widest.
        flex: '1 1 0',
        minWidth: 0,
        alignSelf: 'stretch',
        display: 'flex',
        alignItems: 'center',
        overflowX: still ? 'auto' : 'hidden',
        overflowY: 'hidden',
        scrollbarWidth: 'none',
        // Cut indices fade out at the edges.
        maskImage: fit.over ? 'linear-gradient(to right, transparent, #000 20px, #000 calc(100% - 20px), transparent)' : undefined,
      }}
    >
      <div
        className={running ? 'ticker-track' : undefined}
        style={{ display: 'flex', flexShrink: 0, ...(running ? ({ '--ticker-dur': `${Math.max(8, fit.copy / SPEED)}s` } as CSSProperties) : null) }}
      >
        {copy(false)}
        {running && copy(true)}
      </div>
    </div>
  );
}

const TickerItem = memo(function TickerItem({ item, hidden }: { item: WatchItem; hidden: boolean }) {
  const lang = useLang();
  const q = useStore((s) => s.quotes[contractKey(item.contract)]);
  const last = lastPrice(q);
  const chg = changePct(q);
  const label = contractLabel(item.contract);
  const name = nameOf(item.name, lang);
  return (
    <div
      role={hidden ? undefined : 'listitem'}
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
