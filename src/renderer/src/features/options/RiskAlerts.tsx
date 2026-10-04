// Risk alerts list (OptionsDesk mode "alerts", shown in the bell panel's Alerts tab).

import { useMemo } from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import { pct } from '@shared/format';
import { useQuoteSubscriptions, useQuotesByKey } from '../../hooks/useQuotes';
import { useStore } from '../../state/store';
import { useM, type DeskMessages } from './messages';
import { computeRiskAlerts, isOptionPosition, quotableContract, severityColor, underlyingFor, type RiskAlert } from './risk';

/** Message for an alert in the given language table. */
export function riskMessage(a: RiskAlert, m: DeskMessages): string {
  switch (a.rule) {
    case 'exp':
      return m.aExp(a.days ?? 0);
    case 'asg':
      return a.itm ? m.aAsgItm : m.aAsg;
    case 'move':
      return m.aMove(a.position.contract.symbol, pct(a.movePct, 1));
    case 'loss':
      return m.aLoss(`${(a.lossPct ?? 0).toFixed(0)}%`);
  }
}

/**
 * Live risk alerts for every option position. Subscribes the options (greeks) and their
 * underlyings; `owner` must be unique per mounted user.
 */
export function useRiskAlerts(owner = 'options-alerts'): RiskAlert[] {
  const positions = useStore((s) => s.positions);
  const watchlists = useStore((s) => s.watchlists);
  const options = useMemo(() => positions.filter(isOptionPosition), [positions]);
  const contracts = useMemo(() => options.map((p) => quotableContract(p.contract)), [options]);
  const underlyings = useMemo(() => {
    const syms = [...new Set(options.map((p) => p.contract.symbol))];
    return syms.map((s) => underlyingFor(s, watchlists));
  }, [options, watchlists]);
  // Re-render only when these quotes change, not on every quote batch.
  const keys = useMemo(() => [...contracts, ...underlyings].map((c) => contractKey(c)), [contracts, underlyings]);
  const quotes = useQuotesByKey(keys);
  useQuoteSubscriptions(owner, contracts, 'option');
  useQuoteSubscriptions(owner + '-und', underlyings, 'basic');
  return useMemo(
    () => computeRiskAlerts(options, quotes, (p) => quotes[contractKey(underlyingFor(p.contract.symbol, watchlists))]),
    [options, quotes, watchlists],
  );
}

export function RiskAlerts() {
  const m = useM();
  const alerts = useRiskAlerts();
  const watchlists = useStore((s) => s.watchlists);
  const openSymbol = useStore((s) => s.openSymbol);
  if (!alerts.length) return <div style={{ padding: '12px 28px', fontSize: 12, color: 'var(--dm)' }}>{m.noAlerts}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {alerts.map((a) => (
        <div
          key={a.id}
          onClick={() => openSymbol(underlyingFor(a.position.contract.symbol, watchlists), 'opt')}
          className="hover-p2"
          style={{ cursor: 'pointer', padding: '12px 28px', display: 'flex', gap: 12, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}
        >
          <div style={{ width: 8, height: 8, marginTop: 4, background: severityColor(a.severity), flexShrink: 0 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>{contractLabel(a.position.contract)}</div>
            <div style={{ fontSize: 12, color: 'var(--mu)' }}>{riskMessage(a, m)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
