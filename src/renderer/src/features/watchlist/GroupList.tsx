// Body of the watchlist: a header row and, under it, the rows of the tab shown (GroupTabs), one
// group's symbols or, on All, every symbol once (model.ts → tabRows). A row is one line: symbol (its
// name on hover), last price and today's change, each in its column under the header.
//
// The header sorts the rows (model.ts → sortRows, nextWatchSort): a click on Symbol goes A–Z, Z–A,
// then back to the tab's own order; on Chg % biggest gain first, biggest loss first, own order. The
// sort is kept per device for every tab. Sorted by change, the rows re-sort at most once a second,
// and not while the pointer is over them, so a row never moves away under a click (heldKeys).
//
// Rows are dragged (followPointer, as the tabs): a press that moves more than DRAG_SLOP px drags;
// a shorter one is a click (picks the symbol). A row goes between the others (the accent line says
// where; on All into the group of its neighbours, model.ts → allDrop; not while the rows are sorted,
// when a place among them would mean nothing), or onto a tab of the bar,
// which lights up: from a tab it moves there, from All it is added there too. Near the list's top
// or bottom it scrolls; Escape undoes the drag, and the release's click is swallowed.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { contractKey, contractLabel } from '@shared/contract';
import { pct, px, sg, signColor } from '@shared/format';
import type { Lang, Quote, WatchItem, Watchlist } from '@shared/types';
import { changeAbs, changePct, lastPrice } from '../../hooks/useQuotes';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { lessGutter, stableGutter } from '../../ui/scrollGutter';
import { edgeScroll } from '../portfolio/columnsState';
import { followPointer, swallowClick } from '../../ui/pointerDrag';
import { updateList } from './actions';
import { useWatchlistMessages } from './messages';
import { ALL_TAB, addItem, allDrop, columnsTemplate, dropIndex, groupHas, heldKeys, itemKey, moveItem, moveItemTo, sortRows, tabRows, type TabRow, type WatchCol } from './model';
import { WatchHeader } from './WatchHeader';
import { useWatchlistView } from './viewState';
import { DEFAULT_GROUP_NAME } from './messages';

/** IB error "requires additional subscription"; delayed data, when enabled, follows it. */
const NO_LIVE_SUBSCRIPTION = 10089;

/** A press moves this far (px) before it drags; less is a click. */
const DRAG_SLOP = 4;
/** Within this many px of the list's top or bottom a drag scrolls it, up to EDGE_SPEED px a frame. */
const EDGE = 40;
const EDGE_SPEED = 14;
/** Sorted by change, the rows re-sort at most this often (ms). */
const RESORT_MS = 1000;
/** A row's and the header's side padding and the gap between columns (model.ts → columnsTemplate for the columns). */
const ROW_PAD = '0 10px 0 14px';
const COL_GAP = 6;
const NO_VALUES: number[] = [];

/** A column's value for sorting: the last price, the change or the change in %. */
const valueOf = (col: WatchCol, q: Quote | undefined): number | undefined => (col === 'last' ? lastPrice(q) : col === 'chg' ? changeAbs(q) : changePct(q));

/** What is dragged: a row, by the group it is shown for and its key. */
interface Dragged {
  groupId: string;
  key: string;
}
/** Where it lands: at `index` among the tab's other rows (a line at `y`, in the list's content), or onto a tab of the bar. */
type Drop = { kind: 'row'; index: number; y: number } | { kind: 'tab'; groupId: string };

const sameDrop = (a: Drop | null, b: Drop | null): boolean =>
  a === b || (!!a && !!b && (a.kind === 'row' ? b.kind === 'row' && a.index === b.index && a.y === b.y : b.kind === 'tab' && a.groupId === b.groupId));

