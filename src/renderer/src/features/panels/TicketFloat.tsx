// The order ticket as a floating panel. Narrower than LANDSCAPE_MIN_WIDTH it is the docked ticket
// (OrderTicket) under the panel's header; wider, the approved landscape layout in the order of
// work, built from the same parts and controller (ticket/parts.tsx, ticket/useTicket.ts):
//
//   header      Order · AAPL, name and exchange, last, change, session · collapse, dock back
//   market      bid / ask (a click fills the limit price) and the 5-level Book (Level 2 on; as docked)
//   entry       buy / sell, order type, quantity (chips), price (± one tick, bid / mid / ask), TIF, session
//   confirm     Advanced as one-line sections (scrolling), the status strip, then fixed: the totals
//               (with IBKR's what-if, as docked), the submit button
//
// After a submit the button reads "Submitting…" until IB answers and the status strip follows
// the order (OrderStrip); an accepted order collapses the panel to its bar (state/orderActions.ts).

import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { contractKey, isTradable } from '@shared/contract';
import { change, f0, px, signColor } from '@shared/format';
import { usEquitySession } from '@shared/session';
import { lastPrice, useQuote, useQuoteSubscriptions } from '../../hooks/useQuotes';
import { nameOf, useLang } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { isSending, useOrderFeedback } from '../../state/orderFeedback';
import { useStore } from '../../state/store';
import { useContractInfo as useChartContractInfo } from '../chart/contractInfo';
import { useChartMessages } from '../chart/messages';
import { sessionQuote, usesUsEquitySession } from '../chart/sessionQuote';
import { useNow } from '../chart/useNow';
import { SessionControl } from '../ticket/AdvancedPanel';
import { DepthBlock } from '../ticket/DepthBlock';
import { OrderTicket } from '../ticket/OrderTicket';
import {
  AdvancedBlock,
  MarketIssue,
  NotTradableNote,
  OrderTypeRow,
  PriceField,
  QtyField,
  QuoteBoxes,
  SideSwitch,
  SubmitBlock,
  submitText,
  TifRow,
  Totals,
  TypeExtras,
  type TicketScale,
} from '../ticket/parts';
import { priceText } from '../ticket/ticketModel';
import { useTicket, type TicketCtl } from '../ticket/useTicket';
import { barSide } from './actions';
import { PanelTitleBar } from './chrome';
import { CollapsedBar } from './CollapsedBar';
import { columnSpacing, panelLayout, ticketScale, type PanelLayout } from './layout';
import { usePanelMessages } from './messages';
import { OrderStrip } from './OrderStrip';
import { closingSide, positionQty, priceTarget, QTY_CHIPS, qtyChipText, quotePrice, stepPrice } from './quickActions';

/** The panel's content for its width. */
export function TicketFloatContent({ width }: { width: number }) {
  const layout = panelLayout(width);
  if (layout === 'column') return <NarrowTicket compact={width < COMPACT_HEADER_WIDTH} />;
  return <LandscapeTicket layout={layout} />;
}

/** The submit button's text and state in the panel: "Submitting…" until IB answers, "Confirm modify". */
function useSubmitLabel(T: TicketCtl): { label: string; busy: boolean } {
  const pm = usePanelMessages();
  const busy = useOrderFeedback(isSending('ticket'));
  return { busy, label: busy ? pm.submitting : T.modifying != null ? pm.confirmModify : submitText(T) };
}

/** Below this panel width the header leaves out the price change and the session badge. */
const COMPACT_HEADER_WIDTH = 420;

/** The panel's narrow layout: the docked ticket under the panel's header, with the status strip. */
function NarrowTicket({ compact }: { compact: boolean }) {
  return <OrderTicket origin="ticket" header={(T) => <TicketTitleBar T={T} compact={compact} />} footer={(T) => <NarrowFooter T={T} />} />;
}

function NarrowFooter({ T }: { T: TicketCtl }) {
  const S = ticketScale('column');
  const { label, busy } = useSubmitLabel(T);
  return (
    <>
      <OrderStrip id="ticket" />
      <Totals T={T} S={S} />
      <SubmitBlock T={T} S={S} label={label} busy={busy} />
    </>
  );
}

function LandscapeTicket({ layout }: { layout: PanelLayout }) {
  const T = useTicket('ticket');
  const S = ticketScale(layout);
  const { pad, gap } = columnSpacing(layout);
  const column: CSSProperties = { background: 'var(--p)', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' };
  const scroll: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', padding: pad, display: 'flex', flexDirection: 'column', gap };
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <TicketTitleBar T={T} />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.15fr) minmax(0,1fr)',
          gap: 'var(--gap)',
          background: 'var(--gbg)',
        }}
      >
        <div style={column}>
          <div className="ticket-body" style={scroll}>
            <MarketColumn T={T} S={S} />
          </div>
        </div>
        <div style={column}>
          <div className="ticket-body" style={scroll}>
            <EntryColumn T={T} S={S} />
          </div>
        </div>
        {/* Advanced scrolls above the fixed block; a panel too short for the block scrolls whole. */}
        <div style={{ ...column, overflow: 'auto' }}>
          <ConfirmColumn T={T} S={S} pad={pad} gap={gap} />
        </div>
      </div>
    </div>
  );
}

