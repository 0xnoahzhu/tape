// Bell panel › Alerts: the user's price alerts, then option risk alerts from the options desk.

import { useMemo } from 'react';
import { contractLabel } from '@shared/contract';
import { pct, px } from '@shared/format';
import type { PriceAlert } from '@shared/types';
import { lastPrice, useQuote, useQuoteSubscriptions } from '../../hooks/useQuotes';
import { errorText } from '../../state/orderActions';
import { useClock } from '../../i18n';
import { useStore } from '../../state/store';
import { useAlertMessages } from '../alerts/messages';
import { distancePct } from '../alerts/model';
import { OptionsDesk } from '../options/OptionsDesk';
import { useNotificationsMessages } from './messages';
import { alertInstrumentParts } from './model';

function confirmDelete(alert: PriceAlert): void {
  const m = useNotificationsMessages.now();
  const a = useAlertMessages.now();
  useStore.getState().ask({
    title: m.deleteAlert,
    rows: [
      { label: m.symbol, value: contractLabel(alert.contract) },
      { label: m.condition, value: `${alert.condition === 'above' ? a.above : a.below} ${px(alert.price)}` },
    ],
    label: m.delete,
    danger: true,
    run: async () => {
      const remaining = useStore.getState().priceAlerts.filter((x) => x.id !== alert.id);
      try {
        await window.tape.savePriceAlerts(remaining);
      } catch (err) {
        useStore.getState().showToast(errorText(err), 'error');
      }
    },
  });
}

function AlertRow({ alert }: { alert: PriceAlert }) {
  const m = useNotificationsMessages();
  const a = useAlertMessages();
  const clock = useClock();
  const quote = useQuote(alert.contract);
  const last = lastPrice(quote);
  const { symbol, detail } = alertInstrumentParts(alert.contract);
  const sub = [
    detail,
    `${m.last} ${px(last)}`,
    last != null ? pct(distancePct(alert.price, last)) : '',
    alert.repeat ? m.repeats : '',
    !alert.active && alert.lastTriggeredAt ? m.triggered(clock.time(alert.lastTriggeredAt, { seconds: true })) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px', boxShadow: 'inset 0 1px 0 var(--ln2)', opacity: alert.active ? 1 : 0.55 }}>
      <div className="ellipsis" title={contractLabel(alert.contract)} style={{ font: '600 13px/1 var(--mono)', width: 52, flexShrink: 0 }}>
        {symbol}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 13 }}>
          {alert.condition === 'above' ? a.above : a.below} <span style={{ fontFamily: 'var(--num)' }}>{px(alert.price)}</span>
        </div>
        <div className="ellipsis" style={{ fontSize: 11, color: 'var(--dm)' }} title={quote?.error?.message}>
          {sub}
        </div>
      </div>
      <div
        onClick={() => confirmDelete(alert)}
        title={m.deleteAlert}
        className="hover-r"
        style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dm)', cursor: 'pointer', flexShrink: 0 }}
      >
        ×
      </div>
    </div>
  );
}

export function AlertsTab() {
  const m = useNotificationsMessages();
  const alerts = useStore((s) => s.priceAlerts);
  const symbol = useStore((s) => s.symbol);
  const openAlertForm = useStore((s) => s.openAlertForm);
  const contracts = useMemo(() => alerts.map((x) => x.contract), [alerts]);
  useQuoteSubscriptions('bell-alerts', contracts);

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{m.priceAlerts}</div>
        <div onClick={() => openAlertForm(symbol)} style={{ fontSize: 12, color: 'var(--ac)', cursor: 'pointer' }}>
          {m.addFor(contractLabel(symbol))}
        </div>
      </div>
      {alerts.length === 0 && <div style={{ padding: '2px 18px 14px', fontSize: 12, color: 'var(--dm)', lineHeight: 1.5 }}>{m.noAlerts}</div>}
      {alerts.map((x) => (
        <AlertRow key={x.id} alert={x} />
      ))}
      <div style={{ height: 44, display: 'flex', alignItems: 'center', padding: '0 18px', marginTop: 8, boxShadow: 'inset 0 1px 0 var(--ln)', flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{m.riskAlerts}</div>
      </div>
      <div style={{ padding: '0 18px 4px', fontSize: 12, color: 'var(--dm)', lineHeight: 1.5 }}>{m.riskHint}</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <OptionsDesk mode="alerts" />
      </div>
    </div>
  );
}
