// Right-click menu of a watchlist row: move to another tab (from a tab), add to more tabs, add an
// alert, remove (from the tab shown; on All from every tab).

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { contractLabel } from '@shared/contract';
import type { WatchGroup, WatchItem, Watchlist } from '@shared/types';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { MenuDivider, MenuItem, Popover } from '../../ui/primitives';
import { stableGutter } from '../../ui/scrollGutter';
import { askRemoveItem, updateList } from './actions';
import { DEFAULT_GROUP_NAME, useWatchlistMessages } from './messages';
import { ALL_TAB, addItem, clampMenu, groupHas, itemKey, moveItem } from './model';

export const ROW_MENU_WIDTH = 196;
/** Distance kept between the menu and the panel edges. */
const MENU_MARGIN = 8;

export interface RowMenuTarget {
  groupId: string;
  item: WatchItem;
  /** Click position relative to the panel. */
  x: number;
  y: number;
}

export const sectionLabel: CSSProperties = { padding: '2px 12px 4px', fontSize: 11, color: 'var(--dm)' };
const subItem: CSSProperties = { padding: '0 12px 0 20px' };
export const emptyItem: CSSProperties = { height: 32, display: 'flex', alignItems: 'center', padding: '0 12px 0 20px', color: 'var(--dm)' };

export function RowMenu({
  target,
  list,
  tab,
  panelSize,
  onClose,
}: {
  target: RowMenuTarget;
  list: Watchlist;
  /** The tab shown: from a tab a row moves to another one; on All it is added to more. */
  tab: string;
  panelSize: () => { width: number; height: number };
  onClose: () => void;
}) {
  const m = useWatchlistMessages();
  const lang = useLang();
  const menuRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ x: number; y: number; maxHeight?: number }>({ x: target.x, y: target.y });
  const { item, groupId } = target;
  const key = itemKey(item);
  const label = contractLabel(item.contract);
  const onAll = tab === ALL_TAB;

  // Keep the whole menu inside the panel once its real height is known; a menu taller than
  // the panel (many tabs) scrolls.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = panelSize();
    const maxHeight = Math.max(0, height - 2 * MENU_MARGIN);
    setBox({ ...clampMenu(target.x, target.y, ROW_MENU_WIDTH, Math.min(el.offsetHeight, maxHeight), width, height, MENU_MARGIN), maxHeight });
  }, [target, panelSize, list]);

  const otherGroups = list.groups.filter((g) => g.id !== groupId || onAll);
  const toast = (text: string) => useStore.getState().showToast(text);

  const moveTo = (toGroupId: string, toName: string) => {
    onClose();
    updateList(list.id, (l) => moveItem(l, groupId, toGroupId, key));
    toast(m.movedTo(label, toName));
  };

  const addTo = (toGroupId: string, toName: string) => {
    onClose();
    updateList(list.id, (l) => addItem(l, toGroupId, item, DEFAULT_GROUP_NAME));
    toast(m.addedTo(label, toName));
  };

  const addAlert = () => {
    onClose();
    useStore.getState().openAlertForm(item.contract);
  };

  const remove = () => {
    onClose();
    askRemoveItem(list.id, item.contract, onAll ? null : groupId);
  };

  const close = (e: React.MouseEvent) => {
    e.preventDefault();
    onClose();
  };

  /** A tab of a section: picks it, or says the symbol is there already. */
  const tabItem = (g: WatchGroup, run: (id: string, name: string) => void) => {
    const name = nameOf(g.name, lang);
    const has = groupHas(g, key);
    return (
      <div
        key={g.id}
        onClick={has ? undefined : () => run(g.id, name)}
        className="hover-p2"
        style={{ height: 32, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 0 20px', cursor: has ? 'default' : 'pointer', color: has ? 'var(--dm)' : 'var(--tx)' }}
      >
        <div className="ellipsis" style={{ flex: 1, minWidth: 0 }}>
          {name}
        </div>
        <div style={{ fontSize: 11, color: 'var(--dm)' }}>{has ? m.alreadyAdded : ''}</div>
      </div>
    );
  };

  return (
    <>
      <div onClick={close} onContextMenu={close} style={{ position: 'absolute', inset: 0, zIndex: 6 }} />
      <div ref={menuRef} style={{ position: 'absolute', left: box.x, top: box.y, width: ROW_MENU_WIDTH, zIndex: 7 }}>
        {/* Block layout keeps every row at its fixed height when the menu has to scroll. */}
        <Popover style={{ position: 'relative', zIndex: undefined, display: 'block', maxHeight: box.maxHeight, overflowY: 'auto', ...stableGutter }}>
          <div style={{ padding: '6px 12px 8px', font: '600 12px/1 var(--mono)', color: 'var(--mu)' }}>{label}</div>
          {!onAll && (
            <>
              <div style={sectionLabel}>{m.moveTo}</div>
              {otherGroups.map((g) => tabItem(g, moveTo))}
              {otherGroups.length === 0 && <div style={emptyItem}>{m.noOtherGroups}</div>}
              <MenuDivider />
            </>
          )}
          <div style={sectionLabel}>{m.addToTab}</div>
          {otherGroups.map((g) => tabItem(g, addTo))}
          {otherGroups.length === 0 && <div style={emptyItem}>{m.noOtherGroups}</div>}
          <MenuDivider />
          <MenuItem onClick={addAlert}>{m.addAlert}</MenuItem>
          <MenuDivider />
          <MenuItem onClick={remove} danger>
            {onAll ? m.removeFromAll : m.removeFromTab(nameOf(list.groups.find((g) => g.id === groupId)?.name ?? '', lang))}
          </MenuItem>
        </Popover>
      </div>
    </>
  );
}
