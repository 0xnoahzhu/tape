// The New / Edit alert dialog (moomoo's alert dialog in Tape's design): the instrument and its
// session price, the alert type (grouped Uptrend / Downtrend / Market data / Indicators / Events;
// types that do not fit the instrument are listed with the reason), the value block of the type
// (AlertValueBlock.tsx), frequency, US stock sessions and remarks. Alerts are evaluated in the main process: Create / Save sends
// one alert (upsertPriceAlert), and main checks it again. ⏎ saves, Esc cancels (neither while an IME
// composition is open: Esc then drops its pinyin). Alerts do not trade, so the button needs no
// arming delay.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ALERT_FREQUENCIES, ALERT_LINES_WARNING, ALERT_SESSIONS, NOTE_MAX, noteLength, usesAlertSessions } from '@shared/alerts';
import { contractKey, contractLabel } from '@shared/contract';
import { change, px, signColor } from '@shared/format';
import { usStockSession, type MarketSession } from '@shared/session';
import { liveChangeRef, usesUsEquitySession } from '@shared/sessionQuote';
import type { AlertSession, ContractInfo, Quote, QuoteSubscription } from '@shared/types';
import { useQuote, useQuoteSubscriptionList } from '../../hooks/useQuotes';
import { nameOf, useLang } from '../../i18n';
import { errorText } from '../../state/orderActions';
import { useStore, type AlertFormState } from '../../state/store';
import { Button, Chip, Modal, Segmented, TextInput, ToggleRow } from '../../ui/primitives';
import { lessGutter, stableGutter } from '../../ui/scrollGutter';
import { Select } from '../../ui/select';
import { useContractInfo } from '../chart/contractInfo';
import { useNow } from '../chart/useNow';
import { knownName } from '../orders/navigation';
import { AlertValueBlock, label12, MENU_Z } from './AlertValueBlock';
import { useAlertMessages } from './messages';
import {
  ALERT_KIND_GROUPS,
  alertDescription,
  alertFromForm,
  alertLineCount,
  buildRule,
  dialogKey,
  formErrors,
  formLimitProblem,
  formUsesSessions,
  kindOfRule,
  kindProblem,
  limitNote,
  livePrice,
  refusalText,
  typedNote,
  withKind,
  type AlertKind,
} from './model';
import { useAlertStatuses } from './useAlertStatuses';

export function PriceAlertDialog() {
  const form = useStore((s) => s.alertForm);
  if (!form) return null;
  return <AlertForm key={`${contractKey(form.contract)}|${form.editId ?? ''}`} form={form} />;
}

/** Elements that take ⏎ themselves (buttons, links, a menu's box). */
const takesEnter = (t: EventTarget | null) => t instanceof Element && t.closest('button, [role="button"], a[href], textarea') != null;

