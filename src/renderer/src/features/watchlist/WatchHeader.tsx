// The header over the watchlist's rows: Symbol first, then the other columns (last, change, change
// %) in the order and at the widths the user set (model.ts → WatchColumns, kept per device).
//
// A click on a column's name sorts by it (model.ts → nextWatchSort). The columns after Symbol are
// dragged sideways to move them among themselves (a press that moves more than DRAG_SLOP px drags,
// a shorter one sorts; Escape undoes it); Symbol stays first. The strip on a column's right edge
// sizes it, Symbol's too, against the rightmost column, which takes or gives the difference (it has
// no strip: it takes the room left; model.ts → resizeColumn). A double-click on the strip gives the
// column its default width back. Both follow the pointer on the window from press to release
// (followPointer), as the Positions table's header does. When the panel is resized, the rightmost
// column gives way first (model.ts → reconcileColumns).

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { followPointer, swallowClick } from '../../ui/pointerDrag';
import { useWatchlistMessages } from './messages';
import { COL_WIDTHS, dropIndex, moveColumn, nextWatchSort, resizeColumn, SYMBOL_W, type WatchCol, type WatchColumns, type WatchSortBy } from './model';
import { useWatchlistView } from './viewState';

/** A press moves this far (px) before it drags; less is a click. */
const DRAG_SLOP = 4;
/** Width of the sizing strip on a column's right edge (px); it straddles the gap. */
const GRIP = 8;

/** A column's width, Symbol's or another's. */
const widthOf = (cols: WatchColumns, col: WatchCol | 'symbol') => (col === 'symbol' ? cols.symbol : cols.widths[col]);

