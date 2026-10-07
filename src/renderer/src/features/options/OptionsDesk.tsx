// Options desk entry point (design OptionsDesk.dc.html).
//   mode "full":   option chain, volatility, positions and the strategy builder (Trade › Options)
//   mode "alerts": live option risk alerts for the bell panel's Alerts tab
//
// Development captures can seed data through window.__tape.options (see data.ts).

import { useEffect } from 'react';
import { useStore } from '../../state/store';
import { attachDebugHandle } from './data';
import { DeskFull } from './DeskFull';
import { useDesk } from './deskStore';
import { RiskAlerts } from './RiskAlerts';
import { startRiskWatcher } from './riskWatcher';

export { useRiskAlerts } from './RiskAlerts';

// After the entry module has created window.__tape and the store bridge.
if (typeof window !== 'undefined') {
  setTimeout(() => {
    attachDebugHandle(useDesk);
    startRiskWatcher();
  }, 0);
  // Locking closes the desk's dropdowns (expiry, strategy template) with the app's other popovers.
  useStore.subscribe((s, prev) => {
    if (s.lock.locked && !prev.lock.locked) useDesk.setState({ expOpen: false, tmplOpen: false });
  });
}

export function OptionsDesk({ mode }: { mode: 'full' | 'alerts' }) {
  useEffect(() => attachDebugHandle(useDesk), []);
  return mode === 'alerts' ? <RiskAlerts /> : <DeskFull />;
}
