// The 56px application header, which doubles as the window title bar.
// macOS: native traffic lights at the left edge, then a divider (no logo; the Dock shows it).
// Windows / Linux: a small logo at the left; native caption buttons overlay the right edge.

import { useCommon } from '../i18n/common';
import { modKey } from '../lib/shortcuts';
import { useStore } from '../state/store';
import { BellIcon, Dot, LockIcon, LogoMark, SlidersIcon } from '../ui/icons';
import { IconButton, TabItems } from '../ui/primitives';
import { SymbolSearch } from '../features/search/SymbolSearch';
import { requestLock } from '../features/lock/actions';
import { useLockMessages } from '../features/lock/messages';

export function TopBar() {
  const m = useCommon();
  const lm = useLockMessages();
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const bellOpen = useStore((s) => s.bellOpen);
  const setBell = useStore((s) => s.setBell);
  const openSettings = useStore((s) => s.openSettings);
  const unread = useStore((s) => s.notifications.some((n) => !n.read));
  const mac = useStore((s) => s.platform === 'darwin');

  return (
    <div
      className="drag"
      style={{
        height: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 28,
        padding: `0 ${mac ? 20 : 0}px 0 20px`,
        background: 'var(--p)',
        boxShadow: 'inset 0 -1px 0 var(--ln)',
        flexShrink: 0,
        position: 'relative',
        zIndex: 2,
      }}
    >
      {mac ? (
        <>
          {/* Space for the native traffic lights (positioned by trafficLightPosition in main). */}
          <div style={{ width: 64, flexShrink: 0, marginRight: -8 }} />
          <div style={{ width: 1, height: 20, background: 'var(--ln)', flexShrink: 0 }} />
        </>
      ) : (
        <div className="no-drag" style={{ display: 'flex', alignItems: 'center', gap: 10, font: '700 13px/1 var(--mono)', letterSpacing: '0.14em' }}>
          <LogoMark size={18} />
          TAPE
        </div>
      )}
      <div style={{ display: 'flex', gap: 22, height: '100%', alignItems: 'stretch' }}>
        <TabItems
          tabs={[
            { key: 'acct', label: m.portfolio },
            { key: 'trade', label: m.trade },
          ]}
          value={page}
          onChange={(k) => setPage(k)}
          itemStyle={{ fontWeight: 400 }}
        />
      </div>
      <SymbolSearch />
      {/* Takes the free space only once the search box has reached its maximum width. */}
      <div style={{ marginLeft: 'auto' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingLeft: 12, boxShadow: 'inset 1px 0 0 var(--ln2)' }}>
        <IconButton size={34} title={m.notifications} active={bellOpen} onClick={() => setBell(!bellOpen)}>
          <BellIcon />
          {unread && <Dot top={8} right={8} />}
        </IconButton>
        <IconButton size={34} title={lm.lockTitle(modKey(mac, 'L'))} onClick={() => requestLock()}>
          <LockIcon />
        </IconButton>
        <IconButton size={34} title={m.settingsTitle(modKey(mac, ','))} active={page === 'set'} onClick={() => openSettings()}>
          <SlidersIcon />
        </IconButton>
      </div>
      {/* Windows / Linux: a divider, then room for the three 46px native caption buttons. */}
      {!mac && (
        <div style={{ display: 'flex', alignItems: 'center', alignSelf: 'stretch', flexShrink: 0, marginLeft: 10 }}>
          <div style={{ width: 1, height: 34, background: 'var(--ln2)', marginRight: 10 }} />
          <div style={{ width: 138 }} />
        </div>
      )}
    </div>
  );
}
