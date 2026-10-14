// Alerts in the renderer (pure): the New / Edit alert dialog's kinds and form (built into a
// PriceAlert, with the checks main runs again: storeSchema.ts → sanitizeRule, shared/alerts.ts),
// the bell list's rule summaries and statuses, and the dialog's live hints.

import {
  ALERT_FIT_MESSAGES,
  ALERT_LIMIT_MESSAGES,
  ALERT_SESSIONS,
  alertLimitProblem,
  clipNote,
  dataAllows,
  DEFAULT_ALERT_SESSIONS,
  INVALID_ALERT_MESSAGE,
  MAX_INDICATOR_PERIOD,
  NOTE_MAX,
  noteLength,
  priceLevel,
  ruleFitProblem,
  UNSUPPORTED_EDIT_MESSAGE,
  usesAlertSessions,
  type AlertFitProblem,
  type AlertLimitProblem,
} from '@shared/alerts';
import { contractKey, contractLabel } from '@shared/contract';
import { f2, parseNum, parseQuantity, pct } from '@shared/format';
import { signalOperands, type IndicatorReading } from '@shared/indicatorSignal';
import type { MarketSession } from '@shared/session';
import { liveChangeRef } from '@shared/sessionQuote';
import type { Clock } from '@shared/timeFormat';
import type {
  AlertCross,
  AlertFrequency,
  AlertRule,
  AlertRuleType,
  AlertSession,
  AlertStatus,
  AlertTimeframe,
  ContractRef,
  IndicatorSignal,
  Lang,
  PriceAlert,
  Quote,
} from '@shared/types';
import type { AlertMessages } from './messages';

// ---------------------------------------------------------------------------
// Kinds: what the dialog's "Alert type" menu offers

/**
 * An entry of the alert type menu. Most are a rule type; the 3 / 5-minute rules are one entry per
 * window, each indicator is an entry (its signal is picked below), and turnover ratio is listed but
 * never available (IB gives no shares outstanding).
 */
export type AlertKind =
  | 'priceAbove'
  | 'dayRise'
  | 'windowRise3'
  | 'windowRise5'
  | 'priceBelow'
  | 'dayFall'
  | 'windowFall3'
  | 'windowFall5'
  | 'volumeAbove'
  | 'turnoverAbove'
  | 'turnoverRatio'
  | 'bidAbove'
  | 'askBelow'
  | 'bidSizeAbove'
  | 'askSizeAbove'
  | IndicatorName
  | 'halt';

export type AlertGroup = 'up' | 'down' | 'market' | 'indicators' | 'events';
export type IndicatorName = IndicatorSignal['ind'];

export const INDICATORS: readonly IndicatorName[] = ['ma', 'ema', 'kdj', 'rsi', 'macd', 'boll'];

/** The menu, in order (moomoo's groups; halts are Tape's own event). */
export const ALERT_KIND_GROUPS: ReadonlyArray<{ group: AlertGroup; kinds: readonly AlertKind[] }> = [
  { group: 'up', kinds: ['priceAbove', 'dayRise', 'windowRise3', 'windowRise5'] },
  { group: 'down', kinds: ['priceBelow', 'dayFall', 'windowFall3', 'windowFall5'] },
  { group: 'market', kinds: ['volumeAbove', 'turnoverAbove', 'turnoverRatio', 'bidAbove', 'askBelow', 'bidSizeAbove', 'askSizeAbove'] },
  { group: 'indicators', kinds: INDICATORS },
  { group: 'events', kinds: ['halt'] },
];

const isIndicator = (k: AlertKind): k is IndicatorName => (INDICATORS as readonly string[]).includes(k);

/** The input a kind's value block shows. */
export type ValueBlock = 'price' | 'percent' | 'quantity' | 'size' | 'indicator' | 'halt' | 'none';

export function valueBlock(kind: AlertKind): ValueBlock {
  switch (kind) {
    case 'priceAbove':
    case 'priceBelow':
    case 'bidAbove':
    case 'askBelow':
      return 'price';
    case 'dayRise':
    case 'dayFall':
    case 'windowRise3':
    case 'windowRise5':
    case 'windowFall3':
    case 'windowFall5':
      return 'percent';
    case 'volumeAbove':
    case 'turnoverAbove':
      return 'quantity';
    case 'bidSizeAbove':
    case 'askSizeAbove':
      return 'size';
    case 'halt':
      return 'halt';
    case 'turnoverRatio':
      return 'none';
    default:
      return 'indicator';
  }
}

/** The rule type a kind creates (null: turnover ratio, which none does). */
export function ruleTypeOf(kind: AlertKind): AlertRuleType | null {
  if (kind === 'turnoverRatio') return null;
  if (isIndicator(kind)) return 'indicator';
  if (kind === 'windowRise3' || kind === 'windowRise5') return 'windowRise';
  if (kind === 'windowFall3' || kind === 'windowFall5') return 'windowFall';
  return kind;
}

/**
 * The dialog's note on the quote's market data type, as main evaluates it (shared/alerts.ts →
 * dataAllows): delayed data a price or day-change rule fires on (marked) or a live-only rule waits
 * on, and frozen data (2, delayed frozen 4) nothing fires on. Null on live data or no type yet.
 */
export function dataNote(type: AlertRuleType, marketDataType: Quote['marketDataType']): 'firesDelayed' | 'needsLiveDelayed' | 'frozenData' | null {
  if (marketDataType === undefined || marketDataType === 1) return null;
  const { evaluate, delayed } = dataAllows({ type } as AlertRule, marketDataType);
  if (delayed) return evaluate ? 'firesDelayed' : 'needsLiveDelayed';
  return 'frozenData';
}

/** The menu entry of a stored rule. */
export function kindOfRule(rule: AlertRule): AlertKind {
  switch (rule.type) {
    case 'windowRise':
      return rule.minutes === 3 ? 'windowRise3' : 'windowRise5';
    case 'windowFall':
      return rule.minutes === 3 ? 'windowFall3' : 'windowFall5';
    case 'indicator':
      return rule.signal.ind;
    default:
      return rule.type;
  }
}

