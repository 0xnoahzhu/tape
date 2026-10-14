// The 56px application header, which doubles as the window title bar.
// macOS: native traffic lights at the left edge, then a divider (no logo; the Dock shows it).
// Windows / Linux: a small logo at the left; native caption buttons overlay the right edge.
// Before the bell, the account badge: LIVE (red) or PAPER and the account Tape trades, or OFFLINE.
// While IB refuses requests in Read-Only API mode, a red chip there says so (and where to turn it off);
// another while TWS / IB Gateway cannot carry orders (it lost IB, 1100, or does not answer). Left of
// the bell, a DND tag while do-not-disturb is on (features/settings/DndIndicator.tsx).

import type { CSSProperties } from 'react';
import { useCommon } from '../i18n/common';
import { accountText } from '../lib/account';
import { modKey } from '../lib/shortcuts';
import { connectionHealthText, readOnlyWarning } from '../state/orderActions';
import { useStore } from '../state/store';
import { BellIcon, Dot, LockIcon, LogoMark, SlidersIcon } from '../ui/icons';
import { AccountTag, IconButton, TabItems } from '../ui/primitives';
import { SymbolSearch } from '../features/search/SymbolSearch';
import { requestLock } from '../features/lock/actions';
import { useLockMessages } from '../features/lock/messages';
import { DndIndicator } from '../features/settings/DndIndicator';

/**
 * IB answered a request of this connection with its Read-Only refusal (ConnectionState.readOnlyApi):
 * it refuses orders and cancels until the setting is off. The chip stays while connected; its
 * tooltip, and a click, say where to turn it off.
 */
function ReadOnlyChip() {
  const m = useCommon();
  const text = useStore((s) => (s.connection.status === 'connected' && s.connection.readOnlyApi ? readOnlyWarning() : undefined));
  if (!text) return null;
  return (
    <div className="no-drag" role="status" title={text} onClick={() => useStore.getState().showToast(text, 'warning')} style={warningChip}>
      {m.readOnlyApiChip}
    </div>
  );
}

/** The red outlined chips of the top bar. */
const warningChip: CSSProperties = {
  height: 26,
  display: 'flex',
  alignItems: 'center',
  padding: '0 10px',
  flexShrink: 0,
  whiteSpace: 'nowrap',
  fontSize: 12,
  color: 'var(--r)',
  boxShadow: 'inset 0 0 0 1px var(--r)',
  cursor: 'pointer',
};

/**
 * TWS / IB Gateway is connected but cannot carry orders: it lost its connection to IB (1100) or does
 * not answer the heartbeat (ConnectionState.ibLinkLost / unresponsive). Orders and modifies are held
 * back meanwhile, cancels still go out; the tooltip says so, and a click opens Settings › Connection.
 */
function HealthChip() {
  const text = useStore((s) => (s.connection.ibLinkLost || s.connection.unresponsive ? connectionHealthText('chip') : undefined));
  const tip = useStore((s) => (s.connection.ibLinkLost || s.connection.unresponsive ? connectionHealthText('tip') : undefined));
  if (!text) return null;
  return (
    <div className="no-drag" role="status" data-testid="health-chip" title={tip} onClick={() => useStore.getState().openSettings('conn')} style={warningChip}>
      {text}
    </div>
  );
}

/**
 * Which account orders go to, always in view: "LIVE · U18630011" outlined in red, "PAPER · DUP899854"
 * muted (the id only while Settings › Privacy shows account IDs; LIVE / PAPER is never hidden), or
 * OFFLINE / CONNECTING. A click opens Settings › Connection.
 */
function AccountBadge() {
  const m = useCommon();
  const conn = useStore((s) => s.connection);
  const showId = useStore((s) => s.settings.appearance.showAccountId);
  const open = () => useStore.getState().openSettings('conn');
  if (conn.status === 'connected' && conn.account) {
    const text = accountText(conn.isPaper, conn.account, showId);
    return (
      <div className="no-drag">
        <AccountTag paper={conn.isPaper} text={text} title={`${conn.isPaper ? m.paperTip : m.liveTip} · ${m.connectionTip}`} onClick={open} />
      </div>
    );
  }
  const busy = conn.status === 'connecting' || conn.status === 'reconnecting';
  return (
    <div className="no-drag">
      <AccountTag paper muted text={busy ? m.connectingTag : m.offlineTag} title={`${m.offlineTip} · ${m.connectionTip}`} onClick={open} />
    </div>
  );
}

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <HealthChip />
        <ReadOnlyChip />
        <AccountBadge />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingLeft: 12, boxShadow: 'inset 1px 0 0 var(--ln2)' }}>
        <DndIndicator />
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
