// Order ticket (design 3a, right column of the Trade page). Its state lives in store.ticket so the
// depth view, "Modify" and the command bar can prefill it; prices nobody typed follow the market.

import { useMemo, useState, type CSSProperties } from 'react';
import { contractLabel, isTradable, multiplierOf } from '@shared/contract';
import { f0, roundToTick } from '@shared/format';
import type { ContractRef, OrderAction, OrderType, TimeInForce } from '@shared/types';
import { lastPrice, useQuote, useQuoteSubscriptions } from '../../hooks/useQuotes';
import { useCommon } from '../../i18n/common';
import { submitOrder } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { Chip } from '../../ui/primitives';
import { AdvancedPanel } from './AdvancedPanel';
import { buildOrderRequest, pendingOrder, type ReviewLabels } from './buildOrder';
import { FieldBox, NumberField, TextField } from './fields';
import { useTicketM, type TicketMessages } from './messages';
import { buyingPowerAfter, conditionContract, money, positive, priceInput, priceText, resolveTicket, stepQty, type TicketMarket } from './ticketModel';
import { useContractInfo } from './useContractInfo';
import { useTicketKeys } from './useTicketKeys';

const ORDER_TYPES: OrderType[] = ['LMT', 'MKT', 'STP', 'STP LMT', 'TRAIL'];
const TIFS: TimeInForce[] = ['DAY', 'GTC', 'IOC', 'OPG'];

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