/**
 * Why a kind cannot be picked for an instrument: the rule does not fit it (shared/alerts.ts →
 * ruleFitProblem, which main enforces), or there are no shares outstanding to divide by (turnover
 * ratio).
 */
export type KindProblem = AlertFitProblem | 'noShares';

export function kindProblem(kind: AlertKind, contract: Pick<ContractRef, 'secType'>): KindProblem | null {
  if (kind === 'turnoverRatio') return 'noShares';
  const type = ruleTypeOf(kind);
  return type ? ruleFitProblem(type, contract) : null;
}

// ---------------------------------------------------------------------------
// Indicators: the signals of each, their parameters and defaults

/** The signals the dialog offers per indicator (IndicatorSignal kind × cross, band for BOLL). */
export type SignalChoice =
  | 'priceUp'
  | 'priceDown'
  | 'goldenCross'
  | 'deadCross'
  | 'zeroUp'
  | 'zeroDown'
  | 'levelUp'
  | 'levelDown'
  | 'upperUp'
  | 'upperDown'
  | 'middleUp'
  | 'middleDown'
  | 'lowerUp'
  | 'lowerDown';

export const SIGNAL_CHOICES: Record<IndicatorName, readonly SignalChoice[]> = {
  ma: ['priceUp', 'priceDown', 'goldenCross', 'deadCross'],
  ema: ['priceUp', 'priceDown', 'goldenCross', 'deadCross'],
  macd: ['goldenCross', 'deadCross', 'zeroUp', 'zeroDown'],
  kdj: ['goldenCross', 'deadCross', 'levelUp', 'levelDown'],
  rsi: ['levelUp', 'levelDown', 'goldenCross', 'deadCross'],
  boll: ['upperUp', 'lowerDown', 'middleUp', 'middleDown', 'upperDown', 'lowerUp'],
};

export type ParamKey = 'period' | 'fast' | 'slow' | 'signal' | 'n' | 'm1' | 'm2' | 'level' | 'k';
export type IndicatorParams = Record<ParamKey, string>;

/** The indicator part of the form; parameters as typed. */
export interface IndicatorForm {
  ind: IndicatorName;
  signal: SignalChoice;
  params: IndicatorParams;
  /** KDJ level signals: the line that crosses the level. */
  line: 'k' | 'd' | 'j';
  timeframe: AlertTimeframe;
  on: 'close' | 'live';
}

/** Futu's defaults (MA 5 / 10 / 20, EMA 12 / 26, MACD 12 / 26 / 9, KDJ 9 / 3 / 3, RSI 6 / 12, BOLL 20 / 2). */
const PARAM_DEFAULTS: Record<IndicatorName, Partial<IndicatorParams>> = {
  ma: { period: '20', fast: '5', slow: '10' },
  ema: { period: '12', fast: '12', slow: '26' },
  macd: { fast: '12', slow: '26', signal: '9' },
  kdj: { n: '9', m1: '3', m2: '3', level: '80' },
  rsi: { period: '6', fast: '6', slow: '12', level: '70' },
  boll: { period: '20', k: '2' },
};

/** Level presets offered as chips: the first is the default (RSI 70 / 30, KDJ 80 / 20). */
export const LEVEL_PRESETS: Record<'rsi' | 'kdj', Record<AlertCross, readonly number[]>> = {
  rsi: { up: [70, 80], down: [30, 20] },
  kdj: { up: [80, 90], down: [20, 10] },
};

const EMPTY_PARAMS: IndicatorParams = { period: '', fast: '', slow: '', signal: '', n: '', m1: '', m2: '', level: '', k: '' };

/** The parameter inputs a signal shows, in order. */
export function signalParams(ind: IndicatorName, signal: SignalChoice): ParamKey[] {
  switch (ind) {
    case 'ma':
    case 'ema':
      return signal === 'priceUp' || signal === 'priceDown' ? ['period'] : ['fast', 'slow'];
    case 'macd':
      return ['fast', 'slow', 'signal'];
    case 'kdj':
      return signal === 'levelUp' || signal === 'levelDown' ? ['n', 'm1', 'm2', 'level'] : ['n', 'm1', 'm2'];
    case 'rsi':
      return signal === 'levelUp' || signal === 'levelDown' ? ['period', 'level'] : ['fast', 'slow'];
    case 'boll':
      return ['period', 'k'];
  }
}

const crossOf = (signal: SignalChoice): AlertCross => (/Up$|^golden/.test(signal) ? 'up' : 'down');

/**
 * The trigger a signal starts with: the price against a line or band in real time (moomoo's
 * price alerts behave so), a cross of two lines or a level on the bar's close (a forming bar's
 * lines move back and forth).
 */
export function defaultTrigger(ind: IndicatorName, signal: SignalChoice): 'close' | 'live' {
  return ind === 'boll' || ((ind === 'ma' || ind === 'ema') && (signal === 'priceUp' || signal === 'priceDown')) ? 'live' : 'close';
}

/** A fresh indicator form for `ind` (on `timeframe`), with its first signal and Futu's defaults. */
export function indicatorForm(ind: IndicatorName, timeframe: AlertTimeframe = '1D'): IndicatorForm {
  const signal = SIGNAL_CHOICES[ind][0];
  return { ind, signal, params: { ...EMPTY_PARAMS, ...PARAM_DEFAULTS[ind] }, line: 'k', timeframe, on: defaultTrigger(ind, signal) };
}

/**
 * Another signal of the same indicator: the parameters stay, the trigger becomes the signal's
 * default, and a level still at the other direction's preset follows the direction (70 → 30).
 */
