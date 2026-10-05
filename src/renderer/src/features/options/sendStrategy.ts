// Sends the strategy builder's legs: a single leg as a limit order on the contract, several
// legs as a BAG combo (conIds resolved through contract details) at the net mark price.

import { contractLabel } from '@shared/contract';
import { f0, f2, parseNum, usd } from '@shared/format';
import type { ContractRef, PriceConditionSpec } from '@shared/types';
import { useCommon } from '../../i18n/common';
import { errorText, submitOrder } from '../../state/orderActions';
import { useStore } from '../../state/store';
import type { PanelId } from '../panels/model';
import { useM } from './messages';
import { comboContract, strategyOrder, type StrategyOrderOptions } from './orders';
import type { StrategyKey } from './strategies';
import type { StrategyView } from './strategyModel';

export interface SendOptions {
  view: StrategyView;
  underlying: ContractRef;
  tmpl: StrategyKey | null;
  cond: { on: boolean; op: '>=' | '<='; px: string };
  /** Order type, TIF and combo routing. */
  order?: Omit<StrategyOrderOptions, 'condition'>;
  /** The floating panel the order is sent from: its status strip reports it instead of toasts. */
  origin?: PanelId;
}

const opSymbol = (op: '>=' | '<=') => (op === '>=' ? '≥' : '≤');

/** Validates, resolves combo legs and opens the order review (or sends right away). */
export async function sendStrategy({ view, underlying, tmpl, cond, order = { type: 'LMT', tif: 'DAY' }, origin }: SendOptions): Promise<void> {
  const s = useStore.getState();
  const m = useM.now();
  const c = useCommon.now();
  const fail = (text: string) => s.showToast(text, 'error');
  const legs = view.legs;
  if (!legs.length) return;
  if (underlying.secType === 'IND' && legs.some((l) => l.leg.right === 'S')) return fail(m.noStockOnIndex);
  if (!view.order) return fail(legs.length === 1 ? m.noPrice(legs[0].desc) : m.waitingQuotes);

  let condition: PriceConditionSpec | undefined;
  if (cond.on) {
    const price = parseNum(cond.px);
    if (!(price > 0)) return fail(m.invalidTrigger);
    condition = { contract: underlying, operator: cond.op, price, outsideRth: false };
  }

  let request;
  let name: string;
  if (view.order.single) {
    const v = legs[0];
    request = strategyOrder(v.contract, v.leg.side, v.leg.qty, view.order.price, { ...order, condition });
    name = contractLabel(v.contract);
  } else {
    if (s.connection.status !== 'connected') return fail(c.notConnected);
    const terms = view.order.terms;
    let conIds: number[];
    try {
      const infos = await Promise.all(legs.map((l) => window.tape.getContractInfo(l.contract)));
      const missing = infos.findIndex((i) => !i?.contract.conId);
      if (missing >= 0) return fail(m.resolveFailed(legs[missing].desc));
      conIds = infos.map((i) => i!.contract.conId!);
    } catch (err) {
      return fail(m.resolveFailed(errorText(err)));
    }
    const bag = comboContract(
      underlying.symbol,
      conIds.map((conId, i) => ({ conId, ratio: terms.ratios[i], action: terms.legActions[i] })),
    );
    request = strategyOrder(bag, terms.action, terms.quantity, terms.limitPrice, { ...order, condition });
    name = m.comboName(underlying.symbol, legs.length, tmpl ? m.strategies[tmpl] : m.combo);
  }

  const buy = request.action === 'BUY';
  const sideLabel = buy ? c.buy : c.sell;
  submitOrder({
    origin,
    request,
    label: sideLabel,
    summary: `${sideLabel} ${f0(request.quantity)} ${name}`,
    rows: [
      { label: c.contract, value: name },
      { label: c.side, value: sideLabel, color: buy ? 'var(--up)' : 'var(--dn)' },
      { label: c.qty, value: f0(request.quantity) },
      { label: c.typePrice, value: request.orderType === 'MKT' ? m.market : `${m.limit} ${f2(request.limitPrice)}` },
      { label: c.tif, value: request.tif + (condition ? m.conditional : '') + (request.nonGuaranteed ? m.nonGuaranteedExtra : '') },
      ...(condition ? [{ label: c.trigger, value: `${underlying.symbol} ${opSymbol(condition.operator)} ${f2(condition.price)}` }] : []),
      { label: c.estAmount, value: usd(Math.abs(view.orderCost ?? 0)) },
    ],
  });
}
