// Watchlist panel of the Trade page (design 3a, left column).
// Lists live in the store (persisted by the main process); the current list and each list's
// "Add symbol" target group live in viewState.ts (a group picked in the chart star's picker sets
// the target too; the current list is the panel's own), and collapsed groups are per-device
// preferences. When collapsed only a vertical handle is rendered, absolutely positioned inside
// the Trade page grid.

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { ContractRef, WatchItem, Watchlist } from '@shared/types';
import { useQuoteSubscriptions } from '../../hooks/useQuotes';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { DoubleChevronIcon, PlusIcon } from '../../ui/icons';
import { AddSymbol } from './AddSymbol';
import { GroupList } from './GroupList';
import { GroupMenu, type GroupMenuTarget } from './GroupMenu';
import { ListMenu } from './ListMenu';
import { useWatchlistMessages } from './messages';
import { currentListOf, itemKey, listContracts } from './model';
import { ROW_MENU_WIDTH, RowMenu, type RowMenuTarget } from './RowMenu';
import { useWatchlistView } from './viewState';

const NO_CONTRACTS: ContractRef[] = [];

/** The current list: the remembered one if it still exists, otherwise the first list. */
function useCurrentList(lists: Watchlist[]): [Watchlist | undefined, (id: string) => void] {
  const id = useWatchlistView((s) => s.currentId);
  const select = useWatchlistView((s) => s.selectList);
  return [currentListOf(lists, id), select];
}

export function WatchlistPanel() {
  const m = useWatchlistMessages();
  const lang = useLang();
  const collapsed = useStore((s) => s.watchlistCollapsed);
  const setCollapsed = useStore((s) => s.setWatchlistCollapsed);
  const lists = useStore((s) => s.watchlists);
  const [list, selectList] = useCurrentList(lists);

  // Quotes for every instrument of the current list; released while the panel is collapsed.
  const contracts = useMemo(() => (list && !collapsed ? listContracts(list) : NO_CONTRACTS), [list, collapsed]);
  useQuoteSubscriptions('watchlist', contracts, 'basic');

  const name = list ? nameOf(list.name, lang) : '';
  if (collapsed) {
    return (
      <div
        onClick={() => setCollapsed(false)}
        title={m.expand}
        className="hover-tx"
        style={{
          position: 'absolute',
          left: 0,
          top: 64,
          // Page content: a floating panel (layer 1, later in the DOM) draws over it.
          zIndex: 1,
          width: 26,
          padding: '12px 0',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          background: 'var(--p)',
          color: 'var(--mu)',
          fontSize: 12,
          boxShadow: '1px 0 0 var(--ln), 0 1px 0 var(--ln), 0 -1px 0 var(--ln), 4px 4px 12px rgba(0,0,0,.10)',
        }}
      >
        <DoubleChevronIcon dir="right" size={13} />
        <div style={{ writingMode: 'vertical-rl', letterSpacing: '.04em', whiteSpace: 'nowrap' }}>{name}</div>
      </div>
    );
  }
  return <ExpandedPanel lists={lists} list={list} name={name} selectList={selectList} onCollapse={() => setCollapsed(true)} />;
}