export function withSignal(f: IndicatorForm, signal: SignalChoice): IndicatorForm {
  const next: IndicatorForm = { ...f, signal, on: defaultTrigger(f.ind, signal) };
  if (f.ind === 'rsi' || f.ind === 'kdj') {
    const presets = LEVEL_PRESETS[f.ind];
    const to = crossOf(signal);
    const from: AlertCross = to === 'up' ? 'down' : 'up';
    const i = presets[from].findIndex((v) => String(v) === f.params.level.trim());
    if (i >= 0) next.params = { ...f.params, level: String(presets[to][i]) };
  }
  return next;
}

/** The stored signal as the form edits it. */
function indicatorFormOf(rule: Extract<AlertRule, { type: 'indicator' }>): IndicatorForm {
  const s = rule.signal;
  const base = indicatorForm(s.ind, rule.timeframe);
  const up = s.cross === 'up';
  const p: IndicatorParams = { ...base.params };
  let signal: SignalChoice;
  let line: IndicatorForm['line'] = 'k';
  switch (s.ind) {
    case 'ma':
    case 'ema':
      if (s.kind === 'price') {
        signal = up ? 'priceUp' : 'priceDown';
        p.period = String(s.period);
      } else {
        signal = up ? 'goldenCross' : 'deadCross';
        p.fast = String(s.fast);
        p.slow = String(s.slow);
      }
      break;
    case 'macd':
      signal = s.kind === 'zero' ? (up ? 'zeroUp' : 'zeroDown') : up ? 'goldenCross' : 'deadCross';
      p.fast = String(s.fast);
      p.slow = String(s.slow);
      p.signal = String(s.signal);
      break;
    case 'kdj':
      p.n = String(s.n);
      p.m1 = String(s.m1);
      p.m2 = String(s.m2);
      if (s.kind === 'level') {
        signal = up ? 'levelUp' : 'levelDown';
        p.level = String(s.level);
        line = s.line;
      } else signal = up ? 'goldenCross' : 'deadCross';
      break;
    case 'rsi':
      if (s.kind === 'level') {
        signal = up ? 'levelUp' : 'levelDown';
        p.period = String(s.period);
        p.level = String(s.level);
      } else {
        signal = up ? 'goldenCross' : 'deadCross';
        p.fast = String(s.fast);
        p.slow = String(s.slow);
      }
      break;
    case 'boll':
      signal = `${s.band}${up ? 'Up' : 'Down'}` as SignalChoice;
      p.period = String(s.period);
      p.k = String(s.k);
      break;
  }
  return { ind: s.ind, signal, params: p, line, timeframe: rule.timeframe, on: rule.on };
}

// ---------------------------------------------------------------------------
// The form

/** The New / Edit alert dialog's state (store.ts → alertForm). Inputs are kept as typed. */
export interface AlertFormState {
  /** Editing this alert; undefined for a new one. */
  editId?: string;
  contract: ContractRef;
  kind: AlertKind;
  /** The value input: a price, a percent, or a quantity ("10M", "1000万"). */
  value: string;
  haltDir: 'halted' | 'resumed';
  indicator: IndicatorForm;
  frequency: AlertFrequency;
  sessions: AlertSession[];
  note: string;
  /** Editing an alert that is off: turn it on once saved (an edit alone keeps it off). */
  turnOn?: boolean;
}

/** Preset distances from the reference price, in percent (design: −5% −2% +2% +5%). */
export const PRICE_PRESETS = [-5, -2, 2, 5] as const;
/** Preset percents of the change rules. */
export const PERCENT_PRESETS = [1, 2, 3, 5, 10] as const;
/** Preset sizes of the bid / ask size rules. */
export const SIZE_PRESETS = [1_000, 5_000, 10_000] as const;
/** Preset multiples of the average daily volume (stocks, when IB reports it). */
export const VOLUME_PRESETS = [0.5, 1, 2] as const;

/** Trigger price for a preset, as the input string (more decimals below $1). */
export function presetPrice(ref: number, pct: number): string {
  const v = ref * (1 + pct / 100);
  return v.toFixed(v < 1 ? 4 : 2);
}

/** A quantity as an input string: exact, in the units of the language where it is round ("10M", "1000万"). */
export function quantityInput(n: number, lang: Lang): string {
  if (!Number.isFinite(n)) return '';
  const units: Array<[number, string]> = lang === 'zh' ? [[1e8, '亿'], [1e4, '万']] : [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, unit] of units) {
    const v = n / size;
    // Up to two decimals of the unit, when that is exact ("1.5B", "12.25万").
    if (Math.abs(n) >= size && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6) return `${Number(v.toFixed(2))}${unit}`;
  }
  return String(n);
}

/** A quantity rounded to three significant digits (a preset taken from the average volume). */
export function niceQuantity(n: number): number {
  if (!(n > 0)) return n;
  const step = 10 ** (Math.floor(Math.log10(n)) - 2);
  return Math.round(n / step) * step;
}

/** The price a price kind is set against: last for price rules, the bid or ask for theirs. */
export function referencePrice(kind: AlertKind, q: Quote | undefined): number | undefined {
  if (!q) return undefined;
  const ok = (n: number | undefined) => (n != null && Number.isFinite(n) && n > 0 ? n : undefined);
  if (kind === 'bidAbove') return ok(q.bid);
  if (kind === 'askBelow') return ok(q.ask);
  return ok(q.last) ?? (ok(q.bid) && ok(q.ask) ? (q.bid! + q.ask!) / 2 : undefined) ?? ok(q.mark) ?? ok(q.close);
}

/** The value a kind starts with when picked (empty: the user types it). */
function defaultValue(kind: AlertKind, q: Quote | undefined, lang: Lang): string {
  switch (valueBlock(kind)) {
    case 'price': {
      const ref = referencePrice(kind, q);
      return ref ? presetPrice(ref, kind === 'priceBelow' || kind === 'askBelow' ? -2 : 2) : '';
    }
    case 'percent':
      return kind === 'dayRise' || kind === 'dayFall' ? '3' : '1';
    case 'quantity':
      return kind === 'volumeAbove' && q?.avgVolume && q.avgVolume > 0 ? quantityInput(niceQuantity(q.avgVolume), lang) : '';
    case 'size':
      return quantityInput(SIZE_PRESETS[1], lang);
    default:
      return '';
  }
}

