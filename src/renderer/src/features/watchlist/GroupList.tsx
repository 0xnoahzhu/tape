// Scrollable body of the watchlist: collapsible groups (rename / delete on the header), quote
// rows and "+ New group".

import { memo, useCallback, useEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import { contractKey, contractLabel, isTradable } from '@shared/contract';
import { pct, px, signColor } from '@shared/format';
import type { Lang, WatchItem, Watchlist } from '@shared/types';
import { changePct, lastPrice } from '../../hooks/useQuotes';
import { useCommon } from '../../i18n/common';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { useRefocus } from '../../ui/focus';
import { GlyphButton, TextInput } from '../../ui/primitives';
import { askDeleteGroup, updateList } from './actions';
import { useWatchlistMessages } from './messages';
import { canDeleteGroup, createGroup, groupNameTaken, itemKey, newId, pruneClosedGroups, renameGroup } from './model';
import { groupPrefKey, loadClosedGroups, saveClosedGroups } from './prefs';

/** IB error "requires additional subscription"; delayed data, when enabled, follows it. */
const NO_LIVE_SUBSCRIPTION = 10089;

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

  const pick = useCallback((item: WatchItem) => {
    const s = useStore.getState();
    if (!isTradable(item.contract)) {
      s.showToast(useCommon.now().indexNotTradable(contractLabel(item.contract)));
      return;
    }
    s.selectSymbol(item.contract, item.name);
  }, []);

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
    <div ref={rootRef} style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--rowGap)', padding: '4px 8px 8px' }}>
      {list.groups.map((g) => {
        const open = !closed[groupPrefKey(list.id, g.id)];
        const name = nameOf(g.name, lang);
        return (
          <GroupSection
            key={g.id}
            id={g.id}
            name={name}
            count={g.items.length}
            open={open}
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
              return <WatchRow key={k} item={item} groupId={g.id} lang={lang} selected={k === selectedKey} onPick={pick} onMenu={onRowMenu} />;
            })}
          </GroupSection>
        );
      })}
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
            padding: '0 8px 0 26px',
            border: 'none',
            background: 'transparent',
            fontSize: 12,
            color: 'var(--dm)',
            cursor: 'pointer',
          }}
        >
          {m.newGroup}
        </button>
      )}
    </div>
  );
}

function Arrow({ open }: { open: boolean }) {
  return <div style={{ width: 10, flexShrink: 0, fontSize: 8, color: 'var(--dm)' }}>{open ? '▼' : '▶'}</div>;
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
            onClick={onToggle}
            onContextMenu={onMenu}
            style={{
              height: 34,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 4px 0 8px',
              cursor: 'pointer',
              fontSize: 12,
              color: 'var(--mu)',
              background: menuOpen ? 'var(--p2)' : 'transparent',
            }}
          >
            <Arrow open={open} />
            <div className="ellipsis" title={name} style={{ minWidth: 0, fontWeight: 600 }}>
              {name}
            </div>
            <div style={{ flexShrink: 0, font: '11px/1 var(--num)', color: 'var(--dm)' }}>{count}</div>
            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', flexShrink: 0, opacity: tools ? 1 : 0 }}>
              <GlyphButton title={m.renameGroup} fontSize={12} onClick={onRename}>
                ✎
              </GlyphButton>
              <GlyphButton title={canDelete ? m.deleteGroup : m.lastGroup} fontSize={13} danger disabled={!canDelete} onClick={onDelete}>
                ×
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
  onPick,
  onMenu,
}: {
  item: WatchItem;
  groupId: string;
  lang: Lang;
  selected: boolean;
  onPick: (item: WatchItem) => void;
  onMenu: (e: MouseEvent, groupId: string, item: WatchItem) => void;
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
      onClick={() => onPick(item)}
      onContextMenu={(e) => onMenu(e, groupId, item)}
      style={{
        height: 52,
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
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <div style={{ fontWeight: 600 }}>{contractLabel(item.contract)}</div>
          {/* Non-USD listings look like the US one otherwise ("IBM" on IBIS is quoted in EUR). */}
          {currency && currency !== 'USD' && <div style={{ font: '10.5px/1 var(--mono)', color: 'var(--dm)' }}>{currency}</div>}
        </div>
        <div className="ellipsis" title={name || undefined} style={{ fontSize: 12, color: 'var(--dm)' }}>
          {name || ' '}
        </div>
      </div>
      <div
        className="num"
        title={q?.error ? `${q.error.code} · ${q.error.message}` : undefined}
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
      <div style={renaming ? { height: 34, display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px 0 8px' } : undefined}>
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
