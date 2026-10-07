// The options strategy builder as a floating panel. Narrower than LANDSCAPE_MIN_WIDTH it is the
// docked builder under the panel's header; wider, three columns built from the builder's own
// parts (options/StrategyPanel.tsx):
//
//   header      Strategy · AAPL, the strategy and its expiry · collapse, dock back
//   legs        template, the editable legs, "+ add from the chain", net greeks
//   payoff      a large expiry P&L chart, max profit / loss, breakevens and the other statistics
//   order       net price (− / +), order type and TIF, trigger condition, estimated cost, the
//               status strip and the send button
//
// The panel has its own model and quote owners (options/strategyPanelModel.ts).

import type { CSSProperties } from 'react';
import { shortExpiry } from '@shared/contract';
import { f2, roundToTick, usd } from '@shared/format';
import { isSending, useOrderFeedback } from '../../state/orderFeedback';
import { useDesk } from '../options/deskStore';
import { useM } from '../options/messages';
import type { DeskModel } from '../options/model';
import { Condition, LegList, NetGreeks, OrderChoices, Payoff, SendButton, Stats, StrategyPanel, TemplatePicker, useStrategy, type StrategyCtl } from '../options/StrategyPanel';
import { orderPrice } from '../options/strategyModel';
import { useStrategyPanelModel } from '../options/strategyPanelModel';
import { addFromChain } from './actions';
import { PanelTitleBar } from './chrome';
import { CollapsedBar } from './CollapsedBar';
import { columnSpacing, panelLayout, type PanelLayout } from './layout';
import { usePanelMessages } from './messages';
import { OrderStrip } from './OrderStrip';
import { stepPrice } from './quickActions';

/** Strategy prices move by a cent (per share, or per combo unit). */
const NET_TICK = 0.01;

/** The panel's content for its width. */
export function StrategyFloatContent({ width }: { width: number }) {
  const model = useStrategyPanelModel();
  const layout = panelLayout(width);
  if (layout === 'column') return <NarrowStrategy model={model} />;
  return <LandscapeStrategy model={model} layout={layout} />;
}

function useSendLabel(ctl: StrategyCtl): { busy: boolean; label?: string } {
  const pm = usePanelMessages();
  const sending = useOrderFeedback(isSending('strategy'));
  return sending ? { busy: true, label: pm.submitting } : { busy: ctl.sending };
}

/** "Strategy · AAPL", the strategy's name and its (first) expiry. */
function StrategyTitle({ ctl, model }: { ctl: StrategyCtl; model: DeskModel }) {
  const pm = usePanelMessages();
  const m = useM();
  const expiry = ctl.view?.legs.find((l) => l.leg.right !== 'S')?.leg.expiry ?? model.exp?.expiry;
  const name = ctl.current ? m.strategies[ctl.current.key] : null;
  return (
    <PanelTitleBar id="strategy">
      <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{pm.strategyTitle(model.symbol)}</div>
      {name && (
        <div className="ellipsis" style={{ fontSize: 12, color: 'var(--mu)', minWidth: 0 }}>
          {name}
          {expiry ? ` · ${shortExpiry(expiry)}` : ''}
        </div>
      )}
    </PanelTitleBar>
  );
}

/** The panel's narrow layout: the docked builder under the header, with the status strip. */
function NarrowStrategy({ model }: { model: DeskModel }) {
  const ctl = useStrategy(model, 'strategy');
  const pm = usePanelMessages();
  return (
    <StrategyPanel
      model={model}
      origin="strategy"
      header={<StrategyTitle ctl={ctl} model={model} />}
      heading={pm.legs}
      footer={(c) => <NarrowFooter ctl={c} />}
    />
  );
}

function NarrowFooter({ ctl }: { ctl: StrategyCtl }) {
  const { busy, label } = useSendLabel(ctl);
  if (!ctl.view) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <OrderStrip id="strategy" />
      <SendButton view={ctl.view} busy={busy} label={label} onSend={() => void ctl.send()} />
    </div>
  );
}

/**
 * Legs, payoff, order. The legs keep the docked builder's width at least (their descriptions,
 * "10/09 222.50 Put", must not be cut), the order column what its chips and button need; the chart
 * takes the rest.
 */
const STRATEGY_COLUMNS = 'minmax(360px,1fr) minmax(0,1.2fr) minmax(280px,0.9fr)';

