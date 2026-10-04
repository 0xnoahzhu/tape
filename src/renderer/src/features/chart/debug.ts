// Debug handles for scripted screenshots (scripts/capture.ts). main.tsx publishes the app
// store as `window.__tape.store`; the chart adds its feature-local caches next to it so
// capture steps can inject realistic data without IB:
//
//   __tape.bars.getState().seed('STK:AAPL|1D', bars)
//   __tape.contractInfo.setState(s => ({ infos: { ...s.infos, 'STK:AAPL': info } }))
//   __tape.chartPrefs.getState().setActivityTab('open')

import { useBarsStore } from './barsStore';
import { useChartPrefs } from './chartPrefs';
import { useInfoStore } from './contractInfo';

export function exposeChartDebugHandles(): void {
  const w = window as unknown as { __tape?: Record<string, unknown> };
  if (!w.__tape) return;
  w.__tape.bars = useBarsStore;
  w.__tape.contractInfo = useInfoStore;
  w.__tape.chartPrefs = useChartPrefs;
}
