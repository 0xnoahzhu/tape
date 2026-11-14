// Watchlist panel of the Trade page (design 3a, left column): a title, the tab bar (GroupTabs:
// All and one tab per group of the tabs list, shared/defaults.ts → TABS_LIST_ID) and the rows of the
// tab shown (GroupList). The tab shown is remembered per device and is where "Add symbol" adds; on
// All its chips pick the tab (viewState.ts). When collapsed only a vertical handle is rendered,
// absolutely positioned inside the Trade page grid.

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { ContractRef, WatchItem, Watchlist } from '@shared/types';
import { useQuoteSubscriptions } from '../../hooks/useQuotes';
import { useStore } from '../../state/store';
import { DoubleChevronIcon, PlusIcon } from '../../ui/icons';
import { AddSymbol } from './AddSymbol';
import { GroupList } from './GroupList';
import { GroupMenu, type GroupMenuTarget } from './GroupMenu';
import { GroupTabs } from './GroupTabs';
import { useWatchlistMessages } from './messages';
import { ALL_TAB, itemKey, listContracts, resolveTab, tabsListOf } from './model';
import { ROW_MENU_WIDTH, RowMenu, type RowMenuTarget } from './RowMenu';
import { useWatchlistView } from './viewState';

const NO_CONTRACTS: ContractRef[] = [];

export function WatchlistPanel() {
  const m = useWatchlistMessages();
  const collapsed = useStore((s) => s.watchlistCollapsed);
  const setCollapsed = useStore((s) => s.setWatchlistCollapsed);
  const list = useStore((s) => tabsListOf(s.watchlists));

  // Quotes for every symbol of the tabs (All shows them all); released while the panel is collapsed.
  const contracts = useMemo(() => (list && !collapsed ? listContracts(list) : NO_CONTRACTS), [list, collapsed]);
  useQuoteSubscriptions('watchlist', contracts, 'basic');

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
        <div style={{ writingMode: 'vertical-rl', letterSpacing: '.04em', whiteSpace: 'nowrap' }}>{m.title}</div>
      </div>
    );
  }
  return <ExpandedPanel list={list} onCollapse={() => setCollapsed(true)} />;
}

function ExpandedPanel({ list, onCollapse }: { list: Watchlist | undefined; onCollapse: () => void }) {
  const m = useWatchlistMessages();
  const panelRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [rowMenu, setRowMenu] = useState<RowMenuTarget | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenuTarget | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [dropTab, setDropTab] = useState<string | undefined>(undefined);
  const storedTab = useWatchlistView((s) => s.tab);
  const selectTab = useWatchlistView((s) => s.selectTab);
  const storedTarget = useWatchlistView((s) => s.target);
  const setTarget = useWatchlistView((s) => s.setTarget);
  const tab = list ? resolveTab(list, storedTab) : ALL_TAB;
  // "Add symbol" adds to the tab shown; on All to the tab its chips pick.
  const targetGroupId = tab === ALL_TAB ? storedTarget : tab;

  const closeMenus = useCallback(() => {
    setRowMenu(null);
    setGroupMenu(null);
  }, []);

  // Escape and clicks outside the panel close the menus (unless a confirmation is showing).
  useEffect(() => {
    if (!rowMenu && !groupMenu) return;
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
  }, [rowMenu, groupMenu, closeMenus]);

  const panelSize = useCallback(() => ({ width: panelRef.current?.offsetWidth ?? 272, height: panelRef.current?.offsetHeight ?? 0 }), []);

  const openRowMenu = useCallback((e: MouseEvent, groupId: string, item: WatchItem) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    // As in the design: at the pointer, kept 8px from the panel's right edge.
    const x = Math.min(e.clientX - r.left, panel.offsetWidth - ROW_MENU_WIDTH - 8);
    setGroupMenu(null);
    setRowMenu({ groupId, item, x, y: e.clientY - r.top });
  }, []);

  const openGroupMenu = useCallback((e: MouseEvent, groupId: string) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    setRowMenu(null);
    setGroupMenu({ groupId, x: e.clientX - r.left, y: e.clientY - r.top });
  }, []);

  // A row or tab that disappeared (removed elsewhere) closes its menu.
  const rowMenuValid = rowMenu && list?.groups.some((g) => g.id === rowMenu.groupId && g.items.some((i) => itemKey(i) === itemKey(rowMenu.item)));
  const groupMenuId = groupMenu && list?.groups.some((g) => g.id === groupMenu.groupId) ? groupMenu.groupId : undefined;

  return (
    <div ref={panelRef} style={{ gridRow: '1 / 3', background: 'var(--p)', display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px 0 20px', flexShrink: 0, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>
        <div className="ellipsis" style={{ fontWeight: 600 }}>
          {m.title}
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
      {list && (
        <GroupTabs
          list={list}
          tab={tab}
          barRef={tabBarRef}
          renamingId={renamingId ?? undefined}
          menuGroupId={groupMenuId}
          dropTab={dropTab}
          onSelect={selectTab}
          onRename={setRenamingId}
          onMenu={openGroupMenu}
        />
      )}
      {adding && list && (
        <AddSymbol
          list={list}
          targetGroupId={targetGroupId}
          onTarget={(groupId) => (tab === ALL_TAB ? setTarget(groupId) : selectTab(groupId))}
          onClose={() => setAdding(false)}
        />
      )}
      {list && <GroupList list={list} tab={tab} tabBarRef={tabBarRef} onDropTab={setDropTab} onRowMenu={openRowMenu} onAdd={() => setAdding(true)} />}
      {rowMenu && rowMenuValid && list && <RowMenu target={rowMenu} list={list} tab={tab} panelSize={panelSize} onClose={() => setRowMenu(null)} />}
      {groupMenu && groupMenuId && list && <GroupMenu target={groupMenu} list={list} panelSize={panelSize} onRename={setRenamingId} onClose={() => setGroupMenu(null)} />}
    </div>
  );
}
