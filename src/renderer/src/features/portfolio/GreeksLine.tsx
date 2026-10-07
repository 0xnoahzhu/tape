// The portfolio greeks as one line: Δ sh · $Δ · Γ · Θ/day · Vega/pt, or a dimmed "Greeks: waiting for
// IB on N options" (exposure.ts → portfolioGreeks). On the Positions toolbar for the whole account and
// in the Trade page's activity panel under the options desk for one underlying.

import { f0, f2, sg, signColor } from '@shared/format';
import type { PortfolioGreeks } from './exposure';
import { usePortfolioMessages, type GreekId } from './messages';

/** Δ sh · $Δ · Γ · Θ/day · Vega/pt, each with its tooltip. */
export function GreeksLine({ g }: { g: PortfolioGreeks }) {
  const m = usePortfolioMessages();
  if (g.pending) {
    return (
      <div data-pos="greeks" data-pending title={m.greeksPendingHint} style={{ color: 'var(--dm)', whiteSpace: 'nowrap' }}>
        {m.greeksPending(g.pending)}
      </div>
    );
  }
  const items: Array<{ id: GreekId; value: string; color?: string }> = [
    { id: 'delta', value: sg(g.delta, f0) },
    { id: 'dollarDelta', value: sg(g.dollarDelta, f0) },
    { id: 'gamma', value: sg(g.gamma, (x) => f2(x, 1)) },
    { id: 'theta', value: sg(g.theta, f0), color: signColor(g.theta) },
    { id: 'vega', value: sg(g.vega, f0) },
  ];
  return (
    <div data-pos="greeks" style={{ display: 'flex', alignItems: 'baseline', gap: 16, whiteSpace: 'nowrap' }}>
      {items.map(({ id, value, color }) => {
        const [label, unit] = m.greeks[id];
        return (
          <span key={id} data-greek={id} title={m.greeksHints[id]} style={{ display: 'flex', alignItems: 'baseline' }}>
            <span style={{ color: 'var(--mu)', marginRight: 5 }}>{label}</span>
            <span className="selectable" style={{ fontFamily: 'var(--num)', fontVariantNumeric: 'tabular-nums', color: color ?? 'var(--tx)' }}>
              {value}
            </span>
            {/* "/day" follows the number; "sh" after a space. */}
            {unit && <span style={{ color: 'var(--mu)', marginLeft: unit.startsWith('/') ? 1 : 4 }}>{unit}</span>}
          </span>
        );
      })}
    </div>
  );
}