/** A new alert's form: rises above +2% of the last price, once, in the default sessions. */
export function newAlertForm(contract: ContractRef, q: Quote | undefined, lang: Lang): AlertFormState {
  return {
    contract,
    kind: 'priceAbove',
    value: defaultValue('priceAbove', q, lang),
    haltDir: 'halted',
    indicator: indicatorForm('macd'),
    frequency: 'once',
    sessions: [...DEFAULT_ALERT_SESSIONS],
    note: '',
  };
}

/**
 * Picks another kind. The value stays when the input is the same kind of number (a price typed for
 * "Rises above" still fits "Falls below"); otherwise the new kind's default. Another indicator
 * starts from its defaults on the same interval.
 */
export function withKind(f: AlertFormState, kind: AlertKind, q: Quote | undefined, lang: Lang): AlertFormState {
  if (kind === f.kind) return f;
  const next: AlertFormState = { ...f, kind };
  // Volume and turnover share the input but not the unit (shares, money).
  if (valueBlock(kind) !== valueBlock(f.kind) || valueBlock(kind) === 'quantity') next.value = defaultValue(kind, q, lang);
  if (isIndicator(kind)) next.indicator = indicatorForm(kind, f.indicator.timeframe);
  return next;
}

/** The form editing a stored alert (an unsupported one is not edited). */
export function formFromAlert(a: PriceAlert, lang: Lang): AlertFormState {
  const r = a.rule;
  const f: AlertFormState = {
    editId: a.id,
    contract: a.contract,
    kind: kindOfRule(r),
    value: '',
    haltDir: 'halted',
    indicator: indicatorForm('macd'),
    frequency: a.frequency,
    sessions: a.sessions?.length ? [...a.sessions] : [...DEFAULT_ALERT_SESSIONS],
    note: a.note ?? '',
  };
  switch (r.type) {
    case 'priceAbove':
    case 'priceBelow':
    case 'bidAbove':
    case 'askBelow':
      f.value = String(r.value);
      break;
    case 'dayRise':
    case 'dayFall':
    case 'windowRise':
    case 'windowFall':
      f.value = String(r.pct);
      break;
    case 'volumeAbove':
    case 'bidSizeAbove':
    case 'askSizeAbove':
      f.value = quantityInput(r.shares, lang);
      break;
    case 'turnoverAbove':
      f.value = quantityInput(r.amount, lang);
      break;
    case 'halt':
      f.haltDir = r.dir;
      break;
    case 'indicator':
      f.indicator = indicatorFormOf(r);
      break;
  }
  // An edit keeps the alert off: a spent one is offered to be turned on again, a paused one not.
  if (!a.active) f.turnOn = isSpent(a);
  return f;
}

/** A copy of an alert as a new one (the context menu's Duplicate). */
export function duplicateForm(a: PriceAlert, lang: Lang): AlertFormState {
  const { editId: _id, turnOn: _on, ...rest } = formFromAlert(a, lang);
  return rest;
}

/** Remarks as typed, cut at NOTE_MAX code points (further typing is blocked). */
export function limitNote(s: string): string {
  return noteLength(s) > NOTE_MAX ? [...s].slice(0, NOTE_MAX).join('') : s;
}

/**
 * Remarks from a change of the field: cut by limitNote, except while an IME composition is open. Its
 * pinyin letters are not the text yet, and cutting them rewrites the field mid-composition, which
 * breaks it (Latin letters land in the note); the cut comes when the composition ends.
 */
export function typedNote(s: string, composing: boolean): string {
  return composing ? s : limitNote(s);
}

/**
 * What a key does in the alert dialog: Esc cancels, ⏎ saves (not held down, with a modifier, or on
 * an element that takes ⏎ itself). Neither while an IME composition is open: Esc then drops the
 * unconfirmed pinyin and ⏎ confirms it, and the dialog with everything typed must stay.
 */
export function dialogKey(e: Pick<KeyboardEvent, 'key' | 'isComposing' | 'repeat' | 'metaKey' | 'ctrlKey' | 'altKey'>, takesEnter: boolean): 'cancel' | 'save' | null {
  if (e.isComposing) return null;
  if (e.key === 'Escape') return 'cancel';
  if (e.key !== 'Enter' || e.repeat || e.metaKey || e.ctrlKey || e.altKey || takesEnter) return null;
  return 'save';
}

/** What is wrong with a field (messages.ts → errors). */
export type AlertFormError = 'price' | 'percent' | 'quantity' | 'period' | 'bollPeriod' | 'fastSlow' | 'level' | 'levelJ' | 'k' | 'sessions';
/** The field an error is shown under: the value input, an indicator parameter or the sessions. */
export type AlertFormField = 'value' | ParamKey | 'sessions';
export type AlertFormErrors = Partial<Record<AlertFormField, AlertFormError>>;

const isPeriod = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_INDICATOR_PERIOD;

