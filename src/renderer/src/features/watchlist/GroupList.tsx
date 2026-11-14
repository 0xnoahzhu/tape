// Scrollable body of the watchlist: the rows of the tab shown (GroupTabs), one group's symbols or,
// on All, every symbol once (model.ts → tabRows).
//
// Rows are dragged (followPointer, as the tabs): a press that moves more than DRAG_SLOP px drags;
// a shorter one is a click (picks the symbol). A row goes between the others (the accent line says
// where; on All into the group of its neighbours, model.ts → allDrop), or onto a tab of the bar,
// which lights up: from a tab it moves there, from All it is added there too. Near the list's top
// or bottom it scrolls; Escape undoes the drag, and the release's click is swallowed.

import { memo, useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import { pct, px, signColor } from '@shared/format';
import type { Lang, WatchItem, Watchlist } from '@shared/types';
import { changePct, lastPrice } from '../../hooks/useQuotes';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { lessGutter, stableGutter } from '../../ui/scrollGutter';
import { edgeScroll } from '../portfolio/columnsState';
import { followPointer, swallowClick } from '../../ui/pointerDrag';
import { updateList } from './actions';
import { useWatchlistMessages } from './messages';
import { ALL_TAB, addItem, allDrop, dropIndex, groupHas, itemKey, moveItem, moveItemTo, tabRows, type TabRow } from './model';
import { DEFAULT_GROUP_NAME } from './messages';

/** IB error "requires additional subscription"; delayed data, when enabled, follows it. */
const NO_LIVE_SUBSCRIPTION = 10089;

/** A press moves this far (px) before it drags; less is a click. */
const DRAG_SLOP = 4;
/** Within this many px of the list's top or bottom a drag scrolls it, up to EDGE_SPEED px a frame. */
const EDGE = 40;
const EDGE_SPEED = 14;

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
  const rows = tabRows(list, tab);

  const [dragged, setDragged] = useState<Dragged | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const live = useRef({ list, tab });
  live.current = { list, tab };
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
        if (y < r.top - 8) return null;
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
    // Adding rows makes the list scroll; the rows keep their width (scrollGutter.ts).
    <div
      ref={rootRef}
      role="tabpanel"
      style={{
        position: 'relative',
        flex: 1,
        overflow: 'auto',
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
  );
}

/** One instrument: symbol and name on the left, last price and change on the right. */
const WatchRow = memo(function WatchRow({
  item,
  groupId,
  lang,
  selected,
  dragged,
  onPick,
  onMenu,
  onPress,
}: {
  item: WatchItem;
  groupId: string;
  lang: Lang;
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
  const name = nameOf(item.name, lang);
  // IB refused the subscription (e.g. 354 not subscribed) and nothing arrived: say so instead of
  // a bare "—". 10089 (no live subscription) is followed by delayed data when that is enabled.
  const noData = q?.error != null && q.error.code !== NO_LIVE_SUBSCRIPTION && last == null;
  const currency = item.contract.currency;
  return (
    <div
      data-wl-row=""
      data-group={groupId}
      data-key={key}
      onClick={() => onPick(item)}
      onContextMenu={(e) => onMenu(e, groupId, item)}
      onPointerDown={(e) => onPress(e, { groupId, key })}
      style={{
        height: 52,
        userSelect: 'none',
        opacity: dragged ? 0.45 : 1,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px 0 24px',
        cursor: 'pointer',
        background: selected ? 'var(--sel)' : 'transparent',
        boxShadow: selected ? 'inset 2px 0 0 var(--ac)' : 'none',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          <div style={{ fontWeight: 600, flexShrink: 0 }}>{contractLabel(item.contract)}</div>
          {/* Non-USD listings look like the US one otherwise ("IBM" on IBIS is quoted in EUR). */}
          {currency && currency !== 'USD' && <div style={{ font: '10.5px/1 var(--mono)', color: 'var(--dm)' }}>{currency}</div>}
          {/* Served by its primary exchange because SMART is delayed for this stock: "Live · NASDAQ". */}
          {q?.source && (
            <div
              data-wl="via"
              className="ellipsis"
              title={m.viaTip(q.source.exchange, contractLabel(item.contract), q.marketDataType)}
              style={{ fontSize: 11, lineHeight: 1, color: 'var(--dm)', minWidth: 0 }}
            >
              {m.via(q.source.exchange, q.marketDataType)}
            </div>
          )}
        </div>
        <div className="ellipsis" title={name || undefined} style={{ fontSize: 12, color: 'var(--dm)' }}>
          {name || ' '}
        </div>
      </div>
      <div
        className="num"
        title={q?.error ? `${q.error.code} · ${q.error.message}` : q?.source ? m.viaTip(q.source.exchange, contractLabel(item.contract), q.marketDataType) : undefined}
        style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end', flexShrink: 0, paddingLeft: 8 }}
      >
        <div>{px(last)}</div>
        {noData ? <div style={{ fontSize: 12, color: 'var(--dm)' }}>{m.noData}</div> : <div style={{ fontSize: 12, color: signColor(chg) }}>{pct(chg)}</div>}
      </div>
    </div>
  );
});
