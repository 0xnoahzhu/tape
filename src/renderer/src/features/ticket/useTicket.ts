// The order ticket's state, rules and actions in one place: the docked ticket (OrderTicket) and
// the floating ticket (features/panels/TicketFloat) lay out the same parts (parts.tsx) on
// top of this controller, so validation, keyboard handling and the submit flow stay single-sourced.

import { useMemo } from 'react';
import { contractLabel, isTradable, multiplierOf } from '@shared/contract';
import { roundToTick } from '@shared/format';
import { isTimingProblem, sessionOf, tifChangeAllowed, timingProblem, unavailableReason, type TimingField, type TimingInput } from '@shared/orderTiming';
import { algoParamProblem, isOrderProblem, MAIN_ORDER_TYPES, orderProblems, type OrderField, type OrderProblem, type OrderRulesContext } from '@shared/orderRules';
import type { ContractRef, OrderAction, OrderType, TimeInForce } from '@shared/types';
import { lastPrice, useQuote, useQuoteSubscriptions } from '../../hooks/useQuotes';
import { useClock } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { submitOrder } from '../../state/orderActions';
import { isPanelSending } from '../../state/orderFeedback';
import { useStore, type TicketState } from '../../state/store';
import { attributeFlags } from '../orders/attributes';
import type { PanelId } from '../panels/model';
import { buildOrderRequest, choiceProblem, combinationProblem, composeOrder, pendingOrder, type OrderInput, type ReviewLabels, type TicketError } from './buildOrder';
import type { Choices } from './controls';
import { useTicketM } from './messages';
import { conditionContract, positive, resolveTicket, type TicketMarket } from './ticketModel';
import { goodTillTime, ticketTiming } from './timing';
import { useContractInfo } from './useContractInfo';
import { useTicketKeys } from './useTicketKeys';

/** The main price box: limit, trigger / initial stop, cap or offset, or a read-only market. */
export interface MainPrice {
  key: 'limitPrice' | 'stopPrice' | 'offset' | null;
  value?: number;
  readOnly?: string;
  placeholder?: string;
}

export type TicketCtl = ReturnType<typeof useTicket>;

/**
 * `origin`: the floating panel the ticket is drawn in (its status strip, not toasts, reports the
 * orders sent from it); undefined for the docked ticket.
 */
