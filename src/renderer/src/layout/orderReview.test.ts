import { afterEach, describe, expect, it } from 'vitest';
import { stock } from '@shared/contract';
import type { Lang, OrderRequest } from '@shared/types';
import { isDialogOpen, useStore, type PendingOrder } from '../state/store';
import { isCarriedOverClick } from '../ui/primitives';
import { CONFIRM_ARM_MS, confirmLabel, enterAction, mayArm, needsAcknowledgement, reviewRows, reviewTitle, riskRows, warningRows } from './orderReview';

const request: OrderRequest = { contract: stock('SPCX'), action: 'BUY', orderType: 'LMT', quantity: 100, limitPrice: 158.11, tif: 'DAY', outsideRth: false };
const pending = (patch: Partial<PendingOrder> = {}): PendingOrder => ({
  request,
  rows: [{ label: 'Contract', value: 'SPCX' }],
  label: 'Buy',
  summary: 'Buy 100 SPCX',
  session: 1,
  account: 'U18630011',
  isPaper: false,
  ...patch,
});
const lang = (language: Lang) => useStore.setState((s) => ({ settings: { ...s.settings, appearance: { ...s.settings.appearance, language } } }));

describe('the order review', () => {
  afterEach(() => lang('en'));

  it('names the order: a new one, or the order a modify changes', () => {
    expect(reviewTitle(pending())).toBe('Confirm order');
    expect(confirmLabel(pending())).toBe('Confirm Buy');
    expect(reviewTitle(pending({ modifyOrderId: 58 }))).toBe('Modify order #58');
    expect(confirmLabel(pending({ modifyOrderId: 58 }))).toBe('Confirm modify #58');
    lang('zh');
    expect(reviewTitle(pending({ modifyOrderId: 58 }))).toBe('改单 #58');
  });

  it('starts with the account the order was submitted for: LIVE in red, the id only while shown', () => {
    expect(reviewRows(pending(), true)).toEqual([
      { label: 'Account', value: 'LIVE · U18630011', color: 'var(--r)' },
      { label: 'Contract', value: 'SPCX' },
    ]);
    // Hiding account IDs never hides paper or live.
    expect(reviewRows(pending(), false)[0]).toEqual({ label: 'Account', value: 'LIVE', color: 'var(--r)' });
    expect(reviewRows(pending({ account: 'DUP899854', isPaper: true }), true)[0]).toEqual({ label: 'Account', value: 'PAPER · DUP899854' });
    lang('zh');
    expect(reviewRows(pending(), true)[0]).toEqual({ label: '账户', value: '实盘 · U18630011', color: 'var(--r)' });
  });

  it('adds a red row for prices that are not live', () => {
    expect(warningRows(pending({ marketData: 'live' }))).toEqual([]);
    expect(warningRows(pending())).toEqual([]);
    expect(warningRows(pending({ marketData: 'delayed' }))).toEqual([{ label: 'Market data', value: 'Delayed 15 min: Est. amount and bid / ask may be stale', color: 'var(--r)', prose: true }]);
    expect(warningRows(pending({ marketData: 'frozen' }))[0].value).toBe('Frozen: Est. amount and bid / ask may be stale');
    expect(warningRows(pending({ marketData: 'none' }))[0].value).toBe('None: Est. amount cannot be checked against the market');
    // A market order on them says it once, as the risk to acknowledge.
    expect(warningRows(pending({ marketData: 'delayed', risks: [{ kind: 'marketOnStaleData', data: 'delayed', market: true }] }))).toEqual([
      { label: 'Market data', value: 'Delayed 15 min: a market order can fill far from the prices shown', color: 'var(--r)', prose: true },
    ]);
  });

  it('writes each risk as a red row', () => {
    const rows = riskRows([
      { kind: 'opensShort', before: 0, after: -100 },
      { kind: 'opensShort', before: -50, after: -150 },
      { kind: 'flips', before: 100, after: -400 },
      { kind: 'flips', before: -100, after: 200 },
      { kind: 'largeNotional', amount: 300_000, netLiq: 1_000_000, currency: 'USD' },
      { kind: 'overBuyingPower', amount: 22_749, buyingPower: 10_000, currency: 'USD' },
      { kind: 'farThroughMarket', side: 'BUY', limit: 240, market: 227.49, ref: 'ask', pct: 5.5 },
      { kind: 'farThroughMarket', side: 'SELL', limit: 0.04, market: 0.0525, ref: 'last', pct: 23.8 },
      { kind: 'marketOnStaleData', data: 'delayed', market: true },
      { kind: 'marketOnStaleData', data: 'frozen', market: false },
      { kind: 'unchecked', missing: ['positions', 'account'] },
      { kind: 'unchecked', missing: ['rate'], currency: 'HKD', accountCurrency: 'USD' },
    ]);
    expect(rows.every((r) => r.color === 'var(--r)')).toBe(true);
    expect(rows.map((r) => `${r.label}: ${r.value}`)).toEqual([
      'Position: 0 → −100: opens a short position',
      'Position: −50 → −150: adds to the short position',
      'Position: 100 → −400: turns the long position short',
      'Position: −100 → 200: turns the short position long',
      'Size: $300,000.00 is 30% of net liquidation',
      'Buying power: $22,749.00 is more than the buying power $10,000.00',
      'Limit: 240.00 is 5.5% above the ask 227.49',
      'Limit: 0.0400 is 23.8% below the last price 0.0525',
      'Market data: Delayed 15 min: a market order can fill far from the prices shown',
      'Market data: Frozen: the price comes from that bid / ask; check it against the market',
      'Not checked: Positions not loaded from IBKR yet: the position was not checked',
      'Not checked: No account values from IBKR yet: size and buying power were not checked',
      'Not checked: No HKD → USD rate from IBKR: size and buying power were not checked',
    ]);
    // A check that could not run needs the tick like any other risk.
    expect(needsAcknowledgement(pending({ risks: [{ kind: 'unchecked', missing: ['positions'] }] }))).toBe(true);
    lang('zh');
    expect(riskRows([{ kind: 'opensShort', before: 0, after: -100 }])[0]).toEqual({ label: '持仓', value: '0 → −100：开立空头仓位', color: 'var(--r)', prose: true });
    expect(riskRows([{ kind: 'unchecked', missing: ['rate'], currency: 'HKD', accountCurrency: 'USD' }])[0]).toMatchObject({ label: '未检查', value: 'IBKR 未提供 HKD → USD 汇率：未检查金额和购买力' });
  });

  it('arms Confirm only when there is something to send and the risks are acknowledged', () => {
    const risky = pending({ risks: [{ kind: 'opensShort', before: 0, after: -100 }] });
    expect(needsAcknowledgement(pending())).toBe(false);
    expect(needsAcknowledgement(risky)).toBe(true);
    expect(mayArm(pending(), false)).toBe(true);
    expect(mayArm(risky, false)).toBe(false);
    expect(mayArm(risky, true)).toBe(true);
    // A modify that changes nothing has nothing to confirm.
    expect(mayArm(pending({ modifyOrderId: 58, unchanged: true }), true)).toBe(false);
    // Nor while IB Gateway lost IB (1100) or does not answer: it arms once that is over.
    expect(mayArm(pending(), false, true)).toBe(false);
    expect(mayArm(risky, true, true)).toBe(false);
    expect(mayArm(risky, true, false)).toBe(true);
    expect(CONFIRM_ARM_MS).toBe(600);
  });
});