function ExpandedPanel({
  lists,
  list,
  name,
  selectList,
  onCollapse,
}: {
  lists: Watchlist[];
  list: Watchlist | undefined;
  name: string;
  selectList: (id: string) => void;
  onCollapse: () => void;
}) {
  const m = useWatchlistMessages();
  const panelRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [rowMenu, setRowMenu] = useState<RowMenuTarget | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenuTarget | null>(null);
  // Target group for "Add symbol", remembered per list for the session (viewState.ts; a group
  // picked in the chart star's picker becomes it).
  const targetGroupId = useWatchlistView((s) => (list ? s.targets[list.id] : undefined));
  const setTarget = useWatchlistView((s) => s.setTarget);
  // Group whose name is being edited in its header.
  const [renaming, setRenaming] = useState<{ listId: string; groupId: string } | null>(null);
  const renamingId = renaming && list && renaming.listId === list.id ? renaming.groupId : undefined;

  const closeMenus = useCallback(() => {
    setMenuOpen(false);
    setRowMenu(null);
    setGroupMenu(null);
  }, []);

  // Escape and clicks outside the panel close the menus (unless a confirmation is showing).
  useEffect(() => {
    if (!menuOpen && !rowMenu && !groupMenu) return;
    const blocked = () => useStore.getState().confirm != null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !blocked()) closeMenus();
    };
    const onDown = (e: globalThis.MouseEvent) => {
      if (!blocked() && panelRef.current && !panelRef.current.contains(e.target as Node)) closeMenus();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [menuOpen, rowMenu, groupMenu, closeMenus]);

  const panelSize = useCallback(() => ({ width: panelRef.current?.offsetWidth ?? 272, height: panelRef.current?.offsetHeight ?? 0 }), []);

  const openRowMenu = useCallback((e: MouseEvent, groupId: string, item: WatchItem) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    // As in the design: at the pointer, kept 8px from the panel's right edge.
    const x = Math.min(e.clientX - r.left, panel.offsetWidth - ROW_MENU_WIDTH - 8);
    setMenuOpen(false);
    setGroupMenu(null);
    setRowMenu({ groupId, item, x, y: e.clientY - r.top });
  }, []);

  const openGroupMenu = useCallback((e: MouseEvent, groupId: string) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    setMenuOpen(false);
    setRowMenu(null);
    setGroupMenu({ groupId, x: e.clientX - r.left, y: e.clientY - r.top });
  }, []);

  const startRename = useCallback((groupId: string | null) => setRenaming(groupId && list ? { listId: list.id, groupId } : null), [list]);

  // A row that disappeared (removed elsewhere, list switched) closes its menu.
  const rowMenuValid = rowMenu && list?.groups.some((g) => g.id === rowMenu.groupId && g.items.some((i) => itemKey(i) === itemKey(rowMenu.item)));
  const groupMenuId = groupMenu && list?.groups.some((g) => g.id === groupMenu.groupId) ? groupMenu.groupId : undefined;

  return (
    <div ref={panelRef} style={{ gridRow: '1 / 3', background: 'var(--p)', display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px 0 12px', flexShrink: 0, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>
        <div
          onClick={() => {
            setRowMenu(null);
            setGroupMenu(null);
            setMenuOpen((o) => !o);
          }}
          className="hover-p2"
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', cursor: 'pointer', fontWeight: 600, minWidth: 0, background: menuOpen ? 'var(--p2)' : 'transparent' }}
        >
          <div className="ellipsis">{name}</div>
          <div style={{ fontSize: 9, color: 'var(--dm)' }}>▼</div>
        </div>
        <div style={{ flex: 1 }} />
        <div
          onClick={onCollapse}
          title={m.collapse}
          className="hover-tx hover-p2"
          style={{ width: 28, height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--dm)' }}
        >
          <DoubleChevronIcon dir="left" size={14} />
        </div>
        <div
          onClick={() => setAdding((a) => !a)}
          title={m.addSymbol}
          className="hover-tx hover-p2"
          style={{
            width: 28,
            height: 28,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: adding ? 'var(--ac)' : 'var(--dm)',
            background: adding ? 'var(--sel)' : 'transparent',
          }}
        >
          <PlusIcon size={14} />
        </div>
      </div>
      {adding && list && (
        <AddSymbol list={list} targetGroupId={targetGroupId} onTarget={(groupId) => setTarget(list.id, groupId)} onClose={() => setAdding(false)} />
      )}
      {list && (
        <GroupList
          list={list}
          renamingId={renamingId}
          menuGroupId={groupMenuId}
          onRename={startRename}
          onGroupMenu={openGroupMenu}
          onRowMenu={openRowMenu}
          onGroupCreated={(groupId) => setTarget(list.id, groupId)}
        />
      )}
      {rowMenu && rowMenuValid && list && <RowMenu target={rowMenu} list={list} lists={lists} panelSize={panelSize} onClose={() => setRowMenu(null)} />}
      {groupMenu && groupMenuId && list && <GroupMenu target={groupMenu} list={list} panelSize={panelSize} onRename={startRename} onClose={() => setGroupMenu(null)} />}
      {menuOpen && (
        <ListMenu
          lists={lists}
          currentId={list?.id ?? ''}
          onPick={(id) => {
            selectList(id);
            setMenuOpen(false);
          }}
          onCreated={(id) => {
            selectList(id);
            setMenuOpen(false);
            setAdding(true);
          }}
          onDeleted={(id) => {
            if (id === list?.id) selectList(lists.find((l) => l.builtin)?.id ?? 'main');
            setMenuOpen(false);
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}
