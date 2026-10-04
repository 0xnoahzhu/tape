// Price alert form (design "pa" dialog): condition, trigger price with presets, repeat.
// Alerts are evaluated in the main process; this only edits the persisted list.

import { useEffect, useMemo, useRef, useState } from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import { pct, px, sg } from '@shared/format';
import { lastPrice, useQuote, useQuoteSubscriptions } from '../../hooks/useQuotes';
import { errorText } from '../../state/orderActions';
import { useStore, type AlertFormState } from '../../state/store';
import { Button, Modal, Segmented, TextInput, ToggleRow } from '../../ui/primitives';
import { useAlertMessages } from './messages';
import { ALERT_PRESETS, alertSummary, conditionFor, distancePct, isAlreadyMet, newAlert, parseAlertPrice, presetPrice, type AlertCondition } from './model';

export function PriceAlertDialog() {
  const form = useStore((s) => s.alertForm);
  if (!form) return null;
  return <AlertForm key={contractKey(form.contract)} form={form} />;
}

function AlertForm({ form }: { form: AlertFormState }) {
  const m = useAlertMessages();
  const setForm = useStore((s) => s.setAlertForm);
  const contracts = useMemo(() => [form.contract], [form.contract]);
  useQuoteSubscriptions('alert-form', contracts);
  const quote = useQuote(form.contract);
  const last = lastPrice(quote);
  const price = parseAlertPrice(form.price);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Patch the latest form so quick successive edits never undo each other.
  const patch = (p: Partial<AlertFormState>) => {
    const cur = useStore.getState().alertForm;
    if (cur) setForm({ ...cur, ...p });
  };
  const cancel = () => setForm(null);

  const create = async () => {
    const s = useStore.getState();
    const f = s.alertForm;
    const v = f ? parseAlertPrice(f.price) : null;
    if (!f || v == null || busy) return;
    setBusy(true);
    try {
      await window.tape.savePriceAlerts([newAlert(f.contract, f.condition, v, f.repeat, crypto.randomUUID(), Date.now()), ...s.priceAlerts]);
      useStore.getState().setAlertForm(null);
      useStore.getState().showToast(useAlertMessages.now().added(alertSummary(f.contract, f.condition, v)));
    } catch (err) {
      setBusy(false);
      useStore.getState().showToast(useAlertMessages.now().saveFailed(errorText(err)), 'error');
    }
  };

  // Select the prefilled price so typing replaces it.
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.getState().setAlertForm(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  let dist: string;
  if (price == null) dist = m.enterPrice;
  else if (last == null) dist = m.noLast;
  else dist = m.fromLast(pct(distancePct(price, last))) + (isAlreadyMet(form.condition, price, last) ? m.alreadyMet : '');

  return (
    <Modal onClose={cancel} zIndex={19}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div className="ellipsis" style={{ font: '600 18px/1.2 var(--sans)', minWidth: 0 }}>
          {m.title(contractLabel(form.contract))}
        </div>
        <div className="num" style={{ font: '13px/1 var(--num)', color: 'var(--mu)', whiteSpace: 'nowrap' }} title={quote?.error?.message}>
          {m.last} {px(last)}
        </div>
      </div>
      <Segmented<AlertCondition>
        options={[
          { key: 'above', label: m.above },
          { key: 'below', label: m.below },
        ]}
        value={form.condition}
        onChange={(condition) => patch({ condition })}
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}
        itemStyle={{ height: 36, padding: 0, fontSize: 14, fontWeight: 600 }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--dm)' }}>{m.triggerPrice}</div>
        <TextInput
          inputRef={inputRef}
          value={form.price}
          onChange={(v) => patch({ price: v })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void create();
            }
            if (e.key === 'Escape') cancel();
          }}
          autoFocus
          accent
          align="right"
          height={44}
          style={{ padding: '0 14px', font: '500 16px/1 var(--num)' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {ALERT_PRESETS.map((k) => (
            <div
              key={k}
              onClick={last == null ? undefined : () => patch({ condition: conditionFor(k), price: presetPrice(last, k) })}
              className={last == null ? undefined : 'hover-tx'}
              style={{
                padding: '5px 9px',
                font: '12px/1 var(--num)',
                cursor: last == null ? 'default' : 'pointer',
                boxShadow: 'inset 0 0 0 1px var(--ln)',
                color: 'var(--mu)',
                opacity: last == null ? 0.4 : 1,
              }}
            >
              {sg(k, String)}%
            </div>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 12, color: 'var(--dm)', textAlign: 'right' }}>{dist}</div>
        </div>
      </div>
      <ToggleRow label={m.repeat} desc={m.repeatDesc} on={form.repeat} onToggle={() => patch({ repeat: !form.repeat })} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
        <Button kind="secondary" onClick={cancel}>
          {m.cancel}
        </Button>
        <Button onClick={() => void create()} disabled={price == null || busy}>
          {m.create}
        </Button>
      </div>
    </Modal>
  );
}