/** The indicator signal of the form, or its errors (storeSchema.ts → sanitizeSignal's rules). */
function buildSignal(f: IndicatorForm): { signal: IndicatorSignal } | { errors: AlertFormErrors } {
  const errors: AlertFormErrors = {};
  const num = (k: ParamKey) => parseNum(f.params[k]);
  const period = (k: ParamKey, min = 1) => {
    const v = num(k);
    if (!isPeriod(v) || v < min) errors[k] = min > 1 ? 'bollPeriod' : 'period';
    return v;
  };
  const lines = () => {
    const fast = period('fast');
    const slow = period('slow');
    if (!errors.fast && !errors.slow && fast >= slow) errors.fast = 'fastSlow';
    return { fast, slow };
  };
  const level = (lo: number, hi: number, code: AlertFormError) => {
    const v = num('level');
    if (!Number.isFinite(v) || v < lo || v > hi) errors.level = code;
    return v;
  };
  const cross = crossOf(f.signal);
  const s = f.signal;
  let signal: IndicatorSignal;
  switch (f.ind) {
    case 'ma':
    case 'ema':
      signal = s === 'priceUp' || s === 'priceDown' ? { ind: f.ind, kind: 'price', period: period('period'), cross } : { ind: f.ind, kind: 'lines', ...lines(), cross };
      break;
    case 'macd':
      signal = { ind: 'macd', kind: s === 'zeroUp' || s === 'zeroDown' ? 'zero' : 'signal', ...lines(), signal: period('signal'), cross };
      break;
    case 'kdj': {
      const p = { n: period('n'), m1: period('m1'), m2: period('m2') };
      signal =
        s === 'levelUp' || s === 'levelDown'
          ? { ind: 'kdj', kind: 'level', ...p, line: f.line, level: f.line === 'j' ? level(-50, 150, 'levelJ') : level(0, 100, 'level'), cross }
          : { ind: 'kdj', kind: 'cross', ...p, cross };
      break;
    }
    case 'rsi':
      signal = s === 'levelUp' || s === 'levelDown' ? { ind: 'rsi', kind: 'level', period: period('period'), level: level(0, 100, 'level'), cross } : { ind: 'rsi', kind: 'lines', ...lines(), cross };
      break;
    case 'boll': {
      const k = num('k');
      if (!Number.isFinite(k) || k <= 0 || k > 5) errors.k = 'k';
      const band = s.replace(/Up$|Down$/, '') as 'upper' | 'middle' | 'lower';
      signal = { ind: 'boll', kind: 'band', period: period('period', 2), k, band, cross };
      break;
    }
  }
  return Object.keys(errors).length ? { errors } : { signal };
}

/**
 * The rule of the form, or what is wrong with it. Values follow main's checks (prices, amounts and
 * sizes above 0, percents in (0, 1000], whole periods 1–250 with fast < slow, levels 0–100 or
 * −50–150 for KDJ's J, a band width in (0, 5]), so main refuses nothing the dialog lets through.
 */
export function buildRule(f: AlertFormState): { rule: AlertRule } | { errors: AlertFormErrors } {
  const fail = (e: AlertFormError) => ({ errors: { value: e } as AlertFormErrors });
  switch (valueBlock(f.kind)) {
    case 'price': {
      const v = parseNum(f.value);
      if (!(Number.isFinite(v) && v > 0)) return fail('price');
      return { rule: { type: f.kind as 'priceAbove' | 'priceBelow' | 'bidAbove' | 'askBelow', value: v } };
    }
    case 'percent': {
      const v = parseNum(f.value.replace(/%$/, ''));
      if (!(Number.isFinite(v) && v > 0 && v <= 1000)) return fail('percent');
      if (f.kind === 'dayRise' || f.kind === 'dayFall') return { rule: { type: f.kind, pct: v } };
      const minutes = f.kind === 'windowRise3' || f.kind === 'windowFall3' ? 3 : 5;
      return { rule: { type: f.kind.startsWith('windowRise') ? 'windowRise' : 'windowFall', minutes, pct: v } };
    }
    case 'quantity':
    case 'size': {
      const v = parseQuantity(f.value);
      if (!(Number.isFinite(v) && v > 0)) return fail('quantity');
      if (f.kind === 'turnoverAbove') return { rule: { type: 'turnoverAbove', amount: v } };
      return { rule: { type: f.kind as 'volumeAbove' | 'bidSizeAbove' | 'askSizeAbove', shares: v } };
    }
    case 'halt':
      return { rule: { type: 'halt', dir: f.haltDir } };
    case 'indicator': {
      const built = buildSignal(f.indicator);
      if ('errors' in built) return built;
      return { rule: { type: 'indicator', timeframe: f.indicator.timeframe, on: f.indicator.on, signal: built.signal } };
    }
    case 'none':
      return { errors: {} };
  }
}

/** Whether the form shows the sessions: a US stock's alert (shared/alerts.ts → usesAlertSessions). */
export function formUsesSessions(f: Pick<AlertFormState, 'contract'>): boolean {
  return usesAlertSessions(f.contract);
}

/** Form errors to show under the fields: the rule's, and no session chosen. */
export function formErrors(f: AlertFormState): AlertFormErrors {
  const built = buildRule(f);
  const errors: AlertFormErrors = 'errors' in built ? { ...built.errors } : {};
  if (formUsesSessions(f) && !f.sessions.length) errors.sessions = 'sessions';
  return errors;
}

/**
 * The alert the form describes, as upsertPriceAlert takes it. Sessions are written for US stocks
 * only and left out when they are the default; `active` is main's (it keeps an edited alert's).
 */
export function alertFromForm(f: AlertFormState, rule: AlertRule, id: string, now: number, existing?: PriceAlert): PriceAlert {
  const alert: PriceAlert = {
    id,
    contract: f.contract,
    rule,
    frequency: f.frequency,
    active: existing?.active ?? true,
    createdAt: existing?.createdAt ?? now,
  };
  if (usesAlertSessions(f.contract)) {
    const sessions = ALERT_SESSIONS.filter((s) => f.sessions.includes(s));
    const isDefault = sessions.length === DEFAULT_ALERT_SESSIONS.length && DEFAULT_ALERT_SESSIONS.every((s) => sessions.includes(s));
    if (sessions.length && !isDefault) alert.sessions = sessions;
  }
  const note = clipNote(f.note);
  if (note) alert.note = note;
  return alert;
}

/**
 * The limit a save would hit (shared/alerts.ts → alertLimitProblem, as main checks it), with the
 * form's rule, or its type alone while the form is not complete. A new alert, or an edited one
 * being turned on, counts as on.
 */
