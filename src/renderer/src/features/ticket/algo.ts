// IB algo parameters as the ticket types them: percentages for IB's fractions (10 for 0.1),
// "HH:MM" New York times, switches as booleans. Pure, so it can be unit tested.

import { algoInfo } from '@shared/orderRules';
import type { AlgoSpec, AlgoStrategy } from '@shared/types';

/** The parameters a new algo starts with: its required values at sensible defaults. */
export function algoDefaults(strategy: AlgoStrategy, qty: number): Record<string, string | boolean> {
  const q = Number.isFinite(qty) && qty > 0 ? Math.round(qty) : 100;
  switch (strategy) {
    case 'Adaptive':
      return { adaptivePriority: 'Normal' };
    case 'PctVol':
    case 'PctVolPx':
      return { pctVol: '10' };
    case 'PctVolSz':
    case 'PctVolTm':
      return { startPctVol: '10', endPctVol: '20' };
    case 'DarkIce':
      return { displaySize: String(Math.max(1, Math.min(100, q))) };
    case 'AD':
      return { componentSize: String(Math.max(1, Math.round(q / 10))), timeBetweenOrders: '60' };
    default:
      return {};
  }
}

/** A working order's algo parameters as the ticket types them (Modify). */
export function typedAlgoParams(a: AlgoSpec): Record<string, string | boolean> {
  const info = algoInfo(a.strategy);
  const out: Record<string, string | boolean> = {};
  for (const [tag, v] of Object.entries(a.params)) {
    const p = info?.params.find((x) => x.tag === tag);
    if (!p) continue;
    if (p.kind === 'switch') out[tag] = v === true;
    else if (p.kind === 'fraction' && typeof v === 'number') out[tag] = String(+(v * 100).toFixed(4));
    else out[tag] = String(v);
  }
  return out;
}
