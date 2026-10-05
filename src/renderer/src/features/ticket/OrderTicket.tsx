// Order ticket (design 3a, right column of the Trade page). Its state lives in store.ticket so the
// depth view, "Modify" and the command bar can prefill it; prices nobody typed follow the market.

import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { contractLabel, isTradable, multiplierOf } from '@shared/contract';
import { f0, roundToTick } from '@shared/format';
import {
  isTimingProblem,
  NEW_YORK,
  sessionOf,
  TIME_IN_FORCES,
  tifChangeAllowed,
  timingProblem,
  unavailableReason,
  zonedParts,
  type TimingField,
  type TimingInput,
} from '@shared/orderTiming';
import { algoParamProblem, isOrderProblem, MAIN_ORDER_TYPES, ORDER_TYPE_GROUPS, type OrderField, type OrderProblem, type OrderRulesContext } from '@shared/orderRules';
import type { ContractRef, OrderAction, OrderType, TimeInForce } from '@shared/types';
import { lastPrice, useQuote, useQuoteSubscriptions } from '../../hooks/useQuotes';
import { useClock } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { submitOrder } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { Chip } from '../../ui/primitives';
import { attributeFlags } from '../orders/attributes';
import { AdvancedPanel } from './AdvancedPanel';
import { buildOrderRequest, choiceProblem, combinationProblem, composeOrder, pendingOrder, type OrderInput, type ReviewLabels, type TicketError } from './buildOrder';
import { Dropdown, MenuChoice, MenuHeading, unavailableStyle, type Choices } from './controls';
import { DateTimeField, FieldBox, NumberField, TextField } from './fields';
import { useTicketM, type TicketMessages } from './messages';
import { buyingPowerAfter, conditionContract, isTrailing, money, positive, priceInput, priceText, resolveTicket, stepQty, type TicketMarket } from './ticketModel';
import { goodTillTime, ticketTiming, toLocalInput } from './timing';
import { useContractInfo } from './useContractInfo';
import { useTicketKeys } from './useTicketKeys';

const label12: CSSProperties = { fontSize: 12, color: 'var(--dm)' };
const column6: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const priceFont: CSSProperties = { font: '500 15px/1 var(--num)', fontVariantNumeric: 'tabular-nums' };

function kindLabel(c: ContractRef, common: ReturnType<typeof useCommon>, m: TicketMessages): string {
  switch (c.secType) {
    case 'STK':
      return common.stock;
    case 'OPT':
    case 'FOP':
      return common.option;
    case 'IND':
      return common.index;
    case 'FUT':
      return m.future;
    default:
      return c.secType;
  }
}

const sizeText = (n: number | undefined) => (n != null && n >= 0 ? f0(n) : '—');

/**
 * The qty input between the ± buttons is 72px wide when the ticket shows its scrollbar, and mono
 * digits are 0.6em wide: 15px fits "100,000", longer quantities shrink so no digit is clipped.
 */
const qtyFontSize = (text: string) => Math.max(10, Math.min(15, Math.floor(118 / text.length)));

/** A boxed price row: label on the left, the number on the right (stop-limit limit, offsets, caps). */
function PriceRow({
  label,
  display,
  edit,
  placeholder,
  onInput,
  onCommit,
  style,
}: {
  label: string;
  display: string;
  edit: string;
  placeholder?: string;
  onInput: (n: number | null) => void;
  onCommit?: (n: number | null) => void;
  style?: CSSProperties;
}) {
  const [focus, setFocus] = useState(false);
  return (
    <FieldBox focused={focus} style={{ justifyContent: 'space-between', gap: 12, padding: '0 12px', flexShrink: 0, ...style }}>
      <div style={{ ...label12, flexShrink: 0 }}>{label}</div>
      <NumberField display={display} edit={edit} placeholder={placeholder ?? '—'} onInput={onInput} onCommit={onCommit} onFocusChange={setFocus} style={{ textAlign: 'right', ...priceFont }} />
    </FieldBox>
  );
}