export function formLimitProblem(alerts: readonly PriceAlert[], f: AlertFormState, rule: AlertRule | null): AlertLimitProblem | null {
  const type = ruleTypeOf(f.kind);
  if (!type) return null;
  const existing = f.editId ? alerts.find((a) => a.id === f.editId) : undefined;
  const stub = (rule ?? (type === 'indicator' ? { type, timeframe: f.indicator.timeframe } : { type })) as AlertRule;
  const active = existing ? existing.active || !!f.turnOn : true;
  return alertLimitProblem(alerts, { id: f.editId ?? '', contract: f.contract, rule: stub, frequency: f.frequency, active, createdAt: 0 });
}

/** Instruments with alerts on, counting `contract` too (each holds a market data line). */
export function alertLineCount(alerts: readonly PriceAlert[], contract: ContractRef): number {
  const keys = new Set(alerts.filter((a) => a.active && !a.unsupported).map((a) => contractKey(a.contract)));
  keys.add(contractKey(contract));
  return keys.size;
}

/** A message main refused with, translated when it is one of its own (messages.ts → refusals / limits / problems). */
export function refusalText(msg: string, m: AlertMessages): string {
  if (msg === INVALID_ALERT_MESSAGE) return m.refusals.invalid;
  if (msg === UNSUPPORTED_EDIT_MESSAGE) return m.refusals.unsupportedEdit;
  for (const [k, v] of Object.entries(ALERT_LIMIT_MESSAGES)) if (msg === v) return m.limits[k as AlertLimitProblem];
  for (const [k, v] of Object.entries(ALERT_FIT_MESSAGES)) if (msg === v) return m.problems[k as AlertFitProblem];
  return msg;
}

// ---------------------------------------------------------------------------
// Live hints of the dialog

/** Digits needed to show a trigger price faithfully: 2 to 4 (as main's notifications). */
export function priceDigits(n: number): number {
  if (Math.abs(n) < 1) return 4;
  for (let d = 2; d < 4; d++) if (Math.abs(n * 10 ** d - Math.round(n * 10 ** d)) < 1e-6) return d;
  return 4;
}

export const priceText = (n: number) => f2(n, priceDigits(n));

/** A threshold as typed: at most two decimals, no trailing zeros ("5", "2.5"). */
export const plain = (n: number) => String(Number(n.toFixed(2)));

/** Distance of a level from a price, in percent. */
export function distancePct(level: number, from: number): number {
  return (level / from - 1) * 100;
}

/**
 * The change on the day of a quote's live price, against the reference main measures day-change
 * alerts with (shared/sessionQuote.ts → liveChangeRef): the previous close, after the close today's.
 */
export function dayChange(q: Quote | undefined, session: MarketSession | 'overnight'): { value: number; afterHours: boolean } | undefined {
  if (!q) return undefined;
  const price = livePrice(q);
  const ref = liveChangeRef(q, session);
  if (price == null || !ref) return undefined;
  return { value: (price / ref.ref - 1) * 100, afterHours: ref.afterHours };
}

/** The live price (last, else the midpoint, else the mark), never the previous close. */
export function livePrice(q: Quote | undefined): number | undefined {
  if (!q) return undefined;
  const ok = (n: number | undefined): n is number => n != null && Number.isFinite(n) && n > 0;
  if (ok(q.last)) return q.last;
  if (ok(q.bid) && ok(q.ask)) return (q.bid + q.ask) / 2;
  return ok(q.mark) ? q.mark : undefined;
}

/** Whether a rule holds for `current` already, so a new alert fires at once. */
export function alreadyMet(rule: AlertRule, current: number | undefined): boolean {
  if (current == null || !Number.isFinite(current)) return false;
  switch (rule.type) {
    case 'priceAbove':
    case 'bidAbove':
      return current >= rule.value;
    case 'priceBelow':
    case 'askBelow':
      return current > 0 && current <= rule.value;
    case 'dayRise':
      return current >= rule.pct;
    case 'dayFall':
      return current <= -rule.pct;
    case 'volumeAbove':
    case 'bidSizeAbove':
    case 'askSizeAbove':
      return current >= rule.shares;
    case 'turnoverAbove':
      return current >= rule.amount;
    default:
      return false;
  }
}

/** Approximate turnover (volume × the day's VWAP), as main measures it. */
export function turnoverOf(q: Quote | undefined): number | undefined {
  return q?.volume && q.volume > 0 && q.vwap && q.vwap > 0 ? q.volume * q.vwap : undefined;
}

/** "shares" or "contracts" (options and futures count contracts). */
export function countUnit(c: Pick<ContractRef, 'secType'>, m: Pick<AlertMessages, 'shares' | 'contracts'>): string {
  return c.secType === 'OPT' || c.secType === 'FOP' || c.secType === 'FUT' ? m.contracts : m.shares;
}

/**
 * The indicator preview: the two operands at the bar the alert would test now ('live': the forming
 * bar; 'close': the last closed one), e.g. "Now: DIF 1.21 below DEA 1.31".
 */
export function previewText(reading: IndicatorReading, signal: IndicatorSignal, on: 'close' | 'live', m: AlertMessages): string {
  const { a, b } = signalOperands(signal);
  const name = (s: string) => (s === 'close' ? m.close : s);
  const value = (s: string) => (reading.detail[s] === undefined ? '—' : f2(reading.detail[s]));
  const left = `${name(a)} ${value(a)}`;
  const right = typeof b === 'number' ? plain(b) : `${name(b)} ${value(b)}`;
  const rel = reading.cur > 0 ? m.above : reading.cur < 0 ? m.below : m.at;
  return (on === 'live' ? m.previewNow : m.previewLast)(left, rel, right);
}

// ---------------------------------------------------------------------------
// The bell's list: summaries and statuses

