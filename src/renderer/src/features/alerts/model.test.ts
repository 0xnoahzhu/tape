import { describe, expect, it } from 'vitest';
import { ALERT_FIT_MESSAGES, ALERT_LIMIT_MESSAGES, INVALID_ALERT_MESSAGE, MAX_ALERTS_PER_TYPE, MAX_INDICATOR_SERIES } from '@shared/alerts';
import { option, stock } from '@shared/contract';
import { createClock } from '@shared/timeFormat';
import type { AlertRule, AlertStatus, ContractRef, PriceAlert, Quote } from '@shared/types';
import { useAlertMessages } from './messages';
import {
  ALERT_KIND_GROUPS,
  alertFromForm,
  alertLevel,
  alertLineCount,
  alreadyMet,
  buildRule,
  dataNote,
  dayChange,
  dialogKey,
  duplicateForm,
  formErrors,
  formFromAlert,
  formLimitProblem,
  groupByInstrument,
  indicatorForm,
  isEditable,
  isSpent,
  isUnwatched,
  kindOfRule,
  kindProblem,
  limitNote,
  newAlertForm,
  niceQuantity,
  nowText,
  presetPrice,
  previewText,
  quantityInput,
  refusalText,
  ruleSummary,
  ruleTypeOf,
  statusText,
  typedNote,
  unwatchedCount,
  valueBlock,
  withKind,
  withSignal,
  type AlertFormState,
  type AlertKind,
} from './model';

const en = useAlertMessages.for('en');
const zh = useAlertMessages.for('zh');
const AAPL = stock('AAPL');
const EURUSD: ContractRef = { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' };
const SPX: ContractRef = { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' };
const quote = (over: Partial<Quote> = {}): Quote => ({ contract: AAPL, ...over }) as Quote;

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: 'a1',
  contract: AAPL,
  rule: { type: 'priceAbove', value: 235 },
  frequency: 'once',
  active: true,
  createdAt: 1,
  ...over,
});

const form = (over: Partial<AlertFormState> = {}): AlertFormState => ({ ...newAlertForm(AAPL, undefined, 'en'), ...over });

/** The rule a form builds, or a failure. */
const rule = (f: AlertFormState): AlertRule => {
  const built = buildRule(f);
  if (!('rule' in built)) throw new Error(JSON.stringify(built.errors));
  return built.rule;
};
const errors = (f: AlertFormState) => ('errors' in buildRule(f) ? (buildRule(f) as { errors: object }).errors : {});

describe('alert kinds', () => {
  it('lists every kind once, in moomoo’s groups', () => {
    const kinds = ALERT_KIND_GROUPS.flatMap((g) => g.kinds);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(ALERT_KIND_GROUPS.map((g) => g.group)).toEqual(['up', 'down', 'market', 'indicators', 'events']);
    expect(kinds).toContain('turnoverRatio');
  });

  it('maps kinds to rule types and back', () => {
    expect(ruleTypeOf('windowRise3')).toBe('windowRise');
    expect(ruleTypeOf('windowFall5')).toBe('windowFall');
    expect(ruleTypeOf('macd')).toBe('indicator');
    expect(ruleTypeOf('turnoverRatio')).toBeNull();
    expect(kindOfRule({ type: 'windowRise', minutes: 5, pct: 2 })).toBe('windowRise5');
    expect(kindOfRule({ type: 'windowFall', minutes: 3, pct: 2 })).toBe('windowFall3');
    expect(kindOfRule({ type: 'indicator', timeframe: '1D', on: 'close', signal: { ind: 'rsi', kind: 'level', period: 6, level: 70, cross: 'up' } })).toBe('rsi');
    expect(kindOfRule({ type: 'bidAbove', value: 1 })).toBe('bidAbove');
  });

  it('disables what does not fit the instrument, with the reason', () => {
    expect(kindProblem('volumeAbove', EURUSD)).toBe('noVolume');
    expect(kindProblem('turnoverAbove', option('AAPL', '20261016', 230, 'C'))).toBe('stocksOnly');
    expect(kindProblem('bidAbove', SPX)).toBe('noBidAsk');
    expect(kindProblem('askSizeAbove', SPX)).toBe('noSizes');
    expect(kindProblem('halt', EURUSD)).toBe('noHalts');
    expect(kindProblem('macd', { secType: 'BAG' })).toBe('noBars');
    expect(kindProblem('turnoverRatio', AAPL)).toBe('noShares');
    expect(kindProblem('priceAbove', SPX)).toBeNull();
    expect(kindProblem('turnoverAbove', AAPL)).toBeNull();
  });

  it('has a label, a hint and a group name in both languages', () => {
    for (const k of ALERT_KIND_GROUPS.flatMap((g) => g.kinds)) {
      expect(en.kinds[k]).toBeTruthy();
      expect(zh.kinds[k]).toBeTruthy();
      expect(en.hints[k]).toBeTruthy();
      expect(zh.hints[k]).toBeTruthy();
    }
    expect(zh.kinds.dayRise).toBe('日内涨幅超过');
    expect(zh.problems.noShares).toBe('IB 不提供流通股本数据');
  });
});