/** A two-way segmented switch (trail by % or $, offset by % or $). */
function PctAmt({ value, onChange, lock }: { value: 'pct' | 'amt'; onChange: (v: 'pct' | 'amt') => void; /** Why the mode cannot change. */ lock?: string | null }) {
  return (
    <div style={{ display: 'flex', background: 'var(--p2)', padding: 2 }} title={lock ?? undefined}>
      {(['pct', 'amt'] as const).map((k) => (
        <div
          key={k}
          onClick={lock || value === k ? undefined : () => onChange(k)}
          aria-disabled={!!lock && value !== k}
          style={{
            opacity: lock && value !== k ? 0.4 : 1,
            flex: 1,
            height: 30,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            cursor: lock && value !== k ? 'not-allowed' : 'pointer',
            background: value === k ? 'var(--p)' : 'transparent',
            color: value === k ? 'var(--tx)' : 'var(--dm)',
          }}
        >
          {k === 'pct' ? '%' : '$'}
        </div>
      ))}
    </div>
  );
}

export function OrderTicket() {
  const m = useTicketM();
  const c = useCommon();
  const clock = useClock();
  const tifHints = m.tifHints(clock);
  const sessionHints = m.sessionHints(clock);
  const symbol = useStore((s) => s.symbol);
  const t = useStore((s) => s.ticket);
  const patch = useStore((s) => s.patchTicket);
  const buyingPower = useStore((s) => s.account?.buyingPower);
  const accountCurrency = useStore((s) => s.account?.currency);
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

  const [qtyFocus, setQtyFocus] = useState(false);
  const [pxFocus, setPxFocus] = useState(false);
  const [gtdFocus, setGtdFocus] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);

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
    rule: (p: Partial<typeof t>, field: OrderField) => {
      const why = choiceProblem(input, p, field);
      return why ? ruleText(why) : null;
    },
  };
  /** Why IB would refuse to change the modified order to this TIF (null: it would not). */
  const tifLock = (k: TimeInForce): string | null => (modifiedOrder && !tifChangeAllowed(modifiedOrder.tif, k) ? m.tifLocked(modifiedOrder.tif) : null);
  /** Why an order type cannot be chosen: a working order keeps its type; then the timing and order rules. */
  const typeWhy = (k: OrderType, extra: Partial<typeof t> = {}): string | null => {
    if (modifying != null && k !== t.orderType) return m.locked.orderType;
    return unavailable('orderType', k) ?? choices.rule({ orderType: k, limitPrice: null, stopPrice: null, ...extra }, 'orderType');
  };
  /** Market / limit on open: the type, then TIF OPG with that type. */
  const openWhy = (k: 'MKT' | 'LMT'): string | null => {
    const opg = unavailableReason({ ...timing, orderType: k }, 'tif', 'OPG');
    return typeWhy(k, { tif: 'OPG' }) ?? tifLock('OPG') ?? (opg ? m.problems[opg] : null);
  };

  const tradable = isTradable(symbol);
  const buy = t.side === 'BUY';
  const label = contractLabel(symbol);
  const lock: CSSProperties | undefined = tradable ? undefined : { opacity: 0.4, pointerEvents: 'none' };

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

  const errorText = (e: TicketError, contract: ContractRef, ticket: typeof t): string => {
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
    submitOrder(pendingOrder(res.request, res.model, labels, market, s.ticket.modifyingOrderId));
  };
  useTicketKeys(submit);

  // Changing side or type drops typed prices: their defaults depend on both.
  const setSide = (side: OrderAction) => patch({ side, limitPrice: null, stopPrice: null, limitOffset: null });
  const setType = (orderType: OrderType, extra: Partial<typeof t> = {}) => {
    setMoreOpen(false);
    patch({ orderType, limitPrice: null, stopPrice: null, limitOffset: null, ...extra });
  };
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
  /** The main price box: limit, trigger / initial stop, cap or offset, or a read-only market. */
  const main: { key: 'limitPrice' | 'stopPrice' | 'offset' | null; value?: number; readOnly?: string; placeholder?: string } =
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
  const bpAfter = tradable ? buyingPowerAfter({ buyingPower, currency: accountCurrency }, est, symbol.currency, buy) : undefined;
  const qtyText = f0(t.qty);
  const cashSized = t.cashQtyOn && symbol.secType === 'CASH';

  // What the Advanced section holds when something in it is on.
  const composed = composeOrder(input).request;
  const advancedItems = [
    ...(session !== 'regular' ? [c.sessions[session]] : []),
    ...(composed.bracket ? [m.tpSlShort] : []),
    ...(composed.conditions ? [m.condShort(composed.conditions.items.length)] : []),
    ...attributeFlags(composed, m.attr, clock, true),
    ...(composed.goodAfterTime ? [m.extras.goodAfter(clock.wall(composed.goodAfterTime, { zone: 'ET' })).replace(/^ · /, '')] : []),
  ];

  return (
    <div style={{ gridColumn: 2, gridRow: '1 / 3', background: 'var(--p)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        style={{
          height: 52,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '0 24px',
          boxShadow: 'inset 0 -1px 0 var(--ln2)',
          flexShrink: 0,
        }}
      >
        <div className="ellipsis" style={{ fontWeight: 600 }}>
          {m.title(label)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--dm)', flexShrink: 0 }}>{kindLabel(symbol, c, m)}</div>
      </div>

      <div className="ticket-body" style={{ flex: 1, overflow: 'auto', padding: '18px 24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {!tradable && (
          <div style={{ padding: '10px 12px', background: 'var(--p2)', fontSize: 12, lineHeight: 1.5, color: 'var(--mu)' }}>{c.indexNotTradable(symbol.symbol)}</div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontVariantNumeric: 'tabular-nums', ...lock }}>
          <div
            onClick={sideLock ? undefined : () => setSide('SELL')}
            title={sideLock && buy ? sideLock : undefined}
            style={{
              padding: '10px 12px',
              background: 'var(--p2)',
              cursor: sideLock ? 'default' : 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              boxShadow: buy ? 'none' : 'inset 0 0 0 1px var(--dn)',
            }}
          >
            <div style={label12}>
              {m.bid} × {sizeText(q?.bidSize)}
            </div>
            <div className="selectable" style={{ font: '600 17px/1 var(--num)', color: 'var(--dn)' }}>
              {priceText(market.bid, minTick)}
            </div>
          </div>
          <div
            onClick={sideLock ? undefined : () => setSide('BUY')}
            title={sideLock && !buy ? sideLock : undefined}
            style={{
              padding: '10px 12px',
              background: 'var(--p2)',
              cursor: sideLock ? 'default' : 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              alignItems: 'flex-end',
              boxShadow: buy ? 'inset 0 0 0 1px var(--up)' : 'none',
            }}
          >
            <div style={label12}>
              {m.ask} × {sizeText(q?.askSize)}
            </div>
            <div className="selectable" style={{ font: '600 17px/1 var(--num)', color: 'var(--up)' }}>
              {priceText(market.ask, minTick)}
            </div>
          </div>
        </div>
        {showIssue && (
          <div className="ellipsis" title={issue.message} style={{ fontSize: 11, color: 'var(--dm)', marginTop: -8 }}>
            {m.noMarketData(issue.code)} · {issue.message}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', background: 'var(--p2)', padding: 3, ...lock }}>
          {(['BUY', 'SELL'] as const).map((side) => {
            const on = t.side === side;
            const why = on ? null : sideLock;
            return (
              <div
                key={side}
                onClick={why ? undefined : () => setSide(side)}
                title={why ?? undefined}
                style={{
                  height: 36,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 600,
                  cursor: why ? 'not-allowed' : 'pointer',
                  background: on ? (side === 'BUY' ? 'var(--up)' : 'var(--dn)') : 'transparent',
                  color: on ? 'var(--btnTx)' : 'var(--mu)',
                  ...(why ? { opacity: 0.5 } : undefined),
                }}
              >
                {side === 'BUY' ? c.buy : c.sell}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...lock }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {MAIN_ORDER_TYPES.map((k) => {
              const why = k === type ? null : typeWhy(k);
              return (
                <div
                  key={k}
                  onClick={why ? undefined : () => setType(k)}
                  title={why ? `${m.typeHints[k]}\n${m.unavailable(why)}` : m.typeHints[k]}
                  style={{
                    flex: '1 1 auto',
                    height: 32,
                    padding: '0 4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                    boxShadow: `inset 0 0 0 1px ${type === k ? 'var(--ac)' : 'var(--ln)'}`,
                    color: type === k ? 'var(--tx)' : 'var(--mu)',
                    ...(why ? unavailableStyle : undefined),
                  }}
                >
                  {m.orderTypes[k]}
                </div>
              );
            })}
            <div
              ref={moreRef}
              role="button"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
              title={isMore ? `${m.orderTypes[type]} (${type})` : undefined}
              style={{
                flex: '1 1 auto',
                height: 32,
                padding: '0 6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                fontSize: 12,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                boxShadow: `inset 0 0 0 1px ${isMore || moreOpen ? 'var(--ac)' : 'var(--ln)'}`,
                color: isMore ? 'var(--tx)' : 'var(--mu)',
              }}
            >
              {m.more}
              <span style={{ fontSize: 12, lineHeight: 1, color: 'var(--dm)' }}>▾</span>
            </div>
          </div>
          {isMore && (
            <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--dm)' }}>
              <span style={{ color: 'var(--mu)' }}>{m.orderTypes[type]}</span> · {m.typeHints[type]}
            </div>
          )}
        </div>
        {moreOpen && (
          <Dropdown anchor={moreRef.current} width={292} onClose={() => setMoreOpen(false)}>
            {ORDER_TYPE_GROUPS.map((g) => (
              <div key={g.id}>
                <MenuHeading>{m.typeGroups[g.id]}</MenuHeading>
                {g.types.map((k) => (
                  <MenuChoice
                    key={k}
                    active={type === k}
                    why={k === type ? null : typeWhy(k)}
                    hint={m.typeHints[k]}
                    onPick={() => setType(k)}
                    label={
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span>{m.orderTypes[k]}</span>
                        <span style={{ font: '11px/1.4 var(--mono)', color: 'var(--dm)' }}>{k}</span>
                      </div>
                    }
                  />
                ))}
                {g.id === 'auction' &&
                  (['MKT', 'LMT'] as const).map((k) => (
                    <MenuChoice
                      key={`open-${k}`}
                      active={type === k && t.tif === 'OPG'}
                      why={type === k && t.tif === 'OPG' ? null : openWhy(k)}
                      hint={m.openHint}
                      onPick={() => setType(k, { tif: 'OPG' })}
                      label={
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span>{k === 'MKT' ? m.moo : m.loo}</span>
                          <span style={{ font: '11px/1.4 var(--mono)', color: 'var(--dm)' }}>{k} · OPG</span>
                        </div>
                      }
                    />
                  ))}
              </div>
            ))}
          </Dropdown>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, ...lock }}>
          <div style={column6}>
            <div style={label12}>{cashSized ? m.amount : c.qty}</div>
            {cashSized ? (
              <FieldBox focused={qtyFocus}>
                <TextField value={t.cashQty} onChange={(v) => patch({ cashQty: v.replace(/[^\d.,]/g, '') })} style={{ height: 38, boxShadow: 'none', ...priceFont, textAlign: 'center' }} />
              </FieldBox>
            ) : (
              <FieldBox focused={qtyFocus}>
                <div
                  onClick={() => patch({ qty: stepQty(t.qty, -1) })}
                  className="hover-tx"
                  style={{ width: 32, height: '100%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--mu)' }}
                >
                  −
                </div>
                <NumberField
                  integer
                  display={qtyText}
                  edit={Number.isFinite(t.qty) ? String(t.qty) : ''}
                  title={qtyText}
                  onInput={(n) => n != null && patch({ qty: Math.round(n) })}
                  onFocusChange={setQtyFocus}
                  style={{ flex: 1, textAlign: 'center', ...priceFont, font: `500 ${qtyFontSize(qtyText)}px/1 var(--num)`, textOverflow: 'ellipsis' }}
                />
                <div
                  onClick={() => patch({ qty: stepQty(t.qty, 1) })}
                  className="hover-tx"
                  style={{ width: 32, height: '100%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--mu)' }}
                >
                  +
                </div>
              </FieldBox>
            )}
          </div>
          <div style={column6}>
            <div style={label12}>{mainLabel}</div>
            <FieldBox focused={pxFocus}>
              {main.key == null ? (
                <NumberField readOnly display={main.readOnly ?? ''} edit="" onInput={() => {}} style={{ padding: '0 12px', textAlign: 'right', ...priceFont, color: 'var(--dm)' }} />
              ) : main.key === 'offset' ? (
                <NumberField
                  display={t.orderType === 'REL' && t.offsetMode === 'pct' ? String(model.offset) : priceText(model.offset, minTick)}
                  edit={String(model.offset)}
                  placeholder="0"
                  onInput={(n) => patch({ offset: n })}
                  onFocusChange={setPxFocus}
                  style={{ padding: '0 12px', textAlign: 'right', ...priceFont }}
                />
              ) : (
                <NumberField
                  display={main.value != null ? priceText(main.value, minTick) : ''}
                  edit={priceInput(main.value, minTick)}
                  placeholder={main.placeholder ?? '—'}
                  onInput={(n) => setPrice(main.key as 'limitPrice' | 'stopPrice', n)}
                  onCommit={commitPrice(main.key)}
                  onFocusChange={setPxFocus}
                  style={{ padding: '0 12px', textAlign: 'right', ...priceFont }}
                />
              )}
            </FieldBox>
          </div>
        </div>

        {isTrailing(type) && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, ...lock }}>
              <div style={column6}>
                <div style={label12}>{m.trailBy}</div>
                <PctAmt value={t.trailMode} onChange={(k) => patch({ trailMode: k, stopPrice: null })} />
              </div>
              <div style={column6}>
                <div style={label12}>{t.trailMode === 'pct' ? m.trailPct : m.trailAmt}</div>
                <TextField
                  value={t.trailAmt}
                  onChange={(v) => patch({ trailAmt: v.replace(/[^\d.]/g, ''), stopPrice: null })}
                  style={{ padding: '0 12px', font: '500 14px/1 var(--num)' }}
                />
              </div>
            </div>
            {(type === 'TRAIL LIMIT' || type === 'TRAIL LIT') && (
              <PriceRow
                label={m.limitOffset}
                display={model.limitOffset != null ? priceText(model.limitOffset, minTick) : ''}
                edit={priceInput(model.limitOffset, minTick)}
                onInput={(n) => patch({ limitOffset: n })}
                onCommit={commitPrice('limitOffset')}
                style={lock}
              />
            )}
            <div style={{ fontSize: 11, color: 'var(--dm)', ...lock }}>{(type === 'TRAIL MIT' || type === 'TRAIL LIT' ? m.trailTouchedHint : m.trailHint)(priceText(model.stop, minTick))}</div>
          </>
        )}

        {(type === 'STP LMT' || type === 'LIT') && (
          <PriceRow
            label={m.limit}
            display={model.limit != null ? priceText(model.limit, minTick) : ''}
            edit={priceInput(model.limit, minTick)}
            onInput={(n) => patch({ limitPrice: n })}
            onCommit={commitPrice('limitPrice')}
            style={lock}
          />
        )}

        {type === 'REL' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, ...lock }}>
            <div style={column6}>
              <div style={label12}>{m.offsetBy}</div>
              <PctAmt value={t.offsetMode === 'pct' ? 'pct' : 'amt'} onChange={(k) => patch({ offsetMode: k, offset: null })} lock={modifying != null ? m.locked.offsetMode : null} />
            </div>
            <div style={column6}>
              <div style={label12}>{capLabel}</div>
              <PriceRow
                label=""
                display={model.limit != null ? priceText(model.limit, minTick) : ''}
                edit={priceInput(model.limit, minTick)}
                placeholder={noCap}
                onInput={(n) => patch({ limitPrice: n })}
                onCommit={commitPrice('limitPrice')}
                style={{ height: 34 }}
              />
            </div>
          </div>
        )}
        {type === 'PEG MID' && (
          <PriceRow
            label={capLabel}
            display={model.limit != null ? priceText(model.limit, minTick) : ''}
            edit={priceInput(model.limit, minTick)}
            placeholder={noCap}
            onInput={(n) => patch({ limitPrice: n })}
            onCommit={commitPrice('limitPrice')}
            style={lock}
          />
        )}

        <div style={{ ...column6, ...lock }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div style={label12}>{c.tif}</div>
            {session !== 'regular' && (
              <div
                onClick={() => patch({ advancedOpen: true })}
                title={sessionHints[session]}
                className="ellipsis hover-tx"
                style={{ fontSize: 12, color: 'var(--mu)', cursor: 'pointer' }}
              >
                {c.sessions[session]}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {TIME_IN_FORCES.map((k) => {
              const why = k === t.tif ? null : (tifLock(k) ?? unavailable('tif', k) ?? choices.rule({ tif: k }, 'tif'));
              return (
                <Chip
                  key={k}
                  active={t.tif === k}
                  title={why ? `${tifHints[k]}\n${m.unavailable(why)}` : tifHints[k]}
                  onClick={why ? undefined : () => patch({ tif: k })}
                  style={{ flex: 1, padding: '6px 0', textAlign: 'center', ...(why ? unavailableStyle : undefined) }}
                >
                  {k}
                </Chip>
              );
            })}
          </div>
          {t.tif === 'GTD' && (
            <FieldBox focused={gtdFocus} style={{ justifyContent: 'space-between', gap: 12, padding: '0 12px' }}>
              <div style={{ ...label12, flexShrink: 0 }}>{m.goodTill}</div>
              <DateTimeField
                value={goodTill ? toLocalInput(goodTill) : ''}
                min={toLocalInput(zonedParts(now, NEW_YORK))}
                title={tifHints.GTD}
                onChange={(v) => patch({ goodTill: v })}
                onFocusChange={setGtdFocus}
              />
            </FieldBox>
          )}
          {timingIssue && <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--r)' }}>{timingIssue}</div>}
          {combo && (
            <div role="alert" style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--r)' }}>
              {ruleText(combo)}
            </div>
          )}
        </div>

        <div
          onClick={() => patch({ advancedOpen: !t.advancedOpen })}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', fontSize: 13, color: 'var(--mu)', padding: '4px 0', ...lock }}
        >
          <div className="ellipsis" title={advancedItems.length ? m.advancedOn(advancedItems) : undefined} style={{ minWidth: 0, color: advancedItems.length ? 'var(--tx)' : undefined }}>
            {advancedItems.length ? m.advancedOn(advancedItems) : m.advanced}
          </div>
          <div style={{ flexShrink: 0 }}>{t.advancedOpen ? m.collapse : m.expand}</div>
        </div>
        {t.advancedOpen && (
          <div style={lock}>
            <AdvancedPanel
              t={t}
              model={model}
              patch={patch}
              contract={symbol}
              refContract={refContract}
              timing={timing}
              choices={choices}
              request={composed}
              validExchanges={info?.validExchanges}
              ocaGroups={ocaGroups}
              now={now}
              modified={modifiedOrder}
            />
          </div>
        )}

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--mu)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>{c.estAmount}</div>
            <div className="num selectable" style={{ color: 'var(--tx)' }}>
              {money(est, symbol.currency)}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>{m.bpAfter}</div>
            <div className="num selectable" style={{ color: 'var(--tx)' }}>
              {f0(bpAfter)}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }}>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={submit}
            disabled={!tradable}
            style={{
              height: 46,
              flexShrink: 0,
              border: 'none',
              padding: '0 12px',
              background: buy ? 'var(--up)' : 'var(--dn)',
              color: 'var(--btnTx)',
              font: '600 15px/1 var(--sans)',
              cursor: tradable ? 'pointer' : 'not-allowed',
              opacity: tradable ? 1 : 0.4,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {modifying != null
              ? m.modify(modifying)
              : m.submit(buy ? c.buy : c.sell, cashSized ? `${t.cashQty} ${symbol.currency}` : m.units(f0(t.qty), symbol.secType), label)}
          </button>
          {modifying != null && (
            <div onClick={() => patch({ modifyingOrderId: null })} className="hover-tx" style={{ alignSelf: 'center', fontSize: 12, color: 'var(--dm)', cursor: 'pointer' }}>
              {m.cancelModify}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
