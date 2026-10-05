import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { startBridge } from './state/bridge';
import { useDesk } from './features/options/deskStore';
import { useDashboardLayout } from './features/portfolio/dashboard/layoutStore';
import { usePanels } from './features/panels/panelStore';
import { useOrderFeedback } from './state/orderFeedback';
import { useStore } from './state/store';
import { installLockKeyGuard } from './features/lock/actions';
import { focusLockInput } from './features/lock/LockScreen';

// Debug handle for scripted screenshots (see src/main/devCapture.ts): the stores.
(window as unknown as { __tape: unknown }).__tape = {
  store: useStore,
  panels: usePanels,
  feedback: useOrderFeedback,
  desk: useDesk,
  dash: useDashboardLayout,
};

// Apply the theme before first paint to avoid a flash.
const root = document.documentElement;
root.dataset.sk = 'a';
root.dataset.platform = window.tapePlatform;
root.dataset.th = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
root.dataset.cv = 'cn';

// Before anything else registers a key listener, so no shortcut runs behind the lock screen.
installLockKeyGuard(focusLockInput);

void startBridge();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
