// The full options desk (Trade › Options): header, tabs and the active tab (the chain with the
// strategy builder, or volatility). With the builder floating (features/panels) the chain takes the
// full width. The underlying's positions are in the Trade page's activity panel under the desk.

import { useState } from 'react';
import { PopOutButton } from '../panels/chrome';
import { isFloating, usePanels } from '../panels/panelStore';
import { ChainPanel } from './ChainPanel';
import { DeskHeader } from './DeskHeader';
import { DeskTabs } from './DeskTabs';
import { useDesk } from './deskStore';
import { useM } from './messages';
import { useDeskModel, type DeskModel } from './model';
import { StrategyPanel } from './StrategyPanel';
import { VolatilityTab } from './VolatilityTab';

export function DeskFull() {
  const m = useM();
  const [visible, setVisible] = useState<{ from: number; to: number } | null>(null);
  const model = useDeskModel(visible);
  const tab = useDesk((s) => s.tab);
  const strategyFloating = usePanels(isFloating('strategy'));

  if (!model.underlying) {
    return <div style={{ flex: 1, background: 'var(--p)', padding: '20px 24px', fontSize: 13, color: 'var(--dm)' }}>{m.notOptionable}</div>;
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', fontSize: 14, color: 'var(--tx)', fontFamily: 'var(--sans)' }}>
      <DeskHeader model={model} />
      <DeskTabs expiries={model.chain.expiries} selected={model.exp?.expiry} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'vol' ? (
          <VolatilityTab model={model} />
        ) : (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'grid',
              gridTemplateColumns: strategyFloating ? 'minmax(0,1fr)' : 'minmax(0,1fr) 384px',
              gap: 'var(--gap)',
              padding: 'var(--pad)',
              background: 'var(--gbg)',
            }}
          >
            <ChainPanel model={model} onVisible={setVisible} state={model.chain.status === 'ready' ? null : <ChainState model={model} />} />
            {!strategyFloating && <StrategyPanel model={model} actions={<PopOutButton id="strategy" />} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** Loading / empty / error state of the chain. */
function ChainState({ model }: { model: DeskModel }) {
  const m = useM();
  const { chain, symbol } = model;
  const text = chain.status === 'error' ? m.chainError(chain.error ?? '') : chain.status === 'empty' ? m.noChain(symbol) : m.loadingChain;
  return (
    <div style={{ padding: '18px 20px', display: 'flex', gap: 14, alignItems: 'baseline', fontSize: 13, color: 'var(--dm)' }}>
      <div>{text}</div>
      {(chain.status === 'error' || chain.status === 'empty') && (
        <div onClick={chain.retry} style={{ fontSize: 12, color: 'var(--ac)', cursor: 'pointer' }}>
          {m.retry}
        </div>
      )}
    </div>
  );
}