describe('⏎ in the review', () => {
  const enter = (patch: Partial<{ key: string; repeat: boolean; isComposing: boolean }> = {}) => ({ key: 'Enter', repeat: false, isComposing: false, ...patch });

  it('neither sends nor closes before Confirm has armed (the ⏎⏎ that opened it)', () => {
    expect(enterAction(enter(), false, 'confirm')).toBe('block');
    expect(enterAction(enter(), false, 'none')).toBe('block');
  });

  it('sends once armed: on the focused Confirm natively, with nothing focused by the dialog', () => {
    expect(enterAction(enter(), true, 'confirm')).toBe('native');
    expect(enterAction(enter(), true, 'none')).toBe('confirm');
  });

  it('a held ⏎ never sends; Cancel (after Tab) closes at once', () => {
    expect(enterAction(enter({ repeat: true }), true, 'confirm')).toBe('block');
    expect(enterAction(enter({ repeat: true }), true, 'other')).toBe('block');
    expect(enterAction(enter(), false, 'other')).toBe('native');
  });

  it('leaves other keys and composition alone', () => {
    expect(enterAction(enter({ key: 'Tab' }), false, 'confirm')).toBe('pass');
    expect(enterAction(enter({ isComposing: true }), true, 'none')).toBe('pass');
  });
});

describe('dialogs hold the screen', () => {
  it('a click continuing a double-click that opened the dialog is swallowed', () => {
    expect(isCarriedOverClick(2, 120)).toBe(true);
    expect(isCarriedOverClick(3, 300)).toBe(true);
    // A single click, a keyboard click, or a double-click well after opening is the user's.
    expect(isCarriedOverClick(1, 50)).toBe(false);
    expect(isCarriedOverClick(0, 50)).toBe(false);
    expect(isCarriedOverClick(2, 900)).toBe(false);
  });

  it('app commands and trading keys wait while any dialog is open', () => {
    const none = { pendingOrder: null, confirm: null, cancelAll: null, alertForm: null, pinDialog: null };
    expect(isDialogOpen(none)).toBe(false);
    expect(isDialogOpen({ ...none, pendingOrder: pending() })).toBe(true);
    expect(isDialogOpen({ ...none, confirm: { title: '', rows: [], label: '' } })).toBe(true);
    expect(isDialogOpen({ ...none, cancelAll: { session: 1 } })).toBe(true);
    expect(isDialogOpen({ ...none, alertForm: { contract: stock('AAPL'), condition: 'above', price: '1', repeat: false } })).toBe(true);
    expect(isDialogOpen({ ...none, pinDialog: { mode: 'set' } })).toBe(true);
  });
});
