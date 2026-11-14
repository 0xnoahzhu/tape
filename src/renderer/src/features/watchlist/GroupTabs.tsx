// The watchlist's tab bar: All, then one tab per group with its count, then "+" for a new tab.
//
// A click shows a tab; right-click opens a tab's menu (rename, delete) and a double-click renames
// it in place. A tab is dragged sideways to move it among the others (followPointer, as the rows: a
// press that moves more than DRAG_SLOP px drags, Escape undoes it); All stays first. While a row is
// dragged (GroupList), the tab under it lights up (`dropTab`). The bar scrolls sideways when the
// tabs do not fit: the wheel scrolls it, and the shown tab is kept in view. ← / → move between tabs.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import type { Watchlist } from '@shared/types';
import { nameOf, useLang } from '../../i18n';
import { useRefocus } from '../../ui/focus';
import { followPointer, swallowClick } from '../../ui/pointerDrag';
import { edgeScroll } from '../portfolio/columnsState';
import { updateList } from './actions';
import { GroupNameInput } from './GroupNameInput';
import { useWatchlistMessages } from './messages';
import { ALL_TAB, createGroup, dropIndex, listKeys, moveGroupTo, newId, renameGroup } from './model';

/** A press moves this far (px) before it drags; less is a click. */
const DRAG_SLOP = 4;
/** Within this many px of the bar's ends a drag scrolls it, up to EDGE_SPEED px a frame. */
const EDGE = 32;
const EDGE_SPEED = 12;
export const TAB_BAR_H = 38;