describe('the alert form', () => {
  it('starts as rises above +2% of the last price, once, in the default sessions', () => {
    expect(newAlertForm(AAPL, quote({ last: 227.48 }), 'en')).toMatchObject({ kind: 'priceAbove', value: '232.03', frequency: 'once', sessions: ['pre', 'regular', 'post'], note: '' });
    expect(newAlertForm(AAPL, undefined, 'en').value).toBe('');
    // Without a trade the previous close stands in.
    expect(newAlertForm(AAPL, quote({ close: 100 }), 'en').value).toBe('102.00');
  });

  it('keeps a typed price across price kinds and starts other kinds with their default', () => {
    const f = form({ value: '250' });
    expect(withKind(f, 'priceBelow', undefined, 'en').value).toBe('250');
    expect(withKind(f, 'bidAbove', undefined, 'en').value).toBe('250');
    expect(withKind(f, 'dayRise', undefined, 'en').value).toBe('3');
    expect(withKind(f, 'windowFall5', undefined, 'en').value).toBe('1');
    expect(withKind(f, 'bidSizeAbove', undefined, 'zh').value).toBe('5000');
    expect(withKind(f, 'volumeAbove', quote({ avgVolume: 45_588_678 }), 'en').value).toBe('45.6M');
    expect(withKind(f, 'turnoverAbove', undefined, 'en').value).toBe('');
    // Bid and ask presets are set against the bid and the ask.
    expect(withKind(form({ kind: 'dayRise' }), 'askBelow', quote({ bid: 99, ask: 101 }), 'en').value).toBe('98.98');
  });

  it('starts another indicator from its defaults, on the same interval', () => {
    const f = withKind(form({ indicator: { ...indicatorForm('macd'), timeframe: '15m' } }), 'rsi', undefined, 'en');
    expect(f.indicator).toMatchObject({ ind: 'rsi', signal: 'levelUp', timeframe: '15m', on: 'close', params: { period: '6', level: '70' } });
    expect(indicatorForm('ma')).toMatchObject({ signal: 'priceUp', on: 'live', params: { period: '20', fast: '5', slow: '10' } });
    expect(indicatorForm('boll')).toMatchObject({ signal: 'upperUp', on: 'live', params: { period: '20', k: '2' } });
  });

  it('turns a level preset with the direction and picks the signal’s trigger', () => {
    const rsi = indicatorForm('rsi');
    expect(withSignal(rsi, 'levelDown').params.level).toBe('30');
    expect(withSignal({ ...rsi, params: { ...rsi.params, level: '80' } }, 'levelDown').params.level).toBe('20');
    // A level the user typed stays.
    expect(withSignal({ ...rsi, params: { ...rsi.params, level: '65' } }, 'levelDown').params.level).toBe('65');
    expect(withSignal(indicatorForm('ma'), 'goldenCross').on).toBe('close');
    expect(withSignal(indicatorForm('ma', '1h'), 'priceDown')).toMatchObject({ on: 'live', timeframe: '1h' });
  });

  it('builds price, percent, window, quantity, size and halt rules', () => {
    expect(rule(form({ value: '1,234.5' }))).toEqual({ type: 'priceAbove', value: 1234.5 });
    expect(rule(form({ kind: 'askBelow', value: '99.5' }))).toEqual({ type: 'askBelow', value: 99.5 });
    expect(rule(form({ kind: 'dayFall', value: '5%' }))).toEqual({ type: 'dayFall', pct: 5 });
    expect(rule(form({ kind: 'windowRise3', value: '2' }))).toEqual({ type: 'windowRise', minutes: 3, pct: 2 });
    expect(rule(form({ kind: 'windowFall5', value: '1.5' }))).toEqual({ type: 'windowFall', minutes: 5, pct: 1.5 });
    expect(rule(form({ kind: 'volumeAbove', value: '10M' }))).toEqual({ type: 'volumeAbove', shares: 10_000_000 });
    expect(rule(form({ kind: 'turnoverAbove', value: '2亿' }))).toEqual({ type: 'turnoverAbove', amount: 200_000_000 });
    expect(rule(form({ kind: 'bidSizeAbove', value: '5K' }))).toEqual({ type: 'bidSizeAbove', shares: 5_000 });
    expect(rule(form({ kind: 'halt', haltDir: 'resumed' }))).toEqual({ type: 'halt', dir: 'resumed' });
  });

  it('refuses what main refuses', () => {
    expect(errors(form({ value: '' }))).toEqual({ value: 'price' });
    expect(errors(form({ value: '0' }))).toEqual({ value: 'price' });
    expect(errors(form({ kind: 'dayRise', value: '1001' }))).toEqual({ value: 'percent' });
    expect(errors(form({ kind: 'dayRise', value: '-2' }))).toEqual({ value: 'percent' });
    expect(errors(form({ kind: 'volumeAbove', value: '10 shares' }))).toEqual({ value: 'quantity' });
    expect(errors(form({ kind: 'turnoverRatio' }))).toEqual({});
    expect('rule' in buildRule(form({ kind: 'turnoverRatio' }))).toBe(false);
  });

  it('builds every indicator signal', () => {
    const ind = (kind: AlertKind, patch: Partial<AlertFormState['indicator']> = {}) => {
      const f = withKind(form(), kind, undefined, 'en');
      return rule({ ...f, indicator: { ...f.indicator, ...patch } });
    };
    expect(ind('ma')).toEqual({ type: 'indicator', timeframe: '1D', on: 'live', signal: { ind: 'ma', kind: 'price', period: 20, cross: 'up' } });
    expect(ind('ema', { signal: 'deadCross' })).toMatchObject({ signal: { ind: 'ema', kind: 'lines', fast: 12, slow: 26, cross: 'down' } });
    expect(ind('macd', { signal: 'zeroDown' })).toMatchObject({ signal: { ind: 'macd', kind: 'zero', fast: 12, slow: 26, signal: 9, cross: 'down' } });
    expect(ind('kdj', { signal: 'levelUp', line: 'j' })).toMatchObject({ signal: { ind: 'kdj', kind: 'level', n: 9, m1: 3, m2: 3, line: 'j', level: 80, cross: 'up' } });
    expect(ind('kdj')).toMatchObject({ signal: { ind: 'kdj', kind: 'cross', cross: 'up' } });
    expect(ind('rsi', { signal: 'goldenCross' })).toMatchObject({ signal: { ind: 'rsi', kind: 'lines', fast: 6, slow: 12, cross: 'up' } });
    expect(ind('boll', { signal: 'lowerDown', timeframe: '5m', on: 'close' })).toEqual({
      type: 'indicator',
      timeframe: '5m',
      on: 'close',
      signal: { ind: 'boll', kind: 'band', period: 20, k: 2, band: 'lower', cross: 'down' },
    });
  });

  it('checks indicator parameters as main does', () => {
    const f = withKind(form(), 'macd', undefined, 'en');
    const bad = (params: Partial<AlertFormState['indicator']['params']>, extra: Partial<AlertFormState['indicator']> = {}, kind: AlertKind = 'macd') => {
      const g = withKind(form(), kind, undefined, 'en');
      return errors({ ...g, indicator: { ...g.indicator, ...extra, params: { ...g.indicator.params, ...params } } });
    };
    expect(errors(f)).toEqual({});
    expect(bad({ fast: '26' })).toEqual({ fast: 'fastSlow' });
    expect(bad({ signal: '0' })).toEqual({ signal: 'period' });
    expect(bad({ slow: '251' })).toEqual({ slow: 'period' });
    expect(bad({ fast: '2.5' })).toEqual({ fast: 'period' });
    expect(bad({ level: '101' }, { signal: 'levelUp' }, 'rsi')).toEqual({ level: 'level' });
    expect(bad({ level: '140' }, { signal: 'levelUp', line: 'j' }, 'kdj')).toEqual({});
    expect(bad({ level: '160' }, { signal: 'levelUp', line: 'j' }, 'kdj')).toEqual({ level: 'levelJ' });
    expect(bad({ period: '1' }, {}, 'boll')).toEqual({ period: 'bollPeriod' });
    expect(bad({ k: '6' }, {}, 'boll')).toEqual({ k: 'k' });
  });

  it('needs a session for US stocks only', () => {
    expect(formErrors(form({ value: '1', sessions: [] }))).toEqual({ sessions: 'sessions' });
    expect(formErrors({ ...newAlertForm(EURUSD, undefined, 'en'), value: '1.1', sessions: [] })).toEqual({});
  });

  it('writes the alert as main stores it', () => {
    const f = form({ value: '250', note: '  May take-profit  ', frequency: 'daily' });
    expect(alertFromForm(f, rule(f), 'n1', 42)).toEqual({ id: 'n1', contract: AAPL, rule: { type: 'priceAbove', value: 250 }, frequency: 'daily', active: true, createdAt: 42, note: 'May take-profit' });
    // Other sessions than the default are written, in their order.
    expect(alertFromForm(form({ value: '250', sessions: ['overnight', 'regular'] }), rule(f), 'n1', 42).sessions).toEqual(['regular', 'overnight']);
    // Not for instruments sessions do not apply to.
    const fx = { ...newAlertForm(EURUSD, undefined, 'en'), value: '1.1', sessions: ['regular' as const] };
    expect(alertFromForm(fx, rule(fx), 'n2', 42).sessions).toBeUndefined();
    // An edit keeps the creation time and on / off (main keeps them anyway).
    const existing = alert({ active: false, createdAt: 7 });
    expect(alertFromForm(f, rule(f), 'a1', 42, existing)).toMatchObject({ active: false, createdAt: 7 });
  });

  it('edits a stored alert as it is', () => {
    const rules: AlertRule[] = [
      { type: 'priceBelow', value: 120.125 },
      { type: 'dayRise', pct: 2.5 },
      { type: 'windowFall', minutes: 3, pct: 1 },
      { type: 'volumeAbove', shares: 12_500_000 },
      { type: 'turnoverAbove', amount: 1_500_000_000 },
      { type: 'bidSizeAbove', shares: 2_500 },
      { type: 'halt', dir: 'halted' },
      { type: 'indicator', timeframe: '1h', on: 'live', signal: { ind: 'ema', kind: 'lines', fast: 5, slow: 60, cross: 'down' } },
      { type: 'indicator', timeframe: '1W', on: 'close', signal: { ind: 'macd', kind: 'signal', fast: 5, slow: 35, signal: 5, cross: 'up' } },
      { type: 'indicator', timeframe: '5m', on: 'close', signal: { ind: 'kdj', kind: 'level', n: 9, m1: 3, m2: 3, line: 'd', level: 20, cross: 'down' } },
      { type: 'indicator', timeframe: '1D', on: 'close', signal: { ind: 'rsi', kind: 'level', period: 14, level: 30, cross: 'down' } },
      { type: 'indicator', timeframe: '30m', on: 'live', signal: { ind: 'boll', kind: 'band', period: 20, k: 2.5, band: 'upper', cross: 'down' } },
    ];
    for (const r of rules) {
      for (const lang of ['en', 'zh'] as const) expect(rule(formFromAlert(alert({ rule: r }), lang))).toEqual(r);
    }
    const f = formFromAlert(alert({ frequency: 'always', sessions: ['regular'], note: 'n' }), 'en');
    expect(f).toMatchObject({ editId: 'a1', frequency: 'always', sessions: ['regular'], note: 'n' });
    expect(formFromAlert(alert({ rule: { type: 'volumeAbove', shares: 12_500_000 } }), 'zh').value).toBe('1250万');
    expect(duplicateForm(alert(), 'en').editId).toBeUndefined();
  });

  it('offers turning a spent alert back on, not a paused one', () => {
    expect(formFromAlert(alert({ active: false, lastTriggeredAt: 5, updatedAt: 1 }), 'en').turnOn).toBe(true);
    expect(formFromAlert(alert({ active: false }), 'en').turnOn).toBe(false);
    expect(formFromAlert(alert(), 'en').turnOn).toBeUndefined();
  });

  it('counts remarks in code points and blocks more', () => {
    expect(limitNote('例如：5 月止盈线')).toBe('例如：5 月止盈线');
    expect(limitNote('12345678901234567890X')).toBe('12345678901234567890');
    expect(limitNote('😀'.repeat(21))).toBe('😀'.repeat(20));
  });

  it('cuts remarks only once an IME composition ends', () => {
    // 17 characters, then the pinyin of 止盈 still being composed: not the text yet.
    const typing = '五月止盈线减仓一半再看看后面走势' + '止' + 'zhiying';
    expect(typedNote(typing, true)).toBe(typing);
    expect(typedNote(typing, false)).toBe(limitNote(typing));
    expect(typedNote('12345678901234567890X', false)).toBe('12345678901234567890');
  });

  it('notes the market data type as main evaluates it', () => {
    expect(dataNote('priceAbove', 1)).toBeNull();
    expect(dataNote('priceAbove', undefined)).toBeNull();
    expect(dataNote('priceAbove', 3)).toBe('firesDelayed');
    expect(dataNote('volumeAbove', 3)).toBe('needsLiveDelayed');
    // Delayed frozen data (4) is frozen: main fires nothing on it.
    expect(dataNote('priceAbove', 4)).toBe('frozenData');
    expect(dataNote('volumeAbove', 4)).toBe('frozenData');
    expect(dataNote('dayRise', 2)).toBe('frozenData');
  });

  it('leaves Esc and ⏎ to an open IME composition', () => {
    const key = (k: string, over: Partial<KeyboardEvent> = {}) => ({ key: k, isComposing: false, repeat: false, metaKey: false, ctrlKey: false, altKey: false, ...over });
    expect(dialogKey(key('Escape'), false)).toBe('cancel');
    expect(dialogKey(key('Escape', { isComposing: true }), false)).toBeNull();
    expect(dialogKey(key('Enter'), false)).toBe('save');
    expect(dialogKey(key('Enter', { isComposing: true }), false)).toBeNull();
    expect(dialogKey(key('Enter'), true)).toBeNull();
    expect(dialogKey(key('Enter', { metaKey: true }), false)).toBeNull();
    expect(dialogKey(key('Enter', { repeat: true }), false)).toBeNull();
    expect(dialogKey(key('a'), false)).toBeNull();
  });

  it('mirrors main’s limits', () => {
    const others = Array.from({ length: MAX_ALERTS_PER_TYPE }, (_, i) => alert({ id: `p${i}` }));
    expect(formLimitProblem(others, form({ value: '1' }), { type: 'priceAbove', value: 1 })).toBe('perType');
    // Another type, or an edit of one of them, is fine; an incomplete form counts by its type.
    expect(formLimitProblem(others, form({ kind: 'priceBelow', value: '1' }), null)).toBeNull();
    expect(formLimitProblem(others, form({ editId: 'p3', value: '1' }), null)).toBeNull();
    expect(formLimitProblem(others, form({ value: '' }), null)).toBe('perType');
    const series = Array.from({ length: MAX_INDICATOR_SERIES }, (_, i) =>
      alert({ id: `s${i}`, contract: stock(`S${i}`), rule: { type: 'indicator', timeframe: '1D', on: 'close', signal: { ind: 'kdj', kind: 'cross', n: 9, m1: 3, m2: 3, cross: 'up' } } }),
    );
    const macd = withKind(form(), 'macd', undefined, 'en');
    expect(formLimitProblem(series, macd, null)).toBe('series');
    // A paused alert being edited counts only when it is turned on.
    const paused = [...series, alert({ id: 'x', active: false, rule: rule(macd) })];
    expect(formLimitProblem(paused, { ...macd, editId: 'x' }, rule(macd))).toBeNull();
    expect(formLimitProblem(paused, { ...macd, editId: 'x', turnOn: true }, rule(macd))).toBe('series');
  });

  it('counts the instruments alerts hold a line for', () => {
    const list = [alert(), alert({ id: 'b' }), alert({ id: 'c', contract: stock('NVDA'), active: false }), alert({ id: 'd', contract: stock('TSLA') })];
    expect(alertLineCount(list, AAPL)).toBe(2);
    expect(alertLineCount(list, stock('NVDA'))).toBe(3);
  });

  it('translates main’s refusals', () => {
    expect(refusalText(INVALID_ALERT_MESSAGE, zh)).toBe('提醒无效');
    expect(refusalText(ALERT_LIMIT_MESSAGES.perType, zh)).toBe(zh.limits.perType);
    expect(refusalText(ALERT_FIT_MESSAGES.noVolume, zh)).toBe('IB 不提供该标的的成交量');
    expect(refusalText('Locked', zh)).toBe('Locked');
  });
});

