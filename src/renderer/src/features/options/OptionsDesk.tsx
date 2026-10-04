// Options desk entry point (design OptionsDesk.dc.html).
//   mode "full":   option chain, volatility, flow, positions and the strategy builder (Trade › Options)
//   mode "alerts": live option risk alerts for the bell panel's Alerts tab
//
// Development captures can seed data through window.__tape.options (see data.ts).

import { useEffect } from 'react';
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
}

export function OptionsDesk({ mode }: { mode: 'full' | 'alerts' }) {
  useEffect(() => attachDebugHandle(useDesk), []);
  return mode === 'alerts' ? <RiskAlerts /> : <DeskFull />;
}