export function WatchHeader({ template, gap, pad }: { template: string; gap: number; pad: string }) {
  const m = useWatchlistMessages();
  const sort = useWatchlistView((s) => s.sort);
  const setSort = useWatchlistView((s) => s.setSort);
  const columns = useWatchlistView((s) => s.columns);
  const setColumns = useWatchlistView((s) => s.setColumns);
  const rowRef = useRef<HTMLDivElement>(null);
  const live = useRef(columns);
  live.current = columns;
  const [dragged, setDragged] = useState<WatchCol | null>(null);
  const [line, setLine] = useState<number | null>(null);
  const [sizing, setSizing] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  // The pointer keeps the grabbing hand or the resize arrows wherever it goes during a drag.
  useEffect(() => {
    if (!dragged && !sizing) return;
    const cls = sizing ? 'pos-resizing' : 'pos-reordering';
    document.documentElement.classList.add(cls);
    return () => document.documentElement.classList.remove(cls);
  }, [dragged, sizing]);

  const names: Record<WatchCol, [string, string]> = {
    last: [m.colLast, m.sortLast],
    chg: [m.colChg, m.sortChg],
    pct: [m.colChange, m.sortChange],
  };

  /** A press on a column's name: a drag moves the column, a click sorts by it. */
  const pressMove = (e: PointerEvent<HTMLElement>, col: WatchCol) => {
    const row = rowRef.current;
    if (e.button !== 0 || e.pointerType === 'touch' || !row || stop.current) return;
    const { clientX: x0, clientY: y0 } = e;
    let x = x0;
    let started = false;
    let index: number | null = null;
    const follow = () => {
      const left = row.getBoundingClientRect().left;
      const others = [...row.querySelectorAll<HTMLElement>('[data-wl-col]')].filter((el) => el.dataset.wlCol !== col).map((el) => el.getBoundingClientRect());
      if (!others.length) return;
      index = dropIndex(
        others.map((r) => ({ top: r.left, bottom: r.right })),
        x,
      );
      setLine(index < others.length ? others[index].left - left - gap / 2 : others[others.length - 1].right - left + gap / 2);
    };
    const done = () => {
      stop.current = null;
      setDragged(null);
      setLine(null);
    };
    const unfollow = followPointer(
      e.pointerId,
      (ev) => {
        x = ev.clientX;
        if (!started) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) <= DRAG_SLOP) return;
          started = true;
          setDragged(col);
        }
        follow();
      },
      (ev) => {
        if (ev && started) {
          x = ev.clientX;
          follow();
          if (index != null) setColumns(moveColumn(live.current, col, index), true);
          // The release would sort by the column under it.
          swallowClick();
        }
        done();
      },
    );
    stop.current = () => {
      unfollow();
      done();
    };
  };

  /** A press on a column's right edge sizes it: wider as the edge goes right, the rightmost column giving way (model.ts → resizeColumn). */
  const pressSize = (e: PointerEvent<HTMLElement>, col: WatchCol | 'symbol') => {
    if (e.button !== 0 || stop.current) return;
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const start = live.current;
    const w0 = widthOf(start, col);
    setSizing(true);
    const done = () => {
      stop.current = null;
      setSizing(false);
    };
    const unfollow = followPointer(
      e.pointerId,
      // From the columns as the press found them, so the rightmost one gives back what it took as the edge returns.
      (ev) => setColumns(resizeColumn(start, col, w0 + (ev.clientX - x0)), false),
      (ev) => {
        // Undone (Escape): the columns as they were.
        setColumns(ev ? resizeColumn(start, col, w0 + (ev.clientX - x0)) : start, true);
        swallowClick();
        done();
      },
    );
    stop.current = () => {
      unfollow();
      done();
    };
  };

  const label = (by: WatchSortBy, text: string, title: string, right: boolean, extra?: Partial<React.HTMLAttributes<HTMLDivElement>>) => {
    const on = sort?.by === by;
    const arrow = on ? (sort!.dir === 'asc' ? '▲' : '▼') : '';
    return (
      <div
        role="button"
        tabIndex={0}
        title={title}
        aria-sort={on ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        onClick={() => setSort(nextWatchSort(sort, by))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setSort(nextWatchSort(sort, by));
          }
        }}
        className="hover-tx focus-ring"
        style={{ display: 'flex', alignItems: 'center', gap: 3, justifyContent: right ? 'flex-end' : 'flex-start', minWidth: 0, height: '100%', cursor: 'pointer', userSelect: 'none', color: on ? 'var(--tx)' : undefined }}
        {...extra}
      >
        {right && <span style={{ fontSize: 8, color: 'var(--ac)' }}>{arrow}</span>}
        <span className="ellipsis">{text}</span>
        {!right && <span style={{ fontSize: 8, color: 'var(--ac)' }}>{arrow}</span>}
      </div>
    );
  };

  const grip: CSSProperties = { position: 'absolute', top: 0, bottom: 0, right: -(gap / 2) - GRIP / 2, width: GRIP, cursor: 'col-resize', zIndex: 1, touchAction: 'none' };
  const sizer = (col: WatchCol | 'symbol') => (
    <div
      aria-hidden
      data-wl-size={col}
      title={m.resizeColumn}
      onPointerDown={(e) => pressSize(e, col)}
      onDoubleClick={() => setColumns(resizeColumn(live.current, col, col === 'symbol' ? SYMBOL_W : COL_WIDTHS[col]), true)}
      style={grip}
    />
  );
  const last = columns.order[columns.order.length - 1];
  return (
    <div ref={rowRef} style={{ position: 'relative', height: 28, display: 'grid', gridTemplateColumns: template, gap, alignItems: 'stretch', padding: pad, fontSize: 11, color: 'var(--dm)' }}>
      <div style={{ position: 'relative', minWidth: 0 }}>
        {label('symbol', m.colSymbol, m.sortSymbol, false)}
        {sizer('symbol')}
      </div>
      {columns.order.map((col) => (
        <div key={col} data-wl-col={col} style={{ position: 'relative', minWidth: 0, opacity: dragged === col ? 0.45 : 1 }}>
          {label(col, names[col][0], `${names[col][1]}\n${m.moveColumn}`, true, { onPointerDown: (e) => pressMove(e, col) })}
          {col !== last && sizer(col)}
        </div>
      ))}
      {line != null && <div aria-hidden style={{ position: 'absolute', top: 5, bottom: 5, left: line - 1, width: 2, background: 'var(--ac)', pointerEvents: 'none' }} />}
    </div>
  );
}