const heading: CSSProperties = { padding: '0 20px', fontSize: 12, color: 'var(--mu)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 };

function LandscapeStrategy({ model, layout }: { model: DeskModel; layout: PanelLayout }) {
  const ctl = useStrategy(model, 'strategy');
  const pm = usePanelMessages();
  const m = useM();
  const { view, legs, desk } = ctl;
  const { pad } = columnSpacing(layout);
  const column: CSSProperties = { background: 'var(--p)', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto', paddingTop: pad, paddingBottom: pad };
  const priced = view != null && legs.length > 0;
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <StrategyTitle ctl={ctl} model={model} />
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: STRATEGY_COLUMNS, gap: 'var(--gap)', background: 'var(--gbg)' }}>
        <div style={column}>
          <div style={{ ...heading, paddingBottom: 10 }}>
            <span>{pm.legs}</span>
            <span onClick={desk.clearLegs} className="hover-tx" style={{ color: 'var(--dm)', cursor: 'pointer' }}>
              {m.clear}
            </span>
          </div>
          <TemplatePicker ctl={ctl} />
          {!legs.length && <div style={{ margin: '0 20px', padding: 18, background: 'var(--p2)', fontSize: 12, color: 'var(--dm)', textAlign: 'center' }}>{m.empty}</div>}
          {view && <LegList view={view} />}
          <div onClick={addFromChain} style={{ padding: '12px 20px', fontSize: 12, color: 'var(--ac)', cursor: 'pointer' }}>
            {pm.addFromChain}
          </div>
          {priced && (
            <>
              <div style={{ ...heading, padding: '8px 20px 6px' }}>{m.netGreeks}</div>
              <NetGreeks view={view} m={m} />
            </>
          )}
        </div>
        {/* A short panel scrolls the statistics under the chart (which keeps its 200px minimum). */}
        <div style={column}>
          {priced ? (
            <>
              <Payoff view={view} spot={model.spot} m={m} grow />
              <Stats view={view} m={m} />
            </>
          ) : (
            <div style={{ margin: '0 20px', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--p2)', fontSize: 12, color: 'var(--dm)' }}>{pm.noLegs}</div>
          )}
        </div>
        {/* The choices scroll above the fixed send block; shorter still, the whole column scrolls. */}
        <div style={{ ...column, paddingBottom: 0 }}>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
            {priced && (
              <>
                <NetPrice ctl={ctl} />
                <OrderChoices combo={legs.length > 1} />
                <Condition symbol={model.symbol} spot={model.spot} combo={legs.length > 1} />
              </>
            )}
          </div>
          <OrderBlock ctl={ctl} pad={pad} />
        </div>
      </div>
    </div>
  );
}

/** The net limit price with − / + by a cent; "Mid" follows the legs' prices again. */
function NetPrice({ ctl }: { ctl: StrategyCtl }) {
  const pm = usePanelMessages();
  const m = useM();
  const market = useDesk((s) => s.ordType) === 'MKT';
  const netPrice = useDesk((s) => s.netPrice);
  const price = ctl.view ? orderPrice(ctl.view) : undefined;
  const step = (dir: 1 | -1) => {
    const next = stepPrice(price, dir, NET_TICK);
    if (next != null) ctl.desk.patch({ netPrice: roundToTick(next, NET_TICK) });
  };
  const btn: CSSProperties = { width: 40, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--mu)', flexShrink: 0 };
  return (
    <div style={{ margin: '0 20px', display: 'flex', flexDirection: 'column', gap: 6, opacity: market ? 0.4 : 1, pointerEvents: market ? 'none' : undefined }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--dm)' }}>
        <span>{pm.netPrice}</span>
        {netPrice != null && (
          <span onClick={() => ctl.desk.patch({ netPrice: null })} className="hover-tx" style={{ cursor: 'pointer', color: 'var(--ac)' }}>
            {pm.quickMid}
          </span>
        )}
      </div>
      <div style={{ height: 46, display: 'flex', alignItems: 'center', boxShadow: 'inset 0 0 0 1px var(--ln)' }}>
        <div onClick={() => step(-1)} title={pm.tickDown} className="hover-tx" style={btn}>
          −
        </div>
        <div className="num" style={{ flex: 1, textAlign: 'center', font: '500 18px/1 var(--num)', fontVariantNumeric: 'tabular-nums' }}>
          {market ? m.market : price != null ? f2(price) : '—'}
        </div>
        <div onClick={() => step(1)} title={pm.tickUp} className="hover-tx" style={btn}>
          +
        </div>
      </div>
    </div>
  );
}

/** Estimated cost, the status strip and the send button (fixed at the bottom of the column). */
function OrderBlock({ ctl, pad }: { ctl: StrategyCtl; pad: number }) {
  const pm = usePanelMessages();
  const { busy, label } = useSendLabel(ctl);
  const view = ctl.view;
  return (
    <div style={{ flexShrink: 0, padding: `${pad}px 20px`, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: 'inset 0 1px 0 var(--ln2)' }}>
      <OrderStrip id="strategy" />
      {view && ctl.legs.length > 0 && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13, color: 'var(--mu)' }}>
            <div>{pm.estCost}</div>
            <div className="num selectable" style={{ color: 'var(--tx)' }}>
              {view.orderCost != null ? usd(Math.abs(view.orderCost)) : '—'}
            </div>
          </div>
          <SendButton view={view} busy={busy} label={label} height={52} onSend={() => void ctl.send()} />
        </>
      )}
    </div>
  );
}

/** The collapsed bar: the strategy and its net price (the drag handle), the latest order, expand. */
export function StrategyBar() {
  const pm = usePanelMessages();
  const m = useM();
  const model = useStrategyPanelModel();
  const ctl = useStrategy(model, 'strategy');
  const name = ctl.current ? m.strategies[ctl.current.key] : pm.strategy;
  const price = ctl.view ? orderPrice(ctl.view) : undefined;
  return (
    <CollapsedBar
      id="strategy"
      handle={
        <>
          <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{model.symbol}</span>
          <span className="ellipsis" style={{ color: 'var(--mu)', maxWidth: 120 }}>
            {name}
          </span>
          {price != null && (
            <span className="num" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {f2(price)}
            </span>
          )}
        </>
      }
      expandTitle={pm.expand}
    />
  );
}