function AlertForm({ form }: { form: AlertFormState }) {
  const m = useAlertMessages();
  const lang = useLang();
  const setForm = useStore((s) => s.setAlertForm);
  const alerts = useStore((s) => s.priceAlerts);
  const contract = form.contract;
  const stock = contract.secType === 'STK';
  // The turnover and average volume presets need the stock's VWAP and range ticks.
  const subs = useMemo(() => {
    const list: QuoteSubscription[] = [{ contract, profile: 'basic' }];
    if (stock && form.kind === 'volumeAbove') list.push({ contract, profile: 'range' });
    if (stock && form.kind === 'turnoverAbove') list.push({ contract, profile: 'vwap' });
    return list;
  }, [contract, stock, form.kind]);
  useQuoteSubscriptionList('alert-form', subs);
  const quote = useQuote(contract);
  const info = useContractInfo(contract);
  const now = useNow(30_000);
  const session = usesUsEquitySession(contract) ? usStockSession(now, info?.liquidHours) : 'regular';
  const editing = form.editId ? alerts.find((a) => a.id === form.editId) : undefined;
  const statuses = useAlertStatuses(!!form.editId);
  const status = editing && kindOfRule(editing.rule) === form.kind ? statuses.get(editing.id) : undefined;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Patch the latest form so quick successive edits never undo each other.
  const patch = (p: Partial<AlertFormState>) => {
    const cur = useStore.getState().alertForm;
    if (cur) setForm({ ...cur, ...p });
  };
  const cancel = () => setForm(null);

  const built = useMemo(() => buildRule(form), [form]);
  const rule = 'rule' in built ? built.rule : null;
  const errors = useMemo(() => formErrors(form), [form]);
  const limit = formLimitProblem(alerts, form, rule);
  const blocked = !rule || Object.keys(errors).length > 0 || !!limit;
  const lines = alertLineCount(alerts, contract);

  // The value input's text is selected whenever another type brings a new one, so typing replaces it.
  useEffect(() => {
    inputRef.current?.select();
  }, [form.kind]);

  // save() reads the form from the store, so the listener of the first render stays current.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not during an IME composition: Esc there drops the pinyin of a remark, not the dialog.
      const action = dialogKey(e, takesEnter(e.target));
      if (!action) return;
      // Handled: nothing behind the dialog (a floating panel, the bell) takes it as well.
      e.preventDefault();
      if (action === 'cancel') useStore.getState().setAlertForm(null);
      else void save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Modal onClose={cancel} zIndex={19} width={440}>
      <Header form={form} quote={quote} info={info} session={session} />
      <div style={{ margin: '0 -28px', padding: `0 ${lessGutter(28)} 0 28px`, overflowY: 'auto', minHeight: 0, ...stableGutter, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={label12}>{m.alertType}</div>
          <Select<AlertKind>
            options={ALERT_KIND_GROUPS.flatMap(({ group, kinds }) =>
              kinds.map((k) => {
                const problem = kindProblem(k, contract);
                return { key: k, label: m.kinds[k], hint: m.hints[k], group: m.groups[group], why: problem ? m.problems[problem] : null };
              }),
            )}
            value={form.kind}
            onChange={(kind) => {
              const cur = useStore.getState().alertForm;
              if (cur) setForm(withKind(cur, kind, useStore.getState().quotes[contractKey(cur.contract)], lang));
            }}
            zIndex={MENU_Z}
            showWhy
          />
        </div>
        <AlertValueBlock form={form} patch={patch} quote={quote} info={info} session={session} status={status} errors={errors} inputRef={inputRef} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={label12}>{m.frequency}</div>
          <Segmented
            options={ALERT_FREQUENCIES.map((f) => ({ key: f, label: m.freq[f] }))}
            value={form.frequency}
            onChange={(frequency) => patch({ frequency })}
            style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}
            itemStyle={{ height: 30, padding: 0 }}
          />
          <div style={{ fontSize: 11, color: 'var(--dm)' }}>{m.freqHint[form.frequency]}</div>
        </div>
        {formUsesSessions(form) && <Sessions sessions={form.sessions} onChange={(sessions) => patch({ sessions })} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', ...label12 }}>
            <div>{m.remarks}</div>
            <div style={{ fontFamily: 'var(--num)' }}>
              {/* An open IME composition counts its pinyin letters until it ends. */}
              {Math.min(noteLength(form.note), NOTE_MAX)}/{NOTE_MAX}
            </div>
          </div>
          <TextInput
            value={form.note}
            onChange={(v, composing) => patch({ note: typedNote(v, composing) })}
            onCompositionEnd={(v) => patch({ note: limitNote(v) })}
            placeholder={m.remarksPlaceholder}
          />
        </div>
        {editing && !editing.active && !editing.unsupported && <ToggleRow label={m.turnOn} on={!!form.turnOn} onToggle={() => patch({ turnOn: !form.turnOn })} />}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
          <Button kind="secondary" onClick={cancel}>
            {m.cancel}
          </Button>
          <Button onClick={() => void save()} disabled={blocked || busy} title={limit ? m.limits[limit] : undefined}>
            {form.editId ? m.save : m.create}
          </Button>
        </div>
        {limit && <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--r)' }}>{m.limits[limit]}</div>}
        {lines > ALERT_LINES_WARNING && (!editing || !editing.active) && <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--r)' }}>{m.linesWarning(lines)}</div>}
        <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--dm)' }}>{m.footnote}</div>
      </div>
    </Modal>
  );

  async function save(): Promise<void> {
    const s = useStore.getState();
    const f = s.alertForm;
    if (!f || busyRef.current) return;
    const result = buildRule(f);
    if (!('rule' in result) || Object.keys(formErrors(f)).length || formLimitProblem(s.priceAlerts, f, result.rule)) return;
    const existing = f.editId ? s.priceAlerts.find((a) => a.id === f.editId) : undefined;
    const alert = alertFromForm(f, result.rule, f.editId ?? crypto.randomUUID(), Date.now(), existing);
    const msgs = useAlertMessages.now();
    busyRef.current = true;
    setBusy(true);
    try {
      await window.tape.upsertPriceAlert(alert);
    } catch (err) {
      busyRef.current = false;
      setBusy(false);
      useStore.getState().showToast(msgs.saveFailed(refusalText(errorText(err), msgs)), 'error');
      return;
    }
    useStore.getState().setAlertForm(null);
    // An edit keeps the alert off; the toggle turns it on again (a condition already met fires at once).
    if (existing && !existing.active && f.turnOn) {
      try {
        await window.tape.setPriceAlertsActive([alert.id], true);
      } catch (err) {
        useStore.getState().showToast(msgs.turnOnFailed(refusalText(errorText(err), msgs)), 'error');
        return;
      }
    }
    useStore.getState().showToast((existing ? msgs.saved : msgs.added)(alertDescription(alert, msgs)));
  }
}

