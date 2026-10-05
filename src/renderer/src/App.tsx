import { useEffect, useSyncExternalStore } from 'react';
import { onCommand } from './state/bridge';
import { confirmCancel } from './state/orderActions';
import { isCovered, useStore } from './state/store';
import type { AppCommand } from '@shared/ipc';
import { useCommon } from './i18n/common';
import { lastCancellableOrder } from './lib/orders';
import { TopBar } from './layout/TopBar';
import { ConfirmDialog, OrderConfirmDialog, ToastHost } from './layout/Dialogs';
import { TradePage } from './pages/TradePage';
import { PortfolioPage } from './features/portfolio/PortfolioPage';
import { OrdersPage } from './features/orders/OrdersPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { NotificationsPanel } from './features/notifications/NotificationsPanel';
import { PriceAlertDialog } from './features/alerts/PriceAlertDialog';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { requestLock } from './features/lock/actions';
import { LockScreen } from './features/lock/LockScreen';
import { PinDialogHost } from './features/lock/PinDialog';
import { FloatingPanels } from './features/panels/FloatingPanels';

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const subscribeDark = (cb: () => void) => {
  darkQuery.addEventListener('change', cb);
  return () => darkQuery.removeEventListener('change', cb);
};

/** Resolved theme: the main process sets nativeTheme.themeSource, so the media query follows it. */
export function useDark(): boolean {
  const theme = useStore((s) => s.settings.appearance.theme);
  const systemDark = useSyncExternalStore(subscribeDark, () => darkQuery.matches);
  return theme === 'system' ? systemDark : theme === 'dark';
}

function runCommand(command: AppCommand, dark: boolean): void {
  const s = useStore.getState();
  switch (command) {
    case 'open-settings':
      s.openSettings();
      break;
    case 'toggle-theme':
      void window.tape.updateSettings({ appearance: { theme: dark ? 'light' : 'dark' } });
      break;
    case 'page-portfolio':
      s.setPage('acct');
      break;
    case 'page-trade':
      s.setPage('trade');
      break;
    case 'page-orders':
      s.setPage('ord');
      break;
    case 'focus-search':
      s.focusSearch();
      break;
    case 'cancel-last-order': {
      const last = lastCancellableOrder(s.orders, s.connection.clientId);
      if (last) confirmCancel(last);
      else s.showToast(useCommon.now().noWorkingOrders);
      break;
    }
    case 'set-pin-and-lock':
      requestLock();
      break;
  }
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

export function App() {
  const ready = useStore((s) => s.ready);
  const page = useStore((s) => s.page);
  const upColor = useStore((s) => s.settings.appearance.upColor);
  const lang = useStore((s) => s.settings.appearance.language);
  const covered = useStore(isCovered);
  const lockSeq = useStore((s) => s.lockSeq);
  const dark = useDark();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.th = dark ? 'dark' : 'light';
    root.dataset.sk = 'a';
    root.dataset.cv = upColor;
    root.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [dark, upColor, lang]);

  useEffect(() => onCommand((c) => runCommand(c, dark)), [dark]);

  // Global shortcuts. Trade-specific keys (B / S / ↑ / ↓ / ⏎) live in the order ticket (and, on
  // the floating ticket's bar, B / S in features/panels/shortcuts.ts).
  // None of them works while the lock screen is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || isCovered(useStore.getState())) return;
      const k = e.key.toLowerCase();
      let cmd: AppCommand | null = null;
      if (k === 'l' && !e.shiftKey && !e.altKey) cmd = 'set-pin-and-lock';
      else if (k === 'k' && !e.shiftKey) cmd = 'focus-search';
      else if (k === ',') cmd = 'open-settings';
      else if (k === 'l' && e.shiftKey) cmd = 'toggle-theme';
      else if (k === '1') cmd = 'page-portfolio';
      else if (k === '2') cmd = 'page-trade';
      else if (k === '3') cmd = 'page-orders';
      else if (k === 'backspace' && !isEditable(e.target)) cmd = 'cancel-last-order';
      if (!cmd) return;
      e.preventDefault();
      runCommand(cmd, dark);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dark]);

  if (!ready) return <div style={{ height: '100%', background: 'var(--bg)' }} />;

  return (
    <div style={{ height: '100%', background: 'var(--bg)', overflow: 'hidden', position: 'relative' }}>
      {/* While the lock screen covers it, the app can be neither clicked nor tabbed into. */}
      <div inert={covered} style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      <ErrorBoundary name="Top bar">
        <TopBar />
      </ErrorBoundary>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        <ErrorBoundary name={page} key={page} style={{ flex: 1 }}>
          {page === 'trade' && <TradePage />}
          {page === 'acct' && <PortfolioPage />}
          {page === 'ord' && <OrdersPage />}
          {page === 'set' && <SettingsPage />}
        </ErrorBoundary>
        {/* The order ticket and the strategy builder when popped out, over the content area. */}
        <ErrorBoundary name="Floating panels" style={{ position: 'absolute', right: 8, bottom: 8, zIndex: 1 }}>
          <FloatingPanels />
        </ErrorBoundary>
      </div>
      <ErrorBoundary name="Notifications" style={{ position: 'absolute', top: 60, right: 14, zIndex: 16 }}>
        <NotificationsPanel />
      </ErrorBoundary>
      <ErrorBoundary name="Price alert" style={{ position: 'absolute', top: 60, right: 14, zIndex: 19 }}>
        <PriceAlertDialog />
      </ErrorBoundary>
      <ConfirmDialog />
      <OrderConfirmDialog />
      <PinDialogHost />
      <ToastHost />
      </div>
      {covered && (
        <ErrorBoundary name="Lock screen" style={{ position: 'absolute', inset: 0, zIndex: 40 }}>
          <LockScreen key={lockSeq} />
        </ErrorBoundary>
      )}
    </div>
  );
}
