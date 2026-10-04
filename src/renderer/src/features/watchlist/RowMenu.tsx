// Right-click menu of a watchlist row: move to group, add to another list, price alert, remove.

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { contractLabel } from '@shared/contract';
import type { WatchItem, Watchlist } from '@shared/types';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { MenuDivider, MenuItem, Popover } from '../../ui/primitives';
import { updateList } from './actions';
import { DEFAULT_GROUP_NAME, useWatchlistMessages } from './messages';
import { addItem, clampMenu, itemKey, listAccepts, listHas, moveItem, removeItem } from './model';

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

const sectionLabel: CSSProperties = { padding: '2px 12px 4px', fontSize: 11, color: 'var(--dm)' };
const subItem: CSSProperties = { padding: '0 12px 0 20px' };
const emptyItem: CSSProperties = { height: 32, display: 'flex', alignItems: 'center', padding: '0 12px 0 20px', color: 'var(--dm)' };

export function RowMenu({
  target,
  list,
  lists,
  panelSize,
  onClose,
}: {
  target: RowMenuTarget;
  list: Watchlist;
  lists: Watchlist[];
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

  // Keep the whole menu inside the panel once its real height is known; a menu taller than
  // the panel (many groups or lists) scrolls.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = panelSize();
    const maxHeight = Math.max(0, height - 2 * MENU_MARGIN);
    setBox({ ...clampMenu(target.x, target.y, ROW_MENU_WIDTH, Math.min(el.offsetHeight, maxHeight), width, height, MENU_MARGIN), maxHeight });
  }, [target, panelSize, list, lists]);

  const otherGroups = list.groups.filter((g) => g.id !== groupId);
  const otherLists = lists.filter((l) => l.id !== list.id && listAccepts(l, item.contract));
  const toast = (text: string) => useStore.getState().showToast(text);

  const moveTo = (toGroupId: string, toName: string) => {
    onClose();
    updateList(list.id, (l) => moveItem(l, groupId, toGroupId, key));
    toast(m.movedTo(label, toName));
  };

  const copyTo = (l: Watchlist) => {
    onClose();
    updateList(l.id, (x) => addItem(x, undefined, item, DEFAULT_GROUP_NAME));
    toast(m.copiedTo(label, nameOf(l.name, lang)));
  };

  const addAlert = () => {
    onClose();
    useStore.getState().openAlertForm(item.contract);
  };

  const remove = () => {
    onClose();
    useStore.getState().ask({
      title: m.remove,
      rows: [
        { label: m.symbol, value: label },
        { label: m.list, value: nameOf(list.name, lang) },
      ],
      label: m.removeLabel,
      danger: true,
      run: () => updateList(list.id, (l) => removeItem(l, groupId, key)),
    });
  };

  const close = (e: React.MouseEvent) => {
    e.preventDefault();
    onClose();
  };

  return (
    <>
      <div onClick={close} onContextMenu={close} style={{ position: 'absolute', inset: 0, zIndex: 6 }} />
      <div ref={menuRef} style={{ position: 'absolute', left: box.x, top: box.y, width: ROW_MENU_WIDTH, zIndex: 7 }}>
        {/* Block layout keeps every row at its fixed height when the menu has to scroll. */}
        <Popover style={{ position: 'relative', zIndex: undefined, display: 'block', maxHeight: box.maxHeight, overflowY: 'auto' }}>
          <div style={{ padding: '6px 12px 8px', font: '600 12px/1 var(--mono)', color: 'var(--mu)' }}>{label}</div>
          <div style={sectionLabel}>{m.moveTo}</div>
          {otherGroups.map((g) => {
            const name = nameOf(g.name, lang);
            return (
              <MenuItem key={g.id} onClick={() => moveTo(g.id, name)} style={subItem}>
                <div className="ellipsis" style={{ flex: 1, minWidth: 0 }}>
                  {name}
                </div>
              </MenuItem>
            );
          })}
          {otherGroups.length === 0 && <div style={emptyItem}>{m.noOtherGroups}</div>}
          <MenuDivider />
          <div style={sectionLabel}>{m.copyTo}</div>
          {otherLists.map((l) => {
            const has = listHas(l, key);
            return (
              <div
                key={l.id}
                onClick={has ? undefined : () => copyTo(l)}
                className="hover-p2"
                style={{ height: 32, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 0 20px', cursor: has ? 'default' : 'pointer', color: has ? 'var(--dm)' : 'var(--tx)' }}
              >
                <div className="ellipsis" style={{ flex: 1, minWidth: 0 }}>
                  {nameOf(l.name, lang)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--dm)' }}>{has ? m.alreadyAdded : ''}</div>
              </div>
            );
          })}
          {otherLists.length === 0 && <div style={emptyItem}>{m.noOtherLists}</div>}
          <MenuDivider />
          <MenuItem onClick={addAlert}>{m.addAlert}</MenuItem>
          <MenuDivider />
          <MenuItem onClick={remove} danger>
            {m.remove}
          </MenuItem>
        </Popover>
      </div>
    </>
  );
}