/**
 * The header: "Order · AAPL", name and exchange, last price and change, the session (`compact`:
 * without the change and the session, for the narrowest panels).
 */
function TicketTitleBar({ T, compact = false }: { T: TicketCtl; compact?: boolean }) {
  const lang = useLang();
  const cm = useChartMessages();
  const symbolName = useStore((s) => s.symbolName);
  const now = useNow(30_000);
  const us = usesUsEquitySession(T.symbol);
  const session = us ? usEquitySession(now, T.info?.liquidHours) : 'regular';
  const sq = sessionQuote(T.q, session);
  // The chart header's contract details (name, primary exchange).
  const info = useChartContractInfo(T.symbol);
  const name = nameOf(symbolName, lang) || info?.longName || T.info?.longName;
  const exchange = info?.contract.primaryExchange || T.info?.contract.primaryExchange || T.symbol.primaryExchange;
  const sub = [name, exchange].filter(Boolean).join(' · ');
  const live = session === 'regular';
  return (
    <PanelTitleBar id="ticket">
      <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{T.m.title(T.label)}</div>
      {sub && (
        <div className="ellipsis" style={{ fontSize: 12, color: 'var(--dm)', minWidth: 0, flexShrink: 1 }}>
          {sub}
        </div>
      )}
      {sq.price != null && (
        <div className="num" style={{ display: 'flex', alignItems: 'baseline', gap: 8, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ fontWeight: 600 }}>{priceText(sq.price, T.minTick)}</span>
          {sq.ref != null && !compact && <span style={{ fontSize: 12, color: signColor(sq.price - sq.ref) }}>{change(sq.price, sq.ref)}</span>}
        </div>
      )}
      {us && !compact && (
        <div
          style={{
            padding: '3px 6px',
            font: '600 11px/1 var(--sans)',
            color: live ? 'var(--ac)' : 'var(--mu)',
            boxShadow: `inset 0 0 0 1px ${live ? 'var(--ac)' : 'var(--ln)'}`,
            whiteSpace: 'nowrap',
          }}
        >
          {cm.session[session]}
        </div>
      )}
    </PanelTitleBar>
  );
}

/**
 * A price from the quote into the ticket (quickActions.ts → priceTarget): the bid / ask boxes fill
 * the limit; the chips under the price box fill that box.
 */
export function fillPrice(T: TicketCtl, price: number, source: 'quote' | 'chip' = 'quote'): void {
  const target = priceTarget(T.type, T.main.key, T.modifying != null, source);
  if (target === 'toLimit') T.patch({ orderType: 'LMT', limitPrice: price });
  else if (target) T.setPrice(target, price);
}

function MarketColumn({ T, S }: { T: TicketCtl; S: TicketScale }) {
  const pm = usePanelMessages();
  const pick = (which: 'bid' | 'ask') => {
    const p = quotePrice(which, T.market, T.minTick, T.t.side);
    if (p != null) fillPrice(T, p);
  };
  return (
    <>
      <NotTradableNote T={T} />
      <QuoteBoxes T={T} S={S} onPick={pick} title={(w) =>
          [pm.fillFromQuote(w === 'bid' ? pm.quickBid : pm.quickAsk), T.q?.source?.kind === 'primary' ? T.m.quoteVia(T.q.source.exchange, T.q.marketDataType) : '']
            .filter(Boolean)
            .join('\n')
        } />
      <MarketIssue T={T} />
      {/* The position and working orders are in the Trade page's activity panel. */}
      <DepthBlock T={T} S={S} />
    </>
  );
}