export function GroupList({
  list,
  tab,
  tabBarRef,
  onDropTab,
  onRowMenu,
  onAdd,
}: {
  list: Watchlist;
  /** The tab shown (resolved: All or a group of the list). */
  tab: string;
  /** The tab bar, whose tabs take dropped rows. */
  tabBarRef: RefObject<HTMLDivElement | null>;
  /** The tab a dragged row is over (lit in the bar), or none. */
  onDropTab: (groupId: string | undefined) => void;
  onRowMenu: (e: MouseEvent, groupId: string, item: WatchItem) => void;
  /** Opens "Add symbol" (the empty tab's button). */
  onAdd: () => void;
}) {
  const m = useWatchlistMessages();
  const lang = useLang();
  const selectedKey = useStore((s) => contractKey(s.symbol));
  const rootRef = useRef<HTMLDivElement>(null);
  const sort = useWatchlistView((s) => s.sort);
  const base = useMemo(() => tabRows(list, tab), [list, tab]);
  const columns = useWatchlistView((s) => s.columns);
  const template = useMemo(() => columnsTemplate(columns), [columns]);
  // The sorted column's value of each row, read only while sorting by a number (so quotes do not re-render the list otherwise).
  const by = sort && sort.by !== 'symbol' ? sort.by : null;
  const values = useStore(useShallow((s) => (by ? base.map((r) => valueOf(by, s.quotes[itemKey(r.item)]) ?? NaN) : NO_VALUES)));
  const wanted = useMemo(() => {
    const byKey = new Map(base.map((r, i) => [itemKey(r.item), values[i]]));
    return sortRows(base, sort, (k) => byKey.get(k));
  }, [base, sort, values]);
  const [hold, setHold] = useState(false);
  const order = useHeldOrder(
    wanted.map((r) => itemKey(r.item)),
    `${tab}|${sort?.by ?? ''}|${sort?.dir ?? ''}`,
    hold,
  );
  const rows = useMemo(() => {
    const byKey = new Map(wanted.map((r) => [itemKey(r.item), r]));
    return order.flatMap((k) => byKey.get(k) ?? []);
  }, [order, wanted]);

  const [dragged, setDragged] = useState<Dragged | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const live = useRef({ list, tab, sort });
  live.current = { list, tab, sort };
  /** Stops following the press (unmount). */
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  // The pointer keeps the grabbing hand wherever it goes while something is dragged.
  useEffect(() => {
    if (!dragged) return;
    const html = document.documentElement;
    html.classList.add('pos-reordering');
    return () => html.classList.remove('pos-reordering');
  }, [dragged]);

  const press = useCallback(
    (e: PointerEvent<HTMLElement>, what: Dragged) => {
      const root = rootRef.current;
      if (e.button !== 0 || e.pointerType === 'touch' || !root || stopDrag.current) return;
      const { clientX: x0, clientY: y0 } = e;
      let x = x0;
      let y = y0;
      let started = false;
      let frame = 0;
      let mark: Drop | null = null;
      const at = (): Drop | null => {
        // Over a tab of the bar (not the one shown).
        const tabs = [...(tabBarRef.current?.querySelectorAll<HTMLElement>('[data-wl-group]') ?? [])];
        const over = tabs.find((t) => {
          const r = t.getBoundingClientRect();
          return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
        });
        if (over) return over.dataset.wlGroup === live.current.tab ? null : { kind: 'tab', groupId: over.dataset.wlGroup! };
        const r = root.getBoundingClientRect();
        // Sorted, a place among the rows would mean nothing.
        if (y < r.top - 8 || live.current.sort) return null;
        const top = r.top - root.scrollTop;
        const others = [...root.querySelectorAll<HTMLElement>('[data-wl-row]')].filter((el) => el.dataset.key !== what.key).map((el) => el.getBoundingClientRect());
        if (!others.length) return null;
        const index = dropIndex(others, y);
        const line = index < others.length ? others[index].top - top : others[others.length - 1].bottom - top;
        return { kind: 'row', index, y: line };
      };
      const follow = () => {
        const next = at();
        if (sameDrop(mark, next)) return;
        mark = next;
        setDrop(next);
        onDropTab(next?.kind === 'tab' ? next.groupId : undefined);
      };
      // Each frame of the drag: near the list's top or bottom, scroll it (and follow the rows that moved).
      const scroll = () => {
        frame = requestAnimationFrame(scroll);
        const r = root.getBoundingClientRect();
        if (x < r.left || x > r.right) return;
        const step = edgeScroll(y, y0, r.top, r.bottom, EDGE, EDGE_SPEED);
        if (!step) return;
        const before = root.scrollTop;
        root.scrollTop = before + step;
        if (root.scrollTop !== before) follow();
      };
      const done = () => {
        cancelAnimationFrame(frame);
        stopDrag.current = null;
        setDragged(null);
        setDrop(null);
        onDropTab(undefined);
      };
      const unfollow = followPointer(
        e.pointerId,
        (ev) => {
          x = ev.clientX;
          y = ev.clientY;
          if (!started) {
            if (Math.hypot(ev.clientX - x0, ev.clientY - y0) <= DRAG_SLOP) return;
            started = true;
            setDragged(what);
            frame = requestAnimationFrame(scroll);
          }
          follow();
        },
        (ev) => {
          if (ev && started) {
            x = ev.clientX;
            y = ev.clientY;
            follow();
            const d = mark;
            if (d) dropRow(what, d);
            // The release would pick the row under it.
            swallowClick();
          }
          done();
        },
      );
      stopDrag.current = () => {
        unfollow();
        done();
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabBarRef, onDropTab],
  );

  /** Applies a drop to the latest list (see the top of the file). */
  const dropRow = (what: Dragged, d: Drop) => {
    const { list: l, tab: shown } = live.current;
    const item = l.groups.find((g) => g.id === what.groupId)?.items.find((i) => itemKey(i) === what.key);
    if (!item) return;
    const label = contractLabel(item.contract);
    if (d.kind === 'tab') {
      const target = l.groups.find((g) => g.id === d.groupId);
      if (!target) return;
      const name = nameOf(target.name, lang);
      if (groupHas(target, what.key)) {
        useStore.getState().showToast(m.alreadyIn(label, name));
        return;
      }
      if (shown === ALL_TAB) {
        updateList(l.id, (x) => addItem(x, target.id, item, DEFAULT_GROUP_NAME));
        useStore.getState().showToast(m.addedTo(label, name));
      } else {
        updateList(l.id, (x) => moveItem(x, what.groupId, target.id, what.key));
        useStore.getState().showToast(m.movedTo(label, name));
      }
      return;
    }
    if (shown !== ALL_TAB) {
      updateList(l.id, (x) => moveItemTo(x, shown, what.key, shown, d.index));
      return;
    }
    const others = tabRows(l, ALL_TAB).filter((r) => itemKey(r.item) !== what.key);
    const place = allDrop(l, others, d.index, what.key, what.groupId);
    if (place) updateList(l.id, (x) => moveItemTo(x, what.groupId, what.key, place.groupId, place.index));
  };

  // An index opens too: its chart (and options), without the order ticket.
  const pick = useCallback((item: WatchItem) => useStore.getState().selectSymbol(item.contract, item.name), []);

  return (
    <div role="tabpanel" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Over the rows' scroller, not in it, with the same room for its scrollbar (scrollGutter.ts), so the columns line up. */}
      <div style={{ flexShrink: 0, overflow: 'hidden', ...stableGutter, padding: `0 max(3px, ${lessGutter(8)}) 0 8px`, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>
        <WatchHeader template={template} gap={COL_GAP} pad={ROW_PAD} />
      </div>
      {/* Adding rows makes the list scroll; the rows keep their width (scrollGutter.ts). */}
      <div
        ref={rootRef}
        onPointerEnter={() => setHold(true)}
        onPointerLeave={() => setHold(false)}
        style={{
          position: 'relative',
          flex: 1,
          // Up and down only: the columns give way in a narrow panel (model.ts → columnsTemplate).
          overflowX: 'hidden',
          overflowY: 'auto',
          ...stableGutter,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--rowGap)',
          padding: `4px max(3px, ${lessGutter(8)}) 8px 8px`,
        }}
      >
        {rows.map((r: TabRow) => {
          const k = itemKey(r.item);
          return (
            <WatchRow
              key={k}
              item={r.item}
              groupId={r.groupId}
              lang={lang}
              template={template}
              order={columns.order}
              selected={k === selectedKey}
              dragged={dragged?.key === k}
              onPick={pick}
              onMenu={onRowMenu}
              onPress={press}
            />
          );
        })}
        {!rows.length && (
          <div style={{ padding: '24px 16px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10, fontSize: 12, color: 'var(--dm)' }}>
            <div>{tab === ALL_TAB ? m.emptyAll : m.emptyTab}</div>
            <button type="button" onClick={onAdd} className="hover-tx focus-ring" style={{ border: 'none', background: 'transparent', padding: 0, fontSize: 12, color: 'var(--ac)', cursor: 'pointer' }}>
              + {m.addSymbol}
            </button>
          </div>
        )}
        {drop?.kind === 'row' && (
          <div
            aria-hidden
            data-wl="drop"
            style={{ position: 'absolute', left: 8, right: 4, top: drop.y - 1, height: 2, zIndex: 2, background: 'var(--ac)', pointerEvents: 'none' }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The keys in the order the rows are drawn: a new tab or sort, or the pointer leaving the rows,
 * takes the wanted order at once; while the pointer is over them (`hold`), and within RESORT_MS of
 * the last re-sort, the drawn rows keep their places (model.ts → heldKeys), and a held-back re-sort
 * runs when that second is over. As the Positions table does its rows.
 */
function useHeldOrder(wanted: readonly string[], sig: string, hold: boolean): readonly string[] {
  const drawn = useRef<readonly string[]>(wanted);
  const sortedAt = useRef(0);
  const prev = useRef({ sig, hold });
  const [woken, wake] = useReducer((n: number) => n + 1, 0);
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

  const resort = prev.current.sig !== sig || (prev.current.hold && !hold);
  let next: readonly string[] = resort || (!hold && Date.now() - sortedAt.current >= RESORT_MS) ? wanted : heldKeys(drawn.current, wanted);
  if (same(next, drawn.current)) next = drawn.current;

  useLayoutEffect(() => {
    if (next !== drawn.current && same(next, wanted)) sortedAt.current = Date.now();
    drawn.current = next;
    prev.current = { sig, hold };
  });

  const pending = !hold && !same(next, wanted);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(wake, Math.max(0, sortedAt.current + RESORT_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [pending, woken]);
  return next;
}

/** One instrument on one line: symbol (its name on hover), last price, today's change. */
const WatchRow = memo(function WatchRow({
  item,
  groupId,
  lang,
  template,
  order,
  selected,
  dragged,
  onPick,
  onMenu,
  onPress,
}: {
  item: WatchItem;
  groupId: string;
  lang: Lang;
  /** The columns' grid and order (WatchHeader). */
  template: string;
  order: readonly WatchCol[];
  selected: boolean;
  /** Being dragged (or its group is): faded. */
  dragged: boolean;
  onPick: (item: WatchItem) => void;
  onMenu: (e: MouseEvent, groupId: string, item: WatchItem) => void;
  /** A press that may start dragging the row. */
  onPress: (e: PointerEvent<HTMLElement>, what: Dragged) => void;
}) {
  const m = useWatchlistMessages.for(lang);
  const key = contractKey(item.contract);
  const q = useStore((s) => s.quotes[key]);
  const last = lastPrice(q);
  const chg = changePct(q);
  const chgAbs = changeAbs(q);
  const name = nameOf(item.name, lang);
  // IB refused the subscription (e.g. 354 not subscribed) and nothing arrived: say so instead of
  // a bare "—". 10089 (no live subscription) is followed by delayed data when that is enabled.
  const noData = q?.error != null && q.error.code !== NO_LIVE_SUBSCRIPTION && last == null;
  const currency = item.contract.currency;
  // The symbol's tooltip: the name, and where its quotes come from when not SMART ("Live · NASDAQ").
  const symbolTip = [name, q?.source ? m.viaTip(q.source.exchange, contractLabel(item.contract), q.marketDataType) : ''].filter(Boolean).join('\n') || undefined;
  return (
    <div
      data-wl-row=""
      data-group={groupId}
      data-key={key}
      onClick={() => onPick(item)}
      onContextMenu={(e) => onMenu(e, groupId, item)}
      onPointerDown={(e) => onPress(e, { groupId, key })}
      style={{
        height: 36,
        userSelect: 'none',
        opacity: dragged ? 0.45 : 1,
        flexShrink: 0,
        display: 'grid',
        gridTemplateColumns: template,
        gap: COL_GAP,
        alignItems: 'center',
        padding: ROW_PAD,
        cursor: 'pointer',
        background: selected ? 'var(--sel)' : 'transparent',
        boxShadow: selected ? 'inset 2px 0 0 var(--ac)' : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 }}>
        <div className="ellipsis" title={symbolTip} style={{ fontWeight: 600, minWidth: 0 }}>
          {contractLabel(item.contract)}
        </div>
        {/* Non-USD listings look like the US one otherwise ("IBM" on IBIS is quoted in EUR). */}
        {currency && currency !== 'USD' && <div style={{ flexShrink: 0, font: '10.5px/1 var(--mono)', color: 'var(--dm)' }}>{currency}</div>}
        {/* Served by its primary exchange because SMART is delayed for this stock: a dot, the details on hover. */}
        {q?.source && (
          <div data-wl="via" title={m.viaTip(q.source.exchange, contractLabel(item.contract), q.marketDataType)} style={{ flexShrink: 0, width: 5, height: 5, borderRadius: '50%', background: 'var(--dm)', alignSelf: 'center' }} />
        )}
      </div>
      {order.map((col) => {
        if (col === 'last')
          return (
            <div key={col} className="num ellipsis" title={q?.error ? `${q.error.code} · ${q.error.message}` : px(last)} style={{ textAlign: 'right' }}>
              {px(last)}
            </div>
          );
        if (noData)
          return col === 'pct' ? (
            <div key={col} className="ellipsis" title={q?.error ? `${q.error.code} · ${q.error.message}` : undefined} style={{ textAlign: 'right', fontSize: 12, color: 'var(--dm)' }}>
              {m.noData}
            </div>
          ) : (
            <div key={col} />
          );
        const text = col === 'chg' ? sg(chgAbs, px) : pct(chg);
        return (
          <div key={col} className="num ellipsis" title={text} style={{ textAlign: 'right', fontSize: 12, color: signColor(chg) }}>
            {text}
          </div>
        );
      })}
    </div>
  );
});