describe('dialog hints', () => {
  it('builds preset prices and quantities', () => {
    expect(presetPrice(227.48, 2)).toBe('232.03');
    expect(presetPrice(227.48, -5)).toBe('216.11');
    expect(presetPrice(0.5, 2)).toBe('0.5100');
    expect(quantityInput(10_000_000, 'en')).toBe('10M');
    expect(quantityInput(1_500_000_000, 'en')).toBe('1.5B');
    expect(quantityInput(12_345, 'en')).toBe('12345');
    expect(quantityInput(10_000_000, 'zh')).toBe('1000万');
    expect(quantityInput(250_000_000, 'zh')).toBe('2.5亿');
    expect(quantityInput(500, 'zh')).toBe('500');
    expect(niceQuantity(45_588_678)).toBe(45_600_000);
    expect(niceQuantity(22_794_339)).toBe(22_800_000);
  });

  it('measures the day’s change as main does', () => {
    const q = quote({ last: 105, close: 100, lastRthTrade: 104, marketDataType: 1 });
    expect(dayChange(q, 'regular')).toEqual({ value: expect.closeTo(5, 6), afterHours: false });
    expect(dayChange(q, 'post')!.value).toBeCloseTo((105 / 104 - 1) * 100);
    expect(dayChange(q, 'post')!.afterHours).toBe(true);
    // The previous close alone is no price.
    expect(dayChange(quote({ close: 100 }), 'regular')).toBeUndefined();
  });

  it('says whether a new alert would fire at once', () => {
    expect(alreadyMet({ type: 'priceAbove', value: 230 }, 235)).toBe(true);
    expect(alreadyMet({ type: 'priceBelow', value: 230 }, 235)).toBe(false);
    expect(alreadyMet({ type: 'askBelow', value: 230 }, 0)).toBe(false);
    expect(alreadyMet({ type: 'dayFall', pct: 3 }, -3.2)).toBe(true);
    expect(alreadyMet({ type: 'volumeAbove', shares: 10e6 }, 12e6)).toBe(true);
    expect(alreadyMet({ type: 'priceAbove', value: 230 }, undefined)).toBe(false);
  });

  it('writes the indicator preview from the two operands', () => {
    const reading = { prev: -1, cur: -0.1, bar: 0, closedBar: 0, value: 1.21, detail: { DIF: 1.21, DEA: 1.31, MACD: -0.2 }, band: 0 };
    const signal = { ind: 'macd' as const, kind: 'signal' as const, fast: 12, slow: 26, signal: 9, cross: 'up' as const };
    expect(previewText(reading, signal, 'live', en)).toBe('Now: DIF 1.21 below DEA 1.31');
    expect(previewText(reading, signal, 'close', zh)).toBe('上一根K线：DIF 1.21 低于 DEA 1.31');
    const rsi = { prev: 0, cur: 4, bar: 0, closedBar: 0, value: 74, detail: { RSI6: 74 }, band: 2 };
    expect(previewText(rsi, { ind: 'rsi', kind: 'level', period: 6, level: 70, cross: 'up' }, 'live', en)).toBe('Now: RSI6 74.00 above 70');
    const ma = { prev: 0, cur: 2, bar: 0, closedBar: 0, value: 10, detail: { close: 12, MA20: 10 }, band: 0 };
    expect(previewText(ma, { ind: 'ma', kind: 'price', period: 20, cross: 'up' }, 'live', zh)).toBe('当前：收盘价 12.00 高于 MA20 10.00');
  });

  it('gives each value block its kind', () => {
    expect(valueBlock('bidAbove')).toBe('price');
    expect(valueBlock('windowRise5')).toBe('percent');
    expect(valueBlock('turnoverAbove')).toBe('quantity');
    expect(valueBlock('askSizeAbove')).toBe('size');
    expect(valueBlock('boll')).toBe('indicator');
    expect(valueBlock('halt')).toBe('halt');
    expect(valueBlock('turnoverRatio')).toBe('none');
  });
});

