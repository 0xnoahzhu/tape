// Scrollable body of the watchlist: collapsible groups (rename / delete on the header), quote
// rows and "+ New group".
//
// Rows and groups are dragged to reorder them (followPointer, as the Positions headers): a press
// that moves more than DRAG_SLOP px drags; a shorter one is a click (a row picks its symbol, a
// header opens or closes its group). A row goes between the rows of any open group (the accent line
// says where), or to the end of a closed group dropped on its header (which lights up); a group
// goes between the others. Near the list's top or bottom it scrolls; Escape undoes the drag, and the
// release's click is swallowed. The landing place is read from the rows and headers drawn
// (model.ts → dropIndex) and applied as one change (moveItemTo, moveGroupTo).

import { memo, useCallback, useEffect, useRef, useState, type FocusEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import { pct, px, signColor } from '@shared/format';
import type { Lang, WatchItem, Watchlist } from '@shared/types';
import { changePct, lastPrice } from '../../hooks/useQuotes';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { useRefocus } from '../../ui/focus';
import { CrossIcon, PencilIcon } from '../../ui/icons';
import { GlyphButton, TextInput } from '../../ui/primitives';
import { lessGutter, stableGutter } from '../../ui/scrollGutter';
import { edgeScroll } from '../portfolio/columnsState';
import { followPointer, swallowClick } from '../../ui/pointerDrag';
import { askDeleteGroup, updateList } from './actions';
import { useWatchlistMessages } from './messages';
import { canDeleteGroup, createGroup, dropIndex, groupNameTaken, itemKey, moveGroupTo, moveItemTo, newId, pruneClosedGroups, renameGroup } from './model';
import { groupPrefKey, loadClosedGroups, saveClosedGroups } from './prefs';

/** IB error "requires additional subscription"; delayed data, when enabled, follows it. */
const NO_LIVE_SUBSCRIPTION = 10089;

/** A press moves this far (px) before it drags; less is a click. */
const DRAG_SLOP = 4;
/** Within this many px of the list's top or bottom a drag scrolls it, up to EDGE_SPEED px a frame. */
const EDGE = 40;
const EDGE_SPEED = 14;

/** What is dragged: a row (its group and key) or a group. */
type Dragged = { kind: 'item'; groupId: string; key: string } | { kind: 'group'; groupId: string };
/**
 * Where it lands: a row at `index` of a group (among its other rows), drawn as a line at `y`, or
 * `into` a closed group (its header lit); a group at `index` among the others, a line at `y`. `y` is
 * in the list's content (scrolled with it).
 */
type Drop = { kind: 'item'; groupId: string; index: number; y: number | null } | { kind: 'group'; index: number; y: number };

interface Box {
  top: number;
  bottom: number;
}

/**
 * The landing place of `what` at viewport height `y` in the list `root`, from the headers
 * (`data-wl-header`) and rows (`data-wl-row`) drawn; the dragged row or group itself is left out,
 * as the model counts places among the others. `counts`: each group's rows, open or not.
 */
function dropAt(root: HTMLElement, what: Dragged, y: number, counts: ReadonlyMap<string, number>): Drop | null {
  const top = root.getBoundingClientRect().top - root.scrollTop;
  const inList = (b: Box): Box => ({ top: b.top - top, bottom: b.bottom - top });
  const sections = [...root.querySelectorAll<HTMLElement>('[data-wl-header]')].map((h) => {
    const groupId = h.dataset.wlHeader!;
    const rows = [...root.querySelectorAll<HTMLElement>('[data-wl-row]')].filter((r) => r.dataset.group === groupId);
    const head = h.getBoundingClientRect();
    const last = rows.length ? rows[rows.length - 1].getBoundingClientRect() : head;
    return { groupId, open: h.dataset.open === 'true', head, rows, box: { top: head.top, bottom: last.bottom } };
  });
  if (!sections.length) return null;
  const gap = (a: Box, b: Box) => (b.top - a.bottom) / 2;

  if (what.kind === 'group') {
    const others = sections.filter((s) => s.groupId !== what.groupId);
    if (!others.length) return null;
    const index = dropIndex(others.map((s) => s.box), y);
    const at =
      index < others.length
        ? inList(others[index].box).top - (index > 0 ? gap(others[index - 1].box, others[index].box) : 2)
        : inList(others[others.length - 1].box).bottom + 2;
    return { kind: 'group', index, y: at };
  }

  // The group under the pointer: the last whose top is above it (the first above all of them).
  const s = [...sections].reverse().find((x) => x.box.top <= y) ?? sections[0];
  const own = (r: HTMLElement) => r.dataset.group === what.groupId && r.dataset.key === what.key;
  const rows = s.rows.filter((r) => !own(r)).map((r) => r.getBoundingClientRect());
  if (!s.open) {
    // Closed: to its end, onto its header.
    const n = (counts.get(s.groupId) ?? 0) - (s.groupId === what.groupId ? 1 : 0);
    return { kind: 'item', groupId: s.groupId, index: Math.max(0, n), y: null };
  }
  if (y < s.head.bottom || !rows.length) return { kind: 'item', groupId: s.groupId, index: 0, y: inList(s.head).bottom };
  const index = dropIndex(rows, y);
  const at = index < rows.length ? inList(rows[index]).top : inList(rows[rows.length - 1]).bottom;
  return { kind: 'item', groupId: s.groupId, index, y: at };
}

const sameDrop = (a: Drop | null, b: Drop | null): boolean =>
  a === b || (!!a && !!b && a.kind === b.kind && a.index === b.index && a.y === b.y && (a.kind === 'group' || (b.kind === 'item' && a.groupId === b.groupId)));

export function GroupList({
  list,
  renamingId,
  menuGroupId,
  onRename,
  onGroupMenu,
  onRowMenu,
  onGroupCreated,
}: {
  list: Watchlist;
  /** Group whose name is being edited in its header. */
  renamingId: string | undefined;
  /** Group whose context menu is open. */
  menuGroupId: string | undefined;
  onRename: (groupId: string | null) => void;
  onGroupMenu: (e: MouseEvent, groupId: string) => void;
  onRowMenu: (e: MouseEvent, groupId: string, item: WatchItem) => void;
  onGroupCreated: (groupId: string) => void;
}) {
  const m = useWatchlistMessages();
  const lang = useLang();
  const selectedKey = useStore((s) => contractKey(s.symbol));
  const [closed, setClosed] = useState(loadClosedGroups);
  const [naming, setNaming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const newGroupRef = useRef<HTMLButtonElement>(null);
  const refocus = useRefocus();
  // Enter / Escape in a name editor and a deleted group's × remove the focused element: focus
  // goes to the ✎ of the group's header (or the one now in its place), or to "+ New group".
  const focusHeader = (groupId?: string) =>
    refocus(() => (groupId ? rootRef.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(groupId)}"] button`) : newGroupRef.current));

  // Deleted groups (here, from the context menu or another window) leave no collapsed state behind.
  useEffect(() => {
    setClosed((prev) => {
      const next = pruneClosedGroups(prev, list);
      if (next !== prev) saveClosedGroups(next);
      return next;
    });
  }, [list]);

  const toggleGroup = (groupId: string) => {
    const k = groupPrefKey(list.id, groupId);
    setClosed((prev) => {
      const next = { ...prev };
      if (next[k]) delete next[k];
      else next[k] = true;
      saveClosedGroups(next);
      return next;
    });
  };

  // Dragging a row or a group (see the top of the file).
  const [dragged, setDragged] = useState<Dragged | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const listRef = useRef(list);
  listRef.current = list;
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

  const press = useCallback((e: PointerEvent<HTMLElement>, what: Dragged) => {
    const root = rootRef.current;
    // Not from the header's ✎ and × or a name being edited; not a second press while one drags.
    if (e.button !== 0 || e.pointerType === 'touch' || !root || stopDrag.current || (e.target as HTMLElement).closest('button, input')) return;
    const { clientX: x0, clientY: y0 } = e;
    let y = y0;
    let started = false;
    let frame = 0;
    let mark: Drop | null = null;
    const counts = new Map(listRef.current.groups.map((g) => [g.id, g.items.length]));
    const follow = () => {
      const next = dropAt(root, what, y, counts);
      if (sameDrop(mark, next)) return;
      mark = next;
      setDrop(next);
    };
    // Each frame of the drag: near the list's top or bottom, scroll it (and follow the rows that moved).
    const scroll = () => {
      frame = requestAnimationFrame(scroll);
      const r = root.getBoundingClientRect();
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
    };
    const unfollow = followPointer(
      e.pointerId,
      (ev) => {
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
          y = ev.clientY;
          follow();
          const d = mark;
          if (d?.kind === 'item' && what.kind === 'item') updateList(listRef.current.id, (l) => moveItemTo(l, what.groupId, what.key, d.groupId, d.index));
          if (d?.kind === 'group' && what.kind === 'group') updateList(listRef.current.id, (l) => moveGroupTo(l, what.groupId, d.index));
          // The release would pick the row or toggle the group under it.
          swallowClick();
        }
        done();
      },
    );
    stopDrag.current = () => {
      unfollow();
      done();
    };
  }, []);

  // An index opens too: its chart (and options), without the order ticket.
  const pick = useCallback((item: WatchItem) => useStore.getState().selectSymbol(item.contract, item.name), []);

  const createNamedGroup = (value: string, byKey: boolean) => {
    const name = value.trim();
    setNaming(false);
    if (byKey) focusHeader();
    if (!name) return;
    const id = newId('g');
    updateList(list.id, (l) => createGroup(l, name, id));
    onGroupCreated(id);
  };

  const saveName = (groupId: string, name: string, byKey: boolean) => {
    onRename(null);
    if (byKey) focusHeader(groupId);
    updateList(list.id, (l) => renameGroup(l, groupId, name, lang));
  };

  const cancelRename = (groupId: string, byKey: boolean) => {
    onRename(null);
    if (byKey) focusHeader(groupId);
  };

  const canDelete = canDeleteGroup(list);
  return (
    // Opening a group or adding rows makes the list scroll; the rows keep their width (scrollGutter.ts).
    // 3 px stay on the right for the focus ring of "New group" (outline-offset 2 px), which the scroller clips.
    <div
      ref={rootRef}
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
      {list.groups.map((g) => {
        const open = !closed[groupPrefKey(list.id, g.id)];
        const name = nameOf(g.name, lang);
        const groupDragged = dragged?.kind === 'group' && dragged.groupId === g.id;
        return (
          <GroupSection
            key={g.id}
            id={g.id}
            name={name}
            count={g.items.length}
            open={open}
            dragged={groupDragged}
            target={drop?.kind === 'item' && drop.y == null && drop.groupId === g.id}
            onPress={(e) => press(e, { kind: 'group', groupId: g.id })}
            menuOpen={g.id === menuGroupId}
            canDelete={canDelete}
            editor={
              g.id === renamingId ? (
                <GroupNameInput
                  list={list}
                  groupId={g.id}
                  initial={name}
                  lead={<Arrow open={open} />}
                  onSave={(v, byKey) => saveName(g.id, v, byKey)}
                  onCancel={(byKey) => cancelRename(g.id, byKey)}
                />
              ) : undefined
            }
            onToggle={() => toggleGroup(g.id)}
            onRename={() => onRename(g.id)}
            onDelete={() => askDeleteGroup(list.id, g.id, focusHeader)}
            onMenu={(e) => onGroupMenu(e, g.id)}
          >
            {g.items.map((item) => {
              const k = itemKey(item);
              const rowDragged = groupDragged || (dragged?.kind === 'item' && dragged.groupId === g.id && dragged.key === k);
              return (
                <WatchRow key={k} item={item} groupId={g.id} lang={lang} selected={k === selectedKey} dragged={rowDragged} onPick={pick} onMenu={onRowMenu} onPress={press} />
              );
            })}
          </GroupSection>
        );
      })}
      {drop?.y != null && (
        <div
          aria-hidden
          data-wl="drop"
          style={{ position: 'absolute', left: 8, right: 4, top: drop.y - 1, height: 2, zIndex: 2, background: 'var(--ac)', pointerEvents: 'none' }}
        />
      )}
      {naming ? (
        <GroupNameInput
          list={list}
          placeholder={m.groupPh}
          onSave={createNamedGroup}
          onCancel={(byKey) => {
            setNaming(false);
            if (byKey) focusHeader();
          }}
        />
      ) : (
        <button
          ref={newGroupRef}
          type="button"
          onClick={() => setNaming(true)}
          className="hover-tx"
          style={{
            height: 34,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: LEAD.gap,
            padding: `0 8px 0 ${LEAD.inset}px`,
            border: 'none',
            background: 'transparent',
            fontSize: 12,
            color: 'var(--dm)',
            cursor: 'pointer',
          }}
        >
          <span aria-hidden style={{ width: LEAD.width, flexShrink: 0, textAlign: 'left' }}>
            +
          </span>
          <span>{m.newGroup}</span>
        </button>
      )}
    </div>
  );
}

/**
 * Group headers and "New group" start with a 10 px glyph column (8 px in) and a 6 px gap, so the
 * group name and "New group" line up with the tickers of the rows (24 px in).
 */
const LEAD = { inset: 8, width: 10, gap: 6 } as const;

function Arrow({ open }: { open: boolean }) {
  return <div style={{ width: LEAD.width, flexShrink: 0, fontSize: 8, color: 'var(--dm)' }}>{open ? '▼' : '▶'}</div>;
}

/**
 * Group header: arrow, name and count; rename (✎) and delete (×) appear on hover and on keyboard
 * focus, right-click opens the group menu. `editor` replaces the header while renaming.
 */
function GroupSection({
  id,
  name,
  count,
  open,
  dragged,
  target,
  onPress,
  menuOpen,
  canDelete,
  editor,
  onToggle,
  onRename,
  onDelete,
  onMenu,
  children,
}: {
  id: string;
  name: string;
  count: number;
  open: boolean;
  /** The group is being dragged (faded). */
  dragged: boolean;
  /** A row dragged onto this closed group's header goes in it (lit). */
  target: boolean;
  /** A press on the header (not its buttons) may start dragging the group. */
  onPress: (e: PointerEvent<HTMLElement>) => void;
  menuOpen: boolean;
  canDelete: boolean;
  editor: ReactNode;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMenu: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  const m = useWatchlistMessages();
  const [hover, setHover] = useState(false);
  // Keyboard focus only: a clicked button keeps focus, which should not pin the buttons open.
  const [focused, setFocused] = useState(false);
  // An editor closed with Enter / Escape takes the focus with it without a blur event.
  const editing = editor != null;
  const [wasEditing, setWasEditing] = useState(editing);
  if (wasEditing !== editing) {
    setWasEditing(editing);
    setFocused(false);
  }
  const onBlur = (e: FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
  };
  const tools = hover || focused;
  return (
    <>
      <div
        data-group={id}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={(e) => setFocused(e.target.matches(':focus-visible'))}
        onBlur={onBlur}
        style={{ flexShrink: 0 }}
      >
        {editor ?? (
          <div
            data-wl-header={id}
            data-open={open}
            onClick={onToggle}
            onContextMenu={onMenu}
            onPointerDown={onPress}
            style={{
              height: 34,
              display: 'flex',
              alignItems: 'center',
              gap: LEAD.gap,
              padding: `0 4px 0 ${LEAD.inset}px`,
              cursor: 'pointer',
              userSelect: 'none',
              fontSize: 12,
              color: 'var(--mu)',
              background: target ? 'var(--sel)' : menuOpen ? 'var(--p2)' : 'transparent',
              boxShadow: target ? 'inset 0 0 0 1px var(--ac)' : undefined,
              opacity: dragged ? 0.45 : 1,
            }}
          >
            <Arrow open={open} />
            <div style={{ display: 'flex', alignItems: 'baseline', gap: LEAD.gap, minWidth: 0 }}>
              <div className="ellipsis" title={name} style={{ minWidth: 0, fontWeight: 600 }}>
                {name}
              </div>
              <div style={{ flexShrink: 0, font: '11px/1 var(--num)', color: 'var(--dm)' }}>{count}</div>
            </div>
            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', flexShrink: 0, opacity: tools ? 1 : 0 }}>
              <GlyphButton title={m.renameGroup} fontSize={12} onClick={onRename}>
                <PencilIcon />
              </GlyphButton>
              <GlyphButton title={canDelete ? m.deleteGroup : m.lastGroup} fontSize={13} danger disabled={!canDelete} onClick={onDelete}>
                <CrossIcon />
              </GlyphButton>
            </div>
          </div>
        )}
      </div>
      {open && children}
    </>
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
      onPointerDown={(e) => onPress(e, { kind: 'item', groupId, key })}
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

/**
 * Inline group name editor: "+ New group" (no `groupId`) and rename in the header. Enter saves,
 * Escape cancels. A name another group of the list has is refused with a hint under the input.
 * `byKey` tells Enter / Escape, which unmount the focused input, from leaving it.
 */
function GroupNameInput({
  list,
  groupId,
  initial = '',
  placeholder,
  lead,
  onSave,
  onCancel,
}: {
  list: Watchlist;
  /** The group being renamed. */
  groupId?: string;
  initial?: string;
  placeholder?: string;
  /** Shown left of the input (the arrow of the header being renamed). */
  lead?: ReactNode;
  onSave: (name: string, byKey: boolean) => void;
  onCancel: (byKey: boolean) => void;
}) {
  const m = useWatchlistMessages();
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter / Escape unmount the input, which can fire a trailing blur; ignore it.
  const done = useRef(false);
  const renaming = groupId != null;
  const taken = groupNameTaken(list, value, groupId);
  const hint = taken ? m.groupExists(value.trim()) : null;

  // A rename starts with the current name selected, so typing replaces it.
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const onBlur = () => {
    if (done.current) return;
    if (!renaming) {
      // As in the design: leaving an empty input cancels, a typed name stays.
      if (!value.trim()) onCancel(false);
      return;
    }
    // Leaving a rename saves it; a taken name reverts, and says why.
    done.current = true;
    if (taken) {
      useStore.getState().showToast(m.groupExists(value.trim()), 'error');
      onCancel(false);
    } else onSave(value, false);
  };

  return (
    <div style={{ flexShrink: 0, position: 'relative', padding: renaming ? 0 : '6px 8px' }}>
      <div style={renaming ? { height: 34, display: 'flex', alignItems: 'center', gap: LEAD.gap, padding: `0 4px 0 ${LEAD.inset}px` } : undefined}>
        {lead}
        <TextInput
          inputRef={inputRef}
          autoFocus
          accent
          value={value}
          placeholder={placeholder}
          height={renaming ? 26 : 34}
          style={renaming ? { flex: 1, padding: '0 6px', font: '600 12px/1 var(--sans)' } : undefined}
          onChange={setValue}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && !taken) {
              // No keypress follows: it would activate the button focus moves to (useRefocus).
              e.preventDefault();
              done.current = true;
              onSave(value, true);
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              done.current = true;
              onCancel(true);
            }
          }}
          onBlur={onBlur}
        />
      </div>
      {hint &&
        (renaming ? (
          // Over the rows below, not between them: the header keeps its height, so the revert on
          // blur cannot move what the pointer is pressing (the click would be lost).
          <div
            style={{
              position: 'absolute',
              top: 31,
              left: 26,
              right: 4,
              zIndex: 1,
              padding: '6px 8px',
              background: 'var(--p)',
              boxShadow: '0 0 0 1px var(--ln), 0 8px 24px rgba(0,0,0,.18)',
              fontSize: 11,
              lineHeight: 1.4,
              color: 'var(--r)',
              pointerEvents: 'none',
            }}
          >
            {hint}
          </div>
        ) : (
          <div style={{ padding: '6px 0 0', fontSize: 11, lineHeight: 1.4, color: 'var(--r)' }}>{hint}</div>
        ))}
    </div>
  );
}