function indicatorName(s: IndicatorSignal): string {
  switch (s.ind) {
    case 'macd':
      return s.fast === 12 && s.slow === 26 && s.signal === 9 ? 'MACD' : `MACD(${s.fast},${s.slow},${s.signal})`;
    case 'kdj':
      return s.n === 9 && s.m1 === 3 && s.m2 === 3 ? 'KDJ' : `KDJ(${s.n},${s.m1},${s.m2})`;
    default:
      return s.ind.toUpperCase();
  }
}

function signalSummary(s: IndicatorSignal, m: AlertMessages): string {
  const t = m.sum;
  const up = s.cross === 'up';
  switch (s.ind) {
    case 'ma':
    case 'ema': {
      const line = (p: number) => `${s.ind.toUpperCase()}${p}`;
      if (s.kind === 'price') return up ? t.priceUp(line(s.period)) : t.priceDown(line(s.period));
      return up ? t.linesUp(line(s.fast), line(s.slow)) : t.linesDown(line(s.fast), line(s.slow));
    }
    case 'macd':
      if (s.kind === 'zero') return up ? t.zeroUp : t.zeroDown;
      return up ? t.golden(indicatorName(s)) : t.dead(indicatorName(s));
    case 'kdj':
      if (s.kind === 'cross') return up ? t.golden(indicatorName(s)) : t.dead(indicatorName(s));
      return (up ? t.levelUp : t.levelDown)(`${indicatorName(s)} ${s.line.toUpperCase()}`, plain(s.level));
    case 'rsi':
      if (s.kind === 'level') return (up ? t.levelUp : t.levelDown)(`RSI${s.period}`, plain(s.level));
      return up ? t.linesUp(`RSI${s.fast}`, `RSI${s.slow}`) : t.linesDown(`RSI${s.fast}`, `RSI${s.slow}`);
    case 'boll': {
      const text = t.boll[`${s.band}${up ? 'Up' : 'Down'}` as keyof typeof t.boll];
      return s.period === 20 && s.k === 2 ? text : `${text} (${s.period}, ${plain(s.k)})`;
    }
  }
}

/**
 * What an alert watches, in one line: "Price ≥ 125.00", "5-min rise ≥ 2%", "Volume ≥ 1.25M" (the
 * threshold exactly, never rounded), "MACD golden cross · 15m", "Trading halted". A rule of a newer
 * Tape says it is not supported.
 */
export function ruleSummary(a: Pick<PriceAlert, 'rule' | 'contract' | 'unsupported'>, m: AlertMessages): string {
  const t = m.sum;
  const r = a.rule;
  if (a.unsupported) return t.unsupported(String((r as { type?: unknown }).type ?? '?'));
  switch (r.type) {
    case 'priceAbove':
      return `${t.price} ≥ ${priceText(r.value)}`;
    case 'priceBelow':
      return `${t.price} ≤ ${priceText(r.value)}`;
    case 'bidAbove':
      return `${t.bid} ≥ ${priceText(r.value)}`;
    case 'askBelow':
      return `${t.ask} ≤ ${priceText(r.value)}`;
    case 'dayRise':
      return `${t.dayRise} ≥ ${plain(r.pct)}%`;
    case 'dayFall':
      return `${t.dayFall} ≥ ${plain(r.pct)}%`;
    case 'windowRise':
      return `${t.windowRise(r.minutes)} ≥ ${plain(r.pct)}%`;
    case 'windowFall':
      return `${t.windowFall(r.minutes)} ≥ ${plain(r.pct)}%`;
    case 'volumeAbove':
      return `${t.volume} ≥ ${m.qtyExact(r.shares)}`;
    case 'turnoverAbove':
      return `${t.turnover} ≥ ${m.moneyExact(r.amount, a.contract.currency)}`;
    case 'bidSizeAbove':
      return `${t.bidSize} ≥ ${m.qtyExact(r.shares)}`;
    case 'askSizeAbove':
      return `${t.askSize} ≥ ${m.qtyExact(r.shares)}`;
    case 'indicator':
      return `${signalSummary(r.signal, m)} · ${t.timeframe[r.timeframe]}${r.on === 'live' ? ` · ${t.onLive}` : ''}`;
    case 'halt':
      return r.dir === 'halted' ? t.halted : t.resumed;
  }
}

/** "AAPL · Price ≥ 235.00" for toasts. */
export function alertDescription(a: Pick<PriceAlert, 'rule' | 'contract' | 'unsupported'>, m: AlertMessages): string {
  return `${contractLabel(a.contract)} · ${ruleSummary(a, m)}`;
}

/**
 * The value main measured, as the list shows it after "Now": a price, a signed percent ("+0.80%",
 * after hours so marked), a count, ≈ an amount, or an indicator's two operands. Undefined when
 * there is none.
 */
export function measuredText(a: PriceAlert, s: AlertStatus | undefined, m: AlertMessages): string | undefined {
  if (!s || a.unsupported) return undefined;
  const r = a.rule;
  if (r.type === 'indicator') {
    if (!s.detail) return undefined;
    const { a: x, b: y } = signalOperands(r.signal);
    const part = (k: string) => (s.detail?.[k] === undefined ? undefined : `${k === 'close' ? m.close : k} ${f2(s.detail[k])}`);
    return [part(x), typeof y === 'string' ? part(y) : undefined].filter(Boolean).join(' · ') || undefined;
  }
  const v = s.value;
  if (v === undefined || !Number.isFinite(v)) return undefined;
  switch (r.type) {
    case 'priceAbove':
    case 'priceBelow':
    case 'bidAbove':
    case 'askBelow':
      return priceText(v);
    case 'dayRise':
    case 'dayFall':
      return s.afterHours ? undefined : pct(v);
    case 'windowRise':
    case 'windowFall':
      return pct(v);
    case 'volumeAbove':
    case 'bidSizeAbove':
    case 'askSizeAbove':
      return m.qty(v);
    case 'turnoverAbove':
      return `≈${m.money(v, a.contract.currency)}`;
    default:
      return undefined;
  }
}

