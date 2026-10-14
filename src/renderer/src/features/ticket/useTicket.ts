// The order ticket's state, rules and actions in one place: the docked ticket (OrderTicket) and
// the floating ticket (features/panels/TicketFloat) lay out the same parts (parts.tsx) on
// top of this controller, so validation, keyboard handling and the submit flow stay single-sourced.
// Submitting opens the review (state/orderActions.ts → submitOrder) with what the review needs
// beyond the order: how current the prices are, the pre-trade risks (orderRisk.ts) and, for a
// modify, the order as it works now (before → after).

import { useMemo } from 'react';
import { contractLabel, isTradable, multiplierOf } from '@shared/contract';
import { roundToTick } from '@shared/format';
import { isTimingProblem, sessionOf, tifChangeAllowed, timingProblem, unavailableReason, type TimingField, type TimingInput } from '@shared/orderTiming';
import { algoInfo, algoParamProblem, isOrderProblem, MAIN_ORDER_TYPES, orderProblems, type OrderField, type OrderProblem, type OrderRulesContext } from '@shared/orderRules';
import { isOrderActive, type ContractRef, type OrderAction, type OrderType, type TimeInForce } from '@shared/types';
import { lastPrice, useQuote, useQuoteSubscriptions } from '../../hooks/useQuotes';
import { useClock } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { useConnectedOrders } from '../../state/connectedLists';
import { submitOrder } from '../../state/orderActions';
import { isPanelSending } from '../../state/orderFeedback';
import { useStore, type TicketState } from '../../state/store';
import { attributeFlags } from '../orders/attributes';
import { ticketPatchFromOrder } from '../orders/model';
import type { PanelId } from '../panels/model';
import { buildOrderRequest, choiceProblem, combinationProblem, composeOrder, pendingOrder, type ModifyBase, type OrderInput, type ReviewLabels, type TicketError } from './buildOrder';
import type { Choices } from './controls';
import { useTicketM } from './messages';
import { accountRiskContext, marketDataOf, orderRisks } from './orderRisk';
import { conditionContract, limitFromQuote, positive, resolveTicket, type TicketMarket } from './ticketModel';
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
  const myClientId = useStore((s) => s.connection.clientId);
  const orders = useConnectedOrders();
  // The order being modified keeps its session (IB refuses to move it); the ticket shows that one.
  // Its TIF can only change between DAY and GTC, or to IOC (tifChangeAllowed).
  const modifyingOrderId = useStore((s) => s.ticket.modifyingOrderId);
  const modifiedOrder = useMemo(
    () => (modifyingOrderId == null ? undefined : orders.find((o) => o.orderId === modifyingOrderId && o.clientId === myClientId)),
    [orders, modifyingOrderId, myClientId],
  );
  // OCA groups of this client's working orders, offered when an order joins a group.
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
  /** How current the instrument's prices are: the quote boxes tag anything but live, the review warns. */
  const marketData = marketDataOf(q);

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
    filled: { label: c.filled, text: c.filledOf },
  };

  const errorText = (e: TicketError, contract: ContractRef, ticket: TicketState): string => {
    if (e === 'index') return c.indexNotTradable(contract.symbol);
    if (isTimingProblem(e)) return m.problems[e];
    if (e === 'algoParam') {
      // Name the parameter: "Check the algo parameter “Max % volume”".
      const algo = composeOrder({ ...input, contract, ticket }).request.algo;
      const tag = algo ? algoParamProblem(algo) : null;
      if (algo && tag) {
        const name = m.attr.algoParams[tag] ?? tag;
        // A time may lack its AM / PM on the 12-hour clock, as the good-after time may.
        const time = algoInfo(algo.strategy)?.params.find((p) => p.tag === tag)?.kind === 'time';
        return time && clock.format === '12h' ? m.algoTime12h(name) : m.algoParamProblem(name);
      }
    }
    if (isOrderProblem(e)) return ruleText(e);
    if (e === 'gat' && clock.format === '12h') return m.gat12h;
    return m.errors[e as keyof typeof m.errors];
  };

  const submit = () => {
    // This ticket's order (a floating panel's, or docked: the docked ticket's or builder's) still
    // waits for IB: its button is disabled, and ⏎ must not send again.
    if (isPanelSending(origin)) return;
    const s = useStore.getState();
    // A modify needs the order still working: one that has filled, been cancelled or gone meanwhile,
    // or that IB's last list left out (not reported: it has ended), has nothing left to modify (and
    // the review would compare with nothing).
    const modifyId = s.ticket.modifyingOrderId;
    if (modifyId != null && (!modifiedOrder || !isOrderActive(modifiedOrder.status) || modifiedOrder.notReported)) {
      s.showToast(c.orderNotWorking(modifyId), 'error');
      return;
    }
    const locked = tifLock(s.ticket.tif);
    if (locked) {
      s.showToast(locked, 'error');
      return;
    }
    const base = { contract: s.symbol, market, hours: info, timeFormat: clock.format, rules };
    const res = buildOrderRequest({ ...base, ticket: { ...s.ticket, session } });
    if (!res.ok) {
      s.showToast(errorText(res.error, s.symbol, { ...s.ticket, session }), 'error');
      return;
    }
    // The order as "Modify" loaded it, through the same rules: what the review compares with.
    let modify: ModifyBase | null = null;
    if (modifyId != null && modifiedOrder) {
      const before = composeOrder({ ...base, ticket: { ...s.ticket, ...ticketPatchFromOrder(modifiedOrder), session } });
      modify = { order: modifiedOrder, request: before.request, model: before.model };
    }
    // A modify goes to the order's own account (another of the login's may be the connected one):
    // the review names it, and the checks use its position and values.
    const account = modifiedOrder?.account;
    // The pre-trade checks against this account's position and values, and whether the limit is the
    // quote's (followed or filled from it) rather than typed.
    const risks = orderRisks(res.request, res.model.est, {
      ...accountRiskContext(s, s.symbol, account ?? s.connection.account),
      bid: market.bid,
      ask: market.ask,
      last: market.last,
      marketData,
      priceFromQuote: limitFromQuote(s.ticket),
      ...(modifiedOrder ? { modified: { quantity: modifiedOrder.totalQuantity, filled: modifiedOrder.filled } } : {}),
    });
    submitOrder({ ...pendingOrder(res.request, res.model, labels, market, modify), marketData, ...(risks.length ? { risks } : {}), ...(account ? { account } : {}), origin });
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
  const cashSized = t.cashQtyOn && symbol.secType === 'CASH';

  // What the Advanced section holds when something in it is on.
  const { request: composed, model: composedModel, error: composeError } = composeOrder(input);
  // The amount as the order is sent (a forex order sized by an amount is worth that amount).
  const est = tradable ? composedModel.est : undefined;
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
    marketData,
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
