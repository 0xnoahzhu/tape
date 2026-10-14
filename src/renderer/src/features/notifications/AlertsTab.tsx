// Bell panel › Alerts: the user's alerts grouped by instrument, then option risk alerts from the
// options desk. Each row says what the alert watches ("5-min rise ≥ 2%"), the value main measures
// now, its frequency and note, and whether main is watching it (useAlertStatuses: the status event,
// polled every 2 s while the list is open). A click edits the alert, the switch pauses or resumes it,
// × deletes it after a confirmation; the context menu also duplicates it and opens its chart.
// Changes go to main one at a time (setPriceAlertsActive, deletePriceAlerts).

import { useRef, useState } from 'react';
import { contractLabel, sameContract } from '@shared/contract';
import type { AlertStatus, PriceAlert } from '@shared/types';
import { useClock } from '../../i18n';
import { errorText } from '../../state/orderActions';
import { useStore, type ConfirmRow } from '../../state/store';
import { GlyphButton, Segmented, Toggle } from '../../ui/primitives';
import { lessGutter, stableGutter } from '../../ui/scrollGutter';
import { Dropdown, MenuChoice } from '../../ui/select';
import { useAlertMessages } from '../alerts/messages';
import { groupByInstrument, isEditable, isSpent, kindOfRule, nowText, refusalText, ruleSummary, statusText, toneColor } from '../alerts/model';
import { useAlertStatuses } from '../alerts/useAlertStatuses';
import { OptionsDesk } from '../options/OptionsDesk';
import { openInstrument } from '../orders/navigation';
import { useNotificationsMessages } from './messages';

/** Above this many alerts the list offers "This symbol / All". */
const SCOPE_MIN = 8;

// The panel unmounts when closed; the scope is kept for the session.
let lastScope: 'symbol' | 'all' = 'all';

function showError(err: unknown): void {
  const a = useAlertMessages.now();
  useStore.getState().showToast(refusalText(errorText(err), a), 'error');
}

function setActive(alert: PriceAlert, active: boolean): void {
  window.tape.setPriceAlertsActive([alert.id], active).catch(showError);
}

/** The rows a delete confirmation shows for an alert: instrument, type, condition, frequency, note. */
function alertRows(alert: PriceAlert): ConfirmRow[] {
  const m = useNotificationsMessages.now();
  const a = useAlertMessages.now();
  const rows: ConfirmRow[] = [{ label: m.symbol, value: contractLabel(alert.contract) }];
  if (!alert.unsupported) rows.push({ label: m.type, value: a.kinds[kindOfRule(alert.rule)], prose: true });
  rows.push({ label: m.condition, value: ruleSummary(alert, a), prose: true });
  if (!alert.unsupported) rows.push({ label: m.frequency, value: a.freq[alert.frequency], prose: true });
  if (alert.note) rows.push({ label: m.note, value: alert.note, prose: true });
  return rows;
}

function confirmDelete(alert: PriceAlert): void {
  const m = useNotificationsMessages.now();
  useStore.getState().ask({
    title: m.deleteAlert,
    rows: alertRows(alert),
    label: m.delete,
    danger: true,
    run: () => window.tape.deletePriceAlerts([alert.id]).catch(showError),
  });
}

/** Deletes the 'once' alerts that fired and turned themselves off, after a confirmation listing them. */
function confirmDeleteSpent(spent: PriceAlert[]): void {
  const m = useNotificationsMessages.now();
  const a = useAlertMessages.now();
  const shown = spent.slice(0, 5);
  useStore.getState().ask({
    title: m.deleteSpentTitle(spent.length),
    rows: shown.map((x) => ({ label: contractLabel(x.contract), value: ruleSummary(x, a), prose: true })),
    note: spent.length > shown.length ? m.andMore(spent.length - shown.length) : undefined,
    label: m.delete,
    danger: true,
    run: () => window.tape.deletePriceAlerts(spent.map((x) => x.id)).catch(showError),
  });
}