function QuickChip({ children, onClick, title, disabled }: { children: ReactNode; onClick: () => void; title?: string; disabled?: boolean }) {
  return (
    <div
      role="button"
      onClick={disabled ? undefined : onClick}
      title={title}
      aria-disabled={disabled || undefined}
      className={disabled ? undefined : 'hover-tx'}
      style={{
        flex: 1,
        height: 26,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        whiteSpace: 'nowrap',
        color: 'var(--mu)',
        boxShadow: 'inset 0 0 0 1px var(--ln)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </div>
  );
}

function EntryColumn({ T, S }: { T: TicketCtl; S: TicketScale }) {
  const pm = usePanelMessages();
  const key = contractKey(T.symbol);
  const position = useStore((s) => s.positions.find((p) => contractKey(p.contract) === key)?.quantity);
  const lock: CSSProperties | undefined = T.tradable ? undefined : { opacity: 0.4, pointerEvents: 'none' };
  const closeQty = positionQty(position);
  const priced = T.main.key === 'limitPrice' || T.main.key === 'stopPrice';
  const step = (dir: 1 | -1) => () => {
    const next = stepPrice(T.main.value, dir, T.minTick);
    if (next != null && priced) T.setPrice(T.main.key as 'limitPrice' | 'stopPrice', next);
  };
  const fromQuote = (which: 'bid' | 'mid' | 'ask') => quotePrice(which, T.market, T.minTick, T.t.side);
  return (
    <>
      {T.modifying != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--sel)', fontSize: 12 }}>
          <div style={{ color: 'var(--ac)', fontWeight: 600 }}>{pm.modifying(T.modifying)}</div>
          <div style={{ color: 'var(--dm)' }}>·</div>
          <div onClick={() => T.patch({ modifyingOrderId: null })} className="hover-tx" style={{ color: 'var(--mu)', cursor: 'pointer' }}>
            {pm.cancelModify}
          </div>
        </div>
      )}
      <SideSwitch T={T} S={S} />
      <OrderTypeRow T={T} S={S} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...lock }}>
        <QtyField T={T} S={S} />
        {!T.cashSized && (
          <div style={{ display: 'flex', gap: 4 }}>
            {QTY_CHIPS.map((n) => (
              <QuickChip key={n} onClick={() => T.patch({ qty: n })}>
                {qtyChipText(n)}
              </QuickChip>
            ))}
            {closeQty != null && (
              <QuickChip onClick={() => T.patch({ qty: closeQty })} title={position != null ? `${closingSide(position) === 'SELL' ? T.c.sell : T.c.buy} ${f0(closeQty)}` : undefined}>
                {pm.positionQty}
              </QuickChip>
            )}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...lock }}>
        <PriceField T={T} S={S} step={priced ? { down: step(-1), up: step(1), downTitle: pm.tickDown, upTitle: pm.tickUp } : undefined} />
        {(priced || T.type === 'MKT' || T.type === 'MTL') && (
          <div style={{ display: 'flex', gap: 4 }}>
            {(['bid', 'mid', 'ask'] as const).map((w) => {
              const p = fromQuote(w);
              const label = w === 'bid' ? pm.quickBid : w === 'mid' ? pm.quickMid : pm.quickAsk;
              return (
                <QuickChip key={w} disabled={p == null || (!priced && T.modifying != null)} title={p != null ? priceText(p, T.minTick) : undefined} onClick={() => p != null && fillPrice(T, p, 'chip')}>
                  {label}
                </QuickChip>
              );
            })}
          </div>
        )}
      </div>
      <TypeExtras T={T} S={S} />
      <TifRow T={T} S={S} session={false} />
      <div style={{ background: 'var(--p2)', ...lock }}>
        <SessionControl timing={T.timing} locked={T.modifying != null} onChange={(session) => T.patch({ session })} rule={(k) => T.choices.rule({ session: k }, 'session')} />
      </div>
    </>
  );
}

/** Advanced (scrolling), the status strip, and the fixed bottom block. */
function ConfirmColumn({ T, S, pad, gap }: { T: TicketCtl; S: TicketScale; pad: number; gap: number }) {
  const { label, busy } = useSubmitLabel(T);
  return (
    <>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: `${pad}px ${pad}px 0` }}>
        <AdvancedBlock T={T} session={false} />
      </div>
      <div style={{ flexShrink: 0, padding: pad, display: 'flex', flexDirection: 'column', gap, boxShadow: 'inset 0 1px 0 var(--ln2)', marginTop: pad }}>
        <OrderStrip id="ticket" />
        <Totals T={T} S={S} />
        <SubmitBlock T={T} S={S} label={label} busy={busy} cancelModify={false} />
      </div>
    </>
  );
}

/** The collapsed bar: symbol and last price (the drag handle), the latest order, Buy / Sell, expand. */
export function TicketBar() {
  const pm = usePanelMessages();
  const c = useCommon();
  const symbol = useStore((s) => s.symbol);
  const label = symbol.symbol;
  // The expanded ticket's quote line is gone with it; the bar keeps its own.
  const subs = useMemo(() => [symbol], [symbol]);
  useQuoteSubscriptions('ticket-bar', subs, 'basic');
  const q = useQuote(symbol);
  const last = lastPrice(q);
  const ref = q?.close;
  return (
    <CollapsedBar
      id="ticket"
      handle={
        <>
          <span style={{ fontWeight: 600 }}>{label}</span>
          {last != null && (
            <span className="num" style={{ color: ref ? signColor(last - ref) : 'var(--tx)', fontVariantNumeric: 'tabular-nums' }}>
              {px(last)}
            </span>
          )}
        </>
      }
      actions={
        <>
          <BarSideButton side="BUY" text={c.buyShort} />
          <BarSideButton side="SELL" text={c.sellShort} />
        </>
      }
      expandTitle={pm.expand}
    />
  );
}

function BarSideButton({ side, text }: { side: 'BUY' | 'SELL'; text: string }) {
  const tradable = useStore((s) => isTradable(s.symbol) && s.ticket.modifyingOrderId == null);
  return (
    <button
      type="button"
      disabled={!tradable}
      onClick={() => barSide(side)}
      style={{
        height: 26,
        padding: '0 10px',
        border: 'none',
        background: side === 'BUY' ? 'var(--up)' : 'var(--dn)',
        color: 'var(--btnTx)',
        font: '600 12px/1 var(--sans)',
        cursor: tradable ? 'pointer' : 'not-allowed',
        opacity: tradable ? 1 : 0.4,
        flexShrink: 0,
      }}
    >
      {text}
    </button>
  );
}
