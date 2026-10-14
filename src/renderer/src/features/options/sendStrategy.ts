// Sends the strategy builder's legs: a single leg as a limit order on the contract (a stock leg
// as the shares it stands for: it counts 100-share lots, as its description and the combo ratios
// do), several legs as a BAG combo (conIds resolved through contract details) at the net mark price. The review
// lists every leg as built (side, contracts, the option), the net debit or credit of the price and
// the amount, a red row for a combo at market, and the pre-trade risks that apply
// (ticket/orderRisk.ts).

import { contractKey, contractLabel } from '@shared/contract';
import { DASH, f0, f2, parseNum, usd } from '@shared/format';
import type { ContractRef, PriceConditionSpec } from '@shared/types';
import { useCommon } from '../../i18n/common';
import { errorText, submitOrder } from '../../state/orderActions';
import { useStore, type ConfirmRow } from '../../state/store';
import { accountRiskContext, marketDataOf, orderRisks, strategyRisks, worseData, type MarketDataQuality } from '../ticket/orderRisk';
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

/** Validates, resolves combo legs and opens the order review. */
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
  let legRows: ConfirmRow[] = [];
  if (view.order.single) {
    const v = legs[0];
    // A stock leg counts 100-share lots (legDesc, the combo ratios, the order's cost): send its shares.
    const qty = v.leg.right === 'S' ? v.leg.qty * 100 : v.leg.qty;
    request = strategyOrder(v.contract, v.leg.side, qty, view.order.price, { ...order, condition });
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
    // Each leg as the user built it, which is also what a fill does to the position: a credit
    // combo is sent as SELL with every leg action reversed, so the wire's actions would mislead.
    legRows = legs.map((l, i) => ({
      label: m.legN(i + 1),
      value: `${l.leg.side === 'BUY' ? c.buy : c.sell} ${f0(terms.ratios[i] * terms.quantity)} × ${contractLabel(l.contract)}`,
      color: l.leg.side === 'BUY' ? 'var(--up)' : 'var(--dn)',
    }));
  }

  const buy = request.action === 'BUY';
  const sideLabel = buy ? c.buy : c.sell;
  // A BUY pays a net debit, a SELL (a credit combo, or a leg sold) receives a net credit.
  const net = buy ? m.netDebit : m.netCredit;
  const market = request.orderType === 'MKT';
  const cost = view.orderCost;

  // The legs' prices are as current as their quotes (the stock leg's is the underlying's). The
  // pre-trade checks: a single leg like a ticket order (its price comes from the leg's bid / ask),
  // a combo by its size and the legs' data.
  const current = useStore.getState();
  const marketData = legs.reduce<MarketDataQuality>(
    (d, l) => worseData(d, marketDataOf(current.quotes[contractKey(l.leg.right === 'S' ? underlying : l.contract)])),
    'live',
  );
  const account = accountRiskContext(current, request.contract);
  const risks = view.order.single
    ? orderRisks(request, cost != null ? Math.abs(cost) : undefined, { ...account, bid: legs[0].bid, ask: legs[0].ask, marketData, priceFromQuote: true })
    : strategyRisks(market, cost, { ...account, marketData }, request.contract.currency);

  submitOrder({
    origin,
    request,
    label: sideLabel,
    summary: `${sideLabel} ${f0(request.quantity)} ${name}`,
    marketData,
    ...(risks.length ? { risks } : {}),
    rows: [
      { label: c.contract, value: name },
      { label: c.side, value: sideLabel, color: buy ? 'var(--up)' : 'var(--dn)' },
      { label: c.qty, value: f0(request.quantity) },
      ...legRows,
      { label: c.typePrice, value: market ? m.market : legRows.length ? `${m.limit} ${f2(request.limitPrice)} · ${net}` : `${m.limit} ${f2(request.limitPrice)}` },
      { label: c.tif, value: request.tif + (condition ? m.conditional : '') + (request.nonGuaranteed ? m.nonGuaranteedExtra : '') },
      ...(condition ? [{ label: c.trigger, value: `${underlying.symbol} ${opSymbol(condition.operator)} ${f2(condition.price)}` }] : []),
      { label: c.estAmount, value: cost != null ? `${net} ${usd(Math.abs(cost))}` : DASH },
      // The builder's warning, repeated where the order is confirmed.
      ...(market && legRows.length ? [{ label: m.market, value: m.mktHint, color: 'var(--r)', prose: true }] : []),
    ],
  });
}