/** The list's "Now …" text, with after-hours day changes worded so. */
export function nowText(a: PriceAlert, s: AlertStatus | undefined, m: AlertMessages): string | undefined {
  if (s?.afterHours && (a.rule.type === 'dayRise' || a.rule.type === 'dayFall') && s.value !== undefined) return m.nowAfterHours(pct(s.value));
  const text = measuredText(a, s, m);
  return text === undefined ? undefined : m.now(text);
}

/**
 * The alert's last trigger when it belongs to its current setup (as main/market/alertEval.ts →
 * lastFireOfSetup): not followed by an edit of the trigger, a pause or a resume.
 */
export function lastFireOfSetup(a: Pick<PriceAlert, 'lastTriggeredAt' | 'updatedAt'>): number | undefined {
  const t = a.lastTriggeredAt;
  return t != null && t >= (a.updatedAt ?? -Infinity) ? t : undefined;
}

/** A 'once' alert that fired and turned itself off (the list's "Delete triggered"). */
export function isSpent(a: PriceAlert): boolean {
  return a.frequency === 'once' && !a.active && !a.unsupported && lastFireOfSetup(a) != null;
}

export type StatusTone = 'ok' | 'muted' | 'accent' | 'warn' | 'danger';

/** CSS color of a status tone. */
export const toneColor = (t: StatusTone): string => ({ ok: 'var(--dm)', muted: 'var(--dm)', accent: 'var(--ac)', warn: 'var(--mu)', danger: 'var(--r)' })[t];

/** "02:10" for a wait in milliseconds. */
function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The trigger time: the clock time today, with the date before another day's. */
function triggerTime(t: number, clock: Clock, now: number): string {
  const sameDay = new Date(t).toDateString() === new Date(now).toDateString();
  return sameDay ? clock.time(t) : clock.time(t, { date: 'md' });
}

/**
 * The status the list shows after an alert (null: watched, nothing to say), from main's status or,
 * before one arrived, from the alert itself (paused, triggered, unsupported).
 */
export function statusText(a: PriceAlert, s: AlertStatus | undefined, m: AlertMessages, clock: Clock, now: number): { text: string; tone: StatusTone } | null {
  const t = m.st;
  const fired = lastFireOfSetup(a);
  const state = s?.state ?? (a.unsupported ? 'unsupported' : !a.active ? (isSpent(a) ? 'triggered' : 'paused') : 'ok');
  switch (state) {
    case 'ok':
      return null;
    case 'triggered':
      return { text: t.triggered(fired != null ? triggerTime(fired, clock, now) : ''), tone: 'accent' };
    case 'paused':
      return { text: t.paused, tone: 'muted' };
    case 'unsupported':
      return { text: t.unsupported, tone: 'muted' };
    case 'offline':
      return { text: t.offline, tone: 'muted' };
    case 'noLine':
      return { text: t.noLine, tone: 'danger' };
    case 'noData':
      switch (s?.reason) {
        case 'barsError':
          return { text: t.barsError(s.message ?? ''), tone: 'danger' };
        case 'tooFewBars':
          return { text: t.tooFewBars, tone: 'danger' };
        case 'seriesLimit':
          return { text: t.seriesLimit, tone: 'danger' };
        default:
          return { text: t.lineError(s?.message ?? ''), tone: 'danger' };
      }
    case 'outOfSession':
      return { text: t.outOfSession, tone: 'muted' };
    case 'frozen':
      return { text: t.frozen, tone: 'muted' };
    case 'delayed':
      return s?.needsLive ? { text: t.delayedWaits, tone: 'danger' } : { text: t.delayed, tone: 'warn' };
    case 'waiting': {
      const r = a.rule;
      if (s?.reason === 'window' && (r.type === 'windowRise' || r.type === 'windowFall'))
        return { text: s.readyIn != null ? t.windowLeft(r.minutes, mmss(s.readyIn)) : t.window(r.minutes), tone: 'warn' };
      return { text: s?.reason === 'bars' ? t.bars : t.waiting, tone: 'warn' };
    }
  }
}

/**
 * An alert that is on but not being watched for a reason the user can act on: no market data line,
 * IB's error on the line or the bars, or delayed data a live-only rule waits on. The top bar's bell
 * shows a red mark while any is (not while Tape is offline: everything is then).
 */
export function isUnwatched(a: PriceAlert, s: AlertStatus | undefined): boolean {
  if (!a.active || a.unsupported || !s) return false;
  return s.state === 'noLine' || s.state === 'noData' || (s.state === 'delayed' && !!s.needsLive);
}

/** Alerts that are on but not watched (isUnwatched), from the statuses main sent. */
export function unwatchedCount(alerts: readonly PriceAlert[], statuses: readonly AlertStatus[]): number {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  return alerts.filter((a) => isUnwatched(a, byId.get(a.id))).length;
}

/** Alerts grouped by instrument, in the list's order (each group where its first alert is). */
export function groupByInstrument(alerts: readonly PriceAlert[]): Array<{ key: string; contract: ContractRef; alerts: PriceAlert[] }> {
  const groups = new Map<string, { key: string; contract: ContractRef; alerts: PriceAlert[] }>();
  for (const a of alerts) {
    const key = contractKey(a.contract);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, contract: a.contract, alerts: [] }));
    g.alerts.push(a);
  }
  return [...groups.values()];
}

/** Whether a row can be edited (not a newer Tape's alert). */
export const isEditable = (a: PriceAlert): boolean => !a.unsupported;

/** The condition and price of a price-level alert (price, bid or ask), else null: the chart's lines. */
export function alertLevel(alert: PriceAlert): { condition: 'above' | 'below'; price: number } | null {
  const level = alert.unsupported ? null : priceLevel(alert.rule);
  return level && { condition: level.side, price: level.value };
}
