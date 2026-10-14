// The value part of the alert dialog, by the type picked (alerts/model.ts → valueBlock): a price with
// −5 / −2 / +2 / +5 % presets, a percent, a volume or turnover (10M, 1.5B, 1000万, 2亿), a bid / ask
// size, an indicator's signal, parameters, interval and trigger with a live preview of the values the
// alert will test, a halt / resume choice, or the news providers of a headline alert. Each says where
// the market is now ("From last +3.31%", "Now +1.24%") and whether the alert would fire at once.

import { useEffect, useMemo, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { ALERT_TIMEFRAMES } from '@shared/alerts';
import { f0, parseQuantity, pct, sg } from '@shared/format';
import { barsNeeded, readIndicator } from '@shared/indicatorSignal';
import { alertBarForming, mergeLivePrice, sessionOpenSec } from '@shared/liveBars';
import { usEquitySession, usWeekClosed, type MarketSession } from '@shared/session';
import { usesUsEquitySession } from '@shared/sessionQuote';
import type { AlertRule, AlertStatus, ContractInfo, NewsProviders, Quote } from '@shared/types';
import { useMarketDataAvailable } from '../../hooks/useQuotes';
import { useLang } from '../../i18n';
import { Chip, Segmented, TextInput } from '../../ui/primitives';
import { Select } from '../../ui/select';
import { barsKey, loadBars, useBarsStore } from '../chart/barsStore';
import { useNow } from '../chart/useNow';
import { useAlertMessages, type AlertMessages } from './messages';
import {
  alreadyMet,
  buildRule,
  countUnit,
  dataNote,
  dayChange,
  distancePct,
  LEVEL_PRESETS,
  livePrice,
  newsChoices,
  niceQuantity,
  PERCENT_PRESETS,
  presetPrice,
  previewText,
  PRICE_PRESETS,
  quantityInput,
  referencePrice,
  ruleTypeOf,
  SIGNAL_CHOICES,
  signalParams,
  SIZE_PRESETS,
  turnoverOf,
  valueBlock,
  VOLUME_PRESETS,
  withSignal,
  type AlertFormErrors,
  type AlertFormState,
  type IndicatorForm,
  type ParamKey,
} from './model';

/** The history service slot of the dialog's preview bars: a newer interval supersedes an older one still waiting. */
const PREVIEW_SLOT = 'alert-form';
/** The layer of the dialog's menus: above the dialog (19). */
export const MENU_Z = 22;

export const label12: CSSProperties = { fontSize: 12, color: 'var(--dm)' };
const hint11: CSSProperties = { fontSize: 11, lineHeight: 1.45, color: 'var(--dm)' };
const error11: CSSProperties = { fontSize: 11, lineHeight: 1.45, color: 'var(--r)' };

export interface ValueBlockProps {
  form: AlertFormState;
  patch: (p: Partial<AlertFormState>) => void;
  quote: Quote | undefined;
  info: ContractInfo | null | undefined;
  /** The session a day's change is measured in (a US stock's, overnight included). */
  session: MarketSession | 'overnight';
  /** Main's status of the alert being edited (its measured value). */
  status?: AlertStatus;
  /** The IB login's API news providers (news alerts); undefined until main answered. */
  news?: NewsProviders;
  errors: AlertFormErrors;
  inputRef: RefObject<HTMLInputElement | null>;
}

/** A preset chip under an input (design "pa" chips). */
function PresetChip({ children, onClick, title, active }: { children: ReactNode; onClick?: () => void; title?: string; active?: boolean }) {
  return (
    <div
      onClick={onClick}
      title={title}
      className={onClick ? 'hover-tx' : undefined}
      style={{
        padding: '5px 9px',
        font: '12px/1 var(--num)',
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: `inset 0 0 0 1px ${active ? 'var(--ac)' : 'var(--ln)'}`,
        color: active ? 'var(--tx)' : 'var(--mu)',
        opacity: onClick ? 1 : 0.4,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </div>
  );
}

/** A right-aligned number input with its unit inside at the right ("USD", "%", "shares"). */
function UnitInput({
  value,
  onChange,
  unit,
  inputRef,
  big,
}: {
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  big?: boolean;
}) {
  const room = unit ? 22 + unit.length * 7 : 14;
  return (
    <div style={{ position: 'relative' }}>
      <TextInput
        inputRef={inputRef}
        value={value}
        onChange={onChange}
        autoFocus={!!inputRef}
        accent={big}
        align="right"
        height={big ? 44 : 34}
        style={{ padding: `0 ${room}px 0 14px`, font: big ? '500 16px/1 var(--num)' : '500 13px/1 var(--num)' }}
      />
      {unit && (
        <div style={{ position: 'absolute', top: 0, bottom: 0, right: 12, display: 'flex', alignItems: 'center', fontSize: 12, color: 'var(--dm)', pointerEvents: 'none' }}>{unit}</div>
      )}
    </div>
  );
}

/** Chips on the left, the status ("From last +3.31%") on the right. */
function ChipRow({ chips, status }: { chips: ReactNode; status?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', rowGap: 6 }}>
      {chips}
      <div style={{ flex: 1 }} />
      {status != null && <div style={{ fontSize: 12, color: 'var(--dm)', textAlign: 'right' }}>{status}</div>}
    </div>
  );
}

const FieldError = ({ text }: { text?: string }) => (text ? <div style={error11}>{text}</div> : null);

/**
 * Lines about the quote the alert would read (dataNote, as main evaluates it): delayed data a
 * live-only rule waits on, delayed data a price rule fires on (marked), frozen data (2, delayed
 * frozen 4) nothing fires on, and bid / ask from one exchange only.
 */
function DataNotes({ form, quote, m }: { form: AlertFormState; quote: Quote | undefined; m: AlertMessages }) {
  const type = ruleTypeOf(form.kind);
  // News alerts read no quotes.
  if (!type || type === 'news' || !quote) return null;
  const lines: Array<{ text: string; color: string }> = [];
  const note = dataNote(type, quote.marketDataType);
  if (note) lines.push({ text: m[note], color: note === 'needsLiveDelayed' ? 'var(--r)' : 'var(--dm)' });
  const quoteSide = type === 'bidAbove' || type === 'askBelow' || type === 'bidSizeAbove' || type === 'askSizeAbove';
  if (quoteSide && quote.source?.kind === 'primary') lines.push({ text: m.primaryQuote(quote.source.exchange), color: 'var(--dm)' });
  if (!lines.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {lines.map((l) => (
        <div key={l.text} style={{ ...hint11, color: l.color }}>
          {l.text}
        </div>
      ))}
    </div>
  );
}

export function AlertValueBlock(props: ValueBlockProps) {
  const m = useAlertMessages();
  const block = valueBlock(props.form.kind);
  let body: ReactNode = null;
  switch (block) {
    case 'price':
      body = <PriceBlock {...props} m={m} />;
      break;
    case 'percent':
      body = <PercentBlock {...props} m={m} />;
      break;
    case 'quantity':
    case 'size':
      body = <QuantityBlock {...props} m={m} />;
      break;
    case 'indicator':
      body = <IndicatorBlock {...props} m={m} />;
      break;
    case 'halt':
      body = <HaltBlock {...props} m={m} />;
      break;
    case 'news':
      body = <NewsBlock {...props} m={m} />;
      break;
    case 'none':
      return null;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {body}
      <DataNotes form={props.form} quote={props.quote} m={m} />
    </div>
  );
}

type BlockProps = ValueBlockProps & { m: AlertMessages };

/** The rule the form builds now, if it is complete. */
function useRule(form: AlertFormState): AlertRule | null {
  return useMemo(() => {
    const built = buildRule(form);
    return 'rule' in built ? built.rule : null;
  }, [form]);
}

function PriceBlock({ form, patch, quote, errors, inputRef, m }: BlockProps) {
  const rule = useRule(form);
  const ref = referencePrice(form.kind, quote);
  const lastLevel = form.kind === 'priceAbove' || form.kind === 'priceBelow';
  const from = form.kind === 'bidAbove' ? m.fromBid : form.kind === 'askBelow' ? m.fromAsk : m.fromLast;
  const none = form.kind === 'bidAbove' ? m.noBid : form.kind === 'askBelow' ? m.noAsk : m.noLast;
  // Whether it is met is the live price's question (never the previous close's).
  const current = lastLevel ? livePrice(quote) : ref;
  let status: string | undefined;
  if (rule && 'value' in rule) status = ref == null ? none : from(pct(distancePct(rule.value, ref))) + (alreadyMet(rule, current) ? m.alreadyMet : '');
  return (
    <>
      <UnitInput value={form.value} onChange={(value) => patch({ value })} unit={form.contract.currency} inputRef={inputRef} big />
      <ChipRow
        chips={PRICE_PRESETS.map((k) => (
          <PresetChip
            key={k}
            // Price presets also pick the direction (+2% rises above, −2% falls below); bid and ask keep theirs.
            onClick={ref == null ? undefined : () => patch({ value: presetPrice(ref, k), ...(lastLevel ? { kind: k > 0 ? 'priceAbove' : 'priceBelow' } : null) })}
          >
            {sg(k, String)}%
          </PresetChip>
        ))}
        status={status}
      />
      <FieldError text={form.value.trim() && errors.value ? m.errors[errors.value] : undefined} />
    </>
  );
}

function PercentBlock({ form, patch, quote, session, status, errors, inputRef, m }: BlockProps) {
  const rule = useRule(form);
  const day = form.kind === 'dayRise' || form.kind === 'dayFall';
  const minutes = form.kind.endsWith('3') ? 3 : 5;
  let line: string | undefined;
  if (day) {
    const c = dayChange(quote, session);
    if (!c) line = m.noLast;
    else line = (c.afterHours ? m.nowAfterHours : m.now)(pct(c.value)) + (rule && alreadyMet(rule, c.value) ? m.alreadyMet : '');
  } else if (status?.value !== undefined && status.state !== 'waiting') line = m.now(pct(status.value));
  return (
    <>
      <UnitInput value={form.value} onChange={(value) => patch({ value })} unit="%" inputRef={inputRef} big />
      <ChipRow
        chips={PERCENT_PRESETS.map((k) => (
          <PresetChip key={k} active={form.value.trim() === String(k)} onClick={() => patch({ value: String(k) })}>
            {k}%
          </PresetChip>
        ))}
        status={line}
      />
      {!day && <div style={hint11}>{m.windowHint(minutes)}</div>}
      <FieldError text={form.value.trim() && errors.value ? m.errors[errors.value] : undefined} />
    </>
  );
}

function QuantityBlock({ form, patch, quote, errors, inputRef, m }: BlockProps) {
  const lang = useLang();
  const rule = useRule(form);
  const kind = form.kind;
  const unit = kind === 'turnoverAbove' ? form.contract.currency : countUnit(form.contract, m);
  let current: number | undefined;
  let nowText: string | undefined;
  if (kind === 'volumeAbove') {
    current = quote?.volume;
    nowText = current == null ? undefined : m.qty(current);
  } else if (kind === 'turnoverAbove') {
    current = turnoverOf(quote);
    nowText = current == null ? undefined : `≈${m.money(current, form.contract.currency)}`;
  } else {
    current = kind === 'bidSizeAbove' ? quote?.bidSize : quote?.askSize;
    nowText = current == null ? undefined : f0(current);
  }
  const status = nowText == null ? m.noValue : m.now(nowText) + (rule && alreadyMet(rule, current) ? m.alreadyMet : '');
  // A typed unit ("10M", "1000万") is spelled out, so the amount is never misread.
  const typed = parseQuantity(form.value);
  const spelled = /[^\d.,\s]/.test(form.value) && Number.isFinite(typed) && typed > 0 ? `= ${f0(typed)}` : undefined;
  const avg = quote?.avgVolume;
  let chips: ReactNode = null;
  if (kind === 'volumeAbove' && avg != null && avg > 0) {
    chips = VOLUME_PRESETS.map((k) => {
      const v = quantityInput(niceQuantity(avg * k), lang);
      return (
        <PresetChip key={k} active={form.value.trim() === v} title={m.avgChipTitle(k, m.qty(avg))} onClick={() => patch({ value: v })}>
          {m.avgChip(k)}
        </PresetChip>
      );
    });
  } else if (kind === 'bidSizeAbove' || kind === 'askSizeAbove') {
    chips = SIZE_PRESETS.map((k) => {
      const v = quantityInput(k, lang);
      return (
        <PresetChip key={k} active={form.value.trim() === v} onClick={() => patch({ value: v })}>
          {v}
        </PresetChip>
      );
    });
  }
  return (
    <>
      <UnitInput value={form.value} onChange={(value) => patch({ value })} unit={unit} inputRef={inputRef} big />
      <ChipRow chips={chips} status={status} />
      {spelled && <div style={{ ...hint11, fontFamily: 'var(--num)' }}>{`${spelled} ${unit}`}</div>}
      <FieldError text={form.value.trim() && errors.value ? m.errors[errors.value] : undefined} />
    </>
  );
}

function HaltBlock({ form, patch, m }: BlockProps) {
  return (
    <>
      <Segmented<'halted' | 'resumed'>
        options={[
          { key: 'halted', label: m.haltDir.halted },
          { key: 'resumed', label: m.haltDir.resumed },
        ]}
        value={form.haltDir}
        onChange={(haltDir) => patch({ haltDir })}
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}
        itemStyle={{ height: 32, padding: 0 }}
      />
      <div style={hint11}>{m.haltHints[form.haltDir]}</div>
    </>
  );
}

/**
 * The news providers of a headline alert as toggles (the last one on stays on): the login's, and an
 * edited alert's that the login does not have (marked, so they are not dropped unnoticed). Then what
 * the feeds are and how often Tape checks, and when editing, the newest headline main saw.
 */
function NewsBlock({ form, patch, news, status, errors, m }: BlockProps) {
  const choices = newsChoices(news, form.newsProviders);
  const missing = choices.filter((c) => c.missing && form.newsProviders.includes(c.code)).map((c) => c.code);
  const toggle = (code: string) =>
    patch({ newsProviders: form.newsProviders.includes(code) ? form.newsProviders.filter((c) => c !== code) : [...form.newsProviders, code] });
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={label12}>{m.newsProviders}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {choices.map((c) => {
            const on = form.newsProviders.includes(c.code);
            const last = on && form.newsProviders.length === 1;
            return (
              <Chip
                key={c.code}
                active={on}
                title={last ? m.lastProvider : c.code}
                onClick={last ? undefined : () => toggle(c.code)}
                style={{ cursor: last ? 'not-allowed' : 'pointer', whiteSpace: 'normal', ...(c.missing ? { color: 'var(--r)' } : null) }}
              >
                {c.name}
              </Chip>
            );
          })}
        </div>
      </div>
      {missing.length > 0 && <div style={error11}>{m.newsMissing(missing.join(', '))}</div>}
      <FieldError text={errors.providers ? m.errors[errors.providers] : undefined} />
      <div style={hint11}>{m.newsHint}</div>
      {status?.headline ? (
        <div className="ellipsis" title={status.headline} style={{ fontSize: 12, color: 'var(--mu)' }}>
          {m.latestHeadline(status.headline)}
        </div>
      ) : status?.checkedAt !== undefined ? (
        <div style={{ fontSize: 12, color: 'var(--mu)' }}>{m.noHeadlines}</div>
      ) : null}
    </>
  );
}

/** A small labelled parameter input of an indicator. */
function ParamInput({ label, value, onChange, error }: { label: string; value: string; onChange: (v: string) => void; error?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      {/* A fixed line height keeps the inputs in line under Latin and CJK labels. */}
      <div className="ellipsis" style={{ fontSize: 11, lineHeight: '14px', color: 'var(--dm)' }}>
        {label}
      </div>
      <TextInput value={value} onChange={onChange} mono align="right" style={error ? { boxShadow: 'inset 0 0 0 1px var(--r)' } : undefined} />
    </div>
  );
}

function IndicatorBlock({ form, patch, quote, info, errors, m }: BlockProps) {
  const f = form.indicator;
  const set = (p: Partial<IndicatorForm>) => patch({ indicator: { ...f, ...p } });
  // The menu names the lines with the periods typed: "Golden cross: MA5 crosses above MA10".
  const name = f.ind.toUpperCase();
  const p = f.params;
  const [a, b] = f.ind === 'macd' ? ['DIF', 'DEA'] : f.ind === 'kdj' ? ['K', 'D'] : [`${name}${p.fast}`, `${name}${p.slow}`];
  const levelLine = f.ind === 'kdj' ? f.line.toUpperCase() : `RSI${p.period}`;
  const signals = SIGNAL_CHOICES[f.ind].map((key) => ({
    key,
    label: m.signals[key](key === 'priceUp' || key === 'priceDown' ? `${name}${p.period}` : key === 'levelUp' || key === 'levelDown' ? levelLine : a, b),
  }));
  const params = signalParams(f.ind, f.signal);
  const level = f.signal === 'levelUp' || f.signal === 'levelDown';
  const presets = level && (f.ind === 'rsi' || f.ind === 'kdj') ? LEVEL_PRESETS[f.ind][f.signal === 'levelUp' ? 'up' : 'down'] : [];
  const firstError = params.map((k) => errors[k]).find(Boolean);
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={label12}>{m.signal}</div>
        <Select options={signals} value={f.signal} onChange={(signal) => patch({ indicator: withSignal(f, signal) })} zIndex={MENU_Z} />
      </div>
      {f.ind === 'kdj' && level && (
        <Segmented<'k' | 'd' | 'j'>
          options={(['k', 'd', 'j'] as const).map((k) => ({ key: k, label: k.toUpperCase() }))}
          value={f.line}
          onChange={(line) => set({ line })}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}
          itemStyle={{ height: 28, padding: 0 }}
        />
      )}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(params.length, 3)}, 1fr)`, gap: 8 }}>
        {params.map((k: ParamKey) => (
          <ParamInput key={k} label={m.params[k]} value={f.params[k]} onChange={(v) => set({ params: { ...f.params, [k]: v } })} error={!!errors[k]} />
        ))}
      </div>
      {presets.length > 0 && (
        <ChipRow
          chips={presets.map((v) => (
            <PresetChip key={v} active={f.params.level.trim() === String(v)} onClick={() => set({ params: { ...f.params, level: String(v) } })}>
              {v}
            </PresetChip>
          ))}
        />
      )}
      <FieldError text={firstError ? m.errors[firstError] : undefined} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={label12}>{m.interval}</div>
        <Segmented
          options={ALERT_TIMEFRAMES.map((tf) => ({ key: tf, label: m.timeframes[tf] }))}
          value={f.timeframe}
          onChange={(timeframe) => set({ timeframe })}
          style={{ display: 'grid', gridTemplateColumns: `repeat(${ALERT_TIMEFRAMES.length}, 1fr)` }}
          itemStyle={{ height: 28, padding: 0 }}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={label12}>{m.trigger}</div>
        <Segmented<'close' | 'live'>
          options={[
            { key: 'close', label: m.onClose },
            { key: 'live', label: m.onLive },
          ]}
          value={f.on}
          onChange={(on) => set({ on })}
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}
          itemStyle={{ height: 28, padding: 0 }}
        />
        <div style={hint11}>{f.on === 'close' ? m.onCloseHint : m.onLiveHint}</div>
      </div>
      <IndicatorPreview form={form} quote={quote} info={info} m={m} />
    </>
  );
}

/**
 * The values the alert would test now, from the chart's bars of the interval (the same request main
 * loads, so the same bars) with the live price on the forming bar, as main extends them.
 */
function IndicatorPreview({ form, quote, info, m }: { form: AlertFormState; quote: Quote | undefined; info: ContractInfo | null | undefined; m: AlertMessages }) {
  const contract = form.contract;
  const tf = form.indicator.timeframe;
  const key = barsKey(contract, tf);
  const entry = useBarsStore((s) => s.entries[key]);
  const connected = useMarketDataAvailable();
  const now = useNow(5_000);
  const rule = useRule(form);
  useEffect(() => {
    if (connected) void loadBars(contract, tf, false, PREVIEW_SLOT);
    // The key identifies the instrument and interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected]);
  const text = useMemo(() => {
    if (!rule || rule.type !== 'indicator') return '';
    if (!entry || (entry.status === 'loading' && !entry.bars.length)) return connected ? m.loadingBars : m.noBarsOffline;
    if (entry.status === 'error') return m.barsError(entry.error ?? '');
    const us = usesUsEquitySession(contract);
    const session = us ? usEquitySession(now, info?.liquidHours) : 'regular';
    const live = quote?.marketDataType == null || quote.marketDataType === 1;
    const bars = mergeLivePrice(entry.bars, quote?.last, tf, now, session, { live, sessionOpen: us ? sessionOpenSec(now) : undefined });
    const last = bars.at(-1);
    // As main's feed (alertBars.ts): a US stock's weekly bar is open until its week's last regular close.
    const forming = !!last && alertBarForming(last, tf, now, session, tf === '1W' && us && usWeekClosed(now, info?.liquidHours));
    const n = Math.max(3 * barsNeeded(rule), 250);
    const reading = readIndicator(rule, bars.length > n ? bars.slice(-n) : bars, forming);
    return reading ? previewText(reading, rule.signal, rule.on, m) : m.tooFewBars;
  }, [rule, entry, connected, contract, now, info?.liquidHours, quote?.marketDataType, quote?.last, tf, m]);
  if (!text) return null;
  return <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--mu)' }}>{text}</div>;
}
