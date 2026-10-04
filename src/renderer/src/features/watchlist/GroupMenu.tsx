// Right-click menu of a watchlist group header: rename, delete.

import { useLayoutEffect, useRef, useState } from 'react';
import type { Watchlist } from '@shared/types';
import { nameOf, useLang } from '../../i18n';
import { MenuDivider, MenuItem, Popover } from '../../ui/primitives';
import { askDeleteGroup } from './actions';
import { useWatchlistMessages } from './messages';
import { canDeleteGroup, clampMenu } from './model';

export const GROUP_MENU_WIDTH = 176;

export interface GroupMenuTarget {
  groupId: string;
  /** Click position relative to the panel. */
  x: number;
  y: number;
}

export function GroupMenu({
  target,
  list,
  panelSize,
  onRename,
  onClose,
}: {
  target: GroupMenuTarget;
  list: Watchlist;
  panelSize: () => { width: number; height: number };
  onRename: (groupId: string) => void;
  onClose: () => void;
}) {
  const m = useWatchlistMessages();
  const lang = useLang();
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: target.x, y: target.y });
  const group = list.groups.find((g) => g.id === target.groupId);

  // Keep the whole menu inside the panel once its real height is known.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = panelSize();
    setPos(clampMenu(target.x, target.y, GROUP_MENU_WIDTH, el.offsetHeight, width, height));
  }, [target, panelSize]);

  if (!group) return null;
  const canDelete = canDeleteGroup(list);

  const close = (e: React.MouseEvent) => {
    e.preventDefault();
    onClose();
  };

  return (
    <>
      <div onClick={close} onContextMenu={close} style={{ position: 'absolute', inset: 0, zIndex: 6 }} />
      <div ref={menuRef} style={{ position: 'absolute', left: pos.x, top: pos.y, width: GROUP_MENU_WIDTH, zIndex: 7 }}>
        <Popover style={{ position: 'relative', zIndex: undefined }}>
          <div className="ellipsis" style={{ padding: '6px 12px 8px', font: '600 12px/1 var(--sans)', color: 'var(--mu)' }}>
            {nameOf(group.name, lang)}
          </div>
          <MenuItem
            onClick={() => {
              onClose();
              onRename(group.id);
            }}
          >
            {m.rename}
          </MenuItem>
          <MenuDivider />
          <MenuItem
            danger={canDelete}
            disabled={!canDelete}
            title={canDelete ? undefined : m.lastGroup}
            onClick={() => {
              onClose();
              askDeleteGroup(list.id, group.id);
            }}
          >
            {m.deleteGroup}
          </MenuItem>
        </Popover>
      </div>
    </>
  );
}