describe('the alert list', () => {
  it('summarizes each rule in one line', () => {
    const s = (r: AlertRule, m = en, c: ContractRef = AAPL) => ruleSummary({ rule: r, contract: c }, m);
    expect(s({ type: 'priceAbove', value: 125 })).toBe('Price ≥ 125.00');
    expect(s({ type: 'priceBelow', value: 120.125 })).toBe('Price ≤ 120.125');
    expect(s({ type: 'askBelow', value: 0.5 })).toBe('Ask ≤ 0.5000');
    expect(s({ type: 'windowRise', minutes: 5, pct: 2 })).toBe('5-min rise ≥ 2%');
    expect(s({ type: 'windowRise', minutes: 5, pct: 2 }, zh)).toBe('5 分钟涨幅 ≥ 2%');
    expect(s({ type: 'dayFall', pct: 2.5 })).toBe('Day fall ≥ 2.5%');
    expect(s({ type: 'volumeAbove', shares: 10_000_000 })).toBe('Volume ≥ 10M');
    expect(s({ type: 'volumeAbove', shares: 10_000_000 }, zh)).toBe('成交量 ≥ 1000万');
    expect(s({ type: 'turnoverAbove', amount: 1e9 })).toBe('Turnover ≥ $1B');
    // Thresholds exactly as stored, never rounded (1.25M is not 1.3M).
    expect(s({ type: 'volumeAbove', shares: 1_250_000 })).toBe('Volume ≥ 1.25M');
    expect(s({ type: 'volumeAbove', shares: 12_345_678 })).toBe('Volume ≥ 12,345,678');
    expect(s({ type: 'volumeAbove', shares: 12_345_678 }, zh)).toBe('成交量 ≥ 12,345,678');
    expect(s({ type: 'turnoverAbove', amount: 12_500_000 })).toBe('Turnover ≥ $12.5M');
    expect(s({ type: 'askSizeAbove', shares: 15_250 })).toBe('Ask size ≥ 15.25K');
    // Dollars carry $ in zh too; other currencies their code.
    expect(s({ type: 'turnoverAbove', amount: 1e7 }, zh)).toBe('成交额 ≥ $1000万');
    expect(s({ type: 'turnoverAbove', amount: 1e7 }, zh, { symbol: '700', secType: 'STK', exchange: 'SEHK', currency: 'HKD' })).toBe('成交额 ≥ 1000万 HKD');
    expect(s({ type: 'bidSizeAbove', shares: 5_000 })).toBe('Bid size ≥ 5,000');
    expect(s({ type: 'halt', dir: 'resumed' }, zh)).toBe('复牌');
    expect(s({ type: 'indicator', timeframe: '15m', on: 'close', signal: { ind: 'macd', kind: 'signal', fast: 12, slow: 26, signal: 9, cross: 'up' } })).toBe('MACD golden cross · 15m');
    expect(s({ type: 'indicator', timeframe: '15m', on: 'close', signal: { ind: 'macd', kind: 'signal', fast: 12, slow: 26, signal: 9, cross: 'up' } }, zh)).toBe('MACD 金叉 · 15分钟');
    expect(s({ type: 'indicator', timeframe: '1D', on: 'live', signal: { ind: 'ma', kind: 'price', period: 20, cross: 'up' } })).toBe('Crosses above MA20 · D · real time');
    expect(s({ type: 'indicator', timeframe: '1h', on: 'close', signal: { ind: 'rsi', kind: 'level', period: 6, level: 80, cross: 'up' } }, zh)).toBe('RSI6 升破 80 · 1小时');
    expect(s({ type: 'indicator', timeframe: '1W', on: 'close', signal: { ind: 'kdj', kind: 'cross', n: 5, m1: 3, m2: 3, cross: 'down' } })).toBe('KDJ(5,3,3) dead cross · W');
    expect(s({ type: 'indicator', timeframe: '1D', on: 'live', signal: { ind: 'boll', kind: 'band', period: 20, k: 2, band: 'upper', cross: 'up' } }, zh)).toBe('突破布林上轨 · 日K · 实时');
    expect(ruleSummary({ rule: { type: 'future' } as unknown as AlertRule, contract: AAPL, unsupported: true }, en)).toBe('Alert type of a newer version (future)');
  });

  it('shows what main measures now', () => {
    const st = (over: Partial<AlertStatus>): AlertStatus => ({ id: 'a1', state: 'ok', ...over });
    expect(nowText(alert(), st({ value: 230.5 }), en)).toBe('Now 230.50');
    expect(nowText(alert({ rule: { type: 'dayRise', pct: 3 } }), st({ value: 1.234 }), en)).toBe('Now +1.23%');
    expect(nowText(alert({ rule: { type: 'dayRise', pct: 3 } }), st({ value: 1.234, afterHours: true }), en)).toBe('Now +1.23% after hours');
    expect(nowText(alert({ rule: { type: 'turnoverAbove', amount: 1e9 } }), st({ value: 8e8 }), zh)).toBe('当前 ≈$8亿');
    const macd: AlertRule = { type: 'indicator', timeframe: '15m', on: 'close', signal: { ind: 'macd', kind: 'signal', fast: 12, slow: 26, signal: 9, cross: 'up' } };
    expect(nowText(alert({ rule: macd }), st({ value: 1.21, detail: { DIF: 1.21, DEA: 1.31, MACD: -0.2 } }), en)).toBe('Now DIF 1.21 · DEA 1.31');
    expect(nowText(alert(), undefined, en)).toBeUndefined();
  });

  it('says why an alert is not watched', () => {
    const clock = createClock('24h', 'en');
    const now = new Date(2026, 9, 14, 12).getTime();
    const st = (over: Partial<AlertStatus>): AlertStatus => ({ id: 'a1', state: 'ok', ...over });
    const text = (a: PriceAlert, s?: AlertStatus) => statusText(a, s, en, clock, now);
    expect(text(alert(), st({}))).toBeNull();
    expect(text(alert(), st({ state: 'noLine' }))).toEqual({ text: 'Not monitored: market data line limit', tone: 'danger' });
    expect(text(alert(), st({ state: 'noData', reason: 'lineError', message: 'No market data permissions' }))!.text).toBe('Not monitored: No market data permissions');
    expect(text(alert(), st({ state: 'delayed', needsLive: true }))).toEqual({ text: 'Delayed data: waits for live data', tone: 'danger' });
    expect(text(alert(), st({ state: 'delayed' }))).toEqual({ text: 'Delayed 15 min', tone: 'warn' });
    expect(text(alert({ rule: { type: 'windowRise', minutes: 5, pct: 2 } }), st({ state: 'waiting', reason: 'window', readyIn: 130_000 }))!.text).toBe('Waiting for 5 min of data (2:10 left)');
    expect(text(alert(), st({ state: 'outOfSession' }))!.text).toBe('Outside selected sessions');
    expect(text(alert(), st({ state: 'unsupported', reason: 'newerVersion' }))!.text).toBe('Not supported in this version');
    // Before main's status arrives: from the alert itself.
    const fired = new Date(2026, 9, 14, 10, 31).getTime();
    expect(text(alert({ active: false, lastTriggeredAt: fired }))).toEqual({ text: 'Triggered 10:31', tone: 'accent' });
    expect(text(alert({ active: false }))).toEqual({ text: 'Paused', tone: 'muted' });
    expect(statusText(alert({ active: false, lastTriggeredAt: fired }), undefined, zh, createClock('24h', 'zh'), now)!.text).toBe('已触发 10:31');
  });

  it('marks the bell while an alert that is on is not watched', () => {
    const statuses: AlertStatus[] = [
      { id: 'a', state: 'noLine' },
      { id: 'b', state: 'delayed', needsLive: true },
      { id: 'c', state: 'delayed' },
      { id: 'd', state: 'offline' },
      { id: 'e', state: 'noData', reason: 'tooFewBars' },
    ];
    const list = ['a', 'b', 'c', 'd', 'e'].map((id) => alert({ id }));
    expect(unwatchedCount(list, statuses)).toBe(3);
    expect(isUnwatched(alert({ id: 'a', active: false }), statuses[0])).toBe(false);
    expect(isUnwatched(alert({ id: 'a' }), undefined)).toBe(false);
  });

  it('groups alerts by instrument in list order', () => {
    const list = [alert({ id: '1' }), alert({ id: '2', contract: stock('NVDA') }), alert({ id: '3' })];
    expect(groupByInstrument(list).map((g) => [g.key, g.alerts.map((a) => a.id)])).toEqual([
      ['STK:AAPL', ['1', '3']],
      ['STK:NVDA', ['2']],
    ]);
  });

  it('knows spent and editable alerts', () => {
    expect(isSpent(alert({ active: false, lastTriggeredAt: 5 }))).toBe(true);
    // Paused after the trigger (updatedAt later): not spent.
    expect(isSpent(alert({ active: false, lastTriggeredAt: 5, updatedAt: 9 }))).toBe(false);
    expect(isSpent(alert({ active: false, lastTriggeredAt: 5, frequency: 'daily' }))).toBe(false);
    expect(isEditable(alert({ unsupported: true }))).toBe(false);
    expect(isEditable(alert())).toBe(true);
  });

  it('reads the level of price, bid and ask alerts only (the chart’s lines)', () => {
    expect(alertLevel(alert({ rule: { type: 'priceBelow', value: 220 } }))).toEqual({ condition: 'below', price: 220 });
    expect(alertLevel(alert({ rule: { type: 'bidAbove', value: 230 } }))).toEqual({ condition: 'above', price: 230 });
    expect(alertLevel(alert({ rule: { type: 'dayRise', pct: 5 } }))).toBeNull();
    expect(alertLevel(alert({ unsupported: true }))).toBeNull();
  });
});