/**
 * Title, last price, then the name and, out of regular hours, a session tag (Pre / Post / Overnight)
 * with that session's price and change: against the previous close, after the close against today's
 * close, the reference day-change alerts are measured against (shared/sessionQuote.ts → liveChangeRef).
 */
function Header({ form, quote, info, session }: { form: AlertFormState; quote: Quote | undefined; info: ContractInfo | null | undefined; session: MarketSession | 'overnight' }) {
  const m = useAlertMessages();
  const lang = useLang();
  const contract = form.contract;
  const price = livePrice(quote);
  const ref = quote ? liveChangeRef(quote, session)?.ref : undefined;
  const tag = usesAlertSessions(contract) && (session === 'pre' || session === 'post' || session === 'overnight') ? m.sessionTag[session] : null;
  const name = nameOf(knownName(contract), lang) || info?.longName || '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div className="ellipsis" style={{ font: '600 18px/1.2 var(--sans)', minWidth: 0 }}>
          {(form.editId ? m.editTitle : m.newTitle)(contractLabel(contract))}
        </div>
        <div className="num" style={{ font: '13px/1 var(--num)', color: 'var(--mu)', whiteSpace: 'nowrap' }}>
          {m.last} {px(price ?? quote?.close)}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, color: 'var(--dm)', minWidth: 0 }}>
        {name && (
          <div className="ellipsis" style={{ minWidth: 0 }}>
            {name}
          </div>
        )}
        {tag && <div style={{ flexShrink: 0, padding: '2px 5px', font: '600 11px/1 var(--mono)', boxShadow: 'inset 0 0 0 1px var(--ln)', color: 'var(--mu)' }}>{tag}</div>}
        {price != null && ref != null && (
          <div className="num" style={{ flexShrink: 0, font: '12px/1 var(--num)', color: signColor(price - ref), whiteSpace: 'nowrap' }}>
            {tag ? `${px(price)} ` : ''}
            {change(price, ref)}
          </div>
        )}
      </div>
      {quote?.error && (
        <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--r)' }}>
          {quote.error.message} ({quote.error.code})
        </div>
      )}
    </div>
  );
}

/** US stock sessions as toggles; the last one on stays on. */
function Sessions({ sessions, onChange }: { sessions: AlertSession[]; onChange: (s: AlertSession[]) => void }) {
  const m = useAlertMessages();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={label12}>{m.sessions}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {ALERT_SESSIONS.map((s) => {
          const on = sessions.includes(s);
          const last = on && sessions.length === 1;
          return (
            <Chip
              key={s}
              active={on}
              title={last ? m.lastSession : undefined}
              onClick={last ? undefined : () => onChange(on ? sessions.filter((x) => x !== s) : ALERT_SESSIONS.filter((x) => x === s || sessions.includes(x)))}
              style={{ textAlign: 'center', cursor: last ? 'not-allowed' : 'pointer' }}
            >
              {m.session[s]}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}