export function OrderTicket() {
  const m = useTicketM();
  const c = useCommon();
  const symbol = useStore((s) => s.symbol);
  const t = useStore((s) => s.ticket);
  const patch = useStore((s) => s.patchTicket);
  const buyingPower = useStore((s) => s.account?.buyingPower);
  const accountCurrency = useStore((s) => s.account?.currency);
  const connected = useStore((s) => s.connection.status === 'connected');
  const feedIssue = useStore((s) => s.connection.marketDataIssue);

  const refContract = useMemo(() => conditionContract(symbol), [symbol]);
  const subs = useMemo(() => [symbol, refContract], [symbol, refContract]);
  useQuoteSubscriptions('ticket', subs, 'basic');
  const q = useQuote(symbol);
  const refQ = useQuote(refContract);
  const info = useContractInfo(symbol);
  const refInfo = useContractInfo(refContract);

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
  const [lmtFocus, setLmtFocus] = useState(false);

  const tradable = isTradable(symbol);
  const buy = t.side === 'BUY';
  const label = contractLabel(symbol);
  const modifying = t.modifyingOrderId;
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
    units: m.units,
    extras: m.extras,
  };

  const submit = () => {
    const s = useStore.getState();
    const res = buildOrderRequest({ contract: s.symbol, ticket: s.ticket, market });
    if (!res.ok) {
      s.showToast(res.error === 'index' ? c.indexNotTradable(s.symbol.symbol) : m.errors[res.error], 'error');
      return;
    }
    submitOrder(pendingOrder(res.request, res.model, labels, market, s.ticket.modifyingOrderId));
  };
  useTicketKeys(submit);

  // Changing side or type drops typed prices: their defaults depend on both.
  const setSide = (side: OrderAction) => patch({ side, limitPrice: null, stopPrice: null });
  const setType = (orderType: OrderType) => patch({ orderType, limitPrice: null, stopPrice: null });
  const setPrice = (key: 'limitPrice' | 'stopPrice', n: number | null) => patch(key === 'limitPrice' ? { limitPrice: n } : { stopPrice: n });
  // Typed prices snap to the instrument's tick when the field is left.
  const commitPrice = (key: 'limitPrice' | 'stopPrice') => (n: number | null) => {
    if (n != null) setPrice(key, roundToTick(n, minTick));
  };

  const isMkt = t.orderType === 'MKT';
  const mainPrice = t.orderType === 'LMT' ? model.limit : model.stop;
  const mainKey: 'limitPrice' | 'stopPrice' = t.orderType === 'LMT' ? 'limitPrice' : 'stopPrice';
  const issue = q?.error ?? (connected ? feedIssue : undefined);
  const showIssue = issue != null && market.bid == null && market.ask == null;
  const est = tradable ? model.est : undefined;
  const bpAfter = tradable ? buyingPowerAfter({ buyingPower, currency: accountCurrency }, est, symbol.currency, buy) : undefined;
  const qtyText = f0(t.qty);

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

      <div style={{ flex: 1, overflow: 'auto', padding: '18px 24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {!tradable && (
          <div style={{ padding: '10px 12px', background: 'var(--p2)', fontSize: 12, lineHeight: 1.5, color: 'var(--mu)' }}>{c.indexNotTradable(symbol.symbol)}</div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontVariantNumeric: 'tabular-nums', ...lock }}>
          <div
            onClick={() => setSide('SELL')}
            style={{
              padding: '10px 12px',
              background: 'var(--p2)',
              cursor: 'pointer',
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
            onClick={() => setSide('BUY')}
            style={{
              padding: '10px 12px',
              background: 'var(--p2)',
              cursor: 'pointer',
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
            return (
              <div
                key={side}
                onClick={() => setSide(side)}
                style={{
                  height: 36,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: on ? (side === 'BUY' ? 'var(--up)' : 'var(--dn)') : 'transparent',
                  color: on ? 'var(--btnTx)' : 'var(--mu)',
                }}
              >
                {side === 'BUY' ? c.buy : c.sell}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 4, ...lock }}>
          {ORDER_TYPES.map((k) => (
            <div
              key={k}
              onClick={() => setType(k)}
              style={{
                flex: 1,
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                boxShadow: `inset 0 0 0 1px ${t.orderType === k ? 'var(--ac)' : 'var(--ln)'}`,
                color: t.orderType === k ? 'var(--tx)' : 'var(--mu)',
              }}
            >
              {m.orderTypes[k]}
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, ...lock }}>
          <div style={column6}>
            <div style={label12}>{c.qty}</div>
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
          </div>
          <div style={column6}>
            <div style={label12}>{m.priceLabels[t.orderType]}</div>
            <FieldBox focused={pxFocus}>
              <NumberField
                readOnly={isMkt}
                display={isMkt ? m.market : mainPrice != null ? priceText(mainPrice, minTick) : ''}
                edit={priceInput(mainPrice, minTick)}
                placeholder="—"
                onInput={(n) => setPrice(mainKey, n)}
                onCommit={commitPrice(mainKey)}
                onFocusChange={setPxFocus}
                style={{ padding: '0 12px', textAlign: 'right', ...priceFont, color: isMkt ? 'var(--dm)' : 'var(--tx)' }}
              />
            </FieldBox>
          </div>
        </div>

        {t.orderType === 'TRAIL' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, ...lock }}>
              <div style={column6}>
                <div style={label12}>{m.trailBy}</div>
                <div style={{ display: 'flex', background: 'var(--p2)', padding: 2 }}>
                  {(['pct', 'amt'] as const).map((k) => (
                    <div
                      key={k}
                      onClick={() => patch({ trailMode: k, stopPrice: null })}
                      style={{
                        flex: 1,
                        height: 30,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        cursor: 'pointer',
                        background: t.trailMode === k ? 'var(--p)' : 'transparent',
                        color: t.trailMode === k ? 'var(--tx)' : 'var(--dm)',
                      }}
                    >
                      {k === 'pct' ? '%' : '$'}
                    </div>
                  ))}
                </div>
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
            <div style={{ fontSize: 11, color: 'var(--dm)', ...lock }}>{m.trailHint(priceText(model.stop, minTick))}</div>
          </>
        )}

        {t.orderType === 'STP LMT' && (
          <FieldBox focused={lmtFocus} style={{ justifyContent: 'space-between', gap: 12, padding: '0 12px', ...lock }}>
            <div style={{ ...label12, flexShrink: 0 }}>{m.limit}</div>
            <NumberField
              display={model.limit != null ? priceText(model.limit, minTick) : ''}
              edit={priceInput(model.limit, minTick)}
              placeholder="—"
              onInput={(n) => patch({ limitPrice: n })}
              onCommit={commitPrice('limitPrice')}
              onFocusChange={setLmtFocus}
              style={{ textAlign: 'right', ...priceFont }}
            />
          </FieldBox>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...lock }}>
          <div style={label12}>{c.tif}</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {TIFS.map((k) => (
              <Chip key={k} active={t.tif === k} onClick={() => patch({ tif: k })}>
                {k}
              </Chip>
            ))}
          </div>
        </div>

        <div
          onClick={() => patch({ advancedOpen: !t.advancedOpen })}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', fontSize: 13, color: 'var(--mu)', padding: '4px 0', ...lock }}
        >
          <div>{m.advanced}</div>
          <div style={{ flexShrink: 0 }}>{t.advancedOpen ? m.collapse : m.expand}</div>
        </div>
        {t.advancedOpen && (
          <div style={lock}>
            <AdvancedPanel t={t} model={model} patch={patch} refSymbol={contractLabel(refContract)} modifying={modifying != null} />
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
            {modifying != null ? m.modify(modifying) : m.submit(buy ? c.buy : c.sell, m.units(f0(t.qty), symbol.secType), label)}
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