function AlertRow({ alert, status, onMenu }: { alert: PriceAlert; status: AlertStatus | undefined; onMenu: (alert: PriceAlert, anchor: HTMLElement) => void }) {
  const m = useNotificationsMessages();
  const a = useAlertMessages();
  const clock = useClock();
  const ref = useRef<HTMLDivElement>(null);
  const editable = isEditable(alert);
  const state = statusText(alert, status, a, clock, Date.now());
  const sub = [nowText(alert, status, a), alert.unsupported ? '' : a.freq[alert.frequency], alert.note ?? ''].filter(Boolean).join(' · ');
  // A newer Tape's alert is never evaluated here: it can only be deleted, and shows as off (its
  // stored on / off is the newer Tape's).
  const canToggle = !alert.unsupported;
  const on = alert.active && !alert.unsupported;
  const open = () => editable && useStore.getState().openAlertForm(alert.contract, alert, 'edit');
  return (
    <div
      ref={ref}
      onClick={open}
      onContextMenu={(e) => {
        e.preventDefault();
        if (ref.current) onMenu(alert, ref.current);
      }}
      title={editable ? m.editTip : m.cannotEdit}
      className={editable ? 'hover-p2' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: `9px ${lessGutter(18)} 9px 18px`,
        cursor: editable ? 'pointer' : 'default',
        boxShadow: 'inset 0 1px 0 var(--ln2)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, opacity: on ? 1 : 0.6 }}>
        <div className="ellipsis" style={{ fontSize: 13 }}>
          {ruleSummary(alert, a)}
        </div>
        {(sub || state) && (
          // The status keeps its room before the rest: it is what the row must say.
          <div style={{ display: 'flex', minWidth: 0, fontSize: 11, color: 'var(--dm)' }} title={[sub, state?.text].filter(Boolean).join(' · ')}>
            {sub && (
              <div className="ellipsis" style={{ flex: '0 1 auto', minWidth: 0 }}>
                {sub}
              </div>
            )}
            {state && (
              <div className="ellipsis" style={{ flex: '0 0 auto', maxWidth: sub ? '75%' : '100%', color: toneColor(state.tone) }}>
                {sub ? `\u00a0· ${state.text}` : state.text}
              </div>
            )}
          </div>
        )}
      </div>
      <Toggle
        on={on}
        disabled={!canToggle}
        title={!canToggle ? m.cannotToggle : alert.active ? m.pauseTip : m.resumeTip}
        onClick={(e) => {
          e.stopPropagation();
          setActive(alert, !alert.active);
        }}
      />
      <GlyphButton title={m.deleteAlert} fontSize={14} danger onClick={() => confirmDelete(alert)}>
        ×
      </GlyphButton>
    </div>
  );
}

export function AlertsTab() {
  const m = useNotificationsMessages();
  const alerts = useStore((s) => s.priceAlerts);
  const symbol = useStore((s) => s.symbol);
  const openAlertForm = useStore((s) => s.openAlertForm);
  const statuses = useAlertStatuses(true);
  const [scope, setScope] = useState(lastScope);
  const [menu, setMenu] = useState<{ alert: PriceAlert; anchor: HTMLElement } | null>(null);
  const scoped = alerts.length > SCOPE_MIN && scope === 'symbol';
  const shown = scoped ? alerts.filter((x) => sameContract(x.contract, symbol)) : alerts;
  const groups = groupByInstrument(shown);
  const spent = alerts.filter(isSpent);

  const pickScope = (s: 'symbol' | 'all') => {
    lastScope = s;
    setScope(s);
  };
  const act = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', ...stableGutter, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 44, display: 'flex', alignItems: 'center', gap: 12, padding: `0 ${lessGutter(18)} 0 18px`, flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{m.alerts}</div>
        {alerts.length > SCOPE_MIN && (
          <Segmented
            options={[
              { key: 'symbol', label: m.thisSymbol },
              { key: 'all', label: m.all },
            ]}
            value={scope}
            onChange={pickScope}
            itemStyle={{ padding: '3px 8px', fontSize: 11 }}
          />
        )}
        <div style={{ flex: 1 }} />
        <div onClick={() => openAlertForm(symbol)} className="ellipsis" style={{ fontSize: 12, color: 'var(--ac)', cursor: 'pointer', minWidth: 0 }}>
          {m.addFor(contractLabel(symbol))}
        </div>
      </div>
      {shown.length === 0 && (
        <div style={{ padding: `2px ${lessGutter(18)} 14px 18px`, fontSize: 12, color: 'var(--dm)', lineHeight: 1.5 }}>{scoped ? m.noneFor(contractLabel(symbol)) : m.noAlerts}</div>
      )}
      {groups.map((g) => (
        <div key={g.key} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          <div className="ellipsis" style={{ padding: `12px ${lessGutter(18)} 6px 18px`, font: '600 13px/1 var(--mono)', boxShadow: 'inset 0 1px 0 var(--ln2)' }}>
            {contractLabel(g.contract)}
          </div>
          {g.alerts.map((x) => (
            <AlertRow key={x.id} alert={x} status={statuses.get(x.id)} onMenu={(alert, anchor) => setMenu({ alert, anchor })} />
          ))}
        </div>
      ))}
      {spent.length > 0 && (
        <div style={{ display: 'flex', padding: `8px ${lessGutter(18)} 4px 18px`, boxShadow: 'inset 0 1px 0 var(--ln2)', flexShrink: 0 }}>
          <div onClick={() => confirmDeleteSpent(spent)} className="hover-tx" style={{ fontSize: 12, color: 'var(--dm)', cursor: 'pointer' }}>
            {m.deleteSpent(spent.length)}
          </div>
        </div>
      )}
      <div style={{ height: 44, display: 'flex', alignItems: 'center', padding: `0 ${lessGutter(18)} 0 18px`, marginTop: 8, boxShadow: 'inset 0 1px 0 var(--ln)', flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{m.riskAlerts}</div>
      </div>
      <div style={{ padding: `0 ${lessGutter(18)} 4px 18px`, fontSize: 12, color: 'var(--dm)', lineHeight: 1.5 }}>{m.riskHint}</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <OptionsDesk mode="alerts" />
      </div>
      {menu && (
        <Dropdown anchor={menu.anchor} width={180} onClose={() => setMenu(null)}>
          {(() => {
            const x = menu.alert;
            const editable = isEditable(x);
            const why = editable ? null : m.cannotEdit;
            const canToggle = !x.unsupported;
            return (
              <>
                <MenuChoice label={m.edit} why={why} onPick={act(() => useStore.getState().openAlertForm(x.contract, x, 'edit'))} />
                <MenuChoice label={x.active && canToggle ? m.pause : m.resume} why={canToggle ? null : m.cannotToggle} onPick={act(() => setActive(x, !x.active))} />
                <MenuChoice label={m.duplicate} why={why} onPick={act(() => useStore.getState().openAlertForm(x.contract, x, 'duplicate'))} />
                <MenuChoice
                  label={m.openChart}
                  onPick={act(() => {
                    useStore.getState().setBell(false);
                    openInstrument(x.contract, 'chart');
                  })}
                />
                <MenuChoice label={<span style={{ color: 'var(--r)' }}>{m.delete}</span>} onPick={act(() => confirmDelete(x))} />
              </>
            );
          })()}
        </Dropdown>
      )}
    </div>
  );
}