export function GroupTabs({
  list,
  tab,
  barRef,
  renamingId,
  menuGroupId,
  dropTab,
  onSelect,
  onRename,
  onMenu,
}: {
  list: Watchlist;
  /** The tab shown (resolved: All or a group of the list). */
  tab: string;
  barRef: RefObject<HTMLDivElement | null>;
  /** Tab whose name is being edited in place. */
  renamingId: string | undefined;
  /** Tab whose menu is open. */
  menuGroupId: string | undefined;
  /** Tab a dragged row would go to. */
  dropTab: string | undefined;
  onSelect: (tab: string) => void;
  onRename: (groupId: string | null) => void;
  onMenu: (e: MouseEvent, groupId: string) => void;
}) {
  const m = useWatchlistMessages();
  const lang = useLang();
  const [naming, setNaming] = useState(false);
  const refocus = useRefocus();
  const focusTab = (id: string) => refocus(() => barRef.current?.querySelector<HTMLElement>(`[data-wl-tab="${CSS.escape(id)}"]`) ?? null);

  // The shown tab stays in view (picked from the keyboard, created, or after a list change).
  useEffect(() => {
    barRef.current?.querySelector(`[data-wl-tab="${CSS.escape(tab)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab, barRef, list.groups.length]);

  // The wheel scrolls the bar sideways (a mouse wheel only turns up / down).
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += d;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [barRef]);

  // Dragging a tab (see the top of the file): where it lands among the others, drawn as a line at `x` (in the bar's content).
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ index: number; x: number } | null>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  useEffect(() => {
    if (!dragged) return;
    const html = document.documentElement;
    html.classList.add('pos-reordering');
    return () => html.classList.remove('pos-reordering');
  }, [dragged]);

  const press = useCallback(
    (e: PointerEvent<HTMLElement>, groupId: string) => {
      const bar = barRef.current;
      if (e.button !== 0 || e.pointerType === 'touch' || !bar || stopDrag.current) return;
      const { clientX: x0, clientY: y0 } = e;
      let x = x0;
      let started = false;
      let frame = 0;
      let mark: { index: number; x: number } | null = null;
      const follow = () => {
        const left = bar.getBoundingClientRect().left - bar.scrollLeft;
        const others = [...bar.querySelectorAll<HTMLElement>('[data-wl-group]')].filter((t) => t.dataset.wlGroup !== groupId).map((t) => t.getBoundingClientRect());
        if (!others.length) return;
        const index = dropIndex(
          others.map((r) => ({ top: r.left, bottom: r.right })),
          x,
        );
        const at = index < others.length ? others[index].left - left - 8 : others[others.length - 1].right - left + 8;
        if (mark && mark.index === index && mark.x === at) return;
        mark = { index, x: at };
        setDrop(mark);
      };
      const scroll = () => {
        frame = requestAnimationFrame(scroll);
        const r = bar.getBoundingClientRect();
        const step = edgeScroll(x, x0, r.left, r.right, EDGE, EDGE_SPEED);
        if (!step) return;
        const before = bar.scrollLeft;
        bar.scrollLeft = before + step;
        if (bar.scrollLeft !== before) follow();
      };
      const done = () => {
        cancelAnimationFrame(frame);
        stopDrag.current = null;
        setDragged(null);
        setDrop(null);
      };
      const unfollow = followPointer(
        e.pointerId,
        (ev) => {
          x = ev.clientX;
          if (!started) {
            if (Math.hypot(ev.clientX - x0, ev.clientY - y0) <= DRAG_SLOP) return;
            started = true;
            setDragged(groupId);
            frame = requestAnimationFrame(scroll);
          }
          follow();
        },
        (ev) => {
          if (ev && started) {
            x = ev.clientX;
            follow();
            const d = mark;
            if (d) updateList(listRef.current.id, (l) => moveGroupTo(l, groupId, d.index));
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
    [barRef],
  );

  const create = (value: string, byKey: boolean) => {
    setNaming(false);
    const name = value.trim();
    if (!name) return;
    const id = newId('g');
    updateList(list.id, (l) => createGroup(l, name, id));
    onSelect(id);
    if (byKey) focusTab(id);
  };

  const ids = [ALL_TAB, ...list.groups.map((g) => g.id)];
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = ids.indexOf(tab);
    const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowLeft' ? -1 : 1)))];
    onSelect(next);
    focusTab(next);
  };

  const tabStyle = (on: boolean, lit: boolean, faded: boolean) => ({
    flexShrink: 0,
    display: 'flex',
    alignItems: 'baseline',
    gap: 5,
    padding: '0 2px',
    border: 'none',
    background: lit ? 'var(--sel)' : 'transparent',
    font: 'inherit',
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap' as const,
    cursor: 'pointer',
    userSelect: 'none' as const,
    color: on ? 'var(--tx)' : 'var(--dm)',
    boxShadow: lit ? 'inset 0 0 0 1px var(--ac)' : on ? 'inset 0 -2px 0 var(--ac)' : 'none',
    opacity: faded ? 0.45 : 1,
    lineHeight: `${TAB_BAR_H}px`,
  });
  const count = (n: number) => <span style={{ font: '11px/1 var(--num)', color: 'var(--dm)', fontWeight: 400 }}>{n}</span>;

  return (
    <div
      ref={barRef}
      role="tablist"
      aria-label={m.tabs}
      style={{
        position: 'relative',
        height: TAB_BAR_H,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        gap: 16,
        padding: '0 12px 0 20px',
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'none',
        boxShadow: 'inset 0 -1px 0 var(--ln2)',
      }}
    >
      <button type="button" role="tab" aria-selected={tab === ALL_TAB} data-wl-tab={ALL_TAB} onClick={() => onSelect(ALL_TAB)} onKeyDown={onKeyDown} className="focus-ring" style={tabStyle(tab === ALL_TAB, false, false)}>
        {m.all}
        {count(listKeys(list).size)}
      </button>
      {list.groups.map((g) => {
        const name = nameOf(g.name, lang);
        if (g.id === renamingId)
          return (
            <GroupNameInput
              key={g.id}
              list={list}
              groupId={g.id}
              initial={name}
              onSave={(v, byKey) => {
                onRename(null);
                updateList(list.id, (l) => renameGroup(l, g.id, v, lang));
                if (byKey) focusTab(g.id);
              }}
              onCancel={(byKey) => {
                onRename(null);
                if (byKey) focusTab(g.id);
              }}
            />
          );
        const on = tab === g.id;
        return (
          <button
            key={g.id}
            type="button"
            role="tab"
            aria-selected={on}
            data-wl-tab={g.id}
            data-wl-group={g.id}
            title={name}
            onClick={() => onSelect(g.id)}
            onDoubleClick={() => onRename(g.id)}
            onContextMenu={(e) => onMenu(e, g.id)}
            onPointerDown={(e) => press(e, g.id)}
            onKeyDown={onKeyDown}
            className="focus-ring"
            style={{ ...tabStyle(on, dropTab === g.id, dragged === g.id), background: dropTab === g.id ? 'var(--sel)' : g.id === menuGroupId ? 'var(--p2)' : 'transparent' }}
          >
            <span className="ellipsis" style={{ maxWidth: 140 }}>
              {name}
            </span>
            {count(g.items.length)}
          </button>
        );
      })}
      {naming ? (
        <GroupNameInput
          list={list}
          placeholder={m.groupPh}
          onSave={create}
          onCancel={(byKey) => {
            setNaming(false);
            if (byKey) refocus(() => barRef.current?.querySelector<HTMLElement>('[data-wl-new]') ?? null);
          }}
        />
      ) : (
        <button
          type="button"
          data-wl-new=""
          title={m.newGroup}
          aria-label={m.newGroup}
          onClick={() => setNaming(true)}
          className="hover-tx focus-ring"
          style={{ flexShrink: 0, border: 'none', background: 'transparent', padding: '0 4px', fontSize: 15, color: 'var(--dm)', cursor: 'pointer', lineHeight: `${TAB_BAR_H}px` }}
        >
          +
        </button>
      )}
      {drop && (
        <div aria-hidden style={{ position: 'absolute', top: 9, bottom: 9, left: drop.x - 1, width: 2, background: 'var(--ac)', pointerEvents: 'none' }} />
      )}
    </div>
  );
}
