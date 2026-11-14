// The watchlist's tab bar: All, then one tab per group with its count, then "+" for a new tab.
//
// A click shows a tab; right-click opens a tab's menu (rename, delete) and a double-click renames
// it in place. A tab is dragged sideways to move it among the others (followPointer, as the rows: a
// press that moves more than DRAG_SLOP px drags, Escape undoes it); All stays first. While a row is
// dragged (GroupList), the tab under it lights up (`dropTab`). ← / → move between tabs.
//
// The tabs that do not fit the bar go into a dropdown in the last place (fitTabs: as many tabs as
// fit before it, in order); it reads "More", or the name of the tab shown when that is one of them.
// Its items show their tab, and right-click opens a tab's menu as on the bar.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import type { WatchGroup, Watchlist } from '@shared/types';
import { nameOf, useLang } from '../../i18n';
import { useRefocus } from '../../ui/focus';
import { Popover } from '../../ui/primitives';
import { followPointer, swallowClick } from '../../ui/pointerDrag';
import { updateList } from './actions';
import { GroupNameInput } from './GroupNameInput';
import { useWatchlistMessages } from './messages';
import { ALL_TAB, createGroup, dropIndex, fitTabs, listKeys, moveGroupTo, newId, renameGroup } from './model';

/** A press moves this far (px) before it drags; less is a click. */
const DRAG_SLOP = 4;
export const TAB_BAR_H = 38;
/** Space between tabs, and the bar's padding (px). */
const TAB_GAP = 16;
const PAD_L = 20;
const PAD_R = 12;
/** Room kept for "+" and for the new-tab name input while it is open (px). */
const PLUS_W = 20;
const NAMING_W = 110;
const MENU_W = 200;

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

  // How many tabs fit (see the top of the file), from the widths of every tab drawn in a hidden row.
  const measureRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(list.groups.length);
  useLayoutEffect(() => {
    const bar = barRef.current;
    const row = measureRef.current;
    if (!bar || !row) return;
    const update = () => {
      const w = (sel: string) => (row.querySelector<HTMLElement>(sel)?.offsetWidth ?? 0) + TAB_GAP;
      const fixed = PAD_L + PAD_R + w('[data-m="all"]') + (naming ? NAMING_W : PLUS_W);
      const tabs = [...row.querySelectorAll<HTMLElement>('[data-m="tab"]')].map((el) => el.offsetWidth + TAB_GAP);
      setShown(fitTabs(tabs, bar.clientWidth - fixed, w('[data-m="more"]')));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(bar);
    ro.observe(row);
    return () => ro.disconnect();
  }, [barRef, list.groups, naming, lang]);
  const visible = list.groups.slice(0, shown);
  const hidden = list.groups.slice(shown);
  const hiddenShown = hidden.find((g) => g.id === tab);
  const renamingHidden = hidden.find((g) => g.id === renamingId);

  // The dropdown of the tabs that do not fit; a press outside it or Escape closes it.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);
  useEffect(() => {
    if (!hidden.length) setMoreOpen(false);
  }, [hidden.length]);

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
      let mark: { index: number; x: number } | null = null;
      const follow = () => {
        const left = bar.getBoundingClientRect().left;
        const others = [...bar.querySelectorAll<HTMLElement>('[data-wl-group]')].filter((t) => t.dataset.wlGroup !== groupId).map((t) => t.getBoundingClientRect());
        if (!others.length) return;
        const index = dropIndex(
          others.map((r) => ({ top: r.left, bottom: r.right })),
          x,
        );
        const at = index < others.length ? others[index].left - left - TAB_GAP / 2 : others[others.length - 1].right - left + TAB_GAP / 2;
        if (mark && mark.index === index && mark.x === at) return;
        mark = { index, x: at };
        setDrop(mark);
      };
      const done = () => {
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

  const tabButton = (g: WatchGroup) => {
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
  };
  const caret = <span style={{ fontSize: 8, color: 'var(--dm)', alignSelf: 'center' }}>▼</span>;

  return (
    <div ref={moreRef} style={{ position: 'relative', flexShrink: 0 }}>
      {/* Every tab, unseen: their widths decide how many fit (fitTabs). */}
      <div ref={measureRef} aria-hidden style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', display: 'flex', height: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
        <span data-m="all" style={tabStyle(false, false, false)}>
          {m.all}
          {count(listKeys(list).size)}
        </span>
        {list.groups.map((g) => (
          <span key={g.id} data-m="tab" style={tabStyle(false, false, false)}>
            <span className="ellipsis" style={{ maxWidth: 140 }}>
              {nameOf(g.name, lang)}
            </span>
            {count(g.items.length)}
          </span>
        ))}
        {/* The dropdown at its widest: the longest hidden name it may show. */}
        <span data-m="more" style={tabStyle(false, false, false)}>
          <span className="ellipsis" style={{ maxWidth: 140 }}>
            {[m.more, ...list.groups.map((g) => nameOf(g.name, lang))].reduce((a, b) => (b.length > a.length ? b : a))}
          </span>
          {caret}
        </span>
      </div>
      <div
        ref={barRef}
        role="tablist"
        aria-label={m.tabs}
        style={{
          position: 'relative',
          height: TAB_BAR_H,
          display: 'flex',
          alignItems: 'stretch',
          gap: TAB_GAP,
          padding: `0 ${PAD_R}px 0 ${PAD_L}px`,
          overflow: 'hidden',
          boxShadow: 'inset 0 -1px 0 var(--ln2)',
        }}
      >
        <button type="button" role="tab" aria-selected={tab === ALL_TAB} data-wl-tab={ALL_TAB} onClick={() => onSelect(ALL_TAB)} onKeyDown={onKeyDown} className="focus-ring" style={tabStyle(tab === ALL_TAB, false, false)}>
          {m.all}
          {count(listKeys(list).size)}
        </button>
        {visible.map(tabButton)}
        {renamingHidden
          ? tabButton(renamingHidden)
          : hidden.length > 0 && (
              <button
                type="button"
                role="tab"
                aria-selected={!!hiddenShown}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                data-wl-tab={hiddenShown?.id}
                title={m.moreTip(hidden.length)}
                onClick={() => setMoreOpen((o) => !o)}
                onKeyDown={onKeyDown}
                className="focus-ring"
                style={{ ...tabStyle(!!hiddenShown, false, false), background: moreOpen ? 'var(--p2)' : 'transparent' }}
              >
                <span className="ellipsis" style={{ maxWidth: 140 }}>
                  {hiddenShown ? nameOf(hiddenShown.name, lang) : m.more}
                </span>
                {hiddenShown ? count(hiddenShown.items.length) : count(hidden.length)}
                {caret}
              </button>
            )}
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
      {moreOpen && (
        <Popover style={{ top: TAB_BAR_H, right: PAD_R, width: MENU_W, display: 'block', maxHeight: 320, overflowY: 'auto' }}>
          {hidden.map((g) => {
            const on = g.id === tab;
            return (
              <div
                key={g.id}
                role="menuitemradio"
                aria-checked={on}
                onClick={() => {
                  setMoreOpen(false);
                  onSelect(g.id);
                }}
                onContextMenu={(e) => {
                  setMoreOpen(false);
                  onMenu(e, g.id);
                }}
                className="hover-p2"
                style={{ height: 32, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', cursor: 'pointer', color: 'var(--tx)' }}
              >
                <div style={{ width: 12, flexShrink: 0, color: 'var(--ac)', fontSize: 12 }}>{on ? '✓' : ''}</div>
                <div className="ellipsis" style={{ flex: 1, minWidth: 0, fontWeight: on ? 600 : 400 }}>
                  {nameOf(g.name, lang)}
                </div>
                {count(g.items.length)}
              </div>
            );
          })}
        </Popover>
      )}
    </div>
  );
}