export function useTicket(origin?: PanelId) {
  const m = useTicketM();
  const c = useCommon();
  const clock = useClock();
  const tifHints = m.tifHints(clock);
  const sessionHints = m.sessionHints(clock);
  const symbol = useStore((s) => s.symbol);
  const t = useStore((s) => s.ticket);
  const patch = useStore((s) => s.patchTicket);
  const connected = useStore((s) => s.connection.status === 'connected');
  const feedIssue = useStore((s) => s.connection.marketDataIssue);
  // The order being modified keeps its session (IB refuses to move it); the ticket shows that one.
  // Its TIF can only change between DAY and GTC, or to IOC (tifChangeAllowed).
  const modifiedOrder = useStore((s) =>
    s.ticket.modifyingOrderId == null ? undefined : s.orders.find((o) => o.orderId === s.ticket.modifyingOrderId && o.clientId === s.connection.clientId),
  );
  // OCA groups of this client's working orders, offered when an order joins a group.
  const myClientId = useStore((s) => s.connection.clientId);
  const orders = useStore((s) => s.orders);
  const ocaGroups = useMemo(() => [...new Set(orders.filter((o) => o.clientId === myClientId && o.oca?.group).map((o) => o.oca!.group))], [orders, myClientId]);

  const refContract = useMemo(() => conditionContract(symbol), [symbol]);
  const subs = useMemo(() => [symbol, refContract], [symbol, refContract]);
  useQuoteSubscriptions('ticket', subs, 'basic');
  const q = useQuote(symbol);
  const refQ = useQuote(refContract);
  const info = useContractInfo(symbol);
  const refInfo = useContractInfo(refContract);
  const rules: OrderRulesContext = useMemo(() => ({ orderTypes: info?.orderTypes, validExchanges: info?.validExchanges }), [info]);

  const minTick = positive(info?.minTick) ? info.minTick : 0.01;
  const market: TicketMarket = {
    bid: positive(q?.bid) ? q.bid : undefined,
    ask: positive(q?.ask) ? q.ask : undefined,
    last: lastPrice(q),
    refLast: lastPrice(refQ),
    refMinTick: positive(refInfo?.minTick) ? refInfo.minTick : undefined,
    minTick,
    multiplier: info?.contract.multiplier ?? multiplierOf(symbol),
  };
  const model = resolveTicket(t, market);

  const now = Date.now();
  const session = modifiedOrder ? sessionOf(modifiedOrder) : t.session;
  const goodTill = goodTillTime(t.goodTill, now, info);
  const timing: TimingInput = ticketTiming(t, symbol, session, goodTill);
  const modifying = t.modifyingOrderId;
  /** The ticket as the order rules see it (with the session in effect). */
  const input: OrderInput = { contract: symbol, ticket: { ...t, session }, market, now, hours: info, timeFormat: clock.format, rules };
  const ruleText = (p: OrderProblem): string => m.rules[p];
  /** Why a choice cannot be made with the rest of the ticket as it is (null: it can). */
  const unavailable = <F extends TimingField>(field: F, value: TimingInput[F]): string | null => {
    const why = unavailableReason(timing, field, value);
    return why ? m.problems[why] : null;
  };
  const choices: Choices = {
    timing: unavailable,
    rule: (p: Partial<TicketState>, field: OrderField) => {
      const why = choiceProblem(input, p, field);
      return why ? ruleText(why) : null;
    },
  };
  /** Why IB would refuse to change the modified order to this TIF (null: it would not). */
  const tifLock = (k: TimeInForce): string | null => (modifiedOrder && !tifChangeAllowed(modifiedOrder.tif, k) ? m.tifLocked(modifiedOrder.tif) : null);
  /** Why an order type cannot be chosen: a working order keeps its type; then the timing and order rules. */
  const typeWhy = (k: OrderType, extra: Partial<TicketState> = {}): string | null => {
    if (modifying != null && k !== t.orderType) return m.locked.orderType;
    return unavailable('orderType', k) ?? choices.rule({ orderType: k, limitPrice: null, stopPrice: null, ...extra }, 'orderType');
  };
  /** Market / limit on open: the type, then TIF OPG with that type. */
  const openWhy = (k: 'MKT' | 'LMT'): string | null => {
    const opg = unavailableReason({ ...timing, orderType: k }, 'tif', 'OPG');
    return typeWhy(k, { tif: 'OPG' }) ?? tifLock('OPG') ?? (opg ? m.problems[opg] : null);
  };
  /** Why a TIF chip is unavailable (null: it can be chosen or is chosen). */
  const tifWhy = (k: TimeInForce): string | null => (k === t.tif ? null : (tifLock(k) ?? unavailable('tif', k) ?? choices.rule({ tif: k }, 'tif')));

  const tradable = isTradable(symbol);
  const buy = t.side === 'BUY';
  const label = contractLabel(symbol);

  const labels: ReviewLabels = {
    contract: c.contract,
    side: c.side,
    qty: c.qty,
    typePrice: c.typePrice,
    tif: c.tif,
    trigger: c.trigger,
    estAmount: c.estAmount,
    tpSl: m.tpSl,
    buy: c.buy,
    sell: c.sell,
    orderTypes: m.orderTypes,
    sessions: c.sessions,
    clock,
    units: m.units,
    extras: m.extras,
    review: m.review,
    stopTypes: m.stopTypes,
    attr: m.attr,
  };

  const errorText = (e: TicketError, contract: ContractRef, ticket: TicketState): string => {
    if (e === 'index') return c.indexNotTradable(contract.symbol);
    if (isTimingProblem(e)) return m.problems[e];
    if (e === 'algoParam') {
      // Name the parameter: "Check the algo parameter “Max % volume”".
      const algo = composeOrder({ ...input, contract, ticket }).request.algo;
      const tag = algo ? algoParamProblem(algo) : null;
      if (tag) return m.algoParamProblem(m.attr.algoParams[tag] ?? tag);
    }
    if (isOrderProblem(e)) return ruleText(e);
    if (e === 'gat' && clock.format === '12h') return m.gat12h;
    return m.errors[e as keyof typeof m.errors];
  };

  const submit = () => {
    // A floating panel's order still waiting for IB: its button is disabled, ⏎ must not send again.
    if (isPanelSending(origin)) return;
    const s = useStore.getState();
    const locked = tifLock(s.ticket.tif);
    if (locked) {
      s.showToast(locked, 'error');
      return;
    }
    const res = buildOrderRequest({ contract: s.symbol, ticket: { ...s.ticket, session }, market, hours: info, timeFormat: clock.format, rules });
    if (!res.ok) {
      s.showToast(errorText(res.error, s.symbol, { ...s.ticket, session }), 'error');
      return;
    }
    submitOrder({ ...pendingOrder(res.request, res.model, labels, market, s.ticket.modifyingOrderId), origin });
  };
  useTicketKeys(submit);

  // Changing side or type drops typed prices: their defaults depend on both.
  const setSide = (side: OrderAction) => patch({ side, limitPrice: null, stopPrice: null, limitOffset: null });
  const setType = (orderType: OrderType, extra: Partial<TicketState> = {}) => patch({ orderType, limitPrice: null, stopPrice: null, limitOffset: null, ...extra });
  const setPrice = (key: 'limitPrice' | 'stopPrice', n: number | null) => patch(key === 'limitPrice' ? { limitPrice: n } : { stopPrice: n });
  // Typed prices snap to the instrument's tick when the field is left.
  const commitPrice = (key: 'limitPrice' | 'stopPrice' | 'limitOffset') => (n: number | null) => {
    if (n != null) patch({ [key]: roundToTick(n, minTick) });
  };

  const type = t.orderType;
  const isMore = !MAIN_ORDER_TYPES.includes(type);
  const sideLock = modifying != null ? m.locked.side : null;
  // The optional limit of midprice / relative / pegged orders: a buy's cap, a sell's floor.
  const capLabel = buy ? m.capLabel : m.floorLabel;
  const noCap = buy ? m.noCap : m.noFloor;
  const main: MainPrice =
    type === 'MKT' || type === 'MTL'
      ? { key: null, readOnly: m.market }
      : type === 'MOC'
        ? { key: null, readOnly: m.atClose }
        : type === 'LMT' || type === 'LOC'
          ? { key: 'limitPrice', value: model.limit }
          : type === 'MIDPRICE'
            ? { key: 'limitPrice', value: model.limit, placeholder: noCap }
            : type === 'REL' || type === 'SNAP MID' || type === 'SNAP MKT' || type === 'PEG MID'
              ? { key: 'offset', value: model.offset }
              : { key: 'stopPrice', value: model.stop };
  const mainLabel = type === 'REL' && t.offsetMode === 'pct' ? `${m.priceLabels[type]} %` : type === 'MIDPRICE' ? capLabel : m.priceLabels[type];
  const issue = q?.error ?? (connected ? feedIssue : undefined);
  const showIssue = issue != null && market.bid == null && market.ask == null;
  const problem = tradable ? timingProblem(timing, now) : null;
  const timingIssue = tradable ? (tifLock(t.tif) ?? (problem ? m.problems[problem] : null)) : null;
  const combo = tradable && !timingIssue ? combinationProblem(input) : null;
  const est = tradable ? model.est : undefined;
  const cashSized = t.cashQtyOn && symbol.secType === 'CASH';

  // What the Advanced section holds when something in it is on.
  const { request: composed, error: composeError } = composeOrder(input);
  // Nothing left to type and no rule broken (what `submit` checks): only then is IB's what-if asked.
  const complete = composeError == null && orderProblems(composed, input.rules).length === 0;
  const advancedItems = [
    ...(session !== 'regular' ? [c.sessions[session]] : []),
    ...(composed.bracket ? [m.tpSlShort] : []),
    ...(composed.conditions ? [m.condShort(composed.conditions.items.length)] : []),
    ...attributeFlags(composed, m.attr, clock, true),
    ...(composed.goodAfterTime ? [m.extras.goodAfter(clock.wall(composed.goodAfterTime, { zone: 'ET' })).replace(/^ · /, '')] : []),
  ];

  return {
    origin,
    m,
    c,
    clock,
    tifHints,
    sessionHints,
    symbol,
    t,
    patch,
    q,
    info,
    refContract,
    market,
    model,
    minTick,
    now,
    session,
    goodTill,
    timing,
    modifying,
    modifiedOrder,
    ocaGroups,
    input,
    choices,
    ruleText,
    unavailable,
    tifLock,
    tifWhy,
    typeWhy,
    openWhy,
    tradable,
    buy,
    label,
    submit,
    setSide,
    setType,
    setPrice,
    commitPrice,
    type,
    isMore,
    sideLock,
    capLabel,
    noCap,
    main,
    mainLabel,
    issue,
    showIssue,
    timingIssue,
    combo,
    est,
    cashSized,
    composed,
    complete,
    advancedItems,
  };
}
